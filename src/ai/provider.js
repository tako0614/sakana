import { modelRates, saveModelRates, reserveModelCall, finishModelCall } from './cost.js';

export const providerConfig = {
  apiKey: process.env.OPENROUTER_API_KEY || '',
  baseUrl: 'https://openrouter.ai/api/v1',
  // 統治 (国会・裁判・警察) と、モデルを指定しない呼び出しの既定。会話 agent は agent/engines.js
  model: process.env.AI_MODEL || 'z-ai/glm-5.3-flash',
};

export class ProviderError extends Error {
  constructor(message, status, details = {}) {
    super(message);
    this.status = status;
    this.retryable = status === 0 || status === 429 || status >= 500;
    Object.assign(this, details);
  }
}

const loading = new Map();
const routeCooldowns = new Map();
const paidRateTtlMs = 3600000;
const freeRateTtlMs = 60000;
const absentFreeTtlMs = 300000;
const isExactFree = (model) => model.endsWith(':free');

function routeError(model, message, retryAt = Date.now()+absentFreeTtlMs) {
  return Object.assign(new Error(message), {
    code:'MODEL_ROUTE_UNAVAILABLE',model,retryAt,retryable:true,fallbackAllowed:true
  });
}

function priceError(model, message) {
  return Object.assign(new Error(message), {
    code:'MODEL_PRICE_UNAVAILABLE',model,retryable:false,fallbackAllowed:true
  });
}

function header(response, name) {
  return response?.headers?.get?.(name) ?? response?.headers?.[name] ?? response?.headers?.[name.toLowerCase()];
}

function retryAtFrom(response, now = Date.now()) {
  const retryAfter = header(response,'retry-after');
  if (retryAfter != null) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return now+seconds*1000;
    const date = Date.parse(retryAfter);
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
    const date = Date.parse(reset);
    if (Number.isFinite(date)) return date;
  }
  return now+60000;
}

function cacheFreeFailure(model, error) {
  if (!isExactFree(model)) return;
  const retryAt = Number.isFinite(error?.retryAt) ? error.retryAt : Date.now()+60000;
  routeCooldowns.set(model,Math.max(Date.now()+1000,retryAt));
}

function freeCooldown(model) {
  const retryAt = routeCooldowns.get(model);
  if (!retryAt) return null;
  if (retryAt <= Date.now()) { routeCooldowns.delete(model); return null; }
  return routeError(model,'Free model route is cooling down',retryAt);
}

function endpointUrl(model) {
  return `${providerConfig.baseUrl}/models/${model.split('/').map(encodeURIComponent).join('/')}/endpoints`;
}

function requestSignal(timeoutMs, deadlineAt) {
  if (Date.now() >= deadlineAt) throw new Error('AI request deadline exceeded');
  return AbortSignal.timeout(Math.max(1,Math.min(timeoutMs,deadlineAt-Date.now())));
}

