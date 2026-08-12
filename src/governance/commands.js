import {
  InteractionContextType,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder
} from 'discord.js';
import { parseDiscordRef } from '../agent/format.js';
import {
  governanceConfig,
  isGovernanceOperator,
  loadBootstrapDocuments,
  parseOperationalSetting
} from './config.js';
import {
  bootstrapGovernanceGuild,
  createAdministrativeAct,
  getActiveConstitution,
  getAdministrativeAct,
  getCase,
  getGovernanceGuild,
  getOperationalSetting,
  getLaw,
  getProposal,
  listCaseDecisions,
  listCaseEvidence,
  listCaseSubmissions,
  listActionFailures,
  listAdministrativeActs,
  listAudit,
  listCases,
  listLaws,
  listOperationalSettings,
  listProposalVotes,
  listProposals,
  proposalVoteSummary,
  proposalElectorate,
  retryFailedActions,
  setOperationalSetting,
  updateGovernanceGuild,
  writeAudit
} from './db.js';
import {
  createGovernanceSurfaces,
  governancePermissionReport,
  postGazette
} from './discord.js';
import {
  addEvidenceToCase,
  appealCase,
  approveCase,
  backfillGovernanceActivity,
  castAndPublishVote,
  fileAmendment,
  fileConstitutionalChallenge,
  fileCriminalCase,
  filePetition,
  setTrustedMember
} from './service.js';

const EPHEMERAL = MessageFlags.Ephemeral;

function requireGuild(interaction) {
  if (!interaction.guildId || !interaction.guild) throw new Error('サーバー内でのみ使えます。');
}

function requireInitialized(interaction) {
  requireGuild(interaction);
  const governance = getGovernanceGuild(interaction.guildId);
  if (!governance) throw new Error('統治機能が初期化されていません。');
  return governance;
}

function requireOperator(interaction) {
  if (!isGovernanceOperator(interaction.member)) throw new Error('Discord ownerまたはGOVERNANCE_OPERATOR_USERSだけが実行できます。');
}

async function fetchEvidence(interaction, raw, { requiredViewerIds = [] } = {}) {
  const parsed = parseDiscordRef(raw);
  if (!parsed?.messageId) throw new Error('証拠にはDiscordメッセージリンクまたはメッセージIDを指定してください。');
  if (parsed.guildId && parsed.guildId !== interaction.guildId) throw new Error('別サーバーのメッセージは証拠にできません。');
  const channelId = parsed.channelId ?? interaction.channelId;
  const channel = await interaction.guild.channels.fetch(channelId).catch(() => null);
  if (!channel?.isTextBased?.()) throw new Error('証拠チャンネルを読めません。');
  const member = interaction.member ?? await interaction.guild.members.fetch(interaction.user.id);
  if (!channel.permissionsFor(member)?.has(PermissionFlagsBits.ViewChannel)) throw new Error('自分が閲覧できないメッセージは提出できません。');
  for (const userId of new Set(requiredViewerIds.filter(Boolean))) {
    const viewer = await interaction.guild.members.fetch(userId).catch(() => null);
    if (!viewer || !channel.permissionsFor(viewer)?.has(PermissionFlagsBits.ViewChannel)) {
      throw new Error('相手当事者が閲覧できないチャンネルの内容は証拠にできません。共有可能な裁判チャットへ提示してください。');
    }
  }
  const message = await channel.messages.fetch(parsed.messageId).catch(() => null);
  if (!message) throw new Error('証拠メッセージが見つかりません。');
  const content = [message.content, ...message.attachments.map((attachment) => `[添付] ${attachment.name} ${attachment.url}`)]
    .filter(Boolean).join('\n');
  if (!content) throw new Error('保存できる本文または添付名がありません。');
  return {
    messageId: message.id,
    channelId: message.channelId,
    authorId: message.author.id,
    content: content.slice(0, 8000),
    occurredAt: message.createdTimestamp
  };
}

function linkToThread(guildId, threadId) {
  return `https://discord.com/channels/${guildId}/${threadId}`;
}

