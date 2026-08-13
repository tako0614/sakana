import { PermissionFlagsBits } from 'discord.js';
import { db as archiveDb } from '../archive/db.js';
import {
  activateRestriction,
  addCaseEvidence,
  addCaseSubmission,
  authorizeTrustedMutation,
  castProposalVote,
  completeAction,
  consumeTrustedMutation,
  createAdministrativeAct,
  createAppeal,
  createCase,
  createInterimProtection,
  createProposal,
  createSanction,
  deactivateRestrictionForSanction,
  enactConstitution,
  enactLaw,
  enqueueAction,
  expireRestrictions,
  expireInterimProtections,
  expireGovernanceIntakes,
  failAction,
  findActiveProposalByNormalizedTitle,
  findCaseBySummaryEvent,
  findOpenConstitutionalCase,
  findRecentSummaryCase,
  getActiveConstitution,
  getAdministrativeAct,
  getAppeal,
  getCase,
  getCaseByPublicThread,
  getCaseSanction,
  getGovernanceGuild,
  getCaseInterimProtection,
  getConstitution,
  getLaw,
  getMentionInvestigation,
  getCurrentLawVersion,
  getOperationalSetting,
  getProposal,
  getProposalByForumThread,
  getSanction,
  getSanctionDefinition,
  listCaseApprovals,
  listCaseEvidence,
  listCaseDecisions,
  listCaseSubmissions,
  listCurrentCaseSubmissions,
  listCases,
  listGovernanceGuilds,
  listLaws,
  listInvestigationEvidence,
  listOpenCasesForLaw,
  listProposals,
  listSanctionsForLaw,
  markActionRunning,
  markEvidenceDisclosed,
  pendingActions,
  proposalVoteSummary,
  proposalDiscussion,
  pruneGovernance,
  queueProposalWorkflow,
  recordActivities,
  recordActivity,
  recordProposalDeliberation,
  recordInstrumentRelation,
  recentUserActivity,
  recentGovernanceMessages,
  replaceCaseSubmission,
  reserveAgentAttempt,
  resumeQueuedProposal,
  setCaseApproval,
  setOperationalSetting,
  snapshotProposalVoters,
  updateAppeal,
  updateAdministrativeAct,
  updateCase,
  updateGovernanceGuild,
  updateLaw,
  updateProposal,
  updateSanction,
  writeAudit
} from './db.js';
import {
  applyAppealRestriction,
  createCourtCaseThread,
  createProposalPost,
  executeDiscordSanction,
  ensureGovernanceParliamentForum,
  ensureGovernanceStatuteForum,
  postAuthorityChange,
  postCourtUpdate,
  postCourtRecord,
  postProposalUpdate,
  publicMemberLabel,
  releaseAppealRestriction,
  reviewRequestButtons,
  syncAppealRoleOverwrites,
  ensureGovernanceMentionRoles,
  syncGovernanceRecordUi,
  syncStatuteBook
} from './discord.js';
import {
  discoverWeeklyIssues,
  deliberateProposal,
  draftAmendment,
  draftBill,
  reviewLegislativeRelation,
  runConstitutionalPanel,
  runJudicialPanel
} from './llm.js';
import {
  DAY_MS,
  activityDate,
  isAppealable,
  legislationProcedure,
  normalizeActivityContent,
  requiredApprovals,
  sha256,
  summaryProcedure,
  validateAutomaticTrigger,
  validateInterimProtectionDefinition,
  validateRestrictionDefinition
} from './policy.js';
import { governanceActionAllowed, reserveRestrictedAgentCall } from './restrictions.js';
import { notifyCaseParty } from './notifications.js';
import {
  activeProposal,
  activeConstitutionalAmendment,
  activeLawAmendment,
  buildLegislativeCandidates,
  exactActiveProposalMatch
} from './relation.js';
import { closeGovernanceVote, compileConstitution, durationMilliseconds, workflowFor } from './rules.js';

const RETRY_BASE_MS = 5 * 60_000;
const RETRY_MAX_MS = 60 * 60_000;

function proposalRuntime(proposal) {
  const constitution = getConstitution(proposal.constitution_id);
  if (!constitution) throw new Error('案件受付時の憲法がありません。');
  const compiled = constitution.rules
    ? { rules: constitution.rules, rulesHash: constitution.rules_hash, policy: constitution.policy }
    : compileConstitution({ content: constitution.content, policy: constitution.policy });
  const key = proposal.kind === 'amendment' ? 'constitutionalAmendment' : 'law';
  const workflow = workflowFor(compiled, key);
  const state = workflow.states[proposal.status];
  if (!state) return null;
  return { constitution, compiled, key, workflow, stateName: proposal.status, state };
}

function proposalTransition(proposal, outcome) {
  const runtime = proposalRuntime(proposal);
  return proposalTransitionFrom(runtime, runtime?.stateName, outcome);
}

function proposalTransitionFrom(runtime, stateName, outcome) {
  const source = runtime?.workflow?.states?.[stateName];
  const targetName = source?.on?.[outcome];
  if (!targetName) throw new Error(`憲法の実行規則は ${stateName} で ${outcome} を許可していません。`);
  const target = runtime.workflow.states[targetName];
  return {
    ...runtime,
    sourceName: stateName,
    source,
    outcome,
    targetName,
    target,
    durationMilliseconds: target.duration === null ? null : durationMilliseconds(target.duration)
  };
}

function proposalStageEnd(transition, now = Date.now()) {
  return transition.durationMilliseconds === null ? null : now + transition.durationMilliseconds;
}

function specialElectorateName(guild, governance) {
  return governance.trusted_role_id
    ? (guild.roles.cache.get(governance.trusted_role_id)?.name ?? '特別有権者')
    : '特別有権者';
}

function publicLawDetails(law, offenseCode) {
  const offense = law?.provisions?.offenses?.find((entry) => entry.code === offenseCode);
  return [
    law ? `適用法: ${law.title}` : '適用法: 裁判記録に記載',
    offense?.title ? `対象となる違反: ${offense.title}` : null
  ].filter(Boolean);
}

export function publicPanelOutputs(outputs, evidenceOrder = new Map()) {
  return outputs.map((output) => {
    const {
      evidenceIds = [],
      elementFindings = [],
      lawId: _lawId,
      offenseCode: _offenseCode,
      ...publicOutput
    } = output;
    return {
      ...publicOutput,
      evidence: evidenceIds.map((id) => `証拠 ${evidenceOrder.get(id) ?? '?'}`),
      ...(elementFindings.length > 0 ? {
        elementFindings: elementFindings.map(({ evidenceIds: findingEvidence = [], ...finding }) => ({
          ...finding,
          evidence: findingEvidence.map((id) => `証拠 ${evidenceOrder.get(id) ?? '?'}`)
        }))
      } : {})
    };
  });
}
const CASE_EVIDENCE_LIMIT = 20;
const CASE_SUBMISSION_LIMIT_PER_PHASE = 40;

function acceptedWorkflowError(message, resultType, resultId) {
  const error = new Error(message);
  error.name = 'GovernanceAcceptedWorkflowError';
  error.accepted = { resultType, resultId: String(resultId) };
  return error;
}

function retryPatch(record, error, now = Date.now()) {
  const failureCount = Number(record.failure_count ?? 0) + 1;
  return {
    failure_count: failureCount,
    retry_after: now + Math.min(RETRY_MAX_MS, RETRY_BASE_MS * (2 ** Math.min(failureCount - 1, 4))),
    last_error: String(error?.message ?? error).slice(0, 500)
  };
}

function requireGovernance(guildId) {
  const governance = getGovernanceGuild(guildId);
  if (!governance) throw new Error('このサーバーでは統治機能が初期化されていません。');
  if (governance.status !== 'active') throw new Error('統治機能は現在一時停止中です。');
  const constitution = getActiveConstitution(guildId);
  if (!constitution) throw new Error('有効な憲法がありません。');
  return { governance, constitution, policy: constitution.policy };
}

function constitutionForCase(caseRecord) {
  return (caseRecord.constitution_id ? getConstitution(caseRecord.constitution_id) : null)
    ?? getActiveConstitution(caseRecord.guild_id);
}

function caseProcedure(caseRecord) {
  return summaryProcedure(constitutionForCase(caseRecord)?.policy);
}

function governanceSurface(channel, governance) {
  if (!channel || !governance) return false;
  const ids = new Set([
    governance.category_id,
    governance.parliament_forum_id,
    governance.court_forum_id,
    governance.court_chat_channel_id,
    governance.statute_forum_id,
    governance.procedure_channel_id,
    governance.operations_thread_id
  ].filter(Boolean));
  return ids.has(channel.id) || ids.has(channel.parentId);
}

function publicChannel(message, governance = null) {
  const channel = message.channel;
  if (!channel || channel.isDMBased?.()) return false;
  const isProposalDiscussion = channel.isThread?.()
    && channel.parentId === governance?.parliament_forum_id
    && Boolean(getProposalByForumThread(channel.id));
  if (governanceSurface(channel, governance) && (!isProposalDiscussion || message.author?.bot)) return false;
  const everyone = message.guild?.roles?.everyone;
  return Boolean(everyone && channel.permissionsFor?.(everyone)?.has(PermissionFlagsBits.ViewChannel));
}

export function recordGovernanceMessage(message) {
  if (!message?.guildId) return false;
  const governance = getGovernanceGuild(message.guildId);
  if (!governance || !publicChannel(message, governance)) return false;
  const constitution = getActiveConstitution(message.guildId);
  if (!constitution) return false;
  const normalized = normalizeActivityContent(message.content);
  if (Array.from(normalized).length < constitution.policy.eligibility.minimumVisibleCharacters || /^[/!]/.test(normalized)) return false;
  return recordActivity({
    messageId: message.id,
    guildId: message.guildId,
    channelId: message.channelId,
    parentId: message.channel?.parentId ?? null,
    userId: message.author.id,
    activityDate: activityDate(message.createdTimestamp, constitution.policy.timezoneOffsetMinutes),
    contentHash: sha256(normalized),
    content: String(message.content ?? '').slice(0, 1000),
    createdAt: message.createdTimestamp
  });
}

/**
 * 通常会話agentの回数壁。費用上限とは別で、prompt injectionの試行回数を抑える。
 * trustedはサーバー名ではなく、初期化時に指定したrole IDだけで判定する。
 */
export function reserveGovernanceAgentAttempt(member, eventId) {
  const governance = getGovernanceGuild(member?.guild?.id);
  if (!governance) return { ok: true, governed: false };
  const restricted = reserveRestrictedAgentCall(member.guild.id, member.id, eventId);
  if (!restricted.ok) return { ...restricted, governed: true, scope: 'sanction' };
  const trusted = Boolean(governance.trusted_role_id) && (member.roles?.cache?.has?.(governance.trusted_role_id)
    ?? member.roles?.includes?.(governance.trusted_role_id)
    ?? false);
  const rawLimit = getOperationalSetting(
    member.guild.id,
    trusted ? 'trusted_daily_calls' : 'general_daily_calls'
  );
  const limit = Math.max(0, Math.floor(rawLimit));
  const reservation = reserveAgentAttempt(member.guild.id, member.id, trusted, limit);
  return {
    ...reservation,
    governed: true,
    trusted,
    scope: 'attempt'
  };
}

export function reserveGovernanceIntakeAttempt(member, eventId, { constitutional = false } = {}) {
  if (!constitutional) return reserveGovernanceAgentAttempt(member, eventId);
  const governance = getGovernanceGuild(member?.guild?.id);
  const constitution = getActiveConstitution(member?.guild?.id);
  if (!governance || !constitution) return { ok: true, governed: false };
  const restricted = reserveRestrictedAgentCall(member.guild.id, member.id, eventId);
  if (!restricted.ok) return { ...restricted, governed: true, scope: 'sanction' };
  const limit = constitution.policy.judiciary.constitutionalChallengesPerMemberPerDay;
  return {
    ...reserveAgentAttempt(
      member.guild.id,
      member.id,
      false,
      limit,
      DAY_MS,
      'constitutional_challenge'
    ),
    governed: true,
    trusted: false,
    scope: 'constitutional_challenge'
  };
}

function requireGovernanceAiAttempt(member, eventId) {
  const attempt = reserveGovernanceAgentAttempt(member, eventId);
  if (attempt.ok) return attempt;
  const retry = attempt.retryAt ? ` <t:${Math.floor(attempt.retryAt / 1000)}:R>に空きます。` : '';
  if (attempt.scope === 'sanction') throw new Error(`判決によりAI利用が制限されています。${retry}`);
  throw new Error(`prompt injection対策のAI回数枠に達しました (${attempt.used}/${attempt.limit})。${retry}`);
}

export async function backfillGovernanceActivity(guild) {
  const { governance, policy } = requireGovernance(guild.id);
  await guild.channels.fetch();
  const publicIds = new Set([...guild.channels.cache.values()]
    .filter((channel) => channel.isTextBased?.()
      && !governanceSurface(channel, governance)
      && channel.permissionsFor(guild.roles.everyone)?.has(PermissionFlagsBits.ViewChannel))
    .map((channel) => channel.id));
  const since = Date.now() - policy.eligibility.windowDays * DAY_MS;
  const rows = archiveDb.prepare(`
    SELECT m.message_id, m.guild_id, m.channel_id, m.parent_id, m.author_id, m.content, m.created_at,
      COALESCE(c.is_private, 1) AS is_private
    FROM messages m
    LEFT JOIN channels c ON c.channel_id = m.channel_id
    WHERE m.guild_id = ? AND m.created_at >= ? AND m.deleted = 0
    ORDER BY m.created_at
  `).all(guild.id, since);
  const activities = [];
  for (const row of rows) {
    if (row.is_private || (!publicIds.has(row.channel_id) && !publicIds.has(row.parent_id))) continue;
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
      content: String(row.content ?? '').slice(0, 1000),
      createdAt: row.created_at
    });
  }
  return recordActivities(activities);
}

