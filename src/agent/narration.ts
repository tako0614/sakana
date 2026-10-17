// 「だこに話しかけられたので、…」のような前置きを答えの頭から外す。
//
// 呼ばれたから答えている、は読む人が知っていること。プロンプトの「話しかけてきた人」を
// そのまま口にして、答えの冒頭で自分が呼ばれた経緯を説明していた (2026-10-17)。
// 主な対策はプロンプトの言い方 (依頼者と書き、経緯は書かせない) で、これは取りこぼしの保険。
//
// 外すのは「依頼者の名前 + に/が + 呼ばれた系の動詞」で始まる節だけ。名前を条件にしているので、
// 「たこは運営に呼ばれたので参加した」のように第三者の事実で始まる答えは触らない。

const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// 呼ばれた側から書く形 (〜に話しかけられた) と、呼んだ側から書く形 (〜が話しかけてきた)
const PASSIVE = '(?:話しかけられ|声をかけられ|声かけられ|呼びかけられ|呼ばれ|聞かれ|問いかけられ|質問され|振られ|頼まれ|指名され|メンションされ)';
const ACTIVE = '(?:話しかけてき|声をかけてき|呼びかけてき|呼んでき|聞いてき|質問してき|振ってき|頼んできて?|メンションしてき)';
const HONORIFIC = '(?:さん|くん|君|ちゃん|氏)?';
const TAIL = '[^、。，,\\n]{0,12}';

export function stripAddressNarration(text: string, requesterName: string | null | undefined): string {
  const name = (requesterName ?? '').trim();
  if (!name || name.length > 40) return text;
  const who = `@?${escape(name)}${HONORIFIC}`;
  const lead = `^\\s*${who}(?:(?:に|から)${PASSIVE}|が${ACTIVE})${TAIL}`;

  // 「だこに話しかけられたので、わりと…」→「わりと…」
  const clause = new RegExp(`${lead}[、，,]\\s*`);
  // 「だこに話しかけられた。」だけの1文は文ごと外す
  const sentence = new RegExp(`${lead}[。\\n]+\\s*`);

  for (const pattern of [clause, sentence]) {
    const match = pattern.exec(text);
    if (!match) continue;
    const rest = text.slice(match[0].length);
    // 全部が前置きだった (中身が無い) ときは触らない
    return rest.trim() ? rest : text;
  }
  return text;
}
