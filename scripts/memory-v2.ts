import 'dotenv/config';
import { readFileSync } from 'node:fs';

// 記憶 v2 の構築 CLI。設計は docs/memory-v2.md。v1 の memory.sqlite には触らず、新しい DB (--db) に作る。
// TypeScript なので tsx を通して動かす (src の .ts を読む)。
//
//   node --import tsx scripts/memory-v2.ts init     --guild ID --db memory2.sqlite [--v1 memory.sqlite]   DB を作り、区間を計画する
//   node --import tsx scripts/memory-v2.ts estimate --guild ID --db memory2.sqlite [--v1 …]               量と費用の見込み (AI を呼ばない)
//   node --import tsx scripts/memory-v2.ts canary   --guild ID --db memory2.sqlite [--n 30] [--max-cost 1.5]  少数の区間で通しで試す
//   node --import tsx scripts/memory-v2.ts run      --guild ID --db memory2.sqlite --confirm [--stage S] [--max-cost X]
//        stage: extract (抽出 + 検証) | resolve | compose | arcs | root | project | all
//   node --import tsx scripts/memory-v2.ts update   --guild ID --live [--settle-hours 1] [--max-cost 3]    新着だけを足す (計画 → 抽出 → 検証 → 組み立て → 投影。保存した出力は払い直さない)
//   node --import tsx scripts/memory-v2.ts status   --guild ID --db memory2.sqlite
//   node --import tsx scripts/memory-v2.ts validate --guild ID --db memory2.sqlite [--v1 …]               関門
//   node --import tsx scripts/memory-v2.ts show     --guild ID --db memory2.sqlite --path people/たこ     組み立てたページ
//   node --import tsx scripts/memory-v2.ts sample   --guild ID --db memory2.sqlite [--n 5]               出来事・主張の見本 (目で確かめる)
//   node --import tsx scripts/memory-v2.ts verify-variant --guild ID --db FILE --pack DIR/pack.jsonl --reasoning low|off|medium|high --out FILE   検証の設定違いを同じ主張で比べる (DB は変えない)
//   node --import tsx scripts/memory-v2.ts labelpack --guild ID --db memory2.sqlite --n 200 --out DIR     評価セットの素材 (読む用 pack.jsonl と、v2 の判定 key.jsonl)
//
// --db を指定しないと MEMORY_DB_PATH を使う (本番の memory.sqlite を壊さないよう、必ず新しいファイルを指すこと)。

const [command, ...rest] = process.argv.slice(2);
const args: Record<string, string | true> = {};
for (let i = 0; i < rest.length; i += 1) {
  const arg = rest[i];
  if (arg === undefined || !arg.startsWith('--')) continue;
  const key = arg.slice(2);
  const next = rest[i + 1];
  if (next && !next.startsWith('--')) { args[key] = next; i += 1; } else args[key] = true;
}
const text = (name: string): string | undefined => (typeof args[name] === 'string' ? args[name] as string : undefined);
const number = (name: string, fallback: number): number => {
  const value = text(name);
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(`--${name} は数で指定してください`);
  return n;
};

const guildId = text('guild') ?? process.env.MEMORY_TREE_GUILD;
if (!command || !guildId) {
  console.error('使い方: memory-v2.ts <init|estimate|canary|run|status|validate|show|sample> --guild ID --db FILE');
  process.exit(2);
}
const guild: string = guildId;
const db = text('db');
if (db) process.env.MEMORY_DB_PATH = db;
else if (!process.env.MEMORY_DB_PATH || (/memory\.sqlite$/.test(process.env.MEMORY_DB_PATH) && !args.live)) {
  // 構築は新しいファイルに作る。切り替えたあとの更新 (update) だけは、本番の memory.sqlite を --live で明示して使う
  console.error('--db で v2 用の新しいファイルを指定してください (本番の memory.sqlite は壊さない。切り替え後の update だけ --live)');
  process.exit(2);
}