function statusText(governance, interaction) {
  const constitution = getActiveConstitution(interaction.guildId);
  const permissions = governancePermissionReport(interaction.guild);
  const workflowErrors = [
    ...listProposals(interaction.guildId, {
      statuses: ['drafting', 'constitutional_review', 'debate', 'voting'],
      limit: 100
    }).filter((proposal) => proposal.last_error).map((proposal) => `L-${proposal.id}: ${proposal.last_error.slice(0, 160)}`),
    ...listCases(interaction.guildId, {
      statuses: ['filing', 'defense', 'deliberation', 'appeal_window', 'appeal'],
      limit: 100
    }).filter((caseRecord) => caseRecord.last_error).map((caseRecord) => `C-${caseRecord.id}: ${caseRecord.last_error.slice(0, 160)}`),
    ...listActionFailures(interaction.guildId).map((action) => `outbox-${action.id}: ${String(action.last_error).slice(0, 160)}`)
  ];
  return [
    `状態: ${governance.status}`,
    `執行mode: ${governance.enforcement_mode}`,
    `憲法: v${constitution?.version ?? '?'} / ${constitution?.content_hash?.slice(0, 12) ?? '?'}`,
    `trusted role: ${governance.trusted_role_id ? `<@&${governance.trusted_role_id}> (名前はサーバー側の表示だけに使用)` : 'なし (任意機能は無効)'}`,
    `議会: <#${governance.parliament_forum_id}> / 裁判所: <#${governance.court_forum_id}> / 官報: <#${governance.gazette_channel_id}>`,
    `bot権限: ${permissions.ok ? 'OK' : `不足 ${permissions.missing.join(', ')}`}`,
    governance.weekly_last_error ? `週次AI再試行中: ${governance.weekly_last_error}` : null,
    workflowErrors.length > 0 ? `workflow再試行/失敗:\n${workflowErrors.slice(0, 5).join('\n')}` : 'workflow: OK',
    ...listOperationalSettings(interaction.guildId).map((row) => `${row.key}: ${row.value}`)
  ].filter(Boolean).join('\n').slice(0, 1900);
}

