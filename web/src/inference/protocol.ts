import type { Backend, ModelId, Persona } from '../models';

export interface ConversationTurn {
  role: 'user' | 'assistant';
  content: string;
}

export type WorkerRequest =
  | { type: 'load'; modelId: ModelId; backend: Backend }
  | { type: 'generate'; turns: ConversationTurn[]; persona: Persona }
  | { type: 'abort' }
  | { type: 'reset' }
  | { type: 'clear-cache' };

export type WorkerResponse =
  | { type: 'loading'; modelId: ModelId; backend: Backend }
  | { type: 'progress'; file: string; loaded: number; total: number; progress: number }
  | { type: 'ready'; modelId: ModelId; backend: Exclude<Backend, 'auto'>; cachedBytes: number }
  | { type: 'token'; text: string }
  | { type: 'complete'; text: string; elapsedMs: number }
  | { type: 'aborted' }
  | { type: 'reset-done' }
  | { type: 'cache-cleared' }
  | { type: 'error'; message: string; recoverable: boolean };
