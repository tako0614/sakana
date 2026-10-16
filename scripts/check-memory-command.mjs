// /memory コマンドの検証 (npm run check から呼ぶ)。
//   - status は管理者だけ。先に受け付けてから組み立て、読んだ割合・見込み・費用を出す
//   - pause で builder が区切りの境目で止まり、resume で外れる
//   - show / search / episode は誰でも開け、根拠の発言へのリンクが付く
//
// ARCHIVE_DB_PATH / MEMORY_DB_PATH を一時ファイルに向けて呼ぶこと。

import assert from 'node:assert/strict';
import { MessageFlags, PermissionFlagsBits } from 'discord.js';

process.env.MEMORY_TREE_SYSTEMD_UNIT = '';
const { db: archive } = await import('../src/archive/db.js');
const { ensureModelBudget, reserveModelCall, finishModelCall } = await import('../src/ai/cost.js');
const store = await import('../src/memory/store.js');
const { runBuild, setPaused } = await import('../src/memory/build.js');
const { memoryCommand } = await import('../src/memory/command.js');

const GUILD = '910000000000000001';
const CHANNEL = '910000000000000010';
store.resetTree(GUILD);
store.savePublicChannels(GUILD, [CHANNEL]);
store.ensureSeeds(GUILD);
archive.prepare('DELETE FROM messages WHERE guild_id = ?').run(GUILD);
archive.prepare("INSERT OR REPLACE INTO messages (message_id, guild_id, channel_id, author_id, author_name, content, created_at, char_count) VALUES ('1400000000000000001', ?, ?, 'u', 'たこ', '統治機能を作った', ?, 8)")
  .run(GUILD, CHANNEL, Date.now() - 3_600_000);
store.recordSegment(GUILD, { channelId: CHANNEL, fromId: '1', toId: '2', fromMs: 0, toMs: 1, messages: 400, chars: 9000 }, { status: 'done', now: Date.now() - 600_000 });
store.setState(`totals:${GUILD}`, { messages: 1000, channels: 1, at: Date.now() });
store.ensureNode(GUILD, 'people/たこ', { summary: 'sakana の作者' });
store.addPending(GUILD, 'people/たこ', ['sakana bot を作っている [e1]']);   // 知識が足されたページだけが記憶として出る
store.writePage(GUILD, 'people/たこ', { body: 'sakana bot を作っている [e1]' });
const episode = store.insertEpisode(GUILD, { title: '統治機能を作った', summary: 'たこが統治機能を作った。', channelId: CHANNEL,
  atMs: Date.now() - 3_600_000, endMs: Date.now() - 3_600_000, sources: ['1400000000000000001'], importance: 2 });
store.linkEpisodeNodes(GUILD, episode, ['people/たこ'], Date.now());
// 費用の台帳に記憶の呼び出しを1件
const reservation = reserveModelCall({ model: 'z-ai/glm-5.3-flash', messages: [{ role: 'user', content: 'x' }], outputTokens: 10, guildId: GUILD, role: 'memory-segment' });
finishModelCall(reservation, { usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0.0033 } });

const interaction = ({ sub, admin = true, options = {} }) => {
  const calls = [];
  return {
    calls,
    guildId: GUILD,
    guild: { members: { fetch: async () => null } },
    user: { id: 'u1', username: 'tako' },
    member: { id: 'u1', permissions: { has: (flag) => admin && flag === PermissionFlagsBits.ManageGuild } },
    options: { getSubcommand: () => sub, getString: (name) => options[name] ?? null },
    reply: async (payload) => { calls.push(['reply', payload]); },
    deferReply: async (payload) => { calls.push(['deferReply', payload]); },
    editReply: async (payload) => { calls.push(['editReply', payload]); }
  };
};
const embedText = (payload) => {
  const embed = payload.embeds?.[0]?.toJSON?.() ?? payload.embeds?.[0];
  return [embed?.description ?? '', ...(embed?.fields ?? []).map((f) => `${f.name}: ${f.value}`)].join('\n');
};

// status は管理者だけ
const outsider = interaction({ sub: 'status', admin: false });
await memoryCommand.execute(outsider);
assert.deepEqual(outsider.calls.map((c) => c[0]), ['reply'], 'non-admins get a refusal without work');

