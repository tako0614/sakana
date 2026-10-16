import { canonicalJson, sha256 } from './policy.js';
import { legalDuration } from './legal-system.js';
import { isEffectiveLegalSystem, type CompiledLegalSystem, type GovernanceRules, type LegalBaseline } from './types.js';

function causeMessage(cause: unknown): string {
  return String(typeof cause === 'object' && cause !== null && 'message' in cause ? cause.message : undefined);
}

// This authority comes from the constitution, not from the invalidated organization law.
// Retain the last valid amendment procedure only for a replacement law and rights relief.
export function compileLegalRecovery(
  constitution: { id: number; content_hash: string; rules: GovernanceRules | null },
  baseline: LegalBaseline | null,
  cause: unknown
): CompiledLegalSystem {
  // 最後に有効だった v2 の法体系が無ければ、暫定権限も組み立てられない。元の失敗をそのまま返す。
  if (!baseline || !isEffectiveLegalSystem(baseline.rules) || !isEffectiveLegalSystem(constitution.rules)) throw cause;
  const rules = structuredClone(baseline.rules);
  const authority = constitution.rules.authority;
  if (!authority.recovery || baseline.constitutionId !== constitution.id
    || baseline.constitutionHash !== constitution.content_hash) throw cause;
  rules.authority = structuredClone(authority);
  const procedure = rules.workflows.constitutionalAmendment;
  for (const state of Object.values(procedure.states)) {
    if (state.handler === 'public_vote' && legalDuration(state.duration) < legalDuration(authority.recovery.minimumVoteDuration)) {
      state.duration = authority.recovery.minimumVoteDuration;
    }
  }
  const amendmentBinding = rules.bindings.constitutionalAmendment;
  if (!amendmentBinding) throw cause;
  rules.bindings.law = structuredClone(amendmentBinding);
  rules.workflows.law = procedure;
  rules.procedures[amendmentBinding.target] = procedure;
  rules.votes.law = structuredClone(rules.votes.constitutionalAmendment);
  rules.votes.law.earlyClose = 'never';
  rules.votes.allowedScopes = ['all'];
  rules.votes.defaultScope = 'all';
  rules.recovery = { baselineHash: baseline.rulesHash, cause: causeMessage(cause),
    powers: ['repair_law', 'rights_relief'] };
  const policy = structuredClone(baseline.policy);
  policy.voting.defaultScope = 'all';
  policy.voting.allowedScopes = ['all'];
  policy.voting.lawYesRatio = rules.votes.law.yesRatio;
  policy.voting.quorumRatio = rules.votes.law.quorumRatio;
  policy.voting.minimumBallots = rules.votes.law.minimumBallots;
  return { rules, policy, rulesHash: sha256(canonicalJson(rules)), sourceFormat: 'constitutional-recovery-v2', compilerVersion: 2 };
}
