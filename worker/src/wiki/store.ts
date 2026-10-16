import type { EpisodeBrief, EpisodeRow, NodeBrief, NodeRow, QuoteRow } from './types.ts';

// 記憶の本の読み取り。D1 への問い合わせだけを置き、HTML は作らない。
// 値はすべて bind で渡す (SQL に文字列を連結しない)。D1 は1回の問い合わせの bind が100個までなので、
// IN (...) は CHUNK 個ずつに分ける。

const CHUNK = 80;
const TZ_MS = 9 * 3_600_000;

export async function all<T>(db: D1Database, sql: string, ...binds: (string | number | null)[]): Promise<T[]> {
  const { results } = await db.prepare(sql).bind(...binds).all<T>();
  return results ?? [];
}

export async function one<T>(db: D1Database, sql: string, ...binds: (string | number | null)[]): Promise<T | null> {
  return db.prepare(sql).bind(...binds).first<T>();
}

const BRIEF = 'path, name, summary, child_count, episode_count, weight';
const EPISODE_BRIEF = 'id, kind, title, summary, at_ms, channel_name, importance';

// ---- 日付 (日本時間) ---------------------------------------------------------

export const jstDate = (ms: number): string => new Date(ms + TZ_MS).toISOString().slice(0, 10);
export const jstMonth = (ms: number): string => jstDate(ms).slice(0, 7);

/** 'YYYY-MM' の月の始まりと終わり (日本時間、ミリ秒)。形が違えば null。 */
export function monthRange(month: string): { start: number; end: number } | null {
  const match = /^(\d{4})-(\d{2})$/.exec(month);
  if (!match) return null;
  const year = Number(match[1]);
  const index = Number(match[2]) - 1;
  if (index < 0 || index > 11 || year < 2000 || year > 2100) return null;
  return { start: Date.UTC(year, index, 1) - TZ_MS, end: Date.UTC(year, index + 1, 1) - TZ_MS };
}

// ---- ページ -----------------------------------------------------------------

export const getNode = (db: D1Database, guild: string, path: string) =>
  one<NodeRow>(db, 'SELECT * FROM memory_nodes WHERE guild_id = ?1 AND path = ?2', guild, path);

export const getNodeById = (db: D1Database, guild: string, id: number) =>
  one<NodeRow>(db, 'SELECT * FROM memory_nodes WHERE guild_id = ?1 AND id = ?2', guild, id);

export const childrenOf = (db: D1Database, guild: string, path: string, limit = 60, offset = 0) =>
  all<NodeBrief>(db, `SELECT ${BRIEF} FROM memory_nodes WHERE guild_id = ?1 AND parent = ?2 ORDER BY weight DESC, name LIMIT ?3 OFFSET ?4`,
    guild, path, limit, offset);

export const topLevels = (db: D1Database, guild: string) => childrenOf(db, guild, '', 30);

/** パンくず用: 根を除く祖先を浅い順に。存在しない祖先は名前だけで返す。 */
export async function ancestorsOf(db: D1Database, guild: string, path: string): Promise<{ path: string; name: string; found: boolean }[]> {
  const parts = path.split('/');
  const paths = parts.slice(0, -1).map((_, index) => parts.slice(0, index + 1).join('/'));
  const found = new Map((await nodesByPaths(db, guild, paths)).map((row) => [row.path, row]));
  return paths.map((entry) => ({ path: entry, name: found.get(entry)?.name ?? entry.split('/').at(-1) ?? entry, found: found.has(entry) }));
}

export async function nodesByPaths(db: D1Database, guild: string, paths: readonly string[]): Promise<NodeBrief[]> {
  const out: NodeBrief[] = [];
  const unique = [...new Set(paths)];
  for (let start = 0; start < unique.length; start += CHUNK) {
    const part = unique.slice(start, start + CHUNK);
    out.push(...await all<NodeBrief>(db,
      `SELECT ${BRIEF} FROM memory_nodes WHERE guild_id = ?1 AND path IN (${part.map((_, index) => `?${index + 2}`).join(',')})`,
      guild, ...part));
  }
  return out;
}