const status = interaction({ sub: 'status' });
await memoryCommand.execute(status);
assert.deepEqual(status.calls.map((c) => c[0]), ['deferReply', 'editReply'], 'status must defer before reading the databases');
const shown = embedText(status.calls[1][1]);
assert.match(shown, /400 \/ 1,000 件 \(40\.0%\)/, 'progress against the counted total');
assert.match(shown, /あと約/, 'an ETA from the last hour');
assert.match(shown, /\$0\.003/, 'memory spending from the ledger');
assert.match(shown, /1 \/ 1 を最新まで読んだ|0 \/ 1 を最新まで読んだ/, 'channel progress');

// pause で builder が止まる
await memoryCommand.execute(interaction({ sub: 'pause' }));
let called = 0;
const stopped = await runBuild({ guildId: GUILD, call: async () => { called += 1; return { json: {} }; } });
assert.equal(stopped.stopped, 'paused', 'a paused builder must stop before calling the model');
assert.equal(called, 0);
const resume = interaction({ sub: 'resume' });
await memoryCommand.execute(resume);
assert.match(resume.calls[1][1], /再開しました/);
assert.equal(store.getState(`pause:${GUILD}`), null);
setPaused(GUILD, null);

// 追加したチャンネル: @everyone が見られないチャンネルとその下のスレッドを控えに入れる
const { readableChannels } = await import('../src/memory/snapshot.js');
const ROLE_GATED = '910000000000000020';
const THREAD = '910000000000000021';
const PRIVATE_THREAD = '910000000000000022';
const guild = { id: GUILD, channels: { cache: new Map([
  [THREAD, { id: THREAD, parentId: ROLE_GATED, isThread: () => true, type: 11 }],
  [PRIVATE_THREAD, { id: PRIVATE_THREAD, parentId: ROLE_GATED, isThread: () => true, type: 12 }]
]) }, roles: {}, members: {} };
const include = interaction({ sub: 'include', options: {} });
include.options.getChannel = () => ({ id: ROLE_GATED });
include.client = { guilds: { cache: new Map() } };
await memoryCommand.execute(include);
assert.match(include.calls[1][1], /記憶に入れます/);
assert.deepEqual(store.includedChannels(GUILD), [ROLE_GATED]);
const readable = readableChannels(guild, { threadsOf: () => ['910000000000000023'] });
assert.ok(readable.includes(ROLE_GATED) && readable.includes(THREAD) && readable.includes('910000000000000023'), 'included channels bring their public threads');
assert.ok(!readable.includes(PRIVATE_THREAD), 'private threads under an included channel stay out');
const excluded = interaction({ sub: 'exclude', options: {} });
excluded.options.getChannel = () => ({ id: ROLE_GATED });
excluded.client = include.client;
await memoryCommand.execute(excluded);
assert.match(excluded.calls[1][1], /外しました/);
assert.deepEqual(store.includedChannels(GUILD), []);

// /memory category: 一覧・昇格・削除 (管理者)
const category = (sub, options) => {
  const it = interaction({ sub, options });
  it.options.getSubcommandGroup = () => 'category';
  return it;
};
store.ensureSeeds(GUILD);
store.ensureNode(GUILD, 'others/レスバ集');
const listed = category('list', {});
await memoryCommand.execute(listed);
assert.match(embedText(listed.calls[1][1]), /others/);
const promote = category('add', { name: 'flamewars', description: 'レスバの記録', from: 'others/レスバ集' });
await memoryCommand.execute(promote);
assert.match(promote.calls[1][1], /flamewars.*1 ページを移しました/);
// 昇格: others/レスバ集 そのものが最上位 flamewars になる (中身は直下へ)
assert.ok(store.getNode(GUILD, 'flamewars') && !store.getNode(GUILD, 'others/レスバ集'), 'add with from must promote the subtree to the new top level');
const drop = category('remove', { name: 'flamewars' });
await memoryCommand.execute(drop);
assert.ok(store.getNode(GUILD, 'others/flamewars'), 'remove must keep the pages under others');
const outsiderCategory = interaction({ sub: 'add', admin: false, options: { name: 'x' } });
outsiderCategory.options.getSubcommandGroup = () => 'category';
await memoryCommand.execute(outsiderCategory);
assert.deepEqual(outsiderCategory.calls.map((c) => c[0]), ['reply'], 'only admins can change categories');

