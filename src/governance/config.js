import { readFileSync } from 'node:fs';

function number(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function boundedInteger(value, fallback, maximum) {
  return Math.max(0, Math.min(maximum, Math.floor(number(value, fallback))));
}

function flag(value, fallback) {
  if (value === undefined || value === '') return fallback;
  return !['0', 'false', 'no', 'off'].includes(String(value).toLowerCase());
}

function list(value) {
  return String(value ?? '').split(/[\s,]+/).filter(Boolean);
}

function firstNonEmpty(...values) {
  return values.find((value) => String(value ?? '').trim() !== '') ?? '';
}

function models(value, fallback) {
  const parsed = list(value);
  if (parsed.length === 0) return [fallback];
  return parsed;
}

const defaultModel = firstNonEmpty(
  process.env.GOVERNANCE_MODEL,
  process.env.DEEPSEEK_MODEL,
  'deepseek-v4-flash'
);

export const governanceConfig = {
  enabled: flag(process.env.GOVERNANCE_ENABLED, true),
  operators: list(process.env.GOVERNANCE_OPERATOR_USERS),
  apiKey: firstNonEmpty(process.env.GOVERNANCE_API_KEY, process.env.DEEPSEEK_API_KEY),
  baseUrl: firstNonEmpty(
    process.env.GOVERNANCE_BASE_URL,
    process.env.DEEPSEEK_BASE_URL,
    'https://api.deepseek.com'
  )
    .replace(/\/+$/, ''),
  drafterModel: firstNonEmpty(process.env.GOVERNANCE_DRAFTER_MODEL, defaultModel),
  judgeModels: models(process.env.GOVERNANCE_JUDGE_MODELS, defaultModel),
  appealModels: models(process.env.GOVERNANCE_APPEAL_MODELS, defaultModel),
  maxOutputTokens: number(process.env.GOVERNANCE_MAX_OUTPUT_TOKENS, 8000),
  httpTimeoutMs: number(process.env.GOVERNANCE_HTTP_TIMEOUT_MS, 120_000),
  maxConcurrent: Math.max(1, Math.floor(number(process.env.GOVERNANCE_MAX_CONCURRENT, 3))),
  lawSiteUrl: firstNonEmpty(process.env.GOVERNANCE_LAW_API_URL).replace(/\/+$/, ''),
  lawSiteToken: firstNonEmpty(process.env.GOVERNANCE_LAW_API_TOKEN),
  lawSitePublicUrl: firstNonEmpty(process.env.GOVERNANCE_LAW_SITE_URL).replace(/\/+$/, ''),
  schedulerIntervalMs: number(process.env.GOVERNANCE_SCHEDULER_INTERVAL_MS, 60_000),
  generalDailyCalls: number(process.env.GOVERNANCE_GENERAL_DAILY_CALLS, 20),
  trustedDailyCalls: number(process.env.GOVERNANCE_TRUSTED_DAILY_CALLS, 200),
  notificationEveryoneDailyLimit: boundedInteger(process.env.GOVERNANCE_NOTIFICATION_EVERYONE_DAILY_LIMIT, 3, 10),
  notificationTrustedDailyLimit: boundedInteger(process.env.GOVERNANCE_NOTIFICATION_TRUSTED_DAILY_LIMIT, 10, 50),
  notificationUserDailyLimit: boundedInteger(process.env.GOVERNANCE_NOTIFICATION_USER_DAILY_LIMIT, 5, 20),
  investigationLookbackDays: boundedInteger(process.env.GOVERNANCE_INVESTIGATION_LOOKBACK_DAYS, 30, 90),
  investigationCaseLimit: boundedInteger(process.env.GOVERNANCE_INVESTIGATION_CASE_LIMIT, 5, 10)
};

export function communityDisplayName(value) {
  const normalized = String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100);
  return normalized || 'Community';
}

function constitutionServerName(value) {
  return communityDisplayName(value).replace(/([\\`*_{}\[\]()<>#+\-.!|])/g, '\\$1');
}

export function governanceCategoryName(serverName) {
  const suffix = ' 統治';
  return `${communityDisplayName(serverName).slice(0, 100 - suffix.length)}${suffix}`;
}

export function renderBootstrapConstitution(template, serverName) {
  return String(template).replaceAll('{{SERVER_NAME}}', constitutionServerName(serverName));
}

export function loadBootstrapDocuments({ serverName = 'Community' } = {}) {
  const template = readFileSync(new URL('../../governance/constitution.md', import.meta.url), 'utf8').trim();
  const constitution = renderBootstrapConstitution(template, serverName);
  const policy = JSON.parse(readFileSync(new URL('../../governance/policy.json', import.meta.url), 'utf8'));
  return { constitution, policy };
}

export function isGovernanceOperator(member) {
  if (!member?.id || !member.guild) return false;
  return member.id === member.guild.ownerId || governanceConfig.operators.includes(member.id);
}

export const OPERATIONAL_SETTING_DEFAULTS = Object.freeze({
  general_daily_calls: governanceConfig.generalDailyCalls,
  trusted_daily_calls: governanceConfig.trustedDailyCalls,
  notification_everyone_daily_limit: governanceConfig.notificationEveryoneDailyLimit,
  notification_trusted_daily_limit: governanceConfig.notificationTrustedDailyLimit,
  notification_user_daily_limit: governanceConfig.notificationUserDailyLimit,
  // 席が自分で検索するようになったので、事前詰め込みの件数設定は廃止した。
  // 残るのは席へ渡す既定の遡り日数と、1回の通報で事件化できる上限だけ。
  investigation_lookback_days: governanceConfig.investigationLookbackDays,
  investigation_case_limit: governanceConfig.investigationCaseLimit
});

export function parseOperationalSetting(key, raw) {
  if (!(key in OPERATIONAL_SETTING_DEFAULTS)) return { ok: false, error: '変更できない設定です。' };
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) return { ok: false, error: '0以上の整数を指定してください。' };
  if (key.endsWith('_daily_calls') && value > 10_000) return { ok: false, error: 'AI受付回数は10000以下です。' };
  const investigationMaximums = {
    investigation_lookback_days: 90,
    investigation_case_limit: 10
  };
  if (key in investigationMaximums && value > investigationMaximums[key]) {
    return { ok: false, error: `AI調査設定は${investigationMaximums[key]}以下です。` };
  }
  const notificationMaximums = {
    notification_everyone_daily_limit: 10,
    notification_trusted_daily_limit: 50,
    notification_user_daily_limit: 20
  };
  if (key in notificationMaximums && value > notificationMaximums[key]) {
    return { ok: false, error: `通知上限は${notificationMaximums[key]}以下です。` };
  }
  return { ok: true, value };
}
