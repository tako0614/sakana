import {
  PermissionFlagsBits,
  type Client,
  type Guild,
  type GuildBasedChannel,
  type GuildMember,
  type NonThreadGuildBasedChannel,
  type PartialGuildMember,
  type PartialMessage,
  type Role
} from 'discord.js';
import { discordStructure } from '../conversation/message.js';
import { governanceConfig } from './config.js';
import { humanAuthorityLabel } from './human-authority.js';
import { db as archiveDb } from '../archive/db.js';
import {
  activateRestriction,
  addCaseEvidence,
  authorizeTrustedMutation,
  castProposalVote,
  castHumanVeto,
  completeAction,
  consumeTrustedMutation,
  createAppeal,
  createCase,
  createDetention,
  createSanction,
  deactivateRestrictionForSanction,
  enactConstitution,
  enactLaw,
  expireDetentions,
  expireRestrictions,
  expireGovernanceIntakes,
  failAction,
  findCaseByPoliceEvent,
  findOpenConstitutionalCase,
  findRecentPoliceCase,
  getActiveConstitution,
  getAdministrativeAct,
  getAppeal,
  getCase,
  getCaseByPublicThread,
  getCaseDetention,
  getCaseSanction,
  getGovernanceGuild,
  constitutionForSubject,
  getWorkflowInstance,
  getLaw,
  lawForCase,
  getCurrentLawVersion,
  getOperationalSetting,
  getProposal,
  repairInstitutionProposalScope,
  detainedSeconds,
  getSanction,
  releaseDetention,
  getSanctionDefinition,
  listCaseApprovals,
  listCaseEvidence,
  listCaseDecisions,
  listCaseSubmissions,
  listCurrentCaseSubmissions,
  listGovernanceGuilds,
  listLaws,
  listOpenCasesForLaw,
  listProposals,
  listSanctionsForLaw,
  markActionRunning,
  markEvidenceDisclosed,
  pendingActions,
  proposalVoteSummary,
  pruneGovernance,
  recordActivities,
  recordActivity,
  recentUserActivity,
  replaceCaseSubmission,
  reserveAgentAttempt,
  setCaseApproval,
  sanctionApprovalHash,
  legalApprovalResult,
  setOperationalSetting,
  snapshotProposalVoters,
  updateAppeal,
  updateAdministrativeAct,
  updateCase,
  updateGovernanceGuild,
  updateLaw,
  updateProposal,
  updateSanction
} from './db.js';
import {
  postEnforcementRecord,
  actingMember,
  applyAppealRestriction,
  createCourtCaseThread,
  executeDiscordSanction,
  ensureGovernanceParliamentForum,
  postAuthorityChange,
  postCourtUpdate,
  postCourtRecord,
  postProposalUpdate,
  publicMemberLabel,
  releaseAppealRestriction,
  contestButtons,
  syncAppealRoleOverwrites,
  ensureGovernanceMentionRoles,
  syncGovernanceRecordUi
} from './discord.js';
import {
  runConstitutionalPanel,
  runJudicialPanel
} from './llm.js';
import {
  DAY_MS,
  activityDate,
  isAppealable,
  normalizeActivityContent,
  requiredApprovals,
  sha256,
  policeProcedure,
  validateAutomaticTrigger,
  validateRestrictionDefinition
} from './policy.js';
import { governanceActionAllowed, reserveRestrictedAgentCall } from './restrictions.js';
import { notifyCaseParty } from './notifications.js';
import { publishInstrument, syncLawSite } from './lawsite.js';
import { investigationSummary } from './tools.js';
import { runInstitutionProcedures } from './institutions.js';
import { WAITING_ACTIONS } from './legal-system.js';
import { procedureExhausted, recordProcedureVisit } from './procedure-runtime.js';
import { requiresManualExecution, manualExecutionDetail, requestManualExecution } from './manual-execution.js';

import { closeGovernanceVote, durationMilliseconds, workflowFor } from './rules.js';
import {
  addCaseSubmission,
  assertSanctionExecution,
  autonomousPolicy,
  compileConstitution,
  createAdministrativeAct,
  enqueueAction,
  errorMessage,
  isActivityRow,
  isAdministrativeActRow,
  isAppealRow,
  isApprovalContext,
  isApprovalResult,
  isApprovalRow,
  isCaseRow,
  isConstitutionRow,
  isDetentionRow,
  isEvidenceRow,
  isGovernanceGuildRow,
  isGovernanceRules,
  isLawRow,
  isNumber,
  isOutboxRow,
  isPoliceProcedure,
  isProposalRow,
  isRecord,
  isReservation,
  isSanctionDefinitionRow,
  isSanctionRow,
  isString,
  isStringArray,
  isSubmissionRow,
  isUnknown,
  isVetoResult,
  isVoteCloseResult,
  isVoteSummary,
  isWorkflowInstanceRow,
  listCases,
  narrow,
  narrowList,
  narrowRequired,
  nullable,
  optional,
  policyOf,
  requirePolicy,
  requireValue,
  rulesOf,
  selectHumanMembers,
  shape,
  transitionWorkflowInstance,
  writeAudit,
  type AdministrativeActRow,
  type AttemptMember,
  type CaseRow,
  type ConstitutionalChallengeInput,
  type ConstitutionRow,
  type CriminalCaseInput,
  type EvidenceRow,
  type GovernanceActor,
  type GovernanceGuildRow,
  type GovernanceMessage,
  type GovernancePolicy,
  type GovernanceReservation,
  type GovernanceRules,
  type HumanAuthoritySnapshot,
  type JudicialPanel,
  type LawRow,
  type OutboxRow,
  type PanelCase,
  type PanelTraces,
  type PoliceProcedure,
  type ProposalRow,
  type ProposalRuntime,
  type ProposalTransition,
  type Reporter,
  type RetrievedRecord,
  type ReviewTarget,
  type SanctionChoice,
  type SanctionExecutionDetail,
  type SanctionRow,
  type Workflow,
  type WorkflowState
} from './types-service.js';

// ---- DB の行を確かめて読む ----

const governanceGuild = (guildId: unknown) => narrow(getGovernanceGuild(guildId), isGovernanceGuildRow, 'governance guild');
const caseById = (caseId: unknown) => narrow(getCase(caseId), isCaseRow, 'case');
const requireCase = (value: unknown) => narrowRequired(value, isCaseRow, 'case');
const proposalById = (proposalId: unknown) => narrow(getProposal(proposalId), isProposalRow, 'proposal');
const requireProposal = (value: unknown) => narrowRequired(value, isProposalRow, 'proposal');
const lawById = (lawId: unknown) => narrow(getLaw(lawId), isLawRow, 'law');
const sanctionById = (sanctionId: unknown) => narrow(getSanction(sanctionId), isSanctionRow, 'sanction');
const requireSanction = (value: unknown) => narrowRequired(value, isSanctionRow, 'sanction');
const caseSanction = (caseId: unknown) => narrow(getCaseSanction(caseId), isSanctionRow, 'sanction');
const activeConstitution = (guildId: unknown) => narrow(getActiveConstitution(guildId), isConstitutionRow, 'constitution');
const appealOf = (caseId: unknown) => narrow(getAppeal(caseId), isAppealRow, 'appeal');
const workflowInstance = (subjectType: string, subjectId: unknown) => narrow(getWorkflowInstance(subjectType, subjectId), isWorkflowInstanceRow, 'workflow instance');
const caseEvidence = (caseId: unknown) => narrowList(listCaseEvidence(caseId), isEvidenceRow, 'case evidence');
const currentSubmissions = (caseId: unknown) => narrowList(listCurrentCaseSubmissions(caseId), isSubmissionRow, 'case submission');
const settingNumber = (guildId: string, key: string): number => Number(getOperationalSetting(guildId, key));
const durationMs = (duration: unknown): number => Number(durationMilliseconds(duration));
const procedureOf = (policy: unknown): PoliceProcedure | null => narrow(policeProcedure(policy), isPoliceProcedure, 'police procedure');
const waitingActions: readonly string[] = narrowList(WAITING_ACTIONS, isString, 'waiting action');

// 席の調査は要約だけ公開する（憲法第九条8・実行規則 investigation.publicRecord）。
const PANEL_LENS_LABELS = ['textual', 'rights', 'adversarial'];

function investigationLines(panel: PanelTraces, policy: GovernancePolicy | null | undefined): string[] {
  if ((policy?.investigation?.publicRecord ?? 'none') === 'none') return [];
  return (panel.traces ?? [])
    .flatMap(({ seat, trace }) => {
      const summary = investigationSummary(trace, {
        seat,
        lens: PANEL_LENS_LABELS[(seat - 1) % PANEL_LENS_LABELS.length] ?? null,
        maximumSteps: panel.maximumSteps ?? 0
      });
      return summary ? [summary] : [];
    });
}

const RETRY_BASE_MS = 5 * 60_000;
const RETRY_MAX_MS = 60 * 60_000;

// 案件受付時の憲法を compile した実行規則。
const isCompiledConstitution = shape({ rules: isGovernanceRules, rulesHash: optional(isString), policy: isUnknown });

function proposalRuntime(proposal: ProposalRow): ProposalRuntime | null {
  const constitution = narrow(constitutionForSubject('proposal', proposal), isConstitutionRow, 'constitution');
  if (!constitution) throw new Error('案件受付時の憲法がありません。');
  const source: unknown = constitution.rules
    ? { rules: constitution.rules, rulesHash: constitution.rules_hash, policy: constitution.policy }
    : compileConstitution({ content: constitution.content, policy: constitution.policy });
  const key = proposal.kind === 'amendment' ? 'constitutionalAmendment' : 'law';
  // 手続が無ければ rules.js が理由を付けて止める。続けて実行規則全体の形を確かめる。
  workflowFor(source, key);
  const compiled = narrowRequired(source, isCompiledConstitution, 'compiled constitution');
  const workflow = requireValue(compiled.rules.workflows[key], `憲法にworkflow ${key} がありません。`);
  const state = workflow.states[proposal.status];
  if (!state) return null;
  return { constitution, compiled, key, workflow, stateName: proposal.status, state };
}

function proposalTransition(proposal: ProposalRow, outcome: string): ProposalTransition {
  const runtime = proposalRuntime(proposal);
  return proposalTransitionFrom(runtime, runtime?.stateName, outcome);
}

function proposalTransitionFrom(runtime: ProposalRuntime | null, stateName: string | undefined, outcome: string): ProposalTransition {
  const source = stateName === undefined ? undefined : runtime?.workflow?.states?.[stateName];
  const targetName = source?.on?.[outcome];
  if (!runtime || !source || !targetName) throw new Error(`憲法の実行規則は ${stateName} で ${outcome} を許可していません。`);
  const target = requireValue(runtime.workflow.states[targetName], `憲法の実行規則に ${targetName} がありません。`);
  return {
    ...runtime,
    sourceName: runtime.stateName,
    source,
    outcome,
    targetName,
    target,
    durationMilliseconds: target.duration === null || target.duration === undefined ? null : durationMs(target.duration)
  };
}

function proposalStageEnd(transition: ProposalTransition, now = Date.now()): number | null {
  return transition.durationMilliseconds === null ? null : now + transition.durationMilliseconds;
}

function specialElectorateName(guild: Guild, governance: GovernanceGuildRow | null): string {
  return governance?.trusted_role_id
    ? (guild.roles.cache.get(governance.trusted_role_id)?.name ?? '特別有権者')
    : '特別有権者';
}

function publicLawDetails(law: LawRow | null | undefined, offenseCode: unknown): string[] {
  const offense = law?.provisions?.offenses?.find((entry) => entry.code === offenseCode);
  return [
    law ? `適用法: ${law.title}` : '適用法: 裁判記録に記載',
    offense?.title ? `対象となる違反: ${offense.title}` : null
  ].flatMap((line) => (line ? [line] : []));
}

// 公開する席の結論。内部の証拠 ID・法令 ID・追加候補は表示用の番号へ置き換える。
const HIDDEN_OUTPUT_KEYS = ['evidenceIds', 'elementFindings', 'lawId', 'offenseCode', 'newRecordIds'];

export function publicPanelOutputs(outputs: readonly object[], evidenceOrder: ReadonlyMap<unknown, number> = new Map()) {
  return outputs.map((output) => {
    const publicOutput: Record<string, unknown> = { ...output };
    const evidenceIds: unknown[] = Array.isArray(publicOutput['evidenceIds']) ? publicOutput['evidenceIds'] : [];
    const elementFindings: unknown[] = Array.isArray(publicOutput['elementFindings']) ? publicOutput['elementFindings'] : [];
    // 追加候補の生のmessage idは、証拠として採ったときに別途公開される。
    for (const key of HIDDEN_OUTPUT_KEYS) delete publicOutput[key];
    return {
      ...publicOutput,
      evidence: evidenceIds.map((id) => `証拠 ${evidenceOrder.get(id) ?? '?'}`),
      ...(elementFindings.length > 0 ? {
        elementFindings: elementFindings.map((entry) => {
          const finding: Record<string, unknown> = isRecord(entry) ? { ...entry } : {};
          const findingEvidence: unknown[] = Array.isArray(finding['evidenceIds']) ? finding['evidenceIds'] : [];
          delete finding['evidenceIds'];
          return {
            ...finding,
            evidence: findingEvidence.map((id) => `証拠 ${evidenceOrder.get(id) ?? '?'}`)
          };
        })
      } : {})
    };
  });
}
const CASE_EVIDENCE_LIMIT = 20;
const CASE_SUBMISSION_LIMIT_PER_PHASE = 40;

function acceptedWorkflowError(message: string, resultType: string, resultId: unknown): Error {
  const error = new Error(message);
  error.name = 'GovernanceAcceptedWorkflowError';
  return Object.assign(error, { accepted: { resultType, resultId: String(resultId) } });
}

export function retryPatch(record: { failure_count?: number | null } | null | undefined, error: unknown, now = Date.now()) {
  const failureCount = Number(record?.failure_count ?? 0) + 1;
  return {
    failure_count: failureCount,
    retry_after: now + Math.min(RETRY_MAX_MS, RETRY_BASE_MS * (2 ** Math.min(failureCount - 1, 4))),
    last_error: errorMessage(error).slice(0, 500)
  };
}

function requireGovernance(guildId: unknown): { governance: GovernanceGuildRow; constitution: ConstitutionRow; policy: GovernancePolicy } {
  const governance = governanceGuild(guildId);
  if (!governance) throw new Error('このサーバーでは統治機能が初期化されていません。');
  if (governance.status !== 'active') throw new Error('統治機能は現在一時停止中です。');
  const constitution = activeConstitution(guildId);
  if (!constitution) throw new Error('有効な憲法がありません。');
  return { governance, constitution, policy: requirePolicy(constitution.policy) };
}

function constitutionForCase(caseRecord: CaseRow): ConstitutionRow {
  return requireValue((caseRecord.constitution_id ? narrow(constitutionForSubject('case', caseRecord), isConstitutionRow, 'constitution') : null)
    ?? activeConstitution(caseRecord.guild_id), '事件に適用される憲法がありません。');
}

/** 制度修復中か (実行規則の recovery)。形を問わず、あれば修復中として扱う。 */
function recoveryOf(rules: unknown): unknown {
  return isRecord(rules) ? rules['recovery'] : undefined;
}

const casePolicy = (caseRecord: CaseRow): GovernancePolicy => requirePolicy(constitutionForCase(caseRecord).policy);
const caseRules = (caseRecord: CaseRow): GovernanceRules => requireValue(rulesOf(constitutionForCase(caseRecord).rules), '事件に適用される実行規則がありません。');

/** 事件の手続段階 (法律で組織を定める憲法のとき)。 */
function caseStage(rules: GovernanceRules, instance: { workflow_key: string; current_state: string }): { workflow: Workflow; stage: WorkflowState | undefined } {
  const workflow = requireValue(rules.workflows[instance.workflow_key], '案件に適用される手続がありません。');
  return { workflow, stage: workflow.states[instance.current_state] };
}

function casePeriod(caseRecord: CaseRow, outcome: string, handler: string, fallback: number): number {
  const constitution = constitutionForCase(caseRecord);
  if (!autonomousPolicy(constitution.policy)) return fallback;
  const instance = requireValue(workflowInstance('case', caseRecord.id), '案件の手続状態がありません。');
  const { workflow: procedure, stage } = caseStage(caseRules(caseRecord), instance);
  const current = requireValue(stage, '案件に適用される手続段階がありません。');
  const targetName = current.on[outcome];
  const target = targetName === undefined ? undefined : procedure.states[targetName];
  const period = target?.handler === handler ? target : Object.values(procedure.states).find((entry) => entry.handler === handler);
  if (!period?.duration) throw new Error('法令に必要な期間がありません。');
  return durationMs(period.duration);
}

function caseProcedure(caseRecord: CaseRow): PoliceProcedure | null {
  return procedureOf(constitutionForCase(caseRecord)?.policy);
}

function governanceSurface(channel: { id: string; parentId?: string | null } | null | undefined, governance: GovernanceGuildRow | null): boolean {
  if (!channel || !governance) return false;
  const ids = new Set([
    governance.category_id,
    governance.parliament_forum_id,
    governance.court_forum_id,
    governance.court_chat_channel_id,
    governance.procedure_channel_id,
    governance.operations_thread_id
  ].filter((id): id is string => Boolean(id)));
  return ids.has(channel.id) || (typeof channel.parentId === 'string' && ids.has(channel.parentId));
}

function publicChannel(message: GovernanceMessage, governance: GovernanceGuildRow | null = null): boolean {
  const channel = message.channel;
  if (!channel || channel.isDMBased?.()) return false;
  // 議会Forumのスレは議題そのもの。proposal行になる前の討論も国会が読めるよう記録する。
  const isAgendaDiscussion = channel.isThread?.()
    && channel.parentId === governance?.parliament_forum_id;
  if (governanceSurface(channel, governance) && (!isAgendaDiscussion || message.author?.bot)) return false;
  const everyone = message.guild?.roles?.everyone;
  return Boolean(everyone && 'permissionsFor' in channel && channel.permissionsFor?.(everyone)?.has(PermissionFlagsBits.ViewChannel));
}

function parentChannelId(channel: unknown): string | null {
  const parentId = isRecord(channel) ? channel['parentId'] : undefined;
  return typeof parentId === 'string' ? parentId : null;
}

