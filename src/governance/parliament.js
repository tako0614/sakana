import {
  countParliamentSessions,
  createProposal,
  getActiveConstitution,
  ensureLegalRecoveryProposal,
  getConstitution,
  getProposal,
  getProposalByForumThread,
  listLaws,
  listProposals,
  recentGovernanceMessages,
  recordInstrumentRelation,
  recordParliamentSession,
  setParliamentSessionMinutes,
  updateGovernanceGuild,
  updateProposal,
  writeAudit
} from './db.js';
import { createAgendaPost, postParliamentMinutes } from './discord.js';
import { discoverWeeklyIssues } from './llm.js';
import { sha256 } from './policy.js';
import { exactActiveProposalMatch } from './relation.js';
import { compileConstitution } from './rules.js';
import { retryPatch } from './service.js';
import { advanceLegislation } from './legislation.js';
import { dispatchInstitutionEvent } from './institutions.js';

const SCAN_WINDOW_MS = 7 * 86_400_000;

function constitutionRules(constitution) {
  return constitution.rules ?? compileConstitution({ content: constitution.content }).rules;
}

function agendaStateName(rules, key = 'law') {
  return rules.workflows[key].initial;
}

// 開会間隔・議題数・自律起案の可否は適用法令が定める。
export function sessionIntervalMilliseconds(constitution) {
  return constitution.policy.legislation.sessionIntervalMilliseconds;
}

export function nextSessionAt(governance, constitution) {
  return Number(governance.last_session_at ?? 0) + sessionIntervalMilliseconds(constitution);
}

function agendaProposals(guildId, rules) {
  return listProposals(guildId, { limit: 200 })
    .filter((proposal) => proposal.workflow_handler && proposal.workflow_handler !== 'terminal')
    .filter((proposal) => !rules.recovery || proposal.source === 'constitutional_repair')
    .sort((left, right) => Number(left.updated_at) - Number(right.updated_at) || Number(left.id) - Number(right.id));
}

async function ensureAgendaPost(guild, governance, proposal) {
  if (proposal.forum_thread_id) return proposal;
  const post = await createAgendaPost(guild, governance, proposal);
  return updateProposal(proposal.id, {
    forum_thread_id: post.threadId,
    forum_message_id: post.messageId,
    retry_after: null,
    failure_count: 0,
    last_error: null
  });
}

// 人間が議会Forumへ立てたスレを議題として取り込む。スレ自体が提案であり、
// 取り込みの時点ではAIは何も判断していない。
async function adoptMemberThreads(guild, governance, constitution, rules, room) {
  if (room <= 0) return [];
  const forum = await guild.channels.fetch(governance.parliament_forum_id).catch(() => null);
  if (!forum?.threads) return [];
  const active = await forum.threads.fetchActive().catch(() => null);
  const threads = [...(active?.threads?.values?.() ?? [])]
    .sort((left, right) => Number(left.createdTimestamp ?? 0) - Number(right.createdTimestamp ?? 0));
  const adopted = [];
  for (const thread of threads) {
    if (adopted.length >= room) break;
    if (thread.locked || thread.archived) continue;
    if (getProposalByForumThread(thread.id)) continue;
    const starter = await thread.fetchStarterMessage().catch(() => null);
    // botが立てた議題は作成時にproposal行を持つ。ここで拾うのは人間のスレだけ。
    if (!starter || starter.author?.bot) continue;
    const summary = String(starter.content ?? '').replace(/\s+/g, ' ').trim();
    if (!summary) continue;
    const created = createProposal({
      guildId: guild.id,
      kind: 'law',
      source: 'member_thread',
      title: String(thread.name ?? '無題').slice(0, 100),
      summary: summary.slice(0, 1800),
      status: agendaStateName(rules, 'law'),
      proposerId: starter.author.id,
      constitutionId: constitution.id,
      voteScope: constitution.policy.voting.defaultScope
    });
    adopted.push(updateProposal(created.id, {
      forum_thread_id: thread.id,
      forum_message_id: starter.id
    }));
    dispatchInstitutionEvent(guild.id, 'petition', { proposalId: created.id, summary }, created.id);
  }
  return adopted;
}

