import {
  episodesFor, getNode, linkedPages, memoryDb, nodeNames, recentEpisodesFor, searchEpisodes, searchNodes, sharedEpisodes,
  type EpisodeHit, type NodeName
} from './store.js';
import { MODALITY_LABEL, TYPE_LABEL, monthOf } from './claims.js';
import { meaningOf, type Meaning, type MeaningChunk } from './vectors.js';

// 思い出す。会話に出た名前や言葉を手がかりに、関係するページと出来事を数件だけ引く。
// 同期の recallFor は名前・別名の照合 + 全文検索。手がかりから1段だけ
// つながりをたどる: 2人の名前が出たら、その2人が両方関わった出来事を出す。
// 会話 agent は memory.read を通して、どの往復でも同じベクトル検索を使う。
//
// 書く側 (build.js) も同じ照合で「この区切りに出てくる既知のページ」を見つけ、
// 書く前に渡す (重複を避け、変化として書かせ、前の出来事と結ばせる)。

const NAMES_TTL_MS = 5 * 60_000;
type KeyedName = NodeName & { key: string };
const cache = new Map<string, { at: number; names: KeyedName[] }>();

function namesOf(guildId: string): KeyedName[] {
  const hit = cache.get(guildId);
  if (hit && Date.now() - hit.at < NAMES_TTL_MS) return hit.names;
  const names = nodeNames(guildId)
    .map((entry) => ({ ...entry, key: entry.name.toLowerCase() }))
    .sort((a, b) => b.key.length - a.key.length);
  cache.set(guildId, { at: Date.now(), names });
  return names;
}

export function forgetNames(guildId: string): void {
  cache.delete(guildId);
}

const date = (ms: number): string => new Date(ms + 9 * 3_600_000).toISOString().slice(0, 10);

/** 文章に名前・別名が出てくるページ。出てきた回数と長さ、ページの重みで並べる。 */
export function matchPages(guildId: string, text: unknown, { limit = 12 }: { limit?: number } = {}): { path: string; score: number }[] {
  const haystack = String(text ?? '').toLowerCase();
  if (!haystack) return [];
  const scores = new Map<string, number>();
  for (const { key, path, weight } of namesOf(guildId)) {
    let count = 0;
    for (let from = 0; count < 5;) {
      const at = haystack.indexOf(key, from);
      if (at < 0) break;
      count += 1;
      from = at + key.length;
    }
    if (count === 0) continue;
    // 2文字の名前は別の語の一部に当たりやすい (たこ → たこ焼き)
    const strength = ([...key].length >= 3 ? 1 : 0.6) * count;
    scores.set(path, Math.max(scores.get(path) ?? 0, strength * (1 + Math.log1p(weight) / 4)));
  }
  return [...scores].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([path, score]) => ({ path, score }));
}

const termsOf = (text: unknown): string[] => [...new Set(String(text ?? '')
  .replace(/https?:\/\/\S+/g, ' ')
  .split(/[\s　、。！？!?「」『』()（）:：,，.]+/)
  .filter((term) => [...term].length >= 3 && [...term].length <= 20))].slice(0, 6);

/**
 * 直近の会話に出てくる名前のページを、どれだけ手がかりにするか。0 なら使わない。
 * 本番の実行記録 (2026-10-18、29 件) では、0.4 にしていたせいで、依頼に名前が無いと直近の会話の常連 (t3tra・たこ・さかな)
 * のページと、そのページのいつもの上位の出来事が毎回出て (28 件)、依頼と関係のない話を持ち出す元になっていた。
 */
const CONTEXT_WEIGHT = Number(process.env.MEMORY_RECALL_CONTEXT_WEIGHT ?? 0);

