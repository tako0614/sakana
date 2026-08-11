// 回答の見た目にかかわる2点を固定する。
//
//   1. 引用が本文に生 URL を混ぜないこと (88文字の URL が1文ごとに挟まると読めない)
//   2. system プロンプトが1文字も可変でないこと (可変にすると 5.5KB が毎回キャッシュ外)
//
// どちらも壊れても例外は出ず、静かに読みにくさと費用になるだけなので門を置く。

import { RefTable, expandCitations } from '../src/agent/format.js';
import { buildSystemPrompt } from '../src/agent/prompt.js';

function fail(message) {
  throw new Error(message);
}

// --- 引用 ---

function tableOf(count) {
  const refs = new RefTable();
  for (let i = 1; i <= count; i += 1) {
    refs.add({ messageId: `10000000000000000${i}`, channelId: 'c1', guildId: 'g1' });
  }
  return refs;
}

{
  const refs = tableOf(3);
  const out = expandCitations('4月に書いてる [1]。7月には通してる [2]。', refs);
  const [body, ...rest] = out.split('\n\n');

  if (body.includes('discord.com')) fail(`本文に生 URL が出ている: ${body}`);
  if (!body.includes('[1]') || !body.includes('[2]')) fail(`本文の番号が消えている: ${body}`);

  const footer = rest.join('\n\n');
  if (!footer.startsWith('-# ')) fail(`末尾が subtext になっていない: ${footer}`);
  if (!/-# \[1\] <https:\/\/discord\.com\/channels\/g1\/c1\/\d+> \[2\] </.test(footer)) {
    fail(`末尾の形が違う: ${footer}`);
  }
  // <> で囲まないと役に立たないプレビューが並ぶ
  if (/[^<]https:\/\//.test(footer)) fail(`URL が <> で囲まれていない: ${footer}`);
  // 引用していない [3] は載せない (refs にはモデルに見せた全件が入っている)
  if (footer.includes('[3]')) fail(`引用していない番号が出ている: ${footer}`);
}

{
  // 初出順。本文の登場順で並ぶこと (refs の登録順ではない)
  const footer = expandCitations('まず [3]、次に [1]。', tableOf(3)).split('-# ')[1];
  if (!footer.startsWith('[3] ')) fail(`初出順になっていない: ${footer}`);
  if (footer.indexOf('[3]') > footer.indexOf('[1]')) fail(`初出順になっていない: ${footer}`);
}

{
  // 同じ番号を2回書いても末尾は1つ
  const footer = expandCitations('[1] と書いて、また [1]。', tableOf(1)).split('-# ')[1];
  if ((footer.match(/\[1\]/g) ?? []).length !== 1) fail(`重複している: ${footer}`);
}

{
  // 引けない番号は本文に残し、末尾には出さない (リンク切れを作らない)
  const out = expandCitations('よく分からん [99]。', tableOf(2));
  if (!out.includes('[99]')) fail('引けない番号を本文から消してはいけない');
  if (out.includes('-#')) fail(`引けない番号だけなら末尾を足さない: ${out}`);
}

{
  // 引用0件のときに空行だけ増やさない
  const plain = 'ログに出てないから分からん。';
  if (expandCitations(plain, tableOf(2)) !== plain) fail('引用0件で本文を変えてはいけない');
  if (expandCitations('', tableOf(1)) !== '') fail('空文字はそのまま');
}

console.log('citations ok (本文に生 URL なし / 末尾は subtext)');

// --- system プロンプト ---

const ctx = { browserFull: true };
const toolset = { archiveAvailable: true, semanticAvailable: true, browserAvailable: true };

const first = buildSystemPrompt(ctx, toolset);
const second = buildSystemPrompt(ctx, toolset);

if (first !== second) fail('system プロンプトが呼ぶたびに変わっている (キャッシュの前方一致が壊れる)');

// 時刻や年を混ぜると、その後ろ全部が毎リクエスト新規扱いになる。
// 可変な文脈は buildUserContent 側に置く。
if (/\d{1,2}:\d{2}/.test(first)) fail('system プロンプトに時刻が入っている');
if (first.includes(String(new Date().getFullYear()))) fail('system プロンプトに現在の年が入っている');

// 使えない道具の説明を載せない (載せるとキャッシュ以前に無駄なトークン)
const bare = buildSystemPrompt({ browserFull: false }, {
  archiveAvailable: false, semanticAvailable: false, browserAvailable: false
});
if (/mode:meaning|mode:count|browser/.test(bare)) fail('使えない道具の説明が載っている');

console.log(`prompt ok (byte-static / ${first.length} 文字)`);
