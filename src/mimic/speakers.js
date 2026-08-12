// 「その人として喋らせる」ための材料。
//
// evex-1 は上位48人に固有の話者トークン (<|s0|>..<|s47|>) を持っている。あれが
// 「にゃい」を再現できた理由で、94万件からその人の全履歴を圧縮した結果が重みに入っている。
// ただし推論サーバーは全員を <|other|> に潰して申告していたので、48人ぶんが丸ごと
// 遊んでいた。ここでその表を引けるようにする。
//
// 48人の外の人と、話者を持たない世代 (evex-ft-1 は相対の役なので個人に紐づかない)
// には、本人の実発言をプロンプトに例として並べる手を使う。深さは重みに焼き付いた
// ものに負けるが、対象が全員になるうえ直近の口癖が乗る。
//
// 対応表 (userId → トークン) は**手元と bot サーバーにだけ置く**。HF に上げた
// speakers.json は rank と件数だけで、ID も名前も入っていない。そこは変えない。

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { db } from '../db.js';
import { db as archive } from '../archive/db.js';

// evex-1 の tokenizer と対のもの。
//
// mimic/ を先に見る — pack.mjs がデプロイ用に ckpt / tok.model / speakers.json を
// まとめて置く場所で、bot サーバーにはこれしか無い (corpus/ も corpus-v1/ も
// 追跡していないので、あちらには存在しない)。
// corpus-v1 を corpus より先に見るのは、corpus/ を v2 で上書きして evex-1 を
// 孤児にした経験があるから。
const CANDIDATES = [
  process.env.MIMIC_SPEAKERS,
  'mimic/speakers.json',
  'corpus-v1/speakers.json',
  'corpus/speakers.json'
].filter(Boolean);

function load() {
  for (const file of CANDIDATES) {
    try {
      const rows = JSON.parse(readFileSync(path.resolve(file), 'utf8'));
      if (Array.isArray(rows) && rows.length) return rows;
    } catch {
      // 次の候補へ。無くても本人の実発言を使う経路は動く
    }
  }
  return [];
}

const rows = load();

/** userId → { token, name, count }。上位48人だけ入っている。 */
const byUser = new Map(
  rows
    .filter((row) => row.userId && row.token)
    .map((row) => [String(row.userId), { token: row.token, name: row.name ?? '', count: row.count ?? 0 }])
);

// --- 本人の意思で外れられるようにする ---
//
// 実在の48人の口調を誰でも呼び出せる状態にするので、「自分は対象外にしてほしい」と
// 言われたときに応じられる仕組みが無いと角が立つ。表を1つ持つだけで済む。

db.exec(`
  CREATE TABLE IF NOT EXISTS mimic_optout (
    user_id    TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL
  );
`);

const optOutStmt = db.prepare('INSERT OR IGNORE INTO mimic_optout (user_id, created_at) VALUES (?, ?)');
const optInStmt = db.prepare('DELETE FROM mimic_optout WHERE user_id = ?');
const isOutStmt = db.prepare('SELECT 1 FROM mimic_optout WHERE user_id = ?');

export function optOut(userId) {
  optOutStmt.run(String(userId), Date.now());
}

export function optIn(userId) {
  return optInStmt.run(String(userId)).changes > 0;
}

export function hasOptedOut(userId) {
  return Boolean(isOutStmt.get(String(userId)));
}

/**
 * その人の話者トークン。上位48人の外、抜けている人、表が無いときは null。
 * null なら実発言を例に出す経路に回す。
 */
export function tokenFor(userId) {
  if (hasOptedOut(userId)) return null;
  return byUser.get(String(userId))?.token ?? null;
}

/** 学習で固有トークンを持っている人の一覧。/mimic の autocomplete に出す。 */
export function learnedSpeakers() {
  return [...byUser.entries()]
    .filter(([userId]) => !hasOptedOut(userId))
    .map(([userId, info]) => ({ userId, ...info }))
    .sort((a, b) => b.count - a.count);
}

// --- 実発言を引く ---

// 例は「その人の連続した独り言」ではなく、実際のやり取りの形で見せたい。
// 学習データは会話の流れなので、単発を並べただけだと分布から外れる。
// ただ会話ごと引くと重いので、まず本人の発言を取ってから前後を足す形にする。
const selectOwn = archive.prepare(`
  SELECT message_id, channel_id, content, extra, created_at
    FROM messages
   WHERE author_id = @author_id
     AND deleted = 0
     AND is_bot = 0
     AND LENGTH(content) >= @min_chars
   ORDER BY created_at DESC
   LIMIT @limit
`);

const selectBefore = archive.prepare(`
  SELECT author_id, author_name, content, extra, created_at
    FROM messages
   WHERE channel_id = @channel_id
     AND created_at < @created_at
     AND deleted = 0
     AND is_bot = 0
     AND content <> ''
   ORDER BY created_at DESC
   LIMIT 1
`);

/**
 * 例に使う発言を取る。長すぎ・短すぎを外して、直近から拾う。
 *
 * 4文字未満は「草」「w」で口調の情報が無く、200文字超は1件で例が埋まる。
 * 直近を優先するのは、今の口癖と今の話題が乗る方が似て見えるから。
 */
export function exampleTurns(userId, { limit = 8, minChars = 4, maxChars = 200 } = {}) {
  if (hasOptedOut(userId)) return [];

  let own = [];
  try {
    own = selectOwn.all({ author_id: String(userId), min_chars: minChars, limit: limit * 3 });
  } catch (error) {
    console.error('mimic: 実発言の取得に失敗:', error.message);
    return [];
  }

  const turns = [];
  for (const row of own) {
    const text = (row.content || row.extra || '').trim();
    if (!text || text.length > maxChars) continue;

    // 直前の発言があれば相手役として添える。やり取りの形にすると
    // 「話しかけられて答える」という学習時の形に近づく
    let prior = null;
    try {
      prior = selectBefore.get({ channel_id: row.channel_id, created_at: row.created_at });
    } catch {
      prior = null;
    }

    const priorText = (prior?.content || prior?.extra || '').trim();
    turns.push({
      at: row.created_at,
      prompt: priorText && priorText.length <= maxChars && prior.author_id !== String(userId)
        ? priorText
        : null,
      reply: text
    });

    if (turns.length >= limit) break;
  }

  // 古い順に戻す。会話は時間順に読ませる
  return turns.reverse();
}

/** 表が読めているか。/mimic の説明に出す。 */
export const speakerTableSize = byUser.size;
