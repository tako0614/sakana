import 'dotenv/config';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { db as archive } from '../src/archive/db.js';
import { modelBudgetStatus, settleUnknownCalls } from '../src/ai/cost.js';
import { fetchKeyUsage } from '../src/ai/provider.js';
import { StopRun, budgetIdFor, openRouterCaller, runBuild, segmentPrompt, treeConfig } from '../src/memory/build.js';
import {
  getCursor, getNode, getState, loadPublicChannels, memoryCounts, memoryDb, reopenEmptySegments, resetTree, segmentStats
} from '../src/memory/store.js';
import { recallFor } from '../src/memory/recall.js';
import { memoryRootPrompt, runMemoryTool } from '../src/memory/tool.js';
import { planPack } from '../src/memory/transcript.js';
import { arrayOf, errorMessage, isLockState, isRecord, type JsonRecord } from '../src/memory/types.js';

// 記憶の本の builder。bot とは別プロセスで動かす (systemd timer: deploy/sakana-memory.*)。
// TypeScript なので tsx を通して動かす (src の .ts を読む)。
//
//   node --import tsx scripts/memory-tree.ts status  --guild ID          進み具合 (AI を呼ばない)
//   node --import tsx scripts/memory-tree.ts run     --guild ID [--max-calls N] [--max-minutes M] [--retry-failed]
//   node --import tsx scripts/memory-tree.ts try     --guild ID [--model M]   次の区切りを1回だけ投げて表示 (保存しない)
//   node --import tsx scripts/memory-tree.ts show    --guild ID [--path P] [--with Q]  ページを表示 (agent の memory ツールと同じ形)
//   node --import tsx scripts/memory-tree.ts episode --guild ID --id e12      出来事と根拠の発言
//   node --import tsx scripts/memory-tree.ts search  --guild ID --query Q
//   node --import tsx scripts/memory-tree.ts recall  --guild ID --text T      この文で何を思い出すか (agent の入力に足すもの)
//   node --import tsx scripts/memory-tree.ts root    --guild ID               system に入る根の文面
//   node --import tsx scripts/memory-tree.ts estimate --guild ID              未読の量 (アーカイブを走査するので重い)
//   node --import tsx scripts/memory-tree.ts export  --guild ID --out DIR     Markdown に書き出す
//   node --import tsx scripts/memory-tree.ts reset   --guild ID --yes         記憶を消す (原文には触らない)
//   node --import tsx scripts/memory-tree.ts reopen-empty --guild ID [--yes]  出来事が1つも無い長い区切りを読み直しに回す
//   node --import tsx scripts/memory-tree.ts settle  --guild ID               返らなかった呼び出しの予約を OpenRouter の実額で精算 (run も最初にやる)

const [command, ...rest] = process.argv.slice(2);
const args: Record<string, string | true> = {};
for (let i = 0; i < rest.length; i += 1) {
  const arg = rest[i];
  if (arg === undefined || !arg.startsWith('--')) continue;
  const key = arg.slice(2);
  const next = rest[i + 1];
  if (next && !next.startsWith('--')) { args[key] = next; i += 1; } else args[key] = true;
}
const guildId = String(args.guild ?? process.env.MEMORY_TREE_GUILD ?? '');
if (!command || !guildId) {
  console.error('usage: node --import tsx scripts/memory-tree.ts <status|run|try|show|episode|search|recall|root|estimate|export|reset|reopen-empty|settle> --guild ID');
  process.exit(2);
}

const day = (ms: number | null | undefined): string => (ms ? new Date(ms).toISOString().replace('T', ' ').slice(0, 16) : '-');
const rec = (value: unknown): JsonRecord => (isRecord(value) ? value : {});