const governanceCommand = {
  data: new SlashCommandBuilder()
    .setName('governance')
    .setDescription('Sakana統治機能の初期化・状態・運用設定')
    .setContexts(InteractionContextType.Guild)
    .addSubcommand((sub) => sub
      .setName('bootstrap')
      .setDescription('初期憲法と統治チャンネルを作成します (owner/operator)')
      .addRoleOption((option) => option.setName('trusted_role').setDescription('任意: trusted userとして扱う既存ロール').setRequired(false)))
    .addSubcommand((sub) => sub.setName('status').setDescription('統治状態と権限を表示します'))
    .addSubcommand((sub) => sub.setName('pause').setDescription('新しい統治処理を停止します (owner/operator)'))
    .addSubcommand((sub) => sub.setName('resume').setDescription('停止した統治処理を再開します (owner/operator)'))
    .addSubcommand((sub) => sub.setName('backfill').setDescription('公開活動履歴をarchiveから再取込みします (owner/operator)'))
    .addSubcommand((sub) => sub.setName('retry-outbox').setDescription('失敗したDiscord執行を再試行可能に戻します (owner/operator)'))
    .addSubcommand((sub) => sub
      .setName('enforcement')
      .setDescription('shadow/liveを切り替えます (owner/operator)')
      .addStringOption((option) => option.setName('mode').setDescription('執行mode').setRequired(true)
        .addChoices({ name: 'shadow', value: 'shadow' }, { name: 'live', value: 'live' })))
    .addSubcommand((sub) => sub
      .setName('config')
      .setDescription('運用設定だけを変更します (owner/operator)')
      .addStringOption((option) => option.setName('key').setDescription('運用設定').setRequired(true)
        .addChoices(
          { name: 'weekly_scan_enabled', value: 'weekly_scan_enabled' },
          { name: 'weekly_draft_limit', value: 'weekly_draft_limit' },
          { name: 'general_daily_calls', value: 'general_daily_calls' },
          { name: 'trusted_daily_calls', value: 'trusted_daily_calls' }
        ))
      .addNumberOption((option) => option.setName('value').setDescription('新しい値').setRequired(true)))
    .addSubcommand((sub) => sub
      .setName('trusted-role')
      .setDescription('trusted userの正本ロールを変更します (Discord ownerのみ)')
      .addRoleOption((option) => option.setName('role').setDescription('新しいロール').setRequired(true)))
    .addSubcommand((sub) => sub
      .setName('trusted-disable')
      .setDescription('trusted user機能を無効化します (Discord ownerのみ)'))
    .addSubcommand((sub) => sub
      .setName('trusted-add')
      .setDescription('trusted userを追加します (Discord ownerのみ)')
      .addUserOption((option) => option.setName('user').setDescription('対象member').setRequired(true)))
    .addSubcommand((sub) => sub
      .setName('trusted-remove')
      .setDescription('trusted userを削除します (Discord ownerのみ)')
      .addUserOption((option) => option.setName('user').setDescription('対象member').setRequired(true)))
    .addSubcommand((sub) => sub.setName('audit').setDescription('最新の公開監査ログを表示します')),

  async execute(interaction) {
    requireGuild(interaction);
    const sub = interaction.options.getSubcommand();
    if (sub === 'bootstrap') {
      requireOperator(interaction);
      if (getGovernanceGuild(interaction.guildId)) throw new Error('既に初期化済みです。');
      const role = interaction.options.getRole('trusted_role');
      if (role && (role.managed || role.id === interaction.guildId)) throw new Error('managed roleや@everyoneはtrusted roleにできません。');
      if (role && role.position >= interaction.guild.members.me.roles.highest.position) {
        throw new Error('trusted roleはbotの最高roleより下に置いてください。');
      }
      await interaction.deferReply({ flags: EPHEMERAL });
      const surfaces = await createGovernanceSurfaces(interaction.guild);
      const documents = loadBootstrapDocuments();
      const result = bootstrapGovernanceGuild({
        guildId: interaction.guildId,
        enactedBy: interaction.user.id,
        trustedRoleId: role?.id ?? '',
        // 初期化時は必ずshadow。環境変数だけで実制裁を有効化できないようにする。
        enforcementMode: 'shadow',
        constitution: documents.constitution,
        policy: documents.policy,
        ...surfaces
      });
      const warnings = [];
      const backfilled = await backfillGovernanceActivity(interaction.guild).catch((error) => {
        console.error('Governance activity backfill failed after bootstrap:', error);
        warnings.push('活動履歴の初回取込みに失敗しました。以後の新着は記録されます。');
        return 0;
      });
      await postGazette(interaction.guild, result.guild, '初期憲法 v1', `${result.constitution.content}\n\n## Policy\n\n\`\`\`json\n${JSON.stringify(result.constitution.policy, null, 2)}\n\`\`\`\n\ncontent hash: ${result.constitution.content_hash}\npolicy hash: ${result.constitution.policy_hash}`).catch((error) => {
        console.error('Initial constitution gazette publication failed:', error);
        warnings.push('官報への初期憲法掲載に失敗しました。`/constitution show`では取得できます。');
      });
      await interaction.editReply(`初期化しました。trusted role: ${role ? `${role.name} (${role.id})` : 'なし'}。直近活動 ${backfilled}件を取り込みました。執行modeは ${result.guild.enforcement_mode} です。${warnings.length ? `\n注意: ${warnings.join(' ')}` : ''}`);
      return;
    }
    const governance = requireInitialized(interaction);
    if (sub === 'status') {
      await interaction.reply({ content: statusText(governance, interaction), flags: EPHEMERAL, allowedMentions: { parse: [] } });
      return;
    }
    if (sub === 'audit') {
      const lines = listAudit(interaction.guildId, 20).reverse().map((entry) => `#${entry.id} <t:${Math.floor(entry.created_at / 1000)}:f> ${entry.action} ${entry.target_type ?? ''}:${entry.target_id ?? ''} actor:${entry.actor_id ?? entry.actor_type}`);
      await interaction.reply({ content: lines.join('\n') || '監査記録はありません。', allowedMentions: { parse: [] } });
      return;
    }
    requireOperator(interaction);
    if (sub === 'trusted-add' || sub === 'trusted-remove') {
      if (!governance.trusted_role_id) throw new Error('trusted roleが設定されていません。先に /governance trusted-role を実行してください。');
      const member = interaction.options.getMember('user')
        ?? await interaction.guild.members.fetch(interaction.options.getUser('user', true).id);
      const changed = await setTrustedMember(
        interaction.guild,
        interaction.user.id,
        member,
        sub === 'trusted-add'
      );
      if (changed) createAdministrativeAct({
        guildId: interaction.guildId,
        kind: sub === 'trusted-add' ? 'trusted_member_add' : 'trusted_member_remove',
        actorId: interaction.user.id,
        summary: `${member.id} のtrusted membershipを変更`,
        detail: { operation: sub, userId: member.id, roleId: governance.trusted_role_id }
      });
      await interaction.reply({
        content: changed
          ? `${member.user.username} を ${sub === 'trusted-add' ? 'trusted userに追加' : 'trusted userから削除'}しました。`
          : '既にその状態です。',
        flags: EPHEMERAL
      });
      return;
    }
    if (sub === 'backfill') {
      await interaction.deferReply({ flags: EPHEMERAL });
      const count = await backfillGovernanceActivity(interaction.guild);
      await interaction.editReply(`公開活動履歴を ${count} 件追加しました (既存message IDは重複しません)。`);
      return;
    }
    if (sub === 'retry-outbox') {
      const count = retryFailedActions(interaction.guildId);
      writeAudit({ guildId: interaction.guildId, actorType: 'operator', actorId: interaction.user.id, action: 'outbox.retry', targetType: 'guild', targetId: interaction.guildId, detail: { count } });
      await interaction.reply({ content: `${count}件を再試行待ちへ戻しました。`, flags: EPHEMERAL });
      return;
    }
    if (sub === 'pause' || sub === 'resume') {
      const status = sub === 'pause' ? 'paused' : 'active';
      const before = governance.status;
      updateGovernanceGuild(interaction.guildId, { status });
      createAdministrativeAct({ guildId: interaction.guildId, kind: 'governance_status', actorId: interaction.user.id, summary: `統治状態を ${status} に変更`, detail: { operation: 'governance_status', before, after: status } });
      writeAudit({ guildId: interaction.guildId, actorType: 'operator', actorId: interaction.user.id, action: `governance.${status}`, targetType: 'guild', targetId: interaction.guildId });
      await postGazette(interaction.guild, governance, `統治機能 ${status}`, `operator: <@${interaction.user.id}>`);
      await interaction.reply({ content: `統治機能を ${status} にしました。`, flags: EPHEMERAL });
      return;
    }
    if (sub === 'enforcement') {
      const mode = interaction.options.getString('mode', true);
      if (mode === 'live') {
        const report = governancePermissionReport(interaction.guild);
        if (!report.ok) throw new Error(`liveに必要なbot権限がありません: ${report.missing.join(', ')}`);
      }
      updateGovernanceGuild(interaction.guildId, { enforcement_mode: mode });
      createAdministrativeAct({ guildId: interaction.guildId, kind: 'enforcement_mode', actorId: interaction.user.id, summary: `執行modeを ${mode} に変更`, detail: { operation: 'enforcement_mode', before: governance.enforcement_mode, after: mode } });
      writeAudit({ guildId: interaction.guildId, actorType: 'operator', actorId: interaction.user.id, action: 'enforcement.mode', targetType: 'guild', targetId: interaction.guildId, detail: { mode } });
      await postGazette(interaction.guild, governance, '執行mode変更', `mode: ${mode}\noperator: <@${interaction.user.id}>`);
      await interaction.reply({ content: `執行modeを ${mode} にしました。`, flags: EPHEMERAL });
      return;
    }
    if (sub === 'config') {
      const key = interaction.options.getString('key', true);
      const parsed = parseOperationalSetting(key, interaction.options.getNumber('value', true));
      if (!parsed.ok) throw new Error(parsed.error);
      const before = getOperationalSetting(interaction.guildId, key);
      setOperationalSetting(interaction.guildId, key, parsed.value, interaction.user.id);
      createAdministrativeAct({ guildId: interaction.guildId, kind: 'operational_setting', actorId: interaction.user.id, summary: `${key} を ${parsed.value} に変更`, detail: { operation: 'operational_setting', key, before, after: parsed.value } });
      await interaction.reply({ content: `${key} = ${parsed.value} にしました。`, flags: EPHEMERAL });
      return;
    }
    if (sub === 'trusted-role') {
      if (interaction.user.id !== interaction.guild.ownerId) throw new Error('trusted roleの正本変更はDiscord ownerだけが実行できます。');
      const role = interaction.options.getRole('role', true);
      if (role.managed || role.id === interaction.guildId) throw new Error('managed roleや@everyoneは指定できません。');
      if (role.position >= interaction.guild.members.me.roles.highest.position) {
        throw new Error('trusted roleはbotの最高roleより下に置いてください。');
      }
      const before = governance.trusted_role_id;
      updateGovernanceGuild(interaction.guildId, { trusted_role_id: role.id });
      createAdministrativeAct({ guildId: interaction.guildId, kind: 'trusted_role', actorId: interaction.user.id, summary: `trusted roleを ${role.id} に変更`, detail: { operation: 'trusted_role', before, after: role.id } });
      writeAudit({ guildId: interaction.guildId, actorType: 'operator', actorId: interaction.user.id, action: 'trusted.role_changed', targetType: 'role', targetId: role.id, detail: { before } });
      await postGazette(interaction.guild, governance, 'trusted role変更', `before: ${before}\nafter: ${role.id} (${role.name})\noperator: <@${interaction.user.id}>`);
      await interaction.reply({ content: `trusted roleを ${role.name} に変更しました。進行中投票のsnapshotは変わりません。`, flags: EPHEMERAL });
      return;
    }
    if (sub === 'trusted-disable') {
      if (interaction.user.id !== interaction.guild.ownerId) throw new Error('trusted機能の無効化はDiscord ownerだけが実行できます。');
      const before = governance.trusted_role_id;
      updateGovernanceGuild(interaction.guildId, { trusted_role_id: '' });
      createAdministrativeAct({ guildId: interaction.guildId, kind: 'trusted_role', actorId: interaction.user.id, summary: 'trusted user機能を無効化', detail: { operation: 'trusted_role', before, after: '' } });
      writeAudit({ guildId: interaction.guildId, actorType: 'operator', actorId: interaction.user.id, action: 'trusted.disabled', targetType: 'role', targetId: before, detail: {} });
      await postGazette(interaction.guild, governance, 'trusted user機能を無効化', `before: ${before || 'なし'}\noperator: <@${interaction.user.id}>`);
      await interaction.reply({ content: 'trusted user機能を無効化しました。trusted拒否権と承認が必要な刑は利用できません。', flags: EPHEMERAL });
    }
  }
};

