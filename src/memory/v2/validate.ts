import { memoryDb } from '../store.js';

// 検証と関門。構築した v2 の中身を数え、v1 と並べて、切り替えてよいかを機械で決める。
//   - 精度の関門 (話者・根拠・話の種類) は、Claude が付けた評価セット (labels.jsonl) を当てて測る (labelGates)
//   - 詳細さの関門は「v1 以上」を条件にする (薄くしない保証)
//   - 構造の関門: [eN] が全て実在 / 区間の完了率 / 未検証の割合 / 網羅 / 本文の無いページ

export interface Baseline {
  messages: number;
  episodes: number;
  pages: number;
  pagesWithBody: number;
  /** 人物ページの本文の長さの平均 */
  personBodyChars: number;
  episodesPerK: number;
}

export interface Gate { name: string; value: number | string; need: string; pass: boolean }

export interface Metrics {
  sections: Record<string, number>;
  messages: number;
  episodes: { total: number; wrong: number; weak: number; withOutcome: number };
  claims: { total: number; wrong: number; weak: number; unserious: number; withAttrs: number; unverified: number };
  entities: { people: number; things: number };
  pages: { total: number; withBody: number; mechanical: number; claims: number; cited: number; personBodyChars: number };
  coverage: { required: number; uncovered: number };
  cost: Record<string, number>;
  danglingCites: number;
}

const one = <T>(sql: string, ...params: unknown[]): T => memoryDb().prepare(sql).get(...params) as T;

/** v1 の DB (ファイル) から基準値を数える。発言数は引数 (アーカイブから数える)。 */
export function v1Baseline(guildId: string, v1Path: string, messages: number): Baseline {
  const d = memoryDb();
  d.exec(`ATTACH DATABASE '${v1Path.replace(/'/g, "''")}' AS v1`);
  try {
    const episodes = (d.prepare('SELECT COUNT(*) AS c FROM v1.episodes WHERE guild_id = ?').get(guildId) as { c: number }).c;
    const pages = (d.prepare("SELECT COUNT(*) AS c FROM v1.nodes WHERE guild_id = ? AND path <> ''").get(guildId) as { c: number }).c;
    const withBody = (d.prepare("SELECT COUNT(*) AS c FROM v1.nodes WHERE guild_id = ? AND path <> '' AND length(body) > 0").get(guildId) as { c: number }).c;
    const person = (d.prepare("SELECT AVG(length(body)) AS c FROM v1.nodes WHERE guild_id = ? AND path LIKE 'people/%' AND length(body) > 0").get(guildId) as { c: number | null }).c ?? 0;
    return { messages, episodes, pages, pagesWithBody: withBody, personBodyChars: person, episodesPerK: messages ? (episodes * 1000) / messages : 0 };
  } finally {
    d.exec('DETACH DATABASE v1');
  }
}

