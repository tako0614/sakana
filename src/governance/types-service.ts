// 統治モジュール後半 (service / llm / discord / intake / ux / tools / commands) が使う型と型ガード。
//
// db.js などまだ JS のモジュールが返す値は any として届く。SQLite の行、JSON 列、
// 席 (LLM) の出力はプロセスの外から来たデータなので、ここで形を確かめてから使う。
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
import * as governanceDb from './db.js';
import * as modelProvider from '../ai/provider.js';
import * as agentRuntime from '../ai/runtime.js';
import * as governanceContext from './context.js';
import * as governanceRules from './rules.js';
import * as humanAuthority from './human-authority.js';
import * as executionAuthority from './execution-authority.js';

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

export function recordOf<T>(guard: Guard<T>): Guard<Record<string, T>> {
  return (value: unknown): value is Record<string, T> => isRecord(value) && Object.values(value).every((entry) => guard(entry));
}

export function oneOf<const T extends readonly string[]>(values: T): Guard<T[number]> {
  return (value: unknown): value is T[number] => typeof value === 'string' && values.includes(value);
}

export const isStringArray = arrayOf(isString);
export const isNumberArray = arrayOf(isNumber);

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

// ---- 実行規則 (governance-rules を compile したもの) ----

const stateConfigSchema = {
  institution: optional(isString),
  phase: optional(isString),
  scope: optional(isString),
  users: optional(isStringArray),
  roles: optional(isStringArray),
  veto: optional(isRecord),
  rejectVotes: optional(isNumber),
  text: optional(isString)
} as const;
export const isWorkflowStateConfig = shape(stateConfigSchema);
export type WorkflowStateConfig = Shape<typeof stateConfigSchema>;

const workflowStateSchema = {
  handler: isString,
  duration: optional(isString),
  config: isWorkflowStateConfig,
  on: recordOf(isString)
} as const;
export const isWorkflowState = shape(workflowStateSchema);
export type WorkflowState = Shape<typeof workflowStateSchema>;

const workflowSchema = {
  initial: optional(isString),
  mandate: optional(isString),
  states: recordOf(isWorkflowState)
} as const;
export const isWorkflow = shape(workflowSchema);
export type Workflow = Shape<typeof workflowSchema>;

const institutionSchema = {
  seats: isNumber,
  required: recordOf(isNumber),
  tools: optional(isStringArray),
  mandate: optional(isString)
} as const;
export const isInstitution = shape(institutionSchema);
export type Institution = Shape<typeof institutionSchema>;

const voteRuleSchema = {
  yesRatio: isNumber,
  comparison: optional(isString),
  earlyClose: optional(isString),
  trustedVeto: shape({ enabledForScope: optional(isString), noRatio: isNumber })
} as const;
export const isVoteRule = shape(voteRuleSchema);
export type VoteRule = Shape<typeof voteRuleSchema>;

const rulesSchema = {
  workflows: recordOf(isWorkflow),
  institutions: optional(recordOf(isInstitution)),
  panels: optional(recordOf(isInstitution)),
  votes: optional(shape({ law: isVoteRule, constitutionalAmendment: isVoteRule })),
  recovery: isUnknown
} as const;
export const isGovernanceRules = shape(rulesSchema);
export type GovernanceRules = Shape<typeof rulesSchema>;

// ---- 憲法から作った実行値 (policy) ----

const numberTable = optional(recordOf(isNumber));
const investigationPolicySchema = {
  maximumSteps: numberTable,
  maximumOutputKilobytes: numberTable,
  maximumMinutes: numberTable,
  tools: optional(recordOf(isStringArray)),
  publicRecord: optional(isString),
  maximumRedefense: optional(isNumber)
} as const;
export const isInvestigationPolicy = shape(investigationPolicySchema);
export type InvestigationPolicy = Shape<typeof investigationPolicySchema>;