export function recordGovernanceMessage(message: GovernanceMessage): boolean {
  if (!message?.guildId) return false;
  const governance = governanceGuild(message.guildId);
  if (!governance || !publicChannel(message, governance)) return false;
  const constitution = activeConstitution(message.guildId);
  if (!constitution) return false;
  const policy = requirePolicy(constitution.policy);
  const normalized = normalizeActivityContent(message.content);
  if (Array.from(normalized).length < policy.eligibility.minimumVisibleCharacters || /^[/!]/.test(normalized)) return false;
  return Boolean(recordActivity({
    messageId: message.id,
    guildId: message.guildId,
    channelId: message.channelId,
    parentId: parentChannelId(message.channel),
    userId: message.author.id,
    activityDate: activityDate(message.createdTimestamp, policy.timezoneOffsetMinutes),
    contentHash: sha256(normalized),
    content: String(message.content ?? ''),
    structureJson: JSON.stringify({ ...narrowRequired(discordStructure(message), isRecord, 'message structure'), observedAt: null }),
    createdAt: message.createdTimestamp
  }));
}

// GuildMember は roles.cache (Collection)、API の素のメンバーは roles が ID の配列。
function canCheckMembership(value: unknown): value is { has(id: string): unknown } {
  return isRecord(value) && typeof value['has'] === 'function';
}

function memberHasRole(roles: unknown, roleId: string): boolean {
  const cache = isRecord(roles) ? roles['cache'] : undefined;
  if (canCheckMembership(cache)) return Boolean(cache.has(roleId));
  if (isStringArray(roles)) return roles.includes(roleId);
  return false;
}

function reservation(value: unknown): GovernanceReservation {
  return narrowRequired(value, isReservation, 'attempt reservation');
}

/**
 * 通常会話agentの回数壁。費用上限とは別で、prompt injectionの試行回数を抑える。
 * trustedはサーバー名ではなく、初期化時に指定したrole IDだけで判定する。
 */
export function reserveGovernanceAgentAttempt(member: AttemptMember | null | undefined, eventId: string): GovernanceReservation {
  const guildId = member?.guild?.id;
  const governance = governanceGuild(guildId);
  if (!member || !guildId || !governance) return { ok: true, governed: false };
  const restricted = reservation(reserveRestrictedAgentCall(guildId, member.id, eventId));
  if (!restricted.ok) return { ...restricted, governed: true, scope: 'sanction' };
  const trusted = Boolean(governance.trusted_role_id) && memberHasRole(member.roles, governance.trusted_role_id);
  const rawLimit = settingNumber(
    guildId,
    trusted ? 'trusted_daily_calls' : 'general_daily_calls'
  );
  const limit = Math.max(0, Math.floor(rawLimit));
  const attempt = reservation(reserveAgentAttempt(guildId, member.id, trusted, limit));
  return {
    ...attempt,
    governed: true,
    trusted,
    scope: 'attempt'
  };
}

export function reserveGovernanceIntakeAttempt(
  member: AttemptMember | null | undefined,
  eventId: string,
  { constitutional = false }: { constitutional?: boolean } = {}
): GovernanceReservation {
  if (!constitutional) return reserveGovernanceAgentAttempt(member, eventId);
  const guildId = member?.guild?.id;
  const governance = governanceGuild(guildId);
  const constitution = activeConstitution(guildId);
  if (!member || !guildId || !governance || !constitution) return { ok: true, governed: false };
  const restricted = reservation(reserveRestrictedAgentCall(guildId, member.id, eventId));
  if (!restricted.ok) return { ...restricted, governed: true, scope: 'sanction' };
  const limit = requirePolicy(constitution.policy).judiciary.constitutionalChallengesPerMemberPerDay;
  return {
    ...reservation(reserveAgentAttempt(
      guildId,
      member.id,
      false,
      limit,
      DAY_MS,
      'constitutional_challenge'
    )),
    governed: true,
    trusted: false,
    scope: 'constitutional_challenge'
  };
}

function requireGovernanceAiAttempt(member: AttemptMember, eventId: string): GovernanceReservation {
  const attempt = reserveGovernanceAgentAttempt(member, eventId);
  if (attempt.ok) return attempt;
  const retry = attempt.retryAt ? ` <t:${Math.floor(attempt.retryAt / 1000)}:R>に空きます。` : '';
  if (attempt.scope === 'sanction') throw new Error(`判決によりAI利用が制限されています。${retry}`);
  throw new Error(`prompt injection対策のAI回数枠に達しました (${attempt.used}/${attempt.limit})。${retry}`);
}

// アーカイブから統治の活動記録へ取り込む行。
const isArchivedActivity = shape({
  message_id: isString,
  guild_id: isString,
  channel_id: isString,
  parent_id: optional(isString),
  author_id: isString,
  content: optional(isString),
  created_at: isNumber,
  structure_json: optional(isString),
  is_private: isNumber
});

export async function backfillGovernanceActivity(guild: Guild): Promise<number> {
  const { governance, policy } = requireGovernance(guild.id);
  await guild.channels.fetch();
  const publicIds = new Set([...guild.channels.cache.values()]
    .filter((channel) => {
      const visible = channel.permissionsFor(guild.roles.everyone)?.has(PermissionFlagsBits.ViewChannel);
      return channel.isTextBased?.()
        && !governanceSurface(channel, governance)
        && visible;
    })
    .map((channel) => channel.id));
  const since = Date.now() - policy.eligibility.windowDays * DAY_MS;
  const rows = narrowList(archiveDb.prepare(`
    SELECT m.message_id, m.guild_id, m.channel_id, m.parent_id, m.author_id, m.content, m.created_at, m.structure_json,
      COALESCE(c.is_private, 1) AS is_private
    FROM messages m
    LEFT JOIN channels c ON c.channel_id = m.channel_id
    WHERE m.guild_id = ? AND m.created_at >= ? AND m.deleted = 0
    ORDER BY m.created_at
  `).all(guild.id, since), isArchivedActivity, 'archived activity');
  const activities = [];
  for (const row of rows) {
    if (row.is_private || (!publicIds.has(row.channel_id) && !(row.parent_id && publicIds.has(row.parent_id)))) continue;
    const normalized = normalizeActivityContent(row.content);
    if (Array.from(normalized).length < policy.eligibility.minimumVisibleCharacters || /^[/!]/.test(normalized)) continue;
    activities.push({
      messageId: row.message_id,
      guildId: row.guild_id,
      channelId: row.channel_id,
      parentId: row.parent_id ?? null,
      userId: row.author_id,
      activityDate: activityDate(row.created_at, policy.timezoneOffsetMinutes),
      contentHash: sha256(normalized),
      content: String(row.content ?? ''),
      structureJson: row.structure_json ?? '{}',
      createdAt: row.created_at
    });
  }
  return Number(recordActivities(activities));
}

export async function buildElectorateSnapshot(guild: Guild, proposalId: number) {
  const { governance, policy: activePolicy } = requireGovernance(guild.id);
  const proposal = requireValue(narrow(repairInstitutionProposalScope(proposalId), isProposalRow, 'proposal'), '投票案件が見つかりません。');
  const policy = policyOf(narrow(constitutionForSubject('proposal', proposal), isConstitutionRow, 'constitution')?.policy) ?? activePolicy;
  const scope = proposal.vote_scope ?? policy.voting.defaultScope;
  if (!policy.voting.allowedScopes.includes(scope)) throw new Error('この投票scopeは現行憲法で許可されていません。');
  const members = await guild.members.fetch();
  const rows: { userId: string; eligibleGeneral: boolean; trusted: boolean }[] = [];
  for (const member of members.values()) {
    if (member.user.bot) continue;
    const trusted = Boolean(governance.trusted_role_id) && member.roles.cache.has(governance.trusted_role_id);
    const included = scope === 'all' || (scope === 'trusted' && trusted);
    if (included) {
      rows.push({ userId: member.id, eligibleGeneral: true, trusted });
    }
  }
  snapshotProposalVoters(proposalId, rows);
  return rows;
}

export async function snapshotHumanAuthority(
  guild: Guild,
  authority: Record<string, unknown>,
  exclude: readonly unknown[] = [],
  members: unknown = null
): Promise<HumanAuthoritySnapshot> {
  const governance = governanceGuild(guild.id);
  const operators = narrowList(governanceConfig.operators, isString, 'governance operator');
  return { ...authority, members: narrowList(selectHumanMembers(members ?? await guild.members.fetch(), authority,
    { guild, trustedRoleId: governance?.trusted_role_id, operators, exclude }), isString, 'authority member') };
}

export async function exerciseHumanVeto(interaction: GovernanceActor, subjectType: string, subjectId: number) {
  requireGovernance(interaction.guildId);
  const proposal = subjectType === 'proposal' ? proposalById(subjectId) : null;
  const caseRecord = subjectType === 'case' ? caseById(subjectId) : null;
  const record = proposal ?? caseRecord;
  if (!record || record.guild_id !== interaction.guildId || interaction.user.bot) throw new Error('拒否権の対象が見つかりません。');
  const guild = requireValue(interaction.guild, 'サーバー内でのみ使えます。');
  const result = narrowRequired(castHumanVeto(subjectType, subjectId, interaction.user.id), isVetoResult, 'veto result');
  // Persisted vetoes block commit/execution even if their Discord notice fails.
  if (proposal) {
    await advanceProposal(guild, requireProposal(getProposal(subjectId)));
    await postProposalUpdate(guild, requireProposal(getProposal(subjectId)), `${publicMemberLabel(interaction.user.id)} が拒否権を行使しました。${result.vetoed ? '必要人数に達したため、この案は成立しません。' : `現在 ${result.count}人。`}`);
  } else if (caseRecord) {
    if (result.vetoed) endLegalApproval(caseRecord, 'rejected');
    await postCourtUpdate(guild, requireCase(getCase(subjectId)), `${publicMemberLabel(interaction.user.id)} が拒否権を行使しました。${result.vetoed ? '執行を取りやめます。' : `現在 ${result.count}人。`}`);
  }
  return result;
}

function proposalBody(proposal: ProposalRow): Record<string, unknown> {
  return requireValue(isRecord(proposal.body) ? proposal.body : null, '議案の本文がありません。');
}

function voteRuleFor(proposal: ProposalRow, rules: GovernanceRules) {
  const votes = requireValue(rules.votes, '憲法に投票規則がありません。');
  return proposal.kind === 'amendment' ? votes.constitutionalAmendment : votes.law;
}

export async function openProposalVote(guild: Guild, proposal: ProposalRow, outcome = 'adopted'): Promise<ProposalRow> {
  const { governance } = requireGovernance(guild.id);
  const transition = proposalTransition(proposal, outcome);
  if (transition.target.handler !== 'public_vote') throw new Error('投票開始へ遷移できない案件です。');
  const procedurePolicy = requirePolicy(transition.constitution.policy);
  const voteRule = voteRuleFor(proposal, transition.compiled.rules);
  const snapshot = await buildElectorateSnapshot(guild, proposal.id);
  const now = Date.now();
  const voteEndsAt = proposalStageEnd(transition, now);
  const eligible = snapshot.filter((row) => row.eligibleGeneral).length;
  const trusted = snapshot.filter((row) => row.trusted).length;
  const electorate = specialElectorateName(guild, governance);
  await postProposalUpdate(guild, proposal, [
    `投票を開始しました。締切: <t:${Math.floor(Number(voteEndsAt) / 1000)}:F>`,
    `投票範囲: ${proposal.vote_scope === 'all' ? '全員' : `${electorate}のみ`} / 有権者: ${eligible}人 / ${electorate}: ${trusted}人`,
    `定足数: ${Math.max(procedurePolicy.voting.minimumBallots, Math.ceil(eligible * procedurePolicy.voting.quorumRatio))}票`,
    `成立条件: 投票範囲内の賛否で${Math.round(voteRule.yesRatio * 100)}%${voteRule.comparison === 'gte' ? '以上' : 'を超える'}賛成${proposal.vote_scope === voteRule.trustedVeto.enabledForScope ? `、かつ${electorate}の有効票（賛否）中の反対が${Math.round(voteRule.trustedVeto.noRatio * 100)}%未満` : ''}`
  ].join('\n'), { state: '投票' });
  return requireProposal(updateProposal(proposal.id, {
    status: transition.targetName,
    stage_started_at: now,
    stage_ends_at: voteEndsAt,
    retry_after: null,
    failure_count: 0,
    last_error: null
  }));
}

const isEnactedConstitution = shape({ version: isNumber });
const isEnactedLaw = shape({ id: isNumber, title: isString, version: optional(isNumber) });

async function closeProposalVote(guild: Guild, proposal: ProposalRow): Promise<ProposalRow> {
  const { governance } = requireGovernance(guild.id);
  const runtime = proposalRuntime(proposal);
  if (!runtime || runtime.state.handler !== 'public_vote') throw new Error('この案件は投票中ではありません。');
  const constitution = runtime.constitution;
  const summary = narrowRequired(proposalVoteSummary(proposal.id), isVoteSummary, 'vote summary');
  const result = narrowRequired(closeGovernanceVote(
    { kind: proposal.kind, scope: proposal.vote_scope, ...summary },
    runtime.compiled.rules
  ), isVoteCloseResult, 'vote result');
  if (!result.passed) {
    const electorate = specialElectorateName(guild, governance);
    const transition = proposalTransition(proposal, 'rejected');
    proposal = requireProposal(updateProposal(proposal.id, { status: transition.targetName, stage_ends_at: Date.now() }));
    await postProposalUpdate(guild, proposal, `否決されました。賛成 ${summary.yes} / 反対 ${summary.no} / 棄権 ${summary.abstain} / 定足数 ${summary.yes + summary.no + summary.abstain}/${String(result.quorumNeeded)} / ${electorate}の反対 ${summary.trustedNo}/${summary.trustedTotal}有効票 (棄権 ${summary.trustedAbstain} / 有権者 ${summary.trustedElectorate})`, { state: '否決' });
    return proposal;
  }
  if (proposal.kind === 'amendment') {
    const active = activeConstitution(guild.id);
    if (!proposal.target_hash || Number(proposal.target_id) !== Number(active?.id)
      || proposal.target_hash !== active?.content_hash) {
      const staleTarget = runtime.state.on['stale'] ?? runtime.state.on['rejected'];
      proposal = requireProposal(updateProposal(proposal.id, { status: staleTarget, stage_ends_at: Date.now() }));
      await postProposalUpdate(guild, proposal, '審議中に現行憲法が更新されたため、この案は成立させず差し戻しました。最新版を基礎に再提出してください。', { state: '廃案' });
      return proposal;
    }
    const body = proposalBody(proposal);
    const next = narrowRequired(enactConstitution({
      guildId: guild.id,
      content: body['content'],
      policy: body['policy'],
      bootstrapLaws: body['bootstrapLaws'],
      proposalId: proposal.id,
      enactedBy: 'vote',
      targetConstitutionId: proposal.target_id,
      targetHash: proposal.target_hash
    }), isEnactedConstitution, 'constitution');
    const transition = proposalTransition(proposal, 'passed');
    proposal = requireProposal(updateProposal(proposal.id, { status: transition.targetName, stage_ends_at: Date.now() }));
    await postProposalUpdate(guild, proposal, `改憲が成立しました。憲法 v${next.version} が有効です。`, { state: '成立' });
    try {
      syncLawSite(guild);
    } catch (error) {
      console.error(`Failed to queue constitution v${next.version} for the public law site:`, error);
    }
    // 改憲で既存法との関係が変わり得るため、各現行法を自動的に事後審査へ送る。
    // 審査自体は通常どおり答弁記録期間とpolicy指定のpanelを経る。
    const systemReporter = { id: guild.client.user.id };
    for (const law of narrowList(listLaws(guild.id), isLawRow, 'law')) {
      try {
        await fileConstitutionalChallenge(guild, systemReporter, {
          targetType: 'law',
          targetId: law.id,
          reason: `憲法 v${next.version} 成立に伴う現行法の自動整合性審査`,
          system: true
        });
      } catch (error) {
        console.error(`Failed to queue constitutional review for law ${law.id}:`, error);
      }
    }
    return proposal;
  }
  if (proposal.target_type === 'law') {
    const currentTarget = narrow(getCurrentLawVersion(proposal.target_id), isLawRow, 'law');
    if (!currentTarget || currentTarget.content_hash !== proposal.target_hash) {
      const staleTarget = runtime.state.on['stale'] ?? runtime.state.on['rejected'];
      proposal = requireProposal(updateProposal(proposal.id, { status: staleTarget, stage_ends_at: Date.now() }));
      await postProposalUpdate(guild, proposal, '審議中に改正対象の法律が更新されたため、この案は成立させず差し戻しました。最新版を基礎に再提出してください。', { state: '廃案' });
      return proposal;
    }
  }
  const body = proposalBody(proposal);
  const law = narrowRequired(enactLaw({
    guildId: guild.id,
    proposalId: proposal.id,
    code: `LAW-${proposal.id}-R${proposal.revision}`,
    title: proposal.title,
    text: body['text'],
    provisions: body['provisions'],
    constitutionId: constitution.id,
    supersedesLawId: proposal.target_type === 'law' ? Number(proposal.target_id) : null,
    targetHash: proposal.target_hash,
    effectiveAt: Date.now()
  }), isEnactedLaw, 'law');
  const transition = proposalTransition(proposal, 'passed');
  proposal = requireProposal(updateProposal(proposal.id, { status: transition.targetName, stage_ends_at: Date.now() }));
  await postProposalUpdate(guild, proposal, proposal.target_type === 'law'
    ? `可決・成立しました。「${law.title}」v${law.version} が有効です。旧版は履歴として保存します。`
    : `可決・成立しました。「${law.title}」はこの時点から有効です。`, { state: '成立' });
  try {
    syncLawSite(guild);
  } catch (error) {
    console.error(`Failed to queue law ${law.id} for the public law site:`, error);
  }
  return proposal;
}

const VOTE_LABELS: Record<string, string> = { yes: '賛成', no: '反対', abstain: '棄権' };
const APPROVAL_LABELS: Record<string, string> = { approve: '承認', reject: '拒否' };
const REVIEW_TARGET_NAMES: Record<string, string> = { law: '法律', case: '判決', sanction: '処分', administrative_act: '行政行為' };
const isCastVote = shape({ proposal: isProposalRow, oldChoice: nullable(isString) });

