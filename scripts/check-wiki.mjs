// 記憶 (wiki) の検証 (npm run check から tsx で呼ぶ)。
//
//   - 描画は escape 済みの部品だけで組まれる: 本文・名前・発言に <script> や onerror= を書いても文字として出る
//   - bot からの取り込み: Bearer が要る / 変な本文は 400 / 同じ内容を何度送っても同じ / 消した行は prune で消える
//   - 全文検索 (trigram) と 3 文字未満の LIKE
//   - 公開: ログインも cookie も無しで誰でも読める / 以前のログインリンクはトップへ転送 / 見せていないサーバーは 404
//   - 画面: トップ・記事 (出典の番号・赤リンク・目次)・年表・出来事・検索・存在しないページ
//
// D1 は better-sqlite3 の代用品 (worker/test/d1-shim.ts)。同じ SQLite なので SQL はそのまま通る。

import assert from 'node:assert/strict';

const { createD1 } = await import('../worker/test/d1-shim.ts');
const { html, esc, raw } = await import('../worker/src/wiki/html.ts');
const { renderMarkdown, scanReferences, highlightSnippet, plainText } = await import('../worker/src/wiki/markdown.ts');
const { handleIngest, parseNode, parseEpisode } = await import('../worker/src/wiki/ingest.ts');
const { handleWiki } = await import('../worker/src/wiki/router.ts');
const store = await import('../worker/src/wiki/store.ts');

// ---- html: 値は必ず escape される --------------------------------------------------
{
  const evil = '<script>alert(1)</script>"\'&';
  assert.equal(html`<p>${evil}</p>`.value, '<p>&lt;script&gt;alert(1)&lt;/script&gt;&quot;&#39;&amp;</p>');
  assert.equal(html`<ul>${['<b>', html`<i>ok</i>`]}</ul>`.value, '<ul>&lt;b&gt;<i>ok</i></ul>', 'arrays escape strings but keep SafeHtml');
  assert.equal(html`${raw('<hr>')}${null}${undefined}${false}`.value, '<hr>');
  assert.equal(esc(`a"b`), 'a&quot;b');
}

