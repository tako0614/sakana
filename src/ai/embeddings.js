import { finishModelCall, reserveModelCall } from './cost.js';
import { ProviderError, providerConfig, refreshModelRates } from './provider.js';

const DEFAULT_MODEL = 'qwen/qwen3-embedding-8b';
const DEFAULT_DIMENSIONS = 4096;
const REQUEST_TIMEOUT_MS = 120_000;

function codedError(code, message, details = {}) {
  return Object.assign(new Error(message), { code, retryable:false, ...details });
}

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  if (typeof signal.throwIfAborted === 'function') signal.throwIfAborted();
  throw signal.reason ?? Object.assign(new Error('Embedding request aborted'), { name:'AbortError' });
}

function knownNoCharge(status) {
  return [400,401,402,403,404,405,413,422,429].includes(status);
}

function boundedSignal(signal) {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  return signal ? AbortSignal.any([signal,timeout]) : timeout;
}

function validatedVectors(data, count, dimensions, model) {
  if (!data || typeof data !== 'object' || !Array.isArray(data.data)
    || data.data.length !== count) {
    throw codedError('EMBEDDING_RESPONSE_INVALID', 'OpenRouter returned an incomplete embedding response');
  }
  if (data.model !== model) {
    throw codedError('EMBEDDING_RESPONSE_INVALID', 'OpenRouter returned embeddings from a different model', {
      expectedModel:model,responseModel:data.model
    });
  }
  const vectors = new Array(count);
  for (const item of data.data) {
    const index = item?.index;
    if (!Number.isInteger(index) || index < 0 || index >= count || vectors[index] !== undefined) {
      throw codedError('EMBEDDING_RESPONSE_INVALID', 'OpenRouter returned invalid embedding indexes');
    }
    if (!Array.isArray(item.embedding) || item.embedding.length !== dimensions
      || item.embedding.some(value => typeof value !== 'number' || !Number.isFinite(value))) {
      throw codedError('EMBEDDING_RESPONSE_INVALID', `OpenRouter returned an invalid ${dimensions}-dimension vector`, {
        index
      });
    }
    vectors[index] = item.embedding;
  }
  if (vectors.some(vector => vector === undefined)) {
    throw codedError('EMBEDDING_RESPONSE_INVALID', 'OpenRouter omitted an embedding index');
  }
  return vectors;
}

/**
 * Request exact-model OpenRouter embeddings with verified price routing and
 * the shared durable cost ledger. The caller owns batching and retry policy.
 */
export async function requestEmbeddings({
  model = DEFAULT_MODEL,input,dimensions = DEFAULT_DIMENSIONS,guildId,budgetId = null,
  runId = null,signal,beforeSend
} = {}) {
  if (!providerConfig.apiKey) throw new Error('OPENROUTER_API_KEY is not configured');
  if (typeof model !== 'string' || !model.trim() || model !== model.trim()) {
    throw new TypeError('Embedding model must be a nonempty exact model slug');
  }
  if (!Array.isArray(input) || !input.length) throw new TypeError('Embedding input must be a nonempty string array');
  for (let index = 0; index < input.length; index += 1) {
    if (typeof input[index] !== 'string' || !input[index].length) {
      throw new TypeError(`Embedding input ${index} must be a nonempty string`);
    }
  }
  if (!Number.isInteger(dimensions) || dimensions < 1) {
    throw new TypeError('Embedding dimensions must be a positive integer');
  }
  const texts = input.slice();
  const requestSignal = boundedSignal(signal);
  throwIfAborted(requestSignal);
  const rates = await refreshModelRates(model,requestSignal);
  throwIfAborted(requestSignal);
  if (!rates || rates.verifiedRoute !== 'paid'
    || !Number.isFinite(rates.input) || !Number.isFinite(rates.output)) {
    throw codedError('MODEL_PRICE_UNAVAILABLE', 'Embedding model paid pricing was not verified', { model });
  }

  let reservation;
  let data;
  let sent = false;
  let noCharge = false;
  let finishStatus;
  try {
    // Message-shaped input intentionally overstates the JSON body used by the
    // embedding endpoint; reserveModelCall also adds its fixed byte cushion.
    reservation = reserveModelCall({
      model,messages:texts.map(content => ({ role:'user',content })),tools:null,outputTokens:0,
      guildId,role:'embedding',runId,budgetId
    });
    throwIfAborted(requestSignal);
    await beforeSend?.();
    throwIfAborted(requestSignal);
    sent = true;
    let response;
    try {
      response = await fetch(`${providerConfig.baseUrl}/embeddings`, {
        method:'POST',signal:requestSignal,
        headers:{ 'content-type':'application/json',authorization:`Bearer ${providerConfig.apiKey}` },
        body:JSON.stringify({
          model,input:texts,dimensions,encoding_format:'float',
          provider:{
            sort:'price',allow_fallbacks:true,
            max_price:{ prompt:reservation.rates.input,completion:reservation.rates.output,
              request:reservation.rates.request ?? 0 }
          }
        })
      });
    } catch (cause) {
      throw new ProviderError('OpenRouter embedding transport failed',0,{ cause });
    }
    if (!response.ok) {
      noCharge = knownNoCharge(response.status);
      finishStatus = noCharge ? 'rejected' : undefined;
      throw new ProviderError(`OpenRouter embedding HTTP ${response.status}`,response.status);
    }
    try { data = await response.json(); }
    catch (cause) { throw new ProviderError('OpenRouter embedding response was invalid',0,{ cause }); }
    if (data?.error) {
      const status = Number(data.error.code);
      if (knownNoCharge(status)) { noCharge = true; finishStatus = 'rejected'; }
      throw new ProviderError(`OpenRouter embedding provider error ${data.error.code ?? 'unknown'}`,status);
    }
    const vectors = validatedVectors(data,texts.length,dimensions,model);
    return { vectors,usage:data.usage ?? null,model:data.model };
  } catch (error) {
    if (!sent) { noCharge = true; finishStatus = 'cancelled'; }
    throw error;
  } finally {
    if (reservation) finishModelCall(reservation,data,{ noCharge,status:finishStatus });
  }
}