export async function castAndPublishVote(interaction: GovernanceActor, proposalId: number, choice: string) {
  const { governance } = requireGovernance(interaction.guildId);
  if (proposalById(proposalId)?.guild_id !== interaction.guildId) throw new Error('このサーバーの投票案件ではありません。');
  if (!governanceActionAllowed(interaction.guildId, interaction.user.id, 'vote')) throw new Error('投票権が制裁により停止されています。');
  const guild = requireValue(interaction.guild, 'サーバー内でのみ使えます。');
  const result = narrowRequired(castProposalVote(proposalId, interaction.user.id, choice), isCastVote, 'vote');
  const proposal = result.proposal;
  const label = VOTE_LABELS[choice];
  const oldLabel = (result.oldChoice === null ? undefined : VOTE_LABELS[result.oldChoice]) ?? result.oldChoice;
  await postProposalUpdate(guild, proposal, `${publicMemberLabel(interaction.user.id)} が ${label} に投票しました${oldLabel ? ` (変更前: ${oldLabel})` : ''}。`);
  writeAudit({ guildId: requireValue(interaction.guildId, 'サーバー内でのみ使えます。'), actorType: 'member', actorId: interaction.user.id, action: 'vote.cast', targetType: 'proposal', targetId: proposalId, detail: { oldChoice: result.oldChoice, choice, public: true } });
  return { proposal, governance, choice };
}

function evidenceTime(entry: unknown): number {
  return Number(isRecord(entry) ? entry['occurredAt'] : undefined);
}

export async function fileCriminalCase(guild: Guild, reporter: Reporter, input: CriminalCaseInput): Promise<CaseRow> {
  const { constitution, policy } = requireGovernance(guild.id);
  if (recoveryOf(constitution.rules)) throw new Error('制度修復中は新しい処罰手続を開始できません。');
  if (!governanceActionAllowed(guild.id, reporter.id, 'petition')) throw new Error('事件申立てが制裁により停止されています。');
  const law = lawById(input.lawId);
  if (!law || law.guild_id !== guild.id || law.status !== 'active') throw new Error('有効な法律ではありません。');
  const offense = law.provisions.offenses?.find((entry) => entry.code === input.offenseCode);
  if (!offense) throw new Error('その法律に指定された犯罪構成要件がありません。');
  const evidenceRows = input.evidences ?? [input.evidence];
  if (!evidenceRows.length || evidenceRows.some((entry) => evidenceTime(entry) < law.effective_at)) {
    throw new Error('法律の施行前の行為には適用できません。');
  }
  if (!input.attemptReserved) requireGovernanceAiAttempt(reporter, input.eventId ?? `case:${reporter.id}:${Date.now()}`);
  const procedure = procedureOf(policy);
  const latestEvidence = evidenceRows.at(-1);
  const caseRecord = requireCase(createCase({
    guildId: guild.id,
    reporterId: reporter.id,
    accusedId: input.accused.id,
    lawId: law.id,
    offenseCode: offense.code,
    summary: input.summary,
    status: procedure ? 'police_review' : 'filing',
    defenseUntil: null,
    allegedAt: isRecord(latestEvidence) ? latestEvidence['occurredAt'] : undefined,
    constitutionId: constitution.id,
    procedureVersion: procedure ? 2 : 1,
    policeEventKey: input.policeEventKey ?? null,
    reporterType: input.official ? 'ai' : 'member'
  }));
  for (const evidence of evidenceRows) {
    addCaseEvidence({ caseId: caseRecord.id, submittedBy: reporter.id, ...(isRecord(evidence) ? evidence : {}) });
  }
  try {
    if (policy.autonomous) {
      await advanceCase(guild, caseRecord);
      return requireCase(getCase(caseRecord.id));
    }
    return procedure
      ? await finishPoliceReview(guild, caseRecord)
      : await finishCaseFiling(guild, caseRecord);
  } catch (error) {
    updateCase(caseRecord.id, retryPatch(caseById(caseRecord.id), error));
    console.error(`Initial court setup failed for case ${caseRecord.id}:`, error);
    throw acceptedWorkflowError(
      '申立てを受理しました。準備ができると裁判所に表示されます。',
      'case',
      caseRecord.id
    );
  }
}

function profileForSanction(law: LawRow, sanction: SanctionChoice, policy: GovernancePolicy): unknown {
  if (sanction.type !== 'restriction') return null;
  const definition = narrow(getSanctionDefinition(law.id, sanction.definitionCode), isSanctionDefinitionRow, 'sanction definition');
  if (!definition || !validateRestrictionDefinition(definition.profile, policy)) {
    throw new Error('成立法に有効な制裁定義がありません。');
  }
  return definition.profile;
}

async function notifyPoliceSanction(guild: Guild, caseRecord: CaseRow, sanction: SanctionRow): Promise<boolean> {
  const member = await guild.members.fetch(sanction.user_id).catch(() => null);
  if (!member) return false;
  const label = sanction.type === 'warning'
    ? '警告'
    : sanction.type === 'restriction'
      ? '機能制限'
      : `タイムアウト ${sanction.duration_seconds}秒`;
  const delivered = await member.send({
    content: [
      `**${guild.name}からの即時処分通知**`,
      `処分: ${label}`,
      `理由: ${caseRecord.summary}`,
      '',
      'この処分に異議がある場合は「裁判を求める」を押してください。',
      sanction.type === 'warning' ? '警告は期限なく一度だけ裁判を求められます。' : '処分が続いている間、一度だけ裁判を求められます。'
    ].join('\n').slice(0, 1_900),
    components: contestButtons(guild.id, sanction.id),
    allowedMentions: { parse: [] }
  }).then(() => true).catch(() => false);
  updateSanction(sanction.id, { notice_delivered: delivered ? 1 : 0 });
  return delivered;
}

const SANCTION_LABELS: Record<string, string> = {
  warning: '警告', restriction: '機能制限', timeout: 'タイムアウト', kick: 'キック', ban: '参加禁止'
};

function sanctionLabel(sanction: { type?: string; duration_seconds?: number | null; durationSeconds?: number | null } | null | undefined): string {
  const name = (sanction?.type ? SANCTION_LABELS[sanction.type] : undefined) ?? '処分';
  const seconds = Number(sanction?.duration_seconds ?? sanction?.durationSeconds ?? 0);
  if (!seconds) return name;
  if (seconds % 86_400 === 0) return `${name} ${seconds / 86_400}日`;
  if (seconds % 3_600 === 0) return `${name} ${seconds / 3_600}時間`;
  return `${name} ${Math.ceil(seconds / 60)}分`;
}

// 拘留は罰ではなく審理を確保する保全。裁判所へ送った事件の答弁期間だけ、
// 憲法が定める上限の範囲で置く。経過時間は後の期間処分から差し引く。
async function detainForCourt(guild: Guild, caseRecord: CaseRow, procedure: PoliceProcedure) {
  const { governance } = requireGovernance(guild.id);
  if (getCaseDetention(caseRecord.id)) return null;
  const now = Date.now();
  const seconds = Math.min(
    procedure.detentionMaximumSeconds,
    Math.max(0, Math.floor(((caseRecord.defense_until ?? now) - now) / 1000))
  );
  if (seconds <= 0) return null;
  const detention = narrowRequired(createDetention({
    caseId: caseRecord.id,
    guildId: guild.id,
    userId: caseRecord.accused_id,
    reason: caseRecord.summary,
    durationSeconds: seconds,
    startedAt: now,
    endsAt: now + seconds * 1000,
    status: governance.enforcement_mode === 'live' ? 'active' : 'simulated'
  }), isDetentionRow, 'detention');
  writeAudit({
    guildId: guild.id,
    actorType: 'system',
    action: 'detention.started',
    targetType: 'case',
    targetId: caseRecord.id,
    detail: { userId: caseRecord.accused_id, durationSeconds: seconds, mode: governance.enforcement_mode }
  });
  await postEnforcementRecord(guild, governance, [
    '## 拘留',
    `対象: ${publicMemberLabel(caseRecord.accused_id, '動作確認用アカウント')}`,
    `期間: ${Math.round(seconds / 60)}分（<t:${Math.floor(detention.ends_at / 1000)}:R>まで）`,
    '罰ではなく、裁判所の審理を確保するための保全です。拘留中も自分の事件記録では反論できます。',
    governance.enforcement_mode === 'live' ? null : '（記録のみ・実際の制限はかけていません）'
  ].filter(Boolean).join('\n'));
  return detention;
}

export async function releaseCaseDetention(guild: Guild, caseId: number): Promise<unknown> {
  const detention = narrow(getCaseDetention(caseId), isDetentionRow, 'detention');
  if (!detention || detention.status !== 'active') return null;
  const released: unknown = releaseDetention(caseId);
  writeAudit({
    guildId: guild.id,
    actorType: 'system',
    action: 'detention.released',
    targetType: 'case',
    targetId: caseId,
    detail: { userId: detention.user_id, detainedSeconds: detainedSeconds(caseId) }
  });
  return released;
}

async function continuePoliceSanction(guild: Guild, caseRecord: CaseRow, sanction: SanctionRow, procedure: PoliceProcedure): Promise<CaseRow> {
  const policy = casePolicy(caseRecord);
  const courtFirst = procedure.courtFirstSanctions.includes(sanction.type)
    || (Boolean(policy.autonomous) && sanction.type === 'timeout' && Number(sanction.duration_seconds) > policy.judiciary.immediateTimeoutMaximumSeconds);
  if (courtFirst) {
    if (caseRecord.status === 'defense' || caseRecord.public_thread_id) return caseRecord;
    // 追放・参加禁止は警察が実行できない。裁判所へ送り、その審理の間だけ拘留する。
    let current = requireCase(updateCase(caseRecord.id, { status: 'filing', review_count: 1 }));
    if (policy.autonomous && current.workflow_handler !== 'case_filing') return current;
    current = await finishCaseFiling(guild, current);
    await detainForCourt(guild, current, procedure);
    await postCourtUpdate(guild, current, `${sanctionLabel(sanction)}は警察が実行できません。裁判所が審理し、本人の回答を待って<t:${Math.floor(Number(current.defense_until) / 1000)}:F>までに判定します。`, { state: '答弁' });
    return current;
  }
  if (sanction.status === 'reviewable') {
    return requireCase(updateCase(caseRecord.id, sanction.type === 'warning'
      ? { status: 'final', finalized_at: caseRecord.finalized_at ?? Date.now() }
      : { status: 'contest_window' }));
  }
  if (sanction.required_approvals > 0) {
    if (caseRecord.status === 'approval') return caseRecord;
    await beginCaseApproval(
      guild,
      caseRecord,
      sanction,
      `執行には法令で定める承認者${sanction.required_approvals}人の公開承認が必要です。`
    );
    return requireCase(getCase(caseRecord.id));
  }
  if (caseRecord.status !== 'execution') {
    if (!sanction.notice_delivered) await notifyPoliceSanction(guild, caseRecord, sanction);
    queueExecution(caseRecord, requireSanction(getSanction(sanction.id)));
  }
  await processGovernanceOutbox(guild.client);
  return requireCase(getCase(caseRecord.id));
}

export async function ensurePublicCaseRecord(guild: Guild, caseRecord: CaseRow): Promise<CaseRow> {
  if (caseRecord.public_thread_id) return caseRecord;
  const { governance } = requireGovernance(guild.id);
  let current = caseRecord;
  const thread = await createCourtCaseThread(guild, governance, current, {
    onPartial: (patch) => { current = requireCase(updateCase(current.id, patch)); }
  });
  if (!current.public_thread_id) current = requireCase(updateCase(current.id, { public_thread_id: thread.publicThreadId }));
  await ensureEvidenceDisclosures(guild, current);
  return current;
}

function lawForCaseRecord(caseRecord: CaseRow): LawRow {
  return narrowRequired(lawForCase(caseRecord), isLawRow, 'law');
}

async function finishPoliceReview(guild: Guild, caseRecord: CaseRow): Promise<CaseRow> {
  requireGovernance(guild.id);
  const constitution = constitutionForCase(caseRecord);
  const policy = policyOf(constitution?.policy);
  const procedure = procedureOf(policy);
  if (!procedure) return finishCaseFiling(guild, caseRecord);
  // 警察手続は policy から読んだので、ここでは policy が必ずある。
  const lawPolicy = requireValue(policy, '有効な憲法の実行値がありません。');
  let current = requireCase(getCase(caseRecord.id));
  const law = lawForCaseRecord(current);
  const offense = law.provisions.offenses?.find((entry) => entry.code === current.offense_code);
  if (!offense) throw new Error('犯罪構成要件が法律にありません。');
  const existingSanction = caseSanction(current.id);
  if (existingSanction) return continuePoliceSanction(guild, current, existingSanction, procedure);
  const evidence = caseEvidence(current.id);
  const panel = await runJudicialPanel({
    guildId: guild.id,
    caseRecord: current,
    law,
    offense,
    evidence,
    submissions: [],
    policy: lawPolicy,
    phase: 'police'
  });
  current = requireCase(updateCase(current.id, {
    panel_id: panel.panelId,
    verdict: { phase: 'police', verdict: panel.verdict, sanction: panel.sanction, panelId: panel.panelId }
  }));
  const policeAudit = [
    `対象: ${publicMemberLabel(current.accused_id, '動作確認用アカウント')}`,
    `申立内容: ${current.summary}`,
    ...publicLawDetails(law, current.offense_code),
    `有効な違反認定: ${panel.outputs.filter((entry) => entry.verdict === 'responsible').length}/${procedure.panelSeats}`,
    `無効・失敗席: ${panel.failedSeats}`,
    '',
    ...investigationLines(panel, lawPolicy),
    '',
    '```json',
    JSON.stringify({
      outputs: publicPanelOutputs(panel.outputs, new Map(evidence.map((entry, index) => [entry.id, index + 1])))
    }, null, 2),
    '```'
  ].join('\n');
  const { governance } = requireGovernance(guild.id);
  if (panel.verdict !== 'responsible' || !panel.sanction) {
    current = requireCase(updateCase(current.id, { status: 'acquitted', finalized_at: Date.now() }));
    await postEnforcementRecord(guild, governance, [
      '## 不受理',
      `対象: ${publicMemberLabel(current.accused_id, '動作確認用アカウント')}`,
      ...publicLawDetails(law, current.offense_code),
      '成立法の必要票に達しなかったため、処分せず終えました。'
    ].join('\n'), { files: [{ attachment: Buffer.from(policeAudit), name: '警察の判断.md' }] });
    return current;
  }
  const profile = profileForSanction(law, panel.sanction, lawPolicy);
  const trialFirst = procedure.courtFirstSanctions.includes(panel.sanction.type)
    || (Boolean(lawPolicy.autonomous) && panel.sanction.type === 'timeout' && Number(panel.sanction.durationSeconds) > lawPolicy.judiciary.immediateTimeoutMaximumSeconds);
  const sanction = requireSanction(createSanction({
    caseId: current.id,
    guildId: guild.id,
    userId: current.accused_id,
    type: panel.sanction.type,
    durationSeconds: panel.sanction.durationSeconds,
    definitionCode: panel.sanction.definitionCode,
    profile,
    status: trialFirst ? 'proposed' : 'queued',
    requiredApprovals: requiredApprovals(panel.sanction, lawPolicy),
    appealable: isAppealable(panel.sanction, lawPolicy),
    restrictionStartedAt: trialFirst ? null : Date.now()
  }));
  return continuePoliceSanction(guild, current, sanction, procedure);
}

async function finishCaseFiling(guild: Guild, caseRecord: CaseRow): Promise<CaseRow> {
  const { governance } = requireGovernance(guild.id);
  const policy = casePolicy(caseRecord);
  const procedure = procedureOf(policy);
  let current = requireCase(getCase(caseRecord.id));
  const thread = await createCourtCaseThread(guild, governance, current, {
    onPartial: (patch) => { current = requireCase(updateCase(current.id, patch)); }
  });
  const defenseUntil = Date.now() + casePeriod(current, 'defense', 'defense_window', procedure?.contestMilliseconds ?? policy.judiciary.defenseMilliseconds);
  current = requireCase(updateCase(current.id, {
    status: 'defense',
    public_thread_id: thread.publicThreadId,
    defense_until: defenseUntil,
    decision_due_at: defenseUntil,
    retry_after: null,
    failure_count: 0,
    last_error: null
  }));
  await ensureEvidenceDisclosures(guild, current);
  await postCourtUpdate(guild, current, `答弁期限: <t:${Math.floor(defenseUntil / 1000)}:F>`, { state: '答弁' });
  await notifyCaseParty(guild, current, 'defense', defenseUntil);
  return current;
}

export async function addEvidenceToCase(guild: Guild, member: { id: string }, caseId: number, evidence: unknown): Promise<number> {
  const caseRecord = caseById(caseId);
  if (!caseRecord || caseRecord.guild_id !== guild.id) throw new Error('事件が見つかりません。');
  if (!['defense', 'appeal'].includes(caseRecord.status)) throw new Error('証拠受付中ではありません。');
  if (![caseRecord.reporter_id, caseRecord.accused_id].includes(member.id)) throw new Error('この事件の当事者ではありません。');
  const defenseEvidenceOwner = caseRecord.accused_id ?? caseRecord.reporter_id;
  if (caseRecord.procedure_version === 2 && member.id !== defenseEvidenceOwner) {
    throw new Error('迅速裁判の取締り側証拠は開始時点で固定されています。新しい行為は別事件として申し立ててください。');
  }
  if (caseEvidence(caseId).length >= CASE_EVIDENCE_LIMIT) {
    throw new Error(`証拠は事件ごとに${CASE_EVIDENCE_LIMIT}件までです。関連する内容を1件の提出にまとめてください。`);
  }
  const id = Number(addCaseEvidence({ caseId, submittedBy: member.id, ...(isRecord(evidence) ? evidence : {}) }));
  await ensureEvidenceDisclosures(guild, caseById(caseId));
  return id;
}

function evidenceDisclosure(entry: EvidenceRow & { guild_id: string }, ordinal: number): string {
  const source = entry.message_id && entry.channel_id
    ? `[元の投稿を開く](https://discord.com/channels/${entry.guild_id ?? '@me'}/${entry.channel_id}/${entry.message_id})`
    : '保存された提出';
  return [
    `## 証拠 ${ordinal}`,
    `提出者: ${publicMemberLabel(entry.submitted_by, '動作確認用提出者')} / 原投稿者: ${entry.author_id ? publicMemberLabel(entry.author_id, '動作確認用投稿者') : '-'}`,
    `行為時刻: ${entry.occurred_at ? `<t:${Math.floor(entry.occurred_at / 1000)}:F>` : '-'}`,
    `出典: ${source}`,
    '',
    String(entry.content).slice(0, 1500)
  ].join('\n');
}

async function ensureEvidenceDisclosures(guild: Guild, caseRecord: CaseRow | null): Promise<void> {
  if (!caseRecord?.public_thread_id) return;
  const evidence = caseEvidence(caseRecord.id);
  for (const [index, entry] of evidence.entries()) {
    if (entry.disclosed_at) continue;
    const withGuild = { ...entry, guild_id: guild.id };
    await postCourtRecord(guild, caseRecord, evidenceDisclosure(withGuild, index + 1));
    markEvidenceDisclosed(entry.id);
  }
}