const judiciaryPolicySchema = {
  defenseMilliseconds: isNumber,
  appealMilliseconds: isNumber,
  constitutionalChallengesPerMemberPerDay: isNumber,
  panelSeats: isNumber,
  guiltyVotesRequired: isNumber,
  maximumTimeoutSeconds: isNumber,
  immediateTimeoutMaximumSeconds: isNumber,
  maximumRestrictionSeconds: isNumber,
  allowedSanctions: isStringArray,
  restrictionPrimitives: isStringArray
} as const;

const policySchema = {
  autonomous: optional(isBoolean),
  timezoneOffsetMinutes: isNumber,
  eligibility: shape({ minimumVisibleCharacters: isNumber, windowDays: isNumber }),
  voting: shape({ defaultScope: isString, allowedScopes: isStringArray, minimumBallots: isNumber, quorumRatio: isNumber }),
  legislation: shape({
    sessionIntervalMilliseconds: isNumber,
    agendaLimit: isNumber,
    maximumDeferrals: optional(isNumber),
    logScan: isUnknown
  }),
  judiciary: shape(judiciaryPolicySchema),
  investigation: optional(isInvestigationPolicy)
} as const;
export const isGovernancePolicy = shape(policySchema);
export type GovernancePolicy = Shape<typeof policySchema>;

// policy.js の policeProcedure(policy) が返す警察手続 (無ければ null)。
const policeProcedureSchema = {
  panelSeats: isNumber,
  votesRequired: isNumber,
  contestMilliseconds: isNumber,
  detentionMaximumSeconds: isNumber,
  immediateSanctions: isStringArray,
  courtFirstSanctions: isStringArray
} as const;
export const isPoliceProcedure = shape(policeProcedureSchema);
export type PoliceProcedure = Shape<typeof policeProcedureSchema>;

// ---- 法律 ----

const offenseSanctionSchema = {
  type: isString,
  maximumSeconds: optional(isNumber),
  definitionCode: optional(isString)
} as const;
export const isOffenseSanction = shape(offenseSanctionSchema);

const offenseSchema = {
  code: isString,
  title: optional(isString),
  elements: isStringArray,
  sanctions: optional(arrayOf(isOffenseSanction)),
  automaticTrigger: isUnknown
} as const;
export const isOffense = shape(offenseSchema);
export type Offense = Shape<typeof offenseSchema>;

const provisionsSchema = {
  offenses: optional(arrayOf(isOffense)),
  sanctionDefinitions: optional(arrayOf(isRecord))
} as const;
export const isLawProvisions = shape(provisionsSchema);
export type LawProvisions = Shape<typeof provisionsSchema>;

const lawSchema = {
  id: isNumber,
  guild_id: isString,
  code: isString,
  title: isString,
  text: isString,
  status: isString,
  effective_at: isNumber,
  version: optional(isNumber),
  content_hash: optional(isString),
  provisions: isLawProvisions
} as const;
export const isLawRow = shape(lawSchema);
export type LawRow = Shape<typeof lawSchema>;

// ---- 憲法 ----

const constitutionSchema = {
  id: isNumber,
  guild_id: isString,
  version: isNumber,
  content: isString,
  content_hash: optional(isString),
  rules_hash: optional(isString),
  // 権限型 (v2) の憲法は法律と合わせて compile するまで policy / rules を持たないことがある。
  policy: isUnknown,
  rules: isUnknown
} as const;
export const isConstitutionRow = shape(constitutionSchema);
export type ConstitutionRow = Shape<typeof constitutionSchema>;

// ---- 統治の設定 (サーバーごと) ----

const governanceGuildSchema = {
  guild_id: isString,
  status: isString,
  enforcement_mode: isString,
  trusted_role_id: isString,
  appeal_role_id: isString,
  judiciary_role_id: isString,
  category_id: optional(isString),
  parliament_forum_id: isString,
  court_forum_id: isString,
  court_chat_channel_id: isString,
  procedure_channel_id: isString,
  procedure_message_id: isString,
  operations_thread_id: isString,
  enforcement_thread_id: optional(isString),
  parliament_thread_id: optional(isString),
  last_session_at: optional(isNumber),
  session_last_error: optional(isString)
} as const;
export const isGovernanceGuildRow = shape(governanceGuildSchema);
export type GovernanceGuildRow = Shape<typeof governanceGuildSchema>;

