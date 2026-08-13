import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  OverwriteType,
  PermissionFlagsBits
} from 'discord.js';
import { governanceCategoryName } from './config.js';
import { governanceRulesSummary } from './rules.js';
import {
  getCaseInterimProtection,
  getCaseSanction,
  getConstitution,
  getGovernanceGuild,
  getLaw,
  getProposal,
  getStatutePublication,
  listCases,
  listConstitutions,
  listLaws,
  listProposals,
  upsertStatutePublication
} from './db.js';

const TAGS = ['待機', '草案', '違憲審査', '討議', '投票', '成立', '否決', '廃案'];
const PARLIAMENT_TOPIC = '請願・法案・改憲案。正式案件は1案件1投稿で作成します。';
const STATUTE_TAGS = ['現行憲法', '旧憲法', '現行法', '停止', '違憲', '廃止'];
const STATUTE_TOPIC = '現行憲法と法律の公開正本です。1法令1投稿で、旧法令も状態付きで保存します。';
const GAZETTE_TOPIC = '成立・改正・判決・執行・運営操作を時系列に残す公開履歴です。現行本文は法令集を参照してください。';
export const COURT_TOPIC = '事件ごとの公開審理です。状態・期限・発言範囲と、答弁から上訴までを1つの投稿にまとめます。';
export const GOVERNANCE_GUIDE_NAME = '案内';
export const GOVERNANCE_PROCEDURE_NAME = '進行中';
export const GOVERNANCE_PROCEDURE_TOPIC = 'いま投票・承認・答弁・上訴できる案件を、全員に公開します。';

function proposalHandler(proposal) {
  if (proposal.workflow_handler) return proposal.workflow_handler;
  const constitution = getConstitution(proposal.constitution_id);
  const workflow = constitution?.rules?.workflows?.[proposal.kind === 'amendment' ? 'constitutionalAmendment' : 'law'];
  return workflow?.states?.[proposal.status]?.handler ?? null;
}

function proposalStateLabel(state, handler = null) {
  if (['待機', '草案', '討議', '違憲審査', '投票', '成立', '否決', '廃案'].includes(state)) return state;
  return ({
    drafting: 'AI起草中',
    draft: '草案',
    discussion: '討議中',
    revision_discussion: '調整案の討議中',
    deliberation: 'AI整理中',
    constitutional_review: '違憲審査',
    debate: '討議中',
    voting: '投票中',
    enacted: '成立',
    rejected: '否決',
    remanded: '差戻し'
  })[state] ?? ({
    draft: 'AI起草中',
    public_discussion: '討議中',
    ai_deliberation: 'AI整理中',
    constitutional_panel: '違憲審査',
    public_vote: '投票中',
    terminal: '終了'
  })[handler] ?? '進行中';
}

function caseStateLabel(state) {
  return ({
    filing: '受付中',
    summary_review: 'AI判定中',
    summary_active: '即時処分中・裁判請求可',
    defense: '答弁期間',
    deliberation: '審理中',
    approval: '執行承認待ち',
    appeal_window: '上訴受付中',
    appeal: '上訴審理中',
    execution: '執行処理中',
    final: '確定',
    overturned: '取消',
    acquitted: '責任なし',
    dismissed: '棄却',
    constitutional_uncertain: '違憲判断不能',
    unenforceable: '執行不能'
  })[state] ?? state;
}

