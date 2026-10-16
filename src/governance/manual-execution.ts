import { PermissionFlagsBits, type Guild, type GuildMember } from 'discord.js';
import { db } from '../db.js';
import { sha256 } from './policy.js';
import { assertSanctionExecution } from './execution-authority.js';
import {
  createAdministrativeAct, enqueueAction, getSanction,
  sanctionApprovalHash, updateCase, updateSanction, writeAudit
} from './db.js';
import { isArray, isRecord, type Sanction, type UnknownRecord } from './types.js';

// This boundary is a deployment capability, not a power an AI-authored law can grant.
export const requiresManualExecution = <T extends { type?: string | null }>(sanction: T | null | undefined): sanction is T => (
  sanction?.type === 'ban' || sanction?.type === 'kick'
);
export const manualExecutionDetail = (sanction: { execution_detail?: string | null } | null | undefined): UnknownRecord => {
  try {
    const detail: unknown = JSON.parse(sanction?.execution_detail ?? '{}');
    return isRecord(detail) ? detail : {};
  } catch { return {}; }
};

/** 管理者への執行・取消依頼。報告ボタンの key と対象の hash で、依頼後の変更を見分ける。 */
interface ManualRequest {
  kind: string;
  requestedAt: number;
  targetHash: string;
  previousStatus: string;
  priorExecutionReported: boolean;
  key: string;
}

function manualRequest(value: unknown): ManualRequest | null {
  if (!isRecord(value) || typeof value.kind !== 'string' || typeof value.key !== 'string' || typeof value.targetHash !== 'string') return null;
  return {
    ...value,
    kind: value.kind,
    requestedAt: Number(value.requestedAt),
    targetHash: value.targetHash,
    previousStatus: String(value.previousStatus),
    priorExecutionReported: Boolean(value.priorExecutionReported),
    key: value.key
  };
}

const assertExecutionAllowed = (sanction: Sanction): Sanction => assertSanctionExecution(sanction.id);

export const requestManualExecution = db.transaction((sanctionId: number | string, kind: string = 'execute'): Sanction | null => {
  const sanction = getSanction(sanctionId);
  if (!requiresManualExecution(sanction) || !['execute', 'reverse'].includes(kind)) throw new Error('管理者への執行依頼が不正です。');
  const detail = manualExecutionDetail(sanction);
  const status = kind === 'execute' ? 'pending_manual_execution' : 'pending_manual_reversal';
  if (sanction.status === status || (kind === 'reverse' && sanction.status === 'reversed')) return sanction;
  if (kind === 'execute') {
    if (sanction.status !== 'queued') throw new Error('執行依頼の準備ができていません。');
    assertExecutionAllowed(sanction);
  }
  const base = { kind, requestedAt: Date.now(), targetHash: sanctionApprovalHash(sanction),
    previousStatus: sanction.status, priorExecutionReported: Boolean(sanction.executed_at) };
  const request = { ...base, key: sha256(JSON.stringify({ sanctionId, ...base })).slice(0, 32) };
  const updated = updateSanction(sanction.id, { status,
    execution_detail: JSON.stringify({ ...detail, manualRequest: request }) });
  enqueueAction({ guildId: sanction.guild_id, actionType: 'manual_sanction_notice', targetId: sanction.id,
    payload: { sanctionId: sanction.id, kind, requestedAt: request.requestedAt },
    idempotencyKey: `manual-sanction:${sanction.id}:${kind}:${request.requestedAt}` });
  return updated;
});

export async function requireManualExecutor(guild: Guild, userId: string): Promise<GuildMember> {
  const member = await guild.members.fetch({ user: userId, force: true });
  if (!member || member.user.bot || (member.id !== guild.ownerId && !member.permissions.has(PermissionFlagsBits.Administrator))) {
    throw new Error('執行結果を報告できるのは人間のサーバー管理者だけです。');
  }
  return member;
}

export interface ManualExecutionReport {
  sanctionId: number | string;
  requestKey: string;
  result: string;
}

const saveReport = db.transaction(({ guildId, userId, sanctionId, requestKey, result }: ManualExecutionReport & { guildId: string; userId: string }): Sanction | null => {
  const sanction = getSanction(sanctionId);
  const detail = manualExecutionDetail(sanction);
  const request = manualRequest(detail.manualRequest);
  const kind = request?.kind;
  const status = kind === 'execute' ? 'pending_manual_execution' : 'pending_manual_reversal';
  if (!sanction || sanction.guild_id !== guildId || !requiresManualExecution(sanction)
    || sanction.status !== status || !request || request.key !== requestKey
    || sanctionApprovalHash(sanction) !== request.targetHash) {
    throw new Error('執行依頼が変更・取消されています。最新の案件カードを確認してください。');
  }
  if (result !== 'done' && !(kind === 'reverse' && !request.priorExecutionReported && result === 'not_executed')) throw new Error('執行結果が不正です。');
  if (kind === 'execute') assertExecutionAllowed(sanction);
  const now = Date.now();
  const report = { ...request, reportedAt: now, reportedBy: userId, result,
    evidence: 'administrator_report' };
  const reports = isArray(detail.manualReports) ? detail.manualReports : [];
  const updated = updateSanction(sanction.id, { status: kind === 'execute' ? 'executed' : 'reversed',
    ...(kind === 'execute' ? { executed_at: now } : { reversed_at: now }),
    execution_detail: JSON.stringify({ ...detail, type: sanction.type, manualRequest: null,
      manualReports: [...reports, report] }) });
  if (kind === 'execute') updateCase(sanction.case_id, { status: 'final', finalized_at: now });
  if (kind === 'execute') createAdministrativeAct({ guildId, kind: 'judicial_execution', actorType: 'member', actorId: userId,
    summary: `管理者が ${sanction.type} の執行完了を報告`,
    detail: { operation: 'sanction_execution', sanctionId, caseId: sanction.case_id, report } });
  writeAudit({ guildId, actorType: 'member', actorId: userId, action: 'sanction.manual_report',
    targetType: 'sanction', targetId: sanctionId, detail: report });
  enqueueAction({ guildId, actionType: 'manual_sanction_notice', targetId: sanctionId,
    payload: { sanctionId, report }, idempotencyKey: `manual-sanction-report:${sanctionId}:${requestKey}` });
  return updated;
});

export async function reportManualExecution(guild: Guild, userId: string, input: ManualExecutionReport): Promise<Sanction | null> {
  await requireManualExecutor(guild, userId);
  return saveReport({ ...input, guildId: guild.id, userId });
}
