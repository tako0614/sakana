/// <reference lib="webworker" />

import {
  AutoModelForCausalLM,
  env,
  InterruptableStoppingCriteria,
  PreTrainedTokenizer,
  Qwen2Tokenizer,
  StoppingCriteriaList,
  TextStreamer,
} from '@huggingface/transformers';
import * as ort from 'onnxruntime-web/webgpu';

import { hfFile, MODELS, type Backend, type ModelDefinition, type Persona } from '../models';
import { modelCache, requestPersistentStorage } from './idb-cache';
import {
  buildEvexPrompt,
  buildFtPrompt,
  cleanEvexReply,
  cleanFtReply,
  isUsableReply,
} from './prompts';
import type { ConversationTurn, WorkerRequest, WorkerResponse } from './protocol';

const worker = self as DedicatedWorkerGlobalScope;
const send = (message: WorkerResponse) => worker.postMessage(message);

env.useBrowserCache = false;
env.useCustomCache = true;
env.customCache = modelCache;
if (env.backends.onnx.wasm) env.backends.onnx.wasm.wasmPaths = '/ort/';
ort.env.wasm.wasmPaths = '/ort/';
ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 1) : 1;

interface LoadedEvex {
  kind: 'evex';
  definition: ModelDefinition;
  backend: Exclude<Backend, 'auto'>;
  tokenizer: any;
  session: ort.InferenceSession;
}

interface LoadedFt {
  kind: 'ft';
  definition: ModelDefinition;
  backend: 'webgpu';
  tokenizer: any;
  model: any;
}

type Loaded = LoadedEvex | LoadedFt;

let loaded: Loaded | null = null;
let abortRequested = false;
let ftStopper: InterruptableStoppingCriteria | null = null;

function errorMessage(error: unknown): string {
  const value = error instanceof Error ? error.message : String(error);
  if (/out of memory|memory|allocation|buffer/i.test(value)) {
    return 'モデル用メモリを確保できませんでした。ほかのタブを閉じるか、軽いevex-2を選んでください。';
  }
  if (/webgpu|gpu|adapter|device/i.test(value)) {
    return 'WebGPUを利用できませんでした。対応するChrome系ブラウザとGPU設定を確認してください。';
  }
  if (/quota|storage|space/i.test(value)) {
    return 'モデルを保存する空き容量が足りません。キャッシュを消すか、端末の空き容量を増やしてください。';
  }
  return value || '推論中に不明なエラーが発生しました。';
}

function chooseBackend(requested: Backend, definition: ModelDefinition): Exclude<Backend, 'auto'> {
  if (definition.format === 'qwen3-transformers') return 'webgpu';
  if (requested !== 'auto') return requested;
  return 'gpu' in navigator ? 'webgpu' : 'wasm';
}

