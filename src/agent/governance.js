import { PermissionFlagsBits } from 'discord.js';
import {
  getActiveConstitution,
  getAdministrativeAct,
  getCase,
  getGovernanceGuild,
  getLaw,
  getProposal,
  listAdministrativeActs,
  listCases,
  listLaws,
  listProposals,
  proposalVoteSummary
} from '../governance/db.js';

export const governanceDefinition = {
  type: 'function',
  function: {
    name: 'governance',
    description: 'このサーバーの現行憲法・法律・法案・事件・行政行為を正本DBから読み取る。書込みや投票はできない。',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['status', 'constitution', 'laws', 'law', 'proposals', 'proposal', 'cases', 'case', 'administration', 'administrative_act']
        },
        id: { type: 'number', description: 'law/proposal/case/administrative_actの番号' }
      },
      required: ['action']
    }
  }
};

function integerId(value) {
  const id = Number(value);
  if (!Number.isInteger(id) || id < 1) throw new Error('正の案件IDが必要です。');
  return id;
}

function sameGuild(record, guildId, label) {
  if (!record || record.guild_id !== guildId) throw new Error(`${label}が見つかりません。`);
  return record;
}

function requireVisible(ctx, channelId, label) {
  const channel = ctx.guild.channels?.cache?.get?.(channelId);
  if (!channel?.permissionsFor?.(ctx.member)?.has(PermissionFlagsBits.ViewChannel)) {
    throw new Error(`${label}は呼び出した人に閲覧権限がないため読めません。`);
  }
}

function governanceStateLabel(value) {
  return ({ active: '稼働中', paused: '一時停止中' })[value] ?? value;
}

function enforcementLabel(value) {
  return value === 'live' ? '実執行' : '記録のみ';
}

function proposalKindLabel(value) {
  return value === 'amendment' ? '憲法改正案' : '法案';
}

function proposalStateLabel(value) {
  return ({
    drafting: 'AI起草中', draft: '草案', constitutional_review: '違憲審査',
    debate: '討議中', voting: '投票中', enacted: '成立', rejected: '否決', remanded: '差戻し'
  })[value] ?? value;
}

function caseKindLabel(value) {
  return value === 'constitutional' ? '違憲審査' : '法律違反の申立て';
}

function caseStateLabel(value) {
  return ({
    filing: '受付中', defense: '答弁期間', deliberation: '審理中', approval: '執行承認待ち',
    appeal_window: '上訴受付中', appeal: '上訴審理中', execution: '執行処理中', final: '確定',
    overturned: '取消', acquitted: '責任なし', dismissed: '棄却',
    constitutional_uncertain: '違憲判断不能', unenforceable: '執行不能'
  })[value] ?? value;
}

