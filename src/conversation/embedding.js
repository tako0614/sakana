import { isMainThread, parentPort } from 'node:worker_threads';
import { randomUUID } from 'node:crypto';
import { embedConfig } from '../embed/config.js';
import { embedTexts } from '../embed/worker.js';
import { utf8Tokenizer } from '../../subprojects/atom-memory/dist/index.js';
import { requestEmbeddings } from '../ai/embeddings.js';
import { modelBudgetStatus } from '../ai/cost.js';
import { db } from '../archive/db.js';

// Atom workers share the main process's existing encoder instead of starting
// a second 1 GB Python process. Standalone scripts use the same transport locally.
function broker(texts, options, signal) {
  if (isMainThread || !parentPort) return embedTexts(texts, options);
  return new Promise((resolve, reject) => {
    const id = randomUUID();
    const done = (error, result) => {
      clearTimeout(timer); parentPort.off('message', receive); signal?.removeEventListener('abort', abort);
      if (error) reject(error); else resolve(result);
    };
    const receive = message => {
      if (message.embeddingResult?.id !== id) return;
      done(message.embeddingResult.error ? new Error(message.embeddingResult.error) : null, message.embeddingResult.result);
    };
    const abort = () => done(signal.reason ?? new Error('Embedding aborted'));
    const timer = setTimeout(() => done(new Error('Embedding broker timed out')), embedConfig.startupTimeoutMs + embedConfig.requestTimeoutMs);
    parentPort.on('message', receive);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) { abort(); return; }
    parentPort.postMessage({ embedding: { id, texts, options } });
  });
}

// Search representations carry meaning first, rather than spending the E5
// window on archive hashes and transport keys. The stored Atom stays intact.
export function embeddingText(text) {
  return String(text).split('\n').map(line => {
    const start = line.indexOf('{');
    if (start < 0) return line;
    try {
      const value = JSON.parse(line.slice(start));
      if (value.schema === 'discord.memory.v1') return line.slice(0, start) + value.text;
      if (value.document && value.complete) {
        const message = JSON.parse(value.document);
        return line.slice(0, start) + JSON.stringify({ author: message.author, body: message.body,
          supplemental: message.supplemental, reference: message.reference, forwarded: message.forwarded,
          embeds: message.embeds, attachments: message.attachments });
      }
    } catch { /* Ordinary text and partial source envelopes remain searchable. */ }
    return line;
  }).join('\n');
}

export function conversationEmbedding({ request = broker } = {}) {
  const dimensions = Number(process.env.MEMORY_EMBEDDING_DIMENSIONS ?? 384);
  if (!Number.isSafeInteger(dimensions) || dimensions < 1) throw new Error('Invalid memory embedding dimensions');
  return {
    id: `sakana-e5-v2:${embedConfig.modelName}@${embedConfig.modelRevision ?? 'unversioned'}:${dimensions}:${embedConfig.maxLength}:${process.env.SEMANTIC_PREFIX_QUERY ?? 'query: '}:${process.env.SEMANTIC_PREFIX_PASSAGE ?? 'passage: '}`,
    dimensions, tokenizer: utf8Tokenizer, networkCallsPerCall: 0,
    async embed(texts, signal, purpose = 'query') {
      signal?.throwIfAborted();
      const result = await request(texts.map(embeddingText), { kind: purpose === 'document' ? 'passage' : 'query', encode: 'float32' }, signal);
      signal?.throwIfAborted();
      if (result.model_revision && embedConfig.modelRevision && result.model_revision !== embedConfig.modelRevision) throw new Error('Memory embedding model revision mismatch');
      if (result.dim !== dimensions || result.vectors?.length !== texts.length) throw new Error('Memory embedding model space mismatch');
      return result.vectors.map(encoded => {
        const bytes = Buffer.from(encoded, 'base64');
        if (bytes.length !== dimensions * 4) throw new Error('Invalid memory embedding size');
        return Array.from({ length: dimensions }, (_, i) => bytes.readFloatLE(i * 4));
      });
    }
  };
}

export function dreamEmbeddingBudget(guildId) {
  const invalid = () => Object.assign(new Error('Dream embedding requires a running guild budget'),
    { code: 'DREAM_EMBEDDING_PAUSED' });
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='dream_jobs'").get()) throw invalid();
  const job = db.prepare('SELECT state,budget_id FROM dream_jobs WHERE guild_id=?').get(String(guildId));
  if (!job || job.state !== 'running') throw invalid();
  let budget;
  try { budget = modelBudgetStatus(job.budget_id); }
  catch (error) { if (String(error.code).startsWith('MODEL_BUDGET_')) throw invalid(); throw error; }
  if (budget.guildId !== String(guildId) || budget.paused) throw invalid();
  return budget.id;
}

export function openRouterConversationEmbedding({ guildId, request = requestEmbeddings } = {}) {
  if (!guildId) throw new Error('Remote conversation embedding requires a guild');
  const model = 'qwen/qwen3-embedding-8b';
  const dimensions = Number(process.env.MEMORY_DREAMING_EMBEDDING_DIMENSIONS ?? 4096);
  if (!Number.isSafeInteger(dimensions) || dimensions < 32 || dimensions > 4096)
    throw new Error('Qwen memory dimensions must be an integer between 32 and 4096');
  // Documents remain unprefixed. The instruction describes contextual recall,
  // rather than rewriting the live context into a hypothetical question.
  const instruction = 'Instruct: Retrieve memories relevant to the current conversation context and reasoning.\nQuery: ';
  return {
    id: `sakana-openrouter-qwen3-v1:${model}:${dimensions}:context-recall-v1`,
    dimensions, tokenizer: utf8Tokenizer, networkCallsPerCall: 1,
    async embed(texts, signal, purpose = 'query') {
      signal?.throwIfAborted();
      const budgetId = dreamEmbeddingBudget(guildId);
      const beforeSend = () => {
        signal?.throwIfAborted();
        if (dreamEmbeddingBudget(guildId) !== budgetId) throw Object.assign(new Error('Dream embedding budget changed'),
          { code: 'DREAM_EMBEDDING_PAUSED' });
      };
      const input = texts.map(embeddingText).map(text => purpose === 'document' ? text : instruction + text);
      const result = await request({ model, dimensions, input, guildId: String(guildId), budgetId,
        signal, beforeSend });
      signal?.throwIfAborted();
      return result.vectors;
    }
  };
}
