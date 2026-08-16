import {
  createProposal,
  getActiveConstitution,
  getConstitution,
  getCurrentLawVersion,
  getLaw,
  getProposal,
  getProposalByForumThread,
  listLaws,
  listProposalDeliberations,
  listProposals,
  recentGovernanceMessages,
  recordInstrumentRelation,
  recordParliamentSession,
  recordProposalDeliberation,
  setProposalKind,
  threadDiscussion,
  updateGovernanceGuild,
  updateProposal,
  writeAudit
} from './db.js';
import { createAgendaPost, postProposalUpdate } from './discord.js';
import {
  deliberateAgendaItem,
  discoverWeeklyIssues,
  draftAmendment,
  draftBill,
  runConstitutionalPanel
} from './llm.js';
import { sha256 } from './policy.js';
import { buildLegislativeCandidates, exactActiveProposalMatch } from './relation.js';
import { compileConstitution, governanceRulesSummary } from './rules.js';
import { openProposalVote, publicPanelOutputs, retryPatch } from './service.js';

const AGENDA_DISCUSSION_LIMIT = 300;
const SCAN_WINDOW_MS = 7 * 86_400_000;

function constitutionRules(constitution) {
  return constitution.rules ?? compileConstitution({ content: constitution.content }).rules;
}

function agendaStateName(rules, key = 'law') {
  return rules.workflows[key].initial;
}

// 開会間隔・議題数・自律起案の可否は運営が変えられない。改憲でだけ動く。
export function sessionIntervalMilliseconds(constitution) {
  return constitution.policy.legislation.sessionIntervalMilliseconds;
}

export function nextSessionAt(governance, constitution) {
  return Number(governance.last_session_at ?? 0) + sessionIntervalMilliseconds(constitution);
}

