// 記憶の本の検証 (npm run check から呼ぶ)。モデルは偽物で、AI は呼ばない。
//
// 固定したいこと:
//   - 台本が短く、行番号から元の message_id に戻せる。bot・削除済み・非公開チャンネルは読まない
//   - 出来事は根拠の発言を持つ (実在しない行番号の出来事は作らない)
//   - 知識は必ず出来事を指す。ログの丸写しは捨てる
//   - ページは統合で書き直され、[e12] と [[リンク]] が残る。根拠を全部落とした書き直しは受け取らない
//   - ページ → 出来事 → 元の発言、2つのページが両方関わった出来事、出来事の前後をたどれる
//   - 書く前に既知のページと最近の出来事を渡し、続きの出来事を結べる
//   - 会話に出た名前・別名から思い出す
//   - 区切りの結果と cursor が同じトランザクションで進む / 無料枠が尽きたら何も進めずに止まる
//   - 読めない出力が続いた区切りは failed にして先へ進み、あとでやり直せる / 新着は貯まるまで待つ
//
// ARCHIVE_DB_PATH / MEMORY_DB_PATH を一時ファイルに向けて呼ぶこと。

import { hostname } from 'node:os';
import { db as archive } from '../src/archive/db.js';
import {
  StopRun, acquireLock, applyIntegrateResult, copiedRatio, parseModelJson, runBuild, segmentPrompt, treeConfig
} from '../src/memory/build.js';
import {
  getCursor, getEpisode, getNode, memoryCounts, memoryDb, normalizePath, resetTree, savePublicChannels, segmentStats,
  setState
} from '../src/memory/store.js';
import { forgetNames, recallFor } from '../src/memory/recall.js';
import { memoryRootPrompt, memoryToolDefinition, runMemoryTool } from '../src/memory/tool.js';
import { planPack, renderSegment } from '../src/memory/transcript.js';

const fail = (message) => { throw new Error(message); };
const GUILD = '900000000000000001';
const OPEN = '900000000000000010';
const TALK = '900000000000000011';
const SECRET = '900000000000000012';
const TAKO = '800000000000000001';
const SABA = '800000000000000002';
const BOT = '800000000000000003';
const DAY = 86_400_000;
const T0 = Date.UTC(2025, 2, 14, 5, 0, 0);   // 14:00 JST

// ---- 準備 ------------------------------------------------------------------

archive.prepare('DELETE FROM messages WHERE guild_id = ?').run(GUILD);
archive.prepare('DELETE FROM channels WHERE guild_id = ?').run(GUILD);
resetTree(GUILD);
memoryDb().prepare('DELETE FROM public_channels WHERE guild_id = ?').run(GUILD);
memoryDb().prepare('DELETE FROM state WHERE key LIKE ?').run(`%${GUILD}%`);

const channel = archive.prepare('INSERT INTO channels (channel_id, guild_id, name) VALUES (?, ?, ?)');
channel.run(OPEN, GUILD, '開発');
channel.run(TALK, GUILD, '雑談');
channel.run(SECRET, GUILD, '運営');

