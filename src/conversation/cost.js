import { db } from '../archive/db.js';
import { modelRates, usageCost, reserveModelCall, finishModelCall, modelCostReport } from '../ai/cost.js';
export { usageCost };
export const memoryRates = modelRates;
export const reserveMemoryCall = (input, now) => reserveModelCall({ ...input, role: 'writer' }, now);
export const finishMemoryCall = (reservation, usage) => finishModelCall(reservation, { usage });
export const memoryCostReport = (now, guildIds) => ({ ...modelCostReport({ role: 'writer', now, guildIds }), cap: process.env.MEMORY_WRITER_DAILY_USD?.trim() || null });
export function estimateMemoryBackfill(model, pending, guildIds) {
  const scope = guildIds === undefined ? '' : guildIds.length ? `AND guild_id IN (${guildIds.map(() => '?').join(',')})` : 'AND 0';
  const sample = db.prepare(`SELECT coalesce(sum(messages),0) messages,coalesce(sum(json_extract(usage,'$.prompt_tokens')),0) prompt_tokens,
    coalesce(sum(json_extract(usage,'$.completion_tokens')),0) completion_tokens,
    coalesce(sum(json_extract(usage,'$.prompt_cache_hit_tokens')),0) prompt_cache_hit_tokens FROM (
      SELECT messages,usage FROM memory_writer_runs WHERE json_extract(usage,'$.prompt_tokens')>0 ${scope} ORDER BY completed_at DESC LIMIT 100)`).get(...(guildIds ?? []));
  if (!sample.messages) return { available: false, reason: 'No completed AI sample yet', pending };
  const usage = Object.fromEntries(['prompt_tokens','completion_tokens','prompt_cache_hit_tokens'].map(k => [k,sample[k]*pending/sample.messages]));
  const rates = memoryRates(model);
  return { available: !!rates, pending, sample, estimatedUsd: usageCost(usage, rates),
    note: 'Recent completed batches extrapolated by message count. Retries, reorganization and a changed corpus/model can increase cost. This is not a bill or a spending authorization.' };
}
