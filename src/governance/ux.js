import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  MessageFlags,
  ModalBuilder,
  RoleSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
  UserSelectMenuBuilder
} from 'discord.js';
import { governanceCategoryName, isGovernanceOperator, parseOperationalSetting } from './config.js';
import {
  createAdministrativeAct,
  getActiveConstitution,
  getCaseSanction,
  getConstitution,
  getGovernanceGuild,
  getOperationalSetting,
  governanceNotificationStats,
  listActionFailures,
  listCaseApprovals,
  listCases,
  listNotificationFailures,
  listProposals,
  proposalVoteSummary,
  retryFailedActions,
  retryFailedNotifications,
  setOperationalSetting,
  updateGovernanceGuild,
  writeAudit
} from './db.js';
import {
  GOVERNANCE_PROCEDURE_NAME,
  GOVERNANCE_PROCEDURE_TOPIC,
  createGovernanceProcedureChannel,
  ensureGovernanceCourtForum,
  ensureGovernanceOperationsThread,
  governanceProcedureOverwrites,
  governancePermissionReport,
  postAuthorityChange,
  publicMemberLabel,
  retireGovernanceCourtChat
} from './discord.js';
import {
  beginGovernanceNotification,
  caseApprovalNotification,
  finishGovernanceNotification,
  proposalVoteNotification,
  reconcileGovernanceNotificationMessage,
  rejectGovernanceNotification
} from './notifications.js';
import { setTrustedMember } from './service.js';
import { summaryProcedure } from './policy.js';

const EPHEMERAL = MessageFlags.Ephemeral;
const ACTIVE_CASE_STATUSES = ['filing', 'summary_review', 'summary_active', 'defense', 'deliberation', 'approval', 'appeal_window', 'appeal', 'execution'];

function proposalHandler(proposal) {
  if (proposal.workflow_handler) return proposal.workflow_handler;
  const constitution = getConstitution(proposal.constitution_id);
  const key = proposal.kind === 'amendment' ? 'constitutionalAmendment' : 'law';
  return constitution?.rules?.workflows?.[key]?.states?.[proposal.status]?.handler ?? null;
}

function activeProposals(guildId, limit = 100) {
  return listProposals(guildId, { limit }).filter((proposal) => proposal.workflow_status !== 'queued'
    && proposalHandler(proposal) !== 'terminal');
}

function queuedProposals(guildId, limit = 100) {
  return listProposals(guildId, { limit })
    .filter((proposal) => proposal.workflow_status === 'queued')
    .sort((left, right) => Number(left.id) - Number(right.id));
}

function stateLabel(governance) {
  return governance.status === 'active' ? '稼働中' : '停止中';
}

function enforcementLabel(governance) {
  return governance.enforcement_mode === 'live' ? '実執行' : '記録のみ';
}

async function electorateLabel(guild, governance) {
  if (!governance.trusted_role_id) return '未設定';
  const role = guild.roles.cache.get(governance.trusted_role_id)
    ?? await guild.roles.fetch(governance.trusted_role_id).catch(() => null);
  return role ? `「${role.name}」(<@&${role.id}>)` : 'ロール削除済み（機能停止）';
}

function activeCounts(guildId) {
  return {
    proposals: activeProposals(guildId).length,
    queued: queuedProposals(guildId).length,
    cases: listCases(guildId, { statuses: ACTIVE_CASE_STATUSES, limit: 100 }).length
  };
}

function workflowFailures(governance) {
  return [
    ...activeProposals(governance.guild_id)
      .filter((proposal) => proposal.last_error)
      .map((proposal) => `${proposal.title}: ${proposal.last_error}`),
    ...listCases(governance.guild_id, { statuses: ACTIVE_CASE_STATUSES, limit: 100 })
      .filter((caseRecord) => caseRecord.last_error)
      .map((caseRecord) => `${caseRecord.summary}: ${caseRecord.last_error}`),
    ...(governance.weekly_last_error ? [`自律起案: ${governance.weekly_last_error}`] : [])
  ];
}

function overwriteBits(values = []) {
  return values.reduce((bits, value) => bits | BigInt(value), 0n);
}

export function requiredPermissionOverwritesMatch(channel, expected) {
  const current = channel.permissionOverwrites?.cache;
  if (!current) return false;
  return expected.every((entry) => {
    const overwrite = current.get(entry.id);
    return overwrite
      && (entry.type === undefined || overwrite.type === entry.type)
      && (entry.allow ?? []).every((permission) => overwrite.allow.has(permission) && !overwrite.deny.has(permission))
      && (entry.deny ?? []).every((permission) => overwrite.deny.has(permission) && !overwrite.allow.has(permission));
  });
}