function oneLine(value, maximum = 700) {
  return String(value ?? '').replace(/[#*_`\r\n]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, maximum);
}

export function publicMemberLabel(userId, fallback = '表示対象のアカウント') {
  const value = String(userId ?? '');
  return /^\d{17,20}$/.test(value) ? `<@${value}>` : fallback;
}

function proposalDeadline(proposal) {
  if (proposal.workflow_status === 'queued') return null;
  if (!proposal.stage_ends_at || proposalHandler(proposal) === 'terminal') return null;
  return `<t:${Math.floor(proposal.stage_ends_at / 1000)}:F>`;
}

function courtDeadline(caseRecord) {
  if (caseRecord.status === 'defense' && caseRecord.defense_until) return caseRecord.defense_until;
  if (caseRecord.status === 'appeal_window') return getCaseSanction(caseRecord.id)?.appeal_deadline ?? null;
  if (caseRecord.status === 'appeal') return caseRecord.retry_after ?? null;
  return null;
}

function courtAccessState(caseRecord) {
  const live = getGovernanceGuild(caseRecord.guild_id)?.enforcement_mode === 'live';
  if (caseRecord.procedure_version === 2 && caseRecord.status === 'appeal_window') {
    const sanction = getCaseSanction(caseRecord.id);
    if (live && sanction?.type === 'timeout' && sanction.review_requested_at) {
      return '被申立人はこの事件だけ（上訴を選択中）';
    }
    return live ? '通常（上訴を選択中）' : '通常（上訴を選択中・実執行停止中）';
  }
  if (caseRecord.status === 'appeal') return live
    ? '被申立人はこの事件投稿だけ（上訴中）'
    : '通常（上訴中・実執行停止中）';
  const protection = getCaseInterimProtection(caseRecord.id);
  if (caseRecord.procedure_version === 2 && caseRecord.status === 'defense') {
    return '全員閲覧可・当事者はボタンから回答';
  }
  if (protection?.status === 'active' && protection.ends_at > Date.now() && live) {
    return `被申立人はこの事件投稿だけ（一時保全・<t:${Math.floor(protection.ends_at / 1000)}:R>まで）`;
  }
  if (protection?.status === 'active' && protection.ends_at > Date.now()) return '通常（実執行停止中）';
  if (protection?.status === 'simulated') return '通常（一時保全の条件はshadowで確認済み・実制限なし）';
  return '通常（正式な主張として記録するのは当事者だけ）';
}

function caseLawDescription(caseRecord) {
  if (!caseRecord.law_id) return null;
  const law = getLaw(caseRecord.law_id);
  if (!law) return '適用法: 裁判記録に記載';
  const offense = law.provisions?.offenses?.find((entry) => entry.code === caseRecord.offense_code);
  return [
    `適用法: ${law.title}`,
    offense?.title ? `対象となる違反: ${offense.title}` : null
  ].filter(Boolean).join('\n');
}

const APPEAL_DENY = {
  SendMessages: false,
  SendMessagesInThreads: false,
  AddReactions: false,
  CreatePublicThreads: false,
  CreatePrivateThreads: false,
  Connect: false,
  Speak: false,
  UseApplicationCommands: false
};

const APPEAL_COURT_ACCESS = {
  ViewChannel: true,
  ReadMessageHistory: true,
  SendMessages: false,
  SendMessagesInThreads: true,
  AddReactions: false,
  CreatePublicThreads: false,
  CreatePrivateThreads: false,
  Connect: false,
  Speak: false,
  UseApplicationCommands: false
};

function botOverwrite(guild) {
  return {
    id: guild.members.me.id,
    type: OverwriteType.Member,
    allow: [
      PermissionFlagsBits.ViewChannel,
      PermissionFlagsBits.SendMessages,
      PermissionFlagsBits.SendMessagesInThreads,
      PermissionFlagsBits.CreatePublicThreads,
      PermissionFlagsBits.CreatePrivateThreads,
      PermissionFlagsBits.AttachFiles,
      PermissionFlagsBits.ReadMessageHistory,
      PermissionFlagsBits.ManageChannels,
      PermissionFlagsBits.ManageThreads,
      PermissionFlagsBits.ManageMessages
    ]
  };
}

export function readOnlyTextOverwrites(guild) {
  return [
    {
      id: guild.id,
      type: OverwriteType.Role,
      allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory],
      deny: [
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.SendMessagesInThreads,
        PermissionFlagsBits.AddReactions,
        PermissionFlagsBits.CreatePublicThreads,
        PermissionFlagsBits.CreatePrivateThreads,
        PermissionFlagsBits.UseApplicationCommands
      ]
    },
    botOverwrite(guild)
  ];
}

export function governanceProcedureOverwrites(guild) {
  return readOnlyTextOverwrites(guild);
}

export async function createGovernanceGuideChannel(guild, categoryId) {
  return guild.channels.create({
    name: GOVERNANCE_GUIDE_NAME,
    type: ChannelType.GuildText,
    parent: categoryId,
    topic: 'このコミュニティの統治制度、利用方法、公開記録への入口です。',
    permissionOverwrites: readOnlyTextOverwrites(guild),
    reason: `${guild.name} governance participant guide`
  });
}

export async function createGovernanceProcedureChannel(guild, categoryId) {
  return guild.channels.create({
    name: GOVERNANCE_PROCEDURE_NAME,
    type: ChannelType.GuildText,
    parent: categoryId,
    topic: GOVERNANCE_PROCEDURE_TOPIC,
    permissionOverwrites: governanceProcedureOverwrites(guild),
    reason: `${guild.name} governance procedure hub`
  });
}

function everyoneForumOverwrite(guild, { discuss }) {
  return {
    id: guild.id,
    allow: [
      PermissionFlagsBits.ViewChannel,
      PermissionFlagsBits.ReadMessageHistory,
      ...(discuss ? [PermissionFlagsBits.SendMessagesInThreads] : [])
    ],
    deny: [
      PermissionFlagsBits.SendMessages,
      PermissionFlagsBits.CreatePublicThreads,
      PermissionFlagsBits.CreatePrivateThreads,
      ...(!discuss ? [PermissionFlagsBits.SendMessagesInThreads] : [])
    ]
  };
}

export function courtForumEveryonePermissionState() {
  return {
    ViewChannel: true,
    ReadMessageHistory: true,
    SendMessages: false,
    SendMessagesInThreads: false,
    CreatePublicThreads: false,
    CreatePrivateThreads: false
  };
}

function courtForumBotPermissionState() {
  return {
    ViewChannel: true,
    SendMessages: true,
    SendMessagesInThreads: true,
    CreatePublicThreads: true,
    CreatePrivateThreads: false,
    AttachFiles: true,
    ReadMessageHistory: true,
    ManageChannels: true,
    ManageThreads: true,
    ManageMessages: true
  };
}

function overwriteFromPermissionState(id, type, state) {
  return {
    id,
    type,
    allow: Object.entries(state).filter(([, allowed]) => allowed).map(([name]) => PermissionFlagsBits[name]),
    deny: Object.entries(state).filter(([, allowed]) => !allowed).map(([name]) => PermissionFlagsBits[name])
  };
}

function courtForumOverwrites(guild) {
  return [
    overwriteFromPermissionState(guild.id, OverwriteType.Role, courtForumEveryonePermissionState()),
    overwriteFromPermissionState(guild.members.me.id, OverwriteType.Member, courtForumBotPermissionState())
  ];
}

function statuteForumOverwrites(guild) {
  const everyone = everyoneForumOverwrite(guild, { discuss: false });
  return [
    {
      ...everyone,
      deny: [...everyone.deny, PermissionFlagsBits.AddReactions]
    },
    botOverwrite(guild)
  ];
}

export function statuteForumEveryonePermissionState() {
  return {
    ViewChannel: true,
    ReadMessageHistory: true,
    SendMessages: false,
    SendMessagesInThreads: false,
    CreatePublicThreads: false,
    CreatePrivateThreads: false,
    AddReactions: false
  };
}

function statuteForumBotPermissionState() {
  return {
    ViewChannel: true,
    SendMessages: true,
    SendMessagesInThreads: true,
    CreatePublicThreads: true,
    CreatePrivateThreads: true,
    AttachFiles: true,
    ReadMessageHistory: true,
    ManageChannels: true,
    ManageThreads: true,
    ManageMessages: true
  };
}

function permissionStateMatches(channel, id, state) {
  const overwrite = channel.permissionOverwrites.cache.get(id);
  if (!overwrite) return false;
  return Object.entries(state).every(([name, allowed]) => {
    const permission = PermissionFlagsBits[name];
    return allowed
      ? overwrite.allow.has(permission) && !overwrite.deny.has(permission)
      : overwrite.deny.has(permission) && !overwrite.allow.has(permission);
  });
}

async function reconcileStatuteForumPermissions(forum, guild) {
  const everyoneState = statuteForumEveryonePermissionState();
  if (!permissionStateMatches(forum, guild.id, everyoneState)) {
    await forum.permissionOverwrites.edit(
      guild.id,
      everyoneState,
      { reason: '法令集を公開読み取り専用に同期' }
    );
  }
  const botState = statuteForumBotPermissionState();
  if (!permissionStateMatches(forum, guild.members.me.id, botState)) {
    await forum.permissionOverwrites.edit(
      guild.members.me.id,
      botState,
      { reason: '法令集のbot公開権限を同期' }
    );
  }
}

async function reconcileCourtForumPermissions(forum, guild) {
  const everyoneState = courtForumEveryonePermissionState();
  if (!permissionStateMatches(forum, guild.id, everyoneState)) {
    await forum.permissionOverwrites.edit(guild.id, everyoneState, {
      reason: '裁判所を公開審理の事件Forumに同期'
    });
  }
  const botState = courtForumBotPermissionState();
  if (!permissionStateMatches(forum, guild.members.me.id, botState)) {
    await forum.permissionOverwrites.edit(guild.members.me.id, botState, {
      reason: '裁判所のbot記録権限を同期'
    });
  }
}

async function createStatuteForum(guild, categoryId) {
  return guild.channels.create({
    name: '法令集',
    type: ChannelType.GuildForum,
    parent: categoryId,
    topic: STATUTE_TOPIC,
    availableTags: STATUTE_TAGS.map((name) => ({ name, moderated: true })),
    defaultAutoArchiveDuration: 10_080,
    permissionOverwrites: statuteForumOverwrites(guild),
    reason: 'Governance public statute book'
  });
}

async function createMentionRole(guild, name, { assignToBot = true } = {}) {
  const role = await guild.roles.create({
    name,
    permissions: [],
    mentionable: true,
    hoist: false,
    reason: `Governance conversational address: ${name}`
  });
  if (assignToBot) await guild.members.me.roles.add(role, `Enable @${name} governance address`);
  return role;
}

export async function ensureGovernanceMentionRoles(guild, governance) {
  await guild.roles.fetch();
  let legislature = governance.legislature_role_id
    ? guild.roles.cache.get(governance.legislature_role_id)
    : null;
  let judiciary = governance.judiciary_role_id
    ? guild.roles.cache.get(governance.judiciary_role_id)
    : null;
  if (!legislature) legislature = await createMentionRole(guild, '立法');
  if (!judiciary) judiciary = await createMentionRole(guild, '裁判');
  for (const role of [legislature, judiciary]) {
    if (!role.mentionable) await role.setMentionable(true, 'Governance address roles must be mentionable');
    if (!guild.members.me.roles.cache.has(role.id)) {
      await guild.members.me.roles.add(role, 'Restore governance conversational address');
    }
  }
  return { legislatureRoleId: legislature.id, judiciaryRoleId: judiciary.id };
}

export function governancePermissionReport(guild) {
  const me = guild.members.me;
  const required = [
    ['ManageChannels', PermissionFlagsBits.ManageChannels],
    ['ManageRoles', PermissionFlagsBits.ManageRoles],
    ['ManageThreads', PermissionFlagsBits.ManageThreads],
    ['ManageMessages', PermissionFlagsBits.ManageMessages],
    ['CreatePublicThreads', PermissionFlagsBits.CreatePublicThreads],
    ['SendMessages', PermissionFlagsBits.SendMessages],
    ['AttachFiles', PermissionFlagsBits.AttachFiles],
    ['MoveMembers', PermissionFlagsBits.MoveMembers],
    ['ModerateMembers', PermissionFlagsBits.ModerateMembers],
    ['KickMembers', PermissionFlagsBits.KickMembers],
    ['BanMembers', PermissionFlagsBits.BanMembers]
  ];
  const missing = required.filter(([, permission]) => !me?.permissions?.has(permission)).map(([name]) => name);
  return { ok: missing.length === 0, missing };
}

export async function createGovernanceSurfaces(guild, { resources = {}, onProgress = null } = {}) {
  const core = governancePermissionReport(guild);
  const bootstrapRequired = ['ManageChannels', 'ManageRoles', 'ManageThreads', 'ManageMessages'];
  const blocking = core.missing.filter((name) => bootstrapRequired.includes(name));
  if (blocking.length > 0) throw new Error(`初期化に必要なbot権限がありません: ${blocking.join(', ')}`);

  let state = { ...resources };
  const remember = async (key, entity) => {
    state = { ...state, [key]: entity.id };
    await onProgress?.(state);
    return entity;
  };
  const role = async (key, create) => {
    const existing = state[key] ? await guild.roles.fetch(state[key]).catch(() => null) : null;
    return existing ?? remember(key, await create());
  };
  const channel = async (key, type, create) => {
    const existing = state[key] ? await guild.channels.fetch(state[key]).catch(() => null) : null;
    return existing?.type === type ? existing : remember(key, await create());
  };

  const appealRole = await role('appealRoleId', () => guild.roles.create({
    name: '上訴中',
    permissions: [],
    mentionable: false,
    hoist: false,
    reason: `${guild.name} governance appeal restriction`
  }));
  const legislatureRole = await role('legislatureRoleId', () => createMentionRole(guild, '立法', { assignToBot: false }));
  const judiciaryRole = await role('judiciaryRoleId', () => createMentionRole(guild, '裁判', { assignToBot: false }));
  for (const mentionRole of [legislatureRole, judiciaryRole]) {
    if (!guild.members.me.roles.cache.has(mentionRole.id)) {
      await guild.members.me.roles.add(mentionRole, 'Restore governance conversational address during setup');
    }
  }
  const category = await channel('categoryId', ChannelType.GuildCategory, () => guild.channels.create({
    name: governanceCategoryName(guild.name),
    type: ChannelType.GuildCategory,
    reason: `${guild.name} governance bootstrap`
  }));
  const guide = await channel('guideChannelId', ChannelType.GuildText, () => createGovernanceGuideChannel(guild, category.id));
  const parliament = await channel('parliamentForumId', ChannelType.GuildForum, () => guild.channels.create({
    name: '議会',
    type: ChannelType.GuildForum,
    parent: category.id,
    topic: PARLIAMENT_TOPIC,
    availableTags: TAGS.map((name) => ({ name, moderated: true })),
    defaultAutoArchiveDuration: 10_080,
    permissionOverwrites: [everyoneForumOverwrite(guild, { discuss: true }), botOverwrite(guild)],
    reason: `${guild.name} governance parliament`
  }));
  const court = await channel('courtForumId', ChannelType.GuildForum, () => guild.channels.create({
    name: '裁判所',
    type: ChannelType.GuildForum,
    parent: category.id,
    topic: COURT_TOPIC,
    availableTags: [
      { name: '答弁', moderated: true },
      { name: '審理', moderated: true },
      { name: '承認待ち', moderated: true },
      { name: '上訴', moderated: true },
      { name: '確定', moderated: true },
      { name: '取消', moderated: true }
    ],
    defaultAutoArchiveDuration: 10_080,
    permissionOverwrites: courtForumOverwrites(guild),
    reason: `${guild.name} governance court`
  }));
  const statuteForum = await channel('statuteForumId', ChannelType.GuildForum, () => createStatuteForum(guild, category.id));
  const gazette = await channel('gazetteChannelId', ChannelType.GuildText, () => guild.channels.create({
    name: '官報',
    type: ChannelType.GuildText,
    parent: category.id,
    topic: GAZETTE_TOPIC,
    permissionOverwrites: [
      {
        id: guild.id,
        allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory],
        deny: [
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.SendMessagesInThreads,
          PermissionFlagsBits.AddReactions,
          PermissionFlagsBits.CreatePublicThreads,
          PermissionFlagsBits.CreatePrivateThreads
        ]
      },
      botOverwrite(guild)
    ],
    reason: `${guild.name} governance gazette`
  }));
  const admin = await channel('adminChannelId', ChannelType.GuildText, () => createGovernanceProcedureChannel(guild, category.id));
  if (state.courtChatChannelId && state.courtChatChannelId !== court.id) {
    const legacy = await guild.channels.fetch(state.courtChatChannelId).catch(() => null);
    await retireLegacyCourtChat(legacy, guild.name);
  }
  state = { ...state, courtChatChannelId: court.id };
  await onProgress?.(state);
  await syncAppealRoleOverwrites(guild, appealRole.id, court.id);
  return {
    appealRoleId: appealRole.id,
    legislatureRoleId: legislatureRole.id,
    judiciaryRoleId: judiciaryRole.id,
    categoryId: category.id,
    parliamentForumId: parliament.id,
    courtForumId: court.id,
    // DB互換用の旧column。公開裁判所Forumと同じIDを保存し、別channelは作らない。
    courtChatChannelId: court.id,
    statuteForumId: statuteForum.id,
    gazetteChannelId: gazette.id,
    guideChannelId: guide.id,
    adminChannelId: admin.id,
    permissionReport: core
  };
}

