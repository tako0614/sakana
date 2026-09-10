import { canonicalJson, sha256 } from './policy.js';
import { validateHumanAuthority } from './human-authority.js';

export const AUTHORITY_SCHEMA = 'sakana.constitution/v2';
export const EFFECTIVE_SCHEMA = 'sakana.legal-system/v2';
export const DEFINITION_KINDS = Object.freeze(['institution', 'procedure', 'regulation', 'binding']);
export const PROCEDURAL_ACTIONS = Object.freeze([
  'parliament_agenda', 'legislation_draft', 'law_enactment', 'ai_ratification', 'police_review', 'case_filing', 'defense_window',
  'judicial_panel', 'constitutional_panel', 'contest_window', 'appeal_window',
  'sanction_execution', 'public_vote', 'human_approval', 'agent_task', 'notice', 'wait', 'terminal'
]);
export const LEGAL_TOOLS = Object.freeze([
  'read_case_record', 'read_cases', 'read_channel', 'read_constitution', 'read_context',
  'read_law', 'read_precedent', 'read_user_messages', 'search_messages'
]);
export const WAITING_ACTIONS = Object.freeze(['wait', 'defense_window', 'appeal_window', 'contest_window', 'public_vote', 'human_approval']);
const ID = /^[a-z][a-zA-Z0-9_-]{0,79}$/;

function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label}: object required`);
  return value;
}
function keys(value, required, optional, label) {
  object(value, label);
  if (required.some((key) => !(key in value)) || Object.keys(value).some((key) => ![...required, ...optional].includes(key))) {
    throw new Error(`${label}: unexpected or missing fields`);
  }
}
function id(value, label) {
  if (typeof value !== 'string' || !ID.test(value) || ['__proto__', 'constructor', 'prototype'].includes(value)) throw new Error(`${label}: invalid identifier`);
}
function text(value, label, max = 8000) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`${label}: invalid text`);
}
function integer(value, label, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${label}: invalid integer`);
}
export function legalDuration(value) {
  if (value === 'immediate') return 0;
  const match = /^(\d+)(m|h|d)$/.exec(value);
  const ms = match ? Number(match[1]) * ({ m: 60000, h: 3600000, d: 86400000 })[match[2]] : NaN;
  if (!Number.isSafeInteger(ms) || ms <= 0 || ms > 365 * 86400000) throw new Error(`invalid legal duration: ${value}`);
  return ms;
}

export function validateAuthority(value) {
  keys(value, ['$schema', 'delegations', 'amendment'], ['recovery'], 'constitution authority');
  if (value.$schema !== AUTHORITY_SCHEMA) throw new Error('unsupported constitutional authority schema');
  if (!Array.isArray(value.delegations) || !value.delegations.length || new Set(value.delegations).size !== value.delegations.length) throw new Error('invalid constitutional delegations');
  for (const delegation of value.delegations) {
    if (!DEFINITION_KINDS.includes(delegation)) throw new Error(`unknown constitutional delegation: ${delegation}`);
  }
  keys(value.amendment, ['mode', 'minimumSeats', 'minimumApprovalRatio', 'publicVote', 'minimumPublicApprovalRatio'], [], 'amendment authority');
  if (value.amendment.mode !== 'procedure' || !['required', 'optional'].includes(value.amendment.publicVote)) throw new Error('invalid constitutional amendment authority');
  if (!(value.amendment.minimumPublicApprovalRatio > 0.5 && value.amendment.minimumPublicApprovalRatio <= 1)) throw new Error('invalid public amendment majority');
  integer(value.amendment.minimumSeats, 'amendment minimum seats', 1, 5);
  if (!Number.isFinite(value.amendment.minimumApprovalRatio) || value.amendment.minimumApprovalRatio <= 0.5 || value.amendment.minimumApprovalRatio > 1) throw new Error('invalid amendment majority');
  if (value.recovery !== undefined) {
    keys(value.recovery, ['mode', 'publicVote', 'minimumVoteDuration'], [], 'recovery authority');
    if (value.recovery.mode !== 'last_valid_amendment_procedure' || value.recovery.publicVote !== 'required'
      || value.amendment.publicVote !== 'required' || legalDuration(value.recovery.minimumVoteDuration) === 0) throw new Error('invalid constitutional recovery authority');
  }
  return value;
}

