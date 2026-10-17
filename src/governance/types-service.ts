// 統治モジュール後半 (service / llm / discord / intake / ux / tools / commands) が使う型と型ガード。
//
// SQLite の行・憲法の実行規則・成立法令の型は db.ts / rules.ts / policy.ts と types.ts が持ち主で、
// ここでは写さない (各ファイルが types.ts から直接 import する)。ここに置くのは、後半だけが使う
// 席 (LLM) の出力・Discord へ出すもの・調査ツール・受付の型と、プロセスの外から来た値
// (LLM の出力・JSON 列) を確かめる型ガードだけ。
// ガードは宣言した列をすべて実際に確かめる (宣言と確認がずれないよう schema から型を作る)。
import type {
  ActionRowBuilder,
  AnyThreadChannel,
  APIInteractionGuildMember,
  AttachmentPayload,
  ButtonBuilder,
  ChatInputCommandInteraction,
  Guild,
  GuildForumTag,
  GuildForumThreadCreateOptions,
  GuildMember,
  Message,
  MessageComponentInteraction,
  MessageMentionOptions,
  ModalSubmitInteraction,
  OverwriteType,
  PermissionFlagsBits,
  SlashCommandBuilder,
  TextChannel,
  User
} from 'discord.js';
import type { AgentRequest } from '../ai/runtime.js';
import type { NotificationDescriptor } from './notifications.js';
import type {
  ActivityMessage,
  AdministrativeAct,
  CaseRecord,
  Constitution,
  ConstitutionPolicy,
  GovernanceRules,
  Institution,
  Law,
  LegalProcedure,
  Panel,
  ProcedureState,
  Sanction,
  WorkflowKey
} from './types.js';

export type Guard<T> = (value: unknown) => value is T;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export const isString = (value: unknown): value is string => typeof value === 'string';
export const isNumber = (value: unknown): value is number => typeof value === 'number';
export const isBoolean = (value: unknown): value is boolean => typeof value === 'boolean';
export const isUnknown = (_value: unknown): _value is unknown => true;

/** null も許す。 */
export function nullable<T>(guard: Guard<T>): Guard<T | null> {
  return (value: unknown): value is T | null => value === null || guard(value);
}

/** 列が無い (古い行・省略された JSON キー) か null も許す。 */
export function optional<T>(guard: Guard<T>): Guard<T | null | undefined> {
  return (value: unknown): value is T | null | undefined => value === null || value === undefined || guard(value);
}

export function arrayOf<T>(guard: Guard<T>): Guard<T[]> {
  return (value: unknown): value is T[] => Array.isArray(value) && value.every((entry) => guard(entry));
}

export function oneOf<const T extends readonly string[]>(values: T): Guard<T[number]> {
  return (value: unknown): value is T[number] => typeof value === 'string' && values.includes(value);
}

export const isStringArray = arrayOf(isString);

type Schema = { readonly [key: string]: Guard<unknown> };
type GuardType<G> = G extends Guard<infer T> ? T : never;
// undefined を受け付けるガードの列は、無くてもよい (省略可能な) キーにする。
type OptionalKeys<S extends Schema> = { [K in keyof S]-?: undefined extends GuardType<S[K]> ? K : never }[keyof S];
type RequiredKeys<S extends Schema> = Exclude<keyof S, OptionalKeys<S>>;
type Simplify<T> = { [K in keyof T]: T[K] } & {};
export type Shape<S extends Schema> = Simplify<
  { -readonly [K in RequiredKeys<S>]: GuardType<S[K]> } & { -readonly [K in OptionalKeys<S>]?: GuardType<S[K]> }
>;

/** schema の各キーをガードで確かめる。宣言していない列はそのまま残す (使わない)。 */
export function shape<S extends Schema>(schema: S): Guard<Shape<S>> {
  const entries = Object.entries(schema);
  return (value: unknown): value is Shape<S> => isRecord(value) && entries.every(([key, guard]) => guard(value[key]));
}

/** 無い (null / undefined) は null。あるのに形が違えば黙って捨てず例外にする。 */
export function narrow<T>(value: unknown, guard: Guard<T>, name: string): T | null {
  if (value === null || value === undefined) return null;
  if (guard(value)) return value;
  throw new TypeError(`統治データ ${name} の形が想定と違います。`);
}

