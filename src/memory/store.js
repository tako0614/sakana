import Database from 'better-sqlite3';
import { tuneSqlite } from '../sqlite.js';

// 記憶の本。過去ログを区切りごとに AI へ渡して、2層に整理する。
//
//   出来事 (episodes): いつ・誰が・何を・どうなった、の短い要約。根拠の発言 ID を持つ。
//                      ここが「元の発言までたどれる」層で、関わったページ同士を結ぶ。
//   ページ (nodes):    人物・作っているもの・話題などの説明。出来事から分かったことを
//                      統合して書き直す (ログの写しや日記にしない)。主張ごとに [e12] で
//                      出来事を引き、[[people/さば]] で他のページへリンクする。
//
// 根のページだけを会話の system に入れ、ほかは memory ツールで開く。会話に出た名前を
// 手がかりに関係するページと出来事を自動で思い出す (recall.js)。
//
// アーカイブ (archive.sqlite) とは別ファイル。書くのは builder (scripts/memory-tree.mjs)
// だけで、bot は読むのと公開チャンネルの控えを書くだけ。

const dbPath = process.env.MEMORY_DB_PATH ?? 'memory.sqlite';

// 根の直下 (最上位) の種。書き手は索引にある最上位から必ず選び、どれにも合わなければ
// others に入れる (最上位を勝手に増やさない)。最上位を増やす・消すのは管理者 (/memory category)。
// others に育ったまとまりは、そのまま最上位に昇格できる (moveSubtree)。
export const OTHERS = 'others';
export const TOP_LEVEL = [
  ['people', '人物 (性格・立場や意見・得意なこと・作ったもの・口癖・人との関係)'],
  ['projects', '作っているもの (bot・サービス・作品・リポジトリ)'],
  ['topics', 'よく出る話題・技術的な知見・議論の結論'],
  ['events', '大きな出来事のまとめ (移行・企画・事件・炎上)'],
  ['debates', 'レスバ・議論・揉め事 (誰と誰が何で、それぞれの主張、どう終わったか)'],
  ['culture', 'ネタ・ミーム・名言/迷言・内輪のノリ'],
  ['server', 'サーバーのルール・チャンネル・用語'],
  [OTHERS, 'どこにも当てはまらないもの (まとまりが育ったら最上位に上げる)']
];
// Discord のメニュー (25件) に根の一覧が収まるように
export const MAX_TOP_LEVEL = 20;

export const MAX_DEPTH = 4;
const MAX_PART = 48;

let db = null;

