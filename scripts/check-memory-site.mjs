// 記憶の本を公開サイトへ送る経路の検証 (npm run check から tsx で呼ぶ)。
//
//   memory.sqlite → buildSnapshot → syncSite → (HTTP の代わりに) サイトの取り込み口 → D1 (代用品)
//
//   - 引用は全員に見えるチャンネルのものだけ: /memory include のチャンネル・NSFW の名前のチャンネル・消された発言は載せない
//     (載せなかった件数だけ送る)
//   - 子孫も含めた出来事の数・つながり・メンション表記の整形
//   - 差分: 1回目は全部、2回目は0件、変えた行だけ送る、bot で消えた行はサイトからも消える
//   - サイトを空にしたら次の回に全部送り直す
//
// ARCHIVE_DB_PATH と MEMORY_DB_PATH を一時ファイルに向けて呼ぶこと。

import assert from 'node:assert/strict';

const { db: archive } = await import('../src/archive/db.js');
const store = await import('../src/memory/store.js');
const { buildSnapshot, chunkByBytes, cleanContent, syncSite } = await import('./memory-site-sync.ts');
const { createD1 } = await import('../worker/test/d1-shim.ts');
const { handleIngest } = await import('../worker/src/wiki/ingest.ts');
const { handleWiki } = await import('../worker/src/wiki/router.ts');

const GUILD = '1255999999999999901';
const OPEN = '910000000000000001';
const TALK = '910000000000000002';
const STAFF = '910000000000000003';   // /memory include した @everyone に見えないチャンネル
const NSFW = '910000000000000004';
const T0 = Date.UTC(2025, 5, 1, 3, 0, 0);

archive.prepare('DELETE FROM messages WHERE guild_id = ?').run(GUILD);
archive.prepare('DELETE FROM channels WHERE guild_id = ?').run(GUILD);
store.resetTree(GUILD);
const channel = archive.prepare('INSERT INTO channels (channel_id, guild_id, name) VALUES (?, ?, ?)');
for (const [id, name] of [[OPEN, '雑談'], [TALK, '開発'], [STAFF, '運営'], [NSFW, 'nsfw']]) channel.run(id, GUILD, name);
let seq = 0n;
const insert = archive.prepare(`INSERT INTO messages (message_id, guild_id, channel_id, author_id, author_name, is_bot, content, created_at,
  attachment_count, attachment_kinds, char_count, deleted) VALUES (?, ?, ?, ?, ?, 0, ?, ?, 0, '', ?, ?)`);
const say = (channelId, author, content, at, deleted = false) => {
  seq += 1n;
  const id = (1360000000000000000n + seq).toString();
  insert.run(id, GUILD, channelId, `u-${author}`, author, content, at, [...content].length, deleted ? 1 : 0);
  return id;
};

store.savePublicChannels(GUILD, [OPEN, TALK, STAFF, NSFW]);
store.includeChannel(GUILD, STAFF, 'admin');

const quote = say(OPEN, 'たこ', 'bot 作るぞ <@123456> <@&777> <#888> <:wave:999>', T0);
const evidence = say(OPEN, 'さば', 'いいね', T0 + 1000);
const staff = say(STAFF, 'ぬし', '運営だけの話', T0 + 2000);
const adult = say(NSFW, 'x', '成人向けの話', T0 + 3000);
const gone = say(OPEN, 'y', '消された発言', T0 + 4000, true);

store.ensureSeeds(GUILD);
store.ensureNode(GUILD, 'people/たこ', { summary: 'bot の作者' });
store.writePage(GUILD, 'people/たこ', { summary: 'bot の作者', body: '## 概要\nbot を作る [e1]', aliases: ['tako'] });
store.ensureNode(GUILD, 'projects/sakana-bot', { summary: 'Discord の bot' });
store.addPending(GUILD, 'projects/sakana-bot', ['メモ [e1]'], { firstAt: T0, lastAt: T0 });
const e1 = store.insertEpisode(GUILD, { kind: '企画', title: 'bot を作り始めた', summary: 'たこが bot を作り始めた', channelId: OPEN, atMs: T0, endMs: T0 + 5000,
  sources: [quote, evidence, staff, adult, gone], highlights: [quote, staff], importance: 3 });
store.linkEpisodeNodes(GUILD, e1, ['people/たこ', 'projects/sakana-bot'], T0);
const e2 = store.insertEpisode(GUILD, { kind: '事件', title: '障害', summary: '落ちた', channelId: TALK, atMs: T0 + 86_400_000, endMs: T0 + 86_401_000, sources: [], highlights: [], importance: 2 });
store.linkEpisodeNodes(GUILD, e2, ['people/たこ'], T0);
store.linkEpisodes(GUILD, e2, [e1]);

