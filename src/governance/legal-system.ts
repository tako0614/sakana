import { canonicalJson, sha256 } from './policy.js';
import { validateHumanAuthority } from './human-authority.js';
import {
  isArray,
  isRecord,
  oneOf,
  type ConstitutionalAuthority,
  type DefinitionKind,
  type EffectiveLegalSystem,
  type Institution,
  type LawInput,
  type LegalBinding,
  type LegalProcedure,
  type LegalSource,
  type ProcedureState,
  type UnknownRecord,
  type WorkflowKey
} from './types.js';

export const AUTHORITY_SCHEMA = 'sakana.constitution/v2';
export const EFFECTIVE_SCHEMA = 'sakana.legal-system/v2';
export const DEFINITION_KINDS: readonly DefinitionKind[] = Object.freeze(['institution', 'procedure', 'regulation', 'binding']);
export const PROCEDURAL_ACTIONS: readonly string[] = Object.freeze([
  'parliament_agenda', 'legislation_draft', 'law_enactment', 'ai_ratification', 'police_review', 'case_filing', 'defense_window',
  'judicial_panel', 'constitutional_panel', 'contest_window', 'appeal_window',
  'sanction_execution', 'public_vote', 'human_approval', 'agent_task', 'notice', 'wait', 'terminal'
]);
export const LEGAL_TOOLS: readonly string[] = Object.freeze([
  'read_case_record', 'read_cases', 'read_channel', 'read_constitution', 'read_context',
  'read_law', 'read_precedent', 'read_user_messages', 'search_messages'
]);
export const WAITING_ACTIONS: readonly string[] = Object.freeze(['wait', 'defense_window', 'appeal_window', 'contest_window', 'public_vote', 'human_approval']);
const ID = /^[a-z][a-zA-Z0-9_-]{0,79}$/;

// 処理ごとに state.config で書ける項目。phase と maximumVisits はどの処理でも書ける。
const HANDLER_CONFIG: Readonly<Record<string, readonly string[]>> = {
  parliament_agenda: ['institution'], police_review: ['institution'], judicial_panel: ['institution'],
  constitutional_panel: ['institution'], ai_ratification: ['institution'], agent_task: ['institution', 'effect'],
  notice: ['text'], human_approval: ['scope', 'users', 'roles', 'veto', 'rejectVotes', 'excludeParties']
};

function object(value: unknown, label: string): asserts value is UnknownRecord {
  if (!isRecord(value)) throw new Error(`${label}: object required`);
}
function keys(value: unknown, required: readonly string[], optional: readonly string[], label: string): asserts value is UnknownRecord {
  object(value, label);
  if (required.some((key) => !(key in value)) || Object.keys(value).some((key) => ![...required, ...optional].includes(key))) {
    throw new Error(`${label}: unexpected or missing fields`);
  }
}
function id(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !ID.test(value) || ['__proto__', 'constructor', 'prototype'].includes(value)) throw new Error(`${label}: invalid identifier`);
}
function text(value: unknown, label: string, max = 8000): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`${label}: invalid text`);
}
function integer(value: unknown, label: string, min: number, max: number): asserts value is number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) throw new Error(`${label}: invalid integer`);
}

const DURATION_UNITS: Readonly<Record<string, number>> = { m: 60000, h: 3600000, d: 86400000 };

export function legalDuration(value: unknown): number {
  if (value === 'immediate') return 0;
  const match = /^(\d+)(m|h|d)$/.exec(String(value));
  const unit = match ? DURATION_UNITS[match[2] ?? ''] : undefined;
  const ms = match && unit !== undefined ? Number(match[1]) * unit : NaN;
  if (!Number.isSafeInteger(ms) || ms <= 0 || ms > 365 * 86400000) throw new Error(`invalid legal duration: ${String(value)}`);
  return ms;
}

export function validateAuthority(value: unknown): ConstitutionalAuthority {
  assertAuthority(value);
  return value;
}

