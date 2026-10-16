import { createHash } from 'node:crypto';
import {
  isArray,
  isRecord,
  type ConstitutionPolicy,
  type InvestigationRules,
  type PoliceProcedurePolicy,
  type RestrictionDefinition,
  type SanctionType
} from './types.js';

export const DAY_MS = 86_400_000;
export const AUTOMATIC_TRIGGER_LIMITS = Object.freeze({
  minimumMessages: 5,
  maximumMessages: 30,
  minimumWindowSeconds: 10,
  maximumWindowSeconds: 300
});

export interface AutomaticTrigger {
  type: 'message_burst';
  minimumMessages: number;
  windowSeconds: number;
}

function isInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value);
}

// 警察の即時処分と、争われたときだけ開く裁判所を分ける手続。
export function policeProcedure(policy: ConstitutionPolicy | null | undefined): PoliceProcedurePolicy | null {
  if (!policy || !(policy.schemaVersion >= 2)) return null;
  return policy.judiciary?.policeProcedure ?? null;
}

export function validateAutomaticTrigger(value: unknown): value is AutomaticTrigger {
  if (!isRecord(value)) return false;
  if (Object.keys(value).some((key) => !['type', 'minimumMessages', 'windowSeconds'].includes(key))) return false;
  const limits = AUTOMATIC_TRIGGER_LIMITS;
  return value.type === 'message_burst'
    && isInteger(value.minimumMessages)
    && value.minimumMessages >= limits.minimumMessages
    && value.minimumMessages <= limits.maximumMessages
    && isInteger(value.windowSeconds)
    && value.windowSeconds >= limits.minimumWindowSeconds
    && value.windowSeconds <= limits.maximumWindowSeconds;
}

export function sha256(value: unknown): string {
  return createHash('sha256').update(String(value)).digest('hex');
}

export function canonicalJson(value: unknown): string {
  // JSON.stringify と同じ扱いにする: 配列の undefined は null、objectの
  // undefined な値はキーごと落とす。素通しすると "undefined" という
  // 不正なJSONになり、モデルへ渡すDATAも入力hashも壊れる。
  if (isArray(value)) {
    return `[${value.map((entry) => (entry === undefined ? 'null' : canonicalJson(entry))).join(',')}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value).sort()
      .filter((key) => value[key] !== undefined && typeof value[key] !== 'function')
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`;
  }
  const encoded = JSON.stringify(value);
  return encoded === undefined ? 'null' : encoded;
}

function finite(value: unknown, name: string, { min = 0, max = Infinity }: { min?: number; max?: number } = {}): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) throw new Error(`${name} が不正です。`);
}

const SANCTION_TYPES: readonly string[] = ['warning', 'restriction', 'timeout', 'kick', 'ban'];

export function validateConstitutionPolicy(policy: unknown, options: { technicalOnly?: boolean } = {}): ConstitutionPolicy {
  assertConstitutionPolicy(policy, options);
  return policy;
}