export function narrowList<T>(value: unknown, guard: Guard<T>, name: string): T[] {
  if (!Array.isArray(value)) throw new TypeError(`統治データ ${name} の一覧が配列ではありません。`);
  const rows: T[] = [];
  for (const entry of value) {
    if (!guard(entry)) throw new TypeError(`統治データ ${name} の形が想定と違います。`);
    rows.push(entry);
  }
  return rows;
}

/** 書き込み直後の読み戻しなど、行が必ずある場面。無ければ例外にする。 */
export function narrowRequired<T>(value: unknown, guard: Guard<T>, name: string): T {
  const narrowed = narrow(value, guard, name);
  if (narrowed === null) throw new Error(`統治データ ${name} が見つかりません。`);
  return narrowed;
}

/** 例外に付いた message を取り出す (Error 以外が投げられても文字列にする)。 */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (isRecord(error) && typeof error['message'] === 'string') return error['message'];
  return String(error);
}

/** Discord API の例外 code (数値) を読む。 */
export function errorCode(error: unknown): number {
  return isRecord(error) ? Number(error['code']) : Number.NaN;
}

// 事件の verdict 列 (JSON)。db.ts は中身を unknown のまま返すので、読む側がここで形を確かめる。
const caseVerdictSchema = {
  verdict: optional(isString),
  phase: optional(isString),
  sanction: isUnknown
} as const;
export const isCaseVerdict = shape(caseVerdictSchema);

/** 回数枠の予約結果。scope は呼び出し側で付ける。 */
export interface GovernanceReservation {
  ok: boolean;
  governed?: boolean;
  trusted?: boolean;
  used?: number | null | undefined;
  limit?: number | null | undefined;
  retryAt?: number | null | undefined;
  reason?: string | null | undefined;
  scope?: 'sanction' | 'attempt' | 'constitutional_challenge';
}

// ---- 席 (LLM) の出力 ----

/** 違憲審査の席ひとつぶんの結論 (llm.ts が検算して返す)。 */
export interface ConstitutionalSeatOutput {
  verdict: 'constitutional' | 'unconstitutional' | 'insufficient';
  reasons: string[];
  constitutionArticles: string[];
}

/** 処分の中身 (席の結論・事件の原処分)。 */
const sanctionChoiceSchema = {
  type: isString,
  durationSeconds: optional(isNumber),
  definitionCode: optional(isString)
} as const;
export const isSanctionChoice = shape(sanctionChoiceSchema);
export type SanctionChoice = Shape<typeof sanctionChoiceSchema>;

/** 事件へ提出する証拠。受付が Discord から取り直した投稿 (ValidatedEvidence) でも、保存した受付の証拠でもよい。 */
const caseEvidenceSubmissionSchema = {
  content: isString,
  messageId: optional(isString),
  channelId: optional(isString),
  authorId: optional(isString),
  occurredAt: optional(isNumber),
  conversation: isUnknown
} as const;
export const isCaseEvidenceSubmission = shape(caseEvidenceSubmissionSchema);
export type CaseEvidenceSubmission = Shape<typeof caseEvidenceSubmissionSchema>;

export interface ElementFinding {
  element: string;
  proved: boolean;
  evidenceIds: number[];
  reason: string;
}

/** 裁判・警察の席ひとつぶんの結論。 */
export interface JudicialSeatOutput {
  verdict: 'responsible' | 'not_responsible' | 'insufficient';
  lawId: number;
  offenseCode: string;
  evidenceIds: number[];
  elementFindings: ElementFinding[];
  reasons: string[];
  sanction: SanctionChoice | null;
  newRecordIds: string[];
}

/** 国会の席ひとつぶんの結論。 */
export interface AgendaDecision {
  decision: 'legislate' | 'defer' | 'reject';
  relation: 'new' | 'amend_law' | 'amend_constitution' | null;
  targetType: string | null;
  targetId: string | null;
  instruction: string | null;
  question: string | null;
  reasons: string[];
}

/** 国会が改正対象として示した候補 (法律・憲法)。 */
export interface AgendaCandidate {
  type: string;
  id: string | number;
}

export interface DraftArticle {
  code: string;
  text: string;
}

export interface DraftSanction {
  type: string;
  maximumSeconds?: number;
  definitionCode?: string;
}

