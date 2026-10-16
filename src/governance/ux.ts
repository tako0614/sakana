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
  UserSelectMenuBuilder,
  type Guild,
  type GuildBasedChannel,
  type GuildMember,
  type InteractionReplyOptions,
  type Message,
  type MessageMentionOptions,
  type ModalSubmitInteraction,
  type OverwriteType,
  type TextChannel
} from 'discord.js';
import { governanceCategoryName, isGovernanceOperator, parseOperationalSetting } from './config.js';
import {
  getActiveConstitution,
  getCaseSanction,
  getConstitution,
  getWorkflowInstance,
  legalApprovalResult,
  getGovernanceGuild,
  getOperationalSetting,
  governanceNotificationStats,
  listActionFailures,
  listCaseApprovals,
  listNotificationFailures,
  listProposals,
  proposalVoteSummary,
  retryFailedActions,
  retryFailedNotifications,
  setOperationalSetting,
  updateGovernanceGuild
} from './db.js';
import {
  GOVERNANCE_PROCEDURE_NAME,
  GOVERNANCE_PROCEDURE_TOPIC,
  componentCustomId,
  createGovernanceProcedureChannel,
  ensureGovernanceCourtForum,
  ensureGovernanceOperationsThread,
  ensureGovernanceParliamentThread,
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
import { policeProcedure } from './policy.js';
import { lawSiteLink } from './lawsite.js';
import { humanAuthorityLabel } from './human-authority.js';
import { manualExecutionDetail } from './manual-execution.js';
import {
  createAdministrativeAct,
  errorMessage,
  isApprovalContext,
  isApprovalResult,
  isApprovalRow,
  isBoolean,
  isCaseRow,
  isConstitutionRow,
  isFailureRow,
  isGovernanceGuildRow,
  isNumber,
  isProposalRow,
  isRecord,
  isSanctionRow,
  isString,
  isStringArray,
  isUnknown,
  isVoteSummary,
  isWorkflowInstanceRow,
  listCases,
  listSanctions,
  narrow,
  narrowList,
  narrowRequired,
  optional,
  policyOf,
  requireValue,
  rulesOf,
  shape,
  writeAudit,
  type ButtonRow,
  type CaseRow,
  type GovernanceActionCard,
  type GovernanceGuildRow,
  type GovernancePanelPayload,
  type GovernanceUxInteraction,
  type OverwriteChannel,
  type ProposalRow,
  type RequiredOverwrite,
  type SanctionRow
} from './types-service.js';

const EPHEMERAL = MessageFlags.Ephemeral;
const ACTIVE_CASE_STATUSES = ['filing', 'police_review', 'contest_window', 'defense', 'deliberation', 'approval', 'appeal_window', 'appeal', 'execution'];

const governanceGuild = (guildId: unknown) => narrow(getGovernanceGuild(guildId), isGovernanceGuildRow, 'governance guild');
const requireGovernanceGuild = (guildId: unknown) => narrowRequired(getGovernanceGuild(guildId), isGovernanceGuildRow, 'governance guild');
const activeConstitution = (guildId: unknown) => narrow(getActiveConstitution(guildId), isConstitutionRow, 'constitution');
const caseSanction = (caseId: number) => narrow(getCaseSanction(caseId), isSanctionRow, 'sanction');
const settingValue = (guildId: string, key: string): unknown => getOperationalSetting(guildId, key);

function isPresent<T>(value: T | null | undefined): value is T {
  return value !== null && value !== undefined;
}

function workflowContext(subjectType: string, subjectId: number): Record<string, unknown> | undefined {
  return narrow(getWorkflowInstance(subjectType, subjectId), isWorkflowInstanceRow, 'workflow instance')?.context;
}

function proposalHandler(proposal: ProposalRow): string | null {
  if (proposal.workflow_handler) return proposal.workflow_handler;
  const constitution = narrow(getConstitution(proposal.constitution_id), isConstitutionRow, 'constitution');
  const key = proposal.kind === 'amendment' ? 'constitutionalAmendment' : 'law';
  return rulesOf(constitution?.rules)?.workflows[key]?.states[proposal.status]?.handler ?? null;
}

function activeProposals(guildId: string, limit = 100): ProposalRow[] {
  return narrowList(listProposals(guildId, { limit }), isProposalRow, 'proposal').filter((proposal) => proposalHandler(proposal) !== 'terminal');
}

function activeCases(guildId: string, statuses: readonly string[], limit: number): CaseRow[] {
  return narrowList(listCases(guildId, { statuses, limit }), isCaseRow, 'case');
}

function stateLabel(governance: GovernanceGuildRow): string {
  return governance.status === 'active' ? '稼働中' : '停止中';
}

function enforcementLabel(governance: GovernanceGuildRow): string {
  return governance.enforcement_mode === 'live' ? '実執行' : '記録のみ';
}

async function electorateLabel(guild: Guild, governance: GovernanceGuildRow): Promise<string> {
  if (!governance.trusted_role_id) return '未設定';
  const role = guild.roles.cache.get(governance.trusted_role_id)
    ?? await guild.roles.fetch(governance.trusted_role_id).catch(() => null);
  return role ? `「${role.name}」(<@&${role.id}>)` : 'ロール削除済み（機能停止）';
}

function activeCounts(guildId: string): { agenda: number; voting: number; cases: number } {
  const proposals = activeProposals(guildId);
  return {
    agenda: proposals.filter((proposal) => proposalHandler(proposal) !== 'public_vote').length,
    voting: proposals.filter((proposal) => proposalHandler(proposal) === 'public_vote').length,
    cases: activeCases(guildId, ACTIVE_CASE_STATUSES, 100).length
  };
}

function workflowFailures(governance: GovernanceGuildRow): string[] {
  return [
    ...activeProposals(governance.guild_id)
      .filter((proposal) => proposal.last_error)
      .map((proposal) => `${proposal.title}: ${proposal.last_error}`),
    ...activeCases(governance.guild_id, ACTIVE_CASE_STATUSES, 100)
      .filter((caseRecord) => caseRecord.last_error)
      .map((caseRecord) => `${caseRecord.summary}: ${caseRecord.last_error}`),
    ...(governance.session_last_error ? [`国会: ${governance.session_last_error}`] : [])
  ];
}

function overwriteBits(values: readonly bigint[] = []): bigint {
  return values.reduce((bits, value) => bits | BigInt(value), 0n);
}

export function requiredPermissionOverwritesMatch(channel: Partial<OverwriteChannel>, expected: readonly RequiredOverwrite[]): boolean {
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

export async function reconcileRequiredPermissionOverwrites(channel: OverwriteChannel, expected: readonly RequiredOverwrite[], reason: string): Promise<void> {
  const merged = new Map<string, { id: string; type: OverwriteType | undefined; allow: bigint; deny: bigint }>(
    [...channel.permissionOverwrites.cache.values()].map((overwrite) => [overwrite.id, {
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

function componentsMatch(message: Message, expected: readonly ButtonRow[]): boolean {
  const currentJson = message.components.map((row) => row.toJSON());
  const expectedJson = expected.map((row) => row.toJSON());
  return JSON.stringify(currentJson) === JSON.stringify(expectedJson);
}

function operationsComponents(governance: GovernanceGuildRow): ButtonRow[] {
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId('gov:admin:toggle_state')
        .setLabel(governance.status === 'active' ? '受付を一時停止' : '受付を再開')
        .setStyle(governance.status === 'active' ? ButtonStyle.Danger : ButtonStyle.Success),
      new ButtonBuilder().setCustomId('gov:admin:enforcement')
        .setLabel(governance.enforcement_mode === 'live' ? '実執行を停止' : '実執行を診断')
        .setStyle(governance.enforcement_mode === 'live' ? ButtonStyle.Secondary : ButtonStyle.Danger),
      new ButtonBuilder().setCustomId('gov:admin:settings').setLabel('AI利用上限').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('gov:admin:investigation').setLabel('AI調査範囲').setStyle(ButtonStyle.Primary),
    ),
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId('gov:admin:parliament_now').setLabel('国会を開く').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('gov:admin:electorate').setLabel('特別有権者を設定').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('gov:admin:notifications').setLabel('通知上限').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('gov:admin:recovery').setLabel('診断・復旧').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setLabel('公開手続を開く').setStyle(ButtonStyle.Link)
        .setURL(`https://discord.com/channels/${governance.guild_id}/${governance.procedure_channel_id}`)
    )
  ];
}

const isNotificationStats = shape({ delivered: isNumber, suppressed: isNumber, failed: isNumber });

export async function renderGovernanceOperationsPanel(guild: Guild, governance: GovernanceGuildRow): Promise<GovernancePanelPayload> {
  const constitution = activeConstitution(guild.id);
  const policy = policyOf(constitution?.policy);
  const permissions = governancePermissionReport(guild);
  const failures = narrowList(listActionFailures(guild.id), isFailureRow, 'outbox failure');
  const workflows = workflowFailures(governance);
  const counts = activeCounts(guild.id);
  const electorate = await electorateLabel(guild, governance);
  const electorateName = governance.trusted_role_id
    ? (guild.roles.cache.get(governance.trusted_role_id)?.name ?? '特別有権者')
    : '特別有権者';
  const notificationStats = narrowRequired(governanceNotificationStats(guild.id), isNotificationStats, 'notification stats');
  return {
    content: [
      `# ${guild.name} Bot技術運用`,
      '',
      'この画面は `/governance` を実行した運営者だけに表示されています。投票・承認などの統治手続は公開チャンネルで行います。',
      '',
      `状態: **${stateLabel(governance)}** / 執行: **${enforcementLabel(governance)}**`,
      `憲法: v${constitution?.version ?? '?'} / 議題 ${counts.agenda}件 / 投票中 ${counts.voting}件 / 事件 ${counts.cases}件`,
      `Bot権限: ${permissions.ok ? 'OK' : `不足: ${permissions.missing.join('、')}`}`,
      `失敗した処理: ${failures.length + workflows.length}件`,
      `特別有権者: ${electorate}`,
      `国会(${policy?.autonomous ? '法律で規定' : '憲法で規定'}): ${(policy?.legislation.sessionIntervalMilliseconds ?? 0) / 3_600_000}時間ごと / 1回 ${policy?.legislation.agendaLimit ?? '?'}議題${policy?.autonomous ? '' : ` / 継続審議 ${policy?.legislation.maximumDeferrals ?? '?'}回`} / 自律起案 ${policy?.legislation.logScan ? '有効' : '無効'}${governance.last_session_at ? ` / 前回 <t:${Math.floor(Number(governance.last_session_at) / 1000)}:R>` : ''}`,
      `AI受付: 一般 ${String(settingValue(guild.id, 'general_daily_calls'))}回/日 / ${electorateName} ${String(settingValue(guild.id, 'trusted_daily_calls'))}回/日`,
      `AI調査: 会話 ${String(settingValue(guild.id, 'investigation_conversation_limit'))}件 / 対象者 ${String(settingValue(guild.id, 'investigation_actor_limit'))}件 / サーバー ${String(settingValue(guild.id, 'investigation_guild_limit'))}件 / 最大事件 ${String(settingValue(guild.id, 'investigation_case_limit'))}件`,
      `通知上限: 全体 ${String(settingValue(guild.id, 'notification_everyone_daily_limit'))}回 / ${electorateName} ${String(settingValue(guild.id, 'notification_trusted_daily_limit'))}回 / 当事者1人 ${String(settingValue(guild.id, 'notification_user_daily_limit'))}回（各24時間）`,
      `通知実績（24時間）: 送信 ${notificationStats.delivered} / 上限・権限で抑制 ${notificationStats.suppressed} / 失敗 ${notificationStats.failed}`,
      '',
      `公開手続: <#${governance.procedure_channel_id}>`,
      'ここで変更できるのはBotの運用値だけです。統治の条件を変えるには、根拠となる憲法・法律の改正手続が必要です。'
    ].join('\n').slice(0, 1_900),
    components: operationsComponents(governance),
    allowedMentions: { parse: [] }
  };
}

function safeLabel(value: unknown, maximum = 60): string {
  return String(value ?? '').replace(/[\[\]()*_`]/g, '').replace(/\s+/g, ' ').trim().slice(0, maximum);
}

function deadline(value: unknown, prefix = '締切'): string {
  return value ? ` / ${prefix} <t:${Math.floor(Number(value) / 1000)}:R>` : '';
}

function procedureComponents(governance: GovernanceGuildRow, supportsImmediateReview: boolean): ButtonRow[] {
  const link = (label: string, channelId: string) => new ButtonBuilder().setLabel(label).setStyle(ButtonStyle.Link)
    .setURL(`https://discord.com/channels/${governance.guild_id}/${channelId}`);
  const lawSite: unknown = lawSiteLink(governance.guild_id);
  const destinations = [
    link('議会', governance.parliament_forum_id),
    link('裁判所', governance.court_forum_id),
    isString(lawSite) && lawSite ? new ButtonBuilder().setLabel('法令集').setStyle(ButtonStyle.Link).setURL(lawSite) : null,
    // 国会がいつ開かれて何を決めたかは、議題スレを個別に見なくても追えるようにする。
    governance.parliament_thread_id ? link('国会記録', governance.parliament_thread_id) : null,
    governance.operations_thread_id ? link('運営変更', governance.operations_thread_id) : null
  ].filter(isPresent);
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(...destinations),
    supportsImmediateReview ? new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId('gov:contest_list:0').setLabel('自分が受けた処分を確認').setStyle(ButtonStyle.Primary)
    ) : null
  ].filter(isPresent);
}

function actionLink(guildId: string, channelId: unknown, label: string): ButtonBuilder {
  return new ButtonBuilder().setLabel(label).setStyle(ButtonStyle.Link)
    .setURL(`https://discord.com/channels/${guildId}/${String(channelId)}`);
}

function vetoOf(period: unknown): Record<string, unknown> | null {
  const veto = isRecord(period) ? period['veto'] : undefined;
  return isRecord(veto) ? veto : null;
}

function voteActionComponents(guildId: string, proposal: ProposalRow): ButtonRow[] {
  const veto = vetoOf(workflowContext('proposal', proposal.id)?.['publicVote']);
  return [new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`gov:vote:${proposal.id}:yes`).setLabel('賛成').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`gov:vote:${proposal.id}:no`).setLabel('反対').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`gov:vote:${proposal.id}:abstain`).setLabel('棄権').setStyle(ButtonStyle.Secondary),
    ...(veto ? [new ButtonBuilder().setCustomId(`gov:veto:${proposal.id}:proposal`).setLabel('拒否権を行使').setStyle(ButtonStyle.Danger)] : []),
    actionLink(guildId, proposal.forum_thread_id, '本文・議論')
  )];
}

