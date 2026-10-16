import { AUTHORITY_SCHEMA, composeLegalSystem, validateAuthority } from './legal-system.js';
import { canonicalJson, sha256, validateConstitutionPolicy } from './policy.js';
import { validateHumanAuthority } from './human-authority.js';
import {
  errorMessage,
  isArray,
  isRecord,
  type CompiledAuthority,
  type CompiledConstitution,
  type CompiledLegalSystem,
  type CompiledV1,
  type ConstitutionalAuthority,
  type ConstitutionPolicy,
  type EffectiveLegalSystem,
  type Electorates,
  type GovernanceRules,
  type GovernanceRulesV1,
  type InvestigationRules,
  type LawInput,
  type LegalProcedure,
  type Panels,
  type ParliamentRules,
  type ProcedureState,
  type SanctionRules,
  type UnknownRecord,
  type VoteOutcome,
  type VoteRules,
  type VoteTally,
  type Workflows
} from './types.js';

export const GOVERNANCE_RULES_SCHEMA = 'sakana.governance-rules/v1';
export const GOVERNANCE_RULES_COMPILER_VERSION = 1;

// 席が使える調査手段の実装一覧。tools.js が import 時に自分の登録内容と突き合わせる
// （rules.js → tools.js → db.js → rules.js の循環を避けるため、正本をここに置く）。
export const IMPLEMENTED_TOOLS: readonly string[] = Object.freeze([
  'read_case_record',
  'read_cases',
  'read_channel',
  'read_constitution',
  'read_context',
  'read_law',
  'read_precedent',
  'read_user_messages',
  'search_messages'
]);

const HANDLERS = new Set([
  'parliament_agenda',
  'constitutional_panel',
  'public_vote',
  'police_review',
  'defense_window',
  'judicial_panel',
  'public_approval',
  'contest_window',
  'appeal_window',
  'sanction_execution',
  'terminal'
]);

export const VOTE_EARLY_CLOSE = new Set(['never', 'all_ballots_cast']);

const DURATION_RE = /^(immediate|[1-9]\d*(?:m|h|d))$/;
const MAX_DURATION_MS = 365 * 86_400_000;

// 検査前の数値項目を policy へ写すとき、数でない値は NaN にして validateConstitutionPolicy に弾かせる
// (Number() だと '3' のような文字列が数に化けて通ってしまう)。
function asNumber(value: unknown): number {
  return typeof value === 'number' ? value : NaN;
}

function object(value: unknown, name: string): asserts value is UnknownRecord {
  if (!isRecord(value)) throw new Error(`${name} はobjectである必要があります。`);
}

function exactKeys(value: unknown, keys: readonly string[], name: string, optionalKeys: readonly string[] = []): asserts value is UnknownRecord {
  object(value, name);
  const allowed = new Set([...keys, ...optionalKeys]);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length) throw new Error(`${name} に未対応の項目があります: ${unknown.join(', ')}`);
  const missing = keys.filter((key) => !(key in value));
  if (missing.length) throw new Error(`${name} に必須項目がありません: ${missing.join(', ')}`);
}

function integer(value: unknown, name: string, { min = 0, max = Number.MAX_SAFE_INTEGER }: { min?: number; max?: number } = {}): asserts value is number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) throw new Error(`${name} が不正です。`);
}

function ratio(value: unknown, name: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) throw new Error(`${name} は0以上1以下である必要があります。`);
}

export function durationMilliseconds(value: unknown, name = 'duration'): number {
  if (typeof value !== 'string' || !DURATION_RE.test(value)) throw new Error(`${name} は immediate または 10m・24h・7d 形式である必要があります。`);
  if (value === 'immediate') return 0;
  const amount = Number.parseInt(value, 10);
  const unit = value.at(-1);
  const multiplier = unit === 'm' ? 60_000 : unit === 'h' ? 3_600_000 : 86_400_000;
  const milliseconds = amount * multiplier;
  if (!Number.isSafeInteger(milliseconds) || milliseconds > MAX_DURATION_MS) throw new Error(`${name} が技術上限を超えています。`);
  return milliseconds;
}

export function durationText(milliseconds: unknown): string {
  const value = Number(milliseconds);
  if (value === 0) return 'immediate';
  if (value % 86_400_000 === 0) return `${value / 86_400_000}d`;
  if (value % 3_600_000 === 0) return `${value / 3_600_000}h`;
  if (value % 60_000 === 0) return `${value / 60_000}m`;
  throw new Error('実行規則へ変換できない時間です。');
}

