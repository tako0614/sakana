import { modelRates, saveModelRates, reserveModelCall, finishModelCall, type ModelReservation, type StoredModelRates } from './cost.js';
import {
  arrayOf, detailsOf, isModelChoice, isRecord,
  type ChatMessage, type JsonRecord, type ModelChoice, type ModelResponse, type ModelUsage, type ReasoningOptions, type ToolDefinition
} from './types.js';

export type { ChatMessage, ModelChoice, ModelMessage, ModelResponse, ModelUsage, ReasoningOptions, ToolDefinition } from './types.js';

export const providerConfig = {
  apiKey: process.env.OPENROUTER_API_KEY || '',
  baseUrl: 'https://openrouter.ai/api/v1',
  // 統治 (国会・裁判・警察) と、モデルを指定しない呼び出しの既定。会話 agent は agent/engines.js
  model: process.env.AI_MODEL || 'z-ai/glm-5.3-flash',
};

export class ProviderError extends Error {
  status: number;
  retryable: boolean;
  declare retryAt?: number;
  declare fallbackAllowed?: boolean;
  constructor(message: string, status: number, details: { retryAt?: number | undefined; cause?: unknown } = {}) {
    super(message);
    this.status = status;
    this.retryable = status === 0 || status === 429 || status >= 500;
    Object.assign(this, details);
  }
}

/** 呼び出し側 (fallback・builder) が見る細目を持つエラー。route / price の失敗。 */
export interface RouteFailure extends Error {
  code: 'MODEL_ROUTE_UNAVAILABLE' | 'MODEL_PRICE_UNAVAILABLE';
  model: string;
  retryAt?: number;
  retryable: boolean;
  fallbackAllowed: boolean;
}

const loading = new Map<string, Promise<StoredModelRates | null>>();
const routeCooldowns = new Map<string, number>();
const paidRateTtlMs = 3600000;
const freeRateTtlMs = 60000;
const absentFreeTtlMs = 300000;
const isExactFree = (model: string): boolean => model.endsWith(':free');

function routeError(model: string, message: string, retryAt = Date.now()+absentFreeTtlMs): RouteFailure {
  return Object.assign(new Error(message), {
    code:'MODEL_ROUTE_UNAVAILABLE' as const,model,retryAt,retryable:true,fallbackAllowed:true
  });
}

function priceError(model: string, message: string): RouteFailure {
  return Object.assign(new Error(message), {
    code:'MODEL_PRICE_UNAVAILABLE' as const,model,retryable:false,fallbackAllowed:true
  });
}

// fetch の応答 (検査では headers が Map や get だけを持つ偽物のこともある)
interface HeaderReader { get(name: string): unknown }
const canGet = (value: unknown): value is HeaderReader => isRecord(value) && typeof value.get === 'function';

function header(response: { headers?: unknown } | null | undefined, name: string): unknown {
  const headers = response?.headers;
  const read = canGet(headers) ? headers.get(name) : undefined;
  if (read != null) return read;
  return isRecord(headers) ? headers[name] ?? headers[name.toLowerCase()] : undefined;
}

function retryAtFrom(response: { headers?: unknown } | null | undefined, now = Date.now()): number {
  const retryAfter = header(response,'retry-after');
  if (retryAfter != null) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return now+seconds*1000;
    const date = Date.parse(String(retryAfter));
    if (Number.isFinite(date)) return date;
  }
  const reset = header(response,'x-ratelimit-reset');
  if (reset != null) {
    const number = Number(reset);
    if (Number.isFinite(number) && number >= 0) {
      if (number > 1e12) return number;
      if (number > 1e9) return number*1000;
      return now+number*1000;
    }
    const date = Date.parse(String(reset));
    if (Number.isFinite(date)) return date;
  }
  return now+60000;
}

/** 失敗に付いた再開の時刻。有限の数でなければ undefined。 */
function retryAtOf(error: unknown): number | undefined {
  const retryAt = detailsOf(error).retryAt;
  return typeof retryAt === 'number' && Number.isFinite(retryAt) ? retryAt : undefined;
}

function cacheFreeFailure(model: string, error: unknown): void {
  if (!isExactFree(model)) return;
  const retryAt = retryAtOf(error) ?? Date.now()+60000;
  routeCooldowns.set(model,Math.max(Date.now()+1000,retryAt));
}

