import type { ToolDefinition } from '../ai/types.js';
import { db as archive } from '../archive/db.js';
import {
  topLevels, episodesFor, getEpisode, getNode, hasTree, linkedPages, listChildren, loadPublicChannels, nameOf,
  normalizePath, searchEpisodes, searchNodes, sharedEpisodes, type MemoryNode
} from './store.js';
import { meaningLines } from './recall.js';
import { scopeAllows, type ChannelScope, type QuoteFilter } from './types.js';
import { meaningOf, type Meaning } from './vectors.js';

// 会話 agent から見た記憶。根は system に常駐させ (毎回同じ文面なのでキャッシュが効く)、
// それより下は memory ツールでたどる: ページ → つながったページ / 関わった出来事 → 根拠の発言。
// 記憶 (要約とページ) は公開チャンネルと管理者が入れたチャンネルから作っていて、そのサーバーの誰に見せてもよい。
// 根拠の発言 (原文) は開くときにもう一度、いま読んでよいチャンネルかどうかを確かめ、
// 依頼した人の範囲 (channelScope / canQuote) が渡されていれば、その人が見られないチャンネルのものは出さない。

const BODY_CHARS = 6000;
const ROOT_PROMPT_CHARS = 2600;
const TZ_MS = 9 * 3_600_000;
const day = (ms: number): string => new Date(ms + TZ_MS).toISOString().slice(0, 10);
const minute = (ms: number): string => new Date(ms + TZ_MS).toISOString().slice(5, 16).replace('T', ' ');

/** 根拠の発言に振る引用番号の表 (agent の RefTable)。add は番号を返す。 */
export interface MemoryRefTable {
  add(entry: {
    guildId: string; channelId: string; channelName: string; messageId: string; authorId: string; authorName: string;
    content: string; createdAt: number;
  }): number | null | undefined;
}

/**
 * memory ツールを呼ぶ文脈。
 *   refs:         agent の RefTable。根拠の発言に引用番号を振る
 *   channelScope: 依頼した人が読めるチャンネル (agent の ctx.channelScope = getChannelScope(guild, member))。
 *                 渡すと、その人が見られないチャンネルの根拠の発言 (本文・引用番号) を出さない
 *   canQuote:     同じ判定を関数で渡す (/memory episode は見ている人の権限で判定する)
 * どちらも無ければ、記憶に入れたチャンネル全部の原文を出す (builder の CLI など、運用者が読むとき)。
 */
export interface MemoryToolContext {
  guildId: string;
  refs?: MemoryRefTable | null;
  channelScope?: ChannelScope | null;
  canQuote?: QuoteFilter | null;
}

/** モデル (または /memory) が渡す引数。どれも文字列のはずだが確かめてから使う。 */
export interface MemoryToolArgs {
  path?: unknown;
  with?: unknown;
  query?: unknown;
  episode?: unknown;
}

export const memoryToolDefinition: ToolDefinition = {
  type: 'function',
  function: {
    name: 'memory',
    description: '記憶 (このサーバーの過去ログを整理したもの) を読む。path でページ (説明・子・つながり・出来事)、'
      + 'path と with で2つが両方関わった出来事、query で検索、episode で出来事と根拠の発言 (引用番号つき) を開く。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '例: people/たこ。空なら根' },
        with: { type: 'string', description: 'path と一緒に関わったページ' },
        query: { type: 'string', description: '探す語 (スペース区切り)' },
        episode: { type: 'string', description: '出来事の番号。例: e12' },
        why: { type: 'string', description: 'なぜ・何を知りたくて呼ぶか (1文。想起の手がかりになる)' }
      }
    }
  }
};

export function hasMemory(guildId: string): boolean {
  try { return hasTree(guildId); } catch { return false; }
}

const episodeLine = (episode: { id: number; kind: string; title: string; at_ms: number }): string =>
  `e${episode.id} ${day(episode.at_ms)}${episode.kind ? ` [${episode.kind}]` : ''} ${episode.title}`;

function openPage(guildId: string, node: MemoryNode): string {
  const lines = [`# ${node.path || '(根)'}${node.summary ? ` — ${node.summary}` : ''}`];
  if (node.aliases.length) lines.push(`別名: ${node.aliases.join(', ')}`);
  if (node.first_at) {
    const from = day(node.first_at).slice(0, 7);
    const to = day(node.last_at ?? node.first_at).slice(0, 7);
    lines.push(`期間: ${from === to ? from : `${from}〜${to}`}`);
  }
  if (node.body) lines.push('', node.body.length > BODY_CHARS ? `${node.body.slice(0, BODY_CHARS)}\n…(以下略)` : node.body);
  if (node.pending) lines.push('', 'まだ本文に統合していない新しい知識:', node.pending.trim().split('\n').slice(0, 20).join('\n'));

  const children = listChildren(guildId, node.path, 41);
  if (children.length) {
    lines.push('', `子ページ${children.length > 40 ? ' (重い順に40件)' : ''}:`);
    for (const child of children.slice(0, 40)) {
      lines.push(`- [[${child.path}]] ${child.summary || ''}${child.children ? ` [子${child.children}]` : ''}`.trimEnd());
    }
  }
  if (node.path) {
    const links = linkedPages(guildId, node.path, 8);
    if (links.length) lines.push('', `つながり: ${links.map((link) => `[[${link.path}]]`).join(' ')}`);
    const episodes = episodesFor(guildId, node.path, 8);
    if (episodes.length) {
      lines.push('', '関わった出来事 (重要・新しい順。episode で根拠を開ける):', ...episodes.map((episode) => `- ${episodeLine(episode)}`));
    }
  }
  if (!node.body && !node.pending && children.length === 0) lines.push('', '(まだ中身がありません)');
  return lines.join('\n');
}

