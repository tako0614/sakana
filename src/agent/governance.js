import { PermissionFlagsBits } from 'discord.js';
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
import { lawSiteLink } from '../governance/lawsite.js';

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
        id: { type: 'number', description: '内部参照が既に分かる場合だけ使う番号' },
        title: { type: 'string', description: '人が読める法律名・法案名・事件概要' }
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

function byTitle(records, value, label, field = 'title') {
  const title = String(value ?? '').trim();
  if (!title) throw new Error(`${label}の名前が必要です。`);
  const exact = records.filter((record) => String(record[field] ?? '') === title);
  if (exact.length === 1) return exact[0];
  const partial = records.filter((record) => String(record[field] ?? '').includes(title));
  if (partial.length === 1) return partial[0];
  if (exact.length + partial.length > 1) throw new Error(`${label}を一つに絞れません。名前を詳しく指定してください。`);
  throw new Error(`${label}が見つかりません。`);
}

function requestedRecord(args, records, guildId, label, field = 'title') {
  return args.id !== undefined
    ? sameGuild(records.find((record) => record.id === integerId(args.id)), guildId, label)
    : byTitle(records, args.title, label, field);
}

function lawDescription(entry) {
  if (!entry.law_id) return null;
  const law = getLaw(entry.law_id);
  const offense = law?.provisions?.offenses?.find((item) => item.code === entry.offense_code);
  return [law?.title, offense?.title].filter(Boolean).join(' / ') || '適用法は裁判記録に記載';
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
    agenda: '議題（国会待ち）', voting: '投票中', enacted: '成立', rejected: '不成立'
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

const PUBLIC_ADMINISTRATIVE_KINDS = new Set([
  'enforcement_mode', 'trusted_role', 'trusted_member_add', 'trusted_member_remove', 'governance_status'
]);

function lawSiteLine(guildId) {
  const link = lawSiteLink(guildId);
  return link ? `公開場所: ${link}\n` : '';
}

function publicAdministrativeActs(guildId, limit) {
  return listAdministrativeActs(guildId, Math.max(limit * 4, 100))
    .filter((act) => PUBLIC_ADMINISTRATIVE_KINDS.has(act.kind))
    .slice(0, limit);
}

export function runGovernanceInfo(ctx, args) {
  const guildId = ctx.guild.id;
  const governance = getGovernanceGuild(guildId);
  if (!governance) return 'このサーバーでは統治機能が初期化されていません。';
  const action = String(args.action ?? 'status');
  if (['administration', 'administrative_act'].includes(action)) {
    requireVisible(ctx, governance.procedure_channel_id, '手続');
  }
  if (['proposals', 'proposal'].includes(action)) {
    requireVisible(ctx, governance.parliament_forum_id, '議会');
  }
  if (['cases', 'case'].includes(action)) {
    requireVisible(ctx, governance.court_forum_id, '裁判所');
  }
  if (action === 'status') {
    requireVisible(ctx, governance.procedure_channel_id, '手続');
    requireVisible(ctx, governance.parliament_forum_id, '議会');
    requireVisible(ctx, governance.court_forum_id, '裁判所');
  }
  if (action === 'status') {
    const constitution = getActiveConstitution(guildId);
    return [
      `状態: ${governanceStateLabel(governance.status)} / 執行: ${enforcementLabel(governance.enforcement_mode)}`,
      `憲法: v${constitution?.version ?? '?'}`,
      `手続: <#${governance.procedure_channel_id}>`,
      lawSiteLink(guildId) ? `法令集: ${lawSiteLink(guildId)}` : null,
      `現行法: ${listLaws(guildId).length}件`,
      `議題: ${listProposals(guildId, { statuses: ['agenda'], limit: 100 }).length}件 / 投票中: ${listProposals(guildId, { statuses: ['voting'], limit: 100 }).length}件`,
      `進行中事件: ${listCases(guildId, { statuses: ['filing', 'defense', 'deliberation', 'approval', 'appeal_window', 'appeal'], limit: 100 }).length}件`
    ].filter(Boolean).join('\n');
  }
  if (action === 'constitution') {
    const constitution = getActiveConstitution(guildId);
    return constitution
      ? `${lawSiteLine(guildId)}現行憲法 v${constitution.version}\n\n${constitution.content}`
      : '現行憲法がありません。';
  }
  if (action === 'laws') {
    const laws = listLaws(guildId);
    return lawSiteLine(guildId)
      + (laws.map((law) => `${law.title} / 施行 ${new Date(law.effective_at).toISOString()}`).join('\n') || '現行法はありません。');
  }
  if (action === 'law') {
    const law = requestedRecord(args, listLaws(guildId), guildId, '法律');
    return `${lawSiteLine(guildId)}${law.title}\n\n${law.text}`;
  }
  if (action === 'proposals') {
    const proposals = listProposals(guildId, { limit: 50 });
    return proposals.map((proposal) => `${proposalKindLabel(proposal.kind)} / ${proposalStateLabel(proposal.status)} / ${proposal.title}`).join('\n') || '法案はありません。';
  }
  if (action === 'proposal') {
    const proposal = requestedRecord(args, listProposals(guildId, { limit: 100 }), guildId, '法案');
    const vote = proposalVoteSummary(proposal.id);
    const electorate = governance.trusted_role_id
      ? (ctx.guild.roles?.cache?.get?.(governance.trusted_role_id)?.name ?? '特別有権者')
      : '特別有権者';
    return [
      `${proposalKindLabel(proposal.kind)} / ${proposalStateLabel(proposal.status)} / ${proposal.title}`,
      proposal.summary,
      `投票: 賛成${vote.yes} 反対${vote.no} 棄権${vote.abstain} / ${electorate}の反対${vote.trustedNo}/${vote.trustedTotal}有効票`,
      proposal.body?.content ?? proposal.body?.text ?? '本文は起草中'
    ].join('\n');
  }
  if (action === 'cases') {
    const cases = listCases(guildId, { limit: 50 });
    return cases.map((entry) => `${caseKindLabel(entry.kind)} / ${caseStateLabel(entry.status)} / ${entry.summary}${entry.law_id ? ` / ${lawDescription(entry)}` : ''}`).join('\n') || '事件はありません。';
  }
  if (action === 'case') {
    const entry = requestedRecord(args, listCases(guildId, { limit: 100 }), guildId, '事件', 'summary');
    return [
      `${caseKindLabel(entry.kind)} / ${caseStateLabel(entry.status)}`,
      `申立概要: ${entry.summary}`,
      entry.law_id ? `適用法: ${lawDescription(entry)}` : null,
      entry.challenged_type ? '違憲審査対象: 申立概要と公開裁判記録に記載' : null,
      entry.verdict ? `判決: ${{ responsible: '責任あり', not_responsible: '責任なし', insufficient: '立証不十分', constitutional: '合憲', unconstitutional: '違憲', uncertain: '判断不能' }[entry.verdict.verdict] ?? '確定済み'}` : '判決: 未確定'
    ].filter(Boolean).join('\n');
  }
  if (action === 'administration') {
    const acts = publicAdministrativeActs(guildId, 50);
    return acts.map((act) => `${act.status} / ${act.summary}`).join('\n') || '行政行為はありません。';
  }
  if (action === 'administrative_act') {
    const act = requestedRecord(args, publicAdministrativeActs(guildId, 100), guildId, '行政行為', 'summary');
    return `${act.status}\n${act.summary}`;
  }
  throw new Error('未知のgovernance actionです。');
}