function validateElectorates(electorates: unknown): asserts electorates is Electorates {
  exactKeys(electorates, ['general', 'trusted'], 'electorates');
  const general = electorates.general;
  exactKeys(general, [
    'type', 'memberAge', 'window', 'minimumMessages', 'minimumActiveDays',
    'perDayCap', 'minimumVisibleCharacters', 'timezoneOffsetMinutes'
  ], 'electorates.general');
  if (general.type !== 'activity') throw new Error('electorates.general.type は activity だけを利用できます。');
  const memberAge = durationMilliseconds(general.memberAge, 'electorates.general.memberAge');
  const window = durationMilliseconds(general.window, 'electorates.general.window');
  if (memberAge % 86_400_000 !== 0 || window % 86_400_000 !== 0) {
    throw new Error('活動有権者のmemberAgeとwindowは日単位で指定してください。');
  }
  if (window > 90 * 86_400_000) {
    throw new Error('activity保持期間の技術上限は90日です。');
  }
  for (const key of ['minimumMessages', 'minimumActiveDays', 'perDayCap']) {
    integer(general[key], `electorates.general.${key}`, { max: 100_000 });
  }
  integer(general.minimumVisibleCharacters, 'electorates.general.minimumVisibleCharacters', { max: 2000 });
  // 上の検査で、ここで読む値はすべて整数。
  if (Number(general.minimumActiveDays) > window / 86_400_000
    || Number(general.minimumMessages) > (window / 86_400_000) * Number(general.perDayCap)) {
    throw new Error('活動有権者の条件が指定期間内に到達不能です。');
  }
  integer(general.timezoneOffsetMinutes, 'electorates.general.timezoneOffsetMinutes', { min: -720, max: 840 });
  const trusted = electorates.trusted;
  exactKeys(trusted, ['type', 'binding'], 'electorates.trusted');
  if (trusted.type !== 'discord_role' || trusted.binding !== 'trusted') {
    throw new Error('trusted electorateは運用設定のtrusted roleだけを参照できます。');
  }
}

const PANEL_REQUIRED_KEYS: Readonly<Record<string, readonly string[]>> = {
  parliament: ['decision'],
  constitutional: ['constitutional', 'unconstitutional'],
  court: ['responsible'],
  police: ['responsible'],
  // 事件化するかどうかを独立に調べて決める席。処分そのものは police が決める。
  judicialScreening: ['decision']
};

function validatePanels(panels: unknown): asserts panels is Panels {
  exactKeys(panels, ['parliament', 'constitutional', 'court', 'police', 'judicialScreening'], 'panels');
  for (const [name, panel] of Object.entries(panels)) {
    exactKeys(panel, ['seats', 'required'], `panels.${name}`);
    const seats = panel.seats;
    integer(seats, `panels.${name}.seats`, { min: 1, max: 5 });
    if (seats % 2 === 0) throw new Error(`panels.${name}.seats は1, 3, 5のいずれかです。`);
    const required = panel.required;
    // panels の名前は上の exactKeys で5つに限った。
    exactKeys(required, PANEL_REQUIRED_KEYS[name] ?? [], `panels.${name}.required`);
    for (const [outcome, needed] of Object.entries(required)) {
      if (!/^[a-z][a-z0-9_]*$/.test(outcome)) throw new Error(`panels.${name}.requiredの結果名が不正です。`);
      integer(needed, `panels.${name}.required.${outcome}`, { min: 1, max: seats });
    }
  }
}

// 開会の間隔や議題数は法令の規定。v2以降の改稿回数は手続のmaximumVisitsが定める。
function validateParliament(parliament: unknown, { lawDefined = false }: { lawDefined?: boolean } = {}): asserts parliament is ParliamentRules {
  exactKeys(parliament, ['sessionInterval', 'agendaLimit', 'logScan', ...(!lawDefined ? ['maximumDeferrals'] : [])], 'parliament');
  const interval = durationMilliseconds(parliament.sessionInterval, 'parliament.sessionInterval');
  if (interval < 3_600_000) throw new Error('parliament.sessionInterval は1時間以上である必要があります。');
  if (interval > 30 * 86_400_000) throw new Error('parliament.sessionInterval の技術上限は30日です。');
  integer(parliament.agendaLimit, 'parliament.agendaLimit', { min: 1, max: 20 });
  if (!lawDefined) integer(parliament.maximumDeferrals, 'parliament.maximumDeferrals', { min: 1, max: 20 });
  if (typeof parliament.logScan !== 'boolean') throw new Error('parliament.logScan は真偽値である必要があります。');
}

