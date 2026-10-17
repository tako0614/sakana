// 道具の結果に、次の一手の助言を足す。
//
// 本番の実行を読むと、空振りした呼び出しをそのまま繰り返していた (人名だけ変えて mode:count を5回、すべて「該当なし」)。
// モデルは「同じやり方でもう1回」に寄りやすい。同じ呼び出しの繰り返しと、空振りの連続を見つけたら、結果の末尾に
// 次の手を書いて返す。助言は結果の一部なので、次の往復で読まれる (システムプロンプトは増やさない)。

// 空振り・失敗として出す定型の書き出し (tools.ts / memory/tool.ts の文面)
const FAILED = /^(該当するメッセージはありませんでした|クエリが不正です|ツールの実行に失敗|そのツールはありません|action を指定|記憶に「[^」]*」は見つかりませんでした|ページ \S+ はありません|出来事 e\d+ はありません|\(ヒットなし\)|\(発言なし\))/;

export const isEmptyResult = (text: string): boolean => FAILED.test(text.trimStart());

function signature(name: string, args: unknown): string {
  const record = typeof args === 'object' && args !== null && !Array.isArray(args) ? args as Record<string, unknown> : {};
  const keys = Object.keys(record).sort();
  return `${name}:${JSON.stringify(keys.map((key) => [key, record[key]]))}`;
}

/** 1回の実行ぶんの状態を持つ。call のたびに結果を通す。 */
export function createCoach(): (name: string, args: unknown, text: string) => string {
  const seen = new Set<string>();
  let streak = 0;
  return (name, args, text) => {
    const key = signature(name, args);
    const repeated = seen.has(key);
    seen.add(key);
    const empty = isEmptyResult(text);
    streak = empty ? streak + 1 : 0;

    const notes: string[] = [];
    if (repeated) notes.push('同じ呼び出しを前にもしている。同じ結果になるので、語・条件・道具を変える');
    if (empty && streak >= 2) {
      notes.push('空振りが続いている。語を言い換える・author や after の条件を外す・memory / browser に切り替える、のどれかにする');
    }
    return notes.length ? `${text}\n(${notes.join('。')})` : text;
  };
}