export interface DraftOffense {
  code: string;
  title: string;
  elements: string[];
  sanctions: DraftSanction[];
  automaticTrigger?: { type: unknown; minimumMessages: unknown; windowSeconds: unknown };
}

export interface DraftSanctionDefinition {
  code: string;
  title: string;
  maximumDurationSeconds: number;
  rules: unknown;
}

/** 起草した法案。条文と実行可能な定義の両方を持つ。 */
export interface DraftBill {
  title: string;
  summary: string;
  text: string;
  provisions: {
    articles: DraftArticle[];
    offenses: DraftOffense[];
    sanctionDefinitions: DraftSanctionDefinition[];
    governance?: unknown;
  };
}

export interface DraftAmendment {
  title: string;
  summary: string;
  content: string;
  policy: unknown;
  rules: unknown;
  rulesHash: string;
  sourceFormat: string;
}

/** @通報 の手続上の依頼をまとめたもの。権限は無く、受付の下書きにすぎない。 */
export interface JudicialIntake {
  intent: 'criminal_case' | 'constitutional_challenge' | 'evidence' | 'appeal' | 'case_status' | 'information' | 'unclear';
  summary: string | null;
  lawId: number | null;
  offenseCode: string | null;
  targetType: string | null;
  targetId: number | null;
  caseId: number | null;
  question: string | null;
}

export interface ScreeningElement {
  element: string;
  messageIds: string[];
  reason: string;
}

export interface ScreeningCandidate {
  accusedId: string;
  lawId: number;
  offenseCode: string;
  summary: string;
  elementEvidence: ScreeningElement[];
  reasons: string[];
}

/** 席の多数が独立に支持した事件化の候補。 */
export interface ScreeningConsensus {
  accusedId: string;
  lawId: number;
  offenseCode: string;
  summary: string;
  elementEvidence: { element: string; supportingSeats: number; messageIds: string[]; reasons: string[] }[];
  evidenceMessageIds: string[];
  reasons: string[];
  supportingSeats: number;
}

export interface ScreeningPanel {
  outputs: { candidates: ScreeningCandidate[] }[];
  traces: SeatTrace[];
  failedSeats: number;
  required: number;
  maximumSteps: number;
  retrieved: Map<string, RetrievedRecord>;
  candidates: ScreeningConsensus[];
}

export interface JudicialPanel {
  panelId: string;
  outputs: JudicialSeatOutput[];
  traces: SeatTrace[];
  failedSeats: number;
  maximumSteps: number;
  newEvidence: RetrievedRecord[];
  verdict: 'responsible' | 'not_responsible';
  sanction: SanctionChoice | null;
}

export interface ConstitutionalPanel {
  panelId: string;
  outputs: ConstitutionalSeatOutput[];
  seats: number;
  failedSeats: number;
}

/** 調査ツールが返した記録のうち、席が引用できる完全な行。 */
export interface RetrievedRecord {
  messageId: string;
  channelId: string;
  authorId: string;
  content: string;
  contentHash: string;
  occurredAt: number;
  source?: unknown;
}

/** 調査の1手。governance_investigation_steps へ残し、要約をスレへ出す。 */
export interface InvestigationStep {
  step: number;
  tool: string;
  arguments: unknown;
  count: number;
  detail: string;
  error: string | null;
  result?: unknown;
}

export interface SeatTrace {
  seat: number;
  trace: InvestigationStep[];
}


/** 必ずある値 (実行規則の参照先など)。無ければ例外にする。 */
export function requireValue<T>(value: T | null | undefined, message: string): T {
  if (value === null || value === undefined) throw new Error(message);
  return value;
}

/** 外から来た値が文字列でなければ例外にする。 */
export function requireText(value: unknown, message: string): string {
  if (typeof value !== 'string') throw new Error(message);
  return value;
}

/** 書き込み直後の読み戻しなど、行が必ずある場面。無ければ何の行かを名指して例外にする。 */
export function requireRow<T>(row: T | null | undefined, name: string): T {
  return requireValue(row, `統治データ ${name} が見つかりません。`);
}

// ---- Discord へ出すもの (discord.ts) ----

/** 公開性に必要な権限 overwrite。allow/deny は PermissionFlagsBits の値。 */
export interface RequiredOverwrite {
  id: string;
  type?: OverwriteType;
  allow?: bigint[];
  deny?: bigint[];
}