function validateVotes(votes: unknown, { lawDefined = false }: { lawDefined?: boolean } = {}): asserts votes is VoteRules {
  exactKeys(votes, ['defaultScope', 'allowedScopes', 'law', 'constitutionalAmendment'], 'votes');
  if (votes.defaultScope !== 'all' && votes.defaultScope !== 'trusted') throw new Error('votes.defaultScope が不正です。');
  const allowedScopes = votes.allowedScopes;
  if (!isArray(allowedScopes) || allowedScopes.length < 1
    || allowedScopes.some((scope) => scope !== 'all' && scope !== 'trusted')
    || !allowedScopes.includes(votes.defaultScope)) throw new Error('votes.allowedScopes が不正です。');
  const pairs: [string, unknown][] = [['law', votes.law], ['constitutionalAmendment', votes.constitutionalAmendment]];
  for (const [name, vote] of pairs) {
    exactKeys(
      vote,
      ['duration', 'yesRatio', 'comparison', 'quorumRatio', 'minimumBallots', 'publicBallots', 'trustedVeto'],
      `votes.${name}`,
      ['earlyClose', ...(lawDefined ? ['humanVeto'] : [])]
    );
    if (vote.humanVeto !== undefined && vote.humanVeto !== null) validateHumanAuthority(vote.humanVeto, { veto: true });
    // earlyCloseを書かない旧憲法は締切満了だけで開票する。
    if ('earlyClose' in vote && (typeof vote.earlyClose !== 'string' || !VOTE_EARLY_CLOSE.has(vote.earlyClose))) {
      throw new Error(`votes.${name}.earlyClose は never または all_ballots_cast です。`);
    }
    durationMilliseconds(vote.duration, `votes.${name}.duration`);
    ratio(vote.yesRatio, `votes.${name}.yesRatio`);
    ratio(vote.quorumRatio, `votes.${name}.quorumRatio`);
    if (vote.comparison !== 'gt' && vote.comparison !== 'gte') throw new Error(`votes.${name}.comparison が不正です。`);
    integer(vote.minimumBallots, `votes.${name}.minimumBallots`, { max: 100_000 });
    if (vote.publicBallots !== true) throw new Error('公開投票だけを利用できます。');
    const trustedVeto = vote.trustedVeto;
    exactKeys(trustedVeto, ['enabledForScope', 'noRatio', 'denominator'], `votes.${name}.trustedVeto`);
    if (trustedVeto.enabledForScope !== 'all' || trustedVeto.denominator !== 'decisive_cast_ballots') {
      throw new Error('trusted拒否は全員投票の有効投票だけを分母にする必要があります。');
    }
    ratio(trustedVeto.noRatio, `votes.${name}.trustedVeto.noRatio`);
  }
}

const SANCTION_TYPES: readonly string[] = ['warning', 'restriction', 'timeout', 'kick', 'ban'];

function validateSanctions(sanctions: unknown): asserts sanctions is SanctionRules {
  exactKeys(sanctions, [
    'allowed', 'restrictionPrimitives', 'maximumRestriction', 'timeout',
    'approvals', 'appeals', 'detention', 'police'
  ], 'sanctions');
  const types = SANCTION_TYPES;
  const allowed = sanctions.allowed;
  if (!isArray(allowed) || new Set(allowed).size !== allowed.length
    || allowed.some((type) => typeof type !== 'string' || !types.includes(type))) throw new Error('sanctions.allowed が不正です。');
  const primitives = new Set([
    'messages_per_window', 'block_links', 'block_attachments', 'block_mentions',
    'block_reactions', 'block_thread_creation', 'block_voice',
    'agent_calls_per_window', 'block_petitions', 'block_voting'
  ]);
  const restrictionPrimitives = sanctions.restrictionPrimitives;
  if (!isArray(restrictionPrimitives)
    || restrictionPrimitives.some((value) => typeof value !== 'string' || !primitives.has(value))) {
    throw new Error('未対応のrestriction capabilityがあります。');
  }
  durationMilliseconds(sanctions.maximumRestriction, 'sanctions.maximumRestriction');
  const timeout = sanctions.timeout;
  exactKeys(timeout, ['discordMaximum', 'maximum', 'immediateMaximum'], 'sanctions.timeout');
  for (const [key, value] of Object.entries(timeout)) durationMilliseconds(value, `sanctions.timeout.${key}`);
  if (durationMilliseconds(timeout.discordMaximum) > 2_419_200_000) throw new Error('Discord timeout上限を超えています。');
  const approvals = sanctions.approvals;
  exactKeys(approvals, ['timeoutAboveImmediate', 'kick', 'ban'], 'sanctions.approvals');
  for (const [key, value] of Object.entries(approvals)) integer(value, `sanctions.approvals.${key}`, { max: 100 });
  const appeals = sanctions.appeals;
  exactKeys(appeals, ['timeoutAtLeast', 'types', 'duration'], 'sanctions.appeals');
  durationMilliseconds(appeals.timeoutAtLeast, 'sanctions.appeals.timeoutAtLeast');
  durationMilliseconds(appeals.duration, 'sanctions.appeals.duration');
  const appealTypes = appeals.types;
  if (!isArray(appealTypes)
    || canonicalJson([...appealTypes].sort()) !== canonicalJson(['ban', 'timeout'])) {
    throw new Error('現在のDiscord実行系で上訴対象にできる処分は ban と timeout だけです。');
  }
  // 拘留は罰ではなく保全なので、種類ではなく上限時間だけを憲法が決める。
  const detentionRule = sanctions.detention;
  exactKeys(detentionRule, ['maximum'], 'sanctions.detention');
  const detention = durationMilliseconds(detentionRule.maximum, 'sanctions.detention.maximum');
  if (detention < 60_000) throw new Error('sanctions.detention.maximum は1分以上である必要があります。');
  if (detention > 86_400_000) throw new Error('拘留は保全なので24時間を超えられません。');
  const police = sanctions.police;
  exactKeys(police, ['contestDuration', 'immediate', 'courtFirst', 'unlimitedWarningContest'], 'sanctions.police');
  durationMilliseconds(police.contestDuration, 'sanctions.police.contestDuration');
  const immediate = police.immediate;
  const courtFirst = police.courtFirst;
  for (const [key, list] of [['immediate', immediate], ['courtFirst', courtFirst]] as const) {
    if (!isArray(list)
      || list.some((type) => typeof type !== 'string' || !types.includes(type))) throw new Error(`sanctions.police.${key} が不正です。`);
  }
  // 警察が単独で打てる処分と、必ず裁判所へ送る処分は重ならない。
  if (isArray(immediate) && isArray(courtFirst) && immediate.some((type) => courtFirst.includes(type))) {
    throw new Error('警察の即時処分と裁判所送りの処分は重複できません。');
  }
  if (typeof police.unlimitedWarningContest !== 'boolean') {
    throw new Error('unlimitedWarningContestは真偽値である必要があります。');
  }
}