// 公開ログから自分で議題を立てる。人間の提案と同格に扱う。
async function discoverAgenda(guild, governance, constitution, rules, room) {
  if (room <= 0) return [];
  if (!constitution.policy.legislation.logScan) return [];
  const now = Date.now();
  const publicChannelIds = [...guild.channels.cache.values()]
    .filter((channel) => channel.isTextBased?.() && !channel.isThread?.())
    .filter((channel) => ![
      governance.parliament_forum_id, governance.court_forum_id,
      governance.procedure_channel_id, governance.category_id
    ].includes(channel.id) && channel.parentId !== governance.category_id)
    .map((channel) => channel.id);
  if (publicChannelIds.length === 0) return [];
  const messages = recentGovernanceMessages(guild.id, now - SCAN_WINDOW_MS, publicChannelIds, 300)
    .map((row) => ({
      id: row.message_id,
      channelId: row.channel_id,
      content: String(row.content ?? '').slice(0, 500),
      createdAt: row.created_at
    }))
    .filter((row) => row.content);
  if (messages.length === 0) return [];
  const laws = listLaws(guild.id, { activeOnly: true, limit: 100 });
  const { issues } = await discoverWeeklyIssues({
    guildId: guild.id,
    constitution,
    activeLaws: laws,
    messages,
    limit: room
  });
  const openProposals = listProposals(guild.id, { limit: 200 });
  const created = [];
  for (const issue of issues.slice(0, room)) {
    if (exactActiveProposalMatch(issue.title, openProposals)) continue;
    const evidence = issue.evidenceMessageIds
      .map((messageId) => messages.find((row) => row.id === String(messageId)))
      .filter(Boolean)
      .map((row) => `https://discord.com/channels/${guild.id}/${row.channelId}/${row.id}`);
    const proposal = createProposal({
      guildId: guild.id,
      kind: 'law',
      source: 'log_scan',
      title: issue.title.slice(0, 100),
      summary: [issue.summary, evidence.length ? `参照: ${evidence.join(' ')}` : null]
        .filter(Boolean).join('\n').slice(0, 1800),
      status: agendaStateName(rules, 'law'),
      proposerId: null,
      constitutionId: constitution.id,
      voteScope: constitution.policy.voting.defaultScope
    });
    recordInstrumentRelation({
      guildId: guild.id,
      sourceType: 'log_scan',
      sourceId: sha256(`scan:${issue.title}${issue.summary}`),
      relationType: 'new',
      targetType: 'proposal',
      targetId: String(proposal.id),
      reasons: ['公開記録から反復している制度上の問題として議題化しました。']
    });
    created.push(proposal);
  }
  return created;
}

const OUTCOME_LABELS = {
  legislate: '成立',
  pending: '手続進行中',
  reject: '不採択',
  error: '次回へ持ち越し'
};

// 「国会が開かれたこと」は議題スレを個別に見ないと分からなかった。開会ごとに
// 手続の`国会記録`へ1件残し、そこから各議題のスレへ辿れるようにする。
async function publishMinutes(guild, governance, constitution, session) {
  const { sessionId, number, manual, now, outcomes, waiting } = session;
  const nextAt = now + sessionIntervalMilliseconds(constitution);
  const lines = [
    `## 第${number}回 国会`,
    `<t:${Math.floor(now / 1000)}:F>${manual ? '（臨時開会）' : ''}`,
    ''
  ];
  if (!outcomes.length) {
    lines.push('議題はありませんでした。`議会`にスレを立てると、次の国会で扱います。');
  } else {
    for (const outcome of outcomes) {
      const proposal = getProposal(outcome.proposalId);
      const link = proposal?.forum_thread_id
        ? `[${outcome.title}](https://discord.com/channels/${guild.id}/${proposal.forum_thread_id})`
        : outcome.title;
      const label = OUTCOME_LABELS[outcome.decision] ?? outcome.decision;
      const detail = outcome.decision === 'legislate' && outcome.voteEndsAt
        ? `締切 <t:${Math.floor(outcome.voteEndsAt / 1000)}:R>`
        : outcome.decision === 'defer'
          ? `${outcome.deferrals}回目${outcome.drafted ? '・たたき台あり' : ''}`
          : outcome.decision === 'error'
            ? String(outcome.error ?? '').slice(0, 80)
            : '';
      lines.push(`- **${label}** ${link}${detail ? ` — ${detail}` : ''}`);
    }
  }
  if (waiting > 0) lines.push('', `今回入りきらなかった議題: ${waiting}件（次の国会で扱います）`);
  lines.push('', `次の開会: <t:${Math.floor(nextAt / 1000)}:R>（運営者は /governance から臨時に開けます）`);
  try {
    const message = await postParliamentMinutes(guild, governance, lines.join('\n'));
    setParliamentSessionMinutes(sessionId, message.id);
  } catch (error) {
    // 議事録が出せなくても国会の結論そのものは既に確定している。
    console.error('Parliament minutes failed:', error?.message ?? error);
  }
}