// ---- markdown: 未信頼の本文を HTML にしても、タグにならない ---------------------------------
{
  const known = new Map([['people/たこ', { path: 'people/たこ', name: 'たこ' }]]);
  const context = { resolvePath: (path) => known.get(path) ?? null, citeNumber: (id) => ({ 12: 1, 34: 2 })[id] ?? null };
  const source = [
    '## 概要 <script>alert(1)</script>',
    '**<img src=x onerror=alert(1)>** と [[people/たこ]] と [[people/ない]] と [[people/たこ|たこさん]]。[e12][e34][e999]',
    '',
    '- 箇条書き1 [text](javascript:alert(1)) <b>x</b>',
    '  - 入れ子 [リンク](https://example.com/a?b=1&c=2)',
    '- https://example.com/very/long/path/that/keeps/going/and/going/forever/more',
    '1. 番号つき',
    '',
    '> 引用 `code <b>`',
    '```',
    '<script>block</script>',
    '```'
  ].join('\n');
  const { html: out, headings } = renderMarkdown(source, context);
  const tags = [...out.value.matchAll(/<([a-z0-9]+)([^>]*)>/gi)];
  assert.ok(tags.every(([, name]) => ['h2', 'h3', 'h4', 'a', 'p', 'br', 'ul', 'ol', 'li', 'strong', 'code', 'blockquote', 'pre', 'sup', 'hr'].includes(name.toLowerCase())), `only known tags: ${tags.map((tag) => tag[1])}`);
  assert.ok(tags.every(([, , attributes]) => !/\son[a-z]+\s*=/i.test(attributes)), 'no event-handler attributes');
  assert.ok(!/href="javascript:/i.test(out.value), 'a javascript: URL is never a link');
  assert.match(out.value, /\[text\]\(javascript:alert\(1\)\)/, 'and is shown as plain text');
  assert.match(out.value, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/, 'tags are shown as text');
  assert.match(out.value, /<a class="wl" href="\/wiki\/people\/%E3%81%9F%E3%81%93">たこ<\/a>/, 'a known page links by its path');
  assert.match(out.value, /<a class="wl missing" href="\/wiki\/people\/%E3%81%AA%E3%81%84"[^>]*>ない<\/a>/, 'an unknown page is a red link');
  assert.match(out.value, />たこさん<\/a>/, '[[path|label]] shows the label');
  assert.match(out.value, /<sup class="cite"><a href="#ref-1" id="cite-1">\[1\]<\/a><\/sup><sup class="cite"><a href="#ref-2" id="cite-2">\[2\]<\/a><\/sup>/, 'citations are numbered');
  assert.ok(!out.value.includes('[e999]') && !out.value.includes('e999'), 'a citation to a missing episode is dropped');
  assert.match(out.value, /href="https:\/\/example\.com\/a\?b=1&amp;c=2" rel="noopener noreferrer nofollow" target="_blank"/, 'external links are noopener and escaped');
  assert.match(out.value, /<ul><li>箇条書き1[\s\S]*<ul><li>入れ子/, 'nested lists');
  assert.match(out.value, /<ol><li>番号つき<\/li><\/ol>/);
  assert.match(out.value, /<h2 id="h-1">/, 'headings start at h2 and get ids');
  assert.deepEqual(headings.map((heading) => [heading.id, heading.level]), [['h-1', 2]]);
  assert.match(out.value, /…<\/a>/, 'long bare URLs are shortened');
  assert.deepEqual(scanReferences(source).paths.sort(), ['people/たこ', 'people/ない']);
  assert.deepEqual(scanReferences(source).episodes, [12, 34, 999]);
  assert.equal(plainText('**太字** [[people/たこ|たこ]] [e1] 本文'), '太字 たこ 本文');
  assert.equal(highlightSnippet('a\u0002<b>\u0003c').value, 'a<mark>&lt;b&gt;</mark>c', 'snippet markers become <mark>, the rest is escaped');
}

// ---- 取り込み ---------------------------------------------------------------------
const GUILD = '1255359848644608035';
const P = `/${GUILD}`;   // サーバーごとの URL の接頭辞
const TOKEN = 'secret-token';
const db = createD1();
const env = { LAWS: db, GOVERNANCE_LAW_API_TOKEN: TOKEN, MEMORY_GUILD_IDS: GUILD };
const NOW = Date.UTC(2026, 9, 16, 12, 0, 0);
const at = (y, m, d) => Date.UTC(y, m - 1, d, 3, 0, 0);

const node = (id, path, overrides = {}) => ({
  id, path, parent: path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : path === '' ? null : '', name: path.split('/').at(-1) ?? '', depth: path ? path.split('/').length : 0,
  summary: '', body: '', pending: '', pendingCount: 0, aliases: [], weight: 1, firstAt: null, lastAt: null, updatedAt: NOW, childCount: 0, episodeCount: 0,
  links: [], contentHash: `h-${id}-${path}`, ...overrides
});
const episode = (id, overrides = {}) => ({
  id, kind: '雑談', title: `出来事${id}`, summary: `要約${id}`, channelId: '10', channelName: '雑談', atMs: at(2025, 6, 1) + id * 60_000, endMs: at(2025, 6, 1) + id * 60_000 + 1000,
  importance: 2, sourceCount: 3, hiddenQuotes: 0, nodes: [], before: [], quotes: [], contentHash: `e-${id}`, ...overrides
});

const nodes = [
  node(1, '', { name: '', summary: '', body: '- 開発と雑談のサーバー。[[people/たこ]] が [[projects/sakana-bot]] を作っている', childCount: 3, depth: 0 }),
  node(2, 'people', { summary: '人物のページ', childCount: 2, episodeCount: 5, weight: 9 }),
  node(3, 'projects', { summary: '作っているもの', childCount: 1, episodeCount: 2, weight: 5 }),
  node(4, 'topics', { summary: '話題', childCount: 0, weight: 2 }),
  node(5, 'people/たこ', {
    summary: 'sakana bot の作者', aliases: ['tako', '<b>たこ</b>'], episodeCount: 4, weight: 7, firstAt: at(2025, 6, 1), lastAt: at(2026, 3, 1), childCount: 1,
    body: '## 概要\nたこは [[projects/sakana-bot]] を作っている [e1]。\n\n## 立場と意見\n- Rust 推し [e2][e3]\n- <script>alert(1)</script> [[people/ゆうれい]]',
    pending: '- 新しい知識のメモ [e4]', pendingCount: 1,
    links: [{ dst: 'projects/sakana-bot', weight: 5 }, { dst: 'people/さば', weight: 2 }]
  }),
  node(6, 'people/さば', { summary: '<b>裁判所</b>を作った人', body: 'さばは裁判所を実装した [e3]', episodeCount: 2, links: [{ dst: 'people/たこ', weight: 2 }] }),
  node(7, 'projects/sakana-bot', { summary: 'Discord の bot', body: 'たこが作る bot [e1]', episodeCount: 2, weight: 5 }),
  node(8, 'people/たこ/技術', { summary: 'たこの技術の話', pending: '- 言語の好み [e2]', pendingCount: 1, episodeCount: 1 })
];
const episodes = [
  episode(1, { kind: '企画', title: 'sakana bot を作り始めた', summary: 'たこが bot を作り始めた。', nodes: ['people/たこ', 'projects/sakana-bot'], atMs: at(2025, 6, 1),
    quotes: [{ messageId: '900', channelId: '10', authorName: 'たこ<i>', content: 'bot 作るぞ <script>alert(1)</script>', createdAt: at(2025, 6, 1), highlight: true },
      { messageId: '901', channelId: '10', authorName: 'さば', content: 'いいね', createdAt: at(2025, 6, 1) + 5000, highlight: false }], hiddenQuotes: 2 }),
  episode(2, { kind: 'レスバ', title: 'Rust と Go のレスバ', summary: 'Rust 派と Go 派が言い合った。', nodes: ['people/たこ', 'people/たこ/技術'], atMs: at(2025, 7, 10), importance: 3 }),
  episode(3, { kind: '技術', title: '裁判所を実装', summary: 'さばが裁判所を実装した。', nodes: ['people/さば', 'people/たこ'], before: [1], atMs: at(2025, 8, 3) }),
  episode(4, { kind: '事件', title: '障害が起きた', summary: 'サーバーが落ちた。', nodes: ['people/たこ'], before: [3], atMs: at(2025, 8, 20) }),
  episode(5, { kind: 'ネタ', title: 'たこ焼きの日', summary: 'たこ焼きネタ。', nodes: ['people/さば'], atMs: at(2026, 1, 5) })
];

const post = (path, body, token = TOKEN) => handleIngest(new Request(`https://x.test${path}`, {
  method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body)
}), env, NOW);