/** パスが存在しないとき、同じ名前・別名のページが1つだけなら案内する先 (本文のリンクの書き間違いを救う)。 */
export async function guessNode(db: D1Database, guild: string, path: string): Promise<NodeBrief | null> {
  const name = path.split('/').at(-1) ?? '';
  if (!name) return null;
  const hits = await all<NodeBrief>(db,
    `SELECT ${BRIEF} FROM memory_nodes WHERE guild_id = ?1 AND (name = ?2 COLLATE NOCASE OR aliases LIKE ?3 ESCAPE '\\') LIMIT 3`,
    guild, name, `%"${likeEscape(name)}"%`);
  return hits.length === 1 ? hits[0] ?? null : null;
}

/** つながりの強いページ (同じ出来事に出る・本文でリンクされる)。 */
export const neighborsOf = (db: D1Database, guild: string, path: string, limit = 12) =>
  all<NodeBrief & { link_weight: number }>(db,
    `SELECT n.path, n.name, n.summary, n.child_count, n.episode_count, n.weight, l.weight AS link_weight
     FROM memory_links l JOIN memory_nodes n ON n.guild_id = l.guild_id AND n.path = l.dst
     WHERE l.guild_id = ?1 AND l.src = ?2 ORDER BY l.weight DESC LIMIT ?3`, guild, path, limit);

export const recentNodes = (db: D1Database, guild: string, limit = 8) =>
  all<NodeBrief & { updated_at: number }>(db,
    `SELECT ${BRIEF}, updated_at FROM memory_nodes WHERE guild_id = ?1 AND depth >= 2 AND body <> '' ORDER BY updated_at DESC LIMIT ?2`, guild, limit);

export const popularNodes = (db: D1Database, guild: string, limit = 8) =>
  all<NodeBrief>(db,
    `SELECT ${BRIEF} FROM memory_nodes WHERE guild_id = ?1 AND depth >= 2 AND body <> '' ORDER BY episode_count DESC, weight DESC LIMIT ?2`, guild, limit);

export async function randomPath(db: D1Database, guild: string): Promise<string | null> {
  const row = await one<{ path: string }>(db,
    "SELECT path FROM memory_nodes WHERE guild_id = ?1 AND depth >= 2 AND body <> '' ORDER BY RANDOM() LIMIT 1", guild);
  return row?.path ?? null;
}

// ---- 出来事 -----------------------------------------------------------------

export const getEpisode = (db: D1Database, guild: string, id: number) =>
  one<EpisodeRow>(db, 'SELECT * FROM memory_episodes WHERE guild_id = ?1 AND id = ?2', guild, id);

export const quotesOf = (db: D1Database, guild: string, id: number) =>
  all<QuoteRow>(db,
    `SELECT message_id, channel_id, author_name, content, created_at, highlight FROM memory_quotes
     WHERE guild_id = ?1 AND episode_id = ?2 ORDER BY highlight DESC, created_at`, guild, id);

export const episodeNodes = (db: D1Database, guild: string, id: number) =>
  all<NodeBrief>(db,
    `SELECT n.path, n.name, n.summary, n.child_count, n.episode_count, n.weight
     FROM memory_episode_nodes en JOIN memory_nodes n ON n.guild_id = en.guild_id AND n.path = en.path
     WHERE en.guild_id = ?1 AND en.episode_id = ?2 ORDER BY n.depth, n.name`, guild, id);

