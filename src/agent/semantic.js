// 意味検索ツール。
//
// search_messages は文字列一致なので、「レビュー無しでマージするのは絶対に
// やめるべき」と「急ぎだから自分のPRはレビュー飛ばして通した」を結び付けられない
// (共通する部分文字列がほぼ無い)。言い換えを跨ぐにはこれが必要。
//
// 実測で分かった重要な性質: 無関係な日本語の文どうしでもコサインは 0.77〜0.82 出る。
// つまり絶対閾値では絞れず、意味があるのは順位だけ。生のスコアだけをモデルに
// 見せると「0.79 も高いから似ている」と誤読するので、順位と併記し、
// 相対値であることを明記する。

import { coverage, fetchByRowids, scanTopK } from '../archive/vectors.js';
import { resolveModel } from '../archive/embed-job.js';
import { embedConfig } from '../embed/config.js';
import { embedTexts, isDisabled } from '../embed/worker.js';
import { formatMessages, fromArchiveRow, truncate } from './format.js';

export const semanticToolDefinition = {
  type: 'function',
  function: {
    name: 'semantic_search',
    description: [
      '言い方が違っても意味が近い発言を探す。search_messages は文字列一致なので',
      '「レビュー無しでマージするのはやめるべき」と「急ぎだからレビュー飛ばして通した」を',
      '結び付けられない。同じ人の主張の食い違い (ダブスタ) を調べるときは author を指定して使う。',
      '返るのは「話題が近い発言」で、矛盾かどうかの判断はしない。',
      '類似度は相対値で、無関係な文でも 0.78 前後になる。絶対値で判断せず順位で見ること。',
      '断定する前に read_channel で前後を読むこと。'
    ].join(''),
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '探したい主張や話題。文で書くほうが効く。検索結果の参照番号を渡すとその発言に似た発言を探す' },
        author: { type: 'string', description: '投稿者 (表示名か ID)。食い違いを調べるならほぼ必須' },
        channel: { type: 'string', description: 'チャンネル (#名前か ID)' },
        after: { type: 'string', description: 'この日より後' },
        before: { type: 'string', description: 'この日より前' },
        filter: { type: 'string', description: '候補を先に絞る検索式 (search_messages の query と同じ書き方)' },
        limit: { type: 'number', description: '件数 (既定 10、最大 25)' }
      },
      required: ['query']
    }
  }
};

/** ベクトルが1件も無い / サーキットブレーク中はツールを出さない。 */
export async function semanticAvailable(guildId) {
  if (!embedConfig.enabled || isDisabled()) return false;

  try {
    const { modelId } = await resolveModel();
    return coverage(guildId, modelId).done > 0;
  } catch {
    return false;
  }
}

function collectFilters(args) {
  const extra = [];
  if (args.author) extra.push({ key: 'from', value: String(args.author) });
  if (args.channel) extra.push({ key: 'in', value: String(args.channel) });
  if (args.after) extra.push({ key: 'after', value: String(args.after) });
  if (args.before) extra.push({ key: 'before', value: String(args.before) });
  return extra;
}

export async function runSemanticSearch(ctx, args) {
  const raw = String(args.query ?? '').trim();
  if (!raw) return 'query を指定してください。';

  // 参照番号を渡されたらその発言文を query にする (「これに似た発言」が無料で付く)
  const referenced = ctx.refs.resolve(raw);
  const queryText = referenced?.content ? referenced.content : raw;
  const excludeId = referenced?.messageId ?? null;

  const { modelId, dim } = await resolveModel();
  const stats = coverage(ctx.guild.id, modelId);

  if (stats.done === 0) {
    return '意味検索用のベクトルがまだありません。管理者が `/index embed` を実行すると使えるようになります。';
  }

  let embedded;
  try {
    embedded = await embedTexts([queryText], { kind: 'query', encode: 'float32' });
  } catch (error) {
    return `意味検索は今使えません (${truncate(error.message, 120)})。search_messages で言い換えを何通りか試してください。`;
  }

  const bytes = Buffer.from(embedded.vectors[0], 'base64');
  const queryVec = new Float32Array(bytes.buffer, bytes.byteOffset, dim);

  const limit = Math.max(1, Math.min(25, Math.floor(Number(args.limit) || 10)));

  const options = {
    guildId: ctx.guild.id,
    query: String(args.filter ?? ''),
    extra: collectFilters(args),
    channelScope: ctx.channelScope, // 権限スコープは走査まで継承させる
    allowDeleted: false,
    sort: 'new'
  };

  const result = scanTopK({ options, modelId, queryVec, limit });

  if (result.tooMany) {
    return [
      `候補が ${result.total.toLocaleString()} 件で上限 ${embedConfig.maxCandidates.toLocaleString()} 件を超えました。`,
      'author / channel / after のどれかで絞ってください',
      '(この道具は「誰かの発言の中から」探すのが一番効きます)。'
    ].join('');
  }

  const candidates = result.hits.filter((hit) => !(excludeId && String(hit.rid) === String(excludeId)));
  if (candidates.length === 0) return '意味の近い発言は見つかりませんでした。';

  // 相対カットオフ。実測で無関係な日本語の文どうしでも 0.77〜0.82 出るので、
  // 絶対閾値では絞れない。代わりに「1位からどれだけ落ちたか」で切る。
  // これが無いと limit の枠を埋めるために無関係な発言が並び、モデルが
  // 「これも関連している」と誤読する。
  const top = candidates[0].score;
  const picked = candidates
    .filter((hit) => hit.score >= top - embedConfig.relativeCutoff)
    .slice(0, limit);

  const dropped = candidates.length - picked.length;

  const rows = fetchByRowids(picked.map((hit) => hit.rid));
  const scoreByRowid = new Map(picked.map((hit) => [hit.rid, hit.score]));
  const rankByRowid = new Map(picked.map((hit, index) => [hit.rid, index + 1]));

  // 表示は時系列に並べ直す。ダブスタでは時系列そのものが答えになる。
  // 同一本文の重複は落とす (スコアの近さで落とすと別内容まで消える)。
  const seen = new Set();
  const messages = rows
    .map((row) => ({
      ...fromArchiveRow(row, ctx.guild.channels.cache.get(row.channel_id)?.name ?? row.channel_id),
      rowid: row.rid
    }))
    .filter((message) => {
      const key = message.content.trim();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => a.createdAt - b.createdAt);

  const scores = picked.map((hit) => hit.score);
  const body = formatMessages(messages, {
    refs: ctx.refs,
    showChannel: true,
    bodyChars: 300,
    tailOf: (message) => {
      const rank = rankByRowid.get(message.rowid);
      const score = scoreByRowid.get(message.rowid);
      return rank ? `近さ#${rank}(${score.toFixed(2)})` : null;
    }
  });

  return [
    `意味が近い発言 ${messages.length} 件`
      + (args.author ? ` / ${args.author} の中から` : '')
      + ` (類似度 ${Math.max(...scores).toFixed(2)}〜${Math.min(...scores).toFixed(2)}、候補 ${result.total.toLocaleString()} 件)`,
    `埋め込み済み: このサーバーの ${Math.round(stats.ratio * 100)}%`
      + (stats.ratio < 0.99 ? '。ここに無い=言っていない、ではない。' : ''),
    dropped > 0 ? `(1位から離れすぎた ${dropped} 件は関連が薄いので除外した)` : '',
    '類似度は相対値。無関係な文でも 0.78 前後になるので、順位で見ること。',
    '--- 時系列順 ---',
    body
  ].filter(Boolean).join('\n');
}
