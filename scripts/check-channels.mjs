// スレッドとフォーラムの見え方の検証 (npm run check から呼ぶ)。
//
// 固定したいのは2つ:
//   1. フォーラムが一覧に出ること。本体は発言を持たないので MESSAGE_CHANNEL_TYPES に
//      入っておらず、投稿は取り込まれているのに置き場の名前だけが抜けていた
//   2. 閉じた投稿を名前で読めること。キャッシュに載らないので、名前指定が
//      「そのチャンネルは見つかりませんでした」で行き止まりになっていた
//
// ARCHIVE_DB_PATH を一時ファイルに向けて呼ぶこと。

import { ChannelType } from 'discord.js';
import { db as archiveDb, msToSnowflake } from '../src/archive/db.js';
import { RefTable } from '../src/agent/format.js';
import { describeChannels, resolveAnchor, resolveChannel, runRead, runSearch } from '../src/agent/tools.js';

const fail = (message) => { throw new Error(message); };

const GUILD = 'check-guild-1';
const TEXT = 'ch-text';
const FORUM = 'ch-forum';
// 別チャンネルにある発言。ID はスノーフレークの形でないと素の文字列として弾かれる
const FAR = '1487488490697658408';

const cleanup = () => archiveDb.prepare('DELETE FROM channels WHERE guild_id = ?').run(GUILD);

const addChannel = (row) => archiveDb.prepare(`
  INSERT OR REPLACE INTO channels
    (channel_id, guild_id, parent_id, name, type, is_thread, is_private, message_count, oldest_id, newest_id)
  VALUES
    (@channel_id, @guild_id, @parent_id, @name, @type, @is_thread, @is_private, @message_count, @oldest_id, @newest_id)
`).run({
  parent_id: null, type: 0, is_thread: 0, is_private: 0, message_count: 0,
  oldest_id: null, newest_id: null, guild_id: GUILD, ...row
});

// permissionsFor は「全部見える」で固定する。権限の判定は permissions.js 側の仕事。
const fakeChannel = (id, name, type) => ({
  id,
  name,
  type,
  rawPosition: 0,
  permissionsFor: () => ({ has: () => true })
});

cleanup();

