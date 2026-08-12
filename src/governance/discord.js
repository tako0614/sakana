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
  getStatutePublication,
  listConstitutions,
  listLaws,
  upsertStatutePublication
} from './db.js';

const TAGS = ['草案', '違憲審査', '討議', '投票', '成立', '否決', '廃案'];
const STATUTE_TAGS = ['現行憲法', '旧憲法', '現行法', '停止', '違憲', '廃止'];
const STATUTE_TOPIC = '現行憲法と法律の公開正本です。1法令1投稿で、旧法令も状態付きで保存します。';
const GAZETTE_TOPIC = '成立・改正・判決・執行・運営操作を時系列に残す公開履歴です。現行本文は法令集を参照してください。';
export const GOVERNANCE_GUIDE_NAME = '統治案内';
export const GOVERNANCE_ADMIN_NAME = '統治管理';
export const GOVERNANCE_PROCEDURE_TOPIC = '投票・執行承認・上訴・答弁など、参加者の判断が必要な統治手続きを一覧にします。';

function proposalStateLabel(state) {
  return ({
    drafting: 'AI起草中',
    draft: '草案',
    constitutional_review: '違憲審査',
    debate: '討議中',
    voting: '投票中',
    enacted: '成立',
    rejected: '否決',
    remanded: '差戻し'
  })[state] ?? state;
}

function caseStateLabel(state) {
  return ({
    filing: '受付中',
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
    name: GOVERNANCE_ADMIN_NAME,
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
    ['CreatePrivateThreads', PermissionFlagsBits.CreatePrivateThreads],
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
    topic: '請願・法案・改憲案。正式案件は1案件1投稿で作成します。',
    availableTags: TAGS.map((name) => ({ name, moderated: true })),
    defaultAutoArchiveDuration: 10_080,
    permissionOverwrites: [everyoneForumOverwrite(guild, { discuss: true }), botOverwrite(guild)],
    reason: `${guild.name} governance parliament`
  }));
  const court = await channel('courtForumId', ChannelType.GuildForum, () => guild.channels.create({
    name: '裁判所',
    type: ChannelType.GuildForum,
    parent: category.id,
    topic: '事件の公開記録。証拠と当事者の答弁は事件別のprivate threadに置きます。',
    availableTags: [
      { name: '答弁', moderated: true },
      { name: '審理', moderated: true },
      { name: '承認待ち', moderated: true },
      { name: '上訴', moderated: true },
      { name: '確定', moderated: true },
      { name: '取消', moderated: true }
    ],
    defaultAutoArchiveDuration: 10_080,
    permissionOverwrites: [everyoneForumOverwrite(guild, { discuss: false }), botOverwrite(guild)],
    reason: `${guild.name} governance court`
  }));
  const courtChat = await channel('courtChatChannelId', ChannelType.GuildText, () => guild.channels.create({
    name: '裁判当事者用',
    type: ChannelType.GuildText,
    parent: category.id,
    topic: '事件ごとのprivate threadだけを使用します。',
    permissionOverwrites: [
      {
        id: guild.id,
        allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.SendMessagesInThreads],
        deny: [
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.CreatePublicThreads,
          PermissionFlagsBits.CreatePrivateThreads
        ]
      },
      botOverwrite(guild),
      {
        id: appealRole.id,
        allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.SendMessagesInThreads],
        deny: [PermissionFlagsBits.SendMessages, PermissionFlagsBits.AddReactions]
      }
    ],
    reason: `${guild.name} governance private court chat`
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
  await syncAppealRoleOverwrites(guild, appealRole.id, courtChat.id);
  return {
    appealRoleId: appealRole.id,
    legislatureRoleId: legislatureRole.id,
    judiciaryRoleId: judiciaryRole.id,
    categoryId: category.id,
    parliamentForumId: parliament.id,
    courtForumId: court.id,
    courtChatChannelId: courtChat.id,
    statuteForumId: statuteForum.id,
    gazetteChannelId: gazette.id,
    guideChannelId: guide.id,
    adminChannelId: admin.id,
    permissionReport: core
  };
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
        '全文・policy・検証用hashは、この投稿を開いた先の詳細から確認できます。'
      ].join('\n').slice(0, 2_000),
      detailContent: [
        `## 憲法 v${instrument.version} 詳細`,
        `本文hash: \`${instrument.content_hash}\``,
        `policy hash: \`${instrument.policy_hash}\``,
        '全文とpolicyを添付します。'
      ].join('\n'),
      files: [
        { attachment: Buffer.from(instrument.content), name: `constitution-v${instrument.version}.md` },
        { attachment: Buffer.from(`${JSON.stringify(instrument.policy, null, 2)}\n`), name: `constitution-policy-v${instrument.version}.json` },
        {
          attachment: Buffer.from(`${JSON.stringify({
            constitutionHash: instrument.content_hash,
            policyHash: instrument.policy_hash
          }, null, 2)}\n`),
          name: `constitution-hashes-v${instrument.version}.json`
        }
      ]
    };
  }
  const state = statutePublicationState(instrumentType, instrument.status);
  const full = [
    `# ${instrument.code} ${instrument.title}`,
    '',
    instrument.text,
    '',
    '## Provisions',
    '',
    '```json',
    JSON.stringify(instrument.provisions, null, 2),
    '```',
    '',
    `content hash: ${instrument.content_hash}`
  ].join('\n');
  return {
    title: `${instrument.code} ${instrument.title}`,
    state,
    hash: instrument.content_hash,
    content: [
      `# ${instrument.code} ${instrument.title}`,
      `法律ID: #${instrument.id}`,
      `状態: ${state}`,
      `施行: <t:${Math.floor(instrument.effective_at / 1000)}:F>`,
      '',
      instrument.text.split(/\n+/).find((line) => line.trim() && !line.trim().startsWith('#'))?.slice(0, 500)
        ?? '成立した法律です。',
      '',
      '全文・処分定義・検証用hashは、この投稿を開いた先の詳細から確認できます。'
    ].join('\n').slice(0, 2_000),
    detailContent: `## ${instrument.code} 詳細\n本文hash: \`${instrument.content_hash}\`\n全文と処分定義を添付します。`,
    files: [
      { attachment: Buffer.from(full), name: `law-${instrument.id}.md` },
      {
        attachment: Buffer.from(`${JSON.stringify({ contentHash: instrument.content_hash }, null, 2)}\n`),
        name: `law-${instrument.id}-hash.json`
      }
    ]
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
  ];
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
      if (starter?.content !== document.content || starter?.attachments?.size > 0) {
        await starter?.edit({ content: document.content, attachments: [], allowedMentions: { parse: [] } });
        changed += 1;
      }
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