// ---- 作る -------------------------------------------------------------------------
const snapshot = buildSnapshot(store.memoryDb(), archive, GUILD);
const byPath = new Map(snapshot.nodes.map((node) => [node.path, node]));
const first = snapshot.episodes.find((episode) => episode.id === e1);
{
  assert.equal(snapshot.episodes.length, 2);
  assert.ok(first);
  const texts = first.quotes.map((entry) => entry.content);
  assert.ok(texts.some((text) => text.startsWith('bot 作るぞ')), 'a public quote is sent');
  assert.ok(texts.includes('いいね'), 'and the evidence line');
  assert.ok(!texts.some((text) => text.includes('運営だけ')), 'a quote from a /memory include channel is NOT sent');
  assert.ok(!texts.some((text) => text.includes('成人向け')), 'a quote from an NSFW channel is NOT sent');
  assert.ok(!texts.some((text) => text.includes('消された')), 'a deleted message is NOT sent');
  assert.equal(first.hiddenQuotes, 2, 'the hidden ones are only counted (staff + nsfw; the deleted one is simply gone)');
  assert.equal(first.quotes.find((entry) => entry.messageId === quote)?.highlight, true);
  assert.equal(first.quotes.find((entry) => entry.messageId === quote)?.content, 'bot 作るぞ @ユーザー @ロール #チャンネル :wave:', 'mentions and emoji ids are made readable');
  assert.equal(first.channelName, '雑談');
  assert.deepEqual(first.nodes.sort(), ['people/たこ', 'projects/sakana-bot']);
  assert.deepEqual(snapshot.episodes.find((episode) => episode.id === e2)?.before, [e1]);

  assert.equal(byPath.get('people/たこ')?.episodeCount, 2, 'counts episodes of the page');
  assert.equal(byPath.get('people')?.episodeCount, 2, 'a category counts the episodes of its descendants, once each');
  assert.equal(byPath.get('')?.episodeCount, 2, 'the root counts all of them');
  assert.equal(byPath.get('people')?.childCount, 1);
  assert.deepEqual(byPath.get('people/たこ')?.aliases, ['tako']);
  assert.equal(byPath.get('projects/sakana-bot')?.pendingCount, 1);
  assert.equal(byPath.get('people/たこ')?.name, 'たこ');
  assert.equal(byPath.get('people/たこ')?.depth, 2);
  assert.ok(byPath.get('people/たこ')?.links.some((link) => link.dst === 'projects/sakana-bot'), 'pages that share an episode are linked');

  const again = buildSnapshot(store.memoryDb(), archive, GUILD);
  assert.deepEqual(again.nodes.map((node) => node.contentHash), snapshot.nodes.map((node) => node.contentHash), 'hashes are stable');
  assert.equal(cleanContent('x'.repeat(500)).length, 400);
  assert.deepEqual(chunkByBytes([1, 2, 3, 4, 5], 3, 10), [[1, 2, 3], [4, 5]], 'chunks by size');
  assert.deepEqual(chunkByBytes(['a', 'b', 'c'], 1000, 2), [['a', 'b'], ['c']], 'and by count');
}

