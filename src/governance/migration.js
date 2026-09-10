import { loadBootstrapDocuments } from './config.js';
import { createProposal, getActiveConstitution, listProposals } from './db.js';

// This creates an agenda item only. The current constitution's AI review and
// public amendment vote, including its existing electorate, authorize cutover.
export function proposeLawDefinedGovernance({ guildId, serverName, proposerId }) {
  const current = getActiveConstitution(guildId);
  if (!current) throw new Error('先に統治機能を導入してください。');
  if (current.policy.autonomous) throw new Error('法令で機関と手続を定義する制度へ移行済みです。');
  const existing = listProposals(guildId, { limit: 10000 })
    .find((proposal) => proposal.source === 'legal_migration' && proposal.workflow_handler !== 'terminal');
  if (existing) return existing;
  const documents = loadBootstrapDocuments({ serverName });
  documents.constitution += '\n\n## 附則（法令定義への移行）\n\n1. 本改正とその添付全文に示す統治組織手続法は、改正直前に有効な憲法の改憲手続によって一体の対象として審議・公開投票に付す。本改正が成立した時点で、本附則の憲法上の委任により当該添付全文のみを初期組織法として施行する。投票前に別の法律が成立したものとは扱わず、投票後の添付本文の差替えを認めない。\n2. 本改正は、人間の改憲投票を必須として維持し、通常の法律の投票の要否、重大処分の人間による承認の資格・必要人数・拒否権、および機関と手続の詳細を法律で定められるように変更する。初期組織法は公開投票と重大処分の人間の承認を維持する。\n3. 本改正自体の採択・審査・投票条件は改正直前の制度による。係属事件と開始済み投票は開始時の準拠法と手続を保持し、過去の記録・票・判断を改変しない。個人の違反と処分は別途成立した実体法を要し、本附則と組織法だけでは処罰できない。';
  const definitions = documents.laws[0].provisions.governance;
  for (const definition of definitions) {
    if (definition.kind !== 'regulation') continue;
    const source = definition.key === 'records' ? current.rules.electorates.general : current.rules[definition.key];
    if (source) definition.value = structuredClone(source);
    if (definition.key === 'parliament') delete definition.value.maximumDeferrals;
  }
  const bound = (role) => {
    const binding = definitions.find((entry) => entry.kind === 'binding' && entry.key === role);
    return definitions.find((entry) => entry.kind === binding.value.kind && entry.key === binding.value.target).value;
  };
  for (const role of ['parliament', 'court', 'police', 'constitutional', 'judicialScreening']) {
    const institution = bound(role);
    Object.assign(institution, structuredClone(current.rules.panels[role]), {
      tools: structuredClone(current.rules.investigation.tools[role] ?? institution.tools)
    });
  }
  for (const role of ['law', 'constitutionalAmendment', 'criminalCase', 'constitutionalCase']) {
    const procedure = bound(role);
    const previous = current.rules.workflows[role];
    for (const state of Object.values(procedure.states)) {
      const priorState = Object.values(previous.states).find((entry) => entry.handler === state.handler);
      if (state.duration !== null && priorState?.duration) state.duration = priorState.duration;
      if (state.handler === 'legislation_draft') state.config.maximumVisits = current.rules.parliament.maximumDeferrals;
      if (state.handler === 'contest_window') state.duration = current.rules.sanctions.police.contestDuration;
      if (state.handler === 'appeal_window') state.duration = current.rules.sanctions.appeals.duration;
    }
    if (role === 'constitutionalCase') procedure.config.petitionsPerMemberPerDay = previous.config.petitionsPerMemberPerDay;
  }
  return createProposal({guildId,constitutionId:current.id,kind:'amendment',source:'legal_migration',proposerId,
    title:'統治機関と手続を法律で定義するための憲法改正',
    summary:'AIが起草・調査・修正を遂行する。人間の改憲投票を必須として維持し、通常法の投票の要否、重大処分の承認者・人数・拒否権、機関と手続の詳細を法律で定義できるようにする。初期法では公開投票と重大処分の人間の承認を維持する。初期法全文を附則の委任対象として同じ現行改憲投票で決め、過去の判断・票・係属事件の手続を保持する。',
    status:current.rules.workflows.constitutionalAmendment.initial,voteScope:current.rules.votes.defaultScope,
    body:{migration:{constitution:documents.constitution,laws:documents.laws}}});
}
