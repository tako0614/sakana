import { authConfigured, currentSession, defaultAuthDeps, finishLogin, isPublicAccess, loginRedirect, logoutResponse, memoryGuild, safeNext, type AuthDeps } from './auth.ts';
import type { SafeHtml } from './html.ts';
import { handleIngest } from './ingest.ts';
import { layout } from './layout.ts';
import * as store from './store.ts';
import type { Env, NodeRow, Session } from './types.ts';
import {
  articleView, episodeView, homeView, loginView, messageView, monthView, referencesOf, searchView, timelineIndexView, treeNav,
  type ArticleData, type Page, type TimelineData
} from './views.ts';
import { scanReferences, wikiHref } from './markdown.ts';

// 記憶の本の URL と、gate (ログイン) と、画面ごとの読み出し。
//   /wiki            トップ            /wiki/<path>   記事 (?tab=timeline|links&kind=&order=&page=&cp=)
//   /e/<id>          出来事            /t, /t/YYYY-MM 年表
//   /s?q=            検索              /random        ランダムなページ
//   /auth/login|callback|logout        /v1/memory/*   bot からの取り込み (Bearer)
// 法令集 ('/', '/law/…', '/v1/laws') はここでは扱わない (null を返して既存の処理へ)。

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

function respond(page: Page, ctx: { user: Session | null; query?: string; lawsHref?: string }): Response {
  const body: SafeHtml = layout({
    title: page.title, description: page.description, main: page.main, rail: page.rail, nav: page.nav, narrow: page.narrow,
    user: ctx.user, query: ctx.query, lawsHref: ctx.lawsHref
  });
  return new Response(body.value, { status: page.status ?? 200, headers: { 'content-type': 'text/html; charset=utf-8', ...SECURITY_HEADERS } });
}