/** 処分を Discord へ反映した結果。outbox が execution_detail として保存する。 */
export interface SanctionExecutionDetail {
  type?: string;
  shadow?: boolean;
  delivered?: boolean;
  remainingSeconds?: number;
  creditedSeconds?: number;
  definitionCode?: string;
  reason?: string;
  fallbackChannelIds?: string[];
  effectReceipt?: { type: string | undefined; targetHash: string; actionId: number; completedAt: number };
}

// ---- 調査ツール (tools.ts) ----

/** 席が渡したツール引数 (JSON object)。値はすべて未検証。 */
export type ToolArgs = Record<string, unknown>;

export interface ToolParameters {
  type: 'object';
  properties: Record<string, { type: string; description: string }>;
  required: string[];
}

export interface ToolDefinition {
  type: 'function';
  function: { name: string; description: string; parameters: ToolParameters };
}

export interface ToolContext {
  guildId: string;
  caseId: number | null;
  constitution: Constitution | null;
  defaultLookbackDays: number;
}

/** 公開活動の行。アーカイブに全文があればそれで差し替え、出典を付ける。 */
export type ToolRow = ActivityMessage & { source?: string; conversation?: unknown };

export interface ToolsetOptions {
  guildId: string;
  allowed: readonly string[];
  caseId?: number | null;
  constitution?: Constitution | null;
  maximumOutputBytes?: number;
  onStep?: (entry: InvestigationStep) => void;
}

export interface ToolsetCheckpoint {
  trace: InvestigationStep[];
  retrieved: [string, RetrievedRecord][];
  spentBytes: number;
  pages: [string, [number, number][]][];
}

/** ai/runtime.js が使う読み取り専用ツール一式。 */
export interface Toolset {
  readOnly: true;
  call(name: unknown, args: unknown): Promise<unknown>;
  exhausted(): boolean;
  checkpoint(): ToolsetCheckpoint;
  assertCurrent(): void;
  restore(saved: unknown): void;
  definitions: ToolDefinition[];
  retrieved: Map<string, RetrievedRecord>;
  trace: InvestigationStep[];
  readonly steps: number;
  readonly spentBytes: number;
  run(name: unknown, rawArguments: unknown): Promise<unknown>;
}

// ---- tools.ts ----

/** 公開活動の行を返す調査ツール。返した行はアーカイブの全文で差し替えて引用台帳へ入れる。 */
export interface RowTool {
  rows: true;
  description: string;
  parameters: ToolParameters;
  run(context: ToolContext, args: ToolArgs): ActivityMessage[];
}

/** 法令・事件など統治DBの記録を返す調査ツール。 */
export interface RecordTool {
  rows?: false;
  description: string;
  parameters: ToolParameters;
  run(context: ToolContext, args: ToolArgs): unknown;
}

// ---- discord.ts ----

export type ButtonRow = ActionRowBuilder<ButtonBuilder>;

export type PermissionName = keyof typeof PermissionFlagsBits;

export type PermissionState = Partial<Record<PermissionName, boolean>>;

// Forum の threads.create だけを使う。検査用の偽 channel も同じ形で通す。
export interface ThreadCreator {
  availableTags?: readonly GuildForumTag[];
  threads: { create(options: GuildForumThreadCreateOptions): Promise<AnyThreadChannel> };
}

export interface RecordPostOptions {
  files?: AttachmentPayload[];
  components?: ButtonRow[];
}

export interface GovernancePermissionReport {
  ok: boolean;
  missing: string[];
}

/** 導入途中に作った Discord リソースの ID。session の resources_json に保存する。 */
export type SetupResources = Record<string, unknown>;

export interface GovernanceSurfaces {
  appealRoleId: string;
  judiciaryRoleId: string;
  categoryId: string;
  parliamentForumId: string;
  courtForumId: string;
  courtChatChannelId: string;
  procedureChannelId: string;
  legacyGuideChannelId: string;
  legacyGazetteChannelId: string;
  permissionReport: GovernancePermissionReport;
}

export interface RecordUpdateOptions {
  state?: string | null;
  components?: ButtonRow[];
  files?: AttachmentPayload[];
}

export interface RecordThreadView {
  name: string;
  content: string;
  components: ButtonRow[];
  state: string | null;
  removeActions?: readonly string[];
  closed?: boolean;
}

