import { randomUUID } from 'node:crypto';
import { db } from '../archive/db.js';

let ready = false;
const BUDGET_TOTALS_VERSION = 1;

function ledger() {
  if (ready) return;
  db.pragma('busy_timeout = 5000');
  db.transaction(() => {
    db.exec(`CREATE TABLE IF NOT EXISTS ai_model_calls (
      id TEXT PRIMARY KEY,started_at INTEGER NOT NULL,guild_id TEXT,role TEXT NOT NULL,run_id TEXT,
      model TEXT NOT NULL,provider TEXT,generation_id TEXT,status TEXT NOT NULL,
      reserved_usd REAL NOT NULL,rates TEXT NOT NULL,usage TEXT,reported_usd REAL,estimated_usd REAL
    ); CREATE INDEX IF NOT EXISTS idx_ai_model_calls_day ON ai_model_calls(started_at,role);
    CREATE TABLE IF NOT EXISTS ai_model_rates (model TEXT PRIMARY KEY,checked_at INTEGER NOT NULL,rates TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS ai_model_budgets (
      id TEXT PRIMARY KEY,guild_id TEXT NOT NULL,limit_usd REAL NOT NULL,
      paused INTEGER NOT NULL DEFAULT 0,pause_reason TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,
      calls INTEGER NOT NULL DEFAULT 0,reported_usd REAL NOT NULL DEFAULT 0,
      estimated_usd REAL NOT NULL DEFAULT 0,reserved_usd REAL NOT NULL DEFAULT 0,
      unknown_calls INTEGER NOT NULL DEFAULT 0,totals_version INTEGER NOT NULL DEFAULT 0
    );`);
    if (!db.prepare('PRAGMA table_info(ai_model_calls)').all().some(column => column.name === 'estimated_usd'))
      db.exec('ALTER TABLE ai_model_calls ADD COLUMN estimated_usd REAL');
    if (!db.prepare('PRAGMA table_info(ai_model_calls)').all().some(column => column.name === 'budget_id'))
      db.exec('ALTER TABLE ai_model_calls ADD COLUMN budget_id TEXT');
    const budgetColumns = new Set(db.prepare('PRAGMA table_info(ai_model_budgets)').all().map(column => column.name));
    const additions = [
      ['pause_reason','TEXT'],
      ['calls','INTEGER NOT NULL DEFAULT 0'],
      ['reported_usd','REAL NOT NULL DEFAULT 0'],
      ['estimated_usd','REAL NOT NULL DEFAULT 0'],
      ['reserved_usd','REAL NOT NULL DEFAULT 0'],
      ['unknown_calls','INTEGER NOT NULL DEFAULT 0'],
      ['totals_version','INTEGER NOT NULL DEFAULT 0']
    ];
    for (const [name,definition] of additions) {
      if (!budgetColumns.has(name)) db.exec(`ALTER TABLE ai_model_budgets ADD COLUMN ${name} ${definition}`);
    }
    db.exec('CREATE INDEX IF NOT EXISTS idx_ai_model_calls_budget ON ai_model_calls(budget_id,started_at)');
    if (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='memory_writer_calls'").get()) {
      db.exec(`INSERT OR IGNORE INTO ai_model_calls
        (id,started_at,guild_id,role,run_id,model,provider,generation_id,status,reserved_usd,rates,usage,reported_usd,estimated_usd)
        SELECT id,started_at,NULL,'writer',NULL,model,'deepseek',NULL,
          CASE WHEN estimated_usd IS NULL THEN 'unknown' ELSE 'estimated' END,
          reserved_usd,rates,usage,NULL,estimated_usd FROM memory_writer_calls;
        DROP TABLE memory_writer_calls;`);
    }
    // Upgrade prior lifetime budgets once. The temporary aggregate scans the
    // immutable call ledger once, then each budget is filled by a primary-key
    // lookup. Future reserve/finish/status paths only touch one budget row.
    if (db.prepare('SELECT 1 FROM ai_model_budgets WHERE totals_version<? LIMIT 1')
      .get(BUDGET_TOTALS_VERSION)) {
      db.exec(`DROP TABLE IF EXISTS temp.ai_model_budget_backfill;
        CREATE TEMP TABLE ai_model_budget_backfill (
          id TEXT PRIMARY KEY,calls INTEGER NOT NULL,reported_usd REAL NOT NULL,
          estimated_usd REAL NOT NULL,reserved_usd REAL NOT NULL,unknown_calls INTEGER NOT NULL
        );
        INSERT INTO ai_model_budget_backfill
          SELECT budget_id,count(*),coalesce(sum(reported_usd),0),coalesce(sum(estimated_usd),0),
            coalesce(sum(CASE WHEN reported_usd IS NULL AND estimated_usd IS NULL
              THEN reserved_usd ELSE 0 END),0),
            coalesce(sum(reported_usd IS NULL AND estimated_usd IS NULL),0)
          FROM ai_model_calls WHERE budget_id IS NOT NULL GROUP BY budget_id;
        UPDATE ai_model_budgets SET
          calls=coalesce((SELECT calls FROM ai_model_budget_backfill WHERE id=ai_model_budgets.id),0),
          reported_usd=coalesce((SELECT reported_usd FROM ai_model_budget_backfill WHERE id=ai_model_budgets.id),0),
          estimated_usd=coalesce((SELECT estimated_usd FROM ai_model_budget_backfill WHERE id=ai_model_budgets.id),0),
          reserved_usd=coalesce((SELECT reserved_usd FROM ai_model_budget_backfill WHERE id=ai_model_budgets.id),0),
          unknown_calls=coalesce((SELECT unknown_calls FROM ai_model_budget_backfill WHERE id=ai_model_budgets.id),0),
          totals_version=${BUDGET_TOTALS_VERSION}
          WHERE totals_version<${BUDGET_TOTALS_VERSION};
        DROP TABLE ai_model_budget_backfill;`);
    }
  }).immediate();
  ready = true;
}

