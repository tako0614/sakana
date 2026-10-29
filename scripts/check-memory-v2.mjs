// 記憶 v2 の検証 (npm run check から呼ぶ)。モデルは偽物で、AI は呼ばない。
//
// 固定したいこと:
//   - 区間: 会話単位で切る / 長い会話は空いた所で割る / 同じ範囲から同じ台本ができる (コード・凡例・返信・メンション・文脈)
//   - 抽出: 話者・時刻・原文は行番号から機械が決める / 範囲外の行・丸写しは捨てる / 自己申告は本人の行が要る /
//           発言 8 件以上の会話単位が抜けたら聞き直す / 長さで切れたら区間を割って読み直す
//   - 検証: wrong は使わない / weak は hedged / 冗談に直ったら性格に使わない / 話者の取り違えは wrong / 判定の無いものは未検証と数える
//   - 解決: 人物は author_id で決まる (同名の別人は ~末尾4桁、削除済みも別人) / もの は正規化した名前で束ねる
//   - 組み立て: 主張は [cN] → [eN] / 根拠の無い文・入力に無い [cN] は捨てる / 文に入らなかった主張は機械が追記する
//   - 投影: v1 と同じ形の表に写り、[eN] の出来事が開ける / wrong の出来事は出ない
//   - 再実行しても同じ結果で、保存した出力は払い直さない / StopRun は進めずに止まる
//
// ARCHIVE_DB_PATH / MEMORY_DB_PATH を一時ファイルに向けて呼ぶこと。

process.env.MEMORY_V2_ARC_MIN = '2';   // 計画の下限 (本番は 4)
import { db as archive } from '../src/archive/db.js';
import { StopRun } from '../src/memory/build.js';
import { getEpisode, getNode, memoryDb, resetTree, savePublicChannels } from '../src/memory/store.js';
import { composeAll, makeCtx, runSections } from '../src/memory/v2/run.js';
import { cleanBody, citeEpisodes, loadGroups, planBundles, mechanicalLines } from '../src/memory/v2/compose.js';
import { normalizeExtract, uncoveredConvs } from '../src/memory/v2/extract.js';
import { v2Config } from '../src/memory/v2/call.js';
import { initV2 } from '../src/memory/v2/init.js';
import { planFrom, renderSection, splitLong } from '../src/memory/v2/prepare.js';
import { projectToV1 } from '../src/memory/v2/project.js';
import { resolveEntities, nameKey } from '../src/memory/v2/resolve.js';
import { ensureV2Schema } from '../src/memory/v2/schema.js';
import { verifyPolicy } from '../src/memory/v2/verify.js';

const fail = (message) => { throw new Error(message); };
const equal = (actual, expected, label) => {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) fail(`${label}: ${JSON.stringify(actual)} !== ${JSON.stringify(expected)}`);
};
const GUILD = '910000000000000001';
const OPEN = '910000000000000010';
const TALK = '910000000000000011';
const BIG = '910000000000000012';
const TAKO = '810000000000000001';
const SABA1 = '810000000000000002';
const SABA2 = '810000000000000003';
const GHOST = '810000000000000004';
const BOT = '810000000000000005';
const MIN = 60_000;
const T0 = Date.UTC(2025, 2, 14, 5, 0, 0);   // 14:00 JST

// ---- 準備 ------------------------------------------------------------------

archive.prepare('DELETE FROM messages WHERE guild_id = ?').run(GUILD);
archive.prepare('DELETE FROM channels WHERE guild_id = ?').run(GUILD);
resetTree(GUILD);
ensureV2Schema();
for (const table of ['v2_sections', 'v2_episodes', 'v2_episode_messages', 'v2_claims', 'v2_claim_evidence', 'v2_entities', 'v2_pages', 'v2_jobs', 'v2_llm_cache']) {
  memoryDb().prepare(`DELETE FROM ${table}`).run();
}
memoryDb().prepare('DELETE FROM public_channels WHERE guild_id = ?').run(GUILD);
memoryDb().prepare('DELETE FROM state WHERE key LIKE ?').run(`%${GUILD}%`);

const channel = archive.prepare('INSERT INTO channels (channel_id, guild_id, name) VALUES (?, ?, ?)');
channel.run(OPEN, GUILD, '開発');
channel.run(TALK, GUILD, '雑談');
channel.run(BIG, GUILD, '長文');