function approvalActionComponents(guildId: string, caseRecord: CaseRow): ButtonRow[] {
  const veto = vetoOf(workflowContext('case', caseRecord.id)?.['approval']);
  return [new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`gov:approve:${caseRecord.id}:approve`).setLabel('執行承認').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`gov:approve:${caseRecord.id}:reject`).setLabel('承認しない').setStyle(ButtonStyle.Danger),
    ...(veto ? [new ButtonBuilder().setCustomId(`gov:veto:${caseRecord.id}:case`).setLabel('拒否権を行使').setStyle(ButtonStyle.Danger)] : []),
    actionLink(guildId, caseRecord.public_thread_id, '判決記録')
  )];
}

const SANCTION_NAMES: Record<string, string> = {
  warning: '警告', restriction: '機能制限', timeout: 'タイムアウト', kick: 'キック', ban: 'BAN'
};

function sanctionName(sanction: Pick<SanctionRow, 'type' | 'duration_seconds'> | null | undefined): string {
  const name = (sanction ? SANCTION_NAMES[sanction.type] : undefined) ?? '処分';
  if (!sanction?.duration_seconds) return name;
  const seconds = Number(sanction.duration_seconds);
  if (seconds % 86_400 === 0) return `${name} ${seconds / 86_400}日`;
  if (seconds % 3_600 === 0) return `${name} ${seconds / 3_600}時間`;
  return `${name} ${Math.ceil(seconds / 60)}分`;
}

