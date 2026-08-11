// 会話のまとまり (チャンク) を作る。ベクトル化の単位。
//
// なぜ1発言ずつではないか。Discord では主張が1発言に収まらない:
//
//   たこ: いや待って
//   たこ: レビュー無しで通すのはまずいって
//   さば: 急ぎなんだよ
//   たこ: 急ぎでも履歴に残らんのが問題
//
// 個別に埋めると意味を持つのは2行目だけで、残りは雑音になる。しかも
// SEMANTIC_MIN_CHARS=10 の規則で短い発言を捨てていたため、実測で合成会話の
// 38発言のうち20件 (53%) が意味検索から丸ごと消えていた。立場の変化は
// まさにこういう短文に出るので、これは検索の穴として大きい。
//
// 実測しておいた注意点: まとめてもコサインのノイズ床 (無関係な文どうしで 0.78 前後)
// は下がらない。効くのは「言い換え側のマージンが広がる」「候補が約5分の1になって
// 相対カットオフが効く」「返るのが読めるやり取りになる」の3つ。
// つまり閾値では相変わらず絞れないので、順位で見る前提は変えない。

import { embedConfig } from '../embed/config.js';
import { db } from './db.js';
import { normalizeForEmbedding } from './vectors.js';

const ELIGIBLE_SQL = `
  m.deleted = 0
  AND m.content <> ''
  AND (@include_bots = 1 OR m.is_bot = 0)
`;

function eligibleParams() {
  return { include_bots: embedConfig.includeBots ? 1 : 0 };
}

// channels 表から取る。messages の DISTINCT は 224ms かかる (実測) うえ、
// 取り込み済みチャンネルの一覧はこちらが正しい持ち主。
const selectChannels = db.prepare('SELECT channel_id FROM channels WHERE guild_id = ?');
const selectChannelsFromMessages = db.prepare('SELECT DISTINCT channel_id FROM messages WHERE guild_id = ?');

const selectLastChunk = db.prepare(`
  SELECT chunk_id, from_ms FROM message_chunks
  WHERE channel_id = ? ORDER BY from_ms DESC LIMIT 1
`);

const deleteChunk = db.prepare('DELETE FROM message_chunks WHERE chunk_id = ?');

const insertChunk = db.prepare(`
  INSERT INTO message_chunks
    (guild_id, channel_id, from_ms, to_ms, from_id, to_id, msg_count, text_len, built_at)
  VALUES (@guild_id, @channel_id, @from_ms, @to_ms, @from_id, @to_id, @msg_count, @text_len, @built_at)
`);

const insertChunkAuthor = db.prepare(
  'INSERT OR IGNORE INTO chunk_authors (chunk_id, author_id) VALUES (?, ?)'
);

/** そのまとまりに入る発言。描画にも埋め込みにも同じ範囲を使う。 */
export function chunkMessages(chunk) {
  return db.prepare(`
    SELECT m.* FROM messages m
    WHERE m.channel_id = @channel_id AND m.created_at BETWEEN @from_ms AND @to_ms AND ${ELIGIBLE_SQL}
    ORDER BY m.created_at
  `).all({ ...eligibleParams(), channel_id: chunk.channel_id, from_ms: chunk.from_ms, to_ms: chunk.to_ms });
}

/**
 * 埋め込む文。話者を残す。
 * 「誰がどちら側か」が入っていないと、対立している2つの主張が1つの
 * ベクトルに混ざったときに区別が付かなくなる。
 */
export function chunkText(rows) {
  const lines = [];

  for (const row of rows) {
    const body = normalizeForEmbedding(row.content);
    if (!body) continue;
    lines.push(`${row.author_name || 'unknown'}: ${body}`);
  }

  const text = lines.join('\n');
  const chars = Array.from(text);
  return chars.length <= embedConfig.maxChars ? text : chars.slice(0, embedConfig.maxChars).join('');
}

/**
 * 発言列を境界で切る。純粋な関数にしてあるのでテストできる。
 * 切る条件は3つ: 無言が続いた / 発言数の上限 / 文字数の上限。
 */
export function splitIntoChunks(rows, {
  gapMs = embedConfig.chunkGapMs,
  maxMessages = embedConfig.chunkMaxMessages,
  maxChars = embedConfig.chunkMaxChars
} = {}) {
  const chunks = [];
  let current = [];
  let chars = 0;

  const flush = () => {
    if (current.length > 0) chunks.push(current);
    current = [];
    chars = 0;
  };

  for (const row of rows) {
    const previous = current[current.length - 1];
    const gap = previous ? row.created_at - previous.created_at : 0;

    if (previous && (gap > gapMs || current.length >= maxMessages || chars >= maxChars)) {
      flush();
    }

    current.push(row);
    chars += (row.char_count ?? Array.from(row.content ?? '').length) + 2;
  }

  flush();
  return chunks;
}

