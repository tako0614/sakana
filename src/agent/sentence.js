// 「これは検索語ではなく文か」の判定。
//
// キーワード検索が0件だったときに意味検索へ自動で回すかを決めるのに使う。
// 単語で0件なら本当に無いだけだが、文で0件なら言い換えを跨げていないだけの
// ことが多いので、そこだけ拾いたい。
//
// 形態素解析器は入れない (辞書が重い・依存が増える)。terms.js が
// 「漢字2文字以上はほぼ名詞」で名詞を拾っているのと逆の性質を使う:
// 日本語は内容語が漢字/カタカナ/ラテン、文法がひらがななので、
// ひらがなの密度がそのまま「述語があるか」の手がかりになる。

const HIRAGANA = /[\p{Script=Hiragana}]/gu;
const SENTENCE_MARK = /[。、？?！!]/;

// 語の中に出にくい2文字以上の機能語だけ並べる。
// 1文字の助詞を入れると「のり」「でんき」のような語が文と判定される。
const FUNCTION_WORD = /という|と思|だと|のは|のが|ので|けど|だろ|でしょ|ない|ます|です|べき|ほうが|してる|かった|される/;

// 内容語 + 助詞 + 何か = 述語がある。「消費税増税は必要」のように
// ひらがなが1文字しかない文を拾うのに要る。
// `の` は入れない — 「サーバー移行の話」のように名詞を繋ぐ用法が多く、
// 入れると単語列まで文と判定される。
const PARTICLE_BRIDGE = /[\p{Script=Han}\p{Script=Katakana}ーA-Za-z0-9][はがをにへとも][\p{Script=Han}\p{Script=Katakana}ーA-Za-z0-9\p{Script=Hiragana}]/u;

/**
 * 文らしいか。
 *
 * 判定は意図的に甘い。誤検知の代償は「キーワードで既に0件だったときに
 * ローカルのベクトル走査が1回増える」だけで、見逃しの代償は機能そのもの。
 */
export function looksLikeSentence(text) {
  const flat = String(text ?? '').normalize('NFKC').trim();
  const chars = Array.from(flat);

  if (chars.length < 6) return false;
  if (/^https?:\/\//i.test(flat)) return false;

  // 英文は語数で見る (ひらがなが無いので日本語の指標が全部効かない)
  if (/^[\x20-\x7E]+$/.test(flat)) return flat.split(/\s+/).filter(Boolean).length >= 4;

  if (SENTENCE_MARK.test(flat)) return true;
  if (FUNCTION_WORD.test(flat)) return true;
  if (PARTICLE_BRIDGE.test(flat)) return true;

  const hiragana = (flat.match(HIRAGANA) ?? []).length;
  return hiragana >= 3 && hiragana / chars.length >= 0.12;
}
