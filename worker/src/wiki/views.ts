import { SafeHtml, html, joinHtml, raw } from './html.ts';
import { kindStyle } from './layout.ts';
import { highlightSnippet, plainText, renderMarkdown, scanReferences, wikiHref } from './markdown.ts';
import { jstDate, jstMonth } from './store.ts';
import type { EpisodeBrief, EpisodeRow, NodeBrief, NodeRow, QuoteRow } from './types.ts';
import type { EpisodeHit, NodeHit, SiteStats } from './store.ts';

// 画面ごとの中身。D1 にもネットワークにも触らない純関数 (テストしやすいように)。
// 外から来た文字列は html`` に入れた時点で escape される (html.ts)。

export interface Page {
  title: string;
  description?: string;
  main: SafeHtml;
  rail?: SafeHtml;
  nav?: SafeHtml;
  narrow?: boolean;
  status?: number;
}

const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];

export const fmtDate = (ms: number): string => jstDate(ms);
export const fmtMonth = (month: string): string => {
  const [year, index] = month.split('-');
  return `${year}年${Number(index)}月`;
};
const fmtDay = (ms: number): string => {
  const date = new Date(ms + 9 * 3_600_000);
  return `${date.getUTCMonth() + 1}月${date.getUTCDate()}日 (${WEEKDAYS[date.getUTCDay()]})`;
};
const fmtTime = (ms: number): string => new Date(ms + 9 * 3_600_000).toISOString().slice(11, 16);
const number = (value: number): string => value.toLocaleString('ja-JP');

/** クエリ文字列。空の値は入れない。 */
export function qs(params: Record<string, string | number | null | undefined>): string {
  const query = Object.entries(params)
    .filter(([, value]) => value !== null && value !== undefined && value !== '')
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
    .join('&');
  return query ? `?${query}` : '';
}

export const episodeHref = (id: number): string => `/e/${id}`;
export const monthHref = (month: string, kind = ''): string => `/t/${month}${qs({ kind })}`;

// ---- 部品 -------------------------------------------------------------------

export function kindPill(kind: string): SafeHtml {
  if (!kind) return html``;
  const style = kindStyle(kind);
  return html`<span class="kind ${style.cls}">${style.emoji} ${kind}</span>`;
}

const stars = (importance: number): string => '★'.repeat(Math.max(1, Math.min(3, importance || 2)));

