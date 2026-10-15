import 'dotenv/config';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { db as archive } from '../src/archive/db.js';
import { modelBudgetStatus } from '../src/ai/cost.js';
import { StopRun, openRouterCaller, runBuild, segmentPrompt, treeConfig } from '../src/memory/build.js';
import {
  getCursor, getNode, getState, loadPublicChannels, memoryCounts, memoryDb, reopenEmptySegments, resetTree, segmentStats
} from '../src/memory/store.js';
import { recallFor } from '../src/memory/recall.js';
import { memoryRootPrompt, runMemoryTool } from '../src/memory/tool.js';
import { planPack } from '../src/memory/transcript.js';

// 記憶の本の builder。bot とは別プロセスで動かす (systemd timer: deploy/sakana-memory.*)。
//
//   node scripts/memory-tree.mjs status  --guild ID          進み具合 (AI を呼ばない)
//   node scripts/memory-tree.mjs run     --guild ID [--max-calls N] [--max-minutes M] [--retry-failed]
//   node scripts/memory-tree.mjs try     --guild ID [--model M]   次の区切りを1回だけ投げて表示 (保存しない)
//   node scripts/memory-tree.mjs show    --guild ID [--path P] [--with Q]  ページを表示 (agent の memory ツールと同じ形)
//   node scripts/memory-tree.mjs episode --guild ID --id e12      出来事と根拠の発言
//   node scripts/memory-tree.mjs search  --guild ID --query Q
//   node scripts/memory-tree.mjs recall  --guild ID --text T      この文で何を思い出すか (agent の入力に足すもの)
//   node scripts/memory-tree.mjs root    --guild ID               system に入る根の文面
//   node scripts/memory-tree.mjs estimate --guild ID              未読の量 (アーカイブを走査するので重い)
//   node scripts/memory-tree.mjs export  --guild ID --out DIR     Markdown に書き出す
//   node scripts/memory-tree.mjs reset   --guild ID --yes         記憶を消す (原文には触らない)
//   node scripts/memory-tree.mjs reopen-empty --guild ID [--yes]  出来事が1つも無い長い区切りを読み直しに回す

const [command, ...rest] = process.argv.slice(2);
const args = {};
for (let i = 0; i < rest.length; i += 1) {
  if (!rest[i].startsWith('--')) continue;
  const key = rest[i].slice(2);
  args[key] = rest[i + 1] && !rest[i + 1].startsWith('--') ? rest[++i] : true;
}
const guildId = String(args.guild ?? process.env.MEMORY_TREE_GUILD ?? '');
if (!command || !guildId) {
  console.error('usage: node scripts/memory-tree.mjs <status|run|try|show|episode|search|recall|root|estimate|export|reset|reopen-empty> --guild ID');
  process.exit(2);
}

const day = (ms) => (ms ? new Date(ms).toISOString().replace('T', ' ').slice(0, 16) : '-');

function status() {
  const snapshot = loadPublicChannels(guildId);
  const channels = snapshot?.channelIds ?? [];
  const newest = archive.prepare('SELECT MAX(created_at) AS at FROM messages WHERE channel_id = ?');
  let caughtUp = 0;
  let behind = 0;
  let oldest = null;
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
  const report = {
    models: treeConfig.models,
    publicChannels: { count: channels.length, snapshotAt: day(snapshot?.at) },
    channels: { caughtUp, behind, oldestCursor: oldest === null ? null : (oldest ? day(oldest) : '未読') },
    segments: {
      done: segments.done?.segments ?? 0, messages: segments.done?.messages ?? 0, chars: segments.done?.chars ?? 0,
      failed: segments.failed?.segments ?? 0, latest: day(segments.done?.latest)
    },
    memory: memoryCounts(guildId),
    root: { chars: root?.body?.length ?? 0, updatedAt: day(root?.updated_at), segmentsSince: getState(`root:${guildId}`)?.segments ?? 0 },
    lock: lock ? { ...lock, at: day(lock.at) } : null
  };
  if (treeConfig.budgetUsd > 0) {
    try { report.budget = modelBudgetStatus(`memory-tree:${guildId}:${treeConfig.budgetUsd}`); } catch { report.budget = null; }
  }
  console.log(JSON.stringify(report, null, 2));
}