export async function reconcileRequiredPermissionOverwrites(channel, expected, reason) {
  const merged = new Map([...channel.permissionOverwrites.cache.values()].map((overwrite) => [overwrite.id, {
    id: overwrite.id,
    type: overwrite.type,
    allow: overwrite.allow.bitfield,
    deny: overwrite.deny.bitfield
  }]));
  for (const entry of expected) {
    const current = merged.get(entry.id) ?? { id: entry.id, type: entry.type, allow: 0n, deny: 0n };
    const requiredAllow = overwriteBits(entry.allow ?? []);
    const requiredDeny = overwriteBits(entry.deny ?? []);
    merged.set(entry.id, {
      id: entry.id,
      type: entry.type ?? current.type,
      allow: (current.allow | requiredAllow) & ~requiredDeny,
      deny: (current.deny | requiredDeny) & ~requiredAllow
    });
  }
  // Appeal roleやサーバー独自のoverwriteを残したまま、公開性に必要なbitだけを補正する。
  await channel.permissionOverwrites.set([...merged.values()], reason);
}

function componentsMatch(message, expected) {
  const currentJson = message.components.map((row) => row.toJSON());
  const expectedJson = expected.map((row) => row.toJSON());
  return JSON.stringify(currentJson) === JSON.stringify(expectedJson);
}

function operationsComponents(governance) {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('gov:admin:toggle_state')
        .setLabel(governance.status === 'active' ? '受付を一時停止' : '受付を再開')
        .setStyle(governance.status === 'active' ? ButtonStyle.Danger : ButtonStyle.Success),
      new ButtonBuilder().setCustomId('gov:admin:enforcement')
        .setLabel(governance.enforcement_mode === 'live' ? '実執行を停止' : '実執行を診断')
        .setStyle(governance.enforcement_mode === 'live' ? ButtonStyle.Secondary : ButtonStyle.Danger),
      new ButtonBuilder().setCustomId('gov:admin:settings').setLabel('AI利用上限').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('gov:admin:weekly_toggle')
        .setLabel(getOperationalSetting(governance.guild_id, 'weekly_scan_enabled') === 1 ? '自律起案 ON' : '自律起案 OFF')
        .setStyle(getOperationalSetting(governance.guild_id, 'weekly_scan_enabled') === 1 ? ButtonStyle.Success : ButtonStyle.Secondary)
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('gov:admin:electorate').setLabel('特別有権者を設定').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('gov:admin:notifications').setLabel('通知上限').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('gov:admin:recovery').setLabel('診断・復旧').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setLabel('公開手続を開く').setStyle(ButtonStyle.Link)
        .setURL(`https://discord.com/channels/${governance.guild_id}/${governance.procedure_channel_id}`)
    )
  ];
}

export async function renderGovernanceOperationsPanel(guild, governance) {
  const constitution = getActiveConstitution(guild.id);
  const permissions = governancePermissionReport(guild);
  const failures = listActionFailures(guild.id);
  const workflows = workflowFailures(governance);
  const counts = activeCounts(guild.id);
  const electorate = await electorateLabel(guild, governance);
  const electorateName = governance.trusted_role_id
    ? (guild.roles.cache.get(governance.trusted_role_id)?.name ?? '特別有権者')
    : '特別有権者';
  const weeklyEnabled = getOperationalSetting(guild.id, 'weekly_scan_enabled') === 1;
  const notificationStats = governanceNotificationStats(guild.id);
  return {
    content: [
      `# ${guild.name} Bot技術運用`,
      '',
      'この画面は `/governance` を実行した運営者だけに表示されています。投票・承認などの統治手続は公開チャンネルで行います。',
      '',
      `状態: **${stateLabel(governance)}** / 執行: **${enforcementLabel(governance)}**`,
      `憲法: v${constitution?.version ?? '?'} / 法案 ${counts.proposals}件 / 事件 ${counts.cases}件`,
      `Bot権限: ${permissions.ok ? 'OK' : `不足: ${permissions.missing.join('、')}`}`,
      `失敗した処理: ${failures.length + workflows.length}件`,
      `特別有権者: ${electorate}`,
      `自律起案: ${weeklyEnabled ? '有効' : '無効'} / 週最大 ${getOperationalSetting(guild.id, 'weekly_draft_limit')}件`,
      `AI受付: 一般 ${getOperationalSetting(guild.id, 'general_daily_calls')}回/日 / ${electorateName} ${getOperationalSetting(guild.id, 'trusted_daily_calls')}回/日`,
      `通知上限: 全体 ${getOperationalSetting(guild.id, 'notification_everyone_daily_limit')}回 / ${electorateName} ${getOperationalSetting(guild.id, 'notification_trusted_daily_limit')}回 / 当事者1人 ${getOperationalSetting(guild.id, 'notification_user_daily_limit')}回（各24時間）`,
      `通知実績（24時間）: 送信 ${notificationStats.delivered} / 上限・権限で抑制 ${notificationStats.suppressed} / 失敗 ${notificationStats.failed}`,
      '',
      `公開手続: <#${governance.procedure_channel_id}>`,
      'ここで変更できるのはBotの運用値だけです。憲法・投票・司法policyは改憲手続を経なければ変更できません。'
    ].join('\n').slice(0, 1_900),
    components: operationsComponents(governance),
    allowedMentions: { parse: [] }
  };
}