function agendaProposals(guildId, rules) {
  const states = new Set([agendaStateName(rules, 'law'), agendaStateName(rules, 'constitutionalAmendment')]);
  return listProposals(guildId, { limit: 200 })
    .filter((proposal) => states.has(proposal.status))
    .sort((left, right) => Number(left.id) - Number(right.id));
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

function decisionSummary(decision) {
  return {
    decision: decision.decision,
    relation: decision.relation,
    targetType: decision.targetType,
    targetId: decision.targetId,
    question: decision.question,
    reasons: decision.reasons,
    supportingSeats: decision.supportingSeats,
    required: decision.required,
    seats: decision.seats,
    failedSeats: decision.failedSeats
  };
}

function decisionFile(proposal, decision, extra = {}) {
  return {
    attachment: Buffer.from(`${JSON.stringify({
      agenda: { title: proposal.title, deferrals: Number(proposal.deferrals ?? 0) },
      ...decisionSummary(decision),
      ...extra,
      outputs: decision.outputs
    }, null, 2)}\n`),
    name: '国会の合議.json'
  };
}

async function deferAgendaItem(guild, proposal, decision, extra = {}) {
  const deferrals = Number(proposal.deferrals ?? 0) + 1;
  const updated = updateProposal(proposal.id, {
    deferrals,
    stage_started_at: Date.now(),
    retry_after: null,
    failure_count: 0,
    last_error: null
  });
  await postProposalUpdate(guild, updated, [
    `## 継続審議 (${deferrals}回目)`,
    '国会は今回この議題の結論を出しませんでした。次の国会まで、このスレで討論できます。',
    decision.question ? `\n**聞きたいこと**: ${decision.question}` : null,
    decision.reasons.length ? `\n理由:\n${decision.reasons.map((line) => `- ${line}`).join('\n')}` : null
  ].filter(Boolean).join('\n'), { state: '議論中', files: [decisionFile(proposal, decision, extra)] });
  return { proposalId: proposal.id, title: proposal.title, decision: 'defer', deferrals };
}

async function rejectAgendaItem(guild, proposal, decision) {
  const updated = updateProposal(proposal.id, {
    status: 'rejected',
    stage_ends_at: null,
    retry_after: null,
    failure_count: 0,
    last_error: null
  });
  await postProposalUpdate(guild, updated, [
    '## 不採択',
    '国会はこの議題を法律にしないと決めました。',
    decision.reasons.length ? `\n理由:\n${decision.reasons.map((line) => `- ${line}`).join('\n')}` : null
  ].filter(Boolean).join('\n'), { state: '不成立', files: [decisionFile(proposal, decision)] });
  return { proposalId: proposal.id, title: proposal.title, decision: 'reject' };
}

async function legislateAgendaItem(guild, governance, constitution, proposal, decision) {
  const amendment = decision.relation === 'amend_constitution';
  let current = amendment && proposal.kind !== 'amendment'
    ? setProposalKind(proposal.id, 'amendment')
    : proposal;
  const laws = listLaws(guild.id, { activeOnly: true, limit: 200 });
  let amendmentTarget = null;
  if (decision.relation === 'amend_law') {
    // 合議中に別の版が成立している場合があるので、起草は必ず現行版を基礎にする。
    const target = getCurrentLawVersion(decision.targetId);
    if (!target) throw new Error('改正対象の法律が現在有効ではありません。');
    amendmentTarget = target;
  }
  const body = amendment
    ? await draftAmendment({
      guildId: guild.id,
      request: {
        title: current.title,
        summary: current.summary,
        instruction: decision.instruction
      },
      constitution
    })
    : await draftBill({
      guildId: guild.id,
      petition: {
        title: current.title,
        summary: current.summary,
        instruction: decision.instruction,
        ...(amendmentTarget ? {
          amendmentTarget: {
            id: amendmentTarget.id,
            code: amendmentTarget.code,
            title: amendmentTarget.title,
            text: amendmentTarget.text,
            provisions: amendmentTarget.provisions
          }
        } : {})
      },
      constitution,
      activeLaws: laws,
      policy: constitution.policy
    });
  // 事前違憲審査の段階は廃止したが、憲法適合性は国会の中で必ず確認する。
  const review = await runConstitutionalPanel({
    guildId: guild.id,
    targetType: amendment ? 'amendment' : 'law',
    targetId: current.id,
    phase: 'pre',
    constitution,
    target: body
  });
  const constitutional = review.outputs.filter((output) => output.verdict === 'constitutional').length;
  const objected = amendment && review.outputs.some((output) => output.verdict === 'unconstitutional');
  const reviewSummary = {
    constitutionalReview: {
      constitutional,
      required: constitution.policy.judiciary.constitutionalVotesRequired,
      seats: constitution.policy.judiciary.panelSeats,
      outputs: publicPanelOutputs(review.outputs)
    }
  };
  if (objected || constitutional < constitution.policy.judiciary.constitutionalVotesRequired) {
    const concerns = review.outputs
      .filter((output) => output.verdict !== 'constitutional')
      .flatMap((output) => output.reasons ?? [])
      .slice(0, 5);
    return deferAgendaItem(guild, current, {
      ...decision,
      decision: 'defer',
      question: '憲法に適合する形へ直せるかどうか、意見を聞かせてください。',
      reasons: [
        `条文案の憲法適合を確認できませんでした (合憲 ${constitutional}/${constitution.policy.judiciary.panelSeats})。`,
        ...concerns
      ]
    }, reviewSummary);
  }
  current = updateProposal(current.id, {
    title: body.title.slice(0, 100),
    summary: body.summary.slice(0, 1800),
    body,
    relation_type: decision.relation,
    target_type: amendment ? 'constitution' : (amendmentTarget ? 'law' : null),
    target_id: amendment ? String(constitution.id) : (amendmentTarget ? String(amendmentTarget.id) : null),
    target_hash: amendment ? constitution.content_hash : (amendmentTarget ? amendmentTarget.content_hash : null),
    retry_after: null,
    failure_count: 0,
    last_error: null
  });
  const fullDraft = amendment
    ? `# ${body.title}\n\n${body.content}\n\n実行手続: ${governanceRulesSummary(body.rules)}`
    : `# ${body.title}\n\n${body.text}\n\n## Provisions\n\n\`\`\`json\n${JSON.stringify(body.provisions, null, 2)}\n\`\`\``;
  const structured = amendment ? body.rules : body.provisions;
  await postProposalUpdate(guild, current, [
    '## 国会が条文をまとめました',
    amendment ? '憲法改正案として投票にかけます。' : '法律案として投票にかけます。',
    decision.reasons.length ? `\n理由:\n${decision.reasons.map((line) => `- ${line}`).join('\n')}` : null,
    `\n合憲 ${constitutional}/${constitution.policy.judiciary.panelSeats}`
  ].filter(Boolean).join('\n'), {
    files: [
      decisionFile(current, decision, reviewSummary),
      { attachment: Buffer.from(fullDraft), name: amendment ? '改正案全文.md' : '法律案全文.md' },
      {
        attachment: Buffer.from(`${JSON.stringify(structured, null, 2)}\n`),
        name: amendment ? '憲法実行規則.json' : '執行定義.json'
      }
    ]
  });
  const voting = await openProposalVote(guild, getProposal(current.id));
  return {
    proposalId: current.id,
    title: current.title,
    decision: 'legislate',
    kind: current.kind,
    voteEndsAt: voting.stage_ends_at
  };
}

async function processAgendaItem(guild, governance, constitution, input) {
  const rules = constitutionRules(constitution);
  let proposal = await ensureAgendaPost(guild, governance, input);
  const maximumDeferrals = constitution.policy.legislation.maximumDeferrals;
  const allowDefer = Number(proposal.deferrals ?? 0) < maximumDeferrals;
  const discussion = threadDiscussion(
    guild.id, proposal.forum_thread_id, Number(proposal.created_at ?? 0), AGENDA_DISCUSSION_LIMIT
  ).map((row) => ({ authorId: row.user_id, content: String(row.content).slice(0, 800), occurredAt: row.created_at }));
  const laws = listLaws(guild.id, { activeOnly: false, limit: 200 });
  const activeLaws = laws.filter((law) => law.status === 'active');
  const candidates = buildLegislativeCandidates({
    request: `${proposal.title}\n${proposal.summary}`,
    normalized: { title: proposal.title, summary: proposal.summary, intent: 'amendment' },
    proposals: [],
    laws,
    constitution
  });
  const otherOpenAgenda = listProposals(guild.id, { limit: 100 })
    .filter((entry) => Number(entry.id) !== Number(proposal.id)
      && entry.workflow_handler
      && entry.workflow_handler !== 'terminal')
    .slice(0, 10)
    .map((entry) => ({ title: entry.title, summary: entry.summary.slice(0, 400), status: entry.status }));
  const previousSessions = listProposalDeliberations(proposal.id)
    .slice(-3)
    .map((entry) => ({
      outcome: entry.outcome,
      question: entry.decision?.question ?? null,
      reasons: entry.decision?.reasons ?? []
    }));
  const decision = await deliberateAgendaItem({
    guildId: guild.id,
    agenda: {
      title: proposal.title,
      summary: proposal.summary,
      kind: proposal.kind,
      origin: proposal.source,
      deferrals: Number(proposal.deferrals ?? 0)
    },
    discussion,
    previousSessions,
    otherOpenAgenda,
    constitution,
    activeLaws,
    candidates,
    panel: rules.panels.parliament,
    allowDefer
  });
  // AI席が必要数そろわないのは政治的な結論ではない。継続審議の回数を消費させず、
  // 次の国会でもう一度かける。
  if (decision.outputs.length < decision.required) {
    throw new Error(`独立したAI席が必要数 ${decision.required}/${decision.seats} そろわなかったため、この議題は次の国会へ送ります。`);
  }
  recordProposalDeliberation({
    proposalId: proposal.id,
    revision: proposal.revision,
    outcome: decision.decision,
    discussion,
    decision: decisionSummary(decision)
  });
  if (decision.decision === 'reject') return rejectAgendaItem(guild, proposal, decision);
  if (decision.decision === 'defer') return deferAgendaItem(guild, proposal, decision);
  return legislateAgendaItem(guild, governance, constitution, proposal, decision);
}

export async function runParliamentSession(guild, governance, now = Date.now(), { manual = false } = {}) {
  const constitution = getActiveConstitution(guild.id);
  if (!constitution) return null;
  // 旧手続のまま新コードが起動した窓（デプロイ〜統治DBの作り直しの間）では、
  // 解釈できない実行規則の上で議題を作らない。scripts/reset-governance-guild.mjs で
  // 作り直してから /governance を実行する。
  if (!constitutionRules(constitution).panels?.parliament) {
    throw new Error('現行憲法が国会の実行規則を持っていません。統治DBを作り直してから /governance で導入し直してください。');
  }
  if (!manual) {
    if (governance.session_retry_after && governance.session_retry_after > now) return null;
    if (governance.last_session_at && now - governance.last_session_at < sessionIntervalMilliseconds(constitution)) {
      return null;
    }
  }
  const rules = constitutionRules(constitution);
  const limit = constitution.policy.legislation.agendaLimit;
  const carried = agendaProposals(guild.id, rules);
  const room = Math.max(0, limit - carried.length);
  const adopted = await adoptMemberThreads(guild, governance, constitution, rules, room);
  const discovered = await discoverAgenda(
    guild, governance, constitution, rules, Math.max(0, room - adopted.length)
  );
  const agenda = [...carried, ...adopted, ...discovered].slice(0, limit);
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
  recordParliamentSession({
    guildId: guild.id,
    constitutionId: constitution.id,
    manual,
    agendaCount: agenda.length,
    outcomes,
    startedAt: now
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