/** memory-tree recall コマンドの語彙検索。 */
export function recallFor(guildId: string,
  { request = '', context = '', maxChars = 1800 }: { request?: string; context?: string; maxChars?: number } = {}): string {
  const scores = new Map<string, number>();
  const add = (path: string, value: number): void => { scores.set(path, (scores.get(path) ?? 0) + value); };
  for (const { path, score } of matchPages(guildId, request)) add(path, score);
  if (CONTEXT_WEIGHT > 0) for (const { path, score } of matchPages(guildId, context, { limit: 6 })) add(path, score * CONTEXT_WEIGHT);

  const terms = termsOf(request).join(' ');
  if (terms) {
    for (const row of searchNodes(guildId, terms, 3)) if (row.path.includes('/')) add(row.path, 0.5);
  }
  const episodeHits = terms ? searchEpisodes(guildId, terms, 3) : [];

  const pages = [...scores].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([path]) => path);
  let text = '';
  const paths = new Set<string>();
  const episodeIds = new Set<number>();
  const append = (line: string): boolean => {
    const next = `${text || HEADINGS}\n${line}`;
    if (next.length > maxChars) return false;
    text = next;
    return true;
  };
  const addEpisodes = (episodes: EpisodeHit[], limit: number, heading = ''): void => {
    let count = 0;
    for (const episode of episodes) {
      if (episodeIds.has(episode.id)) continue;
      const kind = !heading && episode.kind ? ` [${episode.kind}]` : '';
      const line = `  e${episode.id} ${date(episode.at_ms)}${kind} ${episode.title}`;
      if (!append(heading && count === 0 ? `${heading}\n${line}` : line)) continue;
      episodeIds.add(episode.id);
      count += 1;
      if (count >= limit) break;
    }
  };
  for (const path of pages) {
    if (!getNode(guildId, path) || !append(`- [[${path}]]`)) continue;
    paths.add(path);
    addEpisodes(episodesFor(guildId, path, 2), 2);
  }
  // 2つ以上思い出したら、その間で起きたこと (複数のページをまたぐ出来事)
  const [firstPage, secondPage] = paths;
  if (firstPage !== undefined && secondPage !== undefined) {
    addEpisodes(sharedEpisodes(guildId, firstPage, secondPage, 3), 3, `- [[${firstPage}]] と [[${secondPage}]] の両方が関わった出来事:`);
  }
  addEpisodes(episodeHits, 3, '- 言葉が一致した出来事:');
  return text;
}

const HEADINGS = '思い出したこと (記憶の見出しだけ。中身は memory ツールで path / episode を開いて読む):';
/** 想起に出す断片の頭の長さ。中身を入れるためではなく、どの話が当たったかが分かる程度。0 なら出さず、ページと節と出来事の番号だけ。 */
const SNIPPET_CHARS = Number(process.env.MEMORY_CHUNK_SNIPPET ?? 60);
/** 1つの断片に添える根拠の出来事の数。 */
const CHUNK_EPISODES = 2;

const clip = (text: string, limit: number): string => ([...text].length > limit ? `${[...text].slice(0, limit).join('')}…` : text);

/** 断片に添える根拠の出来事 (想起の行に出す分)。 */
function chunkLine(chunk: MeaningChunk, room: number): string {
  const { claim } = chunk;
  if (claim) {
    const modality = claim.modality === 'self_report' ? '本人申告' : MODALITY_LABEL[claim.modality] ?? claim.modality;
    const tags = [TYPE_LABEL[claim.type] ?? claim.type, modality, claim.hedged ? '根拠弱' : ''].filter(Boolean).join('・');
    const prefix = `- ${claim.who ? `${claim.who} ` : ''}(${monthOf(claim.asOf)}・${tags})`;
    const citation = claim.episodeId !== null ? `[e${claim.episodeId}]` : `[[${claim.path}]]`;
    const full = `${prefix} ${claim.text} ${citation}`;
    if (full.length <= room) return full;
    const remaining = room - prefix.length - citation.length - 3;
    let end = 0;
    for (const mark of claim.text.matchAll(/[。！？]|[.!?](?=\s|$)/gu)) {
      if (mark.index + 1 > remaining) break;
      end = mark.index + 1;
    }
    return end ? `${prefix} ${claim.text.slice(0, end)}… ${citation}` : `${prefix} ${citation}`;
  }
  const snippet = SNIPPET_CHARS > 0 ? ` — ${clip(chunk.line, SNIPPET_CHARS)}` : '';
  const more = chunk.more > 0 ? ` (同じ節にほか ${chunk.more} 件)` : '';
  return `  [[${chunk.path}]]${chunk.heading ? ` §${chunk.heading}` : ''}${snippet}${more}${chunk.episodeIds.slice(0, CHUNK_EPISODES).map((id) => ` e${id}`).join('')}`;
}

/** 意味で引いた行を組み立てる。予算は各行の先頭の改行込み。 */
export function meaningLines(meaning: Meaning | null, available = Infinity): string[] {
  if (!meaning) return [];
  const lines: string[] = [];
  const append = (line: string): boolean => {
    if (line.length + 1 > available) return false;
    available -= line.length + 1;
    lines.push(line);
    return true;
  };
  const paths = new Set<string>();
  const episodes = new Set<number>();
  for (const chunk of meaning.chunks) {
    if (!append(chunkLine(chunk, available - 1))) continue;
    paths.add(chunk.path);
    for (const id of chunk.episodeIds.slice(0, CHUNK_EPISODES)) episodes.add(id);
  }
  for (const node of meaning.nodes) {
    if (!paths.has(node.path)) append(`  [[${node.path}]]`);
  }
  for (const episode of meaning.episodes) {
    if (!episodes.has(episode.id)) append(`  e${episode.id} ${date(episode.atMs)}${episode.kind ? ` [${episode.kind}]` : ''} ${episode.title}`);
  }
  return lines;
}

const RECALL_SCORE = Number(process.env.MEMORY_AUTO_RECALL_FLOOR || 0.86);
const RECALL_CHARS = 1800;
const RECALL_HEAD = '現在の話に近い記憶。根拠は memory の episode または path で開ける。';