export function memoryDb() {
  if (db) return db;
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('busy_timeout = 30000');
  tuneSqlite(db, { cacheMiB: 64, mmapMiB: 512, label: 'memory' });
  db.exec(`
    CREATE TABLE IF NOT EXISTS nodes (
      id INTEGER PRIMARY KEY,
      guild_id TEXT NOT NULL,
      path TEXT NOT NULL,              -- '' が根。'people/たこ' のように / 区切り
      parent TEXT,                     -- 根だけ NULL
      summary TEXT NOT NULL DEFAULT '',
      body TEXT NOT NULL DEFAULT '',   -- 統合済みの説明 ([e12] と [[path]] を含む)
      aliases TEXT NOT NULL DEFAULT '[]',
      pending TEXT NOT NULL DEFAULT '', -- まだ本文へ統合していない新しい知識 (1行1件、[e12] 付き)
      pending_count INTEGER NOT NULL DEFAULT 0,
      weight INTEGER NOT NULL DEFAULT 0, -- 知識が足された回数。並び順と想起の重みに使う
      first_at INTEGER,
      last_at INTEGER,
      updated_at INTEGER NOT NULL,
      UNIQUE (guild_id, path)
    );
    CREATE INDEX IF NOT EXISTS idx_nodes_parent ON nodes(guild_id, parent, weight DESC);
    CREATE INDEX IF NOT EXISTS idx_nodes_pending ON nodes(guild_id, pending_count DESC);

    -- 日本語は単語で区切れないので trigram。3文字未満は LIKE に落とす。
    CREATE VIRTUAL TABLE IF NOT EXISTS nodes_fts USING fts5(
      path, summary, body, aliases, content='nodes', content_rowid='id', tokenize='trigram'
    );
    CREATE TRIGGER IF NOT EXISTS nodes_ai AFTER INSERT ON nodes BEGIN
      INSERT INTO nodes_fts(rowid, path, summary, body, aliases) VALUES (new.id, new.path, new.summary, new.body, new.aliases);
    END;
    CREATE TRIGGER IF NOT EXISTS nodes_ad AFTER DELETE ON nodes BEGIN
      INSERT INTO nodes_fts(nodes_fts, rowid, path, summary, body, aliases) VALUES ('delete', old.id, old.path, old.summary, old.body, old.aliases);
    END;
    CREATE TRIGGER IF NOT EXISTS nodes_au AFTER UPDATE OF path, summary, body, aliases ON nodes BEGIN
      INSERT INTO nodes_fts(nodes_fts, rowid, path, summary, body, aliases) VALUES ('delete', old.id, old.path, old.summary, old.body, old.aliases);
      INSERT INTO nodes_fts(rowid, path, summary, body, aliases) VALUES (new.id, new.path, new.summary, new.body, new.aliases);
    END;

    CREATE TABLE IF NOT EXISTS episodes (
      id INTEGER PRIMARY KEY,
      guild_id TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT '',   -- 自由な種類名 (レスバ / ネタ / 事件 / 決定 / 近況 …)
      title TEXT NOT NULL,
      summary TEXT NOT NULL,
      highlights TEXT NOT NULL DEFAULT '[]', -- 決め台詞・名言として残す発言の message_id (原文はアーカイブから引く)
      channel_id TEXT NOT NULL,
      at_ms INTEGER NOT NULL,          -- 根拠の発言の最初と最後 (モデルの書いた日付ではなく原文の時刻)
      end_ms INTEGER NOT NULL,
      sources TEXT NOT NULL,           -- 根拠の message_id の JSON 配列
      importance INTEGER NOT NULL DEFAULT 2,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_episodes_time ON episodes(guild_id, at_ms);

    -- 出来事に関わったページ。ページ → 出来事 → 別のページ、とたどる結び目。
    CREATE TABLE IF NOT EXISTS episode_nodes (
      episode_id INTEGER NOT NULL,
      guild_id TEXT NOT NULL,
      path TEXT NOT NULL,
      PRIMARY KEY (episode_id, path)
    );
    CREATE INDEX IF NOT EXISTS idx_episode_nodes_path ON episode_nodes(guild_id, path, episode_id);

    -- 出来事どうしの続き・原因・結果。筋 (話の流れ) をたどる。
    CREATE TABLE IF NOT EXISTS episode_links (
      guild_id TEXT NOT NULL,
      from_id INTEGER NOT NULL,        -- 新しい方
      to_id INTEGER NOT NULL,          -- 前の出来事
      PRIMARY KEY (guild_id, from_id, to_id)
    );
    CREATE INDEX IF NOT EXISTS idx_episode_links_to ON episode_links(guild_id, to_id);

    -- ページどうしのつながり。同じ出来事に関わった回数と、本文の [[リンク]]。
    CREATE TABLE IF NOT EXISTS links (
      guild_id TEXT NOT NULL,
      src TEXT NOT NULL,
      dst TEXT NOT NULL,
      weight INTEGER NOT NULL DEFAULT 0,
      last_at INTEGER,
      PRIMARY KEY (guild_id, src, dst)
    );

    -- 渡し終えた区切り。被覆 (どこまで読んだか) の証拠で、失敗も残す。
    CREATE TABLE IF NOT EXISTS segments (
      id INTEGER PRIMARY KEY,
      guild_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      from_id TEXT NOT NULL,
      to_id TEXT NOT NULL,
      from_ms INTEGER NOT NULL,
      to_ms INTEGER NOT NULL,
      messages INTEGER NOT NULL,
      chars INTEGER NOT NULL,
      status TEXT NOT NULL,            -- done | failed
      model TEXT,
      error TEXT,
      done_at INTEGER NOT NULL,
      UNIQUE (guild_id, channel_id, from_id)
    );
    CREATE INDEX IF NOT EXISTS idx_segments_status ON segments(guild_id, status);

    -- チャンネルごとの読み終えた位置。区切りの適用と同じトランザクションで進める。
    CREATE TABLE IF NOT EXISTS cursors (
      guild_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      last_id TEXT NOT NULL,
      last_ms INTEGER NOT NULL,
      PRIMARY KEY (guild_id, channel_id)
    );

    -- bot が書く「@everyone が読めるチャンネル」の控え。builder は Discord に
    -- つながっていないので、ここに無いチャンネルは読まない (非公開を混ぜない)。
    CREATE TABLE IF NOT EXISTS public_channels (
      guild_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      PRIMARY KEY (guild_id, channel_id)
    );

    -- @everyone からは見えないが、管理者が記憶に入れると決めたチャンネル (/memory include)。
    -- その下の非公開でないスレッドも入る。
    CREATE TABLE IF NOT EXISTS included_channels (
      guild_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      added_by TEXT,
      added_at INTEGER NOT NULL,
      PRIMARY KEY (guild_id, channel_id)
    );

    CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `);

  // 種類名と決め台詞の列 (2026-10-15 に追加)。古い DB には足す
  const columns = new Set(db.pragma('table_info(episodes)').map((row) => row.name));
  if (!columns.has('kind')) db.exec("ALTER TABLE episodes ADD COLUMN kind TEXT NOT NULL DEFAULT ''");
  if (!columns.has('highlights')) db.exec("ALTER TABLE episodes ADD COLUMN highlights TEXT NOT NULL DEFAULT '[]'");
  // 出来事の全文検索は種類名も引く (「レスバ」で探せるように)。列が違えば作り直す
  const ftsColumns = db.pragma('table_info(episodes_fts)').map((row) => row.name);
  if (!ftsColumns.includes('kind')) {
    db.exec(`
      DROP TRIGGER IF EXISTS episodes_ai;
      DROP TRIGGER IF EXISTS episodes_ad;
      DROP TABLE IF EXISTS episodes_fts;
      CREATE VIRTUAL TABLE episodes_fts USING fts5(
        title, summary, kind, content='episodes', content_rowid='id', tokenize='trigram'
      );
      INSERT INTO episodes_fts(episodes_fts) VALUES ('rebuild');
    `);
  }
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS episodes_ai AFTER INSERT ON episodes BEGIN
      INSERT INTO episodes_fts(rowid, title, summary, kind) VALUES (new.id, new.title, new.summary, new.kind);
    END;
    CREATE TRIGGER IF NOT EXISTS episodes_ad AFTER DELETE ON episodes BEGIN
      INSERT INTO episodes_fts(episodes_fts, rowid, title, summary, kind) VALUES ('delete', old.id, old.title, old.summary, old.kind);
    END;
  `);
  return db;
}

export function closeMemoryDb() {
  db?.close();
  db = null;
}

const json = (text, fallback) => { try { return JSON.parse(text); } catch { return fallback; } };

// ---- パス -----------------------------------------------------------------

/**
 * モデルが書いたパスを木の中の位置に直す。空・`..` は null、深すぎる分は切る。
 * 英字の最上位は小文字にそろえる。新しい最上位を許すかは placeTopLevel が決める。
 */
export function normalizePath(raw) {
  const parts = String(raw ?? '')
    .replace(/^\[\[|\]\]$/g, '')
    .replace(/\\/g, '/')
    .split('/')
    .map((part) => part.replace(/[\s　]+/g, ' ').replace(/[#`*<>|?"[\]]/g, '').trim().slice(0, MAX_PART))
    .filter((part) => part && part !== '.' && part !== '..');
  if (parts.length === 0) return null;
  if (/^[\x20-\x7e]+$/.test(parts[0])) parts[0] = parts[0].toLowerCase();
  return parts.slice(0, MAX_DEPTH).join('/');
}

