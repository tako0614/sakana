import { canonicalJson, sha256, validateConstitutionPolicy } from './policy.js';

export const GOVERNANCE_RULES_SCHEMA = 'sakana.governance-rules/v1';
export const GOVERNANCE_RULES_COMPILER_VERSION = 1;

const HANDLERS = new Set([
  'parliament_agenda',
  'constitutional_panel',
  'public_vote',
  'summary_review',
  'defense_window',
  'judicial_panel',
  'public_approval',
  'review_window',
  'appeal_window',
  'sanction_execution',
  'terminal'
]);

export const VOTE_EARLY_CLOSE = new Set(['never', 'all_ballots_cast']);

const DURATION_RE = /^(immediate|[1-9]\d*(?:m|h|d))$/;
const MAX_DURATION_MS = 365 * 86_400_000;

function object(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name} はobjectである必要があります。`);
  return value;
}

function exactKeys(value, keys, name, optionalKeys = []) {
  object(value, name);
  const allowed = new Set([...keys, ...optionalKeys]);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length) throw new Error(`${name} に未対応の項目があります: ${unknown.join(', ')}`);
  const missing = keys.filter((key) => !(key in value));
  if (missing.length) throw new Error(`${name} に必須項目がありません: ${missing.join(', ')}`);
  return value;
}

function integer(value, name, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${name} が不正です。`);
  return value;
}

function ratio(value, name) {
  if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error(`${name} は0以上1以下である必要があります。`);
  return value;
}

export function durationMilliseconds(value, name = 'duration') {
  if (typeof value !== 'string' || !DURATION_RE.test(value)) throw new Error(`${name} は immediate または 10m・24h・7d 形式である必要があります。`);
  if (value === 'immediate') return 0;
  const amount = Number.parseInt(value, 10);
  const unit = value.at(-1);
  const multiplier = unit === 'm' ? 60_000 : unit === 'h' ? 3_600_000 : 86_400_000;
  const milliseconds = amount * multiplier;
  if (!Number.isSafeInteger(milliseconds) || milliseconds > MAX_DURATION_MS) throw new Error(`${name} が技術上限を超えています。`);
  return milliseconds;
}

export function durationText(milliseconds) {
  const value = Number(milliseconds);
  if (value === 0) return 'immediate';
  if (value % 86_400_000 === 0) return `${value / 86_400_000}d`;
  if (value % 3_600_000 === 0) return `${value / 3_600_000}h`;
  if (value % 60_000 === 0) return `${value / 60_000}m`;
  throw new Error('実行規則へ変換できない時間です。');
}

function validateElectorates(electorates) {
  exactKeys(electorates, ['general', 'trusted'], 'electorates');
  exactKeys(electorates.general, [
    'type', 'memberAge', 'window', 'minimumMessages', 'minimumActiveDays',
    'perDayCap', 'minimumVisibleCharacters', 'timezoneOffsetMinutes'
  ], 'electorates.general');
  if (electorates.general.type !== 'activity') throw new Error('electorates.general.type は activity だけを利用できます。');
  const memberAge = durationMilliseconds(electorates.general.memberAge, 'electorates.general.memberAge');
  const window = durationMilliseconds(electorates.general.window, 'electorates.general.window');
  if (memberAge % 86_400_000 !== 0 || window % 86_400_000 !== 0) {
    throw new Error('活動有権者のmemberAgeとwindowは日単位で指定してください。');
  }
  if (window > 90 * 86_400_000) {
    throw new Error('activity保持期間の技術上限は90日です。');
  }
  for (const key of ['minimumMessages', 'minimumActiveDays', 'perDayCap']) {
    integer(electorates.general[key], `electorates.general.${key}`, { max: 100_000 });
  }
  integer(electorates.general.minimumVisibleCharacters, 'electorates.general.minimumVisibleCharacters', { max: 2000 });
  if (electorates.general.minimumActiveDays > window / 86_400_000
    || electorates.general.minimumMessages > (window / 86_400_000) * electorates.general.perDayCap) {
    throw new Error('活動有権者の条件が指定期間内に到達不能です。');
  }
  integer(electorates.general.timezoneOffsetMinutes, 'electorates.general.timezoneOffsetMinutes', { min: -720, max: 840 });
  exactKeys(electorates.trusted, ['type', 'binding'], 'electorates.trusted');
  if (electorates.trusted.type !== 'discord_role' || electorates.trusted.binding !== 'trusted') {
    throw new Error('trusted electorateは運用設定のtrusted roleだけを参照できます。');
  }
}

