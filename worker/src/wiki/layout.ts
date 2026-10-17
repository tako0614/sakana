import { SafeHtml, html, raw } from './html.ts';
import type { Links } from './links.ts';
import type { Session } from './types.ts';

// 記憶の本の枠 (ヘッダー・左の木・右の欄・フッター) と CSS。画面ごとの中身は views.ts。
// JavaScript は使わない: 木は <details>、スマホの分類メニューはチェックボックス、脚注の強調は :target。

export interface KindStyle {
  cls: string;
  emoji: string;
}

const KINDS: [RegExp, KindStyle][] = [
  [/レスバ|議論|口論|論争|揉め|喧嘩/, { cls: 'k-fight', emoji: '⚔️' }],
  [/ネタ|名言|迷言|ミーム|ノリ|おもしろ|面白/, { cls: 'k-meme', emoji: '😂' }],
  [/事件|炎上|障害|トラブル|荒らし/, { cls: 'k-incident', emoji: '🔥' }],
  [/決定|ルール|方針/, { cls: 'k-decision', emoji: '✅' }],
  [/告知|お知らせ|リリース|公開/, { cls: 'k-notice', emoji: '📢' }],
  [/技術|開発|実装|設計/, { cls: 'k-tech', emoji: '🛠️' }],
  [/企画|大会|イベント|オフ会/, { cls: 'k-event', emoji: '🎪' }],
  [/近況|雑談|日常/, { cls: 'k-chat', emoji: '💬' }]
];

export function kindStyle(kind: string): KindStyle {
  return KINDS.find(([pattern]) => pattern.test(kind))?.[1] ?? { cls: 'k-other', emoji: '📜' };
}

export interface LayoutOptions {
  title: string;
  description?: string;
  main: SafeHtml;
  /** 左の分類の木 */
  nav?: SafeHtml;
  /** 右の欄 (情報欄・目次) */
  rail?: SafeHtml;
  user?: Session | null;
  query?: string;
  /** このサーバーの URL (ヘッダーのリンクと検索の送り先)。サーバーが決まらない画面 (ログイン前の案内など) では無い */
  links?: Links;
  /** ログインなどのように左右の欄が要らない画面 */
  narrow?: boolean;
}

export function layout(options: LayoutOptions): SafeHtml {
  const { title, main, nav, rail, user, query = '', narrow = false, links } = options;
  const avatar = user?.avatar ? `https://cdn.discordapp.com/avatars/${user.uid}/${user.avatar}.png?size=64` : null;
  return html`<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<meta name="color-scheme" content="light dark">
<title>${title}</title>
${options.description ? html`<meta name="description" content="${options.description}">` : ''}
<style>${raw(STYLE)}</style>
</head>
<body>
<header class="top">
  <div class="top-in">
    ${nav ? html`<label class="burger" for="navtoggle" title="分類を開く">☰<span class="sr">分類</span></label>` : ''}
    <a class="brand" href="${links?.home ?? '/'}"><span class="logo">📖</span><span>記憶の本</span></a>
    ${links ? html`<nav class="topnav" aria-label="サイト">
      <a href="${links.home}">ページ</a><a href="${links.timeline}">年表</a><a href="${links.random}">ランダム</a><a href="${links.laws}">法令集</a>
    </nav>
    <form class="search" action="${links.search}" method="get" role="search">
      <input type="search" name="q" value="${query}" placeholder="人・もの・ネタ・出来事を探す" aria-label="検索" autocomplete="off" maxlength="100">
      <button type="submit">検索</button>
    </form>` : ''}
    ${user && links ? html`<div class="user">${avatar ? html`<img src="${avatar}" alt="" width="24" height="24">` : ''}<span class="uname">${user.name}</span><a href="${links.logout}">ログアウト</a></div>` : ''}
  </div>
</header>
${nav ? html`<input type="checkbox" id="navtoggle" class="navtoggle" aria-hidden="true">` : ''}
<div class="shell${narrow ? ' narrow' : ''}${rail ? ' has-rail' : ''}${nav ? ' has-nav' : ''}">
  ${nav ? html`<aside class="sidebar" aria-label="分類">${nav}</aside>` : ''}
  <main id="main">${main}</main>
  ${rail ? html`<aside class="rail">${rail}</aside>` : ''}
</div>
<footer class="foot">
  <p>記憶の本は、サーバーの会話を AI が読んでまとめたものです。間違いや抜けがあります。各ページの [数字] から出典の出来事をたどれます。</p>
</footer>
</body>
</html>`;
}

