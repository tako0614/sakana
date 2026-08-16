/**
 * 法令集の画面。D1もfetchも触らない純関数だけを置く。
 * 法令本文はbotが押し込んだ未信頼テキストなので、必ずescapeHtmlを通す。
 */

export const STATUS_ORDER = ['active', 'suspended', 'unconstitutional', 'superseded', 'repealed'];

const STATUS_CLASS = {
  active: 'ok',
  suspended: 'warn',
  unconstitutional: 'warn',
  superseded: 'past',
  repealed: 'past'
};

export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[character]);
}

export function formatDate(milliseconds, offsetMinutes = 540) {
  if (milliseconds === null || milliseconds === undefined || milliseconds === '') return '-';
  const value = Number(milliseconds);
  if (!Number.isFinite(value)) return '-';
  const shifted = new Date(value + offsetMinutes * 60_000);
  const pad = (part) => String(part).padStart(2, '0');
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`;
}

export function instrumentPath(row) {
  const base = row.type === 'constitution' ? '/constitution' : '/law';
  return `${base}/${encodeURIComponent(row.instrument_id)}`;
}

export function sortInstruments(rows) {
  return [...rows].sort((left, right) => {
    const rank = STATUS_ORDER.indexOf(left.status) - STATUS_ORDER.indexOf(right.status);
    return rank || Number(right.effective_at) - Number(left.effective_at)
      || Number(right.version) - Number(left.version);
  });
}

/**
 * 憲法本文から実行規則ブロックを切り離す。条文と機械可読な規則は読み方が違う。
 */
export function splitConstitution(content) {
  const text = String(content ?? '');
  const match = text.match(/```governance-rules\n([\s\S]*?)```/);
  if (!match) return { prose: text.trim(), rules: null };
  return { prose: text.replace(match[0], '').trim(), rules: match[1].trim() };
}

/**
 * 見出しと段落だけの素朴な構造化。HTMLとして解釈させないため、
 * 返すのは文字列ではなくblockの配列にする。
 */
export function outlineBlocks(markdown) {
  const blocks = [];
  for (const line of String(markdown ?? '').split('\n')) {
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      blocks.push({ kind: 'heading', level: heading[1].length, text: heading[2].trim() });
      continue;
    }
    if (!line.trim()) continue;
    const previous = blocks.at(-1);
    if (previous?.kind === 'paragraph') previous.text += `\n${line}`;
    else blocks.push({ kind: 'paragraph', text: line });
  }
  return blocks;
}

export function matchesQuery(row, query) {
  const needle = String(query ?? '').trim().toLowerCase();
  if (!needle) return true;
  const provisions = row.provisions_json ?? '';
  return `${row.title}\n${row.code}\n${row.text}\n${provisions}`.toLowerCase().includes(needle);
}

function badge(row) {
  const kind = STATUS_CLASS[row.status] ?? 'past';
  return `<span class="badge badge-${kind}">${escapeHtml(row.publication_status)}</span>`;
}

function meta(row) {
  const parts = [
    `第${escapeHtml(row.version)}版`,
    `施行 ${formatDate(row.effective_at)}`,
    row.ended_at ? `失効 ${formatDate(row.ended_at)}` : null
  ].filter(Boolean);
  return parts.join(' ・ ');
}

function excerpt(row, length = 120) {
  const line = String(row.text ?? '')
    .split(/\n+/)
    .find((entry) => entry.trim() && !entry.trim().startsWith('#'))
    ?? '';
  return line.length > length ? `${line.slice(0, length)}…` : line;
}

function styles() {
  return `
  :root {
    color-scheme: light dark;
    --bg: #fbfaf7;
    --surface: #fff;
    --ink: #1b1b19;
    --muted: #5f5f58;
    --line: #dcdad2;
    --accent: #1f4f8b;
    --ok: #17603a;
    --warn: #8c2f2f;
    --measure: 44rem;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #15161a; --surface: #1c1e23; --ink: #e9e9e6; --muted: #a3a39b;
      --line: #33353d; --accent: #8ab4f8; --ok: #7bd7a6; --warn: #f0928b;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--bg); color: var(--ink); line-height: 1.85;
    font-family: system-ui, "Hiragino Sans", "Noto Sans JP", sans-serif;
  }
  a { color: var(--accent); }
  header.masthead {
    display: flex; flex-wrap: wrap; gap: .5rem 1.5rem; align-items: baseline;
    padding: .9rem clamp(1rem, 4vw, 2.5rem);
    background: var(--surface); border-bottom: 1px solid var(--line);
  }
  .brand { font-size: 1.1rem; font-weight: 700; letter-spacing: .08em; color: var(--ink); text-decoration: none; }
  nav a { margin-right: 1rem; text-decoration: none; font-size: .9rem; }
  nav a:hover { text-decoration: underline; }
  main { max-width: var(--measure); margin: 0 auto; padding: 1.5rem clamp(1rem, 4vw, 2.5rem) 4rem; }
  form.search { display: flex; flex-wrap: wrap; gap: .6rem; margin-bottom: 1.5rem; }
  form.search input[type="search"] {
    flex: 1 1 16rem; padding: .55rem .7rem; font: inherit; color: var(--ink);
    background: var(--surface); border: 1px solid var(--line); border-radius: 4px;
  }
  form.search button {
    padding: .55rem 1.2rem; font: inherit; color: var(--surface);
    background: var(--accent); border: 0; border-radius: 4px; cursor: pointer;
  }
  form.search label { font-size: .85rem; color: var(--muted); align-self: center; }
  .count { color: var(--muted); font-size: .85rem; margin: 0 0 .5rem; }
  ul.instruments { list-style: none; margin: 0; padding: 0; }
  ul.instruments li { padding: .9rem 0; border-top: 1px solid var(--line); }
  .row-title { display: flex; flex-wrap: wrap; gap: .6rem; align-items: baseline; }
  .row-title a { font-size: 1.05rem; text-decoration: none; }
  .row-title a:hover { text-decoration: underline; }
  .row-meta, .excerpt { color: var(--muted); font-size: .85rem; margin: .2rem 0 0; }
  .badge { font-size: .75rem; border: 1px solid currentColor; border-radius: 999px; padding: .05rem .55rem; }
  .badge-ok { color: var(--ok); }
  .badge-warn { color: var(--warn); }
  .badge-past { color: var(--muted); }
  .notice { padding: .7rem .9rem; background: var(--surface); border-left: 3px solid var(--warn); margin-bottom: 1.5rem; }
  h1 { font-size: 1.5rem; line-height: 1.5; margin: 0 0 .4rem;
       font-family: "Hiragino Mincho ProN", "Yu Mincho", "Noto Serif JP", serif; }
  h2 { font-size: 1.1rem; margin: 2.2rem 0 .6rem; padding-bottom: .3rem; border-bottom: 1px solid var(--line); }
  h3 { font-size: 1rem; margin: 1.4rem 0 .3rem; }
  .section { scroll-margin-top: 1rem; }
  h2 + ul.instruments li:first-child { border-top: 0; }
  .doc-meta { color: var(--muted); font-size: .85rem; display: flex; flex-wrap: wrap; gap: .5rem; align-items: baseline; }
  .body-text, .article p { font-family: "Hiragino Mincho ProN", "Yu Mincho", "Noto Serif JP", serif; white-space: pre-wrap; }
  nav.toc { background: var(--surface); border: 1px solid var(--line); border-radius: 6px; padding: .8rem 1rem; margin: 1.5rem 0; }
  nav.toc p { margin: 0 0 .4rem; font-size: .8rem; color: var(--muted); }
  nav.toc ol { margin: 0; padding-left: 1.2rem; }
  nav.toc li { font-size: .9rem; }
  ol.articles { list-style: none; margin: 0; padding: 0; counter-reset: article; }
  .article { padding: .8rem 0; border-top: 1px dotted var(--line); scroll-margin-top: 4rem; }
  .article h3 { margin: 0; font-size: .85rem; color: var(--muted); letter-spacing: .04em; }
  .article p { margin: .2rem 0 0; }
  .offense { padding: .8rem 0; border-top: 1px dotted var(--line); }
  .label { font-size: .8rem; color: var(--muted); margin: .6rem 0 .1rem; }
  ul.plain { margin: .1rem 0 0; padding-left: 1.2rem; }
  pre.json {
    overflow-x: auto; padding: .8rem; font-size: .8rem; line-height: 1.6;
    background: var(--surface); border: 1px solid var(--line); border-radius: 6px;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  }
  details.rules summary { cursor: pointer; color: var(--muted); font-size: .9rem; }
  ul.versions { list-style: none; margin: 0; padding: 0; }
  ul.versions li { padding: .35rem 0; border-top: 1px dotted var(--line); display: flex; gap: .6rem; align-items: baseline; flex-wrap: wrap; }
  .hash { color: var(--muted); font-size: .78rem; word-break: break-all; }
  footer { max-width: var(--measure); margin: 0 auto; padding: 1rem clamp(1rem, 4vw, 2.5rem) 3rem;
           color: var(--muted); font-size: .82rem; }
  footer > .inner { border-top: 1px solid var(--line); padding-top: 1rem; }
  @media print {
    header.masthead, form.search, nav.toc, footer { display: none; }
    body { background: #fff; color: #000; }
  }`;
}

function layout({ title, guildId, body, footer = '' }) {
  const guild = encodeURIComponent(guildId);
  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${styles()}</style>
</head>
<body>
<header class="masthead">
  <a class="brand" href="/?guild=${guild}">法令集</a>
  <nav>
    <a href="/?guild=${guild}&amp;type=law">法律</a>
    <a href="/?guild=${guild}&amp;type=constitution">憲法</a>
    <a href="/?guild=${guild}&amp;history=1">旧版・廃止</a>
  </nav>
</header>
<main>
${body}
</main>
<footer><div class="inner">
${footer || '成立した憲法と法律の公開正本です。審議中の議題は載せません。'}
<br><a href="/v1/laws?guild=${guild}">JSON</a>
</div></footer>
</body>
</html>`;
}

function searchForm(guildId, { query = '', type = '', history = false } = {}) {
  return `<form class="search" method="get" action="/">
  <input type="hidden" name="guild" value="${escapeHtml(guildId)}">
  ${type ? `<input type="hidden" name="type" value="${escapeHtml(type)}">` : ''}
  <input type="search" name="q" value="${escapeHtml(query)}" placeholder="法令名・本文・条文を検索" aria-label="検索語">
  <label><input type="checkbox" name="history" value="1"${history ? ' checked' : ''}> 旧版・廃止も含める</label>
  <button type="submit">検索</button>
</form>`;
}

function listItem(guildId, row) {
  const articles = parseProvisions(row)?.articles?.length ?? 0;
  return `<li>
    <div class="row-title">
      <a href="${instrumentPath(row)}?guild=${encodeURIComponent(guildId)}">${escapeHtml(row.title)}</a>
      ${badge(row)}
    </div>
    <p class="row-meta">${escapeHtml(meta(row))}${articles ? ` ・ 全${articles}条` : ''}</p>
    <p class="excerpt">${escapeHtml(excerpt(row))}</p>
  </li>`;
}

export function renderList({ guildId, rows, query = '', type = '', history = false }) {
  const ordered = sortInstruments(rows);
  // 憲法は最高規範なので、種類で分けて先に置く。片方だけの一覧では見出しを出さない。
  const groups = [
    { key: 'constitution', heading: '憲法', rows: ordered.filter((row) => row.type === 'constitution') },
    { key: 'law', heading: '法律', rows: ordered.filter((row) => row.type !== 'constitution') }
  ].filter((group) => group.rows.length);
  const sections = groups.map((group) => [
    groups.length > 1 ? `<h2>${group.heading}</h2>` : '',
    `<ul class="instruments">${group.rows.map((row) => listItem(guildId, row)).join('\n')}</ul>`
  ].filter(Boolean).join('\n')).join('\n');
  const empty = query
    ? `<p class="notice">「${escapeHtml(query)}」に一致する法令はありません。</p>`
    : '<p class="notice">まだ公開された法令はありません。</p>';
  return layout({
    title: query ? `「${query}」の検索結果 - 法令集` : '法令集',
    guildId,
    body: [
      searchForm(guildId, { query, type, history }),
      ordered.length ? `<p class="count">${ordered.length}件${history ? '（旧版・廃止を含む）' : ''}</p>` : '',
      ordered.length ? sections : empty
    ].filter(Boolean).join('\n')
  });
}

function articlesSection(provisions) {
  const articles = provisions?.articles ?? [];
  if (!articles.length) return { toc: '', body: '' };
  const toc = `<nav class="toc"><p>目次</p><ol>${articles.map((article) => `
    <li><a href="#a-${escapeHtml(article.code)}">${escapeHtml(article.code)} ${escapeHtml(String(article.text ?? '').slice(0, 28))}…</a></li>`).join('')}
  </ol></nav>`;
  const body = `<h2>条文</h2><ol class="articles">${articles.map((article) => `
    <li class="article" id="a-${escapeHtml(article.code)}">
      <h3>${escapeHtml(article.code)}</h3>
      <p>${escapeHtml(article.text)}</p>
    </li>`).join('')}
  </ol>`;
  return { toc, body };
}

function offencesSection(provisions) {
  const offenses = provisions?.offenses ?? [];
  if (!offenses.length) return '';
  return `<h2>違反と処分</h2>${offenses.map((offense) => `
  <section class="offense">
    <h3>${escapeHtml(offense.title)}（${escapeHtml(offense.code)}）</h3>
    <p class="label">すべて満たしたときだけ違反になる要件</p>
    <ul class="plain">${(offense.elements ?? []).map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>
    <p class="label">処分の上限</p>
    <ul class="plain">${(offense.sanctions ?? []).map((sanction) => `<li>${escapeHtml(sanctionLabel(sanction))}</li>`).join('')}</ul>
  </section>`).join('')}`;
}

function sanctionLabel(sanction) {
  const type = ({
    warning: '警告', restriction: '機能制限', timeout: '発言停止', kick: '追放', ban: '参加禁止'
  })[sanction?.type] ?? String(sanction?.type ?? '');
  const seconds = Number(sanction?.maximumSeconds);
  const limit = Number.isFinite(seconds) && seconds > 0 ? ` / 最大${Math.round(seconds / 60)}分` : '';
  const definition = sanction?.definitionCode ? ` / 定義 ${sanction.definitionCode}` : '';
  return `${type}${limit}${definition}`;
}

function definitionsSection(provisions) {
  const definitions = provisions?.sanctionDefinitions ?? [];
  if (!definitions.length) return '';
  return `<h2>機能制限の定義</h2>${definitions.map((definition) => `
  <section class="offense">
    <h3>${escapeHtml(definition.title)}（${escapeHtml(definition.code)}）</h3>
    <p class="label">最大 ${Math.round(Number(definition.maximumDurationSeconds ?? 0) / 60)}分</p>
    <pre class="json">${escapeHtml(JSON.stringify(definition.rules, null, 2))}</pre>
  </section>`).join('')}`;
}

function versionsSection(guildId, versions, current) {
  if (versions.length < 2) return '';
  return `<h2>沿革</h2><ul class="versions">${sortInstruments(versions).map((row) => `
    <li>
      ${String(row.instrument_id) === String(current.instrument_id)
        ? `<strong>第${escapeHtml(row.version)}版（この版）</strong>`
        : `<a href="${instrumentPath(row)}?guild=${encodeURIComponent(guildId)}">第${escapeHtml(row.version)}版</a>`}
      <span class="row-meta">施行 ${formatDate(row.effective_at)}${row.ended_at ? ` ・ 失効 ${formatDate(row.ended_at)}` : ''}</span>
      ${badge(row)}
    </li>`).join('')}
  </ul>`;
}

export function renderLaw({ guildId, row, versions = [] }) {
  const provisions = parseProvisions(row);
  const { toc, body } = articlesSection(provisions);
  const current = versions.find((entry) => entry.status === 'active');
  const outdated = current && String(current.instrument_id) !== String(row.instrument_id)
    ? `<p class="notice">これは過去の版です。<a href="${instrumentPath(current)}?guild=${encodeURIComponent(guildId)}">現行版を見る</a></p>`
    : '';
  return layout({
    title: `${row.title} - 法令集`,
    guildId,
    body: [
      `<h1>${escapeHtml(row.title)}</h1>`,
      `<p class="doc-meta">${badge(row)}<span>${escapeHtml(meta(row))}</span></p>`,
      outdated,
      toc,
      `<p class="body-text">${escapeHtml(row.text)}</p>`,
      body,
      offencesSection(provisions),
      definitionsSection(provisions),
      versionsSection(guildId, versions, row),
      `<p class="hash">本文hash: ${escapeHtml(row.content_hash)}</p>`
    ].filter(Boolean).join('\n')
  });
}

export function renderConstitution({ guildId, row, versions = [] }) {
  const { prose, rules } = splitConstitution(row.text);
  const parsed = outlineBlocks(prose);
  // 先頭の大見出しは文書の題名なので、本文ではなくh1として扱う。
  const titleBlock = parsed[0]?.kind === 'heading' && parsed[0].level === 1 ? parsed[0] : null;
  const rest = titleBlock ? parsed.slice(1) : parsed;
  let sectionIndex = 0;
  const blocks = rest.map((block) => {
    if (block.kind !== 'heading') return `<p class="body-text">${escapeHtml(block.text)}</p>`;
    // 文書自身の階層をそのまま使う。題名は上でh1にしたので、以降は最上位でもh2から。
    const level = Math.max(2, Math.min(block.level, 6));
    if (block.level !== 2) return `<h${level}>${escapeHtml(block.text)}</h${level}>`;
    sectionIndex += 1;
    return `<h${level} id="s-${sectionIndex}" class="section">${escapeHtml(block.text)}</h${level}>`;
  }).join('\n');
  const headings = rest.filter((block) => block.kind === 'heading' && block.level === 2);
  const toc = headings.length
    ? `<nav class="toc"><p>目次</p><ol>${headings.map((heading, index) => `<li><a href="#s-${index + 1}">${escapeHtml(heading.text)}</a></li>`).join('')}</ol></nav>`
    : '';
  const rulesBlock = rules
    ? `<h2>実行規則</h2>
<p class="label">手続を機械が実行するための正本です。条文と矛盾する改正案は成立できません。</p>
<details class="rules"><summary>JSONを開く</summary><pre class="json">${escapeHtml(rules)}</pre></details>`
    : '';
  return layout({
    title: `${row.title} - 法令集`,
    guildId,
    body: [
      `<h1>${escapeHtml(titleBlock?.text ?? row.title)}</h1>`,
      `<p class="doc-meta">${badge(row)}<span>${escapeHtml(meta(row))}</span></p>`,
      toc,
      blocks,
      rulesBlock,
      versionsSection(guildId, versions, row),
      `<p class="hash">本文hash: ${escapeHtml(row.content_hash)}</p>`
    ].filter(Boolean).join('\n')
  });
}

export function parseProvisions(row) {
  if (!row?.provisions_json) return null;
  try {
    return JSON.parse(row.provisions_json);
  } catch {
    return null;
  }
}

export function renderMessage({ guildId, title, message }) {
  return layout({ title, guildId, body: `<p class="notice">${escapeHtml(message)}</p>` });
}