// notifications.js が作る通知の記述子。mention だけ本文に使い、残りはそのまま返す。
const isNotification = shape({ mention: isString });

export function renderProposalVoteAction(guild: Guild, proposal: ProposalRow): GovernanceActionCard {
  const summary = narrowRequired(proposalVoteSummary(proposal.id), isVoteSummary, 'vote summary');
  const notification = narrowRequired(proposalVoteNotification(guild, proposal), isNotification, 'notification');
  const veto = vetoOf(workflowContext('proposal', proposal.id)?.['publicVote']);
  return {
    key: `vote:${proposal.id}`,
    notification,
    content: [
      notification.mention,
      `**${safeLabel(proposal.title, 180)}**`,
      `対象: ${proposal.vote_scope === 'all' ? '全員' : '特別有権者'}${deadline(proposal.stage_ends_at)}`,
      `現在: 賛成 ${summary.yes} / 反対 ${summary.no} / 棄権 ${summary.abstain}`,
      ...(veto ? [`拒否権: ${String(humanAuthorityLabel(veto))} / 行使 ${summary.vetoCount}/${String(veto['required'])}人。拒否期間の満了まで早期成立しません。`] : []),
      '下のボタンから記名投票できます。選び直すと票が更新されます。'
    ].join('\n').slice(0, 1_900),
    components: voteActionComponents(guild.id, proposal),
    allowedMentions: { parse: [] }
  };
}

