// evex-ft-1 (Qwen3-0.6B-Base を追加学習したもの) 用の直列化。
//
// evex-1 と形が全く違う。あちらは独自の制御記号 (<|conv|> <|s3|> <nl>) だが、
// こちらは**素の日本語**で学習してある:
//
//   #ch2
//   A: これバグってる？
//   B: これでいい
//   A:
//
// 独自トークンを足さなかったのは、足すとその埋め込みだけ未学習から始まるから。
// `A:` や素の改行は事前学習で大量に見ている形なので、そのまま使える。
//
// **学習側の実装は scripts/llm/build-sft.mjs で、ここはその推論版。**
// 形がずれるとモデルは一度も見ていない入力を受け取る (しかも例外は出ず静かに崩れる)。
// evex-1 に <|a|> を渡して出力を崩壊させたのと同じ事故になるので、
// 正規化の規則はあちらと1対1で対応させてある。

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { assignRoles } from './serialize.js';

/**
 * 素の英字の役。**名前ラベルを持たない人だけ**がこれを使う。
 *
 * 最初は全員これにしていたが、それだと個人になりきれない — 実測で役 A の中身は
 * 1,062 人ぶんで、最多の人でも 10.4% (その人の全体シェア 9.4% とほぼ同じ)。
 * つまり A は「このサーバーの平均的な人」であって誰でもない。
 */
export const PLAIN_SCHEME = { roles: ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'], overflow: 'Z' };

// 200 件以上ある 147 人は表示名がそのままラベルになっている (発言の 96.6%)。
// **学習側 (scripts/llm/build-sft.mjs) が書き出した表をそのまま読む。**
// ここで名前から作り直すと、切り詰めや重複の連番がずれて、モデルが一度も見ていない
// ラベルを渡すことになる (`vivacious_flamingo_38533` は 12 字で切られ、
// 同名の 4 組には連番が付いている)。
function loadLabels() {
  for (const file of [process.env.MIMIC_LABELS, 'sft/labels.json'].filter(Boolean)) {
    try {
      const rows = JSON.parse(readFileSync(path.resolve(file), 'utf8'));
      if (Array.isArray(rows) && rows.length) return rows;
    } catch {
      // 無ければ役だけで動く (なりきりはできない)
    }
  }
  return [];
}

const labelRows = loadLabels();
const labelByUser = new Map(labelRows.map((row) => [String(row.userId), row.label]));

/** その人の学習済みラベル。147人の外は null。 */
export function labelFor(userId) {
  return labelByUser.get(String(userId)) ?? null;
}

/** ラベルを持つ人の一覧。/mimic の候補に出す。 */
export function labelledSpeakers() {
  return labelRows.map((row) => ({ ...row, userId: String(row.userId) }));
}

// 上位16チャンネルまで名前を持つ (280 チャンネルのうち上位16で 97%)。
// build-sft.mjs と同じ順位付けでないと番号がずれるので、同じ入力から同じ手順で作る。
const NAMED_CHANNELS = 16;

function loadChannelRanks() {
  for (const file of [process.env.MIMIC_CHANNELS, 'corpus/channels.json'].filter(Boolean)) {
    try {
      const rows = JSON.parse(readFileSync(path.resolve(file), 'utf8'));
      if (!Array.isArray(rows) || !rows.length) continue;
      const ranked = [...rows].sort((a, b) => b.count - a.count);
      return new Map(ranked.slice(0, NAMED_CHANNELS).map((c, rank) => [String(c.id), `#ch${rank}`]));
    } catch {
      // 無くても #other で動く。話題の手がかりが1つ減るだけ
    }
  }
  return new Map();
}

const channelRanks = loadChannelRanks();

/** そのチャンネルの学習時のラベル。上位16の外は #other。 */
export function channelLabel(channelId) {
  return channelRanks.get(String(channelId)) ?? '#other';
}

function shorten(url) {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}

/**
 * Discord の記法を学習時と同じ素の日本語に落とす。
 *
 * メンションは会話の中に居る人だけ役に直す。外の人は落とす — 20桁の ID を残しても
 * 学ぶものが無く、名前に直すと身元が戻る。build-sft.mjs と同じ規則。
 */
export function plainText(content, roleOf = () => null) {
  let out = String(content ?? '');

  out = out.replace(/<@!?(\d+)>/g, (match, id) => {
    const role = roleOf(id);
    return role ? `@${role}` : '';
  });
  out = out.replace(/<@&\d+>/g, '');
  out = out.replace(/<#(\d+)>/g, (match, id) => channelLabel(id));
  out = out.replace(/<a?:([\w~]+):\d+>/g, ':$1:');
  out = out.replace(/https?:\/\/\S+/g, shorten);

  return out
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * 会話を学習時と同じ形に並べる。
 *
 *   #ch2\nA: これバグってる？\nB: これでいい\nA:
 *
 * turns は [{ role, content }] で、content は plainText を通した後のもの。
 * trailingRole を置くと、その役の発言として続きを書かせられる。
 */
export function buildPlainPrompt(turns, { channelId = null, trailingRole = null } = {}) {
  const lines = [channelLabel(channelId)];

  for (const turn of turns) {
    if (!turn.content) continue;
    lines.push(`${turn.role}: ${turn.content}`);
  }

  // 末尾は改行を挟んで役だけ置く。学習データの各行が `X: 本文` なので、
  // `A:` の直後から本文が始まる形になる
  return `${lines.join('\n')}\n${trailingRole ? `${trailingRole}:` : ''}`;
}

// 次の話者の行。`\nB: ` の形。これで切らないと他人の発言まで作った長文になる。
const NEXT_TURN = /\n[A-HZ]:\s/;

/** 生成された続きから最初の1発言だけ取る。 */
export function plainFirstTurn(text) {
  const raw = String(text ?? '');
  const cut = raw.search(NEXT_TURN);
  const body = cut >= 0 ? raw.slice(0, cut) : raw;

  // 学習データにチャンネル行が入っているので、続きに出てきたら会話の切れ目
  return body.split(/\n#(?:ch\d+|other)\b/)[0].trim();
}

/** 会話に居る人に役を振る。evex-1 側と同じ assignRoles を通す。 */
export function assignPlainRoles(userIds) {
  return assignRoles(userIds, PLAIN_SCHEME);
}
