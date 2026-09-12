import { randomUUID } from 'node:crypto';
import { db } from '../archive/db.js';

// Published USD / 1M tokens, checked 2026-09-12. Record the rate per call;
// changing this table never reprices the historical ledger.
export function memoryRates(model, at = Date.now()) {
  const d = new Date(at), hour = d.getUTCHours(), weekday = d.getUTCDay();
  const peak = weekday >= 1 && weekday <= 5 && ((hour >= 1 && hour < 4) || (hour >= 6 && hour < 10));
  const flash = ['deepseek-flash', 'deepseek-v4-flash', 'deepseek-v4-flash-vision-exp'].includes(model);
  const base = flash ? { input: 0.15, cached: 0.003, output: 0.6 }
    : model === 'deepseek-v4-pro' ? { input: 0.66, cached: 0.022, output: 1.98 } : null;
  return base && { ...Object.fromEntries(Object.entries(base).map(([k,v]) => [k, v * (peak ? 2 : 1)])), peak, checked: '2026-09-12' };
}
export function usageCost(usage, rates) {
  if (!rates || !Number.isFinite(usage?.prompt_tokens) || !Number.isFinite(usage?.completion_tokens) || !Number.isFinite(usage?.prompt_cache_hit_tokens ?? 0)) return null;
  const input = Math.max(0, usage.prompt_tokens), cached = Math.min(input, Math.max(0, usage.prompt_cache_hit_tokens ?? 0));
  return ((input-cached)*rates.input + cached*rates.cached + Math.max(0,usage.completion_tokens)*rates.output) / 1e6;
}
let ready = false;
function ledger() {
  if (ready) return;
  db.exec(`CREATE TABLE IF NOT EXISTS memory_writer_calls (
    id TEXT PRIMARY KEY,started_at INTEGER NOT NULL,model TEXT NOT NULL,status TEXT NOT NULL,
    reserved_usd REAL NOT NULL,rates TEXT NOT NULL,usage TEXT,estimated_usd REAL
  ); CREATE INDEX IF NOT EXISTS idx_memory_writer_call_day ON memory_writer_calls(started_at);`);
  ready = true;
}
export function reserveMemoryCall({ model, messages, tools, outputTokens }, now = Date.now()) {
  ledger();
  const rates = memoryRates(model, now);
  const rawCap = process.env.MEMORY_WRITER_DAILY_USD;
  const cap = rawCap?.trim() ? Number(rawCap) : null;
  if (cap !== null && (!Number.isFinite(cap) || cap < 0)) throw new Error('MEMORY_WRITER_DAILY_USD must be a nonnegative USD amount');
  if (!rates && cap !== null) throw new Error('A daily cap requires known model pricing');
  // UTF-8 bytes plus protocol headroom, at peak rates and without cache credits.
  // Unknown outcomes retain the reservation instead of being counted as free.
  const upper = rates ? ((Buffer.byteLength(JSON.stringify({ messages, tools })) + 4096) * rates.input + outputTokens * rates.output) * (rates.peak ? 1 : 2) / 1e6 : 0;
  const day = Math.floor(now / 86400000) * 86400000;
  return db.transaction(() => {
    const charged = db.prepare('SELECT coalesce(sum(coalesce(estimated_usd,reserved_usd)),0) n FROM memory_writer_calls WHERE started_at>=? AND started_at<?').get(day,day+86400000).n;
    if (cap !== null && charged + upper > cap) throw Object.assign(new Error('Memory Writer daily budget reached'), { code: 'MEMORY_BUDGET_PAUSED', retryAt: day+86400000 });
    const id = randomUUID();
    db.prepare('INSERT INTO memory_writer_calls VALUES(?,?,?,?,?,?,NULL,NULL)').run(id,now,model,'pending',upper,JSON.stringify(rates));
    return { id, rates };
  })();
}
export function finishMemoryCall(reservation, usage) {
  const cost = usageCost(usage, reservation.rates);
  db.prepare('UPDATE memory_writer_calls SET status=?,usage=?,estimated_usd=? WHERE id=?')
    .run(cost === null ? 'unknown' : 'reported', usage ? JSON.stringify(usage) : null, cost, reservation.id);
}
export function memoryCostReport(now = Date.now()) {
  ledger();
  const day = Math.floor(now/86400000)*86400000;
  return { currency: 'USD', period: new Date(day).toISOString().slice(0,10), cap: process.env.MEMORY_WRITER_DAILY_USD?.trim() || null,
    ...db.prepare(`SELECT count(*) calls,coalesce(sum(estimated_usd),0) estimatedUsd,
      coalesce(sum(CASE WHEN estimated_usd IS NULL THEN reserved_usd ELSE 0 END),0) unconfirmedReservedUsd,
      coalesce(sum(status<>'reported'),0) unconfirmedCalls FROM memory_writer_calls WHERE started_at>=? AND started_at<?`).get(day,day+86400000) };
}
export function estimateMemoryBackfill(model, pending, guildIds) {
  const scope = guildIds?.length ? `AND guild_id IN (${guildIds.map(() => '?').join(',')})` : '';
  const sample = db.prepare(`SELECT coalesce(sum(messages),0) messages,coalesce(sum(json_extract(usage,'$.prompt_tokens')),0) prompt_tokens,
    coalesce(sum(json_extract(usage,'$.completion_tokens')),0) completion_tokens,
    coalesce(sum(json_extract(usage,'$.prompt_cache_hit_tokens')),0) prompt_cache_hit_tokens FROM (
      SELECT messages,usage FROM memory_writer_runs WHERE json_extract(usage,'$.prompt_tokens')>0 ${scope} ORDER BY completed_at DESC LIMIT 100)`).get(...(guildIds ?? []));
  if (!sample.messages) return { available: false, reason: 'No completed AI sample yet', pending };
  const usage = Object.fromEntries(['prompt_tokens','completion_tokens','prompt_cache_hit_tokens'].map(k => [k,sample[k]*pending/sample.messages]));
  const offpeak = memoryRates(model, Date.UTC(2026,8,12,12));
  const peak = memoryRates(model, Date.UTC(2026,8,14,2));
  return { available: !!offpeak, pending, sample, offpeakUsd: usageCost(usage, offpeak), peakUsd: usageCost(usage, peak),
    note: 'Recent completed batches extrapolated by message count. Retries, reorganization and a changed corpus/model can increase cost. This is not a bill or a spending authorization.' };
}
