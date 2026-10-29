import {
  episodesFor, getNode, linkedPages, nodeNames, recentEpisodesFor, searchEpisodes, searchNodes, sharedEpisodes,
  type NodeName
} from './store.js';
import { recallPack } from './pack.js';
import { embedQuery, hasVectors, meaningOf, scoresFor, type Meaning, type MeaningChunk, type QuerySegment } from './vectors.js';

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
  /** 意味で引いた断片 (ページの中の1つの知識) のうち、出したもの。 */
  chunkIds: Set<number>;
}

/**
 * 会話 agent の入力に足す「思い出したこと」。何も当たらなければ空文字 (何も足さない)。
 * request: いま話しかけられた文 (と返信先)。context: 直近の会話 (弱い手がかり)。
 */
export function recallFor(guildId: string,
  { request = '', context = '', maxChars = 1800 }: { request?: string; context?: string; maxChars?: number } = {}): string {
  return recallParts(guildId, { request, context, maxChars }).text;
}

/**
 * 直近の会話に出てくる名前のページを、どれだけ手がかりにするか。0 なら使わない。
 * 本番の実行記録 (2026-10-18、29 件) では、0.4 にしていたせいで、依頼に名前が無いと直近の会話の常連 (t3tra・たこ・さかな)
 * のページと、そのページのいつもの上位の出来事が毎回出て (28 件)、依頼と関係のない話を持ち出す元になっていた。
 */
const CONTEXT_WEIGHT = Number(process.env.MEMORY_RECALL_CONTEXT_WEIGHT ?? 0);

/** ページに出す出来事の候補を、依頼に近い順に絞る。渡さなければ、ページの重要度順の上位 2 件 (従来どおり)。 */
export type EpisodeRanker = <T extends { id: number }>(episodes: T[]) => T[];

