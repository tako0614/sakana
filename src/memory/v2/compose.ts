import { memoryDb } from '../store.js';
import { arrayOf, isRecord } from '../types.js';
import { CLAIM_TYPES, type ClaimType, type Modality } from './types.js';

// S4 組み立て。ページは検証済みの主張 (claims) から書く。前のページ本文は渡さない (要約の要約をしない)。
//
//   - 同じ文の主張 (何度も言っている) は 1 つにして ×N と示す
//   - 主張が多い entity は、種類ごとの子ページ (people/たこ/立場と意見) と、概要の親ページに分ける。
//     1 つの子ページが長ければ時期で割って、別々に書いて連ねる。本文の長さの上限は置かない
//   - 小さい entity は 1 回の呼び出しに数件まとめる
//   - 各文に [c12] の形で根拠の主張を付けさせ、保存時に [e345] (その主張の出来事) に置き換える
//   - 根拠の無い文・入力に無い [cN] の文は捨てる。どの文にも入らなかった主張は、機械が末尾に追記する
//     (モデルが落としても、検証済みの内容はページから消えない)
//   - モデルの出力が使えなければ、主張を並べただけの本文にする (本文のないページを作らない)

const TZ_MS = Number(process.env.ARCHIVE_TZ_OFFSET_HOURS ?? 9) * 3_600_000;
const day = (ms: number): string => new Date(ms + TZ_MS).toISOString().slice(0, 10);

export const SINGLE_MAX = Number(process.env.MEMORY_V2_SINGLE_MAX || 80);      // これ以下の主張なら子ページに分けない
export const PART_MAX = Number(process.env.MEMORY_V2_PART_MAX || 120);          // 1 回の呼び出しに渡す主張の上限
export const SMALL_GROUPS = 6;                                                 // これ以下なら束ねて 1 回で書く
export const BATCH_PAGES = 12;
export const BATCH_CHARS = 9000;
const SUBPAGE_MIN = 8;                                                         // これ未満の種類は親ページに入れる
const KEY_CLAIMS = 30;                                                         // 親ページの概要に入れる要の主張

export interface Group {
  /** 代表の主張 id (プロンプトでは c<id>) */
  id: number;
  text: string;
  type: ClaimType;
  modality: Modality;
  hedged: boolean;
  n: number;
  firstAt: number;
  lastAt: number;
  /** 根拠の出来事 (古い順、重複なし) */
  episodes: number[];
  attrs: Record<string, string>;
}

interface ClaimRow {
  id: number; text: string; type: string; modality: string; hedged: number; as_of: number; episode_id: number | null; attrs: string
}

const textKey = (text: string): string => text.normalize('NFKC').toLowerCase().replace(/[\s\-_・.,、。!！?？「」『』()（）]/g, '');

export function loadGroups(entityId: number): Group[] {
  const rows = memoryDb().prepare<[number], ClaimRow>(`
    SELECT id, text, type, modality, hedged, as_of, episode_id, attrs FROM v2_claims
    WHERE entity_id = ? AND verdict <> 'wrong' AND modality NOT IN ('joke', 'hypothetical', 'roleplay') ORDER BY as_of, id
  `).all(entityId);
  const groups = new Map<string, Group>();
  for (const row of rows) {
    const key = `${row.type}|${textKey(row.text)}`;
    const group = groups.get(key);
    const episodes = row.episode_id === null ? [] : [row.episode_id];
    if (group) {
      group.n += 1;
      group.lastAt = Math.max(group.lastAt, row.as_of);
      group.hedged = group.hedged && row.hedged === 1;   // 1 つでも確かな根拠があれば弱くない
      for (const id of episodes) if (!group.episodes.includes(id)) group.episodes.push(id);
    } else {
      groups.set(key, {
        id: row.id, text: row.text, type: row.type as ClaimType, modality: row.modality as Modality, hedged: row.hedged === 1,
        n: 1, firstAt: row.as_of, lastAt: row.as_of, episodes, attrs: JSON.parse(row.attrs) as Record<string, string>
      });
    }
  }
  return [...groups.values()];
}

// ---- ページの分け方 -----------------------------------------------------------

const PERSON_GROUPS: Record<ClaimType, string> = {
  stance: '立場と意見', trait: '人柄と口癖', skill: '得意と作ったもの', relation: '人間関係', fact: '経緯と出来事', definition: '用語とネタ', outcome: '経緯と出来事'
};
const THING_GROUPS: Record<ClaimType, string> = {
  stance: '意見と議論', trait: '特徴', skill: '特徴', relation: '関わった人', fact: '経緯と結果', definition: '用語と由来', outcome: '経緯と結果'
};

export interface Part {
  /** 子ページの区分名 / 概要 / 全体 */
  label: string;
  /** 時期で割ったときの見出し (1 ページに連ねる) */
  period: string;
  groups: Group[];
  level: 2 | 3;
}