/**
 * 書き手が書いたパスを、必ずどれかの最上位の下に置く。既にある最上位ならそのまま、
 * 知らない最上位なら others の下へ (最上位は管理者だけが増やす)。
 */
export function placeTopLevel(guildId, path) {
  if (!path) return path;
  const top = path.split('/')[0];
  if (memoryDb().prepare("SELECT 1 FROM nodes WHERE guild_id = ? AND parent = '' AND path = ?").get(guildId, top)) return path;
  return [OTHERS, ...path.split('/')].slice(0, MAX_DEPTH).join('/');
}

/** 最上位を足す (管理者)。既にあれば説明だけ直す。 */
export function addTopLevel(guildId, name, summary = '', now = Date.now()) {
  const path = normalizePath(name);
  if (!path || path.includes('/')) throw new Error('最上位の名前に / は使えません');
  const exists = getNode(guildId, path);
  if (!exists && topLevels(guildId, MAX_TOP_LEVEL + 1).length >= MAX_TOP_LEVEL) {
    throw new Error(`最上位は ${MAX_TOP_LEVEL} 個までです`);
  }
  ensureNode(guildId, path, { summary, now });
  if (summary) memoryDb().prepare('UPDATE nodes SET summary = ? WHERE guild_id = ? AND path = ?').run(summary, guildId, path);
  const removed = (getState(`removed-top:${guildId}`) ?? []).filter((item) => item !== path);
  setState(`removed-top:${guildId}`, removed.length ? removed : null);
  return path;
}

/**
 * 部分木ごと別の場所へ移す (others に育ったまとまりの昇格・最上位の削除)。
 * ページのパス・親、出来事とのつながり、ページどうしのつながり、本文と統合待ちの [[リンク]] を書き換える。
 */
export function moveSubtree(guildId, from, to, now = Date.now()) {
  const d = memoryDb();
  if (!getNode(guildId, from)) throw new Error(`ページ ${from} はありません`);
  if (to === from || to.startsWith(`${from}/`)) throw new Error('自分の下には移せません');
  const rewrite = (path) => (path === from ? to : path.startsWith(`${from}/`) ? `${to}${path.slice(from.length)}` : path);
  const escapeLike = (text) => text.replace(/[%_\\]/g, (c) => `\\${c}`);
  const rows = d.prepare(`SELECT path FROM nodes WHERE guild_id = ? AND (path = ? OR path LIKE ? ESCAPE '\\') ORDER BY length(path)`)
    .all(guildId, from, `${escapeLike(from)}/%`);
  d.transaction(() => {
    // 移し先の途中のページ (新しい最上位など) を先に作る
    if (parentOf(to)) ensureNode(guildId, parentOf(to), { now });
    for (const { path } of rows) {
      const target = rewrite(path);
      if (getNode(guildId, target)) {
        // 同じ名前のページが移し先にあれば、本文を統合待ちに回して1つにする
        const moving = getNode(guildId, path);
        if (moving.body || moving.pending) addPending(guildId, target, `${moving.body}\n${moving.pending}`.split('\n'), { now });
        d.prepare('DELETE FROM nodes WHERE guild_id = ? AND path = ?').run(guildId, path);
      } else {
        d.prepare('UPDATE nodes SET path = ?, parent = ?, updated_at = ? WHERE guild_id = ? AND path = ?')
          .run(target, parentOf(target), now, guildId, path);
      }
      d.prepare('UPDATE OR IGNORE episode_nodes SET path = ? WHERE guild_id = ? AND path = ?').run(target, guildId, path);
      d.prepare('DELETE FROM episode_nodes WHERE guild_id = ? AND path = ?').run(guildId, path);
      d.prepare('UPDATE OR IGNORE links SET src = ? WHERE guild_id = ? AND src = ?').run(target, guildId, path);
      d.prepare('UPDATE OR IGNORE links SET dst = ? WHERE guild_id = ? AND dst = ?').run(target, guildId, path);
      d.prepare('DELETE FROM links WHERE guild_id = ? AND (src = ? OR dst = ?)').run(guildId, path, path);
    }
    // 本文と統合待ちに書かれた [[リンク]] も追いかける
    const link = new RegExp(`\\[\\[${from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=[\\]/])`, 'g');
    for (const node of d.prepare('SELECT path, body, pending FROM nodes WHERE guild_id = ? AND (body LIKE ? OR pending LIKE ?)')
      .all(guildId, `%[[${from}%`, `%[[${from}%`)) {
      d.prepare('UPDATE nodes SET body = ?, pending = ? WHERE guild_id = ? AND path = ?')
        .run(node.body.replace(link, `[[${to}`), node.pending.replace(link, `[[${to}`), guildId, node.path);
    }
  })();
  return rows.length;
}

