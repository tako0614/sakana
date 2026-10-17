// Transitional executor for constitutions that still embed the v1 procedure.
// Pending ballots and cases keep their original authority; a public amendment
// is required before ordinary laws can own institutions and procedures.
import type { Guild } from 'discord.js';
import { constitutionForSubject, getCurrentLawVersion, getProposal, listLaws, listProposalDeliberations,
  recordProposalDeliberation, setProposalKind, threadDiscussion, updateProposal } from './db.js';
import { deliberateAgendaItem, draftAmendment, draftBill, ratifyLegislativeDraft, runConstitutionalPanel } from './llm.js';
import { buildLegislativeCandidates } from './relation.js';
import { canonicalJson, sha256 } from './policy.js';
import { compileConstitution, GOVERNANCE_RULES_SCHEMA } from './rules.js';
import { postProposalUpdate } from './discord.js';
import { agendaDecision, draftBody, panelResult } from './legislation.js';
import type { AgendaOutcome } from './parliament.js';
import type { Proposal, ProposalBody } from './types.js';

function requireProposal(proposal: Proposal | null | undefined): Proposal {
  if (!proposal) throw new Error('議題の記録が見つかりません。');
  return proposal;
}

export async function advanceLegacyLegislation(guild: Guild, input: Proposal): Promise<AgendaOutcome> {
  let proposal = input;
  if (proposal.workflow_handler !== 'parliament_agenda') return {proposalId:proposal.id,title:proposal.title,decision:'pending'};
  const constitution = constitutionForSubject('proposal', proposal);
  const rules = constitution?.rules;
  // 旧統治の議題は、憲法に埋め込んだ v1 の実行規則だけで進む。
  if (!constitution || rules?.$schema !== GOVERNANCE_RULES_SCHEMA) throw new Error('旧統治の実行規則がありません。');
  const laws = listLaws(guild.id,{limit:10000});
  const discussion = threadDiscussion(guild.id,proposal.forum_thread_id,0,100);
  const history = listProposalDeliberations(proposal.id);
  const migration = proposal.source === 'legal_migration' ? proposal.body?.migration : null;
  const decision = agendaDecision(await deliberateAgendaItem({guildId:guild.id,
    agenda:{title:proposal.title,summary:proposal.summary,kind:proposal.kind,origin:proposal.source,deferrals:proposal.deferrals},
    constitution,discussion,previousSessions:history,activeLaws:laws,
    candidates:buildLegislativeCandidates({request:proposal.summary,normalized:{title:proposal.title,summary:proposal.summary,intent:'amendment'},proposals:[],laws,constitution}),
    otherOpenAgenda:[],panel:rules.panels.parliament,allowDefer:false,investigation:constitution.policy.investigation}));
  if (decision.outputs.length < rules.panels.parliament.seats) throw new Error('国会のAI席がそろっていません。');
  if (decision.decision !== 'legislate') {
    const agendaState = rules.workflows[proposal.kind==='amendment'?'constitutionalAmendment':'law'].states[proposal.status];
    if (!agendaState) throw new Error('議題の段階を実行規則で解釈できません。');
    updateProposal(proposal.id,{status:agendaState.on.rejected});
    return {proposalId:proposal.id,title:proposal.title,decision:'reject'};
  }
  const amendment = Boolean(migration) || decision.relation === 'amend_constitution';
  if (amendment && proposal.kind !== 'amendment') proposal=requireProposal(setProposalKind(proposal.id,'amendment'));
  let feedback: unknown=history.at(-1)?.decision?.review ?? null;
  let previousDraft: ProposalBody | null | undefined=proposal.body?.migration ? null : proposal.body;
  const attempts=rules.parliament.maximumDeferrals;
  for (let attempt=0;attempt<attempts;attempt++) {
    // 改正対象は、この議題のサーバーで現行の法律に限る。他サーバーの法令本文を起草へ渡さない。
    const found=decision.relation==='amend_law'?getCurrentLawVersion(decision.targetId):null;
    const target=found?.guild_id===guild.id?found:null;
    const request={title:proposal.title,summary:proposal.summary,instruction:decision.instruction,previousDraft,review:feedback,
      ...(target?{amendmentTarget:target}:{}),...(migration?{migration}: {})};
    let body=draftBody(amendment ? await draftAmendment({guildId:guild.id,request,constitution})
      : await draftBill({guildId:guild.id,petition:request,constitution,activeLaws:laws,policy:constitution.policy}));
    if (migration) {
      compileConstitution({content:body.content,laws:[...laws,...migration.laws]});
      body={...body,bootstrapLaws:migration.laws,migration};
    }
    if (previousDraft && canonicalJson(previousDraft)===canonicalJson(body) && feedback) continue;
    previousDraft=body;
    proposal=requireProposal(updateProposal(proposal.id,{body,title:body.title,summary:body.summary,
      relation_type:amendment?'amend_constitution':decision.relation,
      target_type:amendment?'constitution':target?'law':null,target_id:amendment?String(constitution.id):target?String(target.id):null,
      target_hash:amendment?constitution.content_hash:target?.content_hash??null}));
    // 採決に必要な票数が定められていなければ、approve を空のまま渡して採択の席に止めさせる。
    const decisionVotes=rules.panels.parliament.required['decision'];
    const adoption=panelResult(await ratifyLegislativeDraft({guildId:guild.id,proposalId:proposal.id,constitution,target:body,activeLaws:laws,
      institution:{...rules.panels.parliament,mandate:'完成した同一の案を独立して採択する。',required:decisionVotes===undefined?{}:{approve:decisionVotes}}}),'採択');
    if (adoption.verdict!=='approved') { feedback=adoption; continue; }
    const review=panelResult(await runConstitutionalPanel({guildId:guild.id,targetType:amendment?'amendment':'law',targetId:proposal.id,phase:'pre',constitution,target:body}),'憲法審査');
    if (review.outputs.length!==rules.panels.constitutional.seats) throw new Error('憲法審査のAI席がそろっていません。');
    recordProposalDeliberation({proposalId:proposal.id,revision:proposal.revision,outcome:'review',discussion,decision:{adoption,review,targetHash:sha256(canonicalJson(body))}});
    if (review.outputs.filter((entry)=>entry.verdict==='constitutional').length>=constitution.policy.judiciary.constitutionalVotesRequired) {
      await postProposalUpdate(guild,proposal,'AIが起草・修正・採択・憲法審査を完了しました。添付の全文を公開投票にかけます。',{
        files:[{name:'投票対象全文.json',attachment:Buffer.from(JSON.stringify(body,null,2))}]});
      const {openProposalVote}=await import('./service.js');
      await openProposalVote(guild,proposal);
      return {proposalId:proposal.id,title:proposal.title,decision:'legislate'};
    }
    feedback=review;
  }
  updateProposal(proposal.id,{status:'rejected'});
  await postProposalUpdate(guild,requireProposal(getProposal(proposal.id)),'法定の検討回数内に成立条件を満たす案を仕上げられなかったため、不採択とします。',{state:'不成立'});
  return {proposalId:proposal.id,title:proposal.title,decision:'reject'};
}
