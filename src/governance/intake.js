import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  PermissionFlagsBits
} from 'discord.js';
import { parseDiscordRef } from '../agent/format.js';
import {
  claimGovernanceIntake,
  createGovernanceIntake,
  getActiveConstitution,
  getCase,
  getGovernanceGuild,
  getGovernanceIntake,
  getLaw,
  listCases,
  listLaws,
  updateGovernanceIntake
} from './db.js';
import { interpretJudicialRequest, interpretLegislativeRequest } from './llm.js';
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
      throw new Error('当事者が閲覧できない場所の内容は証拠にできません。共有可能な裁判チャットへ提示してください。');
    }
  }
}

function intakeButtons(intake, disabled = false) {
  const buttons = [];
  if (intake.branch === 'legislature') {
    const scopes = intake.payload.allowedVoteScopes ?? ['all'];
    if (scopes.includes('all')) {
      buttons.push(new ButtonBuilder()
        .setCustomId(`gov:intake:${intake.id}:scope_all`)
        .setLabel(`${intake.payload.voteScope === 'all' ? '✓ ' : ''}全員投票`)
        .setStyle(intake.payload.voteScope === 'all' ? ButtonStyle.Primary : ButtonStyle.Secondary)
        .setDisabled(disabled));
    }
    if (scopes.includes('trusted')) {
      buttons.push(new ButtonBuilder()
        .setCustomId(`gov:intake:${intake.id}:scope_trusted`)
        .setLabel(`${intake.payload.voteScope === 'trusted' ? '✓ ' : ''}trusted投票`)
        .setStyle(intake.payload.voteScope === 'trusted' ? ButtonStyle.Primary : ButtonStyle.Secondary)
        .setDisabled(disabled));
    }
  }
  buttons.push(
    new ButtonBuilder()
      .setCustomId(`gov:intake:${intake.id}:confirm`)
      .setLabel('この内容で正式受付')
      .setStyle(ButtonStyle.Success)
      .setDisabled(disabled),
    new ButtonBuilder()
      .setCustomId(`gov:intake:${intake.id}:cancel`)
      .setLabel('取り消す')
      .setStyle(ButtonStyle.Danger)
      .setDisabled(disabled)
  );
  return [new ActionRowBuilder().addComponents(buttons)];
}

function renderIntake(intake, suffix = '') {
  const payload = intake.payload;
  const lines = [`## ${intake.branch === 'legislature' ? '立法' : '裁判'} 受付内容`, ''];
  if (intake.action === 'petition' || intake.action === 'amendment') {
    lines.push(
      `種別: ${intake.action === 'amendment' ? '憲法改正案' : '法律の請願'}`,
      `題名: ${payload.title}`,
      `内容: ${payload.summary}`,
      `投票scope: ${payload.voteScope === 'trusted' ? 'trusted user' : '全員'}`
    );
  } else if (intake.action === 'criminal_case') {
    const law = getLaw(payload.lawId);
    lines.push(
      '種別: 法律違反の申立て',
      `被申立人: <@${payload.accusedId}>`,
      `適用法候補: #${payload.lawId} ${law?.code ?? ''} / ${payload.offenseCode}`,
      `申立内容: ${payload.summary}`,
      `証拠: ${sourceLink(intake.guild_id, payload.evidence)}`
    );
  } else if (intake.action === 'constitutional_challenge') {
    lines.push(
      '種別: 違憲審査',
      `対象: ${payload.targetType}:${payload.targetId}`,
      `申立理由: ${payload.summary}`
    );
  } else if (intake.action === 'evidence') {
    lines.push('種別: 証拠追加', `事件: C-${payload.caseId}`, `証拠: ${sourceLink(intake.guild_id, payload.evidence)}`);
  } else if (intake.action === 'appeal') {
    lines.push('種別: 上訴', `事件: C-${payload.caseId}`, `上訴理由: ${payload.summary}`);
  }
  lines.push('', suffix || 'まだ正式案件ではありません。内容を確認して本人が確定してください。');
  return lines.join('\n').slice(0, 2000);
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
  if (reservation.scope === 'sanction') return `現在の判決によりAI受付が制限されています。${retry}`;
  return `AI受付の24時間回数枠に達しました (${reservation.used}/${reservation.limit})。${retry}`;
}

async function handleLegislature(message, governance, request) {
  const constitution = getActiveConstitution(message.guildId);
  const output = await interpretLegislativeRequest({
    guildId: message.guildId,
    request: { text: request, authorId: message.author.id },
    constitution,
    activeLaws: listLaws(message.guildId)
  });
  if (!['petition', 'amendment'].includes(output.intent)) {
    await message.reply({ content: output.question, allowedMentions: NO_MENTIONS });
    return true;
  }
  if (output.voteScope === 'trusted' && !governance.trusted_role_id) {
    output.voteScope = 'all';
  }
  return createPreview(message, 'legislature', output.intent, {
    title: output.title,
    summary: output.summary,
    voteScope: output.voteScope,
    allowedVoteScopes: constitution.policy.voting.allowedScopes.filter((scope) => (
      scope !== 'trusted' || Boolean(governance.trusted_role_id)
    ))
  });
}

