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

export interface GovernanceGuild {
  guild_id: string;
  status: string;
  enforcement_mode: string;
  procedure_channel_id: string;
  parliament_forum_id: string;
  court_forum_id: string;
  trusted_role_id: string | null;
}

export interface Constitution {
  version: number;
  content: string;
  rules?: {
    institutions?: Record<string, Record<string, unknown>>;
    procedures?: Record<string, Record<string, unknown>>;
    sources?: Record<string, unknown>;
  } | null;
}

export interface Law {
  id: number;
  guild_id: string;
  title: string;
  text: string;
  effective_at: number;
  provisions?: {
    offenses?: { code: string; title: string }[];
    governance?: unknown[];
  } | null;
}

export interface Proposal {
  id: number;
  guild_id: string;
  kind: string;
  status: string;
  workflow_handler: string | null;
  title: string;
  summary: string;
  body?: { content?: string; text?: string } | null;
}

export interface CaseRecord {
  id: number;
  guild_id: string;
  kind: string;
  status: string;
  summary: string;
  law_id: number | null;
  offense_code: string | null;
  finalized_at: number | null;
  workflow_handler: string | null;
  challenged_type: string | null;
  verdict?: { verdict?: string } | null;
}

export interface AdministrativeAct {
  id: number;
  guild_id: string;
  kind: string;
  status: string;
  summary: string;
}

export interface VoteSummary {
  yes: number;
  no: number;
  abstain: number;
  trustedNo: number;
  trustedTotal: number;
}

export interface GovernanceAttempt {
  ok: boolean;
  governed: boolean;
  scope?: string;
  used?: number;
  limit?: number;
  retryAt?: number | null;
}

interface GovernanceApi {
  getGovernanceGuild(guildId: string): GovernanceGuild | null | undefined;
  getActiveConstitution(guildId: string): Constitution | null | undefined;
  getLaw(id: number): Law | null | undefined;
  listLaws(guildId: string): Law[];
  listProposals(guildId: string, options: { limit: number }): Proposal[];
  proposalVoteSummary(proposalId: number): VoteSummary;
  listCases(guildId: string, options: { limit: number }): CaseRecord[];
  listAdministrativeActs(guildId: string, limit: number): AdministrativeAct[];
  reserveGovernanceAgentAttempt(member: GuildMember, eventId: string): GovernanceAttempt;
}

export const governance: GovernanceApi = {
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
