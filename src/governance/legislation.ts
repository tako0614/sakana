import type { Guild } from 'discord.js';
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
import { runLegalProcedure, type ProcedureOperation } from './procedure-runtime.js';
import { postProposalUpdate } from './discord.js';
import { syncLawSite } from './lawsite.js';
import { dispatchInstitutionEvent } from './institutions.js';
import type { AgendaOutcome } from './parliament.js';
import {
  errorText,
  isArray,
  isEffectiveLegalSystem,
  isProposalBody,
  isRecord,
  isStringArray,
  type AgendaDecision,
  type Constitution,
  type HumanAuthoritySnapshot,
  type Institution,
  type PanelResult,
  type Proposal,
  type ProposalBody,
  type ProcedureState,
  type PublicVoteRecord,
  type SeatOutput,
  type WorkflowKey
} from './types.js';

function requireProposal(proposal: Proposal | null | undefined): Proposal {
  if (!proposal) throw new Error('議題の記録が見つかりません。');
  return proposal;
}

// AI 席の結論は llm.js が検査して返す。ここでも手続に使う形を確かめ、崩れていれば
// 何も決めずに失敗させる (保存した段から再試行する)。
function seatOutputs(value: unknown): SeatOutput[] | null {
  return isArray(value) && value.every(isRecord) ? value : null;
}

export function agendaDecision(value: unknown): AgendaDecision {
  const outputs = isRecord(value) ? seatOutputs(value.outputs) : null;
  if (!isRecord(value) || !outputs || typeof value.decision !== 'string'
    || !(value.relation === null || typeof value.relation === 'string')
    || !(value.targetId === null || typeof value.targetId === 'string')
    || !(value.instruction === null || typeof value.instruction === 'string')) {
    throw new Error('国会のAI席の結論を読めませんでした。再試行します。');
  }
  return { ...value, decision: value.decision, relation: value.relation, targetId: value.targetId, instruction: value.instruction, outputs };
}

/** 保存済みの国会の判断。起草に使う項目が無ければ null。 */
function storedDecision(value: unknown): { instruction: string; relation: unknown; targetId: string | null } | null {
  if (!isRecord(value) || typeof value.instruction !== 'string' || !value.instruction) return null;
  return { instruction: value.instruction, relation: value.relation, targetId: typeof value.targetId === 'string' ? value.targetId : null };
}

export function panelResult(value: unknown, label: string): PanelResult {
  const outputs = isRecord(value) ? seatOutputs(value.outputs) : null;
  if (!isRecord(value) || typeof value.panelId !== 'string' || !outputs
    || !(value.verdict === undefined || typeof value.verdict === 'string')) {
    throw new Error(`${label}のAI席の結論を読めませんでした。再試行します。`);
  }
  return { ...value, panelId: value.panelId, verdict: value.verdict, outputs };
}

export function draftBody(value: unknown): ProposalBody {
  if (!isProposalBody(value)) throw new Error('AIの起草結果を読めませんでした。再試行します。');
  return value;
}

/** 席ごとの理由を順に並べる。旧来どおり reasons の無い席は undefined のまま残る。 */
function outputReasons(record: unknown): unknown[] | undefined {
  if (!isRecord(record) || !isArray(record.outputs)) return undefined;
  return record.outputs.flatMap((output) => (isRecord(output) ? output.reasons : undefined));
}

function errorCode(error: unknown): unknown {
  return typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
}

const running = new Map<string, Promise<AgendaOutcome>>();
export function advanceLegislation(guild: Guild, proposal: Proposal, now = Date.now()): Promise<AgendaOutcome> {
  const key = `${guild.id}:${proposal.id}`;
  const existing = running.get(key);
  if (existing) return existing;
  const task = advance(guild, proposal, now).finally(() => running.delete(key));
  running.set(key, task);
  return task;
}