async function readBytes(url: string, file: string): Promise<Uint8Array> {
  const cached = await modelCache.match(url);
  if (cached) {
    const bytes = new Uint8Array(await cached.arrayBuffer());
    send({ type: 'progress', file, loaded: bytes.byteLength, total: bytes.byteLength, progress: 100 });
    return bytes;
  }

  const response = await fetch(url);
  if (!response.ok || !response.body) throw new Error(`モデル取得に失敗しました (${response.status})`);
  const total = Number(response.headers.get('content-length') ?? 0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let loadedBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loadedBytes += value.byteLength;
    send({
      type: 'progress',
      file,
      loaded: loadedBytes,
      total: total || loadedBytes,
      progress: total ? (loadedBytes / total) * 100 : 0,
    });
  }
  const bytes = new Uint8Array(loadedBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  await modelCache.put(
    url,
    new Response(bytes.slice(), {
      headers: {
        'content-length': String(bytes.byteLength),
        'content-type': response.headers.get('content-type') ?? 'application/octet-stream',
      },
    }),
  );
  return bytes;
}

async function ensureCached(url: string, file: string, fallbackTotal: number): Promise<void> {
  const cached = await modelCache.match(url);
  if (cached) {
    const total = Number(cached.headers.get('content-length') ?? fallbackTotal);
    await cached.body?.cancel();
    send({ type: 'progress', file, loaded: total, total, progress: 100 });
    return;
  }

  const response = await fetch(url);
  if (!response.ok || !response.body) throw new Error(`モデル取得に失敗しました (${response.status})`);
  const declaredTotal = Number(response.headers.get('content-length') ?? fallbackTotal);
  await modelCache.put(url, response, ({ loaded, total, progress }) => {
    const effectiveTotal = total || declaredTotal;
    send({
      type: 'progress',
      file,
      loaded,
      total: effectiveTotal,
      progress: progress || (effectiveTotal ? (loaded / effectiveTotal) * 100 : 0),
    });
  });
}

async function loadPinnedTokenizer(definition: ModelDefinition): Promise<any> {
  const [tokenizerBytes, configBytes] = await Promise.all([
    readBytes(hfFile(definition, 'tokenizer.json'), 'tokenizer.json'),
    readBytes(hfFile(definition, 'tokenizer_config.json'), 'tokenizer_config.json'),
  ]);
  const tokenizerJson = JSON.parse(new TextDecoder().decode(tokenizerBytes));
  const tokenizerConfig = JSON.parse(new TextDecoder().decode(configBytes));
  const Tokenizer = definition.format === 'qwen3-transformers' ? Qwen2Tokenizer : PreTrainedTokenizer;
  return new (Tokenizer as any)(tokenizerJson, tokenizerConfig);
}

async function unload(): Promise<void> {
  abortRequested = true;
  ftStopper?.interrupt();
  if (loaded?.kind === 'evex') await loaded.session.release();
  if (loaded?.kind === 'ft') await loaded.model.dispose();
  loaded = null;
  ftStopper = null;
}

async function loadModel(definition: ModelDefinition, requested: Backend): Promise<void> {
  await unload();
  abortRequested = false;
  const backend = chooseBackend(requested, definition);
  send({ type: 'loading', modelId: definition.id, backend });
  await requestPersistentStorage();

  if (definition.format === 'evex-onnx') {
    const tokenizer = await loadPinnedTokenizer(definition);
    (tokenizer as any).truncation_side = 'left';
    const file = 'onnx/model.onnx';
    const bytes = await readBytes(hfFile(definition, file), file);
    const session = await ort.InferenceSession.create(bytes, {
      executionProviders: [backend],
      graphOptimizationLevel: 'all',
    });
    loaded = { kind: 'evex', definition, backend, tokenizer, session };
  } else {
    if (!('gpu' in navigator)) throw new Error('このモデルにはWebGPUが必要です。');
    const tokenizer = await loadPinnedTokenizer(definition);
    (tokenizer as any).truncation_side = 'left';
    await ensureCached(
      hfFile(definition, 'onnx/model_fp16.onnx'),
      'onnx/model_fp16.onnx',
      definition.downloadBytes,
    );
    const model = await AutoModelForCausalLM.from_pretrained(definition.repo, {
      revision: definition.revision,
      dtype: 'fp16',
      device: 'webgpu',
    });
    loaded = { kind: 'ft', definition, backend: 'webgpu', tokenizer, model };
  }

  send({
    type: 'ready',
    modelId: definition.id,
    backend,
    cachedBytes: await modelCache.size(),
  });
}

function tokenIds(tokenizer: any, value: string): number[] {
  const encoded = tokenizer(value, { add_special_tokens: false });
  return Array.from(encoded.input_ids.data as BigInt64Array, Number);
}

function random(): number {
  const value = new Uint32Array(1);
  crypto.getRandomValues(value);
  return value[0] / 0x1_0000_0000;
}

function sample(logits: Float32Array, banned: Set<number>): number {
  const candidates: Array<{ id: number; value: number }> = [];
  for (let id = 0; id < logits.length; id += 1) {
    if (banned.has(id)) continue;
    candidates.push({ id, value: logits[id] / 0.9 });
  }
  candidates.sort((left, right) => right.value - left.value);
  const top = candidates.slice(0, 40);
  const peak = top[0]?.value ?? 0;
  const weights = top.map((entry) => Math.exp(entry.value - peak));
  const sum = weights.reduce((total, value) => total + value, 0);
  let draw = random() * sum;
  for (let index = 0; index < top.length; index += 1) {
    draw -= weights[index];
    if (draw <= 0) return top[index].id;
  }
  return top.at(-1)?.id ?? 0;
}

async function generateEvex(
  current: LoadedEvex,
  turns: ConversationTurn[],
  persona: Persona,
): Promise<string> {
  const prompt = buildEvexPrompt(turns, persona);
  const allInputIds = tokenIds(current.tokenizer, prompt);
  const inputIds = allInputIds.slice(-current.definition.promptBudget);
  const banned = new Set(
    ['<file>', '<url>', '<mention>', '<channel>', '<time>'].flatMap((token) => tokenIds(current.tokenizer, token)),
  );
  const possibleSpeakers = [
    '<|other|>',
    '<|end|>',
    '<|conv|>',
    ...Array.from({ length: 48 }, (_, index) => `<|s${index}|>`),
  ];
  const selectedId = tokenIds(current.tokenizer, persona.prompt)[0];
  const stopIds = new Set(
    possibleSpeakers
      .flatMap((token) => tokenIds(current.tokenizer, token))
      .filter((id) => id !== selectedId),
  );

  let finalText = '';
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let nextInput = inputIds;
    let cache: Record<string, ort.Tensor> = {};
    let generated: number[] = [];
    let ownTurnMarkers = 0;
    for (let step = 0; step < current.definition.maxNewTokens; step += 1) {
      if (abortRequested) throw new DOMException('Aborted', 'AbortError');
      const feeds: Record<string, ort.Tensor> = {
        input_ids: new ort.Tensor('int64', BigInt64Array.from(nextInput.map(BigInt)), [1, nextInput.length]),
      };
      for (let layer = 0; layer < 6; layer += 1) {
        for (const kind of ['key', 'value'] as const) {
          const name = `past.${layer}.${kind}`;
          feeds[name] =
            cache[name] ?? new ort.Tensor('float32', new Float32Array(0), [1, 4, 0, 64]);
        }
      }
      const output = await current.session.run(feeds);
      for (const tensor of Object.values(feeds)) tensor.dispose();
      cache = {};
      const logitsTensor = output.logits;
      const logitsData = (await logitsTensor.getData(true)) as Float32Array;
      const vocab = 4096;
      const logits = logitsData.slice(logitsData.length - vocab);
      logitsTensor.dispose();
      const nextCache: Record<string, ort.Tensor> = {};
      for (let layer = 0; layer < 6; layer += 1) {
        for (const kind of ['key', 'value'] as const) {
          nextCache[`past.${layer}.${kind}`] = output[`present.${layer}.${kind}`];
        }
      }
      const next = sample(logits, banned);
      if (stopIds.has(next) && step >= 2) {
        for (const tensor of Object.values(nextCache)) tensor.dispose();
        break;
      }
      if (next === selectedId) {
        ownTurnMarkers += 1;
        if (ownTurnMarkers >= 4) {
          for (const tensor of Object.values(nextCache)) tensor.dispose();
          break;
        }
      }
      generated.push(next);
      nextInput = [next];
      cache = nextCache;
      const raw = current.tokenizer.decode(generated.map(BigInt), { skip_special_tokens: false });
      finalText = cleanEvexReply(raw, persona.prompt);
      send({ type: 'token', text: finalText });
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    for (const tensor of Object.values(cache)) tensor.dispose();
    if (isUsableReply(finalText)) return finalText;
    send({ type: 'token', text: '' });
  }
  return finalText || 'うまく返事を作れませんでした。もう一度試してください。';
}

async function generateFt(current: LoadedFt, turns: ConversationTurn[], persona: Persona): Promise<string> {
  const prompt = buildFtPrompt(turns, persona);
  const inputs = current.tokenizer(prompt, {
    add_special_tokens: false,
    truncation: true,
    max_length: current.definition.promptBudget,
  });
  const inputLength = inputs.input_ids.dims.at(-1) as number;
  let finalText = '';
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let streamed = '';
    ftStopper = new InterruptableStoppingCriteria();
    const criteria = new StoppingCriteriaList();
    criteria.push(ftStopper);
    const streamer = new TextStreamer(current.tokenizer, {
      skip_prompt: true,
      skip_special_tokens: false,
      callback_function: (chunk: string) => {
        streamed += chunk;
        finalText = cleanFtReply(streamed, persona.prompt);
        send({ type: 'token', text: finalText });
      },
    });
    const output = await current.model.generate({
      ...inputs,
      max_new_tokens: current.definition.maxNewTokens,
      do_sample: true,
      temperature: 0.9,
      top_k: 40,
      min_p: 0.05,
      repetition_penalty: 1.1,
      streamer,
      stopping_criteria: criteria,
    });
    if (abortRequested) throw new DOMException('Aborted', 'AbortError');
    const generated = output.tolist()[0].slice(inputLength) as bigint[];
    const decoded = current.tokenizer.decode(generated, { skip_special_tokens: false });
    finalText = cleanFtReply(decoded, persona.prompt);
    if (isUsableReply(finalText)) return finalText;
    send({ type: 'token', text: '' });
  }
  return finalText || 'うまく返事を作れませんでした。もう一度試してください。';
}

async function generate(turns: ConversationTurn[], persona: Persona): Promise<void> {
  if (!loaded) throw new Error('先にモデルを読み込んでください。');
  abortRequested = false;
  const started = performance.now();
  const text =
    loaded.kind === 'evex'
      ? await generateEvex(loaded, turns, persona)
      : await generateFt(loaded, turns, persona);
  send({ type: 'complete', text, elapsedMs: performance.now() - started });
}

worker.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const request = event.data;
  if (request.type === 'abort') {
    abortRequested = true;
    ftStopper?.interrupt();
    return;
  }
  try {
    if (request.type === 'load') {
      await loadModel(MODELS[request.modelId], request.backend);
    } else if (request.type === 'generate') {
      await generate(request.turns, request.persona);
    } else if (request.type === 'reset') {
      abortRequested = false;
      send({ type: 'reset-done' });
    } else if (request.type === 'clear-cache') {
      await unload();
      await modelCache.clear();
      send({ type: 'cache-cleared' });
    }
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      send({ type: 'aborted' });
      return;
    }
    send({ type: 'error', message: errorMessage(error), recoverable: true });
  }
};
