import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  InteractionContextType,
  MessageFlags,
  ModalBuilder,
  SlashCommandBuilder,
  TextInputBuilder,
  TextInputStyle
} from 'discord.js';
import { isGovernanceOperator, loadBootstrapDocuments } from './config.js';
import {
  bootstrapGovernanceGuild,
  claimGovernanceSetupSession,
  createGovernanceSetupSession,
  getCase,
  getGovernanceGuild,
  getGovernanceSetupSession,
  getResumableGovernanceSetup,
  listReviewableSanctions,
  updateGovernanceSetupSession
} from './db.js';
import {
  createGovernanceSurfaces,
  governancePermissionReport,
  postGazette,
  reviewRequestButtons,
  syncStatuteBook
} from './discord.js';
import { policyHash, sha256 } from './policy.js';
import {
  approveCase,
  appealCase,
  backfillGovernanceActivity,
  castAndPublishVote,
  completeCaseResponse,
  requestSummaryTrial,
  submitCaseAnswer
} from './service.js';
import { handleGovernanceIntakeComponent } from './intake.js';
import { ensureGovernanceUx, handleGovernanceUxInteraction, renderGovernanceOperationsPanel } from './ux.js';

const EPHEMERAL = MessageFlags.Ephemeral;
const SETUP_TTL_MS = 15 * 60_000;

function reviewListPayload(guildId, userId, offset = 0) {
  const sanctions = listReviewableSanctions(guildId, userId);
  const pageSize = 4;
  const start = Math.max(0, Math.min(Number(offset) || 0, Math.max(0, sanctions.length - 1)));
  const page = sanctions.slice(start, start + pageSize);
  if (!page.length) {
    return { content: 'いま裁判を求められる即時処分はありません。', components: [], flags: EPHEMERAL };
  }
  const lines = page.map((sanction, index) => {
    const caseRecord = getCase(sanction.case_id);
    const type = sanction.type === 'warning' ? '警告' : sanction.type === 'restriction' ? '機能制限' : 'タイムアウト';
    return `${index + 1}. ${type}: ${String(caseRecord?.summary ?? '理由は官報を参照').replace(/\s+/g, ' ').slice(0, 180)}`;
  });
  const rows = page.map((sanction, index) => {
    const row = reviewRequestButtons(guildId, sanction.id)[0];
    row.components[0].setLabel(`${index + 1}の裁判を求める`);
    return row;
  });
  const navigation = new ActionRowBuilder();
  if (start > 0) {
    navigation.addComponents(new ButtonBuilder().setCustomId(`gov:review_list:${Math.max(0, start - pageSize)}`)
      .setLabel('前へ').setStyle(ButtonStyle.Secondary));
  }
  if (start + pageSize < sanctions.length) {
    navigation.addComponents(new ButtonBuilder().setCustomId(`gov:review_list:${start + pageSize}`)
      .setLabel('次へ').setStyle(ButtonStyle.Secondary));
  }
  if (navigation.components.length) rows.push(navigation);
  return {
    content: ['# 自分の即時処分', '', ...lines, '', '処分ごとに一度だけ、本人が裁判を求められます。'].join('\n'),
    components: rows,
    flags: EPHEMERAL
  };
}

function requireGuild(interaction) {
  if (!interaction.guildId || !interaction.guild) throw new Error('サーバー内でのみ使えます。');
}

function requireOperator(interaction) {
  if (!isGovernanceOperator(interaction.member)) {
    throw new Error('この操作はサーバーownerまたは設定済み運営者だけが実行できます。');
  }
}

function setupHashes(documents) {
  return { constitutionHash: sha256(documents.constitution), policyHash: policyHash(documents.policy) };
}

function setupBlockingPermissions(report) {
  const required = new Set(['ManageChannels', 'ManageRoles', 'ManageThreads', 'ManageMessages']);
  return report.missing.filter((name) => required.has(name));
}

