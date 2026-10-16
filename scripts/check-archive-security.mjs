// archive の検索と返事の安全装置 (scripts/check-guild-isolation.mjs から別プロセスで呼ぶ)。
//
//   R1 正規表現: (a+)+ のような形は組み立ての時点で断る。すり抜けた重い形 (.*a.*b を
//      長い発言に掛ける) もワーカーの時間切れで必ず戻り、bot 全体を止めない
//   R2 メンション: 利用者の入力を返す返事も含め、archive の返事は誰も呼ばない
//   R3 公開範囲: 公開の返事に載るのは、そのチャンネルの全員が見られる発言だけ。
//      非公開の場所・削除済みの発言が混ざる結果は本人にだけ見せる
//
// 一時ディレクトリの DB だけを使う。
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChannelType, MessageFlags, PermissionFlagsBits } from 'discord.js';

const directory = mkdtempSync(join(tmpdir(), 'sakana-archive-security-'));
process.env.ARCHIVE_DB_PATH = join(directory, 'archive.sqlite');
process.env.DATABASE_PATH = join(directory, 'main.sqlite');
process.env.MEMORY_DB_PATH = join(directory, 'memory.sqlite');
process.env.ARCHIVE_REGEX_TIMEOUT_MS = '1000';
process.env.OPENROUTER_API_KEY ??= 'check';

const { db, markMessageDeleted, saveMessage, setGuildState, upsertChannel } = await import('../src/archive/db.js');
const { toRecord } = await import('../src/archive/indexer.js');
const { QueryError } = await import('../src/archive/query.js');
const { buildSearch, countSearchVisibility, search, searchSummary } = await import('../src/archive/search.js');
const { archiveCommands, handleArchiveComponent } = await import('../src/archive/commands.js');

const failures = [];
async function check(name, run) {
  try { await run(); console.log(`PASS ${name}`); }
  catch (error) { failures.push(name); console.error(`FAIL ${name}: ${error.stack ?? error.message}`); }
}

let nextId = 100000000000000100n;
const snowflake = () => String(nextId++);
const store = (guildId, channelId, content, extra = {}) => {
  const id = snowflake();
  saveMessage(toRecord({ id, guildId, channelId, content, author: { id: 'author-1', username: 'author' },
    createdTimestamp: 1_700_000_000_000 + Number(nextId % 100000n) * 1000, attachments: new Map(), ...extra }));
  return id;
};
const elapsed = (run) => {
  const started = performance.now();
  let error = null;
  try { run(); } catch (caught) { error = caught; }
  return { ms: performance.now() - started, error };
};

