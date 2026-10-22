import { memoryGuilds } from './links.ts';
import { GUILD_ID } from './links.ts';
import * as store from './store.ts';
import { SITE_ACCESS, type EpisodePayload, type Env, type NodePayload } from './types.ts';

// bot (builder の後に動く memory-site-sync) から記憶を受け取る口。
//   GET  /v1/memory/hashes?guild=ID      いま持っている行の content_hash (差分を取るため)
//   POST /v1/memory/batch                ページと出来事を入れ替える (複数件)
//   POST /v1/memory/prune                bot で消えた行を消す
//   POST /v1/memory/finish               同期の終わりを記録する (孤児の掃除つき)
// どれも Bearer トークンが要る。受け取った値は1つずつ検証して作り直し、想定外の項目は捨てる。
// 1回の要求の SQL は json_each で行をまとめて入れるので、件数が増えても文の数は変わらない
// (Workers の無料枠は1回の呼び出しで D1 に投げられる文が 50 まで)。

const MAX_BODY_BYTES = 1_800_000;
const MAX_ITEMS = 400;

export class BadRequest extends Error {}

function secretEquals(left: string, right: string): boolean {
  const a = new TextEncoder().encode(left);
  const b = new TextEncoder().encode(right);
  let diff = a.length ^ b.length;
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) diff |= (a[index] ?? 0) ^ (b[index] ?? 0);
  return diff === 0;
}

export function authorized(request: Request, env: Env): boolean {
  const header = request.headers.get('authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  return Boolean(env.GOVERNANCE_LAW_API_TOKEN) && secretEquals(token, env.GOVERNANCE_LAW_API_TOKEN ?? '');
}

const json = (value: unknown, status = 200): Response =>
  new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });

// ---- 検証 -------------------------------------------------------------------

type Rec = Record<string, unknown>;

function record(value: unknown, name: string): Rec {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new BadRequest(`${name} が object ではありません`);
  return value as Rec;
}

function str(value: unknown, name: string, max: number, options: { empty?: boolean } = {}): string {
  if (typeof value !== 'string' || value.length > max || (!options.empty && !value.trim())) throw new BadRequest(`${name} が不正です`);
  return value;
}

function int(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw new BadRequest(`${name} が不正です`);
  return value;
}

function optionalInt(value: unknown, name: string): number | null {
  return value === null || value === undefined ? null : int(value, name);
}

function array(value: unknown, name: string, max: number): unknown[] {
  if (!Array.isArray(value) || value.length > max) throw new BadRequest(`${name} が配列ではないか多すぎます`);
  return value;
}

export function parseNode(value: unknown): NodePayload {
  const o = record(value, 'node');
  const path = str(o.path, 'path', 300, { empty: true });
  return {
    id: int(o.id, 'id'),
    path,
    parent: o.parent === null || o.parent === undefined ? null : str(o.parent, 'parent', 300, { empty: true }),
    name: str(o.name, 'name', 120, { empty: true }),
    depth: int(o.depth, 'depth'),
    summary: str(o.summary ?? '', 'summary', 600, { empty: true }),
    body: str(o.body ?? '', 'body', 60_000, { empty: true }),
    pending: str(o.pending ?? '', 'pending', 40_000, { empty: true }),
    pendingCount: int(o.pendingCount ?? 0, 'pendingCount'),
    aliases: array(o.aliases ?? [], 'aliases', 30).map((alias) => str(alias, 'alias', 100)),
    weight: int(o.weight ?? 0, 'weight'),
    firstAt: optionalInt(o.firstAt, 'firstAt'),
    lastAt: optionalInt(o.lastAt, 'lastAt'),
    updatedAt: int(o.updatedAt, 'updatedAt'),
    childCount: int(o.childCount ?? 0, 'childCount'),
    episodeCount: int(o.episodeCount ?? 0, 'episodeCount'),
    links: array(o.links ?? [], 'links', 40).map((link) => {
      const l = record(link, 'link');
      return { dst: str(l.dst, 'dst', 300), weight: int(l.weight ?? 0, 'link weight') };
    }),
    contentHash: str(o.contentHash, 'contentHash', 64)
  };
}