async function processAgendaItem(guild, governance, constitution, input) {
  const proposal = await ensureAgendaPost(guild, governance, input);
  if (!constitutionForProposal(proposal).policy.autonomous) {
    const { advanceLegacyLegislation } = await import('./legacy-legislation.js');
    return advanceLegacyLegislation(guild, proposal);
  }
  return advanceLegislation(guild, proposal);
}

function constitutionForProposal(proposal) { return getConstitution(proposal.constitution_id); }

const runningSessions = new Map();
export function runParliamentSession(guild, governance, now = Date.now(), options = {}) {
  if (runningSessions.has(guild.id)) return runningSessions.get(guild.id);
  const task = runSession(guild, governance, now, options).finally(() => runningSessions.delete(guild.id));
  runningSessions.set(guild.id, task);
  return task;
}

async function runSession(guild, governance, now, { manual = false } = {}) {
  const constitution = getActiveConstitution(guild.id);
  if (!constitution) return null;
  if (!manual) {
    if (governance.session_retry_after && governance.session_retry_after > now) return null;
    if (governance.last_session_at && now - governance.last_session_at < sessionIntervalMilliseconds(constitution)) {
      return null;
    }
  }
  const rules = constitutionRules(constitution);
  if (rules.recovery) ensureLegalRecoveryProposal(guild.id, now);
  const limit = constitution.policy.legislation.agendaLimit;
  const carried = agendaProposals(guild.id, rules).filter((item) => !item.retry_after || item.retry_after <= now);
  const room = limit;
  const adopted = rules.recovery ? [] : await adoptMemberThreads(guild, governance, constitution, rules, room);
  const discovered = rules.recovery ? [] : await discoverAgenda(
    guild, governance, constitution, rules, Math.max(0, room - adopted.length)
  );
  const agenda = [...adopted, ...discovered, ...carried].sort((a, b) => Number(a.updated_at) - Number(b.updated_at)).slice(0, limit);
  const waiting = Math.max(0, agendaProposals(guild.id, rules).length - agenda.length);
  const outcomes = [];
  for (const item of agenda) {
    try {
      outcomes.push(await processAgendaItem(guild, governance, constitution, item));
    } catch (error) {
      // 1議題の失敗で国会全体を止めない。その議題だけ次回へ送る。
      const current = getProposal(item.id);
      if (current) updateProposal(current.id, retryPatch(current, error));
      console.error(`Parliament agenda ${item.id} failed:`, error);
      outcomes.push({
        proposalId: item.id,
        title: item.title,
        decision: 'error',
        error: String(error?.message ?? error).slice(0, 300)
      });
    }
  }
  const sessionId = recordParliamentSession({
    guildId: guild.id,
    constitutionId: constitution.id,
    manual,
    agendaCount: agenda.length,
    outcomes,
    startedAt: now
  });
  await publishMinutes(guild, governance, constitution, {
    sessionId, number: countParliamentSessions(guild.id), manual, now, outcomes, waiting
  });
  updateGovernanceGuild(guild.id, {
    last_session_at: now,
    session_retry_after: null,
    session_failure_count: 0,
    session_last_error: null
  });
  writeAudit({
    guildId: guild.id,
    actorType: 'ai',
    action: 'parliament.session',
    targetType: 'guild',
    targetId: guild.id,
    detail: {
      manual,
      agendaCount: agenda.length,
      waiting,
      outcomes: outcomes.map((entry) => ({ proposalId: entry.proposalId, decision: entry.decision }))
    }
  });
  return { agendaCount: agenda.length, waiting, outcomes };
}

export function recordParliamentFailure(guild, governance, error, now = Date.now()) {
  const failures = Number(governance.session_failure_count ?? 0) + 1;
  return updateGovernanceGuild(guild.id, {
    session_failure_count: failures,
    session_retry_after: now + Math.min(3_600_000, 300_000 * (2 ** Math.min(failures - 1, 4))),
    session_last_error: String(error?.message ?? error).slice(0, 500)
  });
}