function status(): void {
  const snapshot = loadPublicChannels(guildId);
  const channels = snapshot?.channelIds ?? [];
  const newest = archive.prepare<[string], { at: number | null }>('SELECT MAX(created_at) AS at FROM messages WHERE channel_id = ?');
  let caughtUp = 0;
  let behind = 0;
  let oldest: number | null = null;
  for (const channelId of channels) {
    const latest = newest.get(channelId)?.at;
    if (!latest) continue;
    const cursor = getCursor(guildId, channelId);
    if (cursor && cursor.last_ms >= latest) { caughtUp += 1; continue; }
    behind += 1;
    const at = cursor?.last_ms ?? 0;
    if (oldest === null || at < oldest) oldest = at;
  }
  const segments = Object.fromEntries(segmentStats(guildId).map((row) => [row.status, row]));
  const root = getNode(guildId, '');
  const lock = getState(`lock:${guildId}`);
  const rootSegments = rec(getState(`root:${guildId}`)).segments;
  let budget: ReturnType<typeof modelBudgetStatus> | null | undefined;
  if (treeConfig.budgetUsd > 0) {
    try { budget = modelBudgetStatus(budgetIdFor(guildId)); } catch { budget = null; }
  }
  const report = {
    models: treeConfig.models,
    publicChannels: { count: channels.length, snapshotAt: day(snapshot?.at) },
    channels: { caughtUp, behind, oldestCursor: oldest === null ? null : (oldest ? day(oldest) : '未読') },
    segments: {
      done: segments.done?.segments ?? 0, messages: segments.done?.messages ?? 0, chars: segments.done?.chars ?? 0,
      failed: segments.failed?.segments ?? 0, latest: day(segments.done?.latest)
    },
    memory: memoryCounts(guildId),
    root: { chars: root?.body?.length ?? 0, updatedAt: day(root?.updated_at), segmentsSince: typeof rootSegments === 'number' ? rootSegments : 0 },
    lock: isLockState(lock) ? { ...lock, at: day(lock.at) } : null,
    ...(budget === undefined ? {} : { budget })
  };
  console.log(JSON.stringify(report, null, 2));
}

function estimate(): void {
  const channels = loadPublicChannels(guildId)?.channelIds ?? [];
  const count = archive.prepare<[string, number], { messages: number; chars: number }>(`
    SELECT COUNT(*) AS messages, COALESCE(SUM(char_count), 0) AS chars FROM messages
    WHERE channel_id = ? AND deleted = 0 AND is_bot = 0 AND created_at > ?
  `);
  let messages = 0;
  let chars = 0;
  for (const channelId of channels) {
    const row = count.get(channelId, getCursor(guildId, channelId)?.last_ms ?? 0);
    messages += row?.messages ?? 0;
    chars += row?.chars ?? 0;
  }
  // 1行 = 時刻・名前・区切りの分だけ本文より長くなる (実測で1発言あたり +8字前後)
  const transcript = chars + messages * 8;
  console.log(JSON.stringify({
    unreadMessages: messages, unreadChars: chars, transcriptChars: transcript,
    segmentCalls: Math.ceil(transcript / treeConfig.segmentChars),
    note: '整理 (compact) と根の呼び出しが別に要る。無料枠は1日50回 (購入累計10ドル以上で1000回)'
  }, null, 2));
}

/**
 * 結果の返らなかった呼び出しの予約を OpenRouter の実額で精算する (止めて入れ直すと予約が残り、
 * 実費の10倍で上限を埋める)。OpenRouter に聞けなければ精算せずに進む (予約は安全側)。
 */
async function settle(log: (line: string) => void): Promise<void> {
  try {
    const usage = await fetchKeyUsage();
    if (usage.monthly === null) return;
    const result = settleUnknownCalls({ monthUsageUsd: usage.monthly });
    if (result.settled) {
      log(`settled ${result.settled} unfinished calls: held $${result.heldUsd.toFixed(3)} → OpenRouter's gap $${result.gapUsd.toFixed(3)} (released $${result.releasedUsd.toFixed(3)})`);
    }
  } catch (error) {
    log(`settle skipped: ${errorMessage(error)}`);
  }
}

async function run(): Promise<void> {
  await settle((line) => console.log(`[${new Date().toISOString()}] ${line}`));
  const call = openRouterCaller({ guildId });
  const stats = await runBuild({
    guildId, call,
    maxCalls: args['max-calls'] ? Number(args['max-calls']) : Infinity,
    maxMs: args['max-minutes'] ? Number(args['max-minutes']) * 60_000 : Infinity,
    retryFailed: Boolean(args['retry-failed']),
    log: (line) => console.log(`[${new Date().toISOString()}] ${line}`)
  });
  console.log(JSON.stringify(stats));
  if (['auth', 'config', 'no-channels'].includes(stats.stopped)) process.exitCode = 1;
}

