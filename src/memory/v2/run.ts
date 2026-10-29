import { StopRun } from '../build.js';
import { getState, memoryDb } from '../store.js';
import { NameBook } from '../transcript.js';
import { errorMessage } from '../types.js';
import {
  BATCH_CHARS, BATCH_PAGES, SMALL_GROUPS, assemble, cleanBody, composeSystem, composeUser, loadGroups, normalizeCompose, partKey, partPath, planBundles,
  type Bundle, type EntityInfo, type PartInput, type PartOutput
} from './compose.js';
import { isTruncated, v2Config, type V2Caller } from './call.js';
import {
  MIN_COVER_MESSAGES, applyExtract, checkExtract, extractSystem, extractUser, normalizeExtract, uncoveredConvs
} from './extract.js';
import { knownKey } from './init.js';
import { renderSection, splitRange } from './prepare.js';
import { applyVerify, checkVerify, normalizeVerify, subjectsOf, verifyPolicy, verifySystem, verifyUser, VERIFY_BATCH, type VerifyPolicy, type VerifySubject } from './verify.js';
import type { RenderedSection, SectionRange, VerifyItem } from './types.js';

// 実行。区間ごとに S1 抽出 → S2 検証 を回し (区間どうしに依存が無いので並列)、
// そのあと S3 解決 → S4 組み立て → 投影。どの工程も、保存した結果と入力のハッシュで続きから動く。

export type Log = (message: string) => void;

export interface Counters {
  calls: number;
  cached: number;
  cost: number;
  sections: number;
  failed: number;
  split: number;
  tiny: number;
  episodes: number;
  claims: number;
  uncovered: number;
}

export const newCounters = (): Counters => ({ calls: 0, cached: 0, cost: 0, sections: 0, failed: 0, split: 0, tiny: 0, episodes: 0, claims: 0, uncovered: 0 });

export interface Ctx {
  guildId: string;
  call: V2Caller;
  log: Log;
  known: string[];
  book: NameBook;
  policy: VerifyPolicy;
  counters: Counters;
  /** 費用がこれを超えたら新しい仕事を始めない (カナリア用) */
  maxCost: number;
}

export function makeCtx(guildId: string, call: V2Caller, { log = () => {}, maxCost = Infinity }: { log?: Log; maxCost?: number } = {}): Ctx {
  const saved = getState(knownKey(guildId));
  return {
    guildId, call, log, known: Array.isArray(saved) ? saved.filter((item): item is string => typeof item === 'string') : [],
    book: new NameBook(guildId), policy: verifyPolicy(), counters: newCounters(), maxCost
  };
}

export interface SectionRow {
  id: number; guild_id: string; parent_id: number | null; depth: number; channel_id: string; from_id: string; to_id: string;
  from_ms: number; to_ms: number; messages: number; chars: number; state: string; attempts: number;
}

export const rangeOf = (row: SectionRow): SectionRange => ({
  channelId: row.channel_id, fromId: row.from_id, toId: row.to_id, fromMs: row.from_ms, toMs: row.to_ms, messages: row.messages, chars: row.chars
});

const MAX_ATTEMPTS = 3;
const MAX_DEPTH = 3;

function mark(id: number, state: string, { error = null, extractModel = null, verifyModel = null, attempts }: { error?: string | null; extractModel?: string | null; verifyModel?: string | null; attempts?: number } = {}): void {
  memoryDb().prepare(`
    UPDATE v2_sections SET state = ?, error = ?, extract_model = COALESCE(?, extract_model), verify_model = COALESCE(?, verify_model),
      attempts = COALESCE(?, attempts), updated_at = ? WHERE id = ?
  `).run(state, error, extractModel, verifyModel, attempts ?? null, Date.now(), id);
}

function job(ctx: Ctx, key: string, stage: string, state: 'done' | 'failed', info: { cost?: number; model?: string | null; provider?: string | null; error?: string | null }): void {
  memoryDb().prepare(`
    INSERT INTO v2_jobs (guild_id, key, stage, state, attempts, cost, model, provider, error, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?)
    ON CONFLICT(guild_id, key) DO UPDATE SET state = excluded.state, attempts = attempts + 1, cost = cost + excluded.cost,
      model = excluded.model, provider = excluded.provider, error = excluded.error, updated_at = excluded.updated_at
  `).run(ctx.guildId, key, stage, state, info.cost ?? 0, info.model ?? null, info.provider ?? null, info.error ?? null, Date.now());
}