// 誰でも開ける。根拠の発言にリンクが付く
const show = interaction({ sub: 'show', admin: false, options: { path: 'people/たこ' } });
await memoryCommand.execute(show);
assert.match(embedText(show.calls[1][1]), /sakana bot を作っている/);
const ep = interaction({ sub: 'episode', admin: false, options: { id: `e${episode}` } });
await memoryCommand.execute(ep);
assert.match(embedText(ep.calls[1][1]), new RegExp(`\\[1\\]\\(https://discord\\.com/channels/${GUILD}/${CHANNEL}/1400000000000000001\\)`), 'episode sources must link to Discord');
const search = interaction({ sub: 'search', admin: false, options: { query: '統治機能' } });
await memoryCommand.execute(search);
assert.match(embedText(search.calls[1][1]), /統治機能を作った/);

// explore: メニューでたどる。部品は Discord の制限内で組み立てられる
const { handleMemoryComponent } = await import('../src/memory/explore.js');
const explore = interaction({ sub: 'explore', admin: false, options: { path: '' } });
await memoryCommand.execute(explore);
const first = explore.calls[1][1];
const json = (view) => ({ embeds: view.embeds.map((e) => e.toJSON()), components: view.components.map((c) => c.toJSON()) });
const rootJson = json(first);
assert.match(rootJson.embeds[0].title, /記憶の本/);
const menu = rootJson.components.find((row) => row.components[0].type === 3).components[0];
const peopleOption = menu.options.find((option) => /people/.test(option.label));
assert.ok(peopleOption, 'the root menu lists top-level pages');

