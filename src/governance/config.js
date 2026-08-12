import { readFileSync } from 'node:fs';

function number(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
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
  maxConcurrent: Math.max(1, Math.floor(number(process.env.GOVERNANCE_MAX_CONCURRENT, 2))),
  weeklyScanEnabled: flag(process.env.GOVERNANCE_WEEKLY_SCAN, true),
  weeklyDraftLimit: number(process.env.GOVERNANCE_WEEKLY_DRAFT_LIMIT, 3),
  schedulerIntervalMs: number(process.env.GOVERNANCE_SCHEDULER_INTERVAL_MS, 60_000),
  generalDailyCalls: number(process.env.GOVERNANCE_GENERAL_DAILY_CALLS, 20),
  trustedDailyCalls: number(process.env.GOVERNANCE_TRUSTED_DAILY_CALLS, 200)
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
  const suffix = ' Governance';
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
  weekly_scan_enabled: governanceConfig.weeklyScanEnabled ? 1 : 0,
  weekly_draft_limit: governanceConfig.weeklyDraftLimit,
  general_daily_calls: governanceConfig.generalDailyCalls,
  trusted_daily_calls: governanceConfig.trustedDailyCalls
});

export function parseOperationalSetting(key, raw) {
  if (!(key in OPERATIONAL_SETTING_DEFAULTS)) return { ok: false, error: '変更できない設定です。' };
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) return { ok: false, error: '0以上の整数を指定してください。' };
  if (key === 'weekly_scan_enabled' && ![0, 1].includes(value)) {
    return { ok: false, error: 'weekly_scan_enabled は 0 または 1 です。' };
  }
  if (key === 'weekly_draft_limit' && value > 10) return { ok: false, error: 'weekly_draft_limit は10以下です。' };
  if (key.endsWith('_daily_calls') && value > 10_000) return { ok: false, error: 'daily_calls は10000以下です。' };
  return { ok: true, value };
}