function safeLabel(value, maximum = 60) {
  return String(value ?? '').replace(/[\[\]()*_`]/g, '').replace(/\s+/g, ' ').trim().slice(0, maximum);
}

function deadline(value, prefix = '締切') {
  return value ? ` / ${prefix} <t:${Math.floor(Number(value) / 1000)}:R>` : '';
}

function procedureComponents(governance, supportsImmediateReview) {
  const link = (label, channelId) => new ButtonBuilder().setLabel(label).setStyle(ButtonStyle.Link)
    .setURL(`https://discord.com/channels/${governance.guild_id}/${channelId}`);
  const destinations = [
    link('議会', governance.parliament_forum_id),
    link('裁判所', governance.court_forum_id),
    link('法令集', governance.statute_forum_id),
    governance.operations_thread_id ? link('運営変更', governance.operations_thread_id) : null
  ].filter(Boolean);
  return [
    new ActionRowBuilder().addComponents(...destinations),
    supportsImmediateReview ? new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('gov:review_list:0').setLabel('自分の即時処分を確認').setStyle(ButtonStyle.Primary)
    ) : null
  ].filter(Boolean);
}

function actionLink(guildId, channelId, label) {
  return new ButtonBuilder().setLabel(label).setStyle(ButtonStyle.Link)
    .setURL(`https://discord.com/channels/${guildId}/${channelId}`);
}

function voteActionComponents(guildId, proposal) {
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`gov:vote:${proposal.id}:yes`).setLabel('賛成').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`gov:vote:${proposal.id}:no`).setLabel('反対').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`gov:vote:${proposal.id}:abstain`).setLabel('棄権').setStyle(ButtonStyle.Secondary),
    actionLink(guildId, proposal.forum_thread_id, '本文・議論')
  )];
}

function approvalActionComponents(guildId, caseRecord) {
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`gov:approve:${caseRecord.id}:approve`).setLabel('執行承認').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`gov:approve:${caseRecord.id}:reject`).setLabel('承認しない').setStyle(ButtonStyle.Danger),
    actionLink(guildId, caseRecord.public_thread_id, '判決記録')
  )];
}

function sanctionName(sanction) {
  const name = ({
    warning: '警告', restriction: '機能制限', timeout: 'タイムアウト', kick: 'キック', ban: 'BAN'
  })[sanction?.type] ?? '処分';
  if (!sanction?.duration_seconds) return name;
  const seconds = Number(sanction.duration_seconds);
  if (seconds % 86_400 === 0) return `${name} ${seconds / 86_400}日`;
  if (seconds % 3_600 === 0) return `${name} ${seconds / 3_600}時間`;
  return `${name} ${Math.ceil(seconds / 60)}分`;
}

export function renderProposalVoteAction(guild, proposal) {
  const summary = proposalVoteSummary(proposal.id);
  const notification = proposalVoteNotification(guild, proposal);
  return {
    key: `vote:${proposal.id}`,
    notification,
    content: [
      notification.mention,
      `**${safeLabel(proposal.title, 180)}**`,
      `対象: ${proposal.vote_scope === 'all' ? '全員' : '特別有権者'}${deadline(proposal.stage_ends_at)}`,
      `現在: 賛成 ${summary.yes} / 反対 ${summary.no} / 棄権 ${summary.abstain}`,
      '下のボタンから記名投票できます。選び直すと票が更新されます。'
    ].join('\n').slice(0, 1_900),
    components: voteActionComponents(guild.id, proposal),
    allowedMentions: { parse: [] }
  };
}

export function renderCaseApprovalAction(guild, caseRecord) {
  const sanction = getCaseSanction(caseRecord.id);
  const approved = listCaseApprovals(caseRecord.id).filter((entry) => entry.decision === 'approve').length;
  const notification = caseApprovalNotification(guild, caseRecord, sanction);
  return {
    key: `approve:${caseRecord.id}`,
    notification,
    content: [
      notification.mention,
      `**${safeLabel(caseRecord.summary, 180)}**`,
      caseRecord.accused_id ? `対象: ${publicMemberLabel(caseRecord.accused_id)}` : null,
      `処分: ${sanctionName(sanction)} / 承認 ${approved}/${sanction?.required_approvals ?? '?'}人`,
      '特別有権者は下のボタンから記名で判断します。被申立人と申立人は承認できません。'
    ].filter(Boolean).join('\n').slice(0, 1_900),
    components: approvalActionComponents(guild.id, caseRecord),
    allowedMentions: { parse: [] }
  };
}

export function renderGovernanceActionCards(guild) {
  const proposals = activeProposals(guild.id, 100)
    .filter((proposal) => proposalHandler(proposal) === 'public_vote' && proposal.forum_thread_id);
  const approvals = listCases(guild.id, { statuses: ['approval'], limit: 100 })
    .filter((caseRecord) => caseRecord.public_thread_id && getCaseSanction(caseRecord.id));
  return [
    ...proposals.map((proposal) => renderProposalVoteAction(guild, proposal)),
    ...approvals.map((caseRecord) => renderCaseApprovalAction(guild, caseRecord))
  ];
}