export function parseEpisode(value: unknown): EpisodePayload {
  const o = record(value, 'episode');
  return {
    id: int(o.id, 'id'),
    kind: str(o.kind ?? '', 'kind', 40, { empty: true }),
    title: str(o.title, 'title', 200),
    summary: str(o.summary, 'summary', 1500),
    channelId: str(o.channelId, 'channelId', 32),
    channelName: str(o.channelName ?? '', 'channelName', 100, { empty: true }),
    atMs: int(o.atMs, 'atMs'),
    endMs: int(o.endMs, 'endMs'),
    importance: int(o.importance ?? 2, 'importance'),
    sourceCount: int(o.sourceCount ?? 0, 'sourceCount'),
    hiddenQuotes: int(o.hiddenQuotes ?? 0, 'hiddenQuotes'),
    nodes: array(o.nodes ?? [], 'nodes', 40).map((path) => str(path, 'node path', 300)),
    before: array(o.before ?? [], 'before', 40).map((id) => int(id, 'before id')),
    quotes: array(o.quotes ?? [], 'quotes', 30).map((quote) => {
      const q = record(quote, 'quote');
      return {
        messageId: str(q.messageId, 'messageId', 32),
        channelId: str(q.channelId, 'quote channelId', 32),
        authorName: str(q.authorName, 'authorName', 80, { empty: true }),
        content: str(q.content, 'content', 1200, { empty: true }),
        createdAt: int(q.createdAt, 'createdAt'),
        highlight: q.highlight === true
      };
    }),
    contentHash: str(o.contentHash, 'contentHash', 64)
  };
}

// ---- 書き込み ---------------------------------------------------------------

export async function writeNodes(db: D1Database, guild: string, nodes: readonly NodePayload[]): Promise<void> {
  if (!nodes.length) return;
  // aliases は配列のまま渡し、json_extract が JSON 文字列として取り出す
  const payload = JSON.stringify(nodes);
  await db.batch([
    // 同じパスを別の id のページが持っていたら (ページの移動・統合)、古い方を先に消す
    db.prepare(`DELETE FROM memory_nodes WHERE guild_id = ?1 AND EXISTS (
      SELECT 1 FROM json_each(?2) j WHERE json_extract(j.value, '$.path') = memory_nodes.path AND json_extract(j.value, '$.id') <> memory_nodes.id)`).bind(guild, payload),
    db.prepare(`INSERT INTO memory_nodes (guild_id, id, path, parent, name, depth, summary, body, pending, pending_count, aliases, weight,
        first_at, last_at, updated_at, child_count, episode_count, content_hash)
      SELECT ?1, json_extract(value, '$.id'), json_extract(value, '$.path'), json_extract(value, '$.parent'), json_extract(value, '$.name'),
        json_extract(value, '$.depth'), json_extract(value, '$.summary'), json_extract(value, '$.body'), json_extract(value, '$.pending'),
        json_extract(value, '$.pendingCount'), json_extract(value, '$.aliases'), json_extract(value, '$.weight'), json_extract(value, '$.firstAt'),
        json_extract(value, '$.lastAt'), json_extract(value, '$.updatedAt'), json_extract(value, '$.childCount'), json_extract(value, '$.episodeCount'),
        json_extract(value, '$.contentHash')
      FROM json_each(?2) WHERE true
      ON CONFLICT (guild_id, id) DO UPDATE SET path = excluded.path, parent = excluded.parent, name = excluded.name, depth = excluded.depth,
        summary = excluded.summary, body = excluded.body, pending = excluded.pending, pending_count = excluded.pending_count,
        aliases = excluded.aliases, weight = excluded.weight, first_at = excluded.first_at, last_at = excluded.last_at,
        updated_at = excluded.updated_at, child_count = excluded.child_count, episode_count = excluded.episode_count,
        content_hash = excluded.content_hash`).bind(guild, payload),
    db.prepare(`DELETE FROM memory_links WHERE guild_id = ?1 AND src IN (SELECT json_extract(value, '$.path') FROM json_each(?2))`).bind(guild, payload),
    db.prepare(`INSERT OR REPLACE INTO memory_links (guild_id, src, dst, weight)
      SELECT ?1, json_extract(n.value, '$.path'), json_extract(l.value, '$.dst'), json_extract(l.value, '$.weight')
      FROM json_each(?2) n, json_each(n.value, '$.links') l`).bind(guild, payload)
  ]);
}

