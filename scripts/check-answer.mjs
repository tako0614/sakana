// 回答の見た目にかかわる2点を固定する。
//
//   1. 引用が本文に生 URL を混ぜないこと (88文字の URL が1文ごとに挟まると読めない)
//   2. system プロンプトが1文字も可変でないこと (可変にすると 5.5KB が毎回キャッシュ外)
//
// どちらも壊れても例外は出ず、静かに読みにくさと費用になるだけなので門を置く。

import { RefTable, expandCitations } from '../src/agent/format.js';
import { buildSystemPrompt, buildUserContent } from '../src/agent/prompt.js';

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
  // 番号は読む人には要らない。本文から消す
  if (/\[\d+\]/.test(body)) fail(`本文に番号が残っている: ${body}`);
  // 番号を抜いた跡に空白を残さない
  if (body !== '4月に書いてる。7月には通してる。') fail(`本文の詰め方が違う: ${JSON.stringify(body)}`);

  const footer = rest.join('\n\n');
  if (!footer.startsWith('-# ')) fail(`末尾が subtext になっていない: ${footer}`);
  // URL は加工しない (<> で囲まない・番号を付けない)
  if (footer.includes('<') || footer.includes('[')) fail(`URL を加工している: ${footer}`);
  if (!/^-# https:\/\/discord\.com\/channels\/g1\/c1\/\d+ https:\/\/\S+$/.test(footer)) {
    fail(`末尾の形が違う: ${footer}`);
  }
  // 引用していない3件目は載せない (refs にはモデルに見せた全件が入っている)
  if (footer.split(' ').length !== 3) fail(`引用していない URL が出ている: ${footer}`);
}

{
  // 初出順。本文の登場順で並ぶこと (refs の登録順ではない)
  const footer = expandCitations('まず [3]、次に [1]。', tableOf(3)).split('-# ')[1];
  const [first, second] = footer.split(' ');
  if (!first.endsWith('3') || !second.endsWith('1')) fail(`初出順になっていない: ${footer}`);
}

{
  // 同じ番号を2回書いても末尾は1つ
  const footer = expandCitations('[1] と書いて、また [1]。', tableOf(1)).split('-# ')[1];
  if (footer.split(' ').length !== 1) fail(`重複している: ${footer}`);
}

{
  // 引けない番号は本文から消すだけ。末尾には出さない (リンク切れを作らない)
  const out = expandCitations('よく分からん [99]。', tableOf(2));
  if (out.includes('[99]')) fail(`引けない番号も本文から消す: ${out}`);
  if (out.includes('-#')) fail(`引けない番号だけなら末尾を足さない: ${out}`);
  if (out !== 'よく分からん。') fail(`本文の詰め方が違う: ${JSON.stringify(out)}`);
}

{
  // 引用0件のときに空行だけ増やさない
  const plain = 'ログに出てないから分からん。';
  if (expandCitations(plain, tableOf(2)) !== plain) fail('引用0件で本文を変えてはいけない');
  if (expandCitations('', tableOf(1)) !== '') fail('空文字はそのまま');
}

console.log('citations ok (本文に番号も URL も残らない / 末尾は素の URL)');

// --- system プロンプト ---

const ctx = { browserFull: true };
const toolset = { archiveAvailable: true, semanticAvailable: true, browserAvailable: true };

const first = buildSystemPrompt(ctx, toolset);

if (buildSystemPrompt(ctx, toolset) !== first) {
  fail('system プロンプトが呼ぶたびに変わっている (キャッシュの前方一致が壊れる)');
}

// 2回続けて呼ぶだけでは分解能の粗い時刻を捕まえられない (同じ分のうちに終わるので)。
// 時計を1年以上進めて、分・日・月・年のどれを混ぜても落ちるようにする。
// 文面の中の例 (「時刻 (20:21 など) は書かない」) を正規表現で拾うと誤検知するので、
// 実際に時計へ依存しているかどうかで見る。
const realNow = Date.now;
try {
  Date.now = () => realNow() + 400 * 86_400_000;
  if (buildSystemPrompt(ctx, toolset) !== first) {
    fail('system プロンプトが時計に依存している (可変な文脈は buildUserContent 側に置く)');
  }
} finally {
  Date.now = realNow;
}

// 使えない道具の説明を載せない (載せるとキャッシュ以前に無駄なトークン)
const bare = buildSystemPrompt({ browserFull: false }, {
  archiveAvailable: false, semanticAvailable: false, browserAvailable: false
});
if (/mode:meaning|mode:count|browser/.test(bare)) fail('使えない道具の説明が載っている');

console.log(`prompt ok (byte-static / ${first.length} 文字)`);

// --- 話しかけてきた人 ---
//
// 見出し行の末尾に埋めていたら、直前の会話の話題の人と混同されて
// 第三者の話を二人称で書かれた。独立した行であることを固定する。

const said = (id, name, content, extra = {}) => ({
  guildId: 'g1', channelId: 'c1', messageId: id, authorId: id, authorName: name,
  content, createdAt: 1_700_000_000_000, reactionCount: 0, attachmentCount: 0, ...extra
});

const userContentOf = (over = {}) => buildUserContent({
  ctx: {
    guild: { name: 'G' },
    channel: { name: 'general', id: 'c1' },
    member: { displayName: 'さば', id: '999888777666555444' }
  },
  prompt: '今日の失言おしえて',
  recent: [],
  replyChain: [],
  refs: new RefTable(),
  ...over
});

{
  const content = userContentOf();
  const caller = content.split('\n').find((line) => line.includes('話しかけてきた'));
  if (!caller) fail('話しかけてきた人の行が無い');
  if (caller.includes('サーバー:') || caller.includes('チャンネル:')) {
    fail(`話しかけてきた人が見出し行に埋まっている: ${caller}`);
  }
  if (!caller.includes('さば') || !caller.includes('999888777666555444')) {
    fail(`表示名と ID の両方が要る (ID が無いと author に渡せない): ${caller}`);
  }
  if (!content.includes('今日の失言おしえて')) fail('依頼が入っていない');
}

{
  // 話題が並行するチャンネルでは、返信の鎖と背景が別の見出しで分かれていること。
  // 混ぜると「どの話の続きか」をモデルが推測することになって答えが混ざる。
  const content = userContentOf({
    replyChain: [said('11', 'たこ', 'デプロイどうする'), said('12', 'bot', 'まず CI 直そう')],
    recent: [said('21', 'さば', '昼なに食う'), said('22', 'あきら', 'ラーメン')]
  });

  const thread = content.indexOf('いま返信でつながっている話');
  const background = content.indexOf('直近の会話');
  if (thread < 0) fail('返信の鎖の見出しが無い');
  if (background < 0) fail('背景の見出しが無い');
  if (thread > background) fail('今の話題は背景より先に置く');
  if (!/背景/.test(content.slice(background, background + 60))) {
    fail('背景であることを見出しに書く');
  }

  // 鎖は古い順
  if (content.indexOf('デプロイどうする') > content.indexOf('まず CI 直そう')) {
    fail('返信の鎖は古い順に並べる');
  }
  // 鎖が無いときは見出しごと出さない
  if (userContentOf({ recent: [said('21', 'さば', '昼なに食う')] }).includes('いま返信でつながっている話')) {
    fail('鎖が空なら見出しを出さない');
  }
}

console.log('caller ok (独立した行 / 表示名と ID / 話題と背景を分離)');