const STYLE = String.raw`
:root {
  color-scheme: light dark;
  --bg: #f4f5f7; --surface: #ffffff; --surface-2: #f7f8fa; --ink: #1c2230; --muted: #646d80; --line: #e1e4ea;
  --accent: #2f6fed; --accent-ink: #1b4fc4; --accent-soft: #e8f0ff; --mark: #fff0a0; --red: #cf3a54; --shadow: 0 1px 2px rgba(20,30,60,.06), 0 6px 18px rgba(20,30,60,.05);
  --font: system-ui, -apple-system, "Hiragino Sans", "Hiragino Kaku Gothic ProN", "Noto Sans JP", "Yu Gothic UI", Meiryo, sans-serif;
  --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0f1218; --surface: #171b23; --surface-2: #1b212b; --ink: #e7eaf0; --muted: #98a1b3; --line: #2a303c;
    --accent: #6b9cff; --accent-ink: #9bbcff; --accent-soft: #1d2a46; --mark: #5d4f10; --red: #ff7a90; --shadow: none;
  }
}
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; scroll-behavior: smooth; scroll-padding-top: 4.5rem; }
body { margin: 0; background: var(--bg); color: var(--ink); font: 16px/1.75 var(--font); }
a { color: var(--accent-ink); text-decoration-thickness: 1px; text-underline-offset: .18em; }
a:hover { text-decoration-thickness: 2px; }
img { max-width: 100%; }
h1, h2, h3, h4 { line-height: 1.35; margin: 0; }
.sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
mark { background: var(--mark); color: inherit; border-radius: 3px; padding: 0 .1em; }
code, pre { font-family: var(--mono); font-size: .9em; }
code { background: var(--surface-2); border: 1px solid var(--line); border-radius: 4px; padding: .05em .35em; }
pre.code { background: var(--surface-2); border: 1px solid var(--line); border-radius: 8px; padding: .8rem 1rem; overflow: auto; }

/* ヘッダー */
.top { position: sticky; top: 0; z-index: 20; background: color-mix(in srgb, var(--surface) 92%, transparent); backdrop-filter: blur(10px); border-bottom: 1px solid var(--line); }
.top-in { max-width: 1400px; margin: 0 auto; padding: .55rem 1rem; display: flex; align-items: center; gap: .9rem; }
.brand { display: flex; align-items: center; gap: .45rem; font-weight: 800; font-size: 1.05rem; color: var(--ink); text-decoration: none; white-space: nowrap; }
.brand .logo { font-size: 1.35rem; }
.topnav { display: flex; gap: .2rem; }
.topnav a { padding: .3rem .65rem; border-radius: 999px; color: var(--muted); text-decoration: none; font-size: .92rem; white-space: nowrap; }
.topnav a:hover { background: var(--accent-soft); color: var(--accent-ink); }
.search { flex: 1; display: flex; max-width: 28rem; margin-left: auto; }
.search input { flex: 1; min-width: 0; font: inherit; font-size: .95rem; padding: .42rem .8rem; border: 1px solid var(--line); border-right: 0; border-radius: 999px 0 0 999px; background: var(--surface-2); color: var(--ink); }
.search input:focus { outline: 2px solid var(--accent); outline-offset: -1px; background: var(--surface); }
.search button { font: inherit; font-size: .9rem; padding: .42rem .95rem; border: 1px solid var(--accent); border-radius: 0 999px 999px 0; background: var(--accent); color: #fff; cursor: pointer; }
.user { display: flex; align-items: center; gap: .5rem; font-size: .85rem; color: var(--muted); white-space: nowrap; }
.user img { border-radius: 50%; }
.user .uname { max-width: 8rem; overflow: hidden; text-overflow: ellipsis; }
.burger { display: none; cursor: pointer; font-size: 1.3rem; padding: 0 .3rem; user-select: none; }
.navtoggle { display: none; }

/* 3列 */
.shell { max-width: 1400px; margin: 0 auto; padding: 1.2rem 1rem 3rem; display: grid; gap: 1.4rem; grid-template-columns: minmax(0, 1fr); align-items: start; }
.shell.has-nav { grid-template-columns: 16.5rem minmax(0, 1fr); }
.shell.has-rail { grid-template-columns: minmax(0, 1fr) 16rem; }
.shell.has-nav.has-rail { grid-template-columns: 16.5rem minmax(0, 1fr) 16rem; }
.shell.narrow { max-width: 34rem; grid-template-columns: minmax(0, 1fr); }
.sidebar, .rail { position: sticky; top: 4.2rem; max-height: calc(100vh - 5rem); overflow: auto; font-size: .92rem; scrollbar-width: thin; }
main { min-width: 0; }

/* 左: 分類の木 */
.tree h2 { font-size: .78rem; letter-spacing: .08em; color: var(--muted); margin: 0 0 .5rem .4rem; font-weight: 700; }
.tree ul { list-style: none; margin: 0; padding: 0; }
.tree ul ul { margin-left: .55rem; padding-left: .55rem; border-left: 1px solid var(--line); }
.tree li { margin: 1px 0; }
.tree a { display: flex; justify-content: space-between; gap: .5rem; align-items: baseline; padding: .28rem .55rem; border-radius: 8px; color: var(--ink); text-decoration: none; line-height: 1.45; }
.tree a:hover { background: var(--accent-soft); }
.tree a .n { color: var(--muted); font-size: .75rem; font-variant-numeric: tabular-nums; flex: none; }
.tree li.open > a { font-weight: 700; }
.tree li.here > a { background: var(--accent-soft); color: var(--accent-ink); font-weight: 700; }
.tree .more { padding: .2rem .55rem; color: var(--muted); font-size: .8rem; }
.tree .more a { display: inline; padding: 0; color: var(--accent-ink); }

/* 記事 */
.card { background: var(--surface); border: 1px solid var(--line); border-radius: 14px; box-shadow: var(--shadow); }
.article { padding: 1.4rem 1.7rem 1.8rem; }
.crumbs { display: flex; flex-wrap: wrap; gap: .1rem .35rem; font-size: .85rem; color: var(--muted); margin-bottom: .5rem; }
.crumbs a { color: var(--muted); text-decoration: none; }
.crumbs a:hover { color: var(--accent-ink); text-decoration: underline; }
.crumbs .sep { opacity: .5; }
.crumbs .missing { text-decoration: line-through; opacity: .7; }
.art-head h1 { font-size: 2rem; font-weight: 800; letter-spacing: -.01em; word-break: break-word; }
.lead { margin: .5rem 0 0; font-size: 1.05rem; color: var(--muted); }
.chips { display: flex; flex-wrap: wrap; gap: .35rem; margin-top: .7rem; align-items: center; }
.chips .lbl { font-size: .8rem; color: var(--muted); margin-right: .15rem; }
.chip { display: inline-block; padding: .08rem .65rem; border-radius: 999px; background: var(--surface-2); border: 1px solid var(--line); font-size: .82rem; color: var(--ink); text-decoration: none; }
a.chip:hover { background: var(--accent-soft); border-color: var(--accent); }
.tabs { display: flex; gap: .2rem; margin: 1.1rem 0 0; border-bottom: 1px solid var(--line); }
.tabs a { padding: .5rem .95rem; color: var(--muted); text-decoration: none; border-bottom: 2px solid transparent; margin-bottom: -1px; font-size: .92rem; }
.tabs a:hover { color: var(--accent-ink); }
.tabs a[aria-current="page"] { color: var(--accent-ink); border-bottom-color: var(--accent); font-weight: 700; }
.tabs .n { color: var(--muted); font-size: .78rem; margin-left: .25rem; }

.prose { margin-top: 1.2rem; font-size: 1.02rem; line-height: 1.95; overflow-wrap: anywhere; }
.prose > :first-child { margin-top: 0; }
.prose p { margin: .8rem 0; }
.prose h2 { font-size: 1.4rem; margin: 2rem 0 .7rem; padding-bottom: .3rem; border-bottom: 1px solid var(--line); }
.prose h3 { font-size: 1.15rem; margin: 1.5rem 0 .5rem; }
.prose h4 { font-size: 1rem; margin: 1.2rem 0 .4rem; color: var(--muted); }
.prose .anchor { margin-left: -1.1em; margin-right: .3em; opacity: 0; color: var(--muted); text-decoration: none; font-weight: 400; }
.prose :is(h2, h3, h4):hover .anchor { opacity: .7; }
.prose ul, .prose ol { padding-left: 1.4rem; margin: .7rem 0; }
.prose li { margin: .3rem 0; }
.prose li::marker { color: var(--muted); }
.prose blockquote { margin: 1rem 0; padding: .4rem 1rem; border-left: 3px solid var(--accent); background: var(--surface-2); border-radius: 0 8px 8px 0; color: var(--muted); }
.prose hr { border: 0; border-top: 1px solid var(--line); margin: 1.6rem 0; }
.wl { color: var(--accent-ink); text-decoration-style: solid; }
.wl.missing { color: var(--red); text-decoration-style: dotted; }
a.ext::after { content: "↗"; font-size: .75em; margin-left: .1em; opacity: .6; }
.cite { font-size: .72em; line-height: 0; margin-left: .05em; }
.cite a { text-decoration: none; padding: 0 .08em; border-radius: 3px; }
.cite a:hover { background: var(--accent-soft); }
.notice { margin: 1rem 0; padding: .7rem 1rem; border-radius: 10px; background: var(--accent-soft); border: 1px solid color-mix(in srgb, var(--accent) 25%, transparent); font-size: .92rem; }
.notice.warn { background: color-mix(in srgb, #f0b400 14%, var(--surface)); border-color: color-mix(in srgb, #f0b400 40%, transparent); }
details.memo { margin: 1.2rem 0; border: 1px dashed var(--line); border-radius: 10px; padding: .1rem 1rem; background: var(--surface-2); }
details.memo summary { cursor: pointer; padding: .55rem 0; color: var(--muted); font-size: .9rem; }
details.memo .prose { margin-top: 0; font-size: .95rem; line-height: 1.8; }

.sec { margin-top: 2.2rem; }
.sec > h2 { font-size: 1.15rem; display: flex; align-items: baseline; justify-content: space-between; gap: 1rem; margin-bottom: .8rem; }
.sec > h2 small { font-size: .82rem; font-weight: 400; }
.cards { display: grid; gap: .65rem; grid-template-columns: repeat(auto-fill, minmax(13.5rem, 1fr)); }
.pcard { display: block; padding: .75rem .9rem; border: 1px solid var(--line); border-radius: 12px; background: var(--surface); color: inherit; text-decoration: none; transition: border-color .12s, transform .12s; }
.pcard:hover { border-color: var(--accent); transform: translateY(-1px); }
.pcard b { display: block; font-size: .98rem; line-height: 1.4; }
.pcard span { display: block; font-size: .82rem; color: var(--muted); line-height: 1.5; margin-top: .2rem; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.pcard small { display: block; margin-top: .35rem; color: var(--muted); font-size: .74rem; }

/* 出来事 */
.eps { list-style: none; margin: 0; padding: 0; display: grid; gap: .55rem; }
.ep { --kc: #7c8799; position: relative; }
.ep > a { display: block; padding: .7rem .95rem .75rem 1.1rem; background: var(--surface); border: 1px solid var(--line); border-left: 4px solid var(--kc); border-radius: 10px; color: inherit; text-decoration: none; }
.ep > a:hover { border-color: var(--kc); background: var(--surface-2); }
.ep-meta { display: flex; flex-wrap: wrap; align-items: center; gap: .15rem .6rem; font-size: .78rem; color: var(--muted); }
.ep-title { font-weight: 700; line-height: 1.45; margin-top: .15rem; }
.ep-sum { margin: .2rem 0 0; font-size: .87rem; color: var(--muted); line-height: 1.6; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.kind { display: inline-flex; align-items: center; gap: .25rem; padding: 0 .55rem; border-radius: 999px; font-size: .74rem; font-weight: 700; color: var(--kc); background: color-mix(in srgb, var(--kc) 13%, transparent); }
.imp { color: #e0a800; letter-spacing: -.1em; }
.k-fight { --kc: #e0662a; } .k-meme { --kc: #c99700; } .k-incident { --kc: #d6455d; } .k-decision { --kc: #2e9e6a; }
.k-notice { --kc: #2f6fed; } .k-tech { --kc: #6b5bd6; } .k-event { --kc: #b44fc4; } .k-chat { --kc: #4f8a9b; } .k-other { --kc: #7c8799; }
.month-h { margin: 1.6rem 0 .6rem; font-size: .95rem; color: var(--muted); display: flex; align-items: center; gap: .7rem; }
.month-h::after { content: ""; flex: 1; border-top: 1px solid var(--line); }
.month-h:first-child { margin-top: .4rem; }
.filters { display: flex; flex-wrap: wrap; gap: .4rem; margin: 1rem 0 .2rem; align-items: center; }
.filters .chip[aria-current="true"] { background: var(--accent); border-color: var(--accent); color: #fff; }
.pager { display: flex; justify-content: space-between; align-items: center; margin-top: 1.2rem; font-size: .9rem; color: var(--muted); }
.pager a { padding: .35rem .9rem; border: 1px solid var(--line); border-radius: 999px; text-decoration: none; background: var(--surface); }
.pager a:hover { border-color: var(--accent); }

/* 出来事の詳細 */
.ep-head h1 { font-size: 1.7rem; font-weight: 800; margin-top: .5rem; }
.ep-head .when { color: var(--muted); font-size: .9rem; display: flex; flex-wrap: wrap; gap: .2rem .9rem; align-items: center; }
.ep-summary { font-size: 1.05rem; line-height: 1.95; margin: 1.1rem 0; }
.quote { margin: .8rem 0; padding: .75rem 1rem; border-left: 4px solid var(--kc, var(--accent)); background: var(--surface-2); border-radius: 0 10px 10px 0; }
.quote p { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; font-size: 1.02rem; }
.quote footer { margin-top: .35rem; font-size: .8rem; color: var(--muted); display: flex; flex-wrap: wrap; gap: .1rem .7rem; }
.quote footer a { color: var(--muted); }
.evidence { list-style: none; padding: 0; margin: 0; font-size: .9rem; display: grid; gap: .3rem; }
.evidence li { display: grid; grid-template-columns: 4.2rem 7rem minmax(0, 1fr); gap: .6rem; color: var(--muted); }
.evidence .who { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.evidence .text { color: var(--ink); overflow-wrap: anywhere; }
.flow { display: grid; gap: 1.2rem; grid-template-columns: repeat(auto-fit, minmax(16rem, 1fr)); }
.flow h3 { font-size: .85rem; color: var(--muted); margin-bottom: .5rem; }

/* 右の欄 */
.infobox { padding: .2rem 0 .3rem; overflow: hidden; }
.infobox h2 { font-size: .8rem; letter-spacing: .08em; color: var(--muted); padding: .7rem 1rem .3rem; font-weight: 700; }
.infobox dl { margin: 0; padding: 0 1rem .6rem; display: grid; grid-template-columns: 4.8rem 1fr; gap: .35rem .6rem; font-size: .88rem; }
.infobox dt { color: var(--muted); }
.infobox dd { margin: 0; overflow-wrap: anywhere; }
.toc { margin-top: .9rem; padding: .3rem 0 .5rem; }
.toc h2 { font-size: .8rem; letter-spacing: .08em; color: var(--muted); padding: .7rem 1rem .3rem; font-weight: 700; }
.toc ol { list-style: none; margin: 0; padding: 0 .6rem .3rem; font-size: .88rem; }
.toc a { display: block; padding: .2rem .5rem; border-radius: 6px; text-decoration: none; color: var(--ink); line-height: 1.5; }
.toc a:hover { background: var(--accent-soft); }
.toc .l3 { padding-left: 1.2rem; font-size: .84rem; color: var(--muted); }
.toc .l4 { padding-left: 1.9rem; font-size: .82rem; color: var(--muted); }

/* 出典: 2列のコンパクトな一覧 */
.refs { margin: 0; padding: 0; list-style: none; font-size: .84rem; column-width: 22rem; column-gap: 1.6rem; }
.refs li { display: grid; grid-template-columns: 2.1rem minmax(0, 1fr); gap: .2rem; padding: .22rem .4rem; border-radius: 6px; break-inside: avoid; line-height: 1.5; }
.refs li:target { background: var(--accent-soft); }
.refs .no { color: var(--muted); font-variant-numeric: tabular-nums; text-decoration: none; text-align: right; }
.refs .no:hover { color: var(--accent-ink); }
.refs time { color: var(--muted); font-size: .76rem; margin-right: .3rem; font-variant-numeric: tabular-nums; }
.refbox { border: 1px solid var(--line); border-radius: 10px; background: var(--surface-2); padding: 0 1rem .6rem; }
.refbox summary { cursor: pointer; padding: .7rem 0; font-weight: 700; }
.refbox summary small { font-weight: 400; color: var(--muted); margin-left: .4rem; }

/* トップ */
.hero { padding: 2rem 1.7rem 1.6rem; background: linear-gradient(135deg, color-mix(in srgb, var(--accent) 14%, var(--surface)), var(--surface) 60%); }
.hero h1 { font-size: 2.2rem; font-weight: 800; letter-spacing: -.01em; }
.hero p { margin: .5rem 0 0; color: var(--muted); max-width: 40rem; }
.stats { display: flex; flex-wrap: wrap; gap: .6rem 1.6rem; margin-top: 1rem; font-size: .9rem; color: var(--muted); }
.stats b { color: var(--ink); font-size: 1.15rem; font-variant-numeric: tabular-nums; margin-right: .15rem; }
.cols { display: grid; gap: 1.6rem; grid-template-columns: repeat(auto-fit, minmax(19rem, 1fr)); }
.catgrid { display: grid; gap: .7rem; grid-template-columns: repeat(auto-fill, minmax(15rem, 1fr)); }
.cat { display: block; padding: .9rem 1.05rem; border-radius: 12px; border: 1px solid var(--line); background: var(--surface); color: inherit; text-decoration: none; }
.cat:hover { border-color: var(--accent); }
.cat b { font-size: 1.05rem; }
.cat .n { float: right; color: var(--muted); font-size: .8rem; font-variant-numeric: tabular-nums; }
.cat p { margin: .3rem 0 0; font-size: .85rem; color: var(--muted); line-height: 1.55; }
.spark { display: flex; align-items: end; gap: 3px; height: 4.2rem; padding: .3rem 0; }
.spark a { flex: 1; min-width: 4px; height: var(--h); min-height: 3px; background: color-mix(in srgb, var(--accent) 55%, transparent); border-radius: 3px 3px 0 0; position: relative; }
.spark a:hover { background: var(--accent); }
.spark-axis { display: flex; justify-content: space-between; font-size: .72rem; color: var(--muted); }
.plist { list-style: none; margin: 0; padding: 0; display: grid; gap: .1rem; }
.plist li a { display: block; padding: .4rem .55rem; border-radius: 8px; color: inherit; text-decoration: none; line-height: 1.5; }
.plist li a:hover { background: var(--accent-soft); }
.plist b { font-weight: 600; }
.plist small { display: block; color: var(--muted); font-size: .8rem; }

/* 年表の索引 */
.years { display: grid; gap: 1.2rem; }
.year { display: grid; grid-template-columns: 4rem 1fr; gap: .8rem; align-items: center; }
.year h2 { font-size: 1.1rem; color: var(--muted); }
.months { display: grid; grid-template-columns: repeat(12, minmax(0, 1fr)); gap: .3rem; }
.m { --i: 0; display: block; padding: .5rem .2rem; border-radius: 8px; text-align: center; font-size: .8rem; text-decoration: none; color: var(--ink); background: color-mix(in srgb, var(--accent) calc(var(--i) * 70%), var(--surface-2)); border: 1px solid var(--line); line-height: 1.3; }
.m small { display: block; color: var(--muted); font-size: .68rem; }
a.m:hover { border-color: var(--accent); }
.m.empty { opacity: .45; }
.monthnav { display: flex; justify-content: space-between; gap: 1rem; margin-bottom: .6rem; font-size: .9rem; }

/* 検索 */
.hits { list-style: none; margin: 0; padding: 0; display: grid; gap: .55rem; }
.hit a { display: block; padding: .7rem .95rem; background: var(--surface); border: 1px solid var(--line); border-radius: 10px; color: inherit; text-decoration: none; }
.hit a:hover { border-color: var(--accent); }
.hit b { font-size: 1.02rem; }
.hit p { margin: .2rem 0 0; font-size: .87rem; color: var(--muted); line-height: 1.6; overflow-wrap: anywhere; }
.hit .path { font-size: .76rem; color: var(--muted); margin-left: .5rem; font-weight: 400; }
.empty { color: var(--muted); padding: 1rem 0; }

/* ログイン・メッセージ */
.msg { padding: 2rem 1.8rem; text-align: center; }
.msg h1 { font-size: 1.5rem; margin-bottom: .6rem; }
.msg p { color: var(--muted); margin: .5rem 0; }
.btn { display: inline-block; margin-top: 1rem; padding: .65rem 1.5rem; border-radius: 999px; background: #5865f2; color: #fff; text-decoration: none; font-weight: 700; }
.btn:hover { background: #4752c4; }
.btn.plain { background: var(--accent); }
.btn.ghost { background: var(--surface); color: var(--ink); border: 1px solid var(--line); }
.btn.ghost:hover { background: var(--accent-soft); border-color: var(--accent); }
.cta { display: flex; flex-wrap: wrap; gap: .6rem; margin-top: 1.1rem; }
.cta .btn { margin-top: 0; padding: .5rem 1.1rem; font-size: .92rem; }

.foot { max-width: 1400px; margin: 0 auto; padding: 0 1rem 2.5rem; color: var(--muted); font-size: .8rem; }

/* 狭い画面: 右の欄は記事の上へ、左の木はボタンで開く */
@media (max-width: 1180px) {
  /* 右の欄は本文の下へ (本文が画面の下に押し出されないように) */
  .shell.has-nav.has-rail { grid-template-columns: 15rem minmax(0, 1fr); }
  .shell.has-rail:not(.has-nav) { grid-template-columns: minmax(0, 1fr); }
  .shell.has-nav.has-rail main { grid-column: 2; grid-row: 1; }
  .shell.has-nav.has-rail .rail { grid-column: 2; grid-row: 2; position: static; max-height: none; display: grid; gap: .9rem; grid-template-columns: repeat(auto-fit, minmax(16rem, 1fr)); align-items: start; }
  .shell.has-nav.has-rail .rail .toc { margin-top: 0; }
  .shell.has-nav.has-rail .sidebar { grid-row: 1 / span 2; }
  .shell.has-rail:not(.has-nav) .rail { grid-row: 2; position: static; max-height: none; }
}
@media (max-width: 860px) {
  .topnav { display: none; }
  .burger { display: block; }
  .user .uname { display: none; }
  .shell, .shell.has-nav, .shell.has-nav.has-rail, .shell.has-rail { grid-template-columns: minmax(0, 1fr); padding-top: .8rem; }
  .shell.has-nav.has-rail .rail, .shell.has-nav.has-rail main { grid-column: 1; }
  .shell.has-nav.has-rail main { grid-row: 2; }
  .shell.has-nav.has-rail .rail { grid-row: 3; }
  .sidebar { display: none; position: static; max-height: none; grid-row: 1 !important; }
  .navtoggle:checked ~ .shell .sidebar { display: block; background: var(--surface); border: 1px solid var(--line); border-radius: 12px; padding: .8rem; }
  .article { padding: 1.1rem 1rem 1.4rem; }
  .art-head h1 { font-size: 1.6rem; }
  .hero { padding: 1.4rem 1.1rem; }
  .hero h1 { font-size: 1.7rem; }
  .evidence li { grid-template-columns: 1fr; gap: 0; }
  .year { grid-template-columns: 1fr; }
  .months { grid-template-columns: repeat(6, minmax(0, 1fr)); }
  .search { max-width: none; }
  .brand span:not(.logo) { display: none; }
}
@media print { .top, .sidebar, .rail, .tabs, .foot { display: none; } .shell { display: block; padding: 0; } .card { box-shadow: none; border: 0; } }
`;
