import { StopRun, treeConfig } from '../build.js';
import { memoryDb, normalizePath } from '../store.js';
import { errorMessage, isRecord } from '../types.js';
import { v2Config } from './call.js';
import { nameKey } from './resolve.js';
import type { Ctx } from './run.js';

// S5 筋書き / S6 根。
//   S5: 同じもの (プロジェクト・話題・ネタ) をめぐる出来事が、3 日以内の間隔で 4 件以上つながっていれば、
//       時系列の events/ ページを書く (テトリス杯のように、複数の出来事にまたがるもの)
//   S6: 根のページ (bot が毎回最初に読む唯一の常駐する記憶)。機械の統計と上位ページから書く

const TZ_MS = Number(process.env.ARCHIVE_TZ_OFFSET_HOURS ?? 9) * 3_600_000;
const day = (ms: number): string => new Date(ms + TZ_MS).toISOString().slice(0, 10);
const ARC_GAP_MS = 3 * 86_400_000;
export const ARC_MIN = Number(process.env.MEMORY_V2_ARC_MIN || 4);
const ARC_MAX = 60;

export interface ArcEpisode { id: number; at: number; end: number; kind: string; title: string; summary: string; outcome: string; importance: number }
export interface Arc { key: string; name: string; episodes: ArcEpisode[] }

interface EpisodeRow { id: number; at_ms: number; end_ms: number; kind: string; title: string; summary: string; outcome: string; importance: number; entities: string }

/** 出来事を「もの」ごとに時刻順に並べ、3 日を超えて空いた所で切り、4 件以上のまとまりを筋とする。 */
export function planArcs(guildId: string): Arc[] {
  const rows = memoryDb().prepare<[string], EpisodeRow>(`
    SELECT id, at_ms, end_ms, kind, title, summary, outcome, importance, entities FROM v2_episodes
    WHERE guild_id = ? AND verdict <> 'wrong' ORDER BY at_ms, id
  `).all(guildId);
  const byThing = new Map<string, { name: string; list: ArcEpisode[] }>();
  for (const row of rows) {
    const episode: ArcEpisode = { id: row.id, at: row.at_ms, end: row.end_ms, kind: row.kind, title: row.title, summary: row.summary, outcome: row.outcome, importance: row.importance };
    for (const entity of JSON.parse(row.entities) as { k: string; v: string }[]) {
      if (entity.k !== 'thing') continue;
      const key = nameKey(entity.v);
      if (!key) continue;
      const entry = byThing.get(key) ?? { name: entity.v, list: [] };
      entry.list.push(episode);
      byThing.set(key, entry);
    }
  }
  const arcs: Arc[] = [];
  for (const [key, { name, list }] of byThing) {
    if (list.length < ARC_MIN) continue;
    let chain: ArcEpisode[] = [];
    const flush = (): void => {
      for (let i = 0; i < chain.length; i += ARC_MAX) {
        const part = chain.slice(i, i + ARC_MAX);
        if (part.length >= ARC_MIN) arcs.push({ key: `${key}@${part[0]?.id}`, name, episodes: part });
      }
      chain = [];
    };
    for (const episode of list) {
      const last = chain.at(-1);
      if (last && episode.at - last.end > ARC_GAP_MS) flush();
      chain.push(episode);
    }
    flush();
  }
  return arcs.sort((a, b) => b.episodes.length - a.episodes.length);
}

export const arcSystem = `あなたは Discord サーバーの「記憶」の編集者です。同じ話題・企画・揉め事をめぐって何日かにわたって起きた出来事 (e) を、時系列の 1 ページにまとめます。

- 渡した出来事だけを材料にする。足さない・推測しない。
- 発端 → 経過 → 結末 の順に、日付つきで書く。数字・勝敗・結論・但し書きは落とさない。短くまとめすぎない。
- 各文の終わりに根拠の出来事を [e12] の形で付ける (複数なら [e12][e15])。根拠の無い文は書かない。
- title はこの筋の名前 (30 字以内。「テトリス杯 2025-03」のように、何についてのどの時期かが分かる名前)。summary は 1 行の説明 (40 字以内)。

出力は JSON だけ: {"title":"…","summary":"…","body":"…"}`;