function count(ctx: Ctx, result: { cost: number; cached: boolean }): void {
  ctx.counters.calls += result.cached ? 0 : 1;
  ctx.counters.cached += result.cached ? 1 : 0;
  ctx.counters.cost += result.cost;
}

/** 発言がほとんど無い区間は呼ばない (挨拶だけ)。 */
const isTiny = (section: RenderedSection): boolean => section.lines.size < 3 && section.range.chars < 200;

// ---- S1 抽出 ---------------------------------------------------------------

function splitSection(ctx: Ctx, row: SectionRow): boolean {
  if (row.depth >= MAX_DEPTH) return false;
  const halves = splitRange(rangeOf(row));
  if (!halves) return false;
  const d = memoryDb();
  d.transaction(() => {
    const insert = d.prepare(`
      INSERT OR IGNORE INTO v2_sections (guild_id, parent_id, depth, channel_id, from_id, to_id, from_ms, to_ms, messages, chars, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const half of halves) insert.run(ctx.guildId, row.id, row.depth + 1, half.channelId, half.fromId, half.toId, half.fromMs, half.toMs, half.messages, half.chars, Date.now());
    mark(row.id, 'split');
  })();
  ctx.counters.split += 1;
  ctx.log(`split section ${row.id} (${row.messages} 発言): 出力が長さで切れたので 2 つに割る`);
  return true;
}

async function extractSection(ctx: Ctx, row: SectionRow, section: RenderedSection): Promise<void> {
  const system = extractSystem(ctx.known);
  let first;
  try {
    first = await ctx.call({ stage: 'extract', spec: v2Config.extract, system, user: extractUser(section), check: (json) => checkExtract(section, json) });
  } catch (error) {
    if (error instanceof StopRun) throw error;
    if (isTruncated(error) && splitSection(ctx, row)) return;
    const attempts = row.attempts + 1;
    mark(row.id, attempts >= MAX_ATTEMPTS ? 'failed' : 'pending', { error: errorMessage(error).slice(0, 200), attempts });
    job(ctx, `extract:${row.id}`, 'extract', 'failed', { error: errorMessage(error).slice(0, 200) });
    if (attempts >= MAX_ATTEMPTS) ctx.counters.failed += 1;
    ctx.log(`extract failed ${row.id} (${attempts}/${MAX_ATTEMPTS}): ${errorMessage(error).slice(0, 120)}`);
    return;
  }
  count(ctx, first);
  const results = [normalizeExtract(section, first.json)];
  let cost = first.cost;
  const missing = uncoveredConvs(section, results);
  if (missing.length) {
    try {
      const sub = renderSection(ctx.guildId, rangeOf(row), { book: ctx.book, onlyConvs: new Set(missing) });
      const second = await ctx.call({ stage: 'extract', spec: v2Config.extract, system, user: extractUser(sub, { more: missing }), check: (json) => { normalizeExtract(section, json); } });
      count(ctx, second);
      cost += second.cost;
      results.push(normalizeExtract(section, second.json));
    } catch (error) {
      if (error instanceof StopRun) throw error;
      ctx.log(`extract re-ask failed ${row.id}: ${errorMessage(error).slice(0, 100)}`);
    }
    ctx.counters.uncovered += uncoveredConvs(section, results).length;
  }
  const required = section.units.filter((unit) => unit.messages >= MIN_COVER_MESSAGES).length;
  job(ctx, `cover:${row.id}`, 'cover', 'done', { error: JSON.stringify({ required, uncovered: uncoveredConvs(section, results).length }) });
  const applied = applyExtract(ctx.guildId, row.id, section, results);
  ctx.counters.episodes += applied.episodes;
  ctx.counters.claims += applied.claims;
  mark(row.id, 'extracted', { extractModel: first.model, attempts: 0 });
  job(ctx, `extract:${row.id}`, 'extract', 'done', { cost, model: first.model, provider: first.provider });
}

// ---- S2 検証 ---------------------------------------------------------------

async function verifySection(ctx: Ctx, row: SectionRow, section: RenderedSection): Promise<void> {
  const subjects = subjectsOf(row.id, section);
  if (subjects.length === 0) { mark(row.id, 'done'); ctx.counters.sections += 1; return; }
  const judgments = new Map<string, VerifyItem>();
  let cost = 0;
  let model = '';
  let broken = false;
  // 1 回分の判定。出力が長さで切れたら、項目を半分ずつに割って聞き直す (20 項目まで)
  const judge = async (batch: VerifySubject[]): Promise<void> => {
    const ids = new Set(batch.map((subject) => subject.id));
    try {
      const result = await ctx.call({ stage: 'verify', spec: v2Config.verify, system: verifySystem, user: verifyUser(section, batch), check: (json) => checkVerify(ids, json) });
      count(ctx, result);
      cost += result.cost;
      model = result.model;
      for (const [id, item] of normalizeVerify(result.json, ids)) judgments.set(id, item);
    } catch (error) {
      if (error instanceof StopRun) throw error;
      if (isTruncated(error) && batch.length > 20) {
        const half = Math.ceil(batch.length / 2);
        await judge(batch.slice(0, half));
        await judge(batch.slice(half));
        return;
      }
      throw error;
    }
  };
  for (let i = 0; i < subjects.length; i += VERIFY_BATCH) {
    try {
      await judge(subjects.slice(i, i + VERIFY_BATCH));
    } catch (error) {
      if (error instanceof StopRun) throw error;
      const attempts = row.attempts + 1;
      ctx.log(`verify failed ${row.id} (${attempts}/${MAX_ATTEMPTS}): ${errorMessage(error).slice(0, 120)}`);
      if (attempts < MAX_ATTEMPTS) { mark(row.id, 'extracted', { error: errorMessage(error).slice(0, 200), attempts }); return; }
      broken = true;   // 3 回目: 判定の無い項目は「未検証」として通す (数えて関門で見る)
      break;
    }
  }
  applyVerify(row.id, judgments, ctx.policy);
  mark(row.id, 'done', { verifyModel: model || null, error: broken ? 'verify incomplete' : null, attempts: 0 });
  job(ctx, `verify:${row.id}`, 'verify', 'done', { cost, model });
  ctx.counters.sections += 1;
}

export async function processSection(ctx: Ctx, row: SectionRow): Promise<void> {
  const section = renderSection(ctx.guildId, rangeOf(row), { book: ctx.book });
  let state = row.state;
  if (state === 'pending') {
    if (isTiny(section)) { mark(row.id, 'done', { error: 'tiny' }); ctx.counters.tiny += 1; return; }
    await extractSection(ctx, row, section);
    state = (memoryDb().prepare<[number], { state: string }>('SELECT state FROM v2_sections WHERE id = ?').get(row.id)?.state) ?? state;
  }
  if (state === 'extracted' && !v2Config.verifyEnabled) {
    // 検証なし: 抽出の結果をそのまま使う (verdict は ok のまま。MEMORY_V2_VERIFY を戻せば、あとから検証だけ回せる)
    mark(row.id, 'done', { attempts: 0 });
    ctx.counters.sections += 1;
    return;
  }
  if (state === 'extracted') {
    const fresh = memoryDb().prepare<[number], SectionRow>('SELECT * FROM v2_sections WHERE id = ?').get(row.id) ?? row;
    await verifySection(ctx, fresh, section);
  }
}

/** 同時に width 本まで回す。割った区間 (子) も続けて拾う。StopRun は走っている仕事を終えてから投げる。 */
export async function runSections(ctx: Ctx, { only = null, limit = Infinity }: { only?: ReadonlySet<number> | null; limit?: number } = {}): Promise<number> {
  const d = memoryDb();
  const taken = new Set<number>();
  let stop: unknown = null;
  let started = 0;
  const next = (): SectionRow | null => {
    if (stop || started >= limit || ctx.counters.cost >= ctx.maxCost) return null;
    // only を渡したとき (カナリア) は、その区間と、それが割れた子だけを探す
    const ids = only ? [...only].join(',') : '';
    const rows = d.prepare<[string], SectionRow>(`
      SELECT * FROM v2_sections WHERE guild_id = ? AND state IN ('pending', 'extracted')
      ${only ? `AND (id IN (${ids || 'NULL'}) OR parent_id IN (${ids || 'NULL'}))` : ''} ORDER BY id LIMIT 400
    `).all(ctx.guildId);
    const row = rows.find((candidate) => !taken.has(candidate.id));
    if (!row) return null;
    taken.add(row.id);
    started += 1;
    return row;
  };
  const worker = async (): Promise<void> => {
    for (let row = next(); row; row = next()) {
      try {
        await processSection(ctx, row);
        if (started % 25 === 0) ctx.log(progress(ctx));
      } catch (error) {
        if (error instanceof StopRun) { stop ??= error; return; }
        // 想定外の失敗は区間の失敗として数え、他の区間は続ける
        const attempts = row.attempts + 1;
        mark(row.id, attempts >= MAX_ATTEMPTS ? 'failed' : row.state, { error: errorMessage(error).slice(0, 200), attempts });
        ctx.log(`section ${row.id} crashed: ${errorMessage(error).slice(0, 160)}`);
      }
    }
  };
  await Promise.all(Array.from({ length: v2Config.concurrency }, worker));
  if (stop) throw stop;
  return started;
}

export function progress(ctx: Ctx): string {
  const c = ctx.counters;
  const states = memoryDb().prepare<[string], { state: string; c: number }>('SELECT state, COUNT(*) AS c FROM v2_sections WHERE guild_id = ? GROUP BY state').all(ctx.guildId);
  return `sections ${states.map((s) => `${s.state}=${s.c}`).join(' ')} | calls ${c.calls} (cache ${c.cached}) | $${c.cost.toFixed(3)} | 出来事 ${c.episodes} 主張 ${c.claims}`;
}

// ---- S4 組み立て -----------------------------------------------------------

export interface ComposeStats { pages: number; mechanical: number; calls: number; claims: number; cited: number }

interface EntityRow { id: number; kind: 'person' | 'thing'; name: string; path: string; aliases: string; meta: string }

export function entityInfos(guildId: string): EntityInfo[] {
  return memoryDb().prepare<[string], EntityRow>('SELECT id, kind, name, path, aliases, meta FROM v2_entities WHERE guild_id = ? ORDER BY id').all(guildId)
    .map((row) => ({ id: row.id, kind: row.kind, name: row.name, path: row.path, aliases: JSON.parse(row.aliases) as string[], meta: JSON.parse(row.meta) as EntityInfo['meta'] }));
}

function batches(inputs: readonly PartInput[]): PartInput[][] {
  const out: PartInput[][] = [];
  let current: PartInput[] = [];
  let chars = 0;
  for (const input of inputs) {
    const size = input.part.groups.reduce((sum, g) => sum + g.text.length + 40, 0);
    if (current.length && (current.length >= BATCH_PAGES || chars + size > BATCH_CHARS)) { out.push(current); current = []; chars = 0; }
    current.push(input);
    chars += size;
  }
  if (current.length) out.push(current);
  return out;
}

/** 出力のパスから部分を引く。モデルがパスを少し変えても、数が合えば順番で当てる。 */
function outputFor(task: readonly PartInput[], index: number, outputs: ReadonlyMap<string, PartOutput>): PartOutput | null {
  const input = task[index] as PartInput;
  const wanted = partPath(input.bundle, input.part);
  const direct = outputs.get(wanted) ?? outputs.get(wanted.replace(/\s+/g, ''));
  if (direct) return direct;
  const loose = [...outputs].find(([path]) => path.replace(/\s+/g, '') === wanted.replace(/\s+/g, ''));
  if (loose) return loose[1];
  return outputs.size === task.length ? ([...outputs.values()][index] ?? null) : null;
}

export async function composeAll(ctx: Ctx, { entities = entityInfos(ctx.guildId) }: { entities?: EntityInfo[] } = {}): Promise<ComposeStats> {
  const bundles: Bundle[] = [];
  for (const entity of entities) bundles.push(...planBundles(entity, loadGroups(entity.id)));
  const inputs: PartInput[] = bundles.flatMap((bundle) => bundle.parts.map((part, index) => ({ bundle, index, part })));
  const small = inputs.filter((input) => input.bundle.parts.length === 1 && input.part.groups.length <= SMALL_GROUPS);
  const big = inputs.filter((input) => !small.includes(input)).sort((a, b) => b.part.groups.length - a.part.groups.length);
  const tasks: PartInput[][] = [...big.map((input) => [input]), ...batches(small)];
  const outputs = new Map<string, PartOutput | null>();
  const stats: ComposeStats = { pages: 0, mechanical: 0, calls: 0, claims: 0, cited: 0 };
  let stop: unknown = null;
  let cursor = 0;

  const run = async (task: PartInput[], note = ''): Promise<void> => {
    const result = await ctx.call({
      stage: 'compose', spec: v2Config.compose, system: composeSystem, user: composeUser(task, note),
      check: (json) => { if (normalizeCompose(json).size === 0) throw Object.assign(new Error('compose output had no usable page'), { code: 'BAD_OUTPUT' }); }
    });
    count(ctx, result);
    const map = normalizeCompose(result.json);
    task.forEach((input, i) => outputs.set(partKey(input.bundle, input.index), outputFor(task, i, map)));
  };

  const worker = async (): Promise<void> => {
    for (let task = tasks[cursor++]; task && !stop; task = tasks[cursor++]) {
      try {
        await run(task);
        // 文に入らなかった主張が多いページは、抜けを名指しして 1 回だけ書き直させる (単独の部分のみ)
        const only = task.length === 1 ? task[0] : undefined;
        const out = only ? outputs.get(partKey(only.bundle, only.index)) : null;
        if (only && out) {
          const clean = cleanBody(out.body, new Set(only.part.groups.map((g) => g.id)));
          const missing = only.part.groups.filter((g) => !clean.cited.has(g.id));
          if (missing.length >= 2 && missing.length > only.part.groups.length * 0.1) {
            await run(task, `前回の出力では次の主張が文に入っていませんでした。すべて入れて書き直してください: ${missing.map((g) => `[c${g.id}]`).join(' ')}`);
          }
        }
      } catch (error) {
        if (error instanceof StopRun) { stop ??= error; return; }
        ctx.log(`compose failed ${task.map((t) => t.bundle.path).join(', ').slice(0, 120)}: ${errorMessage(error).slice(0, 120)}`);
        for (const input of task) outputs.set(partKey(input.bundle, input.index), null);
      }
      if (cursor % 50 === 0) ctx.log(`compose ${cursor}/${tasks.length} | calls ${ctx.counters.calls} | $${ctx.counters.cost.toFixed(3)}`);
    }
  };
  await Promise.all(Array.from({ length: v2Config.concurrency }, worker));
  if (stop) throw stop;

  const d = memoryDb();
  const insert = d.prepare(`
    INSERT OR REPLACE INTO v2_pages (guild_id, path, entity_id, summary, body, aliases, weight, claims, cited, source, first_at, last_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  d.transaction(() => {
    d.prepare("DELETE FROM v2_pages WHERE guild_id = ? AND source IN ('compose', 'mechanical')").run(ctx.guildId);
    for (const bundle of bundles) {
      const page = assemble(bundle, new Map(bundle.parts.map((_, index) => [partKey(bundle, index), outputs.get(partKey(bundle, index)) ?? null])));
      insert.run(ctx.guildId, page.path, bundle.entityId, page.summary, page.body, JSON.stringify(page.aliases), bundle.weight, page.claims, page.cited,
        page.source, bundle.firstAt, bundle.lastAt, Date.now());
      stats.pages += 1;
      stats.claims += page.claims;
      stats.cited += page.cited;
      if (page.source === 'mechanical') stats.mechanical += 1;
    }
  })();
  stats.calls = ctx.counters.calls;
  return stats;
}