function assertAuthority(value: unknown): asserts value is ConstitutionalAuthority {
  keys(value, ['$schema', 'delegations', 'amendment'], ['recovery'], 'constitution authority');
  if (value.$schema !== AUTHORITY_SCHEMA) throw new Error('unsupported constitutional authority schema');
  const delegations = value.delegations;
  if (!isArray(delegations) || !delegations.length || new Set(delegations).size !== delegations.length) throw new Error('invalid constitutional delegations');
  for (const delegation of delegations) {
    if (!oneOf(DEFINITION_KINDS, delegation)) throw new Error(`unknown constitutional delegation: ${String(delegation)}`);
  }
  const amendment = value.amendment;
  keys(amendment, ['mode', 'minimumSeats', 'minimumApprovalRatio', 'publicVote', 'minimumPublicApprovalRatio'], [], 'amendment authority');
  if (amendment.mode !== 'procedure' || (amendment.publicVote !== 'required' && amendment.publicVote !== 'optional')) throw new Error('invalid constitutional amendment authority');
  // 比較は旧来どおり JavaScript の数値変換で行う (保存済みの憲法の解釈を変えない)。
  const publicRatio = Number(amendment.minimumPublicApprovalRatio);
  if (!(publicRatio > 0.5 && publicRatio <= 1)) throw new Error('invalid public amendment majority');
  integer(amendment.minimumSeats, 'amendment minimum seats', 1, 5);
  const approvalRatio = amendment.minimumApprovalRatio;
  if (typeof approvalRatio !== 'number' || !Number.isFinite(approvalRatio) || approvalRatio <= 0.5 || approvalRatio > 1) throw new Error('invalid amendment majority');
  if (value.recovery !== undefined) {
    const recovery = value.recovery;
    keys(recovery, ['mode', 'publicVote', 'minimumVoteDuration'], [], 'recovery authority');
    if (recovery.mode !== 'last_valid_amendment_procedure' || recovery.publicVote !== 'required'
      || amendment.publicVote !== 'required' || legalDuration(recovery.minimumVoteDuration) === 0) throw new Error('invalid constitutional recovery authority');
  }
}

export function validateInstitution(value: unknown): Institution {
  assertInstitution(value);
  return value;
}

function assertInstitution(value: unknown): asserts value is Institution {
  keys(value, ['name', 'mandate', 'seats', 'required', 'tools'], [], 'institution');
  text(value.name, 'institution name', 100);
  text(value.mandate, 'institution mandate');
  const seats = value.seats;
  integer(seats, 'institution seats', 1, 5);
  const required = value.required;
  object(required, 'decision thresholds');
  if (!Object.keys(required).length) throw new Error('institution requires decision thresholds');
  for (const [outcome, count] of Object.entries(required)) {
    id(outcome, 'decision outcome');
    if (!['decision', 'responsible', 'constitutional', 'unconstitutional', 'approve', 'record', 'propose'].includes(outcome)) throw new Error('unimplemented institution decision');
    integer(count, 'decision threshold', 1, seats);
  }
  // 上の検査で、required の値はすべて整数。
  if (required.constitutional && required.unconstitutional
    && Number(required.constitutional) + Number(required.unconstitutional) <= seats) throw new Error('constitutional decision thresholds can conflict');
  const tools = value.tools;
  if (!isArray(tools) || new Set(tools).size !== tools.length || tools.some((tool) => !oneOf(LEGAL_TOOLS, tool))) throw new Error('institution requests unimplemented tools');
}

export function validateLegalProcedure(value: unknown): LegalProcedure {
  assertLegalProcedure(value);
  return value;
}

/** 名前の state の handler。無い名前は undefined (旧来の value.states[name]?.handler と同じ)。 */
function stateHandler(states: UnknownRecord, name: unknown): unknown {
  const state = typeof name === 'string' ? states[name] : undefined;
  return isRecord(state) ? state.handler : undefined;
}