interface SourceRow {
  message_id: string;
  channel_id: string;
  author_id: string;
  author_name: string;
  content: string;
  created_at: number;
  channel_name: string | null;
}

/** 依頼した人にこのチャンネルの原文を見せてよいか (範囲が渡されていなければ見せる)。 */
function quotable(ctx: MemoryToolContext, channelId: string): boolean {
  if (ctx.channelScope && !scopeAllows(channelId, ctx.channelScope)) return false;
  if (ctx.canQuote && !ctx.canQuote(channelId)) return false;
  return true;
}

function openEpisode(ctx: MemoryToolContext, id: number): string {
  const episode = getEpisode(ctx.guildId, id);
  if (!episode) return `出来事 e${id} はありません。`;
  const channel = archive.prepare<[string], { name: string }>('SELECT name FROM channels WHERE channel_id = ?').get(episode.channel_id);
  const lines = [
    `e${episode.id} ${day(episode.at_ms)} #${channel?.name ?? episode.channel_id}${episode.kind ? ` [${episode.kind}]` : ''} — ${episode.title}`,
    episode.summary,
    `関わり: ${episode.nodes.map((path) => `[[${path}]]`).join(' ') || '-'}`
  ];
  if (episode.before.length) lines.push(`前の出来事: ${episode.before.map(episodeLine).join(' / ')}`);
  if (episode.after.length) lines.push(`後の出来事: ${episode.after.map(episodeLine).join(' / ')}`);

  // 根拠の発言。いま読んでよいチャンネルで、消されていないものだけ。依頼した人が見られないチャンネルのものは省く
  const open = new Set(loadPublicChannels(ctx.guildId)?.channelIds ?? []);
  const ids = [...new Set([...(episode.highlights ?? []), ...episode.sources])].slice(0, 12);
  const rows = ids.length ? archive.prepare<string[], SourceRow>(`
    SELECT m.message_id, m.channel_id, m.author_id, m.author_name, m.content, m.created_at, c.name AS channel_name
    FROM messages m LEFT JOIN channels c ON c.channel_id = m.channel_id
    WHERE m.message_id IN (${ids.map(() => '?').join(',')}) AND m.deleted = 0 ORDER BY m.created_at
  `).all(...ids) : [];
  const readable = rows.filter((row) => open.has(row.channel_id));
  const visible = readable.filter((row) => quotable(ctx, row.channel_id));
  const hidden = readable.length - visible.length;
  if (visible.length === 0) {
    lines.push(hidden ? '根拠の発言: (見られないチャンネルの発言は省きました)' : '根拠の発言: (消されたか、非公開になって開けません)');
  } else {
    // 決め台詞・名言として残した発言を先に (原文そのまま)
    const highlighted = new Set(episode.highlights ?? []);
    visible.sort((a, b) => Number(highlighted.has(b.message_id)) - Number(highlighted.has(a.message_id)) || a.created_at - b.created_at);
    lines.push('根拠の発言 (★ は決め台詞として残したもの):');
    for (const row of visible) {
      const ref = ctx.refs?.add({
        guildId: ctx.guildId, channelId: row.channel_id, channelName: row.channel_name ?? row.channel_id,
        messageId: row.message_id, authorId: row.author_id, authorName: row.author_name,
        content: row.content, createdAt: row.created_at
      });
      const text = row.content.replace(/\s*\n\s*/g, ' / ').slice(0, 300);
      lines.push(`${highlighted.has(row.message_id) ? '★ ' : ''}${ref ? `${ref}) ` : ''}${minute(row.created_at)} ${row.author_name}: ${text}`);
    }
    if (hidden) lines.push('(見られないチャンネルの発言は省きました)');
  }
  return lines.join('\n');
}

/**
 * ctx: { guildId, refs?, channelScope?, canQuote? } (MemoryToolContext)。
 * agent から呼ぶときは channelScope に依頼した人の ctx.channelScope を渡す (見られないチャンネルの原文を出さない)。
 */
