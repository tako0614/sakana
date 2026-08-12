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
  // mimic/ はデプロイ用に pack.mjs がまとめる場所。bot サーバーには sft/ が無い
  // (実 ID を含むので追跡していない) ので、evex-ft-1 を載せるときはここに置く。
  const files = [process.env.MIMIC_LABELS, 'mimic/labels.json', 'sft/labels.json'];
  for (const file of files.filter(Boolean)) {
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
  // labels.json と同じ扱いにする。bot サーバーには corpus/ が無い (書き出しは
  // 開発機だけ) ので、mimic/ に置いたものを先に見る。無いと全部 #other になり、
  // モデルは学習データの 97% で見ていた話題の手がかりを失う
  const files = [process.env.MIMIC_CHANNELS, 'mimic/channels.json', 'corpus/channels.json'];
  for (const file of files.filter(Boolean)) {
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

// 次の話者の行。`\nB: ` だけでなく `\nたこ: ` も切る。
//
// 話者ラベルを表示名にしたので、英字1文字だけを見ていると名前持ちの発言で切れず、
// 他人の発言まで含んだ長文が Discord に流れる。ラベルは 12 字以内で `:` と改行を
// 含まない (build-sft.mjs の cleanName がそう作る) ので、その形を探す。
//
// 本文に `メモ: あれ` のような行があると誤爆するが、学習データにも同じ曖昧さが
// あるのでモデルの側も同じ形を見ている。切りすぎる方が、他人の発言を捏造して
// 流すより害が小さい。
const NEXT_TURN = /\n([^\n:]{1,12}):[ 　]/;

// **同じ人が続けて喋るぶんは残す。** Discord では普通のことで、学習データでも
// 話者の塊 368,649 個のうち 27.4% が2連続以上 (2連続 17.8% / 3連続 5.6% /
// 4連続 2.0% で 98.0%)。1発言で切っていたので、モデルが学習したその形を
// 毎回捨てて、必ず一言だけ返す不自然な相手になっていた。
//
// 4 で止めるのは 98% がそこに収まるから。**他人が喋り出したら必ず切る** —
// 実在の人の発言を捏造して本人のサーバーに流す方が、短く切るより害が大きい。
const MAX_OWN_TURNS = Number(process.env.MIMIC_MAX_TURNS ?? 4);
const MAX_REPLY_CHARS = Number(process.env.MIMIC_MAX_REPLY_CHARS ?? 400);

/**
 * 生成された続きから、**その人が続けて喋ったぶんだけ**取る。
 *
 * label はプロンプトの末尾に置いた話者ラベル。省略すると 1 発言で切る
 * (誰として書かせたか分からないので、同じ人かどうかを判定できない)。
 */
export function plainOwnTurns(text, label = null) {
  // 学習データにチャンネル行が入っているので、続きに出てきたら会話の切れ目
  let rest = String(text ?? '').split(/\n#(?:ch\d+|other)\b/)[0];
  const turns = [];

  for (let i = 0; i < Math.max(1, MAX_OWN_TURNS); i += 1) {
    const found = rest.match(NEXT_TURN);
    if (!found) {
      turns.push(rest);
      break;
    }

    turns.push(rest.slice(0, found.index));
    // 他人が喋り出した (or 誰として書かせたか不明) ならここで終わり
    if (!label || found[1] !== label) break;
    rest = rest.slice(found.index + found[0].length);
  }

  const cleaned = turns.map((turn) => turn.trim()).filter(Boolean);

  // 長すぎるときは**発言ごと**落とす。途中で切ると文が壊れる
  while (cleaned.length > 1 && cleaned.join('\n').length > MAX_REPLY_CHARS) {
    cleaned.pop();
  }

  return cleaned.join('\n');
}

// 返答として使えない発言。学習側 (finetune.py の UNUSABLE_BODY) が損失から外して
// いるものと**同じ3種**を、推論側でも引き直す。
//
//   [画像] だけ   17,889 件。bot は画像を投稿できないので返答にならない
//   URL だけ      正規化で origin まで削っているので "https://github.com" になる
//   @名前 だけ    相手を呼んだだけで中身が無い
//
// 学習で外しても確率は 0 にならない (preview は外す前の版なので特に出る)。
// 実測: -akku- に振ると 2/2 で "https://github.com" が返り、`/as` を差した意味が
// 消えていた。evex-1 で `<file>` を推論時に禁止したのと同じ対処。
//
// 会話の**文脈**としては有用なので落とすのはここだけ。学習データから消すと
// 「誰かが画像を貼って、他の人が反応する」流れが教えられなくなる。
const UNUSABLE_REPLY = new RegExp(
  '^(?:'
  + '\\[(?:画像|動画|音声|ファイル|添付|圧縮ファイル|埋め込み|スタンプ)\\]'
  + '|https?://\\S+(?:[\\s　]+https?://\\S+)*'
  + '|@[^\\s　]+'
  + ')$'
);

/** 返答として使えないもの (添付だけ / URL だけ / @名前 だけ) か。 */
export function isUnusableReply(text) {
  return UNUSABLE_REPLY.test(String(text ?? '').trim());
}

/** 会話に居る人に役を振る。evex-1 側と同じ assignRoles を通す。 */
export function assignPlainRoles(userIds) {
  return assignRoles(userIds, PLAIN_SCHEME);
}
