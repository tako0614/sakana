// 公開の会話データを evex と同じ行形式に変換する (事前学習の段1 用)。
//
//   node scripts/llm/build-external.mjs [出力 corpus-v5/external.txt]
//
// **話者トークン `<|sN|>` は絶対に出さない。**外部データが教えるのは
// 「会話の交代・話の受け方・日本語」までで、**誰が誰かは evex だけが持つ**。
// ここを破ると `<|s0|>` がなりきり掲示板の口調を覚える。最後にアサートで止める。
//
// --- 何を入れるか ---
//
// OmniAICreator/Japanese-Roleplay-Dialogues (Apache-2.0)
//   なりきりチャット掲示板。1行1スレッドで posts[{poster, post_content}]。
//   **evex と構造が同じ**なので変換がほぼ 1 対 1。実測 4,324 スレッド /
//   606,492 投稿 / 本文 94,546,322 字。Filtered 版は 1 スレッド 2 人に揃っている。
//
// --- ト書き (`（微笑み`) を落とす理由 ---
//
// 本文の **74%** がト書きだが、行単位で落としても**空になる投稿は 1.4% だけ**で、
// 残るのは素の口語になる:
//
//   元: はいっ！（作り始め / そうですよ♪（微笑み / よしっ！紗那もっ（卵を焼き
//   残: はいっ！ / そうですよ♪ / よしっ！紗那もっ
//
// 目的は「会話能力の土台」で出力先は Discord なので、ト書きに事前学習の
// 予算を 74% 払う意味が無い。残すと evex が `（ニコッと微笑み` を書き始める。
// LLM_RP_STAGE=keep で残せる (量は 94.5M → 24.5M 字に減る)。
//
// **閉じ括弧が無い**ことに注意。`はいっ！（作り始め` で行末まで続く形なので、
// 行をまたぐ正規表現で消すと後続のセリフごと消える (最初これで 82% 消していた)。

import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

process.env.ARCHIVE_DB_PATH = path.join(os.tmpdir(), 'sakana-external-scratch.sqlite');
const { splitIntoChunks } = await import('../../src/archive/chunks.js');
const { ROLE_TOKENS, ROLE_OVERFLOW, assignRoles, buildPrompt, messageText } =
  await import('../../src/mimic/serialize.js');

const src = process.env.LLM_EXTERNAL_DIR ?? 'external';
const out = process.argv[2] ?? 'corpus-v5/external.txt';

// 窓は evex 側と同じ値。なりきりは 1 スレッド 140 投稿あるので必ず切る
const CHUNK = {
  gapMs: Number(process.env.LLM_CHUNK_GAP_MS ?? 60 * 60 * 1000),
  maxMessages: Number(process.env.LLM_CHUNK_MAX_MESSAGES ?? 60),
  maxChars: Number(process.env.LLM_CHUNK_MAX_CHARS ?? 3600)
};

const KEEP_STAGE = (process.env.LLM_RP_STAGE ?? 'drop') === 'keep';