/** 名前で state を引く。検査済みの遷移先だけを引くので、無ければ実行規則の破損。 */
function stateOf(workflow: LegalProcedure, stateName: string): ProcedureState {
  const state = workflow.states[stateName];
  if (!state) throw new Error(`workflowにstate ${stateName} がありません。`);
  return state;
}

function validateWorkflow(name: string, workflow: unknown): asserts workflow is LegalProcedure {
  exactKeys(workflow, ['initial', 'config', 'states'], `workflows.${name}`);
  const config = workflow.config;
  if (name === 'constitutionalCase') {
    exactKeys(config, ['petitionsPerMemberPerDay'], `workflows.${name}.config`);
    integer(config.petitionsPerMemberPerDay, `workflows.${name}.config.petitionsPerMemberPerDay`, { min: 1, max: 1000 });
  } else {
    exactKeys(config, [], `workflows.${name}.config`);
  }
  const rawStates = workflow.states;
  object(rawStates, `workflows.${name}.states`);
  const entries = Object.entries(rawStates);
  if (entries.length < 1 || entries.length > 64) throw new Error(`workflows.${name}.states の数が不正です。`);
  const initial = workflow.initial;
  if (typeof initial !== 'string' || !(initial in rawStates)) throw new Error(`workflows.${name}.initial が存在しません。`);
  let terminalCount = 0;
  for (const [stateName, state] of entries) {
    if (!/^[a-z][a-z0-9_]*$/.test(stateName)) throw new Error(`workflows.${name}のstate名が不正です。`);
    exactKeys(state, ['handler', 'duration', 'config', 'on'], `workflows.${name}.states.${stateName}`);
    const handler = state.handler;
    if (typeof handler !== 'string' || !HANDLERS.has(handler)) throw new Error(`未対応のworkflow handlerです: ${String(handler)}`);
    if (state.duration !== null) durationMilliseconds(state.duration, `workflows.${name}.states.${stateName}.duration`);
    object(state.config, `workflows.${name}.states.${stateName}.config`);
    const on = state.on;
    object(on, `workflows.${name}.states.${stateName}.on`);
    if (['public_vote', 'defense_window', 'appeal_window'].includes(handler)
      && (state.duration === null || durationMilliseconds(state.duration) === 0)) {
      throw new Error(`${handler} には0より長い期間が必要です。`);
    }
    // 国会が動かすまでの待機なので、議題stateに固定の期間は置かない。
    if (handler === 'parliament_agenda' && state.duration !== null) {
      throw new Error(`workflows.${name}.states.${stateName}.duration は国会の議題では null である必要があります。`);
    }
    if (handler === 'terminal') {
      terminalCount += 1;
      if (state.duration !== null || Object.keys(on).length > 0) throw new Error('terminal stateには期間や遷移を設定できません。');
    }
    for (const [outcome, target] of Object.entries(on)) {
      if (!/^[a-z][a-z0-9_]*$/.test(outcome) || typeof target !== 'string' || !(target in rawStates)) {
        throw new Error(`workflows.${name}.${stateName} の遷移が不正です。`);
      }
    }
  }
  if (terminalCount < 1) throw new Error(`workflows.${name} に終端状態がありません。`);
  // 上の検査で、各 state が handler・duration・config・on (既存 state への遷移) を持つことを確かめた。
  const states = rawStates as Record<string, ProcedureState>;
  const procedure: LegalProcedure = { initial, config, states };
  const reachable = new Set([initial]);
  const queue = [initial];
  for (let current = queue.shift(); current !== undefined; current = queue.shift()) {
    for (const target of Object.values(stateOf(procedure, current).on)) {
      if (!reachable.has(target)) { reachable.add(target); queue.push(target); }
    }
  }
  const unreachable = Object.keys(states).filter((state) => !reachable.has(state));
  if (unreachable.length) throw new Error(`workflows.${name} に到達不能状態があります: ${unreachable.join(', ')}`);
  const waitingHandlers = new Set([
    'parliament_agenda', 'public_vote', 'defense_window', 'public_approval',
    'contest_window', 'appeal_window', 'terminal'
  ]);
  const instant = (stateName: string): boolean => {
    const item = stateOf(procedure, stateName);
    return !waitingHandlers.has(item.handler) && (item.duration === null || durationMilliseconds(item.duration) === 0);
  };
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const findInstantCycle = (stateName: string): boolean => {
    if (!instant(stateName)) return false;
    if (visiting.has(stateName)) return true;
    if (visited.has(stateName)) return false;
    visiting.add(stateName);
    for (const target of Object.values(stateOf(procedure, stateName).on)) {
      if (findInstantCycle(target)) return true;
    }
    visiting.delete(stateName);
    visited.add(stateName);
    return false;
  };
  if (Object.keys(states).some(findInstantCycle)) throw new Error(`workflows.${name} に待機を伴わない循環があります。`);
}