export function collect(guildId: string): Metrics {
  const d = memoryDb();
  const states = Object.fromEntries(d.prepare<[string], { state: string; c: number }>('SELECT state, COUNT(*) AS c FROM v2_sections WHERE guild_id = ? GROUP BY state')
    .all(guildId).map((row) => [row.state, row.c]));
  const messages = (d.prepare<[string], { c: number | null }>("SELECT SUM(messages) AS c FROM v2_sections WHERE guild_id = ? AND state IN ('done')").get(guildId)?.c) ?? 0;
  const ep = one<{ total: number; wrong: number; weak: number; outcome: number }>(
    "SELECT COUNT(*) AS total, SUM(verdict = 'wrong') AS wrong, SUM(verdict = 'weak') AS weak, SUM(outcome <> '') AS outcome FROM v2_episodes WHERE guild_id = ?", guildId);
  const cl = one<{ total: number; wrong: number; weak: number; unserious: number; attrs: number; unverified: number }>(
    `SELECT COUNT(*) AS total, SUM(verdict = 'wrong') AS wrong, SUM(verdict = 'weak') AS weak,
       SUM(modality IN ('joke', 'hypothetical', 'roleplay')) AS unserious, SUM(attrs <> '{}') AS attrs, SUM(note = 'unverified') AS unverified
     FROM v2_claims WHERE guild_id = ?`, guildId);
  const ent = one<{ people: number; things: number }>("SELECT SUM(kind = 'person') AS people, SUM(kind = 'thing') AS things FROM v2_entities WHERE guild_id = ?", guildId);
  const pg = one<{ total: number; body: number; mech: number; claims: number; cited: number }>(
    "SELECT COUNT(*) AS total, SUM(length(body) > 0) AS body, SUM(source = 'mechanical') AS mech, SUM(claims) AS claims, SUM(cited) AS cited FROM v2_pages WHERE guild_id = ? AND path <> ''", guildId);
  const person = one<{ c: number | null }>("SELECT AVG(length(body)) AS c FROM v2_pages WHERE guild_id = ? AND path LIKE 'people/%' AND length(body) > 0", guildId);
  let required = 0;
  let uncovered = 0;
  for (const row of d.prepare<[string], { error: string | null }>("SELECT error FROM v2_jobs WHERE guild_id = ? AND key LIKE 'cover:%'").all(guildId)) {
    try { const parsed = JSON.parse(row.error ?? '{}') as { required?: number; uncovered?: number }; required += parsed.required ?? 0; uncovered += parsed.uncovered ?? 0; } catch { /* 無視 */ }
  }
  const cost = Object.fromEntries(d.prepare<[string], { stage: string; c: number }>('SELECT stage, SUM(cost) AS c FROM v2_jobs WHERE guild_id = ? GROUP BY stage').all(guildId).map((row) => [row.stage, row.c]));
  // 本文の [eN] が、投影した出来事に実在するか
  const known = new Set(d.prepare<[string], { id: number }>('SELECT id FROM episodes WHERE guild_id = ?').all(guildId).map((row) => row.id));
  let dangling = 0;
  for (const row of d.prepare<[string], { body: string }>("SELECT body FROM nodes WHERE guild_id = ? AND body <> ''").all(guildId)) {
    for (const match of row.body.matchAll(/\[e(\d+)\]/g)) if (!known.has(Number(match[1]))) dangling += 1;
  }
  return {
    sections: states, messages,
    episodes: { total: ep.total, wrong: ep.wrong ?? 0, weak: ep.weak ?? 0, withOutcome: ep.outcome ?? 0 },
    claims: { total: cl.total, wrong: cl.wrong ?? 0, weak: cl.weak ?? 0, unserious: cl.unserious ?? 0, withAttrs: cl.attrs ?? 0, unverified: cl.unverified ?? 0 },
    entities: { people: ent.people ?? 0, things: ent.things ?? 0 },
    pages: { total: pg.total, withBody: pg.body ?? 0, mechanical: pg.mech ?? 0, claims: pg.claims ?? 0, cited: pg.cited ?? 0, personBodyChars: person.c ?? 0 },
    coverage: { required, uncovered }, cost, danglingCites: dangling
  };
}

const pct = (a: number, b: number): number => (b ? Math.round((1000 * a) / b) / 10 : 0);

/** 構造と詳細さの関門。baseline があれば「v1 以上」も見る。 */
export function gates(m: Metrics, baseline: Baseline | null): Gate[] {
  const done = m.sections.done ?? 0;
  const open = (m.sections.pending ?? 0) + (m.sections.extracted ?? 0) + (m.sections.failed ?? 0);
  const usableEpisodes = m.episodes.total - m.episodes.wrong;
  const perK = m.messages ? (usableEpisodes * 1000) / m.messages : 0;
  const out: Gate[] = [
    { name: '区間の完了率', value: `${pct(done, done + open)}%`, need: '98% 以上', pass: done + open === 0 || done / (done + open) >= 0.98 },
    ...(m.cost.verify === undefined ? [] : [{ name: '未検証の主張', value: `${pct(m.claims.unverified, m.claims.total)}%`, need: '2% 未満', pass: m.claims.total === 0 || m.claims.unverified / m.claims.total < 0.02 }]),
    { name: '会話単位の網羅', value: `${pct(m.coverage.required - m.coverage.uncovered, m.coverage.required)}%`, need: '98% 以上', pass: m.coverage.required === 0 || 1 - m.coverage.uncovered / m.coverage.required >= 0.98 },
    { name: '本文の無いページ', value: m.pages.total - m.pages.withBody, need: '0', pass: m.pages.withBody === m.pages.total },
    { name: '主張を並べただけのページ (組み立て失敗)', value: `${pct(m.pages.mechanical, m.pages.total)}%`, need: '5% 以下', pass: m.pages.total === 0 || m.pages.mechanical / m.pages.total <= 0.05 },
    { name: '[eN] が実在しない引用', value: m.danglingCites, need: '0', pass: m.danglingCites === 0 },
    { name: '出来事の結末 (outcome) の記入率', value: `${pct(m.episodes.withOutcome, m.episodes.total)}%`, need: '30% 以上', pass: m.episodes.total === 0 || m.episodes.withOutcome / m.episodes.total >= 0.3 },
    { name: '数字・版・日付 (attrs) を持つ主張', value: `${pct(m.claims.withAttrs, m.claims.total)}%`, need: '5% 以上', pass: m.claims.total === 0 || m.claims.withAttrs / m.claims.total >= 0.05 }
  ];
  if (baseline) {
    const pagesBody = m.pages.total ? m.pages.withBody / m.pages.total : 0;
    out.push(
      { name: '出来事 / 千発言 (v1 以上)', value: `${perK.toFixed(1)} (v1 ${baseline.episodesPerK.toFixed(1)})`, need: 'v1 以上', pass: perK >= baseline.episodesPerK },
      { name: '本文を持つページの割合 (v1 以上)', value: `${pct(m.pages.withBody, m.pages.total)}% (v1 ${pct(baseline.pagesWithBody, baseline.pages)}%)`, need: 'v1 以上', pass: pagesBody >= baseline.pagesWithBody / Math.max(1, baseline.pages) },
      { name: '人物ページの本文の長さ (v1 の 90% 以上)', value: `${Math.round(m.pages.personBodyChars)} 字 (v1 ${Math.round(baseline.personBodyChars)} 字)`, need: 'v1 の 90% 以上', pass: m.pages.personBodyChars >= baseline.personBodyChars * 0.9 }
    );
  }
  return out;
}

