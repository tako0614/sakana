import {
  constitutionForSubject, getActiveConstitution, getCase, getGovernanceGuild, getSanction,
  lawForCase, legalApprovalResult, listCaseApprovals, sanctionApprovalHash
} from './db.js';

// Shared by the Bot adapter and the human completion button. Always read fresh records.
export function assertSanctionExecution(sanctionId, { expectedHash, expectedMode, statuses = ['queued', 'pending_manual_execution'] } = {}) {
  const fail = (message) => { const error = new Error(message); error.code = expectedHash ? 'EXECUTION_REVOKED' : 'EXECUTION_FORBIDDEN'; throw error; };
  const sanction = getSanction(sanctionId);
  if (!sanction || !statuses.includes(sanction.status)
    || (expectedHash && sanctionApprovalHash(sanction) !== expectedHash)) fail('処分が変更・取消されています。');
  const record = getCase(sanction.case_id);
  const current = getActiveConstitution(sanction.guild_id);
  const governance = getGovernanceGuild(sanction.guild_id);
  if (governance?.status !== 'active' || current?.rules?.recovery) fail('制度の停止・修復中は処分を執行できません。');
  if (expectedMode && governance.enforcement_mode !== expectedMode) fail('執行モードが変更されています。');
  const constitution = constitutionForSubject('case', record);
  if (record.finalized_at || (constitution.policy.autonomous
    ? record.workflow_handler !== 'sanction_execution' : record.status !== 'execution')) fail('現在の裁定は執行を許可していません。');
  if (record.law_id) {
    try { lawForCase(record); } catch (error) { fail(error.message); }
  }
  if (constitution.policy.autonomous) {
    const veto = Object.values(constitution.rules.workflows.criminalCase.states)
      .some((state) => state.handler === 'human_approval' && state.config.veto);
    if ((sanction.required_approvals > 0 || veto) && !legalApprovalResult(record.id).passed) fail('必要な承認・拒否期間が完了していません。');
  } else if (listCaseApprovals(record.id).filter((entry) => entry.decision === 'approve').length < sanction.required_approvals) {
    fail('必要な執行承認がありません。');
  }
  return sanction;
}