const VERDICT_LABELS: Record<string, string> = { responsible: '責任あり', not_responsible: '責任なし', insufficient: '立証不十分' };

async function publishDecisionRecord(guild: Guild, caseRecord: CaseRow, phase: string, panel: JudicialPanel): Promise<void> {
  const evidence = caseEvidence(caseRecord.id);
  const evidenceOrder = new Map(evidence.map((entry, index) => [entry.id, index + 1]));
  const law = lawById(caseRecord.law_id);
  const phaseLabel = phase === 'appeal' ? '上訴審' : '第一審';
  const publicLines = panel.outputs.map((output, index) => [
    `席 ${index + 1}: ${VERDICT_LABELS[output.verdict] ?? output.verdict}`,
    `採用証拠: ${(output.evidenceIds ?? []).map((id) => `証拠 ${evidenceOrder.get(id) ?? '?'}`).join('、') || 'なし'}`,
    `処分: ${output.sanction ? `${output.sanction.type}${output.sanction.durationSeconds ? ` ${output.sanction.durationSeconds}秒` : ''}` : '-'}`
  ].join(' / '));
  await postCourtUpdate(guild, caseRecord, [
    `判決記録（${phaseLabel}）`,
    ...publicLawDetails(law, caseRecord.offense_code),
    ...publicLines,
    ...investigationLines(panel, policyOf(constitutionForCase(caseRecord).policy))
  ].join('\n'));

  await postCourtRecord(guild, caseRecord, '構成要件ごとの判断・理由・採用証拠を添付します。', {
    files: [{
      attachment: Buffer.from(`${JSON.stringify({
        phase,
        law: law?.title ?? '裁判記録に記載',
        offense: law?.provisions?.offenses?.find((entry) => entry.code === caseRecord.offense_code)?.title ?? '裁判記録に記載',
        allegedAt: caseRecord.alleged_at ? new Date(caseRecord.alleged_at).toISOString() : null,
        outputs: publicPanelOutputs(panel.outputs, evidenceOrder)
      }, null, 2)}\n`),
      name: `${phaseLabel}-判決記録.json`
    }]
  });
}

function reviewTarget(targetType: unknown, targetId: unknown): ReviewTarget | null {
  if (targetType === 'law') { const record = lawById(targetId); return record ? { type: 'law', record } : null; }
  if (targetType === 'case') { const record = caseById(targetId); return record ? { type: 'case', record } : null; }
  if (targetType === 'sanction') { const record = sanctionById(targetId); return record ? { type: 'sanction', record } : null; }
  if (targetType === 'administrative_act') {
    const record = narrow(getAdministrativeAct(targetId), isAdministrativeActRow, 'administrative act');
    return record ? { type: 'administrative_act', record } : null;
  }
  return null;
}

export async function fileConstitutionalChallenge(guild: Guild, reporter: { id: string }, input: ConstitutionalChallengeInput): Promise<CaseRow> {
  const { constitution, policy } = requireGovernance(guild.id);
  const target = reviewTarget(input.targetType, input.targetId);
  if (!target || target.record.guild_id !== guild.id) throw new Error('審査対象が見つかりません。');
  const existing = narrow(findOpenConstitutionalCase(guild.id, input.targetType, input.targetId), isCaseRow, 'case');
  if (existing) throw new Error('同じ対象の違憲審査が進行中です。裁判所で確認してください。');
  if (!input.system && !input.attemptReserved) {
    const attempt = reservation(reserveAgentAttempt(
      guild.id,
      reporter.id,
      false,
      policy.judiciary.constitutionalChallengesPerMemberPerDay,
      DAY_MS,
      'constitutional_challenge'
    ));
    if (!attempt.ok) throw new Error(`違憲審査申立ての24時間枠に達しました (${attempt.used}/${attempt.limit})。`);
  }
  const caseRecord = requireCase(createCase({
    guildId: guild.id,
    kind: 'constitutional',
    reporterId: reporter.id,
    challengedType: input.targetType,
    challengedId: String(input.targetId),
    summary: input.reason,
    status: 'filing',
    defenseUntil: null,
    constitutionId: constitution.id,
    procedureVersion: procedureOf(policy) ? 2 : 1,
    reporterType: input.official ? 'ai' : 'member'
  }));
  addCaseEvidence({ caseId: caseRecord.id, submittedBy: reporter.id, content: input.reason, occurredAt: Date.now() });
  try {
    if (policy.autonomous) {
      await advanceCase(guild, caseRecord);
      return requireCase(getCase(caseRecord.id));
    }
    return await finishCaseFiling(guild, caseRecord);
  } catch (error) {
    updateCase(caseRecord.id, retryPatch(caseById(caseRecord.id), error));
    console.error(`Initial court setup failed for constitutional case ${caseRecord.id}:`, error);
    throw acceptedWorkflowError(
      '違憲審査を受理しました。準備ができると裁判所に表示されます。',
      'case',
      caseRecord.id
    );
  }
}

// 受信した添付 (Collection) と検査用の配列の両方を読む。
function attachmentLines(attachments: unknown): string[] {
  const values: unknown[] = attachments instanceof Map ? [...attachments.values()] : Array.isArray(attachments) ? attachments : [];
  return values.map((attachment) => {
    const entry = isRecord(attachment) ? attachment : {};
    return `[添付] ${String(entry['name'])} ${String(entry['url'])}`;
  });
}

function courtSubmissionText(message: GovernanceMessage | PartialMessage): string {
  return [
    message.content,
    ...attachmentLines(message.attachments)
  ].filter(Boolean).join('\n') || '(本文なし)';
}

async function courtMessageContext(message: GovernanceMessage | PartialMessage): Promise<{ caseRecord: CaseRow | null; blocked: boolean }> {
  if (!message?.guildId || message.author?.bot) return { caseRecord: null, blocked: false };
  const governance = governanceGuild(message.guildId);
  let member = message.member ?? null;
  const members = message.guild?.members;
  if (!member && members?.fetch && message.author) {
    member = await members.fetch(message.author.id).catch(() => null);
  }
  const isAppealRestricted = Boolean(governance?.appeal_role_id
    && member?.roles?.cache?.has(governance.appeal_role_id));
  const caseRecord = message.channel?.isThread?.() ? narrow(getCaseByPublicThread(message.channelId), isCaseRow, 'case') : null;
  if (isAppealRestricted
    && (!caseRecord || !(caseRecord.status === 'appeal' && caseRecord.accused_id === message.author?.id))) {
    const deleted = await message.delete().then(() => true).catch(() => false);
    writeAudit({
      guildId: message.guildId,
      actorType: 'system',
      action: deleted ? 'appeal.message_blocked' : 'appeal.message_block_failed',
      targetType: 'member',
      targetId: message.author?.id ?? null,
      detail: { messageId: message.id, channelId: message.channelId }
    });
    await message.author?.send(`${message.guild?.name ?? 'このコミュニティ'}では、上訴中は自分の上訴事件以外へ投稿できません。`).catch(() => {});
    return { caseRecord, blocked: true };
  }
  return { caseRecord, blocked: false };
}

export async function recordCourtSubmission(message: GovernanceMessage): Promise<boolean | 'blocked'> {
  const { caseRecord, blocked } = await courtMessageContext(message);
  if (blocked) return 'blocked';
  if (!caseRecord) return false;
  const isParty = [caseRecord.reporter_id, caseRecord.accused_id].filter(Boolean).includes(message.author.id);
  if (caseRecord.procedure_version === 2) {
    const deleted = await message.delete().then(() => true).catch(() => false);
    writeAudit({
      guildId: message.guildId ?? '',
      actorType: 'system',
      action: 'court.direct_message_blocked',
      targetType: 'case',
      targetId: caseRecord.id,
      detail: { userId: message.author.id, messageId: message.id, isParty, deleted }
    });
    await message.author.send(isParty
      ? `${message.guild?.name}の裁判回答は事件投稿の「回答を書く」「証拠を出す」ボタンから提出してください。`
      : `${message.guild?.name}の公開裁判は閲覧できますが、投稿できるのは当事者だけです。`).catch(() => {});
    return 'blocked';
  }
  if (!['defense', 'appeal'].includes(caseRecord.status) || !isParty) return false;
  const phaseCount = currentSubmissions(caseRecord.id)
    .filter((entry) => entry.kind === caseRecord.status).length;
  if (phaseCount >= CASE_SUBMISSION_LIMIT_PER_PHASE) {
    await message.reply({
      content: `この審級の主張記録は${CASE_SUBMISSION_LIMIT_PER_PHASE}件が上限です。新しい論点は既存の主張を参照して簡潔にまとめてください。`,
      allowedMentions: { parse: [] }
    }).catch(() => {});
    return false;
  }
  const submission = courtSubmissionText(message);
  addCaseSubmission(caseRecord.id, message.author.id, caseRecord.status, submission.slice(0, 8000), {
    sourceMessageId: message.id ?? null
  });
  return true;
}

const isReplacedSubmission = shape({ unchanged: optional(isUnknown) });

export async function recordCourtSubmissionEdit(message: GovernanceMessage): Promise<boolean | 'blocked'> {
  const { caseRecord, blocked } = await courtMessageContext(message);
  if (blocked) return 'blocked';
  if (!caseRecord || !message.id) return false;
  const isParty = [caseRecord.reporter_id, caseRecord.accused_id].filter(Boolean).includes(message.author.id);
  if (!isParty) return false;
  const existing = currentSubmissions(caseRecord.id)
    .find((entry) => entry.source_message_id === message.id && entry.author_id === message.author.id);
  if (!existing) return false;
  if (!['defense', 'appeal'].includes(caseRecord.status) || existing.kind !== caseRecord.status) {
    if ('send' in message.channel) {
      await message.channel.send({
        content: `${publicMemberLabel(message.author.id)} が締切後に正式主張を編集しました。この編集は判決資料へ反映しません。`,
        allowedMentions: { parse: [] }
      }).catch(() => {});
    }
    return false;
  }
  const changed = narrow(replaceCaseSubmission(
    caseRecord.id,
    message.author.id,
    caseRecord.status,
    courtSubmissionText(message).slice(0, 8000),
    message.id
  ), isReplacedSubmission, 'case submission');
  if (!changed || changed.unchanged) return false;
  if ('send' in message.channel) {
    await message.channel.send({
      content: [
        `${publicMemberLabel(message.author.id)} が正式主張を編集しました。`,
        '変更前の内容も監査履歴に残し、判決には変更後の正本だけを使用します。'
      ].join('\n'),
      allowedMentions: { parse: [] }
    }).catch(() => {});
  }
  return true;
}

async function beginAppealWindow(guild: Guild, caseRecord: CaseRow, sanction: SanctionRow): Promise<void> {
  const policy = casePolicy(caseRecord);
  const procedure = procedureOf(policy);
  const now = Date.now();
  sanction = requireSanction(updateSanction(sanction.id, {
    status: 'pending_appeal',
    appeal_deadline: now + casePeriod(caseRecord, 'appeal_window', 'appeal_window', policy.judiciary.appealMilliseconds),
    restriction_started_at: procedure ? sanction.restriction_started_at : null
  }));
  caseRecord = requireCase(updateCase(caseRecord.id, { status: 'appeal_window' }));
  const appealDeadline = Number(sanction.appeal_deadline);
  await postCourtUpdate(guild, caseRecord, `この刑は上訴対象です。期限: <t:${Math.floor(appealDeadline / 1000)}:F>。上訴しなければ自動確定します。`, { state: '上訴' });
  await notifyCaseParty(guild, caseRecord, 'appeal', sanction.appeal_deadline);
}

function legalApproval(caseId: number, now?: number) {
  return narrowRequired(now === undefined ? legalApprovalResult(caseId) : legalApprovalResult(caseId, now), isApprovalResult, 'approval result');
}

function queueExecution(caseRecord: CaseRow, sanction: SanctionRow): void {
  if (['pending_manual_execution', 'pending_manual_reversal'].includes(sanction.status)) return;
  if (requiresManualExecution(sanction) && ['reversing', 'reversed', 'unavailable'].includes(sanction.status)) return;
  const constitution = constitutionForCase(caseRecord);
  const autonomous = autonomousPolicy(constitution.policy);
  const vetoRequired = autonomous && Object.values(requireValue(caseRules(caseRecord).workflows['criminalCase'], '刑事手続がありません。').states)
    .some((state) => state.handler === 'human_approval' && state.config.veto);
  if (vetoRequired && !legalApproval(caseRecord.id).passed) {
    updateSanction(sanction.id, { status: 'pending_approval' });
    updateCase(caseRecord.id, { status: 'approval' });
    return;
  }
  if (autonomous && sanction.required_approvals > 0 && !legalApproval(caseRecord.id).passed) throw new Error('法令で必要な人間の執行承認がそろっていません。');
  const current = requireCase(updateCase(caseRecord.id, { status: 'execution' }));
  if (autonomousPolicy(constitutionForCase(current).policy) && current.workflow_handler !== 'sanction_execution') return;
  // 拘留していた時間は刑期から差し引く。第十条4。
  const detained = Number(detainedSeconds(caseRecord.id));
  if (detained > 0 && sanction.duration_seconds && !sanction.restriction_started_at) {
    updateSanction(sanction.id, { restriction_started_at: Date.now() - detained * 1000 });
  }
  updateSanction(sanction.id, { status: 'queued' });
  enqueueAction({
    guildId: sanction.guild_id,
    actionType: 'sanction_execute',
    targetId: sanction.id,
    payload: { sanctionId: sanction.id },
    idempotencyKey: `sanction-execute:${sanction.execution_key}`
  });
}

async function trustedApprovers(guild: Guild, governance: GovernanceGuildRow | null, caseRecord: CaseRow): Promise<GuildMember[]> {
  return governance?.trusted_role_id
    ? await guild.members.fetch().then((members) => [...members.values()].filter((member) => !member.user.bot
      && member.roles.cache.has(governance.trusted_role_id)
      && ![caseRecord.accused_id, caseRecord.reporter_id].includes(member.id)))
    : [];
}

async function beginCaseApproval(guild: Guild, caseRecord: CaseRow, sanction: SanctionRow, text: string): Promise<unknown> {
  if (autonomousPolicy(constitutionForCase(caseRecord).policy)) return beginLegalApproval(guild, caseRecord, sanction, text);
  const governance = governanceGuild(guild.id);
  const electorate = specialElectorateName(guild, governance);
  const trustedMembers = await trustedApprovers(guild, governance, caseRecord);
  if (trustedMembers.length < sanction.required_approvals) {
    updateSanction(sanction.id, { status: 'unavailable' });
    updateCase(caseRecord.id, { status: 'unenforceable', finalized_at: Date.now() });
    await postCourtUpdate(guild, requireCase(getCase(caseRecord.id)), `判決は記録しましたが、独立した「${electorate}」の承認者が ${trustedMembers.length}/${sanction.required_approvals} 人しかいないため、この刑は執行不能として終了します。`, { state: '確定' });
    return false;
  }
  updateSanction(sanction.id, { status: 'pending_approval' });
  updateCase(caseRecord.id, { status: 'approval' });
  await postCourtUpdate(guild, requireCase(getCase(caseRecord.id)), text, { state: '承認待ち' });
  return true;
}

async function beginLegalApproval(guild: Guild, caseRecord: CaseRow, sanction: SanctionRow, text: string): Promise<CaseRow | undefined> {
  if (!caseRecord.public_thread_id) caseRecord = await ensurePublicCaseRecord(guild, caseRecord);
  updateSanction(sanction.id, { status: 'pending_approval' });
  if (caseRecord.workflow_handler !== 'human_approval') caseRecord = requireCase(updateCase(caseRecord.id, { status: 'approval' }));
  if (caseRecord.workflow_handler !== 'human_approval') return;
  const instance = requireValue(workflowInstance('case', caseRecord.id), '案件の手続状態がありません。');
  const stage = requireValue(caseStage(caseRules(caseRecord), instance).stage, '案件に適用される手続段階がありません。');
  const currentApproval = narrow(instance.context['approval'], isApprovalContext, 'approval');
  if (!currentApproval || currentApproval.sanctionHash !== sanctionApprovalHash(sanction)) {
    const fetched = await guild.members.fetch();
    const exclude = [caseRecord.accused_id, caseRecord.reporter_id];
    const authority = { scope: stage.config.scope, ...(stage.config.users ? { users: stage.config.users } : {}), ...(stage.config.roles ? { roles: stage.config.roles } : {}) };
    const { members } = await snapshotHumanAuthority(guild, authority, exclude, fetched);
    const veto = stage.config.veto ? await snapshotHumanAuthority(guild, stage.config.veto, exclude, fetched) : null;
    const now = Date.now();
    const deadline = now + durationMs(stage.duration);
    transitionWorkflowInstance({ subjectType: 'case', subjectId: caseRecord.id, toState: instance.current_state,
      context: { ...instance.context, approval: { openedAt: now, deadline,
        members, authority, veto, scope: stage.config.scope, rejectVotes: stage.config.rejectVotes, sanctionHash: sanctionApprovalHash(sanction) } }, eventType: 'approval.opened' });
    const rejectVotes = Number(stage.config.rejectVotes);
    await postCourtUpdate(guild, requireCase(getCase(caseRecord.id)), `${text}\n承認者: ${humanAuthorityLabel(authority)}\n承認期限: <t:${Math.floor(deadline / 1000)}:F>\n${rejectVotes > 0 ? `承認者の拒否 ${stage.config.rejectVotes}票で執行を取りやめます。` : '承認が不足したまま期限を迎えると執行を取りやめます。'}${veto ? `\n拒否権: ${humanAuthorityLabel(veto)}の${String(veto['required'])}人。期限まで拒否権の行使を受け付けます。` : ''}`, { state: '承認待ち' });
  }
  return requireCase(getCase(caseRecord.id));
}

function endLegalApproval(caseRecord: CaseRow, outcome: string): void {
  const sanction = requireValue(caseSanction(caseRecord.id), '承認対象の処分がありません。');
  updateSanction(sanction.id, { status: 'unavailable' });
  updateCase(caseRecord.id, { status: outcome, finalized_at: Date.now() });
  if (sanction.executed_at || sanction.restriction_started_at) enqueueAction({ guildId: caseRecord.guild_id,
    actionType: 'sanction_reverse', targetId: sanction.id, payload: { sanctionId: sanction.id }, idempotencyKey: `approval-ended:${sanction.id}:${outcome}` });
}