export function episodeItem(ep: EpisodeBrief, options: { channel?: boolean } = {}): SafeHtml {
  const style = kindStyle(ep.kind);
  return html`<li class="ep ${style.cls}"><a href="${episodeHref(ep.id)}">
    <div class="ep-meta">${kindPill(ep.kind)}<time datetime="${fmtDate(ep.at_ms)}">${fmtDate(ep.at_ms)}</time>${options.channel !== false && ep.channel_name ? html`<span>#${ep.channel_name}</span>` : ''}<span class="imp" title="重要度">${stars(ep.importance)}</span></div>
    <div class="ep-title">${ep.title}</div>
    <p class="ep-sum">${ep.summary}</p>
  </a></li>`;
}

/** 新しい順 (または古い順) の出来事を月ごとの見出しで区切る。 */
export function episodeList(rows: readonly EpisodeBrief[], options: { channel?: boolean; group?: boolean } = {}): SafeHtml {
  if (!rows.length) return html`<p class="empty">まだ出来事がありません。</p>`;
  if (options.group === false) return html`<ul class="eps">${rows.map((row) => episodeItem(row, options))}</ul>`;
  const groups: { month: string; rows: EpisodeBrief[] }[] = [];
  for (const row of rows) {
    const month = jstMonth(row.at_ms);
    const last = groups.at(-1);
    if (last?.month === month) last.rows.push(row);
    else groups.push({ month, rows: [row] });
  }
  return joinHtml(groups.map((group) => html`<h3 class="month-h"><a href="${monthHref(group.month)}">${fmtMonth(group.month)}</a></h3>
    <ul class="eps">${group.rows.map((row) => episodeItem(row, options))}</ul>`));
}

export function pageCard(node: NodeBrief): SafeHtml {
  return html`<a class="pcard" href="${wikiHref(node.path)}"><b>${node.name}</b>${node.summary ? html`<span>${node.summary}</span>` : ''}${node.episode_count ? html`<small>出来事 ${number(node.episode_count)}${node.child_count ? ` · 子ページ ${number(node.child_count)}` : ''}</small>` : ''}</a>`;
}

/** 左の分類の木。いまのページの祖先だけ開き、その中身を出す。 */
export function treeNav(tops: readonly NodeBrief[], chain: ReadonlyMap<string, readonly NodeBrief[]>, current: string): SafeHtml {
  const list = (nodes: readonly NodeBrief[]): SafeHtml => html`<ul>${nodes.map((node) => {
    const here = node.path === current;
    const open = current.startsWith(`${node.path}/`);
    const children = chain.get(node.path);
    const showChildren = children && (here || open);
    return html`<li class="${here ? 'here' : open ? 'open' : ''}"><a href="${wikiHref(node.path)}"><span>${node.name}</span>${node.episode_count ? html`<span class="n">${number(node.episode_count)}</span>` : ''}</a>${showChildren ? html`${list(children)}${node.child_count > children.length ? html`<div class="more"><a href="${wikiHref(node.path)}">ほか ${number(node.child_count - children.length)} 件 →</a></div>` : ''}` : ''}</li>`;
  })}</ul>`;
  return html`<nav class="tree"><h2>分類</h2>${list(tops)}</nav>`;
}

// ---- トップ -----------------------------------------------------------------

export interface HomeData {
  root: NodeRow | null;
  stats: SiteStats;
  tops: NodeBrief[];
  recent: EpisodeBrief[];
  popular: NodeBrief[];
  updated: (NodeBrief & { updated_at: number })[];
  months: { month: string; n: number }[];
  nodeNames: ReadonlyMap<string, NodeBrief>;
}

export function homeView(data: HomeData): Page {
  const { root, stats } = data;
  const recentMonths = data.months.slice(-24);
  const peak = Math.max(1, ...recentMonths.map((entry) => entry.n));
  // 本文の先頭の「# タイトル」は節の見出し「このサーバーについて」と重なるので外す
  const overview = root?.body
    ? renderMarkdown(root.body.replace(/^\s*#\s+.*\n+/, ''), { resolvePath: (path) => data.nodeNames.get(path) ?? null, citeNumber: () => null }).html
    : null;
  const main = html`
<section class="card hero">
  <h1>📖 記憶の本</h1>
  <p>サーバーの会話をひとつずつ読んで、人・作ったもの・ネタ・出来事としてまとめた、みんなの wiki です。ページの文末の [数字] から、元になった出来事と発言までたどれます。</p>
  <div class="stats">
    <span><b>${number(stats.pages)}</b>ページ</span>
    <span><b>${number(stats.episodes)}</b>出来事</span>
    ${stats.firstAt && stats.lastAt ? html`<span><b>${fmtMonth(jstMonth(stats.firstAt))}</b>〜${fmtMonth(jstMonth(stats.lastAt))}</span>` : ''}
  </div>
  <div class="cta"><a class="btn plain" href="/t">📅 年表をひらく</a><a class="btn ghost" href="/random">🎲 ランダムに1ページ</a><a class="btn ghost" href="/s?q=${encodeURIComponent('レスバ')}">⚔️ レスバを探す</a></div>
</section>
${overview ? html`<section class="sec card article"><h2>このサーバーについて</h2><div class="prose">${overview}</div></section>` : ''}
<section class="sec">
  <h2>分類 <small><a href="/random">ランダムに1ページ →</a></small></h2>
  <div class="catgrid">${data.tops.map((node) => html`<a class="cat" href="${wikiHref(node.path)}"><span class="n">${number(node.child_count)}</span><b>${node.name}</b>${node.summary ? html`<p>${node.summary}</p>` : ''}</a>`)}</div>
</section>
${recentMonths.length > 1 ? html`<section class="sec">
  <h2>出来事の多さ <small><a href="/t">年表 →</a></small></h2>
  <div class="spark" role="img" aria-label="月ごとの出来事の数">${recentMonths.map((entry) => html`<a href="${monthHref(entry.month)}" style="--h:${Math.max(4, Math.round((entry.n / peak) * 100))}%" title="${fmtMonth(entry.month)}: ${entry.n} 件"></a>`)}</div>
  <div class="spark-axis"><span>${fmtMonth(recentMonths[0]?.month ?? '')}</span><span>${fmtMonth(recentMonths.at(-1)?.month ?? '')}</span></div>
</section>` : ''}
<div class="sec cols">
  <section>
    <h2>最近の出来事 <small><a href="${monthHref(jstMonth(stats.lastAt ?? Date.now()))}">もっと →</a></small></h2>
    ${episodeList(data.recent, { group: false })}
  </section>
  <section>
    <h2>よく話題になるページ</h2>
    <ul class="plist">${data.popular.map((node) => html`<li><a href="${wikiHref(node.path)}"><b>${node.name}</b><small>${node.summary || `出来事 ${number(node.episode_count)} 件`}</small></a></li>`)}</ul>
    <h2 style="margin-top:1.6rem">最近書き直されたページ</h2>
    <ul class="plist">${data.updated.map((node) => html`<li><a href="${wikiHref(node.path)}"><b>${node.name}</b><small>${fmtDate(node.updated_at)} · ${node.summary}</small></a></li>`)}</ul>
  </section>
</div>
${stats.syncedAt ? html`<p class="empty" style="margin-top:2rem;font-size:.8rem">最終更新 ${fmtDate(stats.syncedAt)} ${fmtTime(stats.syncedAt)}</p>` : ''}`;
  return { title: '記憶の本', description: '会話から作った、サーバーの wiki', main };
}

// ---- 記事 -------------------------------------------------------------------

export interface TimelineData {
  rows: EpisodeBrief[];
  total: number;
  page: number;
  perPage: number;
  kind: string;
  kinds: { kind: string; n: number }[];
  order: 'new' | 'old';
}

export interface ArticleData {
  node: NodeRow;
  ancestors: { path: string; name: string; found: boolean }[];
  children: NodeBrief[];
  childPage: number;
  childPerPage: number;
  neighbors: (NodeBrief & { link_weight: number })[];
  recent: EpisodeBrief[];
  tab: 'article' | 'timeline' | 'links';
  timeline: TimelineData | null;
  cited: ReadonlyMap<number, EpisodeBrief>;
  known: ReadonlyMap<string, NodeBrief>;
  nav: SafeHtml;
}

/** 本文と統合待ちの [eN] に、出てきた順の脚注番号を振る (出来事が見つからないものは振らない)。 */
function numberCitations(sources: readonly string[], cited: ReadonlyMap<number, EpisodeBrief>): Map<number, number> {
  const numbering = new Map<number, number>();
  for (const source of sources) {
    for (const id of scanReferences(source).episodes) {
      if (cited.has(id) && !numbering.has(id)) numbering.set(id, numbering.size + 1);
    }
  }
  return numbering;
}

/** 記事が引く出来事とページを描画の前に調べるための、本文の参照。 */
export function referencesOf(node: Pick<NodeRow, 'body' | 'pending'>): { paths: string[]; episodes: number[] } {
  const body = scanReferences(node.body);
  const pending = scanReferences(node.pending);
  return { paths: [...new Set([...body.paths, ...pending.paths])], episodes: [...new Set([...body.episodes, ...pending.episodes])] };
}

const articleHref = (path: string, params: Record<string, string | number | null | undefined> = {}): string => `${wikiHref(path)}${qs(params)}`;

function tabs(data: ArticleData): SafeHtml {
  const { node, tab } = data;
  const item = (key: ArticleData['tab'], label: string, count: number | null) => html`<a href="${articleHref(node.path, key === 'article' ? {} : { tab: key })}"${tab === key ? raw(' aria-current="page"') : ''}>${label}${count !== null ? html`<span class="n">${number(count)}</span>` : ''}</a>`;
  return html`<nav class="tabs" aria-label="表示">${item('article', '記事', null)}${item('timeline', '年表', node.episode_count)}${item('links', 'つながり', data.neighbors.length)}</nav>`;
}

function pager(base: (page: number) => string, page: number, total: number, perPage: number): SafeHtml {
  const last = Math.max(1, Math.ceil(total / perPage));
  if (last <= 1) return html``;
  return html`<div class="pager">${page > 1 ? html`<a href="${base(page - 1)}">← 前へ</a>` : html`<span></span>`}<span>${page} / ${last} ページ (${number(total)} 件)</span>${page < last ? html`<a href="${base(page + 1)}">次へ →</a>` : html`<span></span>`}</div>`;
}

function timelinePanel(data: ArticleData, timeline: TimelineData): SafeHtml {
  const { node } = data;
  const link = (params: Record<string, string | number | null>) => articleHref(node.path, { tab: 'timeline', ...params });
  return html`
<div class="filters" role="group" aria-label="種類で絞る">
  <a class="chip" href="${link({ order: timeline.order === 'old' ? 'old' : null })}"${timeline.kind ? '' : raw(' aria-current="true"')}>すべて ${number(node.episode_count)}</a>
  ${timeline.kinds.filter((entry) => entry.kind).map((entry) => html`<a class="chip" href="${link({ kind: entry.kind, order: timeline.order === 'old' ? 'old' : null })}"${timeline.kind === entry.kind ? raw(' aria-current="true"') : ''}>${kindStyle(entry.kind).emoji} ${entry.kind} ${number(entry.n)}</a>`)}
  <span style="margin-left:auto"><a class="chip" href="${link({ kind: timeline.kind, order: timeline.order === 'old' ? null : 'old' })}">${timeline.order === 'old' ? '新しい順にする' : '古い順にする'}</a></span>
</div>
${episodeList(timeline.rows, { channel: true })}
${pager((page) => link({ kind: timeline.kind, order: timeline.order === 'old' ? 'old' : null, page: page > 1 ? page : null }), timeline.page, timeline.total, timeline.perPage)}`;
}

function linksPanel(data: ArticleData): SafeHtml {
  if (!data.neighbors.length) return html`<p class="empty">まだつながりのあるページがありません。</p>`;
  const peak = Math.max(1, ...data.neighbors.map((entry) => entry.link_weight));
  return html`<div class="notice">同じ出来事に一緒に出てくる回数や、本文のリンクが多いページの順です。</div>
<ul class="plist">${data.neighbors.map((entry) => html`<li><a href="${wikiHref(entry.path)}"><b>${entry.name}</b> <small style="display:inline">つながり ${'●'.repeat(Math.max(1, Math.round((entry.link_weight / peak) * 5)))}</small><small>${entry.summary}</small></a></li>`)}</ul>`;
}

export function articleView(data: ArticleData): Page {
  const { node } = data;
  const aliases = safeJsonArray(node.aliases);
  const numbering = numberCitations([node.body, node.pending], data.cited);
  const context = {
    resolvePath: (path: string) => data.known.get(path) ?? null,
    citeNumber: (id: number) => numbering.get(id) ?? null,
    // 出典の番号は、その出来事のページへ直接飛ぶ (たこ・あかりのように 200 件を超える出典でも、一覧を探さずに済む)
    citeLink: (id: number) => {
      const ep = data.cited.get(id);
      return ep ? { href: episodeHref(id), title: `${fmtDate(ep.at_ms)} ${ep.title}` } : null;
    }
  };
  const body = node.body ? renderMarkdown(node.body, context) : null;
  const pending = node.pending ? renderMarkdown(node.pending, { ...context, idPrefix: 'p-' }) : null;
  const top = node.path.split('/')[0] ?? '';
  const refs = [...numbering.entries()].map(([id, no]) => ({ id, no, ep: data.cited.get(id) })).filter((entry): entry is { id: number; no: number; ep: EpisodeBrief } => Boolean(entry.ep));

  const crumbs = html`<nav class="crumbs" aria-label="パンくず"><a href="/wiki">記憶の本</a>${data.ancestors.map((ancestor) => html`<span class="sep">›</span>${ancestor.found ? html`<a href="${wikiHref(ancestor.path)}">${ancestor.name}</a>` : html`<span class="missing">${ancestor.name}</span>`}`)}</nav>`;

  let content: SafeHtml;
  if (data.tab === 'timeline' && data.timeline) {
    content = timelinePanel(data, data.timeline);
  } else if (data.tab === 'links') {
    content = linksPanel(data);
  } else {
    const parts: SafeHtml[] = [];
    if (body) {
      parts.push(html`<div class="prose">${body.html}</div>`);
      if (pending && node.pending_count > 0) {
        parts.push(html`<details class="memo"><summary>📝 まだ本文に入っていない知識のメモ (${number(node.pending_count)} 件)</summary><div class="prose">${pending.html}</div></details>`);
      }
    } else if (pending) {
      parts.push(html`<div class="notice warn">📝 このページはまだ本文にまとめられていません。下は集まっている知識のメモです (次の書き直しで本文になります)。</div><div class="prose">${pending.html}</div>`);
    } else if (!data.children.length) {
      parts.push(html`<p class="empty">このページにはまだ書かれていることがありません。</p>`);
    }
    if (node.child_count > 0) {
      const total = node.child_count;
      parts.push(html`<section class="sec"><h2>子ページ <small>${number(total)} 件</small></h2><div class="cards">${data.children.map(pageCard)}</div>${pager((page) => articleHref(node.path, { cp: page > 1 ? page : null }), data.childPage, total, data.childPerPage)}</section>`);
    }
    if (data.recent.length) {
      parts.push(html`<section class="sec"><h2>最近の出来事 <small><a href="${articleHref(node.path, { tab: 'timeline' })}">年表で全部見る (${number(node.episode_count)}) →</a></small></h2><ul class="eps">${data.recent.map((ep) => episodeItem(ep))}</ul></section>`);
    }
    if (data.neighbors.length) {
      parts.push(html`<section class="sec"><h2>関連するページ <small><a href="${articleHref(node.path, { tab: 'links' })}">もっと →</a></small></h2><div class="chips">${data.neighbors.slice(0, 10).map((entry) => html`<a class="chip" href="${wikiHref(entry.path)}">${entry.name}</a>`)}</div></section>`);
    }
    if (refs.length) {
      const list = html`<ol class="refs">${refs.map(({ id, no, ep }) => html`<li id="ref-${no}"><a class="no" href="#cite-${no}" title="本文へ戻る">${no}</a><span class="txt"><time>${fmtDate(ep.at_ms)}</time> <a href="${episodeHref(id)}" title="${plainText(ep.summary, 120)}">${ep.title}</a></span></li>`)}</ol>`;
      // 多いときは畳む (開くまでは本文の [数字] から出来事へ直接飛べる)
      parts.push(refs.length > 12
        ? html`<section class="sec" id="refs"><details class="refbox"><summary>出典 <small>文中の [数字] の出来事 ${number(refs.length)} 件</small></summary>${list}</details></section>`
        : html`<section class="sec" id="refs"><h2>出典 <small>文中の [数字] の出来事</small></h2>${list}</section>`);
    }
    content = joinHtml(parts);
  }

  const main = html`<article class="card article">
  <header class="art-head">
    ${crumbs}
    <h1>${node.name}</h1>
    ${node.summary ? html`<p class="lead">${node.summary}</p>` : ''}
    ${aliases.length ? html`<div class="chips"><span class="lbl">別名</span>${aliases.map((alias) => html`<span class="chip">${alias}</span>`)}</div>` : ''}
  </header>
  ${tabs(data)}
  ${content}
</article>`;

  const parent = node.parent && node.parent !== '' ? data.ancestors.at(-1) : null;
  const rail = html`<div class="card infobox"><h2>このページ</h2><dl>
    ${top && top !== node.path ? html`<dt>分類</dt><dd><a href="${wikiHref(top)}">${data.ancestors[0]?.name ?? top}</a></dd>` : ''}
    ${parent && parent.path !== top ? html`<dt>親</dt><dd><a href="${wikiHref(parent.path)}">${parent.name}</a></dd>` : ''}
    <dt>出来事</dt><dd>${number(node.episode_count)} 件${node.episode_count ? html` · <a href="${articleHref(node.path, { tab: 'timeline' })}">年表</a>` : ''}</dd>
    ${node.child_count ? html`<dt>子ページ</dt><dd>${number(node.child_count)}</dd>` : ''}
    ${node.first_at ? html`<dt>期間</dt><dd>${fmtMonth(jstMonth(node.first_at))}〜${fmtMonth(jstMonth(node.last_at ?? node.first_at))}</dd>` : ''}
    <dt>更新</dt><dd>${fmtDate(node.updated_at)}</dd>
    ${node.pending_count ? html`<dt>メモ</dt><dd>${number(node.pending_count)} 件が本文待ち</dd>` : ''}
  </dl></div>
  ${body && body.headings.length > 1 ? html`<nav class="card toc" aria-label="目次"><h2>目次</h2><ol>${body.headings.map((heading) => html`<li><a class="l${heading.level}" href="#${heading.id}">${heading.text}</a></li>`)}</ol></nav>` : ''}`;
  return { title: `${node.name} - 記憶の本`, description: node.summary || undefined, main, rail, nav: data.nav };
}

function safeJsonArray(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string').slice(0, 20) : [];
  } catch {
    return [];
  }
}

// ---- 出来事 -----------------------------------------------------------------

export interface EpisodeData {
  guildId: string;
  ep: EpisodeRow;
  quotes: QuoteRow[];
  nodes: NodeBrief[];
  before: EpisodeBrief[];
  after: EpisodeBrief[];
  nav: SafeHtml;
}

const messageUrl = (guildId: string, quote: Pick<QuoteRow, 'channel_id' | 'message_id'>): string =>
  `https://discord.com/channels/${guildId}/${quote.channel_id}/${quote.message_id}`;

export function episodeView(data: EpisodeData): Page {
  const { ep } = data;
  const style = kindStyle(ep.kind);
  const highlights = data.quotes.filter((quote) => quote.highlight);
  const evidence = data.quotes.filter((quote) => !quote.highlight);
  const main = html`<article class="card article ${style.cls}">
  <header class="ep-head">
    <nav class="crumbs" aria-label="パンくず"><a href="/wiki">記憶の本</a><span class="sep">›</span><a href="/t">年表</a><span class="sep">›</span><a href="${monthHref(jstMonth(ep.at_ms))}">${fmtMonth(jstMonth(ep.at_ms))}</a></nav>
    <div class="when">${kindPill(ep.kind)}<time datetime="${fmtDate(ep.at_ms)}">${fmtDate(ep.at_ms)} ${fmtTime(ep.at_ms)}</time>${ep.channel_name ? html`<span>#${ep.channel_name}</span>` : ''}<span class="imp" title="重要度">${stars(ep.importance)}</span></div>
    <h1>${ep.title}</h1>
  </header>
  <p class="ep-summary">${ep.summary}</p>
  ${data.nodes.length ? html`<div class="chips"><span class="lbl">関わったページ</span>${data.nodes.map((node) => html`<a class="chip" href="${wikiHref(node.path)}">${node.name}</a>`)}</div>` : ''}
  ${highlights.length ? html`<section class="sec"><h2>決め台詞・印象的な発言</h2>${highlights.map((quote) => html`<blockquote class="quote"><p>${quote.content}</p><footer><span>${quote.author_name}</span><time>${fmtDate(quote.created_at)} ${fmtTime(quote.created_at)}</time><a href="${messageUrl(data.guildId, quote)}" rel="noopener noreferrer" target="_blank">Discord で開く ↗</a></footer></blockquote>`)}</section>` : ''}
  ${evidence.length ? html`<section class="sec"><h2>根拠の発言</h2><ul class="evidence">${evidence.map((quote) => html`<li><a href="${messageUrl(data.guildId, quote)}" rel="noopener noreferrer" target="_blank">${fmtTime(quote.created_at)} ↗</a><span class="who">${quote.author_name}</span><span class="text">${quote.content}</span></li>`)}</ul></section>` : ''}
  ${ep.hidden_quotes > 0 ? html`<p class="empty" style="font-size:.85rem">🔒 見られるチャンネルが限られている発言 ${number(ep.hidden_quotes)} 件は、ここには載せていません。</p>` : ''}
  ${data.before.length || data.after.length ? html`<section class="sec"><h2>この出来事の前後</h2><div class="flow">
    ${data.before.length ? html`<div><h3>← 前の出来事 (きっかけ・前振り)</h3><ul class="eps">${data.before.map((row) => episodeItem(row, { channel: false }))}</ul></div>` : ''}
    ${data.after.length ? html`<div><h3>続き →</h3><ul class="eps">${data.after.map((row) => episodeItem(row, { channel: false }))}</ul></div>` : ''}
  </div></section>` : ''}
</article>`;
  return { title: `${ep.title} - 記憶の本`, description: plainText(ep.summary, 120), main, nav: data.nav };
}

// ---- 年表 -------------------------------------------------------------------

export function timelineIndexView(months: { month: string; n: number }[], nav: SafeHtml): Page {
  const byYear = new Map<string, Map<string, number>>();
  for (const entry of months) {
    const [year = ''] = entry.month.split('-');
    const row = byYear.get(year) ?? new Map<string, number>();
    row.set(entry.month, entry.n);
    byYear.set(year, row);
  }
  const peak = Math.max(1, ...months.map((entry) => entry.n));
  const years = [...byYear.keys()].sort().reverse();
  const main = html`<section class="card article">
  <h1 style="font-size:1.7rem">年表</h1>
  <p class="lead">月をえらぶと、その月の出来事が日ごとに並びます。色が濃い月ほど出来事が多い月です。</p>
  <div class="years" style="margin-top:1.4rem">${years.map((year) => html`<div class="year"><h2>${year}</h2><div class="months">${Array.from({ length: 12 }, (_, index) => {
    const key = `${year}-${String(index + 1).padStart(2, '0')}`;
    const n = byYear.get(year)?.get(key) ?? 0;
    return n
      ? html`<a class="m" style="--i:${(Math.sqrt(n / peak)).toFixed(2)}" href="${monthHref(key)}">${index + 1}月<small>${number(n)}</small></a>`
      : html`<span class="m empty">${index + 1}月<small>-</small></span>`;
  })}</div></div>`)}</div>
</section>`;
  return { title: '年表 - 記憶の本', main, nav };
}

export interface MonthData {
  month: string;
  rows: EpisodeBrief[];
  total: number;
  page: number;
  perPage: number;
  kind: string;
  kinds: { kind: string; n: number }[];
  prev: string | null;
  next: string | null;
  nav: SafeHtml;
}

export function monthView(data: MonthData): Page {
  const days = new Map<string, EpisodeBrief[]>();
  for (const row of data.rows) {
    const key = fmtDate(row.at_ms);
    days.set(key, [...(days.get(key) ?? []), row]);
  }
  const main = html`<section class="card article">
  <nav class="crumbs" aria-label="パンくず"><a href="/wiki">記憶の本</a><span class="sep">›</span><a href="/t">年表</a></nav>
  <div class="monthnav">${data.prev ? html`<a href="${monthHref(data.prev, data.kind)}">← ${fmtMonth(data.prev)}</a>` : html`<span></span>`}${data.next ? html`<a href="${monthHref(data.next, data.kind)}">${fmtMonth(data.next)} →</a>` : html`<span></span>`}</div>
  <h1 style="font-size:1.7rem">${fmtMonth(data.month)} <small style="font-size:.9rem;color:var(--muted);font-weight:400">${number(data.total)} 件</small></h1>
  <div class="filters" role="group" aria-label="種類で絞る">
    <a class="chip" href="${monthHref(data.month)}"${data.kind ? '' : raw(' aria-current="true"')}>すべて</a>
    ${data.kinds.filter((entry) => entry.kind).map((entry) => html`<a class="chip" href="${monthHref(data.month, entry.kind)}"${data.kind === entry.kind ? raw(' aria-current="true"') : ''}>${kindStyle(entry.kind).emoji} ${entry.kind} ${number(entry.n)}</a>`)}
  </div>
  ${data.rows.length ? joinHtml([...days.entries()].map(([date, rows]) => html`<h3 class="month-h">${fmtDay(rows[0]?.at_ms ?? 0)}</h3><ul class="eps">${rows.map((row) => episodeItem(row))}</ul>`)) : html`<p class="empty">この月の出来事はありません。</p>`}
  ${pager((page) => `${monthHref(data.month, data.kind)}${data.kind ? '&' : '?'}page=${page}`, data.page, data.total, data.perPage)}
</section>`;
  return { title: `${fmtMonth(data.month)} - 年表 - 記憶の本`, main, nav: data.nav };
}

// ---- 検索 -------------------------------------------------------------------

export function searchView(query: string, nodes: NodeHit[], episodes: EpisodeHit[], nav: SafeHtml): Page {
  const main = html`<section class="card article">
  <h1 style="font-size:1.5rem">「${query}」の検索結果</h1>
  ${!query.trim() ? html`<p class="empty">検索する言葉を入れてください。3文字以上の言葉は文中も探します。</p>` : ''}
  ${query.trim() ? html`
  <section class="sec"><h2>ページ <small>${number(nodes.length)} 件</small></h2>
    ${nodes.length ? html`<ul class="hits">${nodes.map((hit) => html`<li class="hit"><a href="${wikiHref(hit.path)}"><b>${hit.name}</b><span class="path">${hit.path}</span><p>${hit.summary}</p>${hit.snippet ? html`<p>${highlightSnippet(hit.snippet)}</p>` : ''}</a></li>`)}</ul>` : html`<p class="empty">一致するページはありません。</p>`}
  </section>
  <section class="sec"><h2>出来事 <small>${number(episodes.length)} 件</small></h2>
    ${episodes.length ? html`<ul class="eps">${episodes.map((hit) => episodeItem(hit))}</ul>` : html`<p class="empty">一致する出来事はありません。</p>`}
  </section>` : ''}
</section>`;
  return { title: `${query} - 検索 - 記憶の本`, main, nav };
}

// ---- メッセージ ---------------------------------------------------------------

export function messageView(title: string, message: string, options: { status?: number; link?: { href: string; label: string }; nav?: SafeHtml } = {}): Page {
  return {
    title: `${title} - 記憶の本`,
    status: options.status ?? 200,
    narrow: !options.nav,
    nav: options.nav,
    main: html`<section class="card msg"><h1>${title}</h1><p>${message}</p>${options.link ? html`<a class="btn plain" href="${options.link.href}">${options.link.label}</a>` : ''}</section>`
  };
}

export function loginView(next: string, methods: { oauth: boolean; link: boolean }): Page {
  return {
    title: 'ログイン - 記憶の本',
    narrow: true,
    status: 401,
    main: html`<section class="card msg"><h1>📖 記憶の本</h1>
    <p>サーバーの人のことや会話がまとまっているので、このサーバーのメンバーだけが読めます。</p>
    ${methods.link ? html`<p class="notice">Discord のサーバーで <b>/memory url</b> を使うと、あなただけに入り口のリンクが出ます (10分だけ有効・1回だけ使えます)。</p>` : ''}
    ${methods.oauth ? html`<a class="btn" href="/auth/login${qs({ next })}">Discord でログイン</a><p style="font-size:.8rem">ユーザー名とサーバーに入っているかを確かめるだけで、メッセージやフレンドは見ません。</p>` : ''}</section>`
  };
}