function validatePanels(panels) {
  exactKeys(panels, ['parliament', 'constitutional', 'criminal', 'summary'], 'panels');
  const requiredKeys = {
    parliament: ['decision'],
    constitutional: ['constitutional', 'unconstitutional'],
    criminal: ['responsible'],
    summary: ['responsible']
  };
  for (const [name, panel] of Object.entries(panels)) {
    exactKeys(panel, ['seats', 'required'], `panels.${name}`);
    integer(panel.seats, `panels.${name}.seats`, { min: 1, max: 5 });
    if (panel.seats % 2 === 0) throw new Error(`panels.${name}.seats は1, 3, 5のいずれかです。`);
    exactKeys(panel.required, requiredKeys[name], `panels.${name}.required`);
    for (const [outcome, needed] of Object.entries(panel.required)) {
      if (!/^[a-z][a-z0-9_]*$/.test(outcome)) throw new Error(`panels.${name}.requiredの結果名が不正です。`);
      integer(needed, `panels.${name}.required.${outcome}`, { min: 1, max: panel.seats });
    }
  }
}

function validateVotes(votes) {
  exactKeys(votes, ['defaultScope', 'allowedScopes', 'law', 'constitutionalAmendment'], 'votes');
  if (!['all', 'trusted'].includes(votes.defaultScope)) throw new Error('votes.defaultScope が不正です。');
  if (!Array.isArray(votes.allowedScopes) || votes.allowedScopes.length < 1
    || votes.allowedScopes.some((scope) => !['all', 'trusted'].includes(scope))
    || !votes.allowedScopes.includes(votes.defaultScope)) throw new Error('votes.allowedScopes が不正です。');
  for (const [name, vote] of [['law', votes.law], ['constitutionalAmendment', votes.constitutionalAmendment]]) {
    exactKeys(
      vote,
      ['duration', 'yesRatio', 'comparison', 'quorumRatio', 'minimumBallots', 'publicBallots', 'trustedVeto'],
      `votes.${name}`,
      ['earlyClose']
    );
    // earlyCloseを書かない旧憲法は締切満了だけで開票する。
    if ('earlyClose' in vote && !VOTE_EARLY_CLOSE.has(vote.earlyClose)) {
      throw new Error(`votes.${name}.earlyClose は never または all_ballots_cast です。`);
    }
    durationMilliseconds(vote.duration, `votes.${name}.duration`);
    ratio(vote.yesRatio, `votes.${name}.yesRatio`);
    ratio(vote.quorumRatio, `votes.${name}.quorumRatio`);
    if (!['gt', 'gte'].includes(vote.comparison)) throw new Error(`votes.${name}.comparison が不正です。`);
    integer(vote.minimumBallots, `votes.${name}.minimumBallots`, { max: 100_000 });
    if (vote.publicBallots !== true) throw new Error('公開投票だけを利用できます。');
    exactKeys(vote.trustedVeto, ['enabledForScope', 'noRatio', 'denominator'], `votes.${name}.trustedVeto`);
    if (vote.trustedVeto.enabledForScope !== 'all' || vote.trustedVeto.denominator !== 'decisive_cast_ballots') {
      throw new Error('trusted拒否は全員投票の有効投票だけを分母にする必要があります。');
    }
    ratio(vote.trustedVeto.noRatio, `votes.${name}.trustedVeto.noRatio`);
  }
}