export interface Bundle {
  path: string;
  entityId: number;
  /** 表示用の種類 (人物 / もの) */
  kind: string;
  name: string;
  /** 機械が出した事実 (引用なしで本文の頭に置く) */
  facts: string[];
  /** 本文の末尾に機械が足すもの (子ページへのリンクなど) */
  links: string[];
  parts: Part[];
  weight: number;
  firstAt: number;
  lastAt: number;
}

export interface EntityInfo {
  id: number;
  kind: 'person' | 'thing';
  name: string;
  path: string;
  aliases: string[];
  meta: { messages?: number; firstMs?: number | null; lastMs?: number | null; names?: number };
}

export function factsOf(entity: EntityInfo): string[] {
  if (entity.kind !== 'person') return [];
  const facts: string[] = [];
  const { messages, firstMs, lastMs } = entity.meta;
  if (messages) facts.push(`- 発言 ${messages.toLocaleString('en-US')} 件${firstMs && lastMs ? ` (${day(firstMs).slice(0, 7)}〜${day(lastMs).slice(0, 7)})` : ''}`);
  if (entity.aliases.length) facts.push(`- 別の名前: ${entity.aliases.join('、')}`);
  return facts;
}

const chunked = (groups: Group[]): Group[][] => {
  const count = Math.ceil(groups.length / PART_MAX);
  const size = Math.ceil(groups.length / count);
  return Array.from({ length: count }, (_, i) => groups.slice(i * size, (i + 1) * size));
};

const periodOf = (groups: Group[]): string => {
  const a = day(groups[0]?.firstAt ?? 0).slice(0, 7);
  const b = day(groups.at(-1)?.lastAt ?? 0).slice(0, 7);
  return a === b ? a : `${a}〜${b}`;
};

/** entity の主張を、ページ (親 + 子) に分ける。純粋関数。 */
export function planBundles(entity: EntityInfo, groups: readonly Group[]): Bundle[] {
  if (groups.length === 0) return [];
  const sorted = [...groups].sort((a, b) => a.firstAt - b.firstAt || a.id - b.id);
  const base = {
    entityId: entity.id, kind: entity.kind === 'person' ? '人物' : 'もの', name: entity.name,
    firstAt: sorted[0]?.firstAt ?? 0, lastAt: Math.max(...sorted.map((g) => g.lastAt))
  };
  if (sorted.length <= SINGLE_MAX) {
    return [{ ...base, path: entity.path, facts: factsOf(entity), links: [], weight: groups.reduce((s, g) => s + g.n, 0), parts: [{ label: '全体', period: '', groups: sorted, level: 2 }] }];
  }
  const names = entity.kind === 'person' ? PERSON_GROUPS : THING_GROUPS;
  const bySection = new Map<string, Group[]>();
  for (const g of sorted) bySection.set(names[g.type], [...(bySection.get(names[g.type]) ?? []), g]);
  const bundles: Bundle[] = [];
  const small: Group[] = [];
  const links: string[] = [];
  for (const [section, list] of [...bySection].sort((a, b) => b[1].length - a[1].length)) {
    if (list.length < SUBPAGE_MIN) { small.push(...list); continue; }
    const parts = chunked(list).map((chunk, _, all) => ({ label: section, period: all.length > 1 ? periodOf(chunk) : '', groups: chunk, level: 3 as const }));
    const path = `${entity.path}/${section}`;
    links.push(`- [[${path}]] — ${section} (${list.length} 件)`);
    bundles.push({
      ...base, path, kind: `${base.kind}のうち「${section}」`, facts: [], links: [], parts, weight: list.reduce((s, g) => s + g.n, 0),
      firstAt: list[0]?.firstAt ?? 0, lastAt: Math.max(...list.map((g) => g.lastAt))
    });
  }
  // 親ページ: 小さい種類の全部 + 要の主張 (繰り返し言っているもの・新しいもの)
  const key = sorted.filter((g) => !small.includes(g)).sort((a, b) => b.n - a.n || b.lastAt - a.lastAt).slice(0, KEY_CLAIMS);
  const overview = [...small, ...key].sort((a, b) => a.firstAt - b.firstAt || a.id - b.id);
  bundles.unshift({
    ...base, path: entity.path, facts: factsOf(entity), links: links.length ? ['', '## 詳細', ...links] : [],
    weight: groups.reduce((s, g) => s + g.n, 0), parts: [{ label: '概要', period: '', groups: overview, level: 2 }]
  });
  return bundles;
}

// ---- プロンプト ---------------------------------------------------------------

