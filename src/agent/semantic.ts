// 意味検索 (mode:meaning)。
//
// mode:keyword は文字列一致なので、「レビュー無しでマージするのは絶対に
// やめるべき」と「急ぎだから自分のPRはレビュー飛ばして通した」を結び付けられない
// (共通する部分文字列がほぼ無い)。言い換えを跨ぐにはこれが必要。
//
// 単位は1発言ではなく「会話のまとまり」。理由は chunks.js に書いてある。
//
// 実測で分かった重要な性質: 無関係な日本語の文どうしでもコサインは 0.77〜0.82 出る。
// まとまりにしても下がらない (0.7988 → 0.8045 で、むしろ僅かに上がった)。
// つまり絶対閾値では絞れず、意味があるのは順位だけ。生のスコアだけをモデルに
// 見せると「0.79 も高いから似ている」と誤読するので、順位と併記し、
// 相対値であることを明記する。

import { chunkCoverage, chunkMessages, hasChunkVectors } from '../archive/chunks.js';
import { resolveModel } from '../archive/embed-job.js';
import type { MessageRow } from '../archive/types.js';
import { fetchChunks, scanChunksTopK, type ChunkFilters } from '../archive/vectors.js';
import { embedConfig } from '../embed/config.js';
import { embedTexts, isDisabled, type EmbedReply } from '../embed/worker.js';
import { agentConfig } from './config.js';
import { createConversationFormatter, fromArchiveRow, shortTime, truncate } from './format.js';
import { resolveCachedDisplay } from './prompt.js';
import { errorMessage, type AgentContext } from './types.js';

type SemanticContext = Pick<AgentContext, 'guild' | 'refs' | 'channelScope' | 'client' | 'member' | 'viewer'>;

// embed/config.js の値は env から来るので、数として読み直す
const maxCandidates = Number(embedConfig.maxCandidates);
const relativeCutoff = Number(embedConfig.relativeCutoff);

/** ベクトルが1件も無い / サーキットブレーク中はモードを出さない。 */
export async function semanticAvailable(guildId: string): Promise<boolean> {
  if (!embedConfig.enabled || isDisabled()) return false;

  try {
    const { modelId } = await resolveModel();
    return hasChunkVectors(guildId, modelId);
  } catch {
    return false;
  }
}

/**
 * 意味検索の本体。
 *
 * filters は呼び出し側 (tools.js) が解決して渡す。表示名の ID 解決も日付の
 * 解釈もツール側の仕事で、ここは「絞った上で近い順に出す」だけにしてある
 * (tools.js から import すると members.js のコメントどおり循環する)。
 *
 * escalated: キーワード検索が0件だったので自動で続けて走らせた場合。
 * 頼まれていない検索なので、見出しと絞り込みの案内を変える。
 */
