import {
  authConfigured, currentSession, defaultAuthDeps, finishLink, finishLogin, isPublicAccess, linkConfigured, loginAvailable, loginRedirect, logoutResponse,
  memoryGuilds, type AuthDeps
} from './auth.ts';
import type { SafeHtml } from './html.ts';
import { handleIngest } from './ingest.ts';
import { layout } from './layout.ts';
import { GUILD_ID, makeLinks, type Links } from './links.ts';
import { scanReferences } from './markdown.ts';
import * as store from './store.ts';
import type { Env, NodeRow, Session } from './types.ts';
import {
  articleView, episodeView, homeView, loginView, messageView, monthView, referencesOf, searchView, timelineIndexView, treeNav,
  type ArticleData, type Page, type TimelineData
} from './views.ts';

// 記憶の本の URL と、gate (入場) と、画面ごとの読み出し。サーバーごとに URL を分ける:
//   /<サーバーID>/wiki           トップ            /<サーバーID>/wiki/<path>   記事 (?tab=timeline|links&kind=&order=&page=&cp=)
//   /<サーバーID>/e/<id>         出来事            /<サーバーID>/t, /t/YYYY-MM 年表
//   /<サーバーID>/s?q=           検索              /<サーバーID>/random        ランダムなページ
//   /<サーバーID>/auth/logout    ログアウト
//   /auth/link  /auth/login  /auth/callback   入場 (サーバーはリンクの署名・state の中にある)
//   /v1/memory/*                 bot からの取り込み (Bearer。サーバーは本文の guildId)
// URL のサーバーが MEMORY_GUILD_IDS に無ければ、中身を何も見せずに 404。cookie もサーバーごと。
// 法令集 ('/', '/law/…', '/v1/laws') はここでは扱わない (null を返して既存の処理へ)。
// サーバーの付かない旧い URL (/wiki …) は、見せているサーバーが1つのときだけそこへ転送する。

export interface Deps {
  auth: AuthDeps;
  now(): number;
}

export const defaultDeps: Deps = { auth: defaultAuthDeps, now: () => Date.now() };

const SECURITY_HEADERS: Record<string, string> = {
  'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; img-src https://cdn.discordapp.com data:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'same-origin',
  'x-frame-options': 'DENY',
  'cache-control': 'private, no-store'
};

interface Context {
  user: Session | null;
  links?: Links;
  query?: string;
}

function respond(page: Page, ctx: Context): Response {
  const body: SafeHtml = layout({
    title: page.title, description: page.description, main: page.main, rail: page.rail, nav: page.nav, narrow: page.narrow,
    user: ctx.user, query: ctx.query, links: ctx.links
  });
  return new Response(body.value, { status: page.status ?? 200, headers: { 'content-type': 'text/html; charset=utf-8', ...SECURITY_HEADERS } });
}

const redirect = (location: string): Response => new Response(null, { status: 302, headers: { location, 'cache-control': 'no-store' } });

/** 見せていないサーバーの URL。サーバーがあるかどうかも、中身も出さない。 */
const notFound = (): Response => respond(messageView('見つかりません', 'そのページはありません。', { status: 404 }), { user: null });

const positive = (value: string | null, fallback = 1): number => {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= 100_000 ? parsed : fallback;
};

function decodePath(segments: string): string | null {
  try {
    return segments.split('/').map(decodeURIComponent).filter((part) => part !== '').join('/');
  } catch {
    return null;
  }
}

