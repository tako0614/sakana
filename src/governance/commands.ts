import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  InteractionContextType,
  MessageFlags,
  ModalBuilder,
  SlashCommandBuilder,
  TextInputBuilder,
  TextInputStyle,
  type APIInteractionGuildMember,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Guild,
  type GuildMember,
  type InteractionReplyOptions
} from 'discord.js';
import { isGovernanceOperator, loadBootstrapDocuments, type BootstrapDocuments } from './config.js';
import {
  bootstrapGovernanceGuild,
  claimGovernanceSetupSession,
  createGovernanceSetupSession,
  getCase,
  getGovernanceGuild,
  getGovernanceSetupSession,
  getResumableGovernanceSetup,
  listContestableSanctions,
  recordGovernanceSurfaceMigration,
  updateGovernanceSetupSession
} from './db.js';
import {
  actingMember,
  createGovernanceSurfaces,
  governancePermissionReport,
  postAuthorityChange,
  contestButtons
} from './discord.js';
import { policyHash, sha256 } from './policy.js';
import { reportManualExecution } from './manual-execution.js';
import {
  approveCase,
  exerciseHumanVeto,
  appealCase,
  backfillGovernanceActivity,
  castAndPublishVote,
  completeCaseResponse,
  requestTrial,
  withdrawContest,
  submitCaseAnswer
} from './service.js';
import { handleGovernanceIntakeComponent } from './intake.js';
import { syncLawSite } from './lawsite.js';
import { ensureGovernanceUx, handleGovernanceUxInteraction, renderGovernanceOperationsPanel } from './ux.js';
import type { SetupSession } from './types.js';
import {
  errorMessage,
  requireValue,
  type GovernanceCommand,
  type GovernanceComponentInteraction,
  type GovernancePermissionReport
} from './types-service.js';

const EPHEMERAL = MessageFlags.Ephemeral;
const SETUP_TTL_MS = 15 * 60_000;
const VOTE_LABELS: Record<string, string> = { yes: '賛成', no: '反対', abstain: '棄権' };

function reviewListPayload(guildId: string, userId: string, offset = 0): InteractionReplyOptions & { flags: typeof EPHEMERAL } {
  const sanctions = listContestableSanctions(guildId, userId);
  const pageSize = 4;
  const start = Math.max(0, Math.min(Number(offset) || 0, Math.max(0, sanctions.length - 1)));
  const page = sanctions.slice(start, start + pageSize);
  if (!page.length) {
    return { content: 'いま争える即時処分はありません。', components: [], flags: EPHEMERAL };
  }
  const lines = page.map((sanction, index) => {
    const caseRecord = getCase(sanction.case_id);
    const type = sanction.type === 'warning' ? '警告' : sanction.type === 'restriction' ? '機能制限' : 'タイムアウト';
    return `${index + 1}. ${type}: ${String(caseRecord?.summary ?? '理由は裁判所を参照').replace(/\s+/g, ' ').slice(0, 180)}`;
  });
  const rows = page.flatMap((sanction, index) => contestButtons(guildId, sanction.id).slice(0, 1).map((row) => {
    row.components[0]?.setLabel(`${index + 1}の審理を求める`);
    return row;
  }));
  const navigation = new ActionRowBuilder<ButtonBuilder>();
  if (start > 0) {
    navigation.addComponents(new ButtonBuilder().setCustomId(`gov:contest_list:${Math.max(0, start - pageSize)}`)
      .setLabel('前へ').setStyle(ButtonStyle.Secondary));
  }
  if (start + pageSize < sanctions.length) {
    navigation.addComponents(new ButtonBuilder().setCustomId(`gov:contest_list:${start + pageSize}`)
      .setLabel('次へ').setStyle(ButtonStyle.Secondary));
  }
  if (navigation.components.length) rows.push(navigation);
  return {
    content: ['# 自分が受けた警察の処分', '', ...lines, '', '処分ごとに一度だけ、本人が裁判所の審理を求められます。'].join('\n'),
    components: rows,
    flags: EPHEMERAL
  };
}

function requireGuild(interaction: { guildId: string | null; guild: Guild | null }): Guild {
  if (!interaction.guildId || !interaction.guild) throw new Error('サーバー内でのみ使えます。');
  return interaction.guild;
}