export async function ensureGovernanceParliamentForum(guild, governance) {
  const forum = await guild.channels.fetch(governance.parliament_forum_id).catch(() => null);
  if (!forum || forum.type !== ChannelType.GuildForum) throw new Error('議会Forumが見つかりません。');
  if (forum.topic !== PARLIAMENT_TOPIC) await forum.setTopic(PARLIAMENT_TOPIC, '議会の説明を同期');
  const known = new Set(forum.availableTags.map((tag) => tag.name));
  const missing = TAGS.filter((name) => !known.has(name));
  if (missing.length > 0) {
    const tags = [
      ...forum.availableTags.map((tag) => ({
        id: tag.id,
        name: tag.name,
        moderated: tag.moderated,
        emoji: tag.emoji
      })),
      ...missing.map((name) => ({ name, moderated: true }))
    ];
    if (tags.length > 20) throw new Error('議会Forumの利用可能タグ上限20件を超えます。');
    await forum.setAvailableTags(tags, '議会の手続状態タグを同期');
  }
  return forum;
}

export async function ensureGovernanceStatuteForum(guild, governance) {
  const existing = governance.statute_forum_id
    ? await guild.channels.fetch(governance.statute_forum_id).catch(() => null)
    : null;
  if (existing?.type === ChannelType.GuildForum) {
    if (existing.topic !== STATUTE_TOPIC) await existing.setTopic(STATUTE_TOPIC, '法令集の説明を同期');
    await reconcileStatuteForumPermissions(existing, guild);
    return existing;
  }
  if (!governance.category_id) throw new Error('統治カテゴリがないため法令集を作成できません。');
  return createStatuteForum(guild, governance.category_id);
}

export async function ensureGovernanceCourtForum(guild, governance) {
  const forum = await guild.channels.fetch(governance.court_forum_id).catch(() => null);
  if (!forum || forum.type !== ChannelType.GuildForum) throw new Error('裁判所Forumが見つかりません。');
  if (forum.topic !== COURT_TOPIC) await forum.setTopic(COURT_TOPIC, '裁判所を公開審理へ同期');
  await reconcileCourtForumPermissions(forum, guild);
  await syncAppealRoleOverwrites(guild, governance.appeal_role_id, forum.id);
  return forum;
}