function assertLegalProcedure(value: unknown): asserts value is LegalProcedure {
  keys(value, ['name', 'mandate', 'initial', 'states', 'config'], ['trigger'], 'procedure');
  text(value.name, 'procedure name', 100);
  text(value.mandate, 'procedure mandate');
  const config = value.config;
  object(config, 'procedure config');
  const rawStates = value.states;
  object(rawStates, 'procedure states');
  const initial = value.initial;
  if (typeof initial !== 'string' || !Object.hasOwn(rawStates, initial)) throw new Error('procedure has no initial state');
  if (Object.keys(rawStates).length > 50) throw new Error('procedure exceeds technical state limit');
  for (const [name, state] of Object.entries(rawStates)) {
    id(name, 'state');
    keys(state, ['handler', 'duration', 'config', 'on'], [], 'procedure state');
    const handler = state.handler;
    if (!oneOf(PROCEDURAL_ACTIONS, handler)) throw new Error(`unimplemented procedural action: ${String(handler)}`);
    const stateConfig = state.config;
    object(stateConfig, 'state config');
    const allowedConfig = ['phase', 'maximumVisits', ...(HANDLER_CONFIG[handler] ?? [])];
    if (Object.keys(stateConfig).some((key) => !allowedConfig.includes(key))) throw new Error('unimplemented state configuration');
    const on = state.on;
    object(on, 'state outcomes');
    if (state.duration !== null) legalDuration(state.duration);
    if (!WAITING_ACTIONS.includes(handler) && state.duration !== null) throw new Error('operation durations require an explicit wait state');
    if (stateConfig.maximumVisits !== undefined) {
      integer(stateConfig.maximumVisits, 'maximum visits', 1, 100);
      if (['terminal', 'sanction_execution', ...WAITING_ACTIONS].includes(handler)) throw new Error('maximumVisits is only available for completed operations');
      if (!on.exhausted || stateHandler(rawStates, on.exhausted) !== 'terminal') throw new Error('bounded retry requires a terminal exhausted outcome');
    }
    if (stateConfig.institution !== undefined) id(stateConfig.institution, 'acting institution');
    for (const [outcome, target] of Object.entries(on)) {
      id(outcome, 'outcome');
      if (typeof target !== 'string' || !Object.hasOwn(rawStates, target)) throw new Error('procedure references a missing state');
    }
    if (handler === 'terminal' && (Object.keys(on).length || state.duration !== null)) throw new Error('terminal procedure state must end');
    if (WAITING_ACTIONS.includes(handler)
      && (state.duration === null || legalDuration(state.duration) === 0)) throw new Error('waiting state requires a positive legal duration');
    if (handler === 'wait' && !on.expired) throw new Error('legal wait requires an expired outcome');
    if (handler === 'agent_task') {
      if (stateConfig.effect !== 'record' && stateConfig.effect !== 'propose') throw new Error('agent task requests an unimplemented effect');
      if (!stateConfig.institution) throw new Error('agent task needs a legal institution');
    }
    if (handler === 'human_approval') {
      keys(stateConfig, ['phase', 'scope', 'rejectVotes', 'excludeParties'], ['users', 'roles', 'veto'], 'approval config');
      const { phase: _phase, rejectVotes: _rejectVotes, excludeParties, veto, ...authority } = stateConfig;
      validateHumanAuthority(authority);
      if (excludeParties !== true) throw new Error('invalid approval eligibility');
      if (veto !== undefined && veto !== null) validateHumanAuthority(veto, { veto: true });
      integer(stateConfig.rejectVotes, 'approval rejection threshold', 0, 100);
      if (!on.expired || !on.rejected) throw new Error('approval needs expiry and rejection outcomes');
    }
  }
  // 上の検査で、各 state が handler・duration・config・on (既存 state への遷移) を持つことを確かめた。
  const states = rawStates as Record<string, ProcedureState>;
  const stateNamed = (name: string): ProcedureState => {
    const state = states[name];
    if (!state) throw new Error('procedure references a missing state');
    return state;
  };
  const reachable = new Set<string>();
  const visit = (state: string): void => {
    if (reachable.has(state)) return;
    reachable.add(state);
    Object.values(stateNamed(state).on).forEach(visit);
  };
  visit(initial);
  for (const property of ['reopen', 'interruptions']) {
    const targets = config[property];
    if (!targets) continue;
    object(targets, property);
    for (const target of Object.values(targets)) {
      if (typeof target !== 'string' || !states[target]) throw new Error(`unknown ${property} target`);
      visit(target);
    }
  }
  if (reachable.size !== Object.keys(states).length) throw new Error('procedure contains unreachable states');
  if (![...reachable].some((name) => stateNamed(name).handler === 'terminal')) throw new Error('procedure cannot finish');
  // A finite legal retry count or a persisted wait is required on every cycle.
  const bounded = new Set<string>();
  const checking = new Set<string>();
  const checkCycle = (name: string): void => {
    if (bounded.has(name)) return;
    const state = stateNamed(name);
    if (WAITING_ACTIONS.includes(state.handler) && state.duration !== null && legalDuration(state.duration) > 0) return;
    if (state.config.maximumVisits !== undefined) {
      integer(state.config.maximumVisits, 'maximum visits', 1, 100);
      if (!state.on.exhausted || stateNamed(state.on.exhausted).handler !== 'terminal') throw new Error('bounded retry requires a terminal exhausted outcome');
      return;
    }
    if (checking.has(name)) throw new Error('unbounded procedural cycle');
    checking.add(name);
    Object.values(state.on).forEach(checkCycle);
    checking.delete(name);
    bounded.add(name);
  };
  Object.keys(states).forEach(checkCycle);
  if (value.trigger) {
    const trigger = value.trigger;
    keys(trigger, ['event'], ['interval'], 'procedure trigger');
    if (trigger.event !== 'schedule' && trigger.event !== 'petition' && trigger.event !== 'law_enacted') throw new Error('unimplemented procedure trigger');
    if (trigger.event === 'schedule' && (!trigger.interval || legalDuration(trigger.interval) < 3600000)) throw new Error('scheduled procedure requires an interval of at least one hour');
  }
}