const { memoryDb } = await import('../src/memory/store.js');
const { ensureV2Schema } = await import('../src/memory/v2/schema.js');
const { initV2 } = await import('../src/memory/v2/init.js');
const run = await import('../src/memory/v2/run.js');
const { openRouterCallerV2, v2Config } = await import('../src/memory/v2/call.js');
const { StopRun } = await import('../src/memory/build.js');
const { resolveEntities } = await import('../src/memory/v2/resolve.js');
const { composeArcs, composeRoot } = await import('../src/memory/v2/arcs.js');
const { projectToV1 } = await import('../src/memory/v2/project.js');
const validate = await import('../src/memory/v2/validate.js');
type LabelRow = import('../src/memory/v2/validate.js').LabelRow;
type KeyRow = import('../src/memory/v2/validate.js').KeyRow;
const { errorMessage } = await import('../src/memory/types.js');

ensureV2Schema();
const log = (message: string): void => console.log(`${new Date().toISOString().slice(11, 19)} ${message}`);
const d = memoryDb();
const v1Path = text('v1') ?? null;

const stageCost = (): Record<string, { n: number; cost: number }> =>
  Object.fromEntries(d.prepare<[string], { stage: string; n: number; c: number }>(
    "SELECT stage, COUNT(*) AS n, SUM(cost) AS c FROM v2_jobs WHERE guild_id = ? AND state = 'done' GROUP BY stage").all(guild).map((row) => [row.stage, { n: row.n, cost: row.c }]));

function estimate(): void {
  const rows = d.prepare<[string], { state: string; n: number; chars: number; messages: number }>(
    'SELECT state, COUNT(*) AS n, SUM(chars) AS chars, SUM(messages) AS messages FROM v2_sections WHERE guild_id = ? GROUP BY state').all(guild);
  const total = rows.reduce((acc, row) => ({ n: acc.n + row.n, chars: acc.chars + row.chars, messages: acc.messages + row.messages }), { n: 0, chars: 0, messages: 0 });
  console.log('区間:', Object.fromEntries(rows.map((row) => [row.state, row.n])), `/ 合計 ${total.n} 区間 ${total.messages.toLocaleString()} 発言 ${(total.chars / 1e6).toFixed(1)}M 字`);
  const pending = rows.filter((row) => ['pending', 'extracted'].includes(row.state)).reduce((acc, row) => acc + row.chars, 0);
  const jobs = stageCost();
  const doneChars = d.prepare<[string], { c: number | null }>("SELECT SUM(chars) AS c FROM v2_sections WHERE guild_id = ? AND state = 'done' AND error IS NOT 'tiny'").get(guild)?.c ?? 0;
  const per = (stage: string, fallback: number): number => {
    const job = jobs[stage];
    return job && doneChars > 0 ? job.cost / doneChars : fallback;
  };
  // 既定の単価 ($ / 字): v1 の実測 (glm 1 区間 27.5k 字で $0.0047) を基準に、出力が約 2 倍・検証が約 1.3 倍とみる
  const e = per('extract', 3.4e-7);
  const v = per('verify', 4.4e-7);
  const measured = Boolean(jobs.extract && jobs.verify);
  const rest = e * pending + v * pending;
  console.log(`未処理 ${(pending / 1e6).toFixed(1)}M 字 → 抽出 $${(e * pending).toFixed(2)} + 検証 $${(v * pending).toFixed(2)} (${measured ? '実測の単価' : '見込みの単価'})`
    + ` / 組み立て・筋書き・根 は主張の数しだいで $3〜8 / 予算の上限 $${v2Config.budgetUsd}`);
  console.log(`この先 約 $${(rest + 5).toFixed(1)} (組み立てを含む概算)。実測済みの費用:`, Object.fromEntries(Object.entries(jobs).map(([k, x]) => [k, `${x.n} 件 $${x.cost.toFixed(3)}`])));
}

function status(): void {
  console.log('区間:', Object.fromEntries(d.prepare<[string], { state: string; c: number }>('SELECT state, COUNT(*) AS c FROM v2_sections WHERE guild_id = ? GROUP BY state').all(guild).map((r) => [r.state, r.c])));
  const m = validate.collect(guild);
  console.log('出来事', m.episodes, '/ 主張', m.claims, '/ 人物・もの', m.entities, '/ ページ', m.pages, '/ 網羅', m.coverage);
  console.log('費用', Object.fromEntries(Object.entries(stageCost()).map(([k, x]) => [k, `${x.n} 件 $${x.cost.toFixed(3)}`])), `合計 $${Object.values(stageCost()).reduce((s, x) => s + x.cost, 0).toFixed(3)}`);
}

