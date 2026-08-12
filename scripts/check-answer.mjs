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
  // 引けない番号は触らない。無条件に消していたら `[2024] の話ね` が `の話ね` になった
  const out = expandCitations('よく分からん [99]。', tableOf(2));
  if (!out.includes('[99]')) fail(`引けない番号は残す: ${out}`);
  if (out.includes('-#')) fail(`引けない番号だけなら末尾を足さない: ${out}`);

  const year = expandCitations('[2024] の話ね', tableOf(2));
  if (year !== '[2024] の話ね') fail(`数字の括弧を引用と誤らない: ${JSON.stringify(year)}`);
}

{
  // 添字は引用ではない。引用は語の区切りに来るので空白の有無で見分ける
  const refs = tableOf(3);
  const idx = expandCitations('配列は items[1] が先頭だよ', refs);
  if (idx !== '配列は items[1] が先頭だよ') fail(`添字を壊してはいけない: ${JSON.stringify(idx)}`);
  if (idx.includes('-#')) fail('添字を引用として拾ってはいけない');

  // 空白で区切られていれば引用として扱う
  const cited = expandCitations('根拠はこれ [1]。', refs);
  if (cited.split('\n')[0] !== '根拠はこれ。') fail(`空白区切りは引用: ${JSON.stringify(cited)}`);
  // 行頭・括弧のあとも引用
  for (const t of ['[1] と言ってる', '「[1]」と書いてる']) {
    if (!expandCitations(t, refs).includes('-#')) fail(`引用として拾えていない: ${t}`);
  }
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

const SELF_ID = '111000111000111000';

const userContentOf = (over = {}) => buildUserContent({
  ctx: {
    guild: { name: 'G' },
    channel: { name: 'general', id: 'c1' },
    member: { displayName: 'さば', id: '999888777666555444' },
    client: { user: { id: SELF_ID } }
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

  const background = content.indexOf('同時に流れている別の話');
  const thread = content.indexOf('いま答えるべき話');
  const ask = content.indexOf('## 依頼');
  if (background < 0) fail('背景の見出しが無い');
  if (thread < 0) fail('返信の鎖の見出しが無い');

  // 順序が本体。鎖と依頼の間に背景を挟むと、量と位置の両方で背景が勝つ。
  if (!(background < thread && thread < ask)) {
    fail(`並びは 背景 → 鎖 → 依頼 (${background} / ${thread} / ${ask})`);
  }
  if (!/答えの材料にしない/.test(content.slice(background, background + 80))) {
    fail('背景は材料にしないと見出しに書く');
  }
  if (!/続きとして答える/.test(content.slice(ask, ask + 60))) {
    fail('依頼の見出しで鎖の続きだと指す');
  }

  // 鎖は古い順で、最後の1件が「いま返信された相手」だと分かること
  const chainBlock = content.slice(thread);
  if (chainBlock.indexOf('デプロイどうする') > chainBlock.indexOf('まず CI 直そう')) {
    fail('返信の鎖は古い順に並べる');
  }
  const marked = chainBlock.split('\n').filter((l) => l.includes('返信して聞いている'));
  if (marked.length !== 1) fail(`返信先の印は最後の1件だけ: ${marked.length} 件`);
  if (!marked[0].includes('まず CI 直そう')) fail(`印が最後の1件に付いていない: ${marked[0]}`);

  // 鎖があるなら背景は削る (混ざる材料を増やさない)
  const many = Array.from({ length: 30 }, (_, i) => said(`3${i}`, 'だれか', `雑談${i}`));
  const trimmed = userContentOf({
    replyChain: [said('11', 'たこ', 'デプロイどうする')],
    recent: many
  });
  if (trimmed.includes('雑談0')) fail('鎖があるときは背景を削る');
  if (!trimmed.includes('雑談29')) fail('背景は新しい側を残す');
  // 鎖が無いときは全部渡す
  if (!userContentOf({ recent: many }).includes('雑談0')) fail('鎖が無いなら背景は削らない');

  // 鎖が無いときは見出しごと出さない
  if (userContentOf({ recent: [said('21', 'さば', '昼なに食う')] }).includes('いま答えるべき話')) {
    fail('鎖が空なら見出しを出さない');
  }
}

{
  // 自分の発言を第三者の発言として読ませない。`bot` の印だけでは
  // 「何かの bot」でしかなく、自分の回答を根拠に引用していた。
  const content = userContentOf({
    recent: [
      said('21', 'さば', 'たこの失言おしえて'),
      said(SELF_ID, 'sakana', '6月と今日で言ってることが違う', { isBot: true }),
      said('23', 'のあ', 'まじか', { isBot: false })
    ]
  });

  const mine = content.split('\n').find((line) => line.includes('6月と今日で'));
  if (!mine?.includes('←あなた自身の発言')) fail(`自分の発言に印が付いていない: ${mine}`);

  // 他人の行には付けない
  if (content.split('\n').find((l) => l.includes('たこの失言')).includes('あなた自身')) {
    fail('他人の発言に「あなた自身」が付いている');
  }

  // 表示名ではなく ID で判定する (ニックネームはサーバーごとに変わる)
  const impostor = userContentOf({
    recent: [said('24', 'sakana', 'なりすまし', { isBot: true })]
  });
  if (impostor.includes('あなた自身')) fail('表示名の一致で自分だと判定してはいけない');
  if (!impostor.includes('bot')) fail('他の bot には bot の印が要る');
}

console.log('caller ok (独立した行 / 表示名と ID / 話題と背景 / 自分の発言に印)');

// --- 返信の鎖 ---
//
// 「どの話の続きか」がここで決まるので、壊れても静かに読みにくくなるだけ。
// discord.js の Message を作れないので、読んでいるところだけ持つ偽物で回す。

const { fetchReplyChain } = await import('../src/agent/index.js');

function fakeMessage({ id, content, replyTo = null, name = 'たこ', snapshots = null }) {
  return {
    id,
    guildId: 'g1',
    channelId: 'c1',
    content,
    author: { id: `u-${id}`, username: name, bot: false },
    member: { displayName: name },
    createdTimestamp: 1_700_000_000_000,
    reference: replyTo ? { messageId: replyTo, channelId: 'c1', guildId: 'g1' } : null,
    messageSnapshots: snapshots,
    attachments: { size: 0 },
    reactions: { cache: new Map() }
  };
}

function fakeChannel(messages) {
  const cache = new Map(messages.map((m) => [m.id, m]));
  return {
    name: 'general',
    messages: {
      cache,
      // キャッシュに無いものは「取りに行っても無い」= 削除済みとして扱う
      fetch: async (id) => cache.get(id) ?? Promise.reject(new Error(`no ${id}`))
    }
  };
}

{
  // メンションと併用したリプライでも、リプ先が鎖に入ること
  const a = fakeMessage({ id: '1', content: '税は控除の話' });
  const b = fakeMessage({ id: '2', content: 'それ経費だろ', replyTo: '1', name: 'のあ' });
  const ask = fakeMessage({ id: '3', content: '@bot このメッセージも経費だよな', replyTo: '2', name: 'さば' });
  for (const m of [a, b, ask]) m.channel = fakeChannel([a, b, ask]);

  const chain = await fetchReplyChain(ask, 'general');
  const ids = chain.map((entry) => entry.messageId).join(',');
  if (ids !== '1,2') fail(`鎖は古い順に親をたどる: ${ids}`);
  if (chain[1].content !== 'それ経費だろ') fail('リプ先の本文が入っていない');
}

{
  // 6ホップで打ち切る (無限に遡らない)
  const msgs = Array.from({ length: 12 }, (_, i) => fakeMessage({
    id: String(i + 1), content: `m${i + 1}`, replyTo: i === 0 ? null : String(i)
  }));
  const channel = fakeChannel(msgs);
  for (const m of msgs) m.channel = channel;

  const chain = await fetchReplyChain(msgs[11], 'general');
  if (chain.length !== 6) fail(`6ホップで止める: ${chain.length}`);
  if (chain[chain.length - 1].messageId !== '11') fail('直近の親が末尾に来る');
}

{
  // 消されたメッセージへのリプライでも落ちない (そこで切れる)
  const ask = fakeMessage({ id: '9', content: 'これ何', replyTo: 'gone' });
  ask.channel = fakeChannel([ask]);
  if ((await fetchReplyChain(ask, 'general')).length !== 0) fail('取れない親は鎖に入れない');
}

{
  // 自分自身を参照していてもループしない
  const loop = fakeMessage({ id: '5', content: 'じぶん', replyTo: '5' });
  loop.channel = fakeChannel([loop]);
  if ((await fetchReplyChain(loop, 'general')).length !== 0) fail('自己参照で回ってはいけない');
}

{
  // 転送 (forward) は fetch では取れず、message_snapshots 側に本文が入る。
  // 投稿者は Discord が渡してこないので、名前を出さずにそう書く。
  const forwarded = fakeMessage({ id: 'far', content: '隠す必要ないしね', name: 'unknown' });
  forwarded.channel = null;
  const ask = fakeMessage({ id: '7', content: '@bot これ本当？', replyTo: 'far' });
  ask.messageSnapshots = new Map([['far', forwarded]]);
  ask.channel = fakeChannel([ask]);

  const chain = await fetchReplyChain(ask, 'general');
  if (chain.length !== 1) fail(`転送も鎖に入れる: ${chain.length}`);
  if (chain[0].content !== '隠す必要ないしね') fail('転送の本文が入っていない');
  if (!chain[0].authorName.includes('投稿者不明')) {
    fail(`転送は投稿者不明と書く (取り違えを防ぐ): ${chain[0].authorName}`);
  }
}

console.log('reply chain ok (リプ先 / 6ホップ / 削除 / 自己参照 / 転送)');

// --- 経過表示を会話に混ぜない ---
//
// indicator.start() は fetchRecent より先に走るので、自分の `-# thinking …` が
// 直近30件に入っていた。枠を食うだけでなく、自分の発言として読まれる。

const { INDICATOR_PREFIX, isIndicatorMessage } = await import('../src/agent/thinking.js');

{
  const self = '111';
  const indicator = { authorId: self, content: `${INDICATOR_PREFIX}<t:1700000000:R> · 検索` };
  if (!isIndicatorMessage(indicator, self)) fail('自分の経過表示を見分けられていない');

  // 他人が同じ文字列を書いても自分の経過表示ではない
  if (isIndicatorMessage({ authorId: '222', content: indicator.content }, self)) {
    fail('他人の発言を経過表示として捨ててはいけない');
  }
  // 自分の普通の回答は捨てない
  if (isIndicatorMessage({ authorId: self, content: 'たこが4月に書いてる' }, self)) {
    fail('自分の回答を経過表示として捨ててはいけない');
  }
  // selfId が取れないときは何も捨てない
  if (isIndicatorMessage(indicator, null)) fail('selfId 不明なら捨てない');
}

console.log('indicator ok (経過表示を直近の会話に混ぜない)');

// --- 本文が無い発言 ---
//
// 画像だけ・埋め込みだけの発言は content が空。そのまま渡すと `(本文なし)` になって
// 何が貼られたのか分からない。アーカイブ側は extra に集めていたのに、
// 生の Message 側 (直近の会話・返信の鎖) だけ抜けていた。

const { fromDiscordMessage } = await import('../src/agent/format.js');

{
  const base = {
    id: '1',
    guildId: 'g',
    channelId: 'c',
    author: { id: 'u', username: 'たこ' },
    member: { displayName: 'たこ' },
    createdTimestamp: 1_700_000_000_000,
    reactions: { cache: new Map() },
    attachments: new Map(),
    embeds: [],
    stickers: new Map()
  };
  const contentOf = (over) => fromDiscordMessage({ ...base, ...over }, 'general').content;

  const image = contentOf({ content: '', attachments: new Map([['a', { name: 'screenshot.png' }]]) });
  if (!image.includes('screenshot.png')) fail(`画像だけの発言でファイル名が出ない: ${image}`);

  const embed = contentOf({
    content: '',
    embeds: [{ title: 'Asahi Linux', description: 'Apple Silicon 上の Linux' }]
  });
  if (!embed.includes('Asahi Linux')) fail(`埋め込みだけの発言で中身が出ない: ${embed}`);
  if (!embed.includes('Apple Silicon')) fail(`埋め込みの説明が出ない: ${embed}`);

  const sticker = contentOf({ content: '', stickers: new Map([['s', { name: 'ぬこ' }]]) });
  if (!sticker.includes('ぬこ')) fail(`スタンプ名が出ない: ${sticker}`);

  // 本文があるときは足さない (普通の発言のトークンを増やさない / アーカイブ側と同じ規則)
  const both = contentOf({ content: 'これ見て', attachments: new Map([['a', { name: 'x.png' }]]) });
  if (both !== 'これ見て') fail(`本文があるなら足さない: ${both}`);

  // 長い埋め込みは切る
  const long = contentOf({ content: '', embeds: [{ description: 'あ'.repeat(500) }] });
  if (long.length > 130) fail(`埋め込みが長すぎる: ${long.length} 文字`);

  if (contentOf({ content: '' }) !== '') fail('何も無いなら空のまま');
}

console.log('extras ok (画像・埋め込み・スタンプの中身を渡す)');