// 行末までのト書き。閉じ括弧があればそこまで。**行はまたがない**
const STAGE = /[(（][^)）\n]*[)）]?/g;
// 中の人の連絡 (`(/参加ありがとうございます`)。会話ではないので落とす
const OOC = /^[(（]\s*\//;

// 露骨な表現。標本 127万字では ほぼ皆無 (エッチ3 / 裸8 / 脱が1 / 喘1) だが、
// 606,492 投稿には尾がある。投稿ごと落とす
const EXPLICIT = /エッチ|セックス|性器|射精|愛撫|喘ぎ|挿入|勃起|陰茎|陰部|変態プレイ/;

// 1 投稿が長すぎるもの。evex は中位 20 字で、なりきりは中位 99 字。
// 25,369 字の投稿まであるので上限を切る (窓ひとつを 1 投稿で埋めてしまう)
const MAX_POST_CHARS = Number(process.env.LLM_RP_MAX_POST ?? 600);

function cleanPost(body) {
  const text = String(body ?? '').trim();
  if (!text || OOC.test(text)) return null;
  if (EXPLICIT.test(text)) return null;

  const kept = KEEP_STAGE
    ? text
    : text.split('\n').map((line) => line.replace(STAGE, '').trim()).filter(Boolean).join('\n');

  if (!kept) return null;
  return kept.length > MAX_POST_CHARS ? kept.slice(0, MAX_POST_CHARS) : kept;
}

await mkdir(path.dirname(out), { recursive: true });
const sink = createWriteStream(out, { encoding: 'utf8' });
const write = (line) => new Promise((resolve) => {
  if (sink.write(`${line}\n`)) resolve();
  else sink.once('drain', resolve);
});

const stats = {
  threads: 0, skipped_threads: 0, posts: 0, dropped_ooc: 0, dropped_explicit: 0,
  dropped_empty: 0, truncated: 0, conversations: 0, chars: 0
};

// **どのファイルを読むか。**Filtered (317MB) と Original (616MB) がある。
//
// Filtered は構造条件で絞った版で、落としているのは
//   - 話者が 1 人以下 / 投稿が 10 件以下
//   - 上位2人が全体の 90% 未満 / 一方が 60% を超える
//   - 上位2人以外の投稿
// つまり「きれいな 1 対 1 のなりきり」だけを残している。
//
// **Original を自分で緩く絞れば約2倍取れる。**同じデータセット・同じ Apache-2.0
// なのでライセンスの追加リスクは無い。段1 は会話の土台を作るのが目的なので、
// 3人以上の会話も 短いスレッドも材料として使える。
const SOURCES = (process.env.LLM_RP_FILES
  ?? 'Japanese-Roleplay-Dialogues-Filtered.jsonl').split(',').map((s) => s.trim());

// Original を読むときの最低条件。Filtered の 10 件より緩くする
const MIN_POSTS = Number(process.env.LLM_RP_MIN_POSTS ?? 4);
const MIN_POSTERS = Number(process.env.LLM_RP_MIN_POSTERS ?? 2);

/**
 * `\n` **だけ**で切って 1 行ずつ流す。
 *
 * `readline` を使ってはいけない。U+2028 / U+2029 / U+0085 も行終端として扱うので、
 * それを含む本文で JSON レコードが割れる (この 317MB では 1 万件目あたりで
 * `Unterminated string in JSON` になった)。build-corpus.mjs にある罠と同じ。
 * 317MB を丸ごと読むとメモリが厳しいので、こちらは流しながら切る。
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

const seenThreads = new Set();

for (const file of SOURCES) {
for await (const line of lines(path.join(src, file))) {
  if (!line.trim()) continue;

  const thread = JSON.parse(line);

  // Filtered と Original は**同じスレッドを含む**ので、id で重複を落とす
  if (thread.id != null) {
    if (seenThreads.has(thread.id)) { stats.skipped_threads += 1; continue; }
    seenThreads.add(thread.id);
  }

  // Original は絞っていないので、ここで最低条件を掛ける。
  // 会話の交代を教えるのが目的なので「2人以上・4投稿以上」で足りる
  const posts = thread.posts ?? [];
  const posters = new Set(posts.map((x) => x.poster));
  if (posts.length < MIN_POSTS || posters.size < MIN_POSTERS) {
    stats.skipped_threads += 1;
    continue;
  }

  stats.threads += 1;
  const rows = [];
  for (const post of posts) {
    stats.posts += 1;
    const raw = String(post.post_content ?? '').trim();
    if (OOC.test(raw)) { stats.dropped_ooc += 1; continue; }
    if (EXPLICIT.test(raw)) { stats.dropped_explicit += 1; continue; }

    const body = cleanPost(raw);
    if (!body) { stats.dropped_empty += 1; continue; }
    if (body.length < raw.length && raw.length > MAX_POST_CHARS) stats.truncated += 1;

    const content = messageText(body);
    rows.push({
      author: post.poster,
      // 投稿番号を分に見立てる。なりきりに時刻は無いので、沈黙で切れないようにして
      // 件数と字数だけで窓を決めさせる
      created_at: rows.length * 60_000,
      content,
      char_count: content.length
    });
  }

  for (const chunk of splitIntoChunks(rows, CHUNK)) {
    if (chunk.length < 2) continue;                  // 1 投稿だけでは交代を教えない
    // **役だけを配る。**名前も固有トークンも与えない
    const roles = assignRoles(chunk.map((row) => row.author));
    const turns = chunk.map((row) => ({ token: roles.get(row.author), content: row.content }));
    const text = `${buildPrompt(turns)}<|end|>`;
    stats.conversations += 1;
    stats.chars += text.length;
    await write(text);
  }
}
}

await new Promise((resolve) => sink.end(resolve));

const fmt = (n) => n.toLocaleString();
console.log(`読んだ file     ${SOURCES.join(', ')}`);
console.log(`スレッド        ${fmt(stats.threads)} (重複や条件外で飛ばした ${fmt(stats.skipped_threads)})`);
console.log(`投稿            ${fmt(stats.posts)}`);
console.log(`  OOC を除外    ${fmt(stats.dropped_ooc)}`);
console.log(`  露骨を除外    ${fmt(stats.dropped_explicit)}`);
console.log(`  空を除外      ${fmt(stats.dropped_empty)}`);
console.log(`  長すぎて切った ${fmt(stats.truncated)} (${MAX_POST_CHARS} 字)`);
console.log(`ト書き          ${KEEP_STAGE ? '残した' : '落とした'} (LLM_RP_STAGE)`);
console.log(`会話            ${fmt(stats.conversations)} / ${fmt(stats.chars)} 字`);
console.log(`\n出力 ${out}`);
