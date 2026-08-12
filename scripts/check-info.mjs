// info ツールの検証 (npm run check から呼ぶ)。
//
// ここで固定したいのは「黙って嘘をつかないこと」。
//   - 記録が無いことを「無かった」と書かない (リアクションの押した人・未取り込み)
//   - 見えないチャンネルの中身を素性経由で漏らさない
//   - どの action も落ちない (落ちると1往復まるごと無駄になる)
//
// ARCHIVE_DB_PATH を一時ファイルに向けて呼ぶこと。

import { Collection } from 'discord.js';
import { db as archiveDb } from '../src/archive/db.js';
import { RefTable } from '../src/agent/format.js';
import { infoDefinition, runInfo } from '../src/agent/info.js';

const fail = (message) => { throw new Error(message); };

const GUILD = 'check-info-guild';
const OPEN = 'ch-open';
const WALLED = 'ch-walled';
const TAKO = '100000000000000001';
const SABA = '100000000000000002';
const MSG = '1487488490697658408';
const HIDDEN_MSG = '1487488490697658409';

const cleanup = () => {
  archiveDb.prepare('DELETE FROM messages WHERE guild_id = ?').run(GUILD);
  archiveDb.prepare('DELETE FROM channels WHERE guild_id = ?').run(GUILD);
  for (const id of [MSG, HIDDEN_MSG]) {
    archiveDb.prepare('DELETE FROM message_reactions WHERE message_id = ?').run(id);
    archiveDb.prepare('DELETE FROM message_reaction_users WHERE message_id = ?').run(id);
  }
};

const addChannel = (id, name) => archiveDb.prepare(`
  INSERT OR REPLACE INTO channels (channel_id, guild_id, name, type, message_count)
  VALUES (?, ?, ?, 0, 0)
`).run(id, GUILD, name);

const said = (id, channel, author, name, content, ms, replyTo = null) => archiveDb.prepare(`
  INSERT OR REPLACE INTO messages
    (message_id, guild_id, channel_id, author_id, author_name, content, created_at, reply_to, char_count)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`).run(id, GUILD, channel, author, name, content, Date.parse(ms), replyTo, content.length);

cleanup();