export async function buildElectorateSnapshot(guild, proposalId) {
  const { governance, policy: activePolicy } = requireGovernance(guild.id);
  const proposal = getProposal(proposalId);
  const policy = getConstitution(proposal?.constitution_id)?.policy ?? activePolicy;
  const scope = proposal?.vote_scope ?? policy.voting.defaultScope;
  if (!policy.voting.allowedScopes.includes(scope)) throw new Error('この投票scopeは現行憲法で許可されていません。');
  const members = await guild.members.fetch();
  const rows = [];
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

async function finishDraft(guild, proposal, body) {
  const { governance } = requireGovernance(guild.id);
  const now = Date.now();
  const transition = proposalTransition(proposal, 'drafted');
  const stageEndsAt = proposalStageEnd(transition, now);
  const nextStatus = transition.targetName;
  // Forum作成が成功するまではdraftingのままにする。bodyは保存済みなので、
  // Discord障害からの再試行でAIをもう一度呼ぶ必要はない。
  proposal = updateProposal(proposal.id, {
    title: body.title,
    summary: body.summary,
    body,
    retry_after: null,
    failure_count: 0,
    last_error: null
  });
  const displayProposal = {
    ...proposal,
    status: nextStatus,
    stage_started_at: now,
    stage_ends_at: stageEndsAt
  };
  const post = proposal.forum_thread_id
    ? { threadId: proposal.forum_thread_id, messageId: proposal.forum_message_id }
    : await createProposalPost(guild, governance, displayProposal);
  return updateProposal(proposal.id, {
    status: nextStatus,
    stage_started_at: now,
    stage_ends_at: stageEndsAt,
    debate_extensions: 0,
    forum_thread_id: post.threadId,
    forum_message_id: post.messageId
  });
}

async function draftStoredProposal(guild, proposal, { relatedInputs = null } = {}) {
  const { constitution, policy } = requireGovernance(guild.id);
  if (proposal.body) return finishDraft(guild, proposal, proposal.body);
  const inputs = relatedInputs ?? (Array.isArray(proposal.workflow_context?.queue?.inputs)
    ? proposal.workflow_context.queue.inputs
    : []);
  const investigationId = /^mention_investigation:(\d+)$/.exec(String(proposal.source))?.[1] ?? null;
  const investigation = investigationId ? getMentionInvestigation(investigationId) : null;
  const investigationEvidence = investigationId
    ? listInvestigationEvidence(investigationId, 'legislative_basis')
    : [];
  const request = {
    title: proposal.title,
    summary: [
      proposal.summary,
      ...inputs.slice(-8).map((input) => `同一案件として寄せられた意見: ${String(input.summary ?? '').slice(0, 1200)}`)
    ].join('\n').slice(0, 12_000),
    source: proposal.source,
    investigation: investigation ? {
      id: investigation.id,
      request: investigation.request_text,
      evidence: investigationEvidence.map((entry) => ({
        messageId: entry.message_id,
        authorId: entry.author_id,
        content: entry.content,
        occurredAt: entry.occurred_at
      }))
    } : null
  };
  const targetLaw = proposal.target_type === 'law' ? getLaw(proposal.target_id) : null;
  const body = proposal.kind === 'amendment'
    ? await draftAmendment({ guildId: guild.id, request, constitution })
    : await draftBill({
      guildId: guild.id,
      petition: targetLaw ? {
        ...request,
        amendmentTarget: {
          id: targetLaw.id,
          title: targetLaw.title,
          text: targetLaw.text,
          provisions: targetLaw.provisions,
          contentHash: targetLaw.content_hash,
          instruction: 'Return the complete replacement law. Preserve every unrelated provision exactly.'
        }
      } : request,
      constitution,
      activeLaws: listLaws(guild.id),
      policy
    });
  return finishDraft(guild, proposal, body);
}

export async function filePetition(guild, member, {
  title, summary, source = 'petition', eventId = null, voteScope = null,
  attemptReserved = false, relation = null
}) {
  const { governance, constitution, policy } = requireGovernance(guild.id);
  const scope = voteScope ?? policy.voting.defaultScope;
  if (!policy.voting.allowedScopes.includes(scope)) throw new Error('許可されていない投票scopeです。');
  if (scope === 'trusted' && !governance.trusted_role_id) throw new Error('特別有権者のみの投票には、対象ロールの設定が必要です。');
  if (!governanceActionAllowed(guild.id, member.id, 'petition')) throw new Error('請願提出が制裁により停止されています。');
  const duplicate = findActiveProposalByNormalizedTitle(guild.id, title);
  if (duplicate) throw new Error('同名の法案が進行中です。議会で討議してください。');
  const officialSource = source === 'weekly' || String(source).startsWith('mention_investigation:');
  if (!officialSource && !attemptReserved) requireGovernanceAiAttempt(member, eventId ?? `petition:${member.id}:${Date.now()}`);
  let targetLaw = null;
  let targetConflict = null;
  if (relation?.relation === 'amend_law') {
    targetLaw = getCurrentLawVersion(relation.targetId);
    if (!targetLaw || targetLaw.guild_id !== guild.id || targetLaw.status !== 'active') throw new Error('改正対象の法律が現行ではありません。');
    if (relation.targetHash && relation.targetHash !== targetLaw.content_hash) throw new Error('改正対象の法律が更新されました。改めて内容を確認してください。');
    targetConflict = activeLawAmendment(
      listProposals(guild.id, { limit: 500 }),
      listLaws(guild.id, { activeOnly: false, limit: 500 }),
      targetLaw.id
    );
  }
  let proposal = createProposal({
    guildId: guild.id,
    kind: 'law',
    source,
    title,
    summary,
    proposerId: officialSource ? null : member.id,
    constitutionId: constitution.id,
    voteScope: scope,
    status: workflowFor({ rules: constitution.rules }, 'law').initial,
    relationType: relation?.relation ?? 'new',
    targetType: targetLaw ? 'law' : null,
    targetId: targetLaw?.id ?? null,
    targetHash: targetLaw?.content_hash ?? null
  });
  if (relation && relation.relation !== 'new') recordInstrumentRelation({
    guildId: guild.id,
    sourceType: 'proposal',
    sourceId: proposal.id,
    relationType: relation.relation,
    targetType: relation.targetType ?? 'none',
    targetId: relation.targetId ?? 'none',
    targetHash: relation.targetHash,
    reasons: relation.reasons,
    decision: relation
  });
  if (targetConflict) {
    return queueProposalWorkflow(proposal.id, {
      blockedByProposalId: targetConflict.id,
      reason: 'same_law_in_progress'
    });
  }
  try {
    return await draftStoredProposal(guild, proposal);
  } catch (error) {
    updateProposal(proposal.id, retryPatch(proposal, error));
    console.error(`Initial draft failed for proposal ${proposal.id}:`, error);
    throw acceptedWorkflowError(
      '法案を受理しました。準備ができると議会に表示されます。',
      'proposal',
      proposal.id
    );
  }
}

export async function fileAmendment(guild, member, {
  title, summary, eventId = null, voteScope = null, attemptReserved = false, relation = null,
  source = 'petition'
}) {
  const { governance, constitution, policy } = requireGovernance(guild.id);
  const scope = voteScope ?? policy.voting.defaultScope;
  if (!policy.voting.allowedScopes.includes(scope)) throw new Error('許可されていない投票scopeです。');
  if (scope === 'trusted' && !governance.trusted_role_id) throw new Error('特別有権者のみの投票には、対象ロールの設定が必要です。');
  if (!governanceActionAllowed(guild.id, member.id, 'petition')) throw new Error('改憲提案が制裁により停止されています。');
  const conflict = activeConstitutionalAmendment(
    listProposals(guild.id, { limit: 500 })
  );
  const duplicate = findActiveProposalByNormalizedTitle(guild.id, title);
  if (duplicate) throw new Error('同名の改憲案が進行中です。議会で討議してください。');
  const officialSource = String(source).startsWith('mention_investigation:');
  if (!officialSource && !attemptReserved) requireGovernanceAiAttempt(member, eventId ?? `amendment:${member.id}:${Date.now()}`);
  let proposal = createProposal({
    guildId: guild.id,
    kind: 'amendment',
    source,
    title,
    summary,
    proposerId: officialSource ? null : member.id,
    constitutionId: constitution.id,
    voteScope: scope,
    status: workflowFor({ rules: constitution.rules }, 'constitutionalAmendment').initial,
    relationType: relation?.relation ?? 'amend_constitution',
    targetType: 'constitution',
    targetId: constitution.id,
    targetHash: constitution.content_hash
  });
  if (relation) recordInstrumentRelation({
    guildId: guild.id,
    sourceType: 'proposal',
    sourceId: proposal.id,
    relationType: relation.relation,
    targetType: relation.targetType ?? 'constitution',
    targetId: relation.targetId ?? constitution.id,
    targetHash: relation.targetHash ?? constitution.content_hash,
    reasons: relation.reasons,
    decision: relation
  });
  if (conflict) {
    return queueProposalWorkflow(proposal.id, {
      blockedByProposalId: conflict.id,
      reason: 'constitution_in_progress'
    });
  }
  try {
    return await draftStoredProposal(guild, proposal);
  } catch (error) {
    updateProposal(proposal.id, retryPatch(proposal, error));
    console.error(`Initial draft failed for amendment ${proposal.id}:`, error);
    throw acceptedWorkflowError(
      '改憲案を受理しました。準備ができると議会に表示されます。',
      'proposal',
      proposal.id
    );
  }
}

async function reviseProposal(guild, proposal, reviews) {
  const runtime = proposalRuntime(proposal);
  const constitution = runtime.constitution;
  const maximumRevisions = runtime.workflow.config.maximumRevisions ?? 2;
  if (proposal.revision - 1 >= maximumRevisions) {
    const transition = proposalTransition(proposal, 'remanded');
    const remanded = { ...proposal, status: transition.targetName, stage_ends_at: Date.now() };
    await postProposalUpdate(
      guild,
      remanded,
      `違憲審査の指摘を反映するには実質変更が必要ですが、調整上限${maximumRevisions}回に達したため差し戻しました。`,
      { state: '廃案' }
    );
    return updateProposal(proposal.id, remanded);
  }
  const feedback = reviews.map((review) => ({ verdict: review.verdict, reasons: review.reasons }));
  const request = {
    title: proposal.title,
    summary: proposal.summary,
    priorDraft: proposal.body,
    constitutionalReview: feedback,
    instruction: '違憲・判断不能の理由だけを修正し、関係ない内容を増やさない'
  };
  const body = proposal.kind === 'amendment'
    ? await draftAmendment({ guildId: guild.id, request, constitution })
    : await draftBill({
      guildId: guild.id,
      petition: request,
      constitution,
      activeLaws: listLaws(guild.id),
      policy: constitution.policy
    });
  const now = Date.now();
  const nextRevision = proposal.revision + 1;
  const transition = proposalTransition(proposal, 'revise');
  const stageEndsAt = proposalStageEnd(transition, now);
  const publicDiscussion = transition.target.handler === 'public_discussion';
  const revised = {
    ...proposal,
    title: body.title,
    summary: body.summary,
    body,
    status: transition.targetName,
    revision: nextRevision,
    stage_started_at: now,
    stage_ends_at: stageEndsAt,
    debate_extensions: 0,
    retry_after: null,
    failure_count: 0,
    last_error: null
  };
  await postProposalUpdate(
    guild,
    revised,
    publicDiscussion
      ? `違憲審査の指摘を反映した調整案を公開しました。最終案ではないため、もう一度この投稿で討議します。締切: <t:${Math.floor(revised.stage_ends_at / 1000)}:F>`
      : '違憲審査の指摘を反映した改訂案を公開しました。憲法の実行規則に従って次の段階へ進みます。',
    { files: [
      ...proposalBodyFiles(proposal.kind, body, '調整案'),
      { attachment: Buffer.from(`${JSON.stringify({ source: 'constitutional_review', feedback }, null, 2)}\n`), name: '調整理由.json' }
    ], state: publicDiscussion ? '討議' : '草案' }
  );
  return updateProposal(proposal.id, revised);
}

function proposalBodyFiles(kind, body, label) {
  const fullText = kind === 'amendment'
    ? `# ${body.title}\n\n${body.content}`
    : `# ${body.title}\n\n${body.text}\n\n## Provisions\n\n\`\`\`json\n${JSON.stringify(body.provisions, null, 2)}\n\`\`\``;
  return [
    { attachment: Buffer.from(fullText), name: `${label}全文.md` },
    {
      attachment: Buffer.from(`${JSON.stringify(kind === 'amendment' ? (body.rules ?? body.policy) : body.provisions, null, 2)}\n`),
      name: kind === 'amendment' ? '憲法実行規則.json' : '執行定義.json'
    }
  ];
}

function deliberationText(decision, heading) {
  const section = (label, values) => values.length
    ? [`**${label}**`, ...values.map((value) => `- ${value}`)]
    : [];
  return [
    `## ${heading}`,
    decision.summary,
    ...section('採用した意見', decision.accepted),
    ...section('採用しなかった意見', decision.rejected),
    ...section('変更点', decision.changes)
  ].join('\n').slice(0, 2_000);
}

export async function completeProposalDebate(guild, proposal, now = Date.now()) {
  const constitution = getActiveConstitution(guild.id);
  const procedurePolicy = getConstitution(proposal.constitution_id)?.policy ?? constitution.policy;
  const runtime = proposalRuntime(proposal);
  if (!['public_discussion', 'ai_deliberation'].includes(runtime?.state?.handler)
    || (runtime.state.handler === 'public_discussion'
      && !['initial', 'revision'].includes(runtime.state.config.phase))) {
    throw new Error('この案件は受付時の旧立法手続で進行しています。');
  }
  const procedure = legislationProcedure(procedurePolicy);
  const rows = proposalDiscussion(
    proposal.id,
    Number(proposal.stage_started_at ?? proposal.created_at),
    Number(proposal.stage_ends_at ?? now),
    300
  );
  const lateBoundary = Number(proposal.stage_ends_at ?? now) - procedure.lateFeedbackWindowMilliseconds;
  const discussion = rows.map((row, index) => ({
    number: index + 1,
    content: row.content,
    createdAt: row.created_at,
    late: row.created_at >= lateBoundary
  }));
  const decision = discussion.length > 0
    ? await deliberateProposal({
        guildId: guild.id,
        proposal,
        discussion,
        constitution,
        activeLaws: listLaws(guild.id)
      })
    : {
        decision: 'finalize',
        summary: '討議期間中に法案を変更する意見はありませんでした。',
        accepted: [],
        rejected: [],
        changes: [],
        lateMaterialFeedback: false,
        body: null
      };
  const publicDecision = { ...decision };
  delete publicDecision.body;

  if (runtime.state.handler === 'public_discussion'
    && procedure.extendOnLateMaterialFeedback
    && decision.lateMaterialFeedback
    && Number(proposal.debate_extensions ?? 0) < procedure.maximumDebateExtensions) {
    const transition = proposalTransition(proposal, 'extended');
    const stageEndsAt = now + procedure.debateExtensionMilliseconds;
    const extended = {
      ...proposal,
      status: transition.targetName,
      stage_ends_at: stageEndsAt,
      debate_extensions: Number(proposal.debate_extensions ?? 0) + 1,
      retry_after: null,
      failure_count: 0,
      last_error: null
    };
    await postProposalUpdate(
      guild,
      extended,
      `${deliberationText(decision, '討議を延長します')}\n\n締切直前に実質的な論点が出たため、応答時間を確保します。新しい締切: <t:${Math.floor(stageEndsAt / 1000)}:F>`,
      { state: '討議', files: [{ attachment: Buffer.from(`${JSON.stringify(publicDecision, null, 2)}\n`), name: '討議整理.json' }] }
    );
    const saved = updateProposal(proposal.id, extended);
    recordProposalDeliberation({
      proposalId: proposal.id,
      revision: proposal.revision,
      outcome: 'extended',
      discussion: rows,
      decision: publicDecision
    });
    return saved;
  }

  const deliberationTransition = runtime.state.handler === 'public_discussion'
    ? proposalTransition(proposal, 'expired')
    : null;
  if (deliberationTransition && deliberationTransition.target.handler !== 'ai_deliberation') {
    throw new Error('公開討議の次にAI整理を行う実行規則ではありません。');
  }
  const deliberationState = deliberationTransition?.targetName ?? proposal.status;

  if (decision.decision === 'revise') {
    if (proposal.revision - 1 >= procedure.maximumRevisions) {
      const transition = proposalTransitionFrom(runtime, deliberationState, 'remanded');
      const remanded = {
        ...proposal,
        status: transition.targetName,
        stage_ends_at: now,
        retry_after: null,
        last_error: null
      };
      await postProposalUpdate(
        guild,
        remanded,
        `${deliberationText(decision, '討議の整理')}\n\n実質変更がさらに必要ですが、調整上限${procedure.maximumRevisions}回に達したため差し戻します。`,
        { state: '廃案', files: [{ attachment: Buffer.from(`${JSON.stringify(publicDecision, null, 2)}\n`), name: '討議整理.json' }] }
      );
      if (deliberationTransition) updateProposal(proposal.id, { status: deliberationState });
      const saved = updateProposal(proposal.id, remanded);
      recordProposalDeliberation({
        proposalId: proposal.id,
        revision: proposal.revision,
        outcome: 'remanded',
        discussion: rows,
        decision: publicDecision
      });
      return saved;
    }
    const transition = proposalTransitionFrom(runtime, deliberationState, 'revised');
    const stageEndsAt = proposalStageEnd(transition, now);
    const revised = {
      ...proposal,
      title: decision.body.title,
      summary: decision.body.summary,
      body: decision.body,
      status: transition.targetName,
      revision: proposal.revision + 1,
      stage_started_at: now,
      stage_ends_at: stageEndsAt,
      debate_extensions: 0,
      retry_after: null,
      failure_count: 0,
      last_error: null
    };
    await postProposalUpdate(
      guild,
      revised,
      `${deliberationText(decision, '調整案を公開します')}\n\n実質的な変更があるため、調整案を再討議します。締切: <t:${Math.floor(stageEndsAt / 1000)}:F>`,
      {
        state: '討議',
        files: [
          ...proposalBodyFiles(revised.kind, revised.body, '調整案'),
          { attachment: Buffer.from(`${JSON.stringify(publicDecision, null, 2)}\n`), name: '討議整理.json' }
        ]
      }
    );
    if (deliberationTransition) updateProposal(proposal.id, { status: deliberationState });
    const saved = updateProposal(proposal.id, revised);
    recordProposalDeliberation({
      proposalId: proposal.id,
      revision: proposal.revision,
      outcome: 'revised',
      discussion: rows,
      decision: publicDecision
    });
    return saved;
  }

  const finalBody = decision.body ?? proposal.body;
  const transition = proposalTransitionFrom(runtime, deliberationState, 'finalized');
  const finalProposal = {
    ...proposal,
    title: finalBody.title,
    summary: finalBody.summary,
    body: finalBody,
    status: transition.targetName,
    stage_started_at: now,
    stage_ends_at: null,
    debate_extensions: 0,
    retry_after: null,
    failure_count: 0,
    last_error: null
  };
  await postProposalUpdate(
    guild,
    finalProposal,
    `${deliberationText(decision, '最終案を固定しました')}\n\nここから本文は変更せず、違憲審査へ進みます。`,
    {
      state: '違憲審査',
      files: [
        ...proposalBodyFiles(finalProposal.kind, finalProposal.body, '最終案'),
        { attachment: Buffer.from(`${JSON.stringify(publicDecision, null, 2)}\n`), name: '討議整理.json' }
      ]
    }
  );
  if (deliberationTransition) updateProposal(proposal.id, { status: deliberationState });
  const saved = updateProposal(proposal.id, finalProposal);
  recordProposalDeliberation({
    proposalId: proposal.id,
    revision: proposal.revision,
    outcome: 'finalized',
    discussion: rows,
    decision: publicDecision
  });
  return transition.target.handler === 'constitutional_panel'
    ? constitutionalReviewProposal(guild, saved)
    : saved;
}

async function constitutionalReviewProposal(guild, proposal) {
  const runtime = proposalRuntime(proposal);
  if (runtime?.state?.handler !== 'constitutional_panel') {
    throw new Error('この案件は現在、違憲審査の段階ではありません。');
  }
  const constitution = runtime.constitution;
  proposal = updateProposal(proposal.id, {
    stage_started_at: Date.now(),
    stage_ends_at: null,
    retry_after: null,
    last_error: null
  });
  await postProposalUpdate(guild, proposal, `${constitution.policy.judiciary.panelSeats}席の事前違憲審査を開始しました。`, { state: '違憲審査' });
  const panel = await runConstitutionalPanel({
    guildId: guild.id,
    targetType: proposal.kind,
    targetId: proposal.id,
    phase: 'pre',
    constitution,
    target: proposal.body
  });
  await postProposalUpdate(guild, proposal, '事前違憲審査の理由と憲法条文参照を公開します。', {
    files: [{
      attachment: Buffer.from(`${JSON.stringify({
        revision: proposal.revision,
        phase: 'pre',
        outputs: publicPanelOutputs(panel.outputs)
      }, null, 2)}\n`),
      name: '違憲審査.json'
    }]
  });
  const constitutional = panel.outputs.filter((output) => output.verdict === 'constitutional').length;
  const anyUnconstitutionalAmendment = proposal.kind === 'amendment'
    && panel.outputs.some((output) => output.verdict === 'unconstitutional');
  const passed = !anyUnconstitutionalAmendment
    && constitutional >= constitution.policy.judiciary.constitutionalVotesRequired;
  if (!passed) return reviseProposal(guild, proposal, panel.outputs);
  const transition = proposalTransition(proposal, 'passed');
  if (transition.target.handler === 'public_discussion') {
    const now = Date.now();
    const debateEndsAt = proposalStageEnd(transition, now);
    const debating = {
      ...proposal,
      status: transition.targetName,
      stage_started_at: now,
      stage_ends_at: debateEndsAt,
      retry_after: null,
      failure_count: 0,
      last_error: null
    };
    await postProposalUpdate(
      guild,
      debating,
      `合憲 ${constitutional}/${constitution.policy.judiciary.panelSeats}で審査を通過しました。受付時の手続に従う討議期限: <t:${Math.floor(debateEndsAt / 1000)}:F>`,
      { state: '討議' }
    );
    return updateProposal(proposal.id, debating);
  }
  if (transition.target.handler !== 'public_vote') {
    throw new Error('違憲審査通過後の段階を実行できません。');
  }
  await postProposalUpdate(
    guild,
    proposal,
    `合憲 ${constitutional}/${constitution.policy.judiciary.panelSeats}で最終案の審査を通過しました。本文は変更せず投票へ進みます。`,
    { state: '違憲審査' }
  );
  return openProposalVote(guild, proposal, transition);
}

async function openProposalVote(guild, proposal, suppliedTransition = null) {
  const { governance } = requireGovernance(guild.id);
  const runtime = proposalRuntime(proposal);
  const transition = suppliedTransition ?? (runtime?.state?.handler === 'public_discussion'
    ? proposalTransition(proposal, 'expired')
    : proposalTransition(proposal, 'passed'));
  if (transition.target.handler !== 'public_vote') throw new Error('投票開始へ遷移できない案件です。');
  const procedurePolicy = transition.constitution.policy;
  const voteRule = proposal.kind === 'amendment'
    ? transition.compiled.rules.votes.constitutionalAmendment
    : transition.compiled.rules.votes.law;
  const snapshot = await buildElectorateSnapshot(guild, proposal.id);
  const now = Date.now();
  const voteEndsAt = proposalStageEnd(transition, now);
  const eligible = snapshot.filter((row) => row.eligibleGeneral).length;
  const trusted = snapshot.filter((row) => row.trusted).length;
  const electorate = specialElectorateName(guild, governance);
  await postProposalUpdate(guild, proposal, [
    `投票を開始しました。締切: <t:${Math.floor(voteEndsAt / 1000)}:F>`,
    `投票範囲: ${proposal.vote_scope === 'all' ? '全員' : `${electorate}のみ`} / 有権者: ${eligible}人 / ${electorate}: ${trusted}人`,
    `定足数: ${Math.max(procedurePolicy.voting.minimumBallots, Math.ceil(eligible * procedurePolicy.voting.quorumRatio))}票`,
    `成立条件: 投票範囲内の賛否で${Math.round(voteRule.yesRatio * 100)}%${voteRule.comparison === 'gte' ? '以上' : 'を超える'}賛成${proposal.vote_scope === voteRule.trustedVeto.enabledForScope ? `、かつ${electorate}の有効票（賛否）中の反対が${Math.round(voteRule.trustedVeto.noRatio * 100)}%未満` : ''}`
  ].join('\n'), { state: '投票' });
  return updateProposal(proposal.id, {
    status: transition.targetName,
    stage_started_at: now,
    stage_ends_at: voteEndsAt,
    retry_after: null,
    failure_count: 0,
    last_error: null
  });
}

async function closeProposalVote(guild, proposal) {
  const { governance } = requireGovernance(guild.id);
  const runtime = proposalRuntime(proposal);
  if (runtime?.state?.handler !== 'public_vote') throw new Error('この案件は投票中ではありません。');
  const constitution = runtime.constitution;
  const summary = proposalVoteSummary(proposal.id);
  const result = closeGovernanceVote(
    { kind: proposal.kind, scope: proposal.vote_scope, ...summary },
    runtime.compiled.rules
  );
  if (!result.passed) {
    const electorate = specialElectorateName(guild, governance);
    const transition = proposalTransition(proposal, 'rejected');
    proposal = updateProposal(proposal.id, { status: transition.targetName, stage_ends_at: Date.now() });
    await postProposalUpdate(guild, proposal, `否決されました。賛成 ${summary.yes} / 反対 ${summary.no} / 棄権 ${summary.abstain} / 定足数 ${summary.yes + summary.no + summary.abstain}/${result.quorumNeeded} / ${electorate}の反対 ${summary.trustedNo}/${summary.trustedTotal}有効票 (棄権 ${summary.trustedAbstain} / 有権者 ${summary.trustedElectorate})`, { state: '否決' });
    return proposal;
  }
  if (proposal.kind === 'amendment') {
    const active = getActiveConstitution(guild.id);
    if (!proposal.target_hash || Number(proposal.target_id) !== Number(active?.id)
      || proposal.target_hash !== active?.content_hash) {
      const staleTarget = runtime.state.on.stale ?? runtime.state.on.rejected;
      proposal = updateProposal(proposal.id, { status: staleTarget, stage_ends_at: Date.now() });
      await postProposalUpdate(guild, proposal, '審議中に現行憲法が更新されたため、この案は成立させず差し戻しました。最新版を基礎に再提出してください。', { state: '廃案' });
      return proposal;
    }
    const next = enactConstitution({
      guildId: guild.id,
      content: proposal.body.content,
      policy: proposal.body.policy,
      proposalId: proposal.id,
      enactedBy: 'vote',
      targetConstitutionId: proposal.target_id,
      targetHash: proposal.target_hash
    });
    const transition = proposalTransition(proposal, 'passed');
    proposal = updateProposal(proposal.id, { status: transition.targetName, stage_ends_at: Date.now() });
    await postProposalUpdate(guild, proposal, `改憲が成立しました。憲法 v${next.version} が有効です。`, { state: '成立' });
    await syncStatuteBook(guild, getGovernanceGuild(guild.id)).catch((error) => {
      console.error(`Failed to publish constitution v${next.version} in statute book:`, error);
    });
    // 改憲で既存法との関係が変わり得るため、各現行法を自動的に事後審査へ送る。
    // 審査自体は通常どおり答弁記録期間とpolicy指定のpanelを経る。
    const systemReporter = { id: guild.client.user.id };
    for (const law of listLaws(guild.id)) {
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
    const currentTarget = getCurrentLawVersion(proposal.target_id);
    if (!currentTarget || currentTarget.content_hash !== proposal.target_hash) {
      const staleTarget = runtime.state.on.stale ?? runtime.state.on.rejected;
      proposal = updateProposal(proposal.id, { status: staleTarget, stage_ends_at: Date.now() });
      await postProposalUpdate(guild, proposal, '審議中に改正対象の法律が更新されたため、この案は成立させず差し戻しました。最新版を基礎に再提出してください。', { state: '廃案' });
      return proposal;
    }
  }
  const law = enactLaw({
    guildId: guild.id,
    proposalId: proposal.id,
    code: `LAW-${proposal.id}-R${proposal.revision}`,
    title: proposal.title,
    text: proposal.body.text,
    provisions: proposal.body.provisions,
    constitutionId: constitution.id,
    supersedesLawId: proposal.target_type === 'law' ? Number(proposal.target_id) : null,
    targetHash: proposal.target_hash,
    effectiveAt: Date.now()
  });
  const transition = proposalTransition(proposal, 'passed');
  proposal = updateProposal(proposal.id, { status: transition.targetName, stage_ends_at: Date.now() });
  await postProposalUpdate(guild, proposal, proposal.target_type === 'law'
    ? `可決・成立しました。「${law.title}」v${law.version} が有効です。旧版は履歴として保存します。`
    : `可決・成立しました。「${law.title}」はこの時点から有効です。`, { state: '成立' });
  await syncStatuteBook(guild, getGovernanceGuild(guild.id)).catch((error) => {
    console.error(`Failed to publish law ${law.id} in statute book:`, error);
  });
  return proposal;
}

export async function castAndPublishVote(interaction, proposalId, choice) {
  const { governance } = requireGovernance(interaction.guildId);
  if (!governanceActionAllowed(interaction.guildId, interaction.user.id, 'vote')) throw new Error('投票権が制裁により停止されています。');
  const result = castProposalVote(proposalId, interaction.user.id, choice);
  const proposal = result.proposal;
  const label = { yes: '賛成', no: '反対', abstain: '棄権' }[choice];
  const oldLabel = { yes: '賛成', no: '反対', abstain: '棄権' }[result.oldChoice] ?? result.oldChoice;
  await postProposalUpdate(interaction.guild, proposal, `${publicMemberLabel(interaction.user.id)} が ${label} に投票しました${oldLabel ? ` (変更前: ${oldLabel})` : ''}。`);
  writeAudit({ guildId: interaction.guildId, actorType: 'member', actorId: interaction.user.id, action: 'vote.cast', targetType: 'proposal', targetId: proposalId, detail: { oldChoice: result.oldChoice, choice, public: true } });
  return { proposal, governance, choice };
}

export async function fileCriminalCase(guild, reporter, input) {
  const { constitution, policy } = requireGovernance(guild.id);
  if (!governanceActionAllowed(guild.id, reporter.id, 'petition')) throw new Error('事件申立てが制裁により停止されています。');
  const law = getLaw(input.lawId);
  if (!law || law.guild_id !== guild.id || law.status !== 'active') throw new Error('有効な法律ではありません。');
  const offense = law.provisions.offenses?.find((entry) => entry.code === input.offenseCode);
  if (!offense) throw new Error('その法律に指定された犯罪構成要件がありません。');
  const evidenceRows = input.evidences ?? [input.evidence];
  if (!evidenceRows.length || evidenceRows.some((entry) => Number(entry.occurredAt) < law.effective_at)) {
    throw new Error('法律の施行前の行為には適用できません。');
  }
  if (!input.attemptReserved) requireGovernanceAiAttempt(reporter, input.eventId ?? `case:${reporter.id}:${Date.now()}`);
  let caseRecord = createCase({
    guildId: guild.id,
    reporterId: reporter.id,
    accusedId: input.accused.id,
    lawId: law.id,
    offenseCode: offense.code,
    summary: input.summary,
    status: summaryProcedure(policy) ? 'summary_review' : 'filing',
    defenseUntil: null,
    allegedAt: evidenceRows.at(-1).occurredAt,
    constitutionId: constitution.id,
    procedureVersion: summaryProcedure(policy) ? 2 : 1,
    summaryEventKey: input.summaryEventKey ?? null,
    reporterType: input.official ? 'ai' : 'member'
  });
  for (const evidence of evidenceRows) {
    addCaseEvidence({ caseId: caseRecord.id, submittedBy: reporter.id, ...evidence });
  }
  try {
    return summaryProcedure(policy)
      ? await finishSummaryReview(guild, caseRecord)
      : await finishCaseFiling(guild, caseRecord);
  } catch (error) {
    updateCase(caseRecord.id, retryPatch(getCase(caseRecord.id), error));
    console.error(`Initial court setup failed for case ${caseRecord.id}:`, error);
    throw acceptedWorkflowError(
      '申立てを受理しました。準備ができると裁判所に表示されます。',
      'case',
      caseRecord.id
    );
  }
}

function profileForSanction(law, sanction, policy) {
  if (sanction.type !== 'restriction') return null;
  const definition = getSanctionDefinition(law.id, sanction.definitionCode);
  if (!definition || !validateRestrictionDefinition(definition.profile, policy)) {
    throw new Error('成立法に有効な制裁定義がありません。');
  }
  return definition.profile;
}

async function notifySummarySanction(guild, caseRecord, sanction) {
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
    components: reviewRequestButtons(guild.id, sanction.id),
    allowedMentions: { parse: [] }
  }).then(() => true).catch(() => false);
  updateSanction(sanction.id, { notice_delivered: delivered ? 1 : 0 });
  return delivered;
}