export function recallParts(guildId: string,
  { request = '', context = '', maxChars = 1800, rank }: { request?: string; context?: string; maxChars?: number; rank?: EpisodeRanker } = {}): RecallParts {
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
  if (pages.length === 0 && episodeHits.length === 0) return { text: '', paths: new Set(), episodeIds: new Set(), chunkIds: new Set() };

  const lines = ['思い出したこと (記憶の見出しだけ。中身は memory ツールで path / episode を開いて読む):'];
  const shown = new Set<number>();
  for (const path of pages) {
    const node = getNode(guildId, path);
    if (!node) continue;
    // 見出しだけ。中身 (説明・本文) は入れない: 読みたければ memory ツールで path / episode を開く
    lines.push(`- [[${path}]]`);
    const episodes = (rank ? rank(episodesFor(guildId, path, 16)) : episodesFor(guildId, path, 2)).filter((episode) => !shown.has(episode.id)).slice(0, 2);
    for (const episode of episodes) {
      shown.add(episode.id);
      lines.push(`  e${episode.id} ${date(episode.at_ms)}${episode.kind ? ` [${episode.kind}]` : ''} ${episode.title}`);
    }
  }
  // 2つ以上思い出したら、その間で起きたこと (複数のページをまたぐ出来事)
  const [firstPage, secondPage] = pages;
  if (firstPage !== undefined && secondPage !== undefined) {
    const shared = (rank ? rank(sharedEpisodes(guildId, firstPage, secondPage, 12)) : sharedEpisodes(guildId, firstPage, secondPage, 3)).filter((episode) => !shown.has(episode.id)).slice(0, 3);
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
  return { text: text.length > maxChars ? `${text.slice(0, maxChars)}…` : text, paths: new Set(pages), episodeIds: shown, chunkIds: new Set() };
}

const MEANING_HEAD = '- 意味が近い記憶 (言葉は一致しないが、話が似ている。§ はページの中の節で、path と section で開ける。e は根拠の出来事):';
/** 想起に出す断片の頭の長さ。中身を入れるためではなく、どの話が当たったかが分かる程度。0 なら出さず、ページと節と出来事の番号だけ。 */
const SNIPPET_CHARS = Number(process.env.MEMORY_CHUNK_SNIPPET ?? 60);
/** 1つの断片に添える根拠の出来事の数。 */
const CHUNK_EPISODES = 2;

const clip = (text: string, limit: number): string => ([...text].length > limit ? `${[...text].slice(0, limit).join('')}…` : text);

/** 断片に添える根拠の出来事 (想起の行に出す分)。 */
export const shownEpisodes = (chunk: MeaningChunk): number[] => chunk.episodeIds.slice(0, CHUNK_EPISODES);

function chunkLine(chunk: MeaningChunk): string {
  const snippet = SNIPPET_CHARS > 0 ? ` — ${clip(chunk.line, SNIPPET_CHARS)}` : '';
  const more = chunk.more > 0 ? ` (同じ節にほか ${chunk.more} 件)` : '';
  return `  [[${chunk.path}]]${chunk.heading ? ` §${chunk.heading}` : ''}${snippet}${more}${shownEpisodes(chunk).map((id) => ` e${id}`).join('')}`;
}

/** 意味で引いた記憶を、想起の1節にする。何も無ければ空配列。 */
export function meaningLines(meaning: Meaning | null): string[] {
  if (!meaning) return [];
  // 断片が出たページは、断片の行に任せる (ページの行を重ねない)
  const chunked = new Set(meaning.chunks.map((chunk) => chunk.path));
  return [
    ...meaning.chunks.map(chunkLine),
    ...meaning.nodes.filter((node) => !chunked.has(node.path)).map((node) => `  [[${node.path}]]`),
    ...meaning.episodes.map((episode) => `  e${episode.id} ${date(episode.atMs)}${episode.kind ? ` [${episode.kind}]` : ''} ${episode.title}`)
  ];
}

/** 出したものを、あとの想起で繰り返さないよう控える。 */
function remember(shown: RecallParts, meaning: Meaning): void {
  for (const node of meaning.nodes) shown.paths.add(node.path);
  for (const episode of meaning.episodes) shown.episodeIds.add(episode.id);
  for (const chunk of meaning.chunks) {
    shown.chunkIds.add(chunk.id);
    shown.paths.add(chunk.path);
    for (const id of shownEpisodes(chunk)) shown.episodeIds.add(id);
  }
}

/**
 * 直前の会話を意味検索の手がかりにするか (MEMORY_CONVERSATION_CLUE=1 で有効。既定はオフ)。
 * 本番の #雑談 で測ったところ (docs/memory-chunks.md)、会話文を埋め込むと、記憶に関係があるかどうかにかかわらず 1 位が 0.88〜0.91 に
 * 集まり (発言者の名前を外しても 0.88 前後)、スコアで選り分けられない。「あの9.9は…」のように話題が会話にある依頼は引けるが、
 * 記憶と関係ない雑談では的外れが増える。話題が会話にある依頼は、モデルが memory_focus で言い直すほうが確かなので、既定では使わない。
 */
const conversationClue = (): boolean => !['', '0', 'false', 'no', 'off'].includes(String(process.env.MEMORY_CONVERSATION_CLUE ?? '').toLowerCase());
/** 有効にしたとき、直前の会話の手がかりが依頼より弱い分。 */
/** 名前で見つけたページの出来事を出す、依頼への近さの下限 (意味で引く出来事の下限と同じ)。 */
const PAGE_EPISODE_FLOOR = Number(process.env.MEMORY_PAGE_EPISODE_FLOOR ?? process.env.MEMORY_RECALL_FLOOR ?? 0.85);
const CONVERSATION_PENALTY = Number(process.env.MEMORY_CONVERSATION_PENALTY ?? 0.01);

/**
 * 直前の会話 (LLM に見せている会話文のうち、依頼の前の数発言) を、想起の手がかりの 1 本の文にする。
 * 「名前: 本文」を古い順に並べ、URL・メンションを除き、長ければ近い (後ろの) ほうを残す。system プロンプトは含めない。
 * 「あの件どうなった？」「それって誰？」のように、話題が依頼文でなく直前の会話にあるときに効く。
 */
export function conversationText(messages: readonly { authorName?: string | undefined; content?: string | undefined }[], { limit = 6, chars = 500 }: { limit?: number; chars?: number } = {}): string {
  const lines = messages.slice(-limit).flatMap((message) => {
    const body = String(message.content ?? '').replace(/https?:\/\/\S+/g, '').replace(/<[@#&!]*\d+>/g, '').replace(/\s+/g, ' ').trim();
    return body ? [`${message.authorName ?? ''}: ${body}`] : [];
  });
  const text = lines.join('\n');
  return text.length > chars ? text.slice(-chars) : text;
}

/**
 * 呼ばれたときの想起: 名前の照合に、意味の近い記憶を足す。
 * conversation (直前の会話) があれば、依頼とは別の手がかりとして足す (少し弱く)。
 * 質問側の埋め込みが間に合わない・ベクトルが無いときは、名前の想起だけを返す (遅くしない)。
 */
export async function recallWithMeaning(guildId: string,
  { request = '', context = '', conversation = '', maxChars = 2400, timeoutMs = 3000 }: { request?: string; context?: string; conversation?: string; maxChars?: number; timeoutMs?: number } = {}): Promise<RecallParts> {
  // v2 の記憶 (主張の索引がある) は、メモリパック: 入口の門 → 候補 → 判定モデルの再順位づけ → 関係する主張そのものを渡す。
  // 索引が無い・判定モデルが使えないときは null で、従来の見出しの想起に落ちる
  const pack = await recallPack(guildId, { request }).catch((error: unknown) => {
    console.error('Memory pack failed:', error);
    return null;
  });
  if (pack) return pack;
  // 名前で見つけたページの出来事は、重要度順でなく依頼に近い順に選ぶ (近いものが無ければ見出しだけ)。
  // 質問側の埋め込みが間に合わない・ベクトルが無いときは、従来の重要度順。
  const vector = hasVectors(guildId) && request.trim() ? await embedQuery(request, { timeoutMs }) : null;
  const rank: EpisodeRanker | undefined = vector
    ? (episodes) => {
      const near = scoresFor(guildId, 'episode', vector, episodes.map((episode) => episode.id));
      return episodes.filter((episode) => (near.get(episode.id) ?? 0) >= PAGE_EPISODE_FLOOR)
        .sort((a, b) => (near.get(b.id) ?? 0) - (near.get(a.id) ?? 0));
    }
    : undefined;
  const parts = recallParts(guildId, { request, context, maxChars: 1800, ...(rank ? { rank } : {}) });
  const query: string | QuerySegment[] = conversation.trim() && conversationClue() ? [{ text: request }, { text: conversation, penalty: CONVERSATION_PENALTY }] : request;
  const meaning = await meaningOf(guildId, query, { excludePaths: parts.paths, excludeEpisodes: parts.episodeIds, excludeChunks: parts.chunkIds, timeoutMs, queryVector: typeof query === 'string' ? vector : null });
  const lines = meaningLines(meaning);
  if (lines.length === 0 || !meaning) return parts;
  const head = parts.text || '思い出したこと (記憶の見出しだけ。中身は memory ツールで path / episode を開いて読む):';
  const text = [head, MEANING_HEAD, ...lines].join('\n');
  remember(parts, meaning);
  return { text: text.length > maxChars ? `${text.slice(0, maxChars)}…` : text, paths: parts.paths, episodeIds: parts.episodeIds, chunkIds: parts.chunkIds };
}

/** memory_focus の中身 (runtime が「memory_focus.context: …」の形で渡す) から、ラベルを外した本文。 */
export const focusOf = (thought: string | undefined): string => (thought ?? '')
  .replace(/^memory_focus\.(?:context|thought):\s*/gm, '')
  .replace(/\s+/g, ' ')
  .trim()
  .slice(0, 700);

const union = <T>(...sets: ReadonlySet<T>[]): Set<T> => new Set(sets.flatMap((set) => [...set]));

/**
 * 考えている途中の想起 (runtime が往復ごとに呼ぶ)。依頼と、モデルが直前に考えていたこと (CoT)、いま調べていること
 * (道具の結果) から、まだ出していない記憶だけを足す。最初の往復 (道具の結果がまだ無い) は、呼ばれたときの想起が済んでいるので何も足さない。
 * 思考は provider が文章で返したときだけ (暗号化されたものは読めない) で、無ければ依頼と道具の結果で引く。
 *
 * モデルが memory_focus で「いま思い出したいこと」を示したら、それを最優先の手がかりにして選び直す (想起は受動のまま、向きだけ変える)。
 * 焦点は runtime が次の 1 回のモデル呼び出しにだけ使い、応答が返ったら捨てる (one-shot)。モデルが明示的に選び直したのだから、
 * 前の往復で出した指し先も出し直す (往復ごとの想起はその往復にしか付かず、入力にはもう残っていない)。
 * 焦点が無い往復は、途中で出したものを繰り返さない。入力に残っている開始時の想起 (seed.shown) は、どちらでも出さない。
 */
export function meaningReader(guildId: string, seed: { request: string; shown?: RecallParts | undefined; conversation?: string | undefined }):
  (query: { observations: string[]; reasoning?: string | undefined; thought?: string | undefined }) => Promise<{ text: string } | null> {
  const start: RecallParts = { text: '', paths: new Set(seed.shown?.paths), episodeIds: new Set(seed.shown?.episodeIds), chunkIds: new Set(seed.shown?.chunkIds) };
  const mid: RecallParts = { text: '', paths: new Set(), episodeIds: new Set(), chunkIds: new Set() };
  return async ({ observations, reasoning, thought }) => {
    const focus = focusOf(thought);
    if (observations.length === 0 && !focus) return null;
    // 既定: 手がかりを順につないで 1 本の質問にする。(焦点) → 依頼 → モデル自身が直前に考えていたこと (CoT。読めるときだけ) → 道具が返した内容。
    // 埋め込みが読めるのは 500 字ほどなので、実際に効くのは前のほう (焦点・依頼・思考の頭) で、後ろの道具の結果は切れる。
    // 道具の結果を別に埋め込むと、7〜9 割が下限を超えて毎往復の想起が的外れで埋まるので (docs/memory-chunks.md)、そうしていない。
    const noticed = observations.map((observation) => observation.replace(/^tool:[^:]*:\s*/, '').slice(0, 300));
    const chained = [...(focus ? [focus] : []), seed.request.slice(0, 300), ...(reasoning ? [reasoning.slice(-600)] : []), ...noticed].join('\n').slice(0, 1600);
    // 直前の会話の手がかりを有効にしたときだけ、別々に埋め込んでいちばん近いものを採る (会話は少し弱く)
    const query: string | QuerySegment[] = seed.conversation?.trim() && conversationClue()
      ? [
        ...(focus ? [{ text: focus }] : []),
        { text: seed.request.slice(0, 300) },
        { text: seed.conversation, penalty: CONVERSATION_PENALTY },
        ...(reasoning ? [{ text: reasoning.slice(-600) }] : []),
        ...noticed.map((text) => ({ text }))
      ]
      : chained;
    // 焦点があるときは、途中で出したものも出し直す (その往復にしか付いていなかったので、もう入力に無い)
    const skip = focus ? start : { paths: union(start.paths, mid.paths), episodeIds: union(start.episodeIds, mid.episodeIds), chunkIds: union(start.chunkIds, mid.chunkIds) };
    const meaning = await meaningOf(guildId, query, { nodeLimit: 2, episodeLimit: 2, chunkLimit: 2, excludePaths: skip.paths, excludeEpisodes: skip.episodeIds, excludeChunks: skip.chunkIds, timeoutMs: 2000 });
    const lines = meaningLines(meaning);
    if (lines.length === 0 || !meaning) return null;
    remember(mid, meaning);
    const head = focus
      ? 'あなたが示した焦点に近い記憶 (見出しだけ。§ は節で、path と section で開ける。中身は memory ツールで path / episode を開いて読む):'
      : '調べている内容に近い記憶 (見出しだけ。まだ出していないもの。§ は節で、path と section で開ける。中身は memory ツールで path / episode を開いて読む):';
    return { text: [head, ...lines].join('\n') };
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