let seq = 0n;
const insert = archive.prepare(`
  INSERT INTO messages (message_id, guild_id, channel_id, author_id, author_name, is_bot, content, created_at,
    reply_to, attachment_count, attachment_kinds, char_count, deleted)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const say = (channelId, author, name, content, at, extra = {}) => {
  seq += 1n;
  const id = (1360000000000000000n + seq).toString();
  insert.run(id, GUILD, channelId, author, name, extra.bot ? 1 : 0, content, at, extra.replyTo ?? null,
    extra.attachments ?? 0, extra.kinds ?? '', [...content].length, extra.deleted ? 1 : 0);
  return id;
};

// 会話 A (8 発言): 1 行目と 2 行目は同じ人が続けて書くので 1 行にまとまる
const a1 = say(OPEN, TAKO, 'tako_old', 'Rust 好きなんだよね', T0);
say(OPEN, TAKO, 'tako_old', '型が堅いのがいい', T0 + MIN);
const a3 = say(OPEN, SABA1, 'さば', 'Go 派だけどな', T0 + 2 * MIN, { replyTo: a1 });
say(OPEN, TAKO, 'tako_old', `<@${SABA1}> 冗談だけど OS を Rust で書く`, T0 + 3 * MIN);
say(OPEN, SABA2, 'さば', '同名の別人です DROPME', T0 + 4 * MIN);
say(OPEN, GHOST, 'Deleted User', 'ウソ: 去年 優勝した', T0 + 5 * MIN);
say(OPEN, TAKO, 'tako_old', '多分 来週リリース', T0 + 6 * MIN);
say(OPEN, BOT, 'Sakana', 'BOT の発言は読まない', T0 + 6 * MIN + 30_000, { bot: true });
say(OPEN, SABA1, 'さば', '消した発言', T0 + 7 * MIN, { deleted: true });
say(OPEN, SABA1, 'さば', 'ところで Go vs Rust の話は終わらない', T0 + 7 * MIN + 30_000);
// 会話 B (25 分以上空く、9 発言): 最初の出力では抜ける (LATER)
const B0 = T0 + 60 * MIN;
for (let i = 0; i < 9; i += 1) {
  say(OPEN, i % 2 ? TAKO : SABA1, i % 2 ? 'たこ' : 'さば', i === 0 ? 'LATER: ベンチマーク取ったら 12% 速かった' : `LATER 続き ${i} 日目`, B0 + i * MIN);
}
// 会話 C (2 発言)
say(OPEN, TAKO, 'たこ', 'おつかれ', B0 + 120 * MIN);
say(OPEN, SABA1, 'さば', 'おつ', B0 + 121 * MIN);
// 雑談: 2 発言だけ
say(TALK, TAKO, 'たこ', 'おはよう', T0);
say(TALK, SABA1, 'さば', 'おは', T0 + MIN);
// 長文: 長さで切れる (TRUNC) 12 発言
for (let i = 0; i < 12; i += 1) say(BIG, i % 2 ? TAKO : SABA1, i % 2 ? 'たこ' : 'さば', `TRUNC ${i} 番目のメモ ${'あ'.repeat(30)}`, T0 + 3 * 24 * 60 * MIN + i * MIN);

savePublicChannels(GUILD, [OPEN, TALK, BIG]);

// ---- 計画 ------------------------------------------------------------------

{
  const slim = (n, gap, len = 100) => Array.from({ length: n }, (_, i) => ({ id: String(i + 1), at: i * gap, len }));
  // 20 分以上空いた所で会話が分かれ、2 万字を超える分だけ別の区間になる
  const plan = planFrom([...slim(100, MIN), ...slim(100, MIN).map((r) => ({ ...r, id: `b${r.id}`, at: r.at + 10 * 60 * MIN }))], 'c', 12000);
  equal(plan.length, 2, '会話単位ごとに区間が分かれる');
  equal(plan[0]?.messages, 100, '1 つ目の区間は 100 発言');
  // 1 つの長い会話は、いちばん空いた所で割る (途中に大きな間を入れる)
  const long = slim(300, MIN, 100).map((r, i) => (i >= 120 ? { ...r, at: r.at + 15 * MIN } : r));
  const parts = splitLong(long, 12000);
  if (parts.length < 2) fail('長い会話が割られない');
  equal(parts.flat().length, 300, '割っても発言は欠けない');
  if (!parts.some((part) => part.length === 120)) fail(`空いた所 (15 分の間) で割る: ${parts.map((p) => p.length)}`);
}

const init = initV2(GUILD, { target: 20000, now: Date.now() });
equal(init.channels, 3, '公開チャンネル 3 つ');
equal(init.sections, 3, '区間は 1 チャンネル 1 つずつ');
equal(initV2(GUILD, { target: 20000, now: Date.now() }).added, 0, '計画は冪等 (新着が無ければ増えない)');
const rows = memoryDb().prepare('SELECT * FROM v2_sections WHERE guild_id = ? AND channel_id = ?').all(GUILD, OPEN);
equal(rows.length, 1, '開発チャンネルは 1 区間');
const openRow = rows[0];
equal(openRow.messages, 19, 'bot・削除済みを除いた発言数 (8 + 9 + 2)');

// ---- 台本 ------------------------------------------------------------------

const range = { channelId: OPEN, fromId: openRow.from_id, toId: openRow.to_id, fromMs: openRow.from_ms, toMs: openRow.to_ms, messages: openRow.messages, chars: openRow.chars };
const section = renderSection(GUILD, range);
if (!section.text.startsWith('[凡例] ')) fail('凡例が先頭');
equal(section.codes.get(TAKO), 'A1', '最初の発言者が A1');
equal(section.labels.get('A1'), 'たこ', '表示名は最新の名前 (tako_old でなく たこ)');
if (!/A\d=さば#0002/.test(section.text) || !/A\d=さば#0003/.test(section.text)) fail(`同名の別人は author_id の末尾で見分ける: ${section.text.split('\n')[0]}`);
if (!/Deleted User#0004/.test(section.text)) fail('削除済みユーザーは別人として見分ける');
if (/BOT の発言|消した発言/.test(section.text)) fail('bot・削除済みは台本に出ない');
if (!/^1\|\d\d:\d\d A1: Rust 好きなんだよね \/ 型が堅いのがいい$/m.test(section.text)) fail(`同じ人の続けての発言は 1 行にまとまる:\n${section.text}`);
if (!/^2\|A\d→A1: Go 派だけどな$/m.test(section.text)) fail('返信先がコードで出る');
if (!/@A2/.test(section.text)) fail('メンションが発言者コードに直る');
equal(section.units.map((unit) => unit.conv), ['c1', 'c2', 'c3'], '会話単位は 3 つ');
equal(section.units.map((unit) => unit.messages), [8, 9, 2], '会話単位ごとの発言数');
equal(section.lines.get(1)?.ids.length, 2, 'まとめた行は 2 つの発言 ID');
equal(section.lines.get(1)?.authorId, TAKO, '行 → 発言者 (author_id)');
const sameAgain = renderSection(GUILD, range);
equal(sameAgain.text, section.text, '同じ範囲から同じ台本');
const onlyB = renderSection(GUILD, range, { onlyConvs: new Set(['c2']) });
if (/Rust 好き/.test(onlyB.text) || !/LATER: ベンチマーク/.test(onlyB.text)) fail('onlyConvs はその会話単位だけを出す');
const lineB = [...section.lines].find(([, info]) => info.conv === 'c2')?.[0];
if (!new RegExp(`^${lineB}\\|`, 'm').test(onlyB.text)) fail('onlyConvs でも行番号は全体のまま');
if (!/^## #開発 2025-03-14$/m.test(onlyB.text)) fail('onlyConvs でも日付の見出しが付く');

// 区間が会話の途中から始まるときは、前の 6 行が読むだけの文脈として付く
{
  const cut = { ...range, fromId: [...section.lines.get(4).ids][0], fromMs: section.lines.get(4).firstMs };
  const tail = renderSection(GUILD, cut);
  if (!tail.text.includes('(前の区間の続き')) fail('途中から始まる区間に文脈が付く');
  if (tail.lines.get(1)?.ids[0] !== cut.fromId) fail('文脈の行には番号が付かない (行 1 は区間の最初の発言)');
}

// ---- 抽出の検査 ------------------------------------------------------------

{
  const norm = normalizeExtract(section, {
    episodes: [
      { kind: 'レスバ/議論', title: 'Rust と Go', summary: '<A1> が Rust を推し、<A2> が Go を推した。', outcome: '特になし', lines: [1, 2, 99], quotes: [2], entities: ['A1', 'A2', 'Go vs Rust', 'たこ'], importance: 9 },
      { title: '範囲外', summary: '行番号が区間に無い', lines: [900] },
      { title: '丸写し', summary: 'Rust 好きなんだよね / 型が堅いのがいい', lines: [1] }
    ],
    claims: [
      { about: 'A1', text: 'Rust 派', type: 'stance', modality: 'self_report', lines: [1], episode: 0 },
      { about: 'A2', text: '本人の行が無い自己申告', type: 'trait', modality: 'self_report', lines: [1], episode: 0 },
      { about: 'たこ', text: '名前で書かれた主体は凡例のコードに直る', type: 'fact', lines: [1], episode: 0 },
      { about: 'Go vs Rust', cat: 'debates', text: 'たびたび蒸し返される', lines: [1, 2], episode: 7 },
      { about: 'A1', text: 'Rust 派', type: 'stance', lines: [1], episode: 0 },
      { about: 'A1', text: '根拠の行が無い', lines: [777], episode: 0 }
    ],
    skip: [{ conv: 'c3', reason: '挨拶のみ' }]
  });
  equal(norm.episodes.length, 1, '範囲外・丸写しの出来事は捨てる');
  equal(norm.episodes[0].lines, [1, 2], '範囲外の行番号だけ取り除く');
  equal(norm.episodes[0].kind, 'レスバ', '種類は決まった語に直す');
  equal(norm.episodes[0].importance, 3, 'importance は 1〜3 に収める');
  equal(norm.episodes[0].outcome, '', '「特になし」は結末が無いのと同じ');
  equal(norm.episodes[0].entities.slice(0, 2), ['A1', 'A2'], '関わった人はコード');
  if (!norm.episodes[0].entities.includes('A1') || norm.episodes[0].entities.filter((x) => x === 'A1').length !== 1) fail('名前で書かれた人も重複なくコードになる');
  equal(norm.claims.length, 4, '重複・根拠の無い主張は捨てる');
  equal(norm.claims[1].modality, 'hearsay', '自己申告の根拠に本人の行が無ければ伝聞');
  equal(norm.claims[2].about, 'A1', '凡例の名前で書かれた主体はコードに直る');
  equal(norm.claims[3].aboutKind, 'thing', '人でない主体');
  equal(norm.claims[3].episode, 0, '出来事の番号が無効なら、根拠の行が重なる出来事へ');
  equal(norm.dropped.noSource, 2, '根拠の行の無い出来事・主張を数える');
  equal(norm.dropped.copied, 1, '丸写しを数える');
  equal(uncoveredConvs(section, [norm]), ['c2'], '発言 8 件以上で出来事も skip も無い会話単位');
}

// ---- 偽のモデル ---------------------------------------------------------------

const calls = { extract: 0, reask: 0, verify: 0, compose: 0, trunc: 0 };

function fakeExtract(user) {
  calls.extract += 1;
  const reask = user.includes('前回の出力で次の会話単位が抜けて');
  if (reask) calls.reask += 1;
  const units = [];
  let cur = null;
  for (const line of user.split('\n')) {
    const h = line.match(/^### (c\d+) \((\d+)発言\)/);
    if (h) { cur = { conv: h[1], n: Number(h[2]), lines: [] }; units.push(cur); continue; }
    const m = line.match(/^(\d+)\|(?:\d\d:\d\d )?(A\d+)(?:→[^:]*)?: (.*)$/);
    if (m && cur) cur.lines.push({ n: Number(m[1]), code: m[2], text: m[3] });
  }
  const episodes = [];
  const claims = [];
  const skip = [];
  for (const unit of units) {
    if (unit.lines.length === 0) continue;
    if (!reask && unit.lines.some((l) => l.text.includes('LATER'))) continue;      // 最初の出力では会話 B を落とす
    if (unit.n < 3) { skip.push({ conv: unit.conv, reason: '挨拶のみ' }); continue; }
    const index = episodes.length;
    const nums = unit.lines.map((l) => l.n).slice(0, 4);
    episodes.push({ conv: unit.conv, kind: 'ネタ', title: `会話 ${unit.conv}`, summary: `${unit.lines.map((l, i) => (i ? `<${l.code}>` : l.code)).slice(0, 2).join(' と ')} が話した (${unit.conv})`, outcome: unit.lines.some((l) => l.text.includes('ベンチ')) ? '12% 速くなった' : '', lines: nums, quotes: [nums[0]], entities: [...new Set([...(unit.lines.some((l) => /Go vs Rust|ベンチ/.test(l.text)) ? ['Go vs Rust'] : []), ...unit.lines.map((l) => l.code)])].slice(0, 4), importance: 2 });
    for (const l of unit.lines) {
      if (l.text.includes('Rust 好き')) claims.push({ about: l.code, text: 'Rust が好きで、型の堅さを気に入っている', type: 'stance', modality: 'self_report', lines: [l.n], episode: index });
      if (l.text.includes('Go 派')) claims.push({ about: l.code, text: 'Go 派', type: 'stance', modality: 'self_report', lines: [l.n], episode: index });
      if (l.text.includes('冗談')) claims.push({ about: l.code, text: 'OS を Rust で書くつもりだ', type: 'skill', modality: 'plain', lines: [l.n], episode: index });
      if (l.text.includes('DROPME')) claims.push({ about: l.code, text: '同名の別人で、DROPME と書いた', type: 'fact', modality: 'plain', lines: [l.n], episode: index });
      if (l.text.includes('ウソ')) claims.push({ about: l.code, text: '去年 優勝した', type: 'fact', modality: 'plain', lines: [l.n], episode: index });
      if (l.text.includes('多分')) claims.push({ about: l.code, text: '来週リリースするらしい', type: 'fact', modality: 'plain', lines: [l.n], episode: index });
      if (l.text.includes('Go vs Rust')) claims.push({ about: 'Go vs Rust', cat: 'debates', text: 'Go と Rust の論争は終わらない', type: 'fact', modality: 'plain', lines: [l.n], episode: index });
      if (l.text.includes('ベンチマーク')) claims.push({ about: 'go vs RUST', cat: 'topics', text: 'ベンチマークで Rust が Go より 12% 速かった', type: 'outcome', modality: 'plain', attrs: { 速度: '12%' }, lines: [l.n], episode: index });
    }
  }
  return { episodes, claims, skip };
}

function fakeVerify(user) {
  calls.verify += 1;
  const items = [];
  for (const line of user.split('\n')) {
    const m = line.match(/^([ec]\d+) \| (.*)$/);
    if (!m) continue;
    const item = { id: m[1], v: 'ok' };
    if (m[2].includes('去年')) { item.v = 'wrong'; item.note = '台本に無い'; }
    else if (m[2].includes('らしい')) { item.v = 'weak'; item.note = '伝聞'; }
    else if (m[2].includes('OS を Rust')) item.mod = 'joke';
    items.push(item);
  }
  return { items };
}

function fakeCompose(user) {
  calls.compose += 1;
  const pages = [];
  let current = null;
  for (const line of user.split('\n')) {
    const h = line.match(/^=== path: (.+?) \(/);
    if (h) { current = { path: h[1], summary: `${h[1]} の説明`, body: '', aliases: [] }; pages.push(current); continue; }
    const m = line.match(/^\[c(\d+)\] (\S+) (.*)$/);
    if (m && current) {
      if (m[3].includes('DROPME')) continue;                                             // 文に入らなかった主張 → 機械が追記する
      current.body += `- ${m[3].replace(/^※弱 /, '')}${m[3].startsWith('※弱') ? 'と述べている' : ''} [c${m[1]}]\n`;
    }
  }
  for (const page of pages) page.body += '根拠の無い文がここに混ざった。\n- 入力に無い引用の文 [c99999]\n';
  return { pages };
}

function fakeArc(user) {
  const items = [...user.matchAll(/^\[e(\d+)\] (.*)$/gm)];
  const first = items[0];
  return { title: 'Go vs Rust の論争 2025-03', summary: '言語論争の経緯', body: `## 経緯\n- ${first?.[2] ?? ''} [e${first?.[1]}]\n- 入力に無い [e999999]\n- 根拠の無い文` };
}

