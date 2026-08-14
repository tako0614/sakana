// おーぷん2ちゃんねる対話コーパスを evex と同じ行形式に変換する (事前学習の段1 用)。
//
//   node scripts/llm/build-2ch.mjs [出力 corpus-v7/open2ch.txt]
//
// p1atdev/open2ch (Apache-2.0 / 元は 1never/open2ch-dialogue-corpus)。
// **カードに出典を書く義務が付く。**
//
// --- なぜこれを足すのか ---
//
// 段1 に入れている 2 つは register がずれている:
//
//   なりきり掲示板  キャラを演じる長文。中位 99 字で、evex の中位 20 字と離れている
//   JESC 字幕       翻訳調。「あなたは戻ったのね、ハロルド?」のような言い回しが混ざる
//
// これは**素の日本語のネット雑談**で、いちばん Discord に近い:
//
//   1: 実況スレをたてる
//   2: おんｊ民の鑑
//   1: とりあえずワクワクする アウトドアショップからいろいろ拝借して山籠りしてえなあ
//   2: ホームセンターの方が良くね？
//
// 実測 6,192,730 対話 / 13,788,115 発話 / 350,173,438 字。
// なりきり掲示板 (73.6M字) と JESC (58.2M字) を合わせた 2.7 倍ある。
//
// --- 2 発話しかないことへの対処 ---
//
// 85% (5,278,234 件) が 2 発話で終わる。そのまま 1 会話にすると
// **`<|end|>` が 60 字ごとに出る**分布になり、「一往復で会話を終える」形を学ぶ。
// evex の窓は 3600 字なので、これは分布として遠すぎる。
//
// 幸い**行の並びは概ね同じスレッド由来**なので、連続する対話を字数まで詰め直す。
// JESC で場面の切れ目をまたいで詰めたのと同じ手だが、あちらより繋がりは良い。
//
// 役は**対話ごとに次の 2 つへ回す** (`<|a|><|b|>` → `<|c|><|d|>` → ...)。
// ずっと `<|a|><|b|>` を交互にすると 2 人だけの会話に見えるが、詰めた中身は
// 別の人の別のやり取り。回すと 4〜8 人が喋る Discord の窓に形が近くなる。
//
// **話者トークン `<|sN|>` は絶対に出さない。**外部データが教えるのは
// 「会話の交代・話の受け方・日本語」までで、誰が誰かは evex だけが持つ。

import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

process.env.ARCHIVE_DB_PATH = path.join(os.tmpdir(), 'sakana-2ch-scratch.sqlite');
const { ROLE_TOKENS, buildPrompt, messageText } =
  await import('../../src/mimic/serialize.js');

const src = process.env.LLM_2CH_FILE ?? 'external/open2ch/open2ch.jsonl';
const out = process.argv[2] ?? 'corpus-v7/open2ch.txt';

// 窓。なりきり掲示板 (3600字) より短くする — 詰め直している以上、
// 長く取るほど無関係な話題が 1 窓に混ざる
const MAX_CHARS = Number(process.env.LLM_2CH_WINDOW_CHARS ?? 1200);
const MAX_POSTS = Number(process.env.LLM_2CH_WINDOW_POSTS ?? 20);

// 1 発話の上限。なりきり掲示板と同じ扱い
const MAX_POST_CHARS = Number(process.env.LLM_2CH_MAX_POST ?? 600);

// 板ごとの上限 (字)。livejupiter が 253M 字あって、無指定だと段1 の 7 割が
// なんJ になる。**register の幅を残すために板ごとに切る**
const CAPS = {
  livejupiter: Number(process.env.LLM_2CH_CAP_JUPITER ?? 105_000_000),
  news4vip: Number(process.env.LLM_2CH_CAP_VIP ?? 86_000_000),
  newsplus: Number(process.env.LLM_2CH_CAP_PLUS ?? 11_000_000)
};
const DEFAULT_CAP = Number(process.env.LLM_2CH_CAP_OTHER ?? 10_000_000);

// 露骨な表現。`-cleaned` は上流が有害表現を落とした版だが、
// なりきり掲示板と同じ網を掛けておく (条件を揃えておくと後で説明しやすい)
const EXPLICIT = /エッチ|セックス|性器|射精|愛撫|喘ぎ|挿入|勃起|陰茎|陰部|変態プレイ/;

// アンカー (`>>123`) と引用行 (`>そうかな`)。宛先の情報は残らないので落とす。
// evex 側の返信は `<|re|><|sN|>` で表すので、数字が本文に残ると形がぶれる
const ANCHOR = /^\s*(?:&gt;|＞|>)+\s*\d*\s*/;

function cleanPost(body) {
  const text = String(body ?? '')
    .split('\n')
    .map((line) => line.replace(ANCHOR, '').trim())
    .filter(Boolean)
    .join('\n')
    .trim();

  if (!text || text.length < 2) return null;
  if (EXPLICIT.test(text)) return null;
  return text.length > MAX_POST_CHARS ? text.slice(0, MAX_POST_CHARS) : text;
}