const petitionCommand = {
  data: new SlashCommandBuilder()
    .setName('petition')
    .setDescription('法律の制定を正式に請願します')
    .setContexts(InteractionContextType.Guild)
    .addSubcommand((sub) => sub
      .setName('file')
      .setDescription('AIに法案を起草させ、正式手続きを開始します')
      .addStringOption((option) => option.setName('title').setDescription('請願の題名').setMaxLength(100).setRequired(true))
      .addStringOption((option) => option.setName('problem').setDescription('解決したい制度上の問題').setMaxLength(1800).setRequired(true))
      .addStringOption((option) => option.setName('scope').setDescription('投票scope (省略時は憲法既定)').setRequired(false)
        .addChoices({ name: '全員', value: 'all' }, { name: 'trusted userのみ', value: 'trusted' })))
    .addSubcommand((sub) => sub
      .setName('status')
      .setDescription('法案の状態を表示します')
      .addIntegerOption((option) => option.setName('id').setDescription('法案ID').setRequired(true).setMinValue(1))),

  async execute(interaction) {
    requireInitialized(interaction);
    const sub = interaction.options.getSubcommand();
    if (sub === 'status') {
      const proposal = getProposal(interaction.options.getInteger('id', true));
      if (!proposal || proposal.guild_id !== interaction.guildId) throw new Error('法案が見つかりません。');
      await interaction.reply({ content: `L-${proposal.id} ${proposal.title}\n状態: ${proposal.status}\n改訂: ${proposal.revision}\n${proposal.forum_thread_id ? linkToThread(interaction.guildId, proposal.forum_thread_id) : ''}`, flags: EPHEMERAL });
      return;
    }
    await interaction.deferReply({ flags: EPHEMERAL });
    const proposal = await filePetition(interaction.guild, interaction.member, {
      title: interaction.options.getString('title', true),
      summary: interaction.options.getString('problem', true),
      voteScope: interaction.options.getString('scope'),
      eventId: interaction.id
    });
    await interaction.editReply(`法案 L-${proposal.id} を起草し、草案期間を開始しました。\n${linkToThread(interaction.guildId, proposal.forum_thread_id)}`);
  }
};

