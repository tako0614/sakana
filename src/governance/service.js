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
  createProposal,
  createSanction,
  deactivateRestrictionForSanction,
  enactConstitution,
  enactLaw,
  enqueueAction,
  expireRestrictions,
  failAction,
  findActiveProposalByNormalizedTitle,
  findOpenConstitutionalCase,
  getActiveConstitution,
  getAdministrativeAct,
  getAppeal,
  getCase,
  getCaseByPrivateThread,
  getCaseSanction,
  getGovernanceGuild,
  getLaw,
  getOperationalSetting,
  getProposal,
  getSanction,
  getSanctionDefinition,
  listCaseApprovals,
  listCaseEvidence,
  listCaseDecisions,
  listCaseSubmissions,
  listCases,
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
  recentGovernanceMessages,
  reserveAgentAttempt,
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
  approvalButtons,
  createCourtThreads,
  createProposalPost,
  executeDiscordSanction,
  postCourtUpdate,
  postPrivateCourtUpdate,
  postGazette,
  postProposalUpdate,
  releaseAppealRestriction,
  syncAppealRoleOverwrites,
  voteButtons
} from './discord.js';
import {
  discoverWeeklyIssues,
  draftAmendment,
  draftBill,
  runConstitutionalPanel,
  runJudicialPanel
} from './llm.js';
import {
  DAY_MS,
  activityDate,
  closeVote,
  isAppealable,
  normalizeActivityContent,
  requiredApprovals,
  sha256,
  validateRestrictionDefinition
} from './policy.js';
import { governanceActionAllowed, reserveRestrictedAgentCall } from './restrictions.js';

const RETRY_BASE_MS = 5 * 60_000;
const RETRY_MAX_MS = 60 * 60_000;
const CASE_EVIDENCE_LIMIT = 20;
const CASE_SUBMISSION_LIMIT_PER_PHASE = 40;

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
  if (governance.status !== 'active') throw new Error(`統治機能は現在 ${governance.status} です。`);
  const constitution = getActiveConstitution(guildId);
  if (!constitution) throw new Error('有効な憲法がありません。');
  return { governance, constitution, policy: constitution.policy };
}

function governanceSurface(channel, governance) {
  if (!channel || !governance) return false;
  const ids = new Set([
    governance.category_id,
    governance.parliament_forum_id,
    governance.court_forum_id,
    governance.court_chat_channel_id,
    governance.gazette_channel_id
  ].filter(Boolean));
  return ids.has(channel.id) || ids.has(channel.parentId);
}

function publicChannel(message, governance = null) {
  const channel = message.channel;
  if (!channel || channel.isDMBased?.()) return false;
  if (governanceSurface(channel, governance)) return false;
  const everyone = message.guild?.roles?.everyone;
  return Boolean(everyone && channel.permissionsFor?.(everyone)?.has(PermissionFlagsBits.ViewChannel));
}

export function recordGovernanceMessage(message) {
  if (!message?.guildId || message.author?.bot) return false;
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
    WHERE m.guild_id = ? AND m.created_at >= ? AND m.is_bot = 0 AND m.deleted = 0
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
  const { governance, policy } = requireGovernance(guild.id);
  const proposal = getProposal(proposalId);
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
  const { policy, governance } = requireGovernance(guild.id);
  const now = Date.now();
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
  const post = proposal.forum_thread_id
    ? { threadId: proposal.forum_thread_id, messageId: proposal.forum_message_id }
    : await createProposalPost(guild, governance, proposal);
  return updateProposal(proposal.id, {
    status: 'draft',
    stage_started_at: now,
    stage_ends_at: now + policy.legislation.draftMilliseconds,
    forum_thread_id: post.threadId,
    forum_message_id: post.messageId
  });
}

async function draftStoredProposal(guild, proposal) {
  const { constitution, policy } = requireGovernance(guild.id);
  if (proposal.body) return finishDraft(guild, proposal, proposal.body);
  const request = {
    title: proposal.title,
    summary: proposal.summary,
    source: proposal.source
  };
  const body = proposal.kind === 'amendment'
    ? await draftAmendment({ guildId: guild.id, request, constitution })
    : await draftBill({
      guildId: guild.id,
      petition: request,
      constitution,
      activeLaws: listLaws(guild.id),
      policy
    });
  return finishDraft(guild, proposal, body);
}