try {
  addChannel(OPEN, 'general');
  addChannel(WALLED, 'staff');

  said('a1', OPEN, SABA, 'さば', 'デプロイした', '2024-03-01T00:00:00Z');
  said('a2', OPEN, TAKO, 'たこ', 'レビューは？', '2024-04-01T00:00:00Z', 'a1');
  said('a3', OPEN, TAKO, 'たこ', 'まあいいか', '2024-05-01T00:00:00Z', 'a1');
  said(MSG, OPEN, TAKO, 'たこ', 'これに反応して', '2024-05-02T00:00:00Z');
  said(HIDDEN_MSG, WALLED, SABA, 'さば', '運営の話', '2024-05-02T00:00:00Z');

  archiveDb.prepare("INSERT OR REPLACE INTO message_reactions VALUES (?, '👍', 2)").run(MSG);
  archiveDb.prepare("INSERT OR REPLACE INTO message_reactions VALUES (?, '🎉', 5)").run(MSG);
  archiveDb.prepare('INSERT OR REPLACE INTO message_reaction_users VALUES (?, ?, ?)').run(MSG, '👍', SABA);
  archiveDb.prepare("INSERT OR REPLACE INTO message_reactions VALUES (?, '👀', 1)").run(HIDDEN_MSG);

  const refs = new RefTable();
  refs.add({ messageId: MSG, channelId: OPEN, guildId: GUILD });
  refs.add({ messageId: HIDDEN_MSG, channelId: WALLED, guildId: GUILD });

  const ctx = {
    refs,
    member: { id: TAKO },
    channelScope: { mode: 'include', ids: [OPEN] },
    guild: {
      id: GUILD,
      name: 'テストサーバー',
      createdTimestamp: Date.parse('2020-01-01T00:00:00Z'),
      memberCount: 42,
      // メンバーはキャッシュに載っていない前提。名前 → ID はアーカイブ側に
      // 落ちて解決される (退出済みの人でも素性を引けることの確認を兼ねる)。
      members: {
        cache: new Collection(),
        fetch: async () => null,
        search: async () => new Collection()
      },
      channels: { cache: new Collection() }
    }
  };

  // --- どの action も落ちない ---
  for (const action of infoDefinition.function.parameters.properties.action.enum) {
    const out = await runInfo(ctx, { action, who: 'たこ', at: '1', period: '30d' });
    if (typeof out !== 'string' || !out.trim()) fail(`${action} が空を返した`);
  }

  // 知らない action は黙って別のものを実行しない
  const bogus = await runInfo(ctx, { action: 'あやしい' });
  if (!bogus.includes('action が不正')) fail(`知らない action を素通りさせている: ${bogus}`);

  // --- member ---
  {
    const out = await runInfo(ctx, { action: 'member', who: 'たこ' });

    if (!out.includes(TAKO)) fail(`ID が出ていない: ${out}`);
    if (!out.includes('発言 3 件')) fail(`発言数が違う: ${out}`);
    if (!out.includes('よく居る')) fail(`よく居るチャンネルが出ていない: ${out}`);
    // 誰と話しているかはチャンネルでは分からない。reply_to を辿って初めて出る
    if (!out.includes('さば')) fail(`よく返信する相手が出ていない: ${out}`);
    // 見えないチャンネルの発言は数に入れない
    if (out.includes('運営の話')) fail('見えないチャンネルの中身が漏れている');

    const missing = await runInfo(ctx, { action: 'member', who: 'そんな人いない' });
    if (!missing.includes('見つかりませんでした')) fail(`居ない人を黙って通している: ${missing}`);
    if (!(await runInfo(ctx, { action: 'member' })).includes('who')) fail('who 省略を案内していない');
  }

  // --- guild ---
  {
    const out = await runInfo(ctx, { action: 'guild' });
    if (!out.includes('テストサーバー')) fail(`サーバー名が出ていない: ${out}`);
    if (!out.includes('42')) fail(`人数が出ていない: ${out}`);
    if (!out.includes('2020')) fail(`作成日が出ていない: ${out}`);
  }

  // --- reactions ---
  {
    const out = await runInfo(ctx, { action: 'reactions', at: '1' });

    if (!out.includes('👍')) fail(`リアクションが出ていない: ${out}`);
    // 記録がある絵文字は名前が出る
    if (!out.includes('さば')) fail(`押した人が出ていない: ${out}`);
    // 記録が無い絵文字を「誰も押していない」と読ませない。ここが一番高い誤り
    if (!out.includes('記録なし')) fail(`記録の無い絵文字をごまかしている: ${out}`);
    if (!out.includes('この機能を入れた後')) fail(`いつからの記録か書いていない: ${out}`);

    // 見えないチャンネルの発言のリアクションは出さない
    const walled = await runInfo(ctx, { action: 'reactions', at: '2' });
    if (walled.includes('👀')) fail(`見えないチャンネルのリアクションが漏れている: ${walled}`);

    if (!(await runInfo(ctx, { action: 'reactions' })).includes('at')) fail('at 省略を案内していない');
  }

  // --- emoji ---
  {
    const out = await runInfo(ctx, { action: 'emoji', period: 'all' });
    if (!out.includes('👍') && !out.includes('記録がありません')) fail(`絵文字の集計がおかしい: ${out}`);
  }

  // --- activity ---
  {
    const out = await runInfo(ctx, { action: 'activity', period: 'month' });
    // XP は発言数ではない。取り違えられると数字が独り歩きする
    if (!out.includes('発言数そのものではない')) fail(`XP の意味を書いていない: ${out}`);
    if (!out.includes('通話')) fail(`通話が出ていない: ${out}`);
  }

  console.log('info ok (5 action / 権限を越えない / 記録が無いことを隠さない)');
} finally {
  cleanup();
}
