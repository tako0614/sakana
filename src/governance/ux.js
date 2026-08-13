import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  MessageFlags,
  MessageType,
  ModalBuilder,
  RoleSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
  UserSelectMenuBuilder
} from 'discord.js';
import { governanceCategoryName, isGovernanceOperator, parseOperationalSetting } from './config.js';
import {
  archiveLegacyGovernanceMessage,
  createAdministrativeAct,
  getActiveConstitution,
  getCaseSanction,
  getGovernanceGuild,
  getOperationalSetting,
  listActionFailures,
  listCaseApprovals,
  listCases,
  listProposals,
  markLegacyGovernanceMessageDeleted,
  retryFailedActions,
  setOperationalSetting,
  updateGovernanceGuild,
  writeAudit
} from './db.js';
import {
  GOVERNANCE_PROCEDURE_NAME,
  GOVERNANCE_GUIDE_NAME,
  GOVERNANCE_PROCEDURE_TOPIC,
  createGovernanceProcedureChannel,
  createGovernanceGuideChannel,
  ensureGovernanceCourtForum,
  governanceProcedureOverwrites,
  governancePermissionReport,
  postGazette,
  readOnlyTextOverwrites,
  retireGovernanceCourtChat
} from './discord.js';
import { setTrustedMember } from './service.js';
import { summaryProcedure } from './policy.js';

const EPHEMERAL = MessageFlags.Ephemeral;
const ACTIVE_PROPOSAL_STATUSES = ['drafting', 'draft', 'constitutional_review', 'debate', 'voting'];
const ACTIVE_CASE_STATUSES = ['filing', 'summary_review', 'summary_active', 'defense', 'deliberation', 'approval', 'appeal_window', 'appeal', 'execution'];

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
    proposals: listProposals(guildId, { statuses: ACTIVE_PROPOSAL_STATUSES, limit: 100 }).length,
    cases: listCases(guildId, { statuses: ACTIVE_CASE_STATUSES, limit: 100 }).length
  };
}

function workflowFailures(governance) {
  return [
    ...listProposals(governance.guild_id, { statuses: ACTIVE_PROPOSAL_STATUSES, limit: 100 })
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

export async function renderGovernanceGuide(guild, governance) {
  const electorate = await electorateLabel(guild, governance);
  const counts = activeCounts(guild.id);
  const constitution = getActiveConstitution(guild.id);
  const summary = summaryProcedure(constitution?.policy);
  return [
    `# ${guild.name} 案内`,
    '',
    `状態: **${stateLabel(governance)}** / 執行: **${enforcementLabel(governance)}**`,
    governance.enforcement_mode === 'live'
      ? '成立した法律と確定判決に基づく処分が実際に執行されます。'
      : '現在は判決と監査記録だけを作り、Discord上の処分は実行しません。',
    `進行中: 法案 ${counts.proposals}件 / 事件 ${counts.cases}件`,
    `特別有権者: ${electorate}`,
    '',
    '## 参加方法',
    `- 法律・改憲を提案: <@&${governance.legislature_role_id}> に、解決したい問題を自然文で書く`,
    `- 違反申立て: 対象発言へ返信して <@&${governance.judiciary_role_id}> に審査理由を書く`,
    `- 違憲審査・上訴: <@&${governance.judiciary_role_id}> に対象案件と理由を書く`,
    `- 憲法・法律への質問: <@${guild.client.user.id}> に自然文で聞く`,
    '',
    'AIが整理しただけでは正式案件になりません。表示された受付内容を本人が確認して初めて手続が始まります。',
    '投票と執行承認は記名です。誰がどの選択をしたか、変更した場合の経過も対象の議会・裁判投稿へ公開されます。',
    summary
      ? '警告・機能制限・タイムアウトは、成立法と3席中2席以上の判定で即時に始まる場合があります。本人は「進行中」または通知から一度だけ裁判を求められ、裁判は24時間以内に終わります。kick・banは裁判前には行いません。'
      : '裁判中の発言範囲は事件投稿の「発言状態」に表示されます。一時保全は公開ログと成立法の条件が一致した時だけ短時間行い、自動終了します。',
    '',
    '## 公開記録',
    `- 投票・承認など、いま対応が必要な手続: <#${governance.admin_channel_id}>`,
    `- 議会: <#${governance.parliament_forum_id}>`,
    `- 裁判所: <#${governance.court_forum_id}>`,
    `- 現行憲法・法律: <#${governance.statute_forum_id}>`,
    `- 成立・判決・執行の履歴: <#${governance.gazette_channel_id}>`
  ].join('\n').slice(0, 2_000);
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
      new ButtonBuilder().setCustomId('gov:admin:recovery').setLabel('診断・復旧').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setLabel('公開手続を開く').setStyle(ButtonStyle.Link)
        .setURL(`https://discord.com/channels/${governance.guild_id}/${governance.admin_channel_id}`)
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
      '',
      `公開手続: <#${governance.admin_channel_id}> / 参加案内: <#${governance.guide_channel_id}>`,
      'ここで変更できるのはBotの運用値だけです。憲法・投票・司法policyは改憲手続を経なければ変更できません。'
    ].join('\n').slice(0, 1_900),
    components: operationsComponents(governance),
    allowedMentions: { parse: [] }
  };
}