function validateSanctions(sanctions) {
  exactKeys(sanctions, [
    'allowed', 'restrictionPrimitives', 'maximumRestriction', 'timeout',
    'approvals', 'appeals', 'summaryProcedure'
  ], 'sanctions');
  const types = ['warning', 'restriction', 'timeout', 'kick', 'ban'];
  if (!Array.isArray(sanctions.allowed) || new Set(sanctions.allowed).size !== sanctions.allowed.length
    || sanctions.allowed.some((type) => !types.includes(type))) throw new Error('sanctions.allowed が不正です。');
  const primitives = new Set([
    'messages_per_window', 'block_links', 'block_attachments', 'block_mentions',
    'block_reactions', 'block_thread_creation', 'block_voice',
    'agent_calls_per_window', 'block_petitions', 'block_voting'
  ]);
  if (!Array.isArray(sanctions.restrictionPrimitives)
    || sanctions.restrictionPrimitives.some((value) => !primitives.has(value))) {
    throw new Error('未対応のrestriction capabilityがあります。');
  }
  durationMilliseconds(sanctions.maximumRestriction, 'sanctions.maximumRestriction');
  exactKeys(sanctions.timeout, ['discordMaximum', 'maximum', 'immediateMaximum'], 'sanctions.timeout');
  for (const [key, value] of Object.entries(sanctions.timeout)) durationMilliseconds(value, `sanctions.timeout.${key}`);
  if (durationMilliseconds(sanctions.timeout.discordMaximum) > 2_419_200_000) throw new Error('Discord timeout上限を超えています。');
  exactKeys(sanctions.approvals, ['timeoutAboveImmediate', 'kick', 'ban'], 'sanctions.approvals');
  for (const [key, value] of Object.entries(sanctions.approvals)) integer(value, `sanctions.approvals.${key}`, { max: 100 });
  exactKeys(sanctions.appeals, ['timeoutAtLeast', 'types', 'duration'], 'sanctions.appeals');
  durationMilliseconds(sanctions.appeals.timeoutAtLeast, 'sanctions.appeals.timeoutAtLeast');
  durationMilliseconds(sanctions.appeals.duration, 'sanctions.appeals.duration');
  if (!Array.isArray(sanctions.appeals.types)
    || canonicalJson([...sanctions.appeals.types].sort()) !== canonicalJson(['ban', 'timeout'])) {
    throw new Error('現在のDiscord実行系で上訴対象にできる処分は ban と timeout だけです。');
  }
  exactKeys(sanctions.summaryProcedure, ['trialDuration', 'immediate', 'trialFirst', 'unlimitedWarningReview'], 'sanctions.summaryProcedure');
  durationMilliseconds(sanctions.summaryProcedure.trialDuration, 'sanctions.summaryProcedure.trialDuration');
  for (const key of ['immediate', 'trialFirst']) {
    if (!Array.isArray(sanctions.summaryProcedure[key])
      || sanctions.summaryProcedure[key].some((type) => !types.includes(type))) throw new Error(`sanctions.summaryProcedure.${key} が不正です。`);
  }
  if (sanctions.summaryProcedure.unlimitedWarningReview !== true && sanctions.summaryProcedure.unlimitedWarningReview !== false) {
    throw new Error('unlimitedWarningReviewは真偽値である必要があります。');
  }
}