function requireTransition(workflow: LegalProcedure, stateName: string, outcome: string, targetHandler: string): string {
  const state = workflow.states[stateName];
  const targetName = state?.on?.[outcome];
  const target = targetName === undefined ? undefined : workflow.states[targetName];
  if (targetName === undefined || !target || target.handler !== targetHandler) {
    throw new Error(`workflow ${stateName}.${outcome} は ${targetHandler} へ進む必要があります。`);
  }
  return targetName;
}

function validateLegislativeWorkflow(name: string, workflow: LegalProcedure): void {
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
  if (workflow.states[voteName]?.on.stale) requireTransition(workflow, voteName, 'stale', 'terminal');
  const agendaStates = Object.values(workflow.states).filter((state) => state.handler === 'parliament_agenda');
  if (agendaStates.length !== 1) throw new Error(`workflows.${name} の議題stateは一つだけです。`);
}

// 憲法第十五条3。席が使える調査手段は実行規則が列挙したものだけで、AIの解釈で
// 増やせない。コードは「実装があるか」しか見ない。何を許すかは憲法が決める。
function validateInvestigation(investigation: unknown): asserts investigation is InvestigationRules {
  exactKeys(investigation, [
    'maximumSteps', 'maximumOutputKilobytes', 'maximumMinutes',
    'tools', 'publicRecord', 'maximumRedefense'
  ], 'investigation');
  const roles = ['police', 'court', 'parliament'] as const;
  const maximumSteps = investigation.maximumSteps;
  exactKeys(maximumSteps, roles, 'investigation.maximumSteps');
  for (const role of roles) {
    integer(maximumSteps[role], `investigation.maximumSteps.${role}`, { min: 1, max: 20 });
  }
  const toolSets = investigation.tools;
  exactKeys(toolSets, roles, 'investigation.tools');
  for (const role of roles) {
    const tools = toolSets[role];
    if (!isArray(tools) || new Set(tools).size !== tools.length) {
      throw new Error(`investigation.tools.${role} が不正です。`);
    }
    for (const name of tools) {
      if (typeof name !== 'string' || !IMPLEMENTED_TOOLS.includes(name)) throw new Error(`未実装の調査手段があります: ${String(name)}`);
    }
  }
  // 席が1回の審議で受け取れる調査結果の総量。ツールループは配列を毎回再送するので
  // ここを固定しないと1件あたりの費用が青天井になる。
  const maximumOutputKilobytes = investigation.maximumOutputKilobytes;
  exactKeys(maximumOutputKilobytes, roles, 'investigation.maximumOutputKilobytes');
  for (const role of roles) {
    integer(maximumOutputKilobytes[role], `investigation.maximumOutputKilobytes.${role}`, { min: 1, max: 256 });
  }
  // 手数と総量だけでは審議時間が決まらない。1手が遅ければ席は何十分でも粘れる。
  // 実時間の上限を置き、超えたらその時点の記録で結論を出させる。
  const maximumMinutes = investigation.maximumMinutes;
  exactKeys(maximumMinutes, roles, 'investigation.maximumMinutes');
  for (const role of roles) {
    integer(maximumMinutes[role], `investigation.maximumMinutes.${role}`, { min: 1, max: 30 });
  }
  const publicRecord = investigation.publicRecord;
  if (publicRecord !== 'none' && publicRecord !== 'summary' && publicRecord !== 'full') {
    throw new Error('investigation.publicRecord は none、summary または full です。');
  }
  integer(investigation.maximumRedefense, 'investigation.maximumRedefense', { min: 0, max: 3 });
}

export function validateGovernanceRules(input: unknown): GovernanceRulesV1 | ConstitutionalAuthority {
  if (isRecord(input) && input.$schema === AUTHORITY_SCHEMA) return validateAuthority(input);
  assertGovernanceRulesV1(input);
  return input;
}