/** 筋: この出来事より前 (原因・前振り) と後 (続き)。 */
export async function episodeNeighbors(db: D1Database, guild: string, id: number) {
  const [before, after] = await Promise.all([
    all<EpisodeBrief>(db,
      `SELECT ${EPISODE_BRIEF.split(', ').map((column) => `e.${column}`).join(', ')} FROM memory_episode_links l
       JOIN memory_episodes e ON e.guild_id = l.guild_id AND e.id = l.to_id
       WHERE l.guild_id = ?1 AND l.from_id = ?2 ORDER BY e.at_ms`, guild, id),
    all<EpisodeBrief>(db,
      `SELECT ${EPISODE_BRIEF.split(', ').map((column) => `e.${column}`).join(', ')} FROM memory_episode_links l
       JOIN memory_episodes e ON e.guild_id = l.guild_id AND e.id = l.from_id
       WHERE l.guild_id = ?1 AND l.to_id = ?2 ORDER BY e.at_ms`, guild, id)
  ]);
  return { before, after };
}

export async function episodesByIds(db: D1Database, guild: string, ids: readonly number[]): Promise<EpisodeBrief[]> {
  const out: EpisodeBrief[] = [];
  const unique = [...new Set(ids)];
  for (let start = 0; start < unique.length; start += CHUNK) {
    const part = unique.slice(start, start + CHUNK);
    out.push(...await all<EpisodeBrief>(db,
      `SELECT ${EPISODE_BRIEF} FROM memory_episodes WHERE guild_id = ?1 AND id IN (${part.map((_, index) => `?${index + 2}`).join(',')})`,
      guild, ...part));
  }
  return out;
}

export interface TimelineOptions {
  kind?: string;
  order?: 'new' | 'old';
  limit?: number;
  offset?: number;
}

/** ページ (と子ページ) に関わる出来事のうち、絞り込みに合うものの条件。根 ('') は全部。 */
function scope(guild: string, path: string, kind: string): { where: string; binds: (string | number)[] } {
  const binds: (string | number)[] = [guild];
  let where = 'e.guild_id = ?1';
  if (path) {
    // path = ? OR path が「path/」で始まる。LIKE より範囲の比較の方が索引に乗る ('0' は '/' の次の文字)
    binds.push(path, `${path}/`, `${path}0`);
    where += ` AND e.id IN (SELECT episode_id FROM memory_episode_nodes WHERE guild_id = ?1 AND (path = ?2 OR (path >= ?3 AND path < ?4)))`;
  }
  if (kind) {
    binds.push(kind);
    where += ` AND e.kind = ?${binds.length}`;
  }
  return { where, binds };
}

export async function episodesFor(db: D1Database, guild: string, path: string, options: TimelineOptions = {}) {
  const { where, binds } = scope(guild, path, options.kind ?? '');
  const limit = Math.min(Math.max(options.limit ?? 30, 1), 100);
  const offset = Math.max(options.offset ?? 0, 0);
  const [rows, total] = await Promise.all([
    all<EpisodeBrief>(db,
      `SELECT ${EPISODE_BRIEF.split(', ').map((column) => `e.${column}`).join(', ')} FROM memory_episodes e WHERE ${where}
       ORDER BY e.at_ms ${options.order === 'old' ? 'ASC' : 'DESC'}, e.id LIMIT ?${binds.length + 1} OFFSET ?${binds.length + 2}`,
      ...binds, limit, offset),
    one<{ n: number }>(db, `SELECT COUNT(*) AS n FROM memory_episodes e WHERE ${where}`, ...binds)
  ]);
  return { rows, total: total?.n ?? 0 };
}

/** 種類ごとの件数 (年表の絞り込みに出す) */
export async function kindCounts(db: D1Database, guild: string, path: string): Promise<{ kind: string; n: number }[]> {
  const { where, binds } = scope(guild, path, '');
  return all<{ kind: string; n: number }>(db,
    `SELECT e.kind AS kind, COUNT(*) AS n FROM memory_episodes e WHERE ${where} GROUP BY e.kind ORDER BY n DESC LIMIT 12`, ...binds);
}

export const recentEpisodes = (db: D1Database, guild: string, limit = 10) =>
  episodesFor(db, guild, '', { limit }).then((result) => result.rows);