// 憲法第六条6。裁判所が審理中に見つけた不利な記録は、その場で認定に使わず、
// 事件記録へ公開したうえで答弁期間をやり直す。上限に達したら二度と開かない。
async function admitDiscoveredEvidence(guild: Guild, caseRecord: CaseRow, panel: { newEvidence: RetrievedRecord[]; panelId: string }, policy: GovernancePolicy): Promise<CaseRow | null> {
  const room = CASE_EVIDENCE_LIMIT - caseEvidence(caseRecord.id).length;
  if (room <= 0) return null;
  const existing = new Set(caseEvidence(caseRecord.id).map((row) => String(row.message_id)));
  const added = [];
  const { revalidateInvestigationEvidence } = await import('./intake.js');
  const verified = await revalidateInvestigationEvidence({ guild }, panel.newEvidence.slice(0, room), [caseRecord.accused_id]);
  for (const row of verified) {
    if (existing.has(String(row.messageId))) continue;
    addCaseEvidence({
      caseId: caseRecord.id,
      submittedBy: guild.client.user.id,
      messageId: row.messageId,
      channelId: row.channelId,
      authorId: row.authorId,
      content: row.content,
      contentHash: row.contentHash,
      conversation: row.conversation,
      occurredAt: row.occurredAt
    });
    added.push(row);
  }
  if (!added.length) return null;
  const until = Date.now() + policy.judiciary.defenseMilliseconds;
  const reopened = requireCase(updateCase(caseRecord.id, {
    status: 'defense',
    defense_until: until,
    redefense_count: Number(caseRecord.redefense_count ?? 0) + 1,
    panel_id: panel.panelId
  }));
  writeAudit({
    guildId: guild.id,
    actorType: 'system',
    action: 'case.evidence_discovered',
    targetType: 'case',
    targetId: caseRecord.id,
    detail: { messageIds: added.map((row) => row.messageId), redefenseCount: reopened.redefense_count }
  });
  await ensureEvidenceDisclosures(guild, reopened);
  await postCourtUpdate(guild, reopened, [
    `審理の中で、事件記録に無い記録が${added.length}件見つかりました。`,
    'この記録は本人へ示すまで判断に使いません。反論の機会をやり直します。',
    `<t:${Math.floor(until / 1000)}:F>までに回答してください。回答完了ボタンを押せばすぐ判定します。`,
    Number(reopened.redefense_count) >= (policy.investigation?.maximumRedefense ?? 0)
      ? '（やり直しはこれが最後です。以後は示された証拠だけで判断します。）'
      : null
  ].filter(Boolean).join('\n'), { state: '答弁' });
  await notifyCaseParty(guild, reopened, 'defense', until);
  return reopened;
}

async function adjudicateCriminalCase(guild: Guild, caseRecord: CaseRow, phase = 'initial'): Promise<CaseRow | undefined> {
  const governance = governanceGuild(guild.id);
  const policy = casePolicy(caseRecord);
  const procedure = procedureOf(policy);
  const currentLaw = lawForCaseRecord(caseRecord);
  const evidence = caseEvidence(caseRecord.id);
  const occurredAt = Number(caseRecord.alleged_at);
  if (!Number.isFinite(occurredAt) || occurredAt < currentLaw.effective_at) throw new Error('行為時に有効な法律を確認できません。');
  const offense = currentLaw.provisions.offenses?.find((entry) => entry.code === caseRecord.offense_code);
  if (!offense) throw new Error('犯罪構成要件が法律にありません。');
  const appeal = phase === 'appeal' ? appealOf(caseRecord.id) : null;
  const originalSanction = caseSanction(caseRecord.id);
  const panelCase: PanelCase = {
    ...caseRecord,
    ...(phase === 'appeal' ? { appealGrounds: appeal?.grounds } : {}),
    ...(['trial', 'appeal'].includes(phase) && originalSanction ? {
      originalSanction: {
        type: originalSanction.type,
        durationSeconds: originalSanction.duration_seconds ?? undefined,
        definitionCode: originalSanction.definition_code ?? undefined
      }
    } : {})
  };
  // 憲法第六条6。やり直しの上限に達していない間だけ、席は事件記録に無い記録を
  // 追加候補として挙げられる。上限後は既に示された証拠だけで判断する。
  const maximumRedefense = policy.investigation?.maximumRedefense ?? 0;
  const allowNewEvidence = Number(caseRecord.redefense_count ?? 0) < maximumRedefense;
  const panel = await runJudicialPanel({
    guildId: guild.id,
    caseRecord: panelCase,
    law: currentLaw,
    offense,
    evidence,
    // 編集前の主張は監査履歴に残すが、判決入力には各Discord投稿の最新正本だけを使う。
    submissions: currentSubmissions(caseRecord.id),
    policy,
    phase,
    allowNewEvidence
  });
  if (allowNewEvidence && panel.newEvidence?.length) {
    const reopened = await admitDiscoveredEvidence(guild, caseRecord, panel, policy);
    if (reopened) return reopened;
  }
  caseRecord = requireCase(updateCase(caseRecord.id, {
    panel_id: panel.panelId,
    verdict: { phase, verdict: panel.verdict, sanction: panel.sanction, panelId: panel.panelId }
  }));
  await publishDecisionRecord(guild, caseRecord, phase, panel);
  if (panel.verdict !== 'responsible' || !panel.sanction) {
    updateCase(caseRecord.id, { status: phase === 'appeal' ? 'overturned' : 'acquitted', finalized_at: Date.now() });
    const existing = caseSanction(caseRecord.id);
    if (existing) {
      updateSanction(existing.id, { status: 'reversing' });
      enqueueAction({ guildId: guild.id, actionType: 'sanction_reverse', targetId: existing.id, payload: { sanctionId: existing.id }, idempotencyKey: `sanction-reverse:${existing.id}` });
    }
    await postCourtUpdate(guild, requireCase(getCase(caseRecord.id)), phase === 'appeal'
      ? '上訴審で原判決を取り消しました。'
      : `構成要件の立証が必要票 ${policy.judiciary.guiltyVotesRequired}/${policy.judiciary.panelSeats} に達せず、責任なしで確定しました。`, { state: '取消' });
    return;
  }

  if (procedure && phase === 'trial') {
    const currentSanction = requireValue(caseSanction(caseRecord.id), '審理対象の処分がありません。');
    const changed = panel.sanction.type !== currentSanction.type
      || Number(panel.sanction.durationSeconds ?? 0) !== Number(currentSanction.duration_seconds ?? 0)
      || String(panel.sanction.definitionCode ?? '') !== String(currentSanction.definition_code ?? '');
    const profile = profileForSanction(currentLaw, panel.sanction, policy);
    if (currentSanction.type === 'restriction' && changed) deactivateRestrictionForSanction(currentSanction.id);
    const sanction = requireSanction(updateSanction(currentSanction.id, {
      type: panel.sanction.type,
      duration_seconds: panel.sanction.durationSeconds ?? null,
      definition_code: panel.sanction.definitionCode ?? null,
      profile,
      required_approvals: requiredApprovals(panel.sanction, policy),
      appealable: isAppealable(panel.sanction, policy) ? 1 : 0,
      status: 'review_upheld'
    }));
    if (sanction.appealable) {
      await beginAppealWindow(guild, caseRecord, sanction);
      await postCourtUpdate(guild, requireCase(getCase(caseRecord.id)), changed
        ? '裁判で処分を軽減しました。重大処分のため、さらに一度だけ上訴できます。'
        : '裁判で処分を維持しました。重大処分のため、さらに一度だけ上訴できます。', { state: '上訴' });
      return;
    }
    if (Number(requiredApprovals(panel.sanction, policy)) > 0) {
      await beginCaseApproval(guild, caseRecord, sanction, `${panel.sanction.type}を認める判決です。法令で定める独立した承認者${sanction.required_approvals}人の公開承認後にだけ執行します。`);
      return;
    }
    queueExecution(caseRecord, sanction);
    await postCourtUpdate(guild, requireCase(getCase(caseRecord.id)), changed ? '裁判で処分を軽減し、残りの処分へ進みます。' : '裁判で処分を維持しました。', { state: '確定' });
    return;
  }

  let profile: unknown = null;
  if (panel.sanction.type === 'restriction') {
    const definition = narrow(getSanctionDefinition(currentLaw.id, panel.sanction.definitionCode), isSanctionDefinitionRow, 'sanction definition');
    if (!definition || !validateRestrictionDefinition(definition.profile, policy)) throw new Error('成立法に有効な制裁定義がありません。');
    profile = definition.profile;
  }
  const approvals = Number(requiredApprovals(panel.sanction, policy));
  const appealable = Boolean(isAppealable(panel.sanction, policy));
  const stored = caseSanction(caseRecord.id);
  let sanction: SanctionRow;
  if (stored) {
    sanction = requireSanction(updateSanction(stored.id, {
      type: panel.sanction.type,
      duration_seconds: panel.sanction.durationSeconds ?? null,
      definition_code: panel.sanction.definitionCode ?? null,
      profile,
      required_approvals: approvals,
      appealable: appealable ? 1 : 0,
      status: approvals > 0 && phase !== 'appeal' ? 'pending_approval' : 'queued'
    }));
  } else {
    sanction = requireSanction(createSanction({
      caseId: caseRecord.id,
      guildId: guild.id,
      userId: caseRecord.accused_id,
      type: panel.sanction.type,
      durationSeconds: panel.sanction.durationSeconds,
      definitionCode: panel.sanction.definitionCode,
      profile,
      status: approvals > 0 ? 'pending_approval' : 'queued',
      requiredApprovals: approvals,
      appealable
    }));
  }
  if (phase === 'appeal') {
    updateAppeal(caseRecord.id, { status: 'upheld', decided_at: Date.now() });
    if (procedure && Number(requiredApprovals(panel.sanction, policy)) > 0) {
      sanction = requireSanction(updateSanction(sanction.id, {
        status: 'pending_approval',
        required_approvals: requiredApprovals(panel.sanction, policy)
      }));
      await beginCaseApproval(guild, caseRecord, sanction, `上訴審で原判決を維持しました。${sanction.required_approvals}人の公開承認後にだけ執行します。`);
    } else {
      queueExecution(caseRecord, sanction);
      await postCourtUpdate(guild, requireCase(getCase(caseRecord.id)), '上訴審で原判決を維持し、残りの処分へ進みます。', { state: '確定' });
    }
    return;
  }
  if (approvals > 0) {
    if (policy.autonomous) {
      await beginCaseApproval(guild, caseRecord, sanction, `判決の執行には${approvals}人の公開承認が必要です。`);
      return;
    }
    const electorate = specialElectorateName(guild, governance);
    const trustedMembers = await trustedApprovers(guild, requireValue(governance, 'このサーバーでは統治機能が初期化されていません。'), caseRecord);
    if (trustedMembers.length < approvals) {
      updateSanction(sanction.id, { status: 'unavailable' });
      updateCase(caseRecord.id, { status: 'unenforceable', finalized_at: Date.now() });
      await postCourtUpdate(guild, requireCase(getCase(caseRecord.id)), `判決は記録しましたが、独立した「${electorate}」の承認者が ${trustedMembers.length}/${approvals} 人しかいないため、この刑は執行不能として終了します。`, { state: '確定' });
      return;
    }
    updateCase(caseRecord.id, { status: 'approval' });
    await postCourtUpdate(guild, requireCase(getCase(caseRecord.id)), `責任あり ${policy.judiciary.guiltyVotesRequired}/${policy.judiciary.panelSeats}以上。刑: ${panel.sanction.type}${panel.sanction.durationSeconds ? ` ${panel.sanction.durationSeconds}秒` : ''}。「${electorate}」${approvals}人の執行承認が必要です。`, { state: '承認待ち' });
  } else if (appealable) {
    await beginAppealWindow(guild, caseRecord, sanction);
  } else {
    queueExecution(caseRecord, sanction);
  }
  return;
}

function reviewInstitution(caseRecord: CaseRow) {
  const constitution = constitutionForCase(caseRecord);
  const rules = caseRules(caseRecord);
  const instance = autonomousPolicy(constitution.policy)
    ? requireValue(workflowInstance('case', caseRecord.id), '案件の手続状態がありません。')
    : null;
  const stage = instance ? caseStage(rules, instance).stage : undefined;
  const institution = stage
    ? requireValue(rules.institutions, '法令に機関の定めがありません。')[stage.config.institution ?? '']
    : rules.panels?.['constitutional'];
  return requireValue(institution, '違憲審査の機関がありません。');
}

async function adjudicateConstitutionalCase(guild: Guild, caseRecord: CaseRow): Promise<void> {
  const constitution = constitutionForCase(caseRecord);
  const autonomous = autonomousPolicy(constitution.policy);
  const institution = reviewInstitution(caseRecord);
  const requiredConstitutional = requireValue(institution.required['constitutional'], '合憲の必要票がありません。');
  const requiredUnconstitutional = requireValue(institution.required['unconstitutional'], '違憲の必要票がありません。');
  // 違憲で取り消すには、法令の必要票に加えて必ず席の過半数が違憲と結論することを求める。
  // 判断を保留した席・失敗した席は、取消にも合憲にも数えない (1席の注入や不調で法を失わせない)。
  const voidingVotes = Math.max(requiredUnconstitutional, Math.floor(institution.seats / 2) + 1);
  const target = reviewTarget(caseRecord.challenged_type, caseRecord.challenged_id);
  if (!target) throw new Error('違憲審査対象がありません。');
  const reviewTargetData = buildConstitutionalReviewTarget(target);
  let panel = await runConstitutionalPanel({
    guildId: guild.id,
    targetType: target.type,
    targetId: caseRecord.challenged_id,
    phase: 'post',
    constitution,
    institution,
    target: reviewTargetData
  });
  const count = (verdict: string) => panel.outputs.filter((output) => output.verdict === verdict).length;
  let constitutional = count('constitutional');
  let unconstitutional = count('unconstitutional');
  if (autonomous && panel.outputs.length !== institution.seats) throw new Error('違憲審査のAI席がそろっていません。');
  if (!autonomous && constitutional < requiredConstitutional
    && unconstitutional < voidingVotes) {
    panel = await runConstitutionalPanel({
      guildId: guild.id,
      targetType: target.type,
      targetId: caseRecord.challenged_id,
      phase: 'post_retry',
      constitution,
      institution,
      target: reviewTargetData
    });
    constitutional = count('constitutional');
    unconstitutional = count('unconstitutional');
  }
  const decided = constitutional >= requiredConstitutional || unconstitutional >= voidingVotes;
  // 結論が出ないまま席が欠けたら、対象には触れずに再試行する (記録も結論が出てから出す)。
  if (!decided && panel.outputs.length < institution.seats) {
    throw new Error(`違憲審査のAI席がそろわず結論が出ませんでした (${panel.outputs.length}/${institution.seats})。対象を維持したまま再審査します。`);
  }
  await postCourtRecord(guild, caseRecord, '違憲審査パネルの理由と憲法条文参照を添付します。', {
    files: [{
      attachment: Buffer.from(`${JSON.stringify({
        target: REVIEW_TARGET_NAMES[target.type] ?? '統治行為',
        outputs: publicPanelOutputs(panel.outputs)
      }, null, 2)}\n`),
      name: '違憲審査記録.json'
    }]
  });
  if (constitutional >= requiredConstitutional) {
    updateCase(caseRecord.id, { status: 'final', verdict: { verdict: 'constitutional', panelId: panel.panelId }, finalized_at: Date.now() });
    await postCourtUpdate(guild, requireCase(getCase(caseRecord.id)), `合憲 ${constitutional}/${institution.seats}で対象を維持します。`, { state: '確定' });
    return;
  }
  if (unconstitutional < voidingVotes) {
    // 判断不能は取消ではない。法律・判決・処分・行政行為と既存の処分はそのまま維持する。
    updateCase(caseRecord.id, { status: 'constitutional_uncertain', verdict: { verdict: 'uncertain', panelId: panel.panelId }, finalized_at: Date.now() });
    await postCourtUpdate(guild, requireCase(getCase(caseRecord.id)),
      `合憲 ${constitutional}/${institution.seats}・違憲 ${unconstitutional}/${institution.seats}で、どちらも必要票に達しませんでした。対象と既存の処分はそのまま維持します。`,
      { state: '確定' });
    return;
  }
  if (target.type === 'law') {
    updateLaw(target.record.id, { status: 'unconstitutional', ended_at: Date.now() });
    for (const pendingCase of narrowList(listOpenCasesForLaw(target.record.id), isCaseRow, 'case')) {
      updateCase(pendingCase.id, {
        status: 'dismissed',
        verdict: { verdict: 'dismissed', reason: 'law_unconstitutional' },
        finalized_at: Date.now()
      });
      await postCourtUpdate(guild, requireCase(getCase(pendingCase.id)), '適用法が違憲審査で維持されなかったため、この事件は処罰なしで終了しました。', { state: '取消' });
    }
    for (const sanction of narrowList(listSanctionsForLaw(target.record.id), isSanctionRow, 'sanction')) {
      updateSanction(sanction.id, { status: 'reversing', reversed_at: Date.now() });
      enqueueAction({
        guildId: guild.id,
        actionType: 'sanction_reverse',
        targetId: sanction.id,
        payload: { sanctionId: sanction.id },
        idempotencyKey: `sanction-reverse:${sanction.id}`
      });
    }
  } else if (target.type === 'sanction') {
    updateSanction(target.record.id, { status: 'reversing' });
    enqueueAction({ guildId: guild.id, actionType: 'sanction_reverse', targetId: target.record.id, payload: { sanctionId: target.record.id }, idempotencyKey: `sanction-reverse:${target.record.id}` });
  } else if (target.type === 'case') {
    const sanction = caseSanction(target.record.id);
    updateCase(target.record.id, { status: 'overturned', finalized_at: Date.now() });
    if (sanction) enqueueAction({ guildId: guild.id, actionType: 'sanction_reverse', targetId: sanction.id, payload: { sanctionId: sanction.id }, idempotencyKey: `sanction-reverse:${sanction.id}` });
  } else {
    await reverseAdministrativeAct(guild, target.record);
  }
  updateCase(caseRecord.id, { status: 'final', verdict: { verdict: 'unconstitutional', panelId: panel.panelId }, finalized_at: Date.now() });
  await postCourtUpdate(guild, requireCase(getCase(caseRecord.id)), `違憲 ${unconstitutional}/${institution.seats}で対象を取り消しました。`, { state: '取消' });
  if (target.type === 'law') {
    try {
      syncLawSite(guild);
    } catch (error) {
      console.error(`Failed to queue law ${target.record.id} for the public law site:`, error);
    }
  }
}