{
  assert.equal((await post('/v1/memory/batch', { guildId: GUILD, nodes: [], episodes: [] }, 'wrong')).status, 401, 'a wrong token is refused');
  assert.equal((await handleIngest(new Request('https://x.test/v1/memory/hashes?guild=1'), env, NOW)).status, 401, 'no token is refused');
  for (const bad of [{ guildId: 'abc' }, { guildId: GUILD, nodes: [{ id: 'x' }] }, { guildId: GUILD, nodes: 'no' }, { guildId: GUILD, episodes: [{ id: 1, title: '' }] },
    { guildId: GUILD, nodes: [{ ...nodes[0], summary: 'x'.repeat(700) }] }]) {
    assert.equal((await post('/v1/memory/batch', bad)).status, 400, `must refuse ${JSON.stringify(bad).slice(0, 60)}`);
  }
  assert.throws(() => parseNode({ ...nodes[0], body: 5 }), /body/);
  assert.throws(() => parseEpisode({ ...episodes[0], quotes: [{ messageId: 1 }] }), /messageId/);
  // 想定外の項目は捨てて作り直す
  assert.equal('evil' in parseNode({ ...nodes[0], evil: '<script>' }), false);

  const response = await post('/v1/memory/batch', { guildId: GUILD, nodes, episodes });
  assert.equal(response.status, 200, await response.clone().text());
  assert.deepEqual(await response.json(), { ok: true, nodes: nodes.length, episodes: episodes.length });
  assert.equal((await post('/v1/memory/finish', { guildId: GUILD })).status, 200);

  const again = await post('/v1/memory/batch', { guildId: GUILD, nodes, episodes });
  assert.equal(again.status, 200);
  assert.equal(db.raw.prepare('SELECT COUNT(*) n FROM memory_nodes').get().n, nodes.length, 'sending the same rows twice does not duplicate');
  assert.equal(db.raw.prepare('SELECT COUNT(*) n FROM memory_quotes').get().n, 2);
  assert.equal(db.raw.prepare('SELECT COUNT(*) n FROM memory_episode_nodes').get().n, 8);

  const hashes = await (await handleIngest(new Request(`https://x.test/v1/memory/hashes?guild=${GUILD}`, { headers: { authorization: `Bearer ${TOKEN}` } }), env, NOW)).json();
  assert.equal(hashes.nodes['5'], 'h-5-people/たこ');
  assert.equal(hashes.episodes['3'], 'e-3');

  // 同じパスを別の id が持つようになった (ページの移動・統合) → 古い方が消え、検索の索引も追従する
  await post('/v1/memory/batch', { guildId: GUILD, nodes: [node(9, 'people/さば', { summary: '別 id のさば', contentHash: 'h9' })] });
  assert.equal(db.raw.prepare("SELECT COUNT(*) n FROM memory_nodes WHERE path = 'people/さば'").get().n, 1);
  assert.equal(db.raw.prepare("SELECT id FROM memory_nodes WHERE path = 'people/さば'").get().id, 9);
  await post('/v1/memory/batch', { guildId: GUILD, nodes: [node(6, 'people/さば2', { summary: '<b>裁判所</b>を作った人', body: 'さばは裁判所を実装した [e3]', contentHash: 'h6b' }),
    node(9, 'people/さば', { summary: 'さば本人', contentHash: 'h9b' })] });
  // 削除 (bot で消えたページ・出来事)
  await post('/v1/memory/prune', { guildId: GUILD, nodeIds: [6], episodeIds: [5] });
  await post('/v1/memory/finish', { guildId: GUILD });
  assert.equal(db.raw.prepare('SELECT COUNT(*) n FROM memory_nodes WHERE id = 6').get().n, 0);
  assert.equal(db.raw.prepare('SELECT COUNT(*) n FROM memory_episodes WHERE id = 5').get().n, 0);
  assert.equal(db.raw.prepare("SELECT COUNT(*) n FROM memory_links WHERE dst = 'people/さば2' OR src = 'people/さば2'").get().n, 0, 'links to removed pages are cleaned');
  await post('/v1/memory/batch', { guildId: GUILD, nodes: [node(6, 'people/さば', { summary: '<b>裁判所</b>を作った人', body: 'さばは裁判所を実装した [e3]', episodeCount: 2, contentHash: 'h6c', links: [{ dst: 'people/たこ', weight: 2 }] })] });
  await post('/v1/memory/prune', { guildId: GUILD, nodeIds: [9], episodeIds: [] });
}