function requireOperator(interaction: { member: GuildMember | APIInteractionGuildMember | null }): void {
  if (!isGovernanceOperator(interaction.member)) {
    throw new Error('この操作はサーバーownerまたは設定済み運営者だけが実行できます。');
  }
}

function setupHashes(documents: BootstrapDocuments): { constitutionHash: string; policyHash: string } {
  return { constitutionHash: sha256(documents.constitution), policyHash: policyHash({ policy: documents.policy, laws: documents.laws }) };
}

function setupBlockingPermissions(report: GovernancePermissionReport): string[] {
  const required = new Set(['ManageChannels', 'ManageRoles', 'ManageThreads', 'ManageMessages']);
  return report.missing.filter((name) => required.has(name));
}

function setupPreviewPayload(
  guild: Guild,
  session: SetupSession,
  documents: BootstrapDocuments,
  report: GovernancePermissionReport,
  { resumed = false }: { resumed?: boolean } = {}
): InteractionReplyOptions {
  const blocking = setupBlockingPermissions(report);
  const missing = report.missing.length ? report.missing.join('、') : 'なし';
  return {
    content: [
      `# ${guild.name} 統治機能の導入確認`,
      '',
      resumed ? '途中まで作成された導入処理を、安全に続きから再開します。' : 'まだサーバーには変更を加えていません。',
      '初期憲法と統治組織手続法の全文を添付しています。内容を確認してから確定してください。',
      '',
      `開始状態: **記録のみ**（Discord上の処分は実行しません）`,
      '特別有権者: 未設定（導入後の管理画面で設定可能）',
      `Bot権限不足: ${missing}`,
      blocking.length ? `\n導入を続けるには次の権限が必要です: ${blocking.join('、')}` : ''
    ].filter(Boolean).join('\n').slice(0, 1_900),
    files: [
      { attachment: Buffer.from(documents.constitution), name: 'initial-constitution.md' },
      { attachment: Buffer.from(`${JSON.stringify(documents.laws, null, 2)}\n`), name: 'initial-laws.json' }
    ],
    components: blocking.length ? [] : [new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`gov:setup:${session.id}:confirm`)
        .setLabel(resumed ? '導入を再開' : 'この憲法・法律で導入')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`gov:setup:${session.id}:cancel`).setLabel('取り消す').setStyle(ButtonStyle.Danger)
    )],
    flags: EPHEMERAL
  };
}

async function openGovernance(interaction: ChatInputCommandInteraction): Promise<void> {
  const guild = requireGuild(interaction);
  requireOperator(interaction);
  const governance = getGovernanceGuild(guild.id);
  if (governance) {
    await interaction.deferReply({ flags: EPHEMERAL });
    const ux = await ensureGovernanceUx(guild, governance);
    await interaction.editReply(await renderGovernanceOperationsPanel(guild, ux.governance));
    return;
  }

  const documents = loadBootstrapDocuments({ serverName: guild.name });
  const hashes = setupHashes(documents);
  let session = getResumableGovernanceSetup(guild.id);
  const canResume = session
    && session.constitution_hash === hashes.constitutionHash
    && session.policy_hash === hashes.policyHash;
  if (session && canResume) {
    session = updateGovernanceSetupSession(session.id, {
      status: 'preview',
      requested_by: interaction.user.id,
      expires_at: Date.now() + SETUP_TTL_MS,
      last_error: session.last_error
    });
  } else {
    session = createGovernanceSetupSession({
      guildId: guild.id,
      requestedBy: interaction.user.id,
      constitutionHash: hashes.constitutionHash,
      policyHash: hashes.policyHash,
      expiresAt: Date.now() + SETUP_TTL_MS
    });
  }
  const current = requireValue(session, '導入確認を作成できませんでした。');
  await interaction.reply(setupPreviewPayload(
    guild,
    current,
    documents,
    governancePermissionReport(guild),
    { resumed: Boolean(canResume && Object.keys(current.resources).length) }
  ));
}