async function retireLegacyCourtChat(channel, guildName) {
  if (!channel || channel.type !== ChannelType.GuildText) return { removed: false, retained: false };
  let hasCourtRecords = true;
  try {
    const [active, archived, messages] = await Promise.all([
      channel.threads.fetchActive(),
      // Discord APIのarchive取得limitは2以上。存在確認だけなので最小値を使う。
      channel.threads.fetchArchived({ type: 'private', fetchAll: true, limit: 2 }),
      // 旧実装や手動運用で本文をtext channelへ直接残した可能性もある。
      channel.messages.fetch({ limit: 2 })
    ]);
    const belongsToChannel = (thread) => thread.parentId === channel.id;
    hasCourtRecords = [...active.threads.values(), ...archived.threads.values()].some(belongsToChannel)
      || messages.size > 0;
  } catch {
    // 読み戻せない場合は記録を消さず、legacy archiveとして残す。
  }
  if (!hasCourtRecords) {
    const removed = await channel.delete(`${guildName} governance: public court migration`)
      .then(() => true).catch(() => false);
    if (removed) return { removed: true, retained: false };
  }
  if (channel.name === '裁判当事者用' || channel.name === '裁判チャット') {
    await channel.setName('旧・非公開審理記録', '公開裁判への移行後も既存記録を保全').catch(() => {});
  }
  if (channel.topic !== '公開裁判への移行前の記録です。新しい答弁・証拠・上訴は裁判所の事件投稿で行います。') {
    await channel.setTopic('公開裁判への移行前の記録です。新しい答弁・証拠・上訴は裁判所の事件投稿で行います。', '既存裁判記録を保全').catch(() => {});
  }
  return { removed: false, retained: true };
}

export async function retireGovernanceCourtChat(guild, governance) {
  const candidates = new Map();
  if (governance.court_chat_channel_id && governance.court_chat_channel_id !== governance.court_forum_id) {
    const referenced = await guild.channels.fetch(governance.court_chat_channel_id).catch(() => null);
    if (referenced) candidates.set(referenced.id, referenced);
  }

  // 先行versionでDBの互換columnだけ先に裁判所Forumへ更新された場合も、
  // 統治category内に取り残された旧channelを再発見して移行を完了する。
  const knownLegacyNames = new Set(['裁判当事者用', '裁判チャット', '旧・非公開審理記録']);
  const fetched = await guild.channels.fetch().catch(() => null);
  const allChannels = fetched?.values ? fetched : guild.channels.cache;
  for (const channel of allChannels?.values?.() ?? []) {
    if (
      channel.type === ChannelType.GuildText
      && channel.parentId === governance.category_id
      && channel.id !== governance.court_forum_id
      && knownLegacyNames.has(channel.name)
    ) candidates.set(channel.id, channel);
  }

  let removed = false;
  let retained = false;
  for (const channel of candidates.values()) {
    const result = await retireLegacyCourtChat(channel, guild.name);
    removed ||= result.removed;
    retained ||= result.retained;
  }
  return { removed, retained };
}

export async function ensureGovernanceGazetteTopic(guild, governance) {
  const gazette = await guild.channels.fetch(governance.gazette_channel_id).catch(() => null);
  if (!gazette?.isTextBased?.() || typeof gazette.setTopic !== 'function') {
    throw new Error('官報channelが見つかりません。');
  }
  if (gazette.topic !== GAZETTE_TOPIC) await gazette.setTopic(GAZETTE_TOPIC, '官報の説明を同期');
  const everyoneState = {
    ViewChannel: true,
    ReadMessageHistory: true,
    SendMessages: false,
    SendMessagesInThreads: false,
    AddReactions: false,
    CreatePublicThreads: false,
    CreatePrivateThreads: false
  };
  if (!permissionStateMatches(gazette, guild.id, everyoneState)) {
    await gazette.permissionOverwrites.edit(guild.id, everyoneState, { reason: '官報を公開読み取り専用に同期' });
  }
  return gazette;
}

export function statutePublicationState(instrumentType, status) {
  if (instrumentType === 'constitution') return status === 'active' ? '現行憲法' : '旧憲法';
  return ({
    active: '現行法',
    superseded: '廃止',
    suspended: '停止',
    unconstitutional: '違憲',
    repealed: '廃止'
  })[status] ?? '廃止';
}

