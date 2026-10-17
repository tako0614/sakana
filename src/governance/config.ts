import { providerConfig } from '../ai/provider.js';
import { readFileSync } from 'node:fs';
import type { APIInteractionGuildMember } from 'discord.js';
import { compileConstitution } from './rules.js';
import { isLawProvisions, isRecord, type ConstitutionPolicy, type FoundingLaw } from './types.js';

function number(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function boundedInteger(value: unknown, fallback: number, maximum: number): number {
  return Math.max(0, Math.min(maximum, Math.floor(number(value, fallback))));
}

function flag(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === '') return fallback;
  return !['0', 'false', 'no', 'off'].includes(String(value).toLowerCase());
}

function list(value: string | undefined): string[] {
  return String(value ?? '').split(/[\s,]+/).filter(Boolean);
}

function firstNonEmpty(...values: (string | undefined)[]): string {
  return values.find((value) => String(value ?? '').trim() !== '') ?? '';
}

function models(value: string | undefined, fallback: string): string[] {
  const parsed = list(value);
  if (parsed.length === 0) return [fallback];
  return parsed;
}

const defaultModel = firstNonEmpty(
  process.env.GOVERNANCE_MODEL,
  providerConfig.model
);

export const governanceConfig = {
  enabled: flag(process.env.GOVERNANCE_ENABLED, true),
  operators: list(process.env.GOVERNANCE_OPERATOR_USERS),
  apiKey: providerConfig.apiKey,
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

export function communityDisplayName(value: unknown): string {
  const normalized = String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100);
  return normalized || 'Community';
}

function constitutionServerName(value: unknown): string {
  return communityDisplayName(value).replace(/([\\`*_{}\[\]()<>#+\-.!|])/g, '\\$1');
}

export function governanceCategoryName(serverName: unknown): string {
  const suffix = ' 統治';
  return `${communityDisplayName(serverName).slice(0, 100 - suffix.length)}${suffix}`;
}

export function renderBootstrapConstitution(template: unknown, serverName: unknown): string {
  return String(template).replaceAll('{{SERVER_NAME}}', constitutionServerName(serverName));
}

// 初期法令はリポジトリの中のJSON。ここでは形だけ確かめ、条項の中身は憲法の組み立てが検査する。
function parseFoundingLaw(value: unknown): FoundingLaw {
  if (!isRecord(value) || !isLawProvisions(value.provisions)
    || typeof value.code !== 'string' || typeof value.title !== 'string'
    || typeof value.summary !== 'string' || typeof value.text !== 'string') {
    throw new Error('初期法令の形式が不正です。');
  }
  return {
    code: value.code,
    title: value.title,
    summary: value.summary,
    text: value.text,
    // 各定義の中身は compileConstitution → validateLegalDefinitions が検査する。
    provisions: value.provisions
  };
}

export interface BootstrapDocuments {
  constitution: string;
  policy: ConstitutionPolicy | null;
  laws: FoundingLaw[];
}

export function loadBootstrapDocuments({ serverName = 'Community' }: { serverName?: string } = {}): BootstrapDocuments {
  const template = readFileSync(new URL('../../governance/constitution.md', import.meta.url), 'utf8').trim();
  const constitution = renderBootstrapConstitution(template, serverName);
  const raw: unknown = JSON.parse(readFileSync(new URL('../../governance/founding-laws/organization.json', import.meta.url), 'utf8'));
  const laws = [parseFoundingLaw(raw)];
  const { policy } = compileConstitution({ content: constitution, laws });
  return { constitution, policy, laws };
}

/** 統治運営者の判定に使う、Discord の GuildMember のうち読む項目。 */
export interface OperatorCandidate {
  id?: string | null;
  guild?: { ownerId: string } | null;
}

/** interaction.member はキャッシュ内なら GuildMember。キャッシュ外のサーバーでは API の素のメンバー (id を持たない) で、運営者とは判定できない。 */
export function isGovernanceOperator(member: OperatorCandidate | APIInteractionGuildMember | null | undefined): boolean {
  if (!member || !('id' in member) || !member.id || !member.guild) return false;
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

export type OperationalSettingKey = keyof typeof OPERATIONAL_SETTING_DEFAULTS;

// in 演算子は prototype の名前 (toString, __proto__ など) も通す。自分の項目だけを設定名と認める。
export function isOperationalSettingKey(key: unknown): key is OperationalSettingKey {
  return typeof key === 'string' && Object.hasOwn(OPERATIONAL_SETTING_DEFAULTS, key);
}

export type OperationalSettingResult = { ok: true; value: number } | { ok: false; error: string };

export function parseOperationalSetting(key: string, raw: unknown): OperationalSettingResult {
  if (!isOperationalSettingKey(key)) return { ok: false, error: '変更できない設定です。' };
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) return { ok: false, error: '0以上の整数を指定してください。' };
  if (key.endsWith('_daily_calls') && value > 10_000) return { ok: false, error: 'AI受付回数は10000以下です。' };
  const investigationMaximums: Partial<Record<OperationalSettingKey, number>> = {
    investigation_lookback_days: 90,
    investigation_case_limit: 10
  };
  const investigationMaximum = investigationMaximums[key];
  if (investigationMaximum !== undefined && value > investigationMaximum) {
    return { ok: false, error: `AI調査設定は${investigationMaximum}以下です。` };
  }
  const notificationMaximums: Partial<Record<OperationalSettingKey, number>> = {
    notification_everyone_daily_limit: 10,
    notification_trusted_daily_limit: 50,
    notification_user_daily_limit: 20
  };
  const notificationMaximum = notificationMaximums[key];
  if (notificationMaximum !== undefined && value > notificationMaximum) {
    return { ok: false, error: `通知上限は${notificationMaximum}以下です。` };
  }
  return { ok: true, value };
}