function actionCardKey(message) {
  for (const row of message.components ?? []) {
    for (const component of row.components ?? []) {
      const customId = component.customId ?? component.data?.custom_id;
      const match = String(customId ?? '').match(/^gov:(vote|approve):(\d+):/);
      if (match) return `${match[1]}:${match[2]}`;
    }
  }
  return null;
}

export async function syncGovernanceActionCards(guild, channel) {
  const expected = renderGovernanceActionCards(guild);
  const activeKeys = new Set(expected.map((card) => card.key));
  const recent = await channel.messages.fetch({ limit: 100 }).catch(() => null);
  const existing = new Map();
  for (const message of recent?.values?.() ?? []) {
    if (message.author.id !== guild.client.user.id) continue;
    const key = actionCardKey(message);
    if (!key) continue;
    if (!existing.has(key)) existing.set(key, []);
    existing.get(key).push(message);
  }
  for (const card of expected) {
    const messages = existing.get(card.key) ?? [];
    const message = messages.shift() ?? null;
    const { key: _key, notification, ...payload } = card;
    if (!message) {
      const delivery = beginGovernanceNotification(guild, notification);
      try {
        const sent = await channel.send({
          ...payload,
          allowedMentions: delivery?.allowedMentions ?? { parse: [] }
        });
        if (delivery) finishGovernanceNotification(notification, sent);
      } catch (error) {
        if (delivery) rejectGovernanceNotification(notification, error);
        throw error;
      }
    } else {
      reconcileGovernanceNotificationMessage(notification, message);
      const editPayload = { ...payload, allowedMentions: { parse: [] } };
      if (message.content !== editPayload.content || !componentsMatch(message, editPayload.components)) {
        await message.edit(editPayload);
      }
    }
    for (const duplicate of messages) await duplicate.delete().catch(() => {});
    existing.delete(card.key);
  }
  for (const [key, messages] of existing) {
    if (activeKeys.has(key)) continue;
    for (const message of messages) await message.delete().catch(() => {});
  }
  return expected.length;
}

export async function renderGovernanceProcedureHub(guild, governance) {
  const supportsImmediateReview = Boolean(summaryProcedure(getActiveConstitution(guild.id)?.policy));
  const voting = activeProposals(guild.id, 100).filter((proposal) => proposalHandler(proposal) === 'public_vote');
  const approvals = listCases(guild.id, { statuses: ['approval'], limit: 20 });
  return {
    content: [
      `# ${guild.name} 手続`,
      '',
      `法律や改憲の提案は <@&${governance.legislature_role_id}>、違反申立てや上訴は <@&${governance.judiciary_role_id}> に自然文で話してください。`,
      '投票と執行承認が始まると、この下に操作カードが出ます。本文と議論は議会・裁判所、現行法は法令集にあります。',
      '',
      voting.length || approvals.length
        ? `いま操作できる案件: 投票 ${voting.length}件 / 承認 ${approvals.length}件`
        : 'いま操作できる案件はありません。'
    ].filter(Boolean).join('\n').slice(0, 1_900),
    components: procedureComponents(governance, supportsImmediateReview),
    allowedMentions: { parse: [] }
  };
}

async function fetchTrackedMessage(channel, id, prefix) {
  if (id) {
    const message = await channel.messages.fetch(id).catch(() => null);
    if (message) return message;
  }
  const recent = await channel.messages.fetch({ limit: 50 }).catch(() => null);
  return recent?.find((message) => message.author.id === channel.client.user.id && message.content.startsWith(prefix)) ?? null;
}