export function renderCaseApprovalAction(guild: Guild, caseRecord: CaseRow): GovernanceActionCard {
  const sanction = caseSanction(caseRecord.id);
  const approval = narrow(workflowContext('case', caseRecord.id)?.['approval'], isApprovalContext, 'approval');
  const approved = approval
    ? narrowRequired(legalApprovalResult(caseRecord.id), isApprovalResult, 'approval result').approvals
    : narrowList(listCaseApprovals(caseRecord.id), isApprovalRow, 'case approval').filter((entry) => entry.decision === 'approve').length;
  const notification = narrowRequired(caseApprovalNotification(guild, caseRecord, sanction), isNotification, 'notification');
  return {
    key: `approve:${caseRecord.id}`,
    notification,
    content: [
      notification.mention,
      `**${safeLabel(caseRecord.summary, 180)}**`,
      approval ? `承認者: ${String(humanAuthorityLabel(approval.authority ?? approval))} / 承認期限: <t:${Math.floor(approval.deadline / 1000)}:F>${Number(approval.rejectVotes) > 0 ? ` / 拒否 ${approval.rejectVotes}票で中止` : ''}` : null,
      approval?.veto ? `拒否権: ${String(humanAuthorityLabel(approval.veto))}の${approval.veto.required}人。拒否期間の満了まで執行しません。` : null,
      caseRecord.accused_id ? `対象: ${publicMemberLabel(caseRecord.accused_id)}` : null,
      `処分: ${sanctionName(sanction)} / 承認 ${approved}/${sanction?.required_approvals ?? '?'}人`,
      `${approval ? '開始時に承認資格を満たした構成員' : '特別有権者'}は下のボタンから記名で判断します。被申立人と申立人は承認できません。`
    ].filter(Boolean).join('\n').slice(0, 1_900),
    components: approvalActionComponents(guild.id, caseRecord),
    allowedMentions: { parse: [] }
  };
}

// 管理者による手動執行の依頼 (execution_detail.manualRequest)。
const isManualRequest = shape({ kind: isString, key: isString, priorExecutionReported: optional(isBoolean) });

function manualRequestOf(sanction: SanctionRow) {
  const detail: unknown = manualExecutionDetail(sanction);
  return narrowRequired(isRecord(detail) ? detail['manualRequest'] : undefined, isManualRequest, 'manual execution request');
}

export function renderGovernanceActionCards(guild: Guild): GovernanceActionCard[] {
  const proposals = activeProposals(guild.id, 100)
    .filter((proposal) => proposalHandler(proposal) === 'public_vote' && proposal.forum_thread_id);
  const approvals = activeCases(guild.id, ['approval'], 100)
    .filter((caseRecord) => caseRecord.public_thread_id && caseSanction(caseRecord.id));
  return [
    ...proposals.map((proposal) => renderProposalVoteAction(guild, proposal)),
    ...approvals.map((caseRecord) => renderCaseApprovalAction(guild, caseRecord)),
    ...narrowList(listSanctions(guild.id, ['pending_manual_execution', 'pending_manual_reversal']), isSanctionRow, 'sanction').map((sanction): GovernanceActionCard => {
      const request = manualRequestOf(sanction);
      const execute = request.kind === 'execute';
      const buttons = [new ButtonBuilder().setCustomId(`gov:manual:${sanction.id}:${request.key}-done`)
        .setLabel(execute ? '執行完了' : '取消への対応完了').setStyle(ButtonStyle.Success)];
      if (!execute && !request.priorExecutionReported) buttons.push(new ButtonBuilder()
        .setCustomId(`gov:manual:${sanction.id}:${request.key}-not_executed`).setLabel('未執行のまま取消').setStyle(ButtonStyle.Secondary));
      return { key: `manual:${sanction.id}`, content: [
        `## C-${sanction.case_id} / ${execute ? '管理者の執行待ち' : '管理者の取消対応待ち'}`,
        `対象: ${publicMemberLabel(sanction.user_id)} / 処分: ${sanctionName(sanction)}`,
        execute ? '管理者がDiscordで手動執行した後、「執行完了」を押してください。'
          : sanction.type === 'ban' ? '管理者がDiscordでBANを解除した後、対応完了を押してください。'
            : '管理者が取消を本人へ伝え、再参加を案内した後、対応完了を押してください。',
        'ボタンは管理者の完了報告を記録します。'
      ].join('\n'), components: [new ActionRowBuilder<ButtonBuilder>().addComponents(buttons)], allowedMentions: { parse: [] } };
    })
  ];
}

function actionCardKey(message: Message): string | null {
  for (const row of message.components ?? []) {
    const components: unknown[] = isRecord(row) && Array.isArray(row['components']) ? row['components'] : [];
    for (const component of components) {
      const match = componentCustomId(component).match(/^gov:(vote|approve|manual):(\d+):/);
      if (match) return `${match[1]}:${match[2]}`;
    }
  }
  return null;
}

const MENTION_TYPES = new Set(['everyone', 'roles', 'users']);

// 通知を送ると決まったときだけ、その通知が許す相手 (全員・1ロール・1人) を mention させる。
function isMentionOptions(value: unknown): value is MessageMentionOptions {
  if (!isRecord(value)) return false;
  const { parse, roles, users, repliedUser } = value;
  return (parse === undefined || (Array.isArray(parse) && parse.every((type) => typeof type === 'string' && MENTION_TYPES.has(type))))
    && (roles === undefined || isStringArray(roles))
    && (users === undefined || isStringArray(users))
    && (repliedUser === undefined || typeof repliedUser === 'boolean');
}

function deliveryMentions(delivery: unknown): MessageMentionOptions | null {
  const mentions = isRecord(delivery) ? delivery['allowedMentions'] : undefined;
  return isMentionOptions(mentions) ? mentions : null;
}