// ---- 検索 -------------------------------------------------------------------------
{
  assert.deepEqual((await store.searchNodes(db, GUILD, 'sakana')).map((hit) => hit.path).sort(), ['people/たこ', 'projects/sakana-bot'].sort(), '3+ chars use the trigram index');
  assert.ok((await store.searchNodes(db, GUILD, '裁判所')).some((hit) => hit.path === 'people/さば'), 'Japanese text is searchable');
  assert.ok((await store.searchNodes(db, GUILD, 'たこ')).some((hit) => hit.path === 'people/たこ'), 'short (2 char) terms fall back to LIKE');
  assert.equal((await store.searchNodes(db, GUILD, '%')).length, 0, 'LIKE wildcards are escaped');
  assert.equal((await store.searchNodes(db, GUILD, '"; DROP TABLE memory_nodes; --')).length, 0, 'a hostile query is just text');
  assert.ok(db.raw.prepare('SELECT COUNT(*) n FROM memory_nodes').get().n > 0);
  assert.ok((await store.searchEpisodes(db, GUILD, 'レスバ')).some((hit) => hit.id === 2), 'episodes are found by their kind');
  assert.ok((await store.searchEpisodes(db, GUILD, 'bot')).length >= 1);
  assert.deepEqual(store.searchTerms('a  bb ccc dddd'), { long: ['ccc', 'dddd'], short: ['a', 'bb'] });
}