function setupPreviewPayload(interaction, session, documents, report, { resumed = false } = {}) {
  const blocking = setupBlockingPermissions(report);
  const missing = report.missing.length ? report.missing.join('、') : 'なし';
  return {
    content: [
      `# ${interaction.guild.name} 統治機能の導入確認`,
      '',
      resumed ? '途中まで作成された導入処理を、安全に続きから再開します。' : 'まだサーバーには変更を加えていません。',
      '初期憲法とpolicyの全文を添付しています。内容を確認してから確定してください。',
      '',
      `開始状態: **記録のみ**（Discord上の処分は実行しません）`,
      '特別有権者: 未設定（導入後の管理画面で設定可能）',
      `Bot権限不足: ${missing}`,
      `憲法hash: \`${session.constitution_hash}\``,
      `policy hash: \`${session.policy_hash}\``,
      blocking.length ? `\n導入を続けるには次の権限が必要です: ${blocking.join('、')}` : ''
    ].filter(Boolean).join('\n').slice(0, 1_900),
    files: [
      { attachment: Buffer.from(documents.constitution), name: 'initial-constitution.md' },
      { attachment: Buffer.from(`${JSON.stringify(documents.policy, null, 2)}\n`), name: 'initial-constitution-policy.json' },
      {
        attachment: Buffer.from(`${JSON.stringify({
          constitutionHash: session.constitution_hash,
          policyHash: session.policy_hash
        }, null, 2)}\n`),
        name: 'initial-constitution-hashes.json'
      }
    ],
    components: blocking.length ? [] : [new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`gov:setup:${session.id}:confirm`)
        .setLabel(resumed ? '導入を再開' : 'この憲法で導入')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`gov:setup:${session.id}:cancel`).setLabel('取り消す').setStyle(ButtonStyle.Danger)
    )],
    flags: EPHEMERAL
  };
}

async function openGovernance(interaction) {
  requireGuild(interaction);
  requireOperator(interaction);
  const governance = getGovernanceGuild(interaction.guildId);
  if (governance) {
    await interaction.deferReply({ flags: EPHEMERAL });
    const ux = await ensureGovernanceUx(interaction.guild, governance);
    await interaction.editReply(await renderGovernanceOperationsPanel(interaction.guild, ux.governance));
    return;
  }

  const documents = loadBootstrapDocuments({ serverName: interaction.guild.name });
  const hashes = setupHashes(documents);
  let session = getResumableGovernanceSetup(interaction.guildId);
  const canResume = session
    && session.constitution_hash === hashes.constitutionHash
    && session.policy_hash === hashes.policyHash;
  if (canResume) {
    session = updateGovernanceSetupSession(session.id, {
      status: 'preview',
      requested_by: interaction.user.id,
      expires_at: Date.now() + SETUP_TTL_MS,
      last_error: session.last_error
    });
  } else {
    session = createGovernanceSetupSession({
      guildId: interaction.guildId,
      requestedBy: interaction.user.id,
      constitutionHash: hashes.constitutionHash,
      policyHash: hashes.policyHash,
      expiresAt: Date.now() + SETUP_TTL_MS
    });
  }
  await interaction.reply(setupPreviewPayload(
    interaction,
    session,
    documents,
    governancePermissionReport(interaction.guild),
    { resumed: Boolean(canResume && Object.keys(session.resources).length) }
  ));
}

