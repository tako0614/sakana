import { SafeHtml, html, raw } from './html.ts';
import type { Links } from './links.ts';

// 記憶の枠 (ヘッダー・左のナビと分類の木・右の欄・フッター) と CSS。画面ごとの中身は views.ts。
// 見た目は素直な wiki: 白い紙・青いリンク・細い罫線だけ。カードも色付きの札も絵文字も使わない。
// JavaScript は使わない: 木は <details>、スマホのメニューはチェックボックス、脚注の強調は :target。

export interface LayoutOptions {
  title: string;
  description?: string;
  main: SafeHtml;
  /** 左の分類の木 */
  nav?: SafeHtml;
  /** 右の欄 (情報欄・目次) */
  rail?: SafeHtml;
  query?: string;
  /** このサーバーの URL (ヘッダーのリンクと検索の送り先)。サーバーが決まらない画面では無い */
  links?: Links;
  /** メッセージだけの画面のように左右の欄が要らないもの */
  narrow?: boolean;
}

export function layout(options: LayoutOptions): SafeHtml {
  const { title, main, nav, rail, query = '', narrow = false, links } = options;
  const side = links || nav;
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
  ${side ? html`<label class="burger" for="navtoggle" title="メニュー">☰<span class="sr">メニュー</span></label>` : ''}
  <a class="brand" href="${links?.home ?? '/'}">記憶</a>
  ${links ? html`<form class="search" action="${links.search}" method="get" role="search">
    <input type="search" name="q" value="${query}" placeholder="記憶を検索" aria-label="検索" autocomplete="off" maxlength="100">
    <button type="submit">検索</button>
  </form>` : ''}
</header>
${side ? html`<input type="checkbox" id="navtoggle" class="navtoggle" aria-hidden="true">` : ''}
<div class="shell${narrow ? ' narrow' : ''}${rail ? ' has-rail' : ''}${side ? ' has-nav' : ''}">
  ${side ? html`<aside class="sidebar" aria-label="ナビゲーション">
    ${links ? html`<nav class="portal"><ul>
      <li><a href="${links.home}">メインページ</a></li><li><a href="${links.timeline}">年表</a></li><li><a href="${links.random}">おまかせ表示</a></li><li><a href="${links.laws}">法令集</a></li>
    </ul></nav>` : ''}
    ${nav ?? ''}
  </aside>` : ''}
  <main id="main">${main}</main>
  ${rail ? html`<aside class="rail">${rail}</aside>` : ''}
</div>
<footer class="foot">
  <p>サーバーの会話を AI が読んでまとめたものです。間違いや抜けがあります。ページ中の [数字] から、元になった出来事をたどれます。</p>
</footer>
</body>
</html>`;
}

const STYLE = String.raw`
:root {
  color-scheme: light dark;
  --bg: #ffffff; --ink: #202122; --muted: #54595d; --line: #c8ccd1; --soft: #eaecf0; --panel: #f8f9fa;
  --link: #3366cc; --red: #d33; --mark: #fef6c7;
  --font: system-ui, -apple-system, "Hiragino Sans", "Hiragino Kaku Gothic ProN", "Noto Sans JP", "Yu Gothic UI", Meiryo, sans-serif;
  --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
@media (prefers-color-scheme: dark) {
  :root { --bg: #101418; --ink: #eaecf0; --muted: #a2a9b1; --line: #3a3f47; --soft: #262b32; --panel: #171b21; --link: #6b9cff; --red: #ff7b7b; --mark: #5a4b0e; }
}
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; scroll-padding-top: 4rem; }
body { margin: 0; background: var(--bg); color: var(--ink); font: 15px/1.8 var(--font); }
a { color: var(--link); text-decoration: none; }
a:hover { text-decoration: underline; }
img { max-width: 100%; }
h1, h2, h3, h4 { line-height: 1.4; margin: 0; font-weight: 600; }
.sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
mark { background: var(--mark); color: inherit; padding: 0 .1em; }
code, pre { font-family: var(--mono); font-size: .9em; }
code { background: var(--panel); border: 1px solid var(--soft); border-radius: 3px; padding: .05em .3em; }
pre.code { background: var(--panel); border: 1px solid var(--soft); padding: .7rem .9rem; overflow: auto; }
small, .muted { color: var(--muted); }

/* ヘッダー */
.top { position: sticky; top: 0; z-index: 10; display: flex; align-items: center; gap: 1rem; height: 3rem; padding: 0 1rem; background: var(--bg); border-bottom: 1px solid var(--soft); }
.brand { font-size: 1.15rem; font-weight: 700; color: var(--ink); letter-spacing: .02em; }
.brand:hover { text-decoration: none; }
.search { display: flex; margin-left: auto; width: min(22rem, 60vw); }
.search input { flex: 1; min-width: 0; font: inherit; font-size: .9rem; padding: .3rem .6rem; color: var(--ink); background: var(--panel); border: 1px solid var(--line); border-right: 0; border-radius: 3px 0 0 3px; }
.search input:focus { outline: 2px solid var(--link); outline-offset: -1px; background: var(--bg); }
.search button { font: inherit; font-size: .85rem; padding: .3rem .8rem; color: var(--ink); background: var(--panel); border: 1px solid var(--line); border-radius: 0 3px 3px 0; cursor: pointer; }
.search button:hover { background: var(--soft); }
.burger { display: none; cursor: pointer; font-size: 1.3rem; line-height: 1; user-select: none; }
.navtoggle { display: none; }

/* 3 列: 左のナビ / 本文 / 右の欄 */
.shell { display: grid; grid-template-columns: minmax(0, 1fr); max-width: 78rem; margin: 0 auto; padding: 0 1rem; }
.shell.has-nav { grid-template-columns: 12.5rem minmax(0, 1fr); column-gap: 2rem; }
.shell.has-nav.has-rail { grid-template-columns: 12.5rem minmax(0, 1fr) 15rem; }
.shell.narrow { max-width: 44rem; }
.sidebar { position: sticky; top: 3rem; align-self: start; max-height: calc(100vh - 3rem); overflow-y: auto; overflow-x: hidden; padding: 1rem 0 2rem; font-size: .85rem; line-height: 1.55; }
main { min-width: 0; padding: 1.2rem 0 2.5rem; }
.shell:not(.has-rail) main { max-width: 52rem; }
.rail { position: sticky; top: 3rem; align-self: start; max-height: calc(100vh - 3rem); overflow: auto; padding: 1.2rem 0 2rem; font-size: .85rem; line-height: 1.6; }

/* 左: ナビと分類の木 */
.sidebar ul { list-style: none; margin: 0; padding: 0; }
.sidebar h2 { font-size: .75rem; font-weight: 600; color: var(--muted); margin: 1.1rem 0 .3rem; letter-spacing: .04em; }
.portal li a { display: block; padding: .1rem 0; color: var(--link); }
.tree li > a { display: flex; justify-content: space-between; gap: .5rem; padding: .08rem 0; color: var(--link); }
.tree li > a .n { color: var(--muted); font-size: .75rem; }
.tree li.here > a { color: var(--ink); font-weight: 700; }
.tree li.open > a { color: var(--ink); }
.tree ul { margin: 0 0 .15rem .35rem; padding-left: .5rem; border-left: 1px solid var(--soft); }
.tree li > a > span:first-child { min-width: 0; overflow-wrap: anywhere; }
.tree .more { margin-left: .35rem; padding-left: .5rem; font-size: .8rem; }

/* 本文 */
.crumbs { font-size: .8rem; color: var(--muted); margin-bottom: .4rem; }
.crumbs .sep { margin: 0 .35rem; }
.crumbs .missing { color: var(--red); }
h1 { font-size: 1.75rem; padding-bottom: .25rem; border-bottom: 1px solid var(--line); margin-bottom: .6rem; word-break: break-word; }
.lead { color: var(--muted); margin: 0 0 .5rem; }
.meta { color: var(--muted); font-size: .85rem; margin: 0 0 .5rem; }
.tabs { display: flex; gap: 1.2rem; font-size: .85rem; margin: 0 0 .3rem; }
.tabs a { color: var(--link); padding: .15rem 0; border-bottom: 2px solid transparent; }
.tabs a[aria-current="page"] { color: var(--ink); border-bottom-color: var(--ink); }
.tabs a:hover { text-decoration: none; border-bottom-color: var(--link); }
.tabs .n { margin-left: .25rem; color: var(--muted); font-size: .75rem; }
.sec { margin-top: 1.8rem; }
.sec > h2, .prose h2 { font-size: 1.35rem; padding-bottom: .15rem; border-bottom: 1px solid var(--soft); margin: 1.6rem 0 .6rem; }
.sec > h2 small { font-size: .8rem; font-weight: 400; margin-left: .5rem; }
.prose h3 { font-size: 1.1rem; margin: 1.2rem 0 .4rem; }
.prose h4 { font-size: 1rem; margin: 1rem 0 .3rem; }
.prose > :first-child { margin-top: 0; }
.prose p { margin: .6rem 0; }
.prose ul, .prose ol { margin: .5rem 0; padding-left: 1.6rem; }
.prose li { margin: .15rem 0; }
.prose blockquote { margin: .8rem 0; padding: .1rem 1rem; border-left: 3px solid var(--line); color: var(--muted); }
.prose table { border-collapse: collapse; margin: .8rem 0; font-size: .9rem; }
.prose th, .prose td { border: 1px solid var(--line); padding: .3rem .6rem; }
.prose th { background: var(--panel); }
.prose :is(h2, h3, h4) { position: relative; }
.prose .anchor { position: absolute; left: -1.1rem; color: var(--muted); opacity: 0; }
.prose :is(h2, h3, h4):hover .anchor { opacity: 1; }
.wl.missing { color: var(--red); }
.ext::after { content: " ↗"; font-size: .75em; color: var(--muted); }
sup.cite { font-size: .72em; line-height: 0; }
sup.cite a { padding: 0 .1em; }
sup.cite a:target, li:target { background: var(--mark); }
.empty { color: var(--muted); }
.notice { border: 1px solid var(--soft); background: var(--panel); padding: .5rem .8rem; margin: .8rem 0; font-size: .9rem; }
.notice.warn { border-color: var(--line); }
details.memo, details.refbox { margin: 1rem 0; }
details > summary { cursor: pointer; color: var(--link); }
details > summary small { margin-left: .4rem; }

/* 一覧 */
.plain { list-style: none; margin: .5rem 0; padding: 0; }
.plain li { padding: .35rem 0; border-bottom: 1px solid var(--soft); }
.plain li:last-child { border-bottom: 0; }
.plain small { display: block; color: var(--muted); line-height: 1.5; }
.cols2 { columns: 2 16rem; column-gap: 2rem; }
.cols2 li { break-inside: avoid; }
.eps { list-style: none; margin: .4rem 0; padding: 0; }
.eps li { padding: .4rem 0; border-bottom: 1px solid var(--soft); }
.eps li:last-child { border-bottom: 0; }
.eps .meta { margin: 0; font-size: .78rem; }
.eps .meta > * + *::before { content: " · "; }
.eps .t { font-weight: 600; }
.eps .sum { margin: .1rem 0 0; color: var(--muted); font-size: .88rem; line-height: 1.55; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.month-h { font-size: 1rem; margin: 1.2rem 0 .2rem; color: var(--muted); font-weight: 600; }
.chips { display: flex; flex-wrap: wrap; gap: .2rem .8rem; margin: .5rem 0; align-items: baseline; }
.chips .lbl { color: var(--muted); font-size: .85rem; }
.filters { display: flex; flex-wrap: wrap; gap: .2rem 1rem; margin: .6rem 0 1rem; font-size: .88rem; }
.filters a[aria-current] { color: var(--ink); font-weight: 700; }
.pager { display: flex; justify-content: space-between; gap: 1rem; margin: 1.2rem 0; font-size: .9rem; color: var(--muted); }
.monthnav { display: flex; justify-content: space-between; font-size: .9rem; margin: .3rem 0; }
.refs { margin: .4rem 0; padding-left: 0; list-style: none; font-size: .88rem; }
.refs li { display: flex; gap: .6rem; padding: .1rem 0; }
.refs .no { min-width: 1.6rem; text-align: right; color: var(--muted); }
.refs time { color: var(--muted); margin-right: .4rem; }

/* 右: 情報欄と目次 */
.infobox { width: 100%; border: 1px solid var(--line); background: var(--panel); border-collapse: collapse; font-size: .85rem; line-height: 1.5; }
.infobox caption { caption-side: top; text-align: center; font-weight: 700; padding: .4rem .6rem; background: var(--soft); border: 1px solid var(--line); border-bottom: 0; }
.infobox th { text-align: left; vertical-align: top; width: 4.2em; padding: .3rem .2rem .3rem .6rem; font-weight: 600; color: var(--muted); }
.infobox td { padding: .3rem .6rem .3rem .2rem; }
.toc { margin-top: 1rem; border: 1px solid var(--line); background: var(--panel); padding: .5rem .8rem; font-size: .85rem; }
.toc h2 { font-size: .9rem; text-align: center; margin: 0 0 .3rem; }
.toc ol { list-style: none; margin: 0; padding: 0; }
.toc a.l3 { padding-left: .8rem; display: inline-block; }
.toc a.l4 { padding-left: 1.6rem; display: inline-block; }

/* 出来事 */
.quote { margin: .8rem 0; padding: .1rem 1rem; border-left: 3px solid var(--line); }
.quote p { margin: .4rem 0; white-space: pre-wrap; word-break: break-word; }
.quote footer { color: var(--muted); font-size: .8rem; display: flex; flex-wrap: wrap; gap: 0 .8rem; margin-bottom: .3rem; }
.evidence { list-style: none; margin: .4rem 0; padding: 0; font-size: .9rem; }
.evidence li { display: flex; gap: .6rem; padding: .2rem 0; }
.evidence .who { color: var(--muted); min-width: 6rem; max-width: 9rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.evidence .text { white-space: pre-wrap; word-break: break-word; min-width: 0; }
.flow { display: grid; grid-template-columns: 1fr 1fr; gap: 0 2rem; }
.flow h3 { font-size: .9rem; color: var(--muted); }

/* 年表 */
.years h2 { font-size: 1.2rem; margin: 1.2rem 0 .4rem; }
.months { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 2px; max-width: 34rem; }
.months .m { display: block; padding: .35rem .5rem; font-size: .85rem; line-height: 1.35; background: color-mix(in srgb, var(--link) calc(var(--i, 0) * 38%), var(--panel)); color: var(--ink); border: 1px solid var(--soft); }
.months .m small { display: block; color: var(--muted); font-size: .72rem; }
.months .m.empty { color: var(--muted); background: transparent; }
.months a.m:hover { text-decoration: none; border-color: var(--link); }

/* 検索・メッセージ */
.hits { list-style: none; margin: .4rem 0; padding: 0; }
.hits li { padding: .5rem 0; border-bottom: 1px solid var(--soft); }
.hits li:last-child { border-bottom: 0; }
.hits b { font-size: 1rem; }
.hits .path { margin-left: .5rem; color: var(--muted); font-size: .78rem; }
.hits p { margin: .1rem 0 0; color: var(--muted); font-size: .88rem; line-height: 1.55; }
.msg p { margin: .6rem 0 1rem; }

.foot { max-width: 78rem; margin: 0 auto; padding: 1rem; border-top: 1px solid var(--soft); color: var(--muted); font-size: .78rem; }
.foot p { margin: 0; }

@media (max-width: 1000px) {
  .shell.has-nav.has-rail { grid-template-columns: 12.5rem minmax(0, 1fr); }
  .rail { grid-column: 2; position: static; max-height: none; padding-top: 0; }
}
@media (max-width: 760px) {
  .top { padding: 0 .8rem; gap: .7rem; }
  .burger { display: block; }
  .shell, .shell.has-nav, .shell.has-nav.has-rail { grid-template-columns: minmax(0, 1fr); padding: 0 .8rem; }
  .sidebar { display: none; position: static; max-height: none; border-bottom: 1px solid var(--soft); margin-bottom: .5rem; }
  .navtoggle:checked ~ .shell .sidebar { display: block; }
  .rail { grid-column: auto; }
  .flow { grid-template-columns: 1fr; }
  .months { grid-template-columns: repeat(3, minmax(0, 1fr)); }
  .cols2 { columns: 1; }
  h1 { font-size: 1.5rem; }
}
@media print { .top, .sidebar, .rail, .foot, .search { display: none; } .shell { display: block; } }
`;
