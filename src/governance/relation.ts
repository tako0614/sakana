import { normalizeActivityContent } from './policy.js';
import type { ProposalBody } from './types.js';

const TERMINAL_PROPOSAL_STATUSES = new Set(['enacted', 'rejected', 'remanded']);

/** 関係判定で読む提案の項目。db の Proposal はそのまま渡せる。 */
export interface ProposalSummary {
  id: number | string;
  kind: string;
  title: string;
  summary: string;
  status: string;
  workflow_handler?: string | null;
  workflow_status?: string | null;
  forum_thread_id?: string | null;
  body?: ProposalBody | null;
  target_hash?: string | null;
  target_type?: string | null;
  target_id?: string | null;
  constitution_id?: number | null;
}

/** 関係判定で読む法律の項目。db の Law はそのまま渡せる。 */
export interface LawSummary {
  id: number | string;
  title: string;
  text: string;
  status: string;
  provisions: unknown;
  content_hash: string;
  root_law_id?: number | string | null;
  version?: number | null;
}

export interface ConstitutionSummary {
  id: number | string;
  version: number;
  content: string;
  content_hash: string;
  rules?: unknown;
  policy?: unknown;
}

export interface LegislativeCandidate {
  type: 'proposal' | 'law' | 'constitution';
  id: string;
  kind: string;
  title: string;
  summary: string;
  status: string;
  threadId?: string | null;
  operativeContent: string;
  contentHash: string | null;
  rootLawId?: string;
  version?: number;
}

export function openProposal(proposal: ProposalSummary): boolean {
  return proposal.workflow_handler
    ? proposal.workflow_handler !== 'terminal'
    : !TERMINAL_PROPOSAL_STATUSES.has(proposal.status);
}

export function activeProposal(proposal: ProposalSummary): boolean {
  return openProposal(proposal) && proposal.workflow_status !== 'queued';
}

function tokens(value: unknown): Set<string> {
  const normalized = normalizeActivityContent(value).replace(/[^\p{L}\p{N}]+/gu, '');
  const result = new Set<string>();
  for (let size = 2; size <= 4; size += 1) {
    for (let index = 0; index + size <= normalized.length; index += 1) result.add(normalized.slice(index, index + size));
  }
  return result;
}

function score(query: string, candidate: string): number {
  const left = tokens(query);
  const right = tokens(candidate);
  if (!left.size || !right.size) return 0;
  let overlap = 0;
  for (const token of left) if (right.has(token)) overlap += 1;
  return overlap / Math.max(1, Math.min(left.size, right.size));
}

function proposalCandidate(proposal: ProposalSummary): LegislativeCandidate {
  return {
    type: 'proposal',
    id: String(proposal.id),
    kind: proposal.kind,
    title: proposal.title,
    summary: proposal.summary,
    status: proposal.workflow_status === 'queued' ? 'queued' : proposal.status,
    threadId: proposal.forum_thread_id ?? null,
    operativeContent: proposal.kind === 'amendment'
      ? String(proposal.body?.content ?? '').slice(0, 12_000)
      : JSON.stringify(proposal.body?.provisions ?? {}).slice(0, 12_000),
    contentHash: proposal.target_hash ?? null
  };
}

function lawCandidate(law: LawSummary): LegislativeCandidate {
  return {
    type: 'law',
    id: String(law.id),
    kind: 'law',
    title: law.title,
    summary: law.text.slice(0, 1800),
    status: law.status,
    operativeContent: JSON.stringify(law.provisions).slice(0, 12_000),
    contentHash: law.content_hash,
    rootLawId: String(law.root_law_id ?? law.id),
    version: law.version ?? 1
  };
}

export interface LegislativeCandidateInput {
  request: string;
  normalized?: { title?: string | null; summary?: string | null; intent?: string | null } | null;
  proposals: readonly ProposalSummary[];
  laws: readonly LawSummary[];
  constitution: ConstitutionSummary;
}

export function buildLegislativeCandidates({ request, normalized, proposals, laws, constitution }: LegislativeCandidateInput): LegislativeCandidate[] {
  const query = `${request}\n${normalized?.title ?? ''}\n${normalized?.summary ?? ''}`;
  const activeProposals = proposals
    .filter(openProposal)
    .map((proposal) => {
      const candidate = proposalCandidate(proposal);
      return { candidate, score: score(query, `${candidate.title}\n${candidate.summary}\n${candidate.operativeContent}`) };
    });
  const activeLaws = laws
    .filter((law) => law.status === 'active')
    .map((law) => {
      const candidate = lawCandidate(law);
      return { candidate, score: score(query, `${candidate.title}\n${candidate.summary}\n${candidate.operativeContent}`) };
    });
  // One category must not crowd the other out. Active discussions and enacted
  // laws are different routing authorities, so retain the strongest six from
  // each before the relation panel decides.
  const best = (entries: { candidate: LegislativeCandidate; score: number }[]): LegislativeCandidate[] => entries
    .sort((a, b) => b.score - a.score)
    .slice(0, 6)
    .map((entry) => entry.candidate);
  const selected = [...best(activeProposals), ...best(activeLaws)];
  if (normalized?.intent === 'amendment') {
    selected.push({
      type: 'constitution',
      id: String(constitution.id),
      kind: 'constitution',
      title: `憲法 v${constitution.version}`,
      summary: constitution.content.slice(0, 3000),
      status: 'active',
      operativeContent: JSON.stringify(constitution.rules ?? constitution.policy).slice(0, 12_000),
      contentHash: constitution.content_hash
    });
  }
  return selected;
}

export function exactActiveProposalMatch<T extends ProposalSummary>(title: unknown, proposals: readonly T[]): T | null {
  const normalized = normalizeActivityContent(title);
  return proposals.find((proposal) => openProposal(proposal)
    && normalizeActivityContent(proposal.title) === normalized) ?? null;
}

export function activeConstitutionalAmendments<T extends ProposalSummary>(
  proposals: readonly T[],
  constitutionId: number | string | null = null,
  { excludeId = null }: { excludeId?: number | string | null } = {}
): T[] {
  return proposals
    .filter((proposal) => proposal.kind === 'amendment'
      && activeProposal(proposal)
      && Number(proposal.id) !== Number(excludeId)
      && (constitutionId === null
        || Number(proposal.target_id ?? proposal.constitution_id) === Number(constitutionId)))
    .sort((left, right) => Number(left.id) - Number(right.id));
}

export function activeConstitutionalAmendment<T extends ProposalSummary>(
  proposals: readonly T[],
  constitutionId: number | string | null = null,
  options: { excludeId?: number | string | null } = {}
): T | null {
  return activeConstitutionalAmendments(proposals, constitutionId, options)[0] ?? null;
}

function lawRootId(law: LawSummary | null | undefined): string {
  return String(law?.root_law_id ?? law?.id ?? '');
}

export function activeLawAmendment<T extends ProposalSummary>(
  proposals: readonly T[],
  laws: readonly LawSummary[],
  lawId: number | string,
  { excludeId = null }: { excludeId?: number | string | null } = {}
): T | null {
  const byId = new Map(laws.map((law) => [String(law.id), law]));
  const target = byId.get(String(lawId));
  if (!target) return null;
  const targetRoot = lawRootId(target);
  return proposals
    .filter((proposal) => proposal.kind === 'law'
      && proposal.target_type === 'law'
      && activeProposal(proposal)
      && Number(proposal.id) !== Number(excludeId)
      && lawRootId(byId.get(String(proposal.target_id))) === targetRoot)
    .sort((left, right) => Number(left.id) - Number(right.id))[0] ?? null;
}
