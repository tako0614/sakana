import {
  episodesFor, getNode, linkedPages, nodeNames, recentEpisodesFor, searchEpisodes, searchNodes, sharedEpisodes,
  type NodeName
} from './store.js';
import { meaningOf, type Meaning } from './vectors.js';

// 思い出す。会話に出た名前や言葉を手がかりに、関係するページと出来事を数件だけ引く。
// 同期の recallFor は名前・別名の照合 + 全文検索。手がかりから1段だけ
// つながりをたどる: 2人の名前が出たら、その2人が両方関わった出来事を出す。
// 非同期の recallWithMeaning / meaningReader は、そのあとに意味の近い記憶 (vectors.ts) を足す。
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

/** 思い出した文面と、そこに出したページ・出来事 (あとの想起で同じものを繰り返さないため)。 */
export interface RecallParts {
  text: string;
  paths: Set<string>;
  episodeIds: Set<number>;
}

/**
 * 会話 agent の入力に足す「思い出したこと」。何も当たらなければ空文字 (何も足さない)。
 * request: いま話しかけられた文 (と返信先)。context: 直近の会話 (弱い手がかり)。
 */
export function recallFor(guildId: string,
  { request = '', context = '', maxChars = 1800 }: { request?: string; context?: string; maxChars?: number } = {}): string {
  return recallParts(guildId, { request, context, maxChars }).text;
}

export function recallParts(guildId: string,
  { request = '', context = '', maxChars = 1800 }: { request?: string; context?: string; maxChars?: number } = {}): RecallParts {
  const scores = new Map<string, number>();
  const add = (path: string, value: number): void => { scores.set(path, (scores.get(path) ?? 0) + value); };
  for (const { path, score } of matchPages(guildId, request)) add(path, score);
  for (const { path, score } of matchPages(guildId, context, { limit: 6 })) add(path, score * 0.4);

  const terms = termsOf(request).join(' ');
  if (terms) {
    for (const row of searchNodes(guildId, terms, 3)) if (row.path.includes('/')) add(row.path, 0.5);
  }
  const episodeHits = terms ? searchEpisodes(guildId, terms, 3) : [];

  const pages = [...scores].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([path]) => path);
  if (pages.length === 0 && episodeHits.length === 0) return { text: '', paths: new Set(), episodeIds: new Set() };

  const lines = ['思い出したこと (記憶の見出しだけ。中身は memory ツールで path / episode を開いて読む):'];
  const shown = new Set<number>();
  for (const path of pages) {
    const node = getNode(guildId, path);
    if (!node) continue;
    // 見出しだけ。中身 (説明・本文) は入れない: 読みたければ memory ツールで path / episode を開く
    lines.push(`- [[${path}]]`);
    const episodes = episodesFor(guildId, path, 2).filter((episode) => !shown.has(episode.id));
    for (const episode of episodes) {
      shown.add(episode.id);
      lines.push(`  e${episode.id} ${date(episode.at_ms)}${episode.kind ? ` [${episode.kind}]` : ''} ${episode.title}`);
    }
  }
  // 2つ以上思い出したら、その間で起きたこと (複数のページをまたぐ出来事)
  const [firstPage, secondPage] = pages;
  if (firstPage !== undefined && secondPage !== undefined) {
    const shared = sharedEpisodes(guildId, firstPage, secondPage, 3).filter((episode) => !shown.has(episode.id));
    if (shared.length > 0) {
      lines.push(`- [[${firstPage}]] と [[${secondPage}]] の両方が関わった出来事:`);
      for (const episode of shared) { shown.add(episode.id); lines.push(`  e${episode.id} ${date(episode.at_ms)} ${episode.title}`); }
    }
  }
  const extra = episodeHits.filter((episode) => !shown.has(episode.id));
  if (extra.length > 0) {
    lines.push('- 言葉が一致した出来事:');
    for (const episode of extra) lines.push(`  e${episode.id} ${date(episode.at_ms)} ${episode.title}`);
  }
  const text = lines.join('\n');
  return { text: text.length > maxChars ? `${text.slice(0, maxChars)}…` : text, paths: new Set(pages), episodeIds: shown };
}

const MEANING_HEAD = '- 意味が近い記憶 (言葉は一致しないが、話が似ている):';

/** 意味で引いた記憶を、想起の1節にする。何も無ければ空配列。 */
export function meaningLines(meaning: Meaning | null): string[] {
  if (!meaning) return [];
  return [
    ...meaning.nodes.map((node) => `  [[${node.path}]]`),
    ...meaning.episodes.map((episode) => `  e${episode.id} ${date(episode.atMs)}${episode.kind ? ` [${episode.kind}]` : ''} ${episode.title}`)
  ];
}

/**
 * 呼ばれたときの想起: 名前の照合に、意味の近い記憶を足す。
 * 質問側の埋め込みが間に合わない・ベクトルが無いときは、名前の想起だけを返す (遅くしない)。
 */
export async function recallWithMeaning(guildId: string,
  { request = '', context = '', maxChars = 2400, timeoutMs = 3000 }: { request?: string; context?: string; maxChars?: number; timeoutMs?: number } = {}): Promise<RecallParts> {
  const parts = recallParts(guildId, { request, context, maxChars: 1800 });
  const lines = meaningLines(await meaningOf(guildId, request, { excludePaths: parts.paths, excludeEpisodes: parts.episodeIds, timeoutMs }));
  if (lines.length === 0) return parts;
  const head = parts.text || '思い出したこと (記憶の見出しだけ。中身は memory ツールで path / episode を開いて読む):';
  const text = [head, MEANING_HEAD, ...lines].join('\n');
  for (const line of lines) {
    const page = /^ {2}\[\[([^\]]+)\]\]/.exec(line)?.[1];
    if (page) parts.paths.add(page);
    const episode = /^ {2}e(\d+) /.exec(line)?.[1];
    if (episode) parts.episodeIds.add(Number(episode));
  }
  return { text: text.length > maxChars ? `${text.slice(0, maxChars)}…` : text, paths: parts.paths, episodeIds: parts.episodeIds };
}

/**
 * 考えている途中の想起 (runtime が往復ごとに呼ぶ)。いま調べていること (道具の結果) と依頼から、
 * まだ出していない記憶だけを足す。最初の往復 (道具の結果がまだ無い) は、呼ばれたときの想起が済んでいるので何も足さない。
 */
export function meaningReader(guildId: string, seed: { request: string; shown?: RecallParts | undefined }):
  (query: { observations: string[] }) => Promise<{ text: string } | null> {
  const paths = new Set(seed.shown?.paths);
  const episodeIds = new Set(seed.shown?.episodeIds);
  return async ({ observations }) => {
    if (observations.length === 0) return null;
    const noticed = observations.map((observation) => observation.replace(/^tool:[^:]*:\s*/, '').slice(0, 500));
    const query = [seed.request.slice(0, 400), ...noticed].join('\n').slice(0, 1400);
    const meaning = await meaningOf(guildId, query, { nodeLimit: 2, episodeLimit: 2, excludePaths: paths, excludeEpisodes: episodeIds, timeoutMs: 2000 });
    const lines = meaningLines(meaning);
    if (lines.length === 0 || !meaning) return null;
    for (const node of meaning.nodes) paths.add(node.path);
    for (const episode of meaning.episodes) episodeIds.add(episode.id);
    return { text: ['調べている内容に近い記憶 (見出しだけ。まだ出していないもの。中身は memory ツールで path / episode を開いて読む):', ...lines].join('\n') };
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