function statuteDocument(instrumentType, instrument) {
  if (instrumentType === 'constitution') {
    const state = statutePublicationState(instrumentType, instrument.status);
    const headings = [...instrument.content.matchAll(/^#{1,3}\s+(.+)$/gm)]
      .slice(0, 6)
      .map((match) => match[1]);
    return {
      title: `憲法 v${instrument.version}`,
      state,
      hash: instrument.content_hash,
      content: [
        `# 憲法 v${instrument.version}`,
        `状態: ${state}`,
        `公布: <t:${Math.floor(instrument.enacted_at / 1000)}:F>`,
        '',
        headings.length > 0 ? `主な構成: ${headings.join(' / ')}` : 'コミュニティの最高規範です。',
        '',
        '全文は、この投稿を開いた先で確認できます。'
      ].join('\n').slice(0, 2_000),
      detailContent: [
        `## 憲法 v${instrument.version} 詳細`,
        '全文を添付します。'
      ].join('\n'),
      files: [
        { attachment: Buffer.from(instrument.content), name: `constitution-v${instrument.version}.md` },
        { attachment: Buffer.from(`${JSON.stringify(instrument.rules ?? instrument.policy, null, 2)}\n`), name: `constitution-rules-v${instrument.version}.json` }
      ]
    };
  }
  const state = statutePublicationState(instrumentType, instrument.status);
  const full = [
    `# ${instrument.title} v${instrument.version ?? 1}`,
    '',
    instrument.text,
    '',
    '## Provisions',
    '',
    '```json',
    JSON.stringify(instrument.provisions, null, 2),
    '```'
  ].join('\n');
  return {
    title: `${instrument.title} v${instrument.version ?? 1}`,
    state,
    hash: instrument.content_hash,
    content: [
      `# ${instrument.title} v${instrument.version ?? 1}`,
      `状態: ${state}`,
      `施行: <t:${Math.floor(instrument.effective_at / 1000)}:F>`,
      '',
      instrument.text.split(/\n+/).find((line) => line.trim() && !line.trim().startsWith('#'))?.slice(0, 500)
        ?? '成立した法律です。',
      '',
      '全文は、この投稿を開いた先で確認できます。'
    ].join('\n').slice(0, 2_000),
    detailContent: `## ${instrument.title} v${instrument.version ?? 1} 詳細\n全文を添付します。`,
    files: [{ attachment: Buffer.from(full), name: '法律全文.md' }]
  };
}

async function applyStatuteState(thread, forum, state, content) {
  const stateTag = tagId(forum, state);
  if (!stateTag) throw new Error(`法令集の状態tagがありません: ${state}`);
  const wasArchived = Boolean(thread.archived);
  if (wasArchived) await thread.setArchived(false, '法令状態の同期');
  const starter = await thread.fetchStarterMessage();
  if (starter) await starter.edit({ content, attachments: [], allowedMentions: { parse: [] } });
  await thread.setAppliedTags([stateTag], `法令状態: ${state}`);
  if (wasArchived) await thread.setArchived(true, '法令状態の同期完了');
}

async function publishStatute(guild, forum, instrumentType, instrument, document) {
  const stateTag = tagId(forum, document.state);
  if (!stateTag) throw new Error(`法令集の状態tagがありません: ${document.state}`);
  const thread = await forum.threads.create({
    name: document.title.slice(0, 100),
    appliedTags: [stateTag],
    autoArchiveDuration: 10_080,
    message: {
      content: document.content,
      allowedMentions: { parse: [] }
    },
    reason: `Publish ${instrumentType} ${instrument.id}`
  });
  const starter = await thread.fetchStarterMessage();
  const detail = await thread.send({
    content: document.detailContent,
    files: document.files,
    allowedMentions: { parse: [] }
  });
  return upsertStatutePublication({
    guildId: guild.id,
    instrumentType,
    instrumentId: instrument.id,
    forumThreadId: thread.id,
    forumMessageId: starter?.id ?? thread.id,
    detailMessageId: detail.id,
    publicationStatus: document.state,
    contentHash: document.hash
  });
}

export async function syncStatuteBook(guild, governance, { verifyExisting = false } = {}) {
  const forum = await guild.channels.fetch(governance.statute_forum_id).catch(() => null);
  if (forum?.type !== ChannelType.GuildForum) throw new Error('法令集Forumが見つかりません。');
  const instruments = [
    ...listConstitutions(guild.id, { limit: 100 }).map((instrument) => ({ instrumentType: 'constitution', instrument })),
    ...listLaws(guild.id, { activeOnly: false, limit: 500 }).map((instrument) => ({ instrumentType: 'law', instrument }))
  ].filter(({ instrumentType, instrument }) => {
    if (String(instrument.title ?? '').startsWith('[E2E:')) return false;
    if (instrumentType !== 'law' || instrument.status !== 'repealed') return true;
    return !String(getProposal(instrument.proposal_id)?.source ?? '').startsWith('live_e2e:');
  });
  let changed = 0;
  for (const { instrumentType, instrument } of instruments) {
    const document = statuteDocument(instrumentType, instrument);
    const publication = getStatutePublication(guild.id, instrumentType, instrument.id);
    if (publication
      && publication.publication_status === document.state
      && publication.content_hash === document.hash
      && !verifyExisting) continue;
    const thread = publication
      ? await guild.channels.fetch(publication.forum_thread_id).catch(() => null)
      : null;
    if (!thread?.isThread?.() || thread.parentId !== forum.id || publication?.content_hash !== document.hash) {
      await publishStatute(guild, forum, instrumentType, instrument, document);
      changed += 1;
      continue;
    }
    let detail = publication.detail_message_id
      ? await thread.messages.fetch(publication.detail_message_id).catch(() => null)
      : null;
    if (verifyExisting) {
      const starter = await thread.fetchStarterMessage().catch(() => null);
      const attachmentNames = [...(detail?.attachments?.values?.() ?? [])].map((attachment) => attachment.name);
      const expectedNames = document.files.map((file) => file.name);
      const displayTitle = document.title.slice(0, 100);
      const rename = thread.name !== displayTitle;
      const refreshStarter = starter?.content !== document.content || starter?.attachments?.size > 0;
      const refreshDetail = detail && (detail.content !== document.detailContent
        || JSON.stringify(attachmentNames) !== JSON.stringify(expectedNames));
      const reopen = Boolean(thread.archived && (rename || refreshStarter || refreshDetail));
      if (reopen) await thread.setArchived(false, '法令表示の同期');
      if (rename) {
        await thread.setName(displayTitle, '法令名の表示を同期');
        changed += 1;
      }
      if (refreshStarter) {
        await starter?.edit({ content: document.content, attachments: [], allowedMentions: { parse: [] } });
        changed += 1;
      }
      if (refreshDetail) {
        await detail.edit({
          content: document.detailContent,
          attachments: [],
          files: document.files,
          allowedMentions: { parse: [] }
        });
        changed += 1;
      }
      if (reopen) await thread.setArchived(true, '法令表示の同期完了');
    }
    if (!detail) {
      const wasArchived = Boolean(thread.archived);
      if (wasArchived) await thread.setArchived(false, '法令詳細の同期');
      detail = await thread.send({ content: document.detailContent, files: document.files, allowedMentions: { parse: [] } });
      if (wasArchived) await thread.setArchived(true, '法令詳細の同期完了');
      changed += 1;
    }
    if (publication.publication_status !== document.state) {
      await applyStatuteState(thread, forum, document.state, document.content);
      upsertStatutePublication({
        guildId: guild.id,
        instrumentType,
        instrumentId: instrument.id,
        forumThreadId: thread.id,
        forumMessageId: publication.forum_message_id,
        detailMessageId: detail.id,
        publicationStatus: document.state,
        contentHash: document.hash
      });
      changed += 1;
    } else if (publication.detail_message_id !== detail.id) {
      upsertStatutePublication({
        guildId: guild.id,
        instrumentType,
        instrumentId: instrument.id,
        forumThreadId: thread.id,
        forumMessageId: publication.forum_message_id,
        detailMessageId: detail.id,
        publicationStatus: document.state,
        contentHash: document.hash
      });
    }
  }
  return changed;
}

export async function syncAppealRoleOverwrites(guild, roleId, courtForumId, { strict = false } = {}) {
  await guild.channels.fetch();
  const failures = [];
  for (const channel of guild.channels.cache.values()) {
    if (!channel.permissionOverwrites) continue;
    const permissionState = channel.id === courtForumId ? APPEAL_COURT_ACCESS : APPEAL_DENY;
    try {
      await channel.permissionOverwrites.edit(roleId, permissionState, {
        reason: `${guild.name} governance: appeal restriction can speak only in court forum`
      });
    } catch (error) {
      failures.push({ channelId: channel.id, error: String(error?.message ?? error) });
    }
  }
  if (strict && failures.length > 0) {
    throw new Error(`上訴中ロールの権限を${failures.length}チャンネルで同期できません。`);
  }
  return { failures };
}

export function appealRestrictedChannelAccessible(channel, member, courtForumId) {
  if (channel.id === courtForumId || channel.parentId === courtForumId) return false;
  const permissions = channel.permissionsFor?.(member);
  if (channel.isTextBased?.()) {
    return Boolean(permissions?.has(PermissionFlagsBits.SendMessages)
      || permissions?.has(PermissionFlagsBits.SendMessagesInThreads));
  }
  if (channel.isVoiceBased?.()) {
    return Boolean(permissions?.has(PermissionFlagsBits.Connect)
      || permissions?.has(PermissionFlagsBits.Speak));
  }
  return false;
}

function tagId(channel, name) {
  return channel.availableTags?.find((tag) => tag.name === name)?.id ?? null;
}

export async function setForumState(thread, name) {
  const id = tagId(thread.parent, name);
  if (!id) return;
  await thread.setAppliedTags([id], `Community governance state: ${name}`);
}

export function voteButtons(proposalId, disabled = false) {
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`gov:vote:${proposalId}:yes`).setLabel('賛成').setStyle(ButtonStyle.Success).setDisabled(disabled),
    new ButtonBuilder().setCustomId(`gov:vote:${proposalId}:no`).setLabel('反対').setStyle(ButtonStyle.Danger).setDisabled(disabled),
    new ButtonBuilder().setCustomId(`gov:vote:${proposalId}:abstain`).setLabel('棄権').setStyle(ButtonStyle.Secondary).setDisabled(disabled)
  )];
}

export function approvalButtons(caseId, disabled = false) {
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`gov:approve:${caseId}:approve`).setLabel('執行承認').setStyle(ButtonStyle.Success).setDisabled(disabled),
    new ButtonBuilder().setCustomId(`gov:approve:${caseId}:reject`).setLabel('承認しない').setStyle(ButtonStyle.Danger).setDisabled(disabled)
  )];
}

function withoutDecisionRows(components = [], actions = ['vote', 'approve']) {
  const blocked = new Set(actions);
  return components.filter((row) => !(row.components ?? []).some((component) => {
    const customId = component.customId ?? component.data?.custom_id;
    const action = String(customId ?? '').match(/^gov:(vote|approve):/)?.[1];
    return action && blocked.has(action);
  }));
}

export function reviewRequestButtons(guildId, sanctionId, disabled = false) {
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`gov:review:${guildId}:${sanctionId}`)
      .setLabel('裁判を求める')
      .setStyle(ButtonStyle.Primary)
      .setDisabled(disabled)
  )];
}

