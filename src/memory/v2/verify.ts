import { getState, memoryDb } from '../store.js';
import { arrayOf, isRecord } from '../types.js';
import { MODALITIES, VERDICTS, type Modality, type RenderedSection, type Verdict, type VerifyItem } from './types.js';

// S2 検証。抽出とは別のモデルが、区間の台本と出来事・主張を並べて「根拠の行に照らして正しいか」を判定する。
//
// 検証は削るための道具ではなく、降格の道具:
//   wrong → ページに使わない (出来事の一覧にも出さない。記録は残す)
//   weak  → 残して hedged にする (「〜と述べている」の形で書く)
//   modality が冗談・仮定・ごっこに直ったもの → 出来事の中にだけ残し、性格・立場のページには使わない
// wrong の適合率が低いと分かったら (validate)、policy で wrong も weak に降格できる。

export interface VerifyPolicy { wrongAsWeak: boolean }

export function verifyPolicy(): VerifyPolicy {
  const saved = getState('v2:verify-policy');
  return { wrongAsWeak: isRecord(saved) && saved.wrongAsWeak === true };
}

export const VERIFY_BATCH = Number(process.env.MEMORY_V2_VERIFY_BATCH || 120);

export const verifySystem = `あなたは Discord サーバーの「記憶」の検証係です。記録係が台本から作った出来事 (e) と主張 (c) が、根拠の行に照らして正しいかを 1 つずつ判定します。

## 判定 (v)
- ok: 根拠の行 (と前後の文脈) がその内容を支えている。言い換え・要約はよい
- weak: 根拠はあるが、言い過ぎ・断定しすぎ・一部しか支えない・当事者や数字があいまい
- wrong: 根拠に無い・逆の内容・別の人の発言・取り違え・台本に無い数字や固有名

## 見るところ
- 話者: 各項目には、根拠の行ごとの話者が 「271(A17)」の形で併記してある。これを正とし、台本から話者のコードを自分で読み直さない。
  「X は〜」「X が〜と言った・している」の X が、併記された話者と違うのに、X 本人の発言・行動として書いてあれば sp:false (誰かが X について語った伝聞なら、話者が X と違ってよい)
- 頻度・習慣の語 (よく・いつも・口癖・癖・常連・定番・〜しがち) は、根拠が 1 回の発言だけなら言い過ぎ (weak)
- 台本に無い固有名・数字・理由で補っていないか (補っていれば weak か wrong)
- 仮定・提案・予定 (〜したい・〜しよう・〜するつもり・〜できそう) を、した・している・持っている、と書いていないか
- 話の種類 (mod): 根拠が冗談・皮肉・煽り・仮定・予想・ごっこ遊びなら、plain や self_report にしない。正しい種類 (plain / self_report / hearsay / joke / hypothetical / roleplay) を mod に書く。合っていれば mod は省く
- 数字・日付・版・固有名が台本と合っているか
- 出来事は、summary と outcome に書いてあることすべてが lines とその周辺で裏づくか (台本に無いことが混ざっていたら weak か wrong)
- 台本を自分で読み直して判断する。記録係の言葉を鵜呑みにしない。ただし、台本のとおりなら迷わず ok にする (厳しすぎも不可)

出力は JSON だけ。全ての項目について 1 つずつ返す:
{"items":[{"id":"e3","v":"ok"},{"id":"c12","v":"weak","note":"一部だけ"},{"id":"c15","v":"wrong","sp":false,"note":"言ったのは A3"},{"id":"c20","v":"ok","mod":"joke"}]}`;

export interface VerifySubject {
  /** e3 / c12 */
  id: string;
  line: string;
}

interface EpisodeRow { id: number; ord: number; kind: string; title: string; summary: string; outcome: string }
interface ClaimRow { id: number; ord: number; about_kind: string; about_key: string; text: string; type: string; modality: string; attrs: string }

/** 区間の出来事・主張を、検証に出す 1 行ずつにする。 */
export function subjectsOf(sectionId: number, section: RenderedSection): VerifySubject[] {
  const d = memoryDb();
  const lineOf = new Map<string, number>();
  for (const [n, info] of section.lines) for (const id of info.ids) lineOf.set(id, n);
  // 根拠の行は話者つき (271(A17))。モデルに台本からコードを読み取らせない
  const linesOf = (ids: readonly string[]): string => [...new Set(ids.map((id) => lineOf.get(id)).filter((n): n is number => n !== undefined))]
    .sort((a, b) => a - b).map((n) => `${n}(${section.lines.get(n)?.code ?? '?'})`).join(',');
  const subjects: VerifySubject[] = [];
  const messages = d.prepare<[number], { message_id: string }>('SELECT message_id FROM v2_episode_messages WHERE episode_id = ? ORDER BY message_id');
  for (const ep of d.prepare<[number], EpisodeRow>('SELECT id, ord, kind, title, summary, outcome FROM v2_episodes WHERE section_id = ? ORDER BY ord').all(sectionId)) {
    const lines = linesOf(messages.all(ep.id).map((row) => row.message_id));
    subjects.push({ id: `e${ep.ord}`, line: `e${ep.ord} | ${ep.kind} | 「${ep.title}」 ${ep.summary}${ep.outcome ? ` 結末: ${ep.outcome}` : ''} | 根拠: ${lines}` });
  }
  const evidence = d.prepare<[number], { message_id: string }>('SELECT message_id FROM v2_claim_evidence WHERE claim_id = ? ORDER BY message_id');
  for (const claim of d.prepare<[number], ClaimRow>('SELECT id, ord, about_kind, about_key, text, type, modality, attrs FROM v2_claims WHERE section_id = ? ORDER BY ord').all(sectionId)) {
    const about = claim.about_kind === 'person' ? `${section.codes.get(claim.about_key) ?? '?'}(${section.labels.get(section.codes.get(claim.about_key) ?? '') ?? ''})` : claim.about_key;
    const attrs = Object.entries(JSON.parse(claim.attrs) as Record<string, string>).map(([k, v]) => `${k}=${v}`).join(' ');
    subjects.push({
      id: `c${claim.ord}`,
      line: `c${claim.ord} | ${about} | ${claim.type}/${claim.modality} | ${claim.text}${attrs ? ` [${attrs}]` : ''} | 根拠: ${linesOf(evidence.all(claim.id).map((row) => row.message_id))}`
    });
  }
  return subjects;
}

