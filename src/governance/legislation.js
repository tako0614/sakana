import {
  commitReviewedLegislation, constitutionForSubject,
  getCurrentLawVersion, getProposal, getWorkflowInstance, listLaws, getActiveConstitution,
  listProposalDeliberations, listProposals, recordProposalDeliberation, setProposalKind,
  threadDiscussion, transitionWorkflowInstance, updateProposal, proposalVoteSummary, rebaseProposalLegalSystem, repairInstitutionProposalScope
} from './db.js';
import { deliberateAgendaItem, draftAmendment, draftBill, ratifyLegislativeDraft, runConstitutionalPanel } from './llm.js';
import { buildLegislativeCandidates } from './relation.js';
import { canonicalJson, sha256 } from './policy.js';
import { closeGovernanceVote, compileConstitution, compileLegalSystem, durationMilliseconds } from './rules.js';
import { runLegalProcedure } from './procedure-runtime.js';
import { postProposalUpdate } from './discord.js';
import { syncLawSite } from './lawsite.js';
import { dispatchInstitutionEvent } from './institutions.js';

const running = new Map();
export function advanceLegislation(guild, proposal, now = Date.now()) {
  const key = `${guild.id}:${proposal.id}`;
  if (running.has(key)) return running.get(key);
  const task = advance(guild, proposal, now).finally(() => running.delete(key));
  running.set(key, task);
  return task;
}