function proposalNextAction(proposal) {
  if (proposal.workflow_status === 'queued') return '先行案件の終了後、最新版を基礎に自動で草案を作成します。';
  const byStatus = ({
    drafting: 'AIが草案を作成しています。',
    draft: '公開草案を確認できます。受付時の手続に従って次の段階へ進みます。',
    constitutional_review: '最終案を固定し、AIが憲法との整合を審査しています。',
    debate: '草案または調整案を読み、意見をこの投稿へ書きます。',
    voting: '「進行中」の案件カードから投票します。',
    enacted: '成立済みです。現行本文は法令集で確認できます。',
    rejected: '否決され、手続は終了しました。',
    remanded: '差し戻され、手続は終了しました。'
  })[proposal.status];
  if (byStatus) return byStatus;
  return ({
    draft: 'AIが草案を作成しています。',
    public_discussion: '案を読み、意見をこの投稿へ書きます。',
    ai_deliberation: '討議内容をAIが整理しています。',
    constitutional_panel: 'AIが憲法との整合を審査しています。',
    public_vote: '「進行中」の案件カードから投票します。',
    terminal: 'この手続は終了しました。'
  })[proposalHandler(proposal)] ?? '経過はこの投稿で確認できます。';
}

function proposalStarterContent(proposal, nextAction = proposalNextAction(proposal), displayState = proposal.status) {
  const governance = getGovernanceGuild(proposal.guild_id);
  const voting = proposalHandler(proposal) === 'public_vote';
  return [
    `# ${proposal.title}`,
    '',
    proposal.summary,
    '',
    `状態: **${proposal.workflow_status === 'queued' ? '待機' : proposalStateLabel(displayState, proposalHandler(proposal))}**`,
    proposalDeadline(proposal) ? `期限: ${proposalDeadline(proposal)}` : null,
    `いま必要なこと: ${oneLine(nextAction)}`,
    voting && governance?.admin_channel_id
      ? `[進行中で投票](https://discord.com/channels/${proposal.guild_id}/${governance.admin_channel_id})`
      : null,
    '草案・調整案・最終案と経過はこの投稿内にあります。'
  ].filter(Boolean).join('\n').slice(0, 2_000);
}

function courtNextAction(caseRecord) {
  return ({
    filing: '裁判の準備中です。',
    summary_review: 'AIが成立法に照らして判定しています。',
    summary_active: '被処分者は「裁判を求める」から争えます。',
    defense: '当事者は下のボタンから回答します。',
    deliberation: '回答を締め切り、AIが判定しています。',
    approval: '特別有権者は「進行中」の案件カードから公開承認します。',
    appeal_window: '被申立人は下のボタンから上訴できます。',
    appeal: '上訴審の回答または判定を待っています。',
    execution: '確定した処分を処理しています。',
    final: '判決は確定しました。',
    overturned: '処分は取り消されました。',
    acquitted: '責任なしで終了しました。',
    dismissed: '申立ては棄却されました。',
    constitutional_uncertain: '違憲判断は成立しませんでした。',
    unenforceable: '処分を執行できないまま終了しました。'
  })[caseRecord.status] ?? '経過はこの投稿で確認できます。';
}

function courtThreadName(caseRecord) {
  return `${caseRecord.kind === 'constitutional' ? '違憲審査' : '法律違反'}: ${caseRecord.summary}`.slice(0, 100);
}

function courtStarterContent(caseRecord, nextAction = courtNextAction(caseRecord), displayState = caseRecord.status) {
  const governance = getGovernanceGuild(caseRecord.guild_id);
  return [
    `# ${caseRecord.kind === 'constitutional' ? '違憲審査' : '法律違反の申立て'}`,
    caseRecord.accused_id ? `被申立人: ${publicMemberLabel(caseRecord.accused_id, '動作確認用アカウント')}` : null,
    caseLawDescription(caseRecord),
    '',
    caseRecord.summary,
    '',
    `状態: **${caseStateLabel(displayState)}**`,
    `発言状態: ${courtAccessState(caseRecord)}`,
    courtDeadline(caseRecord) ? `期限: <t:${Math.floor(courtDeadline(caseRecord) / 1000)}:F>` : null,
    `いま必要なこと: ${oneLine(nextAction)}`,
    caseRecord.status === 'approval' && governance?.admin_channel_id
      ? `[進行中で執行承認](https://discord.com/channels/${caseRecord.guild_id}/${governance.admin_channel_id})`
      : null,
    '答弁・証拠・判断・上訴はこの投稿にまとまります。執行承認は「進行中」で行います。'
  ].filter(Boolean).join('\n').slice(0, 2_000);
}

export async function createProposalPost(guild, governance, proposal) {
  const forum = await guild.channels.fetch(governance.parliament_forum_id);
  if (!forum?.threads) throw new Error('議会Forumが見つかりません。');
  const stageTag = tagId(
    forum,
    proposalHandler(proposal) === 'public_discussion' ? '討議' : '草案'
  );
  const body = proposal.body;
  const fullDraft = proposal.kind === 'amendment'
    ? `# ${body.title}\n\n${body.content}\n\n実行手続: ${body.rules ? governanceRulesSummary(body.rules) : 'legacy policy'}`
    : `# ${body.title}\n\n${body.text}\n\n## Provisions\n\n\`\`\`json\n${JSON.stringify(body.provisions, null, 2)}\n\`\`\``;
  const structuredDraft = proposal.kind === 'amendment' ? (body.rules ?? body.policy) : body.provisions;
  const structuredName = proposal.kind === 'amendment' ? 'rules' : 'provisions';
  const thread = await forum.threads.create({
    name: proposal.title.slice(0, 100),
    appliedTags: stageTag ? [stageTag] : [],
    autoArchiveDuration: 10_080,
    message: {
      content: proposalStarterContent(proposal),
      files: [
        { attachment: Buffer.from(fullDraft), name: '草案全文.md' },
        {
          attachment: Buffer.from(`${JSON.stringify(structuredDraft, null, 2)}\n`),
          name: `${structuredName === 'rules' ? '憲法実行規則' : '執行定義'}.json`
        }
      ],
      allowedMentions: { parse: [] }
    },
    reason: `${guild.name} governance proposal ${proposal.id}`
  });
  const starter = await thread.fetchStarterMessage();
  return { threadId: thread.id, messageId: starter?.id ?? thread.id };
}

export async function postProposalUpdate(guild, proposal, text, { state = null, components = [], files = [] } = {}) {
  const thread = await guild.channels.fetch(proposal.forum_thread_id).catch(() => null);
  if (!thread?.isThread?.()) throw new Error('議会の案件投稿が見つかりません。公開記録なしでは手続を進められません。');
  if (state) await setForumState(thread, state).catch(() => {});
  const starter = await thread.fetchStarterMessage().catch(() => null);
  if (starter) {
    await starter.edit({
      content: proposalStarterContent(proposal, text, state ?? proposal.status),
      allowedMentions: { parse: [] }
    }).catch(() => {});
  }
  return thread.send({
    content: text.slice(0, 2000),
    components: withoutDecisionRows(components, ['vote']),
    files,
    allowedMentions: { parse: [] }
  });
}

export async function createCourtCaseThread(guild, governance, caseRecord, { onPartial = null } = {}) {
  const forum = await guild.channels.fetch(governance.court_forum_id);
  if (!forum?.threads) throw new Error('裁判所Forumが見つかりません。');
  const answerTag = tagId(forum, '答弁');
  const publicThread = caseRecord.public_thread_id
    ? await guild.channels.fetch(caseRecord.public_thread_id)
    : await forum.threads.create({
    name: courtThreadName(caseRecord),
    appliedTags: answerTag ? [answerTag] : [],
    autoArchiveDuration: 10_080,
    message: {
      content: courtStarterContent(caseRecord),
      components: courtActionButtons(caseRecord),
      allowedMentions: { parse: [] }
    },
    reason: `${guild.name} governance case ${caseRecord.id}`
  });
  await onPartial?.({ public_thread_id: publicThread.id });
  return { publicThreadId: publicThread.id };
}