async function executeSetup(interaction, sessionId) {
  requireGuild(interaction);
  requireOperator(interaction);
  const claimed = claimGovernanceSetupSession(sessionId, interaction.user.id);
  if (!claimed) throw new Error('この導入確認は期限切れ、処理済み、または別の運営者が作成したものです。');
  const documents = loadBootstrapDocuments({ serverName: interaction.guild.name });
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
    const surfaces = await createGovernanceSurfaces(interaction.guild, {
      resources: claimed.resources,
      onProgress: (resources) => updateGovernanceSetupSession(claimed.id, { resources })
    });
    let result = getGovernanceGuild(interaction.guildId)
      ? { guild: getGovernanceGuild(interaction.guildId), constitution: null }
      : bootstrapGovernanceGuild({
        guildId: interaction.guildId,
        enactedBy: interaction.user.id,
        trustedRoleId: '',
        enforcementMode: 'shadow',
        constitution: documents.constitution,
        policy: documents.policy,
        ...surfaces
      });
    const warnings = [];
    const backfilled = await backfillGovernanceActivity(interaction.guild).catch((error) => {
      warnings.push(`活動履歴の初回取込み: ${error.message}`);
      return 0;
    });
    const constitution = result.constitution;
    if (constitution) {
      await postGazette(
        interaction.guild,
        result.guild,
        '初期憲法 v1 公布',
        `${constitution.content}\n\n## Policy\n\n\`\`\`json\n${JSON.stringify(constitution.policy, null, 2)}\n\`\`\`\n\ncontent hash: ${constitution.content_hash}\npolicy hash: ${constitution.policy_hash}`,
        {
          summary: '設定済み運営者の全文確認を経て初期憲法 v1 を公布しました。現行正文は法令集を参照してください。',
          links: [`法令集: https://discord.com/channels/${interaction.guildId}/${result.guild.statute_forum_id}`]
        }
      ).catch((error) => warnings.push(`官報掲載: ${error.message}`));
    }
    await syncStatuteBook(interaction.guild, result.guild, { verifyExisting: true })
      .catch((error) => warnings.push(`法令集掲載: ${error.message}`));
    const ux = await ensureGovernanceUx(interaction.guild, getGovernanceGuild(interaction.guildId));
    updateGovernanceSetupSession(claimed.id, { status: 'completed', last_error: null });
    await interaction.editReply([
      '統治機能を記録のみの状態で導入しました。',
      `進行中: <#${ux.admin.id}>`,
      `参加者向け案内: <#${ux.guide.id}>`,
      `直近活動: ${backfilled}件`,
      warnings.length ? `注意: ${warnings.join(' / ')}` : null
    ].filter(Boolean).join('\n'));
  } catch (error) {
    updateGovernanceSetupSession(claimed.id, { status: 'failed', last_error: String(error?.message ?? error).slice(0, 500) });
    throw error;
  }
}

const governanceCommand = {
  data: new SlashCommandBuilder()
    .setName('governance')
    .setDescription('統治機能を導入または管理します')
    .setContexts(InteractionContextType.Guild),
  execute: openGovernance
};

function safeCommandError(error) {
  const message = String(error?.message ?? error);
  if (/Governance model HTTP|Governance AI is busy|fetch failed|JSON|SQLITE|DiscordAPIError/i.test(message)) {
    return 'AI・Discord・DBの一時エラーです。作成済みの案件は自動再試行されます。`/governance` の「診断・復旧」を確認してください。';
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
        const content = `実行できません: ${safeCommandError(error)}`;
        if (interaction.deferred) await interaction.editReply({ content });
        else if (interaction.replied) await interaction.followUp({ content, flags: EPHEMERAL });
        else await interaction.reply({ content, flags: EPHEMERAL });
      }
    }
  };
}

export const governanceCommands = [governanceCommand].map(withGovernanceErrors);