async function continueSummarySanction(guild, caseRecord, sanction, procedure) {
  const trialFirst = procedure.trialFirstSanctions.includes(sanction.type);
  if (trialFirst) {
    if (caseRecord.status === 'defense' || caseRecord.public_thread_id) return caseRecord;
    let current = updateCase(caseRecord.id, { status: 'filing', review_count: 1 });
    current = await finishCaseFiling(guild, current);
    await postCourtUpdate(guild, current, `${sanction.type}は裁判前に実行しません。本人の回答を待ち、<t:${Math.floor(current.defense_until / 1000)}:F>までに判定します。`, { state: '答弁' });
    return current;
  }
  if (sanction.status === 'reviewable') {
    return updateCase(caseRecord.id, sanction.type === 'warning'
      ? { status: 'final', finalized_at: caseRecord.finalized_at ?? Date.now() }
      : { status: 'summary_active' });
  }
  if (sanction.required_approvals > 0) {
    if (caseRecord.status === 'approval') return caseRecord;
    await beginCaseApproval(
      guild,
      caseRecord,
      sanction,
      `このtimeoutは即時執行上限を超えるため、執行には特別有権者${sanction.required_approvals}人の公開承認が必要です。`
    );
    return getCase(caseRecord.id);
  }
  if (caseRecord.status !== 'execution') {
    if (!sanction.notice_delivered) await notifySummarySanction(guild, caseRecord, sanction);
    queueExecution(caseRecord, getSanction(sanction.id));
  }
  await processGovernanceOutbox(guild.client);
  return getCase(caseRecord.id);
}