// 各区分の型・範囲・語彙を確かめる。通らなければ理由つきで投げる。
function assertConstitutionPolicy(policy: unknown, { technicalOnly = false }: { technicalOnly?: boolean } = {}): asserts policy is ConstitutionPolicy {
  const schemaVersion = isRecord(policy) ? policy.schemaVersion : undefined;
  if (!isRecord(policy) || (schemaVersion !== 1 && schemaVersion !== 2 && schemaVersion !== 3)) throw new Error('未対応の憲法policyです。');
  const { eligibility, voting, legislation, judiciary } = policy;
  if (!isRecord(eligibility) || (schemaVersion < 3 && !voting) || !isRecord(legislation) || !isRecord(judiciary)) throw new Error('憲法policyの必須区分がありません。');

  finite(policy.timezoneOffsetMinutes, 'timezoneOffsetMinutes', { min: -720, max: 840 });
  for (const key of ['memberAgeDays', 'windowDays', 'minimumMessages', 'minimumActiveDays', 'perDayCap', 'minimumVisibleCharacters']) {
    finite(eligibility[key], `eligibility.${key}`);
    if (!Number.isInteger(eligibility[key])) throw new Error(`eligibility.${key} は整数である必要があります。`);
  }
  // 上の検査で、ここから読む値はすべて有限の整数。
  const windowDays = Number(eligibility.windowDays);
  if (windowDays > 90) throw new Error('activity保持期間の上限は90日です。');
  if (Number(eligibility.minimumVisibleCharacters) > 2000) throw new Error('minimumVisibleCharactersがDiscord本文上限を超えています。');
  if (Number(eligibility.minimumActiveDays) > windowDays) throw new Error('活動日数が集計期間を超えています。');
  if (Number(eligibility.minimumMessages) > windowDays * Number(eligibility.perDayCap)) {
    throw new Error('message要件が集計期間と日次上限では到達不能です。');
  }
  if (voting) {
    if (!isRecord(voting) || (voting.defaultScope !== 'all' && voting.defaultScope !== 'trusted')) throw new Error('voting.defaultScope が不正です。');
    const scopes = voting.allowedScopes;
    if (!isArray(scopes)
      || scopes.length < 1
      || new Set(scopes).size !== scopes.length
      || scopes.some((scope) => scope !== 'all' && scope !== 'trusted')
      || !scopes.includes(voting.defaultScope)) {
      throw new Error('voting.allowedScopes が不正です。');
    }
    for (const key of ['lawYesRatio', 'amendmentYesRatio', 'trustedVetoRatio', 'quorumRatio']) {
      finite(voting[key], `voting.${key}`, { max: 1 });
    }
    finite(voting.minimumBallots, 'voting.minimumBallots', { max: 100_000 });
    if (!Number.isInteger(voting.minimumBallots)) throw new Error('voting.minimumBallots は整数である必要があります。');
    if (voting.publicBallots !== true) throw new Error('v1の投票は全記名です。');
  } else if (schemaVersion < 3) throw new Error('投票規則がありません。');
  const legislationKeys = [
    ...(schemaVersion < 3 ? ['voteMilliseconds', 'maximumDeferrals'] : []), 'sessionIntervalMilliseconds', 'agendaLimit', 'logScan'
  ];
  const allowedLegislationKeys = new Set(legislationKeys);
  if (Object.keys(legislation).some((key) => !allowedLegislationKeys.has(key))
    || legislationKeys.some((key) => !(key in legislation))) {
    throw new Error('legislationに未対応の設定があります。');
  }
  for (const key of (schemaVersion < 3 ? ['voteMilliseconds', 'sessionIntervalMilliseconds'] : ['sessionIntervalMilliseconds'])) {
    finite(legislation[key], `legislation.${key}`, { min: technicalOnly ? 60_000 : 3_600_000 });
    if (!Number.isInteger(legislation[key])) throw new Error(`legislation.${key} は整数である必要があります。`);
  }
  for (const key of ['agendaLimit', ...(schemaVersion < 3 ? ['maximumDeferrals'] : [])]) {
    finite(legislation[key], `legislation.${key}`, { min: 1, max: 20 });
    if (!Number.isInteger(legislation[key])) throw new Error(`legislation.${key} は整数である必要があります。`);
  }
  if (typeof legislation.logScan !== 'boolean') throw new Error('legislation.logScan は真偽値である必要があります。');
  for (const key of [
    'defenseMilliseconds', 'appealMilliseconds', 'constitutionalChallengesPerMemberPerDay', 'panelSeats', 'guiltyVotesRequired',
    'constitutionalVotesRequired', 'unconstitutionalVotesRequired', 'discordMaximumTimeoutSeconds',
    'maximumTimeoutSeconds',
    'immediateTimeoutMaximumSeconds', 'timeoutApprovalsAboveSeconds', 'kickApprovals',
    'banApprovals', 'appealTimeoutMinimumSeconds', 'maximumRestrictionSeconds'
  ]) finite(judiciary[key], `judiciary.${key}`);
  for (const key of [
    'defenseMilliseconds', 'appealMilliseconds', 'constitutionalChallengesPerMemberPerDay', 'panelSeats', 'guiltyVotesRequired', 'constitutionalVotesRequired',
    'unconstitutionalVotesRequired', 'discordMaximumTimeoutSeconds', 'maximumTimeoutSeconds', 'immediateTimeoutMaximumSeconds',
    'timeoutApprovalsAboveSeconds', 'kickApprovals', 'banApprovals',
    'appealTimeoutMinimumSeconds', 'maximumRestrictionSeconds'
  ]) {
    if (!Number.isInteger(judiciary[key])) throw new Error(`judiciary.${key} は整数である必要があります。`);
  }
  // 上の検査で、judiciary の数値項目はすべて有限の整数。
  const judge = (key: string): number => Number(judiciary[key]);
  const panelSeats = judge('panelSeats');
  if (panelSeats < 1 || panelSeats > 5 || panelSeats % 2 === 0) {
    throw new Error('panelSeatsは1, 3, 5のいずれかです。');
  }
  if (judge('defenseMilliseconds') < (technicalOnly ? 60_000 : 3_600_000)
    || judge('appealMilliseconds') < (technicalOnly ? 60_000 : 3_600_000)) {
    throw new Error('答弁・上訴期間は最低1時間必要です。');
  }
  if (schemaVersion >= 2) {
    const procedure = judiciary.policeProcedure;
    if (!isRecord(procedure)) {
      throw new Error('policeProcedureがありません。');
    }
    const allowedKeys = new Set([
      'panelSeats', 'votesRequired', 'contestMilliseconds', 'detentionMaximumSeconds',
      'immediateSanctions', 'courtFirstSanctions', 'unlimitedWarningContest'
    ]);
    if (Object.keys(procedure).some((key) => !allowedKeys.has(key))) {
      throw new Error('policeProcedureに未対応の設定があります。');
    }
    const { panelSeats: seats, votesRequired, contestMilliseconds, detentionMaximumSeconds } = procedure;
    if (!isInteger(seats) || !isInteger(votesRequired) || !isInteger(contestMilliseconds) || !isInteger(detentionMaximumSeconds)) {
      const missing = (['panelSeats', 'votesRequired', 'contestMilliseconds', 'detentionMaximumSeconds'] as const)
        .find((key) => !Number.isInteger(procedure[key]));
      throw new Error(`policeProcedure.${missing}は整数である必要があります。`);
    }
    if (seats < 1 || seats > 5 || seats % 2 === 0
      || votesRequired < 1 || votesRequired > seats) {
      throw new Error('policeProcedureの席数または必要票が不正です。');
    }
    // 拘留は保全なので、不服申立ての期限より長く続けられない。
    if (detentionMaximumSeconds * 1000 > contestMilliseconds) {
      throw new Error('拘留の上限は不服申立て期間を超えられません。');
    }
    const validSanctionSet = (value: unknown): value is SanctionType[] => isArray(value)
      && new Set(value).size === value.length
      && value.every((entry) => typeof entry === 'string' && SANCTION_TYPES.includes(entry));
    // どの処分を警察が打てるかは憲法が決める。コードは重複と未知の種別だけ弾く。
    const immediate = procedure.immediateSanctions;
    const courtFirst = procedure.courtFirstSanctions;
    if (!validSanctionSet(immediate)
      || !validSanctionSet(courtFirst)
      || immediate.some((entry) => courtFirst.includes(entry))) {
      throw new Error('警察の即時処分・裁判所送りの区分が不正です。');
    }
    if (typeof procedure.unlimitedWarningContest !== 'boolean') {
      throw new Error('warningの不服申立て設定が不正です。');
    }
  }
  const challenges = judge('constitutionalChallengesPerMemberPerDay');
  if (challenges < 1
    || challenges > (technicalOnly ? 1000 : 100)) {
    throw new Error(`違憲審査申立て枠は1-${technicalOnly ? 1000 : 100}回です。`);
  }
  if (judge('guiltyVotesRequired') < 1) throw new Error('guiltyVotesRequiredは1以上です。');
  if (judge('constitutionalVotesRequired') < 1 || judge('unconstitutionalVotesRequired') < 1) {
    throw new Error('違憲審査の必要票は1以上です。');
  }
  // constitutionalPanelSeats は v3 だけが持つ任意項目。無ければ裁判所の席数で数える (旧来どおり)。
  const constitutionalSeats = judiciary.constitutionalPanelSeats ?? panelSeats;
  if (judge('guiltyVotesRequired') > panelSeats
    || judge('constitutionalVotesRequired') > Number(constitutionalSeats)
    || judge('unconstitutionalVotesRequired') > Number(constitutionalSeats)) {
    throw new Error('panelの必要票が席数を超えています。');
  }
  if (judge('discordMaximumTimeoutSeconds') > 2_419_200) throw new Error('Discordのtimeout上限を超えています。');
  if (judge('maximumTimeoutSeconds') > judge('discordMaximumTimeoutSeconds')
    || judge('immediateTimeoutMaximumSeconds') > judge('maximumTimeoutSeconds')
    || judge('appealTimeoutMinimumSeconds') > judge('maximumTimeoutSeconds')) {
    throw new Error('timeoutの承認・上訴境界がDiscord上限を超えています。');
  }
  const allowed = new Set(SANCTION_TYPES);
  const allowedSanctions = judiciary.allowedSanctions;
  if (!isArray(allowedSanctions)
    || new Set(allowedSanctions).size !== allowedSanctions.length
    || allowedSanctions.some((value) => typeof value !== 'string' || !allowed.has(value))) {
    throw new Error('許可されていない制裁種別があります。');
  }
  const primitives = new Set([
    'messages_per_window', 'block_links', 'block_attachments', 'block_mentions',
    'block_reactions', 'block_thread_creation', 'block_voice',
    'agent_calls_per_window', 'block_petitions', 'block_voting'
  ]);
  const restrictionPrimitives = judiciary.restrictionPrimitives;
  if (!isArray(restrictionPrimitives)
    || new Set(restrictionPrimitives).size !== restrictionPrimitives.length
    || restrictionPrimitives.some((value) => typeof value !== 'string' || !primitives.has(value))) {
    throw new Error('許可されていない制限制御があります。');
  }
  // 席の調査手数は警察手続と同じ世代の規則なので、schemaVersion 2 でだけ要求する。
  if (schemaVersion >= 2) validateInvestigationPolicy(policy.investigation);
}

