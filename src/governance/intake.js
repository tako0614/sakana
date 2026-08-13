import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  PermissionFlagsBits
} from 'discord.js';
import { parseDiscordRef } from '../agent/format.js';
import {
  appendQueuedProposalInput,
  appendProposalInput,
  claimGovernanceIntake,
  createGovernanceIntake,
  createMentionInvestigation,
  findAcceptedMentionInvestigationForCase,
  findCaseBySummaryEvent,
  findGovernanceIntakeByResult,
  findMentionInvestigationByResult,
  getActiveConstitution,
  getCase,
  getGovernanceGuild,
  getGovernanceIntake,
  getMentionInvestigationBySource,
  getLaw,
  getProposal,
  listPendingGovernanceIntakes,
  listStaleMentionInvestigations,
  listCases,
  listLaws,
  listProposals,
  recordInvestigationEvidence,
  recordInstrumentRelation,
  updateGovernanceIntake,
  updateMentionInvestigation
} from './db.js';
import {
  interpretJudicialRequest,
  interpretLegislativeRequest,
  investigateLegislativeMention,
  reviewLegislativeRelation,
  screenJudicialMention
} from './llm.js';
import {
  activeConstitutionalAmendments,
  activeLawAmendment,
  buildLegislativeCandidates,
  exactActiveProposalMatch
} from './relation.js';
import { postCourtRecord, postProposalUpdate, publicMemberLabel } from './discord.js';
import { collectInvestigationContext, evidenceLink } from './context.js';
import { normalizeActivityContent, sha256 } from './policy.js';
import {
  addEvidenceToCase,
  appealCase,
  fileAmendment,
  fileConstitutionalChallenge,
  fileCriminalCase,
  filePetition,
  reserveGovernanceIntakeAttempt
} from './service.js';

const INTAKE_TTL_MS = 30 * 60_000;
const NO_MENTIONS = { parse: [], repliedUser: true };
const PROCEDURAL_JUDICIARY = /(違憲|上訴|控訴|証拠.{0,8}(?:追加|提出)|事件.{0,8}(?:状況|状態|どうな))/u;

function roleMentioned(message, roleId) {
  return Boolean(roleId && message.mentions?.roles?.has?.(roleId));
}

export function governanceMentionBranch(message, governance = getGovernanceGuild(message?.guildId)) {
  // 他のAI botはコミュニティ参加者として発議できるが、統治bot自身の出力では再帰発火させない。
  if (!governance || (message?.author?.bot && message.author.id === message.client?.user?.id)) return null;
  const legislature = roleMentioned(message, governance.legislature_role_id);
  const judiciary = roleMentioned(message, governance.judiciary_role_id);
  if (legislature && judiciary) return 'ambiguous';
  if (legislature) return 'legislature';
  if (judiciary) return 'judiciary';
  return null;
}