async function advance(guild: Guild, input: Proposal, now: number, restarts = 0): Promise<AgendaOutcome> {
  const proposal = requireProposal(repairInstitutionProposalScope(input.id));
  const constitution = constitutionForSubject('proposal', proposal);
  const active = getActiveConstitution(guild.id);
  if (active?.rules?.recovery && proposal.source !== 'constitutional_repair') return { proposalId: proposal.id, title: proposal.title, decision: 'pending' };
  if (active?.rules?.recovery && requireConstitution(constitution).rules_hash !== active.rules_hash) {
    rebaseProposalLegalSystem(proposal.id, { reason: 'constitutional_recovery' });
    return advance(guild, requireProposal(getProposal(proposal.id)), now, restarts);
  }
  // 自律統治の憲法は必ず v2 の法体系を持つ。それ以外の議題はここで進めない。
  const rules = constitution?.rules;
  if (!constitution?.policy?.autonomous || !isEffectiveLegalSystem(rules)) throw new Error('旧統治は読取り専用です。法令移行を実行してください。');
  const instance = getWorkflowInstance('proposal', proposal.id);
  if (!instance) throw new Error(`workflow instanceがありません: proposal:${proposal.id}`);
  if (instance.status === 'completed') return { proposalId: proposal.id, title: proposal.title, decision: instance.context.enacted ? 'legislate' : 'reject' };
  if (instance.status === 'queued') {
    const blocking = instance.context.queue?.blockedByProposalId ? getProposal(instance.context.queue.blockedByProposalId) : null;
    if (blocking && blocking.workflow_handler !== 'terminal') return { proposalId: proposal.id, title: proposal.title, decision: 'pending' };
    rebaseProposalLegalSystem(proposal.id, { reason: 'queued_proposal_ready' });
    return advance(guild, requireProposal(getProposal(proposal.id)), now, restarts);
  }
  const workflowKey: WorkflowKey = proposal.kind === 'amendment' ? 'constitutionalAmendment' : 'law';
  const procedure = rules.workflows[workflowKey];
  const laws = listLaws(guild.id, { activeOnly: false, limit: 10000 });
  const activeLaws = laws.filter((law) => law.status === 'active');
  const discussion: { authorId: string | null; content: string; occurredAt: number }[] = threadDiscussion(guild.id, proposal.forum_thread_id, 0, 100)
    .map((row) => ({ authorId: row.user_id, content: row.content, occurredAt: row.created_at }));
  discussion.push(...(instance.context.inputHistory ?? instance.context.queue?.inputs ?? []).map((entry) => ({ authorId: entry.userId, content: entry.summary, occurredAt: entry.createdAt })));
  const institution = (definition: ProcedureState): Institution => {
    const name = definition.config.institution;
    const result = name === undefined ? undefined : rules.institutions[name];
    if (!result) throw new Error('法律で機関が設置されていません。');
    return result;
  };
  const currentProposal = (): Proposal => requireProposal(getProposal(proposal.id));
  const operations: Partial<Record<string, ProcedureOperation>> = {
    async parliament_agenda({ definition }) {
      const decision = agendaDecision(await deliberateAgendaItem({
        guildId: guild.id, agenda: { title: proposal.title, summary: proposal.summary, kind: proposal.kind, origin: proposal.source, deferrals: 0 },
        constitution, discussion, previousSessions: listProposalDeliberations(proposal.id),
        activeLaws, candidates: buildLegislativeCandidates({ request: `${proposal.title}\n${proposal.summary}`,
          normalized: { title: proposal.title, summary: proposal.summary, intent: 'amendment' }, proposals: [], laws, constitution }),
        otherOpenAgenda: listProposals(guild.id, { limit: 1000 }).filter((other) => other.id !== proposal.id && other.workflow_handler !== 'terminal').map((other) => ({ title: other.title, summary: other.summary })),
        panel: definition.config.institution ? institution(definition) : rules.panels.parliament, allowDefer: false, investigation: constitution.policy.investigation
      }));
      if (decision.outputs.length !== decision.seats || decision.failedSeats) throw new Error('国会のAI席が未完了です。再試行します。');
      const amendment = decision.relation === 'amend_constitution';
      if (rules.recovery && amendment) throw new Error('暫定権限は代替組織法の起草に限られます。憲法を改変せず法律で修復してください。');
      if (amendment && proposal.kind !== 'amendment') {
        setProposalKind(proposal.id, 'amendment');
        return { restart: true };
      }
      return { outcome: decision.decision === 'legislate' ? 'adopted' : 'rejected', context: { decision } };
    },
    async legislation_draft({ context }) {
      const current = currentProposal();
      if (current.kind !== proposal.kind) throw new Error('改憲手続へ移しました。次の実行で保存した方針から再開します。');
      const decision = storedDecision(context.decision);
      if (!decision?.instruction) throw new Error('起草に必要な国会の判断がありません。');
      const amendment = current.kind === 'amendment';
      // 改正対象は、この議題のサーバーで現行の法律に限る。他サーバーの法令本文を起草へ渡さない。
      const found = decision.relation === 'amend_law' ? getCurrentLawVersion(decision.targetId) : null;
      const target = found?.guild_id === guild.id ? found : null;
      if (decision.relation === 'amend_law' && !target) throw new Error('改正対象の現行法がありません。');
      const request = { title: current.title, summary: current.summary, instruction: decision.instruction,
        previousDraft: current.body, review: context.review ?? context.adoption ?? null,
        ...(rules.recovery ? { recovery: { ...rules.recovery,
          previousDefinitions: rules, inactiveLaws: laws.filter((law) => law.status !== 'active') } } : {}),
        ...(target ? { amendmentTarget: target } : {}) };
      const body = draftBody(amendment ? await draftAmendment({ guildId: guild.id, request, constitution })
        : await draftBill({ guildId: guild.id, petition: request, constitution, activeLaws, policy: constitution.policy }));
      if (current.body && sha256(canonicalJson(current.body)) === sha256(canonicalJson(body)) && (context.review || context.adoption)) {
        return { outcome: 'drafted', context: { compilationError: `指摘に対する改稿がありません。同一本文の再採決は行いません。${JSON.stringify(request.review)}` } };
      }
      // Validate all declarations in the prospective legal system, not only the bill in isolation.
      try {
        if (amendment) compileConstitution({ content: body.content, laws: activeLaws });
        else compileLegalSystem({ authority: rules.authority,
          laws: [...activeLaws.filter((law) => law.id !== target?.id), { ...body, code: `DRAFT-${proposal.id}` }] });
      } catch (error) {
        // Compiler feedback is legal drafting work, handled on the law-defined revision path.
        updateProposal(proposal.id, { body });
        return { outcome: 'drafted', context: { compilationError: errorText(error), adoption: null, review: null } };
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
      const target = currentProposal().body;
      const result = panelResult(await ratifyLegislativeDraft({ guildId: guild.id, proposalId: proposal.id,
        constitution, institution: institution(definition), target, activeLaws }), '採択');
      return { outcome: result.verdict, context: { adoption: { ...result, state, institutionId: definition.config.institution } } };
    },
    async constitutional_panel({ state, definition }) {
      const target = currentProposal().body;
      const acting = institution(definition);
      const result = panelResult(await runConstitutionalPanel({ guildId: guild.id, targetType: proposal.kind === 'amendment' ? 'amendment' : 'law',
        targetId: proposal.id, phase: 'pre', constitution, target, institution: acting }), '憲法審査');
      if (result.outputs.length !== acting.seats) throw new Error('憲法審査のAI席がそろいませんでした。');
      // 必要票の定めが無ければ合憲にしない (旧来の `n >= undefined` と同じく false)。
      const passed = result.outputs.filter((output) => output.verdict === 'constitutional').length >= (acting.required.constitutional ?? Infinity);
      return { outcome: passed ? 'constitutional' : 'revision', context: { review: { ...result, targetHash: sha256(canonicalJson(target)), state, institutionId: definition.config.institution } } };
    },
    async public_vote({ state, definition, context }) {
      const target = currentProposal();
      const targetHash = sha256(canonicalJson(target.body));
      let vote: PublicVoteRecord | null | undefined = context.publicVote;
      if (!vote || vote.targetHash !== targetHash) {
        const { buildElectorateSnapshot, snapshotHumanAuthority } = await import('./service.js');
        await buildElectorateSnapshot(guild, proposal.id);
        const vetoRule = rules.votes[workflowKey].humanVeto;
        const veto: HumanAuthoritySnapshot | null = vetoRule ? await snapshotHumanAuthority(guild, vetoRule) : null;
        vote = { state, targetHash, openedAt: now, deadline: now + durationMilliseconds(definition.duration), announced: false, veto };
      }
      if (!vote.announced) {
        await postProposalUpdate(guild, target, `## AIの採択・憲法審査が完了しました\n${target.title}\n添付の同一案について公開投票を行います。締切: <t:${Math.floor(vote.deadline / 1000)}:F>`, {
          state: '投票', files: [{ name: '投票対象全文.json', attachment: Buffer.from(JSON.stringify(target.body, null, 2)) }]
        });
        vote = { ...vote, announced: true };
      }
      const summary = proposalVoteSummary(proposal.id);
      const rule = rules.votes[workflowKey];
      const early = !rule.humanVeto && rule.earlyClose === 'all_ballots_cast' && summary.electorate > 0
        && summary.yes + summary.no + summary.abstain === summary.electorate;
      const result = closeGovernanceVote({ kind: proposal.kind, scope: proposal.vote_scope, ...summary }, rules);
      if (now < vote.deadline && !early && !result.humanVetoed) return { suspended: true, context: { publicVote: vote } };
      return { outcome: result.passed ? 'passed' : 'rejected', context: { publicVote: { ...vote, closed: true, result, summary } } };
    },
    async law_enactment({ context }) {
      const current = currentProposal();
      let record: { kind: string; id: number };
      await postProposalUpdate(guild, current, `## 成立前の全文公示\n${current.title}\n採択・審査を終えた本文と実行定義を公示します。`, {
        files: [{ name: '法令全文.json', attachment: Buffer.from(JSON.stringify(current.body, null, 2)) }]
      });
      try {
        record = commitReviewedLegislation(proposal.id, { targetHash: sha256(canonicalJson(current.body)), adoption: context.adoption, review: context.review });
      } catch (error) {
        if (errorCode(error) === 'LEGAL_STALE') {
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
      const text = definition.config.text ?? procedure.mandate;
      if (text === undefined) throw new Error('通知する本文が定められていません。');
      await postProposalUpdate(guild, requireProposal(getProposal(proposal.id)), text);
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
      updateProposal(proposal.id, { status: state, stage_ends_at: procedure.states[state]?.handler === 'public_vote' ? context.publicVote?.deadline ?? null : wakeAt ?? null, retry_after: null, last_error: null });
    }
  });
  if (result.restarted) return restarts < 2 ? advance(guild, currentProposal(), now, restarts + 1)
    : { proposalId: proposal.id, title: currentProposal().title, decision: 'pending' };
  const current = currentProposal();
  const enacted = result.context.enacted;
  const decision = enacted ? 'legislate' : result.completed ? 'reject' : 'pending';
  const contextReasons = result.context.reasons;
  const reasons: unknown[] = result.context.exhausted ? [result.context.exhausted.reason]
    : (isArray(contextReasons) ? contextReasons : undefined) ?? outputReasons(result.context.review)
      ?? outputReasons(result.context.adoption)
      ?? (isRecord(result.context.decision) && isStringArray(result.context.decision.reasons) ? result.context.decision.reasons : undefined) ?? [];
  if (result.completed) {
    recordProposalDeliberation({ proposalId: proposal.id, revision: current.revision, outcome: decision,
      discussion, decision: { ...result.context, reasons } });
    const body = current.body;
    if (!enacted) await postProposalUpdate(guild, current, ['## 不採択',
      current.title, ...reasons.map((reason) => `- ${String(reason)}`)].join('\n'), {
      state: enacted ? '成立' : '不成立',
      files: body ? [{ name: current.kind === 'amendment' ? '憲法改正案全文.json' : '法律全文.json', attachment: Buffer.from(JSON.stringify(body, null, 2)) }] : []
    });
  }
  return { proposalId: proposal.id, title: current.title, decision };
}

function requireConstitution(constitution: Constitution | null): Constitution {
  if (!constitution) throw new Error('議題の憲法が見つかりません。');
  return constitution;
}
