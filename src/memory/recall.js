import {
  episodesFor, getNode, linkedPages, nodeNames, recentEpisodesFor, searchEpisodes, searchNodes, sharedEpisodes
} from './store.js';

// 思い出す。会話に出た名前や言葉を手がかりに、関係するページと出来事を数件だけ引く。
// 埋め込みは使わない (ページ名と別名の照合 + 全文検索)。手がかりから1段だけ
// つながりをたどる: 2人の名前が出たら、その2人が両方関わった出来事を出す。
//
// 書く側 (build.js) も同じ照合で「この区切りに出てくる既知のページ」を見つけ、
// 書く前に渡す (重複を避け、変化として書かせ、前の出来事と結ばせる)。

const NAMES_TTL_MS = 5 * 60_000;
const cache = new Map();

function namesOf(guildId) {
  const hit = cache.get(guildId);
  if (hit && Date.now() - hit.at < NAMES_TTL_MS) return hit.names;
  const names = nodeNames(guildId)
    .map((entry) => ({ ...entry, key: entry.name.toLowerCase() }))
    .sort((a, b) => b.key.length - a.key.length);
  cache.set(guildId, { at: Date.now(), names });
  return names;
}

export function forgetNames(guildId) {
  cache.delete(guildId);
}

const date = (ms) => new Date(ms + 9 * 3_600_000).toISOString().slice(0, 10);

/** 文章に名前・別名が出てくるページ。出てきた回数と長さ、ページの重みで並べる。 */
export function matchPages(guildId, text, { limit = 12 } = {}) {
  const haystack = String(text ?? '').toLowerCase();
  if (!haystack) return [];
  const scores = new Map();
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

const termsOf = (text) => [...new Set(String(text ?? '')
  .replace(/https?:\/\/\S+/g, ' ')
  .split(/[\s　、。！？!?「」『』()（）:：,，.]+/)
  .filter((term) => [...term].length >= 3 && [...term].length <= 20))].slice(0, 6);

/**
 * 会話 agent の入力に足す「思い出したこと」。何も当たらなければ空文字 (何も足さない)。
 * request: いま話しかけられた文 (と返信先)。context: 直近の会話 (弱い手がかり)。
 */
export function recallFor(guildId, { request = '', context = '', maxChars = 1800 } = {}) {
  const scores = new Map();
  const add = (path, value) => scores.set(path, (scores.get(path) ?? 0) + value);
  for (const { path, score } of matchPages(guildId, request)) add(path, score);
  for (const { path, score } of matchPages(guildId, context, { limit: 6 })) add(path, score * 0.4);

  const terms = termsOf(request).join(' ');
  if (terms) {
    for (const row of searchNodes(guildId, terms, 3)) if (row.path.includes('/')) add(row.path, 0.5);
  }
  const episodeHits = terms ? searchEpisodes(guildId, terms, 3) : [];

  const pages = [...scores].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([path]) => path);
  if (pages.length === 0 && episodeHits.length === 0) return '';

  const lines = ['思い出したこと (記憶の本から。詳しくは memory ツールで path / episode を開く):'];
  const shown = new Set();
  for (const path of pages) {
    const node = getNode(guildId, path);
    if (!node) continue;
    lines.push(`- [[${path}]] ${node.summary || ''}`.trimEnd());
    const head = (node.body || node.pending).split('\n').filter(Boolean).slice(0, 3).join(' ').slice(0, 220);
    if (head) lines.push(`  ${head}`);
    const episodes = episodesFor(guildId, path, 2).filter((episode) => !shown.has(episode.id));
    for (const episode of episodes) {
      shown.add(episode.id);
      lines.push(`  e${episode.id} ${date(episode.at_ms)}${episode.kind ? ` [${episode.kind}]` : ''} ${episode.title}`);
    }
  }
  // 2つ以上思い出したら、その間で起きたこと (複数のページをまたぐ出来事)
  if (pages.length >= 2) {
    const shared = sharedEpisodes(guildId, pages[0], pages[1], 3).filter((episode) => !shown.has(episode.id));
    if (shared.length > 0) {
      lines.push(`- [[${pages[0]}]] と [[${pages[1]}]] の両方が関わった出来事:`);
      for (const episode of shared) { shown.add(episode.id); lines.push(`  e${episode.id} ${date(episode.at_ms)} ${episode.title}`); }
    }
  }
  const extra = episodeHits.filter((episode) => !shown.has(episode.id));
  if (extra.length > 0) {
    lines.push('- 言葉が一致した出来事:');
    for (const episode of extra) lines.push(`  e${episode.id} ${date(episode.at_ms)} ${episode.title}`);
  }
  const text = lines.join('\n');
  return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
}

/**
 * 区切りを書く前に渡す既知のページ。ログに出てくる名前から引き、
 * 説明・本文の冒頭・最近の出来事 (e 番号つき) を渡す。
 */
export function knownPagesFor(guildId, transcript, { limit = 12, maxChars = 6000 } = {}) {
  const blocks = [];
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