// 画面の切り替えは「先に受け付け (deferUpdate) → 書き換え (editReply)」の順で来ること (3秒の制限)。
// 新しいメッセージ (共有・自分で開く) はすぐ送る (deferReply → editReply は Discord が 500 で拒否した)
const click = (fields) => {
  const updates = [];
  const modals = [];
  const replies = [];
  let pending = null;
  const user = fields.user ?? { id: 'u1', toString: () => '<@u1>' };
  return { updates, modals, replies, guildId: GUILD, isButton: () => !fields.values && !fields.fields, isStringSelectMenu: () => Boolean(fields.values),
    isModalSubmit: () => Boolean(fields.fields), createdTimestamp: Date.now(),
    update: async () => { throw new Error('acknowledge first (deferUpdate), then editReply'); },
    deferUpdate: async () => { pending = { kind: 'update' }; },
    deferReply: async () => { throw new Error('send new messages at once (deferReply then editReply got 500 from Discord)'); },
    editReply: async (view) => {
      if (!pending) throw new Error('editReply before acknowledging');
      if (pending.kind === 'update') updates.push(view); else replies.push({ ...view, flags: pending.flags });
    },
    reply: async (view) => { if (!fields.allowReply) throw new Error('should update in place'); replies.push(view); },
    followUp: async (view) => { replies.push(view); },
    showModal: async (modal) => { modals.push(modal); }, ...fields, user };
};
// Discord の制限: 部品の ID は1つのメッセージで重複しない・選択肢の値は1つのメニューで重複しない・
// 選択肢は25件まで・ID は100字まで・embed は合計6000字まで
const checkLimits = (view, label) => {
  const all = view.components.flatMap((row) => row.components);
  const ids = all.map((c) => c.custom_id);
  assert.equal(new Set(ids).size, ids.length, `${label}: component ids must be unique within a message: ${ids.join(',')}`);
  for (const id of ids) assert.ok(id.length <= 100, `${label}: custom id too long: ${id}`);
  for (const menu of all.filter((c) => c.type === 3)) {
    const values = menu.options.map((o) => o.value);
    assert.equal(new Set(values).size, values.length, `${label}: select option values must be unique: ${values.join(',')}`);
    assert.ok(values.length >= 1 && values.length <= 25, `${label}: 1-25 options`);
  }
  for (const embed of view.embeds) {
    const size = (embed.title?.length ?? 0) + (embed.description?.length ?? 0) + (embed.author?.name?.length ?? 0)
      + (embed.footer?.text?.length ?? 0) + (embed.fields ?? []).reduce((sum, f) => sum + f.name.length + f.value.length, 0);
    assert.ok(size <= 6000, `${label}: embed is ${size} chars`);
  }
  assert.ok(view.components.length <= 5, `${label}: at most 5 rows`);
};
const buttonsOf = (view) => view.components.flatMap((row) => row.components).filter((c) => c.type === 2);
const people = click({ customId: 'memx:open', values: [peopleOption.value] });
assert.equal(await handleMemoryComponent(people), true);
const peopleJson = json(people.updates[0]);
const takoOption = peopleJson.components.find((row) => row.components[0].type === 3).components[0].options.find((o) => /たこ/.test(o.label));
const tako = click({ customId: 'memx:open', values: [takoOption.value] });
await handleMemoryComponent(tako);
const takoJson = json(tako.updates[0]);
// 1つのメニューの中で値が重複すると Discord が拒否する (親ページで同じ出来事が子ページ経由で重複した)
for (const [label, view] of [['root', rootJson], ['people', peopleJson], ['tako', takoJson]]) checkLimits(view, label);
assert.match(takoJson.embeds[0].description, /sakana bot を作っている/);
// 本文の [[リンク]] は太字の名前に、[e12] は消して読みやすく
assert.doesNotMatch(takoJson.embeds[0].description, /\[\[|\[e\d+\]/, 'links and citations are rendered for people');
assert.match(takoJson.embeds[0].author.name, /記憶の本 › people › たこ/, 'a page shows where it is');
assert.ok(buttonsOf(takoJson).some((b) => b.custom_id === `memx:n:${peopleOption.value.split(':')[1]}`), 'up goes to the parent');
const episodeOption = takoJson.components.flatMap((row) => row.components).filter((c) => c.type === 3)
  .flatMap((c) => c.options).find((o) => o.value.startsWith('e:'));
assert.ok(episodeOption, 'a page lists the episodes it was part of');
const openEpisode = click({ customId: 'memx:open', values: [episodeOption.value] });
await handleMemoryComponent(openEpisode);
const episodeJson = json(openEpisode.updates[0]);
checkLimits(episodeJson, 'episode');
assert.match(episodeJson.embeds[0].description, /discord\.com\/channels/, 'episode view links its sources');
// 開いたページへ戻れる
const takoId = takoOption.value.split(':')[1];
assert.ok(buttonsOf(episodeJson).some((b) => b.custom_id === `memx:n:${takoId}` && /たこ/.test(b.label)), 'the episode leads back to the page it was opened from');

// 年表: 古い順に並び、ページから開ける
const timelineButton = buttonsOf(takoJson).find((b) => b.custom_id.startsWith('memx:t:'));
assert.ok(timelineButton, 'a page with episodes offers a timeline');
const timeline = click({ customId: timelineButton.custom_id });
await handleMemoryComponent(timeline);
const timelineJson = json(timeline.updates[0]);
checkLimits(timelineJson, 'timeline');
assert.match(timelineJson.embeds[0].title, /年表/);
const days = [...timelineJson.embeds[0].description.matchAll(/\*\*(\d{4}-\d{2}-\d{2})\*\*/g)].map((m) => m[1]);
assert.ok(days.length >= 1 && days.every((d, i) => i === 0 || days[i - 1] <= d), 'the timeline runs oldest first: ' + days.join(','));

// 探す: ボタンで入力欄を出し、送られた語で結果を出す
const searchButton = click({ customId: 'memx:s' });
await handleMemoryComponent(searchButton);
assert.equal(searchButton.modals.length, 1, 'search opens a modal');
assert.equal(searchButton.modals[0].toJSON().custom_id, 'memx:q');
const submitted = click({ customId: 'memx:q', fields: { getTextInputValue: (id) => (id === 'query' ? 'たこ' : '') } });
assert.equal(await handleMemoryComponent(submitted), true);
const searchJson = json(submitted.updates[0]);
checkLimits(searchJson, 'search');
assert.match(searchJson.embeds[0].description, /たこ/, 'search finds the page');
const found = searchJson.components.find((row) => row.components[0].type === 3)?.components[0].options.find((o) => o.value === takoOption.value);
assert.ok(found, 'search results can be opened');
const back = click({ customId: 'memx:root' });
await handleMemoryComponent(back);
assert.match(json(back.updates[0]).embeds[0].title, /記憶の本/);
assert.equal(await handleMemoryComponent(click({ customId: 'archive:reset:1' })), false, 'other components pass through');

// 共有: 📢 で今の画面をチャンネルに出す (本人だけではないメッセージ)。出したものは誰でも操作でき、🔎 で自分だけに開ける
const shareId = buttonsOf(takoJson).find((b) => b.custom_id.startsWith('memx:share:'))?.custom_id;
assert.equal(shareId, `memx:share:n:${takoId}:0`, 'a private view offers to share itself');
for (const view of [episodeJson, timelineJson]) assert.ok(buttonsOf(view).some((b) => b.custom_id.startsWith('memx:share:')), 'episodes and timelines can be shared');
const share = click({ customId: shareId, allowReply: true, channel: { nsfw: false }, guild: { channels: { cache: new Map() } } });
await handleMemoryComponent(share);
assert.equal(share.replies.length, 1);
assert.equal(share.replies[0].flags, undefined, 'the shared view is a normal message');
assert.match(share.replies[0].content, /<@u1> が記憶の本を共有/);
assert.deepEqual(share.replies[0].allowedMentions, { parse: [] }, 'sharing does not ping');
const sharedJson = json(share.replies[0]);
checkLimits(sharedJson, 'shared');
assert.match(sharedJson.embeds[0].description, /sakana bot を作っている/);
const mineId = buttonsOf(sharedJson).find((b) => b.custom_id.startsWith('memx:mine:'))?.custom_id;
assert.ok(mineId && !buttonsOf(sharedJson).some((b) => b.custom_id.startsWith('memx:share:')), 'a shared view offers to open it privately instead');
// 共有したメッセージでの操作はそのメッセージを書き換え、共有した人の一行を残す
const sharedMessage = { content: share.replies[0].content, flags: { has: () => false } };
const together = click({ customId: 'memx:root', message: sharedMessage, user: { id: 'u2', toString: () => '<@u2>' } });
await handleMemoryComponent(together);
assert.equal(together.updates[0].content, `${sharedMessage.content} · 最後に操作: <@u2>`, 'navigating a shared view keeps who shared it and shows who moved it');
const again = click({ customId: 'memx:root', message: { ...sharedMessage, content: together.updates[0].content } });
await handleMemoryComponent(again);
assert.equal(again.updates[0].content, `${sharedMessage.content} · 最後に操作: <@u1>`, 'only the latest operator is shown');
assert.deepEqual(again.updates[0].allowedMentions, { parse: [] }, 'naming the operator does not ping');
assert.ok(buttonsOf(json(together.updates[0])).some((b) => b.custom_id.startsWith('memx:mine:')), 'it stays a shared view');
const mine = click({ customId: mineId, allowReply: true, message: sharedMessage });
await handleMemoryComponent(mine);
assert.equal(mine.replies[0].flags, MessageFlags.Ephemeral, 'opening privately is only for the clicker');
assert.ok(buttonsOf(json(mine.replies[0])).some((b) => b.custom_id.startsWith('memx:share:')));
// NSFW チャンネルの出来事は NSFW でないチャンネルに共有しない
const episodeShare = buttonsOf(episodeJson).find((b) => b.custom_id.startsWith('memx:share:')).custom_id;
const episodeChannel = store.getEpisode(GUILD, Number(episodeShare.split(':')[3])).channel_id;
const nsfwShare = click({ customId: episodeShare, allowReply: true, channel: { nsfw: false },
  guild: { channels: { cache: new Map([[episodeChannel, { nsfw: true }]]) } } });
await handleMemoryComponent(nsfwShare);
assert.equal(nsfwShare.replies[0].flags, MessageFlags.Ephemeral);
assert.match(nsfwShare.replies[0].content, /NSFW/);

store.resetTree(GUILD);
archive.prepare('DELETE FROM messages WHERE guild_id = ?').run(GUILD);
console.log('memory command ok (共有は普通のメッセージ・誰でも操作・自分で開く・NSFW の出来事は NSFW でだけ / status は管理者・先に受付・割合と見込みと費用 / pause で止まる / include・exclude / category / explore でたどる・年表・探す / 誰でも開ける・根拠にリンク)');
