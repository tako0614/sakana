// エージェントが読む統治の入口。記録の型も関数も、持ち主の src/governance から直接使う
// (ここに型を写さない)。エージェントが触る関数をまとめて 1 か所から出すだけの窓口。

import {
  getActiveConstitution,
  getGovernanceGuild,
  getLaw,
  listAdministrativeActs,
  listCases,
  listLaws,
  listProposals,
  proposalVoteSummary
} from '../governance/db.js';
import { reserveGovernanceAgentAttempt } from '../governance/service.js';

// ---------------------------------------------------------------- governance

export type { AdministrativeAct, CaseRecord, Constitution, Law, Proposal } from '../governance/types.js';
export type { GovernanceReservation } from '../governance/types-service.js';

export const governance = {
  getGovernanceGuild,
  getActiveConstitution,
  getLaw,
  listLaws,
  listProposals,
  proposalVoteSummary,
  listCases,
  listAdministrativeActs,
  reserveGovernanceAgentAttempt
};