function validateWorkflow(name, workflow) {
  exactKeys(workflow, ['initial', 'config', 'states'], `workflows.${name}`);
  if (['law', 'constitutionalAmendment'].includes(name)) {
    exactKeys(workflow.config, ['maximumDeferrals', 'maximumSessionInterval'], `workflows.${name}.config`);
    integer(workflow.config.maximumDeferrals, `workflows.${name}.config.maximumDeferrals`, { min: 1, max: 20 });
    const interval = durationMilliseconds(workflow.config.maximumSessionInterval, `workflows.${name}.config.maximumSessionInterval`);
    if (interval < 3_600_000) throw new Error(`workflows.${name}.config.maximumSessionInterval は1時間以上である必要があります。`);
  } else if (name === 'constitutionalCase') {
    exactKeys(workflow.config, ['petitionsPerMemberPerDay'], `workflows.${name}.config`);
    integer(workflow.config.petitionsPerMemberPerDay, `workflows.${name}.config.petitionsPerMemberPerDay`, { min: 1, max: 1000 });
  } else {
    exactKeys(workflow.config, [], `workflows.${name}.config`);
  }
  const states = object(workflow.states, `workflows.${name}.states`);
  const entries = Object.entries(states);
  if (entries.length < 1 || entries.length > 64) throw new Error(`workflows.${name}.states の数が不正です。`);
  if (!(workflow.initial in states)) throw new Error(`workflows.${name}.initial が存在しません。`);
  let terminalCount = 0;
  for (const [stateName, state] of entries) {
    if (!/^[a-z][a-z0-9_]*$/.test(stateName)) throw new Error(`workflows.${name}のstate名が不正です。`);
    exactKeys(state, ['handler', 'duration', 'config', 'on'], `workflows.${name}.states.${stateName}`);
    if (!HANDLERS.has(state.handler)) throw new Error(`未対応のworkflow handlerです: ${state.handler}`);
    if (state.duration !== null) durationMilliseconds(state.duration, `workflows.${name}.states.${stateName}.duration`);
    object(state.config, `workflows.${name}.states.${stateName}.config`);
    object(state.on, `workflows.${name}.states.${stateName}.on`);
    if (['public_vote', 'defense_window', 'appeal_window'].includes(state.handler)
      && (state.duration === null || durationMilliseconds(state.duration) === 0)) {
      throw new Error(`${state.handler} には0より長い期間が必要です。`);
    }
    // 国会が動かすまでの待機なので、議題stateに固定の期間は置かない。
    if (state.handler === 'parliament_agenda' && state.duration !== null) {
      throw new Error(`workflows.${name}.states.${stateName}.duration は国会の議題では null である必要があります。`);
    }
    if (state.handler === 'terminal') {
      terminalCount += 1;
      if (state.duration !== null || Object.keys(state.on).length > 0) throw new Error('terminal stateには期間や遷移を設定できません。');
    }
    for (const [outcome, target] of Object.entries(state.on)) {
      if (!/^[a-z][a-z0-9_]*$/.test(outcome) || typeof target !== 'string' || !(target in states)) {
        throw new Error(`workflows.${name}.${stateName} の遷移が不正です。`);
      }
    }
  }
  if (terminalCount < 1) throw new Error(`workflows.${name} に終端状態がありません。`);
  const reachable = new Set([workflow.initial]);
  const queue = [workflow.initial];
  while (queue.length) {
    const current = queue.shift();
    for (const target of Object.values(states[current].on)) {
      if (!reachable.has(target)) { reachable.add(target); queue.push(target); }
    }
  }
  const unreachable = Object.keys(states).filter((state) => !reachable.has(state));
  if (unreachable.length) throw new Error(`workflows.${name} に到達不能状態があります: ${unreachable.join(', ')}`);
  const waitingHandlers = new Set([
    'parliament_agenda', 'public_vote', 'defense_window', 'public_approval',
    'review_window', 'appeal_window', 'terminal'
  ]);
  const instant = (stateName) => {
    const item = states[stateName];
    return !waitingHandlers.has(item.handler) && (item.duration === null || durationMilliseconds(item.duration) === 0);
  };
  const visiting = new Set();
  const visited = new Set();
  const findInstantCycle = (stateName) => {
    if (!instant(stateName)) return false;
    if (visiting.has(stateName)) return true;
    if (visited.has(stateName)) return false;
    visiting.add(stateName);
    for (const target of Object.values(states[stateName].on)) {
      if (findInstantCycle(target)) return true;
    }
    visiting.delete(stateName);
    visited.add(stateName);
    return false;
  };
  if (Object.keys(states).some(findInstantCycle)) throw new Error(`workflows.${name} に待機を伴わない循環があります。`);
}

function requireTransition(workflow, stateName, outcome, targetHandler) {
  const state = workflow.states[stateName];
  const targetName = state?.on?.[outcome];
  const target = workflow.states[targetName];
  if (!target || target.handler !== targetHandler) {
    throw new Error(`workflow ${stateName}.${outcome} は ${targetHandler} へ進む必要があります。`);
  }
  return targetName;
}

function validateLegislativeWorkflow(name, workflow) {
  const agendaName = workflow.initial;
  const agenda = workflow.states[agendaName];
  if (agenda?.handler !== 'parliament_agenda') {
    throw new Error(`workflows.${name}.initial は parliament_agenda handlerである必要があります。`);
  }
  exactKeys(agenda.on, ['adopted', 'deferred', 'rejected'], `workflows.${name}.states.${agendaName}.on`);
  // 継続審議は同じ議題へ戻る。国会以外が議題を進める経路は作れない。
  if (agenda.on.deferred !== agendaName) {
    throw new Error(`workflows.${name} の継続審議は同じ議題へ戻る必要があります。`);
  }
  requireTransition(workflow, agendaName, 'rejected', 'terminal');
  const voteName = requireTransition(workflow, agendaName, 'adopted', 'public_vote');
  requireTransition(workflow, voteName, 'passed', 'terminal');
  requireTransition(workflow, voteName, 'rejected', 'terminal');
  if (workflow.states[voteName].on.stale) requireTransition(workflow, voteName, 'stale', 'terminal');
  const agendaStates = Object.values(workflow.states).filter((state) => state.handler === 'parliament_agenda');
  if (agendaStates.length !== 1) throw new Error(`workflows.${name} の議題stateは一つだけです。`);
}