export async function postCourtUpdate(guild, caseRecord, text, { state = null, components = [], files = [] } = {}) {
  const thread = await guild.channels.fetch(caseRecord.public_thread_id).catch(() => null);
  if (!thread?.isThread?.()) return null;
  if (state) await setForumState(thread, state).catch(() => {});
  const starter = await thread.fetchStarterMessage().catch(() => null);
  if (starter) {
    await starter.edit({
      content: courtStarterContent(caseRecord, text, state ?? caseRecord.status),
      components: courtActionButtons(caseRecord),
      allowedMentions: { parse: [] }
    }).catch(() => {});
  }
  return thread.send({
    content: text.slice(0, 2000),
    components: withoutDecisionRows(components, ['approve']),
    files,
    allowedMentions: { parse: [] }
  });
}

function proposalForumState(proposal) {
  if (proposal.workflow_status === 'queued') return '待機';
  const byStatus = ({
    drafting: '草案', draft: '草案', constitutional_review: '違憲審査', debate: '討議', voting: '投票',
    enacted: '成立', rejected: '否決', remanded: '廃案'
  })[proposal.status];
  if (byStatus) return byStatus;
  return ({
    draft: '草案', public_discussion: '討議', ai_deliberation: '討議',
    constitutional_panel: '違憲審査', public_vote: '投票', terminal: '廃案'
  })[proposalHandler(proposal)] ?? null;
}

function courtForumState(status) {
  if (['filing', 'defense'].includes(status)) return '答弁';
  if (['summary_review', 'deliberation'].includes(status)) return '審理';
  if (status === 'approval') return '承認待ち';
  if (['appeal_window', 'appeal'].includes(status)) return '上訴';
  return '確定';
}

async function removeOldDecisionRows(thread, actions) {
  let before;
  for (let page = 0; page < 5; page += 1) {
    const batch = await thread.messages.fetch({ limit: 100, ...(before ? { before } : {}) });
    if (batch.size === 0) break;
    for (const message of batch.values()) {
      if (message.author.id !== thread.client.user.id || !message.components?.length) continue;
      const retained = withoutDecisionRows(message.components, actions);
      if (retained.length !== message.components.length) await message.edit({ components: retained });
    }
    before = batch.last()?.id;
    if (batch.size < 100 || !before) break;
  }
}

async function syncRecordThread(thread, { name, content, components, state, removeActions = [] }) {
  const wasArchived = Boolean(thread.archived);
  if (wasArchived) await thread.setArchived(false, '公開表示を同期');
  if (thread.name !== name) await thread.setName(name, '内部番号を使わない表示へ同期');
  const starter = await thread.fetchStarterMessage().catch(() => null);
  if (starter) await starter.edit({ content, components, allowedMentions: { parse: [] } });
  if (removeActions.length) await removeOldDecisionRows(thread, removeActions);
  if (state) await setForumState(thread, state);
  if (wasArchived) await thread.setArchived(true, '公開表示の同期完了');
}

export function withoutLegacyPublicIds(content) {
  return maskDiscordUrls(String(content ?? '')
    .replace(/<@!?([^>]+)>/g, (mention, userId) => /^\d{17,20}$/.test(userId) ? mention : '表示対象のアカウント')
    .replace(/\[E2E:[^\]]+\]/g, '【動作確認】')
    .replace(/制裁\s*#\d+/g, '制裁')
    .replace(/^\s*(?:参照番号|法律ID|ロールID):[^\n]*\n?/gim, '')
    .replace(/(^#{1,6}\s+[^\n]*?)\s+(?:L|C|A)-\d+\s*$/gim, '$1')
    .replace(/\n{3,}/g, '\n\n')
    .trim());
}

async function sanitizedGazetteAttachments(message) {
  const retained = [];
  const files = [];
  let changed = false;
  for (const attachment of message.attachments.values()) {
    if (!/\.(?:md|txt|json)$/i.test(attachment.name ?? '') || attachment.size > 1_000_000) {
      retained.push({ id: attachment.id });
      continue;
    }
    const original = await fetch(attachment.url).then((response) => response.ok ? response.text() : null).catch(() => null);
    if (original === null) {
      retained.push({ id: attachment.id });
      continue;
    }
    const sanitized = withoutLegacyPublicIds(original);
    if (sanitized === original) {
      retained.push({ id: attachment.id });
      continue;
    }
    changed = true;
    files.push({ attachment: Buffer.from(sanitized), name: attachment.name });
  }
  return { changed, retained, files };
}

export async function syncGovernanceRecordUi(guild, governance) {
  let changed = 0;
  const failures = [];
  for (const proposal of listProposals(guild.id, { limit: 500 })) {
    if (!proposal.forum_thread_id || proposal.title.startsWith('[E2E:')) continue;
    const thread = await guild.channels.fetch(proposal.forum_thread_id).catch(() => null);
    if (!thread?.isThread?.() || thread.parentId !== governance.parliament_forum_id) continue;
    try {
      await syncRecordThread(thread, {
        name: proposal.title.slice(0, 100),
        content: proposalStarterContent(proposal),
        components: [],
        state: proposalForumState(proposal),
        removeActions: ['vote']
      });
      changed += 1;
    } catch (error) {
      failures.push(`proposal ${proposal.id}: ${error?.message ?? error}`);
    }
  }
  for (const caseRecord of listCases(guild.id, { limit: 500 })) {
    if (!caseRecord.public_thread_id || caseRecord.summary.startsWith('[E2E:')) continue;
    const thread = await guild.channels.fetch(caseRecord.public_thread_id).catch(() => null);
    if (!thread?.isThread?.() || thread.parentId !== governance.court_forum_id) continue;
    try {
      await syncRecordThread(thread, {
        name: courtThreadName(caseRecord),
        content: courtStarterContent(caseRecord),
        components: caseRecord.status === 'approval' ? [] : courtActionButtons(caseRecord),
        state: courtForumState(caseRecord.status),
        removeActions: ['approve']
      });
      changed += 1;
    } catch (error) {
      failures.push(`case ${caseRecord.id}: ${error?.message ?? error}`);
    }
  }
  const gazette = await guild.channels.fetch(governance.gazette_channel_id).catch(() => null);
  if (gazette?.isTextBased?.()) {
    let before;
    for (let page = 0; page < 10; page += 1) {
      const batch = await gazette.messages.fetch({ limit: 100, ...(before ? { before } : {}) });
      if (batch.size === 0) break;
      for (const message of batch.values()) {
        if (message.author.id !== guild.client.user.id) continue;
        const content = withoutLegacyPublicIds(message.content);
        const attachmentUpdate = await sanitizedGazetteAttachments(message);
        if (content !== message.content || attachmentUpdate.changed) {
          await message.edit({
            content,
            ...(attachmentUpdate.changed ? {
              attachments: attachmentUpdate.retained,
              files: attachmentUpdate.files
            } : {})
          });
          changed += 1;
        }
      }
      before = batch.last()?.id;
      if (batch.size < 100 || !before) break;
    }
  }
  if (failures.length > 0) throw new Error(`公開表示を${failures.length}件同期できません: ${failures.slice(0, 3).join(' / ')}`);
  return changed;
}

export function courtActionButtons(caseRecord) {
  if (caseRecord.status === 'appeal_window') {
    return [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`gov:court:${caseRecord.id}:appeal`).setLabel('上訴する').setStyle(ButtonStyle.Primary)
    )];
  }
  if (!['defense', 'appeal'].includes(caseRecord.status)) return [];
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`gov:court:${caseRecord.id}:answer`).setLabel('回答を書く').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`gov:court:${caseRecord.id}:evidence`).setLabel('証拠を出す').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`gov:court:${caseRecord.id}:complete`).setLabel('回答完了').setStyle(ButtonStyle.Success)
  )];
}