function codedError(code, message, details = {}) {
  return Object.assign(new Error(message), { code, retryable: false, ...details });
}

function budgetInput({ id, guildId, limitUsd = 30 }) {
  if (typeof id !== 'string' || !id.trim()) throw codedError('MODEL_BUDGET_INVALID', 'Model budget requires a nonempty id');
  if (typeof guildId !== 'string' || !guildId.trim()) throw codedError('MODEL_BUDGET_INVALID', 'Model budget requires a nonempty guildId');
  if (!Number.isFinite(limitUsd) || limitUsd < 0) throw codedError('MODEL_BUDGET_INVALID', 'Model budget limit must be a nonnegative USD amount');
  return { id: id.trim(), guildId: guildId.trim(), limitUsd };
}

function budgetRow(id) {
  const row = db.prepare('SELECT * FROM ai_model_budgets WHERE id=?').get(id);
  if (!row) throw codedError('MODEL_BUDGET_NOT_FOUND', `Unknown model budget: ${id}`, { budgetId: id });
  return row;
}

function budgetTotals(row) {
  return { calls:Number(row.calls) || 0,reported_usd:Number(row.reported_usd) || 0,
    estimated_usd:Number(row.estimated_usd) || 0,reserved_usd:Number(row.reserved_usd) || 0,
    unknown_calls:Number(row.unknown_calls) || 0 };
}

export function ensureModelBudget(input) {
  ledger();
  const { id, guildId, limitUsd } = budgetInput(input);
  const now = Date.now();
  const conflict = db.transaction(() => {
    db.prepare(`INSERT OR IGNORE INTO ai_model_budgets
      (id,guild_id,limit_usd,paused,pause_reason,created_at,updated_at,totals_version)
      VALUES(?,?,?,0,NULL,?,?,?)`).run(id,guildId,limitUsd,now,now,BUDGET_TOTALS_VERSION);
    const row = budgetRow(id);
    return row.guild_id !== guildId || Math.abs(row.limit_usd-limitUsd) > 1e-9 ? row : null;
  }).immediate();
  if (conflict) throw codedError('MODEL_BUDGET_CONFLICT', 'Model budget id already belongs to a different guild or limit', {
    budgetId:id,guildId:conflict.guild_id,limitUsd:conflict.limit_usd
  });
  return modelBudgetStatus(id);
}