// ---- 議案 ----

const proposalSchema = {
  id: isNumber,
  guild_id: isString,
  kind: isString,
  source: optional(isString),
  title: isString,
  summary: isString,
  status: isString,
  constitution_id: isNumber,
  vote_scope: isString,
  forum_thread_id: optional(isString),
  stage_started_at: optional(isNumber),
  stage_ends_at: optional(isNumber),
  revision: optional(isNumber),
  deferrals: optional(isNumber),
  retry_after: optional(isNumber),
  failure_count: optional(isNumber),
  last_error: optional(isString),
  target_type: optional(isString),
  target_id: optional(isString),
  target_hash: optional(isString),
  body: isUnknown,
  workflow_handler: optional(isString),
  workflow_status: optional(isString)
} as const;
export const isProposalRow = shape(proposalSchema);
export type ProposalRow = Shape<typeof proposalSchema>;

// ---- 事件 ----

const caseSchema = {
  id: isNumber,
  guild_id: isString,
  kind: isString,
  reporter_id: isString,
  accused_id: optional(isString),
  law_id: optional(isNumber),
  offense_code: optional(isString),
  challenged_type: optional(isString),
  challenged_id: optional(isString),
  summary: isString,
  status: isString,
  public_thread_id: optional(isString),
  defense_until: optional(isNumber),
  alleged_at: optional(isNumber),
  panel_id: optional(isString),
  finalized_at: optional(isNumber),
  retry_after: optional(isNumber),
  failure_count: optional(isNumber),
  last_error: optional(isString),
  constitution_id: optional(isNumber),
  procedure_version: optional(isNumber),
  decision_due_at: optional(isNumber),
  response_completed_at: optional(isNumber),
  police_event_key: optional(isString),
  review_count: optional(isNumber),
  redefense_count: optional(isNumber),
  verdict: isUnknown,
  workflow_state: optional(isString),
  workflow_handler: optional(isString),
  created_at: isNumber
} as const;
export const isCaseRow = shape(caseSchema);
export type CaseRow = Shape<typeof caseSchema>;

// 事件の verdict 列 (JSON)。
const caseVerdictSchema = {
  verdict: optional(isString),
  phase: optional(isString),
  sanction: isUnknown
} as const;
export const isCaseVerdict = shape(caseVerdictSchema);

const evidenceSchema = {
  id: isNumber,
  case_id: isNumber,
  submitted_by: isString,
  message_id: optional(isString),
  channel_id: optional(isString),
  author_id: optional(isString),
  content: isString,
  content_hash: isString,
  occurred_at: optional(isNumber),
  disclosed_at: optional(isNumber),
  conversation_json: optional(isString)
} as const;
export const isEvidenceRow = shape(evidenceSchema);
export type EvidenceRow = Shape<typeof evidenceSchema>;

const submissionSchema = {
  id: isNumber,
  author_id: isString,
  kind: isString,
  content: isString,
  content_hash: isString,
  source_message_id: optional(isString)
} as const;
export const isSubmissionRow = shape(submissionSchema);
export type SubmissionRow = Shape<typeof submissionSchema>;

const decisionSchema = {
  phase: isString,
  seat: isNumber,
  verdict: isString,
  sanction_json: optional(isString),
  reasons_json: optional(isString),
  output: isUnknown
} as const;
export const isDecisionRow = shape(decisionSchema);
export type DecisionRow = Shape<typeof decisionSchema>;

const approvalSchema = {
  user_id: isString,
  decision: isString
} as const;
export const isApprovalRow = shape(approvalSchema);
export type ApprovalRow = Shape<typeof approvalSchema>;