/** Fetch and cache a verified upper price bound for one exact model route. */
export async function refreshModelRates(model, signal) {
  const free = isExactFree(model);
  const old = modelRates(model);
  const verified = free ? old?.verifiedRoute === 'free' : old?.verifiedRoute === 'paid';
  if (old && verified && Date.now()-old.checkedAt < (free ? freeRateTtlMs : paidRateTtlMs)) return old;
  if (!loading.has(model)) loading.set(model, (async () => {
    let response;
    try { response = await fetch(endpointUrl(model), { signal }); }
    catch (cause) { throw new ProviderError('OpenRouter pricing transport failed',0,{ cause }); }
    if (!response.ok) {
      if (free && response.status === 404) throw routeError(model,'OpenRouter free route was not found');
      throw new ProviderError(`OpenRouter pricing HTTP ${response.status}`,response.status,{
        retryAt:response.status === 429 ? retryAtFrom(response) : undefined
      });
    }
    let body;
    try { body = await response.json(); }
    catch (cause) { throw new ProviderError('OpenRouter pricing response was invalid',0,{ cause }); }
    const endpoints = body.data?.endpoints ?? [];
    if (!Array.isArray(endpoints) || !endpoints.length) {
      const error = free ? routeError(model,'OpenRouter returned no free endpoint pricing')
        : priceError(model,'OpenRouter returned no endpoint pricing');
      if (free) cacheFreeFailure(model,error);
      throw error;
    }
    const bases = endpoints.map(endpoint => endpoint?.pricing);
    if (bases.some(price => !price || ['prompt','completion'].some(key =>
      price[key] == null || !Number.isFinite(Number(price[key])) || Number(price[key]) < 0)))
      throw priceError(model,'OpenRouter returned incomplete endpoint pricing');
    // 時間帯で値段が変わる提供元は overrides に別の価格を持つ (2026-10 に Alibaba が追加)。
    // 配列を「不正な値」として扱うとモデルごと呼べなくなる。各時間帯の価格も1つの価格として
    // 数え、いちばん高いものを上限・見積もりに使う。欠けている項目は基本の価格で埋める。
    const overrideError = bases.some(price => price.overrides != null && (!Array.isArray(price.overrides)
      || price.overrides.some(entry => !entry || typeof entry !== 'object' || Array.isArray(entry))));
    if (overrideError) throw priceError(model,'OpenRouter returned invalid endpoint pricing overrides');
    const prices = bases.flatMap(price => [price, ...(price.overrides ?? []).map(entry => ({ ...price, ...entry }))]);
    // 値段の欄はすべて数値。overrides 自体と時間帯の境目 (utc_start/utc_end) は値段ではない
    const scalar = ([key, value]) => key !== 'overrides' && !key.startsWith('utc_') && value != null && value !== '';
    if (prices.some(price => Object.entries(price).filter(scalar).some(([, value]) =>
      typeof value === 'object' || !Number.isFinite(Number(value)) || Number(value) < 0)))
      throw priceError(model,'OpenRouter returned invalid endpoint pricing');
    if (free && prices.some(price => Object.entries(price).filter(scalar).some(([key, value]) => key !== 'discount' && Number(value) !== 0)))
      throw priceError(model,'Exact free route returned nonzero endpoint pricing');
    const maximum = key => Math.max(...prices.map(price => Number(price[key] ?? 0)));
    const bound = value => Math.ceil(value*1e12)/1e12;
    const rates = { input:bound(maximum('prompt')*1e6),output:bound(maximum('completion')*1e6),
      cached:bound(Math.max(...prices.map(price => Number(price.input_cache_read ?? price.prompt)))*1e6),
      cacheWrite:bound(Math.max(...prices.map(price => Number(price.input_cache_write ?? price.prompt)))*1e6),
      reasoning:bound(Math.max(...prices.map(price => Number(price.internal_reasoning ?? price.completion)))*1e6),
      request:bound(maximum('request')),verifiedRoute:free ? 'free' : 'paid' };
    saveModelRates(model,rates);
    return modelRates(model);
  })().catch(error => {
    if (free && (error.status === 429 || error.code === 'MODEL_ROUTE_UNAVAILABLE')) cacheFreeFailure(model,error);
    throw error;
  }).finally(() => loading.delete(model)));
  return loading.get(model);
}

export function normalizeUsage(usage = {}) {
  return { ...usage, prompt_tokens: usage.prompt_tokens ?? 0,completion_tokens: usage.completion_tokens ?? 0,
    prompt_cache_hit_tokens: usage.prompt_tokens_details?.cached_tokens ?? usage.prompt_cache_hit_tokens ?? 0 };
}

function knownNoCharge(status) {
  return [400,401,402,403,404,405,413,422,429].includes(status);
}

function retryDelay(attempt, error, deadlineAt) {
  const normal = Date.now()+800*(attempt+1);
  const target = Number.isFinite(error.retryAt) ? Math.max(normal,error.retryAt) : normal;
  return target < deadlineAt ? Math.max(0,target-Date.now()) : null;
}

function validateRoutes(model, fallbackModels) {
  if (!Array.isArray(fallbackModels)) throw new Error('fallbackModels must be an array');
  const routes = [model,...(fallbackModels ?? [])];
  if (!routes.length || routes.some(route => typeof route !== 'string' || !route.trim()))
    throw new Error('Model routes must be nonempty strings');
  if (routes.some(route => route === 'openrouter/free'))
    throw Object.assign(new Error('Random free routing is disabled; use an exact :free model route'), { code:'MODEL_ROUTE_INVALID' });
  if (new Set(routes).size !== routes.length) throw new Error('Model fallback routes must be unique');
  return routes;
}

/** All requests share transport and accounting; the host runtime owns tools and effects. */
// 予約した値段 (予算つき) と、呼び出し側の上限 ({ prompt, completion }、100万トークンあたり USD) の低い方。
// OpenRouter の sort:'price' は主に入力の単価で並べるので、出力の多い使い方では出力の高い provider を
// 先に選ぶ (glm-5.3-flash で Reka が出力 $1.6/M、1回 $0.0094 = StreamLake の5.5倍だった)。
function priceCap(reservation, maxPrice) {
  const pick = (reserved, limit) => [reserved, limit].filter(value => Number.isFinite(value)).reduce((a,b) => Math.min(a,b), Infinity);
  const cap = {
    prompt:pick(reservation.capped ? reservation.rates.input : NaN, maxPrice?.prompt),
    completion:pick(reservation.capped ? reservation.rates.output : NaN, maxPrice?.completion)
  };
  if (reservation.capped) cap.request = reservation.rates.request ?? 0;
  for (const key of ['prompt','completion']) if (cap[key] === Infinity) delete cap[key];
  return cap;
}