export function runMemoryTool(ctx: MemoryToolContext, args: MemoryToolArgs = {}): string {
  const guildId = ctx.guildId;
  const episodeId = Number(String(args.episode ?? '').trim().replace(/^e/i, ''));
  if (args.episode && Number.isInteger(episodeId)) return openEpisode(ctx, episodeId);

  const query = String(args.query ?? '').trim();
  if (query) {
    const pages = searchNodes(guildId, query, 6);
    const episodes = searchEpisodes(guildId, query, 6);
    if (!pages.length && !episodes.length) return `記憶に「${query}」は見つかりませんでした。原文は search で探せます。`;
    return [
      ...(pages.length ? ['ページ:', ...pages.map((row) => `- [[${row.path}]] ${row.summary || ''}${row.snippet ? `\n  ${row.snippet.replace(/\n/g, ' ')}` : ''}`)] : []),
      ...(episodes.length ? ['出来事:', ...episodes.map((row) => `- ${episodeLine(row)}: ${row.summary.slice(0, 120)}`)] : [])
    ].join('\n');
  }

  const path = String(args.path ?? '').replace(/^\[\[|\]\]$/g, '').replace(/^\/+|\/+$/g, '').trim();
  const node = getNode(guildId, path) ?? (path ? getNode(guildId, normalizePath(path) ?? '') : null);
  if (!node || (path && !node.path)) {
    const guess = searchNodes(guildId, nameOf(path), 5);
    return [`ページ ${path} はありません。`, ...(guess.length ? ['近いもの:', ...guess.map((row) => `- [[${row.path}]] ${row.summary || ''}`)] : [])].join('\n');
  }

  const other = String(args.with ?? '').replace(/^\[\[|\]\]$/g, '').trim();
  if (other) {
    const target = getNode(guildId, other) ?? getNode(guildId, normalizePath(other) ?? '');
    if (!target) return `ページ ${other} はありません。`;
    const shared = sharedEpisodes(guildId, node.path, target.path, 15);
    if (!shared.length) return `[[${node.path}]] と [[${target.path}]] が両方関わった出来事は記録にありません。`;
    return [`[[${node.path}]] と [[${target.path}]] が両方関わった出来事 (古い順):`,
      ...shared.map((episode) => `- ${episodeLine(episode)}: ${episode.summary.slice(0, 160)}`)].join('\n');
  }
  return openPage(guildId, node);
}

/**
 * runMemoryTool に、意味の近い記憶を足したもの (agent が使う)。query のときだけ。
 * 言葉が一致しなくても (「レビューを飛ばした」→ ダブスタのページ) 近い話に届くようにする。
 * 埋め込みが間に合わない・ベクトルが無いときは runMemoryTool の結果そのまま。
 */
export async function runMemoryToolWithMeaning(ctx: MemoryToolContext, args: MemoryToolArgs = {}): Promise<string> {
  const base = runMemoryTool(ctx, args);
  const query = String(args.query ?? '').trim();
  if (!query || args.episode) return base;
  const meaning = await meaningOf(ctx.guildId, query, { nodeLimit: 3, episodeLimit: 3, timeoutMs: 3000 });
  if (!meaning) return base;
  // すでに言葉の検索で出たものは繰り返さない
  const fresh: Meaning = {
    nodes: meaning.nodes.filter((node) => !base.includes(`[[${node.path}]]`)),
    episodes: meaning.episodes.filter((episode) => !new RegExp(`(^|\\s)e${episode.id}\\s`).test(base))
  };
  const lines = meaningLines(fresh);
  if (lines.length === 0) return base;
  const notFound = base.startsWith('記憶に「');
  return [notFound ? '' : base, '意味が近い記憶 (言葉は一致しないが、話が似ている):', ...lines].filter((line) => line !== '').join('\n');
}

/**
 * system に入れる根。概要と、最上位ごとの重いページの名前だけ。記憶が無ければ空文字。
 * 長さは固定上限で切るので、記憶が育っても毎回の入力は増えない。
 */
export function memoryRootPrompt(guildId: string): string {
  if (!hasMemory(guildId)) return '';
  const root = getNode(guildId, '');
  const lines = [
    '## 記憶',
    'このサーバーの過去ログ (公開チャンネル) を整理した「記憶」の根。会話に出た名前から思い出したことは入力に添える。'
      + '足りなければ memory ツールでページ・つながり・出来事をたどり、根拠が要るときは episode で元の発言を開いて引用番号で示す。'
      + '記憶は要約なので、言い切る前に根拠を確かめる。'
  ];
  if (root?.body) lines.push('', root.body);
  lines.push('');
  for (const top of topLevels(guildId)) {
    const children = listChildren(guildId, top, 30);
    if (children.length === 0) continue;
    let line = `- ${top}/ (${children.length >= 30 ? '30+' : children.length}):`;
    for (const child of children) {
      const name = ` ${nameOf(child.path)},`;
      if (line.length + name.length > 260) { line += ' …'; break; }
      line += name;
    }
    lines.push(line.replace(/,$/, ''));
  }
  const text = lines.join('\n');
  return text.length > ROOT_PROMPT_CHARS ? `${text.slice(0, ROOT_PROMPT_CHARS)}…` : text;
}
