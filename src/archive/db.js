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
  DROP TRIGGER IF EXISTS messages_fts_au;
  CREATE TRIGGER messages_fts_au AFTER UPDATE OF content, extra ON messages BEGIN
    INSERT INTO messages_fts(messages_fts, rowid, content, extra) VALUES ('delete', old.rowid, old.content, old.extra);
    INSERT INTO messages_fts(rowid, content, extra) VALUES (new.rowid, new.content, new.extra);
  END;
`);

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
    db.prepare('DELETE FROM messages WHERE guild_id = ?').run(guildId);
    db.prepare('DELETE FROM channels WHERE guild_id = ?').run(guildId);
    db.prepare('DELETE FROM guild_index_state WHERE guild_id = ?').run(guildId);
  })();
}