export async function handleWiki(request: Request, env: Env, deps: Deps = defaultDeps): Promise<Response | null> {
  const url = new URL(request.url);
  const path = url.pathname;
  const guilds = memoryGuilds(env);

  if (path.startsWith('/v1/memory/')) return handleIngest(request, env, deps.now());

  // ---- サーバーの付かない入口 ----
  if (path === '/auth/link') {
    const result = await finishLink(request, env, deps.now());
    if (result.ok) return result.response;
    return respond(messageView('入れませんでした', result.reason, { status: result.status }), { user: null });
  }
  if (path === '/auth/login' || path === '/auth/callback') {
    if (!authConfigured(env)) return respond(messageView('ログインの設定がありません', 'このサイトでは Discord ログインは使えません。Discord で /memory url を使うと、ログインリンクが出ます。', { status: 503 }), { user: null });
    if (path === '/auth/login') {
      const guild = url.searchParams.get('g') ?? '';
      return guilds.includes(guild) ? loginRedirect(request, env, guild, deps.auth) : notFound();
    }
    const result = await finishLogin(request, env, deps.auth);
    if (result.ok) return result.response;
    return respond(messageView('ログインできませんでした', result.reason, { status: result.status }), { user: null });
  }

  // 旧い URL (サーバーなし): 見せているサーバーが1つだけなら、そこへ
  if (/^\/(?:wiki|e|t|s|random)(?:\/.*)?$/.test(path)) {
    const only = guilds.length === 1 ? guilds[0] : null;
    return only ? redirect(`/${only}${path}${url.search}`) : notFound();
  }

  // ---- /<サーバーID>/… ----
  const match = /^\/(\d{5,25})(\/.*)?$/.exec(path);
  if (!match?.[1] || !GUILD_ID.test(match[1])) return null;
  const guild = match[1];
  const rest = match[2] ?? '';
  if (!guilds.includes(guild)) return notFound();
  const links = makeLinks(guild);
  if (rest === '' || rest === '/') return redirect(links.home);
  if (rest === '/auth/logout') return logoutResponse(request, guild);

  const isWiki = rest === '/wiki' || rest.startsWith('/wiki/') || rest.startsWith('/e/') || rest === '/t' || rest.startsWith('/t/') || rest === '/s' || rest === '/random';
  if (!isWiki) return null;
  if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('method not allowed', { status: 405, headers: { allow: 'GET, HEAD' } });

  // gate: 公開 (MEMORY_ACCESS=public) でなければ、このサーバーのメンバーとして入った人だけ
  let user: Session | null = null;
  if (!isPublicAccess(env)) {
    if (!loginAvailable(env)) {
      return respond(messageView('まだ公開されていません', '記憶の本は、ログインの設定が済むまで閉じています。', { status: 503 }), { user: null, links });
    }
    user = await currentSession(request, env, guild, deps.now());
    if (!user) return respond(loginView(`${url.pathname}${url.search}`, { oauth: authConfigured(env), link: linkConfigured(env) }, links), { user: null, links });
  }
  const ctx: Context = { user, links };
  const db = env.LAWS;

  const nav = async (current: string): Promise<SafeHtml> => {
    const tops = await store.topLevels(db, guild);
    // いまのページの祖先と自分の子を開いておく (根の直下だけの木にならないように)
    const parts = current ? current.split('/') : [];
    const open = parts.map((_, index) => parts.slice(0, index + 1).join('/'));
    const lists = await Promise.all(open.map((entry) => store.childrenOf(db, guild, entry, 40)));
    return treeNav(tops, new Map(open.map((entry, index) => [entry, lists[index] ?? []])), current, links);
  };

  try {
    if (rest === '/random') {
      const target = await store.randomPath(db, guild);
      return redirect(target ? links.wiki(target) : links.home);
    }

    if (rest === '/s') {
      const query = (url.searchParams.get('q') ?? '').trim().slice(0, 100);
      const [nodes, episodes, navigation] = await Promise.all([store.searchNodes(db, guild, query), store.searchEpisodes(db, guild, query), nav('')]);
      return respond(searchView(query, nodes, episodes, navigation, links), { ...ctx, query });
    }

    if (rest === '/t') {
      const [months, navigation] = await Promise.all([store.monthCounts(db, guild), nav('')]);
      return respond(timelineIndexView(months, navigation, links), ctx);
    }

    const month = /^\/t\/(\d{4}-\d{2})\/?$/.exec(rest);
    if (month?.[1]) {
      const key = month[1];
      if (!store.monthRange(key)) return respond(messageView('見つかりません', 'その月は指定できません。', { status: 404, link: { href: links.timeline, label: '年表へ' } }), ctx);
      const kind = (url.searchParams.get('kind') ?? '').slice(0, 40);
      const perPage = 100;
      const monthPage = positive(url.searchParams.get('page'));
      const [result, kinds, months, navigation] = await Promise.all([
        store.episodesInMonth(db, guild, key, { kind, limit: perPage, offset: (monthPage - 1) * perPage }), store.monthKinds(db, guild, key), store.monthCounts(db, guild), nav('')
      ]);
      const keys = months.map((entry) => entry.month);
      const index = keys.indexOf(key);
      return respond(monthView({
        month: key, rows: result.rows, total: result.total, page: monthPage, perPage, kind, kinds,
        prev: index > 0 ? keys[index - 1] ?? null : index === -1 ? keys.filter((entry) => entry < key).at(-1) ?? null : null,
        next: index >= 0 ? keys[index + 1] ?? null : keys.find((entry) => entry > key) ?? null,
        nav: navigation, links
      }), ctx);
    }

    const episodePath = /^\/e\/(\d{1,12})\/?$/.exec(rest);
    if (episodePath?.[1]) {
      const id = Number(episodePath[1]);
      const ep = await store.getEpisode(db, guild, id);
      const navigation = await nav('');
      if (!ep) return respond(messageView('見つかりません', `出来事 ${id} は記憶の本にありません。`, { status: 404, nav: navigation, link: { href: links.home, label: 'トップへ' } }), ctx);
      const [quotes, nodes, neighbors] = await Promise.all([store.quotesOf(db, guild, id), store.episodeNodes(db, guild, id), store.episodeNeighbors(db, guild, id)]);
      return respond(episodeView({ guildId: guild, ep, quotes, nodes, before: neighbors.before, after: neighbors.after, nav: navigation, links }), ctx);
    }

    if (rest === '/wiki' || rest === '/wiki/') {
      const [root, stats, tops, recent, popular, updated, months] = await Promise.all([
        store.getNode(db, guild, ''), store.siteStats(db, guild), store.topLevels(db, guild), store.recentEpisodes(db, guild, 8),
        store.popularNodes(db, guild, 8), store.recentNodes(db, guild, 6), store.monthCounts(db, guild)
      ]);
      const referenced = root?.body ? scanReferences(root.body).paths : [];
      const known = new Map((await store.nodesByPaths(db, guild, referenced)).map((node) => [node.path, node]));
      return respond(homeView({ root, stats, tops, recent, popular, updated, months, nodeNames: known, links }), ctx);
    }

    const wiki = /^\/wiki\/(.+)$/.exec(rest);
    if (wiki?.[1]) {
      const nodePath = decodePath(wiki[1]);
      if (!nodePath) return respond(messageView('見つかりません', 'ページの指定が正しくありません。', { status: 400 }), ctx);
      const node = await store.getNode(db, guild, nodePath);
      if (!node) {
        const guess = await store.guessNode(db, guild, nodePath);
        if (guess) return redirect(links.wiki(guess.path));
        const name = nodePath.split('/').at(-1) ?? nodePath;
        return respond(messageView('まだこのページはありません', `「${nodePath}」は記憶の本にありません。名前が違うか、まだ作られていないページです。`, {
          status: 404, nav: await nav(''), link: { href: `${links.search}?q=${encodeURIComponent(name)}`, label: `「${name}」を検索` }
        }), ctx);
      }
      return respond(await articlePage(db, guild, node, url, nav, links), ctx);
    }
  } catch (error) {
    console.error('wiki failed:', error);
    return respond(messageView('表示できませんでした', 'データを読み出せませんでした。少し待ってからもう一度お試しください。', { status: 500 }), ctx);
  }
  return null;
}