export const composeSystem = `あなたは Discord サーバーの「記憶」の編集者です。ページ (人物・もの・話題) の本文を、検証済みの主張 (c) から書きます。

## 書き方
- 渡した主張だけを材料にする。主張に無いことを足さない。推測しない。
- 全ての主張を、どこかの文に入れる。似た主張は 1 文にまとめてよいが、細部 (数字・版・日付・固有名・但し書き・結末) は落とさない。短くまとめすぎない。分量の上限は無い。
- 各文の終わりに根拠の主張を [c12] の形で付ける (複数なら [c12][c15])。根拠の無い文は書かない。
- 見出しはページに合わせて付ける (人物なら「立場と意見」「人柄」「作ったもの・得意」「人間関係」「経緯」のように)。無理に埋めない。
- 日付のある主張は「2025-03 時点で〜」「以前は〜、2025-08 から〜」と書く。変化は上書きせず両方を日付つきで残す。
- ×N は N 回出てきた印 (繰り返し言っている・長く続いている)。「たびたび〜」「一貫して〜」と書いてよい。
- ※弱 は根拠が弱い。「〜と述べている」「〜らしい」の形で書く。伝聞 は「〜と言われている」の形。本人談 は本人が言ったこと。
- 他の人に触れるときは、主張の中の名前をそのまま使う。
- 簡潔な箇条書きと短い段落でよい。ログの写しにしない。

出力は JSON だけ。渡したページすべてについて書く:
{"pages":[{"path":"…","summary":"ページの 1 行説明 (40 字以内)","body":"…","aliases":["別名"]}]}`;

const MODALITY_MARK: Partial<Record<Modality, string>> = { hearsay: ' 伝聞', self_report: ' 本人談' };

export function claimLine(group: Group): string {
  const when = group.n > 1 ? `${day(group.firstAt)}〜${day(group.lastAt)} ×${group.n}` : day(group.firstAt);
  const attrs = Object.entries(group.attrs).map(([k, v]) => `${k}=${v}`).join(' ');
  return `[c${group.id}] ${when} ${group.hedged ? '※弱 ' : ''}${MODALITY_MARK[group.modality] ? `${MODALITY_MARK[group.modality]} ` : ''}${group.text}${attrs ? ` (${attrs})` : ''}`;
}

export const partKey = (bundle: Bundle, index: number): string => `${bundle.path}#${index}`;

export interface PartInput { bundle: Bundle; index: number; part: Part }

export function composeUser(inputs: readonly PartInput[], note = ''): string {
  const blocks = inputs.map(({ bundle, part }) => [
    `=== path: ${partPath(bundle, part)} (${bundle.kind}: ${bundle.name}${part.period ? ` / ${part.period}` : ''}) ===`,
    part.level === 3 ? `見出しは ${'#'.repeat(part.level)} から使う。ページ全体の題は付けない。` : '',
    ...part.groups.map(claimLine)
  ].filter(Boolean).join('\n'));
  return [...blocks, note].filter(Boolean).join('\n\n');
}

/** 出力の pages を引くためのパス。時期で割った部分は # 付きで区別する。 */
export const partPath = (bundle: Bundle, part: Part): string => (part.period ? `${bundle.path}#${part.period}` : bundle.path);

// ---- 出力の検査と本文の組み立て --------------------------------------------------

export interface PartOutput { summary: string; body: string; aliases: string[] }

export function normalizeCompose(json: unknown): Map<string, PartOutput> {
  if (!isRecord(json) || !Array.isArray(json.pages)) throw Object.assign(new Error('compose output has no pages'), { code: 'BAD_OUTPUT' });
  const out = new Map<string, PartOutput>();
  for (const raw of arrayOf(json.pages)) {
    if (!isRecord(raw) || typeof raw.path !== 'string' || typeof raw.body !== 'string') continue;
    out.set(raw.path.trim(), {
      summary: String(raw.summary ?? '').replace(/\s+/g, ' ').trim().slice(0, 80), body: raw.body.trim(),
      aliases: arrayOf(raw.aliases).filter((a): a is string => typeof a === 'string').map((a) => a.trim().slice(0, 40)).filter(Boolean).slice(0, 8)
    });
  }
  return out;
}

const CITE = /\[c(\d+)\]/g;
const tidyCites = (text: string): string => text
  .replace(/\[c(\d+)(?:\s*[,、・]\s*c?(\d+))+\]/g, (match) => [...match.matchAll(/\d+/g)].map((m) => `[c${m[0]}]`).join(''));

export interface Rendered { body: string; cited: Set<number>; dropped: number }

/**
 * モデルの本文を整える: 入力に無い [cN] は外し、根拠の無い文は捨てる (見出しと空行は残す)。
 * 引用の連なりの直後までを 1 つの文として扱う (箇条書きの 1 行は別々)。[cN] はあとで [eM] に直す。
 */