export async function writeEpisodes(db: D1Database, guild: string, episodes: readonly EpisodePayload[]): Promise<void> {
  if (!episodes.length) return;
  const payload = JSON.stringify(episodes);
  const ids = JSON.stringify(episodes.map((episode) => episode.id));
  await db.batch([
    db.prepare('DELETE FROM memory_episode_nodes WHERE guild_id = ?1 AND episode_id IN (SELECT value FROM json_each(?2))').bind(guild, ids),
    db.prepare('DELETE FROM memory_episode_links WHERE guild_id = ?1 AND from_id IN (SELECT value FROM json_each(?2))').bind(guild, ids),
    db.prepare('DELETE FROM memory_quotes WHERE guild_id = ?1 AND episode_id IN (SELECT value FROM json_each(?2))').bind(guild, ids),
    db.prepare(`INSERT INTO memory_episodes (guild_id, id, kind, title, summary, channel_id, channel_name, at_ms, end_ms, importance,
        source_count, hidden_quotes, content_hash)
      SELECT ?1, json_extract(value, '$.id'), json_extract(value, '$.kind'), json_extract(value, '$.title'), json_extract(value, '$.summary'),
        json_extract(value, '$.channelId'), json_extract(value, '$.channelName'), json_extract(value, '$.atMs'), json_extract(value, '$.endMs'),
        json_extract(value, '$.importance'), json_extract(value, '$.sourceCount'), json_extract(value, '$.hiddenQuotes'), json_extract(value, '$.contentHash')
      FROM json_each(?2) WHERE true
      ON CONFLICT (guild_id, id) DO UPDATE SET kind = excluded.kind, title = excluded.title, summary = excluded.summary,
        channel_id = excluded.channel_id, channel_name = excluded.channel_name, at_ms = excluded.at_ms, end_ms = excluded.end_ms,
        importance = excluded.importance, source_count = excluded.source_count, hidden_quotes = excluded.hidden_quotes,
        content_hash = excluded.content_hash`).bind(guild, payload),
    db.prepare(`INSERT OR IGNORE INTO memory_episode_nodes (guild_id, episode_id, path)
      SELECT ?1, json_extract(e.value, '$.id'), n.value FROM json_each(?2) e, json_each(e.value, '$.nodes') n`).bind(guild, payload),
    db.prepare(`INSERT OR IGNORE INTO memory_episode_links (guild_id, from_id, to_id)
      SELECT ?1, json_extract(e.value, '$.id'), b.value FROM json_each(?2) e, json_each(e.value, '$.before') b`).bind(guild, payload),
    db.prepare(`INSERT OR REPLACE INTO memory_quotes (guild_id, episode_id, message_id, channel_id, author_name, content, created_at, highlight)
      SELECT ?1, json_extract(e.value, '$.id'), json_extract(q.value, '$.messageId'), json_extract(q.value, '$.channelId'),
        json_extract(q.value, '$.authorName'), json_extract(q.value, '$.content'), json_extract(q.value, '$.createdAt'), json_extract(q.value, '$.highlight')
      FROM json_each(?2) e, json_each(e.value, '$.quotes') q`).bind(guild, payload)
  ]);
}

export async function prune(db: D1Database, guild: string, nodeIds: readonly number[], episodeIds: readonly number[]): Promise<void> {
  const nodes = JSON.stringify(nodeIds);
  const episodes = JSON.stringify(episodeIds);
  await db.batch([
    db.prepare('DELETE FROM memory_nodes WHERE guild_id = ?1 AND id IN (SELECT value FROM json_each(?2))').bind(guild, nodes),
    db.prepare('DELETE FROM memory_episode_nodes WHERE guild_id = ?1 AND episode_id IN (SELECT value FROM json_each(?2))').bind(guild, episodes),
    db.prepare('DELETE FROM memory_episode_links WHERE guild_id = ?1 AND (from_id IN (SELECT value FROM json_each(?2)) OR to_id IN (SELECT value FROM json_each(?2)))').bind(guild, episodes),
    db.prepare('DELETE FROM memory_quotes WHERE guild_id = ?1 AND episode_id IN (SELECT value FROM json_each(?2))').bind(guild, episodes),
    db.prepare('DELETE FROM memory_episodes WHERE guild_id = ?1 AND id IN (SELECT value FROM json_each(?2))').bind(guild, episodes)
  ]);
}

/** 同期の終わり。消えたページに残った行 (つながり・出来事との結び目) を掃除し、同期した時刻を記録する。 */
export async function finish(db: D1Database, guild: string, now: number): Promise<void> {
  await db.batch([
    db.prepare('DELETE FROM memory_links WHERE guild_id = ?1 AND (src NOT IN (SELECT path FROM memory_nodes WHERE guild_id = ?1) OR dst NOT IN (SELECT path FROM memory_nodes WHERE guild_id = ?1))').bind(guild),
    db.prepare('DELETE FROM memory_episode_nodes WHERE guild_id = ?1 AND path NOT IN (SELECT path FROM memory_nodes WHERE guild_id = ?1)').bind(guild),
    db.prepare("INSERT INTO memory_meta (guild_id, key, value) VALUES (?1, 'synced_at', ?2) ON CONFLICT (guild_id, key) DO UPDATE SET value = excluded.value").bind(guild, String(now))
  ]);
}