async function articlePage(database: D1Database, guildId: string, node: NodeRow, requestUrl: URL, nav: (current: string) => Promise<SafeHtml>, links: Links): Promise<Page> {
  const tabParam = requestUrl.searchParams.get('tab');
  const tab: ArticleData['tab'] = tabParam === 'timeline' || tabParam === 'links' ? tabParam : 'article';
  const childPerPage = 48;
  const childPage = positive(requestUrl.searchParams.get('cp'));
  const refs = referencesOf(node);
  const kind = (requestUrl.searchParams.get('kind') ?? '').slice(0, 40);
  const order = requestUrl.searchParams.get('order') === 'old' ? 'old' : 'new';
  const perPage = 30;
  const timelinePage = positive(requestUrl.searchParams.get('page'));

  const [ancestors, children, neighbors, recent, cited, known, navigation, timeline] = await Promise.all([
    store.ancestorsOf(database, guildId, node.path),
    tab === 'article' && node.child_count ? store.childrenOf(database, guildId, node.path, childPerPage, (childPage - 1) * childPerPage) : Promise.resolve([]),
    store.neighborsOf(database, guildId, node.path, tab === 'links' ? 40 : 12),
    tab === 'article' ? store.episodesFor(database, guildId, node.path, { limit: 6 }).then((result) => result.rows) : Promise.resolve([]),
    tab === 'article' ? store.episodesByIds(database, guildId, refs.episodes) : Promise.resolve([]),
    tab === 'article' ? store.nodesByPaths(database, guildId, refs.paths) : Promise.resolve([]),
    nav(node.path),
    tab === 'timeline'
      ? Promise.all([store.episodesFor(database, guildId, node.path, { kind, order, limit: perPage, offset: (timelinePage - 1) * perPage }), store.kindCounts(database, guildId, node.path)])
        .then(([result, kinds]): TimelineData => ({ rows: result.rows, total: result.total, page: timelinePage, perPage, kind, kinds, order }))
      : Promise.resolve(null)
  ]);
  return articleView({
    node, ancestors, children, childPage, childPerPage, neighbors, recent, tab, timeline,
    cited: new Map(cited.map((ep) => [ep.id, ep])), known: new Map(known.map((entry) => [entry.path, entry])), nav: navigation, links
  });
}
