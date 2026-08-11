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

import { chunkCoverage, chunkMessages } from '../archive/chunks.js';
import { fetchChunks, scanChunksTopK } from '../archive/vectors.js';
import { resolveModel } from '../archive/embed-job.js';
import { embedConfig } from '../embed/config.js';
import { embedTexts, isDisabled } from '../embed/worker.js';
import { agentConfig } from './config.js';
import { shortTime, truncate } from './format.js';

/** ベクトルが1件も無い / サーキットブレーク中はモードを出さない。 */
export async function semanticAvailable(guildId) {
  if (!embedConfig.enabled || isDisabled()) return false;

  try {
    const { modelId } = await resolveModel();
    return chunkCoverage(guildId, modelId).done > 0;
  } catch {
    return false;
  }
}

/** 参加者を「たこ/さば/りん」の形にする。3人を超えたら数で出す。 */
function participantLabel(rows) {
  const names = [...new Set(rows.map((row) => row.author_name || 'unknown'))];
  return names.length <= 3 ? names.join('/') : `${names.slice(0, 3).join('/')}他${names.length - 3}人`;
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
export async function runSemanticSearch(ctx, {
  queryText,
  filters = {},
  excludeId = null,
  limit = 10,
  escalated = false
}) {
  const text = String(queryText ?? '').trim();
  if (!text) return 'query を指定してください。';

  const { modelId, dim } = await resolveModel();
  const stats = chunkCoverage(ctx.guild.id, modelId);

  if (stats.done === 0) {
    return '意味検索用のベクトルがまだありません。管理者が `/index embed` を実行すると使えるようになります。';
  }

  let embedded;
  try {
    embedded = await embedTexts([text], { kind: 'query', encode: 'float32' });
  } catch (error) {
    return `意味検索は今使えません (${truncate(error.message, 120)})。言い換えを何通りか試してください。`;
  }

  const bytes = Buffer.from(embedded.vectors[0], 'base64');
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
        `候補が ${result.total.toLocaleString()} 件で上限 ${embedConfig.maxCandidates.toLocaleString()} 件を超えました。`,
        'author / channel / after のどれかで絞ってください',
        '(この道具は「誰かの発言の中から」探すのが一番効きます)。'
      ].join('');
  }

  const chunks = fetchChunks(result.hits.map((hit) => hit.cid));

  // 起点にした発言そのものが入っているまとまりは外す。
  // 残すと必ず1位を占め、下の相対カットオフの基準を押し上げて、
  // 本当に近いまとまりまで切り落とす。
  const scoreById = new Map(result.hits.map((hit) => [hit.cid, hit.score]));
  const loaded = chunks
    .map((chunk) => ({ chunk, rows: chunkMessages(chunk), score: scoreById.get(chunk.chunk_id) ?? 0 }))
    .filter(({ rows }) => !(excludeId && rows.some((row) => row.message_id === excludeId)));

  if (loaded.length === 0) {
    return escalated ? '(意味検索も走らせたが0件)' : '意味の近い会話は見つかりませんでした。';
  }

  // 相対カットオフ。閾値では絞れないので「1位からどれだけ落ちたか」で切る。
  // これが無いと limit の枠を埋めるために無関係な会話が並び、モデルが
  // 「これも関連している」と誤読する。
  const top = loaded[0].score;
  const picked = loaded
    .filter((entry) => entry.score >= top - embedConfig.relativeCutoff)
    .slice(0, limit);

  const dropped = loaded.length - picked.length;
  const ranks = new Map(picked.map((entry, index) => [entry.chunk.chunk_id, index + 1]));

  // 時系列に並べ直す。立場の変遷では時系列そのものが答えになる。
  const ordered = [...picked].sort((a, b) => a.chunk.from_ms - b.chunk.from_ms);

  const lines = ordered.map(({ chunk, rows, score }) => {
    // 参照番号はまとまりの先頭の発言に付ける。URL がやり取りの入口を指す。
    const ref = ctx.refs.add({
      guildId: chunk.guild_id,
      channelId: chunk.channel_id,
      channelName: channelLabel(ctx, chunk.channel_id),
      messageId: chunk.from_id,
      authorId: rows[0]?.author_id ?? '0',
      authorName: rows[0]?.author_name ?? 'unknown',
      content: rows.map((row) => row.content).join(' / '),
      createdAt: chunk.from_ms
    });

    const head = [
      shortTime(chunk.from_ms),
      `#${channelLabel(ctx, chunk.channel_id)}`,
      `${chunk.msg_count}件`,
      participantLabel(rows)
    ].join(' ');

    const body = truncate(
      rows.map((row) => `${row.author_name}: ${row.content}`).join(' / '),
      agentConfig.messageChars * 2
    );

    return `${ref}) [${head}] ${body} 近さ#${ranks.get(chunk.chunk_id)}(${score.toFixed(2)})`;
  });

  return [
    `意味が近い会話 ${ordered.length} 件 (類似度 ${top.toFixed(2)}〜${picked[picked.length - 1].score.toFixed(2)}、候補 ${result.total.toLocaleString()} 件)`,
    `埋め込み済み: このサーバーの会話の ${Math.round(stats.ratio * 100)}%`
      + (stats.ratio < 0.99 ? '。ここに無い=言っていない、ではない。' : ''),
    dropped > 0 ? `(1位から離れすぎた ${dropped} 件は関連が薄いので除外した)` : '',
    '類似度は相対値。無関係な文でも 0.78 前後になるので、順位で見ること。',
    // 自動で走らせたぶんは「一致した結果」と読まれると困る。毎回言う。
    escalated ? '以下は文字列一致ではない。断定する前に read で前後を読むこと。' : '',
    '--- 時系列順 (番号はその会話の先頭の発言) ---',
    ...lines,
    '会話まるごと読むなら read の at にその番号を渡す。'
  ].filter(Boolean).join('\n');
}

function channelLabel(ctx, channelId) {
  return ctx.guild.channels.cache.get(channelId)?.name ?? channelId;
}