// ---- 公開 (ログインは無い) -----------------------------------------------------------
const deps = { now: () => NOW };
{
  const get = (path, init = {}, e = env) => handleWiki(new Request(`https://wiki.test${path}`, init), e, deps);

  // 何も持たない訪問者が、全部の画面を読める (cookie も鍵も要らない)
  for (const path of [`${P}/wiki`, `${P}/wiki/people/%E3%81%9F%E3%81%93`, `${P}/e/1`, `${P}/s?q=tako`, `${P}/t`, `${P}/t/2025-06`]) {
    const response = await get(path);
    assert.equal(response.status, 200, `a visitor reads ${path}`);
    assert.equal(response.headers.get('set-cookie'), null, 'and gets no cookie');
    const text = await response.text();
    assert.ok(!/ログイン|ログアウト|\/auth\//.test(text), `${path} has no login or logout`);
  }
  assert.equal((await get(`${P}/random`)).status, 302);
  // 公開でも検索エンジンには載せない (人物ページがあるため)
  assert.match(await (await get(`${P}/wiki`)).text(), /<meta name="robots" content="noindex, nofollow">/);
  assert.match((await get(`${P}/wiki`)).headers.get('cache-control'), /public/);

  // 以前のログインリンク・ログアウトは、記憶のトップへ送る (Discord に残っているリンクが行き止まりにならない)
  for (const path of ['/auth/link?t=old.token&next=%2Fx', '/auth/login?g=' + GUILD, '/auth/callback?code=x', `${P}/auth/logout`]) {
    const response = await get(path);
    assert.equal(response.status, 302, `${path} goes to the book`);
    assert.equal(response.headers.get('location'), `${P}/wiki`);
  }
  assert.equal((await get('/auth/link?t=x', {}, { ...env, MEMORY_GUILD_IDS: `${GUILD} 1517186886714789910` })).status, 404, 'with two servers an old link cannot pick one');

  assert.equal((await get(`${P}/wiki`, {}, { ...env, MEMORY_GUILD_IDS: '', MEMORY_GUILD_ID: '', DEFAULT_GUILD_ID: '' })).status, 404, 'no server configured: nothing is served');
  assert.equal(await handleWiki(new Request('https://wiki.test/law/1'), env, deps), null, 'law pages are not handled here');
  assert.equal(await handleWiki(new Request('https://wiki.test/'), env, deps), null);
  assert.equal((await get(`${P}/wiki`, { method: 'POST' })).status, 405);
  assert.equal(await get(`${P}/t/abc`), null, 'an unknown /t/ path is not a wiki page');

  // ---- 画面 ----
  const page = async (path, e = env) => {
    const response = await handleWiki(new Request(`https://wiki.test${path}`), e, deps);
    assert.ok(response, `${path} is handled`);
    return { response, text: await response.text() };
  };
  const noLive = (text, label) => {
    const stripped = text.replace(/<style>[\s\S]*?<\/style>/, '');
    assert.ok(!/<script[\s>]/i.test(stripped), `${label}: no <script> element`);
    assert.ok(!/ on[a-z]+=/i.test(stripped.replace(/&[a-z#0-9]+;/g, '')), `${label}: no event handlers`);
    assert.ok(!stripped.includes('<img src=x'), `${label}: no injected img`);
  };

  const home = await page(`${P}/wiki`);
  assert.equal(home.response.status, 200);
  assert.match(home.text, /<title>記憶<\/title>/);
  assert.match(home.text, /開発と雑談のサーバー/, 'the root page is the overview');
  assert.match(home.text, /href="\/1255359848644608035\/wiki\/people"/, 'categories');
  assert.match(home.text, /href="\/1255359848644608035\/e\/\d+"/, 'recent episodes');
  assert.match(home.text, /href="\/\?guild=1255359848644608035">法令集/, 'the law site is one click away');
  assert.match(home.response.headers.get('content-security-policy'), /default-src 'none'/);
  assert.equal(home.response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(home.response.headers.get('x-frame-options'), 'DENY');
  noLive(home.text, 'home');

  const article = await page(`${P}/wiki/people/%E3%81%9F%E3%81%93`);
  assert.equal(article.response.status, 200);
  assert.match(article.text, /<h1>たこ<\/h1>/);
  assert.match(article.text, /sakana bot の作者/);
  assert.match(article.text, /<sup class="cite"><a href="\/1255359848644608035\/e\/1" title="2025-06-01 sakana bot を作り始めた" id="cite-1">\[1\]<\/a><\/sup>/, 'a citation links straight to its episode');
  assert.match(article.text, /id="ref-1"[\s\S]*sakana bot を作り始めた/, 'the sources list shows the cited episode');
  assert.ok(!article.text.includes('class="refbox"'), 'a short list of sources is not folded');
  assert.match(article.text, /class="wl missing"[^>]*>ゆうれい<\/a>/, 'a link to a page that does not exist is red');
  assert.match(article.text, /href="\/1255359848644608035\/wiki\/projects\/sakana-bot"/);
  assert.match(article.text, /&lt;b&gt;たこ&lt;\/b&gt;/, 'aliases are escaped');
  assert.match(article.text, /<nav class="card toc"/, 'a table of contents appears for pages with headings');
  assert.match(article.text, /📝 まだ本文に入っていない知識のメモ \(1 件\)/, 'the unmerged notes are tucked away');
  assert.match(article.text, /class="tree"[\s\S]*class="here"/, 'the sidebar tree opens to the current page');
  assert.match(article.text, /子ページ/);
  noLive(article.text, 'article');

  const timeline = await page(`${P}/wiki/people/%E3%81%9F%E3%81%93?tab=timeline`);
  assert.match(timeline.text, /aria-current="page">年表/);
  assert.match(timeline.text, /Rust と Go のレスバ/);
  assert.ok(timeline.text.indexOf('障害が起きた') < timeline.text.indexOf('sakana bot を作り始めた'), 'newest first');
  const oldFirst = await page(`${P}/wiki/people/%E3%81%9F%E3%81%93?tab=timeline&order=old`);
  assert.ok(oldFirst.text.indexOf('sakana bot を作り始めた') < oldFirst.text.indexOf('障害が起きた'), 'oldest first');
  const filtered = await page(`${P}/wiki/people/%E3%81%9F%E3%81%93?tab=timeline&kind=${encodeURIComponent('レスバ')}`);
  assert.match(filtered.text, /Rust と Go のレスバ/);
  assert.ok(!filtered.text.includes('障害が起きた'), 'filter by kind');
  const links = await page(`${P}/wiki/people/%E3%81%9F%E3%81%93?tab=links`);
  assert.match(links.text, /sakana-bot|Discord の bot/);

  const category = await page(`${P}/wiki/people`);
  assert.match(category.text, /class="pcard" href="\/1255359848644608035\/wiki\/people\/%E3%81%9F%E3%81%93"/, 'a category lists its children as cards');
  assert.match(category.text, /&lt;b&gt;裁判所&lt;\/b&gt;を作った人/, 'summaries are escaped');
  const bare = await page(`${P}/wiki/people/%E3%81%9F%E3%81%93/%E6%8A%80%E8%A1%93`);
  assert.match(bare.text, /まだ本文にまとめられていません/, 'a page with only notes says so and shows them');

  const ep = await page(`${P}/e/1`);
  assert.equal(ep.response.status, 200);
  assert.match(ep.text, /<h1>sakana bot を作り始めた<\/h1>/);
  assert.match(ep.text, /class="kind k-event"/, 'kind pill');
  assert.match(ep.text, /<blockquote class="quote"><p>bot 作るぞ &lt;script&gt;alert\(1\)&lt;\/script&gt;<\/p>/, 'quotes are escaped');
  assert.match(ep.text, /href="https:\/\/discord\.com\/channels\/1255359848644608035\/10\/900" rel="noopener noreferrer"/, 'a quote links back to Discord');
  assert.match(ep.text, /根拠の発言[\s\S]*いいね/);
  assert.match(ep.text, /🔒 見られるチャンネルが限られている発言 2 件/, 'hidden quotes are counted, not shown');
  assert.match(ep.text, /href="\/1255359848644608035\/wiki\/people\/%E3%81%9F%E3%81%93">たこ<\/a>/);
  noLive(ep.text, 'episode');
  const ep3 = await page(`${P}/e/3`);
  assert.match(ep3.text, /前の出来事[\s\S]*sakana bot を作り始めた/, 'the plot: what came before');
  assert.match(ep3.text, /続き[\s\S]*障害が起きた/, 'the plot: what followed');
  assert.equal((await page(`${P}/e/99999`)).response.status, 404);

  const index = await page(`${P}/t`);
  assert.match(index.text, /href="\/1255359848644608035\/t\/2025-06"/);
  assert.match(index.text, /class="m empty"/, 'months without episodes are inert');
  const month = await page(`${P}/t/2025-06`);
  assert.match(month.text, /2025年6月/);
  assert.match(month.text, /sakana bot を作り始めた/);
  assert.match(month.text, /href="\/1255359848644608035\/t\/2025-07"/, 'next month');
  assert.equal((await page(`${P}/t/2025-13`)).response.status, 404);
  assert.equal(await handleWiki(new Request(`https://wiki.test${P}/t/abc`), env, deps), null, 'an unknown /t/ path is not a wiki page');

  const found = await page(`${P}/s?q=${encodeURIComponent('裁判所')}`);
  assert.match(found.text, /「裁判所」の検索結果/);
  assert.match(found.text, /<mark>裁判所<\/mark>/, 'the matched part is highlighted');
  assert.match(found.text, /裁判所を実装/, 'episodes too');
  const xss = await page(`${P}/s?q=${encodeURIComponent('<script>alert(1)</script>')}`);
  assert.ok(!xss.text.includes('<script>alert(1)</script>'), 'the query is escaped where it is echoed');
  assert.match(xss.text, /value="&lt;script&gt;alert\(1\)&lt;\/script&gt;"/);
  noLive(xss.text, 'search');
  assert.match((await page(`${P}/s?q=`)).text, /検索する言葉を入れてください/);

  const random = await handleWiki(new Request(`https://wiki.test${P}/random`), env, deps);
  assert.equal(random.status, 302);
  assert.match(random.headers.get('location'), /^\/1255359848644608035\/wiki\//);

  const missing = await page(`${P}/wiki/people/%E3%81%AA%E3%81%84`);
  assert.equal(missing.response.status, 404);
  assert.match(missing.text, /まだこのページはありません/);
  assert.match(missing.text, /href="\/1255359848644608035\/s\?q=%E3%81%AA%E3%81%84"/, 'offers to search for it');
  const guess = await handleWiki(new Request(`https://wiki.test${P}/wiki/%E3%81%A9%E3%81%93/nothing-like-this`), env, deps);
  assert.equal(guess.status, 404, 'an unknown name with no match is a 404');
  const byAlias = await handleWiki(new Request(`https://wiki.test${P}/wiki/misc/tako`), env, deps);
  assert.equal(byAlias.status, 302, 'an alias also finds the page');
  const alias = await handleWiki(new Request(`https://wiki.test${P}/wiki/misc/%E3%81%9F%E3%81%93`), env, deps);
  assert.equal(alias.status, 302, 'a wrong path with a unique name match redirects to the real page');
  assert.equal(alias.headers.get('location'), `${P}/wiki/people/%E3%81%9F%E3%81%93`);
}

// ---- サーバーごとの分離 ---------------------------------------------------------------
// 別のサーバーを足しても、データ・URL・リンク・検索・取り込みのどれも混ざらない。同じ id・同じパスで別の内容を入れて確かめる。
{
  const OTHER = '1517186886714789910';
  const Q = `/${OTHER}`;
  const both = { ...env, MEMORY_GUILD_IDS: `${GUILD} ${OTHER}` };
  const postTo = (e, path, body, token = TOKEN) => handleIngest(new Request(`https://x.test${path}`, {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) }), e, NOW);

  // 見せていないサーバーのデータは受け取らない
  assert.equal((await postTo(env, '/v1/memory/batch', { guildId: OTHER, nodes: [node(5, 'people/たこ')] })).status, 400, 'ingest refuses a server the site does not serve');
  assert.equal((await handleIngest(new Request(`https://x.test/v1/memory/hashes?guild=${OTHER}`, { headers: { authorization: `Bearer ${TOKEN}` } }), env, NOW)).status, 400);
  assert.equal(db.raw.prepare('SELECT COUNT(*) n FROM memory_nodes WHERE guild_id = ?').get(OTHER).n, 0, 'and nothing was written');

  // 同じ id・同じパス・同じ出来事番号で、別の内容を入れる
  const otherNodes = [
    node(1, '', { body: 'OTHER のトップです', childCount: 1 }),
    node(2, 'people', { summary: 'OTHER の人物', childCount: 1, episodeCount: 1, weight: 9 }),
    node(5, 'people/たこ', { summary: 'OTHER だけのたこ', body: 'OTHER のたこは別人です [e1]', episodeCount: 1, weight: 7 })
  ];
  const otherEpisodes = [episode(1, { kind: '近況', title: 'OTHER の出来事', summary: 'OTHER でだけ起きた', channelId: '20', channelName: 'other-chat', nodes: ['people/たこ'],
    atMs: at(2026, 2, 2), quotes: [{ messageId: '700', channelId: '20', authorName: 'ほかの人', content: 'OTHER だけの発言', createdAt: at(2026, 2, 2), highlight: true }] })];
  assert.equal((await postTo(both, '/v1/memory/batch', { guildId: OTHER, nodes: otherNodes, episodes: otherEpisodes })).status, 200);
  await postTo(both, '/v1/memory/finish', { guildId: OTHER });
  assert.equal(db.raw.prepare('SELECT COUNT(*) n FROM memory_nodes WHERE id = 5').get().n, 2, 'both servers hold a page with the same id');

  const fetchPage = async (path, e = both) => {
    const response = await handleWiki(new Request(`https://wiki.test${path}`), e, deps);
    return { status: response.status, text: await response.text(), headers: response.headers };
  };

  // それぞれ自分のデータだけが出る
  const mine = await fetchPage(`${P}/wiki/people/%E3%81%9F%E3%81%93`);
  const theirs = await fetchPage(`${Q}/wiki/people/%E3%81%9F%E3%81%93`);
  assert.match(mine.text, /sakana bot の作者/);
  assert.ok(!mine.text.includes('OTHER') && !mine.text.includes(OTHER), 'one server\'s page shows nothing of the other');
  assert.match(theirs.text, /OTHER だけのたこ/);
  assert.ok(!theirs.text.includes('sakana bot の作者') && !theirs.text.includes(GUILD), 'and the other way round');
  assert.match((await fetchPage(`${Q}/e/1`)).text, /OTHER の出来事[\s\S]*OTHER だけの発言/, 'the same episode number is a different episode');
  assert.match((await fetchPage(`${P}/e/1`)).text, /sakana bot を作り始めた/);
  assert.ok(!(await fetchPage(`${P}/e/1`)).text.includes('OTHER'));
  const searchMine = (await fetchPage(`${P}/s?q=${encodeURIComponent('たこ')}`)).text;
  const searchTheirs = (await fetchPage(`${Q}/s?q=${encodeURIComponent('たこ')}`)).text;
  assert.ok(!searchMine.includes('OTHER'), 'search does not cross servers');
  assert.ok(searchTheirs.includes('OTHER') && !searchTheirs.includes('sakana bot'), 'search stays inside the server');
  const homeTheirs = (await fetchPage(`${Q}/wiki`)).text;
  assert.match(homeTheirs, /OTHER のトップです/);
  assert.ok(homeTheirs.includes(`href="${Q}/t"`) && !homeTheirs.includes(`href="${P}/`), 'every link stays inside the server');
  assert.ok(!(await fetchPage(`${P}/t`)).text.includes(`href="${Q}/`));
  const rand = await handleWiki(new Request(`https://wiki.test${Q}/random`), both, deps);
  assert.match(rand.headers.get('location'), new RegExp(`^${Q}/wiki/`), 'random stays inside the server');

  // 載せていないサーバーの URL は、何も見せずに 404
  for (const path of ['/777777777/wiki', '/777777777/e/1', '/777777777/s?q=a']) {
    const response = await fetchPage(path);
    assert.equal(response.status, 404, `${path} is not served`);
    assert.ok(!response.text.includes('sakana') && !response.text.includes('OTHER'), 'and shows nothing from any server');
    // どの番号でも同じ答え (そのサーバーがあるかどうかも教えない)
    assert.equal(response.text, (await fetchPage('/888888888/wiki')).text, 'every unserved server answers alike');
  }
  // 旧い URL (サーバーなし): 1つだけ見せているときは転送、複数なら 404 (どのサーバーか決められない)
  const legacy = await handleWiki(new Request('https://wiki.test/wiki/people?tab=timeline'), env, deps);
  assert.equal(legacy.status, 302);
  assert.equal(legacy.headers.get('location'), `${P}/wiki/people?tab=timeline`);
  assert.equal((await handleWiki(new Request('https://wiki.test/wiki'), both, deps)).status, 404, 'with two servers an unprefixed URL is ambiguous');
  assert.equal((await handleWiki(new Request(`https://wiki.test${Q}`), both, deps)).headers.get('location'), `${Q}/wiki`, 'the server root goes to its wiki');

  // 取り込み・削除も混ざらない: 片方の同じ id を消しても、もう片方は残る
  await postTo(both, '/v1/memory/prune', { guildId: OTHER, nodeIds: [5], episodeIds: [1] });
  assert.equal(db.raw.prepare('SELECT COUNT(*) n FROM memory_nodes WHERE id = 5 AND guild_id = ?').get(GUILD).n, 1, 'pruning one server leaves the other\'s rows');
  assert.equal(db.raw.prepare('SELECT COUNT(*) n FROM memory_episodes WHERE id = 1 AND guild_id = ?').get(GUILD).n, 1);
  assert.equal(db.raw.prepare('SELECT COUNT(*) n FROM memory_quotes WHERE guild_id = ?').get(OTHER).n, 0, 'and the removed episode\'s quotes go with it');
  assert.ok(db.raw.prepare('SELECT COUNT(*) n FROM memory_quotes WHERE guild_id = ?').get(GUILD).n >= 1);
  const hashesOther = await (await handleIngest(new Request(`https://x.test/v1/memory/hashes?guild=${OTHER}`, { headers: { authorization: `Bearer ${TOKEN}` } }), both, NOW)).json();
  assert.deepEqual(Object.keys(hashesOther.nodes).sort(), ['1', '2'], 'the hash list is per server');
}

// ---- 日付の扱い (日本時間) ---------------------------------------------------------------
{
  assert.equal(store.jstDate(Date.UTC(2025, 5, 30, 15, 30)), '2025-07-01', '15:30 UTC is already July 1 in Japan');
  assert.deepEqual(store.monthRange('2025-07'), { start: Date.UTC(2025, 5, 30, 15), end: Date.UTC(2025, 6, 31, 15) });
  assert.equal(store.monthRange('2025-00'), null);
  assert.equal(store.monthRange('x'), null);
}

console.log('wiki ok (escape / 取り込みと差分と prune / 検索 / 公開 (ログイン無し) / 全画面 / サーバーごとの分離: データ・URL・リンク・検索・取り込み)');