const fake = async ({ stage, user }) => {
  if (stage === 'arc') return { json: fakeArc(user), model: 'fake', provider: null, cost: 0.001, cached: false };
  if (stage === 'root') return { json: { body: '- 開発の場。主な人物は [[people/たこ]]' }, model: 'fake', provider: null, cost: 0.001, cached: false };
  if (stage === 'extract' && user.includes('TRUNC') && (user.match(/^\d+\|/gm) ?? []).length > 6) {
    calls.trunc += 1;
    throw Object.assign(new Error('AI output was truncated'), { code: 'BAD_OUTPUT' });
  }
  const json = stage === 'extract' ? fakeExtract(user) : stage === 'verify' ? fakeVerify(user) : fakeCompose(user);
  return { json, model: 'fake', provider: null, cost: 0.001, cached: false };
};

// ---- 区間の処理 ---------------------------------------------------------------

const ctx = makeCtx(GUILD, fake);
await runSections(ctx);
const states = Object.fromEntries(memoryDb().prepare('SELECT state, COUNT(*) AS c FROM v2_sections WHERE guild_id = ? GROUP BY state').all(GUILD).map((r) => [r.state, r.c]));
equal(states, { done: 4, split: 1 }, '区間は done 4 (開発・雑談・長文の半分ずつ) と split 1');
equal(calls.trunc, 1, '長さで切れたのは 1 回');
if (calls.reask < 1) fail('抜けた会話単位を聞き直す');
const tiny = memoryDb().prepare("SELECT error FROM v2_sections WHERE channel_id = ?").get(TALK);
equal(tiny.error, 'tiny', '発言がほとんど無い区間は呼ばない');