export async function monthCounts(db: D1Database, guild: string): Promise<{ month: string; n: number }[]> {
  return all<{ month: string; n: number }>(db,
    `SELECT strftime('%Y-%m', at_ms / 1000 + 32400, 'unixepoch') AS month, COUNT(*) AS n
     FROM memory_episodes WHERE guild_id = ?1 GROUP BY month ORDER BY month`, guild);
}

export async function episodesInMonth(db: D1Database, guild: string, month: string, options: { kind?: string; limit?: number; offset?: number } = {}) {
  const range = monthRange(month);
  if (!range) return { rows: [] as EpisodeBrief[], total: 0 };
  const kind = options.kind ?? '';
  const binds: (string | number)[] = [guild, range.start, range.end];
  if (kind) binds.push(kind);
  const where = `guild_id = ?1 AND at_ms >= ?2 AND at_ms < ?3${kind ? ' AND kind = ?4' : ''}`;
  const limit = Math.min(Math.max(options.limit ?? 100, 1), 200);
  const [rows, total] = await Promise.all([
    all<EpisodeBrief>(db, `SELECT ${EPISODE_BRIEF} FROM memory_episodes WHERE ${where} ORDER BY at_ms, id LIMIT ?${binds.length + 1} OFFSET ?${binds.length + 2}`,
      ...binds, limit, Math.max(options.offset ?? 0, 0)),
    one<{ n: number }>(db, `SELECT COUNT(*) AS n FROM memory_episodes WHERE ${where}`, ...binds)
  ]);
  return { rows, total: total?.n ?? 0 };
}

/** その月の種類ごとの件数 (絞り込みに出す) */
export async function monthKinds(db: D1Database, guild: string, month: string): Promise<{ kind: string; n: number }[]> {
  const range = monthRange(month);
  if (!range) return [];
  return all<{ kind: string; n: number }>(db,
    'SELECT kind, COUNT(*) AS n FROM memory_episodes WHERE guild_id = ?1 AND at_ms >= ?2 AND at_ms < ?3 GROUP BY kind ORDER BY n DESC LIMIT 12', guild, range.start, range.end);
}

// ---- 検索 -------------------------------------------------------------------

export const likeEscape = (text: string): string => text.replace(/[\\%_]/g, (character) => `\\${character}`);

/** 検索語を分ける。3文字以上は全文検索 (trigram)、それ未満は LIKE。 */
export function searchTerms(query: string): { long: string[]; short: string[] } {
  const terms = [...new Set(query.replace(/[\u0000-\u001f]/g, ' ').split(/[\s　、。,，]+/).map((term) => term.trim()).filter(Boolean))].slice(0, 6);
  return {
    long: terms.filter((term) => [...term].length >= 3),
    short: terms.filter((term) => [...term].length < 3)
  };
}

const ftsPhrase = (term: string): string => `"${term.replaceAll('"', '""')}"`;

export interface NodeHit extends NodeBrief {
  snippet: string;
}
export interface EpisodeHit extends EpisodeBrief {
  snippet: string;
}

export async function searchNodes(db: D1Database, guild: string, query: string, limit = 30): Promise<NodeHit[]> {
  const { long, short } = searchTerms(query);
  if (!long.length && !short.length) return [];
  const binds: (string | number)[] = [guild];
  const likes = short.map((term) => {
    binds.push(`%${likeEscape(term)}%`);
    const at = `?${binds.length}`;
    return `(n.name LIKE ${at} ESCAPE '\\' OR n.summary LIKE ${at} ESCAPE '\\' OR n.aliases LIKE ${at} ESCAPE '\\' OR n.body LIKE ${at} ESCAPE '\\')`;
  });
  if (long.length) {
    binds.push(long.map(ftsPhrase).join(' '));
    const match = `?${binds.length}`;
    binds.push(limit);
    return all<NodeHit>(db,
      `SELECT n.path, n.name, n.summary, n.child_count, n.episode_count, n.weight,
         snippet(memory_nodes_fts, 2, char(2), char(3), '…', 24) AS snippet
       FROM memory_nodes_fts JOIN memory_nodes n ON n.rowid = memory_nodes_fts.rowid
       WHERE memory_nodes_fts MATCH ${match} AND n.guild_id = ?1${likes.map((like) => ` AND ${like}`).join('')} AND n.path <> ''
       ORDER BY bm25(memory_nodes_fts, 4.0, 2.0, 1.0, 3.0) LIMIT ?${binds.length}`, ...binds);
  }
  binds.push(limit);
  return all<NodeHit>(db,
    `SELECT n.path, n.name, n.summary, n.child_count, n.episode_count, n.weight, '' AS snippet FROM memory_nodes n
     WHERE n.guild_id = ?1 AND n.path <> ''${likes.map((like) => ` AND ${like}`).join('')}
     ORDER BY (n.name LIKE ?2 ESCAPE '\\') DESC, n.episode_count DESC LIMIT ?${binds.length}`, ...binds);
}