const sanctionSchema = {
  id: isNumber,
  case_id: isNumber,
  guild_id: isString,
  user_id: isString,
  type: isString,
  duration_seconds: optional(isNumber),
  status: isString,
  required_approvals: isNumber,
  appealable: isNumber,
  appeal_deadline: optional(isNumber),
  restriction_started_at: optional(isNumber),
  executed_at: optional(isNumber),
  reversed_at: optional(isNumber),
  execution_key: isString,
  execution_detail: optional(isString),
  definition_code: optional(isString),
  review_requested_at: optional(isNumber),
  notice_delivered: optional(isNumber),
  profile: isUnknown
} as const;
export const isSanctionRow = shape(sanctionSchema);
export type SanctionRow = Shape<typeof sanctionSchema>;

const sanctionDefinitionSchema = {
  id: isNumber,
  code: isString,
  profile: isUnknown
} as const;
export const isSanctionDefinitionRow = shape(sanctionDefinitionSchema);

const appealSchema = {
  case_id: isNumber,
  grounds: isString,
  status: isString
} as const;
export const isAppealRow = shape(appealSchema);
export type AppealRow = Shape<typeof appealSchema>;

const detentionSchema = {
  case_id: isNumber,
  guild_id: isString,
  user_id: isString,
  status: isString,
  ends_at: isNumber
} as const;
export const isDetentionRow = shape(detentionSchema);
export type DetentionRow = Shape<typeof detentionSchema>;

const administrativeActSchema = {
  id: isNumber,
  guild_id: isString,
  status: isString,
  detail: isUnknown
} as const;
export const isAdministrativeActRow = shape(administrativeActSchema);
export type AdministrativeActRow = Shape<typeof administrativeActSchema>;

// ---- 手続の実行状態 ----

const humanAuthoritySnapshotSchema = {
  scope: optional(isString),
  required: optional(isNumber),
  members: optional(isStringArray)
} as const;
export const isHumanAuthoritySnapshot = shape(humanAuthoritySnapshotSchema);

const approvalContextSchema = {
  openedAt: optional(isNumber),
  deadline: isNumber,
  members: optional(isStringArray),
  authority: optional(isRecord),
  veto: optional(isHumanAuthoritySnapshot),
  rejectVotes: optional(isNumber),
  sanctionHash: optional(isString)
} as const;
export const isApprovalContext = shape(approvalContextSchema);
export type ApprovalContext = Shape<typeof approvalContextSchema>;

const workflowInstanceSchema = {
  workflow_key: isString,
  current_state: isString,
  state_entered_at: isNumber,
  wake_at: optional(isNumber),
  status: isString,
  context: isRecord
} as const;
export const isWorkflowInstanceRow = shape(workflowInstanceSchema);
export type WorkflowInstanceRow = Shape<typeof workflowInstanceSchema>;

// ---- 受付・調査 ----

const intakeSchema = {
  id: isNumber,
  guild_id: isString,
  branch: isString,
  action: isString,
  requester_id: isString,
  channel_id: isString,
  source_message_id: isString,
  response_message_id: optional(isString),
  status: isString,
  expires_at: isNumber,
  result_type: optional(isString),
  result_id: optional(isString),
  last_error: optional(isString),
  payload: isRecord
} as const;
export const isIntakeRow = shape(intakeSchema);
export type IntakeRow = Shape<typeof intakeSchema>;

const investigationSchema = {
  id: isNumber,
  guild_id: isString,
  branch: isString,
  requester_id: isString,
  channel_id: isString,
  source_message_id: isString,
  response_message_id: optional(isString),
  request_text: isString,
  status: isString,
  outcome: optional(isString),
  result_type: optional(isString),
  result_id: optional(isString),
  last_error: optional(isString),
  result: isRecord
} as const;
export const isInvestigationRow = shape(investigationSchema);
export type InvestigationRow = Shape<typeof investigationSchema>;