/** Claude が付けた正解 (1 主張につき 1 行)。support は根拠が内容を支えるか、speaker は主体が合っているか、modality は正しい話の種類。 */
export interface LabelRow { id: string; support: 'ok' | 'weak' | 'wrong'; speaker: boolean; modality: string }
/** v2 の判定 (labelpack の key.jsonl)。 */
export interface KeyRow { id: string; verdict: 'ok' | 'weak' | 'wrong'; modality: string; speakerOk?: boolean }

export interface LabelScore {
  n: number;
  /** v2 が ok とした主張のうち、正解も ok の割合 */
  okPrecision: number;
  /** v2 が使うとした (ok / weak) 主張のうち、正解が wrong でない割合 */
  usablePrecision: number;
  /** v2 が使うとした主張のうち、主体が合っている割合 */
  speakerAccuracy: number;
  /** v2 が使うとした主張のうち、話の種類が正解と一致する割合 (6 種類) */
  modalityExact: number;
  /** 〃 まじめ (plain / self_report / hearsay) か 冗談・仮定・ごっこ かの 2 値で一致する割合 */
  modalityBinary: number;
  /** v2 が wrong とした主張のうち、正解も wrong の割合 */
  wrongPrecision: number;
  /** 正解が wrong の主張のうち、v2 が wrong とした割合 */
  wrongRecall: number;
  counts: { v2ok: number; v2weak: number; v2wrong: number; labelWrong: number };
}

const rate = (a: number, b: number): number => (b ? Math.round((1000 * a) / b) / 10 : 100);
const serious = (modality: string): boolean => ['plain', 'self_report', 'hearsay'].includes(modality);

export function scoreLabels(labels: readonly LabelRow[], key: readonly KeyRow[]): LabelScore {
  const byId = new Map(key.map((row) => [row.id, row]));
  const paired = labels.flatMap((label) => { const k = byId.get(label.id); return k ? [{ label, k }] : []; });
  const ok = paired.filter((p) => p.k.verdict === 'ok');
  const used = paired.filter((p) => p.k.verdict !== 'wrong');
  const wrong = paired.filter((p) => p.k.verdict === 'wrong');
  const labelWrong = paired.filter((p) => p.label.support === 'wrong');
  return {
    n: paired.length,
    okPrecision: rate(ok.filter((p) => p.label.support === 'ok').length, ok.length),
    usablePrecision: rate(used.filter((p) => p.label.support !== 'wrong').length, used.length),
    speakerAccuracy: rate(used.filter((p) => p.label.speaker && p.k.speakerOk !== false).length, used.length),
    modalityExact: rate(used.filter((p) => p.k.modality === p.label.modality).length, used.length),
    modalityBinary: rate(used.filter((p) => serious(p.k.modality) === serious(p.label.modality)).length, used.length),
    wrongPrecision: rate(wrong.filter((p) => p.label.support === 'wrong').length, wrong.length),
    wrongRecall: rate(labelWrong.filter((p) => p.k.verdict === 'wrong').length, labelWrong.length),
    counts: { v2ok: ok.length, v2weak: used.length - ok.length, v2wrong: wrong.length, labelWrong: labelWrong.length }
  };
}

/** 評価セットの関門: 話者 97% / 根拠 92% / 話の種類 (まじめか否か) 95%。 */
export function labelGates(score: LabelScore): Gate[] {
  return [
    { name: '話者の帰属 (使う主張のうち主体が合う)', value: `${score.speakerAccuracy}%`, need: '97% 以上', pass: score.speakerAccuracy >= 97 },
    { name: '根拠に支えられる (ok とした主張のうち正解も ok)', value: `${score.okPrecision}% (${score.counts.v2ok} 件)`, need: '92% 以上', pass: score.okPrecision >= 92 },
    { name: '話の種類 (まじめか冗談・仮定・ごっこか)', value: `${score.modalityBinary}% (6 種類の一致 ${score.modalityExact}%)`, need: '95% 以上', pass: score.modalityBinary >= 95 }
  ];
}