// 席の調査手数と公開粒度。値そのものは憲法が決めるので、ここは形と技術上限だけを見る。
export function validateInvestigationPolicy(investigation: unknown): InvestigationRules {
  assertInvestigationPolicy(investigation);
  return investigation;
}

// 調査手段の名前そのものは rules の実装一覧 (IMPLEMENTED_TOOLS) が検査する。
function assertInvestigationPolicy(investigation: unknown): asserts investigation is InvestigationRules {
  if (!investigation) throw new Error('憲法policyにinvestigationがありません。');
  if (!isRecord(investigation)) throw new Error('investigationに未対応の設定があります。');
  const roles = ['police', 'court', 'parliament'] as const;
  const allowed = new Set([
    'maximumSteps', 'maximumOutputKilobytes', 'maximumMinutes',
    'tools', 'publicRecord', 'maximumRedefense'
  ]);
  if (Object.keys(investigation).some((key) => !allowed.has(key))
    || [...allowed].some((key) => !(key in investigation))) {
    throw new Error('investigationに未対応の設定があります。');
  }
  for (const key of ['maximumSteps', 'maximumOutputKilobytes', 'maximumMinutes', 'tools']) {
    const section = investigation[key];
    if (!isRecord(section) || Object.keys(section).sort().join(',') !== [...roles].sort().join(',')) {
      throw new Error(`investigation.${key} は police/court/parliament の3つです。`);
    }
  }
  for (const role of roles) {
    for (const [key, max] of [['maximumSteps', 20], ['maximumOutputKilobytes', 256], ['maximumMinutes', 30]] as const) {
      const section = investigation[key];
      const value = isRecord(section) ? section[role] : undefined;
      finite(value, `investigation.${key}.${role}`, { min: 1, max });
      if (!Number.isInteger(value)) {
        throw new Error(`investigation.${key}.${role} は整数である必要があります。`);
      }
    }
    const toolSection = investigation.tools;
    const tools = isRecord(toolSection) ? toolSection[role] : undefined;
    if (!isArray(tools) || new Set(tools).size !== tools.length) {
      throw new Error(`investigation.tools.${role} が不正です。`);
    }
  }
  const publicRecord = investigation.publicRecord;
  if (publicRecord !== 'none' && publicRecord !== 'summary' && publicRecord !== 'full') {
    throw new Error('investigation.publicRecord は none、summary または full です。');
  }
  finite(investigation.maximumRedefense, 'investigation.maximumRedefense', { min: 0, max: 3 });
  if (!Number.isInteger(investigation.maximumRedefense)) {
    throw new Error('investigation.maximumRedefense は整数である必要があります。');
  }
}