/** 検査済みの法令定義。kind ごとに value の形が決まる。 */
export type ValidatedDefinition =
  | { kind: 'institution'; key: string; article: string; value: Institution }
  | { kind: 'procedure'; key: string; article: string; value: LegalProcedure }
  | { kind: 'regulation'; key: string; article: string; value: UnknownRecord }
  | { kind: 'binding'; key: string; article: string; value: LegalBinding };

export function validateLegalDefinitions(definitions: unknown, articles: unknown): ValidatedDefinition[] {
  assertLegalDefinitions(definitions, articles);
  return definitions;
}

function articleCodes(articles: unknown): Set<unknown> {
  // 旧来どおり、条の一覧が配列でなければ (null の条を含めて) 法令として読めない。
  if (!isArray(articles)) throw new Error('invalid law articles');
  return new Set(articles.map((entry) => {
    if (entry === null || entry === undefined) throw new Error('invalid law article');
    return isRecord(entry) ? entry.code : undefined;
  }));
}

function assertLegalDefinitions(definitions: unknown, articles: unknown): asserts definitions is ValidatedDefinition[] {
  if (!isArray(definitions) || definitions.length > 100) throw new Error('invalid legal definitions');
  const articleIds = articleCodes(articles);
  const found = new Set<string>();
  for (const definition of definitions) {
    keys(definition, ['kind', 'key', 'article', 'value'], [], 'legal definition');
    if (!oneOf(DEFINITION_KINDS, definition.kind)) throw new Error('unknown legal definition kind');
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
      const binding = definition.value;
      keys(binding, ['kind', 'target'], [], 'binding');
      if (binding.kind !== 'institution' && binding.kind !== 'procedure') throw new Error('binding must select an institution or procedure');
      id(binding.target, 'binding target');
    }
  }
}

/** 法令を組み立てた直後の法体系。規制 (regulation) の中身は compileLegalSystem が検査する。 */
export interface ComposedLegalSystem extends Omit<EffectiveLegalSystem, 'records' | 'parliament' | 'investigation' | 'sanctions' | 'votes'> {
  records: UnknownRecord;
  parliament: UnknownRecord;
  investigation: UnknownRecord;
  sanctions: UnknownRecord;
  votes: UnknownRecord;
}