function clue(text: string | undefined): string {
  return (text ?? '').replace(/https?:\/\/\S+/g, ' ').replace(/<[@#][!&]?\d+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function requestClue(guildId: string, request: string): string {
  const named = request.replace(/<@!?(\d{15,25})>/g, (_mention, id: string) => {
    const db = memoryDb();
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'v2_entities'").get()) return ' ';
    return db.prepare<[string, string], { name: string }>(
      "SELECT name FROM v2_entities WHERE guild_id = ? AND kind = 'person' AND key = ?"
    ).get(guildId, id)?.name ?? ' ';
  });
  return clue(named);
}

/** 依頼・思考・ツール結果から、モデルを呼ぶ前に同じ局所検索を行う。 */
export function memoryReader(guildId: string, { request, reply = '', timeoutMs = 2000, maxChars = RECALL_CHARS }: {
  request: string; reply?: string; timeoutMs?: number; maxChars?: number;
}): (input: { observations: string[]; reasoning?: string | undefined; thought?: string | undefined; readTarget?: string | null | undefined }) => Promise<{ text: string } | null> {
  let base: string | undefined;
  // 依頼だけの結果を控えておくと、単発の memory_focus が終わっても再検索せず戻れる。
  let initial: { text: string } | null | undefined;
  let latest: { query: string; result: { text: string } | null } | undefined;
  return async ({ observations, reasoning, thought, readTarget }) => {
    if (maxChars <= RECALL_HEAD.length) return null;
    try {
      if (base === undefined) {
        const message = requestClue(guildId, request);
        const quoted = requestClue(guildId, reply);
        base = quoted ? [message.slice(0, 250), quoted.slice(0, 200)].filter(Boolean).join(' ') : message.slice(0, 480);
      }
      const focus = clue(thought?.replace(/^memory_focus\.(?:context|thought):\s*/gm, '')).slice(0, 480);
      const toolText = observations.at(-1)?.replace(/^tool:[^:]*:\s*/, '') ?? '';
      // Typed read results identify the authorized anchor actually returned.
      // null means the read had no visible target; never infer one from neighbors.
      // Older/generic plain tools keep their existing observation behavior.
      const source = readTarget === undefined
        ? toolText.includes('話者（この資料内）:')
          ? toolText.match(/^(?:> [^\n]*(?:\n|$)){1,3}/m)?.[0]?.replace(/^> /gm, '')
          : toolText
        : readTarget ?? '';
      const observation = clue(source);
      const hint = [clue(reasoning).slice(-150), observation.slice(0, 90)].filter(Boolean).join(' ');
      const query = focus || (hint ? [base.slice(0, 240), hint].filter(Boolean).join(' ') : base);
      if (!query) return null;
      if (query === base && initial !== undefined) return initial;
      if (query === latest?.query) return latest.result;
      const found = await meaningOf(guildId, query, { nodeLimit: 0, episodeLimit: 2, chunkLimit: 4, minScore: RECALL_SCORE, timeoutMs });
      const lines = meaningLines(found, maxChars - RECALL_HEAD.length);
      const result = lines.length ? { text: [RECALL_HEAD, ...lines].join('\n') } : null;
      latest = { query, result };
      if (query === base) initial = result;
      return result;
    } catch (error) {
      console.error('Memory recall failed:', error);
      return null;
    }
  };
}

/**
 * 区切りを書く前に渡す既知のページ。ログに出てくる名前から引き、
 * 説明・本文の冒頭・最近の出来事 (e 番号つき) を渡す。
 */
export function knownPagesFor(guildId: string, transcript: string, { limit = 12, maxChars = 6000 }: { limit?: number; maxChars?: number } = {}): string {
  const blocks: string[] = [];
  let used = 0;
  for (const { path } of matchPages(guildId, transcript, { limit })) {
    const node = getNode(guildId, path);
    if (!node) continue;
    const head = node.body.split('\n').filter(Boolean).slice(0, 4).join('\n').slice(0, 320);
    const recent = recentEpisodesFor(guildId, path, 3).map((episode) => `e${episode.id} ${date(episode.at_ms)}${episode.kind ? ` [${episode.kind}]` : ''} ${episode.title}`);
    const links = linkedPages(guildId, path, 4).map((row) => row.path);
    const block = [
      `### ${path}${node.summary ? ` — ${node.summary}` : ''}`,
      ...(node.aliases.length ? [`別名: ${node.aliases.join(', ')}`] : []),
      ...(head ? [head] : []),
      ...(recent.length ? [`最近の出来事: ${recent.join(' / ')}`] : []),
      ...(links.length ? [`つながり: ${links.join(', ')}`] : [])
    ].join('\n');
    if (used + block.length > maxChars) break;
    blocks.push(block);
    used += block.length;
  }
  return blocks.join('\n\n');
}