try {
  // 取り込み済みの形: テキスト1つ (スレッド2本)、フォーラム1つ (投稿3本)
  addChannel({ channel_id: TEXT, name: 'general', type: ChannelType.GuildText, message_count: 100 });
  addChannel({ channel_id: FORUM, name: 'q-and-a', type: ChannelType.GuildForum, message_count: 0 });

  addChannel({ channel_id: 't1', name: '雑談スレ', parent_id: TEXT, is_thread: 1, message_count: 30 });
  addChannel({ channel_id: 't2', name: '閉じたスレ', parent_id: TEXT, is_thread: 1, message_count: 20 });

  // 投稿には実在の発言 ID を持たせる (at の起点に使うので、スレッド ID ではない)
  const at = (iso) => msToSnowflake(Date.parse(iso));
  addChannel({
    channel_id: 'p1', name: 'ビルドが通らない', parent_id: FORUM, is_thread: 1, message_count: 40,
    oldest_id: at('2024-05-01T00:00:00Z'), newest_id: at('2024-05-03T00:00:00Z')
  });
  addChannel({
    channel_id: 'p2', name: '型エラーの直し方', parent_id: FORUM, is_thread: 1, message_count: 25,
    oldest_id: at('2024-04-01T00:00:00Z'), newest_id: at('2024-04-02T00:00:00Z')
  });
  addChannel({
    channel_id: 'p3', name: 'デプロイ手順', parent_id: FORUM, is_thread: 1, message_count: 5,
    oldest_id: at('2024-03-01T00:00:00Z'), newest_id: at('2024-03-02T00:00:00Z')
  });

  // ギルドのキャッシュに載るのは、テキスト・フォーラム本体・アクティブな投稿だけ。
  // 閉じた投稿 (t2 / p2 / p3) は載らない。
  const cache = new Map([
    [TEXT, fakeChannel(TEXT, 'general', ChannelType.GuildText)],
    [FORUM, fakeChannel(FORUM, 'q-and-a', ChannelType.GuildForum)],
    ['t1', fakeChannel('t1', '雑談スレ', ChannelType.PublicThread)],
    ['p1', fakeChannel('p1', 'ビルドが通らない', ChannelType.PublicThread)]
  ]);

  const ctx = {
    member: { id: 'u1' },
    guild: {
      id: GUILD,
      channels: {
        cache,
        fetch: async (id) => fakeChannel(id, `fetched-${id}`, ChannelType.PublicThread)
      }
    }
  };

  // --- 一覧 ---
  {
    const result = describeChannels(ctx);

    if (!result.text.includes('#q-and-a')) fail(`フォーラムが一覧に出ていない: ${result.text}`);

    // 投稿は親に足し込む (40 + 25 + 5 = 70)
    if (!/#q-and-a\(70・投稿3\)/.test(result.text)) fail(`フォーラムの集計が違う: ${result.text}`);
    // テキストは自分の発言 + スレッド (100 + 30 + 20 = 150)
    if (!/#general\(150・スレ2\)/.test(result.text)) fail(`スレッドを親に足し込めていない: ${result.text}`);

    // スレッドは個別に出さない (賑やかなチャンネルの投稿で一覧が埋まる)
    for (const name of ['雑談スレ', 'ビルドが通らない']) {
      if (result.text.includes(name)) fail(`スレッドを個別に並べてはいけない: ${name}`);
    }
    if (result.total !== 2) fail(`入れ物の数で数える: ${result.total}`);
    if (!result.hasThreads) fail('スレッドがあることを呼び出し側に伝えていない');

    // 発言数の多い順
    if (result.text.indexOf('#general') > result.text.indexOf('#q-and-a')) {
      fail(`発言数の多い順に並べる: ${result.text}`);
    }
  }

  // --- 閉じた投稿を名前で読む ---
  {
    // キャッシュにあるものは今までどおりキャッシュから
    const live = await resolveChannel(ctx, '#general');
    if (live?.id !== TEXT) fail(`キャッシュのチャンネルを引けていない: ${live?.id}`);

    // 閉じた投稿はアーカイブから ID を出して取りに行く
    const closed = await resolveChannel(ctx, '型エラーの直し方');
    if (closed?.id !== 'p2') fail(`閉じた投稿を名前で引けていない: ${closed?.id}`);

    // 部分一致でも引ける
    const partial = await resolveChannel(ctx, 'デプロイ');
    if (partial?.id !== 'p3') fail(`部分一致で引けていない: ${partial?.id}`);

    // 無いものは無い
    if (await resolveChannel(ctx, 'そんな投稿はない')) fail('無い名前で何かを返してはいけない');
  }

  // --- フォーラムを指定して「ここのスレッド見て」が通る ---
  //
  // ForumChannel には .messages が無いので、read は
  // 「そのチャンネルからはメッセージを取得できません」で行き止まりだった。
  // 中身は全部スレッドなので、投稿の一覧を番号付きで返す。
  {
    const readCtx = {
      ...ctx,
      refs: new RefTable(),
      channel: cache.get(TEXT),
      channelScope: { mode: 'all', ids: [] },
      client: { user: { id: 'bot-1' } }
    };

    const out = await runRead(readCtx, { channel: '#q-and-a' });

    if (/取得できません/.test(out)) fail(`フォーラムが行き止まりになっている: ${out}`);
    for (const name of ['ビルドが通らない', '型エラーの直し方', 'デプロイ手順']) {
      if (!out.includes(name)) fail(`投稿が一覧に出ていない: ${name}\n${out}`);
    }
    // 最終発言の新しい順
    if (out.indexOf('ビルドが通らない') > out.indexOf('デプロイ手順')) fail(`新しい順に並べる:\n${out}`);
    if (!out.includes('40件')) fail(`発言数が出ていない:\n${out}`);

    // 番号がそのまま at に渡せること。起点はスレッド ID ではなく中の実在の発言。
    const first = readCtx.refs.get(1);
    if (!first) fail('投稿に参照番号を振っていない');
    if (first.channelId !== 'p1') fail(`参照先の投稿が違う: ${first.channelId}`);
    if (first.messageId === 'p1') fail('起点はスレッド ID ではなく中の発言にする');
    if (first.messageId !== at('2024-05-01T00:00:00Z')) fail(`起点が oldest_id ではない: ${first.messageId}`);

    // 次の一手を書いておかないと、一覧を見たまま止まる
    if (!out.includes('at にその番号')) fail(`中の読み方を書いていない:\n${out}`);
    if (!out.includes('in:#q-and-a')) fail(`配下の検索の仕方を書いていない:\n${out}`);
  }

  // --- 非公開スレッドは名前で掘り当てられない ---
  //
  // getChannelScope は「親の権限では判定できない」として弾いている。
  // ここから通すと、その判定を名前指定で迂回できてしまう。
  {
    addChannel({ channel_id: 'secret', name: '運営用スレ', parent_id: TEXT, is_thread: 1, is_private: 1, message_count: 9 });

    if (await resolveChannel(ctx, '運営用スレ')) fail('非公開スレッドを名前で引かせてはいけない');
  }

  // --- 投稿を単位にした検索 (mode:posts) ---
  //
  // 発言単位で返すと「どの投稿の話か」が分からない。フォーラムは 1投稿 = 1話題なので、
  // ここを単位にできないと「○○について聞いてる投稿ある？」に答えられない。
  {
    const said = (id, channel, author, content, ms) => archiveDb.prepare(`
      INSERT OR REPLACE INTO messages
        (message_id, guild_id, channel_id, parent_id, author_id, author_name, is_bot, content, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)
    `).run(id, GUILD, channel, FORUM, author, author, content, Date.parse(ms));

    // p1: 本文に「ビルド」が出てくる / 別の人が答えている
    said('m1', 'p1', 'たこ', 'CI が落ちる', '2024-05-01T00:00:00Z');
    said('m2', 'p1', 'さば', 'ビルドのキャッシュ消した？', '2024-05-02T00:00:00Z');
    // p2: タイトルにしか「型」が出てこない / 投稿者しか喋っていない = 未解決
    said('m3', 'p2', 'のあ', 'これ直し方わかる人いる', '2024-04-01T00:00:00Z');
    said('m4', 'p2', 'のあ', '誰かー', '2024-04-02T00:00:00Z');

    archiveDb.prepare("UPDATE channels SET applied_tags = ' 解決済み ' WHERE channel_id = 'p1'").run();
    archiveDb.prepare("UPDATE channels SET applied_tags = ' bug 未対応 ' WHERE channel_id = 'p2'").run();

    const postCtx = { ...ctx, refs: new RefTable(), channelScope: { mode: 'all', ids: [] } };
    const posts = (over) => runSearch(postCtx, { mode: 'posts', ...over }, { archiveAvailable: true });

    // 本文一致
    const body = await posts({ query: 'キャッシュ' });
    if (!body.includes('ビルドが通らない')) fail(`本文で投稿を引けていない:\n${body}`);
    if (body.includes('型エラー')) fail(`当たっていない投稿まで出ている:\n${body}`);

    // タイトルにしか無い語で引けること (本文で「型」と誰も書いていない)
    const title = await posts({ query: '型エラー' });
    if (!title.includes('型エラーの直し方')) fail(`タイトル一致で引けていない:\n${title}`);
    if (!title.includes('タイトル一致')) fail(`タイトルで当たったことを書いていない:\n${title}`);

    // タグで絞る
    const tagged = await posts({ query: 'tag:解決済み' });
    if (!tagged.includes('ビルドが通らない')) fail(`tag: で引けていない:\n${tagged}`);
    if (tagged.includes('型エラー')) fail(`別のタグの投稿まで出ている:\n${tagged}`);
    if (!tagged.includes('取り込んだ時点のもの')) fail('タグが取り込み時点のものだと注記していない');

    // 未解決 = 人間が投稿者しか喋っていない
    const open = await posts({ query: 'is:unanswered' });
    if (!open.includes('型エラーの直し方')) fail(`未解決の投稿を拾えていない:\n${open}`);
    if (open.includes('ビルドが通らない')) fail(`答えが付いている投稿まで未解決にしている:\n${open}`);

    // 番号がそのまま at に渡せること
    const ref = postCtx.refs.get(1);
    if (!ref?.channelId) fail('投稿に参照番号を振っていない');
    if (ref.messageId === ref.channelId) fail('起点はスレッド ID ではなく中の発言にする');

    archiveDb.prepare('DELETE FROM messages WHERE guild_id = ?').run(GUILD);
  }

  // --- 別チャンネルのメッセージ ID を渡されたとき ---
  // (ID はスノーフレークの形でないと素の文字列として弾かれる)
  //
  // refs に無い ID は channelId が null のままで、runRead が「呼ばれたチャンネル」に
  // 落ちて、他所の ID でそこを around していた。アーカイブが知っているなら埋める。
  {
    archiveDb.prepare(`
      INSERT OR REPLACE INTO messages
        (message_id, guild_id, channel_id, author_id, author_name, content, created_at)
      VALUES (?, ?, 't2', 'u9', 'のあ', '別のスレッドの発言', 1700000000000)
    `).run(FAR, GUILD);

    const anchorCtx = { ...ctx, refs: new RefTable(), channelScope: { mode: 'all', ids: [] } };

    const found = resolveAnchor(anchorCtx, FAR);
    if (found.kind !== 'message') fail(`アーカイブにある ID はメッセージ扱い: ${found.kind}`);
    if (found.channelId !== 't2') fail(`どのチャンネルの発言か埋まっていない: ${found.channelId}`);

    // 見えないチャンネルは埋めない。ID を知っているだけで前後を読めてはいけない
    const walled = { ...anchorCtx, channelScope: { mode: 'include', ids: [TEXT] } };
    if (resolveAnchor(walled, FAR).channelId) fail('権限の無いチャンネルを解決してはいけない');

    // 日付と参照番号は今までどおり
    if (resolveAnchor(anchorCtx, '2020').kind !== 'time') fail('4桁の年は日付');
    if (resolveAnchor(anchorCtx, '9999').kind !== 'error') fail('無い参照番号はエラー');

    archiveDb.prepare('DELETE FROM messages WHERE message_id = ?').run(FAR);
  }

  // --- topic は絞り込んだときだけ出す ---
  {
    archiveDb.prepare('UPDATE channels SET topic = ? WHERE channel_id = ?').run('雑談ぜんぶ', TEXT);

    const narrow = describeChannels(ctx, { filter: 'general' });
    if (!narrow.text.includes('雑談ぜんぶ')) fail(`絞り込んだら topic を出す: ${narrow.text}`);

    // 11件以上のときは出さない (全チャンネルぶん並べると出力が数倍になる)
    const many = new Map(cache);
    for (let i = 0; i < 12; i += 1) {
      many.set(`x${i}`, fakeChannel(`x${i}`, `ch${i}`, ChannelType.GuildText));
    }
    const wide = describeChannels({ ...ctx, guild: { ...ctx.guild, channels: { ...ctx.guild.channels, cache: many } } });
    if (wide.text.includes('雑談ぜんぶ')) fail('件数が多いときに topic を出してはいけない');

    archiveDb.prepare('UPDATE channels SET topic = ? WHERE channel_id = ?').run('', TEXT);
  }

  console.log('channels ok (フォーラム一覧 / 名前で読む / mode:posts / tag: / is:unanswered / at の解決 / topic)');
} finally {
  cleanup();
}
