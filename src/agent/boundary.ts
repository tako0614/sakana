// まだ JavaScript のまま残っているモジュールの入口に型を付ける。
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
// 相手のモジュールが TypeScript に移ったら、その分はここから消して直接 import する。

import type { Client, Guild, GuildBasedChannel, GuildMember, Message } from 'discord.js';
import { requestModel } from '../ai/provider.js';
import { runAgent } from '../ai/runtime.js';
import { chunkCoverage, chunkMessages } from '../archive/chunks.js';
import { resolveModel } from '../archive/embed-job.js';
import { canBotAttach, canBotSpeak, canManageIndex, canRead, getChannelScope, isForumType, isThreadType } from '../archive/permissions.js';
import { collectTerms, parseQuery } from '../archive/query.js';
import { aggregateSearch, buildSearch, isChannelAllowed, search, searchSummary, searchThreads } from '../archive/search.js';
import { topTerms } from '../archive/terms.js';
import { fetchChunks, scanChunksTopK } from '../archive/vectors.js';
import { archiveStructure, messageEnvelope } from '../conversation/message.js';
import { embedTexts } from '../embed/worker.js';
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
import { isAllowedGuild } from '../guilds.js';
import { recallFor } from '../memory/recall.js';
import { isSelfHosted } from '../mimic/client.js';
import { engineFor } from '../mimic/prefs.js';
import { handleMimicRequest } from '../mimic/respond.js';
import { isRecord, type AgentMessage, type ChannelScope, type MessageStructure, type ToolDefinition } from './types.js';

// ---------------------------------------------------------------- archive: 行の形

/** messages 表の1行 (SELECT m.*)。 */
export interface ArchiveRow {
  message_id: string;
  guild_id: string;
  channel_id: string;
  parent_id?: string | null;
  author_id: string;
  author_name: string | null;
  is_bot: number | null;
  content: string | null;
  extra: string | null;
  created_at: number;
  edited_at: number | null;
  deleted: number | null;
  reaction_count: number | null;
  reply_to: string | null;
  attachment_count: number | null;
  structure_json?: string | null;
  pinned?: number | null;
}

/** 他のモジュールから unknown で返ってくる messages の行を確かめる。 */
export function isArchiveRow(value: unknown): value is ArchiveRow {
  return isRecord(value)
    && typeof value.message_id === 'string'
    && typeof value.channel_id === 'string'
    && typeof value.created_at === 'number';
}

export interface SearchFilter {
  key: string;
  value: string;
}

export interface SearchOptions {
  guildId: string;
  query?: string;
  extra?: SearchFilter[];
  channelScope?: ChannelScope | null;
  allowDeleted?: boolean;
  sort?: string;
}

export interface SearchSummary {
  count: number;
  authors: number;
  channels: number;
  first_at: number | null;
  last_at: number | null;
  avg_length: number | null;
  reactions: number | null;
}

export interface AggregateRow {
  bucket: string | number;
  count: number;
}

export interface ThreadRow {
  channel_id: string;
  name: string;
  parent_id: string | null;
  message_count: number | null;
  oldest_id: string | null;
  newest_id: string | null;
  applied_tags: string | null;
  hits: number;
  title_hit: number;
}

export interface ChunkRow {
  chunk_id: number;
  guild_id: string;
  channel_id: string;
  from_id: string;
  from_ms: number;
  to_ms: number;
  msg_count: number;
}

export interface ChunkFilters {
  authorId?: string;
  channelIds?: string[];
  fromMs?: number;
  toMs?: number;
}

export interface ChunkScan {
  tooMany: boolean;
  total: number;
  hits?: { cid: number; score: number }[];
}

export interface TermResult {
  rows: { term: string; count: number; ratio: number }[];
  messages: number;
  mode: string;
  weakBaseline: boolean;
  baseline: { messages: number };
}

/** archive/query.js の構文木。ここで見るのは種類と子だけ。 */
export interface QueryNode {
  type: string;
  key?: string;
  value?: string;
  node?: QueryNode;
  nodes?: QueryNode[];
}