function freeCooldown(model: string): RouteFailure | null {
  const retryAt = routeCooldowns.get(model);
  if (!retryAt) return null;
  if (retryAt <= Date.now()) { routeCooldowns.delete(model); return null; }
  return routeError(model,'Free model route is cooling down',retryAt);
}

function endpointUrl(model: string): string {
  return `${providerConfig.baseUrl}/models/${model.split('/').map(encodeURIComponent).join('/')}/endpoints`;
}

function requestSignal(timeoutMs: number, deadlineAt: number): AbortSignal {
  if (Date.now() >= deadlineAt) throw new Error('AI request deadline exceeded');
  return AbortSignal.timeout(Math.max(1,Math.min(timeoutMs,deadlineAt-Date.now())));
}

/** Fetch and cache a verified upper price bound for one exact model route. */
export async function refreshModelRates(model: string, signal?: AbortSignal): Promise<StoredModelRates | null> {
  const free = isExactFree(model);
  const old = modelRates(model);
  const verified = free ? old?.verifiedRoute === 'free' : old?.verifiedRoute === 'paid';
  if (old && verified && Date.now()-old.checkedAt < (free ? freeRateTtlMs : paidRateTtlMs)) return old;
  let pending = loading.get(model);
  if (!pending) {
    pending = (async () => {
      let response: Response;
      try { response = await fetch(endpointUrl(model), { signal }); }
      catch (cause) { throw new ProviderError('OpenRouter pricing transport failed',0,{ cause }); }
      if (!response.ok) {
        if (free && response.status === 404) throw routeError(model,'OpenRouter free route was not found');
        throw new ProviderError(`OpenRouter pricing HTTP ${response.status}`,response.status,{
          retryAt:response.status === 429 ? retryAtFrom(response) : undefined
        });
      }
      let body: unknown;
      try { body = await response.json(); }
      catch (cause) { throw new ProviderError('OpenRouter pricing response was invalid',0,{ cause }); }
      const data = isRecord(body) ? body.data : undefined;
      const endpoints = (isRecord(data) ? data.endpoints : undefined) ?? [];
      if (!Array.isArray(endpoints) || !endpoints.length) {
        const error = free ? routeError(model,'OpenRouter returned no free endpoint pricing')
          : priceError(model,'OpenRouter returned no endpoint pricing');
        if (free) cacheFreeFailure(model,error);
        throw error;
      }
      const raw = arrayOf(endpoints).map((endpoint) => (isRecord(endpoint) ? endpoint.pricing : undefined));
      const bases = raw.filter(isRecord);
      if (bases.length !== raw.length || bases.some(price => ['prompt','completion'].some(key =>
        price[key] == null || !Number.isFinite(Number(price[key])) || Number(price[key]) < 0)))
        throw priceError(model,'OpenRouter returned incomplete endpoint pricing');
      // 時間帯で値段が変わる提供元は overrides に別の価格を持つ (2026-10 に Alibaba が追加)。
      // 配列を「不正な値」として扱うとモデルごと呼べなくなる。各時間帯の価格も1つの価格として
      // 数え、いちばん高いものを上限・見積もりに使う。欠けている項目は基本の価格で埋める。
      const overrideError = bases.some(price => price.overrides != null && (!Array.isArray(price.overrides)
        || arrayOf(price.overrides).some(entry => !isRecord(entry))));
      if (overrideError) throw priceError(model,'OpenRouter returned invalid endpoint pricing overrides');
      const prices: JsonRecord[] = bases.flatMap(price => [price, ...arrayOf(price.overrides).filter(isRecord).map(entry => ({ ...price, ...entry }))]);
      // 値段の欄はすべて数値。overrides 自体と時間帯の境目 (utc_start/utc_end) は値段ではない
      const scalar = ([key, value]: [string, unknown]): boolean => key !== 'overrides' && !key.startsWith('utc_') && value != null && value !== '';
      if (prices.some(price => Object.entries(price).filter(scalar).some(([, value]) =>
        typeof value === 'object' || !Number.isFinite(Number(value)) || Number(value) < 0)))
        throw priceError(model,'OpenRouter returned invalid endpoint pricing');
      if (free && prices.some(price => Object.entries(price).filter(scalar).some(([key, value]) => key !== 'discount' && Number(value) !== 0)))
        throw priceError(model,'Exact free route returned nonzero endpoint pricing');
      const maximum = (key: string): number => Math.max(...prices.map(price => Number(price[key] ?? 0)));
      const bound = (value: number): number => Math.ceil(value*1e12)/1e12;
      const rates = { input:bound(maximum('prompt')*1e6),output:bound(maximum('completion')*1e6),
        cached:bound(Math.max(...prices.map(price => Number(price.input_cache_read ?? price.prompt)))*1e6),
        cacheWrite:bound(Math.max(...prices.map(price => Number(price.input_cache_write ?? price.prompt)))*1e6),
        reasoning:bound(Math.max(...prices.map(price => Number(price.internal_reasoning ?? price.completion)))*1e6),
        request:bound(maximum('request')),verifiedRoute:free ? 'free' as const : 'paid' as const };
      saveModelRates(model,rates);
      return modelRates(model);
    })().catch((error: unknown) => {
      const details = detailsOf(error);
      if (free && (details.status === 429 || details.code === 'MODEL_ROUTE_UNAVAILABLE')) cacheFreeFailure(model,error);
      throw error;
    }).finally(() => loading.delete(model));
    loading.set(model, pending);
  }
  return pending;
}