const saveChunk = db.transaction((guildId, rows) => {
  const text = chunkText(rows);
  const first = rows[0];
  const last = rows[rows.length - 1];

  const { lastInsertRowid } = insertChunk.run({
    guild_id: guildId,
    channel_id: first.channel_id,
    from_ms: first.created_at,
    to_ms: last.created_at,
    from_id: first.message_id,
    to_id: last.message_id,
    msg_count: rows.length,
    // 0 は「対象外として飛ばした」印。印を残さないと毎回引き直す
    text_len: Array.from(text).length >= embedConfig.minChars ? Array.from(text).length : 0,
    built_at: Date.now()
  });

  const chunkId = Number(lastInsertRowid);
  for (const author of new Set(rows.map((row) => row.author_id))) {
    insertChunkAuthor.run(chunkId, author);
  }

  return chunkId;
});

const countAfter = db.prepare(`
  SELECT COUNT(*) AS count FROM messages m
  WHERE m.channel_id = @channel_id AND m.created_at > @since AND ${ELIGIBLE_SQL}
`);


// (created_at, rowid) の行値で進める。created_at だけだと同一ミリ秒の発言で
// 取りこぼしか重複が出るし、rowid だけだと backfill の挿入順が時系列と逆なので使えない。
const selectPage = db.prepare(`
  SELECT m.*, m.rowid AS rid FROM messages m
  WHERE m.channel_id = @channel_id
    AND (m.created_at, m.rowid) > (@since_ms, @since_rid)
    AND ${ELIGIBLE_SQL}
  ORDER BY m.created_at, m.rowid
  LIMIT @limit
`);

// イベントループに順番を返す。better-sqlite3 は同期なので、これを挟まないと
// Discord への送信が全部タイムアウトする (実際に28秒ブロックして、その間
// deferReply も thinking もリアクション処理も AbortError になった)。
const yieldToLoop = () => new Promise((resolve) => setImmediate(resolve));

// 譲る間隔は件数ではなく経過時間で決める。ページ単位 (5000件) で譲る作りにしたら
// 粗すぎて28秒止まった。1チャンクの重さはチャンネルの喋り方でまるで違うので、
// 件数で見積もると必ず外れる。
const SLICE_MS = 40;

/**
 * 「同期で走り続けてよい時間」を測るタイマー。
 * done() が true を返したら譲る。
 */
function slicer(ms = SLICE_MS) {
  let until = Date.now() + ms;
  return {
    expired: () => Date.now() >= until,
    reset: () => { until = Date.now() + ms; }
  };
}

/**
 * 1チャンネルぶんのまとまりを作る。末尾に追記していくだけ。
 *
 * 末尾のまとまりは作り直す。前回は「そこで発言が尽きた」だけで切れている
 * 可能性があり、続きが来たら同じまとまりに入るべきものを別扱いしてしまう。
 * ただし新しい発言が1件も無いなら触らない — 作り直すとベクトルも捨てることに
 * なり、静かなチャンネルでも毎晩1件ずつ埋め直す羽目になる。
 */
export async function buildChannelChunks(guildId, channelId, { isCancelled = () => false } = {}) {
  const last = selectLastChunk.get(channelId);

  if (last) {
    const fresh = countAfter.get({ ...eligibleParams(), channel_id: channelId, since: last.to_ms }).count;
    if (fresh === 0) return 0;
  }

  const slice = slicer();
  let sinceMs = last ? last.from_ms - 1 : -1;
  let sinceRid = 0;
  // ページの境目でまとまりが切れないよう、最後の組は次のページに持ち越す
  let carry = [];
  let built = 0;

  if (last) deleteChunk.run(last.chunk_id);

  for (;;) {
    if (isCancelled()) break;

    const rows = selectPage.all({
      ...eligibleParams(),
      channel_id: channelId,
      since_ms: sinceMs,
      since_rid: sinceRid,
      limit: embedConfig.chunkPage
    });

    if (rows.length === 0) break;

    const groups = splitIntoChunks([...carry, ...rows]);
    const done = rows.length < embedConfig.chunkPage;

    // 最後まで読んだときだけ最後の組も確定させる
    carry = done ? [] : (groups.pop() ?? []);

    for (const group of groups) {
      saveChunk(guildId, group);
      built += 1;

      // 1ページぶんの保存だけで数百トランザクションになる。ここでも譲る。
      if (slice.expired()) {
        await yieldToLoop();
        slice.reset();
      }
    }

    const tail = rows[rows.length - 1];
    sinceMs = tail.created_at;
    sinceRid = tail.rid;

    if (done) break;
    await yieldToLoop();
  }

  if (carry.length > 0) {
    saveChunk(guildId, carry);
    built += 1;
  }

  return built;
}

/** ギルド全体。取り込み済みチャンネルを順に回す。 */
export async function buildGuildChunks(guildId, { onProgress = () => {}, isCancelled = () => false } = {}) {
  const known = selectChannels.all(guildId).map((row) => row.channel_id);
  // channels 表が無い構成でも動くようにする (取り込み前など)
  const channels = known.length > 0
    ? known
    : selectChannelsFromMessages.all(guildId).map((row) => row.channel_id);
  let built = 0;

  for (const [index, channelId] of channels.entries()) {
    if (isCancelled()) break;

    built += await buildChannelChunks(guildId, channelId, { isCancelled });
    onProgress({ channelsDone: index + 1, channelsTotal: channels.length, built });
    await yieldToLoop();
  }

  return { built, channels: channels.length };
}

