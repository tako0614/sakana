import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';
import 'dotenv/config';
import { siteGuilds } from '../src/memory/site.js';

// 記憶を公開サイト (Worker + D1) へ送る。builder の後に timer から動かす (deploy/sakana-memory-site.*)。
//
//   tsx scripts/memory-site-sync.ts [--dry-run] [--out FILE] [--from FILE]
//
// 手順: memory.sqlite を読んでページと出来事の写しを作る → サイトが持っている行の content_hash と比べる →
// 変わった行だけ送る → bot で消えた行をサイトからも消す → 終わりを記録する。サイトを空にしても、次の回に全部送り直す。
//
// 設定 (未設定なら何もしない。開発機では設定しなくてよい):
//   MEMORY_SITE_URL    サイトの origin。無ければ GOVERNANCE_LAW_API_URL (法令集と同じ Worker)
//   MEMORY_SITE_TOKEN  Bearer トークン。無ければ GOVERNANCE_LAW_API_TOKEN
//   MEMORY_SITE_GUILDS 送るサーバー (カンマ区切り。無ければ MEMORY_TREE_GUILD)。サーバーごとに別々に送る。
//                      Worker の MEMORY_GUILD_IDS に無いサーバーはサイトが受け取らない
//
// 引用 (出来事の根拠の発言の原文) は、全員に見えるチャンネルのものだけを送る:
//   公開チャンネルの控え − /memory include で足した (@everyone に見えない) チャンネル − NSFW っぽい名前のチャンネル。
//   送らなかった発言は件数だけ送り、サイトに「載せていない」と出す。

export interface NodePayload {
  id: number;
  path: string;
  parent: string | null;
  name: string;
  depth: number;
  summary: string;
  body: string;
  pending: string;
  pendingCount: number;
  aliases: string[];
  weight: number;
  firstAt: number | null;
  lastAt: number | null;
  updatedAt: number;
  childCount: number;
  episodeCount: number;
  links: { dst: string; weight: number }[];
  contentHash: string;
}

export interface QuotePayload {
  messageId: string;
  channelId: string;
  authorName: string;
  content: string;
  createdAt: number;
  highlight: boolean;
}

export interface EpisodePayload {
  id: number;
  kind: string;
  title: string;
  summary: string;
  channelId: string;
  channelName: string;
  atMs: number;
  endMs: number;
  importance: number;
  sourceCount: number;
  hiddenQuotes: number;
  nodes: string[];
  before: number[];
  quotes: QuotePayload[];
  contentHash: string;
}

export interface Snapshot {
  nodes: NodePayload[];
  episodes: EpisodePayload[];
}

interface NodeRow {
  id: number;
  path: string;
  parent: string | null;
  summary: string;
  body: string;
  aliases: string;
  pending: string;
  pending_count: number;
  weight: number;
  first_at: number | null;
  last_at: number | null;
  updated_at: number;
}

interface EpisodeRow {
  id: number;
  kind: string;
  title: string;
  summary: string;
  highlights: string;
  channel_id: string;
  at_ms: number;
  end_ms: number;
  sources: string;
  importance: number;
}

interface MessageRow {
  message_id: string;
  channel_id: string;
  author_name: string;
  content: string;
  created_at: number;
}

export interface BuildOptions {
  /** 引用を載せないチャンネル名 (NSFW など) */
  hiddenChannelName?: RegExp;
  maxPending?: number;
  maxQuotes?: { highlights: number; evidence: number };
}

const DEFAULT_HIDDEN = /nsfw|r-?18|18禁|えっち|エッチ/i;
const CHUNK = 400;

const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16);

