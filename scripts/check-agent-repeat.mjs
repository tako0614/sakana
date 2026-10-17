// 同じ答えを重ねて書いたときに最後の版だけを残す仕組みの検証 (npm run check から tsx で呼ぶ)。
import assert from 'node:assert/strict';
import { dropRestartedAnswer as drop, similarity } from '../src/agent/repeat.ts';

// 実際に出た答え (2026-10-17): 日付の書き方だけ変えて、頭からもう一度
const first = [
  'さかなのやらかしは割と在庫があるよ。',
  '一番有名なのは2026-01のやつ。AIに実装を勝手に変えられてて、デバッグ用にbotを起動したらデータベースのレコードを消されたと本人が報告してた。',
  'あとは2025-10、ClaudeでGoogle風UIを完成させて嬉しくなった勢いでコミットメッセージを適当にやってgit履歴を上書き。',
  '最近だと2026-08にSORAHOSTのスタッフの攻撃的発言で揉めてBANで対応した とか、だこに「親の金で経営者気取り」と叩かれた とかもあるけど、こっちは人間関係方面のやつ。'
];
const second = [
  'さかなのやらかしは割と在庫があるよ。',
  '一番有名なのは今年1月のやつ。AIに実装を勝手に変えられてて、デバッグ用にbotを起動したらデータベースのレコードを消されたと本人が報告してた。',
  'あとは去年10月、ClaudeでGoogle風UIを完成させて嬉しくなった勢いでコミットメッセージを適当にやってgit履歴を上書きした。',
  '技術系のやらかしはこの2つが特に語られてる印象。'
];
const doubled = [...first, ...second].join('\n\n');
assert.equal(drop(doubled), second.join('\n\n'), 'the last version is kept');

// 3回重なっていても最後の版だけ
assert.equal(drop([...first, ...first, ...second].join('\n\n')), second.join('\n\n'));

// 重なっていない普通の答えは触らない
const plain = ['結論から言うと、AはBより速い。', '理由は3つある。まずキャッシュが効く。', '次にI/Oが少ない。', 'まとめると、速いのは構造のせい。'].join('\n\n');
assert.equal(drop(plain), plain);
assert.equal(drop('短い返事'), '短い返事');
assert.equal(drop(''), '');

// 結びの1文が冒頭に似ているだけ (続きが無い・続きが似ていない) なら触らない
const echo = ['AはBより速いと思う。', '理由はキャッシュが効くから。', '次にI/Oも少ない。', 'AはBより速いと思う。'].join('\n\n');
assert.equal(drop(echo), echo, 'a closing echo is not a rewrite');
const echoThenOther = ['AはBより速いと思う。', '理由はキャッシュが効くから。', 'AはBより速いと思う。', 'ところで昼ごはんは何にする？'].join('\n\n');
assert.equal(drop(echoThenOther), echoThenOther, 'the follow-up must look like the first version too');

// 短い冒頭 (相槌) は繰り返しても書き直しとは見ない
const short = ['はい。', '説明1です。たくさん書く。', 'はい。', '説明1です。たくさん書く。'].join('\n\n');
assert.equal(drop(short), short);

assert.ok(similarity('さかなのやらかし', 'さかなのやらかし') === 1);
assert.ok(similarity('今日は晴れ', 'コードを書く') < 0.2);

console.log('restarted answer ok (頭から書き直した版は最後だけ残す / 普通の答えと結びの重なりは触らない)');