async function executeSetup(interaction: ButtonInteraction, sessionId: string): Promise<void> {
  const guild = requireGuild(interaction);
  requireOperator(interaction);
  const claimed = claimGovernanceSetupSession(sessionId, interaction.user.id);
  if (!claimed) throw new Error('この導入確認は期限切れ、処理済み、または別の運営者が作成したものです。');
  const documents = loadBootstrapDocuments({ serverName: guild.name });
  const hashes = setupHashes(documents);
  if (claimed.constitution_hash !== hashes.constitutionHash || claimed.policy_hash !== hashes.policyHash) {
    updateGovernanceSetupSession(claimed.id, { status: 'failed', last_error: 'preview hashes changed' });
    throw new Error('確認後に初期憲法が変更されました。/governanceを開き直して再確認してください。');
  }
  await interaction.deferUpdate();
  await interaction.editReply({
    content: '導入中です。作成済みのリソースを記録しながら進めています…',
    components: [],
    attachments: []
  });
  try {
    const surfaces = await createGovernanceSurfaces(guild, {
      resources: claimed.resources,
      onProgress: (resources) => updateGovernanceSetupSession(claimed.id, { resources })
    });
    const bootstrapped = getGovernanceGuild(guild.id)
      ? null
      : bootstrapGovernanceGuild({
        guildId: guild.id,
        enactedBy: interaction.user.id,
        trustedRoleId: '',
        enforcementMode: 'shadow',
        constitution: documents.constitution,
        policy: documents.policy,
        laws: documents.laws,
        ...surfaces
      });
    if (surfaces.legacyGuideChannelId || surfaces.legacyGazetteChannelId) {
      recordGovernanceSurfaceMigration({
        guildId: guild.id,
        legacyGuideChannelId: surfaces.legacyGuideChannelId,
        legacyGazetteChannelId: surfaces.legacyGazetteChannelId,
        detail: { source: 'resumed-setup' }
      });
    }
    const warnings: string[] = [];
    const backfilled = await backfillGovernanceActivity(guild).catch((error: unknown) => {
      warnings.push(`活動履歴の初回取込み: ${errorMessage(error)}`);
      return 0;
    });
    const constitution = bootstrapped?.constitution ?? null;
    syncLawSite(guild, { verifyExisting: true });
    const ux = await ensureGovernanceUx(guild, getGovernanceGuild(guild.id));
    if (constitution) {
      await postAuthorityChange(guild, ux.governance, '統治機能を開始', `初期憲法 v${constitution.version} を公開しました。`)
        .catch((error: unknown) => warnings.push(`運営変更の掲載: ${errorMessage(error)}`));
    }
    updateGovernanceSetupSession(claimed.id, { status: 'completed', last_error: null });
    await interaction.editReply([
      '統治機能を記録のみの状態で導入しました。',
      `手続: <#${ux.procedure.id}>`,
      `直近活動: ${backfilled}件`,
      warnings.length ? `注意: ${warnings.join(' / ')}` : null
    ].filter(Boolean).join('\n'));
  } catch (error) {
    updateGovernanceSetupSession(claimed.id, { status: 'failed', last_error: errorMessage(error).slice(0, 500) });
    throw error;
  }
}

const governanceCommand: GovernanceCommand = {
  data: new SlashCommandBuilder()
    .setName('governance')
    .setDescription('統治機能を導入または管理します')
    .setContexts(InteractionContextType.Guild),
  execute: openGovernance
};

function safeCommandError(error: unknown): string {
  const message = errorMessage(error);
  if (/Governance model HTTP|Governance AI is busy|fetch failed|JSON|SQLITE|DiscordAPIError/i.test(message)) {
    return 'AI・Discord・DBの一時エラーです。作成済みの案件は自動再試行されます。`/governance` の「診断・復旧」を確認してください。';
  }
  return message.slice(0, 500);
}

function withGovernanceErrors(command: GovernanceCommand): GovernanceCommand {
  return {
    ...command,
    async execute(interaction) {
      try {
        await command.execute(interaction);
      } catch (error) {
        console.error(`Governance command /${interaction.commandName} failed:`, error);
        const content = `実行できません: ${safeCommandError(error)}`;
        if (interaction.deferred) await interaction.editReply({ content });
        else if (interaction.replied) await interaction.followUp({ content, flags: EPHEMERAL });
        else await interaction.reply({ content, flags: EPHEMERAL });
      }
    }
  };
}

export const governanceCommands = [governanceCommand].map(withGovernanceErrors);