export async function syncGovernanceActionCards(guild: Guild, channel: TextChannel): Promise<number> {
  const expected = renderGovernanceActionCards(guild);
  const activeKeys = new Set(expected.map((card) => card.key));
  const recent = await channel.messages.fetch({ limit: 100 }).catch(() => null);
  const existing = new Map<string, Message[]>();
  for (const message of recent?.values?.() ?? []) {
    if (message.author.id !== guild.client.user.id) continue;
    const key = actionCardKey(message);
    if (!key) continue;
    const messages = existing.get(key) ?? [];
    existing.set(key, messages);
    messages.push(message);
  }
  for (const card of expected) {
    const messages = existing.get(card.key) ?? [];
    const message = messages.shift() ?? null;
    const { key: _key, notification, ...payload } = card;
    if (!message) {
      const delivery: unknown = notification ? beginGovernanceNotification(guild, notification) : null;
      try {
        const sent = await channel.send({
          ...payload,
          allowedMentions: deliveryMentions(delivery) ?? { parse: [] }
        });
        if (delivery) finishGovernanceNotification(notification, sent);
      } catch (error) {
        if (delivery) rejectGovernanceNotification(notification, error);
        throw error;
      }
    } else {
      if (notification) reconcileGovernanceNotificationMessage(notification, message);
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

export async function renderGovernanceProcedureHub(guild: Guild, governance: GovernanceGuildRow): Promise<GovernancePanelPayload> {
  const supportsImmediateReview = Boolean(policeProcedure(activeConstitution(guild.id)?.policy));

  const proposals = activeProposals(guild.id, 100);
  const voting = proposals.filter((proposal) => proposalHandler(proposal) === 'public_vote');
  const agenda = proposals.filter((proposal) => proposalHandler(proposal) === 'parliament_agenda');
  const approvals = activeCases(guild.id, ['approval'], 20);
  const policy = policyOf(activeConstitution(guild.id)?.policy);
  const intervalMs = policy?.legislation.sessionIntervalMilliseconds ?? 0;
  const nextAt = governance.last_session_at ? Number(governance.last_session_at) + intervalMs : null;
  return {
    content: [
      `# ${guild.name} 手続`,
      '',
      `法律にしたいことは <#${governance.parliament_forum_id}> へ投稿してください。違反の通報・上訴・違憲審査は <@&${governance.judiciary_role_id}> に自然文で話してください。`,
      `国会は${Math.round(intervalMs / 3_600_000)}時間ごとに開き、議会の投稿と公開ログを議題として読みます。${nextAt ? `次の開会: <t:${Math.floor(nextAt / 1000)}:R>` : '次の開会: まもなく'}`,
      '投票と執行承認が始まると、この下に操作カードが出ます。',
      policy?.autonomous ? 'AIが調査・起草・審査・修正を進めます。人間の投票・承認が必要な段階と成立条件は、憲法と法律に従います。' : null,
      '',
      `議題 ${agenda.length}件 / いま操作できる案件: 投票 ${voting.length}件 / 承認 ${approvals.length}件`
    ].filter(Boolean).join('\n').slice(0, 1_900),
    components: procedureComponents(governance, supportsImmediateReview),
    allowedMentions: { parse: [] }
  };
}

async function fetchTrackedMessage(channel: TextChannel, id: string, prefix: string): Promise<Message | null> {
  if (id) {
    const message = await channel.messages.fetch(id).catch(() => null);
    if (message) return message;
  }
  const recent = await channel.messages.fetch({ limit: 50 }).catch(() => null);
  return recent?.find((message) => message.author.id === channel.client.user.id && message.content.startsWith(prefix)) ?? null;
}

export async function ensureGovernanceUx(
  guild: Guild,
  governance = governanceGuild(guild.id)
): Promise<{ governance: GovernanceGuildRow; procedure: TextChannel; procedureMessage: Message }> {
  if (!governance) throw new Error('統治機能が初期化されていません。');
  let current = governance;
  const category = current.category_id ? await guild.channels.fetch(current.category_id).catch(() => null) : null;
  if (!category || category.type !== ChannelType.GuildCategory) throw new Error('統治カテゴリが見つかりません。');
  const oldCategoryName = `${guild.name}`.slice(0, 89) + ' Governance';
  if (category.name === oldCategoryName) await category.setName(governanceCategoryName(guild.name), '統治UXの既定名へ移行');

  await retireGovernanceCourtChat(guild, current);
  const court = await ensureGovernanceCourtForum(guild, current);
  if (current.court_chat_channel_id !== court.id) {
    current = narrowRequired(updateGovernanceGuild(guild.id, { court_chat_channel_id: court.id }), isGovernanceGuildRow, 'governance guild');
  }

  let procedure: GuildBasedChannel | null = current.procedure_channel_id
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

  const siblings = [...guild.channels.cache.values()]
    .flatMap((channel) => (channel.parentId === category.id && 'position' in channel ? [channel.position] : []));
  const firstPosition = Math.min(...siblings);
  if (Number.isFinite(firstPosition) && procedure.position !== firstPosition) {
    await procedure.setPosition(firstPosition, { reason: '手続をカテゴリ先頭へ移動' });
  }

  if (procedure.id !== current.procedure_channel_id) {
    current = narrowRequired(updateGovernanceGuild(guild.id, { procedure_channel_id: procedure.id }), isGovernanceGuildRow, 'governance guild');
  }
  let procedureMessage = await fetchTrackedMessage(procedure, current.procedure_message_id, `# ${guild.name} 手続`);
  if (!procedureMessage) {
    procedureMessage = await fetchTrackedMessage(procedure, '', `# ${guild.name} 進行中`);
  }
  if (!procedureMessage) procedureMessage = await procedure.send(await renderGovernanceProcedureHub(guild, current));
  if (procedureMessage.id !== current.procedure_message_id) {
    current = narrowRequired(updateGovernanceGuild(guild.id, { procedure_message_id: procedureMessage.id }), isGovernanceGuildRow, 'governance guild');
  }
  await ensureGovernanceOperationsThread(guild, current, procedureMessage);
  // 国会記録は開会時にも作られるが、案内から辿れるよう導入時に用意しておく。
  await ensureGovernanceParliamentThread(guild, requireGovernanceGuild(guild.id), procedureMessage)
    .catch((error: unknown) => console.error('国会記録スレを作れませんでした:', errorMessage(error)));
  current = requireGovernanceGuild(guild.id);
  const dashboard = await renderGovernanceProcedureHub(guild, current);
  if (procedureMessage.content !== dashboard.content || !componentsMatch(procedureMessage, dashboard.components)) {
    await procedureMessage.edit(dashboard);
  }
  await syncGovernanceActionCards(guild, procedure);
  return { governance: current, procedure, procedureMessage };
}

async function refreshDashboard(interaction: GovernanceUxInteraction, guild: Guild) {
  const ux = await ensureGovernanceUx(guild, governanceGuild(interaction.guildId));
  if (interaction.message?.content?.startsWith(`# ${guild.name} Bot技術運用`)) {
    await interaction.message.edit(await renderGovernanceOperationsPanel(guild, ux.governance)).catch(() => {});
  }
  return ux;
}

function requireOperator(interaction: GovernanceUxInteraction): void {
  if (!isGovernanceOperator(interaction.member)) throw new Error('この操作はサーバーownerまたは設定済み運営者だけが実行できます。');
}

function requireOwner(interaction: GovernanceUxInteraction, guild: Guild): void {
  if (interaction.user.id !== guild.ownerId) throw new Error('特別有権者を変更できるのはサーバーownerだけです。');
}

function settingInput(id: string, label: string, value: unknown): ActionRowBuilder<TextInputBuilder> {
  return new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder()
    .setCustomId(id).setLabel(label).setStyle(TextInputStyle.Short).setRequired(true).setValue(String(value)));
}

function settingsModal(guildId: string): ModalBuilder {
  return new ModalBuilder()
    .setCustomId('gov:admin_modal:settings')
    .setTitle('AI利用上限')
    .addComponents(
      settingInput('general_daily_calls', '一般参加者のAI受付回数/日', settingValue(guildId, 'general_daily_calls')),
      settingInput('trusted_daily_calls', '特別有権者のAI受付回数/日', settingValue(guildId, 'trusted_daily_calls')),
      settingInput('investigation_case_limit', '一度に開始する事件数（最大10）', settingValue(guildId, 'investigation_case_limit'))
    );
}

function investigationSettingsModal(guildId: string): ModalBuilder {
  return new ModalBuilder()
    .setCustomId('gov:admin_modal:investigation')
    .setTitle('AI調査範囲')
    .addComponents(
      settingInput('investigation_lookback_days', '席が既定で遡る日数（最大90）', settingValue(guildId, 'investigation_lookback_days')),
      settingInput('investigation_case_limit', '1回の通報で事件化する上限（最大10）', settingValue(guildId, 'investigation_case_limit'))
    );
}

function notificationSettingsModal(guildId: string): ModalBuilder {
  return new ModalBuilder()
    .setCustomId('gov:admin_modal:notifications')
    .setTitle('通知上限（24時間）')
    .addComponents(
      settingInput('notification_everyone_daily_limit', '全体通知（0で停止・最大10）', settingValue(guildId, 'notification_everyone_daily_limit')),
      settingInput('notification_trusted_daily_limit', '特別有権者通知（0で停止・最大50）', settingValue(guildId, 'notification_trusted_daily_limit')),
      settingInput('notification_user_daily_limit', '当事者1人あたり（0で停止・最大20）', settingValue(guildId, 'notification_user_daily_limit'))
    );
}

function electoratePanel(governance: GovernanceGuildRow): InteractionReplyOptions {
  const roleSelect = new RoleSelectMenuBuilder()
    .setCustomId('gov:admin_role:set')
    .setPlaceholder('特別有権者として使うロールを選択')
    .setMinValues(1).setMaxValues(1);
  if (governance.trusted_role_id) roleSelect.setDefaultRoles(governance.trusted_role_id);
  return {
    content: 'ロール名はサーバー側で自由に変更できます。メンバー追加・削除はownerの操作だけを正本として受け付けます。',
    components: [
      new ActionRowBuilder<RoleSelectMenuBuilder>().addComponents(roleSelect),
      new ActionRowBuilder<UserSelectMenuBuilder>().addComponents(
        new UserSelectMenuBuilder().setCustomId('gov:admin_user:add').setPlaceholder('特別有権者へ追加').setMinValues(1).setMaxValues(1)
      ),
      new ActionRowBuilder<UserSelectMenuBuilder>().addComponents(
        new UserSelectMenuBuilder().setCustomId('gov:admin_user:remove').setPlaceholder('特別有権者から削除').setMinValues(1).setMaxValues(1)
      ),
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId('gov:admin:disable_electorate').setLabel('特別有権者ロールの利用を停止').setStyle(ButtonStyle.Danger)
      )
    ],
    flags: EPHEMERAL
  };
}

function diagnostics(guild: Guild, governance: GovernanceGuildRow): { blockers: string[]; warnings: string[] } {
  const permission = governancePermissionReport(guild);
  const failures = narrowList(listActionFailures(guild.id), isFailureRow, 'outbox failure');
  const workflows = workflowFailures(governance);
  const constitution = activeConstitution(guild.id);
  const blockers = [
    governance.status !== 'active' ? '統治機能が一時停止中です' : null,
    !constitution ? '有効な憲法がありません' : null,
    !permission.ok ? `Bot権限不足: ${permission.missing.join('、')}` : null,
    failures.length > 0 ? `失敗したDiscord処理が${failures.length}件あります` : null,
    workflows.length > 0 ? `再試行中の統治手続きが${workflows.length}件あります` : null
  ].filter(isPresent);
  const warnings = governance.trusted_role_id
    ? []
    : ['特別有権者が未設定のため、承認を必要とする重い刑は執行不能になります。'];
  return { blockers, warnings };
}

function liveConfirmationModal(guild: Guild): ModalBuilder {
  return new ModalBuilder()
    .setCustomId('gov:admin_modal:live')
    .setTitle('実執行を有効化')
    .addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder().setCustomId('server_name').setLabel(`確認のため「${guild.name}」と入力`)
        .setStyle(TextInputStyle.Short).setRequired(true)
    ));
}

