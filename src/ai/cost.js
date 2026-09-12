import { randomUUID } from 'node:crypto';
import { db } from '../archive/db.js';

let ready = false;
function ledger() {
  if (ready) return;
  db.transaction(() => {
    db.exec(`CREATE TABLE IF NOT EXISTS ai_model_calls (
      id TEXT PRIMARY KEY,started_at INTEGER NOT NULL,guild_id TEXT,role TEXT NOT NULL,run_id TEXT,
      model TEXT NOT NULL,provider TEXT,generation_id TEXT,status TEXT NOT NULL,
      reserved_usd REAL NOT NULL,rates TEXT NOT NULL,usage TEXT,reported_usd REAL,estimated_usd REAL
    ); CREATE INDEX IF NOT EXISTS idx_ai_model_calls_day ON ai_model_calls(started_at,role);
    CREATE TABLE IF NOT EXISTS ai_model_rates (model TEXT PRIMARY KEY,checked_at INTEGER NOT NULL,rates TEXT NOT NULL);`);
    if (!db.prepare('PRAGMA table_info(ai_model_calls)').all().some(column => column.name === 'estimated_usd'))
      db.exec('ALTER TABLE ai_model_calls ADD COLUMN estimated_usd REAL');
    if (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='memory_writer_calls'").get()) {
      db.exec(`INSERT OR IGNORE INTO ai_model_calls
        (id,started_at,guild_id,role,run_id,model,provider,generation_id,status,reserved_usd,rates,usage,reported_usd,estimated_usd)
        SELECT id,started_at,NULL,'writer',NULL,model,'deepseek',NULL,
          CASE WHEN estimated_usd IS NULL THEN 'unknown' ELSE 'estimated' END,
          reserved_usd,rates,usage,NULL,estimated_usd FROM memory_writer_calls;
        DROP TABLE memory_writer_calls;`);
    }
  })();
  ready = true;
}
export function modelRates(model) {
  ledger();
  const row = db.prepare('SELECT checked_at,rates FROM ai_model_rates WHERE model=?').get(model);
  return row ? { ...JSON.parse(row.rates), checkedAt: row.checked_at } : null;
}
export function saveModelRates(model, rates, now = Date.now()) {
  ledger();
  for (const key of ['input','output','cached','request']) if (!Number.isFinite(rates[key] ?? 0) || (rates[key] ?? 0) < 0) throw new Error('Invalid model price');
  db.prepare('INSERT INTO ai_model_rates VALUES(?,?,?) ON CONFLICT(model) DO UPDATE SET checked_at=excluded.checked_at,rates=excluded.rates')
    .run(model,now,JSON.stringify(rates));
}
export function usageCost(usage, rates) {
  if (Number.isFinite(usage?.cost) && usage.cost >= 0) return usage.cost;
  if (!rates || !Number.isFinite(usage?.prompt_tokens) || !Number.isFinite(usage?.completion_tokens)) return null;
  const cached = usage.prompt_tokens_details?.cached_tokens ?? usage.prompt_cache_hit_tokens ?? 0;
  if (!Number.isFinite(cached)) return null;
  const input = Math.max(0,usage.prompt_tokens), hits = Math.min(input,Math.max(0,cached));
  return ((input-hits)*rates.input + hits*(rates.cached ?? rates.input) + Math.max(0,usage.completion_tokens)*rates.output)/1e6 + (rates.request ?? 0);
}
export function reserveModelCall({ model, messages, tools, outputTokens, guildId = null, role = 'chat', runId = null }, now = Date.now()) {
  ledger();
  const rates = modelRates(model);
  const raw = role === 'writer' ? process.env.MEMORY_WRITER_DAILY_USD : undefined;
  const cap = raw?.trim() ? Number(raw) : null;
  if (cap !== null && (!Number.isFinite(cap) || cap < 0)) throw new Error('MEMORY_WRITER_DAILY_USD must be a nonnegative USD amount');
  if (cap !== null && !rates) throw new Error('A daily cap requires current OpenRouter model pricing');
  const upper = rates ? ((Buffer.byteLength(JSON.stringify({ messages, tools })) + 4096) * rates.input + outputTokens*rates.output)/1e6 + (rates.request ?? 0) : 0;
  const day = Math.floor(now/86400000)*86400000;
  return db.transaction(() => {
    const charged = db.prepare('SELECT coalesce(sum(coalesce(reported_usd,estimated_usd,reserved_usd)),0) n FROM ai_model_calls WHERE role=? AND started_at>=? AND started_at<?').get(role,day,day+86400000).n;
    if (cap !== null && charged+upper > cap) throw Object.assign(new Error('Memory Writer daily budget reached'), { code:'MEMORY_BUDGET_PAUSED',retryAt:day+86400000 });
    const id = randomUUID();
    db.prepare('INSERT INTO ai_model_calls (id,started_at,guild_id,role,run_id,model,status,reserved_usd,rates) VALUES(?,?,?,?,?,?,?,?,?)')
      .run(id,now,guildId,role,runId,model,'pending',upper,JSON.stringify(rates));
    return { id, rates, capped: cap !== null };
  })();
}
export function finishModelCall(reservation, data) {
  const reported = data?.usage?.cost;
  // A token-derived estimate is not an OpenRouter bill. Keep unknown reservations.
  const cost = Number.isFinite(reported) && reported >= 0 ? reported : null;
  db.prepare('UPDATE ai_model_calls SET status=?,provider=?,generation_id=?,usage=?,reported_usd=? WHERE id=?')
    .run(cost === null ? 'unknown' : 'reported',data?.provider ?? null,data?.id ?? null,data?.usage ? JSON.stringify(data.usage) : null,cost,reservation.id);
}
export function modelCostReport({ role, guildId, guildIds, now = Date.now() } = {}) {
  ledger();
  const day = Math.floor(now/86400000)*86400000, args = [day,day+86400000];
  let where = 'started_at>=? AND started_at<?';
  if (role) { where+=' AND role=?'; args.push(role); }
  const scope = guildIds ?? (guildId === undefined ? undefined : [guildId]);
  if (scope !== undefined) { where+= scope.length ? ` AND guild_id IN (${scope.map(() => '?').join(',')})` : ' AND 0'; args.push(...scope); }
  const totals = db.prepare(`SELECT count(*) calls,coalesce(sum(reported_usd),0) reportedUsd,
    coalesce(sum(estimated_usd),0) estimatedUsd,
    coalesce(sum(CASE WHEN reported_usd IS NULL AND estimated_usd IS NULL THEN reserved_usd ELSE 0 END),0) unconfirmedReservedUsd,
    coalesce(sum(reported_usd IS NULL AND estimated_usd IS NULL AND rates='null'),0) unpricedCalls,
    coalesce(sum(status<>'reported'),0) unconfirmedCalls FROM ai_model_calls WHERE ${where}`).get(...args);
  return { currency:'USD',period:new Date(day).toISOString().slice(0,10),...totals,
    byModel: db.prepare(`SELECT role,model,provider,count(*) calls,sum(reported_usd) reportedUsd FROM ai_model_calls WHERE ${where} GROUP BY role,model,provider`).all(...args) };
}
