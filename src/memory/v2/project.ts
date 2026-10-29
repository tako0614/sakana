import { ensureNode, ensureSeeds, linkEpisodeNodes, linkPageMentions, memoryDb, setCursor, setState } from '../store.js';
import { entityPaths, nameKey } from './resolve.js';

// 投影。v2 の作業用の表 (検証つきの出来事・組み立てたページ) を、v1 と同じ形の表 (nodes / episodes /
// episode_nodes / links) に写す。サイト同期・Worker・/memory・memory ツールは無改造でそのまま読める。
//
//   - 差分で写す: 変わっていないページ・出来事には触らない (memory_chunks / memory_vectors は本文の hash で引き継がれるので、
//     毎回の投影で振り直しにならない)。消えたページ・出来事は消す
//   - 出来事の id は v2 の id のまま (本文の [e345] がそのまま開く)。wrong の出来事は写さない
//   - 出来事の summary の末尾に結末 (outcome) を足す (全文検索と表示で見えるように)
//   - 出来事 → ページの結び目は、出来事の entities と、その出来事に属する主張の entity から作る (結び目とリンクは毎回作り直す)
//   - チャンネルごとの読み終えた位置 (cursors) を、v2 の区間の終わりに置く

export interface ProjectStats {
  pages: number; changedPages: number; removedPages: number;
  episodes: number; changedEpisodes: number; removedEpisodes: number;
  episodeNodes: number; cursors: number;
}

const SOURCES_MAX = 12;

/** 根拠の発言 ID を SOURCES_MAX 個に間引く (最初と最後を必ず含める)。 */
export function thin(ids: readonly string[], max = SOURCES_MAX): string[] {
  if (ids.length <= max) return [...ids];
  const picked = new Set<number>([0, ids.length - 1]);
  for (let i = 1; picked.size < max; i += 1) picked.add(Math.floor((i * (ids.length - 1)) / (max - 1)));
  return [...picked].sort((a, b) => a - b).map((i) => ids[i] as string);
}

const ancestorsOf = (path: string): string[] => {
  const parts = path.split('/');
  return parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join('/'));
};

interface PageRow { path: string; summary: string; body: string; aliases: string; weight: number; first_at: number | null; last_at: number | null; source: string }
interface EpisodeOut {
  id: number; kind: string; title: string; summary: string; highlights: string; channel_id: string; at_ms: number; end_ms: number; sources: string; importance: number
}