async function advance(guild, proposal, now, restarts = 0) {
  proposal = repairInstitutionProposalScope(proposal.id);
  const constitution = constitutionForSubject('proposal', proposal);
  const active = getActiveConstitution(guild.id);
  if (active?.rules?.recovery && proposal.source !== 'constitutional_repair') return { proposalId: proposal.id, title: proposal.title, decision: 'pending' };
  if (active?.rules?.recovery && constitution.rules_hash !== active.rules_hash) {
    rebaseProposalLegalSystem(proposal.id, { reason: 'constitutional_recovery' });
    return advance(guild, getProposal(proposal.id), now, restarts);
  }
  if (!constitution?.policy?.autonomous) throw new Error('旧統治は読取り専用です。法令移行を実行してください。');
  let instance = getWorkflowInstance('proposal', proposal.id);
  if (instance.status === 'completed') return { proposalId: proposal.id, title: proposal.title, decision: instance.context.enacted ? 'legislate' : 'reject' };
  if (instance.status === 'queued') {
    const blocking = instance.context.queue?.blockedByProposalId ? getProposal(instance.context.queue.blockedByProposalId) : null;
    if (blocking && blocking.workflow_handler !== 'terminal') return { proposalId: proposal.id, title: proposal.title, decision: 'pending' };
    rebaseProposalLegalSystem(proposal.id, { reason: 'queued_proposal_ready' });
    return advance(guild, getProposal(proposal.id), now, restarts);
  }
  const procedure = constitution.rules.workflows[proposal.kind === 'amendment' ? 'constitutionalAmendment' : 'law'];
  const laws = listLaws(guild.id, { activeOnly: false, limit: 10000 });
  const activeLaws = laws.filter((law) => law.status === 'active');
  const discussion = threadDiscussion(guild.id, proposal.forum_thread_id, 0, 100)
    .map((row) => ({ authorId: row.user_id, content: row.content, occurredAt: row.created_at }));
  discussion.push(...(instance.context.inputHistory ?? instance.context.queue?.inputs ?? []).map((entry) => ({ authorId: entry.userId, content: entry.summary, occurredAt: entry.createdAt })));
  const institution = (definition) => {
    const result = constitution.rules.institutions[definition.config.institution];
    if (!result) throw new Error('法律で機関が設置されていません。');
    return result;
  };
  const operations = {
    async parliament_agenda({ definition }) {
      const decision = await deliberateAgendaItem({
        guildId: guild.id, agenda: { title: proposal.title, summary: proposal.summary, kind: proposal.kind, origin: proposal.source, deferrals: 0 },
        constitution, discussion, previousSessions: listProposalDeliberations(proposal.id),
        activeLaws, candidates: buildLegislativeCandidates({ request: `${proposal.title}\n${proposal.summary}`,
          normalized: { title: proposal.title, summary: proposal.summary, intent: 'amendment' }, proposals: [], laws, constitution }),
        otherOpenAgenda: listProposals(guild.id, { limit: 1000 }).filter((other) => other.id !== proposal.id && other.workflow_handler !== 'terminal').map((other) => ({ title: other.title, summary: other.summary })),
        panel: definition.config.institution ? institution(definition) : constitution.rules.panels.parliament, allowDefer: false, investigation: constitution.policy.investigation
      });
      if (decision.outputs.length !== decision.seats || decision.failedSeats) throw new Error('国会のAI席が未完了です。再試行します。');
      const amendment = decision.relation === 'amend_constitution';
      if (constitution.rules.recovery && amendment) throw new Error('暫定権限は代替組織法の起草に限られます。憲法を改変せず法律で修復してください。');
      if (amendment && proposal.kind !== 'amendment') {
        setProposalKind(proposal.id, 'amendment');
        return { restart: true };
      }
      return { outcome: decision.decision === 'legislate' ? 'adopted' : 'rejected', context: { decision } };
    },
    async legislation_draft({ context }) {
      const current = getProposal(proposal.id);
      if (current.kind !== proposal.kind) throw new Error('改憲手続へ移しました。次の実行で保存した方針から再開します。');
      const decision = context.decision;
      if (!decision?.instruction) throw new Error('起草に必要な国会の判断がありません。');
      const amendment = current.kind === 'amendment';
      const target = decision.relation === 'amend_law' ? getCurrentLawVersion(decision.targetId) : null;
      if (decision.relation === 'amend_law' && !target) throw new Error('改正対象の現行法がありません。');
      const request = { title: current.title, summary: current.summary, instruction: decision.instruction,
        previousDraft: current.body, review: context.review ?? context.adoption ?? null,
        ...(constitution.rules.recovery ? { recovery: { ...constitution.rules.recovery,
          previousDefinitions: constitution.rules, inactiveLaws: laws.filter((law) => law.status !== 'active') } } : {}),
        ...(target ? { amendmentTarget: target } : {}) };
      const body = amendment ? await draftAmendment({ guildId: guild.id, request, constitution })
        : await draftBill({ guildId: guild.id, petition: request, constitution, activeLaws, policy: constitution.policy });
      if (current.body && sha256(canonicalJson(current.body)) === sha256(canonicalJson(body)) && (context.review || context.adoption)) {
        return { outcome: 'drafted', context: { compilationError: `指摘に対する改稿がありません。同一本文の再採決は行いません。${JSON.stringify(request.review)}` } };
      }
      // Validate all declarations in the prospective legal system, not only the bill in isolation.
      try {
        if (amendment) compileConstitution({ content: body.content, laws: activeLaws });
        else compileLegalSystem({ authority: constitution.rules.authority,
          laws: [...activeLaws.filter((law) => law.id !== target?.id), { ...body, code: `DRAFT-${proposal.id}` }] });
      } catch (error) {
        // Compiler feedback is legal drafting work, handled on the law-defined revision path.
        updateProposal(proposal.id, { body });
        return { outcome: 'drafted', context: { compilationError: String(error.message), adoption: null, review: null } };
      }
      updateProposal(proposal.id, { title: body.title, summary: body.summary, body,
        relation_type: decision.relation,
        target_type: amendment ? 'constitution' : target ? 'law' : null,
        target_id: amendment ? String(constitution.id) : target ? String(target.id) : null,
        target_hash: amendment ? constitution.content_hash : target?.content_hash ?? null });
      return { outcome: 'drafted', context: { compilationError: null, adoption: null, review: null, publicVote: null } };
    },
    async ai_ratification({ state, definition, context }) {
      if (context.compilationError) return { outcome: 'revision', context: { adoption: { outputs: [{ verdict: 'revise', reasons: [context.compilationError] }] } } };
      const target = getProposal(proposal.id).body;
      const result = await ratifyLegislativeDraft({ guildId: guild.id, proposalId: proposal.id,
        constitution, institution: institution(definition), target, activeLaws });
      return { outcome: result.verdict, context: { adoption: { ...result, state, institutionId: definition.config.institution } } };
    },
    async constitutional_panel({ state, definition }) {
      const target = getProposal(proposal.id).body;
      const acting = institution(definition);
      const result = await runConstitutionalPanel({ guildId: guild.id, targetType: proposal.kind === 'amendment' ? 'amendment' : 'law',
        targetId: proposal.id, phase: 'pre', constitution, target, institution: acting });
      if (result.outputs.length !== acting.seats) throw new Error('憲法審査のAI席がそろいませんでした。');
      const passed = result.outputs.filter((output) => output.verdict === 'constitutional').length >= acting.required.constitutional;
      return { outcome: passed ? 'constitutional' : 'revision', context: { review: { ...result, targetHash: sha256(canonicalJson(target)), state, institutionId: definition.config.institution } } };
    },
    async public_vote({ state, definition, context }) {
      const target = getProposal(proposal.id);
      const targetHash = sha256(canonicalJson(target.body));
      let vote = context.publicVote;
      if (!vote || vote.targetHash !== targetHash) {
        const { buildElectorateSnapshot, snapshotHumanAuthority } = await import('./service.js');
        await buildElectorateSnapshot(guild, proposal.id);
        const vetoRule = constitution.rules.votes[proposal.kind === 'amendment' ? 'constitutionalAmendment' : 'law'].humanVeto;
        vote = { state, targetHash, openedAt: now, deadline: now + durationMilliseconds(definition.duration), announced: false,
          veto: vetoRule ? await snapshotHumanAuthority(guild, vetoRule) : null };
      }
      if (!vote.announced) {
        await postProposalUpdate(guild, target, `## AIの採択・憲法審査が完了しました\n${target.title}\n添付の同一案について公開投票を行います。締切: <t:${Math.floor(vote.deadline / 1000)}:F>`, {
          state: '投票', files: [{ name: '投票対象全文.json', attachment: Buffer.from(JSON.stringify(target.body, null, 2)) }]
        });
        vote = { ...vote, announced: true };
      }
      const summary = proposalVoteSummary(proposal.id);
      const rule = constitution.rules.votes[proposal.kind === 'amendment' ? 'constitutionalAmendment' : 'law'];
      const early = !rule.humanVeto && rule.earlyClose === 'all_ballots_cast' && summary.electorate > 0
        && summary.yes + summary.no + summary.abstain === summary.electorate;
      const result = closeGovernanceVote({ kind: proposal.kind, scope: proposal.vote_scope, ...summary }, constitution.rules);
      if (now < vote.deadline && !early && !result.humanVetoed) return { suspended: true, context: { publicVote: vote } };
      return { outcome: result.passed ? 'passed' : 'rejected', context: { publicVote: { ...vote, closed: true, result, summary } } };
    },
    async law_enactment({ context }) {
      const current = getProposal(proposal.id);
      let record;
      await postProposalUpdate(guild, current, `## 成立前の全文公示\n${current.title}\n採択・審査を終えた本文と実行定義を公示します。`, {
        files: [{ name: '法令全文.json', attachment: Buffer.from(JSON.stringify(current.body, null, 2)) }]
      });
      try {
        record = commitReviewedLegislation(proposal.id, { targetHash: sha256(canonicalJson(current.body)), adoption: context.adoption, review: context.review });
      } catch (error) {
        if (error.code === 'LEGAL_STALE') {
          rebaseProposalLegalSystem(proposal.id);
          return { restart: true };
        }
        throw error;
      }
      syncLawSite(guild);
      dispatchInstitutionEvent(guild.id, 'law_enacted', record, `${record.kind}:${record.id}`);
      return { outcome: 'enacted', context: { enacted: record } };
    },
    async notice({ definition }) {
      await postProposalUpdate(guild, getProposal(proposal.id), definition.config.text ?? procedure.mandate);
      return { outcome: 'completed' };
    }
  };
  const result = await runLegalProcedure({
    procedure, state: instance.current_state, context: instance.context, wakeAt: instance.wake_at, now,
    identity: `proposal:${proposal.id}`, operations,
    async persist({ state, context, wakeAt, completed, event, operationKey }) {
      transitionWorkflowInstance({ subjectType: 'proposal', subjectId: proposal.id, toState: state,
        context, wakeAt, completed, eventType: `legal.${event ?? 'completed'}`,
        payload: { operationKey: operationKey ?? null }, actorType: 'ai' });
      updateProposal(proposal.id, { status: state, stage_ends_at: procedure.states[state].handler === 'public_vote' ? context.publicVote?.deadline ?? null : wakeAt ?? null, retry_after: null, last_error: null });
    }
  });
  if (result.restarted) return restarts < 2 ? advance(guild, getProposal(proposal.id), now, restarts + 1)
    : { proposalId: proposal.id, title: getProposal(proposal.id).title, decision: 'pending' };
  const current = getProposal(proposal.id);
  const enacted = result.context.enacted;
  const decision = enacted ? 'legislate' : result.completed ? 'reject' : 'pending';
  const reasons = result.context.exhausted ? [result.context.exhausted.reason]
    : result.context.reasons ?? result.context.review?.outputs?.flatMap((output) => output.reasons)
      ?? result.context.adoption?.outputs?.flatMap((output) => output.reasons)
      ?? result.context.decision?.reasons ?? [];
  if (result.completed) {
    recordProposalDeliberation({ proposalId: proposal.id, revision: current.revision, outcome: decision,
      discussion, decision: { ...result.context, reasons } });
    const body = current.body;
    if (!enacted) await postProposalUpdate(guild, current, ['## 不採択',
      current.title, ...reasons.map((reason) => `- ${reason}`)].join('\n'), {
      state: enacted ? '成立' : '不成立',
      files: body ? [{ name: current.kind === 'amendment' ? '憲法改正案全文.json' : '法律全文.json', attachment: Buffer.from(JSON.stringify(body, null, 2)) }] : []
    });
  }
  return { proposalId: proposal.id, title: current.title, decision };
}