const episodes = memoryDb().prepare('SELECT * FROM v2_episodes WHERE guild_id = ? ORDER BY id').all(GUILD);
if (episodes.length < 4) fail(`出来事が保存される: ${episodes.length}`);
const epA = episodes.find((e) => e.title === '会話 c1' && e.channel_id === OPEN);
if (!epA) fail('会話 A の出来事');
equal(epA.at_ms, T0, '時刻は原文の最初の発言から (モデルが書いた日付ではない)');
equal(epA.end_ms > epA.at_ms, true, '終わりの時刻');
const epMessages = memoryDb().prepare('SELECT message_id, role FROM v2_episode_messages WHERE episode_id = ?').all(epA.id);
if (!epMessages.some((m) => m.role === 'quote')) fail('決め台詞の発言 ID を持つ');
if (!epMessages.some((m) => m.message_id === a1)) fail('出来事は根拠の発言 ID を持つ');
if (!episodes.some((e) => e.summary.includes('たこ'))) fail('要約の <A1> は名前に直る');
if (episodes.some((e) => /<A\d+>|(?<![A-Za-z0-9_])A\d+(?![A-Za-z0-9_])/.test(e.summary))) fail('コード (<A1> でも A1 でも) が要約に残らない');
const epB = episodes.find((e) => e.title === '会話 c2');
if (!epB || epB.outcome !== '12% 速くなった') fail('聞き直した会話 B が保存される (結末つき)');