export function projectToV1(guildId: string, now = Date.now()): ProjectStats {
  const d = memoryDb();
  const stats: ProjectStats = { pages: 0, changedPages: 0, removedPages: 0, episodes: 0, changedEpisodes: 0, removedEpisodes: 0, episodeNodes: 0, cursors: 0 };
  const { person, thing } = entityPaths(guildId);

  d.transaction(() => {
    ensureSeeds(guildId, now);

    // ---- ページ ----
    const pages = d.prepare<[string], PageRow>(
      'SELECT path, summary, body, aliases, weight, first_at, last_at, source FROM v2_pages WHERE guild_id = ? ORDER BY length(path), path').all(guildId);
    const existing = new Map(d.prepare<[string], { path: string; summary: string; body: string; aliases: string; weight: number; first_at: number | null; last_at: number | null }>(
      'SELECT path, summary, body, aliases, weight, first_at, last_at FROM nodes WHERE guild_id = ?').all(guildId).map((row) => [row.path, row]));
    const update = d.prepare(`
      UPDATE nodes SET summary = ?, body = ?, aliases = ?, pending = '', pending_count = 0, weight = ?, first_at = ?, last_at = ?, updated_at = ?
      WHERE guild_id = ? AND path = ?
    `);
    const keep = new Set<string>(['']);
    for (const page of pages) {
      keep.add(page.path);
      for (const ancestor of ancestorsOf(page.path)) keep.add(ancestor);
      const aliases = JSON.stringify((JSON.parse(page.aliases) as string[]).slice(0, 12));
      const old = existing.get(page.path);
      const same = old && old.body === page.body && old.summary === page.summary && old.aliases === aliases
        && old.weight === page.weight && old.first_at === page.first_at && old.last_at === page.last_at;
      if (page.path !== '') stats.pages += 1;
      if (same) continue;
      if (page.path !== '') ensureNode(guildId, page.path, { summary: page.summary, now });
      update.run(page.summary, page.body, aliases, page.weight, page.first_at, page.last_at, now, guildId, page.path);
      stats.changedPages += 1;
    }
    for (const row of d.prepare<[string], { path: string; parent: string | null }>('SELECT path, parent FROM nodes WHERE guild_id = ?').all(guildId)) {
      if (row.parent === '' || keep.has(row.path)) continue;   // 最上位 (種) は残す
      d.prepare('DELETE FROM nodes WHERE guild_id = ? AND path = ?').run(guildId, row.path);
      stats.removedPages += 1;
    }

    // ---- 出来事 (id は v2 のまま) ----
    const episodes = d.prepare<[string], {
      id: number; kind: string; title: string; summary: string; outcome: string; importance: number; channel_id: string;
      at_ms: number; end_ms: number; entities: string
    }>(`SELECT id, kind, title, summary, outcome, importance, channel_id, at_ms, end_ms, entities FROM v2_episodes
        WHERE guild_id = ? AND verdict <> 'wrong' ORDER BY id`).all(guildId);
    const messages = d.prepare<[number], { message_id: string; role: string }>(
      'SELECT message_id, role FROM v2_episode_messages WHERE episode_id = ? ORDER BY message_id');
    const old = new Map(d.prepare<[string], EpisodeOut>(
      'SELECT id, kind, title, summary, highlights, channel_id, at_ms, end_ms, sources, importance FROM episodes WHERE guild_id = ?').all(guildId).map((row) => [row.id, row]));
    const insert = d.prepare(`
      INSERT INTO episodes (id, guild_id, kind, title, summary, highlights, channel_id, at_ms, end_ms, sources, importance, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const claimPaths = d.prepare<[number], { path: string }>(`
      SELECT DISTINCT e.path FROM v2_claims c JOIN v2_entities e ON e.id = c.entity_id WHERE c.episode_id = ? AND c.verdict <> 'wrong'
    `);
    // 結び目は毎回作り直す (本文のリンクと出来事から決まる)
    for (const table of ['episode_nodes', 'episode_links', 'links']) d.prepare(`DELETE FROM ${table} WHERE guild_id = ?`).run(guildId);
    for (const page of pages) linkPageMentions(guildId, page.path, page.body, now);

    const pagePaths = new Set(pages.map((page) => page.path));
    const live = new Set<number>();
    for (const ep of episodes) {
      live.add(ep.id);
      const rows = messages.all(ep.id);
      const core = rows.filter((row) => row.role === 'core').map((row) => row.message_id);
      const quotes = rows.filter((row) => row.role === 'quote').map((row) => row.message_id);
      const text = ep.outcome ? `${ep.summary} → ${ep.outcome}` : ep.summary;
      const next = {
        kind: ep.kind, title: ep.title, summary: text, highlights: JSON.stringify(quotes), channel_id: ep.channel_id, at_ms: ep.at_ms, end_ms: ep.end_ms,
        sources: JSON.stringify(thin(core.length ? core : quotes)), importance: ep.importance
      };
      const before = old.get(ep.id);
      const same = before && (Object.keys(next) as (keyof typeof next)[]).every((key) => before[key] === next[key]);
      stats.episodes += 1;
      if (!same) {
        // episodes の全文検索は INSERT / DELETE の trigger だけなので、更新は 消して入れ直す
        if (before) d.prepare('DELETE FROM episodes WHERE id = ?').run(ep.id);
        insert.run(ep.id, guildId, next.kind, next.title, next.summary, next.highlights, next.channel_id, next.at_ms, next.end_ms, next.sources, next.importance, now);
        stats.changedEpisodes += 1;
      }
      const paths = new Set<string>();
      for (const entity of JSON.parse(ep.entities) as { k: string; v: string }[]) {
        const path = entity.k === 'person' ? person.get(entity.v) : thing.get(nameKey(entity.v));
        if (path) paths.add(path);
      }
      for (const row of claimPaths.all(ep.id)) paths.add(row.path);
      const linked = [...paths].filter((path) => pagePaths.has(path));
      if (linked.length) { linkEpisodeNodes(guildId, ep.id, linked, ep.end_ms); stats.episodeNodes += linked.length; }
    }
    for (const id of old.keys()) {
      if (live.has(id)) continue;
      d.prepare('DELETE FROM episodes WHERE id = ?').run(id);
      stats.removedEpisodes += 1;
    }

    // 筋書きのページ (events/) は、本文が引く出来事とつなぐ
    for (const page of pages.filter((p) => p.source === 'arc')) {
      for (const match of page.body.matchAll(/\[e(\d+)\]/g)) {
        const id = Number(match[1]);
        if (live.has(id)) { linkEpisodeNodes(guildId, id, [page.path], now); stats.episodeNodes += 1; }
      }
    }

    // 続き: 同じ会話単位の中で順に並ぶ出来事を、新しい方から前の方へ結ぶ
    const link = d.prepare('INSERT OR IGNORE INTO episode_links (guild_id, from_id, to_id) VALUES (?, ?, ?)');
    const byConv = d.prepare<[string], { id: number; section_id: number; conv: string | null }>(
      "SELECT id, section_id, conv FROM v2_episodes WHERE guild_id = ? AND verdict <> 'wrong' AND conv IS NOT NULL ORDER BY section_id, conv, at_ms, id").all(guildId);
    for (let i = 1; i < byConv.length; i += 1) {
      const a = byConv[i - 1];
      const b = byConv[i];
      if (a && b && a.section_id === b.section_id && a.conv === b.conv) link.run(guildId, b.id, a.id);
    }

    // 読み終えた位置
    const cursors = d.prepare<[string], { channel_id: string; to_id: string; to_ms: number }>(`
      SELECT channel_id, to_id, to_ms FROM v2_sections WHERE guild_id = ? AND state IN ('done', 'extracted')
        AND to_ms = (SELECT MAX(to_ms) FROM v2_sections s2 WHERE s2.guild_id = v2_sections.guild_id AND s2.channel_id = v2_sections.channel_id AND s2.state IN ('done', 'extracted'))
    `).all(guildId);
    for (const row of cursors) { setCursor(guildId, row.channel_id, row.to_id, row.to_ms); stats.cursors += 1; }
    setState(`v2:projected:${guildId}`, { at: now, ...stats });
  })();
  return stats;
}