export function cleanBody(body: string, valid: ReadonlySet<number>): Rendered {
  const cited = new Set<number>();
  let dropped = 0;
  const lines: string[] = [];
  for (const rawLine of tidyCites(body).split('\n')) {
    const line = rawLine.replace(/\s+$/, '');
    if (!line.trim() || /^\s*#{1,6}\s/.test(line)) { lines.push(line); continue; }
    const prefix = line.match(/^(\s*(?:[-*・]|\d+[.)])\s+)/)?.[1] ?? '';
    const content = line.slice(prefix.length);
    // 引用の連なりの直後で区切る: 「A。[c1]B。[c2][c3]」→ 「A。[c1]」「B。[c2][c3]」。引用の無い末尾は捨てる
    const sentences = content.split(/(?<=\])(?=[^[\]])/).filter((s) => s.trim());
    const kept: string[] = [];
    for (const sentence of sentences) {
      const ids = [...sentence.matchAll(CITE)].map((m) => Number(m[1]));
      const good = ids.filter((id) => valid.has(id));
      if (good.length === 0) { dropped += 1; continue; }
      for (const id of good) cited.add(id);
      kept.push(sentence.replace(CITE, (match, id: string) => (valid.has(Number(id)) ? match : '')));
    }
    if (kept.length) lines.push(`${prefix}${kept.join('')}`);
  }
  return { body: lines.join('\n').replace(/\n{3,}/g, '\n\n').trim(), cited, dropped };
}

/** 主張を並べただけの本文 (モデルの出力が使えなかったとき・文に入らなかった主張の追記)。 */
export function mechanicalLines(groups: readonly Group[]): string[] {
  return groups.map((g) => `- ${g.hedged ? '(弱) ' : ''}${day(g.firstAt)}${g.n > 1 ? `〜${day(g.lastAt)}` : ''} ${g.text} [c${g.id}]`);
}

/** [c12] → 根拠の出来事 [e345]。出来事は最初の 2 つと最後の 1 つまで。 */
export function citeEpisodes(body: string, byId: ReadonlyMap<number, Group>): string {
  return body.replace(/(?:\[c\d+\])+/g, (run) => {
    const episodes: number[] = [];
    for (const m of run.matchAll(/\[c(\d+)\]/g)) {
      const group = byId.get(Number(m[1]));
      if (!group) continue;
      const list = group.episodes.length > 3 ? [group.episodes[0], group.episodes[1], group.episodes.at(-1)] : group.episodes;
      for (const id of list) if (id !== undefined && !episodes.includes(id)) episodes.push(id);
    }
    return episodes.map((id) => `[e${id}]`).join('');
  });
}

export interface PageResult { path: string; summary: string; body: string; aliases: string[]; cited: number; claims: number; source: 'compose' | 'mechanical' }

/** 1 ページぶん (bundle) の部分の出力を連ねて、完成した本文にする。 */
export function assemble(bundle: Bundle, outputs: ReadonlyMap<string, PartOutput | null>): PageResult {
  const byId = new Map<number, Group>();
  for (const part of bundle.parts) for (const g of part.groups) byId.set(g.id, g);
  const sections: string[] = [];
  const aliases: string[] = [];
  let summary = '';
  let cited = 0;
  let mechanical = 0;
  bundle.parts.forEach((part, index) => {
    const out = outputs.get(partKey(bundle, index)) ?? null;
    const valid = new Set(part.groups.map((g) => g.id));
    let text = '';
    if (out) {
      const clean = cleanBody(out.body, valid);
      const missing = part.groups.filter((g) => !clean.cited.has(g.id));
      cited += part.groups.length - missing.length;
      text = clean.body;
      if (missing.length) text += `${text ? '\n\n' : ''}${part.level === 3 ? '###' : '##'} 追記\n${mechanicalLines(missing).join('\n')}`;
      if (!summary && out.summary) summary = out.summary;
      aliases.push(...out.aliases);
    }
    if (!out || !text.trim()) {
      mechanical += 1;
      text = mechanicalLines(part.groups).join('\n');
      cited += 0;
    }
    sections.push(part.period ? `${'#'.repeat(part.level - 1)} ${part.period}\n${text}` : text);
  });
  const total = bundle.parts.reduce((s, p) => s + p.groups.length, 0);
  const body = [...(bundle.facts.length ? [bundle.facts.join('\n'), ''] : []), citeEpisodes(sections.join('\n\n'), byId), ...bundle.links].join('\n').trim();
  return {
    path: bundle.path, summary: summary || `${bundle.name} (${bundle.kind})`, body,
    aliases: [...new Set(aliases)].slice(0, 12), cited, claims: total, source: mechanical > 0 ? 'mechanical' : 'compose'
  };
}

export function claimTypes(): readonly ClaimType[] { return CLAIM_TYPES; }
