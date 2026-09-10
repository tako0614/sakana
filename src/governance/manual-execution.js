import { PermissionFlagsBits } from 'discord.js';
import { db } from '../db.js';
import { sha256 } from './policy.js';
import { assertSanctionExecution } from './execution-authority.js';
import {
  createAdministrativeAct, enqueueAction, getSanction,
  sanctionApprovalHash, updateCase, updateSanction, writeAudit
} from './db.js';

// This boundary is a deployment capability, not a power an AI-authored law can grant.
export const requiresManualExecution = (sanction) => ['ban', 'kick'].includes(sanction?.type);
export const manualExecutionDetail = (sanction) => {
  try { return JSON.parse(sanction?.execution_detail ?? '{}'); } catch { return {}; }
};

const assertExecutionAllowed = (sanction) => assertSanctionExecution(sanction.id);

export const requestManualExecution = db.transaction((sanctionId, kind = 'execute') => {
  const sanction = getSanction(sanctionId);
  if (!requiresManualExecution(sanction) || !['execute', 'reverse'].includes(kind)) throw new Error('管理者への執行依頼が不正です。');
  const detail = manualExecutionDetail(sanction);
  const status = kind === 'execute' ? 'pending_manual_execution' : 'pending_manual_reversal';
  if (sanction.status === status || (kind === 'reverse' && sanction.status === 'reversed')) return sanction;
  if (kind === 'execute') {
    if (sanction.status !== 'queued') throw new Error('執行依頼の準備ができていません。');
    assertExecutionAllowed(sanction);
  }
  const request = { kind, requestedAt: Date.now(), targetHash: sanctionApprovalHash(sanction),
    previousStatus: sanction.status, priorExecutionReported: Boolean(sanction.executed_at) };
  request.key = sha256(JSON.stringify({ sanctionId, ...request })).slice(0, 32);
  const updated = updateSanction(sanction.id, { status,
    execution_detail: JSON.stringify({ ...detail, manualRequest: request }) });
  enqueueAction({ guildId: sanction.guild_id, actionType: 'manual_sanction_notice', targetId: sanction.id,
    payload: { sanctionId: sanction.id, kind, requestedAt: request.requestedAt },
    idempotencyKey: `manual-sanction:${sanction.id}:${kind}:${request.requestedAt}` });
  return updated;
});

export async function requireManualExecutor(guild, userId) {
  const member = await guild.members.fetch({ user: userId, force: true });
  if (!member || member.user.bot || (member.id !== guild.ownerId && !member.permissions.has(PermissionFlagsBits.Administrator))) {
    throw new Error('執行結果を報告できるのは人間のサーバー管理者だけです。');
  }
  return member;
}

const saveReport = db.transaction(({ guildId, userId, sanctionId, requestKey, result }) => {
  const sanction = getSanction(sanctionId);
  const detail = manualExecutionDetail(sanction);
  const request = detail.manualRequest;
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
  const updated = updateSanction(sanction.id, { status: kind === 'execute' ? 'executed' : 'reversed',
    ...(kind === 'execute' ? { executed_at: now } : { reversed_at: now }),
    execution_detail: JSON.stringify({ ...detail, type: sanction.type, manualRequest: null,
      manualReports: [...(detail.manualReports ?? []), report] }) });
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

export async function reportManualExecution(guild, userId, input) {
  await requireManualExecutor(guild, userId);
  return saveReport({ ...input, guildId: guild.id, userId });
}