export async function filePetition(guild, member, { title, summary, source = 'petition', eventId = null, voteScope = null }) {
  const { governance, constitution, policy } = requireGovernance(guild.id);
  const scope = voteScope ?? policy.voting.defaultScope;
  if (!policy.voting.allowedScopes.includes(scope)) throw new Error('許可されていない投票scopeです。');
  if (scope === 'trusted' && !governance.trusted_role_id) throw new Error('trusted-only投票にはtrusted roleの設定が必要です。');
  if (!governanceActionAllowed(guild.id, member.id, 'petition')) throw new Error('請願提出が制裁により停止されています。');
  const duplicate = findActiveProposalByNormalizedTitle(guild.id, title);
  if (duplicate) throw new Error(`同名の法案 L-${duplicate.id} が進行中です。議会Forumで討議してください。`);
  if (source !== 'weekly') requireGovernanceAiAttempt(member, eventId ?? `petition:${member.id}:${Date.now()}`);
  const proposal = createProposal({
    guildId: guild.id,
    kind: 'law',
    source,
    title,
    summary,
    proposerId: source === 'weekly' ? null : member.id,
    constitutionId: constitution.id,
    voteScope: scope,
    status: 'drafting'
  });
  try {
    return await draftStoredProposal(guild, proposal);
  } catch (error) {
    updateProposal(proposal.id, retryPatch(proposal, error));
    console.error(`Initial draft failed for proposal ${proposal.id}:`, error);
    throw new Error(`法案 L-${proposal.id} は受理しました。AIまたはDiscordが一時失敗したため自動再試行します。`);
  }
}

export async function fileAmendment(guild, member, { title, summary, eventId = null, voteScope = null }) {
  const { governance, constitution, policy } = requireGovernance(guild.id);
  const scope = voteScope ?? policy.voting.defaultScope;
  if (!policy.voting.allowedScopes.includes(scope)) throw new Error('許可されていない投票scopeです。');
  if (scope === 'trusted' && !governance.trusted_role_id) throw new Error('trusted-only投票にはtrusted roleの設定が必要です。');
  if (!governanceActionAllowed(guild.id, member.id, 'petition')) throw new Error('改憲提案が制裁により停止されています。');
  const duplicate = findActiveProposalByNormalizedTitle(guild.id, title);
  if (duplicate) throw new Error(`同名の法案 L-${duplicate.id} が進行中です。議会Forumで討議してください。`);
  requireGovernanceAiAttempt(member, eventId ?? `amendment:${member.id}:${Date.now()}`);
  const proposal = createProposal({
    guildId: guild.id,
    kind: 'amendment',
    source: 'petition',
    title,
    summary,
    proposerId: member.id,
    constitutionId: constitution.id,
    voteScope: scope,
    status: 'drafting'
  });
  try {
    return await draftStoredProposal(guild, proposal);
  } catch (error) {
    updateProposal(proposal.id, retryPatch(proposal, error));
    console.error(`Initial draft failed for amendment ${proposal.id}:`, error);
    throw new Error(`改憲案 L-${proposal.id} は受理しました。AIまたはDiscordが一時失敗したため自動再試行します。`);
  }
}

async function reviseProposal(guild, proposal, reviews) {
  if (proposal.revision >= 3) {
    proposal = updateProposal(proposal.id, { status: 'remanded' });
    await postProposalUpdate(guild, proposal, '違憲審査を3改訂で通過できなかったため差し戻しました。', { state: '廃案' });
    return proposal;
  }
  const constitution = getActiveConstitution(guild.id);
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
  const fullDraft = proposal.kind === 'amendment'
    ? `# ${body.title}\n\n${body.content}\n\n## Policy\n\n\`\`\`json\n${JSON.stringify(body.policy, null, 2)}\n\`\`\``
    : `# ${body.title}\n\n${body.text}\n\n## Provisions\n\n\`\`\`json\n${JSON.stringify(body.provisions, null, 2)}\n\`\`\``;
  await postProposalUpdate(
    guild,
    proposal,
    `違憲審査の指摘を反映して改訂${nextRevision}を公開しました。草案期間をやり直します。`,
    { files: [{ attachment: Buffer.from(fullDraft), name: `proposal-${proposal.id}-r${nextRevision}.md` }] }
  );
  proposal = updateProposal(proposal.id, {
    title: body.title,
    summary: body.summary,
    body,
    status: 'draft',
    revision: nextRevision,
    stage_started_at: now,
    stage_ends_at: now + constitution.policy.legislation.draftMilliseconds,
    retry_after: null,
    failure_count: 0,
    last_error: null
  });
  return proposal;
}