const lawCommand = {
  data: new SlashCommandBuilder()
    .setName('law')
    .setDescription('法律と記名投票を確認します')
    .setContexts(InteractionContextType.Guild)
    .addSubcommand((sub) => sub.setName('list').setDescription('現行法を一覧表示します'))
    .addSubcommand((sub) => sub.setName('show').setDescription('法律または法案を表示します')
      .addStringOption((option) => option.setName('type').setDescription('対象').setRequired(true)
        .addChoices({ name: 'law', value: 'law' }, { name: 'proposal', value: 'proposal' }))
      .addIntegerOption((option) => option.setName('id').setDescription('ID').setRequired(true).setMinValue(1)))
    .addSubcommand((sub) => sub.setName('votes').setDescription('法案の全記名票を表示します')
      .addIntegerOption((option) => option.setName('proposal_id').setDescription('法案ID').setRequired(true).setMinValue(1))),

  async execute(interaction) {
    requireInitialized(interaction);
    const sub = interaction.options.getSubcommand();
    if (sub === 'list') {
      const laws = listLaws(interaction.guildId);
      await interaction.reply({ content: laws.map((law) => `#${law.id} ${law.code} ${law.title} (<t:${Math.floor(law.effective_at / 1000)}:d>)`).join('\n') || '現行法はありません。' });
      return;
    }
    if (sub === 'show') {
      const type = interaction.options.getString('type', true);
      const id = interaction.options.getInteger('id', true);
      const target = type === 'law' ? getLaw(id) : getProposal(id);
      if (!target || target.guild_id !== interaction.guildId) throw new Error('対象が見つかりません。');
      const content = type === 'law'
        ? `# ${target.code} ${target.title}\n\n${target.text}\n\n${JSON.stringify(target.provisions, null, 2)}`
        : `# L-${target.id} ${target.title}\n\n${target.summary}\n\n${JSON.stringify(target.body, null, 2)}`;
      await interaction.reply({ files: [{ attachment: Buffer.from(content), name: `${type}-${id}.md` }] });
      return;
    }
    const id = interaction.options.getInteger('proposal_id', true);
    const proposal = getProposal(id);
    if (!proposal || proposal.guild_id !== interaction.guildId) throw new Error('法案が見つかりません。');
    const summary = proposalVoteSummary(id);
    const rows = listProposalVotes(id);
    const electorate = proposalElectorate(id);
    const content = [
      `L-${id} ${proposal.title}`,
      `賛成 ${summary.yes} / 反対 ${summary.no} / 棄権 ${summary.abstain} / trusted反対 ${summary.trustedNo}/${summary.trustedTotal}`,
      '',
      ...rows.map((row) => `${row.user_id}\t${row.choice}\ttrusted=${Boolean(row.trusted)}\t${new Date(row.updated_at).toISOString()}`),
      '',
      '# Electorate snapshot',
      ...electorate.map((row) => `${row.user_id}\tgeneral=${Boolean(row.eligible_general)}\ttrusted=${Boolean(row.trusted)}`)
    ].join('\n');
    await interaction.reply({ content: `L-${id} の全記名票です。`, files: [{ attachment: Buffer.from(content), name: `proposal-${id}-votes.txt` }] });
  }
};

