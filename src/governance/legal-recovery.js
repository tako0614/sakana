import { canonicalJson, sha256 } from './policy.js';
import { legalDuration } from './legal-system.js';

// This authority comes from the constitution, not from the invalidated organization law.
// Retain the last valid amendment procedure only for a replacement law and rights relief.
export function compileLegalRecovery(constitution, baseline, cause) {
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
  rules.bindings.law = structuredClone(rules.bindings.constitutionalAmendment);
  rules.workflows.law = procedure;
  rules.procedures[rules.bindings.law.target] = procedure;
  rules.votes.law = structuredClone(rules.votes.constitutionalAmendment);
  rules.votes.law.earlyClose = 'never';
  rules.votes.allowedScopes = ['all'];
  rules.votes.defaultScope = 'all';
  rules.recovery = { baselineHash: baseline.rulesHash, cause: String(cause.message),
    powers: ['repair_law', 'rights_relief'] };
  const policy = structuredClone(baseline.policy);
  Object.assign(policy.voting, { defaultScope: 'all', allowedScopes: ['all'],
    lawYesRatio: rules.votes.law.yesRatio, quorumRatio: rules.votes.law.quorumRatio,
    minimumBallots: rules.votes.law.minimumBallots });
  return { rules, policy, rulesHash: sha256(canonicalJson(rules)), sourceFormat: 'constitutional-recovery-v2', compilerVersion: 2 };
}