export async function runSemanticSearch(ctx: SemanticContext, {
  queryText,
  filters = {},
  excludeId = null,
  limit = 10,
  escalated = false
}: {
  queryText: unknown;
  filters?: ChunkFilters;
  excludeId?: string | null;
  limit?: number;
  escalated?: boolean;
}): Promise<string> {
  const text = String(queryText ?? '').trim();
  if (!text) return 'query を指定してください。';

  const { modelId, dim } = await resolveModel();
  const stats = chunkCoverage(ctx.guild.id, modelId);

  if (stats.done === 0) {
    return '意味検索用のベクトルがまだありません。管理者が `/index embed` を実行すると使えるようになります。';
  }

  let embedded: EmbedReply;
  try {
    embedded = await embedTexts([text], { kind: 'query', encode: 'float32' });
  } catch (error) {
    return `意味検索は今使えません (${truncate(errorMessage(error), 120)})。言い換えを何通りか試してください。`;
  }

  // 子プロセスの出力 (worker.ts が形を確かめて返す)。ベクトルが無い・次元が足りないときは埋め込み失敗と同じ扱いにする
  const vector = embedded.vectors[0] ?? null;
  const bytes = vector === null ? Buffer.alloc(0) : Buffer.from(vector, 'base64');
  if (bytes.byteLength < dim * Float32Array.BYTES_PER_ELEMENT) {
    return '意味検索は今使えません (埋め込みの結果を読めませんでした)。言い換えを何通りか試してください。';
  }
  const queryVec = new Float32Array(bytes.buffer, bytes.byteOffset, dim);

  const result = scanChunksTopK({
    guildId: ctx.guild.id,
    modelId,
    queryVec,
    filters,
    channelScope: ctx.channelScope,
    limit
  });

  if (result.tooMany) {
    // 自動で走らせたときに「絞ってください」と指示するのは不可解に読まれる
    // (モデルはこの検索を頼んでいない)。1行に畳む。
    return escalated
      ? `(意味検索も試したが候補が ${result.total.toLocaleString()} 件で多すぎた。author か channel で絞れば mode:meaning で引ける)`
      : [
        `候補が ${result.total.toLocaleString()} 件で上限 ${maxCandidates.toLocaleString()} 件を超えました。`,
        'author / channel / after のどれかで絞ってください',
        '(この道具は「誰かの発言の中から」探すのが一番効きます)。'
      ].join('');
  }

  const { hits } = result;
  const chunks = fetchChunks(hits.map((hit) => hit.cid));

  // 起点にした発言そのものが入っているまとまりは外す。
  // 残すと必ず1位を占め、下の相対カットオフの基準を押し上げて、
  // 本当に近いまとまりまで切り落とす。
  const scoreById = new Map(hits.map((hit) => [hit.cid, hit.score]));
  const loaded = chunks
    .map((chunk) => ({ chunk, rows: chunkMessages(chunk).filter((row) => row.guild_id === ctx.guild.id), score: scoreById.get(chunk.chunk_id) ?? 0 }))
    .filter(({ rows }) => rows.length && !(excludeId && rows.some((row) => row.message_id === excludeId)));

  if (loaded.length === 0) {
    return escalated ? '(意味検索も走らせたが0件)' : '意味の近い会話は見つかりませんでした。';
  }

  // 相対カットオフ。閾値では絞れないので「1位からどれだけ落ちたか」で切る。
  // これが無いと limit の枠を埋めるために無関係な会話が並び、モデルが
  // 「これも関連している」と誤読する。
  // 上で0件のときは返してあるので、先頭は必ずある
  const top = loaded[0]?.score ?? 0;
  const picked = loaded
    .filter((entry) => entry.score >= top - relativeCutoff)
    .slice(0, limit);

  const dropped = loaded.length - picked.length;
  const ranks = new Map(picked.map((entry, index) => [entry.chunk.chunk_id, index + 1]));

  // 時系列に並べ直す。立場の変遷では時系列そのものが答えになる。
  const ordered = [...picked].sort((a, b) => a.chunk.from_ms - b.chunk.from_ms);

  const transcripts = formatSemanticConversations(ctx, ordered.map(({ chunk, rows, score }) => ({
    rows, score, rank: ranks.get(chunk.chunk_id) ?? 0, count: chunk.msg_count
  })));

  return [
    `意味が近い会話 ${ordered.length} 件 (類似度 ${top.toFixed(2)}〜${(picked[picked.length - 1]?.score ?? top).toFixed(2)}、候補 ${result.total.toLocaleString()} 件)`,
    `埋め込み済み: このサーバーの会話の ${Math.round(stats.ratio * 100)}%`
      + (stats.ratio < 0.99 ? '。ここに無い=言っていない、ではない。' : ''),
    dropped > 0 ? `(1位から離れすぎた ${dropped} 件は関連が薄いので除外した)` : '',
    '類似度は相対値。無関係な文でも 0.78 前後になるので、順位で見ること。',
    // 自動で走らせたぶんは「一致した結果」と読まれると困る。毎回言う。
    escalated ? '以下は文字列一致ではない。断定する前に read で前後を読むこと。' : '',
    '--- 会話の候補 (古い順) ---',
    transcripts,
    '会話を続けて読むなら、起点の発言番号を read の at に渡す。'
  ].filter(Boolean).join('\n');
}

function channelLabel(ctx: SemanticContext, channelId: string): string {
  return ctx.guild.channels.cache.get(channelId)?.name ?? channelId;
}

/** 会話の候補の先頭を、キーワード検索や read と同じ発言形式で渡す。 */
export function formatSemanticConversations(ctx: SemanticContext, candidates: readonly {
  rows: readonly MessageRow[]; score: number; rank: number; count: number;
}[]): string {
  const blocks = candidates.flatMap(({ rows, score, rank, count }) => {
    let remaining = agentConfig.messageChars * 2;
    const preview = [];
    for (const row of rows) {
      const bodyChars = Math.max(0, remaining - row.author_name.length - 5);
      if (preview.length && bodyChars === 0) break;
      const message = fromArchiveRow(row, channelLabel(ctx, row.channel_id));
      preview.push({ message, bodyChars });
      remaining = bodyChars - message.content.length;
    }
    const first = preview[0]?.message;
    if (!first) return [];
    // まとまりを検索の手がかりにできるよう、起点の参照に元の会話を残す。
    const anchor = ctx.refs.add({ ...first, content: rows.map((row) => row.content).join(' / ') });
    for (const { message } of preview) ctx.refs.add(message);
    return [{ head: `### 会話（起点 ${anchor}・表示 ${preview.length}/${count}件・近さ#${rank} ${score.toFixed(2)}）`, preview }];
  });
  if (!blocks.length) return '';
  const displayed = blocks.flatMap(({ preview }) => preview.map(({ message }) => message));
  const formatter = createConversationFormatter(displayed, {
    refs: ctx.refs, selfId: ctx.client?.user?.id, resolveDisplay: resolveCachedDisplay(ctx)
  });
  const sections = blocks.map(({ head, preview }) => [
    head,
    ...preview.map(({ message, bodyChars }) => formatter.render([message], { bodyChars, showChannel: true }))
  ].join('\n'));
  return [formatter.speakers, ...sections].join('\n\n');
}