function safeLabel(value, maximum = 60) {
  return String(value ?? '').replace(/[\[\]()*_`]/g, '').replace(/\s+/g, ' ').trim().slice(0, maximum);
}

function recordLink(guildId, channelId, label) {
  const text = safeLabel(label);
  return channelId ? `[${text}](https://discord.com/channels/${guildId}/${channelId})` : text;
}

function deadline(value, prefix = '締切') {
  return value ? ` / ${prefix} <t:${Math.floor(Number(value) / 1000)}:R>` : '';
}

function procedureComponents(governance, supportsImmediateReview) {
  const link = (label, channelId) => new ButtonBuilder().setLabel(label).setStyle(ButtonStyle.Link)
    .setURL(`https://discord.com/channels/${governance.guild_id}/${channelId}`);
  return [
    new ActionRowBuilder().addComponents(
      link('議会', governance.parliament_forum_id),
      link('裁判所', governance.court_forum_id),
      link('法令集', governance.statute_forum_id),
      link('官報', governance.gazette_channel_id),
      link('使い方', governance.guide_channel_id)
    ),
    supportsImmediateReview ? new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('gov:review_list:0').setLabel('自分の即時処分を確認').setStyle(ButtonStyle.Primary)
    ) : null
  ].filter(Boolean);
}

export async function renderGovernanceProcedureHub(guild, governance) {
  const supportsImmediateReview = Boolean(summaryProcedure(getActiveConstitution(guild.id)?.policy));
  const voting = listProposals(guild.id, { statuses: ['voting'], limit: 20 });
  const approvals = listCases(guild.id, { statuses: ['approval'], limit: 20 });
  const debates = listProposals(guild.id, { statuses: ['debate'], limit: 20 });
  const defenses = listCases(guild.id, { statuses: ['defense'], limit: 20 });
  const appeals = listCases(guild.id, { statuses: ['appeal_window'], limit: 20 });
  const votingLines = voting.slice(0, 6).map((proposal) =>
    `- ${recordLink(guild.id, proposal.forum_thread_id, proposal.title)} / ${proposal.vote_scope === 'all' ? '全員' : '特別有権者'}${deadline(proposal.stage_ends_at)}`
  );
  const approvalLines = approvals.slice(0, 6).map((caseRecord) => {
    const sanction = getCaseSanction(caseRecord.id);
    const approved = listCaseApprovals(caseRecord.id).filter((entry) => entry.decision === 'approve').length;
    return `- ${recordLink(guild.id, caseRecord.public_thread_id, `処分の承認: ${caseRecord.summary}`)} / ${approved}/${sanction?.required_approvals ?? '?'}人`;
  });
  const responseLines = [
    ...appeals.map((caseRecord) => {
      const sanction = getCaseSanction(caseRecord.id);
      return `- ${recordLink(guild.id, caseRecord.public_thread_id, `上訴受付: ${caseRecord.summary}`)}${deadline(sanction?.appeal_deadline)}`;
    }),
    ...defenses.map((caseRecord) =>
      `- ${recordLink(guild.id, caseRecord.public_thread_id, `回答受付: ${caseRecord.summary}`)}${deadline(caseRecord.defense_until)}`
    ),
    ...debates.map((proposal) =>
      `- ${recordLink(guild.id, proposal.forum_thread_id, `${proposal.title}を討議中`)}${deadline(proposal.stage_ends_at)}`
    )
  ].slice(0, 8);
  const omitted = Math.max(0, voting.length - votingLines.length)
    + Math.max(0, approvals.length - approvalLines.length)
    + Math.max(0, appeals.length + defenses.length + debates.length - responseLines.length);
  return {
    content: [
      `# ${guild.name} 進行中`,
      '',
      'いま対応できる手続です。詳しい説明と操作はリンク先にあります。',
      '',
      '## 投票',
      ...(votingLines.length ? votingLines : ['いま投票はありません。']),
      '',
      '## 承認',
      ...(approvalLines.length ? approvalLines : ['いま承認待ちはありません。']),
      '',
      '## 裁判・討議',
      ...(responseLines.length ? responseLines : ['いま受付中の案件はありません。']),
      omitted ? `\nほか ${omitted}件は議会・裁判所から確認できます。` : null,
      ''
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

  let guide = current.guide_channel_id ? await guild.channels.fetch(current.guide_channel_id).catch(() => null) : null;
  if (!guide || guide.type !== ChannelType.GuildText) guide = await createGovernanceGuideChannel(guild, category.id);
  if (guide.name !== GOVERNANCE_GUIDE_NAME) await guide.setName(GOVERNANCE_GUIDE_NAME, '参加案内の名称を同期');
  const guideOverwrites = readOnlyTextOverwrites(guild);
  if (!requiredPermissionOverwritesMatch(guide, guideOverwrites)) {
    await reconcileRequiredPermissionOverwrites(guide, guideOverwrites, '案内を公開読み取り専用に同期');
  }

  let admin = current.admin_channel_id ? await guild.channels.fetch(current.admin_channel_id).catch(() => null) : null;
  if (!admin || admin.type !== ChannelType.GuildText) admin = await createGovernanceProcedureChannel(guild, category.id);
  if (admin.name !== GOVERNANCE_PROCEDURE_NAME) await admin.setName(GOVERNANCE_PROCEDURE_NAME, '公開手続の名称を同期');
  if (admin.topic !== GOVERNANCE_PROCEDURE_TOPIC) await admin.setTopic(GOVERNANCE_PROCEDURE_TOPIC, '統治手続の説明を同期');
  const adminOverwrites = governanceProcedureOverwrites(guild);
  if (!requiredPermissionOverwritesMatch(admin, adminOverwrites)) {
    await reconcileRequiredPermissionOverwrites(admin, adminOverwrites, '進行中を公開読み取り専用に同期');
  }

  const siblings = [...guild.channels.cache.values()].filter((channel) => channel.parentId === category.id);
  const firstPosition = Math.min(...siblings.map((channel) => channel.position));
  const lastPosition = Math.max(...siblings.map((channel) => channel.position));
  if (Number.isFinite(firstPosition) && guide.position !== firstPosition) {
    await guide.setPosition(firstPosition, { reason: '案内をカテゴリ先頭へ移動' });
  }
  if (Number.isFinite(lastPosition) && admin.position !== lastPosition) {
    await admin.setPosition(lastPosition, { reason: '進行中をカテゴリ末尾へ移動' });
  }

  if (guide.id !== current.guide_channel_id || admin.id !== current.admin_channel_id) {
    current = updateGovernanceGuild(guild.id, { guide_channel_id: guide.id, admin_channel_id: admin.id });
  }
  const guideContent = await renderGovernanceGuide(guild, current);
  let guideMessage = await fetchTrackedMessage(guide, current.guide_message_id, `# ${guild.name} 案内`);
  if (!guideMessage) guideMessage = await guide.send({ content: guideContent, allowedMentions: { parse: [] } });
  else if (guideMessage.content !== guideContent) await guideMessage.edit({ content: guideContent, allowedMentions: { parse: [] } });

  const dashboard = await renderGovernanceProcedureHub(guild, current);
  let adminMessage = await fetchTrackedMessage(admin, current.admin_dashboard_message_id, `# ${guild.name} 進行中`);
  if (!adminMessage) adminMessage = await admin.send(dashboard);
  else if (adminMessage.content !== dashboard.content || !componentsMatch(adminMessage, dashboard.components)) {
    await adminMessage.edit(dashboard);
  }

  if (guideMessage.id !== current.guide_message_id || adminMessage.id !== current.admin_dashboard_message_id) {
    current = updateGovernanceGuild(guild.id, {
      guide_message_id: guideMessage.id,
      admin_dashboard_message_id: adminMessage.id
    });
  }
  return { governance: current, guide, admin, guideMessage, adminMessage };
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

function interactionName(message) {
  return message.interaction?.commandName ?? message.interactionMetadata?.name ?? '';
}

export function legacyGazetteCandidates(messages, botId) {
  const sorted = [...messages].sort((a, b) => a.createdTimestamp - b.createdTimestamp);
  const ids = new Set();
  for (let index = 0; index < sorted.length; index += 1) {
    const message = sorted[index];
    if (message.author.id === botId && message.content.split('\n', 1)[0].trim() === '# 初期憲法 v1') {
      for (let cursor = index; cursor < sorted.length; cursor += 1) {
        const candidate = sorted[cursor];
        if (candidate.author.id !== botId || candidate.createdTimestamp - message.createdTimestamp > 60_000) break;
        ids.add(candidate.id);
        if (/policy hash:/i.test(candidate.content)) break;
      }
    }
    if (message.author.id === botId && message.content.startsWith('現行憲法 v1')
      && message.attachments?.some?.((attachment) => attachment.name === 'constitution-v1.md')) ids.add(message.id);
    if (message.type === MessageType.ChatInputCommand && interactionName(message) === 'constitution') ids.add(message.id);
  }
  return sorted.filter((message) => ids.has(message.id));
}

export function legacyStatuteTechnicalCandidates(messages) {
  return [...messages].filter((message) => {
    const normalized = String(message.content ?? '').trim()
      .replace(/^```(?:bash|sh)?\s*/i, '')
      .replace(/\s*```$/, '')
      .trim();
    return normalized === 'git pull -ff-only';
  });
}

async function scanLegacyGovernancePosts(guild, governance) {
  const gazette = await guild.channels.fetch(governance.gazette_channel_id);
  const gazetteMessages = await gazette.messages.fetch({ limit: 100 });
  const scannedGazette = [...gazetteMessages.values()];
  const gazetteCandidates = legacyGazetteCandidates(scannedGazette, guild.client.user.id);
  const statuteForum = await guild.channels.fetch(governance.statute_forum_id).catch(() => null);
  const statuteCandidates = [];
  if (statuteForum?.type === ChannelType.GuildForum) {
    const [active, archived] = await Promise.all([
      statuteForum.threads.fetchActive().catch(() => null),
      statuteForum.threads.fetchArchived({ limit: 100 }).catch(() => null)
    ]);
    const threads = new Map([
      ...[...(active?.threads?.values?.() ?? [])].map((thread) => [thread.id, thread]),
      ...[...(archived?.threads?.values?.() ?? [])].map((thread) => [thread.id, thread])
    ]);
    for (const thread of threads.values()) {
      const messages = await thread.messages.fetch({ limit: 100 }).catch(() => null);
      if (messages) statuteCandidates.push(...legacyStatuteTechnicalCandidates(messages.values()));
    }
  }
  const candidates = new Map([...gazetteCandidates, ...statuteCandidates].map((message) => [message.id, message]));
  return {
    scannedGazette,
    gazetteCandidateIds: new Set(gazetteCandidates.map((message) => message.id)),
    candidates: [...candidates.values()]
  };
}

async function archivedAttachments(message) {
  const output = [];
  for (const attachment of message.attachments.values()) {
    const record = { id: attachment.id, name: attachment.name, contentType: attachment.contentType, size: attachment.size, url: attachment.url };
    if (attachment.size > 5_000_000) {
      throw new Error(`旧官報 ${message.id} の添付 ${attachment.name} は5 MBを超えるため、完全に保存するまで削除しません。`);
    }
    const response = await fetch(attachment.url);
    if (!response.ok) {
      throw new Error(`旧官報 ${message.id} の添付 ${attachment.name} を保存できません (HTTP ${response.status})。削除していません。`);
    }
    record.dataBase64 = Buffer.from(await response.arrayBuffer()).toString('base64');
    output.push(record);
  }
  return output;
}

async function cleanupLegacyGazette(interaction, governance) {
  const { candidates, scannedGazette, gazetteCandidateIds } = await scanLegacyGovernancePosts(interaction.guild, governance);
  if (candidates.length === 0) return 0;
  const constitution = getActiveConstitution(interaction.guildId);
  for (const message of candidates) {
    const attachments = await archivedAttachments(message);
    archiveLegacyGovernanceMessage({
      guildId: interaction.guildId,
      channelId: message.channelId,
      messageId: message.id,
      authorId: message.author.id,
      content: message.content,
      attachments,
      createdAt: message.createdTimestamp,
      reason: '統治UX v2の要約＋詳細形式へ置換'
    });
  }
  const replacementHeading = `# 初期憲法 v${constitution?.version ?? 1} 公布`;
  const alreadyReplaced = scannedGazette.some((message) => message.author.id === interaction.guild.client.user.id
    && message.content.startsWith(replacementHeading));
  if (gazetteCandidateIds.size > 0 && !alreadyReplaced) {
    await postGazette(
      interaction.guild,
      governance,
      `初期憲法 v${constitution?.version ?? 1} 公布`,
      `初期憲法を公布しました。\n本文hash: ${constitution?.content_hash ?? '不明'}\npolicy hash: ${constitution?.policy_hash ?? '不明'}`,
      {
        summary: `初期憲法 v${constitution?.version ?? 1} を公布しました。現行正文は法令集を参照してください。`,
        links: [`法令集: https://discord.com/channels/${interaction.guildId}/${governance.statute_forum_id}`]
      }
    );
  }
  for (const message of candidates) {
    await message.delete().catch((error) => {
      throw new Error(`旧官報 ${message.id} を削除できません: ${error?.message ?? error}`);
    });
    markLegacyGovernanceMessageDeleted(interaction.guildId, message.channelId, message.id);
  }
  createAdministrativeAct({
    guildId: interaction.guildId,
    kind: 'legacy_governance_post_cleanup',
    actorId: interaction.user.id,
    summary: `旧統治技術投稿${candidates.length}件を監査アーカイブ後に整理`,
    detail: { operation: 'legacy_governance_post_cleanup', messageIds: candidates.map((message) => message.id) }
  });
  return candidates.length;
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
    await postGazette(interaction.guild, current, '実執行を有効化', `運営者: <@${interaction.user.id}>`, { summary: '権限診断と二段階確認を経て、確定判決の実執行を有効化しました。' });
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
    await postGazette(interaction.guild, governance, '特別有権者ロール変更', `変更後: ${role.name}\n運営者: <@${interaction.user.id}>`, { summary: `特別有権者ロールを「${role.name}」へ変更しました。` });
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
    await interaction.editReply('管理画面と参加者向け案内を更新しました。');
    return true;
  }
  if (customId === 'gov:admin:toggle_state') {
    const next = governance.status === 'active' ? 'paused' : 'active';
    updateGovernanceGuild(interaction.guildId, { status: next });
    createAdministrativeAct({ guildId: interaction.guildId, kind: 'governance_status', actorId: interaction.user.id, summary: `統治機能を${next === 'active' ? '再開' : '一時停止'}`, detail: { before: governance.status, after: next } });
    await postGazette(interaction.guild, governance, next === 'active' ? '統治機能を再開' : '統治機能を一時停止', `運営者: <@${interaction.user.id}>`);
    await interaction.reply({ content: next === 'active' ? '統治機能を再開しました。' : '新しい統治処理を一時停止しました。', flags: EPHEMERAL });
    await refreshDashboard(interaction);
    return true;
  }
  if (customId === 'gov:admin:settings') {
    await interaction.showModal(settingsModal(interaction.guildId));
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
    await postGazette(interaction.guild, governance, '特別有権者機能を無効化', `運営者: <@${interaction.user.id}>`, { summary: '特別有権者の拒否権と重い刑の承認機能を無効化しました。' });
    await interaction.reply({ content: '特別有権者機能を無効化しました。', flags: EPHEMERAL });
    await refreshDashboard(interaction);
    return true;
  }
  if (customId === 'gov:admin:enforcement') {
    if (governance.enforcement_mode === 'live') {
      await interaction.reply({
        content: '実執行を停止して記録のみに戻します。進行中の手続は止まりません。',
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
    await postGazette(interaction.guild, governance, '実執行を停止', `運営者: <@${interaction.user.id}>`, { summary: 'Discord上の処分を停止し、判決と監査記録だけを残す状態へ変更しました。' });
    await interaction.update({ content: '記録のみに戻しました。', components: [] });
    await refreshDashboard(interaction);
    return true;
  }
  if (customId === 'gov:admin:recovery') {
    const failures = listActionFailures(interaction.guildId);
    const workflows = workflowFailures(governance);
    const details = [
      ...failures.map((failure) => `Discord処理: ${failure.last_error}`),
      ...workflows
    ].slice(0, 5);
    await interaction.reply({
      content: failures.length || workflows.length
        ? [
          `Discord処理の失敗 ${failures.length}件 / 自動再試行中の手続き ${workflows.length}件`,
          ...details.map((detail) => `- ${String(detail).slice(0, 300)}`),
          failures.length ? 'Discord処理の再試行は同じ重複防止キーを使います。' : null
        ].filter(Boolean).join('\n').slice(0, 1_900)
        : '失敗または再試行中の処理はありません。',
      components: failures.length ? [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('gov:admin:retry').setLabel('失敗処理を再試行').setStyle(ButtonStyle.Primary)
      )] : [],
      flags: EPHEMERAL
    });
    return true;
  }
  if (customId === 'gov:admin:retry') {
    const count = retryFailedActions(interaction.guildId);
    writeAudit({ guildId: interaction.guildId, actorType: 'operator', actorId: interaction.user.id, action: 'outbox.retry', targetType: 'guild', targetId: interaction.guildId, detail: { count } });
    await interaction.update({ content: `${count}件を再試行待ちへ戻しました。`, components: [] });
    await refreshDashboard(interaction);
    return true;
  }
  if (customId === 'gov:admin:legacy') {
    const { candidates } = await scanLegacyGovernancePosts(interaction.guild, governance);
    await interaction.reply({
      content: candidates.length
        ? `官報の旧形式投稿または法令スレッドの既知の誤送信が${candidates.length}件見つかりました。本文と添付を内部監査アーカイブへ保存し、必要な公布記録を作成してから削除します。`
        : '整理対象の旧技術投稿はありません。',
      components: candidates.length ? [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('gov:admin:legacy_confirm').setLabel(`${candidates.length}件をアーカイブして削除`).setStyle(ButtonStyle.Danger)
      )] : [],
      flags: EPHEMERAL
    });
    return true;
  }
  if (customId === 'gov:admin:legacy_confirm') {
    await interaction.deferUpdate();
    const count = await cleanupLegacyGazette(interaction, governance);
    await interaction.editReply({ content: `${count}件を監査アーカイブへ保存して整理しました。`, components: [] });
    await refreshDashboard(interaction);
    return true;
  }
  return false;
}
