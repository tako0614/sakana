import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  PermissionFlagsBits
} from 'discord.js';

const TAGS = ['草案', '違憲審査', '討議', '投票', '成立', '否決', '廃案'];

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

function everyoneForumOverwrite(guild, { discuss }) {
  return {
    id: guild.id,
    allow: [PermissionFlagsBits.ViewChannel, ...(discuss ? [PermissionFlagsBits.SendMessagesInThreads] : [])],
    deny: [
      PermissionFlagsBits.SendMessages,
      PermissionFlagsBits.CreatePublicThreads,
      PermissionFlagsBits.CreatePrivateThreads,
      ...(!discuss ? [PermissionFlagsBits.SendMessagesInThreads] : [])
    ]
  };
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

export async function createGovernanceSurfaces(guild) {
  const core = governancePermissionReport(guild);
  const bootstrapRequired = ['ManageChannels', 'ManageRoles', 'ManageThreads', 'ManageMessages'];
  const blocking = core.missing.filter((name) => bootstrapRequired.includes(name));
  if (blocking.length > 0) throw new Error(`初期化に必要なbot権限がありません: ${blocking.join(', ')}`);

  const appealRole = await guild.roles.create({
    name: '上訴中',
    permissions: [],
    mentionable: false,
    hoist: false,
    reason: 'Sakana governance appeal restriction'
  });
  const category = await guild.channels.create({
    name: 'Sakana Governance',
    type: ChannelType.GuildCategory,
    reason: 'Sakana governance bootstrap'
  });
  const parliament = await guild.channels.create({
    name: '議会',
    type: ChannelType.GuildForum,
    parent: category.id,
    topic: '請願・法案・改憲案。正式案件はSakana botが1案件1投稿で作成します。',
    availableTags: TAGS.map((name) => ({ name, moderated: true })),
    defaultAutoArchiveDuration: 10_080,
    permissionOverwrites: [everyoneForumOverwrite(guild, { discuss: true }), botOverwrite(guild)],
    reason: 'Sakana governance parliament'
  });
  const court = await guild.channels.create({
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
    reason: 'Sakana governance court'
  });
  const courtChat = await guild.channels.create({
    name: '裁判チャット',
    type: ChannelType.GuildText,
    parent: category.id,
    topic: '事件ごとのprivate threadだけを使用します。',
    permissionOverwrites: [
      {
        id: guild.id,
        allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessagesInThreads],
        deny: [
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.CreatePublicThreads,
          PermissionFlagsBits.CreatePrivateThreads
        ]
      },
      botOverwrite(guild),
      {
        id: appealRole.id,
        allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessagesInThreads],
        deny: [PermissionFlagsBits.SendMessages, PermissionFlagsBits.AddReactions]
      }
    ],
    reason: 'Sakana governance private court chat'
  });
  const gazette = await guild.channels.create({
    name: '官報',
    type: ChannelType.GuildText,
    parent: category.id,
    topic: '現行憲法・法律・確定判決・執行・技術操作の公開台帳です。',
    permissionOverwrites: [
      {
        id: guild.id,
        allow: [PermissionFlagsBits.ViewChannel],
        deny: [PermissionFlagsBits.SendMessages, PermissionFlagsBits.AddReactions]
      },
      botOverwrite(guild)
    ],
    reason: 'Sakana governance gazette'
  });
  await syncAppealRoleOverwrites(guild, appealRole.id, courtChat.id);
  return {
    appealRoleId: appealRole.id,
    categoryId: category.id,
    parliamentForumId: parliament.id,
    courtForumId: court.id,
    courtChatChannelId: courtChat.id,
    gazetteChannelId: gazette.id,
    permissionReport: core
  };
}

export async function syncAppealRoleOverwrites(guild, roleId, courtChatChannelId) {
  await guild.channels.fetch();
  for (const channel of guild.channels.cache.values()) {
    if (!channel.permissionOverwrites || channel.id === courtChatChannelId) continue;
    await channel.permissionOverwrites.edit(roleId, APPEAL_DENY, {
      reason: 'Sakana governance: appeal restriction can speak only in private court chat'
    }).catch(() => {});
  }
}

function tagId(channel, name) {
  return channel.availableTags?.find((tag) => tag.name === name)?.id ?? null;
}

export async function setForumState(thread, name) {
  const id = tagId(thread.parent, name);
  if (!id) return;
  await thread.setAppliedTags([id], `Sakana governance state: ${name}`);
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
        body?.text ?? body?.content ?? 'AI起草待ち',
        '',
        `状態: ${proposal.status} / 改訂: ${proposal.revision}`
      ].join('\n').slice(0, 2000),
      files: [{ attachment: Buffer.from(fullDraft), name: `proposal-${proposal.id}-r${proposal.revision}.md` }],
      allowedMentions: { parse: [] }
    },
    reason: `Sakana governance proposal ${proposal.id}`
  });
  const starter = await thread.fetchStarterMessage();
  return { threadId: thread.id, messageId: starter?.id ?? thread.id };
}

