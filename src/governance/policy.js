import { createHash } from 'node:crypto';

export const DAY_MS = 86_400_000;
export const AUTOMATIC_TRIGGER_LIMITS = Object.freeze({
  minimumMessages: 5,
  maximumMessages: 30,
  minimumWindowSeconds: 10,
  maximumWindowSeconds: 300
});

// 警察の即時処分と、争われたときだけ開く裁判所を分ける手続。
export function policeProcedure(policy) {
  return policy?.schemaVersion === 2 ? policy.judiciary?.policeProcedure ?? null : null;
}

export function validateAutomaticTrigger(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  if (Object.keys(value).some((key) => !['type', 'minimumMessages', 'windowSeconds'].includes(key))) return false;
  const limits = AUTOMATIC_TRIGGER_LIMITS;
  return value.type === 'message_burst'
    && Number.isInteger(value.minimumMessages)
    && value.minimumMessages >= limits.minimumMessages
    && value.minimumMessages <= limits.maximumMessages
    && Number.isInteger(value.windowSeconds)
    && value.windowSeconds >= limits.minimumWindowSeconds
    && value.windowSeconds <= limits.maximumWindowSeconds;
}

export function sha256(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

export function canonicalJson(value) {
  // JSON.stringify と同じ扱いにする: 配列の undefined は null、objectの
  // undefined な値はキーごと落とす。素通しすると "undefined" という
  // 不正なJSONになり、モデルへ渡すDATAも入力hashも壊れる。
  if (Array.isArray(value)) {
    return `[${value.map((entry) => (entry === undefined ? 'null' : canonicalJson(entry))).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort()
      .filter((key) => value[key] !== undefined && typeof value[key] !== 'function')
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`;
  }
  const encoded = JSON.stringify(value);
  return encoded === undefined ? 'null' : encoded;
}

function finite(value, name, { min = 0, max = Infinity } = {}) {
  if (!Number.isFinite(value) || value < min || value > max) throw new Error(`${name} が不正です。`);
}

export function validateConstitutionPolicy(policy, { technicalOnly = false } = {}) {
  if (!policy || ![1, 2].includes(policy.schemaVersion)) throw new Error('未対応の憲法policyです。');
  const { eligibility, voting, legislation, judiciary } = policy;
  if (!eligibility || !voting || !legislation || !judiciary) throw new Error('憲法policyの必須区分がありません。');

  finite(policy.timezoneOffsetMinutes, 'timezoneOffsetMinutes', { min: -720, max: 840 });
  for (const key of ['memberAgeDays', 'windowDays', 'minimumMessages', 'minimumActiveDays', 'perDayCap', 'minimumVisibleCharacters']) {
    finite(eligibility[key], `eligibility.${key}`);
    if (!Number.isInteger(eligibility[key])) throw new Error(`eligibility.${key} は整数である必要があります。`);
  }
  if (eligibility.windowDays > 90) throw new Error('activity保持期間の上限は90日です。');
  if (eligibility.minimumVisibleCharacters > 2000) throw new Error('minimumVisibleCharactersがDiscord本文上限を超えています。');
  if (eligibility.minimumActiveDays > eligibility.windowDays) throw new Error('活動日数が集計期間を超えています。');
  if (eligibility.minimumMessages > eligibility.windowDays * eligibility.perDayCap) {
    throw new Error('message要件が集計期間と日次上限では到達不能です。');
  }
  if (!['all', 'trusted'].includes(voting.defaultScope)) throw new Error('voting.defaultScope が不正です。');
  if (!Array.isArray(voting.allowedScopes)
    || voting.allowedScopes.length < 1
    || new Set(voting.allowedScopes).size !== voting.allowedScopes.length
    || voting.allowedScopes.some((scope) => !['all', 'trusted'].includes(scope))
    || !voting.allowedScopes.includes(voting.defaultScope)) {
    throw new Error('voting.allowedScopes が不正です。');
  }
  for (const key of ['lawYesRatio', 'amendmentYesRatio', 'trustedVetoRatio', 'quorumRatio']) {
    finite(voting[key], `voting.${key}`, { max: 1 });
  }
  finite(voting.minimumBallots, 'voting.minimumBallots', { max: 100_000 });
  if (!Number.isInteger(voting.minimumBallots)) throw new Error('voting.minimumBallots は整数である必要があります。');
  if (voting.publicBallots !== true) throw new Error('v1の投票は全記名です。');
  const legislationKeys = [
    'voteMilliseconds', 'sessionIntervalMilliseconds', 'agendaLimit', 'maximumDeferrals', 'logScan'
  ];
  const allowedLegislationKeys = new Set(legislationKeys);
  if (Object.keys(legislation).some((key) => !allowedLegislationKeys.has(key))
    || legislationKeys.some((key) => !(key in legislation))) {
    throw new Error('legislationに未対応の設定があります。');
  }
  for (const key of ['voteMilliseconds', 'sessionIntervalMilliseconds']) {
    finite(legislation[key], `legislation.${key}`, { min: technicalOnly ? 60_000 : 3_600_000 });
    if (!Number.isInteger(legislation[key])) throw new Error(`legislation.${key} は整数である必要があります。`);
  }
  for (const key of ['agendaLimit', 'maximumDeferrals']) {
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
  if (judiciary.panelSeats < 1 || judiciary.panelSeats > 5 || judiciary.panelSeats % 2 === 0) {
    throw new Error('panelSeatsは1, 3, 5のいずれかです。');
  }
  if (judiciary.defenseMilliseconds < (technicalOnly ? 60_000 : 3_600_000)
    || judiciary.appealMilliseconds < (technicalOnly ? 60_000 : 3_600_000)) {
    throw new Error('答弁・上訴期間は最低1時間必要です。');
  }
  if (policy.schemaVersion === 2) {
    const procedure = judiciary.policeProcedure;
    if (!procedure || typeof procedure !== 'object' || Array.isArray(procedure)) {
      throw new Error('policeProcedureがありません。');
    }
    const allowedKeys = new Set([
      'panelSeats', 'votesRequired', 'contestMilliseconds', 'detentionMaximumSeconds',
      'immediateSanctions', 'courtFirstSanctions', 'unlimitedWarningContest'
    ]);
    if (Object.keys(procedure).some((key) => !allowedKeys.has(key))) {
      throw new Error('policeProcedureに未対応の設定があります。');
    }
    for (const key of ['panelSeats', 'votesRequired', 'contestMilliseconds', 'detentionMaximumSeconds']) {
      if (!Number.isInteger(procedure[key])) throw new Error(`policeProcedure.${key}は整数である必要があります。`);
    }
    if (procedure.panelSeats < 1 || procedure.panelSeats > 5 || procedure.panelSeats % 2 === 0
      || procedure.votesRequired < 1 || procedure.votesRequired > procedure.panelSeats) {
      throw new Error('policeProcedureの席数または必要票が不正です。');
    }
    // 拘留は保全なので、不服申立ての期限より長く続けられない。
    if (procedure.detentionMaximumSeconds * 1000 > procedure.contestMilliseconds) {
      throw new Error('拘留の上限は不服申立て期間を超えられません。');
    }
    const validSanctionSet = (value) => Array.isArray(value)
      && new Set(value).size === value.length
      && value.every((entry) => ['warning', 'restriction', 'timeout', 'kick', 'ban'].includes(entry));
    // どの処分を警察が打てるかは憲法が決める。コードは重複と未知の種別だけ弾く。
    if (!validSanctionSet(procedure.immediateSanctions)
      || !validSanctionSet(procedure.courtFirstSanctions)
      || procedure.immediateSanctions.some((entry) => procedure.courtFirstSanctions.includes(entry))) {
      throw new Error('警察の即時処分・裁判所送りの区分が不正です。');
    }
    if (typeof procedure.unlimitedWarningContest !== 'boolean') {
      throw new Error('warningの不服申立て設定が不正です。');
    }
  }
  if (judiciary.constitutionalChallengesPerMemberPerDay < 1
    || judiciary.constitutionalChallengesPerMemberPerDay > (technicalOnly ? 1000 : 100)) {
    throw new Error(`違憲審査申立て枠は1-${technicalOnly ? 1000 : 100}回です。`);
  }
  if (judiciary.guiltyVotesRequired < 1) throw new Error('guiltyVotesRequiredは1以上です。');
  if (judiciary.constitutionalVotesRequired < 1 || judiciary.unconstitutionalVotesRequired < 1) {
    throw new Error('違憲審査の必要票は1以上です。');
  }
  if (judiciary.guiltyVotesRequired > judiciary.panelSeats
    || judiciary.constitutionalVotesRequired > judiciary.panelSeats
    || judiciary.unconstitutionalVotesRequired > judiciary.panelSeats) {
    throw new Error('panelの必要票が席数を超えています。');
  }
  if (judiciary.discordMaximumTimeoutSeconds > 2_419_200) throw new Error('Discordのtimeout上限を超えています。');
  if (judiciary.maximumTimeoutSeconds > judiciary.discordMaximumTimeoutSeconds
    || judiciary.immediateTimeoutMaximumSeconds > judiciary.maximumTimeoutSeconds
    || judiciary.appealTimeoutMinimumSeconds > judiciary.maximumTimeoutSeconds) {
    throw new Error('timeoutの承認・上訴境界がDiscord上限を超えています。');
  }
  const allowed = new Set(['warning', 'restriction', 'timeout', 'kick', 'ban']);
  if (!Array.isArray(judiciary.allowedSanctions)
    || new Set(judiciary.allowedSanctions).size !== judiciary.allowedSanctions.length
    || judiciary.allowedSanctions.some((value) => !allowed.has(value))) {
    throw new Error('許可されていない制裁種別があります。');
  }
  const primitives = new Set([
    'messages_per_window', 'block_links', 'block_attachments', 'block_mentions',
    'block_reactions', 'block_thread_creation', 'block_voice',
    'agent_calls_per_window', 'block_petitions', 'block_voting'
  ]);
  if (!Array.isArray(judiciary.restrictionPrimitives)
    || new Set(judiciary.restrictionPrimitives).size !== judiciary.restrictionPrimitives.length
    || judiciary.restrictionPrimitives.some((value) => !primitives.has(value))) {
    throw new Error('許可されていない制限制御があります。');
  }
  // 席の調査手数は警察手続と同じ世代の規則なので、schemaVersion 2 でだけ要求する。
  if (policy.schemaVersion === 2) validateInvestigationPolicy(policy.investigation);
  return policy;
}

// 席の調査手数と公開粒度。値そのものは憲法が決めるので、ここは形と技術上限だけを見る。
export function validateInvestigationPolicy(investigation) {
  if (!investigation) throw new Error('憲法policyにinvestigationがありません。');
  const roles = ['police', 'court', 'parliament'];
  const allowed = new Set([
    'maximumSteps', 'maximumOutputKilobytes', 'maximumMinutes',
    'tools', 'publicRecord', 'maximumRedefense'
  ]);
  if (Object.keys(investigation).some((key) => !allowed.has(key))
    || [...allowed].some((key) => !(key in investigation))) {
    throw new Error('investigationに未対応の設定があります。');
  }
  for (const key of ['maximumSteps', 'maximumOutputKilobytes', 'maximumMinutes', 'tools']) {
    if (Object.keys(investigation[key]).sort().join(',') !== [...roles].sort().join(',')) {
      throw new Error(`investigation.${key} は police/court/parliament の3つです。`);
    }
  }
  for (const role of roles) {
    for (const [key, max] of [['maximumSteps', 20], ['maximumOutputKilobytes', 256], ['maximumMinutes', 30]]) {
      finite(investigation[key][role], `investigation.${key}.${role}`, { min: 1, max });
      if (!Number.isInteger(investigation[key][role])) {
        throw new Error(`investigation.${key}.${role} は整数である必要があります。`);
      }
    }
    const tools = investigation.tools[role];
    if (!Array.isArray(tools) || new Set(tools).size !== tools.length) {
      throw new Error(`investigation.tools.${role} が不正です。`);
    }
  }
  if (!['none', 'summary', 'full'].includes(investigation.publicRecord)) {
    throw new Error('investigation.publicRecord は none、summary または full です。');
  }
  finite(investigation.maximumRedefense, 'investigation.maximumRedefense', { min: 0, max: 3 });
  if (!Number.isInteger(investigation.maximumRedefense)) {
    throw new Error('investigation.maximumRedefense は整数である必要があります。');
  }
  return investigation;
}

export function policyHash(policy) {
  return sha256(canonicalJson(validateConstitutionPolicy(policy)));
}

export function activityDate(timestamp, offsetMinutes) {
  return new Date(Number(timestamp) + offsetMinutes * 60_000).toISOString().slice(0, 10);
}

export function normalizeActivityContent(content) {
  return String(content ?? '')
    .normalize('NFKC')
    .replace(/<@!?\d+>/g, '@user')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

export function qualifyingActivity(message, policy) {
  if (!message?.guildId || message.author?.bot) return null;
  const normalized = normalizeActivityContent(message.content);
  if (Array.from(normalized).length < policy.eligibility.minimumVisibleCharacters) return null;
  if (/^[/!]/.test(normalized)) return null;
  return {
    messageId: String(message.id),
    guildId: String(message.guildId),
    channelId: String(message.channelId),
    userId: String(message.author.id),
    activityDate: activityDate(message.createdTimestamp ?? Date.now(), policy.timezoneOffsetMinutes),
    contentHash: sha256(normalized),
    createdAt: Number(message.createdTimestamp ?? Date.now())
  };
}

export function evaluateEligibility({ joinedAt, now = Date.now(), dailyUniqueCounts }, policy) {
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

export function requiredApprovals(sanction, policy) {
  if (!sanction) return Infinity;
  if (sanction.type === 'kick') return policy.judiciary.kickApprovals;
  if (sanction.type === 'ban') return policy.judiciary.banApprovals;
  if (sanction.type === 'timeout' && sanction.durationSeconds > policy.judiciary.immediateTimeoutMaximumSeconds) {
    return policy.judiciary.timeoutApprovalsAboveSeconds;
  }
  if (policeProcedure(policy)) return 0;
  return 0;
}

export function isAppealable(sanction, policy) {
  return sanction?.type === 'ban'
    || (sanction?.type === 'timeout'
      && sanction.durationSeconds >= policy.judiciary.appealTimeoutMinimumSeconds);
}

const SANCTION_RANK = {
  none: 0,
  warning: 1,
  restriction: 2,
  timeout: 3,
  kick: 4,
  ban: 5
};

export function conservativePanelSanction(decisions) {
  const ranked = decisions.map((decision) => {
    if (decision.verdict !== 'responsible') return { type: 'none', durationSeconds: 0 };
    return decision.sanction ?? { type: 'none', durationSeconds: 0 };
  }).sort((a, b) => {
    const rank = (SANCTION_RANK[a.type] ?? Infinity) - (SANCTION_RANK[b.type] ?? Infinity);
    return rank || Number(a.durationSeconds ?? 0) - Number(b.durationSeconds ?? 0);
  });
  const middle = ranked[Math.floor(ranked.length / 2)] ?? { type: 'none', durationSeconds: 0 };
  return middle.type === 'none' ? null : middle;
}

export function leastSevereResponsibleSanction(decisions) {
  const ranked = decisions
    .filter((decision) => decision.verdict === 'responsible' && decision.sanction)
    .map((decision) => decision.sanction)
    .sort((a, b) => {
      const rank = (SANCTION_RANK[a.type] ?? Infinity) - (SANCTION_RANK[b.type] ?? Infinity);
      if (rank) return rank;
      const duration = Number(a.durationSeconds ?? 0) - Number(b.durationSeconds ?? 0);
      if (duration) return duration;
      return String(a.definitionCode ?? '').localeCompare(String(b.definitionCode ?? ''));
    });
  return ranked[0] ?? null;
}

export function sanctionNoMoreSevere(candidate, original) {
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

export function validateSanctionAgainstOffense(sanction, offense, policy) {
  if (!sanction || !offense) return false;
  if (!policy.judiciary.allowedSanctions.includes(sanction.type)) return false;
  const allowed = offense.sanctions?.find((entry) => entry.type === sanction.type
    && (sanction.type !== 'restriction' || entry.definitionCode === sanction.definitionCode));
  if (!allowed) return false;
  if (sanction.type === 'restriction') {
    const duration = Number(sanction.durationSeconds);
    const definition = offense.restrictionDefinitions?.find((entry) => entry.code === sanction.definitionCode);
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

export function validateRestrictionDefinition(definition, policy) {
  if (!definition || typeof definition.code !== 'string' || !/^[A-Z0-9_]{3,40}$/.test(definition.code)) return false;
  if (!Array.isArray(definition.rules) || definition.rules.length < 1 || definition.rules.length > 12) return false;
  const allowed = new Set(policy.judiciary.restrictionPrimitives);
  const seen = new Set();
  for (const rule of definition.rules) {
    if (!rule || !allowed.has(rule.primitive) || seen.has(rule.primitive)) return false;
    seen.add(rule.primitive);
    if (rule.primitive === 'messages_per_window' || rule.primitive === 'agent_calls_per_window') {
      if (Object.keys(rule).some((key) => !['primitive', 'maximum', 'windowSeconds'].includes(key))) return false;
      if (!Number.isInteger(rule.maximum) || rule.maximum < 0 || rule.maximum > 10_000) return false;
      if (!Number.isInteger(rule.windowSeconds) || rule.windowSeconds < 60 || rule.windowSeconds > 2_592_000) return false;
    } else {
      if (Object.keys(rule).some((key) => !['primitive', 'enabled'].includes(key))) return false;
      if (rule.enabled !== true) return false;
    }
  }
  return true;
}