async function constitutionalReviewProposal(guild, proposal) {
  const constitution = getActiveConstitution(guild.id);
  proposal = updateProposal(proposal.id, {
    status: 'constitutional_review',
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
  const reviewRecord = [
    `# 法案 L-${proposal.id} 事前違憲審査`,
    '',
    ...panel.outputs.map((output, index) => `## seat ${index + 1}\n\n${JSON.stringify(output, null, 2)}`)
  ].join('\n');
  await postProposalUpdate(guild, proposal, '事前違憲審査の理由と憲法条文参照を公開します。', {
    files: [{ attachment: Buffer.from(reviewRecord), name: `proposal-${proposal.id}-constitutional-review-r${proposal.revision}.md` }]
  });
  const constitutional = panel.outputs.filter((output) => output.verdict === 'constitutional').length;
  const passed = constitutional >= constitution.policy.judiciary.constitutionalVotesRequired;
  if (!passed) return reviseProposal(guild, proposal, panel.outputs);
  const now = Date.now();
  const debateEndsAt = now + constitution.policy.legislation.debateMilliseconds;
  await postProposalUpdate(guild, proposal, `合憲 ${constitutional}/${constitution.policy.judiciary.panelSeats}で審査を通過しました。討議期限: <t:${Math.floor(debateEndsAt / 1000)}:F>`, { state: '討議' });
  proposal = updateProposal(proposal.id, {
    status: 'debate',
    stage_started_at: now,
    stage_ends_at: debateEndsAt,
    failure_count: 0
  });
  return proposal;
}

async function openProposalVote(guild, proposal) {
  const constitution = getActiveConstitution(guild.id);
  const snapshot = await buildElectorateSnapshot(guild, proposal.id);
  const now = Date.now();
  const voteEndsAt = now + constitution.policy.legislation.voteMilliseconds;
  const eligible = snapshot.filter((row) => row.eligibleGeneral).length;
  const trusted = snapshot.filter((row) => row.trusted).length;
  await postProposalUpdate(guild, proposal, [
    `投票を開始しました。締切: <t:${Math.floor(voteEndsAt / 1000)}:F>`,
    `scope: ${proposal.vote_scope} / 有権者: ${eligible}人 / trusted snapshot: ${trusted}人`,
    `定足数: ${Math.max(constitution.policy.voting.minimumBallots, Math.ceil(eligible * constitution.policy.voting.quorumRatio))}票`,
    proposal.kind === 'amendment'
      ? `成立条件: 投票scope内の賛否で${Math.round(constitution.policy.voting.amendmentYesRatio * 100)}%以上の賛成${proposal.vote_scope === 'all' ? '、かつtrusted拒否なし' : ''}`
      : `成立条件: 投票scope内の賛否で${Math.round(constitution.policy.voting.lawYesRatio * 100)}%を超える賛成${proposal.vote_scope === 'all' ? '、かつtrusted拒否なし' : ''}`
  ].join('\n'), { state: '投票', components: voteButtons(proposal.id) });
  return updateProposal(proposal.id, {
    status: 'voting',
    stage_started_at: now,
    stage_ends_at: voteEndsAt,
    retry_after: null,
    failure_count: 0,
    last_error: null
  });
}

async function closeProposalVote(guild, proposal) {
  const { governance, constitution, policy } = requireGovernance(guild.id);
  const summary = proposalVoteSummary(proposal.id);
  const result = closeVote({ kind: proposal.kind, scope: proposal.vote_scope, ...summary }, policy);
  if (!result.passed) {
    proposal = updateProposal(proposal.id, { status: 'rejected', stage_ends_at: Date.now() });
    await postProposalUpdate(guild, proposal, `否決されました。賛成 ${summary.yes} / 反対 ${summary.no} / 棄権 ${summary.abstain} / 定足数 ${summary.yes + summary.no + summary.abstain}/${result.quorumNeeded} / trusted反対 ${summary.trustedNo}/${summary.trustedTotal}有効票 (棄権 ${summary.trustedAbstain} / 有権者 ${summary.trustedElectorate})`, { state: '否決' });
    return proposal;
  }
  if (proposal.kind === 'amendment') {
    const next = enactConstitution({
      guildId: guild.id,
      content: proposal.body.content,
      policy: proposal.body.policy,
      proposalId: proposal.id,
      enactedBy: 'vote'
    });
    proposal = updateProposal(proposal.id, { status: 'enacted', stage_ends_at: Date.now() });
    await postProposalUpdate(guild, proposal, `改憲が成立しました。憲法 v${next.version} が有効です。`, { state: '成立' });
    await postGazette(guild, governance, `憲法 v${next.version}`, `${next.content}\n\n## Policy\n\n\`\`\`json\n${JSON.stringify(next.policy, null, 2)}\n\`\`\`\n\ncontent hash: ${next.content_hash}\npolicy hash: ${next.policy_hash}`);
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
  const law = enactLaw({
    guildId: guild.id,
    proposalId: proposal.id,
    code: `LAW-${proposal.id}-R${proposal.revision}`,
    title: proposal.title,
    text: proposal.body.text,
    provisions: proposal.body.provisions,
    constitutionId: constitution.id,
    effectiveAt: Date.now()
  });
  proposal = updateProposal(proposal.id, { status: 'enacted', stage_ends_at: Date.now() });
  await postProposalUpdate(guild, proposal, `可決・成立しました。法律 ${law.code} はこの時点から有効です。`, { state: '成立' });
  await postGazette(guild, governance, `${law.code} ${law.title}`, `${law.text}\n\n## Provisions\n\n\`\`\`json\n${JSON.stringify(law.provisions, null, 2)}\n\`\`\`\n\ncontent hash: ${law.content_hash}`);
  return proposal;
}

export async function castAndPublishVote(interaction, proposalId, choice) {
  const { governance } = requireGovernance(interaction.guildId);
  if (!governanceActionAllowed(interaction.guildId, interaction.user.id, 'vote')) throw new Error('投票権が制裁により停止されています。');
  const result = castProposalVote(proposalId, interaction.user.id, choice);
  const proposal = result.proposal;
  const label = { yes: '賛成', no: '反対', abstain: '棄権' }[choice];
  await postProposalUpdate(interaction.guild, proposal, `<@${interaction.user.id}> が ${label} に投票しました${result.oldChoice ? ` (変更前: ${result.oldChoice})` : ''}。`);
  writeAudit({ guildId: interaction.guildId, actorType: 'member', actorId: interaction.user.id, action: 'vote.cast', targetType: 'proposal', targetId: proposalId, detail: { oldChoice: result.oldChoice, choice, public: true } });
  return { proposal, governance, choice };
}

export async function fileCriminalCase(guild, reporter, input) {
  requireGovernance(guild.id);
  if (!governanceActionAllowed(guild.id, reporter.id, 'petition')) throw new Error('事件申立てが制裁により停止されています。');
  const law = getLaw(input.lawId);
  if (!law || law.guild_id !== guild.id || law.status !== 'active') throw new Error('有効な法律ではありません。');
  const offense = law.provisions.offenses?.find((entry) => entry.code === input.offenseCode);
  if (!offense) throw new Error('その法律に指定された犯罪構成要件がありません。');
  if (Number(input.evidence.occurredAt) < law.effective_at) throw new Error('法律の施行前の行為には適用できません。');
  requireGovernanceAiAttempt(reporter, input.eventId ?? `case:${reporter.id}:${Date.now()}`);
  let caseRecord = createCase({
    guildId: guild.id,
    reporterId: reporter.id,
    accusedId: input.accused.id,
    lawId: law.id,
    offenseCode: offense.code,
    summary: input.summary,
    status: 'filing',
    defenseUntil: null,
    allegedAt: input.evidence.occurredAt
  });
  addCaseEvidence({ caseId: caseRecord.id, submittedBy: reporter.id, ...input.evidence });
  try {
    return await finishCaseFiling(guild, caseRecord, input.accused);
  } catch (error) {
    updateCase(caseRecord.id, retryPatch(getCase(caseRecord.id), error));
    console.error(`Initial court setup failed for case ${caseRecord.id}:`, error);
    throw new Error(`事件 C-${caseRecord.id} は受理しました。裁判所の作成を自動再試行します。答弁期間は作成完了後に開始します。`);
  }
}

async function finishCaseFiling(guild, caseRecord, accused = null) {
  const { governance, policy } = requireGovernance(guild.id);
  let current = getCase(caseRecord.id);
  const threads = await createCourtThreads(guild, governance, current, {
    accused,
    onPartial: (patch) => { current = updateCase(current.id, patch); }
  });
  const defenseUntil = Date.now() + policy.judiciary.defenseMilliseconds;
  current = updateCase(current.id, {
    status: 'defense',
    public_thread_id: threads.publicThreadId,
    private_thread_id: threads.privateThreadId,
    defense_until: defenseUntil,
    retry_after: null,
    failure_count: 0,
    last_error: null
  });
  await ensureEvidenceDisclosures(guild, current);
  await postCourtUpdate(guild, current, `答弁期限: <t:${Math.floor(defenseUntil / 1000)}:F>`, { state: '答弁' });
  return current;
}

export async function addEvidenceToCase(guild, member, caseId, evidence) {
  const caseRecord = getCase(caseId);
  if (!caseRecord || caseRecord.guild_id !== guild.id) throw new Error('事件が見つかりません。');
  if (!['defense', 'appeal'].includes(caseRecord.status)) throw new Error('証拠受付中ではありません。');
  if (![caseRecord.reporter_id, caseRecord.accused_id].includes(member.id)) throw new Error('この事件の当事者ではありません。');
  if (listCaseEvidence(caseId).length >= CASE_EVIDENCE_LIMIT) {
    throw new Error(`証拠は事件ごとに${CASE_EVIDENCE_LIMIT}件までです。関連する内容を1件の提出にまとめてください。`);
  }
  const id = addCaseEvidence({ caseId, submittedBy: member.id, ...evidence });
  await ensureEvidenceDisclosures(guild, getCase(caseId));
  return id;
}

function evidenceDisclosure(entry) {
  const source = entry.message_id && entry.channel_id
    ? `https://discord.com/channels/${entry.guild_id ?? '@me'}/${entry.channel_id}/${entry.message_id}`
    : '保存された提出';
  return [
    `## 証拠 E-${entry.id}`,
    `提出者: <@${entry.submitted_by}> / 原投稿者: ${entry.author_id ? `<@${entry.author_id}>` : '-'}`,
    `行為時刻: ${entry.occurred_at ? `<t:${Math.floor(entry.occurred_at / 1000)}:F>` : '-'}`,
    `hash: \`${entry.content_hash}\``,
    `source: ${source}`,
    '',
    String(entry.content).slice(0, 1500)
  ].join('\n');
}

async function ensureEvidenceDisclosures(guild, caseRecord) {
  if (!caseRecord?.private_thread_id) return;
  for (const entry of listCaseEvidence(caseRecord.id).filter((row) => !row.disclosed_at)) {
    const withGuild = { ...entry, guild_id: guild.id };
    await postPrivateCourtUpdate(guild, caseRecord, evidenceDisclosure(withGuild));
    markEvidenceDisclosed(entry.id);
  }
}

async function publishDecisionRecord(guild, caseRecord, phase, panel) {
  const evidence = listCaseEvidence(caseRecord.id);
  const publicLines = panel.outputs.map((output, index) => [
    `seat ${index + 1}: ${output.verdict}`,
    `evidence: ${(output.evidenceIds ?? []).map((id) => `E-${id}`).join(', ') || '-'}`,
    `sanction: ${output.sanction ? JSON.stringify(output.sanction) : '-'}`
  ].join(' / '));
  await postCourtUpdate(guild, caseRecord, [
    `判決記録 (${phase})`,
    `法: #${caseRecord.law_id} / 構成要件: ${caseRecord.offense_code}`,
    ...publicLines,
    `証拠hash: ${evidence.map((entry) => `E-${entry.id}=\`${entry.content_hash.slice(0, 16)}\``).join(' ')}`
  ].join('\n'));

  const privateRecord = [
    `# 事件 C-${caseRecord.id} ${phase} パネル判断`,
    '',
    `law: ${caseRecord.law_id} / offense: ${caseRecord.offense_code}`,
    `alleged_at: ${caseRecord.alleged_at ? new Date(caseRecord.alleged_at).toISOString() : '-'}`,
    '',
    ...panel.outputs.map((output, index) => `## seat ${index + 1}\n\n${JSON.stringify(output, null, 2)}`)
  ].join('\n');
  await postPrivateCourtUpdate(guild, caseRecord, '構成要件ごとの判断・理由・採用証拠を添付します。', {
    files: [{ attachment: Buffer.from(privateRecord), name: `case-${caseRecord.id}-${phase}-decision.md` }]
  });
}

export async function fileConstitutionalChallenge(guild, reporter, input) {
  const { policy } = requireGovernance(guild.id);
  let target;
  if (input.targetType === 'law') target = getLaw(input.targetId);
  else if (input.targetType === 'case') target = getCase(input.targetId);
  else if (input.targetType === 'sanction') target = getSanction(input.targetId);
  else if (input.targetType === 'administrative_act') target = getAdministrativeAct(input.targetId);
  if (!target || target.guild_id !== guild.id) throw new Error('審査対象が見つかりません。');
  const existing = findOpenConstitutionalCase(guild.id, input.targetType, input.targetId);
  if (existing) throw new Error(`同じ対象の違憲審査 C-${existing.id} が進行中です。`);
  if (!input.system) {
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
    defenseUntil: null
  });
  addCaseEvidence({ caseId: caseRecord.id, submittedBy: reporter.id, content: input.reason, occurredAt: Date.now() });
  try {
    return await finishCaseFiling(guild, caseRecord);
  } catch (error) {
    updateCase(caseRecord.id, retryPatch(getCase(caseRecord.id), error));
    console.error(`Initial court setup failed for constitutional case ${caseRecord.id}:`, error);
    throw new Error(`違憲審査 C-${caseRecord.id} は受理しました。裁判所の作成を自動再試行します。答弁期間は作成完了後に開始します。`);
  }
}

export async function recordCourtSubmission(message) {
  if (!message?.channel?.isThread?.() || message.author?.bot) return false;
  const caseRecord = getCaseByPrivateThread(message.channelId);
  if (!caseRecord || !['defense', 'appeal'].includes(caseRecord.status)) return false;
  if (![caseRecord.reporter_id, caseRecord.accused_id].filter(Boolean).includes(message.author.id)) return false;
  const phaseCount = listCaseSubmissions(caseRecord.id)
    .filter((entry) => entry.kind === caseRecord.status).length;
  if (phaseCount >= CASE_SUBMISSION_LIMIT_PER_PHASE) {
    await message.reply({
      content: `この審級の主張記録は${CASE_SUBMISSION_LIMIT_PER_PHASE}件が上限です。新しい論点は既存の主張を参照して簡潔にまとめてください。`,
      allowedMentions: { parse: [] }
    }).catch(() => {});
    return false;
  }
  const submission = [
    message.content,
    ...message.attachments.map((attachment) => `[添付] ${attachment.name} ${attachment.url}`)
  ].filter(Boolean).join('\n') || '(本文なし)';
  addCaseSubmission(caseRecord.id, message.author.id, caseRecord.status, submission.slice(0, 8000));
  return true;
}

async function beginAppealWindow(guild, caseRecord, sanction) {
  const { policy } = requireGovernance(guild.id);
  const now = Date.now();
  sanction = updateSanction(sanction.id, {
    status: 'pending_appeal',
    appeal_deadline: now + policy.judiciary.appealMilliseconds,
    restriction_started_at: null
  });
  caseRecord = updateCase(caseRecord.id, { status: 'appeal_window' });
  await postCourtUpdate(guild, caseRecord, `この刑は上訴対象です。期限: <t:${Math.floor(sanction.appeal_deadline / 1000)}:F>。上訴しなければ自動確定します。`, { state: '上訴' });
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

async function adjudicateCriminalCase(guild, caseRecord, phase = 'initial') {
  const { governance, policy } = requireGovernance(guild.id);
  const currentLaw = getLaw(caseRecord.law_id);
  if (!currentLaw || currentLaw.status !== 'active') throw new Error('適用法が現在有効ではありません。');
  const evidence = listCaseEvidence(caseRecord.id);
  const occurredAt = Number(caseRecord.alleged_at);
  if (!Number.isFinite(occurredAt) || occurredAt < currentLaw.effective_at) throw new Error('行為時に有効な法律を確認できません。');
  const offense = currentLaw.provisions.offenses?.find((entry) => entry.code === caseRecord.offense_code);
  if (!offense) throw new Error('犯罪構成要件が法律にありません。');
  const appeal = phase === 'appeal' ? getAppeal(caseRecord.id) : null;
  const panelCase = phase === 'appeal' ? { ...caseRecord, appealGrounds: appeal?.grounds } : caseRecord;
  const panel = await runJudicialPanel({
    guildId: guild.id,
    caseRecord: panelCase,
    law: currentLaw,
    offense,
    evidence,
    submissions: listCaseSubmissions(caseRecord.id),
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
    queueExecution(caseRecord, sanction);
    await postCourtUpdate(guild, getCase(caseRecord.id), '上訴審で原判決を維持し、執行へ進みます。', { state: '確定' });
    return;
  }
  if (approvals > 0) {
    const trustedMembers = governance.trusted_role_id
      ? await guild.members.fetch().then((members) => [...members.values()].filter((member) => !member.user.bot
        && member.roles.cache.has(governance.trusted_role_id)
        && ![caseRecord.accused_id, caseRecord.reporter_id].includes(member.id)))
      : [];
    if (trustedMembers.length < approvals) {
      updateSanction(sanction.id, { status: 'unavailable' });
      updateCase(caseRecord.id, { status: 'unenforceable', finalized_at: Date.now() });
      await postCourtUpdate(guild, getCase(caseRecord.id), `判決は記録しましたが、独立したtrusted承認者が ${trustedMembers.length}/${approvals} 人しかいないため、この刑は執行不能として終了します。`, { state: '確定' });
      return;
    }
    updateCase(caseRecord.id, { status: 'approval' });
    await postCourtUpdate(guild, getCase(caseRecord.id), `責任あり ${policy.judiciary.guiltyVotesRequired}/${policy.judiciary.panelSeats}以上。刑: ${panel.sanction.type}${panel.sanction.durationSeconds ? ` ${panel.sanction.durationSeconds}秒` : ''}。trusted ${approvals}人の執行承認が必要です。`, { state: '承認待ち', components: approvalButtons(caseRecord.id) });
  } else if (appealable) {
    await beginAppealWindow(guild, caseRecord, sanction);
  } else {
    queueExecution(caseRecord, sanction);
  }
}

async function adjudicateConstitutionalCase(guild, caseRecord) {
  const { constitution } = requireGovernance(guild.id);
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
  const constitutionalRecord = [
    `# 違憲審査 C-${caseRecord.id}`,
    '',
    `target: ${caseRecord.challenged_type}:${caseRecord.challenged_id}`,
    '',
    ...panel.outputs.map((output, index) => `## seat ${index + 1}\n\n${JSON.stringify(output, null, 2)}`)
  ].join('\n');
  await postPrivateCourtUpdate(guild, caseRecord, '違憲審査パネルの理由と憲法条文参照を添付します。', {
    files: [{ attachment: Buffer.from(constitutionalRecord), name: `constitutional-case-${caseRecord.id}.md` }]
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
    throw new Error(`行政行為 A-${act.id} は自動取消方法を持ちません。`);
  }
  updateAdministrativeAct(act.id, { status: 'reversed', reversed_at: Date.now() });
  writeAudit({ guildId: guild.id, actorType: 'system', action: 'administrative_act.reversed', targetType: 'administrative_act', targetId: act.id, detail: { operation } });
}

export async function approveCase(interaction, caseId, decision) {
  const { governance, policy } = requireGovernance(interaction.guildId);
  const member = interaction.member ?? await interaction.guild.members.fetch(interaction.user.id);
  if (!governance.trusted_role_id) throw new Error('trusted承認機能は無効です。');
  if (!member.roles.cache.has(governance.trusted_role_id)) throw new Error('trusted roleが必要です。');
  const caseRecord = getCase(caseId);
  if (!caseRecord || caseRecord.guild_id !== interaction.guildId || caseRecord.status !== 'approval') throw new Error('承認待ちの事件ではありません。');
  if ([caseRecord.accused_id, caseRecord.reporter_id].includes(member.id)) throw new Error('被告・通報者は執行承認できません。');
  setCaseApproval(caseId, member.id, decision);
  const sanction = getCaseSanction(caseId);
  const approvals = listCaseApprovals(caseId).filter((entry) => entry.decision === 'approve').length;
  await postCourtUpdate(interaction.guild, caseRecord, `<@${member.id}> が執行を${decision === 'approve' ? '承認' : '拒否'}しました。承認 ${approvals}/${sanction.required_approvals}`);
  if (decision === 'approve' && approvals >= sanction.required_approvals) {
    if (sanction.appealable) await beginAppealWindow(interaction.guild, caseRecord, sanction);
    else queueExecution(caseRecord, sanction);
  }
  return { approvals, required: sanction.required_approvals, policy };
}

export async function appealCase(guild, member, caseId, grounds) {
  const { policy } = requireGovernance(guild.id);
  const caseRecord = getCase(caseId);
  const sanction = getCaseSanction(caseId);
  if (!caseRecord || !sanction || caseRecord.guild_id !== guild.id) throw new Error('事件または刑が見つかりません。');
  if (caseRecord.accused_id !== member.id) throw new Error('被告本人だけが上訴できます。');
  if (caseRecord.status !== 'appeal_window' || !sanction.appealable || Date.now() >= sanction.appeal_deadline) throw new Error('上訴受付中ではありません。');
  if (getAppeal(caseId)) throw new Error('上訴は1回だけです。');
  createAppeal(caseId, member.id, grounds);
  const now = Date.now();
  const submissionsUntil = now + policy.judiciary.defenseMilliseconds;
  updateCase(caseId, { status: 'appeal', retry_after: submissionsUntil, last_error: null });
  updateSanction(sanction.id, { restriction_started_at: now });
  enqueueAction({
    guildId: guild.id,
    actionType: 'appeal_restrict',
    targetId: sanction.id,
    payload: { sanctionId: sanction.id },
    idempotencyKey: `appeal-restrict:${sanction.id}`
  });
  await postCourtUpdate(guild, getCase(caseId), `<@${member.id}> が上訴しました。<t:${Math.floor(submissionsUntil / 1000)}:F>まで裁判チャットで追加主張を受け付け、その後に別の${policy.judiciary.panelSeats}席パネルで再審します。`, { state: '上訴' });
  // live modeではAI再審へ渡す前に発言先を裁判チャットへ限定する。
  await ensureAppealRestriction(guild, sanction.id);
  return getCase(caseId);
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
  if (proposal.retry_after && proposal.retry_after > now) return proposal;
  if (proposal.status === 'drafting') return draftStoredProposal(guild, proposal);
  if (proposal.status === 'draft' && proposal.stage_ends_at <= now) return constitutionalReviewProposal(guild, proposal);
  if (proposal.status === 'constitutional_review') return constitutionalReviewProposal(guild, proposal);
  if (proposal.status === 'debate' && proposal.stage_ends_at <= now) return openProposalVote(guild, proposal);
  if (proposal.status === 'voting' && proposal.stage_ends_at <= now) return closeProposalVote(guild, proposal);
  return proposal;
}

async function advanceCase(guild, caseRecord, now) {
  if (caseRecord.retry_after && caseRecord.retry_after > now) return;
  if (caseRecord.status === 'filing') {
    await finishCaseFiling(guild, caseRecord);
    return;
  }
  if (caseRecord.status === 'defense' && caseRecord.defense_until <= now) {
    await ensureEvidenceDisclosures(guild, caseRecord);
    updateCase(caseRecord.id, { status: 'deliberation', retry_after: null, last_error: null });
    const { policy } = requireGovernance(guild.id);
    await postCourtUpdate(guild, getCase(caseRecord.id), `答弁期間が終了し、${policy.judiciary.panelSeats}席パネルの審理を開始します。`, { state: '審理' });
    if (caseRecord.kind === 'constitutional') await adjudicateConstitutionalCase(guild, getCase(caseRecord.id));
    else await adjudicateCriminalCase(guild, getCase(caseRecord.id));
    return;
  }
  if (caseRecord.status === 'defense') {
    await ensureEvidenceDisclosures(guild, caseRecord);
    return;
  }
  if (caseRecord.status === 'deliberation') {
    if (caseRecord.kind === 'constitutional') await adjudicateConstitutionalCase(guild, caseRecord);
    else await adjudicateCriminalCase(guild, caseRecord);
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
  if (caseRecord.status === 'appeal_window' && sanction?.appeal_deadline <= now && !getAppeal(caseRecord.id)) {
    queueExecution(caseRecord, sanction);
    await postCourtUpdate(guild, getCase(caseRecord.id), '上訴期限内に上訴がなかったため判決が確定しました。', { state: '確定' });
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
    const duplicate = findActiveProposalByNormalizedTitle(guild.id, issue.title);
    if (duplicate) continue;
    const sourceLinks = issue.evidenceMessageIds
      .map((id) => sourceById.get(String(id)))
      .filter(Boolean)
      .map((message) => `https://discord.com/channels/${guild.id}/${message.channelId}/${message.id}`);
    const summary = sourceLinks.length > 0
      ? `${issue.summary}\n\n週次検出の根拠:\n${sourceLinks.join('\n')}`
      : issue.summary;
    try {
      await filePetition(guild, syntheticMember, { title: issue.title, summary, source: 'weekly' });
    } catch (error) {
      // proposalはdraftingで永続化済み。後続issueまで失わずscheduler再試行へ任せる。
      console.error(`Failed to draft weekly proposal ${issue.title}:`, error);
    }
  }
}

let schedulerRunning = false;
let lastPruneAt = 0;

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
    for (const governance of listGovernanceGuilds()) {
      if (governance.status !== 'active') continue;
      const guild = client.guilds.cache.get(governance.guild_id) ?? await client.guilds.fetch(governance.guild_id).catch(() => null);
      if (!guild) continue;
      for (const proposal of listProposals(guild.id, { statuses: ['drafting', 'draft', 'constitutional_review', 'debate', 'voting'], limit: 100 })) {
        try {
          await advanceProposal(guild, proposal, now);
        } catch (error) {
          updateProposal(proposal.id, retryPatch(getProposal(proposal.id), error));
          console.error(`Failed to advance proposal ${proposal.id}:`, error);
        }
      }
      const cases = listCases(guild.id, { statuses: ['filing', 'defense', 'deliberation', 'appeal_window', 'appeal'], limit: 100 });
      for (const caseRecord of cases) {
        try {
          await advanceCase(guild, caseRecord, now);
        } catch (error) {
          updateCase(caseRecord.id, retryPatch(getCase(caseRecord.id), error));
          console.error(`Failed to advance case ${caseRecord.id}:`, error);
        }
      }
      try {
        await runWeeklyReview(guild, governance, now);
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
  await releaseAppealRestriction(guild, governance, sanction.user_id, detail.fallbackChannelIds ?? []);
  if (reverseExternal && sanction.type === 'timeout') {
    const member = await guild.members.fetch(sanction.user_id).catch(() => null);
    await member?.timeout(null, `Sakana sanction ${sanction.id} reversed`).catch(() => {});
  }
  if (reverseExternal && sanction.type === 'ban') {
    await guild.members.unban(sanction.user_id, `Sakana sanction ${sanction.id} reversed`).catch(() => {});
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
      } else if (action.action_type === 'sanction_execute') {
        if (['executed', 'simulated'].includes(sanction.status)) {
          completeAction(action.id);
          continue;
        }
        let detail = { shadow: true };
        const old = parseExecutionDetail(sanction.execution_detail);
        await releaseAppealRestriction(guild, governance, sanction.user_id, old.fallbackChannelIds ?? []);
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
          } else {
            const stableSanction = sanction.type === 'timeout' && !sanction.restriction_started_at
              ? updateSanction(sanction.id, { restriction_started_at: Date.now() })
              : sanction;
            detail = await executeDiscordSanction(guild, stableSanction);
          }
        }
        updateSanction(sanction.id, {
          status: governance.enforcement_mode === 'live' ? 'executed' : 'simulated',
          executed_at: Date.now(),
          execution_detail: JSON.stringify(detail)
        });
        updateCase(sanction.case_id, { status: 'final', finalized_at: Date.now() });
        createAdministrativeAct({
          guildId: guild.id,
          kind: 'judicial_execution',
          actorType: 'system',
          actorId: guild.client.user.id,
          summary: `判決 C-${sanction.case_id} の刑 ${sanction.type} を${governance.enforcement_mode === 'live' ? '執行' : 'shadow記録'}`,
          detail: {
            operation: 'sanction_execution',
            sanctionId: sanction.id,
            caseId: sanction.case_id,
            enforcementMode: governance.enforcement_mode,
            execution: detail
          }
        });
        await postGazette(guild, governance, `判決 C-${sanction.case_id} 執行`, `対象: <@${sanction.user_id}>\n刑: ${sanction.type}${sanction.duration_seconds ? ` ${sanction.duration_seconds}秒` : ''}\nmode: ${governance.enforcement_mode}`);
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
    writeAudit({ guildId: newMember.guild.id, actorType: 'operator', actorId: authorized.authorized_by, action: after ? 'trusted.added' : 'trusted.removed', targetType: 'member', targetId: newMember.id, detail: { roleId: governance.trusted_role_id } });
    await postGazette(newMember.guild, governance, after ? 'trusted user追加' : 'trusted user削除', `対象: <@${newMember.id}>\nrole id: ${governance.trusted_role_id}\nauthorized by: <@${authorized.authorized_by}>`);
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
  const governance = requireGovernance(guild.id).governance;
  if (!governance.trusted_role_id) throw new Error('trusted roleが設定されていません。');
  if (actorId !== guild.ownerId) throw new Error('trusted membershipを変更できるのはDiscord ownerだけです。');
  if (member.user.bot) throw new Error('botはtrusted userにできません。');
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
  if (!governance || governance.trusted_role_id !== role.id) return;
  updateGovernanceGuild(role.guild.id, { trusted_role_id: '' });
  writeAudit({ guildId: role.guild.id, actorType: 'system', action: 'trusted.role_deleted', targetType: 'role', targetId: role.id, detail: { trustedDisabled: true } });
  await postGazette(role.guild, governance, 'trusted user機能を自動無効化', `trusted role ${role.id} が削除されたため拒否権と執行承認を無効化しました。統治workflow自体は停止していません。`);
}

export async function onGuildChannelCreate(channel) {
  const governance = getGovernanceGuild(channel.guildId);
  if (!governance || channel.id === governance.court_chat_channel_id) return;
  await syncAppealRoleOverwrites(channel.guild, governance.appeal_role_id, governance.court_chat_channel_id);
}