const claims = memoryDb().prepare('SELECT * FROM v2_claims WHERE guild_id = ? ORDER BY id').all(GUILD);
const claimOf = (needle) => claims.find((c) => c.text.includes(needle));
equal(claimOf('去年')?.verdict, 'wrong', '台本に無い主張は wrong');
equal(claimOf('らしい')?.verdict, 'weak', '弱い主張は weak');
equal(claimOf('らしい')?.hedged, 1, 'weak は hedged');
equal(claimOf('OS を Rust')?.modality, 'joke', '冗談に直る');
equal(claimOf('Rust が好き')?.modality, 'self_report', '自己申告のまま');
equal(claimOf('Rust が好き')?.about_key, TAKO, '主体は author_id');
equal(claimOf('Go 派')?.about_key, SABA1, 'Go 派は さば(1) の行');
equal(claimOf('ベンチマーク')?.as_of, B0, '主張の時刻は根拠の行の時刻');
equal(JSON.parse(claimOf('ベンチマーク').attrs), { 速度: '12%' }, '数字は attrs に残る');
const evidence = memoryDb().prepare('SELECT message_id FROM v2_claim_evidence WHERE claim_id = ?').all(claimOf('Go 派').id).map((r) => r.message_id);
equal(evidence, [a3], '主張の根拠は行 → 発言 ID');
if (memoryDb().prepare("SELECT COUNT(*) AS c FROM v2_claims WHERE note = 'unverified'").get().c !== 0) fail('判定の無い項目が出ていない');
const callsBefore = calls.extract + calls.verify;
await runSections(makeCtx(GUILD, fake));
equal(calls.extract + calls.verify, callsBefore, '終わった区間は読み直さない');

