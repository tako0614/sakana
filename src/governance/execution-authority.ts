import {
  constitutionForSubject, getActiveConstitution, getCase, getGovernanceGuild, getSanction,
  lawForCase, legalApprovalResult, listCaseApprovals, sanctionApprovalHash
} from './db.js';
import { errorMessage, type Sanction } from './types.js';

export interface SanctionExecutionCheck {
  expectedHash?: string | null;
  expectedMode?: string | null;
  statuses?: readonly string[];
}

// Shared by the Bot adapter and the human completion button. Always read fresh records.
export function assertSanctionExecution(sanctionId: number | string, { expectedHash, expectedMode, statuses = ['queued', 'pending_manual_execution'] }: SanctionExecutionCheck = {}): Sanction {
  function fail(message: string): never {
    throw Object.assign(new Error(message), { code: expectedHash ? 'EXECUTION_REVOKED' : 'EXECUTION_FORBIDDEN' });
  }
  const sanction = getSanction(sanctionId);
  if (!sanction || !statuses.includes(sanction.status)
    || (expectedHash && sanctionApprovalHash(sanction) !== expectedHash)) fail('処分が変更・取消されています。');
  const record = getCase(sanction.case_id);
  const current = getActiveConstitution(sanction.guild_id);
  const governance = getGovernanceGuild(sanction.guild_id);
  if (governance?.status !== 'active' || current?.rules?.recovery) fail('制度の停止・修復中は処分を執行できません。');
  if (expectedMode && governance.enforcement_mode !== expectedMode) fail('執行モードが変更されています。');
  // 事件や憲法が読めなければ、執行の根拠を確かめられない。
  if (!record) fail('現在の裁定は執行を許可していません。');
  const constitution = constitutionForSubject('case', record);
  if (!constitution) fail('現在の裁定は執行を許可していません。');
  if (record.finalized_at || (constitution.policy.autonomous
    ? record.workflow_handler !== 'sanction_execution' : record.status !== 'execution')) fail('現在の裁定は執行を許可していません。');
  if (record.law_id) {
    try { lawForCase(record); } catch (error) { fail(errorMessage(error)); }
  }
  if (constitution.policy.autonomous) {
    const states = constitution.rules?.workflows.criminalCase.states;
    if (!states) fail('現在の裁定は執行を許可していません。');
    const veto = Object.values(states)
      .some((state) => state.handler === 'human_approval' && state.config.veto);
    if ((sanction.required_approvals > 0 || veto) && !legalApprovalResult(record.id).passed) fail('必要な承認・拒否期間が完了していません。');
  } else if (listCaseApprovals(record.id).filter((entry) => entry.decision === 'approve').length < sanction.required_approvals) {
    fail('必要な執行承認がありません。');
  }
  return sanction;
}