const constitutionCommand = {
  data: new SlashCommandBuilder()
    .setName('constitution')
    .setDescription('憲法の確認・改憲提案・事後違憲審査')
    .setContexts(InteractionContextType.Guild)
    .addSubcommand((sub) => sub.setName('show').setDescription('現行憲法とpolicyを表示します'))
    .addSubcommand((sub) => sub.setName('propose').setDescription('改憲案をAIに起草させます')
      .addStringOption((option) => option.setName('title').setDescription('改憲案の題名').setMaxLength(100).setRequired(true))
      .addStringOption((option) => option.setName('change').setDescription('変更したい内容').setMaxLength(1800).setRequired(true))
      .addStringOption((option) => option.setName('scope').setDescription('投票scope (省略時は憲法既定)').setRequired(false)
        .addChoices({ name: '全員', value: 'all' }, { name: 'trusted userのみ', value: 'trusted' })))
    .addSubcommand((sub) => sub.setName('challenge').setDescription('法律・判決・処分の違憲審査を申し立てます')
      .addStringOption((option) => option.setName('target_type').setDescription('対象').setRequired(true)
        .addChoices(
          { name: 'law', value: 'law' },
          { name: 'case', value: 'case' },
          { name: 'sanction', value: 'sanction' },
          { name: 'administrative act', value: 'administrative_act' }
        ))
      .addIntegerOption((option) => option.setName('target_id').setDescription('対象ID').setRequired(true).setMinValue(1))
      .addStringOption((option) => option.setName('reason').setDescription('違憲と考える理由').setMaxLength(1800).setRequired(true))),

  async execute(interaction) {
    requireInitialized(interaction);
    const sub = interaction.options.getSubcommand();
    if (sub === 'show') {
      const constitution = getActiveConstitution(interaction.guildId);
      const content = `${constitution.content}\n\n## Policy\n\n\u0060\u0060\u0060json\n${JSON.stringify(constitution.policy, null, 2)}\n\u0060\u0060\u0060`;
      await interaction.reply({ content: `現行憲法 v${constitution.version}`, files: [{ attachment: Buffer.from(content), name: `constitution-v${constitution.version}.md` }] });
      return;
    }
    await interaction.deferReply({ flags: EPHEMERAL });
    if (sub === 'propose') {
      const proposal = await fileAmendment(interaction.guild, interaction.member, {
        title: interaction.options.getString('title', true),
        summary: interaction.options.getString('change', true),
        voteScope: interaction.options.getString('scope'),
        eventId: interaction.id
      });
      await interaction.editReply(`改憲案 L-${proposal.id} を公開しました。\n${linkToThread(interaction.guildId, proposal.forum_thread_id)}`);
      return;
    }
    const caseRecord = await fileConstitutionalChallenge(interaction.guild, interaction.member, {
      targetType: interaction.options.getString('target_type', true),
      targetId: interaction.options.getInteger('target_id', true),
      reason: interaction.options.getString('reason', true),
      eventId: interaction.id
    });
    await interaction.editReply(`違憲審査 C-${caseRecord.id} を受理しました。\n${linkToThread(interaction.guildId, caseRecord.public_thread_id)}`);
  }
};

const administrationCommand = {
  data: new SlashCommandBuilder()
    .setName('administration')
    .setDescription('行政行為の公開台帳を確認します')
    .setContexts(InteractionContextType.Guild)
    .addSubcommand((sub) => sub.setName('list').setDescription('最近の行政行為を一覧表示します'))
    .addSubcommand((sub) => sub.setName('show').setDescription('行政行為の詳細を表示します')
      .addIntegerOption((option) => option.setName('id').setDescription('行政行為ID').setRequired(true).setMinValue(1))),

  async execute(interaction) {
    requireInitialized(interaction);
    const sub = interaction.options.getSubcommand();
    if (sub === 'list') {
      const acts = listAdministrativeActs(interaction.guildId, 25);
      await interaction.reply({
        content: acts.map((act) => `A-${act.id} ${act.kind} / ${act.status} / <t:${Math.floor(act.created_at / 1000)}:f> / ${act.summary}`).join('\n').slice(0, 1900) || '行政行為はありません。',
        allowedMentions: { parse: [] }
      });
      return;
    }
    const act = getAdministrativeAct(interaction.options.getInteger('id', true));
    if (!act || act.guild_id !== interaction.guildId) throw new Error('行政行為が見つかりません。');
    const content = `# 行政行為 A-${act.id}\n\nkind: ${act.kind}\nstatus: ${act.status}\nactor: ${act.actor_id ?? act.actor_type}\ncreated: ${new Date(act.created_at).toISOString()}\n\n${act.summary}\n\n\u0060\u0060\u0060json\n${JSON.stringify(act.detail, null, 2)}\n\u0060\u0060\u0060`;
    await interaction.reply({ files: [{ attachment: Buffer.from(content), name: `administrative-act-${act.id}.md` }] });
  }
};

