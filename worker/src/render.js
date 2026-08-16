/**
 * 法令集の画面。D1もfetchも触らない純関数だけを置く。
 * 法令本文はbotが押し込んだ未信頼テキストなので、必ずescapeHtmlを通す。
 *
 * 構成はe-Gov法令検索に倣う（検索band / 2段ヘッダ / 沿革・目次のsidebar + 条文本文）。
 * 色・書体・余白はデジタル庁デザインシステム(DADS)に合わせ、値は
 * @digital-go-jp/design-tokens v2.0.1 の tokens-simple.css から写している。
 */

export const STATUS_ORDER = ['active', 'suspended', 'unconstitutional', 'superseded', 'repealed'];

const STATUS_CLASS = {
  active: 'ok',
  suspended: 'warn',
  unconstitutional: 'error',
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
  return `${shifted.getUTCFullYear()}年${shifted.getUTCMonth() + 1}月${shifted.getUTCDate()}日`;
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

export function parseProvisions(row) {
  if (!row?.provisions_json) return null;
  try {
    return JSON.parse(row.provisions_json);
  } catch {
    return null;
  }
}

function badge(row) {
  return `<span class="badge badge-${STATUS_CLASS[row.status] ?? 'past'}">${escapeHtml(row.publication_status)}</span>`;
}

function excerpt(row, length = 110) {
  const line = String(row.text ?? '')
    .split(/\n+/)
    .find((entry) => entry.trim() && !entry.trim().startsWith('#'))
    ?? '';
  return line.length > length ? `${line.slice(0, length)}…` : line;
}

/**
 * DADSのトークンをそのまま変数に置く。本文16px以上、行高1.5以上、
 * テキストのコントラスト比4.5:1以上という基本デザインの規定に合わせる。
 */
function styles() {
  return `
  :root {
    --blue-900: #0017c1;
    --blue-1000: #00118f;
    --blue-50: #e8f1fe;
    --purple-900: #5109ad;
    --green-800: #197a4b;
    --red-800: #ec0000;
    --yellow-400: #ffc700;
    --yellow-700: #b78f00;
    --gray-50: #f2f2f2;
    --gray-200: #cccccc;
    --gray-536: #767676;
    --gray-600: #666666;
    --gray-700: #4d4d4d;
    --gray-900: #1a1a1a;
    --white: #ffffff;
    --black: #000000;
    --ink: var(--gray-900);
    --muted: var(--gray-536);
    --line: var(--gray-200);
    --bg: var(--gray-50);
    --link: var(--blue-900);
    --primary: var(--blue-900);
    --primary-hover: var(--blue-1000);
    --measure: 60rem;
  }
  * { box-sizing: border-box; }
  html { -webkit-text-size-adjust: 100%; }
  body {
    margin: 0; background: var(--bg); color: var(--ink);
    font-size: 16px; line-height: 1.7;
    font-family: 'Noto Sans JP', 'Hiragino Sans', 'Yu Gothic Medium', Meiryo, system-ui, sans-serif;
  }
  a { color: var(--link); text-underline-offset: .15em; }
  a:visited { color: var(--purple-900); }
  a:hover { color: var(--primary-hover); }
  :focus-visible {
    outline: 3px solid var(--yellow-400); outline-offset: 1px;
    box-shadow: 0 0 0 1px var(--black); border-radius: 2px;
  }
  .skip {
    position: absolute; left: -9999px; top: 0; z-index: 10;
    background: var(--white); color: var(--link); padding: .5rem 1rem;
  }
  .skip:focus { left: .5rem; top: .5rem; }

  .site-header { background: var(--white); border-bottom: 1px solid var(--line); }
  .site-header .inner, .doc-header .inner, .page, .site-footer .inner, .search-band form {
    max-width: var(--measure); margin: 0 auto; padding-left: clamp(1rem, 4vw, 2rem); padding-right: clamp(1rem, 4vw, 2rem);
  }
  .site-header .inner {
    display: flex; align-items: center; justify-content: space-between; gap: 1rem; min-height: 56px;
  }
  .brand { display: flex; align-items: baseline; gap: .6rem; text-decoration: none; color: var(--ink); }
  .brand-mark { font-size: 1.25rem; font-weight: 700; color: var(--primary); letter-spacing: .04em; }
  .brand-name { font-size: 1rem; font-weight: 700; }
  .site-header nav a { font-size: .875rem; margin-left: 1.25rem; }

  .doc-header { background: var(--white); border-bottom: 1px solid var(--line); }
  .doc-header .inner {
    display: flex; align-items: center; justify-content: space-between;
    gap: 1rem; min-height: 52px; flex-wrap: wrap;
  }
  .doc-header h1 { font-size: 1.125rem; font-weight: 700; margin: 0; line-height: 1.5; }
  .doc-header .sub { color: var(--gray-700); font-weight: 400; font-size: .9375rem; }

  .search-band { background: var(--white); border-bottom: 1px solid var(--line); padding: 1.5rem 0 1.75rem; }
  fieldset.scope {
    border: 0; margin: 0 0 .75rem; padding: 0;
    display: flex; flex-wrap: wrap; gap: .25rem 1.5rem; align-items: center;
  }
  fieldset.scope legend { float: left; font-size: .875rem; color: var(--gray-700); padding: 0 .75rem 0 0; }
  .radio { display: inline-flex; align-items: center; gap: .4rem; font-size: .9375rem; min-height: 32px; }
  .radio input { width: 1.125rem; height: 1.125rem; accent-color: var(--primary); }
  .filters { background: var(--gray-50); border: 1px solid var(--line); padding: .6rem .9rem; margin-bottom: .9rem; }
  .filters fieldset.scope { margin: 0; }
  .search-row { display: flex; }
  .search-row input[type="search"] {
    flex: 1 1 auto; min-width: 0; font: inherit; color: var(--ink); background: var(--white);
    border: 1px solid var(--gray-600); border-right: 0; padding: .65rem .8rem; min-height: 48px;
  }
  .search-row button {
    flex: 0 0 auto; font: inherit; font-weight: 700; color: var(--white);
    background: var(--primary); border: 1px solid var(--primary);
    padding: 0 1.5rem; min-height: 48px; cursor: pointer;
  }
  .search-row button:hover { background: var(--primary-hover); border-color: var(--primary-hover); }

  .page { padding-top: 1.5rem; padding-bottom: 3rem; }
  .split { display: grid; grid-template-columns: 17rem minmax(0, 1fr); gap: 1.5rem; align-items: start; }
  /* 画面が狭いときは、目次より先に本文を読ませる。 */
  @media (max-width: 52rem) {
    .split { grid-template-columns: minmax(0, 1fr); }
    .split > main.doc { order: 1; }
    .split > aside.side { order: 2; }
  }
  .panel { background: var(--white); border: 1px solid var(--line); }
  .panel h2 {
    font-size: .875rem; margin: 0; padding: .6rem .9rem; background: var(--gray-50);
    border-bottom: 1px solid var(--line); color: var(--gray-700); font-weight: 700;
  }
  aside.side { position: sticky; top: 1rem; display: grid; gap: 1rem; }
  @media (max-width: 52rem) { aside.side { position: static; } }
  .side ol { list-style: none; margin: 0; padding: .4rem 0; }
  .side li a, .side li span { display: block; padding: .35rem .9rem; font-size: .9375rem; text-decoration: none; }
  .side li a:hover { background: var(--blue-50); text-decoration: underline; }
  .side li .current { font-weight: 700; background: var(--blue-50); }
  .side .note { padding: .5rem .9rem; margin: 0; font-size: .875rem; color: var(--gray-700); }

  main.doc { background: var(--white); border: 1px solid var(--line); padding: 1.5rem clamp(1rem, 3vw, 2rem) 2rem; }
  .doc-meta {
    display: flex; flex-wrap: wrap; gap: .5rem .75rem; align-items: center; margin: 0;
    padding-bottom: .9rem; border-bottom: 1px solid var(--line); font-size: .9375rem; color: var(--gray-700);
  }
  .tabs { display: flex; flex-wrap: wrap; margin: 1.1rem 0 1.4rem; justify-content: center; }
  .tabs a {
    font-size: .9375rem; text-decoration: none; color: var(--ink); background: var(--white);
    border: 1px solid var(--gray-600); padding: .45rem 1.1rem; margin-left: -1px;
    min-height: 40px; display: inline-flex; align-items: center;
  }
  .tabs a:first-child { margin-left: 0; }
  .tabs a:hover { background: var(--blue-50); }
  h2.section {
    font-size: 1.125rem; font-weight: 700; margin: 2rem 0 .8rem;
    padding-bottom: .4rem; border-bottom: 2px solid var(--gray-900); scroll-margin-top: 1rem;
  }
  h3 { font-size: 1rem; font-weight: 700; margin: 1.4rem 0 .3rem; }
  .law-title { font-size: 1.5rem; font-weight: 700; text-align: center; margin: 1.4rem 0 1.8rem; line-height: 1.5; }
  .lede { margin: 0 0 1rem; text-indent: 1em; }
  ol.articles { list-style: none; margin: 0; padding: 0; }
  .article { margin: 0 0 .9rem; padding-left: 5.5em; text-indent: -5.5em; scroll-margin-top: 1rem; }
  /* text-indentは継承するので、ぶら下げの番号側では打ち消す。 */
  .article .num { font-weight: 700; display: inline-block; min-width: 5em; text-indent: 0; }
  /* 項番号は条番号より短いので、ぶら下げ幅も詰める。 */
  .article.item { padding-left: 2.5em; text-indent: -2.5em; margin-bottom: .5rem; }
  .article.item .num { min-width: 2em; font-weight: 400; }
  .offense { border-top: 1px solid var(--line); padding: .9rem 0 .2rem; }
  .label { font-size: .875rem; color: var(--gray-700); margin: .7rem 0 .1rem; font-weight: 700; }
  ul.plain { margin: .1rem 0 0; padding-left: 1.4rem; }
  .badge {
    display: inline-block; font-size: .875rem; line-height: 1.5; padding: .05rem .6rem;
    border: 1px solid currentColor; border-radius: 2px; font-weight: 700; white-space: nowrap;
  }
  .badge-ok { color: var(--green-800); background: #f0f9f4; }
  .badge-warn { color: var(--yellow-700); background: #fbf5e0; }
  .badge-error { color: var(--red-800); background: #fdeaea; }
  .badge-past { color: var(--gray-700); background: var(--gray-50); }
  .notice {
    border: 1px solid var(--line); border-left: 4px solid var(--yellow-700);
    background: var(--white); padding: .8rem 1rem; margin: 0 0 1.2rem;
  }
  .notice-error { border-left-color: var(--red-800); }
  pre.json {
    overflow-x: auto; padding: .8rem 1rem; font-size: .875rem; line-height: 1.7; margin: .4rem 0 0;
    background: var(--gray-50); border: 1px solid var(--line);
    font-family: 'Noto Sans Mono', ui-monospace, SFMono-Regular, Menlo, monospace;
  }
  details.rules summary { cursor: pointer; padding: .4rem 0; font-weight: 700; }
  .hash { color: var(--gray-700); font-size: .875rem; word-break: break-all; margin: 1.6rem 0 0; }
  .actions { display: flex; justify-content: flex-end; gap: 1.25rem; margin: 1.5rem 0 0; font-size: .9375rem; }

  .result-count { margin: 0 0 .75rem; color: var(--gray-700); font-size: .9375rem; }
  .group { margin-bottom: 1.75rem; }
  .group > h2 { font-size: 1.125rem; margin: 0 0 .6rem; padding-bottom: .35rem; border-bottom: 2px solid var(--gray-900); }
  table.laws { width: 100%; border-collapse: collapse; background: var(--white); }
  table.laws th, table.laws td { border: 1px solid var(--line); padding: .7rem .9rem; text-align: left; vertical-align: top; }
  table.laws th { background: var(--gray-50); font-size: .875rem; color: var(--gray-700); white-space: nowrap; }
  table.laws td.name a { font-weight: 700; }
  table.laws td.name p { margin: .2rem 0 0; font-size: .875rem; color: var(--gray-700); }
  table.laws td.when { white-space: nowrap; font-size: .9375rem; }
  @media (max-width: 40rem) {
    table.laws, table.laws tbody, table.laws tr, table.laws td { display: block; width: 100%; }
    table.laws thead { display: none; }
    table.laws tr { border: 1px solid var(--line); margin-bottom: .75rem; }
    table.laws td { border: 0; padding: .4rem .9rem; }
  }

  .site-footer { background: var(--gray-50); border-top: 1px solid var(--line); margin-top: 2rem; }
  .site-footer .inner { padding-top: 1.5rem; padding-bottom: 1.5rem; font-size: .875rem; color: var(--gray-700); }
  .site-footer ul { list-style: none; display: flex; flex-wrap: wrap; gap: 1.25rem; margin: .6rem 0 0; padding: 0; }
  .copyright { background: var(--gray-700); color: var(--white); text-align: center; font-size: .875rem; padding: .8rem 1rem; }

  @media print {
    .site-header, .search-band, aside.side, .tabs, .actions, .site-footer, .copyright, .skip { display: none; }
    body { background: var(--white); }
    main.doc, .panel { border: 0; }
    .split { display: block; }
  }`;
}

function layout({ title, guildId, docTitle = null, docSub = null, body, search = null }) {
  const guild = encodeURIComponent(guildId);
  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<meta name="description" content="このコミュニティで成立している憲法と法律の公開正本です。">
<style>${styles()}</style>
</head>
<body>
<a class="skip" href="#main">本文へ移動</a>
<header class="site-header">
  <div class="inner">
    <a class="brand" href="/?guild=${guild}">
      <span class="brand-mark">法令集</span>
      <span class="brand-name">法令検索</span>
    </a>
    <nav aria-label="サイト内">
      <a href="/?guild=${guild}&amp;type=constitution">憲法</a>
      <a href="/?guild=${guild}&amp;type=law">法律</a>
      <a href="/v1/laws?guild=${guild}">API</a>
    </nav>
  </div>
</header>
${docTitle ? `<div class="doc-header"><div class="inner">
  <h1>${escapeHtml(docTitle)}${docSub ? ` <span class="sub">${escapeHtml(docSub)}</span>` : ''}</h1>
  <a href="/?guild=${guild}">一覧へ戻る</a>
</div></div>` : ''}
${search ?? ''}
<div class="page" id="main">
${body}
</div>
<footer class="site-footer">
  <div class="inner">
    成立した憲法と法律の公開正本です。審議中の議題は載せていません。
    <ul>
      <li><a href="/?guild=${guild}">法令集</a></li>
      <li><a href="/?guild=${guild}&amp;history=1">旧版・停止・廃止を含む一覧</a></li>
      <li><a href="/v1/laws?guild=${guild}">法令データ (JSON)</a></li>
    </ul>
  </div>
  <div class="copyright">統治botが公布した正本をそのまま掲載しています。</div>
</footer>
</body>
</html>`;
}

function searchBand(guildId, { query = '', type = '', history = false } = {}) {
  return `<div class="search-band">
<form method="get" action="/" role="search">
  <input type="hidden" name="guild" value="${escapeHtml(guildId)}">
  <fieldset class="scope">
    <legend>検索対象</legend>
    <label class="radio"><input type="radio" name="history" value=""${history ? '' : ' checked'}> 現行の法令</label>
    <label class="radio"><input type="radio" name="history" value="1"${history ? ' checked' : ''}> 旧版・停止・廃止も含む</label>
  </fieldset>
  <div class="filters">
    <fieldset class="scope">
      <legend>種別</legend>
      <label class="radio"><input type="radio" name="type" value=""${type ? '' : ' checked'}> すべて</label>
      <label class="radio"><input type="radio" name="type" value="constitution"${type === 'constitution' ? ' checked' : ''}> 憲法</label>
      <label class="radio"><input type="radio" name="type" value="law"${type === 'law' ? ' checked' : ''}> 法律</label>
    </fieldset>
  </div>
  <div class="search-row">
    <label class="skip" for="q">法令名・本文・条文を検索</label>
    <input type="search" id="q" name="q" value="${escapeHtml(query)}" placeholder="法令名・本文・条文を検索">
    <button type="submit">検索</button>
  </div>
</form>
</div>`;
}

function lawRow(guildId, row) {
  const articles = parseProvisions(row)?.articles?.length ?? 0;
  return `<tr>
    <td class="name">
      <a href="${instrumentPath(row)}?guild=${encodeURIComponent(guildId)}">${escapeHtml(row.title)}</a>
      <p>${escapeHtml(excerpt(row))}</p>
    </td>
    <td>${badge(row)}</td>
    <td class="when">第${escapeHtml(row.version)}版${articles ? `<br>全${articles}条` : ''}</td>
    <td class="when">${formatDate(row.effective_at)}${row.ended_at ? `<br>失効 ${formatDate(row.ended_at)}` : ''}</td>
  </tr>`;
}

export function renderList({ guildId, rows, query = '', type = '', history = false }) {
  const ordered = sortInstruments(rows);
  const groups = [
    { key: 'constitution', heading: '憲法', rows: ordered.filter((row) => row.type === 'constitution') },
    { key: 'law', heading: '法律', rows: ordered.filter((row) => row.type !== 'constitution') }
  ].filter((group) => group.rows.length);
  const table = (group) => `<section class="group">
    ${groups.length > 1 ? `<h2>${group.heading}</h2>` : ''}
    <table class="laws">
      <thead><tr><th scope="col">法令名</th><th scope="col">状態</th><th scope="col">版</th><th scope="col">施行日</th></tr></thead>
      <tbody>${group.rows.map((row) => lawRow(guildId, row)).join('\n')}</tbody>
    </table>
  </section>`;
  const empty = query
    ? `<p class="notice">「${escapeHtml(query)}」に一致する法令はありません。検索語を短くするか、「旧版・停止・廃止も含む」で探してください。</p>`
    : '<p class="notice">まだ公開された法令はありません。</p>';
  return layout({
    title: query ? `「${query}」の検索結果 - 法令集` : '法令集',
    guildId,
    search: searchBand(guildId, { query, type, history }),
    body: [
      ordered.length
        ? `<p class="result-count">${ordered.length}件${query ? `（「${escapeHtml(query)}」の検索結果）` : ''}${history ? ' / 旧版・停止・廃止を含む' : ''}</p>`
        : '',
      ordered.length ? groups.map(table).join('\n') : empty
    ].filter(Boolean).join('\n')
  });
}

function versionsPanel(guildId, versions, current) {
  if (!versions.length) return '';
  return `<section class="panel">
    <h2>沿革</h2>
    <ol>${sortInstruments(versions).map((row) => (String(row.instrument_id) === String(current.instrument_id)
    ? `<li><span class="current">第${escapeHtml(row.version)}版（表示中）<br>${formatDate(row.effective_at)} 施行</span></li>`
    : `<li><a href="${instrumentPath(row)}?guild=${encodeURIComponent(guildId)}">第${escapeHtml(row.version)}版<br>${formatDate(row.effective_at)} 施行</a></li>`)).join('')}
    </ol>
    ${versions.length < 2 ? '<p class="note">この法令はまだ改正されていません。</p>' : ''}
  </section>`;
}

function tocPanel(entries) {
  if (!entries.length) return '';
  return `<nav class="panel" aria-label="目次">
    <h2>目次</h2>
    <ol>${entries.map((entry) => `<li><a href="#${entry.id}">${escapeHtml(entry.label)}</a></li>`).join('')}</ol>
  </nav>`;
}

function articlesSection(provisions) {
  const articles = provisions?.articles ?? [];
  if (!articles.length) return { toc: [], body: '' };
  const toc = articles.map((article) => ({ id: `a-${article.code}`, label: article.code }));
  const body = `<h2 class="section" id="articles">条文</h2>
  <ol class="articles">${articles.map((article) => `
    <li class="article" id="a-${escapeHtml(article.code)}">
      <span class="num">${escapeHtml(article.code)}</span>${escapeHtml(article.text)}
    </li>`).join('')}
  </ol>`;
  return { toc, body };
}

function sanctionLabel(sanction) {
  const type = ({
    warning: '警告', restriction: '機能制限', timeout: '発言停止', kick: '追放', ban: '参加禁止'
  })[sanction?.type] ?? String(sanction?.type ?? '');
  const seconds = Number(sanction?.maximumSeconds);
  const limit = Number.isFinite(seconds) && seconds > 0 ? `　上限 ${Math.round(seconds / 60)}分` : '';
  const definition = sanction?.definitionCode ? `　定義 ${sanction.definitionCode}` : '';
  return `${type}${limit}${definition}`;
}

function offencesSection(provisions) {
  const offenses = provisions?.offenses ?? [];
  if (!offenses.length) return '';
  return `<h2 class="section" id="offenses">違反と処分</h2>${offenses.map((offense) => `
  <section class="offense">
    <h3>${escapeHtml(offense.title)}（${escapeHtml(offense.code)}）</h3>
    <p class="label">すべて満たしたときだけ違反になる要件</p>
    <ul class="plain">${(offense.elements ?? []).map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>
    <p class="label">科すことができる処分の上限</p>
    <ul class="plain">${(offense.sanctions ?? []).map((sanction) => `<li>${escapeHtml(sanctionLabel(sanction))}</li>`).join('')}</ul>
  </section>`).join('')}`;
}

function definitionsSection(provisions) {
  const definitions = provisions?.sanctionDefinitions ?? [];
  if (!definitions.length) return '';
  return `<h2 class="section" id="definitions">機能制限の定義</h2>${definitions.map((definition) => `
  <section class="offense">
    <h3>${escapeHtml(definition.title)}（${escapeHtml(definition.code)}）</h3>
    <p class="label">上限 ${Math.round(Number(definition.maximumDurationSeconds ?? 0) / 60)}分</p>
    <pre class="json">${escapeHtml(JSON.stringify(definition.rules, null, 2))}</pre>
  </section>`).join('')}`;
}

function tabs(entries) {
  if (entries.length < 2) return '';
  return `<div class="tabs">${entries.map((entry) => `<a href="#${entry.id}">${escapeHtml(entry.label)}</a>`).join('')}</div>`;
}

export function renderLaw({ guildId, row, versions = [] }) {
  const provisions = parseProvisions(row);
  const { toc, body } = articlesSection(provisions);
  const current = versions.find((entry) => entry.status === 'active');
  const outdated = current && String(current.instrument_id) !== String(row.instrument_id)
    ? `<p class="notice">これは過去の版です。<a href="${instrumentPath(current)}?guild=${encodeURIComponent(guildId)}">現行版（第${escapeHtml(current.version)}版）を見る</a></p>`
    : '';
  const halted = row.status !== 'active' && !outdated
    ? `<p class="notice notice-error">この法令は${escapeHtml(row.publication_status)}です。執行されません。</p>`
    : '';
  const sections = [
    toc.length ? { id: 'articles', label: '条文' } : null,
    provisions?.offenses?.length ? { id: 'offenses', label: '違反と処分' } : null,
    provisions?.sanctionDefinitions?.length ? { id: 'definitions', label: '機能制限の定義' } : null
  ].filter(Boolean);
  return layout({
    title: `${row.title} - 法令集`,
    guildId,
    docTitle: row.title,
    docSub: `第${row.version}版`,
    body: `<div class="split">
  <aside class="side">
    ${versionsPanel(guildId, versions, row)}
    ${tocPanel(toc)}
  </aside>
  <main class="doc">
    <p class="doc-meta">${badge(row)}<span>${formatDate(row.effective_at)} 施行</span>${row.ended_at ? `<span>${formatDate(row.ended_at)} 失効</span>` : ''}<span>第${escapeHtml(row.version)}版</span></p>
    ${tabs(sections)}
    ${outdated}${halted}
    <h2 class="law-title">${escapeHtml(row.title)}</h2>
    <p class="lede">${escapeHtml(row.text)}</p>
    ${body}
    ${offencesSection(provisions)}
    ${definitionsSection(provisions)}
    <p class="hash">本文hash: ${escapeHtml(row.content_hash)}</p>
    <p class="actions"><a href="/v1/laws/${encodeURIComponent(row.code)}?guild=${encodeURIComponent(guildId)}">この法令のJSON</a></p>
  </main>
</div>`
  });
}

export function renderConstitution({ guildId, row, versions = [] }) {
  const { prose, rules } = splitConstitution(row.text);
  const parsed = outlineBlocks(prose);
  const titleBlock = parsed[0]?.kind === 'heading' && parsed[0].level === 1 ? parsed[0] : null;
  const rest = titleBlock ? parsed.slice(1) : parsed;
  const toc = [];
  let sectionIndex = 0;
  const blocks = rest.map((block) => {
    if (block.kind !== 'heading') {
      // 「1. …」で始まる項は、条文と同じぶら下げで並べる。
      return block.text.split('\n').map((line) => {
        const numbered = line.match(/^(\d+)\.\s*(.*)$/);
        return numbered
          ? `<p class="article item"><span class="num">${escapeHtml(numbered[1])}</span>${escapeHtml(numbered[2])}</p>`
          : `<p class="lede">${escapeHtml(line)}</p>`;
      }).join('\n');
    }
    if (block.level !== 2) return `<h3>${escapeHtml(block.text)}</h3>`;
    sectionIndex += 1;
    toc.push({ id: `s-${sectionIndex}`, label: block.text });
    return `<h2 class="section" id="s-${sectionIndex}">${escapeHtml(block.text)}</h2>`;
  }).join('\n');
  const rulesBlock = rules
    ? `<h2 class="section" id="rules">実行規則</h2>
<p>手続を機械が実行するための正本です。日本語の条文と矛盾する改正案は成立できません。</p>
<details class="rules"><summary>実行規則のJSONを開く</summary><pre class="json">${escapeHtml(rules)}</pre></details>`
    : '';
  const outdated = row.status !== 'active'
    ? '<p class="notice">これは過去の憲法です。現行憲法は一覧から開けます。</p>'
    : '';
  return layout({
    title: `${row.title} - 法令集`,
    guildId,
    docTitle: titleBlock?.text ?? row.title,
    docSub: `第${row.version}版`,
    body: `<div class="split">
  <aside class="side">
    ${versionsPanel(guildId, versions, row)}
    ${tocPanel(rulesBlock ? [...toc, { id: 'rules', label: '実行規則' }] : toc)}
  </aside>
  <main class="doc">
    <p class="doc-meta">${badge(row)}<span>${formatDate(row.effective_at)} 施行</span><span>第${escapeHtml(row.version)}版</span></p>
    ${outdated}
    <h2 class="law-title">${escapeHtml(titleBlock?.text ?? row.title)}</h2>
    ${blocks}
    ${rulesBlock}
    <p class="hash">本文hash: ${escapeHtml(row.content_hash)}</p>
  </main>
</div>`
  });
}

export function renderMessage({ guildId, title, message }) {
  return layout({
    title,
    guildId,
    body: `<main class="doc"><p class="notice notice-error">${escapeHtml(message)}</p></main>`
  });
}