function assertGovernanceRulesV1(rules: unknown): asserts rules is GovernanceRulesV1 {
  exactKeys(rules, ['$schema', 'electorates', 'panels', 'parliament', 'investigation', 'votes', 'sanctions', 'workflows'], 'governance-rules');
  if (rules.$schema !== GOVERNANCE_RULES_SCHEMA) throw new Error('未対応のgovernance-rules schemaです。');
  validateElectorates(rules.electorates);
  validatePanels(rules.panels);
  validateParliament(rules.parliament);
  validateInvestigation(rules.investigation);
  const votes = rules.votes;
  validateVotes(votes);
  validateSanctions(rules.sanctions);
  const rawWorkflows = rules.workflows;
  exactKeys(rawWorkflows, ['law', 'constitutionalAmendment', 'criminalCase', 'constitutionalCase'], 'workflows');
  for (const [name, workflow] of Object.entries(rawWorkflows)) validateWorkflow(name, workflow);
  // 4つの workflow をそれぞれ上の validateWorkflow で確かめた。
  const workflows = rawWorkflows as Workflows;
  validateLegislativeWorkflow('law', workflows.law);
  validateLegislativeWorkflow('constitutionalAmendment', workflows.constitutionalAmendment);
  for (const [workflowName, voteName] of [['law', 'law'], ['constitutionalAmendment', 'constitutionalAmendment']] as const) {
    const voteStates = Object.values(workflows[workflowName].states)
      .filter((state) => state.handler === 'public_vote');
    const [voteState] = voteStates;
    if (voteStates.length !== 1 || voteState?.config.vote !== voteName
      || voteState.duration !== votes[voteName].duration) {
      throw new Error(`workflows.${workflowName} の投票段階は votes.${voteName} と一致する必要があります。`);
    }
  }
}

export function extractGovernanceRules(content: unknown): GovernanceRulesV1 | ConstitutionalAuthority | null {
  const text = String(content ?? '');
  const matches = [...text.matchAll(/```governance-rules\s*\n([\s\S]*?)\n```/g)];
  if (matches.length === 0) return null;
  if (matches.length !== 1) throw new Error('憲法にはgovernance-rulesブロックを一つだけ置けます。');
  let parsed: unknown;
  // 正規表現の括弧は必ず一致するので、本文は常に文字列。
  try { parsed = JSON.parse(matches[0]?.[1] ?? ''); } catch (error) {
    throw new Error(`governance-rules JSONを読めません: ${errorMessage(error)}`);
  }
  return validateGovernanceRules(parsed);
}

export function policyFromGovernanceRules(input: unknown): ConstitutionPolicy {
  const rules = validateGovernanceRules(structuredClone(input));
  if (rules.$schema !== GOVERNANCE_RULES_SCHEMA) throw new Error('埋め込み実行規則 (v1) ではありません。');
  const general = rules.electorates.general;
  const vote = rules.votes.law;
  const constitutional = rules.panels.constitutional;
  const court = rules.panels.court;
  const police = rules.panels.police;
  const sanctions = rules.sanctions;
  const summaryWorkflow = Object.values(rules.workflows.criminalCase.states)
    .some((state) => state.handler === 'police_review');
  // 刑事の答弁期間が無ければ (null も含めて) 違憲審査の答弁期間を使う。
  const defenseDuration = rules.workflows.criminalCase.states.defense?.duration
    ?? stateOf(rules.workflows.constitutionalCase, 'defense').duration;
  const policy: ConstitutionPolicy = {
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
      sessionIntervalMilliseconds: durationMilliseconds(rules.parliament.sessionInterval),
      agendaLimit: rules.parliament.agendaLimit,
      maximumDeferrals: rules.parliament.maximumDeferrals,
      logScan: rules.parliament.logScan
    },
    judiciary: {
      defenseMilliseconds: durationMilliseconds(defenseDuration),
      appealMilliseconds: durationMilliseconds(sanctions.appeals.duration),
      constitutionalChallengesPerMemberPerDay: asNumber(rules.workflows.constitutionalCase.config.petitionsPerMemberPerDay),
      panelSeats: court.seats,
      guiltyVotesRequired: asNumber(court.required.responsible),
      constitutionalVotesRequired: asNumber(constitutional.required.constitutional),
      unconstitutionalVotesRequired: asNumber(constitutional.required.unconstitutional),
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
    },
    investigation: {
      maximumSteps: { ...rules.investigation.maximumSteps },
      maximumOutputKilobytes: { ...rules.investigation.maximumOutputKilobytes },
      maximumMinutes: { ...rules.investigation.maximumMinutes },
      tools: {
        police: [...rules.investigation.tools.police],
        court: [...rules.investigation.tools.court],
        parliament: [...rules.investigation.tools.parliament]
      },
      publicRecord: rules.investigation.publicRecord,
      maximumRedefense: rules.investigation.maximumRedefense
    }
  };
  if (policy.schemaVersion === 2) {
    policy.judiciary.policeProcedure = {
      panelSeats: police.seats,
      votesRequired: asNumber(police.required.responsible),
      contestMilliseconds: durationMilliseconds(sanctions.police.contestDuration),
      detentionMaximumSeconds: durationMilliseconds(sanctions.detention.maximum) / 1000,
      immediateSanctions: sanctions.police.immediate,
      courtFirstSanctions: sanctions.police.courtFirst,
      unlimitedWarningContest: sanctions.police.unlimitedWarningContest
    };
  }
  return validateConstitutionPolicy(policy, { technicalOnly: true });
}

