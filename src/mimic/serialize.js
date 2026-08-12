// 学習データと推論のプロンプトを同じ形にするための直列化。
//
// ここを2箇所に持つと必ずずれる。ずれた瞬間にモデルは「学習中に一度も見ていない形」を
// 受け取ることになり、しかも例外は出ないので静かに崩れた出力になるだけ。
// build-corpus.mjs (学習データ) と respond.js (推論) の両方がこれを使う。

// 消すもの: そのまま入れると語彙を食うだけで、文体に寄与しないもの。
// 残すもの: 絵文字・草・www・顔文字・伸ばし棒。文体そのもの。
const RULES = [
  // URL は真っ先に。中に記号が多くて後続の規則を巻き込む
  [/https?:\/\/\S+/g, '<url>'],
  [/<a?:([a-zA-Z0-9_]{2,32}):\d{15,25}>/g, ':$1:'], // カスタム絵文字は名前を残す (:kusa: は文化)
  [/<@[!&]?\d{15,25}>/g, '<mention>'],
  [/<#\d{15,25}>/g, '<channel>'],
  [/<t:\d+(?::[tTdDfFR])?>/g, '<time>'],
  [/@everyone|@here/g, '<mention>']
];

// 話者は「会話の中で何番目に喋ったか」で振る。実在の人物には紐づけない。
//
// evex-1 は上位48人に固有トークンを与えていたので、speakers.json / 順位 /
// Discord ID の対応表 / 「その人として書く」機能が全部くっついてきた。
// 相対にすれば身元は消え、会話の交代だけが残る。
// 実測: 1会話あたりの異なる話者は 8 人までで 99.1%、37% は 1 人だけ
// (連投・独り言)。だから「同じ人が続けている」と「別の人が返した」の
// 区別は残す価値がある。
export const ROLE_TOKENS = ['<|a|>', '<|b|>', '<|c|>', '<|d|>', '<|e|>', '<|f|>', '<|g|>', '<|h|>'];
export const ROLE_OVERFLOW = '<|z|>';

export const CONTROL_TOKENS = [
  '<|conv|>', '<|end|>', '<|re|>', ROLE_OVERFLOW,
  '<url>', '<mention>', '<channel>', '<time>',
  '<code>', '</code>', '<nl>', '<file>',
  ...ROLE_TOKENS
];

/**
 * 会話の参加者に出現順でトークンを割る。
 *
 * 同じ `<|a|>` が別の会話では別人になる。これが身元を消す仕組みそのもの。
 * 9人目以降は `<|z|>` にまとめる (実測で 0.9%)。
 */
export function assignRoles(keys) {
  const roles = new Map();
  for (const key of keys) {
    if (roles.has(key)) continue;
    roles.set(key, ROLE_TOKENS[roles.size] ?? ROLE_OVERFLOW);
  }
  return roles;
}

/** 会話に居る参加者の次に来る役 (bot が新しい参加者として喋るとき)。 */
export function nextRole(roles) {
  return ROLE_TOKENS[roles.size] ?? ROLE_OVERFLOW;
}

export function normalize(text) {
  let out = String(text ?? '');

  // コードブロックは中身を残して囲みだけ差し替える。``` のままだと
  // 言語名や改行と混ざって語彙が散る
  out = out.replace(/```[a-zA-Z0-9+#-]*\n?([\s\S]*?)```/g, (_, body) => `<code>${body}</code>`);

  for (const [pattern, replacement] of RULES) out = out.replace(pattern, replacement);

  // 会話 1 件を 1 行に収める。改行は消さずにトークンにする
  // (sentencepiece は行単位で読むし、学習側のデータローダも行で切りたい)
  //
  // U+2028 / U+2029 も潰す。JSON.stringify はこの2つを素通しするのに
  // Node の readline は行終端として扱うので、残すと下流で行が割れる
  // (実データに 5 件あって、書き出しの JSON が途中で切れた)。
  return out.replace(/\r\n|[\n\r\u2028\u2029]/g, '<nl>').trim();
}

/** 本文が空なのは添付かスタンプ。turn 自体は残す (会話の間が消えると流れが壊れる)。 */
export function messageText(content) {
  return normalize(content) || '<file>';
}

/**
 * 会話を学習時と同じ形に並べる。
 *
 *   <|conv|><|s3|>今日ひま？<|s7|><|re|>ひま
 *
 * turns: [{ token, reply, content }] で、**content は messageText を通した後のもの**。
 * ここで正規化しないのは、二度掛けると壊れるから。normalize は URL を潰してから
 * 改行を <nl> にする順序で動くので、一度通した文をもう一度通すと
 * `https://<nl>Current` の `<nl>Current` まで URL として飲まれる (実データで1件出た)。
 *
 * trailing に話者トークンを置くと、その人の発言として続きを書かせられる。
 */
export function buildPrompt(turns, trailingToken = null) {
  const parts = ['<|conv|>'];

  for (const turn of turns) {
    parts.push(turn.token);
    if (turn.reply) parts.push('<|re|>');
    parts.push(turn.content);
  }

  if (trailingToken) parts.push(trailingToken);
  return parts.join('');
}

/**
 * 生成された続きから最初の1発言だけ取る。
 *
 * モデルは放っておくと `<|s3|>…<|s7|>…` と会話を続けてしまうので、
 * 次の話者トークンか <|end|> で切る。ここを切らないと、他の人の発言を
 * 勝手に作った長文が Discord に流れる。
 */
export function firstTurn(text) {
  const raw = String(text ?? '');
  const cut = raw.search(/<\|[a-hz]\|>|<\|end\|>|<\|conv\|>/);
  return plain(cut >= 0 ? raw.slice(0, cut) : raw);
}

/** 制御記号を読める形に落とす。表示に生のまま漏らさないための一箇所。 */
function plain(text) {
  return String(text ?? '')
    .replace(/<\|re\|>/g, '')
    .replace(/<nl>/g, '\n')
    .replace(/<code>/g, '```\n')
    .replace(/<\/code>/g, '\n```')
    .replace(/<file>/g, '(画像)')
    .replace(/<url>/g, '(リンク)')
    .replace(/<mention>/g, '(だれか)')
    .replace(/<channel>/g, '(チャンネル)')
    .replace(/<time>/g, '(時刻)')
    .trim();
}

/**
 * 生成結果を人が読める形に戻す。会話ごと見たいとき用。
 * Discord に返すのは firstTurn の方。
 * 役トークンは nameOf(役) で置き換え、<nl> は改行に、制御記号は落とす。
 */
export function humanize(text, nameOf) {
  let out = String(text ?? '');

  // <|end|> より後ろは次の会話なので捨てる
  const end = out.indexOf('<|end|>');
  if (end >= 0) out = out.slice(0, end);

  out = out.replace(/<\|conv\|>/g, '');
  out = out.replace(/<\|([a-hz])\|>/g, (_, role) => `\n${nameOf(role)}: `);

  return plain(out);
}