function caseStatusText(caseRecord, guildId) {
  return [
    `C-${caseRecord.id} / ${caseRecord.kind}`,
    `状態: ${caseRecord.status}`,
    caseRecord.accused_id ? `被申立人: <@${caseRecord.accused_id}>` : null,
    caseRecord.law_id ? `適用法: #${caseRecord.law_id} / ${caseRecord.offense_code}` : null,
    caseRecord.challenged_type ? `違憲審査対象: ${caseRecord.challenged_type}:${caseRecord.challenged_id}` : null,
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
    await message.reply({ content: `統治機能は現在 ${governance.status} です。`, allowedMentions: NO_MENTIONS });
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
  if (intake.action === 'petition') {
    const result = await filePetition(interaction.guild, member, {
      title: payload.title,
      summary: payload.summary,
      voteScope: payload.voteScope,
      eventId: intake.source_message_id,
      attemptReserved: true
    });
    return { type: 'proposal', id: result.id, text: `法案 L-${result.id} を受理しました。\n${linkToThread(interaction.guildId, result.forum_thread_id)}` };
  }
  if (intake.action === 'amendment') {
    const result = await fileAmendment(interaction.guild, member, {
      title: payload.title,
      summary: payload.summary,
      voteScope: payload.voteScope,
      eventId: intake.source_message_id,
      attemptReserved: true
    });
    return { type: 'proposal', id: result.id, text: `改憲案 L-${result.id} を受理しました。\n${linkToThread(interaction.guildId, result.forum_thread_id)}` };
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
    return { type: 'case', id: result.id, text: `事件 C-${result.id} を受理しました。\n${linkToThread(interaction.guildId, result.public_thread_id)}` };
  }
  if (intake.action === 'constitutional_challenge') {
    const result = await fileConstitutionalChallenge(interaction.guild, member, {
      targetType: payload.targetType,
      targetId: payload.targetId,
      reason: payload.summary,
      eventId: intake.source_message_id,
      attemptReserved: Boolean(payload.constitutionalAttemptReserved)
    });
    return { type: 'case', id: result.id, text: `違憲審査 C-${result.id} を受理しました。\n${linkToThread(interaction.guildId, result.public_thread_id)}` };
  }
  if (intake.action === 'evidence') {
    const caseRecord = getCase(payload.caseId);
    if (!caseRecord || caseRecord.guild_id !== interaction.guildId) throw new Error('事件が見つかりません。');
    await assertEvidenceVisibleTo(interaction.guild, payload.evidence, [caseRecord.reporter_id, caseRecord.accused_id]);
    const id = await addEvidenceToCase(interaction.guild, member, payload.caseId, payload.evidence);
    return { type: 'evidence', id, text: `証拠 E-${id} を事件 C-${payload.caseId} に追加しました。` };
  }
  if (intake.action === 'appeal') {
    const result = await appealCase(interaction.guild, member, payload.caseId, payload.summary);
    return { type: 'appeal', id: result.id, text: `事件 C-${result.id} の上訴を受理しました。` };
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
  if (value === 'scope_all' || value === 'scope_trusted') {
    const scope = value === 'scope_trusted' ? 'trusted' : 'all';
    if (intake.branch !== 'legislature' || !intake.payload.allowedVoteScopes?.includes(scope)) {
      await interaction.reply({ content: 'この投票scopeは選べません。', flags: MessageFlags.Ephemeral });
      return true;
    }
    const updated = updateGovernanceIntake(intake.id, { payload: { ...intake.payload, voteScope: scope } });
    await interaction.update({ content: renderIntake(updated), components: intakeButtons(updated), allowedMentions: { parse: [] } });
    return true;
  }
  if (value === 'cancel') {
    const updated = updateGovernanceIntake(intake.id, { status: 'cancelled' });
    await interaction.update({
      content: renderIntake(updated, '本人が取り消しました。正式案件にはなっていません。'),
      components: intakeButtons(updated, true),
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
      content: renderIntake(completed, `正式受付済み: ${result.type} ${result.id}`),
      components: intakeButtons(completed, true),
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
        content: renderIntake(accepted, `正式受付済み: ${error.accepted.resultType} ${error.accepted.resultId}（自動再試行中）`),
        components: intakeButtons(accepted, true),
        allowedMentions: { parse: [] }
      }).catch(() => {});
      await interaction.editReply(error.message);
      return true;
    }
    const failed = updateGovernanceIntake(claimed.id, { status: 'failed', last_error: String(error?.message ?? error).slice(0, 500) });
    await interaction.message.edit({
      content: renderIntake(failed, '受付処理に失敗しました。重複防止のため再実行はしません。内容を直して新しく呼び出してください。'),
      components: intakeButtons(failed, true),
      allowedMentions: { parse: [] }
    }).catch(() => {});
    await interaction.editReply(`実行できません: ${safeError(error)}`);
  }
  return true;
}