await mkdir(path.dirname(out), { recursive: true });
const sink = createWriteStream(out, { encoding: 'utf8' });
const write = (line) => new Promise((resolve) => {
  if (sink.write(`${line}\n`)) resolve();
  else sink.once('drain', resolve);
});

/**
 * `\n` **だけ**で切って 1 行ずつ流す。
 *
 * `readline` を使ってはいけない。U+2028 / U+2029 / U+0085 も行終端として扱うので、
 * それを含む本文で JSON レコードが割れる。build-corpus.mjs / build-external.mjs
 * にある罠と同じ。
 */
async function* lines(file) {
  let rest = '';
  for await (const chunk of createReadStream(file, { encoding: 'utf8' })) {
    const parts = (rest + chunk).split('\n');
    rest = parts.pop();
    yield* parts;
  }
  if (rest) yield rest;
}

const stats = {
  dialogues: 0, posts: 0, dropped_explicit: 0, dropped_empty: 0,
  capped: 0, windows: 0, chars: 0, duplicates: 0,
  by_board: {}
};

// 板ごとに詰める。板をまたいで 1 窓にしない — 板が変われば話題も口調も変わる
const buffers = new Map();
const seen = new Set();

function boardStat(board) {
  if (!stats.by_board[board]) {
    stats.by_board[board] = { dialogues: 0, windows: 0, chars: 0, capped: false };
  }
  return stats.by_board[board];
}

async function flush(board) {
  const buffer = buffers.get(board);
  if (!buffer || buffer.posts.length < 2) { buffers.delete(board); return; }

  const text = `${buildPrompt(buffer.posts)}<|end|>`;
  buffers.delete(board);

  // 同じ 2 発話の対話が何度も出るので、窓ごと重複を落とす
  if (seen.has(text)) { stats.duplicates += 1; return; }
  seen.add(text);

  const stat = boardStat(board);
  stat.windows += 1;
  stat.chars += text.length;
  stats.windows += 1;
  stats.chars += text.length;
  await write(text);
}

for await (const line of lines(src)) {
  if (!line.trim()) continue;

  const row = JSON.parse(line);
  const board = row.board ?? 'unknown';
  const stat = boardStat(board);
  const cap = CAPS[board] ?? DEFAULT_CAP;
  if (stat.chars >= cap) {
    if (!stat.capped) { stat.capped = true; stats.capped += 1; }
    continue;
  }

  stats.dialogues += 1;
  stat.dialogues += 1;

  if (!buffers.has(board)) buffers.set(board, { posts: [], chars: 0, roleAt: 0 });
  const buffer = buffers.get(board);

  // 対話ごとに役を 2 つ進める。話者番号は 1/2 なので、そのまま添え字にする
  const roleOf = (speaker) =>
    ROLE_TOKENS[(buffer.roleAt + (speaker === 2 ? 1 : 0)) % ROLE_TOKENS.length];

  let added = 0;
  for (const post of row.posts ?? []) {
    stats.posts += 1;
    const raw = String(post.content ?? '');
    if (EXPLICIT.test(raw)) { stats.dropped_explicit += 1; continue; }

    const body = cleanPost(raw);
    if (!body) { stats.dropped_empty += 1; continue; }

    const content = messageText(body);
    buffer.posts.push({ token: roleOf(post.speaker), content });
    buffer.chars += content.length;
    added += 1;
  }

  if (added) buffer.roleAt = (buffer.roleAt + 2) % ROLE_TOKENS.length;
  if (buffer.chars >= MAX_CHARS || buffer.posts.length >= MAX_POSTS) await flush(board);
}

for (const board of [...buffers.keys()]) await flush(board);
await new Promise((resolve) => sink.end(resolve));

const fmt = (n) => n.toLocaleString();
console.log(`対話           ${fmt(stats.dialogues)} / 発話 ${fmt(stats.posts)}`);
console.log(`  露骨を除外   ${fmt(stats.dropped_explicit)}`);
console.log(`  空を除外     ${fmt(stats.dropped_empty)} (アンカーだけ / 短い)`);
console.log(`窓             ${fmt(stats.windows)} (最大 ${MAX_CHARS} 字 / ${MAX_POSTS} 発話) `
  + `/ ${fmt(stats.chars)} 字  重複 ${fmt(stats.duplicates)} 件は落とした`);
for (const [board, s] of Object.entries(stats.by_board)) {
  console.log(`  ${board.padEnd(12)} ${fmt(s.windows).padStart(8)} 窓 / `
    + `${fmt(s.chars).padStart(11)} 字${s.capped ? '  (上限に達して打ち切り)' : ''}`);
}
console.log(`\n出力 ${out}`);
console.log('Apache-2.0 — **モデルカードに 1never/open2ch-dialogue-corpus の出典を書くこと**');