export function compileLegalSystem({ authority, laws }: { authority: unknown; laws: readonly LawInput[] }): CompiledLegalSystem {
  const composed = composeLegalSystem(authority, laws);
  const { panels, sanctions } = composed;
  const roles = ['police', 'court', 'parliament'] as const;
  const investigation = {
    ...composed.investigation,
    tools: Object.fromEntries(roles.map((role) => [role, panels[role].tools]))
  };
  validateInvestigation(investigation);
  const parliament = composed.parliament;
  validateParliament(parliament, { lawDefined: true });
  validateSanctions(sanctions);
  const votes = composed.votes;
  validateVotes(votes, { lawDefined: true });
  const workflows = composed.workflows;
  for (const role of ['law', 'constitutionalAmendment'] as const) {
    if (votes[role].humanVeto && !Object.values(workflows[role].states).some((state) => state.handler === 'public_vote')) throw new Error('人間の拒否権には公開の投票・拒否期間が必要です。');
  }
  const electorates = { general: composed.records, trusted: { type: 'discord_role', binding: 'trusted' } };
  validateElectorates(electorates);
  if (Object.values(sanctions.approvals).some((value) => value > 0)
    && !Object.values(workflows.criminalCase.states).some((state) => state.handler === 'human_approval')) throw new Error('執行承認が必要な処分には承認手続が必要です。');
  const duration = (workflow: LegalProcedure, handler: string): number => {
    const state = Object.values(workflow.states).find((entry) => entry.handler === handler);
    if (!state || state.duration === null) throw new Error(`missing legal ${handler} period`);
    return durationMilliseconds(state.duration);
  };
  const general = electorates.general;
  // 各規制を上で検査した。以後は型のついた値として組み立てる (中身は composed と同じ)。
  const rules: EffectiveLegalSystem = { ...composed, investigation, parliament, sanctions, votes, records: general };
  const policy: ConstitutionPolicy = {
    schemaVersion: 3,
    autonomous: true,
    voting: {
      defaultScope: votes.defaultScope, allowedScopes: votes.allowedScopes,
      lawYesRatio: votes.law.yesRatio, amendmentYesRatio: votes.constitutionalAmendment.yesRatio,
      trustedVetoRatio: votes.law.trustedVeto.noRatio, quorumRatio: votes.law.quorumRatio,
      minimumBallots: votes.law.minimumBallots, publicBallots: true
    },
    timezoneOffsetMinutes: general.timezoneOffsetMinutes,
    eligibility: {
      memberAgeDays: durationMilliseconds(general.memberAge) / 86400000,
      windowDays: durationMilliseconds(general.window) / 86400000,
      minimumMessages: general.minimumMessages,
      minimumActiveDays: general.minimumActiveDays,
      perDayCap: general.perDayCap,
      minimumVisibleCharacters: general.minimumVisibleCharacters
    },
    legislation: {
      sessionIntervalMilliseconds: durationMilliseconds(parliament.sessionInterval),
      agendaLimit: parliament.agendaLimit,
      logScan: parliament.logScan
    },
    judiciary: {
      defenseMilliseconds: duration(workflows.criminalCase, 'defense_window'),
      appealMilliseconds: durationMilliseconds(sanctions.appeals.duration),
      constitutionalChallengesPerMemberPerDay: asNumber(workflows.constitutionalCase.config.petitionsPerMemberPerDay),
      panelSeats: panels.court.seats,
      constitutionalPanelSeats: panels.constitutional.seats,
      guiltyVotesRequired: asNumber(panels.court.required.responsible),
      constitutionalVotesRequired: asNumber(panels.constitutional.required.constitutional),
      unconstitutionalVotesRequired: asNumber(panels.constitutional.required.unconstitutional),
      discordMaximumTimeoutSeconds: durationMilliseconds(sanctions.timeout.discordMaximum) / 1000,
      maximumTimeoutSeconds: durationMilliseconds(sanctions.timeout.maximum) / 1000,
      immediateTimeoutMaximumSeconds: durationMilliseconds(sanctions.timeout.immediateMaximum) / 1000,
      timeoutApprovalsAboveSeconds: sanctions.approvals.timeoutAboveImmediate,
      kickApprovals: sanctions.approvals.kick, banApprovals: sanctions.approvals.ban,
      appealTimeoutMinimumSeconds: durationMilliseconds(sanctions.appeals.timeoutAtLeast) / 1000,
      maximumRestrictionSeconds: durationMilliseconds(sanctions.maximumRestriction) / 1000,
      allowedSanctions: sanctions.allowed,
      restrictionPrimitives: sanctions.restrictionPrimitives,
      policeProcedure: {
        panelSeats: panels.police.seats, votesRequired: asNumber(panels.police.required.responsible),
        contestMilliseconds: durationMilliseconds(sanctions.police.contestDuration),
        detentionMaximumSeconds: durationMilliseconds(sanctions.detention.maximum) / 1000,
        immediateSanctions: sanctions.police.immediate, courtFirstSanctions: sanctions.police.courtFirst,
        unlimitedWarningContest: sanctions.police.unlimitedWarningContest
      }
    },
    investigation
  };
  validateConstitutionPolicy(policy, { technicalOnly: true });
  return { rules, policy, rulesHash: sha256(canonicalJson(rules)), sourceFormat: 'law-defined-v2', compilerVersion: 2 };
}