async function stageExtract(ctx: ReturnType<typeof run.makeCtx>, only: ReadonlySet<number> | null = null): Promise<void> {
  await run.runSections(ctx, { only });
  log(run.progress(ctx));
}

async function resolveAndCompose(ctx: ReturnType<typeof run.makeCtx>): Promise<void> {
  const resolved = resolveEntities(guild);
  log(`resolve: 人物 ${resolved.people} / もの ${resolved.things} / 主張 ${resolved.claims} / 置けなかった ${resolved.unplaced}`);
  const composed = await run.composeAll(ctx);
  log(`compose: ページ ${composed.pages} (主張を並べただけ ${composed.mechanical}) / 主張 ${composed.claims} のうち文に入った ${composed.cited} / 呼び出し ${ctx.counters.calls} / $${ctx.counters.cost.toFixed(3)}`);
}

function printSample(n: number): void {
  const episodes = d.prepare<[string, number], { id: number; kind: string; title: string; summary: string; outcome: string; verdict: string }>(
    "SELECT id, kind, title, summary, outcome, verdict FROM v2_episodes WHERE guild_id = ? ORDER BY RANDOM() LIMIT ?").all(guild, n);
  for (const e of episodes) console.log(`[e${e.id}] (${e.kind}/${e.verdict}) ${e.title}\n  ${e.summary}${e.outcome ? `\n  → ${e.outcome}` : ''}`);
  const claims = d.prepare<[string, number], { id: number; about_kind: string; about_key: string; type: string; modality: string; verdict: string; text: string; attrs: string }>(
    "SELECT id, about_kind, about_key, type, modality, verdict, text, attrs FROM v2_claims WHERE guild_id = ? ORDER BY RANDOM() LIMIT ?").all(guild, n * 2);
  for (const c of claims) console.log(`[c${c.id}] ${c.about_kind === 'person' ? `<${c.about_key.slice(-4)}>` : c.about_key} ${c.type}/${c.modality}/${c.verdict}: ${c.text}${c.attrs !== '{}' ? ` ${c.attrs}` : ''}`);
}

