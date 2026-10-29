// 記憶 v2 の型と定数。設計は docs/memory-v2.md。
//
// 事実 (話者・日時・原文) は機械が行番号から決め、モデルは行番号を指すだけ。
// 人物は author_id で決める (台本では発言者コード A1, A2… で見せる)。

export const CLAIM_TYPES = ['stance', 'trait', 'skill', 'relation', 'fact', 'definition', 'outcome'] as const;
export type ClaimType = (typeof CLAIM_TYPES)[number];

/** 話の種類。plain 以外は、その人の性格・立場として書かない (出来事の中にだけ残す)。 */
export const MODALITIES = ['plain', 'self_report', 'hearsay', 'joke', 'hypothetical', 'roleplay'] as const;
export type Modality = (typeof MODALITIES)[number];
/** ページの性格・立場・得意として使えない話の種類。 */
export const UNSERIOUS: readonly Modality[] = ['joke', 'hypothetical', 'roleplay'];

export const VERDICTS = ['ok', 'weak', 'wrong'] as const;
export type Verdict = (typeof VERDICTS)[number];

/** 人物以外のページの最上位。 */
export const CATEGORIES = ['projects', 'topics', 'events', 'debates', 'culture', 'server', 'others'] as const;
export type Category = (typeof CATEGORIES)[number];

export const EPISODE_KINDS = ['レスバ', '議論', 'ネタ', '名言', '事件', '決定', '告知', '近況', '技術', '企画', '雑談', '相談', 'その他'] as const;

/** 台本の 1 行。まとめた行は複数の発言 ID を持つ (話者は必ず 1 人)。 */
export interface LineInfo {
  ids: string[];
  authorId: string;
  code: string;
  firstMs: number;
  lastMs: number;
  /** 属する会話単位 (c1, c2…) */
  conv: string;
}

export interface UnitInfo {
  conv: string;
  fromLine: number;
  toLine: number;
  messages: number;
  fromMs: number;
  toMs: number;
}

/** 区間 (1 回の読み取りの単位) の範囲。アーカイブの同じ範囲から、いつでも同じ台本を作れる。 */
export interface SectionRange {
  channelId: string;
  fromId: string;
  toId: string;
  fromMs: number;
  toMs: number;
  messages: number;
  chars: number;
}

export interface RenderedSection {
  range: SectionRange;
  label: string;
  /** モデルに渡す台本 (凡例を含む) */
  text: string;
  lines: Map<number, LineInfo>;
  units: UnitInfo[];
  /** author_id → 発言者コード */
  codes: Map<string, string>;
  /** 発言者コード → author_id */
  authors: Map<string, string>;
  /** 発言者コード → 台本の凡例と同じ表示名 (同名の人は author_id の末尾で見分けてある) */
  labels: Map<string, string>;
  lineEnd: number;
}

// ---- モデルの出力 (まだ確かめていない) → 検査済みの形 ----------------------------

export interface ClaimDraft {
  /** 発言者コード (A3) か、人物以外のページ名 */
  about: string;
  /** about が発言者コードなら person、そうでなければ名前 */
  aboutKind: 'person' | 'thing';
  /** 人物以外のときの最上位 */
  category: Category;
  text: string;
  type: ClaimType;
  modality: Modality;
  attrs: Record<string, string>;
  lines: number[];
  /** 同じ出力の episodes の添字 */
  episode: number | null;
}

export interface EpisodeDraft {
  conv: string | null;
  kind: string;
  title: string;
  summary: string;
  outcome: string;
  lines: number[];
  quotes: number[];
  /** 関わった発言者コード・ページ名 */
  entities: string[];
  related: number[];
  importance: number;
}

export interface ExtractResult {
  episodes: EpisodeDraft[];
  claims: ClaimDraft[];
  skips: { conv: string; reason: string }[];
  dropped: Record<string, number>;
}

export interface VerifyItem {
  /** e0, c3 のような、出力の中の通し番号 */
  id: string;
  verdict: Verdict;
  /** 話者・当事者の取り違えではないか */
  speakerOk: boolean;
  modality: Modality | null;
  note: string;
}