export function validateGovernanceRules(input) {
  const rules = exactKeys(input, ['$schema', 'electorates', 'panels', 'votes', 'sanctions', 'workflows'], 'governance-rules');
  if (rules.$schema !== GOVERNANCE_RULES_SCHEMA) throw new Error('未対応のgovernance-rules schemaです。');
  validateElectorates(rules.electorates);
  validatePanels(rules.panels);
  validateVotes(rules.votes);
  validateSanctions(rules.sanctions);
  exactKeys(rules.workflows, ['law', 'constitutionalAmendment', 'criminalCase', 'constitutionalCase'], 'workflows');
  for (const [name, workflow] of Object.entries(rules.workflows)) validateWorkflow(name, workflow);
  validateLegislativeWorkflow('law', rules.workflows.law);
  validateLegislativeWorkflow('constitutionalAmendment', rules.workflows.constitutionalAmendment);
  for (const [workflowName, voteName] of [['law', 'law'], ['constitutionalAmendment', 'constitutionalAmendment']]) {
    const voteStates = Object.values(rules.workflows[workflowName].states)
      .filter((state) => state.handler === 'public_vote');
    if (voteStates.length !== 1 || voteStates[0].config.vote !== voteName
      || voteStates[0].duration !== rules.votes[voteName].duration) {
      throw new Error(`workflows.${workflowName} の投票段階は votes.${voteName} と一致する必要があります。`);
    }
  }
  return rules;
}

export function extractGovernanceRules(content) {
  const text = String(content ?? '');
  const matches = [...text.matchAll(/```governance-rules\s*\n([\s\S]*?)\n```/g)];
  if (matches.length === 0) return null;
  if (matches.length !== 1) throw new Error('憲法にはgovernance-rulesブロックを一つだけ置けます。');
  let parsed;
  try { parsed = JSON.parse(matches[0][1]); } catch (error) {
    throw new Error(`governance-rules JSONを読めません: ${error.message}`);
  }
  return validateGovernanceRules(parsed);
}

export function policyFromGovernanceRules(input) {
  const rules = validateGovernanceRules(structuredClone(input));
  const general = rules.electorates.general;
  const lawFlow = rules.workflows.law;
  const vote = rules.votes.law;
  const constitutional = rules.panels.constitutional;
  const criminal = rules.panels.criminal;
  const summary = rules.panels.summary;
  const sanctions = rules.sanctions;
  const summaryWorkflow = Object.values(rules.workflows.criminalCase.states)
    .some((state) => state.handler === 'summary_review');
  const policy = {
    schemaVersion: summaryWorkflow ? 2 : 1,
    timezoneOffsetMinutes: general.timezoneOffsetMinutes,
    eligibility: {
      memberAgeDays: durationMilliseconds(general.memberAge) / 86_400_000,
      windowDays: durationMilliseconds(general.window) / 86_400_000,
      minimumMessages: general.minimumMessages,
      minimumActiveDays: general.minimumActiveDays,
      perDayCap: general.perDayCap,
      minimumVisibleCharacters: general.minimumVisibleCharacters
    },
    voting: {
      defaultScope: rules.votes.defaultScope,
      allowedScopes: rules.votes.allowedScopes,
      lawYesRatio: vote.yesRatio,
      amendmentYesRatio: rules.votes.constitutionalAmendment.yesRatio,
      trustedVetoRatio: vote.trustedVeto.noRatio,
      quorumRatio: vote.quorumRatio,
      minimumBallots: vote.minimumBallots,
      publicBallots: vote.publicBallots
    },
    legislation: {
      voteMilliseconds: durationMilliseconds(vote.duration),
      maximumDeferrals: lawFlow.config.maximumDeferrals,
      maximumSessionIntervalMilliseconds: durationMilliseconds(lawFlow.config.maximumSessionInterval)
    },
    judiciary: {
      defenseMilliseconds: durationMilliseconds(rules.workflows.criminalCase.states.defense?.duration ?? rules.workflows.constitutionalCase.states.defense.duration),
      appealMilliseconds: durationMilliseconds(sanctions.appeals.duration),
      constitutionalChallengesPerMemberPerDay: rules.workflows.constitutionalCase.config.petitionsPerMemberPerDay,
      panelSeats: criminal.seats,
      guiltyVotesRequired: criminal.required.responsible,
      constitutionalVotesRequired: constitutional.required.constitutional,
      unconstitutionalVotesRequired: constitutional.required.unconstitutional,
      discordMaximumTimeoutSeconds: durationMilliseconds(sanctions.timeout.discordMaximum) / 1000,
      maximumTimeoutSeconds: durationMilliseconds(sanctions.timeout.maximum) / 1000,
      immediateTimeoutMaximumSeconds: durationMilliseconds(sanctions.timeout.immediateMaximum) / 1000,
      timeoutApprovalsAboveSeconds: sanctions.approvals.timeoutAboveImmediate,
      kickApprovals: sanctions.approvals.kick,
      banApprovals: sanctions.approvals.ban,
      appealTimeoutMinimumSeconds: durationMilliseconds(sanctions.appeals.timeoutAtLeast) / 1000,
      maximumRestrictionSeconds: durationMilliseconds(sanctions.maximumRestriction) / 1000,
      allowedSanctions: sanctions.allowed,
      restrictionPrimitives: sanctions.restrictionPrimitives
    }
  };
  if (policy.schemaVersion === 2) {
    policy.judiciary.summaryProcedure = {
      panelSeats: summary.seats,
      votesRequired: summary.required.responsible,
      trialMilliseconds: durationMilliseconds(sanctions.summaryProcedure.trialDuration),
      immediateSanctions: sanctions.summaryProcedure.immediate,
      trialFirstSanctions: sanctions.summaryProcedure.trialFirst,
      unlimitedWarningReview: sanctions.summaryProcedure.unlimitedWarningReview
    };
  }
  return validateConstitutionPolicy(policy, { technicalOnly: true });
}

