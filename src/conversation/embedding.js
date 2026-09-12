import { isMainThread, parentPort } from 'node:worker_threads';
import { randomUUID } from 'node:crypto';
import { embedConfig } from '../embed/config.js';
import { embedTexts } from '../embed/worker.js';
import { utf8Tokenizer } from '../../subprojects/atom-memory/dist/index.js';

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
          reference: message.reference, forwarded: message.forwarded, attachments: message.attachments });
      }
    } catch { /* Ordinary text and partial source envelopes remain searchable. */ }
    return line;
  }).join('\n');
}

export function conversationEmbedding({ request = broker } = {}) {
  const dimensions = Number(process.env.MEMORY_EMBEDDING_DIMENSIONS ?? 384);
  if (!Number.isSafeInteger(dimensions) || dimensions < 1) throw new Error('Invalid memory embedding dimensions');
  return {
    id: `sakana-e5-v1:${embedConfig.modelName}@${embedConfig.modelRevision ?? 'unversioned'}:${dimensions}:${embedConfig.maxLength}:${process.env.SEMANTIC_PREFIX_QUERY ?? 'query: '}:${process.env.SEMANTIC_PREFIX_PASSAGE ?? 'passage: '}`,
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