function stripAddressMentions(content, governance, clientId) {
  const ids = [governance.legislature_role_id, governance.judiciary_role_id].filter(Boolean);
  let output = String(content ?? '');
  for (const id of ids) output = output.replaceAll(`<@&${id}>`, ' ');
  if (clientId) output = output.replace(new RegExp(`<@!?${clientId}>`, 'g'), ' ');
  return output.replace(/[^\S\n]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

function safeError(error) {
  const message = String(error?.message ?? error);
  if (/Governance model HTTP|Governance AI is busy|fetch failed|JSON|SQLITE|DiscordAPIError/i.test(message)) {
    return 'AI・Discord・DBの一時エラーです。少し待ってからもう一度呼んでください。';
  }
  return message.slice(0, 500);
}

function linkToThread(guildId, threadId) {
  return `[投稿を開く](https://discord.com/channels/${guildId}/${threadId})`;
}

function sourceLink(guildId, evidence) {
  return evidence?.messageId && evidence?.channelId
    ? `[証拠の投稿を開く](https://discord.com/channels/${guildId}/${evidence.channelId}/${evidence.messageId})`
    : null;
}

function sourceContent(source) {
  return [
    source.content,
    ...source.attachments.map((attachment) => `[添付] ${attachment.name} ${attachment.url}`)
  ].filter(Boolean).join('\n').slice(0, 8000);
}

async function fetchSourceMessage(message, governance) {
  let channelId = message.reference?.channelId ?? message.channelId;
  let messageId = message.reference?.messageId ?? null;
  if (!messageId) {
    const cleaned = stripAddressMentions(message.content, governance, message.client.user?.id);
    if (/https?:\/\/(?:\w+\.)?discord(?:app)?\.com\/channels\//i.test(cleaned)) {
      const parsed = parseDiscordRef(cleaned);
      if (parsed?.guildId && parsed.guildId !== message.guildId) throw new Error('別サーバーのメッセージは証拠にできません。');
      channelId = parsed?.channelId ?? channelId;
      messageId = parsed?.messageId ?? null;
    }
  }
  if (!messageId) return null;
  const channel = await message.guild.channels.fetch(channelId).catch(() => null);
  if (!channel?.isTextBased?.()) throw new Error('証拠メッセージのチャンネルを読めません。');
  const requester = message.member ?? await message.guild.members.fetch(message.author.id);
  if (!channel.permissionsFor(requester)?.has(PermissionFlagsBits.ViewChannel)) {
    throw new Error('自分が閲覧できないメッセージは証拠にできません。');
  }
  const source = await channel.messages.fetch(messageId).catch(() => null);
  if (!source) throw new Error('証拠メッセージが見つかりません。');
  const content = sourceContent(source);
  if (!content) throw new Error('証拠として保存できる本文または添付がありません。');
  return {
    messageId: source.id,
    channelId: source.channelId,
    authorId: source.author.id,
    authorIsBot: source.author.bot,
    content: content.slice(0, 8000),
    occurredAt: source.createdTimestamp
  };
}

async function revalidateInvestigationEvidence(message, rows, partyIds = [], { allowBots = false } = {}) {
  const validated = [];
  for (const row of rows) {
    const channel = await message.guild.channels.fetch(row.channelId).catch(() => null);
    if (!channel?.isTextBased?.()) continue;
    const everyone = message.guild.roles.everyone;
    if (!everyone || !channel.permissionsFor(everyone)?.has(PermissionFlagsBits.ViewChannel)) continue;
    let visible = true;
    for (const userId of new Set(partyIds.filter(Boolean))) {
      const member = await message.guild.members.fetch(userId).catch(() => null);
      if (!member || !channel.permissionsFor(member)?.has(PermissionFlagsBits.ViewChannel)) {
        visible = false;
        break;
      }
    }
    if (!visible) continue;
    const source = await channel.messages.fetch(row.messageId).catch(() => null);
    if (!source || (!allowBots && source.author.bot) || String(source.author.id) !== String(row.authorId)) continue;
    const content = sourceContent(source);
    const currentHash = sha256(normalizeActivityContent(content));
    const plainHash = sha256(normalizeActivityContent(source.content));
    if (row.contentHash && row.contentHash !== currentHash && row.contentHash !== plainHash) continue;
    validated.push({
      messageId: source.id,
      channelId: source.channelId,
      authorId: source.author.id,
      content,
      contentHash: currentHash,
      occurredAt: source.createdTimestamp
    });
  }
  return validated;
}

async function assertEvidenceVisibleTo(guild, evidence, userIds) {
  const channel = await guild.channels.fetch(evidence.channelId).catch(() => null);
  if (!channel?.isTextBased?.()) throw new Error('証拠チャンネルを読めません。');
  for (const userId of new Set(userIds.filter(Boolean))) {
    const member = await guild.members.fetch(userId).catch(() => null);
    if (!member || !channel.permissionsFor(member)?.has(PermissionFlagsBits.ViewChannel)) {
      throw new Error('当事者が閲覧できない場所の内容は証拠にできません。裁判所の事件投稿へ提示してください。');
    }
  }
  const everyone = guild.roles?.everyone;
  if (!everyone || !channel.permissionsFor(everyone)?.has(PermissionFlagsBits.ViewChannel)) {
    throw new Error('裁判は公開審理です。非公開場所の内容は、公開可能な形に整理して裁判所の事件投稿へ提示してください。');
  }
}

function intakeButtons(intake) {
  const queuedTarget = intake.payload.relation?.targetStatus === 'queued';
  const buttons = [
    new ButtonBuilder()
      .setCustomId(`gov:intake:${intake.id}:confirm`)
      .setLabel(intake.action === 'join_discussion'
        ? (queuedTarget ? '待機案に加える' : '既存討議に加える')
        : '審議に進める')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`gov:intake:${intake.id}:cancel`)
      .setLabel('取り消す')
      .setStyle(ButtonStyle.Danger)
  ];
  return [new ActionRowBuilder().addComponents(buttons)];
}

function renderIntake(intake, suffix = '') {
  const payload = intake.payload;
  const pending = intake.status === 'pending' || intake.status === 'processing';
  const queuedTarget = payload.relation?.targetStatus === 'queued' || intake.result_type === 'proposal_queue';
  const joinedDiscussion = intake.action === 'join_discussion'
    || ['proposal_discussion', 'proposal_queue'].includes(intake.result_type);
  const lines = [intake.status === 'completed' ? '## 正式受付済み' : pending ? '## 受付前の確認' : '## 受付結果', ''];
  if ((intake.action === 'petition' || intake.action === 'amendment') && !joinedDiscussion) {
    lines.push(
      `種別: ${intake.action === 'amendment' ? '憲法改正案' : '法律の請願'}`,
      `題名: ${payload.title}`,
      pending ? `内容: ${payload.summary}` : null,
      `投票範囲: ${payload.voteScope === 'trusted' ? `${payload.electorateLabel ?? '特別有権者'}のみ` : '全員'}`
    );
    if (payload.relation?.relation === 'amend_law') {
      lines.push(`改正対象: ${payload.relation.targetTitle}`, `現在の版: v${payload.relation.targetVersion ?? 1}`);
    }
    if (payload.relation?.relation === 'amend_constitution') lines.push(`改正対象: ${payload.relation.targetTitle}`);
    if (payload.relation?.relation === 'separate') lines.push('関連案件とは独立して成立できる別案件として扱います。');
    if (payload.queueBehindTitle) lines.push(`開始時期: 「${payload.queueBehindTitle}」の終了後`);
    if (payload.relation?.reasons?.length) lines.push(`振り分け理由: ${payload.relation.reasons.join(' / ')}`);
  } else if (joinedDiscussion) {
    lines.push(
      queuedTarget ? '種別: 審議待ち案への意見追加' : '種別: 既存討議への意見追加',
      payload.relation?.targetTitle ? `対象: ${payload.relation.targetTitle}` : null,
      pending ? `意見・対案: ${payload.summary}` : null,
      payload.relation?.threadId ? linkToThread(intake.guild_id, payload.relation.threadId) : null,
      payload.relation?.reasons?.length ? `振り分け理由: ${payload.relation.reasons.join(' / ')}` : null
    );
  } else if (intake.action === 'criminal_case') {
    const law = getLaw(payload.lawId);
    const offense = law?.provisions?.offenses?.find((entry) => entry.code === payload.offenseCode);
    lines.push(
      '種別: 法律違反の申立て',
      `被申立人: ${publicMemberLabel(payload.accusedId)}`,
      `適用法候補: ${law?.title ?? '裁判記録に記載'}`,
      offense?.title ? `対象となる違反: ${offense.title}` : null,
      pending ? `申立内容: ${payload.summary}` : null,
      pending ? `証拠: ${sourceLink(intake.guild_id, payload.evidence)}` : null
    );
  } else if (intake.action === 'constitutional_challenge') {
    const target = payload.targetType === 'law'
      ? getLaw(payload.targetId)?.title
      : payload.targetType === 'case'
        ? getCase(payload.targetId)?.summary
        : ({ sanction: '処分', administrative_act: '行政行為' }[payload.targetType] ?? '統治行為');
    lines.push(
      '種別: 違憲審査',
      `対象: ${target ?? '指定した統治行為'}`,
      pending ? `申立理由: ${payload.summary}` : null
    );
  } else if (intake.action === 'evidence') {
    lines.push('種別: 証拠追加', '対象: 指定した裁判', `証拠: ${sourceLink(intake.guild_id, payload.evidence)}`);
  } else if (intake.action === 'appeal') {
    lines.push('種別: 上訴', '対象: 指定した裁判', `上訴理由: ${payload.summary}`);
  }
  lines.push('', suffix || '内容が正しければ「審議に進める」を押してください。押すまでは正式案件になりません。');
  return lines.filter((line) => line !== null).join('\n').slice(0, 2000);
}

function retriedResultText(intake, resultType, result) {
  if (resultType === 'proposal') {
    const acceptedAs = intake.action === 'amendment' ? '改憲案' : '請願';
    const link = result.forum_thread_id ? `\n${linkToThread(intake.guild_id, result.forum_thread_id)}` : '';
    return `「${result.title}」を${acceptedAs}として受理し、草案を公開しました。${link}`;
  }
  if (resultType === 'case') {
    const link = result.public_thread_id ? `\n${linkToThread(intake.guild_id, result.public_thread_id)}` : '';
    return `裁判所の受付処理が完了しました。${link}`;
  }
  return '受付処理が完了しました。';
}

export async function updateRetriedIntakeMessage(guild, resultType, result) {
  const intake = findGovernanceIntakeByResult(guild.id, resultType, result.id);
  if (!intake?.response_message_id) return false;
  const channel = await guild.channels.fetch(intake.channel_id).catch(() => null);
  if (!channel?.isTextBased?.()) return false;
  const message = await channel.messages.fetch(intake.response_message_id).catch(() => null);
  if (!message) return false;
  const completed = { ...intake, last_error: null };
  await message.edit({
    content: renderIntake(completed, retriedResultText(completed, resultType, result)),
    components: [],
    allowedMentions: NO_MENTIONS
  });
  updateGovernanceIntake(intake.id, { last_error: null });
  return true;
}

export async function updateRetriedMentionInvestigationMessage(guild, resultType, result) {
  const investigation = findMentionInvestigationByResult(guild.id, resultType, result.id)
    ?? (resultType === 'case' ? findAcceptedMentionInvestigationForCase(guild.id, result.id) : null);
  if (!investigation || investigation.status !== 'accepted') return false;
  if (resultType === 'proposal') {
    await publishLegislativeInvestigationRecord(guild, investigation, result);
  } else if (resultType === 'case') {
    const screening = investigation.result?.screening;
    const caseIds = investigation.result?.caseIds ?? [result.id];
    const published = new Set((investigation.result?.publishedCaseIds ?? []).map(String));
    const evidenceRows = listInvestigationEvidence(investigation.id, 'judicial_charge');
    for (const caseId of caseIds) {
      const currentCase = getCase(caseId);
      if (!currentCase?.public_thread_id || published.has(String(caseId))) continue;
      const candidate = screening?.candidates?.find((entry) => (
        String(entry.accusedId) === String(currentCase.accused_id)
        && Number(entry.lawId) === Number(currentCase.law_id)
        && entry.offenseCode === currentCase.offense_code
      ));
      if (!candidate) continue;
      const evidence = evidenceRows
        .filter((entry) => candidate.evidenceMessageIds.includes(String(entry.message_id)))
        .map((entry) => ({
          messageId: String(entry.message_id), channelId: String(entry.channel_id),
          authorId: String(entry.author_id), content: entry.content,
          contentHash: entry.content_hash, occurredAt: entry.occurred_at
        }));
      await publishJudicialScreeningRecord(guild, investigation, currentCase, candidate, evidence, {
        outputs: Array.from({ length: Math.max(0, screening.totalSeats - screening.failedSeats) }),
        failedSeats: screening.failedSeats
      });
      published.add(String(caseId));
    }
    const ready = caseIds.every((caseId) => {
      const currentCase = getCase(caseId);
      return currentCase?.public_thread_id && !currentCase.retry_after
        && !['filing', 'summary_review'].includes(currentCase.status);
    });
    updateMentionInvestigation(investigation.id, {
      result: { ...investigation.result, publishedCaseIds: [...published] },
      record_published_at: ready ? Date.now() : null
    });
    if (!ready) return false;
  }
  if (investigation.response_message_id) {
    const channel = await guild.channels.fetch(investigation.channel_id).catch(() => null);
    const response = channel?.isTextBased?.()
      ? await channel.messages.fetch(investigation.response_message_id).catch(() => null)
      : null;
    if (response) {
      const caseLinks = resultType === 'case'
        ? (investigation.result?.caseIds ?? [result.id])
          .map((caseId) => getCase(caseId))
          .filter((caseRecord) => caseRecord?.public_thread_id)
          .map((caseRecord) => linkToThread(guild.id, caseRecord.public_thread_id))
        : [];
      const text = resultType === 'proposal'
        ? `「${result.title}」の公開準備が完了しました。\n${linkToThread(guild.id, result.forum_thread_id)}`
        : `裁判所の公開準備が完了しました。\n${caseLinks.join('\n')}`;
      await response.edit({ content: text, allowedMentions: NO_MENTIONS });
    }
  }
  updateMentionInvestigation(investigation.id, {
    status: 'completed', outcome: 'filed', last_error: null, completed_at: Date.now()
  });
  return true;
}

export async function syncPendingIntakeMessages(guild) {
  const governance = getGovernanceGuild(guild.id);
  const constitution = getActiveConstitution(guild.id);
  if (!governance || !constitution) return 0;
  let updatedCount = 0;
  for (const intake of listPendingGovernanceIntakes(guild.id)) {
    if (!intake.response_message_id) continue;
    let current = intake;
    if (intake.branch === 'legislature') {
      const payload = { ...intake.payload };
      delete payload.allowedVoteScopes;
      const voteScope = constitution.policy.voting.defaultScope;
      current = updateGovernanceIntake(intake.id, {
        payload: {
          ...payload,
          voteScope,
          electorateLabel: governance.trusted_role_id
            ? (guild.roles?.cache?.get?.(governance.trusted_role_id)?.name ?? '特別有権者')
            : '特別有権者'
        }
      });
    }
    const channel = await guild.channels.fetch(current.channel_id).catch(() => null);
    if (!channel?.isTextBased?.()) continue;
    const message = await channel.messages.fetch(current.response_message_id).catch(() => null);
    if (!message) continue;
    await message.edit({
      content: renderIntake(current),
      components: intakeButtons(current),
      allowedMentions: NO_MENTIONS
    });
    updatedCount += 1;
  }
  return updatedCount;
}

async function createPreview(message, branch, action, payload) {
  const intake = createGovernanceIntake({
    guildId: message.guildId,
    branch,
    action,
    requesterId: message.author.id,
    channelId: message.channelId,
    sourceMessageId: message.id,
    payload,
    expiresAt: Date.now() + INTAKE_TTL_MS
  });
  const response = await message.reply({
    content: renderIntake(intake),
    components: intakeButtons(intake),
    allowedMentions: NO_MENTIONS
  });
  updateGovernanceIntake(intake.id, { response_message_id: response.id });
  return true;
}

function reservationMessage(reservation) {
  const retry = reservation.retryAt ? ` <t:${Math.floor(reservation.retryAt / 1000)}:R>に空きます。` : '';
  if (reservation.reason === 'interim_protection') return `一時保全中は自分の裁判事件でだけ発言できます。${retry}`;
  if (reservation.scope === 'sanction') return `現在の判決によりAI受付が制限されています。${retry}`;
  return `AI受付の24時間回数枠に達しました (${reservation.used}/${reservation.limit})。${retry}`;
}

async function appendToExistingDiscussion(interaction, intake, proposal, reasons = []) {
  if (!proposal || proposal.workflow_handler === 'terminal'
    || (!proposal.workflow_handler && ['enacted', 'rejected', 'remanded'].includes(proposal.status))) {
    throw new Error('既存討議は終了しています。改めて新規提案してください。');
  }
  if (proposal.workflow_status === 'queued') {
    const decision = {
      relation: 'join_active',
      targetType: 'proposal',
      targetId: String(proposal.id),
      reasons,
      materialDifferences: intake.payload.relation?.materialDifferences ?? []
    };
    recordInstrumentRelation({
      guildId: interaction.guildId,
      sourceType: 'intake',
      sourceId: intake.id,
      relationType: 'join_active',
      targetType: 'proposal',
      targetId: proposal.id,
      targetHash: proposal.target_hash,
      reasons,
      decision
    });
    appendQueuedProposalInput(proposal.id, {
      intakeId: intake.id,
      userId: interaction.user.id,
      summary: intake.payload.summary
    });
    return {
      type: 'proposal_queue',
      id: proposal.id,
      text: `新しい案件にはせず、審議待ちの「${proposal.title}」に統合しました。先行案件の終了後に討議が始まります。`
    };
  }
  if (!proposal.forum_thread_id) throw new Error('既存案件は草案作成中です。公開後、その討議へ意見を追加してください。');
  const thread = await interaction.guild.channels.fetch(proposal.forum_thread_id).catch(() => null);
  if (!thread?.isTextBased?.()) throw new Error('既存討議を読めません。');
  await thread.send({
    content: [
      `<@${interaction.user.id}> からの意見・対案`,
      intake.payload.summary,
      `元の発言: [投稿を開く](https://discord.com/channels/${interaction.guildId}/${intake.channel_id}/${intake.source_message_id})`
    ].join('\n\n'),
    allowedMentions: { parse: [] }
  });
  const decision = {
    relation: 'join_active',
    targetType: 'proposal',
    targetId: String(proposal.id),
    reasons,
    materialDifferences: intake.payload.relation?.materialDifferences ?? []
  };
  recordInstrumentRelation({
    guildId: interaction.guildId,
    sourceType: 'intake',
    sourceId: intake.id,
    relationType: 'join_active',
    targetType: 'proposal',
    targetId: proposal.id,
    targetHash: proposal.target_hash,
    reasons,
    decision
  });
  return {
    type: 'proposal_discussion',
    id: proposal.id,
    text: `新しい案件にはせず、進行中の「${proposal.title}」へ追加しました。\n${linkToThread(interaction.guildId, proposal.forum_thread_id)}`
  };
}

async function handleLegislature(message, governance, request) {
  const constitution = getActiveConstitution(message.guildId);
  let output = await interpretLegislativeRequest({
    guildId: message.guildId,
    request: { text: request, authorId: message.author.id },
    constitution,
    activeLaws: listLaws(message.guildId)
  });
  if (!['petition', 'amendment'].includes(output.intent)) {
    await message.reply({ content: output.question, allowedMentions: NO_MENTIONS });
    return true;
  }
  const proposals = listProposals(message.guildId, { limit: 100 });
  const currentAmendments = activeConstitutionalAmendments(proposals);
  const currentAmendment = currentAmendments[0] ?? null;
  const exact = exactActiveProposalMatch(output.title, proposals);
  const laws = listLaws(message.guildId, { activeOnly: false, limit: 100 });
  const candidates = buildLegislativeCandidates({
    request,
    normalized: output,
    proposals,
    laws,
    constitution
  });
  const relation = exact ? {
    relation: 'join_active',
    targetType: 'proposal',
    targetId: String(exact.id),
    reasons: ['同じ題名の案件がすでに進行中です。'],
    materialDifferences: [],
    outputs: []
  } : await reviewLegislativeRelation({
    guildId: message.guildId,
    request: { text: request, authorId: message.author.id },
    normalized: output,
    candidates,
    panel: constitution.rules?.panels?.proposalRelation
  });
  const joinsCurrentAmendment = currentAmendment
    && relation.relation === 'join_active'
    && relation.targetType === 'proposal'
    && currentAmendments.some((proposal) => String(proposal.id) === String(relation.targetId));
  if (relation.relation === 'uncertain') {
    await message.reply({ content: relation.reasons[0], allowedMentions: NO_MENTIONS });
    return true;
  }
  const target = relation.targetType && relation.targetId
    ? candidates.find((candidate) => candidate.type === relation.targetType && String(candidate.id) === String(relation.targetId))
    : null;
  if (relation.relation === 'covered') {
    const link = target?.type === 'proposal' && target.threadId
      ? linkToThread(message.guildId, target.threadId)
      : target?.type === 'law' && governance.statute_forum_id
        ? `法令集: <#${governance.statute_forum_id}>`
        : '法令集を確認してください。';
    await message.reply({
      content: `この内容は「${target?.title ?? '現行制度'}」ですでに実現されています。\n${relation.reasons.join(' / ')}\n${link}`.slice(0, 2000),
      allowedMentions: NO_MENTIONS
    });
    return true;
  }
  const isConstitutionalAmendment = output.intent === 'amendment'
    || relation.relation === 'amend_constitution';
  let queueConflict = isConstitutionalAmendment && currentAmendment && !joinsCurrentAmendment
    ? currentAmendment
    : null;
  if (relation.relation === 'amend_law' && target) {
    const currentLawAmendment = activeLawAmendment(proposals, laws, target.id);
    if (currentLawAmendment) queueConflict = currentLawAmendment;
  }
  const relationPayload = {
    relation: relation.relation,
    targetType: relation.targetType,
    targetId: relation.targetId,
    targetTitle: target?.title ?? null,
    targetHash: target?.contentHash ?? null,
    targetVersion: target?.version ?? null,
    targetStatus: target?.status ?? null,
    threadId: target?.threadId ?? null,
    reasons: relation.reasons,
    materialDifferences: relation.materialDifferences,
    panelOutputs: relation.outputs
  };
  if (relation.relation === 'join_active') {
    return createPreview(message, 'legislature', 'join_discussion', {
      title: output.title,
      summary: output.summary,
      relation: relationPayload
    });
  }
  if (relation.relation === 'amend_law') output = {
    ...output,
    intent: 'petition',
    title: `${target.title}の改正`.slice(0, 50),
    summary: `現行の「${target.title}」を次の内容で改正する。${output.summary}`.slice(0, 1800)
  };
  if (relation.relation === 'amend_constitution') output = { ...output, intent: 'amendment' };
  const voteScope = constitution.policy.voting.defaultScope;
  if (voteScope === 'trusted' && !governance.trusted_role_id) {
    throw new Error('既定の投票範囲に使う特別有権者ロールが設定されていません。');
  }
  return createPreview(message, 'legislature', output.intent, {
    title: output.title,
    summary: output.summary,
    voteScope,
    queueBehindTitle: queueConflict?.title ?? null,
    queueBehindProposalId: queueConflict?.id ?? null,
    electorateLabel: governance.trusted_role_id
      ? (message.guild.roles?.cache?.get?.(governance.trusted_role_id)?.name ?? '特別有権者')
      : '特別有権者',
    relation: relationPayload
  });
}

function publicEvidenceLinks(guildId, rows, prefix = '参照') {
  return rows.slice(0, 20).map((row, index) => (
    `[${prefix}${index + 1}](${evidenceLink(guildId, {
      messageId: row.messageId ?? row.message_id,
      channelId: row.channelId ?? row.channel_id
    })})`
  ));
}

function relationRecord(relation) {
  return {
    relation: relation.relation,
    targetType: relation.targetType,
    targetId: relation.targetId,
    reasons: relation.reasons,
    materialDifferences: relation.materialDifferences
  };
}

async function publishLegislativeInvestigationRecord(guild, investigation, proposal) {
  if (!proposal?.forum_thread_id || investigation.record_published_at) return false;
  const evidence = listInvestigationEvidence(investigation.id, 'legislative_basis');
  const result = investigation.result ?? {};
  const analysis = result.analysis ?? {};
  const relation = result.relation ?? {};
  await postProposalUpdate(guild, proposal, [
    'AI調査から正式手続へ移しました。',
    analysis.summary ? `提案内容: ${analysis.summary}` : null,
    analysis.explanation ? `必要性: ${analysis.explanation}` : null,
    relation.reasons?.length ? `既存制度との関係: ${relation.reasons.join(' / ')}` : null,
    evidence.length ? `確認した公開記録: ${publicEvidenceLinks(guild.id, evidence).join('、')}` : '根拠: 呼びかけに書かれた明示的な提案',
    '公開記録は状況把握にだけ使い、個人への非難や過去行為を法文へ取り込みません。'
  ].filter(Boolean).join('\n'));
  updateMentionInvestigation(investigation.id, { record_published_at: Date.now() });
  return true;
}

async function appendInvestigationToProposal(message, investigation, output, proposal, relation) {
  if (!proposal || proposal.workflow_handler === 'terminal'
    || (!proposal.workflow_handler && ['enacted', 'rejected', 'remanded'].includes(proposal.status))) {
    throw new Error('関連する討議は既に終了しています。');
  }
  const decision = relationRecord(relation);
  recordInstrumentRelation({
    guildId: message.guildId,
    sourceType: 'mention_investigation',
    sourceId: investigation.id,
    relationType: 'join_active',
    targetType: 'proposal',
    targetId: proposal.id,
    targetHash: proposal.target_hash,
    reasons: relation.reasons,
    decision
  });
  if (proposal.workflow_status === 'queued') {
    appendQueuedProposalInput(proposal.id, {
      intakeId: `investigation:${investigation.id}`,
      summary: output.summary,
      sourceType: 'mention_investigation'
    });
    return {
      outcome: 'accepted_pending', resultType: 'proposal', resultId: proposal.id,
      text: `同じ論点の「${proposal.title}」が審議待ちです。この内容をそこへ統合しました。`
    };
  }
  if (!proposal.forum_thread_id) {
    appendProposalInput(proposal.id, {
      sourceId: `investigation:${investigation.id}`,
      summary: output.summary,
      sourceType: 'mention_investigation'
    });
    return {
      outcome: 'accepted_pending', resultType: 'proposal', resultId: proposal.id,
      text: `同じ論点の「${proposal.title}」へ統合しました。公開記録の準備は自動で再試行します。`
    };
  }
  const thread = await message.guild.channels.fetch(proposal.forum_thread_id).catch(() => null);
  if (!thread?.isTextBased?.()) throw new Error('関連する討議を開けません。');
  await thread.send({
    content: [
      'AI調査で同じ案件に属する意見として統合しました。',
      `要点: ${output.summary}`,
      relation.reasons?.length ? `理由: ${relation.reasons.join(' / ')}` : null,
      `[元の呼びかけ](https://discord.com/channels/${message.guildId}/${message.channelId}/${message.id})`
    ].filter(Boolean).join('\n'),
    allowedMentions: { parse: [] }
  });
  return {
    outcome: 'joined', resultType: 'proposal', resultId: proposal.id,
    text: `同じ論点の「${proposal.title}」へ統合しました。\n${linkToThread(message.guildId, proposal.forum_thread_id)}`
  };
}

function acceptedProposalResult(error) {
  if (error?.accepted?.resultType !== 'proposal') return null;
  const proposal = getProposal(error.accepted.resultId);
  return proposal ? {
    outcome: 'accepted_pending', resultType: 'proposal', resultId: proposal.id,
    text: `「${proposal.title}」を正式受理しました。公開記録の準備は自動で再試行します。`
  } : null;
}

async function runAutomaticLegislature(message, governance, request, context, investigation) {
  const constitution = getActiveConstitution(message.guildId);
  const laws = listLaws(message.guildId, { activeOnly: false, limit: 100 });
  const output = await investigateLegislativeMention({
    guildId: message.guildId,
    request: { text: request, authorId: message.author.id },
    constitution,
    activeLaws: laws.filter((law) => law.status === 'active'),
    messages: context.messages
  });
  const selected = context.messages.filter((row) => output.evidenceMessageIds.includes(row.messageId));
  const evidence = await revalidateInvestigationEvidence(message, selected, [], { allowBots: true });
  if (output.basis === 'structural_logs' && evidence.length < 2) {
    return { outcome: 'no_action', text: '公開記録を再確認しましたが、継続的な問題として法律化できる根拠が2件に届きませんでした。' };
  }
  if (evidence.length) recordInvestigationEvidence(investigation.id, evidence, 'legislative_basis');
  if (output.intent === 'unclear') return { outcome: 'unclear', text: output.question };
  if (['information', 'no_action'].includes(output.intent)) {
    return { outcome: output.intent, text: output.explanation };
  }

  const proposals = listProposals(message.guildId, { limit: 100 });
  const exact = exactActiveProposalMatch(output.title, proposals);
  const candidates = buildLegislativeCandidates({
    request,
    normalized: output,
    proposals,
    laws,
    constitution
  });
  const relation = exact ? {
    relation: 'join_active', targetType: 'proposal', targetId: String(exact.id),
    reasons: ['同じ内容の案件がすでに進行中です。'], materialDifferences: [], outputs: []
  } : await reviewLegislativeRelation({
    guildId: message.guildId,
    request: { text: request, authorId: message.author.id },
    normalized: output,
    candidates,
    panel: constitution.rules?.panels?.proposalRelation
  });
  const target = relation.targetType && relation.targetId
    ? candidates.find((candidate) => candidate.type === relation.targetType
      && String(candidate.id) === String(relation.targetId))
    : null;
  const storedResult = {
    analysis: {
      intent: output.intent,
      basis: output.basis,
      title: output.title,
      summary: output.summary,
      explanation: output.explanation
    },
    relation: relationRecord(relation)
  };
  updateMentionInvestigation(investigation.id, { outcome: 'routing', result: storedResult });
  if (relation.relation === 'uncertain') {
    return { outcome: 'unclear', text: relation.reasons[0] };
  }
  if (relation.relation === 'covered') {
    const destination = target?.type === 'proposal' && target.threadId
      ? linkToThread(message.guildId, target.threadId)
      : governance.statute_forum_id ? `法令集: <#${governance.statute_forum_id}>` : '法令集を確認してください。';
    return {
      outcome: 'covered',
      text: `この内容は「${target?.title ?? '現行制度'}」ですでに扱われています。\n${relation.reasons.join(' / ')}\n${destination}`
    };
  }
  if (relation.relation === 'join_active') {
    const proposal = proposals.find((entry) => String(entry.id) === String(relation.targetId));
    return appendInvestigationToProposal(message, investigation, output, proposal, relation);
  }

  let normalized = output;
  if (relation.relation === 'amend_law' && target) normalized = {
    ...normalized,
    intent: 'petition',
    title: `${target.title}の改正`.slice(0, 50),
    summary: `現行の「${target.title}」を次の内容で改正する。${output.summary}`.slice(0, 1800)
  };
  if (relation.relation === 'amend_constitution') normalized = { ...normalized, intent: 'amendment' };
  const voteScope = constitution.policy.voting.defaultScope;
  if (voteScope === 'trusted' && !governance.trusted_role_id) {
    throw new Error('既定の投票範囲に使う特別有権者ロールが設定されていません。');
  }
  const official = { id: message.client.user.id };
  const source = `mention_investigation:${investigation.id}`;
  try {
    const proposal = normalized.intent === 'amendment'
      ? await fileAmendment(message.guild, official, {
        title: normalized.title, summary: normalized.summary, voteScope,
        eventId: message.id, attemptReserved: true, relation: relationRecord(relation), source
      })
      : await filePetition(message.guild, official, {
        title: normalized.title, summary: normalized.summary, voteScope,
        eventId: message.id, attemptReserved: true, relation: relationRecord(relation), source
      });
    const currentInvestigation = updateMentionInvestigation(investigation.id, {
      outcome: proposal.workflow_status === 'queued' ? 'queued' : 'filed',
      result_type: 'proposal', result_id: String(proposal.id), result: storedResult
    });
    await publishLegislativeInvestigationRecord(message.guild, currentInvestigation, proposal);
    return {
      outcome: proposal.workflow_status === 'queued' ? 'queued' : 'filed',
      resultType: 'proposal', resultId: proposal.id,
      text: proposal.workflow_status === 'queued'
        ? `「${proposal.title}」を正式受理しました。関連する先行案件の終了後に審議を始めます。`
        : `「${proposal.title}」を正式受理し、討議を始めました。\n${linkToThread(message.guildId, proposal.forum_thread_id)}`
    };
  } catch (error) {
    const accepted = acceptedProposalResult(error);
    if (accepted) return accepted;
    if (/同名の.*案が進行中/.test(String(error?.message))) {
      const duplicate = exactActiveProposalMatch(normalized.title, listProposals(message.guildId, { limit: 100 }));
      if (duplicate) return appendInvestigationToProposal(message, investigation, normalized, duplicate, {
        relation: 'join_active', targetType: 'proposal', targetId: String(duplicate.id),
        reasons: ['受付処理中に同じ内容の案件が先に開始されました。'], materialDifferences: []
      });
    }
    throw error;
  }
}

function caseStatusText(caseRecord, guildId) {
  const status = ({
    filing: '受付中', summary_review: 'AI判定中', summary_active: '即時処分中・裁判請求可',
    defense: '答弁期間', deliberation: '審理中', approval: '執行承認待ち',
    appeal_window: '上訴受付中', appeal: '上訴審理中', execution: '執行処理中', final: '確定',
    overturned: '取消', acquitted: '責任なし', dismissed: '棄却',
    constitutional_uncertain: '違憲判断不能', unenforceable: '執行不能'
  })[caseRecord.status] ?? caseRecord.status;
  const law = caseRecord.law_id ? getLaw(caseRecord.law_id) : null;
  const offense = law?.provisions?.offenses?.find((entry) => entry.code === caseRecord.offense_code);
  const challenged = caseRecord.challenged_type === 'law'
    ? getLaw(caseRecord.challenged_id)
    : caseRecord.challenged_type === 'case'
      ? getCase(caseRecord.challenged_id)
      : null;
  return [
    `${caseRecord.kind === 'constitutional' ? '違憲審査' : '法律違反の申立て'}`,
    `状態: ${status}`,
    caseRecord.accused_id ? `被申立人: ${publicMemberLabel(caseRecord.accused_id)}` : null,
    law ? `適用法: ${law.title}` : null,
    offense?.title ? `対象となる違反: ${offense.title}` : null,
    caseRecord.challenged_type ? `違憲審査対象: ${challenged?.title ?? challenged?.summary ?? ({ sanction: '処分', administrative_act: '行政行為' }[caseRecord.challenged_type] ?? '統治行為')}` : null,
    caseRecord.public_thread_id ? linkToThread(guildId, caseRecord.public_thread_id) : null
  ].filter(Boolean).join('\n');
}

async function handleJudiciary(message, governance, request, evidence, reservation, member) {
  const constitution = getActiveConstitution(message.guildId);
  const output = await interpretJudicialRequest({
    guildId: message.guildId,
    request: {
      text: request,
      authorId: message.author.id,
      repliedEvidence: evidence ? {
        messageId: evidence.messageId,
        channelId: evidence.channelId,
        authorId: evidence.authorId,
        content: evidence.content,
        occurredAt: evidence.occurredAt
      } : null
    },
    constitution,
    activeLaws: listLaws(message.guildId),
    recentCases: listCases(message.guildId, { limit: 25 })
  });
  if (reservation.scope === 'constitutional_challenge' && output.intent !== 'constitutional_challenge') {
    const general = reserveGovernanceIntakeAttempt(member, `${message.id}:general`);
    if (!general.ok) {
      await message.reply({ content: reservationMessage(general), allowedMentions: NO_MENTIONS });
      return true;
    }
  }
  if (output.intent === 'case_status') {
    const caseRecord = getCase(output.caseId);
    if (!caseRecord || caseRecord.guild_id !== message.guildId) throw new Error('事件が見つかりません。');
    await message.reply({ content: caseStatusText(caseRecord, message.guildId), allowedMentions: NO_MENTIONS });
    return true;
  }
  if (['information', 'unclear'].includes(output.intent)) {
    await message.reply({ content: output.question, allowedMentions: NO_MENTIONS });
    return true;
  }
  if (['criminal_case', 'evidence'].includes(output.intent) && !evidence) {
    await message.reply({
      content: output.intent === 'criminal_case'
        ? '対象の発言へ返信して、同じ内容でもう一度 @裁判 を呼んでください。返信元を証拠として固定します。'
        : '追加したい証拠メッセージへ返信して、同じ内容でもう一度 @裁判 を呼んでください。',
      allowedMentions: NO_MENTIONS
    });
    return true;
  }
  if (output.intent === 'criminal_case') {
    if (evidence.authorIsBot) throw new Error('botを被申立人にはできません。');
    await assertEvidenceVisibleTo(message.guild, evidence, [message.author.id, evidence.authorId]);
    return createPreview(message, 'judiciary', output.intent, {
      accusedId: evidence.authorId,
      lawId: output.lawId,
      offenseCode: output.offenseCode,
      summary: output.summary,
      evidence
    });
  }
  if (output.intent === 'constitutional_challenge') {
    return createPreview(message, 'judiciary', output.intent, {
      targetType: output.targetType,
      targetId: output.targetId,
      summary: output.summary,
      constitutionalAttemptReserved: true
    });
  }
  if (output.intent === 'evidence') {
    const caseRecord = getCase(output.caseId);
    if (!caseRecord || caseRecord.guild_id !== message.guildId) throw new Error('事件が見つかりません。');
    await assertEvidenceVisibleTo(message.guild, evidence, [caseRecord.reporter_id, caseRecord.accused_id]);
    return createPreview(message, 'judiciary', output.intent, { caseId: output.caseId, evidence });
  }
  return createPreview(message, 'judiciary', output.intent, {
    caseId: output.caseId,
    summary: output.summary
  });
}

function acceptedCaseResult(error) {
  if (error?.accepted?.resultType !== 'case') return null;
  return getCase(error.accepted.resultId);
}

async function publishJudicialScreeningRecord(guild, investigation, caseRecord, candidate, evidence, panel) {
  if (!caseRecord?.public_thread_id) return false;
  const law = getLaw(candidate.lawId);
  const offense = law?.provisions?.offenses?.find((entry) => entry.code === candidate.offenseCode);
  const links = new Map(evidence.map((row, index) => [row.messageId, `[記録${index + 1}](${evidenceLink(guild.id, row)})`]));
  await postCourtRecord(guild, caseRecord, [
    '## AI事前審査の記録',
    `適用法: ${law?.title ?? '成立法'}`,
    `対象となる違反: ${offense?.title ?? candidate.offenseCode}`,
    `事件化を支持したAI席: ${candidate.supportingSeats}/${panel.outputs.length + panel.failedSeats}`,
    ...candidate.elementEvidence.map((entry) => (
      `- ${entry.element}: ${entry.messageIds.map((id) => links.get(String(id))).filter(Boolean).join('、')}`
    )),
    candidate.reasons?.length ? `事件化の理由: ${candidate.reasons.join(' / ')}` : null,
    '',
    'これは事件を開始するための審査です。有罪・処分は成立法に基づく別の司法パネルが判断します。'
  ].filter((line) => line !== null).join('\n'));
  return true;
}

async function runProceduralJudiciary(message, request, anchor, investigation, reservation, member) {
  const constitution = getActiveConstitution(message.guildId);
  const output = await interpretJudicialRequest({
    guildId: message.guildId,
    request: {
      text: request,
      authorId: message.author.id,
      repliedEvidence: anchor ? {
        messageId: anchor.messageId,
        channelId: anchor.channelId,
        authorId: anchor.authorId,
        content: anchor.content,
        occurredAt: anchor.occurredAt
      } : null
    },
    constitution,
    activeLaws: listLaws(message.guildId),
    recentCases: listCases(message.guildId, { limit: 25 })
  });
  if (reservation.scope === 'constitutional_challenge' && output.intent !== 'constitutional_challenge') {
    const general = reserveGovernanceIntakeAttempt(member, `${message.id}:general`);
    if (!general.ok) return { outcome: 'limited', text: reservationMessage(general) };
  }
  updateMentionInvestigation(investigation.id, { outcome: 'procedural', result: { procedural: output } });
  if (output.intent === 'case_status') {
    const caseRecord = getCase(output.caseId);
    if (!caseRecord || caseRecord.guild_id !== message.guildId) throw new Error('事件が見つかりません。');
    return { outcome: 'information', text: caseStatusText(caseRecord, message.guildId) };
  }
  if (['information', 'unclear'].includes(output.intent)) {
    return { outcome: output.intent, text: output.question };
  }
  if (output.intent === 'constitutional_challenge') {
    try {
      const caseRecord = await fileConstitutionalChallenge(message.guild, { id: message.client.user.id }, {
        targetType: output.targetType,
        targetId: output.targetId,
        reason: output.summary,
        eventId: message.id,
        attemptReserved: true,
        official: true
      });
      return {
        outcome: 'filed', resultType: 'case', resultId: caseRecord.id,
        text: `違憲審査を正式受理しました。\n${linkToThread(message.guildId, caseRecord.public_thread_id)}`
      };
    } catch (error) {
      const accepted = acceptedCaseResult(error);
      if (!accepted) throw error;
      return {
        outcome: 'accepted_pending', resultType: 'case', resultId: accepted.id,
        text: '違憲審査を正式受理しました。公開記録の準備は自動で再試行します。'
      };
    }
  }
  if (output.intent === 'evidence') {
    if (!anchor) return { outcome: 'unclear', text: '追加する投稿へ返信して、もう一度 @裁判 を呼んでください。' };
    const caseRecord = getCase(output.caseId);
    if (!caseRecord || caseRecord.guild_id !== message.guildId) throw new Error('事件が見つかりません。');
    await assertEvidenceVisibleTo(message.guild, anchor, [caseRecord.reporter_id, caseRecord.accused_id]);
    const evidenceId = await addEvidenceToCase(message.guild, member, output.caseId, anchor);
    return { outcome: 'evidence_added', resultType: 'evidence', resultId: evidenceId, text: '証拠を裁判記録へ追加しました。' };
  }
  if (output.intent === 'appeal') {
    const caseRecord = await appealCase(message.guild, member, output.caseId, output.summary);
    return {
      outcome: 'appealed', resultType: 'case', resultId: caseRecord.id,
      text: `上訴を正式受理しました。\n${linkToThread(message.guildId, caseRecord.public_thread_id)}`
    };
  }
  return { outcome: 'unclear', text: output.question ?? '審査対象を特定できませんでした。' };
}

async function runAutomaticJudiciary(message, request, anchor, context, investigation, reservation, member) {
  if (PROCEDURAL_JUDICIARY.test(request)) {
    return runProceduralJudiciary(message, request, anchor, investigation, reservation, member);
  }
  const constitution = getActiveConstitution(message.guildId);
  const laws = listLaws(message.guildId).filter((law) => law.status === 'active');
  const panel = await screenJudicialMention({
    guildId: message.guildId,
    request: { text: request, authorId: message.author.id, targetUserIds: context.targetUserIds },
    constitution,
    activeLaws: laws,
    recentCases: listCases(message.guildId, { limit: 25 }),
    messages: context.messages,
    panel: constitution.rules?.panels?.judicialScreening
  });
  if (panel.outputs.length < panel.required) {
    return { outcome: 'failed_closed', text: '独立したAI席が必要数そろわなかったため、事件化も処分も行いませんでした。' };
  }
  const candidates = panel.candidates.slice(0, context.settings.caseLimit);
  if (!candidates.length) {
    return { outcome: 'no_case', text: '公開記録と成立法を照合しましたが、全構成要件を証拠で確認できる違反は見つかりませんでした。' };
  }
  const results = [];
  const storedCandidates = [];
  const publishedCaseIds = [];
  for (const candidate of candidates) {
    const selected = context.messages.filter((row) => candidate.evidenceMessageIds.includes(row.messageId));
    const evidence = await revalidateInvestigationEvidence(message, selected, [candidate.accusedId]);
    const validIds = new Set(evidence.map((row) => row.messageId));
    if (candidate.elementEvidence.some((entry) => entry.messageIds.every((id) => !validIds.has(String(id))))) continue;
    const accused = await message.guild.members.fetch(candidate.accusedId).catch(() => null);
    if (!accused || accused.user?.bot) continue;
    const summaryEventKey = `ai-screen:${sha256([
      message.guildId,
      candidate.accusedId,
      candidate.lawId,
      candidate.offenseCode,
      ...evidence.map((row) => row.messageId).sort()
    ].join('|'))}`;
    const duplicate = findCaseBySummaryEvent(message.guildId, summaryEventKey);
    if (duplicate) {
      results.push({ caseRecord: duplicate, candidate, evidence, duplicate: true });
      continue;
    }
    recordInvestigationEvidence(investigation.id, evidence, 'judicial_charge');
    storedCandidates.push({
      accusedId: candidate.accusedId,
      lawId: candidate.lawId,
      offenseCode: candidate.offenseCode,
      summary: candidate.summary,
      supportingSeats: candidate.supportingSeats,
      evidenceMessageIds: evidence.map((row) => row.messageId),
      elementEvidence: candidate.elementEvidence
    });
    updateMentionInvestigation(investigation.id, {
      outcome: 'filing',
      result: { screening: {
        failedSeats: panel.failedSeats,
        required: panel.required,
        totalSeats: panel.outputs.length + panel.failedSeats,
        candidates: storedCandidates
      } }
    });
    try {
      const caseRecord = await fileCriminalCase(message.guild, { id: message.client.user.id }, {
        accused,
        lawId: candidate.lawId,
        offenseCode: candidate.offenseCode,
        summary: candidate.summary,
        evidences: evidence,
        eventId: message.id,
        attemptReserved: true,
        summaryEventKey,
        official: true
      });
      results.push({ caseRecord, candidate, evidence, duplicate: false });
    } catch (error) {
      const accepted = acceptedCaseResult(error);
      if (!accepted) throw error;
      results.push({ caseRecord: accepted, candidate, evidence, duplicate: false, pending: true });
    }
  }
  if (!results.length) {
    return { outcome: 'no_case', text: '候補はありましたが、公開性・改変有無・当事者の閲覧権限を再確認できず、事件化も処分も行いませんでした。' };
  }
  for (const result of results) {
    if (!result.duplicate && !result.pending) {
      await publishJudicialScreeningRecord(
        message.guild, investigation, result.caseRecord, result.candidate, result.evidence, panel
      );
      publishedCaseIds.push(String(result.caseRecord.id));
    }
  }
  const links = results
    .filter((result) => result.caseRecord.public_thread_id)
    .map((result) => linkToThread(message.guildId, result.caseRecord.public_thread_id));
  return {
    outcome: results.some((result) => result.pending) ? 'accepted_pending' : 'filed',
    resultType: 'case',
    resultId: (results.find((entry) => entry.pending) ?? results[0]).caseRecord.id,
    result: {
      screening: {
        failedSeats: panel.failedSeats,
        required: panel.required,
        totalSeats: panel.outputs.length + panel.failedSeats,
        candidates: storedCandidates
      },
      caseIds: results.map((entry) => entry.caseRecord.id),
      publishedCaseIds,
      omittedCandidates: Math.max(0, panel.candidates.length - candidates.length)
    },
    text: [
      `${results.length}件を成立法に基づく裁判へ移しました。`,
      ...links,
      panel.candidates.length > candidates.length
        ? `安全上限により、残り${panel.candidates.length - candidates.length}件は今回事件化していません。`
        : null
    ].filter(Boolean).join('\n')
  };
}

async function executeAutomaticInvestigation(message, governance, request, investigation, reservation, member, progress) {
  try {
    const anchor = await fetchSourceMessage(message, governance);
    const context = collectInvestigationContext(message, request, anchor);
    const result = investigation.branch === 'legislature'
      ? await runAutomaticLegislature(message, governance, request, context, investigation)
      : await runAutomaticJudiciary(message, request, anchor, context, investigation, reservation, member);
    const current = getMentionInvestigationBySource(message.id);
    const status = result.outcome === 'accepted_pending' ? 'accepted' : 'completed';
    updateMentionInvestigation(investigation.id, {
      status,
      outcome: result.outcome,
      result_type: result.resultType ?? current?.result_type ?? null,
      result_id: result.resultId === undefined ? (current?.result_id ?? null) : String(result.resultId),
      result: result.result ?? current?.result ?? {},
      last_error: null,
      completed_at: status === 'completed' ? Date.now() : null
    });
    if (typeof progress?.edit === 'function') {
      await progress.edit({ content: result.text.slice(0, 2000), allowedMentions: NO_MENTIONS });
    }
    return true;
  } catch (error) {
    console.error(`Governance ${investigation.branch} investigation failed:`, error);
    const current = getMentionInvestigationBySource(message.id) ?? investigation;
    const retryCount = Number(current.result?.retryCount ?? 0) + 1;
    const retryable = Boolean(error?.governanceRetryHint)
      || /Governance model HTTP|Governance AI is busy|fetch failed|JSON|SQLITE|DiscordAPIError/i.test(String(error?.message ?? error));
    const willRetry = retryable && retryCount < 3;
    updateMentionInvestigation(investigation.id, {
      status: willRetry ? 'processing' : 'failed',
      outcome: willRetry ? 'retrying' : 'failed',
      result: { ...current.result, retryCount },
      last_error: String(error?.message ?? error).slice(0, 500),
      completed_at: willRetry ? null : Date.now()
    });
    if (typeof progress?.edit === 'function') {
      await progress.edit({
        content: willRetry
          ? 'AI・Discord・DBの一時エラーです。調査記録を保持し、自動で再試行します。'
          : `調査を完了できません: ${safeError(error)}`,
        allowedMentions: NO_MENTIONS
      });
    }
    return true;
  }
}

export async function resumePendingMentionInvestigations(guild, now = Date.now()) {
  const governance = getGovernanceGuild(guild.id);
  if (!governance || governance.status !== 'active') return 0;
  let resumed = 0;
  for (const stale of listStaleMentionInvestigations(guild.id, now - 15 * 60_000, 5)) {
    updateMentionInvestigation(stale.id, { outcome: 'resuming', last_error: null });
    const channel = await guild.channels.fetch(stale.channel_id).catch(() => null);
    const source = channel?.isTextBased?.()
      ? await channel.messages.fetch(stale.source_message_id).catch(() => null)
      : null;
    const member = await guild.members.fetch(stale.requester_id).catch(() => null);
    if (!source || !member) {
      updateMentionInvestigation(stale.id, {
        status: 'failed', outcome: 'source_unavailable',
        last_error: '元の呼びかけまたはメンバーを取得できません。', completed_at: Date.now()
      });
      continue;
    }
    let progress = stale.response_message_id
      ? await channel.messages.fetch(stale.response_message_id).catch(() => null)
      : null;
    if (!progress) {
      progress = await source.reply({
        content: '中断したAI調査を再開しています。',
        allowedMentions: NO_MENTIONS
      }).catch(() => null);
      if (progress) updateMentionInvestigation(stale.id, { response_message_id: progress.id });
    }
    const constitutional = stale.branch === 'judiciary'
      && /(違憲|憲法.{0,12}(?:違反|反する)|constitutional)/i.test(stale.request_text);
    await executeAutomaticInvestigation(
      source,
      governance,
      stale.request_text,
      { ...stale, outcome: 'resuming' },
      { ok: true, scope: constitutional ? 'constitutional_challenge' : 'attempt' },
      member,
      progress
    );
    resumed += 1;
  }
  return resumed;
}

export async function handleGovernanceMention(message) {
  const governance = getGovernanceGuild(message?.guildId);
  const branch = governanceMentionBranch(message, governance);
  if (!branch) return false;
  if (branch === 'ambiguous') {
    await message.reply({ content: '@立法 と @裁判 はどちらか一方だけを呼んでください。', allowedMentions: NO_MENTIONS });
    return true;
  }
  if (governance.status !== 'active') {
    await message.reply({ content: '統治機能は現在一時停止中です。', allowedMentions: NO_MENTIONS });
    return true;
  }
  const request = stripAddressMentions(message.content, governance, message.client.user?.id);
  if (!request) {
    await message.reply({
      content: branch === 'legislature'
        ? '作りたい法律、解決したい問題、または改憲したい内容を書いてください。'
        : '審査してほしい内容を書いてください。違反申立てなら対象発言へ返信してください。',
      allowedMentions: NO_MENTIONS
    });
    return true;
  }
  if (getMentionInvestigationBySource(message.id)) return true;
  const constitutional = branch === 'judiciary' && /(違憲|憲法.{0,12}(?:違反|反する)|constitutional)/i.test(request);
  const member = message.member ?? await message.guild.members.fetch(message.author.id).catch(() => null);
  if (!member) {
    await message.reply({ content: 'サーバーメンバー情報を取得できません。', allowedMentions: NO_MENTIONS });
    return true;
  }
  const reservation = reserveGovernanceIntakeAttempt(member, message.id, { constitutional });
  if (!reservation.ok) {
    await message.reply({ content: reservationMessage(reservation), allowedMentions: NO_MENTIONS });
    return true;
  }
  const investigation = createMentionInvestigation({
    guildId: message.guildId,
    branch,
    requesterId: message.author.id,
    channelId: message.channelId,
    sourceMessageId: message.id,
    requestText: request
  });
  await message.channel.sendTyping().catch(() => {});
  const progress = await message.reply({
    content: branch === 'legislature'
      ? '公開記録・現行法・進行中の案件をAIが調べています。必要ならそのまま正式手続へ移します。'
      : '公開記録と成立法を独立したAI席で照合しています。根拠がそろった場合だけ裁判へ移します。',
    allowedMentions: NO_MENTIONS
  });
  updateMentionInvestigation(investigation.id, { response_message_id: progress.id });
  return executeAutomaticInvestigation(message, governance, request, investigation, reservation, member, progress);
}

async function executeIntake(interaction, intake) {
  const member = interaction.member ?? await interaction.guild.members.fetch(interaction.user.id);
  const payload = intake.payload;
  if (['petition', 'amendment'].includes(intake.action)) {
    const proposals = listProposals(interaction.guildId, { limit: 500 });
    const exact = exactActiveProposalMatch(payload.title, proposals);
    if (exact) {
      return appendToExistingDiscussion(interaction, intake, exact, [
        '同じ題名の案件がすでに進行中です。'
      ]);
    }
  }
  if (intake.action === 'petition') {
    const result = await filePetition(interaction.guild, member, {
      title: payload.title,
      summary: payload.summary,
      voteScope: payload.voteScope,
      eventId: intake.source_message_id,
      attemptReserved: true,
      relation: payload.relation
    });
    if (result.workflow_status === 'queued') {
      return { type: 'proposal', id: result.id, text: `「${payload.title}」を審議待ちとして受理しました。先行案件の終了後、最新版を基礎に自動で開始します。` };
    }
    return { type: 'proposal', id: result.id, text: `「${payload.title}」を受理しました。\n${linkToThread(interaction.guildId, result.forum_thread_id)}` };
  }
  if (intake.action === 'amendment') {
    const result = await fileAmendment(interaction.guild, member, {
      title: payload.title,
      summary: payload.summary,
      voteScope: payload.voteScope,
      eventId: intake.source_message_id,
      attemptReserved: true,
      relation: payload.relation
    });
    if (result.workflow_status === 'queued') {
      return { type: 'proposal', id: result.id, text: `「${payload.title}」を改憲の審議待ちとして受理しました。先行案の終了後、現行憲法を基礎に自動で起草します。` };
    }
    return { type: 'proposal', id: result.id, text: `「${payload.title}」を改憲案として受理しました。\n${linkToThread(interaction.guildId, result.forum_thread_id)}` };
  }
  if (intake.action === 'join_discussion') {
    const relation = payload.relation;
    if (relation.targetType !== 'proposal' || !relation.targetId) throw new Error('既存案件を特定できません。');
    const proposal = listProposals(interaction.guildId, { limit: 100 })
      .find((entry) => String(entry.id) === String(relation.targetId));
    return appendToExistingDiscussion(interaction, intake, proposal, relation.reasons);
  }
  if (intake.action === 'criminal_case') {
    await assertEvidenceVisibleTo(interaction.guild, payload.evidence, [interaction.user.id, payload.accusedId]);
    const accused = await interaction.guild.members.fetch(payload.accusedId);
    const result = await fileCriminalCase(interaction.guild, member, {
      accused,
      lawId: payload.lawId,
      offenseCode: payload.offenseCode,
      summary: payload.summary,
      evidence: payload.evidence,
      eventId: intake.source_message_id,
      attemptReserved: true
    });
    return { type: 'case', id: result.id, text: result.public_thread_id
      ? `法律違反の申立てを受理しました。\n${linkToThread(interaction.guildId, result.public_thread_id)}`
      : '法律違反の申立てを受理し、AI判定を開始しました。処分がある場合は本人へ通知します。' };
  }
  if (intake.action === 'constitutional_challenge') {
    const result = await fileConstitutionalChallenge(interaction.guild, member, {
      targetType: payload.targetType,
      targetId: payload.targetId,
      reason: payload.summary,
      eventId: intake.source_message_id,
      attemptReserved: Boolean(payload.constitutionalAttemptReserved)
    });
    return { type: 'case', id: result.id, text: `違憲審査を受理しました。\n${linkToThread(interaction.guildId, result.public_thread_id)}` };
  }
  if (intake.action === 'evidence') {
    const caseRecord = getCase(payload.caseId);
    if (!caseRecord || caseRecord.guild_id !== interaction.guildId) throw new Error('事件が見つかりません。');
    await assertEvidenceVisibleTo(interaction.guild, payload.evidence, [caseRecord.reporter_id, caseRecord.accused_id]);
    const id = await addEvidenceToCase(interaction.guild, member, payload.caseId, payload.evidence);
    return { type: 'evidence', id, text: '証拠を裁判記録へ追加しました。' };
  }
  if (intake.action === 'appeal') {
    const result = await appealCase(interaction.guild, member, payload.caseId, payload.summary);
    return { type: 'appeal', id: result.id, text: '上訴を受理しました。' };
  }
  throw new Error('未対応の受付種別です。');
}

export async function handleGovernanceIntakeComponent(interaction, intakeId, value) {
  const intake = getGovernanceIntake(intakeId);
  if (!intake || intake.guild_id !== interaction.guildId) {
    await interaction.reply({ content: '受付が見つかりません。', flags: MessageFlags.Ephemeral });
    return true;
  }
  if (intake.requester_id !== interaction.user.id) {
    await interaction.reply({ content: '発議・申立てを開始した本人だけが確定できます。', flags: MessageFlags.Ephemeral });
    return true;
  }
  if (intake.status !== 'pending' || intake.expires_at <= Date.now()) {
    await interaction.reply({ content: 'この受付は確定済み、取消済み、または期限切れです。', flags: MessageFlags.Ephemeral });
    return true;
  }
  if (value === 'cancel') {
    const updated = updateGovernanceIntake(intake.id, { status: 'cancelled' });
    await interaction.update({
      content: renderIntake(updated, '本人が取り消しました。正式案件にはなっていません。'),
      components: [],
      allowedMentions: { parse: [] }
    });
    return true;
  }
  if (value !== 'confirm') {
    await interaction.reply({ content: '未対応の受付操作です。', flags: MessageFlags.Ephemeral });
    return true;
  }
  const claimed = claimGovernanceIntake(intake.id, interaction.user.id);
  if (!claimed) {
    await interaction.reply({ content: 'この受付は既に処理されています。', flags: MessageFlags.Ephemeral });
    return true;
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    const result = await executeIntake(interaction, claimed);
    const completed = updateGovernanceIntake(claimed.id, {
      status: 'completed',
      result_type: result.type,
      result_id: result.id,
      last_error: null
    });
    await interaction.message.edit({
      content: renderIntake(completed, result.text),
      components: [],
      allowedMentions: { parse: [] }
    }).catch(() => {});
    await interaction.editReply(result.text);
  } catch (error) {
    console.error(`Governance intake ${claimed.id} execution failed:`, error);
    if (error?.accepted?.resultType && error?.accepted?.resultId) {
      const accepted = updateGovernanceIntake(claimed.id, {
        status: 'completed',
        result_type: error.accepted.resultType,
        result_id: error.accepted.resultId,
        last_error: String(error.message).slice(0, 500)
      });
      await interaction.message.edit({
        content: renderIntake(accepted, '受け付けました。準備ができると公開記録に表示されます。'),
        components: [],
        allowedMentions: { parse: [] }
      }).catch(() => {});
      await interaction.editReply(error.message);
      return true;
    }
    const failed = updateGovernanceIntake(claimed.id, { status: 'failed', last_error: String(error?.message ?? error).slice(0, 500) });
    await interaction.message.edit({
      content: renderIntake(failed, '受付処理に失敗しました。重複防止のため再実行はしません。内容を直して新しく呼び出してください。'),
      components: [],
      allowedMentions: { parse: [] }
    }).catch(() => {});
    await interaction.editReply(`実行できません: ${safeError(error)}`);
  }
  return true;
}

export async function updateExpiredIntakeMessages(client, intakes) {
  let updated = 0;
  for (const intake of intakes) {
    if (!intake.response_message_id) continue;
    const channel = await client.channels.fetch(intake.channel_id).catch(() => null);
    if (!channel?.isTextBased?.()) continue;
    const message = await channel.messages.fetch(intake.response_message_id).catch(() => null);
    if (!message) continue;
    const expired = { ...intake, status: 'expired' };
    await message.edit({
      content: renderIntake(expired, '確認期限が切れました。正式案件にはなっていません。必要なら改めて呼び出してください。'),
      components: [],
      allowedMentions: NO_MENTIONS
    }).catch(() => {});
    updated += 1;
  }
  return updated;
}
