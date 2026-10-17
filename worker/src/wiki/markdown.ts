import { SafeHtml, esc, raw } from './html.ts';

// 記憶の本文 (LLM が書いた、見出し・箇条書き・太字・[[リンク]]・[e12] だけの小さな Markdown) を HTML にする。
//
// 本文は bot が押し込んだ未信頼のテキスト。ここで作る HTML は、
//   1. タグになる文字はすべて esc() を通す (ブロックもインラインも)
//   2. 自分で足すタグ・属性は固定。URL は http(s) だけ
// の2つだけで組むので、本文に <script> や onerror= を書いても文字として出る。

export interface Heading {
  id: string;
  level: number;
  text: string;
}

export interface RenderContext {
  /** [[path]] の行き先。無ければ null (赤リンクにする) */
  resolvePath(path: string): { path: string; name: string } | null;
  /** [e12] の脚注番号。出来事が無ければ null */
  citeNumber(episodeId: number): number | null;
  /** [n] のリンク先と、マウスを載せたときの説明 (無ければページ内の出典欄 #ref-n) */
  citeLink?(episodeId: number): { href: string; title: string } | null;
  /** [[path]] の href。無ければ /wiki/<path> (サーバーの付かない素の形。テスト用) */
  wikiHref?(path: string): string;
  /** 見出しと出典の id の接頭辞 (1ページに複数の本文を出すときに id を重ねない) */
  idPrefix?: string;
}

export interface Rendered {
  html: SafeHtml;
  headings: Heading[];
}

const WIKI_LINK = /\[\[([^\]\n]+?)\]\]/g;
const CITE = /\[e(\d+)\]/g;

/** 本文が参照しているページと出来事。描画の前にまとめて引くために使う。 */
export function scanReferences(source: string): { paths: string[]; episodes: number[] } {
  const paths = new Set<string>();
  for (const match of source.matchAll(WIKI_LINK)) {
    const target = wikiTarget(match[1] ?? '').path;
    if (target) paths.add(target);
  }
  const episodes: number[] = [];
  const seen = new Set<number>();
  for (const match of source.matchAll(CITE)) {
    const id = Number(match[1]);
    if (Number.isSafeInteger(id) && !seen.has(id)) {
      seen.add(id);
      episodes.push(id);
    }
  }
  return { paths: [...paths], episodes };
}

/** `[[people/たこ|たこさん]]` を行き先と表示名に分ける。 */
export function wikiTarget(inner: string): { path: string; label: string | null } {
  const [target = '', label] = inner.split('|', 2);
  return { path: target.trim().replace(/^\/+|\/+$/g, ''), label: label?.trim() || null };
}

export const wikiHref = (path: string): string => `/wiki/${path.split('/').map(encodeURIComponent).join('/')}`;