export const verifyUser = (section: RenderedSection, subjects: readonly VerifySubject[]): string =>
  [`区間: ${section.label}`, section.text, '---', '検証する項目 (id | 内容 | 根拠の行):', ...subjects.map((subject) => subject.line)].join('\n');

const isVerdict = (value: unknown): value is Verdict => (VERDICTS as readonly unknown[]).includes(value);
const isModality = (value: unknown): value is Modality => (MODALITIES as readonly unknown[]).includes(value);

/** モデルの出力を読む。id が項目に無いものは捨てる。 */
export function normalizeVerify(json: unknown, ids: ReadonlySet<string>): Map<string, VerifyItem> {
  if (!isRecord(json) || !Array.isArray(json.items)) throw Object.assign(new Error('verify output has no items'), { code: 'BAD_OUTPUT' });
  const items = new Map<string, VerifyItem>();
  for (const raw of arrayOf(json.items)) {
    if (!isRecord(raw)) continue;
    const id = String(raw.id ?? '').trim();
    if (!ids.has(id) || !isVerdict(raw.v)) continue;
    items.set(id, {
      id, verdict: raw.v, speakerOk: raw.sp !== false,
      modality: isModality(raw.mod) ? raw.mod : null, note: String(raw.note ?? '').replace(/\s+/g, ' ').trim().slice(0, 160)
    });
  }
  return items;
}

/** 項目の 9 割以上に判定が付いていること (抜けが多い出力は読み直す)。 */
export function checkVerify(ids: ReadonlySet<string>, json: unknown): void {
  const items = normalizeVerify(json, ids);
  if (ids.size >= 5 && items.size < ids.size * 0.9) {
    throw Object.assign(new Error(`verify output covered ${items.size}/${ids.size}`), { code: 'BAD_OUTPUT' });
  }
}

export interface VerifyStats { ok: number; weak: number; wrong: number; unverified: number; remodalized: number; speaker: number }

/** 判定を保存する。判定の無い項目は ok のまま note='unverified' にする。 */
export function applyVerify(sectionId: number, judgments: ReadonlyMap<string, VerifyItem>, policy: VerifyPolicy = verifyPolicy()): VerifyStats {
  const d = memoryDb();
  const stats: VerifyStats = { ok: 0, weak: 0, wrong: 0, unverified: 0, remodalized: 0, speaker: 0 };
  const episode = d.prepare('UPDATE v2_episodes SET verdict = ?, hedged = ?, note = ? WHERE section_id = ? AND ord = ?');
  const claim = d.prepare('UPDATE v2_claims SET verdict = ?, hedged = ?, note = ?, modality = COALESCE(?, modality) WHERE section_id = ? AND ord = ?');
  const modalityOf = d.prepare<[number, number], { modality: string }>('SELECT modality FROM v2_claims WHERE section_id = ? AND ord = ?');
  const all = [
    ...d.prepare<[number], { ord: number }>('SELECT ord FROM v2_episodes WHERE section_id = ?').all(sectionId).map((row) => `e${row.ord}`),
    ...d.prepare<[number], { ord: number }>('SELECT ord FROM v2_claims WHERE section_id = ?').all(sectionId).map((row) => `c${row.ord}`)
  ];
  d.transaction(() => {
    for (const id of all) {
      const item = judgments.get(id);
      const ord = Number(id.slice(1));
      let verdict: Verdict = item?.verdict ?? 'ok';
      let note = item?.note ?? (item ? '' : 'unverified');
      if (!item) stats.unverified += 1;
      if (item && !item.speakerOk) { verdict = 'wrong'; note = `speaker: ${note}`.slice(0, 160); stats.speaker += 1; }
      if (verdict === 'wrong' && policy.wrongAsWeak) verdict = 'weak';
      stats[verdict] += 1;
      const hedged = verdict === 'weak' ? 1 : 0;
      if (id.startsWith('e')) {
        episode.run(verdict, hedged, note, sectionId, ord);
      } else {
        const before = modalityOf.get(sectionId, ord)?.modality;
        const next = item?.modality && item.modality !== before ? item.modality : null;
        if (next) stats.remodalized += 1;
        claim.run(verdict, hedged, note, next, sectionId, ord);
      }
    }
  })();
  return stats;
}
