// 統治機能の共有型。SQLite の行・保存したJSON・法令定義の形をここに置く。
// 行の型は db.ts のスキーマ (CREATE TABLE と後から足した ALTER) と一致させる。
// JSON列の中身は、読んだ側で形を確かめるまで unknown として扱う。

export type UnknownRecord = Record<string, unknown>;

/** 配列でも null でもない object。JSON列やDiscordの値を読むときの最初の関門。 */
export function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Array.isArray は any[] に絞るので、要素を unknown のまま扱えるようにする。
export function isArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

export function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

/** 決まった語彙のどれかであることを確かめる。includes に unknown を渡せない代わり。 */
export function oneOf<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && (values as readonly string[]).includes(value);
}

/** SQLite の主キーや Discord の snowflake。数値でも文字列でも受け渡される識別子。 */
export type Id = number | string;

export function isId(value: unknown): value is Id {
  return typeof value === 'number' || typeof value === 'string';
}

/** 外から来た値 (custom_id の断片・JSON の項目など) を識別子として読む。違えば何の値かを名指して止める。 */
export function requireId(value: unknown, name: string): Id {
  if (isId(value)) return value;
  throw new TypeError(`${name} が識別子 (数値または文字列) ではありません。`);
}

/** 保存した JSON の項目など、あるとは限らない識別子。識別子でなければ「無い」として探さない。 */
export function idOrNull(value: unknown): Id | null {
  return isId(value) ? value : null;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 旧来の `String(error?.message ?? error)` と同じ文字列。message を持つ object も読む。 */
export function errorText(error: unknown): string {
  const message = typeof error === 'object' && error !== null && 'message' in error ? error.message : undefined;
  return String(message ?? error);
}

// ---------------------------------------------------------------------------
// 法令・憲法の実行規則
// ---------------------------------------------------------------------------

export type VoteScope = 'all' | 'trusted';
export type SanctionType = 'warning' | 'restriction' | 'timeout' | 'kick' | 'ban';
export type RestrictionPrimitive =
  | 'messages_per_window' | 'block_links' | 'block_attachments' | 'block_mentions'
  | 'block_reactions' | 'block_thread_creation' | 'block_voice'
  | 'agent_calls_per_window' | 'block_petitions' | 'block_voting';
export type InvestigationRole = 'police' | 'court' | 'parliament';
export type WorkflowKey = 'law' | 'constitutionalAmendment' | 'criminalCase' | 'constitutionalCase';
export const WORKFLOW_KEYS: readonly WorkflowKey[] = ['law', 'constitutionalAmendment', 'criminalCase', 'constitutionalCase'];

/** 保存した workflow_key (文字列) を、実行規則の workflows を引ける名前として読む。 */
export function isWorkflowKey(value: unknown): value is WorkflowKey {
  return oneOf(WORKFLOW_KEYS, value);
}

export type DefinitionKind = 'institution' | 'procedure' | 'regulation' | 'binding';
export type HumanScope = 'all' | 'trusted' | 'administrators' | 'operators' | 'designated';

/** 法令が定める人間の権限対象。 */
export interface HumanAuthority {
  scope: HumanScope;
  users?: string[];
  roles?: string[];
  required?: number;
}

export interface HumanVetoAuthority extends HumanAuthority {
  required: number;
}

/** 開始時点で資格を満たした構成員を固定したもの。後からロールが変わっても数え直さない。 */
export interface HumanAuthoritySnapshot extends HumanAuthority {
  members: string[];
}

export interface ProcedureStateConfig {
  [key: string]: unknown;
  phase?: string;
  maximumVisits?: number;
  institution?: string;
  effect?: string;
  text?: string;
  vote?: string;
  scope?: HumanScope;
  users?: string[];
  roles?: string[];
  veto?: HumanVetoAuthority | null;
  rejectVotes?: number;
  excludeParties?: boolean;
}

export interface ProcedureState {
  handler: string;
  duration: string | null;
  config: ProcedureStateConfig;
  on: Record<string, string>;
}

export interface ProcedureConfig {
  [key: string]: unknown;
  petitionsPerMemberPerDay?: number;
  reopen?: Record<string, string>;
  interruptions?: Record<string, string>;
}

export interface ProcedureTrigger {
  event: 'schedule' | 'petition' | 'law_enacted';
  interval?: string;
}

/** v1 の workflow と、法律が定める v2 の手続の共通形。v2 では name と mandate が必ずある。 */
export interface LegalProcedure {
  name?: string;
  mandate?: string;
  initial: string;
  states: Record<string, ProcedureState>;
  config: ProcedureConfig;
  trigger?: ProcedureTrigger;
}

export interface Panel {
  seats: number;
  required: Record<string, number>;
}

export interface Institution extends Panel {
  name: string;
  mandate: string;
  tools: string[];
}

export interface Panels<P extends Panel = Panel> {
  parliament: P;
  constitutional: P;
  court: P;
  police: P;
  judicialScreening: P;
}

export type Workflows = Record<WorkflowKey, LegalProcedure>;

export interface ParliamentRules {
  sessionInterval: string;
  agendaLimit: number;
  logScan: boolean;
  maximumDeferrals?: number;
}

export interface GeneralElectorate {
  type: 'activity';
  memberAge: string;
  window: string;
  minimumMessages: number;
  minimumActiveDays: number;
  perDayCap: number;
  minimumVisibleCharacters: number;
  timezoneOffsetMinutes: number;
}

export interface Electorates {
  general: GeneralElectorate;
  trusted: { type: 'discord_role'; binding: 'trusted' };
}

export interface InvestigationRules {
  maximumSteps: Record<InvestigationRole, number>;
  maximumOutputKilobytes: Record<InvestigationRole, number>;
  maximumMinutes: Record<InvestigationRole, number>;
  tools: Record<InvestigationRole, string[]>;
  publicRecord: 'none' | 'summary' | 'full';
  maximumRedefense: number;
}

export interface TrustedVetoRule {
  enabledForScope: 'all';
  noRatio: number;
  denominator: 'decisive_cast_ballots';
}

export interface VoteRule {
  duration: string;
  yesRatio: number;
  comparison: 'gt' | 'gte';
  quorumRatio: number;
  minimumBallots: number;
  publicBallots: true;
  trustedVeto: TrustedVetoRule;
  earlyClose?: 'never' | 'all_ballots_cast';
  humanVeto?: HumanVetoAuthority | null;
}

export interface VoteRules {
  defaultScope: VoteScope;
  allowedScopes: VoteScope[];
  law: VoteRule;
  constitutionalAmendment: VoteRule;
}

export interface SanctionRules {
  allowed: SanctionType[];
  restrictionPrimitives: RestrictionPrimitive[];
  maximumRestriction: string;
  timeout: { discordMaximum: string; maximum: string; immediateMaximum: string };
  approvals: { timeoutAboveImmediate: number; kick: number; ban: number };
  appeals: { timeoutAtLeast: string; types: SanctionType[]; duration: string };
  detention: { maximum: string };
  police: { contestDuration: string; immediate: SanctionType[]; courtFirst: SanctionType[]; unlimitedWarningContest: boolean };
}

export interface ConstitutionalAuthority {
  $schema: 'sakana.constitution/v2';
  delegations: DefinitionKind[];
  amendment: {
    mode: 'procedure';
    minimumSeats: number;
    minimumApprovalRatio: number;
    publicVote: 'required' | 'optional';
    minimumPublicApprovalRatio: number;
  };
  recovery?: { mode: 'last_valid_amendment_procedure'; publicVote: 'required'; minimumVoteDuration: string };
}

export interface LegalBinding {
  kind: 'institution' | 'procedure';
  target: string;
}

export interface LegalSource {
  lawId: number | null;
  code: string;
  version: number;
  article: string;
  hash: string;
}

export interface LawVersionRef {
  id: number | null;
  code: string;
  hash: string;
}

/** 法令が無効になったとき、憲法の暫定権限で代替法だけを起草できる状態。 */
export interface RecoveryRules {
  baselineHash: string | null;
  cause: string;
  powers: string[];
}

interface GovernanceRulesBase {
  $schema: string;
  panels: Panels;
  parliament: ParliamentRules;
  investigation: InvestigationRules;
  votes: VoteRules;
  sanctions: SanctionRules;
  workflows: Workflows;
  recovery?: RecoveryRules;
}

/** 憲法本文に埋め込んだ v1 の実行規則。 */
export interface GovernanceRulesV1 extends GovernanceRulesBase {
  $schema: 'sakana.governance-rules/v1';
  electorates: Electorates;
  parliament: ParliamentRules & { maximumDeferrals: number };
}

/** 憲法の授権と成立法令から組み立てた v2 の法体系。 */
export interface EffectiveLegalSystem extends GovernanceRulesBase {
  $schema: 'sakana.legal-system/v2';
  authority: ConstitutionalAuthority;
  institutions: Record<string, Institution>;
  procedures: Record<string, LegalProcedure>;
  bindings: Record<string, LegalBinding>;
  sources: Record<string, LegalSource>;
  panels: Panels<Institution> & { adoption: Institution; amendmentAdoption: Institution };
  records: GeneralElectorate;
  lawVersions: LawVersionRef[];
}

/** 保存される実行規則。v2 の授権だけの形は保存しない (必ず法令と合わせて組み立てる)。 */
export type GovernanceRules = GovernanceRulesV1 | EffectiveLegalSystem;

export function isEffectiveLegalSystem(rules: GovernanceRules | null | undefined): rules is EffectiveLegalSystem {
  return rules?.$schema === 'sakana.legal-system/v2';
}

// ---------------------------------------------------------------------------
// 憲法policy (実行規則から導いた、コードが直接読む値)
// ---------------------------------------------------------------------------

export interface EligibilityPolicy {
  memberAgeDays: number;
  windowDays: number;
  minimumMessages: number;
  minimumActiveDays: number;
  perDayCap: number;
  minimumVisibleCharacters: number;
}

export interface VotingPolicy {
  defaultScope: VoteScope;
  allowedScopes: VoteScope[];
  lawYesRatio: number;
  amendmentYesRatio: number;
  trustedVetoRatio: number;
  quorumRatio: number;
  minimumBallots: number;
  publicBallots: boolean;
}

export interface LegislationPolicy {
  voteMilliseconds?: number;
  sessionIntervalMilliseconds: number;
  agendaLimit: number;
  maximumDeferrals?: number;
  logScan: boolean;
}

export interface PoliceProcedurePolicy {
  panelSeats: number;
  votesRequired: number;
  contestMilliseconds: number;
  detentionMaximumSeconds: number;
  immediateSanctions: SanctionType[];
  courtFirstSanctions: SanctionType[];
  unlimitedWarningContest: boolean;
}

export interface JudiciaryPolicy {
  defenseMilliseconds: number;
  appealMilliseconds: number;
  constitutionalChallengesPerMemberPerDay: number;
  panelSeats: number;
  constitutionalPanelSeats?: number;
  guiltyVotesRequired: number;
  constitutionalVotesRequired: number;
  unconstitutionalVotesRequired: number;
  discordMaximumTimeoutSeconds: number;
  maximumTimeoutSeconds: number;
  immediateTimeoutMaximumSeconds: number;
  timeoutApprovalsAboveSeconds: number;
  kickApprovals: number;
  banApprovals: number;
  appealTimeoutMinimumSeconds: number;
  maximumRestrictionSeconds: number;
  allowedSanctions: SanctionType[];
  restrictionPrimitives: RestrictionPrimitive[];
  policeProcedure?: PoliceProcedurePolicy;
}

export interface ConstitutionPolicy {
  schemaVersion: 1 | 2 | 3;
  autonomous?: true;
  timezoneOffsetMinutes: number;
  eligibility: EligibilityPolicy;
  voting: VotingPolicy;
  legislation: LegislationPolicy;
  judiciary: JudiciaryPolicy;
  investigation?: InvestigationRules;
}

export interface CompiledMeta {
  rulesHash: string;
  sourceFormat: string;
  compilerVersion: number;
}

export interface CompiledV1 extends CompiledMeta {
  rules: GovernanceRulesV1;
  policy: ConstitutionPolicy;
}

export interface CompiledLegalSystem extends CompiledMeta {
  rules: EffectiveLegalSystem;
  policy: ConstitutionPolicy;
}

export interface CompiledAuthority extends CompiledMeta {
  rules: ConstitutionalAuthority;
  policy: null;
}

export type CompiledConstitution = CompiledV1 | CompiledLegalSystem | CompiledAuthority;

/** 法令が壊れたときに戻る、最後に有効だった法体系。snapshot か現行憲法の行から作る。 */
export interface LegalBaseline {
  constitutionId: number;
  constitutionHash: string;
  rules: GovernanceRules | null;
  policy: ConstitutionPolicy;
  rulesHash: string | null;
}

/** 開票に使う集計。VoteSummary に案件の種別と投票範囲を足したもの。 */
export interface VoteTally {
  kind: string;
  yes: number;
  no: number;
  abstain: number;
  electorate: number;
  trustedNo?: number;
  trustedTotal?: number;
  vetoCount?: number;
  scope?: string;
}

export interface VoteOutcome {
  passed: boolean;
  ratioPassed: boolean;
  quorumPassed: boolean;
  vetoed: boolean;
  humanVetoed: boolean;
  quorumNeeded: number;
  trustedNeeded: number;
  decisive: number;
  ballots: number;
}

// ---------------------------------------------------------------------------
// 法律の本文 (提案の body と成立法の provisions)
// ---------------------------------------------------------------------------

export interface LawArticle {
  code: string;
  text: string;
}

export interface LegalDefinition {
  kind: DefinitionKind;
  key: string;
  article: string;
  value: unknown;
}

export interface RestrictionRule {
  primitive: RestrictionPrimitive;
  maximum?: number;
  windowSeconds?: number;
  enabled?: true;
}

export interface RestrictionDefinition {
  code: string;
  title?: string;
  maximumDurationSeconds?: number;
  rules: RestrictionRule[];
}

export interface OffenseSanction {
  type: SanctionType;
  definitionCode?: string;
  maximumSeconds?: number;
}

export interface Offense {
  [key: string]: unknown;
  code: string;
  title?: string;
  elements?: string[];
  sanctions?: OffenseSanction[];
  restrictionDefinitions?: RestrictionDefinition[];
}

export interface LawProvisions {
  [key: string]: unknown;
  articles?: LawArticle[];
  governance?: LegalDefinition[];
  offenses?: Offense[];
  sanctionDefinitions?: RestrictionDefinition[];
}

/** 法体系の組み立てに渡す法律。成立済みの行でも起草中の案でもよい。 */
export interface LawInput {
  id?: number | null;
  code: string;
  title?: string;
  summary?: string;
  text?: string;
  version?: number | null;
  content_hash?: string | null;
  provisions?: LawProvisions | null;
}

/** 初期法令 (governance/founding-laws/*.json) の形。 */
export interface FoundingLaw {
  code: string;
  title: string;
  summary: string;
  text: string;
  provisions: LawProvisions;
}

export interface LegalMigrationBody {
  constitution: string;
  laws: FoundingLaw[];
}

/** 提案の本文。法律案・改憲案・移行案で使う項目が違うので、どれも任意。 */
export interface ProposalBody {
  [key: string]: unknown;
  title?: string;
  summary?: string;
  text?: string;
  content?: string;
  provisions?: LawProvisions;
  migration?: LegalMigrationBody;
  bootstrapLaws?: FoundingLaw[];
}

function optionalString(record: UnknownRecord, key: string): boolean {
  return record[key] === undefined || typeof record[key] === 'string';
}

/** 法律の条項。ある区分だけ配列であることを確かめる (中身は法体系の組み立てが検査する)。 */
export function isLawProvisions(value: unknown): value is LawProvisions {
  return isRecord(value)
    && ['articles', 'governance', 'offenses', 'sanctionDefinitions'].every((key) => value[key] === undefined || Array.isArray(value[key]));
}

/** AI が起草した提案本文。項目はどれも任意で、ある項目だけ型を確かめる。 */
export function isProposalBody(value: unknown): value is ProposalBody {
  return isRecord(value)
    && ['title', 'summary', 'text', 'content'].every((key) => optionalString(value, key))
    && (value.provisions === undefined || isLawProvisions(value.provisions))
    && (value.migration === undefined || isRecord(value.migration))
    && (value.bootstrapLaws === undefined || Array.isArray(value.bootstrapLaws));
}

// ---------------------------------------------------------------------------
// workflow の文脈 (手続の各段が保存する値)
// ---------------------------------------------------------------------------

export interface PublicVoteRecord {
  state: string;
  targetHash: string;
  openedAt: number;
  deadline: number;
  announced: boolean;
  closed?: boolean;
  veto: HumanAuthoritySnapshot | null;
  result?: unknown;
  summary?: unknown;
}

export interface ApprovalRecord {
  [key: string]: unknown;
  openedAt: number;
  deadline: number;
  members: string[];
  authority?: HumanAuthority;
  veto?: HumanAuthoritySnapshot | null;
  scope?: string;
  users?: string[];
  roles?: string[];
  rejectVotes: number;
  sanctionHash: string;
}

export interface QueuedInput {
  intakeId?: string;
  sourceId?: string;
  userId: string | null;
  sourceType: string;
  summary: string;
  createdAt: number;
}

export interface ProposalQueue {
  queuedAt?: number;
  blockedByProposalId?: string | null;
  reason?: string;
  previousState?: string;
  inputs?: QueuedInput[];
}

export interface WorkflowContext {
  [key: string]: unknown;
  visits?: Record<string, number>;
  pending?: { state: string; key: string };
  exhausted?: { state: string; visits: number; reason: string };
  // 起草し直すと null にして、次の投票を開き直す。
  publicVote?: PublicVoteRecord | null;
  approval?: ApprovalRecord;
  queue?: ProposalQueue;
  inputHistory?: QueuedInput[];
}

// ---------------------------------------------------------------------------
// SQLite の行
// ---------------------------------------------------------------------------

export interface GovernanceGuildRow {
  guild_id: string;
  status: string;
  enforcement_mode: string;
  trusted_role_id: string;
  appeal_role_id: string;
  legislature_role_id: string;
  judiciary_role_id: string;
  category_id: string | null;
  parliament_forum_id: string;
  court_forum_id: string;
  court_chat_channel_id: string;
  statute_forum_id: string;
  procedure_channel_id: string;
  procedure_message_id: string;
  operations_thread_id: string;
  enforcement_thread_id: string;
  parliament_thread_id: string;
  active_constitution_id: number | null;
  last_weekly_scan_at: number | null;
  weekly_retry_after: number | null;
  weekly_failure_count: number;
  weekly_last_error: string | null;
  last_session_at: number | null;
  session_retry_after: number | null;
  session_failure_count: number;
  session_last_error: string | null;
  created_at: number;
  updated_at: number;
}

export type GovernanceGuild = GovernanceGuildRow;

export interface ConstitutionRow {
  id: number;
  guild_id: string;
  version: number;
  content: string;
  policy_json: string;
  content_hash: string;
  policy_hash: string;
  status: string;
  enacted_by: string;
  enacted_at: number;
  proposal_id: number | null;
  source_format: string;
  rules_json: string | null;
  rules_hash: string | null;
  compiler_version: number | null;
}

export interface Constitution extends ConstitutionRow {
  policy: ConstitutionPolicy;
  rules: GovernanceRules | null;
}

/** 現行憲法。v2 では成立法令から組み立てた法体系 (rulesHash など) を重ねて返す。 */
export type ActiveConstitution = Constitution & Partial<CompiledMeta>;

export interface SettingRow {
  guild_id: string;
  key: string;
  value: number;
  updated_by: string | null;
  updated_at: number;
}

export interface ActivityRow {
  message_id: string;
  guild_id: string;
  channel_id: string;
  parent_id: string | null;
  user_id: string;
  activity_date: string;
  content_hash: string;
  content: string;
  created_at: number;
  structure_json: string;
}

/** 調査や議題発見で読む、活動記録の公開してよい列。 */
export type ActivityMessage = Pick<ActivityRow, 'message_id' | 'channel_id' | 'parent_id' | 'user_id' | 'content_hash' | 'content' | 'created_at'>;
export type DiscussionMessage = Pick<ActivityRow, 'message_id' | 'user_id' | 'content' | 'created_at'>;

/** recordActivity に渡す1件。service が Discord の投稿から作る。 */
export interface ActivityInput {
  messageId: string;
  guildId: string;
  channelId: string;
  parentId: string | null;
  userId: string;
  activityDate: string;
  contentHash: string;
  content: string;
  createdAt: number;
  structureJson?: string;
}

export interface ProposalRow {
  id: number;
  guild_id: string;
  kind: string;
  source: string;
  title: string;
  summary: string;
  body_json: string | null;
  status: string;
  proposer_id: string | null;
  constitution_id: number;
  vote_scope: string;
  forum_thread_id: string | null;
  forum_message_id: string | null;
  stage_started_at: number | null;
  stage_ends_at: number | null;
  revision: number;
  deferrals: number;
  debate_extensions: number;
  retry_after: number | null;
  failure_count: number;
  last_error: string | null;
  relation_type: string | null;
  target_type: string | null;
  target_id: string | null;
  target_hash: string | null;
  created_at: number;
  updated_at: number;
}

export interface Proposal extends ProposalRow {
  body: ProposalBody | null;
  workflow_handler: string | null;
  workflow_status: string | null;
  workflow_context: WorkflowContext;
}

export interface ProposalVoterRow {
  proposal_id: number;
  user_id: string;
  eligible_general: number;
  trusted: number;
  snapshotted_at: number;
}

export type ProposalElectorateRow = Pick<ProposalVoterRow, 'user_id' | 'eligible_general' | 'trusted'>;

export interface ProposalVoteRow {
  user_id: string;
  choice: string;
  updated_at: number;
  trusted: number;
}

export interface VoteSummary {
  yes: number;
  no: number;
  abstain: number;
  electorate: number;
  trustedTotal: number;
  trustedElectorate: number;
  trustedYes: number;
  trustedNo: number;
  trustedAbstain: number;
  vetoCount: number;
}

export interface ProposalDeliberationRow {
  id: number;
  proposal_id: number;
  revision: number;
  outcome: string;
  discussion_json: string;
  decision_json: string;
  created_at: number;
}

export interface ProposalDeliberation extends ProposalDeliberationRow {
  discussion: unknown[];
  decision: UnknownRecord;
}

export interface LawRow {
  id: number;
  guild_id: string;
  proposal_id: number;
  code: string;
  title: string;
  text: string;
  provisions_json: string;
  content_hash: string;
  constitution_id: number;
  status: string;
  effective_at: number;
  ended_at: number | null;
  root_law_id: number | null;
  supersedes_law_id: number | null;
  version: number;
}

export interface Law extends LawRow {
  provisions: LawProvisions;
}

export interface SanctionDefinitionRow {
  id: number;
  guild_id: string;
  law_id: number;
  code: string;
  title: string;
  profile_json: string;
  profile_hash: string;
  maximum_duration_seconds: number;
  status: string;
  created_at: number;
}

export interface SanctionDefinitionRecord extends SanctionDefinitionRow {
  profile: unknown;
}

export interface StatutePublicationRow {
  id: number;
  guild_id: string;
  instrument_type: string;
  instrument_id: string;
  forum_thread_id: string;
  forum_message_id: string;
  detail_message_id: string;
  publication_status: string;
  content_hash: string;
  created_at: number;
  updated_at: number;
}

export interface LawPublicationRow {
  guild_id: string;
  instrument_type: string;
  instrument_id: string;
  content_hash: string;
  publication_status: string;
  pushed_at: number;
}

export interface ReviewRow {
  id: number;
  guild_id: string;
  target_type: string;
  target_id: string;
  panel_id: string;
  phase: string;
  seat: number;
  model: string;
  verdict: string;
  reasons_json: string;
  citations_json: string;
  input_hash: string;
  output_json: string;
  target_hash: string | null;
  created_at: number;
}

export interface CaseRow {
  id: number;
  guild_id: string;
  kind: string;
  reporter_id: string;
  accused_id: string | null;
  law_id: number | null;
  offense_code: string | null;
  challenged_type: string | null;
  challenged_id: string | null;
  summary: string;
  status: string;
  public_thread_id: string | null;
  private_thread_id: string | null;
  defense_until: number | null;
  alleged_at: number | null;
  panel_id: string | null;
  verdict_json: string | null;
  retry_after: number | null;
  failure_count: number;
  last_error: string | null;
  constitution_id: number | null;
  procedure_version: number;
  decision_due_at: number | null;
  response_completed_at: number | null;
  police_event_key: string | null;
  review_count: number;
  redefense_count: number;
  workflow_state: string | null;
  created_at: number;
  updated_at: number;
  finalized_at: number | null;
}

export interface CaseRecord extends Omit<CaseRow, 'workflow_state'> {
  verdict: unknown;
  workflow_state: string;
  workflow_handler: string | null;
}

export interface CaseEvidenceRow {
  id: number;
  case_id: number;
  submitted_by: string;
  message_id: string | null;
  channel_id: string | null;
  author_id: string | null;
  content: string;
  content_hash: string;
  occurred_at: number | null;
  disclosed_at: number | null;
  conversation_json: string | null;
  created_at: number;
}

export interface CaseSubmissionRow {
  id: number;
  case_id: number;
  author_id: string;
  kind: string;
  content: string;
  content_hash: string;
  source_message_id: string | null;
  superseded_at: number | null;
  created_at: number;
}

export interface CaseDecisionRow {
  id: number;
  case_id: number;
  panel_id: string;
  phase: string;
  seat: number;
  model: string;
  verdict: string;
  law_id: number | null;
  offense_code: string | null;
  sanction_json: string | null;
  evidence_ids_json: string;
  reasons_json: string;
  input_hash: string;
  output_json: string;
  created_at: number;
}

export interface CaseDecision extends CaseDecisionRow {
  sanction: unknown;
  evidenceIds: unknown;
  reasons: unknown;
  output: unknown;
}

export interface CaseApprovalRow {
  case_id: number;
  user_id: string;
  decision: string;
  reason: string;
  target_hash: string | null;
  created_at: number;
}

export interface SanctionRow {
  id: number;
  case_id: number;
  guild_id: string;
  user_id: string;
  type: string;
  duration_seconds: number | null;
  status: string;
  required_approvals: number;
  appealable: number;
  appeal_deadline: number | null;
  restriction_started_at: number | null;
  executed_at: number | null;
  reversed_at: number | null;
  execution_key: string;
  execution_detail: string | null;
  definition_code: string | null;
  profile_json: string | null;
  review_requested_at: number | null;
  notice_delivered: number;
}

export interface Sanction extends SanctionRow {
  profile: unknown;
}

export interface AppealRow {
  id: number;
  case_id: number;
  appellant_id: string;
  grounds: string;
  status: string;
  panel_id: string | null;
  created_at: number;
  decided_at: number | null;
}

export interface AuditRow {
  id: number;
  guild_id: string;
  actor_type: string;
  actor_id: string | null;
  action: string;
  target_type: string | null;
  target_id: string | null;
  detail_json: string;
  created_at: number;
}

export interface AuditEntry extends AuditRow {
  detail: unknown;
}

export interface AdministrativeActRow {
  id: number;
  guild_id: string;
  kind: string;
  actor_type: string;
  actor_id: string | null;
  summary: string;
  detail_json: string;
  status: string;
  created_at: number;
  reversed_at: number | null;
}

export interface AdministrativeAct extends AdministrativeActRow {
  detail: UnknownRecord;
}

export interface OutboxRow {
  id: number;
  guild_id: string;
  action_type: string;
  target_id: string | null;
  payload_json: string;
  idempotency_key: string;
  status: string;
  attempts: number;
  last_error: string | null;
  retry_after: number | null;
  created_at: number;
  completed_at: number | null;
}

export interface OutboxAction extends OutboxRow {
  payload: UnknownRecord;
}

export interface ActiveRestrictionRow {
  id: number;
  sanction_id: number;
  guild_id: string;
  user_id: string;
  definition_id: number;
  profile_json: string;
  started_at: number;
  ends_at: number;
  status: string;
}

export interface ActiveRestriction extends ActiveRestrictionRow {
  profile: unknown;
}

export interface TrustedMutationRow {
  id: number;
  guild_id: string;
  user_id: string;
  role_id: string;
  desired: number;
  authorized_by: string;
  expires_at: number;
  consumed_at: number | null;
}

export interface IntakeRow {
  id: number;
  guild_id: string;
  branch: string;
  action: string;
  requester_id: string;
  channel_id: string;
  source_message_id: string;
  response_message_id: string | null;
  payload_json: string;
  status: string;
  expires_at: number;
  result_type: string | null;
  result_id: string | null;
  last_error: string | null;
  created_at: number;
  updated_at: number;
}

export interface Intake extends IntakeRow {
  payload: UnknownRecord;
}

export interface SetupSessionRow {
  id: string;
  guild_id: string;
  requested_by: string;
  constitution_hash: string;
  policy_hash: string;
  status: string;
  resources_json: string;
  last_error: string | null;
  expires_at: number;
  created_at: number;
  updated_at: number;
}

export interface SetupSession extends SetupSessionRow {
  resources: UnknownRecord;
}

export interface LegacyMessageArchiveRow {
  id: number;
  guild_id: string;
  channel_id: string;
  message_id: string;
  author_id: string | null;
  content: string;
  attachments_json: string;
  content_hash: string;
  reason: string;
  message_created_at: number | null;
  archived_at: number;
  deleted_at: number | null;
}

export interface InterimProtectionRow {
  id: number;
  case_id: number;
  guild_id: string;
  user_id: string;
  law_id: number;
  offense_code: string;
  trigger_type: string;
  minimum_events: number;
  observed_events: number;
  window_seconds: number;
  duration_seconds: number;
  evidence_message_id: string;
  evidence_channel_id: string;
  started_at: number;
  ends_at: number;
  status: string;
  ended_at: number | null;
  created_at: number;
}

export interface WorkflowInstanceRow {
  id: number;
  guild_id: string;
  constitution_id: number;
  workflow_key: string;
  subject_type: string;
  subject_id: string;
  current_state: string;
  state_entered_at: number;
  wake_at: number | null;
  context_json: string;
  status: string;
  legal_snapshot_hash: string | null;
  created_at: number;
  updated_at: number;
}

export interface WorkflowInstance extends WorkflowInstanceRow {
  context: WorkflowContext;
}

export interface WorkflowEventRow {
  id: number;
  workflow_instance_id: number;
  event_type: string;
  actor_type: string;
  actor_id: string | null;
  from_state: string | null;
  to_state: string;
  payload_json: string;
  idempotency_key: string | null;
  created_at: number;
}

export interface WorkflowEvent extends WorkflowEventRow {
  payload: unknown;
}

export interface InstrumentRelationRow {
  id: number;
  guild_id: string;
  source_type: string;
  source_id: string;
  relation_type: string;
  target_type: string;
  target_id: string;
  target_hash: string | null;
  reason_json: string;
  decision_json: string;
  created_at: number;
}

export interface InstrumentRelation extends InstrumentRelationRow {
  reasons: unknown;
  decision: unknown;
}

export interface NotificationRow {
  id: number;
  guild_id: string;
  event_key: string;
  event_type: string;
  audience_kind: string;
  audience_id: string | null;
  status: string;
  attempts: number;
  channel_id: string | null;
  message_id: string | null;
  last_error: string | null;
  created_at: number;
  updated_at: number;
  delivered_at: number | null;
}

export interface SurfaceMigrationRow {
  guild_id: string;
  legacy_guide_channel_id: string;
  legacy_gazette_channel_id: string;
  status: string;
  detail_json: string;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
}

export interface SurfaceMigration extends SurfaceMigrationRow {
  detail: UnknownRecord;
}

export interface MentionInvestigationRow {
  id: number;
  guild_id: string;
  branch: string;
  requester_id: string;
  channel_id: string;
  source_message_id: string;
  response_message_id: string | null;
  request_text: string;
  request_hash: string;
  status: string;
  outcome: string | null;
  result_json: string;
  result_type: string | null;
  result_id: string | null;
  record_published_at: number | null;
  last_error: string | null;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
}

export interface MentionInvestigation extends MentionInvestigationRow {
  result: UnknownRecord;
}

export interface InvestigationEvidenceRow {
  id: number;
  investigation_id: number;
  message_id: string;
  channel_id: string;
  author_id: string;
  content: string;
  content_hash: string;
  occurred_at: number;
  purpose: string;
  created_at: number;
}

export interface InvestigationStepRow {
  id: number;
  ai_call_id: number;
  guild_id: string;
  purpose: string;
  seat: number;
  step: number;
  tool: string;
  arguments_json: string;
  result_count: number;
  result_summary: string;
  result_hash: string;
  error: string | null;
  created_at: number;
}

export interface ParliamentSessionRow {
  id: number;
  guild_id: string;
  constitution_id: number;
  manual: number;
  agenda_count: number;
  outcomes_json: string;
  started_at: number;
  finished_at: number | null;
  minutes_message_id: string | null;
}

export interface ParliamentSession extends ParliamentSessionRow {
  outcomes: unknown;
}

export interface DetentionRow {
  id: number;
  case_id: number;
  guild_id: string;
  user_id: string;
  reason: string;
  duration_seconds: number;
  started_at: number;
  ends_at: number;
  status: string;
  released_at: number | null;
  created_at: number;
}

export interface LegalSnapshotRow {
  hash: string;
  guild_id: string;
  constitution_id: number;
  content_json: string;
  created_at: number;
}

/** 案件が受付時に固定した法体系。後から法令が変わっても、この版で手続を続ける。 */
export interface LegalSnapshot {
  constitutionId: number;
  constitutionHash: string;
  rules: GovernanceRules;
  policy: ConstitutionPolicy;
  rulesHash: string | null;
  hash: string;
  guildId: string;
}

export interface LegalTaskRow {
  id: number;
  guild_id: string;
  procedure_id: string;
  snapshot_hash: string;
  event_key: string;
  state: string;
  context_json: string;
  status: string;
  wake_at: number | null;
  retry_after: number | null;
  failure_count: number;
  last_error: string | null;
  created_at: number;
  updated_at: number;
}

export interface LegalTask extends LegalTaskRow {
  context: WorkflowContext;
}

export interface HumanVetoRow {
  subject_type: string;
  subject_id: number;
  round_key: string;
  target_hash: string;
  user_id: string;
  created_at: number;
}

// ---------------------------------------------------------------------------
// AI 席の結論 (llm.js の戻り値のうち、ここで読む項目)
// ---------------------------------------------------------------------------

export interface SeatOutput {
  [key: string]: unknown;
  verdict?: string;
  reasons?: string[];
}

export interface AgendaDecision {
  [key: string]: unknown;
  decision: string;
  relation: string | null;
  targetType?: string | null;
  targetId: string | null;
  instruction: string | null;
  reasons?: string[];
  outputs: SeatOutput[];
  seats?: number;
  failedSeats?: number;
}

export interface PanelResult {
  [key: string]: unknown;
  panelId: string;
  verdict?: string;
  outputs: SeatOutput[];
  targetHash?: string;
}

export interface InstitutionTaskOutput {
  decision: string;
  title: string;
  summary: string;
  reasons: string[];
}

export interface InstitutionTaskResult {
  decision: string;
  output: InstitutionTaskOutput;
  outputs: InstitutionTaskOutput[];
}

export interface WeeklyIssue {
  title: string;
  summary: string;
  evidenceMessageIds: string[];
}