export function normalizeUsage(usage: unknown = {}): ModelUsage {
  const raw = isRecord(usage) ? usage : {};
  const details = isRecord(raw.prompt_tokens_details) ? raw.prompt_tokens_details : {};
  const count = (value: unknown): number | undefined => (typeof value === 'number' ? value : undefined);
  return { ...raw, prompt_tokens: count(raw.prompt_tokens) ?? 0,completion_tokens: count(raw.completion_tokens) ?? 0,
    prompt_cache_hit_tokens: count(details.cached_tokens) ?? count(raw.prompt_cache_hit_tokens) ?? 0 };
}

function knownNoCharge(status: number): boolean {
  return [400,401,402,403,404,405,413,422,429].includes(status);
}

function retryDelay(attempt: number, error: unknown, deadlineAt: number): number | null {
  const normal = Date.now()+800*(attempt+1);
  const retryAt = retryAtOf(error);
  const target = retryAt !== undefined ? Math.max(normal,retryAt) : normal;
  return target < deadlineAt ? Math.max(0,target-Date.now()) : null;
}

function validateRoutes(model: string, fallbackModels: readonly string[]): string[] {
  if (!Array.isArray(fallbackModels)) throw new Error('fallbackModels must be an array');
  const routes: unknown[] = [model,...(fallbackModels ?? [])];
  const valid = routes.filter((route): route is string => typeof route === 'string' && Boolean(route.trim()));
  if (!routes.length || valid.length !== routes.length)
    throw new Error('Model routes must be nonempty strings');
  if (valid.some(route => route === 'openrouter/free'))
    throw Object.assign(new Error('Random free routing is disabled; use an exact :free model route'), { code:'MODEL_ROUTE_INVALID' });
  if (new Set(valid).size !== valid.length) throw new Error('Model fallback routes must be unique');
  return valid;
}

/** 100万トークンあたり USD の上限。 */
export interface MaxPrice {
  prompt?: number;
  completion?: number;
}

/** All requests share transport and accounting; the host runtime owns tools and effects. */
// 予約した値段 (予算つき) と、呼び出し側の上限 ({ prompt, completion }、100万トークンあたり USD) の低い方。
// OpenRouter の sort:'price' は主に入力の単価で並べるので、出力の多い使い方では出力の高い provider を
// 先に選ぶ (glm-5.3-flash で Reka が出力 $1.6/M、1回 $0.0094 = StreamLake の5.5倍だった)。
function priceCap(reservation: ModelReservation, maxPrice: MaxPrice | null | undefined): MaxPrice & { request?: number } {
  const pick = (reserved: number | undefined, limit: number | undefined): number =>
    [reserved, limit].filter((value): value is number => Number.isFinite(value)).reduce((a,b) => Math.min(a,b), Infinity);
  const cap: MaxPrice & { request?: number } = {
    prompt:pick(reservation.capped ? reservation.rates?.input : NaN, maxPrice?.prompt),
    completion:pick(reservation.capped ? reservation.rates?.output : NaN, maxPrice?.completion)
  };
  if (reservation.capped) cap.request = reservation.rates?.request ?? 0;
  for (const key of ['prompt','completion'] as const) if (cap[key] === Infinity) delete cap[key];
  return cap;
}