export function compileConstitution({ content }) {
  const rules = extractGovernanceRules(content);
  if (!rules) throw new Error('憲法にgovernance-rulesブロックがありません。');
  const projectedPolicy = policyFromGovernanceRules(rules);
  const canonical = canonicalJson(rules);
  return {
    sourceFormat: 'embedded-rules-v1',
    compilerVersion: GOVERNANCE_RULES_COMPILER_VERSION,
    rules,
    rulesHash: sha256(canonical),
    policy: projectedPolicy
  };
}

export function workflowFor(compiled, key) {
  const workflow = compiled?.rules?.workflows?.[key];
  if (!workflow) throw new Error(`憲法にworkflow ${key} がありません。`);
  return workflow;
}

export function workflowNext(compiled, key, stateName, outcome) {
  const workflow = workflowFor(compiled, key);
  const state = workflow.states[stateName];
  if (!state) throw new Error(`workflow ${key} にstate ${stateName} がありません。`);
  const next = state.on[outcome];
  if (!next) throw new Error(`workflow ${key}.${stateName} は結果 ${outcome} を受け付けません。`);
  return next;
}

export function closeGovernanceVote({ kind, yes, no, abstain, electorate, trustedNo, trustedTotal, scope = 'all' }, rules) {
  const vote = kind === 'amendment' ? rules.votes.constitutionalAmendment : rules.votes.law;
  const decisive = Number(yes) + Number(no);
  const yesRatio = decisive > 0 ? Number(yes) / decisive : 0;
  const ratioPassed = decisive > 0
    && (vote.comparison === 'gte' ? yesRatio >= vote.yesRatio : yesRatio > vote.yesRatio);
  const ballots = decisive + Number(abstain);
  const quorumNeeded = Math.max(vote.minimumBallots, Math.ceil(Math.max(0, Number(electorate)) * vote.quorumRatio));
  const quorumPassed = ballots >= quorumNeeded;
  const vetoApplies = scope === vote.trustedVeto.enabledForScope;
  const trustedNeeded = Number(trustedTotal) > 0
    ? Math.ceil(Number(trustedTotal) * vote.trustedVeto.noRatio)
    : Infinity;
  const vetoed = vetoApplies && Number(trustedTotal) > 0 && Number(trustedNo) >= trustedNeeded;
  return {
    passed: ratioPassed && quorumPassed && !vetoed,
    ratioPassed,
    quorumPassed,
    vetoed,
    quorumNeeded,
    trustedNeeded,
    decisive,
    ballots
  };
}

export function governanceRulesSummary(rules) {
  const law = rules.workflows.law;
  const lines = [];
  lines.push(`国会の開会間隔上限 ${law.config.maximumSessionInterval}`);
  lines.push(`継続審議 ${law.config.maximumDeferrals}回まで`);
  lines.push(`法律投票 ${rules.votes.law.duration}`);
  lines.push(`憲法改正投票 ${rules.votes.constitutionalAmendment.duration}`);
  if (rules.votes.law.earlyClose === 'all_ballots_cast' || rules.votes.constitutionalAmendment.earlyClose === 'all_ballots_cast') {
    lines.push('有権者全員の投票で即時開票');
  }
  lines.push(`違憲審査 ${rules.panels.constitutional.seats}席`);
  lines.push(`国会の合議 ${rules.panels.parliament.seats}席`);
  return lines.join(' / ');
}