/**
 * 本文が変わったまとまりを拾う。
 *
 * 編集はトリガでは拾えない (範囲の判定ができない)。まとまりを作った時刻より
 * 後に編集された発言を含むものだけ選んで作り直す。
 */
export function staleChunks(guildId, limit = 500) {
  return db.prepare(`
    SELECT c.chunk_id, c.channel_id FROM message_chunks c
    WHERE c.guild_id = ? AND EXISTS (
      SELECT 1 FROM messages m
      WHERE m.channel_id = c.channel_id
        AND m.created_at BETWEEN c.from_ms AND c.to_ms
        AND (m.edited_at > c.built_at OR (m.deleted = 1 AND m.created_at > 0))
    )
    LIMIT ?
  `).all(guildId, limit);
}

const refreshChunk = db.prepare(`
  UPDATE message_chunks SET msg_count = @msg_count, text_len = @text_len, built_at = @built_at
  WHERE chunk_id = @chunk_id
`);
const dropChunkVector = db.prepare('DELETE FROM chunk_vectors WHERE chunk_id = ?');

/**
 * 本文が変わったまとまりを埋め直す。
 *
 * まとまりを作り直さずベクトルだけ捨てるのが要点。編集は created_at を変えないので
 * 境界は動かず、同じ範囲を埋め直せば足りる。作り直す実装にすると、履歴の途中の
 * 1件が編集されただけで、そのチャンネルの後ろ全部のベクトルを捨てることになる
 * (実際にそれで4つあったまとまりが3つに減るバグを踏んだ)。
 */
export const refreshStale = db.transaction((guildId, limit = 500) => {
  const rows = staleChunks(guildId, limit);
  const now = Date.now();

  for (const row of rows) {
    const chunk = db.prepare('SELECT * FROM message_chunks WHERE chunk_id = ?').get(row.chunk_id);
    if (!chunk) continue;

    const messages = chunkMessages(chunk);

    // 中身が全部消えたなら、まとまり自体を捨てる (トリガがベクトルも消す)
    if (messages.length === 0) {
      deleteChunk.run(chunk.chunk_id);
      continue;
    }

    const text = chunkText(messages);
    refreshChunk.run({
      chunk_id: chunk.chunk_id,
      msg_count: messages.length,
      text_len: Array.from(text).length >= embedConfig.minChars ? Array.from(text).length : 0,
      built_at: now
    });

    // ベクトルを捨てれば nextChunkBatch が拾い直す
    dropChunkVector.run(chunk.chunk_id);
  }

  return { stale: rows.length };
});

/**
 * このギルドの最後のまとまりの ID。
 * カーソルが実在しない値まで進んでいないかを確かめるのに使う。
 */
export function maxChunkIdFor(guildId) {
  return db.prepare('SELECT COALESCE(MAX(chunk_id), 0) AS id FROM message_chunks WHERE guild_id = ?')
    .get(guildId).id;
}

/** 次に埋め込むまとまり。cursor は chunk_id (AUTOINCREMENT なので単調)。 */
export function nextChunkBatch({ guildId, modelId, cursor = 0, limit = 32 }) {
  return db.prepare(`
    SELECT c.chunk_id, c.channel_id, c.from_ms, c.to_ms
    FROM message_chunks c
    WHERE c.guild_id = @guild_id AND c.chunk_id > @cursor AND c.text_len > 0
      AND NOT EXISTS (
        SELECT 1 FROM chunk_vectors v WHERE v.chunk_id = c.chunk_id AND v.model_id = @model_id
      )
    ORDER BY c.chunk_id LIMIT @limit
  `).all({ guild_id: guildId, model_id: modelId, cursor, limit });
}

const insertChunkVector = db.prepare(`
  INSERT OR REPLACE INTO chunk_vectors (chunk_id, model_id, scale, vec, created_at)
  VALUES (?, ?, ?, ?, ?)
`);

export const saveChunkVectors = db.transaction((rows) => {
  const now = Date.now();
  for (const row of rows) {
    insertChunkVector.run(row.chunkId, row.modelId, row.scale, row.vec, now);
  }
  return rows.length;
});

export function chunkCoverage(guildId, modelId) {
  const total = db.prepare(
    'SELECT COUNT(*) AS count FROM message_chunks WHERE guild_id = ? AND text_len > 0'
  ).get(guildId).count;

  const done = db.prepare(`
    SELECT COUNT(*) AS count FROM message_chunks c
    JOIN chunk_vectors v ON v.chunk_id = c.chunk_id
    WHERE c.guild_id = ? AND v.model_id = ? AND c.text_len > 0
  `).get(guildId, modelId).count;

  const messages = db.prepare(
    'SELECT COALESCE(SUM(msg_count), 0) AS count FROM message_chunks WHERE guild_id = ? AND text_len > 0'
  ).get(guildId).count;

  return { total, done, messages, ratio: total > 0 ? done / total : 0 };
}

export function clearGuildChunks(guildId) {
  db.prepare('DELETE FROM message_chunks WHERE guild_id = ?').run(guildId);
}