// ---- 送る -------------------------------------------------------------------------
const TOKEN = 'site-token';
const d1 = createD1();
const env = { LAWS: d1, GOVERNANCE_LAW_API_TOKEN: TOKEN, MEMORY_GUILD_ID: GUILD, MEMORY_ACCESS: 'public' };
const requests = [];
const fetchImpl = async (input, init) => {
  const url = new URL(String(input));
  requests.push(`${init?.method ?? 'GET'} ${url.pathname}`);
  return handleIngest(new Request(url, init), env, T0);
};
const options = { url: 'https://site.test', token: TOKEN, guildId: GUILD, fetchImpl };
{
  const sent = await syncSite(snapshot, options);
  assert.deepEqual(sent.nodes, { sent: snapshot.nodes.length, unchanged: 0, removed: 0 });
  assert.deepEqual(sent.episodes, { sent: 2, unchanged: 0, removed: 0 });
  assert.ok(requests.includes('POST /v1/memory/finish'));
  assert.equal(d1.raw.prepare('SELECT COUNT(*) n FROM memory_nodes').get().n, snapshot.nodes.length);
  assert.equal(d1.raw.prepare('SELECT COUNT(*) n FROM memory_quotes').get().n, 2, 'only the two public quotes reached the site');
  assert.equal(d1.raw.prepare("SELECT COUNT(*) n FROM memory_quotes WHERE content LIKE '%運営だけ%' OR content LIKE '%成人向け%'").get().n, 0);
  assert.equal(d1.raw.prepare('SELECT hidden_quotes h FROM memory_episodes WHERE id = ?').get(e1).h, 2);

  // 何も変えなければ送らない
  requests.length = 0;
  const idle = await syncSite(snapshot, options);
  assert.deepEqual([idle.nodes.sent, idle.episodes.sent, idle.nodes.removed], [0, 0, 0]);
  assert.deepEqual(requests, ['GET /v1/memory/hashes'], 'an unchanged book costs one request');

  // 1ページ書き換える → そのページ (と数が変わる親) だけ送る
  store.writePage(GUILD, 'people/たこ', { summary: 'bot の作者 (更新)', body: '## 概要\nbot を作る [e1] [e2]', aliases: ['tako'] });
  const changed = buildSnapshot(store.memoryDb(), archive, GUILD);
  requests.length = 0;
  const partial = await syncSite(changed, options);
  assert.equal(partial.nodes.sent, 1, 'only the edited page is sent');
  assert.equal(partial.episodes.sent, 0);
  assert.equal(d1.raw.prepare("SELECT summary FROM memory_nodes WHERE path = 'people/たこ'").get().summary, 'bot の作者 (更新)');

  // bot で消えたページはサイトからも消える
  store.memoryDb().prepare("DELETE FROM nodes WHERE guild_id = ? AND path = 'projects/sakana-bot'").run(GUILD);
  store.memoryDb().prepare("DELETE FROM episodes WHERE guild_id = ? AND id = ?").run(GUILD, e2);
  const removed = buildSnapshot(store.memoryDb(), archive, GUILD);
  const pruned = await syncSite(removed, options);
  assert.equal(pruned.nodes.removed, 1);
  assert.equal(pruned.episodes.removed, 1);
  assert.equal(d1.raw.prepare("SELECT COUNT(*) n FROM memory_nodes WHERE path = 'projects/sakana-bot'").get().n, 0);
  assert.equal(d1.raw.prepare('SELECT COUNT(*) n FROM memory_episodes WHERE id = ?').get(e2).n, 0);
  assert.equal(d1.raw.prepare('SELECT COUNT(*) n FROM memory_episode_nodes WHERE episode_id = ?').get(e2).n, 0, 'and so are its joins');

  // サイトを空にしても次の回に全部戻る
  d1.raw.exec('DELETE FROM memory_nodes; DELETE FROM memory_episodes; DELETE FROM memory_quotes; DELETE FROM memory_episode_nodes; DELETE FROM memory_links; DELETE FROM memory_episode_links');
  const refill = await syncSite(removed, options);
  assert.equal(refill.nodes.sent, removed.nodes.length);
  assert.equal(refill.episodes.sent, removed.episodes.length);

  // 大きなデータは束に分けて送る
  requests.length = 0;
  d1.raw.exec('DELETE FROM memory_nodes; DELETE FROM memory_episodes');
  const split = await syncSite(removed, { ...options, batchBytes: 300 });
  assert.ok(requests.filter((request) => request === 'POST /v1/memory/batch').length >= 3, 'a small batch size splits the upload');
  assert.equal(d1.raw.prepare('SELECT COUNT(*) n FROM memory_nodes').get().n, removed.nodes.length);

  // 間違ったトークンは送れない
  await assert.rejects(syncSite(removed, { ...options, token: 'wrong' }), /HTTP 401/);
}

// ---- サイトに出る ----------------------------------------------------------------------
{
  const page = await handleWiki(new Request('https://wiki.test/e/' + e1), env);
  const text = await page.text();
  assert.match(text, /bot 作るぞ @ユーザー/, 'the public quote shows');
  assert.ok(!text.includes('運営だけ') && !text.includes('成人向け'), 'the gated quotes never reach a page');
  assert.match(text, /見られるチャンネルが限られている発言 2 件/);
}

store.resetTree(GUILD);
archive.prepare('DELETE FROM messages WHERE guild_id = ?').run(GUILD);
archive.prepare('DELETE FROM channels WHERE guild_id = ?').run(GUILD);
console.log('memory site ok (引用は全員に見えるチャンネルだけ / 子孫の出来事数 / 差分だけ送る / 消えた行を消す / 空にしても戻る / 束に分ける)');