const decisionOutputs = (caseId: number): unknown[] => narrowList(listCaseDecisions(caseId), isRecord, 'case decision').map((entry) => entry['output']);

function buildConstitutionalReviewTarget(target: ReviewTarget): unknown {
  if (target.type === 'case') {
    const record = target.record;
    return {
      case: record,
      law: record.law_id ? lawById(record.law_id) : null,
      evidence: caseEvidence(record.id).map((entry) => ({
        id: entry.id,
        authorId: entry.author_id,
        occurredAt: entry.occurred_at,
        contentHash: entry.content_hash,
        content: entry.content
      })),
      submissions: listCaseSubmissions(record.id),
      decisions: decisionOutputs(record.id)
    };
  }
  if (target.type === 'sanction') {
    const sourceCase = caseById(target.record.case_id);
    return {
      sanction: target.record,
      case: sourceCase,
      law: sourceCase?.law_id ? lawById(sourceCase.law_id) : null,
      decisions: sourceCase ? decisionOutputs(sourceCase.id) : []
    };
  }
  return target.record;
}

async function reverseAdministrativeAct(guild: Guild, act: AdministrativeActRow): Promise<void> {
  if (act.status === 'reversed') return;
  const detail = isRecord(act.detail) ? act.detail : {};
  const { operation, before, userId, roleId } = detail;
  if (operation === 'operational_setting') {
    setOperationalSetting(guild.id, detail['key'], before, guild.client.user.id);
  } else if (operation === 'enforcement_mode') {
    updateGovernanceGuild(guild.id, { enforcement_mode: before });
  } else if (operation === 'governance_status') {
    updateGovernanceGuild(guild.id, { status: before });
  } else if (operation === 'trusted_role') {
    updateGovernanceGuild(guild.id, { trusted_role_id: before ?? '' });
  } else if (operation === 'trusted-add' || operation === 'trusted-remove') {
    const member = typeof userId === 'string' ? await guild.members.fetch(userId).catch(() => null) : null;
    if (member && typeof roleId === 'string' && roleId) {
      const desired = operation === 'trusted-remove';
      authorizeTrustedMutation({ guildId: guild.id, userId, roleId, desired, authorizedBy: guild.client.user.id });
      if (desired) await member.roles.add(roleId, `Administrative act A-${act.id} reversed`);
      else await member.roles.remove(roleId, `Administrative act A-${act.id} reversed`);
    }
  } else if (operation === 'sanction_execution') {
    const sanction = sanctionById(detail['sanctionId']);
    if (sanction) {
      updateSanction(sanction.id, { status: 'reversing', reversed_at: Date.now() });
      enqueueAction({
        guildId: guild.id,
        actionType: 'sanction_reverse',
        targetId: sanction.id,
        payload: { sanctionId: sanction.id },
        idempotencyKey: `sanction-reverse:administrative-act:${act.id}`
      });
    }
  } else {
    throw new Error('この行政行為は自動で取り消せません。');
  }
  updateAdministrativeAct(act.id, { status: 'reversed', reversed_at: Date.now() });
  writeAudit({ guildId: guild.id, actorType: 'system', action: 'administrative_act.reversed', targetType: 'administrative_act', targetId: act.id, detail: { operation } });
}

const isCaseApproval = shape({ oldDecision: nullable(isString) });

export async function approveCase(interaction: GovernanceActor, caseId: number, decision: string) {
  const { governance } = requireGovernance(interaction.guildId);
  const guild = requireValue(interaction.guild, 'サーバー内でのみ使えます。');
  const member = await actingMember({ member: interaction.member ?? null, user: interaction.user }, guild);
  const legalCase = caseById(caseId);
  if (legalCase?.guild_id === interaction.guildId && autonomousPolicy(constitutionForCase(legalCase).policy)) {
    setCaseApproval(caseId, member.id, decision);
    const result = legalApproval(caseId);
    const sanction = requireValue(caseSanction(caseId), '承認対象の処分がありません。');
    await postCourtUpdate(guild, legalCase, `${publicMemberLabel(member.id)} が${decision === 'approve' ? '承認' : '拒否'}しました。承認 ${result.approvals}/${sanction.required_approvals}`);
    if (result.rejected) endLegalApproval(legalCase, 'rejected');
    else if (result.passed) {
      if (sanction.appealable && !sanction.appeal_deadline && !appealOf(caseId)) await beginAppealWindow(guild, legalCase, sanction);
      else queueExecution(legalCase, sanction);
    }
    return { approvals: result.approvals, required: sanction.required_approvals, policy: casePolicy(legalCase) };
  }
  if (!governance.trusted_role_id) throw new Error('特別有権者による承認機能は無効です。');
  const electorate = specialElectorateName(guild, governance);
  if (!member.roles.cache.has(governance.trusted_role_id)) throw new Error(`「${electorate}」ロールが必要です。`);
  const caseRecord = caseById(caseId);
  if (!caseRecord || caseRecord.guild_id !== interaction.guildId || caseRecord.status !== 'approval') throw new Error('承認待ちの事件ではありません。');
  const policy = casePolicy(caseRecord);
  if ([caseRecord.accused_id, caseRecord.reporter_id].includes(member.id)) throw new Error('被告・通報者は執行承認できません。');
  const approvalResult = narrowRequired(setCaseApproval(caseId, member.id, decision), isCaseApproval, 'case approval');
  const sanction = requireValue(caseSanction(caseId), '承認対象の処分がありません。');
  const approvals = narrowList(listCaseApprovals(caseId), isApprovalRow, 'case approval').filter((entry) => entry.decision === 'approve').length;
  const oldLabel = approvalResult.oldDecision === null ? undefined : APPROVAL_LABELS[approvalResult.oldDecision];
  await postCourtUpdate(
    guild,
    caseRecord,
    `${publicMemberLabel(member.id)} が執行を${decision === 'approve' ? '承認' : '拒否'}しました${oldLabel ? ` (変更前: ${oldLabel})` : ''}。承認 ${approvals}/${sanction.required_approvals}`
  );
  if (decision === 'approve' && approvals >= sanction.required_approvals) {
    const procedure = procedureOf(policy);
    const appealWindowAlreadyOffered = Boolean(procedure && sanction.appeal_deadline);
    if (sanction.appealable && !appealOf(caseId) && !appealWindowAlreadyOffered) {
      await beginAppealWindow(guild, caseRecord, sanction);
    }
    else queueExecution(caseRecord, sanction);
  }
  return { approvals, required: sanction.required_approvals, policy };
}

export async function appealCase(guild: Guild, member: { id: string }, caseId: number, grounds: string): Promise<CaseRow> {
  const caseRecord = caseById(caseId);
  const sanction = caseSanction(caseId);
  if (!caseRecord || !sanction || caseRecord.guild_id !== guild.id) throw new Error('事件または刑が見つかりません。');
  const policy = casePolicy(caseRecord);
  if (caseRecord.accused_id !== member.id) throw new Error('被告本人だけが上訴できます。');
  if (caseRecord.status !== 'appeal_window' || !sanction.appealable || Date.now() >= Number(sanction.appeal_deadline)) throw new Error('上訴受付中ではありません。');
  if (appealOf(caseId)) throw new Error('上訴は1回だけです。');
  createAppeal(caseId, member.id, grounds);
  const now = Date.now();
  const submissionsUntil = now + policy.judiciary.defenseMilliseconds;
  updateCase(caseId, { status: 'appeal', retry_after: submissionsUntil, last_error: null });
  if (!procedureOf(policy)) updateSanction(sanction.id, { restriction_started_at: now });
  enqueueAction({
    guildId: guild.id,
    actionType: 'appeal_restrict',
    targetId: sanction.id,
    payload: { sanctionId: sanction.id },
    idempotencyKey: `appeal-restrict:${sanction.id}`
  });
  await postCourtUpdate(guild, requireCase(getCase(caseId)), `${publicMemberLabel(member.id, '動作確認用アカウント')} が上訴しました。<t:${Math.floor(submissionsUntil / 1000)}:F>までこの事件投稿で追加主張を受け付け、その後に別の${policy.judiciary.panelSeats}席パネルで再審します。`, { state: '上訴' });
  // live modeではAI再審へ渡す前に発言先を自分の上訴事件投稿へ限定する。
  await ensureAppealRestriction(guild, sanction.id);
  return requireCase(getCase(caseId));
}

export async function requestTrial(guild: Guild, member: { id: string }, sanctionId: number): Promise<CaseRow> {
  const sanction = sanctionById(sanctionId);
  if (!sanction || sanction.guild_id !== guild.id) throw new Error('処分が見つかりません。');
  if (sanction.user_id !== member.id) throw new Error('処分を受けた本人だけが裁判を求められます。');
  const caseRecord = requireValue(caseById(sanction.case_id), '処分の事件が見つかりません。');
  const policy = policyOf(constitutionForCase(caseRecord)?.policy);
  const procedure = procedureOf(policy);
  if (!policy || !procedure || caseRecord.procedure_version !== 2) throw new Error('この処分は簡易裁判の対象ではありません。');
  if (Number(caseRecord.review_count ?? 0) !== 0 || sanction.review_requested_at) {
    throw new Error('この処分の裁判請求は既に使われています。');
  }
  if (!procedure.immediateSanctions.includes(sanction.type)) throw new Error('この処分は裁判請求の対象ではありません。');
  if (sanction.type !== 'warning') {
    const startedAt = Number(sanction.restriction_started_at ?? sanction.executed_at ?? 0);
    if (!startedAt || startedAt + Number(sanction.duration_seconds ?? 0) * 1000 <= Date.now()) {
      throw new Error('この処分の期間は終了しています。');
    }
  }
  const now = Date.now();
  updateSanction(sanction.id, { review_requested_at: now });
  let current = requireCase(updateCase(caseRecord.id, {
    status: 'filing',
    review_count: 1,
    response_completed_at: null,
    decision_due_at: now + procedure.contestMilliseconds
  }));
  if (sanction.type === 'timeout') {
    enqueueAction({
      guildId: guild.id,
      actionType: 'sanction_pause_for_trial',
      targetId: sanction.id,
      payload: { sanctionId: sanction.id },
      idempotencyKey: `sanction-pause-for-trial:${sanction.id}`
    });
    await processGovernanceOutbox(guild.client);
  }
  if (!policy.autonomous || current.workflow_handler === 'case_filing') current = await finishCaseFiling(guild, current);
  else {
    await advanceCase(guild, current);
    current = requireCase(getCase(current.id));
  }
  const response = current.workflow_handler === 'defense_window' || (!policy.autonomous && current.status === 'defense')
    ? `回答完了ボタンを押せばすぐ判定し、押さなくても<t:${Math.floor(Number(current.defense_until) / 1000)}:F>までに判定します。`
    : '法定手続に従って受付・審理を進めます。';
  await postCourtUpdate(guild, current, `${publicMemberLabel(member.id)} が裁判を求めました。${response}`, {
    state: current.status === 'defense' ? '答弁' : '受付'
  });
  return current;
}

// 不服申立ての取下げは、未執行処分の法定審査・承認を免除しない。
export async function withdrawContest(guild: Guild, member: { id: string }, caseId: number): Promise<CaseRow> {
  const caseRecord = caseById(caseId);
  if (!caseRecord || caseRecord.guild_id !== guild.id) throw new Error('事件が見つかりません。');
  if (caseRecord.accused_id !== member.id) throw new Error('申立てた本人だけが取り下げられます。');
  if (!['defense', 'appeal'].includes(caseRecord.status)) throw new Error('いま取り下げられる申立てはありません。');
  const sanction = caseSanction(caseId);
  if (!sanction) throw new Error('対象の処分がありません。');
  const appealing = caseRecord.status === 'appeal';
  await releaseCaseDetention(guild, caseId);
  if (appealing) updateAppeal(caseId, { status: 'withdrawn', decided_at: Date.now() });
  const current = requireCase(updateCase(caseId, { response_completed_at: Date.now(), retry_after: null, last_error: null }));
  const applied = ['reviewable', 'executed', 'simulated'].includes(sanction.status);
  const continueProcedure = !applied && autonomousPolicy(constitutionForCase(caseRecord).policy);
  await postCourtUpdate(guild, current, `${publicMemberLabel(member.id)} が${appealing ? '上訴' : '審理の請求'}を取り下げました。${continueProcedure ? '必要な審査・承認を経て処分を判断します。' : '処分をそのまま確定します。'}`, {
    state: continueProcedure ? '取下げ' : '確定'
  });
  writeAudit({
    guildId: guild.id,
    actorType: 'member',
    actorId: member.id,
    action: appealing ? 'appeal.withdrawn' : 'contest.withdrawn',
    targetType: 'case',
    targetId: caseId,
    detail: { sanctionId: sanction.id }
  });
  // 既に始まっている即時処分は、取り下げでそのまま確定する。まだ執行していない
  // 送検事件だけを執行へ回す。
  if (applied) {
    const { governance } = requireGovernance(guild.id);
    updateSanction(sanction.id, {
      status: governance.enforcement_mode === 'live' ? 'executed' : 'simulated'
    });
    updateCase(caseId, { status: 'final', finalized_at: Date.now() });
  } else {
    if (autonomousPolicy(constitutionForCase(caseRecord).policy)) {
      await advanceCase(guild, requireCase(getCase(caseId)));
      return requireCase(getCase(caseId));
    }
    queueExecution(requireCase(getCase(caseId)), requireSanction(getSanction(sanction.id)));
    await processGovernanceOutbox(guild.client);
  }
  return requireCase(getCase(caseId));
}

const isAutomaticTrigger = shape({ windowSeconds: isNumber, minimumMessages: isNumber });

export async function detectAutomaticEnforcement(message: GovernanceMessage): Promise<CaseRow | null> {
  if (!message?.guildId || message.author?.bot) return null;
  const { constitution } = requireGovernance(message.guildId);
  const procedure = procedureOf(constitution.policy);
  if (!procedure || !publicChannel(message, governanceGuild(message.guildId))) return null;
  for (const law of narrowList(listLaws(message.guildId), isLawRow, 'law').filter((entry) => entry.status === 'active')) {
    if (Number(message.createdTimestamp) < Number(law.effective_at)) continue;
    for (const offense of law.provisions.offenses ?? []) {
      const trigger = offense.automaticTrigger;
      if (!validateAutomaticTrigger(trigger) || !isAutomaticTrigger(trigger)) continue;
      const windowMs = trigger.windowSeconds * 1000;
      const recent = narrowList(recentUserActivity(
        message.guildId,
        message.author.id,
        message.channelId,
        message.createdTimestamp - windowMs,
        message.createdTimestamp,
        100
      ), isActivityRow, 'activity');
      if (recent.length < trigger.minimumMessages) continue;
      if (findRecentPoliceCase(message.guildId, message.author.id, law.id, offense.code, message.createdTimestamp - windowMs)) continue;
      const triggerEvidence = recent.slice(-trigger.minimumMessages);
      const first = triggerEvidence[0];
      if (!first) continue;
      const eventKey = `auto:${law.id}:${offense.code}:${message.author.id}:${message.channelId}:${first.message_id}:${message.id}`;
      if (findCaseByPoliceEvent(message.guildId, eventKey)) continue;
      const reporter = { id: message.guild?.client?.user?.id ?? 'system' };
      return fileCriminalCase(requireValue(message.guild, 'サーバー内でのみ使えます。'), reporter, {
        accused: message.member ?? { id: message.author.id },
        lawId: law.id,
        offenseCode: offense.code,
        summary: `${trigger.windowSeconds}秒以内に公開投稿${recent.length}件を検出`,
        evidences: triggerEvidence.map((entry) => ({
          messageId: entry.message_id,
          channelId: entry.channel_id,
          authorId: message.author.id,
          content: String(entry.content ?? '').slice(0, 8000),
          occurredAt: entry.created_at
        })),
        attemptReserved: true,
        policeEventKey: eventKey
      });
    }
  }
  return null;
}

export async function completeCaseResponse(guild: Guild, member: { id: string }, caseId: number): Promise<CaseRow> {
  const caseRecord = caseById(caseId);
  if (!caseRecord || caseRecord.guild_id !== guild.id) throw new Error('事件が見つかりません。');
  const responseController = caseRecord.accused_id ?? caseRecord.reporter_id;
  if (responseController !== member.id) throw new Error('回答する当事者本人だけが回答を完了できます。');
  if (!['defense', 'appeal'].includes(caseRecord.status)) throw new Error('現在は回答受付中ではありません。');
  if (!caseProcedure(caseRecord)) throw new Error('この事件は回答完了による即時判定に対応していません。');
  const now = Date.now();
  const current = requireCase(updateCase(caseRecord.id, {
    response_completed_at: now,
    defense_until: now,
    decision_due_at: now,
    retry_after: null
  }));
  await postCourtUpdate(guild, current, `${publicMemberLabel(member.id)} が回答を完了しました。判定を開始します。`, { state: '審理' });
  await advanceCase(guild, current, now);
  await processGovernanceOutbox(guild.client);
  return requireCase(getCase(caseId));
}

export async function submitCaseAnswer(guild: Guild, member: { id: string }, caseId: number, content: string): Promise<number> {
  const caseRecord = caseById(caseId);
  if (!caseRecord || caseRecord.guild_id !== guild.id) throw new Error('事件が見つかりません。');
  if (![caseRecord.reporter_id, caseRecord.accused_id].filter(Boolean).includes(member.id)) {
    throw new Error('この事件の当事者だけが回答できます。');
  }
  if (!['defense', 'appeal'].includes(caseRecord.status)) throw new Error('現在は回答受付中ではありません。');
  const normalized = String(content ?? '').trim();
  if (!normalized || normalized.length > 8000) throw new Error('回答は1文字以上8000文字以内で入力してください。');
  const count = currentSubmissions(caseRecord.id).filter((entry) => entry.kind === caseRecord.status).length;
  if (count >= CASE_SUBMISSION_LIMIT_PER_PHASE) throw new Error('この審級の回答件数上限に達しました。');
  const id = Number(addCaseSubmission(caseRecord.id, member.id, caseRecord.status, normalized));
  await postCourtRecord(guild, caseRecord, `${publicMemberLabel(member.id)} が回答を提出しました。`);
  return id;
}