export function modelBudgetStatus(id) {
  ledger();
  if (typeof id !== 'string' || !id.trim()) throw codedError('MODEL_BUDGET_INVALID', 'Model budget requires a nonempty id');
  const row = budgetRow(id.trim());
  const totals = budgetTotals(row);
  const spentUsd = totals.reported_usd + totals.estimated_usd;
  const committedUsd = spentUsd + totals.reserved_usd;
  return { id:row.id,guildId:row.guild_id,limitUsd:row.limit_usd,paused:!!row.paused,
    pauseReason:row.pause_reason ?? null,reportedUsd:totals.reported_usd,estimatedUsd:totals.estimated_usd,
    spentUsd,reservedUsd:totals.reserved_usd,committedUsd,
    remainingUsd:Math.max(0,row.limit_usd-committedUsd),calls:totals.calls,unknownCalls:totals.unknown_calls };
}

export function setModelBudgetPaused(id, paused) {
  ledger();
  if (typeof id !== 'string' || !id.trim()) throw codedError('MODEL_BUDGET_INVALID', 'Model budget requires a nonempty id');
  if (typeof paused !== 'boolean') throw codedError('MODEL_BUDGET_INVALID', 'Model budget paused state must be boolean');
  const changed = db.prepare(`UPDATE ai_model_budgets SET paused=?,pause_reason=?,updated_at=? WHERE id=?`)
    .run(paused ? 1 : 0,paused ? 'manual' : null,Date.now(),id.trim());
  if (!changed.changes) throw codedError('MODEL_BUDGET_NOT_FOUND', `Unknown model budget: ${id}`, { budgetId:id });
  return modelBudgetStatus(id.trim());
}
export function modelRates(model) {
  ledger();
  const row = db.prepare('SELECT checked_at,rates FROM ai_model_rates WHERE model=?').get(model);
  return row ? { ...JSON.parse(row.rates), checkedAt: row.checked_at } : null;
}
export function saveModelRates(model, rates, now = Date.now()) {
  ledger();
  for (const key of ['input','output','cached','cacheWrite','reasoning','request'])
    if (!Number.isFinite(rates[key] ?? 0) || (rates[key] ?? 0) < 0) throw new Error('Invalid model price');
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
export function reserveModelCall({ model, messages, tools, outputTokens, guildId = null, role = 'chat', runId = null,
  budgetId = null }, now = Date.now()) {
  ledger();
  if (budgetId !== null && (typeof budgetId !== 'string' || !budgetId.trim()))
    throw codedError('MODEL_BUDGET_INVALID', 'Model budget requires a nonempty id');
  if (budgetId) budgetId = budgetId.trim();
  const rates = modelRates(model);
  const raw = !budgetId && role === 'writer' ? process.env.MEMORY_WRITER_DAILY_USD : undefined;
  const cap = raw?.trim() ? Number(raw) : null;
  if (cap !== null && (!Number.isFinite(cap) || cap < 0)) throw new Error('MEMORY_WRITER_DAILY_USD must be a nonnegative USD amount');
  if ((cap !== null || budgetId) && (!rates || !Number.isFinite(rates.input) || !Number.isFinite(rates.output)))
    throw new Error('A model budget requires current OpenRouter model pricing');
  if (!Number.isFinite(outputTokens) || outputTokens < 0) throw new Error('Model output token limit must be nonnegative');
  const inputRate = rates ? Math.max(rates.input,rates.cached ?? rates.input,rates.cacheWrite ?? rates.input) : 0;
  const outputRate = rates ? Math.max(rates.output,rates.reasoning ?? rates.output) : 0;
  const rawUpper = rates ? ((Buffer.byteLength(JSON.stringify({ messages, tools })) + 4096) * inputRate
    + outputTokens*outputRate)/1e6 + (rates.request ?? 0) : 0;
  // A floating-point representation must never round a reservation below the
  // verified price bound used to admit it.
  const upper = rates ? Math.ceil(rawUpper*1e12)/1e12 : 0;
  const day = Math.floor(now/86400000)*86400000;
  const result = db.transaction(() => {
    if (budgetId) {
      const budget = budgetRow(budgetId);
      if (budget.guild_id !== guildId) return { error:codedError('MODEL_BUDGET_CONFLICT', 'Model budget guild does not match the request', {
        budgetId,guildId:budget.guild_id
      }) };
      if (budget.paused) return { error:codedError(budget.pause_reason === 'exhausted' ? 'MODEL_BUDGET_EXHAUSTED' : 'MODEL_BUDGET_PAUSED',
        budget.pause_reason === 'exhausted' ? 'Model budget is exhausted' : 'Model budget is paused', { budgetId }) };
      const committed = budgetTotals(budget);
      const charged = committed.reported_usd + committed.estimated_usd + committed.reserved_usd;
      if (charged+upper > budget.limit_usd) {
        db.prepare("UPDATE ai_model_budgets SET paused=1,pause_reason='exhausted',updated_at=? WHERE id=?").run(now,budgetId);
        return { error:codedError('MODEL_BUDGET_EXHAUSTED', 'Model budget is exhausted', {
          budgetId,remainingUsd:Math.max(0,budget.limit_usd-charged)
        }) };
      }
    }
    if (cap !== null) {
      const charged = db.prepare(`SELECT coalesce(sum(coalesce(reported_usd,estimated_usd,reserved_usd)),0) n
        FROM ai_model_calls WHERE role=? AND budget_id IS NULL AND started_at>=? AND started_at<?`)
        .get(role,day,day+86400000).n;
      if (charged+upper > cap) return { error:Object.assign(new Error('Memory Writer daily budget reached'), {
        code:'MEMORY_BUDGET_PAUSED',retryAt:day+86400000
      }) };
    }
    const id = randomUUID();
    db.prepare(`INSERT INTO ai_model_calls
      (id,started_at,guild_id,role,run_id,model,status,reserved_usd,rates,budget_id) VALUES(?,?,?,?,?,?,?,?,?,?)`)
      .run(id,now,guildId,role,runId,model,'pending',upper,JSON.stringify(rates),budgetId);
    if (budgetId) db.prepare(`UPDATE ai_model_budgets SET calls=calls+1,
      reserved_usd=reserved_usd+?,unknown_calls=unknown_calls+1,updated_at=? WHERE id=?`)
      .run(upper,now,budgetId);
    return { id, rates, capped: cap !== null || !!budgetId, budgetId };
  }).immediate();
  if (result.error) throw result.error;
  return result;
}
export function finishModelCall(reservation, data, { noCharge = false, status } = {}) {
  ledger();
  const reported = data?.usage?.cost;
  // A token-derived estimate is not an OpenRouter bill. Keep unknown reservations.
  const cost = noCharge ? 0 : Number.isFinite(reported) && reported >= 0 ? reported : null;
  db.transaction(() => {
    const call = db.prepare('SELECT budget_id,status,reserved_usd FROM ai_model_calls WHERE id=?').get(reservation.id);
    if (!call || call.status !== 'pending') return;
    const updated = db.prepare(`UPDATE ai_model_calls SET status=?,provider=?,generation_id=?,usage=?,reported_usd=?
      WHERE id=? AND status='pending'`)
      .run(status ?? (noCharge ? 'no_charge' : cost === null ? 'unknown' : 'reported'),data?.provider ?? null,
        data?.id ?? null,data?.usage ? JSON.stringify(data.usage) : null,cost,reservation.id);
    if (!updated.changes) return;
    if (call.budget_id) {
      if (cost !== null) db.prepare(`UPDATE ai_model_budgets SET
        reported_usd=reported_usd+?,reserved_usd=max(0,reserved_usd-?),
        unknown_calls=max(0,unknown_calls-1),updated_at=? WHERE id=?`)
        .run(cost,call.reserved_usd,Date.now(),call.budget_id);
      const budget = budgetRow(call.budget_id);
      const totals = budgetTotals(budget);
      const committed = totals.reported_usd+totals.estimated_usd+totals.reserved_usd;
      if (committed > 0 && committed >= budget.limit_usd)
        db.prepare("UPDATE ai_model_budgets SET paused=1,pause_reason='exhausted',updated_at=? WHERE id=?")
          .run(Date.now(),call.budget_id);
    }
  }).immediate();
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
    coalesce(sum(reported_usd IS NULL AND estimated_usd IS NULL),0) unconfirmedCalls
    FROM ai_model_calls WHERE ${where}`).get(...args);
  return { currency:'USD',period:new Date(day).toISOString().slice(0,10),...totals,
    byModel: db.prepare(`SELECT role,model,provider,count(*) calls,sum(reported_usd) reportedUsd FROM ai_model_calls WHERE ${where} GROUP BY role,model,provider`).all(...args) };
}
