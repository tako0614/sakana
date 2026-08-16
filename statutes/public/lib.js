/**
 * 画面とnodeのテストで共有する純関数。DOMもfetchも触らない。
 */

export function parseRoute(hash) {
  const raw = String(hash ?? '').replace(/^#/, '');
  const [path, search] = raw.split('?');
  const segments = path.split('/').filter(Boolean);
  const query = new URLSearchParams(search ?? '');
  if (segments.length === 0) return { name: 'laws', params: {}, query };
  if (segments[0] === 'law' && segments.length === 2) {
    return { name: 'law', params: { lawId: segments[1] }, query };
  }
  if (segments[0] === 'law' && segments.length === 4 && segments[2] === 'v') {
    return { name: 'law', params: { lawId: segments[1], version: segments[3] }, query };
  }
  if (segments[0] === 'constitution' && segments.length === 1) {
    return { name: 'constitution', params: {}, query };
  }
  if (segments[0] === 'constitution' && segments.length === 2) {
    return { name: 'constitution', params: { version: segments[1] }, query };
  }
  return { name: 'notFound', params: {}, query };
}

export function lawPath(law) {
  return law.version === law.currentVersion || law.currentVersion === undefined
    ? `#/law/${law.id}`
    : `#/law/${law.id}/v/${law.version}`;
}

const JST_OFFSET_MINUTES = 540;

export function formatDate(milliseconds, offsetMinutes = JST_OFFSET_MINUTES) {
  if (milliseconds === null || milliseconds === undefined || milliseconds === '') return '-';
  const value = Number(milliseconds);
  if (!Number.isFinite(value)) return '-';
  const shifted = new Date(value + offsetMinutes * 60_000);
  const pad = (part) => String(part).padStart(2, '0');
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`;
}

export function statusLabel(status) {
  return ({
    active: '現行',
    suspended: '停止',
    unconstitutional: '違憲',
    repealed: '廃止',
    superseded: '旧版'
  })[status] ?? status;
}

/**
 * 憲法本文から実行規則ブロックを切り離す。条文と機械可読な規則は
 * 読み方が違うので、画面でも分けて出す。
 */
export function splitConstitutionContent(content) {
  const text = String(content ?? '');
  const match = text.match(/```governance-rules\n([\s\S]*?)```/);
  if (!match) return { prose: text.trim(), rules: null };
  return {
    prose: text.replace(match[0], '').trim(),
    rules: match[1].trim()
  };
}

/**
 * 見出しと本文だけの素朴な段組み。法令本文をHTMLとして解釈しないため、
 * 表示側はここが返した文字列をtextContentで置く。
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