export function validateInstitution(value) {
  keys(value, ['name', 'mandate', 'seats', 'required', 'tools'], [], 'institution');
  text(value.name, 'institution name', 100);
  text(value.mandate, 'institution mandate');
  integer(value.seats, 'institution seats', 1, 5);
  object(value.required, 'decision thresholds');
  if (!Object.keys(value.required).length) throw new Error('institution requires decision thresholds');
  for (const [outcome, count] of Object.entries(value.required)) {
    id(outcome, 'decision outcome');
    if (!['decision', 'responsible', 'constitutional', 'unconstitutional', 'approve', 'record', 'propose'].includes(outcome)) throw new Error('unimplemented institution decision');
    integer(count, 'decision threshold', 1, value.seats);
  }
  if (value.required.constitutional && value.required.unconstitutional
    && value.required.constitutional + value.required.unconstitutional <= value.seats) throw new Error('constitutional decision thresholds can conflict');
  if (!Array.isArray(value.tools) || new Set(value.tools).size !== value.tools.length || value.tools.some((tool) => !LEGAL_TOOLS.includes(tool))) throw new Error('institution requests unimplemented tools');
  return value;
}

export function validateLegalProcedure(value) {
  keys(value, ['name', 'mandate', 'initial', 'states', 'config'], ['trigger'], 'procedure');
  text(value.name, 'procedure name', 100);
  text(value.mandate, 'procedure mandate');
  object(value.config, 'procedure config');
  object(value.states, 'procedure states');
  if (!Object.hasOwn(value.states, value.initial)) throw new Error('procedure has no initial state');
  if (Object.keys(value.states).length > 50) throw new Error('procedure exceeds technical state limit');
  for (const [name, state] of Object.entries(value.states)) {
    id(name, 'state');
    keys(state, ['handler', 'duration', 'config', 'on'], [], 'procedure state');
    if (!PROCEDURAL_ACTIONS.includes(state.handler)) throw new Error(`unimplemented procedural action: ${state.handler}`);
    object(state.config, 'state config');
    const allowedConfig = ['phase', 'maximumVisits', ...({
      parliament_agenda: ['institution'], police_review: ['institution'], judicial_panel: ['institution'],
      constitutional_panel: ['institution'], ai_ratification: ['institution'], agent_task: ['institution', 'effect'],
      notice: ['text'], human_approval: ['scope', 'users', 'roles', 'veto', 'rejectVotes', 'excludeParties']
    }[state.handler] ?? [])];
    if (Object.keys(state.config).some((key) => !allowedConfig.includes(key))) throw new Error('unimplemented state configuration');
    object(state.on, 'state outcomes');
    if (state.duration !== null) legalDuration(state.duration);
    if (!WAITING_ACTIONS.includes(state.handler) && state.duration !== null) throw new Error('operation durations require an explicit wait state');
    if (state.config.maximumVisits !== undefined) {
      integer(state.config.maximumVisits, 'maximum visits', 1, 100);
      if (['terminal', 'sanction_execution', ...WAITING_ACTIONS].includes(state.handler)) throw new Error('maximumVisits is only available for completed operations');
      if (!state.on.exhausted || value.states[state.on.exhausted]?.handler !== 'terminal') throw new Error('bounded retry requires a terminal exhausted outcome');
    }
    if (state.config.institution !== undefined) id(state.config.institution, 'acting institution');
    for (const [outcome, target] of Object.entries(state.on)) {
      id(outcome, 'outcome');
      if (!Object.hasOwn(value.states, target)) throw new Error('procedure references a missing state');
    }
    if (state.handler === 'terminal' && (Object.keys(state.on).length || state.duration !== null)) throw new Error('terminal procedure state must end');
    if (WAITING_ACTIONS.includes(state.handler)
      && (state.duration === null || legalDuration(state.duration) === 0)) throw new Error('waiting state requires a positive legal duration');
    if (state.handler === 'wait' && !state.on.expired) throw new Error('legal wait requires an expired outcome');
    if (state.handler === 'agent_task') {
      if (!['record', 'propose'].includes(state.config.effect)) throw new Error('agent task requests an unimplemented effect');
      if (!state.config.institution) throw new Error('agent task needs a legal institution');
    }
    if (state.handler === 'human_approval') {
      keys(state.config, ['phase', 'scope', 'rejectVotes', 'excludeParties'], ['users', 'roles', 'veto'], 'approval config');
      const { phase, rejectVotes, excludeParties, veto, ...authority } = state.config;
      validateHumanAuthority(authority);
      if (excludeParties !== true) throw new Error('invalid approval eligibility');
      if (veto !== undefined && veto !== null) validateHumanAuthority(veto, { veto: true });
      integer(state.config.rejectVotes, 'approval rejection threshold', 0, 100);
      if (!state.on.expired || !state.on.rejected) throw new Error('approval needs expiry and rejection outcomes');
    }
  }
  const reachable = new Set();
  const visit = (state) => {
    if (reachable.has(state)) return;
    reachable.add(state);
    Object.values(value.states[state].on).forEach(visit);
  };
  visit(value.initial);
  for (const property of ['reopen', 'interruptions']) {
    if (!value.config[property]) continue;
    object(value.config[property], property);
    for (const target of Object.values(value.config[property])) {
      if (!value.states[target]) throw new Error(`unknown ${property} target`);
      visit(target);
    }
  }
  if (reachable.size !== Object.keys(value.states).length) throw new Error('procedure contains unreachable states');
  if (![...reachable].some((name) => value.states[name].handler === 'terminal')) throw new Error('procedure cannot finish');
  // A finite legal retry count or a persisted wait is required on every cycle.
  const bounded = new Set();
  const checking = new Set();
  const checkCycle = (name) => {
    if (bounded.has(name)) return;
    const state = value.states[name];
    if (WAITING_ACTIONS.includes(state.handler) && state.duration !== null && legalDuration(state.duration) > 0) return;
    if (state.config.maximumVisits !== undefined) {
      integer(state.config.maximumVisits, 'maximum visits', 1, 100);
      if (!state.on.exhausted || value.states[state.on.exhausted].handler !== 'terminal') throw new Error('bounded retry requires a terminal exhausted outcome');
      return;
    }
    if (checking.has(name)) throw new Error('unbounded procedural cycle');
    checking.add(name);
    Object.values(state.on).forEach(checkCycle);
    checking.delete(name);
    bounded.add(name);
  };
  Object.keys(value.states).forEach(checkCycle);
  if (value.trigger) {
    keys(value.trigger, ['event'], ['interval'], 'procedure trigger');
    if (!['schedule', 'petition', 'law_enacted'].includes(value.trigger.event)) throw new Error('unimplemented procedure trigger');
    if (value.trigger.event === 'schedule' && (!value.trigger.interval || legalDuration(value.trigger.interval) < 3600000)) throw new Error('scheduled procedure requires an interval of at least one hour');
  }
  return value;
}