export async function postCourtRecord(guild, caseRecord, text, { files = [] } = {}) {
  const thread = await guild.channels.fetch(caseRecord.public_thread_id).catch(() => null);
  if (!thread?.isThread?.()) throw new Error('裁判所の事件投稿が見つかりません。');
  return thread.send({ content: text.slice(0, 2000), files, allowedMentions: { parse: [] } });
}

function gazetteSummary(body) {
  const lines = String(body ?? '').split('\n');
  let inFence = false;
  const kept = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (line.startsWith('```')) {
      inFence = !inFence;
      continue;
    }
    if (inFence || !line || /^[{}\[\],]+$/.test(line) || /^"[^\n]+":/.test(line)) continue;
    if (/^(content|policy) hash:/i.test(line)) continue;
    kept.push(line);
    if (kept.join('\n').length >= 900 || kept.length >= 10) break;
  }
  return kept.join('\n').slice(0, 900) || '詳細は添付の監査記録を確認してください。';
}

function safeGazetteFilename(heading) {
  const base = String(heading).normalize('NFKC').replace(/[^\p{L}\p{N}._-]+/gu, '-').replace(/^-+|-+$/g, '');
  return `${base || 'governance-event'}-details.md`.slice(0, 100);
}

export function maskDiscordUrls(value) {
  return String(value).replace(
    /(?<!\]\()https:\/\/discord\.com\/channels\/\d+\/\d+(?:\/\d+)?/g,
    (url) => `[Discordで開く](${url})`
  );
}

export async function postGazette(guild, governance, heading, body, { summary = null, links = [] } = {}) {
  const channel = await guild.channels.fetch(governance.gazette_channel_id).catch(() => null);
  if (!channel?.isTextBased?.()) return null;
  const full = maskDiscordUrls(body ?? '');
  const compact = maskDiscordUrls(summary ?? gazetteSummary(full));
  const needsAttachment = summary !== null
    ? full.trim() !== compact.trim()
    : full.length > compact.length || full.includes('```');
  const content = [
    `# ${heading}`,
    '',
    compact,
    ...links.map((link) => `- ${maskDiscordUrls(link)}`),
    needsAttachment ? '\n詳細な監査情報は添付ファイルに保存しています。' : null
  ].filter(Boolean).join('\n').slice(0, 1_900);
  return channel.send({
    content,
    files: needsAttachment ? [{ attachment: Buffer.from(full), name: safeGazetteFilename(heading) }] : [],
    allowedMentions: { parse: [] }
  });
}

export async function applyAppealRestriction(guild, governance, userId) {
  const member = await guild.members.fetch(userId);
  if (member.id === guild.ownerId || member.permissions.has(PermissionFlagsBits.Administrator)) {
    throw new Error('Discord owner / Administratorは裁判所限定を保証できません。');
  }
  const role = await guild.roles.fetch(governance.appeal_role_id);
  if (!role || role.position >= guild.members.me.roles.highest.position) throw new Error('上訴中ロールをbotが管理できません。');
  await syncAppealRoleOverwrites(guild, role.id, governance.court_forum_id, { strict: true });
  await member.roles.add(role, `${guild.name} governance appeal restriction`);

  const fallbackChannelIds = [];
  const canSpeakOutsideCourt = (channel) => appealRestrictedChannelAccessible(
    channel,
    member,
    governance.court_forum_id
  );
  const stillAccessible = [...guild.channels.cache.values()].filter(canSpeakOutsideCourt);
  const fallbackTargets = new Map();
  for (const channel of stillAccessible) {
    const target = channel.permissionOverwrites
      ? channel
      : guild.channels.cache.get(channel.parentId);
    if (!target?.permissionOverwrites) {
      await member.roles.remove(role, `${guild.name} governance appeal restriction rollback`).catch(() => {});
      throw new Error(`上訴中の発言先 ${channel.id} を権限で閉じられません。`);
    }
    fallbackTargets.set(target.id, target);
  }
  if (fallbackTargets.size > 100) {
    await member.roles.remove(role, `${guild.name} governance appeal restriction rollback`).catch(() => {});
    throw new Error('上訴中のmember overwriteが100チャンネルを超えるため安全に限定できません。権限設計を修正してください。');
  }
  try {
    for (const channel of fallbackTargets.values()) {
      await channel.permissionOverwrites.edit(member.id, APPEAL_DENY, {
        reason: `${guild.name} governance appeal restriction fallback`
      });
      fallbackChannelIds.push(channel.id);
    }
    const remaining = [...guild.channels.cache.values()].filter(canSpeakOutsideCourt);
    if (remaining.length > 0) {
      throw new Error(`上訴中の発言先を${remaining.length}件閉じられません。`);
    }
  } catch (error) {
    for (const channelId of fallbackChannelIds) {
      const channel = guild.channels.cache.get(channelId);
      await channel?.permissionOverwrites?.delete(userId, `${guild.name} appeal restriction rollback`).catch(() => {});
    }
    await member.roles.remove(role, `${guild.name} governance appeal restriction rollback`).catch(() => {});
    throw error;
  }
  return { fallbackChannelIds };
}

export async function releaseAppealRestriction(guild, governance, userId, fallbackChannelIds = []) {
  const member = await guild.members.fetch(userId).catch(() => null);
  if (member) await member.roles.remove(governance.appeal_role_id, `${guild.name} governance appeal ended`).catch(() => {});
  for (const channelId of fallbackChannelIds) {
    const channel = await guild.channels.fetch(channelId).catch(() => null);
    await channel?.permissionOverwrites?.delete(userId, `${guild.name} governance appeal fallback cleanup`).catch(() => {});
  }
}

export async function executeDiscordSanction(guild, sanction) {
  const member = await guild.members.fetch(sanction.user_id).catch(() => null);
  if (sanction.type === 'kick' && !member) return { type: 'kick', alreadyAbsent: true };
  if (sanction.type === 'warning' && !member) return { type: 'warning', delivered: false };
  if (sanction.type !== 'ban' && !member) throw new Error('対象メンバーがサーバーにいません。');
  if (member && (member.id === guild.ownerId || member.permissions.has(PermissionFlagsBits.Administrator))) {
    throw new Error('Discord owner / Administratorには自動執行できません。');
  }
  const reason = `${guild.name} case C-${sanction.case_id} / sanction ${sanction.id}`;
  if (sanction.type === 'warning') {
    if (!sanction.notice_delivered) {
      await member.send(`${guild.name}の判定により警告を受けました。`).catch(() => {});
    }
    return { type: 'warning' };
  }
  if (sanction.type === 'timeout') {
    if (!member.moderatable) throw new Error('Discord role hierarchyにより対象をtimeoutできません。');
    const credited = sanction.restriction_started_at
      ? Math.max(0, Math.floor((Date.now() - sanction.restriction_started_at) / 1000))
      : 0;
    const remaining = Math.max(0, Number(sanction.duration_seconds) - credited);
    if (remaining === 0) return { type: 'timeout', remainingSeconds: 0, creditedSeconds: credited };
    await member.timeout(remaining * 1000, reason);
    return { type: 'timeout', remainingSeconds: remaining, creditedSeconds: credited };
  }
  if (sanction.type === 'kick') {
    if (!member.kickable) throw new Error('Discord role hierarchyにより対象をkickできません。');
    await member.kick(reason);
    return { type: 'kick' };
  }
  if (sanction.type === 'ban') {
    if (member && !member.bannable) throw new Error('Discord role hierarchyにより対象をbanできません。');
    await guild.members.ban(sanction.user_id, { reason, deleteMessageSeconds: 0 });
    return { type: 'ban' };
  }
  if (sanction.type === 'restriction') return { type: 'restriction' };
  throw new Error(`未対応の制裁です: ${sanction.type}`);
}