try {
  // ------------------------------------------------------------------ R1
  const RX = 'regex-guild-1';
  const RX_SLOW = 'regex-guild-2';
  const long = store(RX, 'rx-channel', 'a'.repeat(4000));
  const prose = store(RX, 'rx-channel', `${'x'.repeat(10)} ${'長い本文'.repeat(60)}`);
  const linked = store(RX, 'rx-channel', `${'y'.repeat(240)} https://example.com/`);
  const ab = store(RX, 'rx-channel', 'b');
  store(RX_SLOW, 'rx-slow', 'a'.repeat(4000));

  await check('R1 nested quantifiers are refused before any row is scanned', () => {
    for (const pattern of ['regex:/(a+)+$/', 'regex:/(\\w*\\s?)*x/', 're:"/(?:ab+){2,}/"', 'regex:/((a|b)+)*/']) {
      const { ms, error } = elapsed(() => buildSearch({ guildId: RX, query: pattern }));
      assert.ok(error instanceof QueryError, `${pattern} must be refused, got ${error}`);
      assert.match(error.message, /入れ子/);
      assert.ok(ms < 100, `${pattern} refusal took ${ms}ms`);
    }
    const tooLong = elapsed(() => buildSearch({ guildId: RX, query: `regex:/${'a'.repeat(400)}/` }));
    assert.ok(tooLong.error instanceof QueryError && /長すぎ/.test(tooLong.error.message), 'over-long patterns are refused');
  });

  await check('R1 the audit example ((a+)+$ against a long aaaa...b) returns a refusal immediately', () => {
    const victim = store(RX_SLOW, 'rx-slow', `${'a'.repeat(3000)}b`);
    assert.ok(victim);
    const { ms, error } = elapsed(() => search({ guildId: RX_SLOW, query: 'regex:/(a+)+$/' }));
    assert.ok(error instanceof QueryError, String(error));
    assert.ok(ms < 100, `refusal took ${ms}ms`);
  });

  await check('R1 existing regex features still parse and match (lookahead, alternation, backreference)', () => {
    const ids = (query) => search({ guildId: RX, query }, { limit: 50 }).rows.map((row) => row.message_id);
    const lookahead = ids('regex:/^(?!.*http).{200,}/');
    assert.ok(lookahead.includes(prose) && lookahead.includes(long), 'long text without http must match');
    assert.ok(!lookahead.includes(linked), 'text with http must not match the negative lookahead');
    const alternation = ids('regex:/(a|b)/');
    assert.ok(alternation.includes(ab) && alternation.includes(long));
    assert.ok(ids('regex:/(.)\\1{5,}/').includes(long), 'backreferences keep working');
    assert.ok(searchSummary({ guildId: RX, query: 'regex:/(a|b)/' }).count >= 2, 'summaries run through the guard too');
    assert.equal(countSearchVisibility({ guildId: RX, query: 'regex:/^b$/' }, ['rx-channel']).total, 1);
  });

  await check('R1 a heavy pattern that passes the static check is cut off by the worker timeout', async () => {
    const { ms, error } = elapsed(() => search({ guildId: RX_SLOW, query: 'regex:/.*a.*c/' }));
    assert.ok(error instanceof QueryError, `expected a QueryError, got ${error}`);
    assert.match(error.message, /打ち切り/);
    // 1回あたり 1000ms (ARCHIVE_REGEX_TIMEOUT_MS) で必ず戻る。ワーカーの起動ぶんの余裕を見る
    assert.ok(ms < 2500, `the event loop was blocked for ${ms}ms`);
    console.log(`  (.*a.*c over 4000 chars returned after ${Math.round(ms)}ms)`);
    // 止めたワーカーが裏で回り続けていない (回っていれば待つ間ずっと CPU を1本使う)
    await new Promise((resolve) => setTimeout(resolve, 100));
    const cpu = process.cpuUsage();
    await new Promise((resolve) => setTimeout(resolve, 400));
    const used = process.cpuUsage(cpu);
    assert.ok((used.user + used.system) / 1000 < 200, `a terminated worker is still burning CPU: ${JSON.stringify(used)}`);
    const again = elapsed(() => search({ guildId: RX_SLOW, query: 'regex:/a/' }));
    assert.ok(again.error instanceof QueryError && /待って/.test(again.error.message), 'a guild that timed out is refused for a while');
    assert.ok(again.ms < 100, `the follow-up refusal took ${again.ms}ms`);
    // 別のサーバーは巻き込まない
    assert.ok(search({ guildId: RX, query: 'regex:/^b$/' }).rows.length === 1);
  });

  await check('R1 the main connection never evaluates regexp() itself', () => {
    assert.throws(() => db.prepare("SELECT regexp('/a/', 'a') AS hit").get(), /regex worker/);
  });

  // ------------------------------------------------------------------ R2 / R3
  const GUILD = '900000000000000001';
  const PUB = '900000000000000010';
  const PRIV = '900000000000000020';
  const everyone = { id: GUILD };
  const bot = { id: 'bot-user' };
  const flagsOf = (...flags) => ({ has: (flag) => flags.includes(flag) });
  const member = (id, ...flags) => ({ id, permissions: flagsOf(...flags) });
  const reader = member('reader-user');
  const moderator = member('moderator-user', PermissionFlagsBits.ManageMessages);
  const readable = { [PUB]: [everyone.id, bot.id, reader.id, moderator.id], [PRIV]: [bot.id, reader.id, moderator.id] };
  const channel = (id, name) => ({ id, name, type: ChannelType.GuildText, isTextBased: () => true,
    permissionsFor: (who) => ({ has: () => (readable[id] ?? []).includes(who.id) }) });
  const guild = { id: GUILD, roles: { everyone }, members: { me: bot, fetch: async () => reader },
    channels: { cache: new Map([[PUB, channel(PUB, 'general')], [PRIV, channel(PRIV, 'mods-only')]]) } };
  for (const id of [PUB, PRIV]) {
    upsertChannel({ channel_id: id, guild_id: GUILD, parent_id: null, name: id === PUB ? 'general' : 'mods-only',
      type: ChannelType.GuildText, is_thread: 0, is_private: 0 });
  }
  setGuildState(GUILD, { status: 'idle' });

  const shared = store(GUILD, PUB, 'ALPHAWORD shared note');
  const hidden = store(GUILD, PRIV, 'ALPHAWORD hidden note');
  const gone = store(GUILD, PUB, 'BETAWORD removed note');
  markMessageDeleted(gone);
  db.prepare('INSERT INTO message_reactions (message_id, emoji, count) VALUES (?, ?, ?)').run(hidden, 'PRIVEMOJI', 9);
  db.prepare('INSERT INTO message_reactions (message_id, emoji, count) VALUES (?, ?, ?)').run(shared, 'PUBEMOJI', 2);
  db.prepare('INSERT INTO message_links (message_id, url, domain) VALUES (?, ?, ?)').run(hidden, 'https://secret.example/x', 'secret.example');
  db.prepare('INSERT INTO message_links (message_id, url, domain) VALUES (?, ?, ?)').run(shared, 'https://public.example/x', 'public.example');

  const allCalls = [];
  const recorder = (calls) => (kind) => async (payload) => { calls.push([kind, payload]); allCalls.push([kind, payload]); };
  const command = (name, { as = reader, in: channelId = PUB, options = {} } = {}) => {
    const calls = [];
    const record = recorder(calls);
    const interaction = {
      id: snowflake(), guildId: GUILD, guild, channelId, user: { id: as.id }, member: as,
      options: {
        getString: (key) => options[key] ?? null,
        getInteger: (key) => options[key] ?? null,
        getBoolean: () => null, getUser: () => null, getChannel: () => null,
        getSubcommand: () => options.subcommand
      },
      reply: record('reply'), deferReply: record('deferReply'), editReply: record('editReply'), followUp: record('followUp')
    };
    const target = archiveCommands.find((entry) => entry.data.name === name);
    return { calls, interaction, run: () => target.execute(interaction) };
  };
  const button = (customId, { as = reader, in: channelId = PUB, ephemeral = false } = {}) => {
    const calls = [];
    const record = recorder(calls);
    const interaction = {
      isButton: () => true, customId, guildId: GUILD, guild, channelId, user: { id: as.id }, member: as,
      message: { flags: { has: (flag) => ephemeral && flag === MessageFlags.Ephemeral } },
      reply: record('reply'), update: record('update')
    };
    return { calls, run: () => handleArchiveComponent(interaction) };
  };
  const json = (payload) => JSON.stringify({ ...payload, embeds: payload?.embeds?.map((embed) => embed.toJSON?.() ?? embed),
    components: payload?.components?.map((row) => row.toJSON?.() ?? row) });
  const ephemeral = (payload) => (Number(payload?.flags ?? 0) & MessageFlags.Ephemeral) !== 0;
  const visible = (calls) => calls.filter(([kind, payload]) => kind !== 'deferReply' && !ephemeral(payload));
  const publicText = (calls) => visible(calls).map(([, payload]) => json(payload)).join('\n');

  await check('R2 errors that echo the query do not ping @everyone or roles', async () => {
    const run = command('search', { options: { query: 'ALPHAWORD', after: '@everyone <@&900000000000000099>' } });
    await run.run();
    const [, reply] = run.calls.find(([kind]) => kind === 'editReply');
    assert.match(reply.content, /@everyone/, 'the error message still shows what was typed');
    assert.deepEqual(reply.allowedMentions, { parse: [] });
  });

  // 結果の本文は検索語が太字になるので、発言は ID (跳ぶリンクに入る) で見分ける
  const has = (text, id) => text.includes(id);

  await check('R3 /search with a private-channel hit answers only the invoker', async () => {
    const run = command('search', { options: { query: 'ALPHAWORD' } });
    await run.run();
    const text = publicText(run.calls);
    assert.ok(!has(text, hidden) && !has(text, shared) && !/hidden/.test(text), 'no result may be posted publicly');
    assert.match(text, /実行した人にだけ/, 'the public reply says why');
    const [, privately] = run.calls.find(([kind]) => kind === 'followUp');
    assert.ok(ephemeral(privately), 'results go to an ephemeral follow-up');
    assert.ok(has(json(privately), hidden) && has(json(privately), shared));
  });

  await check('R3 /search whose hits are all in this public channel stays public', async () => {
    const run = command('search', { options: { query: 'shared' } });
    await run.run();
    assert.ok(has(publicText(run.calls), shared));
    assert.ok(!run.calls.some(([kind]) => kind === 'followUp'), 'nothing needs to be hidden');
  });

  await check('R3 results from the current channel itself may be public there', async () => {
    // 非公開チャンネルの中で実行すれば、その場の全員がそのチャンネルを見られるので公開でよい
    const inside = command('search', { in: PRIV, options: { query: 'hidden' } });
    await inside.run();
    assert.ok(has(publicText(inside.calls), hidden));
  });

  await check('R3 deleted messages shown to moderators are never public', async () => {
    const run = command('search', { as: moderator, options: { query: 'is:deleted BETAWORD' } });
    await run.run();
    assert.ok(!has(publicText(run.calls), gone) && !/removed/.test(publicText(run.calls)));
    const [, privately] = run.calls.find(([kind]) => kind === 'followUp');
    assert.ok(ephemeral(privately) && has(json(privately), gone));
  });

  await check('R3 /context of a private-channel message answers only the invoker', async () => {
    const run = command('context', { options: { message: hidden } });
    await run.run();
    assert.ok(!/hidden note/.test(publicText(run.calls)) && !has(publicText(run.calls), hidden));
    assert.ok(run.calls.some(([kind, payload]) => kind === 'followUp' && ephemeral(payload) && /hidden note/.test(json(payload))));
    const open = command('context', { options: { message: shared } });
    await open.run();
    assert.match(publicText(open.calls), /shared note/, 'a public-channel context stays public');
  });

  await check('R3 the random-result button posts publicly only shareable rows', async () => {
    const secret = command('search', { options: { query: 'hidden' } });
    await secret.run();
    const shuffle = button(`archive:shuffle:${secret.interaction.id}`, { ephemeral: true });
    await shuffle.run();
    assert.ok(!has(publicText(shuffle.calls), hidden));
    assert.ok(shuffle.calls.some(([, payload]) => ephemeral(payload) && has(json(payload), hidden)));

    const open = command('search', { options: { query: 'shared' } });
    await open.run();
    const openShuffle = button(`archive:shuffle:${open.interaction.id}`);
    await openShuffle.run();
    assert.ok(has(publicText(openShuffle.calls), shared));
  });

  await check('R3 paging a public result re-checks the page before editing it', async () => {
    const open = command('search', { options: { query: 'PAGEWORD' } });
    const first = store(GUILD, PUB, 'PAGEWORD first');
    await open.run();
    assert.ok(has(publicText(open.calls), first));
    const later = store(GUILD, PRIV, 'PAGEWORD later secret');
    const page = button(`archive:page:${open.interaction.id}:0`);
    await page.run();
    assert.ok(!page.calls.some(([kind]) => kind === 'update'), 'the public message must not be edited to show a private row');
    assert.ok(!has(publicText(page.calls), later));
    assert.ok(page.calls.some(([, payload]) => ephemeral(payload) && has(json(payload), later)), 'the page goes to the invoker only');
    const privatePage = button(`archive:page:${open.interaction.id}:0`, { ephemeral: true });
    await privatePage.run();
    assert.ok(privatePage.calls.some(([kind]) => kind === 'update'), 'an ephemeral result page can be edited in place');
  });

  await check('R3 /archivestats counts only what everyone in the channel can see', async () => {
    const run = command('archivestats');
    await run.run();
    const text = publicText(run.calls);
    assert.match(text, /PUBEMOJI/);
    assert.match(text, /public\.example/);
    assert.doesNotMatch(text, /PRIVEMOJI|secret\.example/);
  });

  await check('reset button re-checks the permission when pressed', async () => {
    const before = db.prepare('SELECT COUNT(*) AS c FROM messages WHERE guild_id = ?').get(GUILD).c;
    const press = button(`archive:reset:${reader.id}`);
    await press.run();
    assert.ok(press.calls.some(([kind, payload]) => kind === 'reply' && ephemeral(payload)), 'a member without the permission is refused');
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM messages WHERE guild_id = ?').get(GUILD).c, before, 'nothing was purged');
  });

  await check('R2 every archive reply in these flows disables mentions', () => {
    const sent = allCalls.filter(([kind]) => kind !== 'deferReply');
    assert.ok(sent.length > 10);
    for (const [kind, payload] of sent) {
      assert.deepEqual(payload?.allowedMentions, { parse: [] }, `${kind} without allowedMentions: ${json(payload).slice(0, 200)}`);
    }
  });

  assert.deepEqual(failures, [], 'archive security regressions');
  console.log('check-archive-security: ok');
} finally {
  db.close();
  rmSync(directory, { recursive: true, force: true });
}
