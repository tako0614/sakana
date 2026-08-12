// 回答の見た目にかかわる2点を固定する。
//
//   1. 引用が本文に生 URL を混ぜないこと (88文字の URL が1文ごとに挟まると読めない)
//   2. system プロンプトが1文字も可変でないこと (可変にすると 5.5KB が毎回キャッシュ外)
//
// どちらも壊れても例外は出ず、静かに読みにくさと費用になるだけなので門を置く。

import { browserToolDefinition } from '../src/agent/browser.js';
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

{
  // どのモデルが書いたかは毎回出す。引用があるときは同じ subtext に混ぜる
  // (行を2本にすると会話の邪魔になる)。
  const refs = tableOf(2);
  const withUrls = expandCitations('4月に書いてる [1]。', refs, { label: 'deepseek v4 flash' });
  const footer = withUrls.split('-# ')[1];
  if (!footer.startsWith('deepseek v4 flash ')) fail(`モデル名が先頭に来ていない: ${footer}`);
  if (!footer.includes('discord.com')) fail(`引用が消えている: ${footer}`);
  if ((withUrls.match(/-#/g) ?? []).length !== 1) fail('subtext は1行にまとめる');

  // 引用が無くてもモデル名は出す
  const bare = expandCitations('ログに出てないから分からん。', refs, { label: 'evex-1' });
  if (!bare.endsWith('-# evex-1')) fail(`引用0件でもモデル名を出す: ${bare}`);

  // ラベルを渡さなければ従来どおり (末尾は URL だけ / 引用0件なら足さない)
  const plain = expandCitations('分からん。', refs);
  if (plain.includes('-#')) fail(`ラベルも引用も無いなら末尾を足さない: ${plain}`);
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

// --- web 検索 ---
//
// ブラウザを「貼られた URL を開く道具」としか書いていなかったので、モデルは
// ログに無いことを記憶で埋めるか「分からない」で終わらせていた。
// 入口 (search) と、それを使う場面の説明が両方あって初めて発想が生まれる。
// 片方だけ消えても例外は出ないので門を置く。
const readOnlyBrowser = browserToolDefinition(false).function;

if (!readOnlyBrowser.parameters.properties.action.enum.includes('search')) {
  fail('閲覧しか許していない人が web 検索を使えない (search は操作ではない)');
}
if (!readOnlyBrowser.parameters.properties.query) {
  fail('search に渡す query が宣伝されていない');
}
if (!/search/.test(first)) {
  fail('プロンプトに web を引く場面が書かれていない (道具があっても呼ばれない)');
}

console.log('web search ok (閲覧のみでも search / プロンプトに使う場面)');

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

// --- Discord のリンク ---
//
// リンクにはスノーフレークが3つ並んでいて、最初に当たるのはサーバー ID。
// 素の /(\d{16,21})/ で拾っていたので、リンクを貼って「これ何？」と聞くと
// サーバー ID をメッセージ ID として読みに行っていた。

{
  const G = '1255359848644608035';
  const C = '1445478071221223515';
  const M = '1487488490697658408';

  const refs = new RefTable();
  refs.add({ messageId: '999888777666555444', channelId: 'c1', guildId: 'g1' });

  const link = refs.resolve(`https://discord.com/channels/${G}/${C}/${M}`);
  if (link?.messageId !== M) fail(`リンクの3つ目を取る (いまは ${link?.messageId}): サーバー ID を掴んではいけない`);
  if (link.channelId !== C) fail(`リンクからチャンネルも取れる: ${link.channelId}`);

  // 囲みや前後の文があっても拾う
  const inline = refs.resolve(`これ見て <https://discord.com/channels/${G}/${C}/${M}> どう思う`);
  if (inline?.messageId !== M) fail(`文中のリンクを拾えていない: ${inline?.messageId}`);

  // 旧ドメイン
  if (refs.resolve(`https://discordapp.com/channels/${G}/${C}/${M}`)?.messageId !== M) {
    fail('discordapp.com のリンクを読めていない');
  }

  // チャンネルへのリンク (メッセージが無い)
  const toChannel = refs.resolve(`https://discord.com/channels/${G}/${C}`);
  if (toChannel?.messageId) fail(`チャンネルへのリンクにメッセージは無い: ${toChannel.messageId}`);
  if (toChannel?.channelId !== C) fail(`チャンネルへのリンクから ID が取れない: ${toChannel?.channelId}`);

  // DM のリンクで落ちない
  if (refs.resolve(`https://discord.com/channels/@me/${C}/${M}`)?.messageId !== M) {
    fail('@me のリンクで壊れている');
  }

  // 素のスノーフレークと参照番号は今までどおり
  if (refs.resolve('999888777666555444')?.channelId !== 'c1') fail('表にある ID は表から引く');
  if (refs.resolve('1')?.messageId !== '999888777666555444') fail('参照番号が引けなくなっている');
  if (refs.resolve('ただの文字列')) fail('ID の無い文字列で何かを返してはいけない');
}

console.log('discord link ok (3つ目を取る / channel も取れる / 番号は今までどおり)');

// --- 転送メッセージの取り込み ---
//
// 転送は content が空で、中身は message_snapshots 側。見ないまま取り込むと
// 本文なしの行になって検索に永久に引っかからない。

{
  const { toRecord } = await import('../src/archive/indexer.js');

  const base = {
    id: 'f1',
    guildId: 'g1',
    channelId: 'c1',
    author: { id: 'u1', username: 'たこ' },
    member: { displayName: 'たこ' },
    createdTimestamp: 1_700_000_000_000,
    attachments: new Map(),
    embeds: [],
    stickers: new Map(),
    reactions: { cache: new Map() },
    mentions: { users: new Map() },
    channel: { id: 'c1' }
  };

  const forwarded = toRecord({
    ...base,
    content: '',
    messageSnapshots: new Map([['far', { content: '隠す必要ないしね' }]])
  });

  if (!forwarded.content.includes('隠す必要ないしね')) {
    fail(`転送の本文を取り込んでいない: ${JSON.stringify(forwarded.content)}`);
  }
  // 投稿者は Discord が渡してこない。転送だと分かる印は要る
  if (!forwarded.content.startsWith('[転送]')) fail(`転送の印が無い: ${forwarded.content}`);
  if (forwarded.char_count === 0) fail('文字数が 0 のままだと len: で引けない');

  // 本文がある発言には足さない
  const normal = toRecord({
    ...base,
    content: '自分で書いた',
    messageSnapshots: new Map([['far', { content: '転送のぶん' }]])
  });
  if (normal.content !== '自分で書いた') fail(`本文があるなら足さない: ${normal.content}`);

  // 転送でない発言は今までどおり
  if (toRecord({ ...base, content: 'ふつう' }).content !== 'ふつう') fail('普通の発言を壊している');
}

console.log('forward ok (転送の本文を取り込む / 印を付ける)');

// --- 依頼そのものの取りこぼし ---
//
// 直近の会話は describeExtras を通っているのに、依頼だけ message.content の
// 素通しだった。改行は潰れ、貼られた画像は存在すら伝わっていなかった。

const { stripMention } = await import('../src/agent/index.js');

{
  const BOT = '111000111000111000';

  // 改行は残す。箇条書きや貼り付けたログが1行に潰れると、人が見ている形と違うものを読ませる。
  const listed = stripMention(`<@${BOT}> これ直して\n- A が落ちる\n- B が遅い`, BOT);
  if (!listed.includes('\n- A が落ちる\n- B が遅い')) fail(`改行が潰れている: ${JSON.stringify(listed)}`);
  if (listed.startsWith('\n') || listed.endsWith('\n')) fail(`端の空白は落とす: ${JSON.stringify(listed)}`);

  // 行の中の連続空白は畳む (元の挙動)
  if (stripMention('a    b', BOT) !== 'a b') fail('行内の連続空白は畳む');
  // 空行が3つ以上続いても2つまで
  if (stripMention('a\n\n\n\n\nb', BOT) !== 'a\n\nb') fail('空行を詰める');
  // メンションは消える (ニックネーム形式 <@!id> も)
  if (stripMention(`<@!${BOT}> やあ`, BOT) !== 'やあ') fail('メンションが残っている');
}

{
  // 依頼に貼られたものが依頼セクションに出ること
  const withImage = userContentOf({ extras: 'screenshot.png' });
  const askBlock = withImage.slice(withImage.indexOf('## 依頼'));
  if (!askBlock.includes('screenshot.png')) fail(`依頼の添付が出ていない: ${askBlock}`);
  if (!askBlock.includes('中身は見えない')) fail('読めないことを書かないと、読めたふりをする');

  // 添付が無いときは1行も足さない (普通の依頼のトークンを増やさない)
  if (userContentOf().includes('貼られているもの')) fail('添付が無いのに行を足している');

  // 本文なし + 添付 のときに「直近の会話をまとめて」と言わない
  const imageOnly = userContentOf({ prompt: '', extras: 'cat.png' });
  if (imageOnly.includes('直近の会話をまとめて')) fail('画像だけの依頼で背景の要約を指示してはいけない');
  if (!imageOnly.includes('貼られたものについて')) fail('画像だけの依頼の指示が出ていない');
}

console.log('request ok (改行を保つ / 依頼の添付を伝える)');

// --- 長い回答の分割 ---
//
// コードブロックの途中で切ると、続きのメッセージが地の文になって等幅もインデントも消える。

const { chunkForDiscord } = await import('../src/agent/format.js');

{
  const code = Array.from({ length: 200 }, (_, i) => `const x${i} = ${i};`).join('\n');
  const chunks = chunkForDiscord(`これ直して\n\n\`\`\`js\n${code}\n\`\`\``);

  if (chunks.length < 2) fail('この長さなら分割されるはず');
  for (const [i, chunk] of chunks.entries()) {
    const fences = (chunk.match(/```/g) ?? []).length;
    if (fences % 2 !== 0) fail(`チャンク ${i + 1} でコードブロックが開いたまま: ${JSON.stringify(chunk.slice(-40))}`);
    if (chunk.length > 2000) fail(`チャンク ${i + 1} が Discord の上限を超えている: ${chunk.length}`);
  }
  // 2通目以降はコードの続きとして開き直す
  if (!chunks[1].startsWith('```')) fail(`続きが開き直されていない: ${JSON.stringify(chunks[1].slice(0, 20))}`);

  // コードが無いときの挙動は変えない
  const plain = chunkForDiscord('短い答え。');
  if (plain.length !== 1 || plain[0] !== '短い答え。') fail(`短い答えは1通のまま: ${JSON.stringify(plain)}`);
  if (chunkForDiscord('あ'.repeat(10_000)).at(-1).includes('```')) fail('コードでないのにフェンスを足している');
}

console.log('chunking ok (コードブロックを跨いで壊さない)');

// --- 断り文を次の会話に混ぜない ---

const { isAgentNotice } = await import('../src/agent/index.js');

{
  const self = '111';
  const notices = [
    'いま処理が立て込んでいます。少し待ってからもう一度呼んでください。',
    '使用量の上限に達しました (1人あたり1日 $0.050 / $0.05)。<t:1700000000:R> に空きます。',
    'サーバー全体の使用量の上限に達しました (1日 $0.500 / $0.50)。<t:1700000000:R> に空きます。',
    'エージェントの実行に失敗しました。しばらくしてからもう一度試してください。'
  ];

  for (const content of notices) {
    if (!isAgentNotice({ authorId: self, content }, self)) fail(`断り文を見分けられていない: ${content}`);
  }

  // 他人の発言と、自分の普通の回答は捨てない
  if (isAgentNotice({ authorId: '222', content: notices[0] }, self)) fail('他人の発言を捨ててはいけない');
  if (isAgentNotice({ authorId: self, content: 'たこが4月に書いてる' }, self)) fail('自分の回答を捨ててはいけない');
  if (isAgentNotice({ authorId: self, content: notices[0] }, null)) fail('selfId 不明なら捨てない');
}

console.log('notice ok (断り文を直近の会話に混ぜない)');

// --- 発火するのは「メンション」と「回答へのリプライ」だけ ---
//
// 以前は「bot が書いたメッセージなら続き」と見なす保険があり、経過表示・
// ウェルカム・上限の断り文・エラー文へのリプライでも起動していた。

const { isAgentRequest } = await import('../src/agent/index.js');
const { db } = await import('../src/db.js');
const { isAgentReply, rememberAgentReply } = await import('../src/agent/ratelimit.js');

const ANSWER_ID = 'check-answer-1';
const OTHER_ID = 'check-other-1';
const clearReplies = () => db.prepare('DELETE FROM agent_replies WHERE message_id LIKE ?').run('check-%');

clearReplies();
try {
  rememberAgentReply(ANSWER_ID, null);
  if (!isAgentReply(ANSWER_ID)) fail('回答を覚えられていない');
  if (isAgentReply(OTHER_ID)) fail('覚えていない ID を回答扱いしてはいけない');

  // 二重に覚えても壊れない (チャンクごとに呼ばれる)
  rememberAgentReply(ANSWER_ID, null);

  const client = { user: { id: 'bot-1' } };
  const ask = ({ replyTo = null, mention = false, fromBot = false, repliedUser = null, content = 'なんで？' }) => ({
    guildId: 'g1',
    content,
    author: { id: 'u1', bot: fromBot },
    reference: replyTo ? { messageId: replyTo } : null,
    mentions: {
      has: () => mention,
      repliedUser: repliedUser ? { id: repliedUser } : null
    }
  });

  if (!isAgentRequest(ask({ mention: true }), client)) fail('メンションでは起動する');
  if (!isAgentRequest(ask({ replyTo: ANSWER_ID }), client)) fail('回答へのリプライでは起動する');

  // bot が書いた「回答以外」へのリプライでは起動しない (経過表示・ウェルカムなど)
  if (isAgentRequest(ask({ replyTo: OTHER_ID, repliedUser: 'bot-1' }), client)) {
    fail('回答以外の bot メッセージへのリプライで起動してはいけない');
  }
  // 人へのリプライ / ただの発言 / bot 自身の発言では起動しない
  if (isAgentRequest(ask({ replyTo: 'someone-else' }), client)) fail('他人へのリプライでは起動しない');
  if (isAgentRequest(ask({}), client)) fail('ただの発言では起動しない');
  if (isAgentRequest(ask({ mention: true, fromBot: true }), client)) fail('bot の発言では起動しない');

  // --- 相槌では起動しない ---
  //
  // 回答へのリプライは会話の続きとして拾うが、そこに「ありがとう」まで含めると
  // 相槌のたびに直近30件を積み直して1回ぶん払うことになる。
  for (const content of [
    'ありがとう', 'ありがとう！', 'あざす', 'thanks', '了解', 'おけ', 'なるほど',
    '草', 'wwww', 'ｗ', 'たしかに', 'おつ', '👍', '😂😂', '<:kusa:123456789012345678>', ''
  ]) {
    if (isAgentRequest(ask({ replyTo: ANSWER_ID, content }), client)) {
      fail(`相槌では起動しない: ${JSON.stringify(content)}`);
    }
  }

  // 短い追撃は落とさない。ここを落とすと「続きを聞く」機能そのものが死ぬ。
  for (const content of [
    'なんで？', 'なんで', 'もっと詳しく', 'ソースは', 'それ本当？', 'なるほど？',
    'なるほど、じゃあ次は', 'ありがとう、あと1つ聞きたい'
  ]) {
    if (!isAgentRequest(ask({ replyTo: ANSWER_ID, content }), client)) {
      fail(`追撃では起動する: ${JSON.stringify(content)}`);
    }
  }

  // メンションは明示的な呼び出しなので、相槌でも通す
  if (!isAgentRequest(ask({ mention: true, content: 'ありがとう' }), client)) {
    fail('メンション付きなら相槌でも起動する');
  }

  console.log('trigger ok (メンション / 回答へのリプライだけ / 相槌は無視)');
} finally {
  clearReplies();
}