const REGULATION_KEYS = ['records', 'parliament', 'investigation', 'sanctions', 'votes'] as const;
// 判断する処理は、行う機関に結論ごとの必要票を求める。
const REQUIRED_OUTCOMES: Readonly<Record<string, readonly string[]>> = {
  ai_ratification: ['approve'], constitutional_panel: ['constitutional', 'unconstitutional'], judicial_panel: ['responsible'], police_review: ['responsible']
};
const WORKFLOW_ROLES: readonly WorkflowKey[] = ['law', 'constitutionalAmendment', 'criminalCase', 'constitutionalCase'];
const WORKFLOW_OPERATIONS: Readonly<Record<WorkflowKey, readonly string[]>> = {
  law: ['parliament_agenda', 'legislation_draft', 'ai_ratification', 'constitutional_panel', 'public_vote', 'law_enactment'],
  constitutionalAmendment: ['parliament_agenda', 'legislation_draft', 'ai_ratification', 'constitutional_panel', 'public_vote', 'law_enactment'],
  criminalCase: ['police_review', 'case_filing', 'defense_window', 'judicial_panel', 'human_approval', 'appeal_window', 'sanction_execution', 'contest_window'],
  constitutionalCase: ['case_filing', 'defense_window', 'constitutional_panel']
};

// prototype を持たない入れ物。法令のキーが Object.prototype の名前と衝突しない。
function emptyRecord<T>(): Record<string, T> {
  const record: Record<string, T> = Object.create(null);
  return record;
}

