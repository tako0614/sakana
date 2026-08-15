export type ModelId = 'evex-1' | 'evex-2' | 'evex-ft-1';
export type ModelFormat = 'evex-onnx' | 'qwen3-transformers';
export type Backend = 'auto' | 'webgpu' | 'wasm';

export interface ModelDefinition {
  id: ModelId;
  name: string;
  description: string;
  repo: string;
  revision: string;
  format: ModelFormat;
  context: number;
  promptBudget: number;
  maxNewTokens: number;
  downloadBytes: number;
  backends: Backend[];
  supportsPersonas: boolean;
  warning?: string;
}

export interface Persona {
  id: string;
  label: string;
  prompt: string;
  messages?: number;
}

export const MODELS: Record<ModelId, ModelDefinition> = {
  'evex-1': {
    id: 'evex-1',
    name: 'evex-1',
    description: '小さくて軽い初代モデル。48人の話者トークンを持ちます。',
    repo: 'tako080614/evex-1',
    revision: 'ddb75d2e3a4e231973f79c5ce4d4140958eaaaa4',
    format: 'evex-onnx',
    context: 512,
    promptBudget: 432,
    maxNewTokens: 80,
    downloadBytes: 27_784_077,
    backends: ['auto', 'webgpu', 'wasm'],
    supportsPersonas: true,
  },
  'evex-2': {
    id: 'evex-2',
    name: 'evex-2',
    description: '既定モデル。evex-1と同じ軽さで、より長く学習しています。',
    repo: 'tako080614/evex-2',
    revision: '3a36a29b32df1ab2322a05d5c5259c1a3644294a',
    format: 'evex-onnx',
    context: 512,
    promptBudget: 432,
    maxNewTokens: 80,
    downloadBytes: 27_784_077,
    backends: ['auto', 'webgpu', 'wasm'],
    supportsPersonas: true,
  },
  'evex-ft-1': {
    id: 'evex-ft-1',
    name: 'evex-ft-1 · epoch 2',
    description: 'Qwen3 0.6Bを会話へfine-tuneした高品質版。',
    repo: 'tako080614/evex-ft-1',
    revision: '8616ffe9f82085740c4afa9e6c1d5d12dfcc3ce4',
    format: 'qwen3-transformers',
    context: 1024,
    promptBudget: 864,
    maxNewTokens: 160,
    downloadBytes: 1_310_822_236,
    backends: ['webgpu'],
    supportsPersonas: true,
    warning: 'WebGPUと約1.3 GBの保存領域が必要です。初回読込後はIndexedDBに保存します。',
  },
};

export const MODEL_LIST = Object.values(MODELS);

export function hfFile(model: ModelDefinition, file: string): string {
  return `https://huggingface.co/${model.repo}/resolve/${model.revision}/${file}`;
}

export async function fetchPersonas(model: ModelDefinition): Promise<Persona[]> {
  const response = await fetch(hfFile(model, 'speakers.json'));
  if (!response.ok) throw new Error(`話者一覧を取得できませんでした (${response.status})`);
  const rows = (await response.json()) as Array<{
    token?: string;
    label?: string;
    name?: string;
    messages?: number;
  }>;
  const anonymous: Persona = {
    id: 'anonymous',
    label: '匿名（おすすめ）',
    prompt: model.format === 'evex-onnx' ? '<|other|>' : 'B',
  };
  return [
    anonymous,
    ...rows.map((row, index) => ({
      id: row.token ?? row.label ?? `speaker-${index}`,
      label: row.name || row.label || row.token || `話者 ${index + 1}`,
      prompt: row.token ?? row.label ?? 'B',
      messages: row.messages,
    })),
  ];
}