/** 最上位を消す (管理者)。中身は others の下へ移すので失わない。others は消せない。 */
export function removeTopLevel(guildId, name) {
  const path = normalizePath(name);
  if (!path || path.includes('/') || !getNode(guildId, path)) throw new Error(`最上位 ${name} はありません`);
  if (path === OTHERS) throw new Error('others は受け皿なので消せません');
  ensureNode(guildId, OTHERS);
  const moved = moveSubtree(guildId, path, `${OTHERS}/${path}`);
  if (TOP_LEVEL.some(([seed]) => seed === path)) {
    setState(`removed-top:${guildId}`, [...new Set([...(getState(`removed-top:${guildId}`) ?? []), path])]);
  }
  return moved;
}

/** 根の直下 (種と、モデルが作ったもの)。重い順。 */
export function topLevels(guildId, limit = MAX_TOP_LEVEL) {
  return listChildren(guildId, '', limit).map((row) => row.path);
}

export const parentOf = (path) => (path === '' ? null : path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');
export const nameOf = (path) => path.slice(path.lastIndexOf('/') + 1);
export const depthOf = (path) => (path ? path.split('/').length : 0);

// ---- ページ ---------------------------------------------------------------

export function ensureSeeds(guildId, now = Date.now()) {
  const d = memoryDb();
  const insert = d.prepare(`
    INSERT OR IGNORE INTO nodes (guild_id, path, parent, summary, updated_at) VALUES (?, ?, ?, ?, ?)
  `);
  // 管理者が消した種は作り直さない (others だけは受け皿なので必ず置く)
  const removed = new Set(getState(`removed-top:${guildId}`) ?? []);
  d.transaction(() => {
    insert.run(guildId, '', null, 'このサーバーの記憶の根', now);
    for (const [name, summary] of TOP_LEVEL) {
      if (name === OTHERS || !removed.has(name)) insert.run(guildId, name, '', summary, now);
    }
  })();
}

export function getNode(guildId, path) {
  const row = memoryDb().prepare('SELECT * FROM nodes WHERE guild_id = ? AND path = ?').get(guildId, path);
  return row ? { ...row, aliases: json(row.aliases, []) } : null;
}

export function listChildren(guildId, path, limit = 200) {
  return memoryDb().prepare(`
    SELECT path, summary, weight, length(body) AS chars,
      (SELECT COUNT(*) FROM nodes c WHERE c.guild_id = n.guild_id AND c.parent = n.path) AS children
    FROM nodes n WHERE guild_id = ? AND parent = ?
    ORDER BY weight DESC, path LIMIT ?
  `).all(guildId, path, limit);
}

export function countNodes(guildId) {
  return memoryDb().prepare("SELECT COUNT(*) AS c FROM nodes WHERE guild_id = ? AND path <> ''").get(guildId).c;
}

export function hasTree(guildId) {
  return Boolean(memoryDb().prepare(
    "SELECT 1 FROM nodes WHERE guild_id = ? AND (path = '' AND body <> '' OR weight > 0) LIMIT 1"
  ).get(guildId));
}

const nameKey = (value) => String(value).toLowerCase().replace(/[\s_\-・.]+/g, '');

/**
 * 同じ親の下で、名前の表記ゆれ (大文字小文字・空白・別名) が一致する既存ページがあれば
 * そちらへ寄せる。索引に載せきれなかった小さいページを別名で作り直されるのを防ぐ。
 */
export function resolveExisting(guildId, path) {
  const d = memoryDb();
  if (d.prepare('SELECT 1 FROM nodes WHERE guild_id = ? AND path = ?').get(guildId, path)) return path;
  const target = nameKey(nameOf(path));
  for (const row of d.prepare('SELECT path, aliases FROM nodes WHERE guild_id = ? AND parent = ?').all(guildId, parentOf(path))) {
    if (nameKey(nameOf(row.path)) === target) return row.path;
    if (json(row.aliases, []).some((alias) => nameKey(alias) === target)) return row.path;
  }
  return path;
}

/** 途中のページも作る。既存なら何もしない (説明が空なら埋める)。 */
export function ensureNode(guildId, path, { summary = '', now = Date.now() } = {}) {
  const d = memoryDb();
  const parts = path.split('/');
  const insert = d.prepare('INSERT OR IGNORE INTO nodes (guild_id, path, parent, summary, updated_at) VALUES (?, ?, ?, ?, ?)');
  for (let i = 1; i <= parts.length; i += 1) {
    const current = parts.slice(0, i).join('/');
    insert.run(guildId, current, parentOf(current), i === parts.length ? summary : '', now);
  }
  if (summary) d.prepare("UPDATE nodes SET summary = ? WHERE guild_id = ? AND path = ? AND summary = ''").run(summary, guildId, path);
}

export function addAliases(guildId, path, aliases) {
  const node = getNode(guildId, path);
  if (!node) return;
  const merged = [...node.aliases];
  for (const alias of aliases) {
    const text = String(alias ?? '').trim().slice(0, 40);
    if (text && nameKey(text) !== nameKey(nameOf(path)) && !merged.some((item) => nameKey(item) === nameKey(text))) merged.push(text);
  }
  if (merged.length !== node.aliases.length) {
    memoryDb().prepare('UPDATE nodes SET aliases = ? WHERE guild_id = ? AND path = ?')
      .run(JSON.stringify(merged.slice(0, 12)), guildId, path);
  }
}

const lineKey = (line) => line.replace(/^[-・*\s]+/, '').replace(/\[e\d+\]/g, '').replace(/\s+/g, ' ').trim();

/**
 * 統合待ちの知識を足す。本文には直接書かない (統合の呼び出しが書き直す)。
 * 統合待ち・本文に同じ行があれば足さない。
 */
export function addPending(guildId, path, lines, { firstAt, lastAt, now = Date.now() } = {}) {
  const node = getNode(guildId, path);
  if (!node) throw new Error(`node missing: ${path}`);
  const seen = new Set(`${node.body}\n${node.pending}`.split('\n').map(lineKey).filter(Boolean));
  const fresh = [];
  for (const raw of lines) {
    const text = String(raw ?? '').replace(/\s*\n\s*/g, ' ').trim().slice(0, 400);
    const key = lineKey(text);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    fresh.push(text.startsWith('- ') ? text : `- ${text}`);
  }
  if (fresh.length === 0) return 0;
  memoryDb().prepare(`
    UPDATE nodes SET pending = pending || ?, pending_count = pending_count + ?, weight = weight + ?, updated_at = ?,
      first_at = MIN(COALESCE(first_at, ?), ?), last_at = MAX(COALESCE(last_at, ?), ?)
    WHERE guild_id = ? AND path = ?
  `).run(`${fresh.join('\n')}\n`, fresh.length, fresh.length, now,
    firstAt ?? now, firstAt ?? now, lastAt ?? now, lastAt ?? now, guildId, path);
  return fresh.length;
}

export function writePage(guildId, path, { summary, body, aliases, now = Date.now() }) {
  memoryDb().prepare(`
    UPDATE nodes SET summary = COALESCE(?, summary), body = ?, pending = '', pending_count = 0, updated_at = ?
    WHERE guild_id = ? AND path = ?
  `).run(summary || null, body, now, guildId, path);
  if (aliases?.length) addAliases(guildId, path, aliases);
}

/** 統合に何度も失敗したページは、知識を落とさないよう統合待ちをそのまま本文の末尾へ移す。 */
export function flushPendingRaw(guildId, path, now = Date.now()) {
  memoryDb().prepare(`
    UPDATE nodes SET body = trim(body || char(10) || pending), pending = '', pending_count = 0, updated_at = ?
    WHERE guild_id = ? AND path = ?
  `).run(now, guildId, path);
}

export function pendingNodes(guildId, { minChars = 0, limit = 200 } = {}) {
  return memoryDb().prepare(`
    SELECT path, length(body) AS body_chars, length(pending) AS pending_chars, pending_count FROM nodes
    WHERE guild_id = ? AND pending_count > 0 AND length(pending) >= ?
    ORDER BY length(pending) DESC LIMIT ?
  `).all(guildId, minChars, limit);
}

/**
 * 呼び出しに渡す木の索引。最上位から、知識の多いページの順に、文字数の上限まで。
 * 本文は渡さない (パスと1行説明だけで振り分けさせる)。
 */
export function treeIndex(guildId, maxChars = 6000) {
  const rows = memoryDb().prepare(`
    SELECT path, summary FROM nodes WHERE guild_id = ? AND path <> ''
    ORDER BY (instr(path, '/') = 0) DESC, weight DESC, path
  `).all(guildId);
  const lines = [];
  let used = 0;
  for (const row of rows) {
    const line = row.summary ? `${row.path} — ${row.summary}` : row.path;
    if (used + line.length + 1 > maxChars) break;
    lines.push(line);
    used += line.length + 1;
  }
  return { text: lines.join('\n'), shown: lines.length, total: rows.length };
}

/** 想起と照合に使う名前の一覧 (ページ名と別名)。2文字未満と最上位の名前は除く。 */
export function nodeNames(guildId) {
  const rows = memoryDb().prepare(`
    SELECT path, aliases, weight FROM nodes WHERE guild_id = ? AND instr(path, '/') > 0
  `).all(guildId);
  const names = [];
  for (const row of rows) {
    for (const name of [nameOf(row.path), ...json(row.aliases, [])]) {
      if ([...name].length >= 2) names.push({ name, path: row.path, weight: row.weight });
    }
  }
  return names;
}

// ---- 出来事 ---------------------------------------------------------------

export function insertEpisode(guildId, { kind = '', title, summary, channelId, atMs, endMs, sources, highlights = [], importance, now = Date.now() }) {
  return Number(memoryDb().prepare(`
    INSERT INTO episodes (guild_id, kind, title, summary, channel_id, at_ms, end_ms, sources, highlights, importance, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(guildId, kind, title, summary, channelId, atMs, endMs, JSON.stringify(sources), JSON.stringify(highlights), importance, now).lastInsertRowid);
}

export function linkEpisodeNodes(guildId, episodeId, paths, at) {
  const d = memoryDb();
  const insert = d.prepare('INSERT OR IGNORE INTO episode_nodes (episode_id, guild_id, path) VALUES (?, ?, ?)');
  const bump = d.prepare(`
    INSERT INTO links (guild_id, src, dst, weight, last_at) VALUES (?, ?, ?, 1, ?)
    ON CONFLICT(guild_id, src, dst) DO UPDATE SET weight = weight + 1, last_at = MAX(COALESCE(last_at, 0), excluded.last_at)
  `);
  const unique = [...new Set(paths)].slice(0, 8);
  for (const path of unique) insert.run(episodeId, guildId, path);
  for (const a of unique) for (const b of unique) if (a !== b) bump.run(guildId, a, b, at);
}

export function linkEpisodes(guildId, fromId, toIds) {
  const d = memoryDb();
  const exists = d.prepare('SELECT 1 FROM episodes WHERE guild_id = ? AND id = ?');
  const insert = d.prepare('INSERT OR IGNORE INTO episode_links (guild_id, from_id, to_id) VALUES (?, ?, ?)');
  let linked = 0;
  for (const id of toIds) {
    if (id !== fromId && exists.get(guildId, id)) { insert.run(guildId, fromId, id); linked += 1; }
  }
  return linked;
}

/** 本文の [[path]] をページどうしのつながりに数える。 */
export function linkPageMentions(guildId, path, body, at = Date.now()) {
  const bump = memoryDb().prepare(`
    INSERT INTO links (guild_id, src, dst, weight, last_at) VALUES (?, ?, ?, 1, ?)
    ON CONFLICT(guild_id, src, dst) DO UPDATE SET weight = weight + 1, last_at = MAX(COALESCE(last_at, 0), excluded.last_at)
  `);
  const exists = memoryDb().prepare('SELECT 1 FROM nodes WHERE guild_id = ? AND path = ?');
  for (const match of String(body).matchAll(/\[\[([^\]]+)\]\]/g)) {
    const target = normalizePath(match[1]);
    if (target && target !== path && exists.get(guildId, target)) bump.run(guildId, path, target, at);
  }
}

export function getEpisode(guildId, id) {
  const row = memoryDb().prepare('SELECT * FROM episodes WHERE guild_id = ? AND id = ?').get(guildId, id);
  if (!row) return null;
  const d = memoryDb();
  return {
    ...row,
    sources: json(row.sources, []),
    highlights: json(row.highlights, []),
    nodes: d.prepare('SELECT path FROM episode_nodes WHERE episode_id = ?').all(id).map((r) => r.path),
    before: d.prepare(`SELECT e.id, e.kind, e.title, e.at_ms FROM episode_links l JOIN episodes e ON e.id = l.to_id
      WHERE l.guild_id = ? AND l.from_id = ? ORDER BY e.at_ms`).all(guildId, id),
    after: d.prepare(`SELECT e.id, e.kind, e.title, e.at_ms FROM episode_links l JOIN episodes e ON e.id = l.from_id
      WHERE l.guild_id = ? AND l.to_id = ? ORDER BY e.at_ms`).all(guildId, id)
  };
}

/** ページに関わる出来事。重要なもの・新しいものから。 */
export function episodesFor(guildId, path, limit = 8) {
  // 子ページ経由で同じ出来事が何度も当たるので1件ずつにまとめる
  // (重複したまま /memory explore のメニューに並べると Discord が拒否した)
  return memoryDb().prepare(`
    SELECT e.id, e.kind, e.title, e.summary, e.at_ms, e.importance FROM episodes e
    WHERE e.guild_id = ? AND e.id IN (
      SELECT n.episode_id FROM episode_nodes n WHERE n.guild_id = ? AND (n.path = ? OR n.path LIKE ? ESCAPE '\\')
    )
    ORDER BY e.importance DESC, e.at_ms DESC LIMIT ?
  `).all(guildId, guildId, path, `${path.replace(/[%_\\]/g, (c) => `\\${c}`)}/%`, limit);
}

/** ページ (と子ページ) に関わる出来事を古い順に。年表用。件数も返す。 */
export function episodeTimeline(guildId, path, { offset = 0, limit = 10 } = {}) {
  const like = `${path.replace(/[%_\\]/g, (c) => `\\${c}`)}/%`;
  const where = `e.guild_id = ? AND e.id IN (
    SELECT n.episode_id FROM episode_nodes n WHERE n.guild_id = ? AND (n.path = ? OR n.path LIKE ? ESCAPE '\\')
  )`;
  const d = memoryDb();
  return {
    total: d.prepare(`SELECT COUNT(*) AS c FROM episodes e WHERE ${where}`).get(guildId, guildId, path, like).c,
    rows: d.prepare(`SELECT e.id, e.kind, e.title, e.summary, e.at_ms, e.importance FROM episodes e WHERE ${where}
      ORDER BY e.at_ms, e.id LIMIT ? OFFSET ?`).all(guildId, guildId, path, like, limit, offset)
  };
}

/** 子ページの数 (explore のページ送り用)。 */
export function countChildren(guildId, path) {
  return memoryDb().prepare('SELECT COUNT(*) AS c FROM nodes WHERE guild_id = ? AND parent = ?').get(guildId, path).c;
}

/** 2つのページが両方関わった出来事 (時系列)。 */
export function sharedEpisodes(guildId, a, b, limit = 15) {
  return memoryDb().prepare(`
    SELECT e.id, e.kind, e.title, e.summary, e.at_ms FROM episodes e
    WHERE e.guild_id = ?
      AND EXISTS (SELECT 1 FROM episode_nodes x WHERE x.episode_id = e.id AND x.path = ?)
      AND EXISTS (SELECT 1 FROM episode_nodes y WHERE y.episode_id = e.id AND y.path = ?)
    ORDER BY e.at_ms LIMIT ?
  `).all(guildId, a, b, limit);
}

export function linkedPages(guildId, path, limit = 8) {
  return memoryDb().prepare(`
    SELECT l.dst AS path, n.summary, SUM(l.weight) AS weight FROM (
      SELECT dst, weight FROM links WHERE guild_id = ? AND src = ?
      UNION ALL SELECT src AS dst, weight FROM links WHERE guild_id = ? AND dst = ?
    ) l JOIN nodes n ON n.guild_id = ? AND n.path = l.dst
    GROUP BY l.dst ORDER BY weight DESC LIMIT ?
  `).all(guildId, path, guildId, path, guildId, limit);
}

/** 区切りを書く前に渡す「最近の出来事」。続きの出来事を前のものと結ばせる。 */
export function recentEpisodesFor(guildId, path, limit = 3) {
  return memoryDb().prepare(`
    SELECT e.id, e.kind, e.title, e.at_ms FROM episode_nodes n JOIN episodes e ON e.id = n.episode_id
    WHERE n.guild_id = ? AND n.path = ? ORDER BY e.at_ms DESC LIMIT ?
  `).all(guildId, path, limit);
}

// ---- 検索 ----------------------------------------------------------------

const ftsPhrase = (term) => `"${term.replace(/"/g, '""')}"`;
const splitTerms = (query) => String(query ?? '').split(/[\s　]+/).map((t) => t.trim()).filter(Boolean).slice(0, 8);

function ftsSearch(sql, terms, params, limit) {
  const long = terms.filter((t) => [...t].length >= 3);
  if (long.length === 0) return [];
  const run = (match) => memoryDb().prepare(sql).all(match, ...params, limit);
  const rows = run(long.map(ftsPhrase).join(' AND '));
  if (rows.length >= limit || long.length === 1) return rows;
  const seen = new Set(rows.map((row) => row.id ?? row.path));
  return [...rows, ...run(long.map(ftsPhrase).join(' OR ')).filter((row) => !seen.has(row.id ?? row.path))].slice(0, limit);
}

export function searchNodes(guildId, query, limit = 8) {
  const terms = splitTerms(query);
  if (terms.length === 0) return [];
  const results = new Map();
  for (const row of ftsSearch(`
    SELECT n.path, n.summary, snippet(nodes_fts, 2, '[', ']', '…', 16) AS snippet
    FROM nodes_fts JOIN nodes n ON n.id = nodes_fts.rowid
    WHERE nodes_fts MATCH ? AND n.guild_id = ? ORDER BY bm25(nodes_fts, 4.0, 2.0, 1.0, 3.0) LIMIT ?
  `, terms, [guildId], limit)) results.set(row.path, row);

  const short = terms.filter((t) => [...t].length < 3);
  if (results.size < limit && short.length > 0) {
    // 2文字の名前 (たこ 等) は trigram に引っかからない。ページ数は数千なので LIKE で足りる。
    const where = short.map(() => '(path LIKE ? OR summary LIKE ? OR aliases LIKE ? OR body LIKE ?)').join(' AND ');
    const params = short.flatMap((t) => { const p = `%${t.replace(/[%_]/g, '')}%`; return [p, p, p, p]; });
    for (const row of memoryDb().prepare(`SELECT path, summary, body FROM nodes WHERE guild_id = ? AND path <> '' AND ${where}
      ORDER BY (path LIKE ?) DESC, weight DESC LIMIT ?`).all(guildId, ...params, `%${short[0]}%`, limit)) {
      if (results.has(row.path)) continue;
      const at = row.body.indexOf(short[0]);
      results.set(row.path, { path: row.path, summary: row.summary, snippet: at < 0 ? '' : `…${row.body.slice(Math.max(0, at - 30), at + 50)}…` });
    }
  }
  return [...results.values()].slice(0, limit);
}

export function searchEpisodes(guildId, query, limit = 8) {
  const terms = splitTerms(query);
  const rows = ftsSearch(`
    SELECT e.id, e.kind, e.title, e.summary, e.at_ms FROM episodes_fts JOIN episodes e ON e.id = episodes_fts.rowid
    WHERE episodes_fts MATCH ? AND e.guild_id = ? ORDER BY bm25(episodes_fts, 3.0, 1.0, 2.0) LIMIT ?
  `, terms, [guildId], limit);
  const short = terms.filter((t) => [...t].length < 3);
  if (rows.length < limit && short.length > 0) {
    const where = short.map(() => '(title LIKE ? OR summary LIKE ? OR kind LIKE ?)').join(' AND ');
    const params = short.flatMap((t) => { const p = `%${t.replace(/[%_]/g, '')}%`; return [p, p, p]; });
    const seen = new Set(rows.map((row) => row.id));
    for (const row of memoryDb().prepare(`SELECT id, kind, title, summary, at_ms FROM episodes WHERE guild_id = ? AND ${where}
      ORDER BY importance DESC, at_ms DESC LIMIT ?`).all(guildId, ...params, limit)) {
      if (!seen.has(row.id)) rows.push(row);
    }
  }
  return rows.slice(0, limit);
}

// ---- 進み具合 -------------------------------------------------------------

export function getCursor(guildId, channelId) {
  return memoryDb().prepare('SELECT last_id, last_ms FROM cursors WHERE guild_id = ? AND channel_id = ?')
    .get(guildId, channelId) ?? null;
}

export function setCursor(guildId, channelId, lastId, lastMs) {
  memoryDb().prepare(`
    INSERT INTO cursors (guild_id, channel_id, last_id, last_ms) VALUES (?, ?, ?, ?)
    ON CONFLICT(guild_id, channel_id) DO UPDATE SET last_id = excluded.last_id, last_ms = excluded.last_ms
  `).run(guildId, channelId, lastId, lastMs);
}

export function recordSegment(guildId, segment, { status, model = null, error = null, now = Date.now() }) {
  memoryDb().prepare(`
    INSERT INTO segments (guild_id, channel_id, from_id, to_id, from_ms, to_ms, messages, chars, status, model, error, done_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(guild_id, channel_id, from_id) DO UPDATE SET
      to_id = excluded.to_id, to_ms = excluded.to_ms, messages = excluded.messages, chars = excluded.chars,
      status = excluded.status, model = excluded.model, error = excluded.error, done_at = excluded.done_at
  `).run(guildId, segment.channelId, segment.fromId, segment.toId, segment.fromMs, segment.toMs,
    segment.messages, segment.chars, status, model, error, now);
}

export function segmentStats(guildId) {
  return memoryDb().prepare(`
    SELECT status, COUNT(*) AS segments, COALESCE(SUM(messages), 0) AS messages, COALESCE(SUM(chars), 0) AS chars,
      MAX(to_ms) AS latest
    FROM segments WHERE guild_id = ? GROUP BY status
  `).all(guildId);
}

export function memoryCounts(guildId) {
  const d = memoryDb();
  return {
    pages: countNodes(guildId),
    episodes: d.prepare('SELECT COUNT(*) AS c FROM episodes WHERE guild_id = ?').get(guildId).c,
    links: d.prepare('SELECT COUNT(*) AS c FROM links WHERE guild_id = ?').get(guildId).c,
    pendingPages: d.prepare('SELECT COUNT(*) AS c FROM nodes WHERE guild_id = ? AND pending_count > 0').get(guildId).c,
    pendingChars: d.prepare('SELECT COALESCE(SUM(length(pending)), 0) AS c FROM nodes WHERE guild_id = ?').get(guildId).c
  };
}

export function getState(key) {
  const row = memoryDb().prepare('SELECT value FROM state WHERE key = ?').get(key);
  return row ? json(row.value, null) : null;
}

export function setState(key, value) {
  if (value === null || value === undefined) {
    memoryDb().prepare('DELETE FROM state WHERE key = ?').run(key);
    return;
  }
  memoryDb().prepare('INSERT INTO state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, JSON.stringify(value));
}

// ---- 公開チャンネルの控え --------------------------------------------------

export function savePublicChannels(guildId, channelIds, now = Date.now()) {
  const d = memoryDb();
  d.transaction(() => {
    d.prepare('DELETE FROM public_channels WHERE guild_id = ?').run(guildId);
    const insert = d.prepare('INSERT OR IGNORE INTO public_channels (guild_id, channel_id) VALUES (?, ?)');
    for (const id of channelIds) insert.run(guildId, String(id));
    setState(`public-channels:${guildId}`, { at: now, count: channelIds.length });
  })();
}

export function loadPublicChannels(guildId) {
  const meta = getState(`public-channels:${guildId}`);
  if (!meta) return null;
  const ids = memoryDb().prepare('SELECT channel_id FROM public_channels WHERE guild_id = ?').all(guildId)
    .map((row) => row.channel_id);
  return { at: meta.at, channelIds: ids };
}

export function includeChannel(guildId, channelId, by = null, now = Date.now()) {
  memoryDb().prepare(`
    INSERT INTO included_channels (guild_id, channel_id, added_by, added_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(guild_id, channel_id) DO NOTHING
  `).run(guildId, String(channelId), by, now);
}

export function removeIncluded(guildId, channelId) {
  return memoryDb().prepare('DELETE FROM included_channels WHERE guild_id = ? AND channel_id = ?')
    .run(guildId, String(channelId)).changes > 0;
}

export function includedChannels(guildId) {
  return memoryDb().prepare('SELECT channel_id FROM included_channels WHERE guild_id = ? ORDER BY added_at')
    .all(guildId).map((row) => row.channel_id);
}

/** 記憶を作り直す。原文 (アーカイブ) と公開チャンネルの控えには触らない。 */
export function resetTree(guildId) {
  const d = memoryDb();
  d.transaction(() => {
    for (const table of ['nodes', 'segments', 'cursors', 'links', 'episode_nodes', 'episode_links']) {
      d.prepare(`DELETE FROM ${table} WHERE guild_id = ?`).run(guildId);
    }
    d.prepare('DELETE FROM episodes WHERE guild_id = ?').run(guildId);
    d.prepare("DELETE FROM state WHERE key LIKE ? AND key NOT LIKE 'public-channels:%'").run(`%:${guildId}%`);
  })();
}