function jsonArray(text: string): unknown[] {
  try {
    const parsed: unknown = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

const stringIds = (values: unknown[]): string[] => values.filter((value): value is string => typeof value === 'string' || typeof value === 'number').map(String);

/** 発言の中のメンションなどを、サイトで読める形にする (ID のままだと意味が分からない)。 */
export function cleanContent(text: string, max = 400): string {
  const cleaned = text
    .replace(/<@&\d+>/g, '@ロール')
    .replace(/<@!?\d+>/g, '@ユーザー')
    .replace(/<#\d+>/g, '#チャンネル')
    .replace(/<a?:(\w+):\d+>/g, ':$1:')
    .replace(/\r\n?/g, '\n')
    .trim();
  return cleaned.length > max ? `${cleaned.slice(0, max - 1)}…` : cleaned;
}

/** 親の連鎖 (自分も含む)。'a/b/c' → ['a/b/c', 'a/b', 'a', '']。 */
function lineage(path: string): string[] {
  const out = [path];
  let current = path;
  while (current) {
    current = current.includes('/') ? current.slice(0, current.lastIndexOf('/')) : '';
    out.push(current);
  }
  return out;
}

export function buildSnapshot(memory: Database.Database, archive: Database.Database, guildId: string, options: BuildOptions = {}): Snapshot {
  const hiddenName = options.hiddenChannelName ?? DEFAULT_HIDDEN;
  const maxPending = options.maxPending ?? 20_000;
  const quoteLimits = options.maxQuotes ?? { highlights: 6, evidence: 8 };

  const nodeRows = memory.prepare('SELECT id, path, parent, summary, body, aliases, pending, pending_count, weight, first_at, last_at, updated_at FROM nodes WHERE guild_id = ?').all(guildId) as NodeRow[];
  const paths = new Set(nodeRows.map((row) => row.path));

  // 子ページの数と、子孫も含めた出来事の数
  const childCount = new Map<string, number>();
  for (const row of nodeRows) if (row.parent !== null) childCount.set(row.parent, (childCount.get(row.parent) ?? 0) + 1);
  const episodeNodes = memory.prepare('SELECT episode_id, path FROM episode_nodes WHERE guild_id = ?').all(guildId) as { episode_id: number; path: string }[];
  const nodesOfEpisode = new Map<number, string[]>();
  const episodeSets = new Map<string, Set<number>>();
  for (const { episode_id: id, path } of episodeNodes) {
    if (!paths.has(path)) continue;
    nodesOfEpisode.set(id, [...(nodesOfEpisode.get(id) ?? []), path]);
    for (const entry of lineage(path)) {
      const set = episodeSets.get(entry) ?? new Set<number>();
      set.add(id);
      episodeSets.set(entry, set);
    }
  }

  // ページどうしのつながり (強い順に12件)
  const linkRows = memory.prepare('SELECT src, dst, weight FROM links WHERE guild_id = ? ORDER BY weight DESC').all(guildId) as { src: string; dst: string; weight: number }[];
  const linksOf = new Map<string, { dst: string; weight: number }[]>();
  for (const row of linkRows) {
    if (!paths.has(row.src) || !paths.has(row.dst) || row.src === row.dst) continue;
    const list = linksOf.get(row.src) ?? [];
    if (list.length < 12) list.push({ dst: row.dst, weight: row.weight });
    linksOf.set(row.src, list);
  }

  const nodes: NodePayload[] = nodeRows.map((row) => {
    const payload = {
      id: row.id,
      path: row.path,
      parent: row.parent,
      name: row.path.slice(row.path.lastIndexOf('/') + 1),
      depth: row.path ? row.path.split('/').length : 0,
      summary: row.summary.slice(0, 600),
      body: row.body,
      pending: row.pending.length > maxPending ? row.pending.slice(0, row.pending.lastIndexOf('\n', maxPending) + 1 || maxPending) : row.pending,
      pendingCount: row.pending_count,
      aliases: stringIds(jsonArray(row.aliases)).slice(0, 30),
      weight: row.weight,
      firstAt: row.first_at,
      lastAt: row.last_at,
      updatedAt: row.updated_at,
      childCount: childCount.get(row.path) ?? 0,
      episodeCount: episodeSets.get(row.path)?.size ?? 0,
      links: linksOf.get(row.path) ?? []
    };
    return { ...payload, contentHash: hash(payload) };
  });

  // ---- 出来事 ----
  const episodeRows = memory.prepare('SELECT id, kind, title, summary, highlights, channel_id, at_ms, end_ms, sources, importance FROM episodes WHERE guild_id = ?').all(guildId) as EpisodeRow[];
  const beforeOf = new Map<number, number[]>();
  for (const row of memory.prepare('SELECT from_id, to_id FROM episode_links WHERE guild_id = ?').all(guildId) as { from_id: number; to_id: number }[]) {
    beforeOf.set(row.from_id, [...(beforeOf.get(row.from_id) ?? []), row.to_id]);
  }

  // 引用してよいチャンネル
  const channelNames = new Map((archive.prepare('SELECT channel_id, name FROM channels').all() as { channel_id: string; name: string }[]).map((row) => [row.channel_id, row.name]));
  const publicIds = new Set((memory.prepare('SELECT channel_id FROM public_channels WHERE guild_id = ?').all(guildId) as { channel_id: string }[]).map((row) => row.channel_id));
  const included = new Set((memory.prepare('SELECT channel_id FROM included_channels WHERE guild_id = ?').all(guildId) as { channel_id: string }[]).map((row) => row.channel_id));
  const quotable = (channelId: string): boolean => publicIds.has(channelId) && !included.has(channelId) && !hiddenName.test(channelNames.get(channelId) ?? '');

  // 必要な発言をまとめて引く
  const wanted = new Map<number, { highlights: string[]; evidence: string[] }>();
  const allIds = new Set<string>();
  for (const row of episodeRows) {
    const highlights = stringIds(jsonArray(row.highlights));
    const evidence = stringIds(jsonArray(row.sources)).filter((id) => !highlights.includes(id));
    wanted.set(row.id, { highlights, evidence });
    for (const id of [...highlights, ...evidence]) allIds.add(id);
  }
  const messages = new Map<string, MessageRow>();
  const idList = [...allIds];
  for (let start = 0; start < idList.length; start += CHUNK) {
    const part = idList.slice(start, start + CHUNK);
    const rows = archive.prepare(`SELECT message_id, channel_id, author_name, content, created_at FROM messages WHERE deleted = 0 AND message_id IN (${part.map(() => '?').join(',')})`).all(...part) as MessageRow[];
    for (const row of rows) messages.set(row.message_id, row);
  }

  const episodes: EpisodePayload[] = episodeRows.map((row) => {
    const ids = wanted.get(row.id) ?? { highlights: [], evidence: [] };
    const quotes: QuotePayload[] = [];
    let hidden = 0;
    const take = (list: string[], highlight: boolean, limit: number) => {
      let taken = 0;
      for (const id of list) {
        const message = messages.get(id);
        if (!message) continue; // 消された発言・取り込めなかった発言は数えない
        if (!quotable(message.channel_id)) {
          hidden += 1;
          continue;
        }
        if (taken >= limit || !message.content.trim()) continue;
        taken += 1;
        quotes.push({ messageId: message.message_id, channelId: message.channel_id, authorName: message.author_name.slice(0, 80), content: cleanContent(message.content), createdAt: message.created_at, highlight });
      }
    };
    take(ids.highlights, true, quoteLimits.highlights);
    take(ids.evidence, false, quoteLimits.evidence);
    quotes.sort((a, b) => Number(b.highlight) - Number(a.highlight) || a.createdAt - b.createdAt);
    const payload = {
      id: row.id,
      kind: row.kind.slice(0, 40),
      title: row.title.slice(0, 200),
      summary: row.summary.slice(0, 1500),
      channelId: row.channel_id,
      channelName: (channelNames.get(row.channel_id) ?? '').slice(0, 100),
      atMs: row.at_ms,
      endMs: row.end_ms,
      importance: row.importance,
      sourceCount: ids.highlights.length + ids.evidence.length,
      hiddenQuotes: hidden,
      nodes: (nodesOfEpisode.get(row.id) ?? []).slice(0, 40),
      before: (beforeOf.get(row.id) ?? []).slice(0, 40),
      quotes
    };
    return { ...payload, contentHash: hash(payload) };
  });
  return { nodes, episodes };
}

// ---- 送る -------------------------------------------------------------------

export interface SyncOptions {
  url: string;
  token: string;
  guildId: string;
  fetchImpl?: typeof fetch;
  log?: (line: string) => void;
  /** 1回の要求の本文の大きさ (サイトは 1.8MB まで) */
  batchBytes?: number;
  dryRun?: boolean;
}

export interface SyncResult {
  nodes: { sent: number; unchanged: number; removed: number };
  episodes: { sent: number; unchanged: number; removed: number };
  requests: number;
}

function isHashMap(value: unknown): value is Record<string, string> {
  return typeof value === 'object' && value !== null && Object.values(value).every((entry) => typeof entry === 'string');
}

/** 件数と大きさの上限に収まるように、順番を保ったまま束に分ける。 */
export function chunkByBytes<T>(items: readonly T[], maxBytes: number, maxItems: number): T[][] {
  const out: T[][] = [];
  let current: T[] = [];
  let size = 0;
  for (const item of items) {
    const bytes = Buffer.byteLength(JSON.stringify(item));
    if (current.length && (size + bytes > maxBytes || current.length >= maxItems)) {
      out.push(current);
      current = [];
      size = 0;
    }
    current.push(item);
    size += bytes;
  }
  if (current.length) out.push(current);
  return out;
}

export async function syncSite(snapshot: Snapshot, options: SyncOptions): Promise<SyncResult> {
  const http = options.fetchImpl ?? fetch;
  const log = options.log ?? (() => undefined);
  const base = options.url.replace(/\/+$/, '');
  const headers = { authorization: `Bearer ${options.token}`, 'content-type': 'application/json' };
  let requests = 0;
  const call = async (path: string, body?: unknown): Promise<unknown> => {
    requests += 1;
    const response = await http(`${base}${path}`, {
      method: body === undefined ? 'GET' : 'POST', headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(60_000)
    });
    if (!response.ok) throw new Error(`site ${path} -> HTTP ${response.status}: ${(await response.text().catch(() => '')).slice(0, 200)}`);
    return response.json();
  };

  const remote = await call(`/v1/memory/hashes?guild=${encodeURIComponent(options.guildId)}`);
  const remoteNodes = (typeof remote === 'object' && remote !== null && isHashMap((remote as Record<string, unknown>).nodes)) ? (remote as { nodes: Record<string, string> }).nodes : {};
  const remoteEpisodes = (typeof remote === 'object' && remote !== null && isHashMap((remote as Record<string, unknown>).episodes)) ? (remote as { episodes: Record<string, string> }).episodes : {};

  const changedNodes = snapshot.nodes.filter((node) => remoteNodes[String(node.id)] !== node.contentHash);
  const changedEpisodes = snapshot.episodes.filter((episode) => remoteEpisodes[String(episode.id)] !== episode.contentHash);
  const localNodeIds = new Set(snapshot.nodes.map((node) => String(node.id)));
  const localEpisodeIds = new Set(snapshot.episodes.map((episode) => String(episode.id)));
  const goneNodes = Object.keys(remoteNodes).filter((id) => !localNodeIds.has(id)).map(Number);
  const goneEpisodes = Object.keys(remoteEpisodes).filter((id) => !localEpisodeIds.has(id)).map(Number);

  const result: SyncResult = {
    nodes: { sent: changedNodes.length, unchanged: snapshot.nodes.length - changedNodes.length, removed: goneNodes.length },
    episodes: { sent: changedEpisodes.length, unchanged: snapshot.episodes.length - changedEpisodes.length, removed: goneEpisodes.length },
    requests: 0
  };
  if (options.dryRun) {
    result.requests = requests;
    return result;
  }

  const maxBytes = options.batchBytes ?? 700_000;
  const nodeBatches = chunkByBytes(changedNodes, maxBytes, 200);
  const episodeBatches = chunkByBytes(changedEpisodes, maxBytes, 200);
  let done = 0;
  for (const nodes of nodeBatches) {
    await call('/v1/memory/batch', { guildId: options.guildId, nodes });
    done += nodes.length;
    log(`pages ${done}/${changedNodes.length}`);
  }
  done = 0;
  for (const episodes of episodeBatches) {
    await call('/v1/memory/batch', { guildId: options.guildId, episodes });
    done += episodes.length;
    log(`episodes ${done}/${changedEpisodes.length}`);
  }
  if (goneNodes.length || goneEpisodes.length) await call('/v1/memory/prune', { guildId: options.guildId, nodeIds: goneNodes, episodeIds: goneEpisodes });
  if (changedNodes.length || changedEpisodes.length || goneNodes.length || goneEpisodes.length) await call('/v1/memory/finish', { guildId: options.guildId });
  result.requests = requests;
  return result;
}

// ---- CLI --------------------------------------------------------------------

function parseArgs(argv: string[]): Record<string, string | true> {
  const args: Record<string, string | true> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg?.startsWith('--')) continue;
    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith('--')) {
      args[arg.slice(2)] = next;
      index += 1;
    } else {
      args[arg.slice(2)] = true;
    }
  }
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  // 送るサーバー: --guild、無ければ MEMORY_SITE_GUILDS (無ければ MEMORY_TREE_GUILD)。サーバーごとに別々に送る
  const guilds = typeof args.guild === 'string' ? [args.guild] : siteGuilds();
  const url = process.env.MEMORY_SITE_URL ?? process.env.GOVERNANCE_LAW_API_URL ?? '';
  const token = process.env.MEMORY_SITE_TOKEN ?? process.env.GOVERNANCE_LAW_API_TOKEN ?? '';
  if (guilds.length === 0) throw new Error('MEMORY_TREE_GUILD / MEMORY_SITE_GUILDS (または --guild) が要ります');

  const fromFile = typeof args.from === 'string' ? args.from : null;
  const outFile = typeof args.out === 'string' ? args.out : null;
  if ((fromFile || outFile) && guilds.length !== 1) throw new Error('--from / --out は --guild で1つのサーバーを指定してください');
  const memory = fromFile ? null : new Database(process.env.MEMORY_DB_PATH ?? 'memory.sqlite', { readonly: true, fileMustExist: true });
  const archive = fromFile ? null : new Database(process.env.ARCHIVE_DB_PATH ?? 'archive.sqlite', { readonly: true, fileMustExist: true });
  memory?.pragma('busy_timeout = 30000');
  archive?.pragma('busy_timeout = 30000');
  try {
    for (const guildId of guilds) {
      let snapshot: Snapshot;
      if (fromFile) {
        snapshot = JSON.parse(readFileSync(fromFile, 'utf8')) as Snapshot;
      } else if (memory && archive) {
        // builder が書いている最中でも、1つの時点の記憶を読む (読み取りトランザクション)
        snapshot = memory.transaction(() => buildSnapshot(memory, archive, guildId)).deferred();
      } else {
        continue;
      }
      console.log(`[${guildId}] snapshot: ${snapshot.nodes.length} pages, ${snapshot.episodes.length} episodes, ${snapshot.episodes.reduce((sum, episode) => sum + episode.quotes.length, 0)} quotes`);
      if (outFile) {
        writeFileSync(outFile, JSON.stringify(snapshot));
        console.log(`wrote ${outFile}`);
        continue;
      }
      // 記憶の無いサーバーは送らない (サイトの一覧に空のサーバーを作らない)
      if (snapshot.nodes.length === 0) {
        console.log(`[${guildId}] 記憶がまだ無いので送りません。`);
        continue;
      }
      if (!url || !token) {
        console.log('MEMORY_SITE_URL / MEMORY_SITE_TOKEN (または GOVERNANCE_LAW_API_URL / _TOKEN) が未設定なので、送りません。');
        return;
      }
      const started = Date.now();
      const result = await syncSite(snapshot, { url, token, guildId, dryRun: args['dry-run'] === true, log: (line) => console.log(`[${guildId}] ${line}`) });
      console.log(`[${guildId}] ${args['dry-run'] === true ? 'would send' : 'sent'}: ${JSON.stringify(result)} (${((Date.now() - started) / 1000).toFixed(1)}s)`);
    }
  } finally {
    memory?.close();
    archive?.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error('memory-site-sync failed:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