export function runGovernanceInfo(ctx, args) {
  const guildId = ctx.guild.id;
  const governance = getGovernanceGuild(guildId);
  if (!governance) return 'このサーバーでは統治機能が初期化されていません。';
  const action = String(args.action ?? 'status');
  if (['constitution', 'laws', 'law'].includes(action)) {
    requireVisible(ctx, governance.statute_forum_id || governance.gazette_channel_id, '法令集');
  }
  if (['administration', 'administrative_act'].includes(action)) {
    requireVisible(ctx, governance.gazette_channel_id, '官報');
  }
  if (['proposals', 'proposal'].includes(action)) {
    requireVisible(ctx, governance.parliament_forum_id, '議会');
  }
  if (['cases', 'case'].includes(action)) {
    requireVisible(ctx, governance.court_forum_id, '裁判所');
  }
  if (action === 'status') {
    requireVisible(ctx, governance.gazette_channel_id, '官報');
    requireVisible(ctx, governance.statute_forum_id || governance.gazette_channel_id, '法令集');
    requireVisible(ctx, governance.parliament_forum_id, '議会');
    requireVisible(ctx, governance.court_forum_id, '裁判所');
  }
  if (action === 'status') {
    const constitution = getActiveConstitution(guildId);
    return [
      `状態: ${governanceStateLabel(governance.status)} / 執行: ${enforcementLabel(governance.enforcement_mode)}`,
      `憲法: v${constitution?.version ?? '?'} / hash ${constitution?.content_hash?.slice(0, 12) ?? '?'}`,
      `法令集: <#${governance.statute_forum_id || governance.gazette_channel_id}>`,
      `現行法: ${listLaws(guildId).length}件`,
      `進行中法案: ${listProposals(guildId, { statuses: ['drafting', 'draft', 'constitutional_review', 'debate', 'voting'], limit: 100 }).length}件`,
      `進行中事件: ${listCases(guildId, { statuses: ['filing', 'defense', 'deliberation', 'approval', 'appeal_window', 'appeal'], limit: 100 }).length}件`
    ].join('\n');
  }
  if (action === 'constitution') {
    const constitution = getActiveConstitution(guildId);
    return constitution
      ? `公開場所: 法令集 <#${governance.statute_forum_id || governance.gazette_channel_id}>\n現行憲法 v${constitution.version}\n\n${constitution.content}\n\nPolicy:\n${JSON.stringify(constitution.policy)}`
      : '現行憲法がありません。';
  }
  if (action === 'laws') {
    const laws = listLaws(guildId);
    return `公開場所: 法令集 <#${governance.statute_forum_id || governance.gazette_channel_id}>\n`
      + (laws.map((law) => `#${law.id} ${law.code} ${law.title} / 施行 ${new Date(law.effective_at).toISOString()}`).join('\n') || '現行法はありません。');
  }
  if (action === 'law') {
    const law = sameGuild(getLaw(integerId(args.id)), guildId, '法律');
    return `公開場所: 法令集 <#${governance.statute_forum_id || governance.gazette_channel_id}>\n#${law.id} ${law.code} ${law.title}\n\n${law.text}\n\nProvisions:\n${JSON.stringify(law.provisions)}`;
  }
  if (action === 'proposals') {
    const proposals = listProposals(guildId, { limit: 50 });
    return proposals.map((proposal) => `L-${proposal.id} ${proposalKindLabel(proposal.kind)} / ${proposalStateLabel(proposal.status)} / ${proposal.title}`).join('\n') || '法案はありません。';
  }
  if (action === 'proposal') {
    const proposal = sameGuild(getProposal(integerId(args.id)), guildId, '法案');
    const vote = proposalVoteSummary(proposal.id);
    const electorate = governance.trusted_role_id
      ? (ctx.guild.roles?.cache?.get?.(governance.trusted_role_id)?.name ?? '特別有権者')
      : '特別有権者';
    return [
      `L-${proposal.id} ${proposalKindLabel(proposal.kind)} / ${proposalStateLabel(proposal.status)} / ${proposal.title}`,
      proposal.summary,
      `投票: 賛成${vote.yes} 反対${vote.no} 棄権${vote.abstain} / ${electorate}の反対${vote.trustedNo}/${vote.trustedTotal}有効票`,
      proposal.body ? JSON.stringify(proposal.body) : '本文は起草中'
    ].join('\n');
  }
  if (action === 'cases') {
    const cases = listCases(guildId, { limit: 50 });
    return cases.map((entry) => `C-${entry.id} ${caseKindLabel(entry.kind)} / ${caseStateLabel(entry.status)}${entry.law_id ? ` / 法律 #${entry.law_id}:${entry.offense_code}` : ''}${entry.challenged_type ? ` / 違憲審査対象 ${entry.challenged_type}:${entry.challenged_id}` : ''}`).join('\n') || '事件はありません。';
  }
  if (action === 'case') {
    const entry = sameGuild(getCase(integerId(args.id)), guildId, '事件');
    return [
      `C-${entry.id} ${caseKindLabel(entry.kind)} / ${caseStateLabel(entry.status)}`,
      `申立概要: ${entry.summary}`,
      entry.law_id ? `適用法: #${entry.law_id} / ${entry.offense_code}` : null,
      entry.challenged_type ? `違憲審査対象: ${entry.challenged_type}:${entry.challenged_id}` : null,
      entry.verdict ? `判決: ${JSON.stringify(entry.verdict)}` : '判決: 未確定'
    ].filter(Boolean).join('\n');
  }
  if (action === 'administration') {
    const acts = listAdministrativeActs(guildId, 50);
    return acts.map((act) => `A-${act.id} ${act.kind} / ${act.status} / ${act.summary}`).join('\n') || '行政行為はありません。';
  }
  if (action === 'administrative_act') {
    const act = sameGuild(getAdministrativeAct(integerId(args.id)), guildId, '行政行為');
    return `A-${act.id} ${act.kind} / ${act.status}\n${act.summary}\n${JSON.stringify(act.detail)}`;
  }
  throw new Error('未知のgovernance actionです。');
}