const redirect = (location: string): Response => new Response(null, { status: 302, headers: { location, 'cache-control': 'no-store' } });

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

  if (path.startsWith('/v1/memory/')) return handleIngest(request, env, deps.now());

  if (path.startsWith('/auth/')) {
    if (!authConfigured(env)) return respond(messageView('ログインの設定がありません', 'このサイトではまだ Discord ログインが設定されていません。', { status: 503 }), { user: null });
    if (path === '/auth/login') return loginRedirect(request, env, deps.auth);
    if (path === '/auth/logout') return logoutResponse(request);
    if (path === '/auth/callback') {
      const result = await finishLogin(request, env, deps.auth);
      if (result.ok) return result.response;
      return respond(messageView('ログインできませんでした', result.reason, { status: result.status, link: { href: '/wiki', label: 'もう一度試す' } }), { user: null });
    }
    return null;
  }

  const isWiki = path === '/wiki' || path.startsWith('/wiki/') || path.startsWith('/e/') || path === '/t' || path.startsWith('/t/') || path === '/s' || path === '/random';
  if (!isWiki) return null;
  if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('method not allowed', { status: 405, headers: { allow: 'GET, HEAD' } });

  const guild = memoryGuild(env);
  const lawsHref = guild ? `/?guild=${encodeURIComponent(guild)}` : undefined;
  if (!guild) return respond(messageView('設定がありません', '表示するサーバーが設定されていません。', { status: 503 }), { user: null });

  // gate: 公開 (MEMORY_ACCESS=public) でなければ、サーバーのメンバーとしてログインした人だけ
  let user: Session | null = null;
  if (!isPublicAccess(env)) {
    if (!authConfigured(env)) {
      return respond(messageView('まだ公開されていません', '記憶の本は、Discord ログインの設定が済むまで閉じています。', { status: 503 }), { user: null, lawsHref });
    }
    user = await currentSession(request, env, deps.now());
    if (!user) return respond(loginView(safeNext(`${url.pathname}${url.search}`), null), { user: null, lawsHref });
  }
  const ctx = { user, lawsHref };
  const db = env.LAWS;

  const nav = async (current: string): Promise<SafeHtml> => {
    const tops = await store.topLevels(db, guild);
    // いまのページの祖先と自分の子を開いておく (根の直下だけの木にならないように)
    const parts = current ? current.split('/') : [];
    const open = parts.map((_, index) => parts.slice(0, index + 1).join('/'));
    const lists = await Promise.all(open.map((entry) => store.childrenOf(db, guild, entry, 40)));
    return treeNav(tops, new Map(open.map((entry, index) => [entry, lists[index] ?? []])), current);
  };

  try {
    if (path === '/random') {
      const target = await store.randomPath(db, guild);
      return redirect(target ? wikiHref(target) : '/wiki');
    }

    if (path === '/s') {
      const query = (url.searchParams.get('q') ?? '').trim().slice(0, 100);
      const [nodes, episodes, navigation] = await Promise.all([store.searchNodes(db, guild, query), store.searchEpisodes(db, guild, query), nav('')]);
      return respond(searchView(query, nodes, episodes, navigation), { ...ctx, query });
    }

    if (path === '/t') {
      const [months, navigation] = await Promise.all([store.monthCounts(db, guild), nav('')]);
      return respond(timelineIndexView(months, navigation), ctx);
    }

    const month = /^\/t\/(\d{4}-\d{2})\/?$/.exec(path);
    if (month?.[1]) {
      const key = month[1];
      if (!store.monthRange(key)) return respond(messageView('見つかりません', 'その月は指定できません。', { status: 404, link: { href: '/t', label: '年表へ' } }), ctx);
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
        nav: navigation
      }), ctx);
    }

    const episodePath = /^\/e\/(\d{1,12})\/?$/.exec(path);
    if (episodePath?.[1]) {
      const id = Number(episodePath[1]);
      const ep = await store.getEpisode(db, guild, id);
      const navigation = await nav('');
      if (!ep) return respond(messageView('見つかりません', `出来事 ${id} は記憶の本にありません。`, { status: 404, nav: navigation, link: { href: '/wiki', label: 'トップへ' } }), ctx);
      const [quotes, nodes, neighbors] = await Promise.all([store.quotesOf(db, guild, id), store.episodeNodes(db, guild, id), store.episodeNeighbors(db, guild, id)]);
      return respond(episodeView({ guildId: guild, ep, quotes, nodes, before: neighbors.before, after: neighbors.after, nav: navigation }), ctx);
    }

    if (path === '/wiki' || path === '/wiki/') {
      const [root, stats, tops, recent, popular, updated, months] = await Promise.all([
        store.getNode(db, guild, ''), store.siteStats(db, guild), store.topLevels(db, guild), store.recentEpisodes(db, guild, 8),
        store.popularNodes(db, guild, 8), store.recentNodes(db, guild, 6), store.monthCounts(db, guild)
      ]);
      const links = root?.body ? scanReferences(root.body).paths : [];
      const known = new Map((await store.nodesByPaths(db, guild, links)).map((node) => [node.path, node]));
      return respond(homeView({ root, stats, tops, recent, popular, updated, months, nodeNames: known }), ctx);
    }

    const wiki = /^\/wiki\/(.+)$/.exec(path);
    if (wiki?.[1]) {
      const nodePath = decodePath(wiki[1]);
      if (!nodePath) return respond(messageView('見つかりません', 'ページの指定が正しくありません。', { status: 400 }), ctx);
      const node = await store.getNode(db, guild, nodePath);
      if (!node) {
        const guess = await store.guessNode(db, guild, nodePath);
        if (guess) return redirect(wikiHref(guess.path));
        const name = nodePath.split('/').at(-1) ?? nodePath;
        return respond(messageView('まだこのページはありません', `「${nodePath}」は記憶の本にありません。名前が違うか、まだ作られていないページです。`, {
          status: 404, nav: await nav(''), link: { href: `/s?q=${encodeURIComponent(name)}`, label: `「${name}」を検索` }
        }), ctx);
      }
      const page = await articlePage(db, guild, node, url, nav);
      return respond(page, ctx);
    }
  } catch (error) {
    console.error('wiki failed:', error);
    return respond(messageView('表示できませんでした', 'データを読み出せませんでした。少し待ってからもう一度お試しください。', { status: 500 }), ctx);
  }
  return null;
}

async function articlePage(database: D1Database, guildId: string, node: NodeRow, requestUrl: URL, nav: (current: string) => Promise<SafeHtml>): Promise<Page> {
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
    cited: new Map(cited.map((ep) => [ep.id, ep])), known: new Map(known.map((entry) => [entry.path, entry])), nav: navigation
  });

}