const investigationEvidenceSchema = {
  message_id: isString,
  channel_id: isString,
  author_id: isString,
  content: isString,
  content_hash: isString,
  occurred_at: isNumber
} as const;
export const isInvestigationEvidenceRow = shape(investigationEvidenceSchema);

const setupSessionSchema = {
  id: isString,
  guild_id: isString,
  requested_by: isString,
  constitution_hash: isString,
  policy_hash: isString,
  status: isString,
  last_error: optional(isString),
  resources: isRecord
} as const;
export const isSetupSessionRow = shape(setupSessionSchema);
export type SetupSessionRow = Shape<typeof setupSessionSchema>;

// ---- 公開活動の記録 (governance_activity) と arcive の行 ----

const activitySchema = {
  message_id: isString,
  channel_id: isString,
  user_id: isString,
  content: optional(isString),
  content_hash: optional(isString),
  created_at: isNumber
} as const;
export const isActivityRow = shape(activitySchema);
export type ActivityRow = Shape<typeof activitySchema>;

// ---- 外部への処理 (outbox) ----

const outboxSchema = {
  id: isNumber,
  guild_id: isString,
  action_type: isString,
  payload: isRecord,
  last_error: optional(isString)
} as const;
export const isOutboxRow = shape(outboxSchema);
export type OutboxRow = Shape<typeof outboxSchema>;

const failureSchema = { last_error: optional(isString) } as const;
export const isFailureRow = shape(failureSchema);

// ---- 集計 ----

const voteSummarySchema = {
  yes: isNumber,
  no: isNumber,
  abstain: isNumber,
  electorate: isNumber,
  trustedTotal: isNumber,
  trustedElectorate: isNumber,
  trustedNo: isNumber,
  trustedAbstain: isNumber,
  vetoCount: isNumber
} as const;
export const isVoteSummary = shape(voteSummarySchema);
export type VoteSummary = Shape<typeof voteSummarySchema>;

const approvalResultSchema = {
  passed: isBoolean,
  rejected: isBoolean,
  approvals: isNumber
} as const;
export const isApprovalResult = shape(approvalResultSchema);

const vetoResultSchema = { count: isNumber, vetoed: isBoolean } as const;
export const isVetoResult = shape(vetoResultSchema);

const reservationSchema = {
  ok: isBoolean,
  used: optional(isNumber),
  limit: optional(isNumber),
  retryAt: optional(isNumber),
  reason: optional(isString)
} as const;
export const isReservation = shape(reservationSchema);

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

const voteCloseSchema = { passed: isBoolean, quorumNeeded: isUnknown } as const;
export const isVoteCloseResult = shape(voteCloseSchema);

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

/** 実行規則 (rules) を読む。compile 前の権限型憲法など workflows が無ければ null。 */
export function rulesOf(value: unknown): GovernanceRules | null {
  if (!isRecord(value) || value['workflows'] === undefined) return null;
  if (isGovernanceRules(value)) return value;
  throw new TypeError('統治データ rules の形が想定と違います。');
}

/** 憲法の実行値 (policy) を読む。compile 前で policy が無ければ null。 */
export function policyOf(value: unknown): GovernancePolicy | null {
  if (!isRecord(value)) return null;
  if (isGovernancePolicy(value)) return value;
  throw new TypeError('統治データ policy の形が想定と違います。');
}

/** 実行値が必要な場面。無ければ手続を進めない。 */
export function requirePolicy(value: unknown): GovernancePolicy {
  const policy = policyOf(value);
  if (!policy) throw new Error('有効な憲法の実行値がありません。');
  return policy;
}

/** 法律で組織を定める (autonomous) 憲法か。policy が未 compile でも読める。 */
export function autonomousPolicy(value: unknown): boolean {
  return isRecord(value) && Boolean(value['autonomous']);
}

/** 必ずある値 (実行規則の参照先など)。無ければ例外にする。 */
export function requireValue<T>(value: T | null | undefined, message: string): T {
  if (value === null || value === undefined) throw new Error(message);
  return value;
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
  constitution: ConstitutionRow | null;
  defaultLookbackDays: number;
}