// ---- llm.ts ----

/** 法案採択の席ひとつぶんの結論。 */
export interface AdoptionOutput {
  verdict: 'approve' | 'revise' | 'reject';
  reasons: string[];
}

export interface InstitutionTaskOutput {
  decision: 'record' | 'propose';
  title: string;
  summary: string;
  reasons: string[];
}

/** provider への1回の依頼。会話・道具・回数の数え方は ai/runtime.ts の AgentRequest をそのまま受け取る。 */
export interface ChatRequest extends Pick<AgentRequest, 'messages' | 'tools' | 'runId' | 'deadlineAt' | 'beforeSend' | 'consumeRequest'> {
  model: string;
  jsonOnly?: boolean;
  timeoutMs: number;
  thinking?: 'enabled' | 'disabled';
  guildId: string;
  purpose: string;
}

export interface GovernanceCallOptions<T> {
  guildId: string;
  purpose: string;
  model: string;
  instruction: string;
  data: unknown;
  caseId?: number | null;
  constitution?: Constitution | null;
  maximumOutputBytes?: number;
  maximumMilliseconds?: number;
  seat?: number;
  thinking?: 'enabled' | 'disabled';
  validate: (raw: unknown, retrieved: ReadonlyMap<string, RetrievedRecord>) => T;
}

export interface GovernanceAgentOptions<T> extends GovernanceCallOptions<T> {
  role: { tools: readonly string[] };
  maximumSteps?: number;
}

export interface GovernanceCallResult<T> {
  output: T;
  raw: T;
  inputHash: string;
  trace: InvestigationStep[];
  retrieved: Map<string, RetrievedRecord>;
  steps: number;
}

export interface AgendaDeliberation extends AgendaDecision {
  supportingSeats: number;
  required: number;
  seats: number;
  failedSeats: number;
  maximumSteps: number;
  traces: SeatTrace[];
  outputs: AgendaDecision[];
}

/** 席の構成。旧形式の憲法の席は seats と required だけ、法令が定める機関は使命と調査手段も持つ。 */
export type SeatPanel = Panel & Partial<Institution>;

/** 裁判の席に渡す事件。上訴理由と原処分は service が付ける。 */
export type PanelCase = CaseRecord & { appealGrounds?: string | null; originalSanction?: SanctionChoice };

export interface WeeklyIssue {
  title: string;
  summary: string;
  evidenceMessageIds: string[];
}

// ---- intake.ts ----

/** 呼びかけのメッセージ。テストの偽物でも同じ形で通るよう、使う場所だけを読む。 */
export type MentionMessage = Message;

/** 証拠にした投稿。保存・照合に使う全文と会話の形。 */
export interface SourceEvidence {
  messageId: string;
  channelId: string;
  authorId: string;
  authorIsBot: boolean;
  content: string;
  conversation: unknown;
  occurredAt: number;
}

/** Discord から取り直して照合できた証拠。 */
export interface ValidatedEvidence {
  messageId: string;
  channelId: string;
  authorId: string;
  content: string;
  contentHash: string;
  conversation: unknown;
  occurredAt: number;
}

export interface EvidenceToRevalidate {
  messageId: string;
  channelId: string;
  authorId: string;
  contentHash?: string | null;
}

/** 再試行で受付が終わった案件 (事件)。公開スレがあればリンクを付ける。 */
export interface RetriedResult {
  id: number;
  public_thread_id?: string | null;
}

export interface StoredCandidate {
  accusedId: string;
  lawId: number;
  offenseCode: string;
  summary: string;
  supportingSeats: number;
  evidenceMessageIds: string[];
  elementEvidence: { element: string; messageIds: string[]; supportingSeats?: number | null; reason?: string | null }[];
}

export interface PanelRecord {
  outputs: readonly unknown[];
  failedSeats: number;
  traces?: readonly SeatTrace[];
  maximumSteps?: number;
}

/** 事前審査の記録を出す候補。合議の結果でも、調査記録から読み戻したものでもよい。 */
export type ScreeningRecordCandidate = Pick<ScreeningConsensus, 'lawId' | 'offenseCode' | 'supportingSeats'> & {
  elementEvidence: readonly { element: string; messageIds: readonly unknown[]; supportingSeats?: number | null }[];
  reasons?: readonly string[];
};