async function ensureAppealRestriction(guild: Guild, sanctionId: number): Promise<void> {
  const governance = governanceGuild(guild.id);
  if (governance?.enforcement_mode !== 'live') return;
  await processGovernanceOutbox(guild.client);
  let sanction = requireValue(sanctionById(sanctionId), '上訴対象の処分がありません。');
  if (!sanction.execution_detail) {
    // shadow中にoutboxが完了したあとliveへ切り替わった場合も、再審より先に
    // 必ず制限を実体化する。適用できなければ例外で審理を止める。
    const detail = await applyAppealRestriction(guild, governance, sanction.user_id);
    sanction = requireSanction(updateSanction(sanction.id, { execution_detail: JSON.stringify(detail) }));
    writeAudit({
      guildId: guild.id,
      actorType: 'system',
      action: 'appeal.restriction_recovered',
      targetType: 'sanction',
      targetId: sanction.id,
      detail
    });
  }
}

// 議題を進めるのは国会だけ。schedulerが自分で進めるのは投票の締切だけになった。
export async function advanceProposal(guild: Guild, proposal: ProposalRow, now?: number): Promise<unknown> {
  if (proposal.retry_after && now !== undefined && proposal.retry_after > now) return proposal;
  const runtime = proposalRuntime(proposal);
  if (runtime && autonomousPolicy(runtime.constitution.policy)) {
    if (runtime.state.handler === 'terminal') return proposal;
    const { advanceLegislation } = await import('./legislation.js');
    const advanced: unknown = await advanceLegislation(guild, proposal, now);
    return advanced;
  }
  if (!runtime || runtime.state.handler !== 'public_vote') return proposal;
  if (proposal.stage_ends_at !== null && proposal.stage_ends_at !== undefined && now !== undefined && Number(proposal.stage_ends_at) <= now) {
    return closeProposalVote(guild, proposal);
  }
  if (allBallotsCast(proposal, runtime)) {
    // 受付時に固定した有権者が全員投票したので、残り時間で結果は動かない。
    await postProposalUpdate(guild, proposal, '受付時の有権者が全員投票したため、締切を待たずに開票します。', { state: '投票' });
    return closeProposalVote(guild, proposal);
  }
  return proposal;
}

function allBallotsCast(proposal: ProposalRow, runtime: ProposalRuntime): boolean {
  const vote = voteRuleFor(proposal, runtime.compiled.rules);
  if (vote.earlyClose !== 'all_ballots_cast') return false;
  const summary = narrowRequired(proposalVoteSummary(proposal.id), isVoteSummary, 'vote summary');
  const electorate = Number(summary.electorate);
  if (!Number.isFinite(electorate) || electorate <= 0) return false;
  return summary.yes + summary.no + summary.abstain >= electorate;
}

async function syncRetriedIntake(guild: Guild, resultType: string, result: CaseRow): Promise<void> {
  const { updateRetriedIntakeMessage, updateRetriedMentionInvestigationMessage } = await import('./intake.js');
  await updateRetriedIntakeMessage(guild, resultType, result).catch((error: unknown) => {
    console.error(`Failed to update completed ${resultType} intake ${result.id}:`, error);
  });
  await updateRetriedMentionInvestigationMessage(guild, resultType, result).catch((error: unknown) => {
    console.error(`Failed to update completed ${resultType} investigation ${result.id}:`, error);
  });
}

const advancingCases = new Map<string, Promise<unknown>>();
export function advanceCase(guild: Guild, caseRecord: { id: number }, now = Date.now()): Promise<unknown> {
  const key = `${guild.id}:${caseRecord.id}`;
  const running = advancingCases.get(key);
  if (running) return running;
  const current = caseById(caseRecord.id);
  const task = (current ? advanceCaseState(guild, current, now) : Promise.reject(new Error('事件が見つかりません。')))
    .finally(() => advancingCases.delete(key));
  advancingCases.set(key, task);
  return task;
}

async function advanceCaseState(guild: Guild, caseRecord: CaseRow, now: number): Promise<unknown> {
  if (caseRecord.retry_after && caseRecord.retry_after > now) return;
  if (recoveryOf(activeConstitution(guild.id)?.rules) && caseRecord.kind !== 'constitutional'
    && !caseRecord.review_count && !appealOf(caseRecord.id)) return;
  const constitution = constitutionForCase(caseRecord);
  if (autonomousPolicy(constitution.policy)) {
    const instance = requireValue(workflowInstance('case', caseRecord.id), '案件の手続状態がありません。');
    const { workflow, stage } = caseStage(caseRules(caseRecord), instance);
    if (!stage) throw new Error('案件に適用される手続段階がありません。');
    const move = (outcome: string, extra: Record<string, unknown> = {}) => updateCase(caseRecord.id, { ...extra, status: outcome });
    if (procedureExhausted(stage, instance.context, instance.current_state)) {
      const sanction = caseSanction(caseRecord.id);
      if (sanction) {
        updateSanction(sanction.id, { status: 'unavailable' });
        enqueueAction({ guildId: guild.id, actionType: 'sanction_reverse', targetId: sanction.id,
          payload: { sanctionId: sanction.id }, idempotencyKey: `legal-exhausted:${caseRecord.id}` });
      }
      return move('exhausted', { verdict: { verdict: 'undetermined', reason: 'legal_attempt_limit' }, finalized_at: now });
    }
    const judge = async () => {
      if (caseRecord.kind === 'constitutional') return adjudicateConstitutionalCase(guild, caseRecord);
      return adjudicateCriminalCase(guild, caseRecord, stage.config.phase === 'appeal' ? 'appeal' : 'trial');
    };
    const handlers: Record<string, () => unknown> = {
      police_review: () => finishPoliceReview(guild, caseRecord),
      case_filing: () => finishCaseFiling(guild, caseRecord),
      async defense_window() {
        await ensureEvidenceDisclosures(guild, caseRecord);
        if (!caseRecord.response_completed_at && Number(caseRecord.defense_until) > now) {
          return notifyCaseParty(guild, caseRecord, 'defense', caseRecord.defense_until);
        }
        move('deliberation', { retry_after: null, last_error: null });
        return undefined;
      },
      judicial_panel: judge,
      constitutional_panel: judge,
      async appeal_window() {
        const sanction = caseSanction(caseRecord.id);
        if (!sanction) throw new Error('上訴対象の処分がありません。');
        if (Number(sanction.appeal_deadline) > now) return notifyCaseParty(guild, caseRecord, 'appeal', sanction.appeal_deadline);
        if (!appealOf(caseRecord.id)) {
          if (sanction.required_approvals > 0 && !legalApproval(caseRecord.id).passed) await beginCaseApproval(guild, caseRecord, sanction, '上訴期間が終了しました。執行には人間の公開承認が必要です。');
          else queueExecution(caseRecord, sanction);
        }
        return undefined;
      },
      async human_approval() {
        const sanction = requireValue(caseSanction(caseRecord.id), '承認対象の処分がありません。');
        await beginLegalApproval(guild, caseRecord, sanction, `判決の執行には${sanction.required_approvals}人の公開承認が必要です。`);
        const approval = narrow(workflowInstance('case', caseRecord.id)?.context['approval'], isApprovalContext, 'approval');
        const result = legalApproval(caseRecord.id, now);
        if (result.rejected) endLegalApproval(caseRecord, 'rejected');
        else if (result.passed) {
          if (sanction.appealable && !sanction.appeal_deadline && !appealOf(caseRecord.id)) await beginAppealWindow(guild, caseRecord, sanction);
          else queueExecution(caseRecord, sanction);
        } else if (approval && approval.deadline <= now) endLegalApproval(caseRecord, 'expired');
      },
      sanction_execution() {
        const sanction = caseSanction(caseRecord.id);
        if (!sanction) throw new Error('執行対象の処分がありません。');
        queueExecution(caseRecord, sanction);
      },
      contest_window() { finalizeElapsedSummarySanctions(guild.id, now); },
      async notice() {
        await postCourtUpdate(guild, caseRecord, requireValue(stage.config.text ?? workflow.mandate, '通知の本文が法令にありません。'));
        move('completed');
      },
      wait() {
        const deadline = Number(instance.wake_at ?? instance.state_entered_at + durationMs(stage.duration));
        if (deadline <= now) move('expired');
      },
      terminal() {}
    };
    const handler = handlers[stage.handler];
    if (!handler) throw new Error(`この案件で実行できない手続です: ${stage.handler}`);
    const result = await handler();
    if (!['terminal', 'sanction_execution', ...waitingActions].includes(stage.handler)) {
      const updated = requireValue(workflowInstance('case', caseRecord.id), '案件の手続状態がありません。');
      transitionWorkflowInstance({ subjectType: 'case', subjectId: caseRecord.id, toState: updated.current_state,
        wakeAt: updated.wake_at, completed: updated.status === 'completed',
        context: recordProcedureVisit(updated.context, instance.current_state), eventType: 'legal.operation_completed' });
    }
    return result;
  }
  if (caseRecord.status === 'police_review') {
    await finishPoliceReview(guild, caseRecord);
    return;
  }
  if (caseRecord.status === 'filing') {
    if (caseRecord.procedure_version === 2 && caseRecord.police_event_key && !caseSanction(caseRecord.id)) {
      await finishPoliceReview(guild, caseRecord);
    } else {
      await finishCaseFiling(guild, caseRecord);
    }
    return;
  }
  if (caseRecord.status === 'defense' && Number(caseRecord.defense_until) <= now) {
    await ensureEvidenceDisclosures(guild, caseRecord);
    updateCase(caseRecord.id, { status: 'deliberation', retry_after: null, last_error: null });
    const policy = casePolicy(caseRecord);
    await postCourtUpdate(guild, requireCase(getCase(caseRecord.id)), `答弁期間が終了し、${policy.judiciary.panelSeats}席パネルの審理を開始します。`, { state: '審理' });
    if (caseRecord.kind === 'constitutional') await adjudicateConstitutionalCase(guild, requireCase(getCase(caseRecord.id)));
    else await adjudicateCriminalCase(guild, requireCase(getCase(caseRecord.id)), caseRecord.procedure_version === 2 ? 'trial' : 'initial');
    return;
  }
  if (caseRecord.status === 'defense') {
    await notifyCaseParty(guild, caseRecord, 'defense', caseRecord.defense_until);
    await ensureEvidenceDisclosures(guild, caseRecord);
    return;
  }
  if (caseRecord.status === 'deliberation') {
    if (caseRecord.kind === 'constitutional') await adjudicateConstitutionalCase(guild, caseRecord);
    else await adjudicateCriminalCase(guild, caseRecord, caseRecord.procedure_version === 2 ? 'trial' : 'initial');
    return;
  }
  if (caseRecord.status === 'appeal') {
    const appealSanction = caseSanction(caseRecord.id);
    if (!appealSanction) throw new Error('上訴対象の刑がありません。');
    await ensureAppealRestriction(guild, appealSanction.id);
    await adjudicateCriminalCase(guild, caseRecord, 'appeal');
    return;
  }
  const sanction = caseSanction(caseRecord.id);
  if (caseRecord.status === 'appeal_window' && sanction && Number(sanction.appeal_deadline) > now) {
    await notifyCaseParty(guild, caseRecord, 'appeal', sanction.appeal_deadline);
    return;
  }
  if (caseRecord.status === 'appeal_window' && sanction && Number(sanction.appeal_deadline) <= now && !appealOf(caseRecord.id)) {
    if (caseRecord.procedure_version === 2 && sanction.required_approvals > 0) {
      await beginCaseApproval(guild, caseRecord, sanction, `上訴がなかったため判決が確定しました。執行には${sanction.required_approvals}人の公開承認が必要です。`);
    } else {
      queueExecution(caseRecord, sanction);
      await postCourtUpdate(guild, requireCase(getCase(caseRecord.id)), '上訴期限内に上訴がなかったため判決が確定しました。', { state: '確定' });
    }
  }
  return;
}

let schedulerRunning = false;
let lastPruneAt = 0;
const verifiedStatuteGuilds = new Set<string>();
const verifiedRecordUiGuilds = new Set<string>();
const verifiedIntakeUiGuilds = new Set<string>();

function finalizeElapsedSummarySanctions(guildId: string, now: number): void {
  for (const caseRecord of narrowList(listCases(guildId, { statuses: ['contest_window'], limit: 100 }), isCaseRow, 'case')) {
    const sanction = caseSanction(caseRecord.id);
    if (!sanction) continue;
    const elapsed = sanction.type === 'warning'
      || (Number(sanction.restriction_started_at ?? sanction.executed_at ?? 0) > 0
        && Number(sanction.restriction_started_at ?? sanction.executed_at) + Number(sanction.duration_seconds ?? 0) * 1000 <= now);
    if (!elapsed) continue;
    if (sanction.type !== 'warning') updateSanction(sanction.id, { status: 'expired' });
    updateCase(caseRecord.id, { status: 'final', finalized_at: now });
  }
}

const isExpiredDetention = shape({ guild_id: isString, case_id: isNumber, user_id: isString });

export async function runGovernanceScheduler(client: Client): Promise<void> {
  if (schedulerRunning) return;
  schedulerRunning = true;
  try {
    const now = Date.now();
    if (now - lastPruneAt >= DAY_MS) {
      pruneGovernance();
      lastPruneAt = now;
    }
    expireRestrictions(now);
    const expiredDetentions = narrowList(expireDetentions(now), isExpiredDetention, 'detention');
    const expiredIntakes: unknown = expireGovernanceIntakes(now);
    if (Array.isArray(expiredIntakes) && expiredIntakes.length > 0) {
      const { updateExpiredIntakeMessages } = await import('./intake.js');
      await updateExpiredIntakeMessages(client, expiredIntakes).catch((error: unknown) => {
        console.error('Failed to update expired governance intake messages:', error);
      });
    }
    for (const governance of narrowList(listGovernanceGuilds(), isGovernanceGuildRow, 'governance guild')) {
      const guild = client.guilds.cache.get(governance.guild_id) ?? await client.guilds.fetch(governance.guild_id).catch(() => null);
      if (!guild) continue;
      finalizeElapsedSummarySanctions(guild.id, now);
      for (const detention of expiredDetentions.filter((entry) => entry.guild_id === guild.id)) {
        writeAudit({
          guildId: guild.id,
          actorType: 'system',
          action: 'detention.expired',
          targetType: 'case',
          targetId: detention.case_id,
          detail: { userId: detention.user_id, endedAt: now }
        });
      }
      let currentGovernance = governance;
      try {
        const roles = await ensureGovernanceMentionRoles(guild, currentGovernance);
        if (roles.judiciaryRoleId !== governance.judiciary_role_id) {
          currentGovernance = narrowRequired(updateGovernanceGuild(guild.id, { judiciary_role_id: roles.judiciaryRoleId }), isGovernanceGuildRow, 'governance guild');
        }
      } catch (error) {
        console.error(`Failed to ensure governance mention roles in ${guild.id}:`, error);
      }
      try {
        syncLawSite(guild, { verifyExisting: !verifiedStatuteGuilds.has(guild.id) });
        verifiedStatuteGuilds.add(guild.id);
      } catch (error) {
        console.error(`Failed to sync the public law site in ${guild.id}:`, error);
      }
      try {
        await ensureGovernanceParliamentForum(guild, currentGovernance);
      } catch (error) {
        console.error(`Failed to sync parliament forum in ${guild.id}:`, error);
      }
      try {
        const { ensureGovernanceUx } = await import('./ux.js');
        const ux = await ensureGovernanceUx(guild, currentGovernance);
        currentGovernance = ux.governance;
        if (!verifiedRecordUiGuilds.has(guild.id)) {
          await syncGovernanceRecordUi(guild, currentGovernance);
          verifiedRecordUiGuilds.add(guild.id);
        }
        if (!verifiedIntakeUiGuilds.has(guild.id)) {
          const { syncPendingIntakeMessages } = await import('./intake.js');
          await syncPendingIntakeMessages(guild);
          verifiedIntakeUiGuilds.add(guild.id);
        }
      } catch (error) {
        console.error(`Failed to sync governance UX in ${guild.id}:`, error);
      }
      if (currentGovernance.status !== 'active') continue;
      try {
        const { resumePendingMentionInvestigations } = await import('./intake.js');
        await resumePendingMentionInvestigations(guild, now);
      } catch (error) {
        console.error(`Failed to resume mention investigations in ${guild.id}:`, error);
      }
      for (const proposal of narrowList(listProposals(guild.id, { limit: 100 }), isProposalRow, 'proposal')
        .filter((entry) => {
          const handler = proposalRuntime(entry)?.state?.handler;
          return handler && !['terminal', 'parliament_agenda'].includes(handler);
        })) {
        try {
          await advanceProposal(guild, proposal, now);
        } catch (error) {
          updateProposal(proposal.id, retryPatch(proposalById(proposal.id), error));
          console.error(`Failed to advance proposal ${proposal.id}:`, error);
        }
      }
      await runInstitutionProcedures(guild, now);
      const cases = narrowList(listCases(guild.id, { limit: 1000 }), isCaseRow, 'case').filter((entry) => entry.workflow_handler !== 'terminal' && !entry.finalized_at);
      for (const caseRecord of cases) {
        try {
          await advanceCase(guild, caseRecord, now);
          const current = caseById(caseRecord.id);
          if (current && !current.retry_after && !['filing', 'police_review'].includes(current.status)) {
            await syncRetriedIntake(guild, 'case', current);
          }
        } catch (error) {
          updateCase(caseRecord.id, retryPatch(caseById(caseRecord.id), error));
          console.error(`Failed to advance case ${caseRecord.id}:`, error);
        }
      }
      try {
        const { runParliamentSession, recordParliamentFailure } = await import('./parliament.js');
        const session: unknown = await runParliamentSession(guild, currentGovernance, now).catch((error: unknown) => {
          recordParliamentFailure(guild, governanceGuild(guild.id), error, now);
          throw error;
        });
        if (session) {
          const { ensureGovernanceUx } = await import('./ux.js');
          currentGovernance = (await ensureGovernanceUx(guild, governanceGuild(guild.id))).governance;
        }
      } catch (error) {
        console.error(`Parliament session failed in ${guild.id}:`, error);
      }
    }
    await processGovernanceOutbox(client);
  } finally {
    schedulerRunning = false;
  }
}

function parseExecutionDetail(value: string | null | undefined): Record<string, unknown> {
  try {
    const parsed: unknown = value ? JSON.parse(value) : {};
    return isRecord(parsed) ? parsed : {};
  } catch { return {}; }
}

/** execution_detail の中の外部効果の記録 (effectIntent / effectReceipt) が持つ type。 */
function effectType(effect: unknown): unknown {
  return isRecord(effect) ? effect['type'] : undefined;
}

const stringList = (value: unknown): string[] => (isStringArray(value) ? value : []);