export interface KeyUsage {
  total: number | null;
  daily: number | null;
  weekly: number | null;
  monthly: number | null;
}

/** OpenRouter が数えたこのキーの請求額 (USD)。累計・今日・今週・今月 (いずれも UTC)。 */
export async function fetchKeyUsage({ timeoutMs = 15000 }: { timeoutMs?: number } = {}): Promise<KeyUsage> {
  if (!providerConfig.apiKey) throw new Error('OPENROUTER_API_KEY is not configured');
  const response = await fetch(`${providerConfig.baseUrl}/key`, {
    signal:AbortSignal.timeout(timeoutMs),headers:{authorization:`Bearer ${providerConfig.apiKey}`}
  });
  if (!response.ok) throw new ProviderError(`OpenRouter HTTP ${response.status}`,response.status);
  const body: unknown = await response.json();
  const data = isRecord(body) && isRecord(body.data) ? body.data : {};
  const usd = (value: unknown): number | null => (Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : null);
  return { total:usd(data.usage),daily:usd(data.usage_daily),weekly:usd(data.usage_weekly),monthly:usd(data.usage_monthly) };
}

export interface RequestModelOptions {
  model?: string;
  fallbackModels?: readonly string[];
  messages: readonly ChatMessage[];
  tools?: readonly ToolDefinition[] | null;
  jsonOnly?: boolean;
  maxOutputTokens?: number;
  timeoutMs?: number;
  deadlineAt?: number;
  reasoning?: ReasoningOptions;
  temperature?: number;
  guildId?: string | null;
  role?: string;
  runId?: string | null;
  retries?: number;
  budgetId?: string | null;
  /** 送る直前に1回ずつ呼ぶ (回数の上限を数える)。投げれば送らない。 */
  consumeRequest?: (request: { model: string }) => unknown;
  beforeSend?: () => unknown;
  ignoreProviders?: readonly string[];
  maxPrice?: MaxPrice | null;
}

/** 応答の choices[0] を確かめて形を決める。message が無ければ投げる。 */
function modelResponse(data: JsonRecord & { usage: ModelUsage }): ModelResponse {
  const [first, ...rest] = arrayOf(data.choices);
  if (!isModelChoice(first)) throw new Error('OpenRouter returned no message');
  const choices: [ModelChoice, ...ModelChoice[]] = [first, ...rest.filter(isModelChoice)];
  const response: ModelResponse = { ...data, choices };
  // id / model / provider は文字列のときだけ残す (台帳の列に入る)
  for (const key of ['id', 'model', 'provider'] as const) if (key in data && typeof data[key] !== 'string') delete response[key];
  return response;
}