export async function ensureGovernanceUx(guild, governance = getGovernanceGuild(guild.id)) {
  if (!governance) throw new Error('統治機能が初期化されていません。');
  let current = governance;
  const category = current.category_id ? await guild.channels.fetch(current.category_id).catch(() => null) : null;
  if (!category || category.type !== ChannelType.GuildCategory) throw new Error('統治カテゴリが見つかりません。');
  const oldCategoryName = `${guild.name}`.slice(0, 89) + ' Governance';
  if (category.name === oldCategoryName) await category.setName(governanceCategoryName(guild.name), '統治UXの既定名へ移行');

  await retireGovernanceCourtChat(guild, current);
  const court = await ensureGovernanceCourtForum(guild, current);
  if (current.court_chat_channel_id !== court.id) {
    current = updateGovernanceGuild(guild.id, { court_chat_channel_id: court.id });
  }

  let procedure = current.procedure_channel_id
    ? await guild.channels.fetch(current.procedure_channel_id).catch(() => null)
    : null;
  if (!procedure || procedure.type !== ChannelType.GuildText) {
    procedure = await createGovernanceProcedureChannel(guild, category.id);
  }
  if (procedure.name !== GOVERNANCE_PROCEDURE_NAME) {
    await procedure.setName(GOVERNANCE_PROCEDURE_NAME, '公開手続の名称を同期');
  }
  if (procedure.topic !== GOVERNANCE_PROCEDURE_TOPIC) {
    await procedure.setTopic(GOVERNANCE_PROCEDURE_TOPIC, '統治手続の説明を同期');
  }
  const procedureOverwrites = governanceProcedureOverwrites(guild);
  if (!requiredPermissionOverwritesMatch(procedure, procedureOverwrites)) {
    await reconcileRequiredPermissionOverwrites(procedure, procedureOverwrites, '手続を公開読み取り専用に同期');
  }

  const siblings = [...guild.channels.cache.values()].filter((channel) => channel.parentId === category.id);
  const firstPosition = Math.min(...siblings.map((channel) => channel.position));
  if (Number.isFinite(firstPosition) && procedure.position !== firstPosition) {
    await procedure.setPosition(firstPosition, { reason: '手続をカテゴリ先頭へ移動' });
  }

  if (procedure.id !== current.procedure_channel_id) {
    current = updateGovernanceGuild(guild.id, { procedure_channel_id: procedure.id });
  }
  let procedureMessage = await fetchTrackedMessage(procedure, current.procedure_message_id, `# ${guild.name} 手続`);
  if (!procedureMessage) {
    procedureMessage = await fetchTrackedMessage(procedure, '', `# ${guild.name} 進行中`);
  }
  if (!procedureMessage) procedureMessage = await procedure.send(await renderGovernanceProcedureHub(guild, current));
  if (procedureMessage.id !== current.procedure_message_id) {
    current = updateGovernanceGuild(guild.id, { procedure_message_id: procedureMessage.id });
  }
  await ensureGovernanceOperationsThread(guild, current, procedureMessage);
  current = getGovernanceGuild(guild.id);
  const dashboard = await renderGovernanceProcedureHub(guild, current);
  if (procedureMessage.content !== dashboard.content || !componentsMatch(procedureMessage, dashboard.components)) {
    await procedureMessage.edit(dashboard);
  }
  await syncGovernanceActionCards(guild, procedure);
  return { governance: current, procedure, procedureMessage };
}

async function refreshDashboard(interaction) {
  const ux = await ensureGovernanceUx(interaction.guild, getGovernanceGuild(interaction.guildId));
  if (interaction.message?.content?.startsWith(`# ${interaction.guild.name} Bot技術運用`)) {
    await interaction.message.edit(await renderGovernanceOperationsPanel(interaction.guild, ux.governance)).catch(() => {});
  }
  return ux;
}

function requireOperator(interaction) {
  if (!isGovernanceOperator(interaction.member)) throw new Error('この操作はサーバーownerまたは設定済み運営者だけが実行できます。');
}

function requireOwner(interaction) {
  if (interaction.user.id !== interaction.guild.ownerId) throw new Error('特別有権者を変更できるのはサーバーownerだけです。');
}

function settingsModal(guildId) {
  const input = (id, label, value) => new TextInputBuilder()
    .setCustomId(id).setLabel(label).setStyle(TextInputStyle.Short).setRequired(true).setValue(String(value));
  return new ModalBuilder()
    .setCustomId('gov:admin_modal:settings')
    .setTitle('AI回数と起案上限')
    .addComponents(
      new ActionRowBuilder().addComponents(input('weekly_draft_limit', '自律起案の週最大件数', getOperationalSetting(guildId, 'weekly_draft_limit'))),
      new ActionRowBuilder().addComponents(input('general_daily_calls', '一般参加者のAI受付回数/日', getOperationalSetting(guildId, 'general_daily_calls'))),
      new ActionRowBuilder().addComponents(input('trusted_daily_calls', '特別有権者のAI受付回数/日', getOperationalSetting(guildId, 'trusted_daily_calls')))
    );
}

function notificationSettingsModal(guildId) {
  const input = (id, label, value) => new TextInputBuilder()
    .setCustomId(id).setLabel(label).setStyle(TextInputStyle.Short).setRequired(true).setValue(String(value));
  return new ModalBuilder()
    .setCustomId('gov:admin_modal:notifications')
    .setTitle('通知上限（24時間）')
    .addComponents(
      new ActionRowBuilder().addComponents(input('notification_everyone_daily_limit', '全体通知（0で停止・最大10）', getOperationalSetting(guildId, 'notification_everyone_daily_limit'))),
      new ActionRowBuilder().addComponents(input('notification_trusted_daily_limit', '特別有権者通知（0で停止・最大50）', getOperationalSetting(guildId, 'notification_trusted_daily_limit'))),
      new ActionRowBuilder().addComponents(input('notification_user_daily_limit', '当事者1人あたり（0で停止・最大20）', getOperationalSetting(guildId, 'notification_user_daily_limit')))
    );
}