export async function ensurePublicCaseRecord(guild, caseRecord) {
  if (caseRecord.public_thread_id) return caseRecord;
  const { governance } = requireGovernance(guild.id);
  let current = caseRecord;
  const thread = await createCourtCaseThread(guild, governance, current, {
    onPartial: (patch) => { current = updateCase(current.id, patch); }
  });
  if (!current.public_thread_id) current = updateCase(current.id, { public_thread_id: thread.publicThreadId });
  await ensureEvidenceDisclosures(guild, current);
  return current;
}

async function finishSummaryReview(guild, caseRecord) {
  requireGovernance(guild.id);
  const constitution = constitutionForCase(caseRecord);
  const policy = constitution?.policy;
  const procedure = summaryProcedure(policy);
  if (!procedure) return finishCaseFiling(guild, caseRecord);
  let current = getCase(caseRecord.id);
  const law = getLaw(current.law_id);
  if (!law || law.guild_id !== guild.id || law.status !== 'active') throw new Error('適用法が現在有効ではありません。');
  const offense = law.provisions.offenses?.find((entry) => entry.code === current.offense_code);
  if (!offense) throw new Error('犯罪構成要件が法律にありません。');
  const existingSanction = getCaseSanction(current.id);
  if (existingSanction) return continueSummarySanction(guild, current, existingSanction, procedure);
  const evidence = listCaseEvidence(current.id);
  const panel = await runJudicialPanel({
    guildId: guild.id,
    caseRecord: current,
    law,
    offense,
    evidence,
    submissions: [],
    policy,
    phase: 'summary'
  });
  current = updateCase(current.id, {
    panel_id: panel.panelId,
    verdict: { phase: 'summary', verdict: panel.verdict, sanction: panel.sanction, panelId: panel.panelId }
  });
  const summaryAudit = [
    `対象: ${publicMemberLabel(current.accused_id, '動作確認用アカウント')}`,
    `申立内容: ${current.summary}`,
    ...publicLawDetails(law, current.offense_code),
    `有効な違反認定: ${panel.outputs.filter((entry) => entry.verdict === 'responsible').length}/${procedure.panelSeats}`,
    `無効・失敗席: ${panel.failedSeats}`,
    '',
    '```json',
    JSON.stringify({
      outputs: publicPanelOutputs(panel.outputs, new Map(evidence.map((entry, index) => [entry.id, index + 1])))
    }, null, 2),
    '```'
  ].join('\n');
  if (panel.verdict !== 'responsible' || !panel.sanction) {
    current = updateCase(current.id, { status: 'acquitted', finalized_at: Date.now() });
    current = await ensurePublicCaseRecord(guild, current);
    await postCourtUpdate(guild, current, '成立法の必要票に達しなかったため、処分せず終了しました。', {
      state: '責任なし',
      files: [{ attachment: Buffer.from(summaryAudit), name: '判断詳細.md' }]
    });
    return current;
  }
  const profile = profileForSanction(law, panel.sanction, policy);
  const trialFirst = procedure.trialFirstSanctions.includes(panel.sanction.type);
  current = await ensurePublicCaseRecord(guild, current);
  await postCourtUpdate(guild, current, `成立法に照らした${procedure.panelSeats}席中${procedure.votesRequired}席以上の判断により、${panel.sanction.type}を選びました。`, {
    state: '判断中',
    files: [{ attachment: Buffer.from(summaryAudit), name: '判断詳細.md' }]
  });
  const sanction = createSanction({
    caseId: current.id,
    guildId: guild.id,
    userId: current.accused_id,
    type: panel.sanction.type,
    durationSeconds: panel.sanction.durationSeconds,
    definitionCode: panel.sanction.definitionCode,
    profile,
    status: trialFirst ? 'proposed' : 'queued',
    requiredApprovals: requiredApprovals(panel.sanction, policy),
    appealable: isAppealable(panel.sanction, policy),
    restrictionStartedAt: trialFirst ? null : Date.now()
  });
  return continueSummarySanction(guild, current, sanction, procedure);
}

async function finishCaseFiling(guild, caseRecord) {
  const { governance } = requireGovernance(guild.id);
  const constitution = constitutionForCase(caseRecord);
  const policy = constitution.policy;
  const procedure = summaryProcedure(policy);
  let current = getCase(caseRecord.id);
  const thread = await createCourtCaseThread(guild, governance, current, {
    onPartial: (patch) => { current = updateCase(current.id, patch); }
  });
  const defenseUntil = Date.now() + (procedure?.trialMilliseconds ?? policy.judiciary.defenseMilliseconds);
  current = updateCase(current.id, {
    status: 'defense',
    public_thread_id: thread.publicThreadId,
    defense_until: defenseUntil,
    decision_due_at: defenseUntil,
    retry_after: null,
    failure_count: 0,
    last_error: null
  });
  await ensureEvidenceDisclosures(guild, current);
  await postCourtUpdate(guild, current, `答弁期限: <t:${Math.floor(defenseUntil / 1000)}:F>`, { state: '答弁' });
  await notifyCaseParty(guild, current, 'defense', defenseUntil);
  if (!procedure) await applyInterimProtectionFromLogs(guild, current);
  return current;
}

export async function applyInterimProtectionFromLogs(guild, caseRecord, now = Date.now()) {
  const { governance } = requireGovernance(guild.id);
  const current = getCase(caseRecord.id);
  if (!current || current.guild_id !== guild.id || current.kind !== 'criminal' || current.status !== 'defense') return null;
  const existing = getCaseInterimProtection(current.id);
  if (existing) return existing;
  const law = getLaw(current.law_id);
  if (!law || law.guild_id !== guild.id || law.status !== 'active') return null;
  const offense = law.provisions.offenses?.find((entry) => entry.code === current.offense_code);
  const definition = offense?.interimProtection;
  if (!validateInterimProtectionDefinition(definition)) return null;
  if (governance.enforcement_mode === 'live') {
    const member = guild.members?.fetch
      ? await guild.members.fetch(current.accused_id).catch(() => null)
      : null;
    if (!member || member.id === guild.ownerId || member.permissions?.has?.(PermissionFlagsBits.Administrator)) return null;
  }

  const evidence = listCaseEvidence(current.id).find((entry) => (
    entry.author_id === current.accused_id && entry.message_id && entry.channel_id && entry.occurred_at
  ));
  if (!evidence) return null;
  const trigger = definition.trigger;
  const occurredAt = Number(evidence.occurred_at);
  const windowMs = trigger.windowSeconds * 1000;
  // 過去ログだけで現在の発言権を奪わない。申立て時点でも同じburst window内にある場合だけ評価する。
  if (occurredAt > now + 30_000 || now - occurredAt > windowMs) return null;
  const messages = recentUserActivity(
    guild.id,
    current.accused_id,
    evidence.channel_id,
    occurredAt - windowMs,
    occurredAt,
    100
  );
  if (!messages.some((message) => message.message_id === evidence.message_id)
    || messages.length < trigger.minimumMessages) return null;

  const status = governance.enforcement_mode === 'live' ? 'active' : 'simulated';
  const protection = createInterimProtection({
    caseId: current.id,
    guildId: guild.id,
    userId: current.accused_id,
    lawId: law.id,
    offenseCode: offense.code,
    triggerType: trigger.type,
    minimumEvents: trigger.minimumMessages,
    observedEvents: messages.length,
    windowSeconds: trigger.windowSeconds,
    durationSeconds: definition.durationSeconds,
    evidenceMessageId: evidence.message_id,
    evidenceChannelId: evidence.channel_id,
    startedAt: now,
    endsAt: now + definition.durationSeconds * 1000,
    status
  });
  writeAudit({
    guildId: guild.id,
    actorType: 'system',
    action: status === 'active' ? 'interim_protection.started' : 'interim_protection.simulated',
    targetType: 'interim_protection',
    targetId: protection.id,
    detail: {
      caseId: current.id,
      lawId: law.id,
      offenseCode: offense.code,
      evidenceMessageId: evidence.message_id,
      observedEvents: messages.length,
      minimumEvents: trigger.minimumMessages,
      windowSeconds: trigger.windowSeconds,
      durationSeconds: definition.durationSeconds
    }
  });
  await postCourtUpdate(guild, current, status === 'active'
    ? `一時保全を開始しました。直近${trigger.windowSeconds}秒の公開ログ${messages.length}件を確認し、<t:${Math.floor(protection.ends_at / 1000)}:T>まで被申立人の投稿先をこの事件に限ります。これは判決や刑罰ではなく、自動終了します。`
    : `一時保全の条件をshadowで確認しました。直近${trigger.windowSeconds}秒の公開ログ${messages.length}件が基準${trigger.minimumMessages}件を満たしましたが、実際の発言制限は行っていません。`);
  return protection;
}

export async function addEvidenceToCase(guild, member, caseId, evidence) {
  const caseRecord = getCase(caseId);
  if (!caseRecord || caseRecord.guild_id !== guild.id) throw new Error('事件が見つかりません。');
  if (!['defense', 'appeal'].includes(caseRecord.status)) throw new Error('証拠受付中ではありません。');
  if (![caseRecord.reporter_id, caseRecord.accused_id].includes(member.id)) throw new Error('この事件の当事者ではありません。');
  const defenseEvidenceOwner = caseRecord.accused_id ?? caseRecord.reporter_id;
  if (caseRecord.procedure_version === 2 && member.id !== defenseEvidenceOwner) {
    throw new Error('迅速裁判の取締り側証拠は開始時点で固定されています。新しい行為は別事件として申し立ててください。');
  }
  if (listCaseEvidence(caseId).length >= CASE_EVIDENCE_LIMIT) {
    throw new Error(`証拠は事件ごとに${CASE_EVIDENCE_LIMIT}件までです。関連する内容を1件の提出にまとめてください。`);
  }
  const id = addCaseEvidence({ caseId, submittedBy: member.id, ...evidence });
  await ensureEvidenceDisclosures(guild, getCase(caseId));
  return id;
}