async function reverseDiscordSanction(guild: Guild, governance: GovernanceGuildRow, sanction: SanctionRow, { reverseExternal }: { reverseExternal: boolean }): Promise<void> {
  deactivateRestrictionForSanction(sanction.id);
  const detail = parseExecutionDetail(sanction.execution_detail);
  await releaseAppealRestriction(guild, governance, sanction.user_id, [
    ...stringList(detail['fallbackChannelIds']),
    ...stringList(detail['trialFallbackChannelIds'])
  ]);
  const externalType = effectType(detail['effectIntent']) ?? detail['type'] ?? sanction.type;
  if (reverseExternal && externalType === 'timeout') {
    const member = await guild.members.fetch(sanction.user_id).catch((error: unknown) => { if (isRecord(error) && error['code'] === 10007) return null; throw error; });
    await member?.timeout(null, `${guild.name} sanction ${sanction.id} reversed`);
  }
  if (reverseExternal && externalType === 'ban') throw new Error('BAN解除は管理者がDiscordで手動実行します。');
}

async function publishSanctionExecution(guild: Guild, governance: GovernanceGuildRow, sanction: SanctionRow): Promise<void> {
  const reviewable = sanction.status === 'reviewable';
  const executionLabel = governance.enforcement_mode === 'live' ? '実執行' : '記録のみ';
  const publicCase = requireValue(caseById(sanction.case_id), '処分の事件が見つかりません。');
  if (publicCase.public_thread_id) {
    // 裁判所へ来た事件だけが事件投稿を持つ。警察止まりの処分は執行記録へ。
    await postCourtUpdate(guild, publicCase, `裁判で確定した処分を${executionLabel}として処理しました。`, {
      state: publicCase.status
    });
  } else {
    await postEnforcementRecord(guild, governance, [
      `## ${reviewable ? '即時処分' : '処分の確定'}`,
      `対象: ${publicMemberLabel(publicCase.accused_id, '動作確認用アカウント')}`,
      `処分: ${sanctionLabel(sanctionById(sanction.id))}`,
      `理由: ${publicCase.summary}`,
      `${executionLabel}として記録しました。${reviewable ? '本人は期限内に裁判所の審理を求められます。' : ''}`
    ].join('\n'), {
      components: reviewable ? contestButtons(guild.id, sanction.id) : []
    });
  }
}

// One ordered effect stream: a reversal cannot overtake an in-flight Discord call.
let outboxRunning: Promise<void> | null = null;
export function processGovernanceOutbox(client: Client): Promise<void> {
  if (!outboxRunning) outboxRunning = drainGovernanceOutbox(client).finally(() => { outboxRunning = null; });
  return outboxRunning;
}

function reconcileSanctionEffect(action: OutboxRow): void {
  const current = requireValue(sanctionById(action.payload['sanctionId']), '処分が見つかりません。');
  const detail = parseExecutionDetail(current.execution_detail);
  if (!detail['effectIntent'] && !detail['effectReceipt']) return;
  updateSanction(current.id, { status: 'reversing' });
  enqueueAction({ guildId: current.guild_id, actionType: 'sanction_reverse', targetId: current.id,
    payload: { sanctionId: current.id }, idempotencyKey: `sanction-reconcile:${action.id}` });
}

// 管理者の手動対応の報告 (outbox payload.report) と、待っている依頼 (manualRequest)。
const isManualReport = shape({ reportedBy: isUnknown, result: isUnknown, kind: isUnknown });
const isPendingManualRequest = shape({ kind: isUnknown, requestedAt: isUnknown });

async function drainGovernanceOutbox(client: Client): Promise<void> {
  for (const action of narrowList(pendingActions(25), isOutboxRow, 'outbox action')) {
    if (!markActionRunning(action.id)) continue;
    try {
      // 法令の公開はDiscordを一切触らないので、guildやsanctionの解決より前に処理する。
      if (action.action_type === 'law_publish') {
        await publishInstrument(action.guild_id, { instrumentType: action.payload['instrumentType'], instrumentId: action.payload['instrumentId'] });
        completeAction(action.id);
        continue;
      }
      const governance = governanceGuild(action.guild_id);
      const guild = client.guilds.cache.get(action.guild_id) ?? await client.guilds.fetch(action.guild_id);
      if (action.action_type === 'institution_notice') {
        await postEnforcementRecord(guild, requireValue(governance, 'outbox target is missing'), String(action.payload['text']));
        completeAction(action.id);
        continue;
      }
      if (action.action_type === 'legislation_notice') {
        const proposal = requireProposal(getProposal(action.payload['proposalId']));
        await postProposalUpdate(guild, proposal, `## 成立しました\n${proposal.title}\n法令で定めるAI審査・採択と、必要な人間の投票を完了しました。`, {
          state: '成立', files: [{ name: '成立全文.json', attachment: Buffer.from(JSON.stringify(proposal.body, null, 2)) }]
        });
        syncLawSite(guild);
        completeAction(action.id);
        continue;
      }
      const sanction = sanctionById(action.payload['sanctionId']);
      if (!governance || !sanction) throw new Error('outbox target is missing');
      if (action.action_type === 'manual_sanction_notice') {
        const report = narrow(action.payload['report'], isManualReport, 'manual report');
        const manual: unknown = manualExecutionDetail(sanction);
        const pending = narrow(isRecord(manual) ? manual['manualRequest'] : null, isPendingManualRequest, 'manual execution request');
        if (report || (pending?.kind === action.payload['kind'] && pending?.requestedAt === action.payload['requestedAt'])) {
          const text = report
            ? `管理者 ${publicMemberLabel(report.reportedBy)} が${report.result === 'not_executed' ? '未執行のままの取消' : report.kind === 'execute' ? `${sanction.type}の執行完了` : '処分取消への対応完了'}を報告しました。`
            : `人間の管理者による${pending?.kind === 'execute' ? `${sanction.type}の手動執行` : sanction.type === 'ban' ? 'BAN解除' : '取消通知・再参加案内'}を待っています。「手続」の同じ案件カードから完了を記録してください。`;
          const caseRecord = requireValue(caseById(sanction.case_id), '処分の事件が見つかりません。');
          if (caseRecord.public_thread_id) await postCourtUpdate(guild, caseRecord, text);
          else await postEnforcementRecord(guild, governance, `C-${caseRecord.id}: ${text}`);
        }
      } else if (action.action_type === 'appeal_restrict') {
        if (governance.enforcement_mode === 'live') {
          const detail = await applyAppealRestriction(guild, governance, sanction.user_id);
          updateSanction(sanction.id, { execution_detail: JSON.stringify(detail) });
        }
      } else if (action.action_type === 'sanction_pause_for_trial') {
        const detail = parseExecutionDetail(sanction.execution_detail);
        await reverseDiscordSanction(guild, governance, sanction, { reverseExternal: sanction.type === 'timeout' });
        if (governance.enforcement_mode === 'live') {
          const courtOnly = await applyAppealRestriction(guild, governance, sanction.user_id);
          updateSanction(sanction.id, {
            status: 'under_review',
            execution_detail: JSON.stringify({ ...detail, trialFallbackChannelIds: courtOnly.fallbackChannelIds ?? [] })
          });
        } else {
          updateSanction(sanction.id, { status: 'under_review' });
        }
      } else if (action.action_type === 'sanction_execute') {
        if (['pending_manual_execution', 'pending_manual_reversal'].includes(sanction.status)) {
          completeAction(action.id);
          continue;
        }
        if (sanction.executed_at && ['executed', 'simulated', 'reviewable', 'expired'].includes(sanction.status)) {
          await publishSanctionExecution(guild, governance, sanction);
          completeAction(action.id);
          continue;
        }
        assertSanctionExecution(sanction.id, { statuses: ['queued'] });
        const expectedHash = String(sanctionApprovalHash(sanction));
        const executionAuthority = { expectedHash, expectedMode: governance.enforcement_mode, statuses: ['queued'] };
        const beforeEffect = () => {
          const current = requireSanction(assertSanctionExecution(sanction.id, executionAuthority));
          // Persist intent before external I/O: a crash or ambiguous response still requires cleanup.
          updateSanction(sanction.id, { execution_detail: JSON.stringify({ ...parseExecutionDetail(current.execution_detail),
            effectIntent: { type: sanction.type, targetHash: expectedHash, actionId: action.id } }) });
        };
        let detail: SanctionExecutionDetail = { shadow: true };
        const old = parseExecutionDetail(sanction.execution_detail);
        await releaseAppealRestriction(guild, governance, sanction.user_id, [
          ...stringList(old['fallbackChannelIds']),
          ...stringList(old['trialFallbackChannelIds'])
        ]);
        assertSanctionExecution(sanction.id, executionAuthority);
        if (governance.enforcement_mode === 'live' && requiresManualExecution(sanction)) {
          requestManualExecution(sanction.id);
          completeAction(action.id);
          continue;
        }
        const caseRecord = caseById(sanction.case_id);
        const v2Procedure = caseRecord?.procedure_version === 2 ? caseProcedure(caseRecord) : null;
        if (governance.enforcement_mode === 'live') {
          if (sanction.type === 'restriction') {
            beforeEffect();
            const definition = narrow(getSanctionDefinition(caseById(sanction.case_id)?.law_id, sanction.definition_code), isSanctionDefinitionRow, 'sanction definition');
            if (!definition) throw new Error('restriction definition is missing');
            const startedAt = sanction.restriction_started_at ?? Date.now();
            updateSanction(sanction.id, { restriction_started_at: startedAt });
            activateRestriction({
              sanctionId: sanction.id,
              guildId: guild.id,
              userId: sanction.user_id,
              definitionId: definition.id,
              profile: definition.profile,
              startedAt,
              endsAt: startedAt + Number(sanction.duration_seconds) * 1000
            });
            detail = { type: 'restriction', definitionCode: definition.code };
          } else if (sanction.type === 'timeout' && v2Procedure && !sanction.notice_delivered) {
            beforeEffect();
            const startedAt = sanction.restriction_started_at ?? Date.now();
            updateSanction(sanction.id, { restriction_started_at: startedAt });
            activateRestriction({
              sanctionId: sanction.id,
              guildId: guild.id,
              userId: sanction.user_id,
              definitionId: 0,
              profile: {
                code: 'TIMEOUT_NOTICE_FALLBACK',
                title: '裁判請求経路を残すタイムアウト代替',
                maximumDurationSeconds: sanction.duration_seconds,
                rules: [
                  { primitive: 'messages_per_window', maximum: 0, windowSeconds: 60 },
                  { primitive: 'block_reactions', enabled: true },
                  { primitive: 'block_thread_creation', enabled: true },
                  { primitive: 'block_voice', enabled: true },
                  { primitive: 'agent_calls_per_window', maximum: 0, windowSeconds: 60 },
                  { primitive: 'block_petitions', enabled: true },
                  { primitive: 'block_voting', enabled: true }
                ]
              },
              startedAt,
              endsAt: startedAt + Number(sanction.duration_seconds) * 1000
            });
            detail = { type: 'timeout_fallback', reason: 'review_notice_dm_failed' };
          } else {
            const stableSanction = sanction.type === 'timeout' && !sanction.restriction_started_at
              ? requireSanction(updateSanction(sanction.id, { restriction_started_at: Date.now() }))
              : sanction;
            detail = await executeDiscordSanction(guild, stableSanction, { beforeEffect });
          }
        }
        detail.effectReceipt = { type: detail.type, targetHash: expectedHash, actionId: action.id, completedAt: Date.now() };
        updateSanction(sanction.id, { execution_detail: JSON.stringify(detail) });
        assertSanctionExecution(sanction.id, executionAuthority);
        const reviewable = Boolean(v2Procedure
          && v2Procedure.immediateSanctions.includes(sanction.type)
          && Number(caseRecord?.review_count ?? 0) === 0);
        updateSanction(sanction.id, {
          status: reviewable ? 'reviewable' : (governance.enforcement_mode === 'live' ? 'executed' : 'simulated'),
          executed_at: Date.now(),
          execution_detail: JSON.stringify(detail)
        });
        updateCase(sanction.case_id, reviewable
          ? (sanction.type === 'warning'
            ? { status: 'final', finalized_at: Date.now() }
            : { status: 'contest_window' })
          : { status: 'final', finalized_at: Date.now() });
        createAdministrativeAct({
          guildId: guild.id,
          kind: 'judicial_execution',
          actorType: 'system',
          actorId: guild.client.user.id,
          summary: `${reviewable ? '即時処分' : '判決'}の ${sanction.type} を${governance.enforcement_mode === 'live' ? '執行' : '記録のみ'}`,
          detail: {
            operation: 'sanction_execution',
            sanctionId: sanction.id,
            caseId: sanction.case_id,
            enforcementMode: governance.enforcement_mode,
            execution: detail
          }
        });
        await publishSanctionExecution(guild, governance, requireSanction(getSanction(sanction.id)));
      } else if (action.action_type === 'sanction_reverse') {
        const execution = parseExecutionDetail(sanction.execution_detail);
        if (requiresManualExecution(sanction) && (execution['manualRequest'] || (sanction.executed_at && !execution['shadow']))) {
          await reverseDiscordSanction(guild, governance, sanction, { reverseExternal: false });
          requestManualExecution(sanction.id, 'reverse');
          completeAction(action.id);
          continue;
        }
        const externalType = effectType(execution['effectIntent']) ?? execution['type'];
        await reverseDiscordSanction(guild, governance, sanction, {
          reverseExternal: externalType === 'timeout' || externalType === 'ban'
        });
        updateSanction(sanction.id, { status: 'reversed', reversed_at: Date.now() });
      } else {
        throw new Error(`unknown outbox action: ${action.action_type}`);
      }
      completeAction(action.id);
    } catch (error) {
      const execution = action.action_type === 'sanction_execute' ? parseExecutionDetail(sanctionById(action.payload['sanctionId'])?.execution_detail) : {};
      const code = isRecord(error) ? error['code'] : undefined;
      if (code === 'EXECUTION_REVOKED' || (code === 'EXECUTION_FORBIDDEN' && (execution['effectIntent'] || execution['effectReceipt']))) {
        reconcileSanctionEffect(action);
        completeAction(action.id);
        continue;
      }
      failAction(action.id, error);
    }
  }
}

const isTrustedMutation = shape({ authorized_by: isString });

export async function onTrustedRoleChange(oldMember: GuildMember | PartialGuildMember, newMember: GuildMember): Promise<void> {
  const governance = governanceGuild(newMember.guild.id);
  if (!governance?.trusted_role_id) return;
  const before = oldMember.roles.cache.has(governance.trusted_role_id);
  const after = newMember.roles.cache.has(governance.trusted_role_id);
  if (before === after) return;
  const authorized = narrow(consumeTrustedMutation({
    guildId: newMember.guild.id,
    userId: newMember.id,
    roleId: governance.trusted_role_id,
    desired: after
  }), isTrustedMutation, 'trusted mutation');
  if (authorized) {
    const electorate = specialElectorateName(newMember.guild, governance);
    writeAudit({ guildId: newMember.guild.id, actorType: 'operator', actorId: authorized.authorized_by, action: after ? 'trusted.added' : 'trusted.removed', targetType: 'member', targetId: newMember.id, detail: { roleId: governance.trusted_role_id } });
    await postAuthorityChange(newMember.guild, governance, after ? `「${electorate}」に追加` : `「${electorate}」から削除`, `対象: ${publicMemberLabel(newMember.id)}\n運営者: ${publicMemberLabel(authorized.authorized_by)}`);
    return;
  }

  // trusted membershipの正本操作はowner専用commandだけ。UIや別botからの直接変更は
  // role管理権限の横取りを統治権限へ昇格させないよう元へ戻す。
  authorizeTrustedMutation({
    guildId: newMember.guild.id,
    userId: newMember.id,
    roleId: governance.trusted_role_id,
    desired: before,
    authorizedBy: newMember.guild.client.user.id
  });
  if (before) await newMember.roles.add(governance.trusted_role_id, 'Unauthorized trusted role removal reverted');
  else await newMember.roles.remove(governance.trusted_role_id, 'Unauthorized trusted role addition reverted');
  writeAudit({ guildId: newMember.guild.id, actorType: 'system', action: 'trusted.unauthorized_change_reverted', targetType: 'member', targetId: newMember.id, detail: { attempted: after ? 'add' : 'remove', roleId: governance.trusted_role_id } });
}

export async function setTrustedMember(guild: Guild, actorId: string, member: GuildMember, desired: boolean): Promise<boolean> {
  const governance = governanceGuild(guild.id);
  if (!governance) throw new Error('このサーバーでは統治機能が初期化されていません。');
  if (!governance.trusted_role_id) throw new Error('特別有権者ロールが設定されていません。');
  if (actorId !== guild.ownerId) throw new Error('特別有権者を変更できるのはDiscord ownerだけです。');
  if (member.user.bot) throw new Error('Botは特別有権者にできません。');
  const current = member.roles.cache.has(governance.trusted_role_id);
  if (current === desired) return false;
  authorizeTrustedMutation({
    guildId: guild.id,
    userId: member.id,
    roleId: governance.trusted_role_id,
    desired,
    authorizedBy: actorId
  });
  if (desired) await member.roles.add(governance.trusted_role_id, `Trusted user added by owner ${actorId}`);
  else await member.roles.remove(governance.trusted_role_id, `Trusted user removed by owner ${actorId}`);
  return true;
}

export async function onGuildRoleDelete(role: Role): Promise<void> {
  const governance = governanceGuild(role.guild.id);
  if (!governance) return;
  if (governance.trusted_role_id === role.id) {
    updateGovernanceGuild(role.guild.id, { trusted_role_id: '' });
    writeAudit({ guildId: role.guild.id, actorType: 'system', action: 'trusted.role_deleted', targetType: 'role', targetId: role.id, detail: { trustedDisabled: true } });
    await postAuthorityChange(role.guild, governance, '特別有権者ロールが削除されました', '新たな特別有権者の受付を停止しました。すでに開始した投票・承認は保存済みの資格と法定条件に従い、必要な承認を省略しません。');
  }
  const patch: Record<string, string> = {};
  if (governance.judiciary_role_id === role.id) patch['judiciary_role_id'] = '';
  if (Object.keys(patch).length > 0) {
    updateGovernanceGuild(role.guild.id, patch);
    writeAudit({
      guildId: role.guild.id,
      actorType: 'system',
      action: 'governance.address_role_deleted',
      targetType: 'role',
      targetId: role.id,
      detail: { recreatedByScheduler: true, ...patch }
    });
  }
}

export async function onGuildChannelCreate(channel: NonThreadGuildBasedChannel | GuildBasedChannel): Promise<void> {
  const governance = governanceGuild(channel.guildId);
  if (!governance || channel.id === governance.court_forum_id) return;
  await syncAppealRoleOverwrites(channel.guild, governance.appeal_role_id, governance.court_forum_id, { strict: true });
}