/** custom_id に埋めた数値の ID。正の整数でなければ壊れた操作として扱う。 */
function positiveId(value: unknown): number | null {
  const id = Number(value);
  return Number.isInteger(id) && id >= 1 ? id : null;
}

export async function handleGovernanceComponent(interaction: GovernanceComponentInteraction): Promise<boolean> {
  const customId = interaction.customId ?? '';
  if (!customId.startsWith('gov:')) return false;
  try {
    if (customId.startsWith('gov:contest_list:') && interaction.isButton()) {
      const guild = requireGuild(interaction);
      const offset = Number(customId.split(':')[2]);
      const payload = reviewListPayload(guild.id, interaction.user.id, offset);
      if (interaction.message?.flags?.has?.(EPHEMERAL)) {
        const { flags: _flags, ...update } = payload;
        await interaction.update(update);
      }
      else await interaction.reply(payload);
      return true;
    }
    if (customId.startsWith('gov:contest:') && interaction.isButton()) {
      const [, , guildId, rawSanctionId] = customId.split(':');
      // 処分通知は DM でも届くので対象サーバーを custom_id に持つ。サーバー内で押されたなら
      // そのサーバーの処分だけを扱い、別サーバーへ手続を起こさない。
      if (!guildId || (interaction.inGuild() && interaction.guildId !== guildId)) throw new Error('対象サーバーを確認できません。');
      const guild = interaction.client.guilds.cache.get(guildId)
        ?? await interaction.client.guilds.fetch(guildId).catch(() => null);
      if (!guild) throw new Error('対象サーバーを確認できません。');
      const member = await guild.members.fetch(interaction.user.id).catch(() => null);
      if (!member) throw new Error('対象サーバーのメンバーではありません。');
      const sanctionId = positiveId(rawSanctionId);
      if (sanctionId === null) throw new Error('処分が見つかりません。');
      await interaction.deferReply(interaction.inGuild() ? { flags: EPHEMERAL } : {});
      const result = await requestTrial(guild, member, sanctionId);
      await interaction.editReply(`裁判所の審理を始めました。期限: <t:${Math.floor(Number(result.defense_until) / 1000)}:F>\n[事件記録を開く](https://discord.com/channels/${guild.id}/${String(result.public_thread_id)})`);
      return true;
    }
    if (customId.startsWith('gov:court_answer:') && interaction.isModalSubmit()) {
      const guild = requireGuild(interaction);
      const caseId = positiveId(customId.split(':')[2]);
      if (caseId === null) throw new Error('案件IDが壊れています。');
      const member = await actingMember(interaction, guild);
      await interaction.deferReply({ flags: EPHEMERAL });
      await submitCaseAnswer(guild, member, caseId, interaction.fields.getTextInputValue('answer'));
      await interaction.editReply('回答を裁判記録へ提出しました。追記するか、事件投稿の「回答完了」を押してください。');
      return true;
    }
    if (customId.startsWith('gov:court_appeal:') && interaction.isModalSubmit()) {
      const guild = requireGuild(interaction);
      const caseId = positiveId(customId.split(':')[2]);
      if (caseId === null) throw new Error('案件IDが壊れています。');
      const member = await actingMember(interaction, guild);
      await interaction.deferReply({ flags: EPHEMERAL });
      await appealCase(guild, member, caseId, interaction.fields.getTextInputValue('grounds'));
      await interaction.editReply('上訴を受理しました。回答を追記し、終わったら「回答完了」を押してください。');
      return true;
    }
    if (customId.startsWith('gov:admin')) return await handleGovernanceUxInteraction(interaction);
    if (interaction.isButton() && customId.startsWith('gov:setup:')) {
      const [, , sessionId, action] = customId.split(':');
      const session = sessionId === undefined ? null : getGovernanceSetupSession(sessionId);
      if (!session || session.guild_id !== interaction.guildId || session.requested_by !== interaction.user.id) {
        throw new Error('この導入確認は使用できません。');
      }
      if (action === 'cancel') {
        updateGovernanceSetupSession(session.id, { status: 'expired' });
        await interaction.update({ content: '導入を取り消しました。サーバーには変更していません。', components: [], attachments: [] });
        return true;
      }
      if (action === 'confirm') {
        await executeSetup(interaction, session.id);
        return true;
      }
      throw new Error('未知の導入操作です。');
    }
    if (!interaction.isButton()) return false;
    const [, action, rawId, value] = customId.split(':');
    const id = positiveId(rawId);
    if (id === null) throw new Error('案件IDが壊れています。');
    if (action === 'intake') return await handleGovernanceIntakeComponent(interaction, id, value);
    const guild = requireGuild(interaction);
    if (action === 'court') {
      const member = await actingMember(interaction, guild);
      if (value === 'answer') {
        const modal = new ModalBuilder().setCustomId(`gov:court_answer:${id}`).setTitle('裁判への回答')
          .addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(
            new TextInputBuilder().setCustomId('answer').setLabel('説明・反論').setStyle(TextInputStyle.Paragraph)
              .setRequired(true).setMaxLength(4000)
          ));
        await interaction.showModal(modal);
        return true;
      }
      if (value === 'appeal') {
        const modal = new ModalBuilder().setCustomId(`gov:court_appeal:${id}`).setTitle('上訴')
          .addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(
            new TextInputBuilder().setCustomId('grounds').setLabel('判決を見直す理由').setStyle(TextInputStyle.Paragraph)
              .setRequired(true).setMaxLength(4000)
          ));
        await interaction.showModal(modal);
        return true;
      }
      if (value === 'evidence') {
        await interaction.reply({
          content: '証拠にしたい公開メッセージへ返信し、「@通報 この事件へ証拠として追加」と送ってください。',
          flags: EPHEMERAL
        });
        return true;
      }
      if (value === 'withdraw') {
        await interaction.deferReply({ flags: EPHEMERAL });
        await withdrawContest(guild, member, id);
        await interaction.editReply('申立ての取下げを記録しました。処分は法定手続に従って扱います。');
        return true;
      }
      if (value === 'complete') {
        await interaction.deferReply({ flags: EPHEMERAL });
        await completeCaseResponse(guild, member, id);
        await interaction.editReply('回答を締め切り、判定を開始しました。');
        return true;
      }
    }
    await interaction.deferReply({ flags: EPHEMERAL });
    if (action === 'veto') {
      const result = await exerciseHumanVeto(interaction, String(value), id);
      await ensureGovernanceUx(guild, getGovernanceGuild(guild.id));
      await interaction.editReply(`拒否権の行使を記録しました（${result.count}人）。${result.vetoed ? '成立・執行を取りやめます。' : '法律で定める必要人数への到達を待ちます。'}`);
      return true;
    }
    if (action === 'manual') {
      const [requestKey, result] = String(value).split('-');
      if (requestKey === undefined || result === undefined) throw new Error('管理者対応の操作を読み取れません。');
      await reportManualExecution(guild, interaction.user.id, { sanctionId: id, requestKey, result });
      await ensureGovernanceUx(guild, getGovernanceGuild(guild.id));
      await interaction.editReply('管理者による対応完了を記録しました。');
      return true;
    }
    if (action === 'vote') {
      await castAndPublishVote(interaction, id, String(value));
      await ensureGovernanceUx(guild, getGovernanceGuild(guild.id));
      const label = VOTE_LABELS[String(value)] ?? value;
      await interaction.editReply(`「${label}」で記名投票しました。`);
      return true;
    }
    if (action === 'approve') {
      const result = await approveCase(interaction, id, String(value));
      await ensureGovernanceUx(guild, getGovernanceGuild(guild.id));
      const label = value === 'approve' ? '執行を承認' : '承認しない';
      await interaction.editReply(`「${label}」を記録しました（承認 ${result.approvals}/${result.required}）。`);
      return true;
    }
    await interaction.editReply('未対応の統治操作です。');
    return true;
  } catch (error) {
    console.error('Governance component failed:', error);
    const content = `実行できません: ${safeCommandError(error)}`;
    const notice: InteractionReplyOptions = interaction.inGuild?.() ? { content, flags: EPHEMERAL } : { content };
    if (interaction.deferred) await interaction.editReply({ content }).catch(() => {});
    else if (interaction.replied) await interaction.followUp(notice).catch(() => {});
    else await interaction.reply(notice).catch(() => {});
    return true;
  }
}