export function compileConstitution({ content, laws = null }: { content: unknown; laws?: readonly LawInput[] | null }): CompiledConstitution {
  const rules = extractGovernanceRules(content);
  if (!rules) throw new Error('憲法にgovernance-rulesブロックがありません。');
  if (rules.$schema === AUTHORITY_SCHEMA) {
    if (laws) return compileLegalSystem({ authority: rules, laws });
    const authorityOnly: CompiledAuthority = { sourceFormat: 'constitutional-authority-v2', compilerVersion: 2, rules,
      rulesHash: sha256(canonicalJson(rules)), policy: null };
    return authorityOnly;
  }
  const projectedPolicy = policyFromGovernanceRules(rules);
  const canonical = canonicalJson(rules);
  const compiled: CompiledV1 = {
    sourceFormat: 'embedded-rules-v1',
    compilerVersion: GOVERNANCE_RULES_COMPILER_VERSION,
    rules,
    rulesHash: sha256(canonical),
    policy: projectedPolicy
  };
  return compiled;
}

/** workflow を引くときに読む、コンパイル済み憲法の項目。 */
export interface WorkflowSource {
  rules?: { workflows?: Partial<Record<string, LegalProcedure>> } | null;
}

export function workflowFor(compiled: WorkflowSource | null | undefined, key: string): LegalProcedure {
  const workflow = compiled?.rules?.workflows?.[key];
  if (!workflow) throw new Error(`憲法にworkflow ${key} がありません。`);
  return workflow;
}

export function workflowNext(compiled: WorkflowSource | null | undefined, key: string, stateName: string, outcome: string): string {
  const workflow = workflowFor(compiled, key);
  const state = workflow.states[stateName];
  if (!state) throw new Error(`workflow ${key} にstate ${stateName} がありません。`);
  const next = state.on[outcome];
  if (!next) throw new Error(`workflow ${key}.${stateName} は結果 ${outcome} を受け付けません。`);
  return next;
}

export function closeGovernanceVote({ kind, yes, no, abstain, electorate, trustedNo, trustedTotal, vetoCount = 0, scope = 'all' }: VoteTally, rules: { votes: VoteRules }): VoteOutcome {
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
  const humanVetoed = Boolean(vote.humanVeto && Number(vetoCount) >= vote.humanVeto.required);
  const vetoed = humanVetoed || (vetoApplies && Number(trustedTotal) > 0 && Number(trustedNo) >= trustedNeeded);
  return {
    passed: ratioPassed && quorumPassed && !vetoed,
    ratioPassed,
    quorumPassed,
    vetoed,
    humanVetoed,
    quorumNeeded,
    trustedNeeded,
    decisive,
    ballots
  };
}

export function governanceRulesSummary(rules: GovernanceRules): string {
  const lines = [];
  lines.push(`国会 ${rules.parliament.sessionInterval}ごと / 1回 ${rules.parliament.agendaLimit}議題`);
  lines.push(`継続審議 ${String(rules.parliament.maximumDeferrals)}回まで`);
  lines.push(`公開記録からの議題発見 ${rules.parliament.logScan ? 'あり' : 'なし'}`);
  lines.push(`法律投票 ${rules.votes.law.duration}`);
  lines.push(`憲法改正投票 ${rules.votes.constitutionalAmendment.duration}`);
  if (rules.votes.law.earlyClose === 'all_ballots_cast' || rules.votes.constitutionalAmendment.earlyClose === 'all_ballots_cast') {
    lines.push('有権者全員の投票で即時開票');
  }
  lines.push(`警察 ${rules.panels.police.seats}席 / 裁判所 ${rules.panels.court.seats}席`);
  lines.push(`拘留 最大${rules.sanctions.detention.maximum}`);
  lines.push(`違憲審査 ${rules.panels.constitutional.seats}席`);
  lines.push(`国会の合議 ${rules.panels.parliament.seats}席`);
  return lines.join(' / ');
}