// ---- 解決 ------------------------------------------------------------------

const resolved = resolveEntities(GUILD, new Map([
  [TAKO, { names: [{ name: 'たこ', lastMs: B0 }, { name: 'tako_old', lastMs: T0 }], messages: 100, firstMs: T0, lastMs: B0 }],
  [SABA1, { names: [{ name: 'さば', lastMs: B0 }], messages: 50, firstMs: T0, lastMs: B0 }],
  [SABA2, { names: [{ name: 'さば', lastMs: T0 }], messages: 3, firstMs: T0, lastMs: T0 }],
  [GHOST, { names: [{ name: 'Deleted User', lastMs: T0 }], messages: 1, firstMs: T0, lastMs: T0 }]
]));
equal(resolved.people, 3, '人物は author_id ごと (wrong の主張だけの削除済みユーザーは作らない)');
const entities = memoryDb().prepare('SELECT * FROM v2_entities WHERE guild_id = ?').all(GUILD);
const paths = entities.map((e) => e.path).sort();
if (!paths.includes('people/たこ')) fail(`人物のページ名は最新の名前: ${paths}`);
equal(JSON.parse(entities.find((e) => e.key === TAKO).aliases), ['tako_old'], '昔の名前は別名');
const sabas = entities.filter((e) => e.kind === 'person' && e.name === 'さば').map((e) => e.path).sort();
equal(sabas.length, 2, '同名の別人は別のページ');
if (!sabas.some((p) => p === 'people/さば') || !sabas.some((p) => /^people\/さば~/.test(p))) fail(`同名の 2 人目は ~末尾4桁: ${sabas}`);
const thing = entities.filter((e) => e.kind === 'thing');
equal(thing.length, 1, '正規化した名前が同じものは 1 つ (Go vs Rust / go vs RUST)');
equal(thing[0].category, 'debates', '分類は多数決 (debates 1 / topics 1 は先に見たほう)');
if (nameKey('Go vs Rust') !== nameKey('go VS rust')) fail('nameKey は大小・空白を無視する');
const entityOf = (needle) => memoryDb().prepare('SELECT entity_id FROM v2_claims WHERE text LIKE ?').get(`%${needle}%`)?.entity_id ?? null;
if (entityOf('OS を Rust') === null) fail('冗談の主張にも entity は付く (想起で誰の冗談かを出す)');
equal(entityOf('去年'), null, 'wrong の主張には entity を付けない');

// ---- 組み立て --------------------------------------------------------------

