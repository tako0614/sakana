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
  claimGovernanceIntake,
  createGovernanceIntake,
  findGovernanceIntakeByResult,
  getActiveConstitution,
  getCase,
  getGovernanceGuild,
  getGovernanceIntake,
  getLaw,
  listPendingGovernanceIntakes,
  listCases,
  listLaws,
  listProposals,
  recordInstrumentRelation,
  updateGovernanceIntake
} from './db.js';
import { interpretJudicialRequest, interpretLegislativeRequest, reviewLegislativeRelation } from './llm.js';
import {
  activeConstitutionalAmendments,
  activeLawAmendment,
  buildLegislativeCandidates,
  exactActiveProposalMatch
} from './relation.js';
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

function roleMentioned(message, roleId) {
  return Boolean(roleId && message.mentions?.roles?.has?.(roleId));
}

export function governanceMentionBranch(message, governance = getGovernanceGuild(message?.guildId)) {
  if (!governance || message?.author?.bot) return null;
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
  return `https://discord.com/channels/${guildId}/${threadId}`;
}

function sourceLink(guildId, evidence) {
  return evidence?.messageId && evidence?.channelId
    ? `https://discord.com/channels/${guildId}/${evidence.channelId}/${evidence.messageId}`
    : null;
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
  const content = [
    source.content,
    ...source.attachments.map((attachment) => `[添付] ${attachment.name} ${attachment.url}`)
  ].filter(Boolean).join('\n');
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
      `被申立人: <@${payload.accusedId}>`,
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
      `元の発言: https://discord.com/channels/${interaction.guildId}/${intake.channel_id}/${intake.source_message_id}`
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
    caseRecord.accused_id ? `被申立人: <@${caseRecord.accused_id}>` : null,
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
  await message.channel.sendTyping().catch(() => {});
  try {
    if (branch === 'legislature') return await handleLegislature(message, governance, request);
    const evidence = await fetchSourceMessage(message, governance);
    return await handleJudiciary(message, governance, request, evidence, reservation, member);
  } catch (error) {
    console.error(`Governance ${branch} intake failed:`, error);
    await message.reply({ content: `受付を整理できません: ${safeError(error)}`, allowedMentions: NO_MENTIONS });
    return true;
  }
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
        content: renderIntake(accepted, 'AI・Discord処理を自動再試行しています。'),
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