try {
  switch (command) {
    case 'init': {
      const stats = initV2(guild, { v1Path });
      log(`init: チャンネル ${stats.channels} / 区間 ${stats.sections} (新規 ${stats.added}) / 既知のページ名 ${stats.known} ${stats.seeded ? '(v1 から引き継いだ)' : ''}`);
      estimate();
      break;
    }
    case 'estimate':
      estimate();
      break;
    case 'status':
      status();
      break;
    case 'sample':
      printSample(number('n', 5));
      break;
    case 'show': {
      const row = d.prepare<[string, string], { path: string; summary: string; body: string; source: string }>('SELECT path, summary, body, source FROM v2_pages WHERE guild_id = ? AND path = ?').get(guild, text('path') ?? '');
      if (!row) console.log('(ページが無い)');
      else console.log(`# ${row.path || '(根)'} [${row.source}]\n${row.summary}\n\n${row.body}`);
      break;
    }
    case 'labelpack': {
      // 主張を層化して無作為に取り、根拠の行の前後 8 行つきで書き出す。v2 の判定は key.jsonl に分けて、読む側が引きずられないようにする
      const { writeFileSync, mkdirSync } = await import('node:fs');
      const out = text('out') ?? '.';
      mkdirSync(out, { recursive: true });
      const n = number('n', 200);
      const sections = d.prepare<[string], { id: number; channel_id: string; from_id: string; to_id: string; from_ms: number; to_ms: number; messages: number; chars: number }>(
        "SELECT id, channel_id, from_id, to_id, from_ms, to_ms, messages, chars FROM v2_sections WHERE guild_id = ? AND state = 'done' AND error IS NOT 'tiny'").all(guild);
      const { renderSection } = await import('../src/memory/v2/prepare.js');
      const { NameBook } = await import('../src/memory/transcript.js');
      const book = new NameBook(guild);
      const claims = d.prepare<[string], { id: number; section_id: number; episode_id: number | null; about_kind: string; about_key: string; text: string; type: string; modality: string; verdict: string; attrs: string }>(
        'SELECT id, section_id, episode_id, about_kind, about_key, text, type, modality, verdict, attrs FROM v2_claims WHERE guild_id = ?').all(guild);
      // 決まった種で並べ替えて、層 (verdict × modality) ごとに均等に取る
      let seed = number('seed', 20261029);
      const rand = (): number => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
      const strata = new Map<string, typeof claims>();
      for (const claim of claims) strata.set(`${claim.verdict}/${claim.modality}`, [...(strata.get(`${claim.verdict}/${claim.modality}`) ?? []), claim]);
      const picks: typeof claims = [];
      const keys = [...strata.keys()].sort();
      for (let round = 0; picks.length < n && round < n; round += 1) {
        for (const key of keys) {
          const list = strata.get(key) ?? [];
          if (list.length === 0) continue;
          picks.push(list.splice(Math.floor(rand() * list.length), 1)[0] as (typeof claims)[number]);
          if (picks.length >= n) break;
        }
      }
      const byId = new Map(sections.map((row) => [row.id, row]));
      const evidence = d.prepare<[number], { message_id: string }>('SELECT message_id FROM v2_claim_evidence WHERE claim_id = ?');
      const pack: string[] = [];
      const key: string[] = [];
      for (const claim of picks) {
        const row = byId.get(claim.section_id);
        if (!row) continue;
        const section = renderSection(guild, { channelId: row.channel_id, fromId: row.from_id, toId: row.to_id, fromMs: row.from_ms, toMs: row.to_ms, messages: row.messages, chars: row.chars }, { book });
        const ids = new Set(evidence.all(claim.id).map((e) => e.message_id));
        const lines = [...section.lines].filter(([, info]) => info.ids.some((id) => ids.has(id))).map(([no]) => no);
        if (lines.length === 0) continue;
        const lo = Math.min(...lines) - 8;
        const hi = Math.max(...lines) + 8;
        const window = section.text.split('\n').filter((line) => {
          const m = line.match(/^(\d+)\|/);
          return !m || (Number(m[1]) >= lo && Number(m[1]) <= hi);
        }).filter((line) => !/^(\[凡例\]|### |## )/.test(line) || true).join('\n');
        const about = claim.about_kind === 'person' ? `${section.codes.get(claim.about_key) ?? '?'} (${section.labels.get(section.codes.get(claim.about_key) ?? '') ?? '?'})` : claim.about_key;
        pack.push(JSON.stringify({ id: `c${claim.id}`, about, claim: claim.text, type: claim.type, attrs: JSON.parse(claim.attrs), cited_lines: lines, transcript: window }));
        key.push(JSON.stringify({ id: `c${claim.id}`, verdict: claim.verdict, modality: claim.modality, about_kind: claim.about_kind }));
      }
      writeFileSync(`${out}/pack.jsonl`, `${pack.join('\n')}\n`);
      writeFileSync(`${out}/key.jsonl`, `${key.join('\n')}\n`);
      log(`labelpack: ${pack.length} 件 → ${out}/pack.jsonl, key.jsonl`);
      break;
    }
    case 'verify-variant': {
      // pack.jsonl の主張を含む区間を、別の推論の強さで検証し直した判定を書き出す (DB の判定は変えない)
      const { readFileSync: read, writeFileSync: write } = await import('node:fs');
      const packPath = text('pack');
      if (!packPath) throw new Error('--pack が要る');
      const reasoning = text('reasoning') ?? 'low';
      const wanted = new Set(read(packPath, 'utf8').trim().split('\n').map((line) => (JSON.parse(line) as { id: string }).id));
      const { renderSection } = await import('../src/memory/v2/prepare.js');
      const { subjectsOf, verifySystem, verifyUser, checkVerify, normalizeVerify } = await import('../src/memory/v2/verify.js');
      const { NameBook } = await import('../src/memory/transcript.js');
      const book = new NameBook(guild);
      const sectionIds = d.prepare<[string], { id: number; section_id: number; ord: number }>('SELECT id, section_id, ord FROM v2_claims WHERE guild_id = ?').all(guild)
        .filter((row) => wanted.has(`c${row.id}`));
      const bySection = new Map<number, Map<string, string>>();
      for (const row of sectionIds) bySection.set(row.section_id, new Map([...(bySection.get(row.section_id) ?? []), [`c${row.ord}`, `c${row.id}`]]));
      const models = text('models');
      const spec = {
        ...v2Config.verify, reasoning: reasoning === 'off' ? { enabled: false } : { effort: reasoning, exclude: true },
        ...(models ? { models: models.split(','), providerPrefs: undefined, maxPrice: v2Config.extract.maxPrice } : {})
      };
      const call = openRouterCallerV2({ guildId: guild });
      const out: Record<string, { v: string; mod: string | null; sp: boolean; note: string }> = {};
      let cost = 0;
      let next = 0;
      const todo = [...bySection.keys()];
      await Promise.all(Array.from({ length: v2Config.concurrency }, async () => {
        for (let i = next++; i < todo.length; i = next++) {
          const sectionId = todo[i] as number;
          const row = d.prepare<[number], { channel_id: string; from_id: string; to_id: string; from_ms: number; to_ms: number; messages: number; chars: number }>('SELECT * FROM v2_sections WHERE id = ?').get(sectionId);
          if (!row) continue;
          const section = renderSection(guild, { channelId: row.channel_id, fromId: row.from_id, toId: row.to_id, fromMs: row.from_ms, toMs: row.to_ms, messages: row.messages, chars: row.chars }, { book });
          const subjects = subjectsOf(sectionId, section);
          const ids = new Set(subjects.map((subject) => subject.id));
          const result = await call({ stage: `verify-${models ?? 'default'}-${reasoning}`, spec, system: verifySystem, user: verifyUser(section, subjects), check: (json) => checkVerify(ids, json) });
          cost += result.cost;
          for (const [id, item] of normalizeVerify(result.json, ids)) {
            const global = bySection.get(sectionId)?.get(id);
            if (global) out[global] = { v: item.verdict, mod: item.modality, sp: item.speakerOk, note: item.note };
          }
        }
      }));
      write(text('out') ?? `verify-${reasoning}.json`, JSON.stringify(out));
      log(`verify-variant ${reasoning}: ${Object.keys(out).length} 件 / ${todo.length} 区間 / $${cost.toFixed(3)}`);
      break;
    }
    case 'canary': {
      const n = number('n', 30);
      const candidates = d.prepare<[string], { id: number; chars: number }>("SELECT id, chars FROM v2_sections WHERE guild_id = ? AND state = 'pending' AND chars >= 5000 AND parent_id IS NULL ORDER BY id").all(guild);
      const step = Math.max(1, Math.floor(candidates.length / n));
      const picked = new Set(candidates.filter((_, i) => i % step === 0).slice(0, n).map((row) => row.id));
      log(`canary: ${picked.size} 区間 (全体の ${candidates.length} 区間から等間隔) / 上限 $${number('max-cost', 1.5)}`);
      const call = openRouterCallerV2({ guildId: guild });
      const ctx = run.makeCtx(guild, call, { log, maxCost: number('max-cost', 1.5) });
      await stageExtract(ctx, picked);
      const jobs = stageCost();
      const doneChars = d.prepare<[string], { c: number | null }>("SELECT SUM(chars) AS c FROM v2_sections WHERE guild_id = ? AND state = 'done' AND error IS NOT 'tiny'").get(guild)?.c ?? 0;
      const total = d.prepare<[string], { c: number }>("SELECT SUM(chars) AS c FROM v2_sections WHERE guild_id = ? AND error IS NOT 'tiny'").get(guild)?.c ?? 0;
      const perChar = ((jobs.extract?.cost ?? 0) + (jobs.verify?.cost ?? 0)) / Math.max(1, doneChars);
      log(`canary の実測: 抽出 $${(jobs.extract?.cost ?? 0).toFixed(3)} + 検証 $${(jobs.verify?.cost ?? 0).toFixed(3)} / ${(doneChars / 1e3).toFixed(0)}k 字 → 全体 ${(total / 1e6).toFixed(1)}M 字なら 抽出+検証 約 $${(perChar * total).toFixed(1)}`);
      if (args.compose) {
        await resolveAndCompose(ctx);
        log(`canary の合計 $${ctx.counters.cost.toFixed(3)}`);
      }
      const m = validate.collect(guild);
      console.log(JSON.stringify({ episodes: m.episodes, claims: m.claims, coverage: m.coverage, sections: m.sections }, null, 1));
      printSample(3);
      break;
    }
    case 'run': {
      if (!args.confirm) throw new Error('全体の実行は --confirm が要ります (費用がかかる)。先に canary で見込みを確かめてください');
      const stage = text('stage') ?? 'all';
      const call = openRouterCallerV2({ guildId: guild });
      const ctx = run.makeCtx(guild, call, { log, maxCost: number('max-cost', v2Config.budgetUsd) });
      if (['extract', 'all'].includes(stage)) await stageExtract(ctx);
      if (['resolve', 'compose', 'all'].includes(stage)) await resolveAndCompose(ctx);
      if (['arcs', 'all'].includes(stage)) { const arcs = await composeArcs(ctx); log(`arcs: ${arcs.arcs} 筋 → ${arcs.pages} ページ`); }
      if (['root', 'all'].includes(stage)) { await composeRoot(ctx); log('root: 書いた'); }
      if (['project', 'all'].includes(stage)) { const projected = projectToV1(guild); log(`project: ${JSON.stringify(projected)}`); }
      log(`合計 $${ctx.counters.cost.toFixed(3)} / 呼び出し ${ctx.counters.calls} (保存済みの再利用 ${ctx.counters.cached})`);
      break;
    }
    case 'update': {
      // 構築が済んだ DB に新着を足す。新着の区間だけが AI を呼び、変わった主張の部分だけ組み立て直す (同じ入力は保存した出力を使う)
      const stats = initV2(guild, { settleMs: number('settle-hours', 1) * 3_600_000 });
      log(`update: 新しい区間 ${stats.added}`);
      const call = openRouterCallerV2({ guildId: guild });
      const ctx = run.makeCtx(guild, call, { log, maxCost: number('max-cost', 3) });
      await stageExtract(ctx);
      await resolveAndCompose(ctx);
      const arcs = await composeArcs(ctx);
      await composeRoot(ctx);
      log(`arcs: ${arcs.arcs} 筋 → ${arcs.pages} ページ / project: ${JSON.stringify(projectToV1(guild))} / 合計 $${ctx.counters.cost.toFixed(3)}`);
      break;
    }
    case 'project': {
      log(`project: ${JSON.stringify(projectToV1(guild))}`);
      break;
    }
    case 'validate': {
      const m = validate.collect(guild);
      const messages = (d.prepare<[string], { c: number }>("SELECT SUM(messages) AS c FROM v2_sections WHERE guild_id = ?").get(guild)?.c) ?? 0;
      const baseline = v1Path ? validate.v1Baseline(guild, v1Path, messages) : null;
      const gates = validate.gates(m, baseline);
      const labels = text('labels');
      if (labels) {
        const key = text('key');
        if (!key) throw new Error('--labels には --key (labelpack の key.jsonl) も要る');
        const readJsonl = <T>(path: string): T[] => readFileSync(path, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as T);
        const score = validate.scoreLabels(readJsonl<LabelRow>(labels), readJsonl<KeyRow>(key));
        console.log('評価セット:', JSON.stringify(score));
        gates.push(...validate.labelGates(score));
      }
      for (const gate of gates) console.log(`${gate.pass ? 'OK  ' : 'NG  '} ${gate.name}: ${gate.value} (${gate.need})`);
      if (baseline) console.log('v1 の基準:', baseline);
      process.exitCode = gates.every((gate) => gate.pass) ? 0 : 1;
      break;
    }
    default:
      throw new Error(`知らないコマンド: ${command}`);
  }
} catch (error) {
  if (error instanceof StopRun) {
    log(`止まりました (${error.reason}): ${error.message}。保存した結果は残っています。同じコマンドで続きから動きます`);
    process.exitCode = 3;
  } else {
    console.error(errorMessage(error));
    process.exitCode = 1;
  }
}