export function policyHash(policy: unknown): string {
  return sha256(canonicalJson(validateConstitutionPolicy(policy)));
}

export function activityDate(timestamp: number | string, offsetMinutes: number): string {
  return new Date(Number(timestamp) + offsetMinutes * 60_000).toISOString().slice(0, 10);
}

export function normalizeActivityContent(content: unknown): string {
  return String(content ?? '')
    .normalize('NFKC')
    .replace(/<@!?\d+>/g, '@user')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** 活動として数える Discord の投稿のうち、ここで読む項目。 */
export interface ActivityMessageSource {
  id: string;
  guildId: string | null;
  channelId: string;
  content?: string | null;
  createdTimestamp?: number | null;
  author?: { id: string; bot?: boolean } | null;
}

export interface QualifyingActivity {
  messageId: string;
  guildId: string;
  channelId: string;
  userId: string;
  activityDate: string;
  contentHash: string;
  createdAt: number;
}

export function qualifyingActivity(message: ActivityMessageSource | null | undefined, policy: ConstitutionPolicy): QualifyingActivity | null {
  if (!message?.guildId || message.author?.bot) return null;
  const normalized = normalizeActivityContent(message.content);
  if (Array.from(normalized).length < policy.eligibility.minimumVisibleCharacters) return null;
  if (/^[/!]/.test(normalized)) return null;
  // author の無い投稿は bot の検査を通っても投稿者を決められない。数えずに失敗させる。
  const author = message.author;
  if (!author) throw new Error('投稿者のない投稿は活動として記録できません。');
  return {
    messageId: String(message.id),
    guildId: String(message.guildId),
    channelId: String(message.channelId),
    userId: String(author.id),
    activityDate: activityDate(message.createdTimestamp ?? Date.now(), policy.timezoneOffsetMinutes),
    contentHash: sha256(normalized),
    createdAt: Number(message.createdTimestamp ?? Date.now())
  };
}

export interface EligibilityInput {
  joinedAt: number | string | null | undefined;
  now?: number;
  dailyUniqueCounts: (number | string)[];
}

export function evaluateEligibility({ joinedAt, now = Date.now(), dailyUniqueCounts }: EligibilityInput, policy: ConstitutionPolicy) {
  const cutoff = now - policy.eligibility.memberAgeDays * DAY_MS;
  const oldEnough = Number(joinedAt) <= cutoff;
  const counts = dailyUniqueCounts.map((count) => Math.min(Number(count), policy.eligibility.perDayCap));
  const messages = counts.reduce((sum, count) => sum + count, 0);
  const activeDays = counts.filter((count) => count > 0).length;
  return {
    eligible: oldEnough
      && messages >= policy.eligibility.minimumMessages
      && activeDays >= policy.eligibility.minimumActiveDays,
    oldEnough,
    messages,
    activeDays
  };
}

/** 処分の種別と期間。裁判の判断 (durationSeconds) でも保存行の写しでもよい。 */
export interface SanctionChoice {
  type: string;
  durationSeconds?: number | string | null;
  definitionCode?: string | null;
}

export function requiredApprovals(sanction: SanctionChoice | null | undefined, policy: ConstitutionPolicy): number {
  if (!sanction) return Infinity;
  if (sanction.type === 'kick') return policy.judiciary.kickApprovals;
  if (sanction.type === 'ban') return policy.judiciary.banApprovals;
  if (sanction.type === 'timeout' && Number(sanction.durationSeconds) > policy.judiciary.immediateTimeoutMaximumSeconds) {
    return policy.judiciary.timeoutApprovalsAboveSeconds;
  }
  if (policeProcedure(policy)) return 0;
  return 0;
}

export function isAppealable(sanction: SanctionChoice | null | undefined, policy: ConstitutionPolicy): boolean {
  return sanction?.type === 'ban'
    || (sanction?.type === 'timeout'
      && Number(sanction.durationSeconds) >= policy.judiciary.appealTimeoutMinimumSeconds);
}

const SANCTION_RANK: Readonly<Record<string, number>> = {
  none: 0,
  warning: 1,
  restriction: 2,
  timeout: 3,
  kick: 4,
  ban: 5
};

/** 席ごとの判断。責任ありの席だけが処分を提案できる。 */
export interface SeatSanctionDecision {
  verdict?: string;
  sanction?: SanctionChoice | null;
}

const NO_SANCTION: SanctionChoice = { type: 'none', durationSeconds: 0 };

export function conservativePanelSanction(decisions: readonly SeatSanctionDecision[]): SanctionChoice | null {
  const ranked = decisions.map((decision) => {
    if (decision.verdict !== 'responsible') return { type: 'none', durationSeconds: 0 };
    return decision.sanction ?? { type: 'none', durationSeconds: 0 };
  }).sort((a, b) => {
    const rank = (SANCTION_RANK[a.type] ?? Infinity) - (SANCTION_RANK[b.type] ?? Infinity);
    return rank || Number(a.durationSeconds ?? 0) - Number(b.durationSeconds ?? 0);
  });
  const middle = ranked[Math.floor(ranked.length / 2)] ?? NO_SANCTION;
  return middle.type === 'none' ? null : middle;
}

export function leastSevereResponsibleSanction(decisions: readonly SeatSanctionDecision[]): SanctionChoice | null {
  const ranked = decisions
    .flatMap((decision) => (decision.verdict === 'responsible' && decision.sanction ? [decision.sanction] : []))
    .sort((a, b) => {
      const rank = (SANCTION_RANK[a.type] ?? Infinity) - (SANCTION_RANK[b.type] ?? Infinity);
      if (rank) return rank;
      const duration = Number(a.durationSeconds ?? 0) - Number(b.durationSeconds ?? 0);
      if (duration) return duration;
      return String(a.definitionCode ?? '').localeCompare(String(b.definitionCode ?? ''));
    });
  return ranked[0] ?? null;
}

export function sanctionNoMoreSevere(candidate: SanctionChoice | null | undefined, original: SanctionChoice | null | undefined): boolean {
  if (!candidate || !original) return false;
  const candidateRank = SANCTION_RANK[candidate.type] ?? Infinity;
  const originalRank = SANCTION_RANK[original.type] ?? -Infinity;
  if (candidateRank < originalRank) return true;
  if (candidateRank > originalRank) return false;
  if (candidate.type === 'timeout') {
    return Number(candidate.durationSeconds) <= Number(original.durationSeconds);
  }
  if (candidate.type === 'restriction') {
    return candidate.definitionCode === original.definitionCode
      && Number(candidate.durationSeconds) <= Number(original.durationSeconds);
  }
  return true;
}

/** 罪の定義のうち、処分の検査で読む項目。 */
export interface OffenseSanctionRule {
  sanctions?: readonly { type: string; definitionCode?: string; maximumSeconds?: number | string }[];
  restrictionDefinitions?: readonly unknown[];
}

export function validateSanctionAgainstOffense(sanction: SanctionChoice | null | undefined, offense: OffenseSanctionRule | null | undefined, policy: ConstitutionPolicy): boolean {
  if (!sanction || !offense) return false;
  if (!policy.judiciary.allowedSanctions.some((type: string) => type === sanction.type)) return false;
  const allowed = offense.sanctions?.find((entry) => entry.type === sanction.type
    && (sanction.type !== 'restriction' || entry.definitionCode === sanction.definitionCode));
  if (!allowed) return false;
  if (sanction.type === 'restriction') {
    const duration = Number(sanction.durationSeconds);
    const definition = offense.restrictionDefinitions?.find((entry) => isRecord(entry) && entry.code === sanction.definitionCode);
    return Boolean(definition)
      && validateRestrictionDefinition(definition, policy)
      && Number.isInteger(duration)
      && duration > 0
      && duration <= Number(allowed.maximumSeconds)
      && duration <= policy.judiciary.maximumRestrictionSeconds;
  }
  if (sanction.type === 'timeout') {
    if (sanction.definitionCode !== undefined) return false;
    const duration = Number(sanction.durationSeconds);
    return Number.isInteger(duration)
      && duration > 0
      && duration <= Number(allowed.maximumSeconds)
      && duration <= policy.judiciary.maximumTimeoutSeconds
      && duration <= policy.judiciary.discordMaximumTimeoutSeconds;
  }
  return sanction.durationSeconds === undefined && sanction.definitionCode === undefined;
}

export function validateRestrictionDefinition(definition: unknown, policy: ConstitutionPolicy): definition is RestrictionDefinition {
  if (!isRecord(definition) || typeof definition.code !== 'string' || !/^[A-Z0-9_]{3,40}$/.test(definition.code)) return false;
  const rules = definition.rules;
  if (!isArray(rules) || rules.length < 1 || rules.length > 12) return false;
  const allowed = new Set<string>(policy.judiciary.restrictionPrimitives);
  const seen = new Set<unknown>();
  for (const rule of rules) {
    if (!isRecord(rule) || typeof rule.primitive !== 'string' || !allowed.has(rule.primitive) || seen.has(rule.primitive)) return false;
    seen.add(rule.primitive);
    if (rule.primitive === 'messages_per_window' || rule.primitive === 'agent_calls_per_window') {
      if (Object.keys(rule).some((key) => !['primitive', 'maximum', 'windowSeconds'].includes(key))) return false;
      if (!isInteger(rule.maximum) || rule.maximum < 0 || rule.maximum > 10_000) return false;
      if (!isInteger(rule.windowSeconds) || rule.windowSeconds < 60 || rule.windowSeconds > 2_592_000) return false;
    } else {
      if (Object.keys(rule).some((key) => !['primitive', 'enabled'].includes(key))) return false;
      if (rule.enabled !== true) return false;
    }
  }
  return true;
}