function evidenceDisclosure(entry, ordinal) {
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

async function ensureEvidenceDisclosures(guild, caseRecord) {
  if (!caseRecord?.public_thread_id) return;
  const evidence = listCaseEvidence(caseRecord.id);
  for (const [index, entry] of evidence.entries()) {
    if (entry.disclosed_at) continue;
    const withGuild = { ...entry, guild_id: guild.id };
    await postCourtRecord(guild, caseRecord, evidenceDisclosure(withGuild, index + 1));
    markEvidenceDisclosed(entry.id);
  }
}

async function publishDecisionRecord(guild, caseRecord, phase, panel) {
  const evidence = listCaseEvidence(caseRecord.id);
  const evidenceOrder = new Map(evidence.map((entry, index) => [entry.id, index + 1]));
  const law = getLaw(caseRecord.law_id);
  const phaseLabel = phase === 'appeal' ? '上訴審' : '第一審';
  const publicLines = panel.outputs.map((output, index) => [
    `席 ${index + 1}: ${{ responsible: '責任あり', not_responsible: '責任なし', insufficient: '立証不十分' }[output.verdict] ?? output.verdict}`,
    `採用証拠: ${(output.evidenceIds ?? []).map((id) => `証拠 ${evidenceOrder.get(id) ?? '?'}`).join('、') || 'なし'}`,
    `処分: ${output.sanction ? `${output.sanction.type}${output.sanction.durationSeconds ? ` ${output.sanction.durationSeconds}秒` : ''}` : '-'}`
  ].join(' / '));
  await postCourtUpdate(guild, caseRecord, [
    `判決記録（${phaseLabel}）`,
    ...publicLawDetails(law, caseRecord.offense_code),
    ...publicLines
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

export async function fileConstitutionalChallenge(guild, reporter, input) {
  const { constitution, policy } = requireGovernance(guild.id);
  let target;
  if (input.targetType === 'law') target = getLaw(input.targetId);
  else if (input.targetType === 'case') target = getCase(input.targetId);
  else if (input.targetType === 'sanction') target = getSanction(input.targetId);
  else if (input.targetType === 'administrative_act') target = getAdministrativeAct(input.targetId);
  if (!target || target.guild_id !== guild.id) throw new Error('審査対象が見つかりません。');
  const existing = findOpenConstitutionalCase(guild.id, input.targetType, input.targetId);
  if (existing) throw new Error('同じ対象の違憲審査が進行中です。裁判所で確認してください。');
  if (!input.system && !input.attemptReserved) {
    const attempt = reserveAgentAttempt(
      guild.id,
      reporter.id,
      false,
      policy.judiciary.constitutionalChallengesPerMemberPerDay,
      DAY_MS,
      'constitutional_challenge'
    );
    if (!attempt.ok) throw new Error(`違憲審査申立ての24時間枠に達しました (${attempt.used}/${attempt.limit})。`);
  }
  let caseRecord = createCase({
    guildId: guild.id,
    kind: 'constitutional',
    reporterId: reporter.id,
    challengedType: input.targetType,
    challengedId: String(input.targetId),
    summary: input.reason,
    status: 'filing',
    defenseUntil: null,
    constitutionId: constitution.id,
    procedureVersion: summaryProcedure(policy) ? 2 : 1,
    reporterType: input.official ? 'ai' : 'member'
  });
  addCaseEvidence({ caseId: caseRecord.id, submittedBy: reporter.id, content: input.reason, occurredAt: Date.now() });
  try {
    return await finishCaseFiling(guild, caseRecord);
  } catch (error) {
    updateCase(caseRecord.id, retryPatch(getCase(caseRecord.id), error));
    console.error(`Initial court setup failed for constitutional case ${caseRecord.id}:`, error);
    throw acceptedWorkflowError(
      '違憲審査を受理しました。準備ができると裁判所に表示されます。',
      'case',
      caseRecord.id
    );
  }
}

function courtSubmissionText(message) {
  return [
    message.content,
    ...[...(message.attachments?.values?.() ?? message.attachments ?? [])]
      .map((attachment) => `[添付] ${attachment.name} ${attachment.url}`)
  ].filter(Boolean).join('\n') || '(本文なし)';
}

async function courtMessageContext(message) {
  if (!message?.guildId || message.author?.bot) return { caseRecord: null, blocked: false };
  const governance = getGovernanceGuild(message.guildId);
  let member = message.member ?? null;
  if (!member && message.guild?.members?.fetch) {
    member = await message.guild.members.fetch(message.author.id).catch(() => null);
  }
  const isAppealRestricted = Boolean(governance?.appeal_role_id
    && member?.roles?.cache?.has(governance.appeal_role_id));
  const caseRecord = message.channel?.isThread?.() ? getCaseByPublicThread(message.channelId) : null;
  if (isAppealRestricted
    && (!caseRecord || !(caseRecord.status === 'appeal' && caseRecord.accused_id === message.author.id))) {
    const deleted = await message.delete().then(() => true).catch(() => false);
    writeAudit({
      guildId: message.guildId,
      actorType: 'system',
      action: deleted ? 'appeal.message_blocked' : 'appeal.message_block_failed',
      targetType: 'member',
      targetId: message.author.id,
      detail: { messageId: message.id, channelId: message.channelId }
    });
    await message.author.send(`${message.guild?.name ?? 'このコミュニティ'}では、上訴中は自分の上訴事件以外へ投稿できません。`).catch(() => {});
    return { caseRecord, blocked: true };
  }
  return { caseRecord, blocked: false };
}

export async function recordCourtSubmission(message) {
  const { caseRecord, blocked } = await courtMessageContext(message);
  if (blocked) return 'blocked';
  if (!caseRecord) return false;
  const isParty = [caseRecord.reporter_id, caseRecord.accused_id].filter(Boolean).includes(message.author.id);
  if (caseRecord.procedure_version === 2) {
    const deleted = await message.delete().then(() => true).catch(() => false);
    writeAudit({
      guildId: message.guildId,
      actorType: 'system',
      action: 'court.direct_message_blocked',
      targetType: 'case',
      targetId: caseRecord.id,
      detail: { userId: message.author.id, messageId: message.id, isParty, deleted }
    });
    await message.author.send(isParty
      ? `${message.guild.name}の裁判回答は事件投稿の「回答を書く」「証拠を出す」ボタンから提出してください。`
      : `${message.guild.name}の公開裁判は閲覧できますが、投稿できるのは当事者だけです。`).catch(() => {});
    return 'blocked';
  }
  if (!['defense', 'appeal'].includes(caseRecord.status) || !isParty) return false;
  const phaseCount = listCurrentCaseSubmissions(caseRecord.id)
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

export async function recordCourtSubmissionEdit(message) {
  const { caseRecord, blocked } = await courtMessageContext(message);
  if (blocked) return 'blocked';
  if (!caseRecord || !message.id) return false;
  const isParty = [caseRecord.reporter_id, caseRecord.accused_id].filter(Boolean).includes(message.author.id);
  if (!isParty) return false;
  const existing = listCurrentCaseSubmissions(caseRecord.id)
    .find((entry) => entry.source_message_id === message.id && entry.author_id === message.author.id);
  if (!existing) return false;
  if (!['defense', 'appeal'].includes(caseRecord.status) || existing.kind !== caseRecord.status) {
    await message.channel.send({
      content: `${publicMemberLabel(message.author.id)} が締切後に正式主張を編集しました。この編集は判決資料へ反映しません。`,
      allowedMentions: { parse: [] }
    }).catch(() => {});
    return false;
  }
  const changed = replaceCaseSubmission(
    caseRecord.id,
    message.author.id,
    caseRecord.status,
    courtSubmissionText(message).slice(0, 8000),
    message.id
  );
  if (!changed || changed.unchanged) return false;
  await message.channel.send({
    content: [
      `${publicMemberLabel(message.author.id)} が正式主張を編集しました。`,
      '変更前の内容も監査履歴に残し、判決には変更後の正本だけを使用します。'
    ].join('\n'),
    allowedMentions: { parse: [] }
  }).catch(() => {});
  return true;
}

async function beginAppealWindow(guild, caseRecord, sanction) {
  const policy = constitutionForCase(caseRecord).policy;
  const procedure = summaryProcedure(policy);
  const now = Date.now();
  sanction = updateSanction(sanction.id, {
    status: 'pending_appeal',
    appeal_deadline: now + policy.judiciary.appealMilliseconds,
    restriction_started_at: procedure ? sanction.restriction_started_at : null
  });
  caseRecord = updateCase(caseRecord.id, { status: 'appeal_window' });
  await postCourtUpdate(guild, caseRecord, `この刑は上訴対象です。期限: <t:${Math.floor(sanction.appeal_deadline / 1000)}:F>。上訴しなければ自動確定します。`, { state: '上訴' });
  await notifyCaseParty(guild, caseRecord, 'appeal', sanction.appeal_deadline);
}

function queueExecution(caseRecord, sanction) {
  updateSanction(sanction.id, { status: 'queued' });
  updateCase(caseRecord.id, { status: 'execution' });
  enqueueAction({
    guildId: sanction.guild_id,
    actionType: 'sanction_execute',
    targetId: sanction.id,
    payload: { sanctionId: sanction.id },
    idempotencyKey: `sanction-execute:${sanction.execution_key}`
  });
}

async function beginCaseApproval(guild, caseRecord, sanction, text) {
  const governance = getGovernanceGuild(guild.id);
  const electorate = specialElectorateName(guild, governance);
  const trustedMembers = governance?.trusted_role_id
    ? await guild.members.fetch().then((members) => [...members.values()].filter((member) => !member.user.bot
      && member.roles.cache.has(governance.trusted_role_id)
      && ![caseRecord.accused_id, caseRecord.reporter_id].includes(member.id)))
    : [];
  if (trustedMembers.length < sanction.required_approvals) {
    updateSanction(sanction.id, { status: 'unavailable' });
    updateCase(caseRecord.id, { status: 'unenforceable', finalized_at: Date.now() });
    await postCourtUpdate(guild, getCase(caseRecord.id), `判決は記録しましたが、独立した「${electorate}」の承認者が ${trustedMembers.length}/${sanction.required_approvals} 人しかいないため、この刑は執行不能として終了します。`, { state: '確定' });
    return false;
  }
  updateSanction(sanction.id, { status: 'pending_approval' });
  updateCase(caseRecord.id, { status: 'approval' });
  await postCourtUpdate(guild, getCase(caseRecord.id), text, { state: '承認待ち' });
  return true;
}

async function adjudicateCriminalCase(guild, caseRecord, phase = 'initial') {
  const governance = getGovernanceGuild(guild.id);
  const constitution = constitutionForCase(caseRecord);
  const policy = constitution.policy;
  const procedure = summaryProcedure(policy);
  const currentLaw = getLaw(caseRecord.law_id);
  if (!currentLaw || currentLaw.status !== 'active') throw new Error('適用法が現在有効ではありません。');
  const evidence = listCaseEvidence(caseRecord.id);
  const occurredAt = Number(caseRecord.alleged_at);
  if (!Number.isFinite(occurredAt) || occurredAt < currentLaw.effective_at) throw new Error('行為時に有効な法律を確認できません。');
  const offense = currentLaw.provisions.offenses?.find((entry) => entry.code === caseRecord.offense_code);
  if (!offense) throw new Error('犯罪構成要件が法律にありません。');
  const appeal = phase === 'appeal' ? getAppeal(caseRecord.id) : null;
  const originalSanction = getCaseSanction(caseRecord.id);
  const panelCase = {
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
  const panel = await runJudicialPanel({
    guildId: guild.id,
    caseRecord: panelCase,
    law: currentLaw,
    offense,
    evidence,
    // 編集前の主張は監査履歴に残すが、判決入力には各Discord投稿の最新正本だけを使う。
    submissions: listCurrentCaseSubmissions(caseRecord.id),
    policy,
    phase
  });
  caseRecord = updateCase(caseRecord.id, {
    panel_id: panel.panelId,
    verdict: { phase, verdict: panel.verdict, sanction: panel.sanction, panelId: panel.panelId }
  });
  await publishDecisionRecord(guild, caseRecord, phase, panel);
  if (panel.verdict !== 'responsible' || !panel.sanction) {
    updateCase(caseRecord.id, { status: phase === 'appeal' ? 'overturned' : 'acquitted', finalized_at: Date.now() });
    const existing = getCaseSanction(caseRecord.id);
    if (existing) {
      updateSanction(existing.id, { status: 'reversed', reversed_at: Date.now() });
      enqueueAction({ guildId: guild.id, actionType: 'sanction_reverse', targetId: existing.id, payload: { sanctionId: existing.id }, idempotencyKey: `sanction-reverse:${existing.id}` });
    }
    await postCourtUpdate(guild, getCase(caseRecord.id), phase === 'appeal'
      ? '上訴審で原判決を取り消しました。'
      : `構成要件の立証が必要票 ${policy.judiciary.guiltyVotesRequired}/${policy.judiciary.panelSeats} に達せず、責任なしで確定しました。`, { state: '取消' });
    return;
  }

  if (procedure && phase === 'trial') {
    const currentSanction = getCaseSanction(caseRecord.id);
    const changed = panel.sanction.type !== currentSanction.type
      || Number(panel.sanction.durationSeconds ?? 0) !== Number(currentSanction.duration_seconds ?? 0)
      || String(panel.sanction.definitionCode ?? '') !== String(currentSanction.definition_code ?? '');
    const profile = profileForSanction(currentLaw, panel.sanction, policy);
    if (currentSanction.type === 'restriction' && changed) deactivateRestrictionForSanction(currentSanction.id);
    let sanction = updateSanction(currentSanction.id, {
      type: panel.sanction.type,
      duration_seconds: panel.sanction.durationSeconds ?? null,
      definition_code: panel.sanction.definitionCode ?? null,
      profile,
      required_approvals: requiredApprovals(panel.sanction, policy),
      appealable: isAppealable(panel.sanction, policy) ? 1 : 0,
      status: 'review_upheld'
    });
    if (sanction.appealable) {
      await beginAppealWindow(guild, caseRecord, sanction);
      await postCourtUpdate(guild, getCase(caseRecord.id), changed
        ? '裁判で処分を軽減しました。重大処分のため、さらに一度だけ上訴できます。'
        : '裁判で処分を維持しました。重大処分のため、さらに一度だけ上訴できます。', { state: '上訴' });
      return;
    }
    if (requiredApprovals(panel.sanction, policy) > 0) {
      await beginCaseApproval(guild, caseRecord, sanction, `${panel.sanction.type}を認める判決です。独立した特別有権者${sanction.required_approvals}人の公開承認後にだけ執行します。`);
      return;
    }
    queueExecution(caseRecord, sanction);
    await postCourtUpdate(guild, getCase(caseRecord.id), changed ? '裁判で処分を軽減し、残りの処分へ進みます。' : '裁判で処分を維持しました。', { state: '確定' });
    return;
  }

  let profile = null;
  if (panel.sanction.type === 'restriction') {
    const definition = getSanctionDefinition(currentLaw.id, panel.sanction.definitionCode);
    if (!definition || !validateRestrictionDefinition(definition.profile, policy)) throw new Error('成立法に有効な制裁定義がありません。');
    profile = definition.profile;
  }
  const approvals = requiredApprovals(panel.sanction, policy);
  const appealable = isAppealable(panel.sanction, policy);
  let sanction = getCaseSanction(caseRecord.id);
  if (sanction) {
    sanction = updateSanction(sanction.id, {
      type: panel.sanction.type,
      duration_seconds: panel.sanction.durationSeconds ?? null,
      definition_code: panel.sanction.definitionCode ?? null,
      profile,
      required_approvals: approvals,
      appealable: appealable ? 1 : 0,
      status: approvals > 0 && phase !== 'appeal' ? 'pending_approval' : 'queued'
    });
  } else {
    sanction = createSanction({
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
    });
  }
  if (phase === 'appeal') {
    updateAppeal(caseRecord.id, { status: 'upheld', decided_at: Date.now() });
    if (procedure && requiredApprovals(panel.sanction, policy) > 0) {
      sanction = updateSanction(sanction.id, {
        status: 'pending_approval',
        required_approvals: requiredApprovals(panel.sanction, policy)
      });
      await beginCaseApproval(guild, caseRecord, sanction, `上訴審で原判決を維持しました。${sanction.required_approvals}人の公開承認後にだけ執行します。`);
    } else {
      queueExecution(caseRecord, sanction);
      await postCourtUpdate(guild, getCase(caseRecord.id), '上訴審で原判決を維持し、残りの処分へ進みます。', { state: '確定' });
    }
    return;
  }
  if (approvals > 0) {
    const electorate = specialElectorateName(guild, governance);
    const trustedMembers = governance.trusted_role_id
      ? await guild.members.fetch().then((members) => [...members.values()].filter((member) => !member.user.bot
        && member.roles.cache.has(governance.trusted_role_id)
        && ![caseRecord.accused_id, caseRecord.reporter_id].includes(member.id)))
      : [];
    if (trustedMembers.length < approvals) {
      updateSanction(sanction.id, { status: 'unavailable' });
      updateCase(caseRecord.id, { status: 'unenforceable', finalized_at: Date.now() });
      await postCourtUpdate(guild, getCase(caseRecord.id), `判決は記録しましたが、独立した「${electorate}」の承認者が ${trustedMembers.length}/${approvals} 人しかいないため、この刑は執行不能として終了します。`, { state: '確定' });
      return;
    }
    updateCase(caseRecord.id, { status: 'approval' });
    await postCourtUpdate(guild, getCase(caseRecord.id), `責任あり ${policy.judiciary.guiltyVotesRequired}/${policy.judiciary.panelSeats}以上。刑: ${panel.sanction.type}${panel.sanction.durationSeconds ? ` ${panel.sanction.durationSeconds}秒` : ''}。「${electorate}」${approvals}人の執行承認が必要です。`, { state: '承認待ち' });
  } else if (appealable) {
    await beginAppealWindow(guild, caseRecord, sanction);
  } else {
    queueExecution(caseRecord, sanction);
  }
}

async function adjudicateConstitutionalCase(guild, caseRecord) {
  const constitution = constitutionForCase(caseRecord);
  let target;
  if (caseRecord.challenged_type === 'law') target = getLaw(caseRecord.challenged_id);
  else if (caseRecord.challenged_type === 'case') target = getCase(caseRecord.challenged_id);
  else if (caseRecord.challenged_type === 'sanction') target = getSanction(caseRecord.challenged_id);
  else if (caseRecord.challenged_type === 'administrative_act') target = getAdministrativeAct(caseRecord.challenged_id);
  if (!target) throw new Error('違憲審査対象がありません。');
  const reviewTarget = buildConstitutionalReviewTarget(caseRecord.challenged_type, target);
  let panel = await runConstitutionalPanel({
    guildId: guild.id,
    targetType: caseRecord.challenged_type,
    targetId: caseRecord.challenged_id,
    phase: 'post',
    constitution,
    target: reviewTarget
  });
  let constitutional = panel.outputs.filter((output) => output.verdict === 'constitutional').length;
  let unconstitutional = panel.outputs.filter((output) => output.verdict === 'unconstitutional').length;
  if (constitutional < constitution.policy.judiciary.constitutionalVotesRequired
    && unconstitutional < constitution.policy.judiciary.unconstitutionalVotesRequired) {
    panel = await runConstitutionalPanel({
      guildId: guild.id,
      targetType: caseRecord.challenged_type,
      targetId: caseRecord.challenged_id,
      phase: 'post_retry',
      constitution,
      target: reviewTarget
    });
    constitutional = panel.outputs.filter((output) => output.verdict === 'constitutional').length;
    unconstitutional = panel.outputs.filter((output) => output.verdict === 'unconstitutional').length;
  }
  await postCourtRecord(guild, caseRecord, '違憲審査パネルの理由と憲法条文参照を添付します。', {
    files: [{
      attachment: Buffer.from(`${JSON.stringify({
        target: ({ law: '法律', case: '判決', sanction: '処分', administrative_act: '行政行為' })[caseRecord.challenged_type] ?? '統治行為',
        outputs: publicPanelOutputs(panel.outputs)
      }, null, 2)}\n`),
      name: '違憲審査記録.json'
    }]
  });
  if (constitutional >= constitution.policy.judiciary.constitutionalVotesRequired) {
    updateCase(caseRecord.id, { status: 'final', verdict: { verdict: 'constitutional', panelId: panel.panelId }, finalized_at: Date.now() });
    await postCourtUpdate(guild, getCase(caseRecord.id), `合憲 ${constitutional}/${constitution.policy.judiciary.panelSeats}で対象を維持します。`, { state: '確定' });
    return;
  }
  const uncertain = unconstitutional < constitution.policy.judiciary.unconstitutionalVotesRequired;
  if (caseRecord.challenged_type === 'law') {
    updateLaw(target.id, { status: uncertain ? 'suspended' : 'unconstitutional', ended_at: Date.now() });
    for (const pendingCase of listOpenCasesForLaw(target.id)) {
      updateCase(pendingCase.id, {
        status: 'dismissed',
        verdict: { verdict: 'dismissed', reason: uncertain ? 'law_suspended' : 'law_unconstitutional' },
        finalized_at: Date.now()
      });
      await postCourtUpdate(guild, getCase(pendingCase.id), '適用法が違憲審査で維持されなかったため、この事件は処罰なしで終了しました。', { state: '取消' });
    }
    for (const sanction of listSanctionsForLaw(target.id)) {
      updateSanction(sanction.id, { status: 'reversing', reversed_at: Date.now() });
      enqueueAction({
        guildId: guild.id,
        actionType: 'sanction_reverse',
        targetId: sanction.id,
        payload: { sanctionId: sanction.id },
        idempotencyKey: `sanction-reverse:${sanction.id}`
      });
    }
  } else if (caseRecord.challenged_type === 'sanction') {
    updateSanction(target.id, { status: 'reversed', reversed_at: Date.now() });
    enqueueAction({ guildId: guild.id, actionType: 'sanction_reverse', targetId: target.id, payload: { sanctionId: target.id }, idempotencyKey: `sanction-reverse:${target.id}` });
  } else if (caseRecord.challenged_type === 'case') {
    const sanction = getCaseSanction(target.id);
    updateCase(target.id, { status: 'overturned', finalized_at: Date.now() });
    if (sanction) enqueueAction({ guildId: guild.id, actionType: 'sanction_reverse', targetId: sanction.id, payload: { sanctionId: sanction.id }, idempotencyKey: `sanction-reverse:${sanction.id}` });
  } else if (caseRecord.challenged_type === 'administrative_act') {
    await reverseAdministrativeAct(guild, target);
  }
  updateCase(caseRecord.id, { status: uncertain ? 'constitutional_uncertain' : 'final', verdict: { verdict: uncertain ? 'uncertain' : 'unconstitutional', panelId: panel.panelId }, finalized_at: Date.now() });
  await postCourtUpdate(guild, getCase(caseRecord.id), uncertain
    ? '再審査後も合憲必要票に達しなかったため、対象の執行を停止しました。'
    : `違憲 ${unconstitutional}/${constitution.policy.judiciary.panelSeats}で対象を取り消しました。`, { state: '取消' });
  if (caseRecord.challenged_type === 'law') {
    await syncStatuteBook(guild, getGovernanceGuild(guild.id)).catch((error) => {
      console.error(`Failed to update law ${target.id} in statute book:`, error);
    });
  }
}

function buildConstitutionalReviewTarget(type, target) {
  if (type === 'case') {
    return {
      case: target,
      law: target.law_id ? getLaw(target.law_id) : null,
      evidence: listCaseEvidence(target.id).map((entry) => ({
        id: entry.id,
        authorId: entry.author_id,
        occurredAt: entry.occurred_at,
        contentHash: entry.content_hash,
        content: entry.content
      })),
      submissions: listCaseSubmissions(target.id),
      decisions: listCaseDecisions(target.id).map((entry) => entry.output)
    };
  }
  if (type === 'sanction') {
    const sourceCase = getCase(target.case_id);
    return {
      sanction: target,
      case: sourceCase,
      law: sourceCase?.law_id ? getLaw(sourceCase.law_id) : null,
      decisions: sourceCase ? listCaseDecisions(sourceCase.id).map((entry) => entry.output) : []
    };
  }
  return target;
}

async function reverseAdministrativeAct(guild, act) {
  if (act.status === 'reversed') return;
  const { operation, before, userId, roleId } = act.detail ?? {};
  if (operation === 'operational_setting') {
    setOperationalSetting(guild.id, act.detail.key, before, guild.client.user.id);
  } else if (operation === 'enforcement_mode') {
    updateGovernanceGuild(guild.id, { enforcement_mode: before });
  } else if (operation === 'governance_status') {
    updateGovernanceGuild(guild.id, { status: before });
  } else if (operation === 'trusted_role') {
    updateGovernanceGuild(guild.id, { trusted_role_id: before ?? '' });
  } else if (operation === 'trusted-add' || operation === 'trusted-remove') {
    const member = await guild.members.fetch(userId).catch(() => null);
    if (member && roleId) {
      const desired = operation === 'trusted-remove';
      authorizeTrustedMutation({ guildId: guild.id, userId, roleId, desired, authorizedBy: guild.client.user.id });
      if (desired) await member.roles.add(roleId, `Administrative act A-${act.id} reversed`);
      else await member.roles.remove(roleId, `Administrative act A-${act.id} reversed`);
    }
  } else if (operation === 'sanction_execution') {
    const sanction = getSanction(act.detail.sanctionId);
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

export async function approveCase(interaction, caseId, decision) {
  const { governance } = requireGovernance(interaction.guildId);
  const member = interaction.member ?? await interaction.guild.members.fetch(interaction.user.id);
  if (!governance.trusted_role_id) throw new Error('特別有権者による承認機能は無効です。');
  const electorate = specialElectorateName(interaction.guild, governance);
  if (!member.roles.cache.has(governance.trusted_role_id)) throw new Error(`「${electorate}」ロールが必要です。`);
  const caseRecord = getCase(caseId);
  if (!caseRecord || caseRecord.guild_id !== interaction.guildId || caseRecord.status !== 'approval') throw new Error('承認待ちの事件ではありません。');
  const policy = constitutionForCase(caseRecord).policy;
  if ([caseRecord.accused_id, caseRecord.reporter_id].includes(member.id)) throw new Error('被告・通報者は執行承認できません。');
  const approvalResult = setCaseApproval(caseId, member.id, decision);
  const sanction = getCaseSanction(caseId);
  const approvals = listCaseApprovals(caseId).filter((entry) => entry.decision === 'approve').length;
  const oldLabel = { approve: '承認', reject: '拒否' }[approvalResult.oldDecision];
  await postCourtUpdate(
    interaction.guild,
    caseRecord,
    `${publicMemberLabel(member.id)} が執行を${decision === 'approve' ? '承認' : '拒否'}しました${oldLabel ? ` (変更前: ${oldLabel})` : ''}。承認 ${approvals}/${sanction.required_approvals}`
  );
  if (decision === 'approve' && approvals >= sanction.required_approvals) {
    const procedure = summaryProcedure(policy);
    const appealWindowAlreadyOffered = Boolean(procedure && sanction.appeal_deadline);
    if (sanction.appealable && !getAppeal(caseId) && !appealWindowAlreadyOffered) {
      await beginAppealWindow(interaction.guild, caseRecord, sanction);
    }
    else queueExecution(caseRecord, sanction);
  }
  return { approvals, required: sanction.required_approvals, policy };
}

export async function appealCase(guild, member, caseId, grounds) {
  const caseRecord = getCase(caseId);
  const sanction = getCaseSanction(caseId);
  if (!caseRecord || !sanction || caseRecord.guild_id !== guild.id) throw new Error('事件または刑が見つかりません。');
  const policy = constitutionForCase(caseRecord).policy;
  if (caseRecord.accused_id !== member.id) throw new Error('被告本人だけが上訴できます。');
  if (caseRecord.status !== 'appeal_window' || !sanction.appealable || Date.now() >= sanction.appeal_deadline) throw new Error('上訴受付中ではありません。');
  if (getAppeal(caseId)) throw new Error('上訴は1回だけです。');
  createAppeal(caseId, member.id, grounds);
  const now = Date.now();
  const submissionsUntil = now + policy.judiciary.defenseMilliseconds;
  updateCase(caseId, { status: 'appeal', retry_after: submissionsUntil, last_error: null });
  if (!summaryProcedure(policy)) updateSanction(sanction.id, { restriction_started_at: now });
  enqueueAction({
    guildId: guild.id,
    actionType: 'appeal_restrict',
    targetId: sanction.id,
    payload: { sanctionId: sanction.id },
    idempotencyKey: `appeal-restrict:${sanction.id}`
  });
  await postCourtUpdate(guild, getCase(caseId), `${publicMemberLabel(member.id, '動作確認用アカウント')} が上訴しました。<t:${Math.floor(submissionsUntil / 1000)}:F>までこの事件投稿で追加主張を受け付け、その後に別の${policy.judiciary.panelSeats}席パネルで再審します。`, { state: '上訴' });
  // live modeではAI再審へ渡す前に発言先を自分の上訴事件投稿へ限定する。
  await ensureAppealRestriction(guild, sanction.id);
  return getCase(caseId);
}

export async function requestSummaryTrial(guild, member, sanctionId) {
  const sanction = getSanction(sanctionId);
  if (!sanction || sanction.guild_id !== guild.id) throw new Error('処分が見つかりません。');
  if (sanction.user_id !== member.id) throw new Error('処分を受けた本人だけが裁判を求められます。');
  const caseRecord = getCase(sanction.case_id);
  const constitution = constitutionForCase(caseRecord);
  const policy = constitution?.policy;
  const procedure = summaryProcedure(policy);
  if (!procedure || caseRecord.procedure_version !== 2) throw new Error('この処分は簡易裁判の対象ではありません。');
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
  let current = updateCase(caseRecord.id, {
    status: 'filing',
    review_count: 1,
    response_completed_at: null,
    decision_due_at: now + procedure.trialMilliseconds
  });
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
  current = await finishCaseFiling(guild, current);
  await postCourtUpdate(guild, current, `${publicMemberLabel(member.id)} が裁判を求めました。回答完了ボタンを押せばすぐ判定し、押さなくても<t:${Math.floor(current.defense_until / 1000)}:F>までに判定します。`, {
    state: '答弁'
  });
  return current;
}

export async function detectAutomaticEnforcement(message) {
  if (!message?.guildId || message.author?.bot) return null;
  const { constitution } = requireGovernance(message.guildId);
  const procedure = summaryProcedure(constitution.policy);
  if (!procedure || !publicChannel(message, getGovernanceGuild(message.guildId))) return null;
  for (const law of listLaws(message.guildId).filter((entry) => entry.status === 'active')) {
    if (Number(message.createdTimestamp) < Number(law.effective_at)) continue;
    for (const offense of law.provisions.offenses ?? []) {
      const trigger = offense.automaticTrigger;
      if (!validateAutomaticTrigger(trigger)) continue;
      const windowMs = trigger.windowSeconds * 1000;
      const recent = recentUserActivity(
        message.guildId,
        message.author.id,
        message.channelId,
        message.createdTimestamp - windowMs,
        message.createdTimestamp,
        100
      );
      if (recent.length < trigger.minimumMessages) continue;
      if (findRecentSummaryCase(message.guildId, message.author.id, law.id, offense.code, message.createdTimestamp - windowMs)) continue;
      const triggerEvidence = recent.slice(-trigger.minimumMessages);
      const first = triggerEvidence[0];
      const eventKey = `auto:${law.id}:${offense.code}:${message.author.id}:${message.channelId}:${first.message_id}:${message.id}`;
      if (findCaseBySummaryEvent(message.guildId, eventKey)) continue;
      const reporter = { id: message.guild?.client?.user?.id ?? 'system' };
      return fileCriminalCase(message.guild, reporter, {
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
        summaryEventKey: eventKey
      });
    }
  }
  return null;
}

export async function completeCaseResponse(guild, member, caseId) {
  const caseRecord = getCase(caseId);
  if (!caseRecord || caseRecord.guild_id !== guild.id) throw new Error('事件が見つかりません。');
  const responseController = caseRecord.accused_id ?? caseRecord.reporter_id;
  if (responseController !== member.id) throw new Error('回答する当事者本人だけが回答を完了できます。');
  if (!['defense', 'appeal'].includes(caseRecord.status)) throw new Error('現在は回答受付中ではありません。');
  if (!caseProcedure(caseRecord)) throw new Error('この事件は回答完了による即時判定に対応していません。');
  const now = Date.now();
  const current = updateCase(caseRecord.id, {
    response_completed_at: now,
    defense_until: now,
    decision_due_at: now,
    retry_after: null
  });
  await postCourtUpdate(guild, current, `${publicMemberLabel(member.id)} が回答を完了しました。判定を開始します。`, { state: '審理' });
  await advanceCase(guild, current, now);
  await processGovernanceOutbox(guild.client);
  return getCase(caseId);
}

export async function submitCaseAnswer(guild, member, caseId, content) {
  const caseRecord = getCase(caseId);
  if (!caseRecord || caseRecord.guild_id !== guild.id) throw new Error('事件が見つかりません。');
  if (![caseRecord.reporter_id, caseRecord.accused_id].filter(Boolean).includes(member.id)) {
    throw new Error('この事件の当事者だけが回答できます。');
  }
  if (!['defense', 'appeal'].includes(caseRecord.status)) throw new Error('現在は回答受付中ではありません。');
  const normalized = String(content ?? '').trim();
  if (!normalized || normalized.length > 8000) throw new Error('回答は1文字以上8000文字以内で入力してください。');
  const count = listCurrentCaseSubmissions(caseRecord.id).filter((entry) => entry.kind === caseRecord.status).length;
  if (count >= CASE_SUBMISSION_LIMIT_PER_PHASE) throw new Error('この審級の回答件数上限に達しました。');
  const id = addCaseSubmission(caseRecord.id, member.id, caseRecord.status, normalized);
  await postCourtRecord(guild, caseRecord, `${publicMemberLabel(member.id)} が回答を提出しました。`);
  return id;
}

async function ensureAppealRestriction(guild, sanctionId) {
  const governance = getGovernanceGuild(guild.id);
  if (governance?.enforcement_mode !== 'live') return;
  await processGovernanceOutbox(guild.client);
  let sanction = getSanction(sanctionId);
  if (!sanction?.execution_detail) {
    // shadow中にoutboxが完了したあとliveへ切り替わった場合も、再審より先に
    // 必ず制限を実体化する。適用できなければ例外で審理を止める。
    const detail = await applyAppealRestriction(guild, governance, sanction.user_id);
    sanction = updateSanction(sanction.id, { execution_detail: JSON.stringify(detail) });
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

async function advanceProposal(guild, proposal, now) {
  if (proposal.workflow_status === 'queued') return proposal;
  if (proposal.retry_after && proposal.retry_after > now) return proposal;
  const runtime = proposalRuntime(proposal);
  if (!runtime || runtime.state.handler === 'terminal') return proposal;
  if (runtime.state.handler === 'draft') return draftStoredProposal(guild, proposal);
  if (runtime.state.handler === 'public_discussion') {
    if (proposal.stage_ends_at === null || Number(proposal.stage_ends_at) > now) return proposal;
    if (['initial', 'revision'].includes(runtime.state.config.phase)) {
      return completeProposalDebate(guild, proposal, now);
    }
    if (runtime.state.config.phase === 'legacy_draft') {
      const transition = proposalTransition(proposal, 'expired');
      const reviewing = updateProposal(proposal.id, {
        status: transition.targetName,
        stage_started_at: now,
        stage_ends_at: proposalStageEnd(transition, now)
      });
      return constitutionalReviewProposal(guild, reviewing);
    }
    if (runtime.state.config.phase === 'legacy_debate') return openProposalVote(guild, proposal);
    throw new Error(`未対応の公開討議phaseです: ${runtime.state.config.phase ?? '(none)'}`);
  }
  if (runtime.state.handler === 'ai_deliberation') return completeProposalDebate(guild, proposal, now);
  if (runtime.state.handler === 'constitutional_panel') return constitutionalReviewProposal(guild, proposal);
  if (runtime.state.handler === 'public_vote'
    && proposal.stage_ends_at !== null && Number(proposal.stage_ends_at) <= now) {
    return closeProposalVote(guild, proposal);
  }
  return proposal;
}

async function queueProposalBehind(guild, proposal, blocker, reason) {
  const queued = queueProposalWorkflow(proposal.id, {
    blockedByProposalId: blocker.id,
    reason
  });
  if (queued.forum_thread_id) {
    await postProposalUpdate(
      guild,
      queued,
      `先に受理された「${blocker.title}」と同じ対象を更新するため、審議を一時停止しました。先行案件の終了後、最新版を基礎に自動で再開します。`,
      { state: '待機', components: [] }
    );
  }
  return queued;
}

export async function reconcileProposalQueues(guild) {
  const newlyQueued = [];
  let proposals = listProposals(guild.id, { limit: 500 });
  const activeAmendments = proposals
    .filter((proposal) => proposal.kind === 'amendment' && activeProposal(proposal))
    .sort((left, right) => Number(left.id) - Number(right.id));
  const firstAmendment = activeAmendments[0] ?? null;
  for (const proposal of activeAmendments.slice(1)) {
    newlyQueued.push(await queueProposalBehind(guild, proposal, firstAmendment, 'constitution_in_progress'));
  }

  proposals = listProposals(guild.id, { limit: 500 });
  const laws = listLaws(guild.id, { activeOnly: false, limit: 500 });
  const lawsById = new Map(laws.map((law) => [String(law.id), law]));
  const firstByRoot = new Map();
  for (const proposal of proposals
    .filter((entry) => entry.kind === 'law' && entry.target_type === 'law' && activeProposal(entry))
    .sort((left, right) => Number(left.id) - Number(right.id))) {
    const law = lawsById.get(String(proposal.target_id));
    const root = String(law?.root_law_id ?? law?.id ?? proposal.target_id);
    const first = firstByRoot.get(root);
    if (!first) firstByRoot.set(root, proposal);
    else newlyQueued.push(await queueProposalBehind(guild, proposal, first, 'same_law_in_progress'));
  }
  return newlyQueued;
}

async function resumeQueuedProposalAndDraft(guild, proposal) {
  const constitution = getActiveConstitution(guild.id);
  const relatedInputs = Array.isArray(proposal.workflow_context?.queue?.inputs)
    ? proposal.workflow_context.queue.inputs
    : [];
  let targetType = null;
  let targetId = null;
  let targetHash = null;
  if (proposal.kind === 'amendment') {
    targetType = 'constitution';
    targetId = constitution.id;
    targetHash = constitution.content_hash;
  } else if (proposal.target_type === 'law') {
    const law = getCurrentLawVersion(proposal.target_id);
    if (!law || law.guild_id !== guild.id || law.status !== 'active') {
      const remanded = updateProposal(proposal.id, { status: 'remanded', stage_ends_at: Date.now() });
      if (remanded.forum_thread_id) {
        await postProposalUpdate(guild, remanded, '改正対象の法律が現行ではなくなったため、審議待ちを終了して差し戻しました。', { state: '廃案' });
      }
      return remanded;
    }
    targetType = 'law';
    targetId = law.id;
    targetHash = law.content_hash;
  }
  let resumed = resumeQueuedProposal(proposal.id, {
    constitutionId: constitution.id,
    targetType,
    targetId,
    targetHash
  });
  if (resumed.forum_thread_id) {
    await postProposalUpdate(guild, resumed, '先行案件が終了したため、最新版を基礎に草案を作り直します。', { state: '草案', components: [] });
  }
  try {
    resumed = await draftStoredProposal(guild, resumed, { relatedInputs });
  } catch (error) {
    updateProposal(resumed.id, retryPatch(resumed, error));
    throw error;
  }
  if (resumed.forum_thread_id) {
    await postProposalUpdate(
      guild,
      resumed,
      '審議待ちを終了し、最新版を基礎に討議を開始しました。',
      { files: proposalBodyFiles(resumed.kind, resumed.body, '再起草案') }
    );
  }
  return resumed;
}

export async function resumeProposalQueues(guild) {
  const proposals = listProposals(guild.id, { limit: 500 });
  const active = proposals.filter(activeProposal);
  const queued = proposals
    .filter((proposal) => proposal.workflow_status === 'queued')
    .sort((left, right) => Number(left.id) - Number(right.id));
  const resumed = [];
  if (!active.some((proposal) => proposal.kind === 'amendment')) {
    const next = queued.find((proposal) => proposal.kind === 'amendment');
    if (next) resumed.push(await resumeQueuedProposalAndDraft(guild, next));
  }
  const laws = listLaws(guild.id, { activeOnly: false, limit: 500 });
  const rootOf = (lawId) => {
    const law = laws.find((entry) => String(entry.id) === String(lawId));
    return String(law?.root_law_id ?? law?.id ?? lawId);
  };
  const activeRoots = new Set(active
    .filter((proposal) => proposal.kind === 'law' && proposal.target_type === 'law')
    .map((proposal) => rootOf(proposal.target_id)));
  const resumedRoots = new Set();
  for (const proposal of queued.filter((entry) => entry.kind === 'law' && entry.target_type === 'law')) {
    const root = rootOf(proposal.target_id);
    if (activeRoots.has(root) || resumedRoots.has(root)) continue;
    resumed.push(await resumeQueuedProposalAndDraft(guild, proposal));
    resumedRoots.add(root);
  }
  return resumed;
}

async function syncRetriedIntake(guild, resultType, result) {
  const { updateRetriedIntakeMessage, updateRetriedMentionInvestigationMessage } = await import('./intake.js');
  await updateRetriedIntakeMessage(guild, resultType, result).catch((error) => {
    console.error(`Failed to update completed ${resultType} intake ${result.id}:`, error);
  });
  await updateRetriedMentionInvestigationMessage(guild, resultType, result).catch((error) => {
    console.error(`Failed to update completed ${resultType} investigation ${result.id}:`, error);
  });
}

async function advanceCase(guild, caseRecord, now) {
  if (caseRecord.retry_after && caseRecord.retry_after > now) return;
  if (caseRecord.status === 'summary_review') {
    await finishSummaryReview(guild, caseRecord);
    return;
  }
  if (caseRecord.status === 'filing') {
    if (caseRecord.procedure_version === 2 && caseRecord.summary_event_key && !getCaseSanction(caseRecord.id)) {
      await finishSummaryReview(guild, caseRecord);
    } else {
      await finishCaseFiling(guild, caseRecord);
    }
    return;
  }
  if (caseRecord.status === 'defense' && caseRecord.defense_until <= now) {
    await ensureEvidenceDisclosures(guild, caseRecord);
    updateCase(caseRecord.id, { status: 'deliberation', retry_after: null, last_error: null });
    const policy = constitutionForCase(caseRecord).policy;
    await postCourtUpdate(guild, getCase(caseRecord.id), `答弁期間が終了し、${policy.judiciary.panelSeats}席パネルの審理を開始します。`, { state: '審理' });
    if (caseRecord.kind === 'constitutional') await adjudicateConstitutionalCase(guild, getCase(caseRecord.id));
    else await adjudicateCriminalCase(guild, getCase(caseRecord.id), caseRecord.procedure_version === 2 ? 'trial' : 'initial');
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
    const appealSanction = getCaseSanction(caseRecord.id);
    if (!appealSanction) throw new Error('上訴対象の刑がありません。');
    await ensureAppealRestriction(guild, appealSanction.id);
    await adjudicateCriminalCase(guild, caseRecord, 'appeal');
    return;
  }
  const sanction = getCaseSanction(caseRecord.id);
  if (caseRecord.status === 'appeal_window' && sanction?.appeal_deadline > now) {
    await notifyCaseParty(guild, caseRecord, 'appeal', sanction.appeal_deadline);
    return;
  }
  if (caseRecord.status === 'appeal_window' && sanction?.appeal_deadline <= now && !getAppeal(caseRecord.id)) {
    if (caseRecord.procedure_version === 2 && sanction.required_approvals > 0) {
      await beginCaseApproval(guild, caseRecord, sanction, `上訴がなかったため判決が確定しました。執行には${sanction.required_approvals}人の公開承認が必要です。`);
    } else {
      queueExecution(caseRecord, sanction);
      await postCourtUpdate(guild, getCase(caseRecord.id), '上訴期限内に上訴がなかったため判決が確定しました。', { state: '確定' });
    }
  }
}

async function runWeeklyReview(guild, governance, now) {
  if (!getOperationalSetting(guild.id, 'weekly_scan_enabled')) return;
  if (governance.last_weekly_scan_at && now - governance.last_weekly_scan_at < 7 * DAY_MS) return;
  if (governance.weekly_retry_after && governance.weekly_retry_after > now) return;
  const constitution = getActiveConstitution(guild.id);
  const limit = Math.max(0, Math.min(10, getOperationalSetting(guild.id, 'weekly_draft_limit')));
  if (limit === 0) return;
  const since = now - 7 * DAY_MS;
  await guild.channels.fetch();
  const publicIds = new Set([...guild.channels.cache.values()]
    .filter((channel) => channel.isTextBased?.()
      && !governanceSurface(channel, governance)
      && channel.permissionsFor(guild.roles.everyone)?.has(PermissionFlagsBits.ViewChannel))
    .map((channel) => channel.id));
  if (publicIds.size === 0) {
    updateGovernanceGuild(guild.id, {
      last_weekly_scan_at: now,
      weekly_retry_after: null,
      weekly_failure_count: 0,
      weekly_last_error: null
    });
    return;
  }
  const publicChannelIds = [...publicIds];
  const messages = recentGovernanceMessages(guild.id, since, publicChannelIds, 300)
    .map((row) => ({
      id: row.message_id,
      channelId: row.channel_id,
      content: row.content.slice(0, 500),
      createdAt: row.created_at
    }));
  if (messages.length === 0) {
    updateGovernanceGuild(guild.id, {
      last_weekly_scan_at: now,
      weekly_retry_after: null,
      weekly_failure_count: 0,
      weekly_last_error: null
    });
    return;
  }
  const issues = await discoverWeeklyIssues({ guildId: guild.id, constitution, activeLaws: listLaws(guild.id), messages, limit });
  updateGovernanceGuild(guild.id, {
    last_weekly_scan_at: now,
    weekly_retry_after: null,
    weekly_failure_count: 0,
    weekly_last_error: null
  });
  const syntheticMember = { id: guild.client.user.id };
  const sourceById = new Map(messages.map((message) => [String(message.id), message]));
  for (const issue of issues) {
    const sourceLinks = issue.evidenceMessageIds
      .map((id) => sourceById.get(String(id)))
      .filter(Boolean)
      .map((message, index) => `[根拠投稿 ${index + 1}](https://discord.com/channels/${guild.id}/${message.channelId}/${message.id})`);
    const summary = sourceLinks.length > 0
      ? `${issue.summary}\n\n週次検出の根拠:\n${sourceLinks.join('\n')}`
      : issue.summary;
    try {
      const proposals = listProposals(guild.id, { limit: 100 });
      const normalized = { intent: 'petition', title: issue.title, summary, question: null };
      const exact = exactActiveProposalMatch(issue.title, proposals);
      const candidates = buildLegislativeCandidates({
        request: { title: issue.title, summary, source: 'weekly' },
        normalized,
        proposals,
        laws: listLaws(guild.id, { activeOnly: false, limit: 100 }),
        constitution
      });
      const reviewed = exact ? {
        relation: 'join_active', targetType: 'proposal', targetId: String(exact.id),
        reasons: ['同じ題名の案件がすでに進行中です。'], materialDifferences: [], outputs: []
      } : await reviewLegislativeRelation({
        guildId: guild.id,
        request: { title: issue.title, summary, source: 'weekly' },
        normalized,
        candidates,
        panel: constitution.rules?.panels?.proposalRelation
      });
      const target = reviewed.targetType && reviewed.targetId
        ? candidates.find((entry) => entry.type === reviewed.targetType && String(entry.id) === String(reviewed.targetId))
        : null;
      const relation = {
        ...reviewed,
        targetHash: target?.contentHash ?? null,
        targetVersion: target?.version ?? null,
        targetTitle: target?.title ?? null
      };
      const sourceId = sha256(`weekly:${issue.title}:${summary}`);
      if (['covered', 'uncertain', 'amend_constitution'].includes(relation.relation)) {
        if (relation.relation !== 'uncertain') recordInstrumentRelation({
          guildId: guild.id,
          sourceType: 'weekly_issue',
          sourceId,
          relationType: relation.relation,
          targetType: relation.targetType ?? 'none',
          targetId: relation.targetId ?? 'none',
          targetHash: relation.targetHash,
          reasons: relation.reasons,
          decision: relation
        });
        continue;
      }
      if (relation.relation === 'join_active') {
        const targetProposal = getProposal(relation.targetId);
        if (targetProposal?.forum_thread_id) {
          await postProposalUpdate(guild, targetProposal, `週次確認で関連する論点が見つかりました。\n${summary}`);
          recordInstrumentRelation({
            guildId: guild.id,
            sourceType: 'weekly_issue',
            sourceId,
            relationType: relation.relation,
            targetType: 'proposal',
            targetId: targetProposal.id,
            reasons: relation.reasons,
            decision: relation
          });
        }
        continue;
      }
      await filePetition(guild, syntheticMember, {
        title: relation.relation === 'amend_law' ? `${target.title}の改正`.slice(0, 50) : issue.title,
        summary: relation.relation === 'amend_law'
          ? `現行の「${target.title}」を次の内容で改正する。${summary}`.slice(0, 1800)
          : summary,
        source: 'weekly',
        relation
      });
    } catch (error) {
      // proposalはdraftingで永続化済み。後続issueまで失わずscheduler再試行へ任せる。
      console.error(`Failed to draft weekly proposal ${issue.title}:`, error);
    }
  }
}

let schedulerRunning = false;
let lastPruneAt = 0;
const verifiedStatuteGuilds = new Set();
const verifiedRecordUiGuilds = new Set();
const verifiedIntakeUiGuilds = new Set();

function finalizeElapsedSummarySanctions(guildId, now) {
  for (const caseRecord of listCases(guildId, { statuses: ['summary_active'], limit: 100 })) {
    const sanction = getCaseSanction(caseRecord.id);
    if (!sanction) continue;
    const elapsed = sanction.type === 'warning'
      || (Number(sanction.restriction_started_at ?? sanction.executed_at ?? 0) > 0
        && Number(sanction.restriction_started_at ?? sanction.executed_at) + Number(sanction.duration_seconds ?? 0) * 1000 <= now);
    if (!elapsed) continue;
    if (sanction.type !== 'warning') updateSanction(sanction.id, { status: 'expired' });
    updateCase(caseRecord.id, { status: 'final', finalized_at: now });
  }
}

export async function runGovernanceScheduler(client) {
  if (schedulerRunning) return;
  schedulerRunning = true;
  try {
    const now = Date.now();
    if (now - lastPruneAt >= DAY_MS) {
      pruneGovernance();
      lastPruneAt = now;
    }
    expireRestrictions(now);
    const expiredProtections = expireInterimProtections(now);
    const expiredIntakes = expireGovernanceIntakes(now);
    if (expiredIntakes.length > 0) {
      const { updateExpiredIntakeMessages } = await import('./intake.js');
      await updateExpiredIntakeMessages(client, expiredIntakes).catch((error) => {
        console.error('Failed to update expired governance intake messages:', error);
      });
    }
    for (const governance of listGovernanceGuilds()) {
      const guild = client.guilds.cache.get(governance.guild_id) ?? await client.guilds.fetch(governance.guild_id).catch(() => null);
      if (!guild) continue;
      finalizeElapsedSummarySanctions(guild.id, now);
      for (const protection of expiredProtections.filter((entry) => entry.guild_id === guild.id)) {
        const caseRecord = getCase(protection.case_id);
        if (caseRecord?.public_thread_id) {
          await postCourtUpdate(guild, caseRecord, '一時保全は期限どおり自動終了しました。被申立人の発言状態は通常に戻っています。')
            .catch((error) => console.error(`Failed to publish interim protection expiry ${protection.id}:`, error));
        }
        writeAudit({
          guildId: guild.id,
          actorType: 'system',
          action: 'interim_protection.expired',
          targetType: 'interim_protection',
          targetId: protection.id,
          detail: { caseId: protection.case_id, endedAt: now }
        });
      }
      let currentGovernance = governance;
      try {
        const roles = await ensureGovernanceMentionRoles(guild, currentGovernance);
        if (roles.legislatureRoleId !== governance.legislature_role_id
          || roles.judiciaryRoleId !== governance.judiciary_role_id) {
          currentGovernance = updateGovernanceGuild(guild.id, {
            legislature_role_id: roles.legislatureRoleId,
            judiciary_role_id: roles.judiciaryRoleId
          });
        }
      } catch (error) {
        console.error(`Failed to ensure governance mention roles in ${guild.id}:`, error);
      }
      try {
        const statuteForum = await ensureGovernanceStatuteForum(guild, currentGovernance);
        const statuteForumChanged = statuteForum.id !== currentGovernance.statute_forum_id;
        if (statuteForumChanged) {
          currentGovernance = updateGovernanceGuild(guild.id, { statute_forum_id: statuteForum.id });
        }
        await syncStatuteBook(guild, currentGovernance, {
          verifyExisting: statuteForumChanged || !verifiedStatuteGuilds.has(guild.id)
        });
        verifiedStatuteGuilds.add(guild.id);
      } catch (error) {
        console.error(`Failed to sync statute book in ${guild.id}:`, error);
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
      let queueUiChanged = false;
      try {
        queueUiChanged = (await reconcileProposalQueues(guild)).length > 0;
      } catch (error) {
        console.error(`Failed to reconcile proposal queues in ${guild.id}:`, error);
      }
      for (const proposal of listProposals(guild.id, { limit: 100 })
        .filter((entry) => entry.workflow_status !== 'queued'
          && proposalRuntime(entry)?.state?.handler !== 'terminal')) {
        try {
          const current = await advanceProposal(guild, proposal, now) ?? getProposal(proposal.id);
          if (current?.status !== 'drafting') await syncRetriedIntake(guild, 'proposal', current);
        } catch (error) {
          updateProposal(proposal.id, retryPatch(getProposal(proposal.id), error));
          console.error(`Failed to advance proposal ${proposal.id}:`, error);
        }
      }
      try {
        queueUiChanged = (await resumeProposalQueues(guild)).length > 0 || queueUiChanged;
      } catch (error) {
        console.error(`Failed to resume proposal queue in ${guild.id}:`, error);
      }
      if (queueUiChanged) {
        try {
          const { ensureGovernanceUx } = await import('./ux.js');
          currentGovernance = (await ensureGovernanceUx(guild, currentGovernance)).governance;
        } catch (error) {
          console.error(`Failed to publish proposal queue state in ${guild.id}:`, error);
        }
      }
      const cases = listCases(guild.id, { statuses: ['filing', 'summary_review', 'defense', 'deliberation', 'appeal_window', 'appeal'], limit: 100 });
      for (const caseRecord of cases) {
        try {
          await advanceCase(guild, caseRecord, now);
          const current = getCase(caseRecord.id);
          if (current && !current.retry_after && !['filing', 'summary_review'].includes(current.status)) {
            await syncRetriedIntake(guild, 'case', current);
          }
        } catch (error) {
          updateCase(caseRecord.id, retryPatch(getCase(caseRecord.id), error));
          console.error(`Failed to advance case ${caseRecord.id}:`, error);
        }
      }
      try {
        await runWeeklyReview(guild, currentGovernance, now);
      } catch (error) {
        const current = getGovernanceGuild(guild.id);
        const failures = Number(current.weekly_failure_count ?? 0) + 1;
        updateGovernanceGuild(guild.id, {
          weekly_failure_count: failures,
          weekly_retry_after: now + Math.min(RETRY_MAX_MS, RETRY_BASE_MS * (2 ** Math.min(failures - 1, 4))),
          weekly_last_error: String(error?.message ?? error).slice(0, 500)
        });
        console.error(`Weekly governance review failed in ${guild.id}:`, error);
      }
    }
    await processGovernanceOutbox(client);
  } finally {
    schedulerRunning = false;
  }
}

function parseExecutionDetail(value) {
  try { return value ? JSON.parse(value) : {}; } catch { return {}; }
}

async function reverseDiscordSanction(guild, governance, sanction, { reverseExternal }) {
  deactivateRestrictionForSanction(sanction.id);
  const detail = parseExecutionDetail(sanction.execution_detail);
  await releaseAppealRestriction(guild, governance, sanction.user_id, [
    ...(detail.fallbackChannelIds ?? []),
    ...(detail.trialFallbackChannelIds ?? [])
  ]);
  if (reverseExternal && sanction.type === 'timeout') {
    const member = await guild.members.fetch(sanction.user_id).catch(() => null);
    await member?.timeout(null, `${guild.name} sanction ${sanction.id} reversed`).catch(() => {});
  }
  if (reverseExternal && sanction.type === 'ban') {
    await guild.members.unban(sanction.user_id, `${guild.name} sanction ${sanction.id} reversed`).catch(() => {});
  }
}

export async function processGovernanceOutbox(client) {
  for (const action of pendingActions(25)) {
    markActionRunning(action.id);
    try {
      const governance = getGovernanceGuild(action.guild_id);
      const guild = client.guilds.cache.get(action.guild_id) ?? await client.guilds.fetch(action.guild_id);
      const sanction = getSanction(action.payload.sanctionId);
      if (!governance || !sanction) throw new Error('outbox target is missing');
      if (action.action_type === 'appeal_restrict') {
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
        if (['executed', 'simulated'].includes(sanction.status)) {
          completeAction(action.id);
          continue;
        }
        let detail = { shadow: true };
        const old = parseExecutionDetail(sanction.execution_detail);
        await releaseAppealRestriction(guild, governance, sanction.user_id, [
          ...(old.fallbackChannelIds ?? []),
          ...(old.trialFallbackChannelIds ?? [])
        ]);
        const caseRecord = getCase(sanction.case_id);
        const v2Procedure = caseRecord?.procedure_version === 2 ? caseProcedure(caseRecord) : null;
        if (governance.enforcement_mode === 'live') {
          if (sanction.type === 'restriction') {
            const definition = getSanctionDefinition(getCase(sanction.case_id).law_id, sanction.definition_code);
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
              endsAt: startedAt + sanction.duration_seconds * 1000
            });
            detail = { type: 'restriction', definitionCode: definition.code };
          } else if (sanction.type === 'timeout' && v2Procedure && !sanction.notice_delivered) {
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
              endsAt: startedAt + sanction.duration_seconds * 1000
            });
            detail = { type: 'timeout_fallback', reason: 'review_notice_dm_failed' };
          } else {
            const stableSanction = sanction.type === 'timeout' && !sanction.restriction_started_at
              ? updateSanction(sanction.id, { restriction_started_at: Date.now() })
              : sanction;
            detail = await executeDiscordSanction(guild, stableSanction);
          }
        }
        const reviewable = Boolean(v2Procedure
          && v2Procedure.immediateSanctions.includes(sanction.type)
          && Number(caseRecord.review_count ?? 0) === 0);
        updateSanction(sanction.id, {
          status: reviewable ? 'reviewable' : (governance.enforcement_mode === 'live' ? 'executed' : 'simulated'),
          executed_at: Date.now(),
          execution_detail: JSON.stringify(detail)
        });
        updateCase(sanction.case_id, reviewable
          ? (sanction.type === 'warning'
            ? { status: 'final', finalized_at: Date.now() }
            : { status: 'summary_active' })
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
        const executionLabel = governance.enforcement_mode === 'live' ? '実執行' : '記録のみ';
        let publicCase = await ensurePublicCaseRecord(guild, getCase(sanction.case_id));
        publicCase = getCase(publicCase.id);
        await postCourtUpdate(
          guild,
          publicCase,
          reviewable
            ? `即時処分を${executionLabel}として記録しました。本人は裁判を求められます。`
            : `裁判で確定した処分を${executionLabel}として処理しました。`,
          { state: publicCase.status }
        );
      } else if (action.action_type === 'sanction_reverse') {
        const execution = parseExecutionDetail(sanction.execution_detail);
        await reverseDiscordSanction(guild, governance, sanction, {
          reverseExternal: ['timeout', 'ban'].includes(execution.type)
        });
        updateSanction(sanction.id, { status: 'reversed', reversed_at: Date.now() });
      } else {
        throw new Error(`unknown outbox action: ${action.action_type}`);
      }
      completeAction(action.id);
    } catch (error) {
      failAction(action.id, error);
    }
  }
}

export async function onTrustedRoleChange(oldMember, newMember) {
  const governance = getGovernanceGuild(newMember.guild.id);
  if (!governance?.trusted_role_id) return;
  const before = oldMember.roles.cache.has(governance.trusted_role_id);
  const after = newMember.roles.cache.has(governance.trusted_role_id);
  if (before === after) return;
  const authorized = consumeTrustedMutation({
    guildId: newMember.guild.id,
    userId: newMember.id,
    roleId: governance.trusted_role_id,
    desired: after
  });
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

export async function setTrustedMember(guild, actorId, member, desired) {
  const governance = getGovernanceGuild(guild.id);
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

export async function onGuildRoleDelete(role) {
  const governance = getGovernanceGuild(role.guild.id);
  if (!governance) return;
  if (governance.trusted_role_id === role.id) {
    updateGovernanceGuild(role.guild.id, { trusted_role_id: '' });
    writeAudit({ guildId: role.guild.id, actorType: 'system', action: 'trusted.role_deleted', targetType: 'role', targetId: role.id, detail: { trustedDisabled: true } });
    await postAuthorityChange(role.guild, governance, '特別有権者機能を自動無効化', '設定されていたロールが削除されたため、拒否権と重い処分の承認を無効化しました。');
  }
  const patch = {};
  if (governance.legislature_role_id === role.id) patch.legislature_role_id = '';
  if (governance.judiciary_role_id === role.id) patch.judiciary_role_id = '';
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

export async function onGuildChannelCreate(channel) {
  const governance = getGovernanceGuild(channel.guildId);
  if (!governance || channel.id === governance.court_forum_id) return;
  await syncAppealRoleOverwrites(channel.guild, governance.appeal_role_id, governance.court_forum_id, { strict: true });
}