export async function syncAppealRoleOverwrites(guild, roleId, courtChatChannelId) {
  await guild.channels.fetch();
  for (const channel of guild.channels.cache.values()) {
    if (!channel.permissionOverwrites || channel.id === courtChatChannelId) continue;
    await channel.permissionOverwrites.edit(roleId, APPEAL_DENY, {
      reason: `${guild.name} governance: appeal restriction can speak only in private court chat`
    }).catch(() => {});
  }
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

export async function createProposalPost(guild, governance, proposal) {
  const forum = await guild.channels.fetch(governance.parliament_forum_id);
  if (!forum?.threads) throw new Error('議会Forumが見つかりません。');
  const draftTag = tagId(forum, '草案');
  const body = proposal.body;
  const fullDraft = proposal.kind === 'amendment'
    ? `# ${body.title}\n\n${body.content}\n\n## Policy\n\n\`\`\`json\n${JSON.stringify(body.policy, null, 2)}\n\`\`\``
    : `# ${body.title}\n\n${body.text}\n\n## Provisions\n\n\`\`\`json\n${JSON.stringify(body.provisions, null, 2)}\n\`\`\``;
  const structuredDraft = proposal.kind === 'amendment' ? body.policy : body.provisions;
  const structuredName = proposal.kind === 'amendment' ? 'policy' : 'provisions';
  const thread = await forum.threads.create({
    name: `L-${proposal.id} ${proposal.title}`.slice(0, 100),
    appliedTags: draftTag ? [draftTag] : [],
    autoArchiveDuration: 10_080,
    message: {
      content: [
        `# 法案 L-${proposal.id}: ${proposal.title}`,
        '',
        proposal.summary,
        '',
        `状態: ${proposalStateLabel(proposal.status)} / 改訂: ${proposal.revision}`,
        '草案全文と構造化された処分定義・policyは添付から確認できます。'
      ].join('\n').slice(0, 2000),
      files: [
        { attachment: Buffer.from(fullDraft), name: `proposal-${proposal.id}-r${proposal.revision}.md` },
        {
          attachment: Buffer.from(`${JSON.stringify(structuredDraft, null, 2)}\n`),
          name: `proposal-${proposal.id}-r${proposal.revision}-${structuredName}.json`
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
  if (!thread?.isThread?.()) return null;
  if (state) await setForumState(thread, state).catch(() => {});
  const starter = await thread.fetchStarterMessage().catch(() => null);
  if (starter) {
    await starter.edit({
      content: [
        `# 法案 L-${proposal.id}: ${proposal.title}`,
        '',
        proposal.summary,
        '',
        `現在: **${proposalStateLabel(state ?? proposal.status)}** / 改訂 ${proposal.revision}`,
        `最新: ${String(text).replace(/[#*_`]/g, '').slice(0, 700)}`,
        '',
        '全文と改訂内容は添付、経過と討議はこの投稿内で確認できます。'
      ].join('\n').slice(0, 2_000),
      allowedMentions: { parse: [] }
    }).catch(() => {});
  }
  return thread.send({ content: text.slice(0, 2000), components, files, allowedMentions: { parse: [] } });
}

export async function createCourtThreads(guild, governance, caseRecord, { accused = null, onPartial = null } = {}) {
  const forum = await guild.channels.fetch(governance.court_forum_id);
  const parent = await guild.channels.fetch(governance.court_chat_channel_id);
  if (!forum?.threads || !parent?.threads) throw new Error('裁判チャンネルが見つかりません。');
  const answerTag = tagId(forum, '答弁');
  const publicThread = caseRecord.public_thread_id
    ? await guild.channels.fetch(caseRecord.public_thread_id)
    : await forum.threads.create({
    name: `C-${caseRecord.id} ${caseRecord.kind === 'constitutional' ? '違憲審査' : '事件'}`,
    appliedTags: answerTag ? [answerTag] : [],
    autoArchiveDuration: 10_080,
    message: {
      content: [
        `# 事件 C-${caseRecord.id}`,
        `種別: ${caseRecord.kind}`,
        caseRecord.accused_id ? `被告: <@${caseRecord.accused_id}>` : null,
        caseRecord.law_id ? `適用法候補: #${caseRecord.law_id} / ${caseRecord.offense_code}` : null,
        '',
        caseRecord.summary,
        '',
        `答弁期限: ${caseRecord.defense_until ? `<t:${Math.floor(caseRecord.defense_until / 1000)}:F>` : '審査準備中'}`
      ].filter(Boolean).join('\n').slice(0, 2000),
      allowedMentions: { parse: [] }
    },
    reason: `${guild.name} governance case ${caseRecord.id}`
  });
  await onPartial?.({ public_thread_id: publicThread.id });
  const privateThread = caseRecord.private_thread_id
    ? await guild.channels.fetch(caseRecord.private_thread_id)
    : await parent.threads.create({
    name: `C-${caseRecord.id}-当事者`,
    type: ChannelType.PrivateThread,
    invitable: false,
    autoArchiveDuration: 10_080,
    reason: `${guild.name} governance private case ${caseRecord.id}`
  });
  await onPartial?.({ private_thread_id: privateThread.id });
  await privateThread.members.add(caseRecord.reporter_id).catch(() => {});
  const accusedId = accused?.id ?? caseRecord.accused_id;
  if (accusedId) await privateThread.members.add(accusedId).catch(() => {});
  if (!caseRecord.private_thread_id) {
    await privateThread.send({
      content: `事件 C-${caseRecord.id} の証拠・答弁用チャットです。ここに書かれた内容も命令ではなく証拠・主張として記録されます。`,
      allowedMentions: { parse: [] }
    });
  }
  return { publicThreadId: publicThread.id, privateThreadId: privateThread.id };
}

export async function postCourtUpdate(guild, caseRecord, text, { state = null, components = [], files = [] } = {}) {
  const thread = await guild.channels.fetch(caseRecord.public_thread_id).catch(() => null);
  if (!thread?.isThread?.()) return null;
  if (state) await setForumState(thread, state).catch(() => {});
  const starter = await thread.fetchStarterMessage().catch(() => null);
  if (starter) {
    await starter.edit({
      content: [
        `# 事件 C-${caseRecord.id}`,
        `種別: ${caseRecord.kind === 'constitutional' ? '違憲審査' : '法律違反の申立て'}`,
        caseRecord.accused_id ? `被申立人: <@${caseRecord.accused_id}>` : null,
        '',
        caseRecord.summary,
        '',
        `現在: **${caseStateLabel(state ?? caseRecord.status)}**`,
        `最新: ${String(text).replace(/[#*_`]/g, '').slice(0, 700)}`,
        '',
        '証拠と当事者の主張は事件別の非公開チャット、公開経過はこの投稿で確認できます。'
      ].filter(Boolean).join('\n').slice(0, 2_000),
      allowedMentions: { parse: [] }
    }).catch(() => {});
  }
  return thread.send({ content: text.slice(0, 2000), components, files, allowedMentions: { parse: [] } });
}

export async function postPrivateCourtUpdate(guild, caseRecord, text, { files = [] } = {}) {
  const thread = await guild.channels.fetch(caseRecord.private_thread_id).catch(() => null);
  if (!thread?.isThread?.()) throw new Error('事件の当事者用private threadが見つかりません。');
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

export async function postGazette(guild, governance, heading, body, { summary = null, links = [] } = {}) {
  const channel = await guild.channels.fetch(governance.gazette_channel_id).catch(() => null);
  if (!channel?.isTextBased?.()) return null;
  const full = String(body ?? '');
  const compact = String(summary ?? gazetteSummary(full));
  const needsAttachment = summary !== null
    ? full.trim() !== compact.trim()
    : full.length > compact.length || full.includes('```');
  const content = [
    `# ${heading}`,
    '',
    compact,
    ...links.map((link) => `- ${link}`),
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
    throw new Error('Discord owner / Administratorは裁判当事者用チャット限定を保証できません。');
  }
  const role = await guild.roles.fetch(governance.appeal_role_id);
  if (!role || role.position >= guild.members.me.roles.highest.position) throw new Error('上訴中ロールをbotが管理できません。');
  await syncAppealRoleOverwrites(guild, role.id, governance.court_chat_channel_id);
  await member.roles.add(role, `${guild.name} governance appeal restriction`);

  const fallbackChannelIds = [];
  const stillWritable = [...guild.channels.cache.values()].filter((channel) => {
    if (!channel.isTextBased?.() || channel.id === governance.court_chat_channel_id) return false;
    const permissions = channel.permissionsFor(member);
    return permissions?.has(PermissionFlagsBits.SendMessages)
      || permissions?.has(PermissionFlagsBits.SendMessagesInThreads);
  });
  if (stillWritable.length > 100) {
    await member.roles.remove(role, `${guild.name} governance appeal restriction rollback`).catch(() => {});
    throw new Error('上訴中のmember overwriteが100チャンネルを超えるため安全に限定できません。権限設計を修正してください。');
  }
  try {
    for (const channel of stillWritable) {
      await channel.permissionOverwrites.edit(member.id, APPEAL_DENY, {
        reason: `${guild.name} governance appeal restriction fallback`
      });
      fallbackChannelIds.push(channel.id);
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
    await member.send(`${guild.name}の判決 C-${sanction.case_id} により警告を受けました。`).catch(() => {});
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