export function validateLegalDefinitions(definitions, articles) {
  if (!Array.isArray(definitions) || definitions.length > 100) throw new Error('invalid legal definitions');
  const articleIds = new Set(articles.map((entry) => entry.code));
  const found = new Set();
  for (const definition of definitions) {
    keys(definition, ['kind', 'key', 'article', 'value'], [], 'legal definition');
    if (!DEFINITION_KINDS.includes(definition.kind)) throw new Error('unknown legal definition kind');
    id(definition.key, 'legal definition key');
    if (!articleIds.has(definition.article)) throw new Error('legal definition needs an article in the same law');
    const key = `${definition.kind}:${definition.key}`;
    if (found.has(key)) throw new Error(`duplicate legal definition: ${key}`);
    found.add(key);
    if (definition.kind === 'institution') validateInstitution(definition.value);
    if (definition.kind === 'procedure') validateLegalProcedure(definition.value);
    if (definition.kind === 'regulation') {
      if (!['records', 'parliament', 'investigation', 'sanctions', 'votes'].includes(definition.key)) throw new Error('unimplemented regulation domain');
      object(definition.value, 'regulation');
    }
    if (definition.kind === 'binding') {
      keys(definition.value, ['kind', 'target'], [], 'binding');
      if (!['institution', 'procedure'].includes(definition.value.kind)) throw new Error('binding must select an institution or procedure');
      id(definition.value.target, 'binding target');
    }
  }
  return definitions;
}