function electoratePanel(governance) {
  const roleSelect = new RoleSelectMenuBuilder()
    .setCustomId('gov:admin_role:set')
    .setPlaceholder('特別有権者として使うロールを選択')
    .setMinValues(1).setMaxValues(1);
  if (governance.trusted_role_id) roleSelect.setDefaultRoles(governance.trusted_role_id);
  return {
    content: 'ロール名はサーバー側で自由に変更できます。メンバー追加・削除はownerの操作だけを正本として受け付けます。',
    components: [
      new ActionRowBuilder().addComponents(roleSelect),
      new ActionRowBuilder().addComponents(
        new UserSelectMenuBuilder().setCustomId('gov:admin_user:add').setPlaceholder('特別有権者へ追加').setMinValues(1).setMaxValues(1)
      ),
      new ActionRowBuilder().addComponents(
        new UserSelectMenuBuilder().setCustomId('gov:admin_user:remove').setPlaceholder('特別有権者から削除').setMinValues(1).setMaxValues(1)
      ),
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('gov:admin:disable_electorate').setLabel('特別有権者機能を無効化').setStyle(ButtonStyle.Danger)
      )
    ],
    flags: EPHEMERAL
  };
}

function diagnostics(guild, governance) {
  const permission = governancePermissionReport(guild);
  const failures = listActionFailures(guild.id);
  const workflows = workflowFailures(governance);
  const constitution = getActiveConstitution(guild.id);
  const blockers = [
    governance.status !== 'active' ? '統治機能が一時停止中です' : null,
    !constitution ? '有効な憲法がありません' : null,
    !permission.ok ? `Bot権限不足: ${permission.missing.join('、')}` : null,
    failures.length > 0 ? `失敗したDiscord処理が${failures.length}件あります` : null,
    workflows.length > 0 ? `再試行中の統治手続きが${workflows.length}件あります` : null
  ].filter(Boolean);
  const warnings = governance.trusted_role_id
    ? []
    : ['特別有権者が未設定のため、承認を必要とする重い刑は執行不能になります。'];
  return { blockers, warnings };
}

function liveConfirmationModal(guild) {
  return new ModalBuilder()
    .setCustomId('gov:admin_modal:live')
    .setTitle('実執行を有効化')
    .addComponents(new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('server_name').setLabel(`確認のため「${guild.name}」と入力`)
        .setStyle(TextInputStyle.Short).setRequired(true)
    ));
}