export async function postProposalUpdate(guild, proposal, text, { state = null, components = [], files = [] } = {}) {
  const thread = await guild.channels.fetch(proposal.forum_thread_id).catch(() => null);
  if (!thread?.isThread?.()) return null;
  if (state) await setForumState(thread, state).catch(() => {});
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
    reason: `Sakana governance case ${caseRecord.id}`
  });
  await onPartial?.({ public_thread_id: publicThread.id });
  const privateThread = caseRecord.private_thread_id
    ? await guild.channels.fetch(caseRecord.private_thread_id)
    : await parent.threads.create({
    name: `C-${caseRecord.id}-当事者`,
    type: ChannelType.PrivateThread,
    invitable: false,
    autoArchiveDuration: 10_080,
    reason: `Sakana governance private case ${caseRecord.id}`
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
  return thread.send({ content: text.slice(0, 2000), components, files, allowedMentions: { parse: [] } });
}

export async function postPrivateCourtUpdate(guild, caseRecord, text, { files = [] } = {}) {
  const thread = await guild.channels.fetch(caseRecord.private_thread_id).catch(() => null);
  if (!thread?.isThread?.()) throw new Error('事件のprivate裁判チャットが見つかりません。');
  return thread.send({ content: text.slice(0, 2000), files, allowedMentions: { parse: [] } });
}

export async function postGazette(guild, governance, heading, body) {
  const channel = await guild.channels.fetch(governance.gazette_channel_id).catch(() => null);
  if (!channel?.isTextBased?.()) return null;
  const chunks = [];
  let rest = `# ${heading}\n\n${body}`;
  while (rest.length > 0) {
    chunks.push(rest.slice(0, 1900));
    rest = rest.slice(1900);
  }
  let first = null;
  for (const chunk of chunks) {
    const message = await channel.send({ content: chunk, allowedMentions: { parse: [] } });
    first ??= message;
  }
  return first;
}

export async function applyAppealRestriction(guild, governance, userId) {
  const member = await guild.members.fetch(userId);
  if (member.id === guild.ownerId || member.permissions.has(PermissionFlagsBits.Administrator)) {
    throw new Error('Discord owner / Administratorは裁判チャット限定を保証できません。');
  }
  const role = await guild.roles.fetch(governance.appeal_role_id);
  if (!role || role.position >= guild.members.me.roles.highest.position) throw new Error('上訴中ロールをbotが管理できません。');
  await syncAppealRoleOverwrites(guild, role.id, governance.court_chat_channel_id);
  await member.roles.add(role, 'Sakana governance appeal restriction');

  const fallbackChannelIds = [];
  const stillWritable = [...guild.channels.cache.values()].filter((channel) => {
    if (!channel.isTextBased?.() || channel.id === governance.court_chat_channel_id) return false;
    const permissions = channel.permissionsFor(member);
    return permissions?.has(PermissionFlagsBits.SendMessages)
      || permissions?.has(PermissionFlagsBits.SendMessagesInThreads);
  });
  if (stillWritable.length > 100) {
    await member.roles.remove(role, 'Sakana governance appeal restriction rollback').catch(() => {});
    throw new Error('上訴中のmember overwriteが100チャンネルを超えるため安全に限定できません。権限設計を修正してください。');
  }
  try {
    for (const channel of stillWritable) {
      await channel.permissionOverwrites.edit(member.id, APPEAL_DENY, {
        reason: 'Sakana governance appeal restriction fallback'
      });
      fallbackChannelIds.push(channel.id);
    }
  } catch (error) {
    for (const channelId of fallbackChannelIds) {
      const channel = guild.channels.cache.get(channelId);
      await channel?.permissionOverwrites?.delete(userId, 'Sakana appeal restriction rollback').catch(() => {});
    }
    await member.roles.remove(role, 'Sakana governance appeal restriction rollback').catch(() => {});
    throw error;
  }
  return { fallbackChannelIds };
}

export async function releaseAppealRestriction(guild, governance, userId, fallbackChannelIds = []) {
  const member = await guild.members.fetch(userId).catch(() => null);
  if (member) await member.roles.remove(governance.appeal_role_id, 'Sakana governance appeal ended').catch(() => {});
  for (const channelId of fallbackChannelIds) {
    const channel = await guild.channels.fetch(channelId).catch(() => null);
    await channel?.permissionOverwrites?.delete(userId, 'Sakana governance appeal fallback cleanup').catch(() => {});
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
  const reason = `Sakana case C-${sanction.case_id} / sanction ${sanction.id}`;
  if (sanction.type === 'warning') {
    await member.send(`Sakanaの判決 C-${sanction.case_id} により警告を受けました。`).catch(() => {});
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