/** OpenRouter が数えたこのキーの請求額 (USD)。累計・今日・今週・今月 (いずれも UTC)。 */
export async function fetchKeyUsage({ timeoutMs = 15000 } = {}) {
  if (!providerConfig.apiKey) throw new Error('OPENROUTER_API_KEY is not configured');
  const response = await fetch(`${providerConfig.baseUrl}/key`, {
    signal:AbortSignal.timeout(timeoutMs),headers:{authorization:`Bearer ${providerConfig.apiKey}`}
  });
  if (!response.ok) throw new ProviderError(`OpenRouter HTTP ${response.status}`,response.status);
  const data = (await response.json())?.data ?? {};
  const usd = (value) => (Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : null);
  return { total:usd(data.usage),daily:usd(data.usage_daily),weekly:usd(data.usage_weekly),monthly:usd(data.usage_monthly) };
}

export async function requestModel({ model = providerConfig.model,fallbackModels = [],messages,tools,jsonOnly = false,
  maxOutputTokens = 8000,timeoutMs = 120000,deadlineAt = Infinity,reasoning,temperature,
  guildId = null,role = 'chat',runId = null,retries = 0,budgetId = null,consumeRequest,beforeSend,ignoreProviders = [],
  maxPrice = null }) {
  if (!providerConfig.apiKey) throw new Error('OPENROUTER_API_KEY is not configured');
  if (!Number.isInteger(retries) || retries < 0) throw new Error('retries must be a nonnegative integer');
  const routes = validateRoutes(model,fallbackModels);
  let lastError;
  for (let routeIndex = 0; routeIndex < routes.length; routeIndex += 1) {
    const route = routes[routeIndex];
    const free = isExactFree(route);
    let rates;
    try {
      const cooling = free && freeCooldown(route);
      if (cooling) throw cooling;
      rates = await refreshModelRates(route,requestSignal(timeoutMs,deadlineAt));
      if (free && rates.verifiedRoute !== 'free') throw priceError(route,'Free route price was not verified');
      if (!free && rates.verifiedRoute !== 'paid') throw priceError(route,'Paid route price was not verified');
    } catch (error) {
      if (free && (error.retryable || error.fallbackAllowed)) cacheFreeFailure(route,error);
      if (routeIndex+1 < routes.length && error.status !== 401 && error.status !== 402
        && (error.retryable || error.fallbackAllowed)) { lastError = error; continue; }
      throw error;
    }
    for (let attempt = 0; ; attempt += 1) {
      let reservation;
      let data;
      let sent = false;
      let noCharge = false;
      let finishStatus;
      try {
        reservation = reserveModelCall({ model:route,messages,tools,outputTokens:maxOutputTokens,guildId,role,runId,budgetId });
        const signal = requestSignal(timeoutMs,deadlineAt);
        await beforeSend?.();
        if (consumeRequest) await consumeRequest({ model:route });
        sent = true;
        let response;
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
        if (data.error) {
          const status = Number(data.error.code);
          if (knownNoCharge(status)) { noCharge = true; finishStatus = 'rejected'; }
          const error = new ProviderError(`OpenRouter provider error ${data.error.code ?? 'unknown'}`,status);
          if (free && (status === 400 || status === 404)) error.fallbackAllowed = true;
          throw error;
        }
        data = {...data,usage:normalizeUsage(data.usage)};
        // どの provider で切れたかを呼び出し側へ渡す (暴走する provider を外すため)
        if (data.choices?.[0]?.finish_reason === 'length') throw Object.assign(new Error('AI output was truncated'),{provider:data.provider});
        if (!data.choices?.[0]?.message) throw new Error('OpenRouter returned no message');
        if (free && !Number.isFinite(data.usage.cost)) { noCharge = true; finishStatus = 'verified_free'; }
        return data;
      } catch (error) {
        if (!sent) { noCharge = true; finishStatus = 'cancelled'; }
        if (free && (error.retryable || error.fallbackAllowed)) cacheFreeFailure(route,error);
        const delay = !free && error.retryable && attempt < retries ? retryDelay(attempt,error,deadlineAt) : null;
        if (delay !== null) { await new Promise(resolve => setTimeout(resolve,delay)); continue; }
        const canFallback = routeIndex+1 < routes.length && error.status !== 401 && error.status !== 402
          && (error.retryable || error.fallbackAllowed);
        if (canFallback) { lastError = error; break; }
        throw error;
      } finally {
        if (reservation) finishModelCall(reservation,data,{ noCharge,status:finishStatus });
      }
    }
  }
  throw lastError ?? new Error('No model route was available');
}