export function composeLegalSystem(authority, laws) {
  validateAuthority(authority);
  const groups = Object.fromEntries(DEFINITION_KINDS.map((kind) => [kind, Object.create(null)]));
  const sources = Object.create(null);
  for (const law of laws) {
    const definitions = law.provisions?.governance ?? [];
    validateLegalDefinitions(definitions, law.provisions?.articles ?? []);
    for (const entry of definitions) {
      if (!authority.delegations.includes(entry.kind)) throw new Error(`constitution did not delegate ${entry.kind}`);
      const key = `${entry.kind}:${entry.key}`;
      if (sources[key]) throw new Error(`conflicting enacted definitions: ${key}; amend its owning law`);
      groups[entry.kind][entry.key] = structuredClone(entry.value);
      sources[key] = { lawId: law.id ?? null, code: law.code, version: law.version ?? 1, article: entry.article, hash: law.content_hash ?? sha256(canonicalJson(law)) };
    }
  }
  for (const binding of Object.values(groups.binding)) {
    if (!groups[binding.kind][binding.target]) throw new Error(`binding target does not exist: ${binding.target}`);
  }
  for (const procedure of Object.values(groups.procedure)) {
    for (const state of Object.values(procedure.states)) {
      if (state.config.institution && !groups.institution[state.config.institution]) throw new Error('procedure requests an institution that is not established');
      const required = { ai_ratification: ['approve'], constitutional_panel: ['constitutional', 'unconstitutional'], judicial_panel: ['responsible'], police_review: ['responsible'] }[state.handler];
      if (required?.some((outcome) => !Number.isInteger(groups.institution[state.config.institution]?.required[outcome]))) throw new Error('acting institution lacks required outcome thresholds');
    }
  }
  const select = (role, kind) => {
    const binding = groups.binding[role];
    if (!binding || binding.kind !== kind) throw new Error(`missing legal binding: ${role}`);
    return groups[kind][binding.target];
  };
  const panels = Object.fromEntries(['parliament', 'constitutional', 'court', 'police', 'judicialScreening', 'adoption', 'amendmentAdoption'].map((role) => [role, select(role, 'institution')]));
  if (panels.amendmentAdoption.seats < authority.amendment.minimumSeats
    || panels.amendmentAdoption.required.approve / panels.amendmentAdoption.seats < authority.amendment.minimumApprovalRatio) throw new Error('ordinary law weakens constitutional amendment requirements');
  const workflows = Object.fromEntries(['law', 'constitutionalAmendment', 'criminalCase', 'constitutionalCase'].map((role) => [role, select(role, 'procedure')]));
  for (const [role, procedure] of Object.entries(workflows)) {
    const operations = {
      law: ['parliament_agenda', 'legislation_draft', 'ai_ratification', 'constitutional_panel', 'public_vote', 'law_enactment'],
      constitutionalAmendment: ['parliament_agenda', 'legislation_draft', 'ai_ratification', 'constitutional_panel', 'public_vote', 'law_enactment'],
      criminalCase: ['police_review', 'case_filing', 'defense_window', 'judicial_panel', 'human_approval', 'appeal_window', 'sanction_execution', 'contest_window'],
      constitutionalCase: ['case_filing', 'defense_window', 'constitutional_panel']
    }[role];
    if (Object.values(procedure.states).some((state) => ![...operations, 'notice', 'wait', 'terminal'].includes(state.handler))) throw new Error('procedure uses an operation unavailable for its subject');
    const handlers = new Set(Object.values(procedure.states).map((state) => state.handler));
    if (['law', 'constitutionalAmendment'].includes(role)) {
      for (const handler of ['legislation_draft', 'ai_ratification', 'constitutional_panel', 'law_enactment']) if (!handlers.has(handler)) throw new Error(`legislation requires ${handler}`);
      if (role === 'constitutionalAmendment') {
        if (authority.amendment.publicVote === 'required' && !handlers.has('public_vote')) throw new Error('constitution requires public amendment voting');
        for (const state of Object.values(procedure.states).filter((state) => state.handler === 'ai_ratification')) {
          const institution = groups.institution[state.config.institution];
          if (institution.seats < authority.amendment.minimumSeats || institution.required.approve / institution.seats < authority.amendment.minimumApprovalRatio) throw new Error('amendment procedure weakens constitutional adoption');
        }
      }
    }
  }
  for (const procedure of Object.values(groups.procedure).filter((entry) => entry.trigger)) {
    if (Object.values(procedure.states).some((state) => !['agent_task', 'notice', 'wait', 'terminal'].includes(state.handler))) throw new Error('triggered procedure requests an unavailable effect');
  }
  const requiredRegulations = ['records', 'parliament', 'investigation', 'sanctions', 'votes'];
  for (const key of requiredRegulations) if (!groups.regulation[key]) throw new Error(`missing enacted regulation: ${key}`);
  if (groups.regulation.votes.constitutionalAmendment.yesRatio < authority.amendment.minimumPublicApprovalRatio) throw new Error('ordinary law weakens constitutional public vote');
  return {
    $schema: EFFECTIVE_SCHEMA,
    authority: structuredClone(authority),
    institutions: groups.institution,
    procedures: groups.procedure,
    bindings: groups.binding,
    sources,
    panels,
    workflows,
    ...groups.regulation,
    lawVersions: laws.map((law) => ({ id: law.id ?? null, code: law.code, hash: law.content_hash ?? sha256(canonicalJson(law)) }))
  };
}