const judgeCommand = {
  data: new SlashCommandBuilder()
    .setName('judge')
    .setDescription('法律に基づく事件・証拠・上訴')
    .setContexts(InteractionContextType.Guild)
    .addSubcommand((sub) => sub.setName('file').setDescription('法律違反を正式に申し立てます')
      .addUserOption((option) => option.setName('accused').setDescription('被告').setRequired(true))
      .addIntegerOption((option) => option.setName('law_id').setDescription('現行法ID').setRequired(true).setMinValue(1))
      .addStringOption((option) => option.setName('offense_code').setDescription('法律に定義された構成要件コード').setMaxLength(40).setRequired(true))
      .addStringOption((option) => option.setName('summary').setDescription('申立ての概要').setMaxLength(1500).setRequired(true))
      .addStringOption((option) => option.setName('evidence').setDescription('証拠メッセージのリンク').setRequired(true)))
    .addSubcommand((sub) => sub.setName('evidence').setDescription('答弁中の事件に証拠を追加します')
      .addIntegerOption((option) => option.setName('case_id').setDescription('事件ID').setRequired(true).setMinValue(1))
      .addStringOption((option) => option.setName('message').setDescription('証拠メッセージのリンク').setRequired(true)))
    .addSubcommand((sub) => sub.setName('status').setDescription('事件の状態を表示します')
      .addIntegerOption((option) => option.setName('case_id').setDescription('事件ID').setRequired(true).setMinValue(1)))
    .addSubcommand((sub) => sub.setName('record').setDescription('当事者用の証拠・主張・判決記録を取得します')
      .addIntegerOption((option) => option.setName('case_id').setDescription('事件ID').setRequired(true).setMinValue(1)))
    .addSubcommand((sub) => sub.setName('appeal').setDescription('banまたは3日以上timeoutの判決へ1回だけ上訴します')
      .addIntegerOption((option) => option.setName('case_id').setDescription('事件ID').setRequired(true).setMinValue(1))
      .addStringOption((option) => option.setName('grounds').setDescription('上訴理由').setMaxLength(1800).setRequired(true))),

  async execute(interaction) {
    requireInitialized(interaction);
    const sub = interaction.options.getSubcommand();
    const caseId = interaction.options.getInteger('case_id');
    if (sub === 'status') {
      const caseRecord = getCase(caseId);
      if (!caseRecord || caseRecord.guild_id !== interaction.guildId) throw new Error('事件が見つかりません。');
      await interaction.reply({ content: `C-${caseRecord.id}\n状態: ${caseRecord.status}\n被告: ${caseRecord.accused_id ? `<@${caseRecord.accused_id}>` : '-'}\n法: ${caseRecord.law_id ? `#${caseRecord.law_id} / ${caseRecord.offense_code}` : '-'}\n判決: ${caseRecord.verdict ? JSON.stringify(caseRecord.verdict) : '-'}\n${caseRecord.public_thread_id ? linkToThread(interaction.guildId, caseRecord.public_thread_id) : ''}`.slice(0, 1900), flags: EPHEMERAL, allowedMentions: { parse: [] } });
      return;
    }
    if (sub === 'record') {
      const caseRecord = getCase(caseId);
      if (!caseRecord || caseRecord.guild_id !== interaction.guildId) throw new Error('事件が見つかりません。');
      const member = interaction.member ?? await interaction.guild.members.fetch(interaction.user.id);
      if (![caseRecord.reporter_id, caseRecord.accused_id].includes(interaction.user.id) && !isGovernanceOperator(member)) {
        throw new Error('事件当事者または技術operatorだけが完全記録を取得できます。');
      }
      const evidence = listCaseEvidence(caseId);
      const submissions = listCaseSubmissions(caseId);
      const decisions = listCaseDecisions(caseId);
      const content = [
        `# 事件 C-${caseId} 完全記録`,
        '',
        `status: ${caseRecord.status}`,
        `law: ${caseRecord.law_id ?? '-'} / offense: ${caseRecord.offense_code ?? '-'}`,
        `alleged_at: ${caseRecord.alleged_at ? new Date(caseRecord.alleged_at).toISOString() : '-'}`,
        '',
        '## 証拠',
        ...evidence.map((entry) => `### E-${entry.id}\nauthor: ${entry.author_id ?? '-'}\noccurred_at: ${entry.occurred_at ? new Date(entry.occurred_at).toISOString() : '-'}\nhash: ${entry.content_hash}\n\n${entry.content}`),
        '',
        '## 当事者主張',
        ...submissions.map((entry) => `### S-${entry.id} ${entry.kind} by ${entry.author_id}\nhash: ${entry.content_hash}\n\n${entry.content}`),
        '',
        '## パネル判断',
        ...decisions.map((entry) => `### ${entry.phase} seat ${entry.seat}\n${JSON.stringify(entry.output, null, 2)}`)
      ].join('\n');
      await interaction.reply({ content: `C-${caseId} の完全記録です。`, files: [{ attachment: Buffer.from(content), name: `case-${caseId}-record.md` }], flags: EPHEMERAL });
      return;
    }
    await interaction.deferReply({ flags: EPHEMERAL });
    if (sub === 'file') {
      const accused = interaction.options.getMember('accused') ?? await interaction.guild.members.fetch(interaction.options.getUser('accused', true).id);
      if (accused.user.bot) throw new Error('botを被告にはできません。');
      const evidence = await fetchEvidence(interaction, interaction.options.getString('evidence', true), { requiredViewerIds: [accused.id] });
      const caseRecord = await fileCriminalCase(interaction.guild, interaction.member, {
        accused,
        lawId: interaction.options.getInteger('law_id', true),
        offenseCode: interaction.options.getString('offense_code', true),
        summary: interaction.options.getString('summary', true),
        evidence,
        eventId: interaction.id
      });
      await interaction.editReply(`事件 C-${caseRecord.id} を受理しました。答弁期限: <t:${Math.floor(caseRecord.defense_until / 1000)}:F>\n${linkToThread(interaction.guildId, caseRecord.public_thread_id)}`);
      return;
    }
    if (sub === 'evidence') {
      const caseRecord = getCase(caseId);
      if (!caseRecord || caseRecord.guild_id !== interaction.guildId) throw new Error('事件が見つかりません。');
      const evidence = await fetchEvidence(interaction, interaction.options.getString('message', true), {
        requiredViewerIds: [caseRecord.reporter_id, caseRecord.accused_id].filter((id) => id !== interaction.user.id)
      });
      const id = await addEvidenceToCase(interaction.guild, interaction.member, caseId, evidence);
      await interaction.editReply(`証拠 #${id} を事件 C-${caseId} に保存しました。`);
      return;
    }
    const result = await appealCase(interaction.guild, interaction.member, caseId, interaction.options.getString('grounds', true));
    await interaction.editReply(`事件 C-${result.id} の上訴を受理し、別パネルの再審を開始しました。`);
  }
};

function safeCommandError(error) {
  const message = String(error?.message ?? error);
  if (/Governance model HTTP|Governance AI is busy|fetch failed|JSON|SQLITE|DiscordAPIError/i.test(message)) {
    return 'AI・Discord・DBの一時エラーです。永続workflowに作成済みの案件は自動再試行されます。`/governance status`で確認してください。';
  }
  return message.slice(0, 500);
}

function withGovernanceErrors(command) {
  return {
    ...command,
    async execute(interaction) {
      try {
        await command.execute(interaction);
      } catch (error) {
        console.error(`Governance command /${interaction.commandName} failed:`, error);
        const payload = { content: `実行できません: ${safeCommandError(error)}`, flags: EPHEMERAL };
        if (interaction.deferred) await interaction.editReply({ content: payload.content });
        else if (interaction.replied) await interaction.followUp(payload);
        else await interaction.reply(payload);
      }
    }
  };
}

export const governanceCommands = [
  governanceCommand,
  petitionCommand,
  lawCommand,
  constitutionCommand,
  administrationCommand,
  judgeCommand
].map(withGovernanceErrors);

export async function handleGovernanceComponent(interaction) {
  if (!interaction.isButton() || !interaction.customId.startsWith('gov:')) return false;
  const [, action, rawId, value] = interaction.customId.split(':');
  const id = Number(rawId);
  if (!Number.isInteger(id) || id < 1) {
    await interaction.reply({ content: '案件IDが壊れています。', flags: EPHEMERAL });
    return true;
  }
  await interaction.deferReply({ flags: EPHEMERAL });
  try {
    if (action === 'vote') {
      await castAndPublishVote(interaction, id, value);
      await interaction.editReply(`L-${id} に ${value} で記名投票しました。`);
      return true;
    }
    if (action === 'approve') {
      const result = await approveCase(interaction, id, value);
      await interaction.editReply(`C-${id}: ${value} を記録しました (${result.approvals}/${result.required})。`);
      return true;
    }
    await interaction.editReply('未対応の統治操作です。');
  } catch (error) {
    await interaction.editReply(`実行できません: ${error.message}`);
  }
  return true;
}