export async function requestModel({ model = providerConfig.model,fallbackModels = [],messages,tools,jsonOnly = false,
  maxOutputTokens = 8000,timeoutMs = 120000,deadlineAt = Infinity,reasoning,temperature,
  guildId = null,role = 'chat',runId = null,retries = 0,budgetId = null,consumeRequest,beforeSend,ignoreProviders = [],
  maxPrice = null }: RequestModelOptions): Promise<ModelResponse> {
  if (!providerConfig.apiKey) throw new Error('OPENROUTER_API_KEY is not configured');
  if (!Number.isInteger(retries) || retries < 0) throw new Error('retries must be a nonnegative integer');
  const routes = validateRoutes(model,fallbackModels);
  let lastError: unknown;
  for (const [routeIndex, route] of routes.entries()) {
    const free = isExactFree(route);
    let rates: StoredModelRates | null;
    try {
      const cooling = free && freeCooldown(route);
      if (cooling) throw cooling;
      rates = await refreshModelRates(route,requestSignal(timeoutMs,deadlineAt));
      if (free && rates?.verifiedRoute !== 'free') throw priceError(route,'Free route price was not verified');
      if (!free && rates?.verifiedRoute !== 'paid') throw priceError(route,'Paid route price was not verified');
    } catch (error) {
      const details = detailsOf(error);
      if (free && (details.retryable || details.fallbackAllowed)) cacheFreeFailure(route,error);
      if (routeIndex+1 < routes.length && details.status !== 401 && details.status !== 402
        && (details.retryable || details.fallbackAllowed)) { lastError = error; continue; }
      throw error;
    }
    for (let attempt = 0; ; attempt += 1) {
      let reservation: ModelReservation | undefined;
      let data: unknown;
      let sent = false;
      let noCharge = false;
      let finishStatus: string | undefined;
      try {
        reservation = reserveModelCall({ model:route,messages,tools,outputTokens:maxOutputTokens,guildId,role,runId,budgetId });
        const signal = requestSignal(timeoutMs,deadlineAt);
        await beforeSend?.();
        if (consumeRequest) await consumeRequest({ model:route });
        sent = true;
        let response: Response;
        try {
          response = await fetch(`${providerConfig.baseUrl}/chat/completions`, {
            method:'POST',signal,
            headers:{'content-type':'application/json',authorization:`Bearer ${providerConfig.apiKey}`},
            body:JSON.stringify({ model:route,messages,stream:false,max_tokens:maxOutputTokens,
              provider:{sort:'price',require_parameters:true,allow_fallbacks:true,
                ...(ignoreProviders.length ? {ignore:ignoreProviders} : {}),
                ...(reservation.capped || maxPrice ? {max_price:priceCap(reservation,maxPrice)} : {})},
              ...(tools?.length ? {tools,tool_choice:'auto'} : {}),
              ...(jsonOnly ? {response_format:{type:'json_object'}} : {}),
              ...(reasoning ? {reasoning} : {}),...(temperature !== undefined ? {temperature} : {}) })
          });
        } catch (cause) { throw new ProviderError('OpenRouter transport failed',0,{ cause }); }
        if (!response.ok) {
          noCharge = knownNoCharge(response.status);
          finishStatus = noCharge ? 'rejected' : undefined;
          const error = new ProviderError(`OpenRouter HTTP ${response.status}`,response.status,{
            retryAt:response.status === 429 ? retryAtFrom(response) : undefined
          });
          if (free && (response.status === 400 || response.status === 404)) error.fallbackAllowed = true;
          throw error;
        }
        try { data = await response.json(); }
        catch (cause) { throw new ProviderError('OpenRouter response was invalid',0,{ cause }); }
        const body: JsonRecord = isRecord(data) ? data : {};
        if (body.error) {
          const code = isRecord(body.error) ? body.error.code : undefined;
          const status = Number(code);
          if (knownNoCharge(status)) { noCharge = true; finishStatus = 'rejected'; }
          const error = new ProviderError(`OpenRouter provider error ${String(code ?? 'unknown')}`,status);
          if (free && (status === 400 || status === 404)) error.fallbackAllowed = true;
          throw error;
        }
        const normalized: JsonRecord & { usage: ModelUsage } = {...body,usage:normalizeUsage(body.usage)};
        data = normalized;
        // どの provider で切れたかを呼び出し側へ渡す (暴走する provider を外すため)
        const [first] = arrayOf(normalized.choices);
        if (isRecord(first) && first.finish_reason === 'length') throw Object.assign(new Error('AI output was truncated'),{provider:normalized.provider});
        const result = modelResponse(normalized);
        if (free && !Number.isFinite(result.usage.cost)) { noCharge = true; finishStatus = 'verified_free'; }
        return result;
      } catch (error) {
        if (!sent) { noCharge = true; finishStatus = 'cancelled'; }
        const details = detailsOf(error);
        if (free && (details.retryable || details.fallbackAllowed)) cacheFreeFailure(route,error);
        const delay = !free && details.retryable && attempt < retries ? retryDelay(attempt,error,deadlineAt) : null;
        if (delay !== null) { await new Promise(resolve => setTimeout(resolve,delay)); continue; }
        const canFallback = routeIndex+1 < routes.length && details.status !== 401 && details.status !== 402
          && (details.retryable || details.fallbackAllowed);
        if (canFallback) { lastError = error; break; }
        throw error;
      } finally {
        if (reservation) finishModelCall(reservation,data,{ noCharge,status:finishStatus });
      }
    }
  }
  throw lastError ?? new Error('No model route was available');
}