export async function handleGovernanceUxInteraction(interaction) {
  const customId = interaction.customId ?? '';
  if (!customId.startsWith('gov:admin')) return false;
  requireOperator(interaction);
  const governance = getGovernanceGuild(interaction.guildId);
  if (!governance) throw new Error('統治機能が初期化されていません。');

  if (interaction.isModalSubmit() && customId === 'gov:admin_modal:settings') {
    const keys = ['weekly_draft_limit', 'general_daily_calls', 'trusted_daily_calls'];
    const updates = [];
    for (const key of keys) {
      const parsed = parseOperationalSetting(key, interaction.fields.getTextInputValue(key));
      if (!parsed.ok) throw new Error(parsed.error);
      updates.push([key, parsed.value]);
    }
    for (const [key, value] of updates) setOperationalSetting(interaction.guildId, key, value, interaction.user.id);
    createAdministrativeAct({ guildId: interaction.guildId, kind: 'operational_settings', actorId: interaction.user.id, summary: 'AI受付と自律起案の設定を変更', detail: Object.fromEntries(updates) });
    await interaction.reply({ content: 'AI受付と自律起案の設定を更新しました。', flags: EPHEMERAL });
    await refreshDashboard(interaction);
    return true;
  }
  if (interaction.isModalSubmit() && customId === 'gov:admin_modal:notifications') {
    const keys = [
      'notification_everyone_daily_limit',
      'notification_trusted_daily_limit',
      'notification_user_daily_limit'
    ];
    const updates = [];
    for (const key of keys) {
      const parsed = parseOperationalSetting(key, interaction.fields.getTextInputValue(key));
      if (!parsed.ok) throw new Error(parsed.error);
      updates.push([key, parsed.value]);
    }
    for (const [key, value] of updates) setOperationalSetting(interaction.guildId, key, value, interaction.user.id);
    createAdministrativeAct({
      guildId: interaction.guildId,
      kind: 'notification_settings',
      actorId: interaction.user.id,
      summary: '通知上限を変更',
      detail: Object.fromEntries(updates)
    });
    await interaction.reply({ content: '通知上限を更新しました。0にした対象への新しい通知は停止します。', flags: EPHEMERAL });
    await refreshDashboard(interaction);
    return true;
  }
  if (interaction.isModalSubmit() && customId === 'gov:admin_modal:live') {
    if (interaction.fields.getTextInputValue('server_name').trim() !== interaction.guild.name) {
      throw new Error('サーバー名が一致しません。実執行へ切り替えていません。');
    }
    const current = getGovernanceGuild(interaction.guildId);
    const report = diagnostics(interaction.guild, current);
    if (report.blockers.length > 0) throw new Error(report.blockers.join(' / '));
    updateGovernanceGuild(interaction.guildId, { enforcement_mode: 'live' });
    createAdministrativeAct({ guildId: interaction.guildId, kind: 'enforcement_mode', actorId: interaction.user.id, summary: '実執行を有効化', detail: { before: current.enforcement_mode, after: 'live' } });
    writeAudit({ guildId: interaction.guildId, actorType: 'operator', actorId: interaction.user.id, action: 'enforcement.live', targetType: 'guild', targetId: interaction.guildId });
    await postAuthorityChange(interaction.guild, getGovernanceGuild(interaction.guildId), '実執行を有効化', `運営者: <@${interaction.user.id}>`);
    await interaction.reply({ content: '実執行を有効化しました。', flags: EPHEMERAL });
    await refreshDashboard(interaction);
    return true;
  }
  if (interaction.isRoleSelectMenu() && customId === 'gov:admin_role:set') {
    requireOwner(interaction);
    const role = interaction.roles.first();
    if (!role || role.managed || role.id === interaction.guildId) throw new Error('選択したロールは使用できません。');
    if (role.position >= interaction.guild.members.me.roles.highest.position) throw new Error('Botの最高ロールより下のロールを選んでください。');
    updateGovernanceGuild(interaction.guildId, { trusted_role_id: role.id });
    createAdministrativeAct({ guildId: interaction.guildId, kind: 'trusted_role', actorId: interaction.user.id, summary: `特別有権者ロールを${role.name}に変更`, detail: { before: governance.trusted_role_id, after: role.id } });
    writeAudit({ guildId: interaction.guildId, actorType: 'operator', actorId: interaction.user.id, action: 'trusted.role_changed', targetType: 'role', targetId: role.id, detail: { before: governance.trusted_role_id } });
    await postAuthorityChange(interaction.guild, getGovernanceGuild(interaction.guildId), '特別有権者ロール変更', `変更後: ${role.name}\n運営者: <@${interaction.user.id}>`);
    await interaction.reply({ content: `特別有権者ロールを「${role.name}」に変更しました。`, flags: EPHEMERAL });
    await refreshDashboard(interaction);
    return true;
  }
  if (interaction.isUserSelectMenu() && (customId === 'gov:admin_user:add' || customId === 'gov:admin_user:remove')) {
    requireOwner(interaction);
    const user = interaction.users.first();
    const member = await interaction.guild.members.fetch(user.id);
    const desired = customId.endsWith(':add');
    const changed = await setTrustedMember(interaction.guild, interaction.user.id, member, desired);
    if (changed) createAdministrativeAct({ guildId: interaction.guildId, kind: desired ? 'trusted_member_add' : 'trusted_member_remove', actorId: interaction.user.id, summary: `${member.id}の特別有権者資格を変更`, detail: { userId: member.id, desired } });
    await interaction.reply({ content: changed ? `${member.user.username}を${desired ? '追加' : '削除'}しました。` : '既にその状態です。', flags: EPHEMERAL });
    await refreshDashboard(interaction);
    return true;
  }
  if (!interaction.isButton()) return false;

  if (customId === 'gov:admin:refresh') {
    await interaction.deferReply({ flags: EPHEMERAL });
    await refreshDashboard(interaction);
    await interaction.editReply('技術運用パネルと公開の手続を更新しました。');
    return true;
  }
  if (customId === 'gov:admin:toggle_state') {
    const next = governance.status === 'active' ? 'paused' : 'active';
    updateGovernanceGuild(interaction.guildId, { status: next });
    createAdministrativeAct({ guildId: interaction.guildId, kind: 'governance_status', actorId: interaction.user.id, summary: `統治機能を${next === 'active' ? '再開' : '一時停止'}`, detail: { before: governance.status, after: next } });
    await postAuthorityChange(interaction.guild, getGovernanceGuild(interaction.guildId), next === 'active' ? '統治機能を再開' : '統治機能を一時停止', `運営者: <@${interaction.user.id}>`);
    await interaction.reply({ content: next === 'active' ? '統治機能を再開しました。' : '新しい統治処理を一時停止しました。', flags: EPHEMERAL });
    await refreshDashboard(interaction);
    return true;
  }
  if (customId === 'gov:admin:settings') {
    await interaction.showModal(settingsModal(interaction.guildId));
    return true;
  }
  if (customId === 'gov:admin:notifications') {
    await interaction.showModal(notificationSettingsModal(interaction.guildId));
    return true;
  }
  if (customId === 'gov:admin:weekly_toggle') {
    const current = getOperationalSetting(interaction.guildId, 'weekly_scan_enabled') === 1;
    const next = current ? 0 : 1;
    setOperationalSetting(interaction.guildId, 'weekly_scan_enabled', next, interaction.user.id);
    createAdministrativeAct({
      guildId: interaction.guildId,
      kind: 'operational_settings',
      actorId: interaction.user.id,
      summary: `自律起案を${next ? '有効化' : '無効化'}`,
      detail: { weekly_scan_enabled: next }
    });
    await interaction.reply({ content: `自律起案を${next ? '有効' : '無効'}にしました。`, flags: EPHEMERAL });
    await refreshDashboard(interaction);
    return true;
  }
  if (customId === 'gov:admin:electorate') {
    requireOwner(interaction);
    await interaction.reply(electoratePanel(governance));
    return true;
  }
  if (customId === 'gov:admin:disable_electorate') {
    requireOwner(interaction);
    updateGovernanceGuild(interaction.guildId, { trusted_role_id: '' });
    createAdministrativeAct({ guildId: interaction.guildId, kind: 'trusted_role', actorId: interaction.user.id, summary: '特別有権者機能を無効化', detail: { before: governance.trusted_role_id, after: '' } });
    await postAuthorityChange(interaction.guild, getGovernanceGuild(interaction.guildId), '特別有権者機能を無効化', `運営者: <@${interaction.user.id}>`);
    await interaction.reply({ content: '特別有権者機能を無効化しました。', flags: EPHEMERAL });
    await refreshDashboard(interaction);
    return true;
  }
  if (customId === 'gov:admin:enforcement') {
    if (governance.enforcement_mode === 'live') {
      await interaction.reply({
        content: '実執行を停止して記録のみに戻します。既に始まっている手続は止まりません。',
        components: [new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('gov:admin:shadow_confirm').setLabel('記録のみに戻す').setStyle(ButtonStyle.Danger)
        )],
        flags: EPHEMERAL
      });
      return true;
    }
    const report = diagnostics(interaction.guild, governance);
    const lines = [
      '# 実執行の診断',
      report.blockers.length ? `開始できません:\n- ${report.blockers.join('\n- ')}` : '必須条件: OK',
      ...report.warnings.map((warning) => `注意: ${warning}`),
      '',
      '実執行では、成立法と確定判決に基づきtimeout・kick・ban・各種制限がDiscordへ反映されます。'
    ];
    await interaction.reply({
      content: lines.join('\n'),
      components: report.blockers.length ? [] : [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('gov:admin:live_modal').setLabel('確認入力へ進む').setStyle(ButtonStyle.Danger)
      )],
      flags: EPHEMERAL
    });
    return true;
  }
  if (customId === 'gov:admin:live_modal') {
    const report = diagnostics(interaction.guild, governance);
    if (report.blockers.length > 0) throw new Error(report.blockers.join(' / '));
    await interaction.showModal(liveConfirmationModal(interaction.guild));
    return true;
  }
  if (customId === 'gov:admin:shadow_confirm') {
    updateGovernanceGuild(interaction.guildId, { enforcement_mode: 'shadow' });
    createAdministrativeAct({ guildId: interaction.guildId, kind: 'enforcement_mode', actorId: interaction.user.id, summary: '記録のみに変更', detail: { before: governance.enforcement_mode, after: 'shadow' } });
    await postAuthorityChange(interaction.guild, getGovernanceGuild(interaction.guildId), '実執行を停止', `運営者: <@${interaction.user.id}>`);
    await interaction.update({ content: '記録のみに戻しました。', components: [] });
    await refreshDashboard(interaction);
    return true;
  }
  if (customId === 'gov:admin:recovery') {
    const failures = listActionFailures(interaction.guildId);
    const notificationFailures = listNotificationFailures(interaction.guildId);
    const workflows = workflowFailures(governance);
    const details = [
      ...failures.map((failure) => `Discord処理: ${failure.last_error}`),
      ...notificationFailures.map((failure) => `通知: ${failure.last_error}`),
      ...workflows
    ].slice(0, 5);
    await interaction.reply({
      content: failures.length || notificationFailures.length || workflows.length
        ? [
          `Discord処理の失敗 ${failures.length}件 / 通知の失敗 ${notificationFailures.length}件 / 自動再試行中の手続き ${workflows.length}件`,
          ...details.map((detail) => `- ${String(detail).slice(0, 300)}`),
          failures.length || notificationFailures.length ? '再試行しても同じ通知・処理は重複実行しません。' : null
        ].filter(Boolean).join('\n').slice(0, 1_900)
        : '失敗または再試行中の処理はありません。',
      components: failures.length || notificationFailures.length ? [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('gov:admin:retry').setLabel('失敗処理を再試行').setStyle(ButtonStyle.Primary)
      )] : [],
      flags: EPHEMERAL
    });
    return true;
  }
  if (customId === 'gov:admin:retry') {
    const actionCount = retryFailedActions(interaction.guildId);
    const notificationCount = retryFailedNotifications(interaction.guildId);
    writeAudit({ guildId: interaction.guildId, actorType: 'operator', actorId: interaction.user.id, action: 'outbox.retry', targetType: 'guild', targetId: interaction.guildId, detail: { actionCount, notificationCount } });
    await interaction.update({ content: `${actionCount + notificationCount}件を再試行待ちへ戻しました。`, components: [] });
    await refreshDashboard(interaction);
    return true;
  }
  return false;
}