// ---- ルート -----------------------------------------------------------------

async function readJson(request: Request): Promise<Rec> {
  const length = Number(request.headers.get('content-length') ?? 0);
  if (length > MAX_BODY_BYTES) throw new BadRequest('本文が大きすぎます');
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) throw new BadRequest('本文が大きすぎます');
  try {
    return record(JSON.parse(text), 'body');
  } catch (error) {
    throw error instanceof BadRequest ? error : new BadRequest('JSON ではありません');
  }
}

/** 送ってよいのは、サイトが見せているサーバー (MEMORY_GUILD_IDS) だけ。 */
function guildOf(value: unknown, env: Env): string {
  const guild = str(value, 'guildId', 32);
  if (!GUILD_ID.test(guild)) throw new BadRequest('guildId が不正です');
  if (!memoryGuilds(env).includes(guild)) throw new BadRequest('このサーバーはサイトに載せていません');
  return guild;
}

export async function handleIngest(request: Request, env: Env, now = Date.now()): Promise<Response> {
  if (!authorized(request, env)) return json({ error: 'unauthorized' }, 401);
  const url = new URL(request.url);
  try {
    if (request.method === 'GET' && url.pathname === '/v1/memory/hashes') {
      const guild = guildOf(url.searchParams.get('guild'), env);
      const [nodes, episodes] = await Promise.all([
        env.LAWS.prepare('SELECT id, content_hash AS hash FROM memory_nodes WHERE guild_id = ?1').bind(guild).all<{ id: number; hash: string }>(),
        env.LAWS.prepare('SELECT id, content_hash AS hash FROM memory_episodes WHERE guild_id = ?1').bind(guild).all<{ id: number; hash: string }>()
      ]);
      const toMap = (rows: { id: number; hash: string }[] | undefined) => Object.fromEntries((rows ?? []).map((row) => [String(row.id), row.hash]));
      return json({ nodes: toMap(nodes.results), episodes: toMap(episodes.results) });
    }
    // 公開状態 (off / members / public)。取り込みと同じ Bearer。off の間も、取り込みは受け付ける
    if (request.method === 'GET' && url.pathname === '/v1/memory/access') {
      const guild = guildOf(url.searchParams.get('guild'), env);
      return json({ guildId: guild, access: await store.siteAccess(env.LAWS, guild), default: env.MEMORY_ACCESS === 'public' ? 'public' : 'members' });
    }
    if (request.method !== 'POST') return json({ error: 'method not allowed' }, 405);
    const body = await readJson(request);
    const guild = guildOf(body.guildId, env);
    if (url.pathname === '/v1/memory/access') {
      const access = SITE_ACCESS.find((value) => value === body.access);
      if (!access) throw new BadRequest('access は off / members / public のどれかです');
      const by = typeof body.by === 'string' && body.by.length <= 64 ? body.by : null;
      await store.setSiteAccess(env.LAWS, guild, access, by, now);
      return json({ ok: true, guildId: guild, access });
    }
    if (url.pathname === '/v1/memory/batch') {
      const nodes = array(body.nodes ?? [], 'nodes', MAX_ITEMS).map(parseNode);
      const episodes = array(body.episodes ?? [], 'episodes', MAX_ITEMS).map(parseEpisode);
      await writeNodes(env.LAWS, guild, nodes);
      await writeEpisodes(env.LAWS, guild, episodes);
      return json({ ok: true, nodes: nodes.length, episodes: episodes.length });
    }
    if (url.pathname === '/v1/memory/prune') {
      const nodeIds = array(body.nodeIds ?? [], 'nodeIds', 5000).map((id) => int(id, 'nodeId'));
      const episodeIds = array(body.episodeIds ?? [], 'episodeIds', 5000).map((id) => int(id, 'episodeId'));
      await prune(env.LAWS, guild, nodeIds, episodeIds);
      return json({ ok: true, nodes: nodeIds.length, episodes: episodeIds.length });
    }
    if (url.pathname === '/v1/memory/finish') {
      await finish(env.LAWS, guild, now);
      return json({ ok: true });
    }
    return json({ error: 'not found' }, 404);
  } catch (error) {
    if (error instanceof BadRequest) return json({ error: error.message }, 400);
    console.error('memory ingest failed:', error);
    return json({ error: 'internal error' }, 500);
  }
}