export async function handleGovernanceComponent(interaction) {
  const customId = interaction.customId ?? '';
  if (!customId.startsWith('gov:')) return false;
  try {
    if (customId.startsWith('gov:review_list:') && interaction.isButton()) {
      requireGuild(interaction);
      const offset = Number(customId.split(':')[2]);
      const payload = reviewListPayload(interaction.guildId, interaction.user.id, offset);
      if (interaction.message?.flags?.has?.(EPHEMERAL)) {
        const { flags: _flags, ...update } = payload;
        await interaction.update(update);
      }
      else await interaction.reply(payload);
      return true;
    }
    if (customId.startsWith('gov:review:') && interaction.isButton()) {
      const [, , guildId, rawSanctionId] = customId.split(':');
      const guild = interaction.client.guilds.cache.get(guildId)
        ?? await interaction.client.guilds.fetch(guildId).catch(() => null);
      if (!guild) throw new Error('対象サーバーを確認できません。');
      const member = await guild.members.fetch(interaction.user.id).catch(() => null);
      if (!member) throw new Error('対象サーバーのメンバーではありません。');
      await interaction.deferReply(interaction.inGuild?.() ? { flags: EPHEMERAL } : {});
      const result = await requestSummaryTrial(guild, member, Number(rawSanctionId));
      await interaction.editReply(`裁判を開始しました。24時間以内に終了します。\nhttps://discord.com/channels/${guild.id}/${result.public_thread_id}`);
      return true;
    }
    if (customId.startsWith('gov:court_answer:') && interaction.isModalSubmit()) {
      const caseId = Number(customId.split(':')[2]);
      const member = interaction.member ?? await interaction.guild.members.fetch(interaction.user.id);
      await interaction.deferReply({ flags: EPHEMERAL });
      await submitCaseAnswer(interaction.guild, member, caseId, interaction.fields.getTextInputValue('answer'));
      await interaction.editReply('回答を裁判記録へ提出しました。追記するか、事件投稿の「回答完了」を押してください。');
      return true;
    }
    if (customId.startsWith('gov:court_appeal:') && interaction.isModalSubmit()) {
      const caseId = Number(customId.split(':')[2]);
      const member = interaction.member ?? await interaction.guild.members.fetch(interaction.user.id);
      await interaction.deferReply({ flags: EPHEMERAL });
      await appealCase(interaction.guild, member, caseId, interaction.fields.getTextInputValue('grounds'));
      await interaction.editReply('上訴を受理しました。回答を追記し、終わったら「回答完了」を押してください。');
      return true;
    }
    if (customId.startsWith('gov:admin')) return await handleGovernanceUxInteraction(interaction);
    if (interaction.isButton() && customId.startsWith('gov:setup:')) {
      const [, , sessionId, action] = customId.split(':');
      const session = getGovernanceSetupSession(sessionId);
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
    const id = Number(rawId);
    if (!Number.isInteger(id) || id < 1) throw new Error('案件IDが壊れています。');
    if (action === 'intake') return await handleGovernanceIntakeComponent(interaction, id, value);
    if (action === 'court') {
      const member = interaction.member ?? await interaction.guild.members.fetch(interaction.user.id);
      if (value === 'answer') {
        const modal = new ModalBuilder().setCustomId(`gov:court_answer:${id}`).setTitle('裁判への回答')
          .addComponents(new ActionRowBuilder().addComponents(
            new TextInputBuilder().setCustomId('answer').setLabel('説明・反論').setStyle(TextInputStyle.Paragraph)
              .setRequired(true).setMaxLength(4000)
          ));
        await interaction.showModal(modal);
        return true;
      }
      if (value === 'appeal') {
        const modal = new ModalBuilder().setCustomId(`gov:court_appeal:${id}`).setTitle('上訴')
          .addComponents(new ActionRowBuilder().addComponents(
            new TextInputBuilder().setCustomId('grounds').setLabel('判決を見直す理由').setStyle(TextInputStyle.Paragraph)
              .setRequired(true).setMaxLength(4000)
          ));
        await interaction.showModal(modal);
        return true;
      }
      if (value === 'evidence') {
        await interaction.reply({
          content: '証拠にしたい公開メッセージへ返信し、「@裁判 この事件へ証拠として追加」と送ってください。',
          flags: EPHEMERAL
        });
        return true;
      }
      if (value === 'complete') {
        await interaction.deferReply({ flags: EPHEMERAL });
        await completeCaseResponse(interaction.guild, member, id);
        await interaction.editReply('回答を締め切り、判定を開始しました。');
        return true;
      }
    }
    await interaction.deferReply({ flags: EPHEMERAL });
    if (action === 'vote') {
      await castAndPublishVote(interaction, id, value);
      const label = { yes: '賛成', no: '反対', abstain: '棄権' }[value] ?? value;
      await interaction.editReply(`「${label}」で記名投票しました。`);
      return true;
    }
    if (action === 'approve') {
      const result = await approveCase(interaction, id, value);
      const label = value === 'approve' ? '執行を承認' : '承認しない';
      await interaction.editReply(`「${label}」を記録しました（承認 ${result.approvals}/${result.required}）。`);
      return true;
    }
    await interaction.editReply('未対応の統治操作です。');
    return true;
  } catch (error) {
    console.error('Governance component failed:', error);
    const content = `実行できません: ${safeCommandError(error)}`;
    const flags = interaction.inGuild?.() ? { flags: EPHEMERAL } : {};
    if (interaction.deferred) await interaction.editReply({ content }).catch(() => {});
    else if (interaction.replied) await interaction.followUp({ content, ...flags }).catch(() => {});
    else await interaction.reply({ content, ...flags }).catch(() => {});
    return true;
  }
}