/** 調査の結論。text は呼びかけへの返信、result は調査記録 (result_json) へ残す。 */
export interface InvestigationOutcome {
  outcome: string;
  text: string;
  resultType?: string;
  resultId?: number | string;
  result?: Record<string, unknown>;
}

export interface InvestigationContext {
  settings: { caseLimit: number | undefined };
  targetUserIds: string[];
}

export interface ScreenedCase {
  caseRecord: CaseRecord;
  candidate: ScreeningConsensus;
  evidence: ValidatedEvidence[];
  duplicate: boolean;
  pending?: boolean;
}

/** 受付の結果。type と id は調査記録へ残す。 */
export interface IntakeResult {
  type: string;
  id: unknown;
  text: string;
}

// ---- ux.ts ----

/** 統治の操作ボタン・選択・モーダル。`gov:admin` の名前空間で届く。 */
export type GovernanceUxInteraction = MessageComponentInteraction | ModalSubmitInteraction;

/** 権限 overwrite を持つ channel (text / forum など)。検査用の偽物も同じ形で通す。 */
export type OverwriteChannel = Pick<TextChannel, 'permissionOverwrites'>;

/** 運用パネル・手続の案内・案件カードの本文。mention は送る直前に決める。 */
export interface GovernancePanelPayload {
  content: string;
  components: ButtonRow[];
  allowedMentions: MessageMentionOptions;
}

/** 手続の案件カード。key で既存カードと突き合わせる。 */
export interface GovernanceActionCard extends GovernancePanelPayload {
  key: string;
  notification?: NotificationDescriptor;
}

// ---- commands.ts ----

/** 統治のボタン・選択・モーダル。custom_id は `gov:` で始まる。 */
export type GovernanceComponentInteraction = MessageComponentInteraction | ModalSubmitInteraction;

export interface GovernanceCommand {
  data: SlashCommandBuilder | Omit<SlashCommandBuilder, 'addSubcommand' | 'addSubcommandGroup'>;
  execute(interaction: ChatInputCommandInteraction): Promise<void>;
}

// ---- service.ts ----

export interface PanelTraces {
  traces?: readonly SeatTrace[];
  maximumSteps?: number;
}

/** 案件受付時の憲法と、それを compile して手続を引いた結果 (提案の現在の段階)。 */
export interface ProposalRuntime {
  constitution: Constitution;
  compiled: { rules: GovernanceRules; rulesHash?: string | null; policy?: ConstitutionPolicy | null };
  key: WorkflowKey;
  workflow: LegalProcedure;
  stateName: string;
  state: ProcedureState;
}

export interface ProposalTransition extends ProposalRuntime {
  sourceName: string;
  source: ProcedureState;
  outcome: string;
  targetName: string;
  target: ProcedureState;
  durationMilliseconds: number | null;
}

/** 統治の記録に使う公開メッセージ (Discord の Message、検査では同じ形の偽物)。 */
export type GovernanceMessage = Message;

/** 回数枠を数えるメンバー。Discord の GuildMember か、ロールを ID の配列で持つ API のメンバー。 */
export interface AttemptMember {
  id: string;
  guild?: { id: string } | null;
  roles?: unknown;
}

/** 投票・承認・拒否権の操作 (ボタン)。検査では同じ形の偽物を渡す。 */
export interface GovernanceActor {
  guildId: string | null;
  guild: Guild | null;
  user: User;
  member?: GuildMember | APIInteractionGuildMember | null;
}

/** 申立てを出す人。bot 名義の公式申立てでは id だけを持つ。 */
export type Reporter = AttemptMember;

export interface CriminalCaseInput {
  accused: { id: string };
  lawId: unknown;
  offenseCode: unknown;
  summary: unknown;
  evidence?: unknown;
  evidences?: readonly unknown[];
  eventId?: string;
  attemptReserved?: boolean;
  policeEventKey?: string | null;
  official?: boolean;
}

export interface ConstitutionalChallengeInput {
  targetType: unknown;
  targetId: unknown;
  reason: unknown;
  eventId?: string;
  attemptReserved?: boolean;
  official?: boolean;
  system?: boolean;
}

export type ReviewTarget =
  | { type: 'law'; record: Law }
  | { type: 'case'; record: CaseRecord }
  | { type: 'sanction'; record: Sanction }
  | { type: 'administrative_act'; record: AdministrativeAct };