export async function searchEpisodes(db: D1Database, guild: string, query: string, limit = 30): Promise<EpisodeHit[]> {
  const { long, short } = searchTerms(query);
  if (!long.length && !short.length) return [];
  const binds: (string | number)[] = [guild];
  const likes = short.map((term) => {
    binds.push(`%${likeEscape(term)}%`);
    const at = `?${binds.length}`;
    return `(e.title LIKE ${at} ESCAPE '\\' OR e.summary LIKE ${at} ESCAPE '\\' OR e.kind LIKE ${at} ESCAPE '\\')`;
  });
  const columns = EPISODE_BRIEF.split(', ').map((column) => `e.${column}`).join(', ');
  if (long.length) {
    binds.push(long.map(ftsPhrase).join(' '));
    const match = `?${binds.length}`;
    binds.push(limit);
    return all<EpisodeHit>(db,
      `SELECT ${columns}, snippet(memory_episodes_fts, 1, char(2), char(3), '…', 24) AS snippet
       FROM memory_episodes_fts JOIN memory_episodes e ON e.rowid = memory_episodes_fts.rowid
       WHERE memory_episodes_fts MATCH ${match} AND e.guild_id = ?1${likes.map((like) => ` AND ${like}`).join('')}
       ORDER BY bm25(memory_episodes_fts, 3.0, 1.0, 2.0), e.at_ms DESC LIMIT ?${binds.length}`, ...binds);
  }
  binds.push(limit);
  return all<EpisodeHit>(db,
    `SELECT ${columns}, '' AS snippet FROM memory_episodes e
     WHERE e.guild_id = ?1${likes.map((like) => ` AND ${like}`).join('')} ORDER BY e.importance DESC, e.at_ms DESC LIMIT ?${binds.length}`, ...binds);
}

// ---- 全体の数字 ---------------------------------------------------------------

export interface SiteStats {
  pages: number;
  episodes: number;
  quotes: number;
  firstAt: number | null;
  lastAt: number | null;
  syncedAt: number | null;
}

export async function siteStats(db: D1Database, guild: string): Promise<SiteStats> {
  const [counts, meta] = await Promise.all([
    one<{ pages: number; episodes: number; first_at: number | null; last_at: number | null }>(db,
      `SELECT (SELECT COUNT(*) FROM memory_nodes WHERE guild_id = ?1 AND path <> '') AS pages,
              COUNT(*) AS episodes, MIN(at_ms) AS first_at, MAX(at_ms) AS last_at
       FROM memory_episodes WHERE guild_id = ?1`, guild),
    one<{ value: string }>(db, "SELECT value FROM memory_meta WHERE guild_id = ?1 AND key = 'synced_at'", guild)
  ]);
  return {
    pages: counts?.pages ?? 0,
    episodes: counts?.episodes ?? 0,
    quotes: 0,
    firstAt: counts?.first_at ?? null,
    lastAt: counts?.last_at ?? null,
    syncedAt: meta ? Number(meta.value) || null : null
  };
}