const URL_PATTERN = /https?:\/\/[^\s<>"'）)」』、。]+/;
const INLINE = new RegExp([
  String.raw`\[\[([^\]\n]+?)\]\]`, // 1: wiki link
  String.raw`\[e(\d+)\]`, // 2: 出典
  String.raw`\*\*(.+?)\*\*`, // 3: 太字
  '`([^`\n]+)`', // 4: コード
  String.raw`\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)`, // 5,6: [text](url)
  `(${URL_PATTERN.source})` // 7: 素の URL
].join('|'), 'g');

/** 行の中の記法を HTML にする。記法に当たらない部分は必ず esc() を通す。 */
export function renderInline(text: string, context: RenderContext, citations: Set<number> = new Set()): string {
  let out = '';
  let last = 0;
  for (const match of text.matchAll(INLINE)) {
    const index = match.index ?? 0;
    out += esc(text.slice(last, index));
    last = index + match[0].length;
    if (match[1] !== undefined) {
      const { path, label } = wikiTarget(match[1]);
      const hit = path ? context.resolvePath(path) : null;
      const shown = label ?? hit?.name ?? path.split('/').at(-1) ?? path;
      const href = context.wikiHref ?? wikiHref;
      out += hit
        ? `<a class="wl" href="${esc(href(hit.path))}">${esc(shown)}</a>`
        : `<a class="wl missing" href="${esc(href(path))}" title="まだページがありません">${esc(shown)}</a>`;
    } else if (match[2] !== undefined) {
      const id = Number(match[2]);
      const number = context.citeNumber(id);
      if (number !== null) {
        const prefix = context.idPrefix ?? '';
        const first = !citations.has(id);
        citations.add(id);
        const link = context.citeLink?.(id) ?? null;
        out += `<sup class="cite"><a href="${esc(link?.href ?? `#ref-${number}`)}"${link ? ` title="${esc(link.title)}"` : ''}${first ? ` id="${prefix}cite-${number}"` : ''}>[${number}]</a></sup>`;
      }
    } else if (match[3] !== undefined) {
      out += `<strong>${renderInline(match[3], context, citations)}</strong>`;
    } else if (match[4] !== undefined) {
      out += `<code>${esc(match[4])}</code>`;
    } else if (match[5] !== undefined && match[6] !== undefined) {
      out += externalLink(match[6], match[5]);
    } else if (match[7] !== undefined) {
      out += externalLink(match[7], match[7].length > 48 ? `${match[7].slice(0, 47)}…` : match[7]);
    }
  }
  return out + esc(text.slice(last));
}

function externalLink(url: string, label: string): string {
  return `<a class="ext" href="${esc(url)}" rel="noopener noreferrer nofollow" target="_blank">${esc(label)}</a>`;
}

interface ListItem {
  text: string;
  ordered: boolean;
  children: ListItem[];
}

/** 先頭の空白の深さで入れ子にした箇条書きを組む。 */
function renderList(lines: { indent: number; ordered: boolean; text: string }[], context: RenderContext, citations: Set<number>): string {
  const first = lines[0];
  if (!first) return '';
  const root: ListItem[] = [];
  const stack: { indent: number; items: ListItem[] }[] = [{ indent: first.indent, items: root }];
  for (const line of lines) {
    let top = stack.at(-1);
    while (top && stack.length > 1 && line.indent < top.indent) {
      stack.pop();
      top = stack.at(-1);
    }
    if (top && line.indent > top.indent) {
      const parent = top.items.at(-1);
      if (parent) {
        const next = { indent: line.indent, items: parent.children };
        stack.push(next);
        top = next;
      }
    }
    (top ?? { items: root }).items.push({ text: line.text, ordered: line.ordered, children: [] });
  }
  // 入れ子の段ごとに、その段の最初の項目で ul / ol を決める
  const build = (items: ListItem[]): string => {
    const tag = items[0]?.ordered ? 'ol' : 'ul';
    return `<${tag}>${items.map((item) =>
      `<li>${renderInline(item.text, context, citations)}${item.children.length ? build(item.children) : ''}</li>`).join('')}</${tag}>`;
  };
  return build(root);
}

/** 本文全体。見出しには順に h-1, h-2 … の id を付け、目次に使えるよう返す。 */
export function renderMarkdown(source: string, context: RenderContext): Rendered {
  const headings: Heading[] = [];
  const citations = new Set<number>();
  const blocks: string[] = [];
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const prefix = context.idPrefix ?? '';
  let paragraph: string[] = [];
  let list: { indent: number; ordered: boolean; text: string }[] = [];
  let quote: string[] = [];
  let fence: string[] | null = null;

  const flush = () => {
    if (paragraph.length) {
      blocks.push(`<p>${paragraph.map((line) => renderInline(line, context, citations)).join('<br>')}</p>`);
      paragraph = [];
    }
    if (list.length) {
      blocks.push(renderList(list, context, citations));
      list = [];
    }
    if (quote.length) {
      blocks.push(`<blockquote>${quote.map((line) => renderInline(line, context, citations)).join('<br>')}</blockquote>`);
      quote = [];
    }
  };

  for (const line of lines) {
    if (fence) {
      if (line.trimStart().startsWith('```')) {
        blocks.push(`<pre class="code">${esc(fence.join('\n'))}</pre>`);
        fence = null;
      } else {
        fence.push(line);
      }
      continue;
    }
    if (line.trimStart().startsWith('```')) {
      flush();
      fence = [];
      continue;
    }
    const heading = /^(#{1,4})\s+(.+?)\s*#*$/.exec(line);
    if (heading) {
      flush();
      // 記事のタイトルが h1 なので、本文の # と ## (節) は h2、### は h3、#### は h4
      const level = Math.min(4, Math.max(2, heading[1]?.length ?? 2));
      const text = heading[2] ?? '';
      const id = `${prefix}h-${headings.length + 1}`;
      headings.push({ id, level, text: text.replace(/\*\*|`/g, '') });
      blocks.push(`<h${level} id="${id}"><a class="anchor" href="#${id}" aria-hidden="true">#</a>${renderInline(text, context, citations)}</h${level}>`);
      continue;
    }
    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
      flush();
      blocks.push('<hr>');
      continue;
    }
    const item = /^(\s*)([-*・]|\d+[.)])\s+(.+)$/.exec(line);
    if (item) {
      if (paragraph.length || quote.length) flush();
      const indent = item[1]?.length ?? 0;
      const ordered = /\d/.test(item[2] ?? '');
      // 先頭と同じ深さで種類 (箇条書き / 番号) が変わったら、別のリストにする
      const head = list[0];
      if (head && indent <= head.indent && ordered !== head.ordered) flush();
      list.push({ indent, ordered, text: item[3] ?? '' });
      continue;
    }
    const quoted = /^>\s?(.*)$/.exec(line);
    if (quoted) {
      if (paragraph.length || list.length) flush();
      quote.push(quoted[1] ?? '');
      continue;
    }
    if (!line.trim()) {
      flush();
      continue;
    }
    if (list.length || quote.length) flush();
    paragraph.push(line);
  }
  if (fence) blocks.push(`<pre class="code">${esc(fence.join('\n'))}</pre>`);
  flush();
  return { html: raw(blocks.join('\n')), headings };
}

/** 検索結果の抜粋: snippet() が付けた目印 (STX/ETX) を <mark> にし、残りは escape する。 */
export function highlightSnippet(snippet: string): SafeHtml {
  return raw(esc(snippet).replaceAll('\u0002', '<mark>').replaceAll('\u0003', '</mark>'));
}

/** 本文から検索結果などに出す1行の要約 (記法を外して短くする)。 */
export function plainText(source: string, max = 120): string {
  const text = source
    .replace(WIKI_LINK, (_match, inner: string) => wikiTarget(inner).label ?? wikiTarget(inner).path.split('/').at(-1) ?? '')
    .replace(CITE, '')
    .replace(/\*\*|`/g, '')
    .replace(/^[#>\-*\s]+/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
