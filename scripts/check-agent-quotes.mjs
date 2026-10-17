// 「」の引用が材料に無いとき、「」を外す仕組みの検証 (npm run check から tsx で呼ぶ)。
import assert from 'node:assert/strict';
import { quoteOverlap, softenUnverifiedQuotes as soften } from '../src/agent/quotes.ts';

const observed = [
  '{"body":{"text":"レビュー無しでマージするのはやめよう、事故のもとだし"}}',
  '2026-07-11 だこ: 急ぎだから自分のPRはレビュー飛ばして通した',
  '{"text":"他を貶すのはやめようよ…人としてね？"}'
].join('\n');

// そのまま載っている引用は触らない (句読点・空白・「…」の違いは無視)
const kept = '「レビュー無しでマージするのはやめよう、事故のもとだし」って言ってた。「他を貶すのはやめようよ。人としてね」とも。';
assert.equal(soften(kept, observed), kept);
// 一部の語が違うくらいは言葉そのままとみなす (0.5 以上重なる)
assert.equal(soften('「急ぎだから自分のPRはレビューを飛ばして通した」らしい', observed), '「急ぎだから自分のPRはレビューを飛ばして通した」らしい');

// 材料に無い引用は「」を外す (中身は残す)
assert.equal(soften('これは「悪くはないが神でもない」ってところ。', observed), 'これは悪くはないが神でもないってところ。');
// 載っている引用と載っていない引用が混ざっていれば、後者だけ外す
assert.equal(soften('「言った気がする」と「レビュー無しでマージするのはやめよう」', observed), '言った気がすると「レビュー無しでマージするのはやめよう」');

// 短いもの (6字未満) と「」の無い文は触らない
assert.equal(soften('「はい」だけ', observed), '「はい」だけ');
assert.equal(soften('「」', observed), '「」');
assert.equal(soften('引用は無い', observed), '引用は無い');
// 改行をまたぐ「」は引用として扱わない
assert.equal(soften('「作り話の\n引用らしきもの」', observed), '「作り話の\n引用らしきもの」');

// 重なりの値
assert.equal(quoteOverlap('レビュー無しでマージするのはやめよう', observed.replace(/[^\p{L}\p{N}]/gu, '')), 1);
assert.ok(quoteOverlap('まったく関係のない作り話の文章です', observed.replace(/[^\p{L}\p{N}]/gu, '')) < 0.2);

// 長い材料でも速い
const big = 'あいうえおかきくけこ'.repeat(60_000);
const started = Date.now();
soften('「作り話の引用らしきもののテスト」', big);
assert.ok(Date.now() - started < 3000, 'a large evidence does not make it slow');

console.log('quote check ok (材料に無い「」は外す / そのままの引用・短い語・「」の無い文は触らない)');
