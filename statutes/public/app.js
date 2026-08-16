import {
  formatDate,
  lawPath,
  outlineBlocks,
  parseRoute,
  splitConstitutionContent,
  statusLabel
} from './lib.js';

const main = document.getElementById('main');
const searchForm = document.getElementById('search');
const queryInput = document.getElementById('query');
const historyInput = document.getElementById('history');

let guildId = null;

function element(tag, options = {}, children = []) {
  const node = document.createElement(tag);
  if (options.text !== undefined) node.textContent = options.text;
  if (options.className) node.className = options.className;
  if (options.href) node.href = options.href;
  if (options.id) node.id = options.id;
  for (const child of children) node.append(child);
  return node;
}

function render(...nodes) {
  main.replaceChildren(...nodes);
}

function message(text) {
  render(element('p', { className: 'notice', text }));
}

async function api(path) {
  const response = await fetch(path, { headers: { accept: 'application/json' } });
  if (!response.ok) {
    const detail = await response.json().catch(() => ({}));
    throw new Error(detail.error === 'origin unavailable'
      ? '法令サーバーへ接続できません。復旧までしばらくお待ちください。'
      : `取得に失敗しました (${response.status})`);
  }
  return response.json();
}

async function ensureGuild() {
  if (guildId) return guildId;
  const { guilds } = await api('/api/guilds');
  if (!guilds.length) throw new Error('公開されている法令がまだありません。');
  guildId = guilds[0].guildId;
  return guildId;
}

function badge(status) {
  return element('span', { className: `badge badge-${status}`, text: statusLabel(status) });
}

function lawListItem(law) {
  const link = element('a', { className: 'law-link', href: lawPath(law), text: law.title });
  const meta = element('p', {
    className: 'law-meta',
    text: `第${law.version}版 ・ 施行 ${formatDate(law.effectiveAt)}${law.endedAt ? ` ・ 失効 ${formatDate(law.endedAt)}` : ''}`
  });
  return element('li', { className: 'law-item' }, [
    element('div', { className: 'law-head' }, [link, badge(law.status)]),
    meta
  ]);
}

async function showLaws(route) {
  const guild = await ensureGuild();
  const search = new URLSearchParams();
  const keyword = route.query.get('q') ?? '';
  if (keyword) search.set('q', keyword);
  if (route.query.get('status') === 'all') search.set('status', 'all');
  queryInput.value = keyword;
  historyInput.checked = route.query.get('status') === 'all';
  const { laws, total } = await api(`/api/guilds/${guild}/laws?${search}`);
  if (!laws.length) {
    message(keyword ? `「${keyword}」に一致する法令はありません。` : '公開されている法令はまだありません。');
    return;
  }
  render(
    element('p', { className: 'result-count', text: `${total}件` }),
    element('ul', { className: 'law-list' }, laws.map(lawListItem))
  );
}

function provisionSection(law) {
  const sections = [];
  const articles = law.provisions?.articles ?? [];
  if (articles.length) {
    sections.push(element('h2', { text: '条文' }));
    const list = element('ol', { className: 'articles' }, articles.map((article) => element('li', {
      className: 'article',
      id: `art-${article.code}`
    }, [
      element('span', { className: 'article-code', text: article.code }),
      element('p', { className: 'article-text', text: article.text })
    ])));
    sections.push(list);
  }
  const offenses = law.provisions?.offenses ?? [];
  if (offenses.length) {
    sections.push(element('h2', { text: '違反と処分' }));
    sections.push(element('ul', { className: 'offenses' }, offenses.map((offense) => element('li', {}, [
      element('h3', { text: `${offense.title}（${offense.code}）` }),
      element('p', { className: 'label', text: '成立要件' }),
      element('ul', {}, (offense.elements ?? []).map((item) => element('li', { text: item }))),
      element('p', { className: 'label', text: '処分の上限' }),
      element('ul', {}, (offense.sanctions ?? []).map((sanction) => element('li', {
        text: `${sanction.type}${sanction.maximumSeconds ? ` / 最大${Math.round(sanction.maximumSeconds / 60)}分` : ''}${sanction.definitionCode ? ` / 定義 ${sanction.definitionCode}` : ''}`
      })))
    ]))));
  }
  const definitions = law.provisions?.sanctionDefinitions ?? [];
  if (definitions.length) {
    sections.push(element('h2', { text: '制限の定義' }));
    sections.push(element('ul', { className: 'definitions' }, definitions.map((definition) => element('li', {}, [
      element('h3', { text: `${definition.title}（${definition.code}）` }),
      element('p', { text: `最大 ${Math.round(definition.maximumDurationSeconds / 60)}分` }),
      element('pre', { className: 'json', text: JSON.stringify(definition.rules, null, 2) })
    ]))));
  }
  return sections;
}