export function arcUser(arc: Arc): string {
  return [`話題: ${arc.name}`, ...arc.episodes.map((e) => `[e${e.id}] ${day(e.at)}${e.end - e.at > 86_400_000 ? `〜${day(e.end)}` : ''} (${e.kind}) 「${e.title}」 ${e.summary}${e.outcome ? ` → ${e.outcome}` : ''}`)].join('\n');
}

export interface ArcPage { path: string; summary: string; body: string }

/** 出力を整える: 入力に無い [eN] の文は捨て、文に入らなかった出来事は末尾に機械が足す。 */
export function arcPage(arc: Arc, output: unknown, taken: Set<string>): ArcPage | null {
  if (!isRecord(output) || typeof output.body !== 'string' || typeof output.title !== 'string') return null;
  const valid = new Set(arc.episodes.map((e) => e.id));
  const cited = new Set<number>();
  const lines: string[] = [];
  for (const line of output.body.split('\n')) {
    if (!line.trim() || /^\s*#{1,6}\s/.test(line)) { lines.push(line); continue; }
    const ids = [...line.matchAll(/\[e(\d+)\]/g)].map((m) => Number(m[1])).filter((id) => valid.has(id));
    if (ids.length === 0) continue;
    for (const id of ids) cited.add(id);
    lines.push(line.replace(/\[e(\d+)\]/g, (match, id: string) => (valid.has(Number(id)) ? match : '')));
  }
  const missing = arc.episodes.filter((e) => !cited.has(e.id));
  const body = [...lines, ...(missing.length ? ['', '## 追記', ...missing.map((e) => `- ${day(e.at)} ${e.title}: ${e.summary}${e.outcome ? ` → ${e.outcome}` : ''} [e${e.id}]`)] : [])]
    .join('\n').replace(/\n{3,}/g, '\n\n').trim();
  const title = output.title.replace(/[/／\\]/g, '／').replace(/\s+/g, ' ').trim().slice(0, 30);
  let path = normalizePath(`events/${title || arc.name}`);
  if (!path || !body) return null;
  for (let n = 2; taken.has(path.toLowerCase()); n += 1) path = `${normalizePath(`events/${title || arc.name}`) ?? 'events/x'}~${n}`;
  taken.add(path.toLowerCase());
  return { path, summary: String(output.summary ?? '').replace(/\s+/g, ' ').trim().slice(0, 80) || title, body };
}

export async function composeArcs(ctx: Ctx, { limit = Infinity }: { limit?: number } = {}): Promise<{ arcs: number; pages: number }> {
  const arcs = planArcs(ctx.guildId).slice(0, limit);
  const d = memoryDb();
  const taken = new Set(d.prepare<[string], { path: string }>('SELECT path FROM v2_pages WHERE guild_id = ?').all(ctx.guildId).map((row) => row.path.toLowerCase()));
  const raws = new Map<number, unknown>();
  let cursor = 0;
  let stop: unknown = null;
  const worker = async (): Promise<void> => {
    for (let i = cursor++; i < arcs.length && !stop; i = cursor++) {
      const arc = arcs[i] as Arc;
      try {
        const result = await ctx.call({
          stage: 'arc', spec: v2Config.compose, system: arcSystem, user: arcUser(arc),
          check: (json) => { if (!isRecord(json) || typeof json.body !== 'string') throw Object.assign(new Error('arc output has no body'), { code: 'BAD_OUTPUT' }); }
        });
        ctx.counters.calls += result.cached ? 0 : 1;
        ctx.counters.cost += result.cost;
        raws.set(i, result.json);
      } catch (error) {
        if (error instanceof StopRun) { stop ??= error; return; }
        ctx.log(`arc failed ${arc.name}: ${errorMessage(error).slice(0, 100)}`);
        raws.set(i, null);
      }
    }
  };
  await Promise.all(Array.from({ length: v2Config.concurrency }, worker));
  if (stop) throw stop;
  const insert = d.prepare(`
    INSERT OR REPLACE INTO v2_pages (guild_id, path, entity_id, summary, body, aliases, weight, claims, cited, source, first_at, last_at, updated_at)
    VALUES (?, ?, NULL, ?, ?, '[]', ?, ?, ?, 'arc', ?, ?, ?)
  `);
  let pages = 0;
  d.transaction(() => {
    d.prepare("DELETE FROM v2_pages WHERE guild_id = ? AND source = 'arc'").run(ctx.guildId);
    arcs.forEach((arc, i) => {
      const raw = raws.get(i);
      const page = raw ? arcPage(arc, raw, taken) : null;
      if (!page) return;
      insert.run(ctx.guildId, page.path, page.summary, page.body, arc.episodes.length, arc.episodes.length, arc.episodes.length,
        arc.episodes[0]?.at ?? null, arc.episodes.at(-1)?.end ?? null, Date.now());
      pages += 1;
    });
  })();
  return { arcs: arcs.length, pages };
}

// ---- 根 --------------------------------------------------------------------

export const rootSystem = `あなたは Discord サーバーの「記憶」の編集者です。根のページ (サーバー全体の概要) を書きます。bot が毎回の会話で最初に読む、唯一の常駐する記憶です。

- このサーバーが何の場所か、主な人物と役割、主なプロジェクト、よく出る話題、文化や用語を ${treeConfig.rootChars} 字以内で。
- 主なページには [[projects/sakana-bot]] の形でリンクする (渡したパスだけ)。
- 渡したページの内容だけを根拠にする。推測しない。箇条書きでよい。

出力は JSON だけ: {"body":"…"}`;

export function rootUser(guildId: string): string {
  const d = memoryDb();
  const parts: string[] = [];
  let used = 0;
  for (const top of ['people', 'projects', 'topics', 'events', 'debates', 'culture', 'server', 'others']) {
    const rows = d.prepare<[string, string, string], { path: string; summary: string; weight: number; head: string }>(`
      SELECT path, summary, weight, substr(replace(body, char(10), ' '), 1, 160) AS head FROM v2_pages
      WHERE guild_id = ? AND path LIKE ? AND instr(substr(path, length(?) + 1), '/') = 0 ORDER BY weight DESC LIMIT 25
    `).all(guildId, `${top}/%`, `${top}/`);
    if (rows.length === 0) continue;
    const block = [`## ${top}`, ...rows.map((row) => `- ${row.path} (${row.weight}): ${row.summary}${row.head ? ` | ${row.head}` : ''}`)].join('\n');
    if (used + block.length > 24000) break;
    parts.push(block);
    used += block.length;
  }
  return parts.join('\n\n');
}

export async function composeRoot(ctx: Ctx): Promise<boolean> {
  const result = await ctx.call({
    stage: 'root', spec: v2Config.compose, system: rootSystem, user: rootUser(ctx.guildId),
    check: (json) => { if (!isRecord(json) || typeof json.body !== 'string' || !json.body.trim()) throw Object.assign(new Error('root body was empty'), { code: 'BAD_OUTPUT' }); }
  });
  ctx.counters.calls += result.cached ? 0 : 1;
  ctx.counters.cost += result.cost;
  const body = String((result.json as { body: string }).body).trim().slice(0, Math.round(treeConfig.rootChars * 1.5));
  memoryDb().prepare(`
    INSERT OR REPLACE INTO v2_pages (guild_id, path, entity_id, summary, body, aliases, weight, claims, cited, source, first_at, last_at, updated_at)
    VALUES (?, '', NULL, '', ?, '[]', 0, 0, 0, 'root', NULL, NULL, ?)
  `).run(ctx.guildId, body, Date.now());
  return true;
}
