import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  OverwriteType,
  PermissionFlagsBits
} from 'discord.js';
import { governanceCategoryName } from './config.js';
import {
  getCaseDetention,
  getCaseSanction,
  getConstitution,
  getGovernanceGuild,
  getLaw,
  listCases,
  listProposals,
  updateGovernanceGuild
} from './db.js';

const PARLIAMENT_TAGS = ['議題', '議論中', '投票中', '成立', '不成立'];
const PARLIAMENT_TOPIC = '作りたい法律や直したい制度をここへ投稿します。定期的に開く国会がすべての投稿を議題として読みます。';
const COURT_TAGS = ['回答待ち', '判断中', '処分中', '処分確定', '取消', '責任なし', '棄却', '合憲', '違憲', '判断不能'];
export const COURT_TOPIC = '警察の処分が争われた事件と、警察が実行できない処分の事件だけを審理します。答弁・証拠・上訴も同じ投稿で扱います。';
export const GOVERNANCE_PROCEDURE_NAME = '手続';
export const GOVERNANCE_PROCEDURE_TOPIC = 'いま投票・執行承認できる案件だけを表示します。本文と議論は議会・裁判所にあります。';

function proposalHandler(proposal) {
  if (proposal.workflow_handler) return proposal.workflow_handler;
  const constitution = getConstitution(proposal.constitution_id);
  const workflow = constitution?.rules?.workflows?.[proposal.kind === 'amendment' ? 'constitutionalAmendment' : 'law'];
  return workflow?.states?.[proposal.status]?.handler ?? null;
}

function proposalStateLabel(state, handler = null) {
  if (PARLIAMENT_TAGS.includes(state)) return state;
  return ({
    agenda: '議題',
    voting: '投票中',
    enacted: '成立',
    rejected: '不成立'
  })[state] ?? ({
    parliament_agenda: '議題',
    public_vote: '投票中',
    terminal: '不成立'
  })[handler] ?? '議題';
}