{
  const groups = loadGroups(entities.find((e) => e.key === TAKO).id);
  if (groups.length < 2) fail('たこの主張 (冗談・wrong 以外)');
  if (groups.some((g) => g.text.includes('OS を Rust'))) fail('冗談の主張はページの材料にしない');
  const weak = groups.find((g) => g.text.includes('らしい'));
  if (!weak?.hedged) fail('hedged が組み立てに渡る');
  const bundles = planBundles({ id: 1, kind: 'person', name: 'たこ', path: 'people/たこ', aliases: [], meta: { messages: 12345, firstMs: T0, lastMs: B0 } }, groups);
  equal(bundles.length, 1, '主張が少なければ 1 ページ');
  if (!bundles[0].facts.some((f) => f.includes('12,345'))) fail('人物には機械が出した事実 (発言数) が付く');
  // 主張が多いと、種類ごとの子ページ + 概要になる
  const many = Array.from({ length: 100 }, (_, i) => ({ id: 1000 + i, text: `主張 ${i}`, type: i % 2 ? 'stance' : 'fact', modality: 'plain', hedged: false, n: 1, firstAt: T0 + i * MIN, lastAt: T0 + i * MIN, episodes: [1], attrs: {} }));
  const split = planBundles({ id: 2, kind: 'person', name: 'ぷ', path: 'people/ぷ', aliases: [], meta: {} }, many);
  equal(split.map((b) => b.path), ['people/ぷ', 'people/ぷ/経緯と出来事', 'people/ぷ/立場と意見'], '主張が多いと種類ごとの子ページ + 概要');
  if (!split[0].links.some((l) => l.includes('[[people/ぷ/立場と意見]]'))) fail('概要は子ページへリンクする');
  // 引用の整理
  const g = new Map([[1, { episodes: [10, 11, 12, 13] }], [2, { episodes: [20] }]]);
  const cleaned = cleanBody('## 見出し\n- 本文 A [c1]\n- 根拠の無い文\n- 入力に無い [c9]\n- 二つの根拠 [c1][c2]\n- 末尾に引用の無い文。[c2]余り', new Set([1, 2]));
  equal(cleaned.dropped, 3, '根拠の無い文・入力に無い引用・引用の後の余りを捨てる');
  if (!cleaned.body.startsWith('## 見出し')) fail('見出しは残す');
  equal([...cleaned.cited].sort(), [1, 2], '引用された主張');
  equal(citeEpisodes('- A [c1][c2]', g), '- A [e10][e11][e13][e20]', '[cN] は根拠の出来事 [eM] に直る (長ければ最初の 2 つと最後)');
  if (!mechanicalLines(groups)[0].includes('[c')) fail('機械の追記も [cN] で書く');
}

const composed = await composeAll(ctx);
if (composed.pages < 4) fail(`ページが組み立つ: ${composed.pages}`);
const pages = memoryDb().prepare('SELECT * FROM v2_pages WHERE guild_id = ?').all(GUILD);
const takoPage = pages.find((p) => p.path === 'people/たこ');
if (!takoPage) fail('たこのページ');
if (/\[c\d+\]/.test(takoPage.body)) fail('[cN] が残らない');
if (!/\[e\d+\]/.test(takoPage.body)) fail('[eN] で出来事を引く');
if (/根拠の無い文|c99999/.test(takoPage.body)) fail('根拠の無い文・入力に無い引用は捨てる');
if (!/※|と述べている/.test(takoPage.body)) fail('hedged の主張は断定しない書き方で渡る');
if (!takoPage.body.startsWith('- 発言 100 件')) fail(`機械が出した事実が先頭: ${takoPage.body.slice(0, 80)}`);
if (!pages.some((p) => /追記/.test(p.body) && /DROPME/.test(p.body))) fail('文に入らなかった主張は機械が追記する');
equal(pages.filter((p) => !p.body.trim()).length, 0, '本文の無いページを作らない');
for (const page of pages) if (page.cited > page.claims) fail('cited <= claims');

// ---- 筋書き・根 ----------------------------------------------------------------

{
  const { composeArcs, composeRoot, planArcs } = await import('../src/memory/v2/arcs.js');
  const arcs = planArcs(GUILD);
  equal(arcs.length, 1, '同じもの (Go vs Rust) をめぐる出来事が 3 日以内に続けば 1 つの筋');
  equal(arcs[0].episodes.length, 2, '筋の出来事');
  const made = await composeArcs(ctx);
  equal(made.pages, 1, '筋書きのページが書かれる');
  const arcPage = memoryDb().prepare("SELECT * FROM v2_pages WHERE source = 'arc'").get();
  if (!arcPage.path.startsWith('events/')) fail(`筋書きは events/ の下: ${arcPage.path}`);
  if (/999999|根拠の無い文/.test(arcPage.body)) fail('入力に無い [eN]・根拠の無い文は捨てる');
  const arcCites = [...arcPage.body.matchAll(/\[e(\d+)\]/g)].map((m) => Number(m[1]));
  equal(new Set(arcCites).size, 2, '文に入らなかった出来事は機械が追記して、全ての出来事を引く');
  await composeRoot(ctx);
  if (!memoryDb().prepare("SELECT body FROM v2_pages WHERE path = ''").get()?.body.includes('[[people/たこ]]')) fail('根のページ');
}

// ---- 投影 ------------------------------------------------------------------

