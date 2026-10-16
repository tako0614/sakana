// OpenRouter とのやり取りで受け渡す形と、外から来た値 (応答の JSON・SQLite の JSON 列) を
// 確かめる小さな型ガード。応答は読むまで中身が分からないので unknown から絞る。

export type JsonRecord = Record<string, unknown>;

export const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** 配列ならそのまま、そうでなければ空。 */
export const arrayOf = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

/** 有限の数ならその数、そうでなければ undefined。 */
export const finiteNumber = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

/** 投げられた値に付いた細目 (status / code / retryAt …)。Error も普通のオブジェクトとして読む。 */
export const detailsOf = (error: unknown): JsonRecord => (isRecord(error) ? error : {});

export const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** OpenAI 互換の会話の1件。中身はそのまま provider に渡す。 */
export interface ChatMessage {
  role: string;
  content?: unknown;
  [key: string]: unknown;
}

export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters?: unknown;
  };
}

export interface ReasoningOptions {
  effort?: string;
  exclude?: boolean;
  enabled?: boolean;
}

/** usage は provider の数え方をそのまま残し、3つの数だけ必ず数にそろえる。cost は確かめてから使う。 */
export interface ModelUsage extends JsonRecord {
  prompt_tokens: number;
  completion_tokens: number;
  prompt_cache_hit_tokens: number;
  cost?: unknown;
}

/** 応答の message。content / tool_calls / reasoning* は provider によって形が違うので使う側が確かめる。 */
export type ModelMessage = JsonRecord;

export interface ModelChoice extends JsonRecord {
  message: ModelMessage;
  finish_reason?: unknown;
}

export interface ModelResponse extends JsonRecord {
  id?: string;
  model?: string;
  provider?: string;
  choices: [ModelChoice, ...ModelChoice[]];
  usage: ModelUsage;
}

export const isModelChoice = (value: unknown): value is ModelChoice =>
  isRecord(value) && isRecord(value.message);