const isParsedSetting = shape({ ok: isBoolean, value: isUnknown, error: optional(isString) });

/** モーダルの入力を運用値として読む。1つでも不正なら何も変えない。 */
function parsedSettings(interaction: ModalSubmitInteraction, keys: readonly string[]): [string, unknown][] {
  const updates: [string, unknown][] = [];
  for (const key of keys) {
    const parsed = narrowRequired(parseOperationalSetting(key, interaction.fields.getTextInputValue(key)), isParsedSetting, 'operational setting');
    if (!parsed.ok) throw new Error(parsed.error ?? undefined);
    updates.push([key, parsed.value]);
  }
  return updates;
}

function parliamentOutcomes(session: unknown): unknown[] {
  return isRecord(session) && Array.isArray(session['outcomes']) ? session['outcomes'] : [];
}

export async function handleGovernanceUxInteraction(interaction: GovernanceUxInteraction): Promise<boolean> {
  const customId = interaction.customId ?? '';
  if (!customId.startsWith('gov:admin')) return false;
  requireOperator(interaction);
  // 運営者の判定はサーバーのメンバー情報で行うので、ここに来るのはサーバー内の操作だけ。
  const guild = requireValue(interaction.guild, 'サーバー内でのみ使えます。');
  const governance = governanceGuild(interaction.guildId);
  if (!governance) throw new Error('統治機能が初期化されていません。');

  if (interaction.isModalSubmit() && customId === 'gov:admin_modal:settings') {
    const updates = parsedSettings(interaction, ['general_daily_calls', 'trusted_daily_calls', 'investigation_case_limit']);
    for (const [key, value] of updates) setOperationalSetting(guild.id, key, value, interaction.user.id);
    createAdministrativeAct({ guildId: guild.id, kind: 'operational_settings', actorId: interaction.user.id, summary: 'AI受付の設定を変更', detail: Object.fromEntries(updates) });
    await interaction.reply({ content: 'AI受付の設定を更新しました。', flags: EPHEMERAL });
    await refreshDashboard(interaction, guild);
    return true;
  }
  if (interaction.isModalSubmit() && customId === 'gov:admin_modal:investigation') {
    const updates = parsedSettings(interaction, ['investigation_lookback_days', 'investigation_case_limit']);
    for (const [key, value] of updates) setOperationalSetting(guild.id, key, value, interaction.user.id);
    createAdministrativeAct({
      guildId: guild.id,
      kind: 'operational_settings',
      actorId: interaction.user.id,
      summary: 'AI調査範囲を変更',
      detail: Object.fromEntries(updates)
    });
    await interaction.reply({ content: 'AI調査範囲を更新しました。新しい呼びかけから適用します。', flags: EPHEMERAL });
    await refreshDashboard(interaction, guild);
    return true;
  }
  if (interaction.isModalSubmit() && customId === 'gov:admin_modal:notifications') {
    const updates = parsedSettings(interaction, [
      'notification_everyone_daily_limit',
      'notification_trusted_daily_limit',
      'notification_user_daily_limit'
    ]);
    for (const [key, value] of updates) setOperationalSetting(guild.id, key, value, interaction.user.id);
    createAdministrativeAct({
      guildId: guild.id,
      kind: 'notification_settings',
      actorId: interaction.user.id,
      summary: '通知上限を変更',
      detail: Object.fromEntries(updates)
    });
    await interaction.reply({ content: '通知上限を更新しました。0にした対象への新しい通知は停止します。', flags: EPHEMERAL });
    await refreshDashboard(interaction, guild);
    return true;
  }
  if (interaction.isModalSubmit() && customId === 'gov:admin_modal:live') {
    if (interaction.fields.getTextInputValue('server_name').trim() !== guild.name) {
      throw new Error('サーバー名が一致しません。実執行へ切り替えていません。');
    }
    const current = requireGovernanceGuild(guild.id);
    const report = diagnostics(guild, current);
    if (report.blockers.length > 0) throw new Error(report.blockers.join(' / '));
    updateGovernanceGuild(guild.id, { enforcement_mode: 'live' });
    createAdministrativeAct({ guildId: guild.id, kind: 'enforcement_mode', actorId: interaction.user.id, summary: '実執行を有効化', detail: { before: current.enforcement_mode, after: 'live' } });
    writeAudit({ guildId: guild.id, actorType: 'operator', actorId: interaction.user.id, action: 'enforcement.live', targetType: 'guild', targetId: guild.id });
    await postAuthorityChange(guild, requireGovernanceGuild(guild.id), '実執行を有効化', `運営者: <@${interaction.user.id}>`);
    await interaction.reply({ content: '実執行を有効化しました。', flags: EPHEMERAL });
    await refreshDashboard(interaction, guild);
    return true;
  }
  if (interaction.isRoleSelectMenu() && customId === 'gov:admin_role:set') {
    requireOwner(interaction, guild);
    const role = interaction.roles.first();
    if (!role || role.managed || role.id === guild.id) throw new Error('選択したロールは使用できません。');
    const highest = guild.members.me?.roles.highest.position;
    if (highest === undefined || role.position >= highest) throw new Error('Botの最高ロールより下のロールを選んでください。');
    updateGovernanceGuild(guild.id, { trusted_role_id: role.id });
    createAdministrativeAct({ guildId: guild.id, kind: 'trusted_role', actorId: interaction.user.id, summary: `特別有権者ロールを${role.name}に変更`, detail: { before: governance.trusted_role_id, after: role.id } });
    writeAudit({ guildId: guild.id, actorType: 'operator', actorId: interaction.user.id, action: 'trusted.role_changed', targetType: 'role', targetId: role.id, detail: { before: governance.trusted_role_id } });
    await postAuthorityChange(guild, requireGovernanceGuild(guild.id), '特別有権者ロール変更', `変更後: ${role.name}\n運営者: <@${interaction.user.id}>`);
    await interaction.reply({ content: `特別有権者ロールを「${role.name}」に変更しました。`, flags: EPHEMERAL });
    await refreshDashboard(interaction, guild);
    return true;
  }
  if (interaction.isUserSelectMenu() && (customId === 'gov:admin_user:add' || customId === 'gov:admin_user:remove')) {
    requireOwner(interaction, guild);
    const user = requireValue(interaction.users.first(), 'ユーザーを選択してください。');
    const member: GuildMember = await guild.members.fetch(user.id);
    const desired = customId.endsWith(':add');
    const changed = await setTrustedMember(guild, interaction.user.id, member, desired);
    if (changed) createAdministrativeAct({ guildId: guild.id, kind: desired ? 'trusted_member_add' : 'trusted_member_remove', actorId: interaction.user.id, summary: `${member.id}の特別有権者資格を変更`, detail: { userId: member.id, desired } });
    await interaction.reply({ content: changed ? `${member.user.username}を${desired ? '追加' : '削除'}しました。` : '既にその状態です。', flags: EPHEMERAL });
    await refreshDashboard(interaction, guild);
    return true;
  }
  if (!interaction.isButton()) return false;

  if (customId === 'gov:admin:refresh') {
    await interaction.deferReply({ flags: EPHEMERAL });
    await refreshDashboard(interaction, guild);
    await interaction.editReply('技術運用パネルと公開の手続を更新しました。');
    return true;
  }
  if (customId === 'gov:admin:toggle_state') {
    const next = governance.status === 'active' ? 'paused' : 'active';
    updateGovernanceGuild(guild.id, { status: next });
    createAdministrativeAct({ guildId: guild.id, kind: 'governance_status', actorId: interaction.user.id, summary: `統治機能を${next === 'active' ? '再開' : '一時停止'}`, detail: { before: governance.status, after: next } });
    await postAuthorityChange(guild, requireGovernanceGuild(guild.id), next === 'active' ? '統治機能を再開' : '統治機能を一時停止', `運営者: <@${interaction.user.id}>`);
    await interaction.reply({ content: next === 'active' ? '統治機能を再開しました。' : '新しい統治処理を一時停止しました。', flags: EPHEMERAL });
    await refreshDashboard(interaction, guild);
    return true;
  }
  if (customId === 'gov:admin:settings') {
    await interaction.showModal(settingsModal(guild.id));
    return true;
  }
  if (customId === 'gov:admin:investigation') {
    await interaction.showModal(investigationSettingsModal(guild.id));
    return true;
  }
  if (customId === 'gov:admin:notifications') {
    await interaction.showModal(notificationSettingsModal(guild.id));
    return true;
  }
  if (customId === 'gov:admin:parliament_now') {
    await interaction.deferReply({ flags: EPHEMERAL });
    const { runParliamentSession } = await import('./parliament.js');
    const session: unknown = await runParliamentSession(guild, governance, Date.now(), { manual: true });
    const outcomes = parliamentOutcomes(session);
    const count = (decision: string) => outcomes.filter((entry) => isRecord(entry) && entry['decision'] === decision).length;
    const agendaCount = isRecord(session) ? session['agendaCount'] : undefined;
    createAdministrativeAct({
      guildId: guild.id,
      kind: 'parliament_session',
      actorId: interaction.user.id,
      summary: '国会を手動で開会',
      detail: { agendaCount: agendaCount ?? 0 }
    });
    await interaction.editReply(session
      ? `国会を開きました。議題 ${String(agendaCount)}件（立法 ${count('legislate')} / 継続審議 ${count('defer')} / 不採択 ${count('reject')} / 失敗 ${count('error')}）。`
      : '有効な憲法がないため開会できません。');
    await refreshDashboard(interaction, guild);
    return true;
  }
  if (customId === 'gov:admin:electorate') {
    requireOwner(interaction, guild);
    await interaction.reply(electoratePanel(governance));
    return true;
  }
  if (customId === 'gov:admin:disable_electorate') {
    requireOwner(interaction, guild);
    updateGovernanceGuild(guild.id, { trusted_role_id: '' });
    createAdministrativeAct({ guildId: guild.id, kind: 'trusted_role', actorId: interaction.user.id, summary: '特別有権者ロールの利用を停止', detail: { before: governance.trusted_role_id, after: '' } });
    await postAuthorityChange(guild, requireGovernanceGuild(guild.id), '特別有権者ロールの利用を停止', `運営者: <@${interaction.user.id}>`);
    await interaction.reply({ content: '新たな特別有権者の受付を停止しました。法令で必要な投票・承認は省略しません。', flags: EPHEMERAL });
    await refreshDashboard(interaction, guild);
    return true;
  }
  if (customId === 'gov:admin:enforcement') {
    if (governance.enforcement_mode === 'live') {
      await interaction.reply({
        content: '実執行を停止して記録のみに戻します。既に始まっている手続は止まりません。',
        components: [new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder().setCustomId('gov:admin:shadow_confirm').setLabel('記録のみに戻す').setStyle(ButtonStyle.Danger)
        )],
        flags: EPHEMERAL
      });
      return true;
    }
    const report = diagnostics(guild, governance);
    const lines = [
      '# 実執行の診断',
      report.blockers.length ? `開始できません:\n- ${report.blockers.join('\n- ')}` : '必須条件: OK',
      ...report.warnings.map((warning) => `注意: ${warning}`),
      '',
      '実執行ではtimeout・各種制限をBotが反映します。ban・kickは必要な承認後に管理者が手動で行い、案件カードの「執行完了」で記録します。'
    ];
    await interaction.reply({
      content: lines.join('\n'),
      components: report.blockers.length ? [] : [new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId('gov:admin:live_modal').setLabel('確認入力へ進む').setStyle(ButtonStyle.Danger)
      )],
      flags: EPHEMERAL
    });
    return true;
  }
  if (customId === 'gov:admin:live_modal') {
    const report = diagnostics(guild, governance);
    if (report.blockers.length > 0) throw new Error(report.blockers.join(' / '));
    await interaction.showModal(liveConfirmationModal(guild));
    return true;
  }
  if (customId === 'gov:admin:shadow_confirm') {
    updateGovernanceGuild(guild.id, { enforcement_mode: 'shadow' });
    createAdministrativeAct({ guildId: guild.id, kind: 'enforcement_mode', actorId: interaction.user.id, summary: '記録のみに変更', detail: { before: governance.enforcement_mode, after: 'shadow' } });
    await postAuthorityChange(guild, requireGovernanceGuild(guild.id), '実執行を停止', `運営者: <@${interaction.user.id}>`);
    await interaction.update({ content: '記録のみに戻しました。', components: [] });
    await refreshDashboard(interaction, guild);
    return true;
  }
  if (customId === 'gov:admin:recovery') {
    const failures = narrowList(listActionFailures(guild.id), isFailureRow, 'outbox failure');
    const notificationFailures = narrowList(listNotificationFailures(guild.id), isFailureRow, 'notification failure');
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
      components: failures.length || notificationFailures.length ? [new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId('gov:admin:retry').setLabel('失敗処理を再試行').setStyle(ButtonStyle.Primary)
      )] : [],
      flags: EPHEMERAL
    });
    return true;
  }
  if (customId === 'gov:admin:retry') {
    const actionCount = Number(retryFailedActions(guild.id));
    const notificationCount = Number(retryFailedNotifications(guild.id));
    writeAudit({ guildId: guild.id, actorType: 'operator', actorId: interaction.user.id, action: 'outbox.retry', targetType: 'guild', targetId: guild.id, detail: { actionCount, notificationCount } });
    await interaction.update({ content: `${actionCount + notificationCount}件を再試行待ちへ戻しました。`, components: [] });
    await refreshDashboard(interaction, guild);
    return true;
  }
  return false;
}