function versionSection(law) {
  if (law.versions.length < 2) return [];
  return [
    element('h2', { text: '沿革' }),
    element('ul', { className: 'versions' }, law.versions.map((version) => element('li', {}, [
      element('a', {
        href: `#/law/${law.id}/v/${version.version}`,
        text: `第${version.version}版（施行 ${formatDate(version.effectiveAt)}）`
      }),
      element('span', { className: 'spacer', text: ' ' }),
      badge(version.status)
    ])))
  ];
}

async function showLaw(route) {
  const guild = await ensureGuild();
  const path = route.params.version
    ? `/api/guilds/${guild}/laws/${route.params.lawId}/versions/${route.params.version}`
    : `/api/guilds/${guild}/laws/${route.params.lawId}`;
  const law = await api(path);
  const outdated = law.currentVersion !== null && law.version !== law.currentVersion
    ? element('p', { className: 'notice' }, [
        element('span', { text: 'これは過去の版です。' }),
        element('a', { href: `#/law/${law.id}`, text: '現行版を見る' })
      ])
    : null;
  render(
    element('article', { className: 'document' }, [
      element('h1', { text: law.title }),
      element('p', { className: 'law-meta' }, [
        badge(law.status),
        element('span', {
          text: ` 第${law.version}版 ・ 施行 ${formatDate(law.effectiveAt)}${law.endedAt ? ` ・ 失効 ${formatDate(law.endedAt)}` : ''} ・ 憲法 v${law.constitutionVersion ?? '-'}`
        })
      ]),
      ...(outdated ? [outdated] : []),
      element('p', { className: 'law-text', text: law.text }),
      ...provisionSection(law),
      ...versionSection(law),
      element('p', { className: 'hash', text: `本文hash: ${law.contentHash}` })
    ])
  );
  const anchor = route.query.get('art');
  if (anchor) document.getElementById(`art-${anchor}`)?.scrollIntoView({ block: 'start' });
}

async function showConstitution(route) {
  const guild = await ensureGuild();
  const path = route.params.version
    ? `/api/guilds/${guild}/constitutions/${route.params.version}`
    : `/api/guilds/${guild}/constitution`;
  const [constitution, list] = await Promise.all([
    api(path),
    api(`/api/guilds/${guild}/constitutions`)
  ]);
  const { prose, rules } = splitConstitutionContent(constitution.content);
  const body = outlineBlocks(prose).map((block) => (block.kind === 'heading'
    ? element(`h${Math.min(block.level + 1, 6)}`, { text: block.text })
    : element('p', { className: 'law-text', text: block.text })));
  const rulesBlock = rules
    ? [
        element('h2', { text: '実行規則' }),
        element('p', { className: 'label', text: '手続を機械が実行するための正本です。条文と矛盾する改正案は成立できません。' }),
        element('pre', { className: 'json', text: rules })
      ]
    : [];
  render(
    element('article', { className: 'document' }, [
      element('p', { className: 'law-meta' }, [
        badge(constitution.status === 'active' ? 'active' : 'superseded'),
        element('span', { text: ` v${constitution.version} ・ 施行 ${formatDate(constitution.enactedAt)}` })
      ]),
      ...body,
      ...rulesBlock,
      element('h2', { text: '版' }),
      element('ul', { className: 'versions' }, list.constitutions.map((entry) => element('li', {}, [
        element('a', { href: `#/constitution/${entry.version}`, text: `v${entry.version}（${formatDate(entry.enactedAt)}）` }),
        element('span', { className: 'spacer', text: ' ' }),
        badge(entry.status === 'active' ? 'active' : 'superseded')
      ]))),
      element('p', { className: 'hash', text: `本文hash: ${constitution.contentHash}` })
    ])
  );
}

async function route() {
  const current = parseRoute(location.hash);
  try {
    if (current.name === 'laws') await showLaws(current);
    else if (current.name === 'law') await showLaw(current);
    else if (current.name === 'constitution') await showConstitution(current);
    else message('そのページはありません。');
  } catch (error) {
    message(error.message);
  }
}

searchForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const search = new URLSearchParams();
  if (queryInput.value.trim()) search.set('q', queryInput.value.trim());
  if (historyInput.checked) search.set('status', 'all');
  const suffix = search.toString();
  location.hash = suffix ? `#/?${suffix}` : '#/';
  if (parseRoute(location.hash).name === 'laws') route();
});

window.addEventListener('hashchange', route);
route();