/** 公開活動の行。アーカイブに全文があればそれで差し替え、出典を付ける。 */
export type ToolRow = ActivityRow & { source?: string; conversation?: unknown };

export interface ToolsetOptions {
  guildId: string;
  allowed: readonly string[];
  caseId?: number | null;
  constitution?: ConstitutionRow | null;
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

// ---- まだ JS のモジュールとの境界 ----
//
// JS の既定値 `actorId = null` などは TS から null 型と推論され、実際に渡す string を
// 受け付けない。ここで実際の契約を宣言し、その型で受け取る。メソッドとして宣言した
// 引数は双方向の互換で照合されるので、JS 側と食い違う型 (number を受けるなど) は弾かれる。
// JS が TS へ移ったら、この節は元の関数を直接 import する形へ戻せる。

interface AuditEntry {
  guildId: string;
  actorType: string;
  actorId?: string | null;
  action: string;
  targetType?: string | null;
  targetId?: string | number | null;
  detail?: unknown;
}

interface AdministrativeActInput {
  guildId: string;
  kind: string;
  actorType?: string;
  actorId?: string | null;
  summary: string;
  detail?: unknown;
}

interface OutboxInput {
  guildId: string;
  actionType: string;
  targetId?: string | number | null;
  payload: unknown;
  idempotencyKey: string;
}

/** ai/runtime.js が request に渡す値。そのまま provider へ渡す。 */
export interface AgentRequestInput {
  messages: unknown;
  tools: unknown;
  final: unknown;
  deadlineAt: unknown;
  runId: unknown;
  beforeSend: unknown;
  consumeRequest: unknown;
}

interface JsBoundary {
  writeAudit(entry: AuditEntry): unknown;
  createAdministrativeAct(input: AdministrativeActInput): unknown;
  enqueueAction(input: OutboxInput): unknown;
  listCases(guildId: string, options?: { statuses?: readonly string[] | null; limit?: number }): unknown;
  listSanctions(guildId: string, statuses?: readonly string[] | null): unknown;
  listInvestigationEvidence(investigationId: number, purpose?: string | null): unknown;
  addCaseSubmission(caseId: number, authorId: string, kind: string, content: string, options?: { sourceMessageId?: string | null }): unknown;
  finishAiCall(id: unknown, result: { output?: unknown; error?: unknown }): unknown;
  requestModel(options: {
    model?: string;
    messages: unknown;
    tools?: unknown;
    jsonOnly?: boolean;
    timeoutMs?: number;
    deadlineAt?: number;
    guildId?: string | null;
    role?: string;
    runId?: unknown;
    beforeSend?: unknown;
    consumeRequest?: unknown;
    maxOutputTokens?: number;
    reasoning?: { enabled: boolean };
    temperature?: number;
  }): Promise<unknown>;
  runAgent(options: {
    guildId: string;
    system: string;
    userContent: string;
    toolset?: unknown;
    request: (input: AgentRequestInput) => Promise<unknown>;
    validate?: (message: unknown) => unknown;
    maximumSteps?: number;
    deadlineAt?: number;
    separateFinal?: boolean;
    runId?: string;
    modelIdentity: string;
  }): Promise<unknown>;
  investigationTargets(message: Message, anchor?: { authorId?: string; authorIsBot?: boolean } | null): unknown;
  compileConstitution(input: { content: string; laws?: unknown; policy?: unknown }): unknown;
  transitionWorkflowInstance(input: {
    subjectType: string;
    subjectId: unknown;
    toState: string;
    eventType?: string;
    actorType?: string;
    actorId?: string | null;
    wakeAt?: number | null;
    context?: unknown;
    payload?: unknown;
    idempotencyKey?: string | null;
    completed?: boolean;
  }): unknown;
  selectHumanMembers(members: unknown, authority: unknown, options: {
    guild: unknown;
    trustedRoleId?: unknown;
    operators?: readonly string[];
    exclude?: readonly unknown[];
  }): unknown;
  assertSanctionExecution(sanctionId: number, options?: { expectedHash?: string; expectedMode?: string; statuses?: readonly string[] }): unknown;
}

export const writeAudit: JsBoundary['writeAudit'] = governanceDb.writeAudit;
export const createAdministrativeAct: JsBoundary['createAdministrativeAct'] = governanceDb.createAdministrativeAct;
export const enqueueAction: JsBoundary['enqueueAction'] = governanceDb.enqueueAction;
export const listCases: JsBoundary['listCases'] = governanceDb.listCases;
export const listSanctions: JsBoundary['listSanctions'] = governanceDb.listSanctions;
export const listInvestigationEvidence: JsBoundary['listInvestigationEvidence'] = governanceDb.listInvestigationEvidence;
export const addCaseSubmission: JsBoundary['addCaseSubmission'] = governanceDb.addCaseSubmission;
export const finishAiCall: JsBoundary['finishAiCall'] = governanceDb.finishAiCall;
export const requestModel: JsBoundary['requestModel'] = modelProvider.requestModel;
export const runAgent: JsBoundary['runAgent'] = agentRuntime.runAgent;
export const investigationTargets: JsBoundary['investigationTargets'] = governanceContext.investigationTargets;
export const compileConstitution: JsBoundary['compileConstitution'] = governanceRules.compileConstitution;
export const transitionWorkflowInstance: JsBoundary['transitionWorkflowInstance'] = governanceDb.transitionWorkflowInstance;
export const selectHumanMembers: JsBoundary['selectHumanMembers'] = humanAuthority.selectHumanMembers;
export const assertSanctionExecution: JsBoundary['assertSanctionExecution'] = executionAuthority.assertSanctionExecution;

// ---- tools.ts ----

/** 公開活動の行を返す調査ツール。返した行はアーカイブの全文で差し替えて引用台帳へ入れる。 */
export interface RowTool {
  rows: true;
  description: string;
  parameters: ToolParameters;
  run(context: ToolContext, args: ToolArgs): ActivityRow[];
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

export interface ChatRequest {
  model: string | undefined;
  messages: unknown;
  tools?: unknown;
  jsonOnly?: boolean;
  timeoutMs: number;
  thinking?: 'enabled' | 'disabled';
  guildId: string;
  purpose: string;
  runId: unknown;
  deadlineAt: number;
  beforeSend: unknown;
  consumeRequest: unknown;
}

export interface GovernanceCallOptions<T> {
  guildId: string;
  purpose: string;
  model: string | undefined;
  instruction: string;
  data: unknown;
  caseId?: number | null;
  constitution?: ConstitutionRow | null;
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

/** 裁判の席に渡す事件。上訴理由と原処分は service が付ける。 */
export type PanelCase = CaseRow & { appealGrounds?: string | null; originalSanction?: SanctionChoice };

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
  caseRecord: CaseRow;
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

export type GovernanceNotification = { mention: string };

/** 手続の案件カード。key で既存カードと突き合わせる。 */
export interface GovernanceActionCard extends GovernancePanelPayload {
  key: string;
  notification?: GovernanceNotification;
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

export interface ProposalRuntime {
  constitution: ConstitutionRow;
  compiled: { rules: GovernanceRules; rulesHash?: string | null; policy?: unknown };
  key: string;
  workflow: Workflow;
  stateName: string;
  state: WorkflowState;
}

export interface ProposalTransition extends ProposalRuntime {
  sourceName: string;
  source: WorkflowState;
  outcome: string;
  targetName: string;
  target: WorkflowState;
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

/** 手続を開いた時点で資格を満たした人の一覧つきの権限対象。 */
export type HumanAuthoritySnapshot = Record<string, unknown> & { members: string[] };

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
  | { type: 'law'; record: LawRow }
  | { type: 'case'; record: CaseRow }
  | { type: 'sanction'; record: SanctionRow }
  | { type: 'administrative_act'; record: AdministrativeActRow };