let seq = 0n;
const insert = archive.prepare(`
  INSERT INTO messages (message_id, guild_id, channel_id, author_id, author_name, is_bot, content, created_at,
    reply_to, attachment_count, attachment_kinds, char_count, deleted)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const say = (channelId, author, name, content, at, extra = {}) => {
  seq += 1n;
  const id = (1350000000000000000n + seq).toString();
  insert.run(id, GUILD, channelId, author, name, extra.bot ? 1 : 0, content, at, extra.replyTo ?? null,
    extra.attachments ?? 0, extra.kinds ?? '', [...content].length, extra.deleted ? 1 : 0);
  return id;
};

const first = say(OPEN, TAKO, 'tako_old', 'sakana bot の統治機能を作ってる', T0);
const second = say(OPEN, TAKO, 'tako_old', '国会は72時間ごとに開く予定', T0 + 60_000);  // 同じ人・3分以内 → 1行
const reply = say(OPEN, SABA, 'さば', 'いいね、裁判所も欲しい', T0 + 2 * 60_000, { replyTo: first });
say(OPEN, BOT, 'Sakana', 'BOT の発言は読まない', T0 + 3 * 60_000, { bot: true });
say(OPEN, SABA, 'さば', '消した発言', T0 + 4 * 60_000, { deleted: true });
say(OPEN, SABA, 'さば', '', T0 + 5 * 60_000, { attachments: 1, kinds: 'image/png' });
say(OPEN, TAKO, 'たこ', '名前を変えた', T0 + 30 * 60_000);                              // 最新の表示名は「たこ」
say(SECRET, TAKO, 'たこ', '非公開の相談', T0 + 6 * 60_000);
for (let i = 0; i < 30; i += 1) say(TALK, SABA, 'さば', `裁判所の実装 ${i} 日目、テストが通った`, T0 + DAY + i * 20 * 60_000);

// bot が書く控え: 運営 (SECRET) は入らない
savePublicChannels(GUILD, [OPEN, TALK]);

// ---- 台本 ------------------------------------------------------------------

const segment = renderSegment({ guildId: GUILD, channelId: OPEN, cursor: null, maxChars: 100_000 });
const text = segment.text;
if (!text.startsWith('## #開発 2025-03-14\n1|14:00 たこ: ')) fail('transcript must start with a header and a numbered line in the latest name:\n' + text);
if (!text.includes('1|14:00 たこ: sakana bot の統治機能を作ってる / 国会は72時間ごとに開く予定')) fail('same author within 3 min must merge:\n' + text);
if (!text.includes('2|さば→たこ: いいね、裁判所も欲しい / [画像]')) fail('a reply names its target; an image-only follow-up stays visible:\n' + text);
if (/BOT|消した|tako_old/.test(text)) fail('bots, deleted messages and old display names must not appear:\n' + text);
if (!text.includes('\n3|14:30 たこ: 名前を変えた')) fail('a 10+ minute gap must print the time:\n' + text);
if (segment.lineMap.get(1).ids.join() !== [first, second].join()) fail('a merged line must map back to every message');
if (segment.lineMap.get(2).ids[0] !== reply) fail('line numbers must map to message ids');
if (segment.messages !== 5) fail(`segment must count the 5 human, live messages (got ${segment.messages})`);
if (segment.chars > 220) fail(`transcript should stay compact (${segment.chars} chars)`);

// ---- 偽のモデル -------------------------------------------------------------

Object.assign(treeConfig, { segmentChars: 900, minChars: 0, idleMs: 0, integrateChars: 100, rootEverySegments: 1000 });

const calls = [];
let mode = 'ok';
let inFlight = 0;
let maxInFlight = 0;
let slowLabel = null;
let slowSeen = false;
let slowActive = false;
let finishedDuringSlow = false;
let refillsDuringSlow = 0;
const busyChannels = new Set();
const fake = async ({ kind, user }) => {
  calls.push({ kind, user });
  // 同時に何本走ったか、同じ波の区切りがチャンネルを取り合っていないかを見る
  const labels = kind === 'segment' ? [...new Set([...(user.split('会話ログ')[1] ?? '').matchAll(/^## (#\S+)/gm)].map((m) => m[1]))] : [];
  for (const label of labels) {
    if (busyChannels.has(label)) fail('two concurrent segments read the same channel: ' + label);
    busyChannels.add(label);
  }
  inFlight += 1;
  maxInFlight = Math.max(maxInFlight, inFlight);
  // 遅い1本 (#wide0 の最初の区切り) が走っている間に、空いた枠へ次が入るか (作業プール)
  const slow = slowLabel && labels.includes(slowLabel) && !slowSeen;
  if (slow) { slowSeen = true; slowActive = true; }
  else if (slowActive && finishedDuringSlow) refillsDuringSlow += 1;
  await new Promise((resolve) => setTimeout(resolve, slow ? 150 : 5));
  if (slow) slowActive = false;
  else if (slowActive) finishedDuringSlow = true;
  inFlight -= 1;
  for (const label of labels) busyChannels.delete(label);
  if (mode === 'quota') throw new StopRun('無料枠の上限', 'quota');
  if (kind === 'segment') {
    if (mode === 'garbage') return { json: parseModelJson('すみません、できません'), model: 'fake' };
    // 既知のページにも前の出来事の題が載るので、会話ログの部分だけで判定する
    const log = user.split('会話ログ (行頭の数字が行番号):')[1] ?? '';
    if (log.includes('統治機能')) {
      return { model: 'fake', json: {
        episodes: [
          { kind: 'レスバ 気味の決定', title: '統治機能の実装を始めた', summary: 'たこが sakana bot に国会の仕組みを入れ始め、さばが裁判所も欲しいと言った。',
            lines: [1, 2], quotes: [2, 999], nodes: ['people/たこ', 'people/さば', 'projects/sakana-bot', 'debates/統治の作り方'], importance: 3 },
          { title: '存在しない行', summary: '根拠の行が実在しない', lines: [999], nodes: ['people/たこ'] }
        ],
        facts: [
          { path: 'projects/sakana-bot', text: '国会を定期的に開く統治の仕組みを持つ', episode: 0 },
          { path: 'people/たこ', text: 'sakana bot の作者で統治機能を実装している', episode: 0 },
          { path: 'people/たこ', text: 'sakana bot の統治機能を作ってる / 国会は72時間ごとに開く予定', episode: 0 },  // 丸写し
          { path: 'people/さば', text: '裁判所の機能を望んでいる', episode: 1 },   // 出来事が捨てられた → 根拠なし
          { path: 'people/さば', text: '根拠の番号が無い知識' }
        ],
        new: [{ path: 'Projects/sakana-bot', summary: 'たこが作っている統治 bot', aliases: ['sakana', 'さかな'] }]
      } };
    }
    if (log.includes('裁判所の実装')) {
      const known = /e(\d+) \d{4}-\d{2}-\d{2}(?: \[[^\]]*\])? 統治機能の実装を始めた/.exec(user);
      return { model: 'fake', json: {
        episodes: [{ title: '裁判所を実装した', summary: 'さばが sakana bot の裁判所を実装し、テストが通った。', lines: [1, 3],
          nodes: ['people/さば', 'sakana'], related: known ? [`e${known[1]}`] : [], importance: 2 }],
        facts: [{ path: 'people/さば', text: 'sakana bot の裁判所を実装した', episode: 0 },
          { path: 'projects/sakana-bot', text: '裁判所の機能がある', episode: 0 }],
        new: []
      } };
    }
    return { json: { episodes: [], facts: [], new: [] }, model: 'fake' };
  }
  if (kind === 'integrate') {
    if (mode === 'lose-refs') {
      const paths = [...user.matchAll(/^### (.+)$/gm)].map((m) => m[1]);
      return { model: 'fake', json: { pages: paths.map((path) => ({ path, summary: 'x', body: '根拠を全部消した長い本文'.repeat(20) })) } };
    }
    const pages = [...user.matchAll(/^### (.+)\n[\s\S]*?新しい知識:\n([\s\S]*?)(?=\n\n### |\n\n各ページ|$)/gm)].map((m) => {
      const path = m[1];
      const facts = m[2].split('\n').map((line) => line.replace(/^- /, '')).filter(Boolean);
      const link = path === 'people/たこ' ? ' [[projects/sakana-bot]] を作っている。' : '';
      return { path, summary: `${path} の説明`, body: `概要。${link}\n${facts.join('\n')}` };
    });
    return { model: 'fake', json: { pages } };
  }
  if (kind === 'root') return { model: 'fake', json: { body: '- 開発と雑談のサーバー\n- たこが [[projects/sakana-bot]] を作っている' } };
  fail('unexpected call ' + kind);
};

// 無料枠切れ: 何も進まない
mode = 'quota';
const stopped = await runBuild({ guildId: GUILD, call: fake });
if (stopped.stopped !== 'quota') fail('quota must stop the run: ' + JSON.stringify(stopped));
if (getCursor(GUILD, OPEN)) fail('a stopped run must not advance cursors');

// 読めない出力が3回 → failed にして先へ
mode = 'garbage';
const garbage = await runBuild({ guildId: GUILD, call: fake, maxCalls: 3 });
if (garbage.failed === 0) fail('three unreadable outputs must mark the pack failed: ' + JSON.stringify(garbage));
if (!segmentStats(GUILD).some((row) => row.status === 'failed')) fail('failed segments must be recorded');

// 通常 (failed もやり直す)
mode = 'ok';
calls.length = 0;
const done = await runBuild({ guildId: GUILD, call: fake, retryFailed: true });
if (done.stopped !== 'done') fail('run must finish: ' + JSON.stringify(done));
if (calls.some((c) => c.user.includes('非公開の相談'))) fail('a channel missing from the public snapshot must never be sent');
if (done.dropped.copied !== 1) fail('a fact copied from the log must be dropped: ' + JSON.stringify(done.dropped));
if (done.dropped.unsourced !== 2) fail('facts without a surviving episode must be dropped: ' + JSON.stringify(done.dropped));
if (done.dropped.noSource !== 1) fail('an episode citing no real line must be dropped: ' + JSON.stringify(done.dropped));

// 出来事 → 元の発言
const counts = memoryCounts(GUILD);
// 雑談は区切りの大きさ次第で2回に分かれるので、件数は下限だけ見る
if (counts.episodes < 2) fail('at least two episodes expected: ' + JSON.stringify(counts));
const start = getEpisode(GUILD, 1);
if (start.kind !== 'レスバ 気味の決定') fail('episode kind must be stored: ' + start.kind);
if (start.highlights.length !== 1 || start.highlights[0] !== reply) fail('quotes must be stored as the real message ids of the cited lines: ' + JSON.stringify(start.highlights));
if (!getNode(GUILD, 'debates/統治の作り方')) fail('debates is a top level the writer can use');
if (!start.sources.includes(first) || !start.sources.includes(reply)) fail('episode sources must be the cited messages: ' + JSON.stringify(start.sources));
if (start.at_ms !== T0) fail('episode time must come from the messages, not the model');
for (const path of ['people/たこ', 'people/さば', 'projects/sakana-bot']) {
  if (!start.nodes.includes(path)) fail(`episode must link ${path}: ${start.nodes}`);
}

// 既知のページを渡して、続きの出来事を結べる
const secondPrompt = calls.find((c) => c.kind === 'segment' && c.user.split('会話ログ')[1]?.includes('裁判所の実装')).user;
if (!/既知のページ[\s\S]*### people\/さば/.test(secondPrompt)) fail('the writer must see known pages for names in the log');
if (!secondPrompt.includes('統治機能の実装を始めた')) fail('the writer must see recent episodes of known pages');
const court = getEpisode(GUILD, 2);
if (court.before[0]?.id !== 1) fail('a continuing episode must link to the earlier one');
if (getEpisode(GUILD, 1).after[0]?.id !== 2) fail('the earlier episode must show what followed');
if (!court.nodes.includes('projects/sakana-bot')) fail('an alias (sakana) must resolve to the existing page');

// ページは統合で書き直される
const tako = getNode(GUILD, 'people/たこ');
if (tako.pending) fail('integrated pages must have no pending knowledge');
if (!/\[e1\]/.test(tako.body) || !tako.body.includes('[[projects/sakana-bot]]')) fail('page body must keep [e] refs and links:\n' + tako.body);
if (!getNode(GUILD, 'projects/sakana-bot').aliases.includes('さかな')) fail('aliases must be stored');
if (!done.root || !getNode(GUILD, '').body.includes('sakana-bot')) fail('the root must be written at the end');

// 根拠を全部落とした書き直しは受け取らない
memoryDb().prepare("UPDATE nodes SET pending = '- 新しい知識 [e2]\n', pending_count = 1 WHERE guild_id = ? AND path = 'people/さば'").run(GUILD);
const refused = applyIntegrateResult(GUILD, [{ path: 'people/さば', consumed: '- 新しい知識 [e2]\n' }],
  { pages: [{ path: 'people/さば', body: '根拠なし'.repeat(40) }] });
if (refused.failed[0]?.problem !== 'lost every [e] reference') fail('a rewrite that drops every reference must be refused: ' + JSON.stringify(refused));
if (!getNode(GUILD, 'people/さば').pending) fail('a refused page keeps its pending knowledge');

// 3回失敗したページは知識を落とさず本文の末尾へ移す
mode = 'lose-refs';
treeConfig.integrateChars = 1;
for (let i = 0; i < 4; i += 1) await runBuild({ guildId: GUILD, call: fake });
const saba = getNode(GUILD, 'people/さば');
if (saba.pending || !saba.body.includes('新しい知識 [e2]')) fail('after repeated failures pending knowledge must be kept in the body');
mode = 'ok';
treeConfig.integrateChars = 100;

// 2回目は何も読まず、何も呼ばない
calls.length = 0;
const idle = await runBuild({ guildId: GUILD, call: fake });
if (calls.length !== 0 || idle.calls !== 0) fail('an idle run must not call the model: ' + calls.map((c) => c.kind).join(','));

// 新着: 少量でまだ続いていそうなら待つ。時間が経てば読む
const fresh = say(TALK, TAKO, 'たこ', '新着', Date.now() - 60_000);
if (planPack({ guildId: GUILD, channelIds: [OPEN, TALK], targetChars: 900, minChars: 5000, idleMs: 6 * 3_600_000 })) fail('a small fresh tail must wait');
const idleTail = planPack({ guildId: GUILD, channelIds: [OPEN, TALK], targetChars: 900, minChars: 5000, idleMs: 6 * 3_600_000, now: Date.now() + 7 * 3_600_000 });
if (!idleTail || idleTail.segments[0].toId !== fresh) fail('an idle tail must be read');

// ---- 並行: チャンネルが重ならない区切りを同時に投げる ---------------------------

const WIDE = '900000000000000002';
const wideChannels = ['900000000000000020', '900000000000000021', '900000000000000022'];
resetTree(WIDE);
archive.prepare('DELETE FROM messages WHERE guild_id = ?').run(WIDE);
for (const [i, id] of wideChannels.entries()) {
  archive.prepare('INSERT OR REPLACE INTO channels (channel_id, guild_id, name) VALUES (?, ?, ?)').run(id, WIDE, `wide${i}`);
  for (let j = 0; j < 40; j += 1) {
    seq += 1n;
    insert.run((1350000000000000000n + seq).toString(), WIDE, id, `70000000000000000${i}`, `user${i}`, 0,
      `チャンネル${i}の話題 ${j} についての長めの発言をここに書く`, T0 + j * 20 * 60_000, null, 0, '', 20, 0);
  }
}
savePublicChannels(WIDE, wideChannels);
maxInFlight = 0;
slowLabel = '#wide0';
const wide = await runBuild({ guildId: WIDE, call: fake });
slowLabel = null;
if (refillsDuringSlow < 1) fail('a slow call must not hold back the others (the pool must refill freed slots)');
if (wide.stopped !== 'done') fail('the wide run must finish: ' + JSON.stringify(wide));
if (maxInFlight < 2) fail('segments on different channels must run concurrently (max in flight ' + maxInFlight + ')');
for (const id of wideChannels) if (!getCursor(WIDE, id)) fail('every channel must be read in the concurrent run');
resetTree(WIDE);
archive.prepare('DELETE FROM messages WHERE guild_id = ?').run(WIDE);
archive.prepare('DELETE FROM channels WHERE guild_id = ?').run(WIDE);

// ---- たどる -----------------------------------------------------------------

forgetNames(GUILD);
const refs = { entries: [], add(entry) { this.entries.push(entry); return this.entries.length; } };
const ctx = { guildId: GUILD, refs };
const page = runMemoryTool(ctx, { path: 'people/さば' });
if (!page.includes('e2') || !page.includes('[[people/たこ]]')) fail('a page must show its episodes and connections:\n' + page);
const both = runMemoryTool(ctx, { path: 'people/たこ', with: 'people/さば' });
if (!both.includes('統治機能の実装を始めた')) fail('with must list episodes shared by both pages:\n' + both);
const opened = runMemoryTool(ctx, { episode: 'e1' });
if (!opened.includes('★') || !opened.includes('いいね、裁判所も欲しい') || !opened.includes('[レスバ 気味の決定]')) fail('an episode must show its kind and highlighted quote verbatim:\n' + opened);
if (!runMemoryTool(ctx, { query: 'レスバ' }).includes('統治機能の実装を始めた')) fail('episodes must be searchable by kind');
if (!opened.includes('1) ') || !opened.includes('sakana bot の統治機能を作ってる')) fail('an episode must open its source messages with citation numbers:\n' + opened);
// 決め台詞は先に並ぶので順番は問わない。根拠の発言が引用番号として登録されていること
if (!refs.entries.some((entry) => entry.messageId === first) || refs.entries[0]?.messageId !== reply) fail('cited sources must be registered for citation, highlights first');
if (!opened.includes('後の出来事: e2')) fail('an episode must show what followed');
const found = runMemoryTool(ctx, { query: '裁判所' });
if (!found.includes('裁判所を実装した')) fail('query must find episodes:\n' + found);
if (!runMemoryTool(ctx, { query: 'たこ' }).includes('people/たこ')) fail('2-char names must be searchable');
if (!runMemoryTool(ctx, { path: 'people/いない' }).includes('ありません')) fail('a missing page must say so');
// 非公開になったチャンネルの発言は開かない
savePublicChannels(GUILD, [TALK]);
if (!runMemoryTool({ guildId: GUILD }, { episode: 'e1' }).includes('開けません')) fail('sources in a now-private channel must not open');
savePublicChannels(GUILD, [OPEN, TALK]);
if (JSON.stringify(memoryToolDefinition).length > 900) fail('memory tool definition must stay small');

// ---- 思い出す ---------------------------------------------------------------

const recalled = recallFor(GUILD, { request: 'さばって sakana の何を作ったんだっけ' });
if (!recalled.includes('[[people/さば]]') || !recalled.includes('[[projects/sakana-bot]]')) fail('names and aliases must be recalled:\n' + recalled);
if (!recalled.includes('e2')) fail('recall must bring up related episodes:\n' + recalled);
if (recallFor(GUILD, { request: 'こんにちは' }) !== '') fail('nothing must be recalled from an unrelated message');
if (recalled.length > 1900) fail('recall must stay bounded');

const root = memoryRootPrompt(GUILD);
if (!root.includes('## 記憶') || !root.includes('sakana-bot')) fail('root prompt must carry the root body:\n' + root);
if (!/- people\/ \(2\): (たこ|さば), (たこ|さば)/.test(root)) fail('root prompt must list top-level pages:\n' + root);
if (memoryRootPrompt('nobody') !== '') fail('a guild without memory must add nothing to the prompt');

// ---- 小物 ------------------------------------------------------------------

if (normalizePath('/people//たこ/') !== 'people/たこ') fail('slashes must collapse');
if (normalizePath('[[people/たこ]]') !== 'people/たこ') fail('wiki links must normalize');
if (normalizePath('../../etc') !== 'etc') fail('.. must be dropped');
if (normalizePath('Debates/x') !== 'debates/x') fail('ASCII top levels are lowercased');
// 最上位は必ずどれかに分類する: 知らない最上位は others の下。最上位を増やす・消すのは管理者
{
  const st = await import('../src/memory/store.js');
  const CAP = '900000000000000003';
  resetTree(CAP);
  st.ensureSeeds(CAP);
  if (st.placeTopLevel(CAP, 'people/x') !== 'people/x') fail('an existing top level stays');
  if (st.placeTopLevel(CAP, 'brandnew/x') !== 'others/brandnew/x') fail('an unknown top level goes under others');
  // others に育ったまとまりを昇格: ページ・出来事のつながり・本文のリンクごと移る
  st.ensureNode(CAP, 'others/レスバ集/GoとRust');
  st.addPending(CAP, 'others/レスバ集/GoとRust', ['毎月蒸し返される [e1]']);
  st.ensureNode(CAP, 'people/たこ');
  st.writePage(CAP, 'people/たこ', { body: '常連。[[others/レスバ集/GoとRust]] の当事者 [e1]' });
  const ep = st.insertEpisode(CAP, { kind: 'レスバ', title: 't', summary: 's', channelId: 'c', atMs: 1, endMs: 2, sources: [], importance: 2 });
  st.linkEpisodeNodes(CAP, ep, ['others/レスバ集/GoとRust', 'people/たこ'], 1);
  st.addTopLevel(CAP, 'flamewars', 'レスバの記録');
  const moved = st.moveSubtree(CAP, 'others/レスバ集', 'flamewars/レスバ集');
  if (moved !== 2) fail('the subtree (2 pages) must move: ' + moved);
  if (!st.getNode(CAP, 'flamewars/レスバ集/GoとRust') || st.getNode(CAP, 'others/レスバ集')) fail('pages must move to the promoted top level');
  if (!st.getEpisode(CAP, ep).nodes.includes('flamewars/レスバ集/GoとRust')) fail('episode links must follow the move');
  if (!st.getNode(CAP, 'people/たこ').body.includes('[[flamewars/レスバ集/GoとRust]]')) fail('[[links]] in bodies must follow the move');
  if (!st.linkedPages(CAP, 'people/たこ').some((row) => row.path === 'flamewars/レスバ集/GoとRust')) fail('page links must follow the move');
  // 最上位を消すと中身は others の下へ。消した種は作り直さない
  st.removeTopLevel(CAP, 'culture');
  if (st.getNode(CAP, 'culture') || !st.getNode(CAP, 'others/culture')) fail('a removed top level moves under others');
  st.ensureSeeds(CAP);
  if (st.getNode(CAP, 'culture')) fail('a removed seed must not come back');
  let refused = false;
  try { st.removeTopLevel(CAP, 'others'); } catch { refused = true; }
  if (!refused) fail('others cannot be removed');
  for (let i = st.topLevels(CAP, 99).length; i < st.MAX_TOP_LEVEL; i += 1) st.addTopLevel(CAP, `cat${i}`);
  refused = false;
  try { st.addTopLevel(CAP, 'onemore'); } catch { refused = true; }
  if (!refused) fail(`top levels are capped at ${st.MAX_TOP_LEVEL}`);
  resetTree(CAP);
}
if (normalizePath('a/b/c/d/e/f').split('/').length > 4) fail('depth must be capped');
if (copiedRatio('まったく別の言い方でまとめた説明文になっている', 'たこ:sakanabotの統治機能を作ってる') > 0.2) fail('paraphrase must not count as a copy');
if (!segmentPrompt(GUILD, { text: 'x', lineMap: new Map() }).includes('JSON だけ')) fail('segment prompt must end with the output reminder');

setState(`lock:${GUILD}`, { pid: process.ppid, host: hostname(), at: Date.now() });
let locked = false;
try { acquireLock(GUILD); } catch (error) { locked = error.reason === 'locked'; }
if (!locked) fail('a live builder must hold the lock');
setState(`lock:${GUILD}`, null);

resetTree(GUILD);
archive.prepare('DELETE FROM messages WHERE guild_id = ?').run(GUILD);
archive.prepare('DELETE FROM channels WHERE guild_id = ?').run(GUILD);
console.log('memory ok (台本と行番号 / 並行 / 出来事と根拠 / 丸写し・根拠なしを捨てる / 統合と[e]・[[リンク]] / 続きの出来事 / 2つの間の出来事 / 想起 / 再開・無料枠・失敗)');