export function composeLegalSystem(authorityInput: unknown, laws: readonly LawInput[]): ComposedLegalSystem {
  const authority = validateAuthority(authorityInput);
  const groups = {
    institution: emptyRecord<Institution>(),
    procedure: emptyRecord<LegalProcedure>(),
    regulation: emptyRecord<UnknownRecord>(),
    binding: emptyRecord<LegalBinding>()
  };
  const sources = emptyRecord<LegalSource>();
  for (const law of laws) {
    const definitions = validateLegalDefinitions(law.provisions?.governance ?? [], law.provisions?.articles ?? []);
    for (const entry of definitions) {
      if (!authority.delegations.includes(entry.kind)) throw new Error(`constitution did not delegate ${entry.kind}`);
      const key = `${entry.kind}:${entry.key}`;
      if (sources[key]) throw new Error(`conflicting enacted definitions: ${key}; amend its owning law`);
      switch (entry.kind) {
        case 'institution': groups.institution[entry.key] = structuredClone(entry.value); break;
        case 'procedure': groups.procedure[entry.key] = structuredClone(entry.value); break;
        case 'regulation': groups.regulation[entry.key] = structuredClone(entry.value); break;
        case 'binding': groups.binding[entry.key] = structuredClone(entry.value); break;
      }
      sources[key] = { lawId: law.id ?? null, code: law.code, version: law.version ?? 1, article: entry.article, hash: law.content_hash ?? sha256(canonicalJson(law)) };
    }
  }
  for (const binding of Object.values(groups.binding)) {
    if (!groups[binding.kind][binding.target]) throw new Error(`binding target does not exist: ${binding.target}`);
  }
  // 旧来どおり、機関名は JavaScript のキー変換で引く (未設定は 'undefined' という名前として探す)。
  const institutionNamed = (name: string | undefined): Institution | undefined => groups.institution[String(name)];
  for (const procedure of Object.values(groups.procedure)) {
    for (const state of Object.values(procedure.states)) {
      if (state.config.institution && !groups.institution[state.config.institution]) throw new Error('procedure requests an institution that is not established');
      const required = REQUIRED_OUTCOMES[state.handler];
      if (required?.some((outcome) => !Number.isInteger(institutionNamed(state.config.institution)?.required[outcome]))) throw new Error('acting institution lacks required outcome thresholds');
    }
  }
  const selectBinding = (role: string, kind: LegalBinding['kind']): string => {
    const binding = groups.binding[role];
    if (!binding || binding.kind !== kind) throw new Error(`missing legal binding: ${role}`);
    return binding.target;
  };
  // binding の行き先が存在することは上で確かめた。
  const selectInstitution = (role: string): Institution => {
    const target = selectBinding(role, 'institution');
    const institution = groups.institution[target];
    if (!institution) throw new Error(`binding target does not exist: ${target}`);
    return institution;
  };
  const selectProcedure = (role: string): LegalProcedure => {
    const target = selectBinding(role, 'procedure');
    const procedure = groups.procedure[target];
    if (!procedure) throw new Error(`binding target does not exist: ${target}`);
    return procedure;
  };
  const panels = {
    parliament: selectInstitution('parliament'), constitutional: selectInstitution('constitutional'), court: selectInstitution('court'),
    police: selectInstitution('police'), judicialScreening: selectInstitution('judicialScreening'),
    adoption: selectInstitution('adoption'), amendmentAdoption: selectInstitution('amendmentAdoption')
  };
  if (panels.amendmentAdoption.seats < authority.amendment.minimumSeats
    || Number(panels.amendmentAdoption.required.approve) / panels.amendmentAdoption.seats < authority.amendment.minimumApprovalRatio) throw new Error('ordinary law weakens constitutional amendment requirements');
  const workflows = {
    law: selectProcedure('law'), constitutionalAmendment: selectProcedure('constitutionalAmendment'),
    criminalCase: selectProcedure('criminalCase'), constitutionalCase: selectProcedure('constitutionalCase')
  };
  for (const role of WORKFLOW_ROLES) {
    const procedure = workflows[role];
    const operations = WORKFLOW_OPERATIONS[role];
    if (Object.values(procedure.states).some((state) => ![...operations, 'notice', 'wait', 'terminal'].includes(state.handler))) throw new Error('procedure uses an operation unavailable for its subject');
    const handlers = new Set(Object.values(procedure.states).map((state) => state.handler));
    if (role === 'law' || role === 'constitutionalAmendment') {
      for (const handler of ['legislation_draft', 'ai_ratification', 'constitutional_panel', 'law_enactment']) if (!handlers.has(handler)) throw new Error(`legislation requires ${handler}`);
      if (role === 'constitutionalAmendment') {
        if (authority.amendment.publicVote === 'required' && !handlers.has('public_vote')) throw new Error('constitution requires public amendment voting');
        for (const state of Object.values(procedure.states).filter((entry) => entry.handler === 'ai_ratification')) {
          // ai_ratification の機関が approve の必要票を持つことは上で確かめた。
          const institution = institutionNamed(state.config.institution);
          if (!institution) throw new Error('procedure requests an institution that is not established');
          if (institution.seats < authority.amendment.minimumSeats || Number(institution.required.approve) / institution.seats < authority.amendment.minimumApprovalRatio) throw new Error('amendment procedure weakens constitutional adoption');
        }
      }
    }
  }
  for (const procedure of Object.values(groups.procedure).filter((entry) => entry.trigger)) {
    if (Object.values(procedure.states).some((state) => !['agent_task', 'notice', 'wait', 'terminal'].includes(state.handler))) throw new Error('triggered procedure requests an unavailable effect');
  }
  const regulationOf = (key: typeof REGULATION_KEYS[number]): UnknownRecord => {
    const regulation = groups.regulation[key];
    if (!regulation) throw new Error(`missing enacted regulation: ${key}`);
    return regulation;
  };
  const regulations = {
    records: regulationOf('records'), parliament: regulationOf('parliament'), investigation: regulationOf('investigation'),
    sanctions: regulationOf('sanctions'), votes: regulationOf('votes')
  };
  // 投票規則の中身は compileLegalSystem が検査する。ここでは憲法の公開投票の下限だけを見る。
  const amendmentVote = regulations.votes.constitutionalAmendment;
  if (!isRecord(amendmentVote)) throw new Error('missing enacted regulation: votes');
  if (Number(amendmentVote.yesRatio) < authority.amendment.minimumPublicApprovalRatio) throw new Error('ordinary law weakens constitutional public vote');
  return {
    $schema: EFFECTIVE_SCHEMA,
    authority: structuredClone(authority),
    institutions: groups.institution,
    procedures: groups.procedure,
    bindings: groups.binding,
    sources,
    panels,
    workflows,
    ...regulations,
    lawVersions: laws.map((law) => ({ id: law.id ?? null, code: law.code, hash: law.content_hash ?? sha256(canonicalJson(law)) }))
  };
}
