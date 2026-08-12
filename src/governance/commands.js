import {
  InteractionContextType,
  MessageFlags,
  SlashCommandBuilder
} from 'discord.js';
import {
  isGovernanceOperator,
  loadBootstrapDocuments,
  parseOperationalSetting
} from './config.js';
import {
  bootstrapGovernanceGuild,
  createAdministrativeAct,
  getActiveConstitution,
  getGovernanceGuild,
  getOperationalSetting,
  listActionFailures,
  listAudit,
  listCases,
  listOperationalSettings,
  listProposals,
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
  approveCase,
  backfillGovernanceActivity,
  castAndPublishVote,
  setTrustedMember
} from './service.js';
import { handleGovernanceIntakeComponent } from './intake.js';

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
    `会話入口: 立法 ${governance.legislature_role_id ? `<@&${governance.legislature_role_id}>` : '準備中'} / 裁判 ${governance.judiciary_role_id ? `<@&${governance.judiciary_role_id}>` : '準備中'} / 一般 <@${interaction.client.user.id}>`,
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
    .setDescription('統治機能の初期化・状態・運用設定')
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
      const documents = loadBootstrapDocuments({ serverName: interaction.guild.name });
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
        warnings.push('官報への初期憲法掲載に失敗しました。bot本体へのメンションでは正本DBから取得できます。');
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
  governanceCommand
].map(withGovernanceErrors);

export async function handleGovernanceComponent(interaction) {
  if (!interaction.isButton() || !interaction.customId.startsWith('gov:')) return false;
  const [, action, rawId, value] = interaction.customId.split(':');
  const id = Number(rawId);
  if (!Number.isInteger(id) || id < 1) {
    await interaction.reply({ content: '案件IDが壊れています。', flags: EPHEMERAL });
    return true;
  }
  if (action === 'intake') {
    return handleGovernanceIntakeComponent(interaction, id, value);
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