function estimate() {
  const channels = loadPublicChannels(guildId)?.channelIds ?? [];
  const count = archive.prepare(`
    SELECT COUNT(*) AS messages, COALESCE(SUM(char_count), 0) AS chars FROM messages
    WHERE channel_id = ? AND deleted = 0 AND is_bot = 0 AND created_at > ?
  `);
  let messages = 0;
  let chars = 0;
  for (const channelId of channels) {
    const row = count.get(channelId, getCursor(guildId, channelId)?.last_ms ?? 0);
    messages += row.messages;
    chars += row.chars;
  }
  // 1行 = 時刻・名前・区切りの分だけ本文より長くなる (実測で1発言あたり +8字前後)
  const transcript = chars + messages * 8;
  console.log(JSON.stringify({
    unreadMessages: messages, unreadChars: chars, transcriptChars: transcript,
    segmentCalls: Math.ceil(transcript / treeConfig.segmentChars),
    note: '整理 (compact) と根の呼び出しが別に要る。無料枠は1日50回 (購入累計10ドル以上で1000回)'
  }, null, 2));
}

async function run() {
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

async function tryOnce() {
  const pack = planPack({ guildId, channelIds: loadPublicChannels(guildId)?.channelIds ?? [],
    targetChars: treeConfig.segmentChars, now: Date.now() });
  if (!pack) { console.log('読む区切りがありません'); return; }
  const models = args.model ? [String(args.model)] : treeConfig.models;
  const call = openRouterCaller({ guildId, models });
  const { SEGMENT_SYSTEM } = await import('../src/memory/build.js');
  const started = Date.now();
  try {
    const result = await call({ kind: 'segment', system: SEGMENT_SYSTEM, user: segmentPrompt(guildId, pack) });
    const { episodes = [], facts = [], new: created = [] } = result.json ?? {};
    console.log(`model ${result.model} / ${((Date.now() - started) / 1000).toFixed(0)}s / in ${result.usage?.prompt_tokens} out ${result.usage?.completion_tokens} tokens`);
    console.log(`区切り: ${pack.segments.map((s) => `${s.label} ${day(s.fromMs)}〜${day(s.toMs)} (${s.messages}件)`).join(', ')} / ${pack.chars}字`);
    console.log(`\n出来事 ${episodes.length}:`);
    episodes.forEach((episode, i) => {
      const cited = (episode.lines ?? []).map((n) => pack.lineMap.get(Number(n)) ? n : `${n}?`).join(',');
      console.log(`  [${i}] ${episode.title} (重要度 ${episode.importance}, 行 ${cited}) ${(episode.nodes ?? []).join(' ')}`);
      console.log(`      ${episode.summary}`);
    });
    console.log(`\n知識 ${facts.length}:`);
    for (const fact of facts) console.log(`  ${fact.path} ← ${fact.text} (出来事 ${fact.episode})`);
    if (created.length) console.log(`\n新しいページ: ${created.map((entry) => `${entry.path}${entry.aliases?.length ? ` (${entry.aliases.join(',')})` : ''}`).join(', ')}`);
  } catch (error) {
    console.error(error instanceof StopRun ? `stopped: ${error.message}` : error);
    process.exitCode = 1;
  }
}

function exportTree() {
  const out = String(args.out ?? '');
  if (!out) throw new Error('--out DIR が要ります');
  const rows = memoryDb().prepare('SELECT path FROM nodes WHERE guild_id = ? ORDER BY path').all(guildId);
  for (const row of rows) {
    const file = row.path ? join(out, `${row.path}.md`) : join(out, 'README.md');
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${runMemoryTool({ guildId }, { path: row.path })}\n`);
  }
  const episodes = memoryDb().prepare('SELECT id FROM episodes WHERE guild_id = ? ORDER BY at_ms').all(guildId);
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