function caseStateLabel(state) {
  return ({
    filing: '回答待ち',
    police_review: '警察が確認中',
    contest_window: '処分中・不服申立て可',
    defense: '回答待ち',
    deliberation: '判断中',
    approval: '判断中',
    appeal_window: '回答待ち',
    appeal: '判断中',
    execution: '判断中',
    final: '処分確定',
    overturned: '取消',
    acquitted: '責任なし',
    dismissed: '棄却',
    constitutional_uncertain: '判断不能',
    unenforceable: '判断不能'
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
  const detention = getCaseDetention(caseRecord.id);
  if (detention?.status === 'active' && detention.ends_at > Date.now()) {
    return `拘留中（<t:${Math.floor(detention.ends_at / 1000)}:R>まで）。この事件記録では発言できます`;
  }
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
  if (caseRecord.procedure_version === 2 && caseRecord.status === 'defense') {
    return '全員閲覧可・当事者はボタンから回答';
  }
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

// 警察の処分の公開先。裁判所は争われた事件だけを扱うので、ここが取締りの記録になる。
export async function ensureGovernanceEnforcementThread(guild, governance, procedureMessage = null) {
  let thread = governance.enforcement_thread_id
    ? await guild.channels.fetch(governance.enforcement_thread_id).catch(() => null)
    : null;
  if (thread?.isThread?.()) return thread;
  const channel = await guild.channels.fetch(governance.procedure_channel_id).catch(() => null);
  if (!channel?.isTextBased?.()) throw new Error('手続channelが見つかりません。');
  const starter = procedureMessage
    ?? await channel.messages.fetch(governance.procedure_message_id).catch(() => null);
  if (!starter) throw new Error('手続の案内messageが見つかりません。');
  thread = await channel.threads.create({
    name: '執行記録',
    autoArchiveDuration: 10_080,
    reason: `${guild.name} governance enforcement log`
  });
  updateGovernanceGuild(guild.id, { enforcement_thread_id: thread.id });
  return thread;
}

export async function postEnforcementRecord(guild, governance, text, { files = [], components = [] } = {}) {
  const thread = await ensureGovernanceEnforcementThread(guild, governance);
  return thread.send({
    content: String(text).slice(0, 2000),
    files,
    components,
    allowedMentions: { parse: [] }
  });
}

export async function ensureGovernanceOperationsThread(guild, governance, procedureMessage = null) {
  let thread = governance.operations_thread_id
    ? await guild.channels.fetch(governance.operations_thread_id).catch(() => null)
    : null;
  if (!thread?.isThread?.()) {
    const channel = await guild.channels.fetch(governance.procedure_channel_id).catch(() => null);
    if (!channel?.isTextBased?.()) throw new Error('手続channelが見つかりません。');
    const starter = procedureMessage
      ?? await channel.messages.fetch(governance.procedure_message_id).catch(() => null);
    if (!starter) throw new Error('手続の案内messageが見つかりません。');
    thread = starter.thread ?? await guild.channels.fetch(starter.id).catch(() => null);
    if (!thread?.isThread?.()) {
      thread = await starter.startThread({
        name: '運営変更',
        autoArchiveDuration: 10_080,
        reason: `${guild.name} governance authority history`
      });
    }
    updateGovernanceGuild(guild.id, { operations_thread_id: thread.id });
  }
  if (thread.name !== '運営変更') await thread.setName('運営変更', '公開する権限変更の名称を同期');
  return thread;
}

export function authorityChangeContent(heading, body) {
  return [`**${oneLine(heading, 120)}**`, oneLine(body, 1_600)].filter(Boolean).join('\n');
}

export async function postAuthorityChange(guild, governance, heading, body) {
  const current = getGovernanceGuild(guild.id) ?? governance;
  const thread = await ensureGovernanceOperationsThread(guild, current);
  if (thread.archived) await thread.setArchived(false, '運営変更を記録');
  return thread.send({
    content: authorityChangeContent(heading, body),
    allowedMentions: { parse: [] }
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
  // 立法の入口はForumへの投稿になったので、mention roleは裁判だけ維持する。
  let judiciary = governance.judiciary_role_id
    ? guild.roles.cache.get(governance.judiciary_role_id)
    : null;
  if (!judiciary) judiciary = await createMentionRole(guild, '通報');
  if (!judiciary.mentionable) await judiciary.setMentionable(true, 'Governance address roles must be mentionable');
  if (!guild.members.me.roles.cache.has(judiciary.id)) {
    await guild.members.me.roles.add(judiciary, 'Restore governance conversational address');
  }
  return { judiciaryRoleId: judiciary.id };
}

export function governancePermissionReport(guild) {
  const me = guild.members.me;
  const required = [
    ['ManageChannels', PermissionFlagsBits.ManageChannels],
    ['ManageRoles', PermissionFlagsBits.ManageRoles],
    ['ManageThreads', PermissionFlagsBits.ManageThreads],
    ['ManageMessages', PermissionFlagsBits.ManageMessages],
    ['MentionEveryone', PermissionFlagsBits.MentionEveryone],
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

  let state = {
    ...resources,
    procedureChannelId: resources.procedureChannelId ?? resources.adminChannelId ?? ''
  };
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
  const judiciaryRole = await role('judiciaryRoleId', () => createMentionRole(guild, '通報', { assignToBot: false }));
  if (!guild.members.me.roles.cache.has(judiciaryRole.id)) {
    await guild.members.me.roles.add(judiciaryRole, 'Restore governance conversational address during setup');
  }
  const category = await channel('categoryId', ChannelType.GuildCategory, () => guild.channels.create({
    name: governanceCategoryName(guild.name),
    type: ChannelType.GuildCategory,
    reason: `${guild.name} governance bootstrap`
  }));
  const parliament = await channel('parliamentForumId', ChannelType.GuildForum, () => guild.channels.create({
    name: '議会',
    type: ChannelType.GuildForum,
    parent: category.id,
    topic: PARLIAMENT_TOPIC,
    availableTags: PARLIAMENT_TAGS.map((name) => ({ name, moderated: true })),
    defaultAutoArchiveDuration: 10_080,
    permissionOverwrites: [everyoneForumOverwrite(guild, { discuss: true }), botOverwrite(guild)],
    reason: `${guild.name} governance parliament`
  }));
  const court = await channel('courtForumId', ChannelType.GuildForum, () => guild.channels.create({
    name: '裁判所',
    type: ChannelType.GuildForum,
    parent: category.id,
    topic: COURT_TOPIC,
    availableTags: COURT_TAGS.map((name) => ({ name, moderated: true })),
    defaultAutoArchiveDuration: 10_080,
    permissionOverwrites: courtForumOverwrites(guild),
    reason: `${guild.name} governance court`
  }));
  const procedure = await channel('procedureChannelId', ChannelType.GuildText, () => createGovernanceProcedureChannel(guild, category.id));
  if (state.courtChatChannelId && state.courtChatChannelId !== court.id) {
    const legacy = await guild.channels.fetch(state.courtChatChannelId).catch(() => null);
    await retireLegacyCourtChat(legacy, guild.name);
  }
  state = { ...state, courtChatChannelId: court.id };
  await onProgress?.(state);
  await syncAppealRoleOverwrites(guild, appealRole.id, court.id);
  return {
    appealRoleId: appealRole.id,
    judiciaryRoleId: judiciaryRole.id,
    categoryId: category.id,
    parliamentForumId: parliament.id,
    courtForumId: court.id,
    // DB互換用の旧column。公開裁判所Forumと同じIDを保存し、別channelは作らない。
    courtChatChannelId: court.id,
    procedureChannelId: procedure.id,
    legacyGuideChannelId: resources.guideChannelId ?? '',
    legacyGazetteChannelId: resources.gazetteChannelId ?? '',
    permissionReport: core
  };
}

export async function ensureGovernanceParliamentForum(guild, governance) {
  const forum = await guild.channels.fetch(governance.parliament_forum_id).catch(() => null);
  if (!forum || forum.type !== ChannelType.GuildForum) throw new Error('議会Forumが見つかりません。');
  if (forum.topic !== PARLIAMENT_TOPIC) await forum.setTopic(PARLIAMENT_TOPIC, '議会の説明を同期');
  const tags = PARLIAMENT_TAGS.map((name) => {
    const existing = forum.availableTags.find((tag) => tag.name === name);
    return existing ? { id: existing.id, name, moderated: true, emoji: existing.emoji } : { name, moderated: true };
  });
  if (JSON.stringify(forum.availableTags.map((tag) => tag.name)) !== JSON.stringify(PARLIAMENT_TAGS)) {
    await forum.setAvailableTags(tags, '議会の公開状態を簡潔に同期');
  }
  return forum;
}

export async function ensureGovernanceCourtForum(guild, governance) {
  const forum = await guild.channels.fetch(governance.court_forum_id).catch(() => null);
  if (!forum || forum.type !== ChannelType.GuildForum) throw new Error('裁判所Forumが見つかりません。');
  if (forum.topic !== COURT_TOPIC) await forum.setTopic(COURT_TOPIC, '裁判所を公開審理へ同期');
  const tags = COURT_TAGS.map((name) => {
    const existing = forum.availableTags.find((tag) => tag.name === name);
    return existing ? { id: existing.id, name, moderated: true, emoji: existing.emoji } : { name, moderated: true };
  });
  if (JSON.stringify(forum.availableTags.map((tag) => tag.name)) !== JSON.stringify(COURT_TAGS)) {
    await forum.setAvailableTags(tags, '裁判所の公開状態を簡潔に同期');
  }
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

export function contestButtons(guildId, sanctionId, disabled = false) {
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`gov:contest:${guildId}:${sanctionId}`)
      .setLabel('裁判所の審理を求める')
      .setStyle(ButtonStyle.Primary)
      .setDisabled(disabled)
  )];
}

function proposalNextAction(proposal) {
  const byStatus = ({
    agenda: 'この投稿で討論できます。次の国会が読みます。',
    voting: '「手続」の案件カードから投票できます。',
    enacted: '成立しました。現行本文は法令集にあります。',
    rejected: '成立しませんでした。'
  })[proposal.status];
  if (byStatus) return byStatus;
  return ({
    parliament_agenda: 'この投稿で討論できます。次の国会が読みます。',
    public_vote: '「手続」の案件カードから投票できます。',
    terminal: '結論が確定しました。'
  })[proposalHandler(proposal)] ?? 'この投稿で経過を確認できます。';
}

function proposalStarterContent(proposal, nextAction = proposalNextAction(proposal), displayState = proposal.status) {
  const governance = getGovernanceGuild(proposal.guild_id);
  const voting = proposalHandler(proposal) === 'public_vote';
  const deferrals = Number(proposal.deferrals ?? 0);
  return [
    `# ${proposal.title}`,
    '',
    proposal.summary,
    '',
    `状態: **${proposalStateLabel(displayState, proposalHandler(proposal))}**`,
    deferrals > 0 ? `継続審議: ${deferrals}回` : null,
    proposalDeadline(proposal) ? `期限: ${proposalDeadline(proposal)}` : null,
    `いま必要なこと: ${oneLine(nextAction)}`,
    voting && governance?.procedure_channel_id
      ? `[手続で投票](https://discord.com/channels/${proposal.guild_id}/${governance.procedure_channel_id})`
      : null,
    '討論、国会の判断、結論はこの投稿にまとまります。'
  ].filter(Boolean).join('\n').slice(0, 2_000);
}

function courtNextAction(caseRecord) {
  return ({
    filing: '裁判所の準備中です。',
    police_review: '警察が成立法に照らして確認しています。',
    contest_window: '被処分者は下のボタンから裁判所の審理を求められます。',
    defense: '当事者は下のボタンから回答します。',
    deliberation: '回答を締め切り、判断しています。',
    approval: '特別有権者は「手続」の案件カードから承認します。',
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

export function courtPublicState(caseRecord, displayState = caseRecord.status) {
  if (caseRecord.kind === 'constitutional') {
    const verdict = caseRecord.verdict?.verdict;
    if (verdict === 'constitutional') return '合憲';
    if (verdict === 'unconstitutional') return '違憲';
    if (verdict === 'uncertain' || displayState === 'constitutional_uncertain') return '判断不能';
  }
  return caseStateLabel(displayState);
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
    `状態: **${courtPublicState(caseRecord, displayState)}**`,
    `発言状態: ${courtAccessState(caseRecord)}`,
    courtDeadline(caseRecord) ? `期限: <t:${Math.floor(courtDeadline(caseRecord) / 1000)}:F>` : null,
    `いま必要なこと: ${oneLine(nextAction)}`,
    caseRecord.status === 'approval' && governance?.procedure_channel_id
      ? `[手続で執行承認](https://discord.com/channels/${caseRecord.guild_id}/${governance.procedure_channel_id})`
      : null,
    '答弁、証拠、判断、上訴はこの投稿にまとまります。'
  ].filter(Boolean).join('\n').slice(0, 2_000);
}

// 公開ログから国会が自分で立てた議題。人間が立てたスレと同じ扱いで討論に開く。
export async function createAgendaPost(guild, governance, proposal) {
  const forum = await guild.channels.fetch(governance.parliament_forum_id);
  if (!forum?.threads) throw new Error('議会Forumが見つかりません。');
  const stageTag = tagId(forum, proposalStateLabel(proposal.status, 'parliament_agenda'));
  const thread = await forum.threads.create({
    name: proposal.title.slice(0, 100),
    appliedTags: stageTag ? [stageTag] : [],
    autoArchiveDuration: 10_080,
    message: {
      content: proposalStarterContent(proposal),
      allowedMentions: { parse: [] }
    },
    reason: `${guild.name} governance agenda ${proposal.id}`
  });
  const starter = await thread.fetchStarterMessage();
  return { threadId: thread.id, messageId: starter?.id ?? thread.id };
}

export async function postProposalUpdate(guild, proposal, text, { state = null, components = [], files = [] } = {}) {
  const thread = await guild.channels.fetch(proposal.forum_thread_id).catch(() => null);
  if (!thread?.isThread?.()) throw new Error('議会の案件投稿が見つかりません。公開記録なしでは手続を進められません。');
  const publicState = proposalForumState(proposal);
  if (state && publicState) await setForumState(thread, publicState).catch(() => {});
  const starter = await thread.fetchStarterMessage().catch(() => null);
  if (starter) {
    await starter.edit({
      content: proposalStarterContent(proposal, text, publicState ?? proposal.status),
      allowedMentions: { parse: [] }
    }).catch(() => {});
  }
  const message = await thread.send({
    content: text.slice(0, 2000),
    components: withoutDecisionRows(components, ['vote']),
    files,
    allowedMentions: { parse: [] }
  });
  if (proposalClosed(proposal)) await closeRecordThread(thread);
  return message;
}

export async function createCourtCaseThread(guild, governance, caseRecord, { onPartial = null } = {}) {
  const forum = await guild.channels.fetch(governance.court_forum_id);
  if (!forum?.threads) throw new Error('裁判所Forumが見つかりません。');
  const answerTag = tagId(forum, courtPublicState(caseRecord));
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
  const publicState = courtPublicState(caseRecord);
  if (state && publicState) await setForumState(thread, publicState).catch(() => {});
  const starter = await thread.fetchStarterMessage().catch(() => null);
  if (starter) {
    await starter.edit({
      content: courtStarterContent(caseRecord, text, publicState),
      components: courtActionButtons(caseRecord),
      allowedMentions: { parse: [] }
    }).catch(() => {});
  }
  const message = await thread.send({
    content: text.slice(0, 2000),
    components: withoutDecisionRows(components, ['approve']),
    files,
    allowedMentions: { parse: [] }
  });
  if (caseClosed(caseRecord)) await closeRecordThread(thread);
  return message;
}

function proposalForumState(proposal) {
  if (proposal.workflow_status === 'queued') return '待機';
  return proposalStateLabel(proposal.status, proposalHandler(proposal));
}

function courtForumState(caseRecord) {
  return courtPublicState(caseRecord);
}

function proposalClosed(proposal) {
  return proposalHandler(proposal) === 'terminal'
    || ['enacted', 'rejected', 'remanded'].includes(proposal.status);
}

function caseClosed(caseRecord) {
  return ['final', 'overturned', 'acquitted', 'dismissed', 'constitutional_uncertain', 'unenforceable']
    .includes(caseRecord.status);
}

async function closeRecordThread(thread) {
  if (!thread.locked) await thread.setLocked(true, '統治手続が完了したため記録を確定');
  if (!thread.archived) await thread.setArchived(true, '統治手続が完了したため記録を保管');
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

async function syncRecordThread(thread, { name, content, components, state, removeActions = [], closed = false }) {
  const wasArchived = Boolean(thread.archived);
  if (wasArchived) await thread.setArchived(false, '公開表示を同期');
  if (thread.name !== name) await thread.setName(name, '内部番号を使わない表示へ同期');
  const starter = await thread.fetchStarterMessage().catch(() => null);
  if (starter) await starter.edit({ content, components, allowedMentions: { parse: [] } });
  if (removeActions.length) await removeOldDecisionRows(thread, removeActions);
  if (state) await setForumState(thread, state);
  if (closed) await closeRecordThread(thread);
  else if (wasArchived) await thread.setArchived(true, '公開表示の同期完了');
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
        removeActions: ['vote'],
        closed: proposalClosed(proposal)
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
        state: courtForumState(caseRecord),
        removeActions: ['approve'],
        closed: caseClosed(caseRecord)
      });
      changed += 1;
    } catch (error) {
      failures.push(`case ${caseRecord.id}: ${error?.message ?? error}`);
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
  // 警察の処分に不服がある間は、事件記録からも直接争えるようにする。
  if (caseRecord.status === 'contest_window') {
    const sanction = getCaseSanction(caseRecord.id);
    return sanction
      ? [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`gov:contest:${caseRecord.guild_id}:${sanction.id}`)
          .setLabel('裁判所の審理を求める').setStyle(ButtonStyle.Primary)
      )]
      : [];
  }
  if (!['defense', 'appeal'].includes(caseRecord.status)) return [];
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`gov:court:${caseRecord.id}:answer`).setLabel('回答を書く').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`gov:court:${caseRecord.id}:evidence`).setLabel('証拠を出す').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`gov:court:${caseRecord.id}:complete`).setLabel('回答完了').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`gov:court:${caseRecord.id}:withdraw`).setLabel('取り下げる').setStyle(ButtonStyle.Danger)
  )];
}

export async function postCourtRecord(guild, caseRecord, text, { files = [] } = {}) {
  const thread = await guild.channels.fetch(caseRecord.public_thread_id).catch(() => null);
  if (!thread?.isThread?.()) throw new Error('裁判所の事件投稿が見つかりません。');
  return thread.send({ content: text.slice(0, 2000), files, allowedMentions: { parse: [] } });
}

export function maskDiscordUrls(value) {
  return String(value).replace(
    /(?<!\]\()https:\/\/discord\.com\/channels\/\d+\/\d+(?:\/\d+)?/g,
    (url) => `[Discordで開く](${url})`
  );
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