async function tryOnce(): Promise<void> {
  const pack = planPack({ guildId, channelIds: loadPublicChannels(guildId)?.channelIds ?? [],
    targetChars: treeConfig.segmentChars, now: Date.now() });
  if (!pack) { console.log('読む区切りがありません'); return; }
  const models = args.model ? [String(args.model)] : treeConfig.models;
  const call = openRouterCaller({ guildId, models });
  const { SEGMENT_SYSTEM } = await import('../src/memory/build.js');
  const started = Date.now();
  try {
    const result = await call({ kind: 'segment', system: SEGMENT_SYSTEM, user: segmentPrompt(guildId, pack) });
    const output = rec(result.json);
    const episodes = arrayOf(output.episodes).map(rec);
    const facts = arrayOf(output.facts).map(rec);
    const created = arrayOf(output.new).map(rec);
    const usage = rec(result.usage);
    const text = (value: unknown): string => String(value);
    console.log(`model ${result.model} / ${((Date.now() - started) / 1000).toFixed(0)}s / in ${text(usage.prompt_tokens)} out ${text(usage.completion_tokens)} tokens`);
    console.log(`区切り: ${pack.segments.map((s) => `${s.label} ${day(s.fromMs)}〜${day(s.toMs)} (${s.messages}件)`).join(', ')} / ${pack.chars}字`);
    console.log(`\n出来事 ${episodes.length}:`);
    episodes.forEach((episode, i) => {
      const cited = arrayOf(episode.lines).map((n) => pack.lineMap.get(Number(n)) ? n : `${text(n)}?`).join(',');
      console.log(`  [${i}] ${text(episode.title)} (重要度 ${text(episode.importance)}, 行 ${cited}) ${arrayOf(episode.nodes).join(' ')}`);
      console.log(`      ${text(episode.summary)}`);
    });
    console.log(`\n知識 ${facts.length}:`);
    for (const fact of facts) console.log(`  ${text(fact.path)} ← ${text(fact.text)} (出来事 ${text(fact.episode)})`);
    if (created.length) console.log(`\n新しいページ: ${created.map((entry) => { const aliases = arrayOf(entry.aliases); return `${text(entry.path)}${aliases.length ? ` (${aliases.join(',')})` : ''}`; }).join(', ')}`);
  } catch (error) {
    console.error(error instanceof StopRun ? `stopped: ${error.message}` : error);
    process.exitCode = 1;
  }
}

function exportTree(): void {
  const out = String(args.out ?? '');
  if (!out) throw new Error('--out DIR が要ります');
  const rows = memoryDb().prepare<[string], { path: string }>('SELECT path FROM nodes WHERE guild_id = ? ORDER BY path').all(guildId);
  for (const row of rows) {
    const file = row.path ? join(out, `${row.path}.md`) : join(out, 'README.md');
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${runMemoryTool({ guildId }, { path: row.path })}\n`);
  }
  const episodes = memoryDb().prepare<[string], { id: number }>('SELECT id FROM episodes WHERE guild_id = ? ORDER BY at_ms').all(guildId);
  writeFileSync(join(out, 'episodes.md'), episodes.map((row) => runMemoryTool({ guildId }, { episode: `e${row.id}` })).join('\n\n---\n\n'));
  console.log(`${rows.length} pages, ${episodes.length} episodes → ${out}`);
}

switch (command) {
  case 'status': status(); break;
  case 'estimate': estimate(); break;
  case 'run': await run(); break;
  case 'try': await tryOnce(); break;
  case 'show': console.log(runMemoryTool({ guildId }, { path: String(args.path ?? ''), with: args.with ? String(args.with) : '' })); break;
  case 'episode': console.log(runMemoryTool({ guildId }, { episode: String(args.id ?? '') })); break;
  case 'search': console.log(runMemoryTool({ guildId }, { query: String(args.query ?? '') })); break;
  case 'recall': console.log(recallFor(guildId, { request: String(args.text ?? '') }) || '(何も思い出さない)'); break;
  case 'root': console.log(memoryRootPrompt(guildId) || '(まだ木がありません)'); break;
  case 'export': exportTree(); break;
  case 'settle': await settle(console.log); console.log(JSON.stringify(modelBudgetStatus(budgetIdFor(guildId)))); break;
  case 'reopen-empty': {
    const rows = reopenEmptySegments(guildId, { minChars: Number(args['min-chars'] ?? treeConfig.emptyChars), apply: Boolean(args.yes) });
    const messages = rows.reduce((sum, row) => sum + row.messages, 0);
    console.log(`${args.yes ? '読み直しに回した' : '読み直しに回す (--yes で実行)'}: ${rows.length} 区切り / ${messages} 発言`);
    break;
  }
  case 'reset':
    if (args.yes !== true) { console.error('記憶を消すには --yes を付けてください (原文のアーカイブは残ります)'); process.exit(2); }
    resetTree(guildId);
    console.log('reset');
    break;
  default:
    console.error(`unknown command: ${command}`);
    process.exit(2);
}
