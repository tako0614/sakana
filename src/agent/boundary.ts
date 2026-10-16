// まだ JavaScript のまま残っているモジュール (src/governance) の入口に型を付ける。
//
// allowJs の推論は既定値から型を作るので、`guildId = null` は null 型、`titleTerms = []` は
// never[] 型になり、正しい呼び出しまで型エラーになる。逆に SQL の結果は any か unknown で返る。
// そこで「この関数はこういう形で呼ばれ、こういう形を返す」をここに1回だけ書く。
//
// 下の interface はメソッドの形で書いてある。TypeScript はメソッドの引数を双変で比べるので、
// JS の推論した引数型 (null や never[]) とこちらの引数型のどちらか一方が他方に入れば受け入れる。
// as のキャストは使っていない。戻り値は共変のままなので、unknown を返す関数は unknown のまま受けて
// 呼び出し側で確かめる (行の形を勝手に名乗らない)。
//
// TypeScript に移ったモジュール (archive / conversation / embed / ai / memory / mimic) の型は
// ここに写さない。持ち主のモジュールから直接 import する。governance が TypeScript に移ったら、
// この入口ごと消して同じようにする。

import type { GuildMember } from 'discord.js';
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

// db.ts は TypeScript なので、記録の型も関数も持ち主から直接使う。
// まだ JavaScript の service.js の関数だけ、ここで呼び方を宣言する。
export type { AdministrativeAct, CaseRecord, Constitution, Law, Proposal } from '../governance/types.js';

export interface GovernanceAttempt {
  ok: boolean;
  governed: boolean;
  scope?: string;
  used?: number;
  limit?: number;
  retryAt?: number | null;
}

interface AttemptApi {
  reserveGovernanceAgentAttempt(member: GuildMember, eventId: string): GovernanceAttempt;
}

const attempts: AttemptApi = { reserveGovernanceAgentAttempt };

export const governance = {
  getGovernanceGuild,
  getActiveConstitution,
  getLaw,
  listLaws,
  listProposals,
  proposalVoteSummary,
  listCases,
  listAdministrativeActs,
  ...attempts
};
