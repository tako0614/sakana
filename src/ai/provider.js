import { modelRates, saveModelRates, reserveModelCall, finishModelCall } from './cost.js';

export const providerConfig = {
  apiKey: process.env.OPENROUTER_API_KEY || '',
  baseUrl: 'https://openrouter.ai/api/v1',
  model: process.env.AI_MODEL || 'deepseek/deepseek-v4-flash-0731',
  writerModel: process.env.MEMORY_WRITER_MODEL || 'inclusionai/ling-3.0-flash',
};
export class ProviderError extends Error {
  constructor(message, status) { super(message); this.status = status; this.retryable = status === 429 || status >= 500; }
}
const loading = new Map();
export async function refreshModelRates(model, signal) {
  const old = modelRates(model);
  if (old && Date.now()-old.checkedAt < 3600000) return old;
  if (!loading.has(model)) loading.set(model, (async () => {
    const response = await fetch(`${providerConfig.baseUrl}/models/${model.split('/').map(encodeURIComponent).join('/')}/endpoints`, { signal });
    if (!response.ok) throw new ProviderError(`OpenRouter pricing HTTP ${response.status}`,response.status);
    const body = await response.json();
    const prices = (body.data?.endpoints ?? []).map(endpoint => endpoint.pricing).filter(Boolean);
    if (!prices.length) throw new Error('OpenRouter returned no endpoint pricing');
    if (prices.some(price => ['prompt','completion'].some(key => price[key] == null || !Number.isFinite(Number(price[key])) || Number(price[key]) < 0)))
      throw new Error('OpenRouter returned incomplete endpoint pricing');
    const maximum = key => Math.max(...prices.map(price => Number(price[key] ?? 0)));
    const rates = { input:maximum('prompt')*1e6,output:maximum('completion')*1e6,
      cached:Math.max(...prices.map(price => Number(price.input_cache_read ?? price.prompt)))*1e6,request:maximum('request') };
    saveModelRates(model,rates);
    return modelRates(model);
  })().finally(() => loading.delete(model)));
  return loading.get(model);
}
export function normalizeUsage(usage = {}) {
  return { ...usage, prompt_tokens: usage.prompt_tokens ?? 0,completion_tokens: usage.completion_tokens ?? 0,
    prompt_cache_hit_tokens: usage.prompt_tokens_details?.cached_tokens ?? usage.prompt_cache_hit_tokens ?? 0 };
}
/** All paid requests share transport and accounting; the host runtime owns tools and effects. */
export async function requestModel({ model = providerConfig.model,messages,tools,jsonOnly = false,
  maxOutputTokens = 8000,timeoutMs = 120000,deadlineAt = Infinity,reasoning,temperature,
  guildId = null,role = 'chat',runId = null,retries = 0 }) {
  if (!providerConfig.apiKey) throw new Error('OPENROUTER_API_KEY is not configured');
  for (let attempt = 0; ; attempt++) {
    if (Date.now() >= deadlineAt) throw new Error('AI request deadline exceeded');
    const signal = AbortSignal.timeout(Math.max(1,Math.min(timeoutMs,deadlineAt-Date.now())));
    try { await refreshModelRates(model, signal); }
    catch (error) { if (role === 'writer' && process.env.MEMORY_WRITER_DAILY_USD?.trim()) throw error; }
    const reservation = reserveModelCall({ model,messages,tools,outputTokens:maxOutputTokens,guildId,role,runId });
    let data;
    try {
      const response = await fetch(`${providerConfig.baseUrl}/chat/completions`, {
        method:'POST',signal,headers:{'content-type':'application/json',authorization:`Bearer ${providerConfig.apiKey}`},
        body:JSON.stringify({ model,messages,stream:false,max_tokens:maxOutputTokens,
          provider:{sort:'price',require_parameters:true,allow_fallbacks:true,
            ...(reservation.capped ? {max_price:{prompt:reservation.rates.input,completion:reservation.rates.output,request:reservation.rates.request ?? 0}} : {})},
          ...(tools?.length ? {tools,tool_choice:'auto'} : {}),
          ...(jsonOnly ? {response_format:{type:'json_object'}} : {}),
          ...(reasoning ? {reasoning} : {}),...(temperature !== undefined ? {temperature} : {}) })
      });
      if (!response.ok) throw new ProviderError(`OpenRouter HTTP ${response.status}`,response.status);
      data = await response.json();
      if (data.error) throw new ProviderError(`OpenRouter provider error ${data.error.code ?? 'unknown'}`,Number(data.error.code));
      if (data.choices?.[0]?.finish_reason === 'length') throw new Error('AI output was truncated');
      if (!data.choices?.[0]?.message) throw new Error('OpenRouter returned no message');
      return {...data,usage:normalizeUsage(data.usage)};
    } catch (error) {
      if (!(error.retryable && attempt < retries && Date.now()+800*(attempt+1) < deadlineAt)) throw error;
      await new Promise(resolve => setTimeout(resolve,800*(attempt+1)));
    } finally { finishModelCall(reservation,data); }
  }
}