interface ArchiveApi {
  search(options: SearchOptions, page?: { limit?: number; offset?: number }): { rows: ArchiveRow[] };
  searchSummary(options: SearchOptions): SearchSummary;
  aggregateSearch(options: SearchOptions, groupBy: string, page?: { limit?: number }): AggregateRow[];
  searchThreads(options: SearchOptions, page?: { limit?: number; offset?: number; titleTerms?: string[] }): ThreadRow[];
  buildSearch(options: SearchOptions): { where: string; params: (string | number)[] };
  isChannelAllowed(channelId: string, channelScope: ChannelScope | null | undefined): boolean;
  topTerms(options: SearchOptions, settings?: { range?: { from: number | null; to: number | null; total: number } | null }): TermResult;
  parseQuery(input: string): { ast: QueryNode | null; directives: { sort?: string } };
  collectTerms(ast: QueryNode | null): string[];
  chunkCoverage(guildId: string, modelId: number): { total: number; done: number; ratio: number };
  chunkMessages(chunk: ChunkRow): unknown[];
  fetchChunks(chunkIds: number[]): ChunkRow[];
  scanChunksTopK(options: {
    guildId: string;
    modelId: number;
    queryVec: Float32Array;
    filters?: ChunkFilters;
    channelScope?: ChannelScope | null;
    limit?: number;
  }): ChunkScan;
  resolveModel(): Promise<{ modelId: number; dim: number }>;
  embedTexts(texts: string[], options: { kind: string; encode: string }): Promise<unknown>;
  getChannelScope(guild: Guild, member: GuildMember): ChannelScope;
  canRead(channel: GuildBasedChannel, member: GuildMember): boolean;
  canBotSpeak(channel: GuildBasedChannel, me: GuildMember): boolean;
  canBotAttach(channel: GuildBasedChannel, me: GuildMember): boolean;
  canManageIndex(member: GuildMember | null): boolean;
  isForumType(type: number): boolean;
  isThreadType(type: number): boolean;
  isAllowedGuild(guildId: string | null): boolean;
}

export const archive: ArchiveApi = {
  search,
  searchSummary,
  aggregateSearch,
  searchThreads,
  buildSearch,
  isChannelAllowed,
  topTerms,
  parseQuery,
  collectTerms,
  chunkCoverage,
  chunkMessages,
  fetchChunks,
  scanChunksTopK,
  resolveModel,
  embedTexts,
  getChannelScope,
  canRead,
  canBotSpeak,
  canBotAttach,
  canManageIndex,
  isForumType,
  isThreadType,
  isAllowedGuild
};

// ---------------------------------------------------------------- conversation/message.js

/** messageEnvelope の出力。formatMessages が触るのは location と contextNote だけ。 */
export interface MessageEnvelope {
  location: { [key: string]: unknown };
  contextNote?: string;
  [key: string]: unknown;
}

interface ConversationApi {
  archiveStructure(row: ArchiveRow): MessageStructure;
  messageEnvelope(message: AgentMessage, options: {
    lookup: (id: string) => unknown;
    selfId: string | null;
    bodyChars: number;
  }): MessageEnvelope;
}

export const conversation: ConversationApi = { archiveStructure, messageEnvelope };

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

// ---------------------------------------------------------------- mimic

interface MimicApi {
  engineFor(userId: string, guildId: string): string;
  isSelfHosted(engine: unknown): boolean;
  handleMimicRequest(message: Message<true>, client: Client, options?: {
    recent?: Message[];
    chain?: AgentMessage[];
    engine?: string;
    remember?: ((messageId: string | null | undefined, callId?: number) => void) | null;
    selfId?: string | null;
  }): Promise<void>;
}

export const mimic: MimicApi = { engineFor, isSelfHosted, handleMimicRequest };

// ---------------------------------------------------------------- memory

interface MemoryApi {
  recallFor(guildId: string, options?: { request?: string; context?: string; maxChars?: number }): string;
}

export const memory: MemoryApi = { recallFor };

// ---------------------------------------------------------------- ai

/** OpenAI 互換のメッセージ。中身は runtime がそのまま provider に渡す。 */
export type ChatMessage = { role: string; content?: unknown } & Record<string, unknown>;

export interface ModelRequestOptions {
  model?: string;
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  guildId?: string | null;
  runId?: string | null;
  beforeSend?: unknown;
  consumeRequest?: unknown;
  role?: string;
  deadlineAt?: number;
  timeoutMs?: number;
  maxOutputTokens?: number;
  retries?: number;
  reasoning?: { effort: string } | { enabled: false };
  temperature?: number;
}

/** runtime が request() に渡すもの。 */
export interface RuntimeRequest {
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  effort?: string;
  deadlineAt?: number;
  guildId?: string | null;
  runId?: string | null;
  final?: boolean;
  beforeSend?: unknown;
  consumeRequest?: unknown;
}

export interface TokenUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_cache_hit_tokens?: number;
  cached_tokens?: number;
  cost?: number;
  rounds?: number;
}

export interface UsedTool {
  name?: string;
  args?: unknown;
}

export interface AgentToolset {
  definitions: ToolDefinition[];
  call(name: string, args: unknown): Promise<string>;
}

export interface RuntimeOptions {
  guildId: string;
  system: string;
  userContent: string;
  toolset?: AgentToolset;
  request: (request: RuntimeRequest) => Promise<unknown>;
  usage?: TokenUsage;
  budget?: number;
  weigh?: (usage?: TokenUsage) => number;
  deadlineAt?: number;
  onToolCall?: (name: string, args: unknown) => void;
  runId?: string;
  modelIdentity?: string;
}

export interface RuntimeResult {
  text?: string;
  invocation: { rounds: number; usage: TokenUsage };
  used: UsedTool[];
}

interface ModelApi {
  requestModel(options: ModelRequestOptions): Promise<unknown>;
  runAgent(options: RuntimeOptions): Promise<RuntimeResult>;
}

export const model: ModelApi = { requestModel, runAgent };