const projected = projectToV1(GUILD, T0 + 1000);
equal(projected.pages, memoryDb().prepare("SELECT COUNT(*) AS c FROM v2_pages WHERE path <> ''").get().c, 'ページ (筋書きを含む) が写る');
const node = getNode(GUILD, 'people/たこ');
if (!node || !node.body.includes('[e')) fail('nodes に本文が写る');
const cited = [...node.body.matchAll(/\[e(\d+)\]/g)].map((m) => Number(m[1]));
for (const id of cited) {
  const episode = getEpisode(GUILD, id);
  if (!episode) fail(`[e${id}] の出来事が開ける`);
  if (!episode.sources.length) fail('出来事は根拠の発言を持つ');
}
equal(JSON.parse(memoryDb().prepare('SELECT highlights FROM episodes WHERE id = ?').get(epA.id).highlights).length, 2, '決め台詞が highlights に写る (まとめた行の 2 発言)');
if (!memoryDb().prepare('SELECT 1 FROM episode_nodes WHERE episode_id = ? AND path = ?').get(epA.id, 'people/たこ')) fail('出来事 → ページの結び目');
if (memoryDb().prepare('SELECT COUNT(*) AS c FROM cursors WHERE guild_id = ?').get(GUILD).c < 2) fail('読み終えた位置を置く');
if (!getNode(GUILD, '')?.body.includes('開発の場')) fail('根の本文が写る');
const arcNode = memoryDb().prepare("SELECT path FROM nodes WHERE path LIKE 'events/%'").get();
if (!arcNode) fail('筋書きのページが nodes に写る');
if (!memoryDb().prepare('SELECT 1 FROM episode_nodes WHERE path = ?').get(arcNode.path)) fail('筋書きのページは出来事とつながる');
{
  const again = projectToV1(GUILD, T0 + 2000);
  equal([again.episodes, again.changedPages, again.changedEpisodes, again.removedPages, again.removedEpisodes], [projected.episodes, 0, 0, 0, 0], '投影は冪等で、変わっていないものには触らない');
  memoryDb().prepare('UPDATE v2_episodes SET title = ? WHERE id = ?').run('題を直した出来事', epA.id);
  memoryDb().prepare("UPDATE v2_pages SET body = body || char(10) || '- 足した行 [e' || ? || ']' WHERE path = 'people/たこ'").run(epA.id);
  const changed = projectToV1(GUILD, T0 + 3000);
  equal([changed.changedPages, changed.changedEpisodes], [1, 1], '変わったページ・出来事だけ書き直す');
  if (!memoryDb().prepare("SELECT 1 FROM episodes_fts WHERE episodes_fts MATCH '題を直した'").get()) fail('書き直した出来事の全文検索が更新される');
  memoryDb().prepare("DELETE FROM v2_pages WHERE path LIKE 'events/%'").run();
  equal(projectToV1(GUILD, T0 + 4000).removedPages, 1, '消えたページは nodes からも消える');
}

if (memoryDb().prepare("SELECT COUNT(*) AS c FROM nodes_fts WHERE nodes_fts MATCH 'Rust'").get().c < 1) fail('全文検索の索引が張られる');

// ---- 保存した出力・止まり方 --------------------------------------------------

{
  const before = calls.compose;
  const again = makeCtx(GUILD, fake);
  await composeAll(again);
  equal(again.counters.calls, calls.compose - before, '呼び出しの数が数えられる');
  // 保存した出力のハッシュを使う実際の呼び出し層は call.ts。ここでは StopRun が先へ進めず止めることだけ確かめる
  memoryDb().prepare("UPDATE v2_sections SET state = 'pending' WHERE channel_id = ?").run(BIG);
  memoryDb().prepare("DELETE FROM v2_sections WHERE parent_id IS NOT NULL").run();
  const stopper = makeCtx(GUILD, async () => { throw new StopRun('予算', 'budget'); });
  let stopped = null;
  try { await runSections(stopper); } catch (error) { stopped = error; }
  if (!(stopped instanceof StopRun)) fail('StopRun は握りつぶさず投げる');
  equal(memoryDb().prepare('SELECT state FROM v2_sections WHERE channel_id = ?').get(BIG).state, 'pending', '止まった区間は進めない');
}
equal(verifyPolicy().wrongAsWeak, false, '既定では wrong は wrong');

// 検証を切る (最低コスト): 抽出だけで done になり、検証は呼ばない。主張は ok のまま使える
{
  v2Config.verifyEnabled = false;
  memoryDb().prepare("UPDATE v2_sections SET state = 'pending' WHERE channel_id = ?").run(BIG);
  memoryDb().prepare('DELETE FROM v2_sections WHERE parent_id IS NOT NULL').run();
  const verifyBefore = calls.verify;
  await runSections(makeCtx(GUILD, fake));
  equal(calls.verify, verifyBefore, '検証を切ると検証の呼び出しをしない');
  const states = memoryDb().prepare('SELECT DISTINCT state FROM v2_sections WHERE channel_id = ?').all(BIG).map((r) => r.state);
  if (states.includes('extracted') || states.includes('pending')) fail(`検証なしでも区間は done まで進む: ${states}`);
  v2Config.verifyEnabled = true;
}

console.log('memory-v2 checks passed');
