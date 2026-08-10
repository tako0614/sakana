import Database from 'better-sqlite3';

// メッセージアーカイブは XP 用の database.sqlite とは別ファイルに置く。
// 巨大になりやすく、作り直し (再インデックス) も独立してできるようにするため。
const dbPath = process.env.ARCHIVE_DB_PATH ?? 'archive.sqlite';

export const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS messages (
    message_id TEXT PRIMARY KEY,
    guild_id TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    parent_id TEXT,
    author_id TEXT NOT NULL,
    author_name TEXT NOT NULL DEFAULT '',
    is_bot INTEGER NOT NULL DEFAULT 0,
    content TEXT NOT NULL DEFAULT '',
    extra TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    edited_at INTEGER,
    reply_to TEXT,
    attachment_count INTEGER NOT NULL DEFAULT 0,
    attachment_kinds TEXT NOT NULL DEFAULT '',
    embed_count INTEGER NOT NULL DEFAULT 0,
    sticker_count INTEGER NOT NULL DEFAULT 0,
    link_count INTEGER NOT NULL DEFAULT 0,
    reaction_count INTEGER NOT NULL DEFAULT 0,
    char_count INTEGER NOT NULL DEFAULT 0,
    pinned INTEGER NOT NULL DEFAULT 0,
    deleted INTEGER NOT NULL DEFAULT 0
  );

  CREATE INDEX IF NOT EXISTS idx_msg_guild_time ON messages(guild_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_msg_channel_time ON messages(channel_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_msg_author_time ON messages(guild_id, author_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_msg_reply ON messages(reply_to);
  CREATE INDEX IF NOT EXISTS idx_msg_reaction ON messages(guild_id, reaction_count);

  CREATE TABLE IF NOT EXISTS message_mentions (
    message_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    PRIMARY KEY (message_id, user_id)
  );
  CREATE INDEX IF NOT EXISTS idx_mention_user ON message_mentions(user_id);

  CREATE TABLE IF NOT EXISTS message_reactions (
    message_id TEXT NOT NULL,
    emoji TEXT NOT NULL,
    count INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (message_id, emoji)
  );
  CREATE INDEX IF NOT EXISTS idx_reaction_emoji ON message_reactions(emoji);

  CREATE TABLE IF NOT EXISTS message_links (
    message_id TEXT NOT NULL,
    url TEXT NOT NULL,
    domain TEXT NOT NULL,
    PRIMARY KEY (message_id, url)
  );
  CREATE INDEX IF NOT EXISTS idx_link_domain ON message_links(domain);

  CREATE TABLE IF NOT EXISTS channels (
    channel_id TEXT PRIMARY KEY,
    guild_id TEXT NOT NULL,
    parent_id TEXT,
    name TEXT NOT NULL DEFAULT '',
    type INTEGER,
    is_thread INTEGER NOT NULL DEFAULT 0,
    is_private INTEGER NOT NULL DEFAULT 0,
    oldest_id TEXT,
    newest_id TEXT,
    complete INTEGER NOT NULL DEFAULT 0,
    message_count INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    updated_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_channel_guild ON channels(guild_id);

  CREATE TABLE IF NOT EXISTS guild_index_state (
    guild_id TEXT PRIMARY KEY,
    status TEXT NOT NULL DEFAULT 'idle',
    mode TEXT,
    started_at INTEGER,
    finished_at INTEGER,
    channels_total INTEGER NOT NULL DEFAULT 0,
    channels_done INTEGER NOT NULL DEFAULT 0,
    messages_indexed INTEGER NOT NULL DEFAULT 0,
    current_channel TEXT,
    last_error TEXT
  );
`);

// 全文検索は trigram トークナイザで作る。
// unicode61 だと日本語が単語分割されず「会議」のような部分一致が引けないため。
// external content 方式にして本文の二重保存を避ける。
db.exec(`
  CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
    content,
    extra,
    content='messages',
    content_rowid='rowid',
    tokenize='trigram'
  );

  CREATE TRIGGER IF NOT EXISTS messages_fts_ai AFTER INSERT ON messages BEGIN
    INSERT INTO messages_fts(rowid, content, extra) VALUES (new.rowid, new.content, new.extra);
  END;

  CREATE TRIGGER IF NOT EXISTS messages_fts_ad AFTER DELETE ON messages BEGIN
    INSERT INTO messages_fts(messages_fts, rowid, content, extra) VALUES ('delete', old.rowid, old.content, old.extra);
  END;

  -- 本文が変わったときだけ張り直す。リアクション数や削除フラグの更新で
  -- FTS を作り直すと、リアクションが付くたびに無駄な書き込みが走るため。
  --
  -- WHEN が要るのは、saveMessages の upsert が中身が同じでも content/extra を
  -- 毎回 SET するから。これが無いと /index update を回すたびに全件の FTS を
  -- 作り直すことになる (UPDATE OF だけでは防げない)。
  DROP TRIGGER IF EXISTS messages_fts_au;
  CREATE TRIGGER messages_fts_au AFTER UPDATE OF content, extra ON messages
  WHEN old.content <> new.content OR old.extra <> new.extra BEGIN
    INSERT INTO messages_fts(messages_fts, rowid, content, extra) VALUES ('delete', old.rowid, old.content, old.extra);
    INSERT INTO messages_fts(rowid, content, extra) VALUES (new.rowid, new.content, new.extra);
  END;
`);

// 取り切った区間を明示的に持つ。
//
// 単一カーソル (channels.newest_id) だけだと、bot が落ちている間に流れた分を
// 復帰後の最初の1通がカーソルごと飛び越えてしまい、その穴は二度と埋まらない。
// 「どこからどこまでは実際に取った」を区間で持てば、穴を列挙して塞げる。
db.exec(`
  CREATE TABLE IF NOT EXISTS channel_spans (
    channel_id TEXT NOT NULL,
    from_ms    INTEGER NOT NULL,
    to_ms      INTEGER NOT NULL,
    from_id    TEXT NOT NULL,
    to_id      TEXT NOT NULL,
    PRIMARY KEY (channel_id, from_ms)
  );
  CREATE INDEX IF NOT EXISTS idx_span_channel ON channel_spans(channel_id, from_ms);
`);

// 意味検索用のベクトル。
//
// messages.rowid を主キーにする。権限フィルタと絞り込みは buildSearch() の SQL に
// あるので、「SQL で絞ってから生き残った行のベクトルを引く」形になり、これは JOIN。
// rowid は INTEGER PRIMARY KEY なので追加索引ゼロで最速に引ける。
// FTS5 も content_rowid='rowid' で同じ前提に乗っているので、新しい露出は作らない。
db.exec(`
  CREATE TABLE IF NOT EXISTS embed_models (
    model_id       INTEGER PRIMARY KEY AUTOINCREMENT,
    name           TEXT NOT NULL,
    dim            INTEGER NOT NULL,
    quant          TEXT NOT NULL,
    prefix_query   TEXT NOT NULL DEFAULT '',
    prefix_passage TEXT NOT NULL DEFAULT '',
    max_length     INTEGER NOT NULL DEFAULT 192,
    created_at     INTEGER NOT NULL,
    UNIQUE (name, dim, quant, prefix_query, prefix_passage)
  );

  -- text_len = 0 は「対象外として飛ばした」印。印を残さないとスイープが同じ行を
  -- 毎回引き直し、被覆率も推測になる。
  CREATE TABLE IF NOT EXISTS message_vectors (
    rowid      INTEGER PRIMARY KEY,
    model_id   INTEGER NOT NULL,
    scale      REAL NOT NULL DEFAULT 1,
    vec        BLOB NOT NULL,
    text_len   INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );

  -- messages が消えたらベクトルも消す。SQLite は DELETE で空いた rowid を
  -- 使い回すので、残すと別のメッセージに他人のベクトルが付く。
  CREATE TRIGGER IF NOT EXISTS messages_vec_ad AFTER DELETE ON messages BEGIN
    DELETE FROM message_vectors WHERE rowid = old.rowid;
  END;

  -- 本文が「実際に変わったとき」だけ捨てる。WHEN を付けないと saveMessages の
  -- upsert が毎回 content を SET するせいで、/index update を回すたびに
  -- 全ベクトルが消えて数時間の再埋め込みになる。
  CREATE TRIGGER IF NOT EXISTS messages_vec_au AFTER UPDATE OF content ON messages
  WHEN old.content <> new.content BEGIN
    DELETE FROM message_vectors WHERE rowid = old.rowid;
  END;

  CREATE TABLE IF NOT EXISTS embed_state (
    guild_id     TEXT PRIMARY KEY,
    model_id     INTEGER,
    status       TEXT NOT NULL DEFAULT 'idle',
    cursor_rowid INTEGER NOT NULL DEFAULT 0,
    embedded     INTEGER NOT NULL DEFAULT 0,
    skipped      INTEGER NOT NULL DEFAULT 0,
    started_at   INTEGER,
    finished_at  INTEGER,
    swept_at     INTEGER,
    last_error   TEXT,
    enabled      INTEGER NOT NULL DEFAULT 0
  );
`);

export function getEmbedState(guildId) {
  return db.prepare('SELECT * FROM embed_state WHERE guild_id = ?').get(guildId);
}

export function setEmbedState(guildId, patch) {
  db.prepare('INSERT OR IGNORE INTO embed_state (guild_id) VALUES (?)').run(guildId);

  const keys = Object.keys(patch);
  if (keys.length === 0) return;

  const assignments = keys.map((key) => `${key} = @${key}`).join(', ');
  db.prepare(`UPDATE embed_state SET ${assignments} WHERE guild_id = @guild_id`)
    .run({ ...patch, guild_id: guildId });
}

export function listEmbedGuilds() {
  return db.prepare('SELECT * FROM embed_state WHERE enabled = 1').all();
}

const DISCORD_EPOCH_MS = 1420070400000n;

/**
 * snowflake から生成時刻 (ms) を取り出す。
 *
 * 区間演算を ID の文字列比較でやってはいけない。snowflake は 17〜19 桁あり、
 * 桁数が違うと文字列比較の大小が実際の時系列と逆になる。
 * 数値化しても 2^53 を超えるので BigInt で shift してから ms に落とす。
 */
export function snowflakeToMs(id) {
  try {
    return Number((BigInt(String(id)) >> 22n) + DISCORD_EPOCH_MS);
  } catch {
    return null;
  }
}

const selectOverlappingSpans = db.prepare(`
  SELECT from_ms, to_ms, from_id, to_id FROM channel_spans
  WHERE channel_id = ? AND to_ms >= ? AND from_ms <= ?
  ORDER BY from_ms
`);
const deleteSpanStmt = db.prepare('DELETE FROM channel_spans WHERE channel_id = ? AND from_ms = ?');
const insertSpanStmt = db.prepare(`
  INSERT OR REPLACE INTO channel_spans (channel_id, from_ms, to_ms, from_id, to_id)
  VALUES (?, ?, ?, ?, ?)
`);

/**
 * 「fromId から toId までは取り切った」を記録する。
 * 既存区間と重なっていれば1本にまとめる (連続取得なら必ず端で重なる)。
 */
export const recordSpan = db.transaction((channelId, fromId, toId) => {
  let fromMs = snowflakeToMs(fromId);
  let toMs = snowflakeToMs(toId);
  if (fromMs === null || toMs === null) return;

  if (fromMs > toMs) {
    [fromId, toId] = [toId, fromId];
    [fromMs, toMs] = [toMs, fromMs];
  }

  let from = { ms: fromMs, id: fromId };
  let to = { ms: toMs, id: toId };

  for (const span of selectOverlappingSpans.all(channelId, fromMs, toMs)) {
    if (span.from_ms < from.ms) from = { ms: span.from_ms, id: span.from_id };
    if (span.to_ms > to.ms) to = { ms: span.to_ms, id: span.to_id };
    deleteSpanStmt.run(channelId, span.from_ms);
  }

  insertSpanStmt.run(channelId, from.ms, to.ms, from.id, to.id);
});

export function listSpans(channelId) {
  return db.prepare(`
    SELECT from_ms, to_ms, from_id, to_id FROM channel_spans
    WHERE channel_id = ? ORDER BY from_ms
  `).all(channelId);
}

/**
 * 区間の隙間 = 取りこぼしている期間。
 * 末尾 (最後の区間より後) は起動時のキャッチアップが担当するのでここには含めない。
 */
export function channelGaps(channelId) {
  const spans = listSpans(channelId);
  const gaps = [];

  for (let i = 1; i < spans.length; i += 1) {
    gaps.push({
      afterId: spans[i - 1].to_id,
      beforeId: spans[i].from_id,
      fromMs: spans[i - 1].to_ms,
      toMs: spans[i].from_ms
    });
  }

  return gaps;
}

/**
 * 最後の区間より後に既知のメッセージがあるなら、その間は「取ったと言えない」。
 *
 * 停止中に流れた分は、復帰後の live メッセージが先に入るのでここに現れる。
 * 区間の隙間 (channelGaps) は前後を区間で挟まれた穴しか拾えないので、
 * 末尾はこちらで別に見る必要がある。追いつきが済めば区間が伸びて消える。
 */
export function channelTailGap(channelId) {
  const spans = listSpans(channelId);
  if (spans.length === 0) return null;

  const last = spans[spans.length - 1];
  const row = db
    .prepare('SELECT MAX(created_at) AS at FROM messages WHERE channel_id = ? AND deleted = 0')
    .get(channelId);

  if (!row?.at || row.at <= last.to_ms) return null;

  return { afterId: last.to_id, fromMs: last.to_ms, toMs: row.at };
}

export function clearSpans(channelId) {
  db.prepare('DELETE FROM channel_spans WHERE channel_id = ?').run(channelId);
}

// 正規表現検索用。SQLite 側から呼べるようにしておく。
// 暴走を防ぐため、1クエリあたりの評価回数に上限を設ける。
let regexBudget = Infinity;

export function setRegexBudget(limit) {
  regexBudget = limit;
}

export class RegexBudgetExceeded extends Error {}

db.function('regexp', { deterministic: true }, (pattern, value) => {
  if (value == null) return 0;
  if (regexBudget-- <= 0) {
    throw new RegexBudgetExceeded('regex scan budget exceeded');
  }

  try {
    const [, body, flags] = /^\/(.*)\/([a-z]*)$/s.exec(pattern) ?? [null, pattern, 'i'];
    return new RegExp(body, flags).test(String(value)) ? 1 : 0;
  } catch {
    return 0;
  }
});

const upsertMessageStmt = db.prepare(`
  INSERT INTO messages (
    message_id, guild_id, channel_id, parent_id, author_id, author_name, is_bot,
    content, extra, created_at, edited_at, reply_to,
    attachment_count, attachment_kinds, embed_count, sticker_count, link_count,
    reaction_count, char_count, pinned, deleted
  ) VALUES (
    @message_id, @guild_id, @channel_id, @parent_id, @author_id, @author_name, @is_bot,
    @content, @extra, @created_at, @edited_at, @reply_to,
    @attachment_count, @attachment_kinds, @embed_count, @sticker_count, @link_count,
    @reaction_count, @char_count, @pinned, 0
  )
  ON CONFLICT(message_id) DO UPDATE SET
    author_name = excluded.author_name,
    content = excluded.content,
    extra = excluded.extra,
    edited_at = excluded.edited_at,
    reply_to = excluded.reply_to,
    attachment_count = excluded.attachment_count,
    attachment_kinds = excluded.attachment_kinds,
    embed_count = excluded.embed_count,
    sticker_count = excluded.sticker_count,
    link_count = excluded.link_count,
    reaction_count = excluded.reaction_count,
    char_count = excluded.char_count,
    pinned = excluded.pinned,
    deleted = 0
`);

const deleteMentionsStmt = db.prepare('DELETE FROM message_mentions WHERE message_id = ?');
const insertMentionStmt = db.prepare('INSERT OR IGNORE INTO message_mentions (message_id, user_id) VALUES (?, ?)');
const deleteReactionsStmt = db.prepare('DELETE FROM message_reactions WHERE message_id = ?');
const insertReactionStmt = db.prepare('INSERT OR REPLACE INTO message_reactions (message_id, emoji, count) VALUES (?, ?, ?)');
const deleteLinksStmt = db.prepare('DELETE FROM message_links WHERE message_id = ?');
const insertLinkStmt = db.prepare('INSERT OR IGNORE INTO message_links (message_id, url, domain) VALUES (?, ?, ?)');

function saveOne(record) {
  // 子テーブル向けの配列は名前付きパラメータに渡せないので分離する
  const { mentions = [], reactions = [], links = [], ...row } = record;

  upsertMessageStmt.run(row);

  deleteMentionsStmt.run(row.message_id);
  for (const userId of mentions) {
    insertMentionStmt.run(row.message_id, userId);
  }

  deleteReactionsStmt.run(row.message_id);
  for (const reaction of reactions) {
    insertReactionStmt.run(row.message_id, reaction.emoji, reaction.count);
  }

  deleteLinksStmt.run(row.message_id);
  for (const link of links) {
    insertLinkStmt.run(row.message_id, link.url, link.domain);
  }
}

export const saveMessages = db.transaction((records) => {
  for (const record of records) {
    saveOne(record);
  }
  return records.length;
});

export function saveMessage(record) {
  saveMessages([record]);
}

export function markMessageDeleted(messageId) {
  db.prepare('UPDATE messages SET deleted = 1 WHERE message_id = ?').run(messageId);
}

export function replaceReactions(messageId, reactions) {
  const total = reactions.reduce((sum, reaction) => sum + reaction.count, 0);
  db.transaction(() => {
    deleteReactionsStmt.run(messageId);
    for (const reaction of reactions) {
      insertReactionStmt.run(messageId, reaction.emoji, reaction.count);
    }
    db.prepare('UPDATE messages SET reaction_count = ? WHERE message_id = ?').run(total, messageId);
  })();
}

export function upsertChannel(channel) {
  db.prepare(`
    INSERT INTO channels (channel_id, guild_id, parent_id, name, type, is_thread, is_private, updated_at)
    VALUES (@channel_id, @guild_id, @parent_id, @name, @type, @is_thread, @is_private, @updated_at)
    ON CONFLICT(channel_id) DO UPDATE SET
      guild_id = excluded.guild_id,
      parent_id = excluded.parent_id,
      name = excluded.name,
      type = excluded.type,
      is_thread = excluded.is_thread,
      is_private = excluded.is_private,
      updated_at = excluded.updated_at
  `).run({ updated_at: Date.now(), ...channel });
}

export function getChannelState(channelId) {
  return db.prepare('SELECT * FROM channels WHERE channel_id = ?').get(channelId);
}

export function updateChannelState(channelId, patch) {
  const keys = Object.keys(patch);
  if (keys.length === 0) return;

  const assignments = keys.map((key) => `${key} = @${key}`).join(', ');
  db.prepare(`UPDATE channels SET ${assignments}, updated_at = @updated_at WHERE channel_id = @channel_id`)
    .run({ ...patch, channel_id: channelId, updated_at: Date.now() });
}

export function listChannelStates(guildId) {
  return db.prepare('SELECT * FROM channels WHERE guild_id = ? ORDER BY message_count DESC').all(guildId);
}

export function getGuildState(guildId) {
  return db.prepare('SELECT * FROM guild_index_state WHERE guild_id = ?').get(guildId);
}

export function setGuildState(guildId, patch) {
  db.prepare('INSERT OR IGNORE INTO guild_index_state (guild_id) VALUES (?)').run(guildId);

  const keys = Object.keys(patch);
  if (keys.length === 0) return;

  const assignments = keys.map((key) => `${key} = @${key}`).join(', ');
  db.prepare(`UPDATE guild_index_state SET ${assignments} WHERE guild_id = @guild_id`)
    .run({ ...patch, guild_id: guildId });
}

export function isGuildIndexed(guildId) {
  return Boolean(getGuildState(guildId));
}

export function countMessages(guildId) {
  return db.prepare('SELECT COUNT(*) AS count FROM messages WHERE guild_id = ?').get(guildId).count;
}

export function countChannelMessages(channelId) {
  return db.prepare('SELECT COUNT(*) AS count FROM messages WHERE channel_id = ?').get(channelId).count;
}

export function getMessageById(messageId) {
  return db.prepare('SELECT * FROM messages WHERE message_id = ?').get(messageId);
}

export function purgeGuild(guildId) {
  db.transaction(() => {
    db.prepare(`
      DELETE FROM message_mentions WHERE message_id IN (SELECT message_id FROM messages WHERE guild_id = ?)
    `).run(guildId);
    db.prepare(`
      DELETE FROM message_reactions WHERE message_id IN (SELECT message_id FROM messages WHERE guild_id = ?)
    `).run(guildId);
    db.prepare(`
      DELETE FROM message_links WHERE message_id IN (SELECT message_id FROM messages WHERE guild_id = ?)
    `).run(guildId);
    db.prepare(`
      DELETE FROM channel_spans WHERE channel_id IN (SELECT channel_id FROM channels WHERE guild_id = ?)
    `).run(guildId);
    // ベクトルは messages_vec_ad トリガで連鎖して消える
    db.prepare('DELETE FROM messages WHERE guild_id = ?').run(guildId);
    db.prepare('DELETE FROM channels WHERE guild_id = ?').run(guildId);
    db.prepare('DELETE FROM guild_index_state WHERE guild_id = ?').run(guildId);
    db.prepare('DELETE FROM embed_state WHERE guild_id = ?').run(guildId);
  })();
}
