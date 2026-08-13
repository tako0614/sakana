import { normalizeActivityContent } from './policy.js';

const TERMINAL_PROPOSAL_STATUSES = new Set(['enacted', 'rejected', 'remanded']);

function activeProposal(proposal) {
  return proposal.workflow_handler
    ? proposal.workflow_handler !== 'terminal'
    : !TERMINAL_PROPOSAL_STATUSES.has(proposal.status);
}

function tokens(value) {
  const normalized = normalizeActivityContent(value).replace(/[^\p{L}\p{N}]+/gu, '');
  const result = new Set();
  for (let size = 2; size <= 4; size += 1) {
    for (let index = 0; index + size <= normalized.length; index += 1) result.add(normalized.slice(index, index + size));
  }
  return result;
}

function score(query, candidate) {
  const left = tokens(query);
  const right = tokens(candidate);
  if (!left.size || !right.size) return 0;
  let overlap = 0;
  for (const token of left) if (right.has(token)) overlap += 1;
  return overlap / Math.max(1, Math.min(left.size, right.size));
}

function proposalCandidate(proposal) {
  return {
    type: 'proposal',
    id: String(proposal.id),
    kind: proposal.kind,
    title: proposal.title,
    summary: proposal.summary,
    status: proposal.status,
    threadId: proposal.forum_thread_id ?? null,
    operativeContent: proposal.kind === 'amendment'
      ? String(proposal.body?.content ?? '').slice(0, 12_000)
      : JSON.stringify(proposal.body?.provisions ?? {}).slice(0, 12_000),
    contentHash: proposal.target_hash ?? null
  };
}

function lawCandidate(law) {
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

export function buildLegislativeCandidates({ request, normalized, proposals, laws, constitution }) {
  const query = `${request}\n${normalized?.title ?? ''}\n${normalized?.summary ?? ''}`;
  const activeProposals = proposals
    .filter(activeProposal)
    .map((proposal) => ({ candidate: proposalCandidate(proposal), score: score(query, `${proposal.title}\n${proposal.summary}`) }));
  const activeLaws = laws
    .filter((law) => law.status === 'active')
    .map((law) => ({ candidate: lawCandidate(law), score: score(query, `${law.title}\n${law.text}`) }));
  const selected = [...activeProposals, ...activeLaws]
    .sort((a, b) => b.score - a.score)
    .slice(0, 12)
    .map((entry) => entry.candidate);
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

export function exactActiveProposalMatch(title, proposals) {
  const normalized = normalizeActivityContent(title);
  return proposals.find((proposal) => activeProposal(proposal)
    && normalizeActivityContent(proposal.title) === normalized) ?? null;
}
