import { PermissionFlagsBits } from 'discord.js';
import { lawSiteLink } from '../governance/lawsite.js';
import { governance as records, type AdministrativeAct, type CaseRecord, type Proposal } from './boundary.js';
import type { AgentContext, ToolArgs, ToolDefinition } from './types.js';

type GovernanceContext = Pick<AgentContext, 'guild' | 'member'>;

/** 正本の記録に共通する部分。id とサーバーで引き当てる。 */
interface GuildRecord {
  id: number;
  guild_id: string;
}

export const governanceDefinition: ToolDefinition = {
  type: 'function',
  function: {
    name: 'governance',
    description: 'このサーバーの現行憲法・法律・法案・事件・行政行為を正本DBから読み取る。書込みや投票はできない。',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['status', 'constitution', 'institutions', 'procedures', 'laws', 'law', 'proposals', 'proposal', 'cases', 'case', 'administration', 'administrative_act']
        },
        id: { type: 'number', description: '内部参照が既に分かる場合だけ使う番号' },
        title: { type: 'string', description: '人が読める法律名・法案名・事件概要' }
      },
      required: ['action']
    }
  }
};

function integerId(value: unknown): number {
  const id = Number(value);
  if (!Number.isInteger(id) || id < 1) throw new Error('正の案件IDが必要です。');
  return id;
}

function sameGuild<T extends GuildRecord>(record: T | undefined, guildId: string, label: string): T {
  if (!record || record.guild_id !== guildId) throw new Error(`${label}が見つかりません。`);
  return record;
}

function byTitle<T extends GuildRecord>(list: T[], value: unknown, label: string, name: (record: T) => unknown): T {
  const title = String(value ?? '').trim();
  if (!title) throw new Error(`${label}の名前が必要です。`);
  const exact = list.filter((record) => String(name(record) ?? '') === title);
  if (exact.length === 1 && exact[0]) return exact[0];
  const partial = list.filter((record) => String(name(record) ?? '').includes(title));
  if (partial.length === 1 && partial[0]) return partial[0];
  if (exact.length + partial.length > 1) throw new Error(`${label}を一つに絞れません。名前を詳しく指定してください。`);
  throw new Error(`${label}が見つかりません。`);
}

// 名前で引く項目。法律・法案は title、事件・行政行為は summary
const byTitleField = (record: { title: string }): unknown => record.title;
const bySummaryField = (record: { summary: string }): unknown => record.summary;

function requestedRecord<T extends GuildRecord>(
  args: ToolArgs, list: T[], guildId: string, label: string, name: (record: T) => unknown
): T {
  return args.id !== undefined
    ? sameGuild(list.find((record) => record.id === integerId(args.id)), guildId, label)
    : byTitle(list, args.title, label, name);
}

function lawDescription(entry: CaseRecord): string | null {
  if (!entry.law_id) return null;
  const law = records.getLaw(entry.law_id);
  const offense = law?.provisions?.offenses?.find((item) => item.code === entry.offense_code);
  return [law?.title, offense?.title].filter(Boolean).join(' / ') || '適用法は裁判記録に記載';
}

function requireVisible(ctx: GovernanceContext, channelId: string, label: string): void {
  const channel = ctx.guild.channels?.cache?.get?.(channelId);
  if (!channel?.permissionsFor?.(ctx.member)?.has(PermissionFlagsBits.ViewChannel)) {
    throw new Error(`${label}は呼び出した人に閲覧権限がないため読めません。`);
  }
}

/** 表の中の訳。表に無い値はそのまま出す (Object.hasOwn なので toString などは拾わない)。 */
function labelFrom(table: Record<string, string>, value: string | null | undefined): string | undefined {
  return value !== null && value !== undefined && Object.hasOwn(table, value) ? table[value] : undefined;
}

/** 判決の記録 ({ verdict: 'constitutional' ... }) から判決の名前だけを取り出す。形が違えば undefined。 */
function verdictName(record: unknown): string | undefined {
  if (typeof record !== 'object' || record === null || !('verdict' in record)) return undefined;
  return typeof record.verdict === 'string' ? record.verdict : undefined;
}

function governanceStateLabel(value: string): string {
  return labelFrom({ active: '稼働中', paused: '一時停止中' }, value) ?? value;
}

function enforcementLabel(value: string): string {
  return value === 'live' ? '実執行' : '記録のみ';
}

function proposalKindLabel(value: string): string {
  return value === 'amendment' ? '憲法改正案' : '法案';
}

function proposalStateLabel(proposal: Proposal): string {
  const handler = labelFrom({
    parliament_agenda: '議題（国会待ち）', legislation_draft: '起草・改稿中',
    ai_ratification: '採択審議中', constitutional_panel: '憲法審査中',
    public_vote: '投票中', law_enactment: '成立手続中', notice: '公告中', wait: '法定期間待ち'
  }, proposal.workflow_handler);
  return handler ?? labelFrom({
    agenda: '議題（国会待ち）', voting: '投票中', enacted: '成立', rejected: '不成立'
  }, proposal.status) ?? proposal.status;
}

function caseKindLabel(value: string): string {
  return value === 'constitutional' ? '違憲審査' : '法律違反の申立て';
}

function caseStateLabel(value: string): string {
  return labelFrom({
    filing: '受付中', defense: '答弁期間', deliberation: '審理中', approval: '執行承認待ち',
    appeal_window: '上訴受付中', appeal: '上訴審理中', execution: '執行処理中', final: '確定',
    overturned: '取消', acquitted: '責任なし', dismissed: '棄却',
    constitutional_uncertain: '違憲判断不能', unenforceable: '執行不能'
  }, value) ?? value;
}

const VERDICT_LABELS: Record<string, string> = {
  responsible: '責任あり', not_responsible: '責任なし', insufficient: '立証不十分',
  constitutional: '合憲', unconstitutional: '違憲', uncertain: '判断不能'
};

const PUBLIC_ADMINISTRATIVE_KINDS = new Set([
  'enforcement_mode', 'trusted_role', 'trusted_member_add', 'trusted_member_remove', 'governance_status'
]);

function lawSiteLine(guildId: string): string {
  const link = lawSiteLink(guildId);
  return link ? `公開場所: ${link}\n` : '';
}

function publicAdministrativeActs(guildId: string, limit: number): AdministrativeAct[] {
  return records.listAdministrativeActs(guildId, Math.max(limit * 4, 100))
    .filter((act) => PUBLIC_ADMINISTRATIVE_KINDS.has(act.kind))
    .slice(0, limit);
}

export function runGovernanceInfo(ctx: GovernanceContext, args: ToolArgs): string {
  const guildId = ctx.guild.id;
  const governance = records.getGovernanceGuild(guildId);
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
    const constitution = records.getActiveConstitution(guildId);
    const proposals = records.listProposals(guildId, { limit: 10000 }).filter((proposal) => proposal.workflow_handler !== 'terminal');
    const cases = records.listCases(guildId, { limit: 10000 }).filter((entry) => !entry.finalized_at && entry.workflow_handler !== 'terminal');
    return [
      `状態: ${governanceStateLabel(governance.status)} / 執行: ${enforcementLabel(governance.enforcement_mode)}`,
      `憲法: v${constitution?.version ?? '?'}`,
      `手続: <#${governance.procedure_channel_id}>`,
      lawSiteLink(guildId) ? `法令集: ${lawSiteLink(guildId)}` : null,
      `現行法: ${records.listLaws(guildId).length}件`,
      `議題: ${proposals.filter((proposal) => proposal.workflow_handler !== 'public_vote').length}件 / 投票中: ${proposals.filter((proposal) => proposal.workflow_handler === 'public_vote').length}件`,
      `進行中事件: ${cases.length}件`
    ].filter(Boolean).join('\n');
  }
  if (action === 'constitution') {
    const constitution = records.getActiveConstitution(guildId);
    return constitution
      ? `${lawSiteLine(guildId)}現行憲法 v${constitution.version}\n\n${constitution.content}`
      : '現行憲法がありません。';
  }
  if (['institutions', 'procedures'].includes(action)) {
    requireVisible(ctx, governance.procedure_channel_id, '手続');
    const constitution = records.getActiveConstitution(guildId);
    if (!constitution) throw new Error('現行憲法がありません。');
    const kind = action === 'institutions' ? 'institution' : 'procedure';
    // 機関・手続・出典を持つのは v2 の法体系だけ (v1 の憲法本文に埋め込んだ規則には無い)
    const rules = constitution.rules;
    const system = rules?.$schema === 'sakana.legal-system/v2' ? rules : null;
    const entries = (action === 'institutions' ? system?.institutions : system?.procedures) ?? {};
    return Object.entries(entries).map(([key, value]) => ({ id: key, ...value,
      legalBasis: system?.sources[`${kind}:${key}`] })).map((entry) => JSON.stringify(entry)).join('\n') || '旧憲法の実行規則を参照してください。';
  }
  if (action === 'laws') {
    const laws = records.listLaws(guildId);
    return lawSiteLine(guildId)
      + (laws.map((law) => `${law.title} / 施行 ${new Date(law.effective_at).toISOString()}`).join('\n') || '現行法はありません。');
  }
  if (action === 'law') {
    const law = requestedRecord(args, records.listLaws(guildId), guildId, '法律', byTitleField);
    const defined = law.provisions?.governance;
    return `${lawSiteLine(guildId)}${law.title}\n\n${law.text}${defined?.length ? `\n\n法令による機関・手続の定義:\n${JSON.stringify(defined)}` : ''}`;
  }
  if (action === 'proposals') {
    const proposals = records.listProposals(guildId, { limit: 50 });
    return proposals.map((proposal) => `${proposalKindLabel(proposal.kind)} / ${proposalStateLabel(proposal)} / ${proposal.title}`).join('\n') || '法案はありません。';
  }
  if (action === 'proposal') {
    const proposal = requestedRecord(args, records.listProposals(guildId, { limit: 100 }), guildId, '法案', byTitleField);
    const vote = records.proposalVoteSummary(proposal.id);
    const electorate = governance.trusted_role_id
      ? (ctx.guild.roles?.cache?.get?.(governance.trusted_role_id)?.name ?? '特別有権者')
      : '特別有権者';
    return [
      `${proposalKindLabel(proposal.kind)} / ${proposalStateLabel(proposal)} / ${proposal.title}`,
      proposal.summary,
      `投票: 賛成${vote.yes} 反対${vote.no} 棄権${vote.abstain} / ${electorate}の反対${vote.trustedNo}/${vote.trustedTotal}有効票`,
      proposal.body?.content ?? proposal.body?.text ?? '本文は起草中'
    ].join('\n');
  }
  if (action === 'cases') {
    const cases = records.listCases(guildId, { limit: 50 });
    return cases.map((entry) => `${caseKindLabel(entry.kind)} / ${caseStateLabel(entry.status)} / ${entry.summary}${entry.law_id ? ` / ${lawDescription(entry)}` : ''}`).join('\n') || '事件はありません。';
  }
  if (action === 'case') {
    const entry = requestedRecord(args, records.listCases(guildId, { limit: 100 }), guildId, '事件', bySummaryField);
    return [
      `${caseKindLabel(entry.kind)} / ${caseStateLabel(entry.status)}`,
      `申立概要: ${entry.summary}`,
      entry.law_id ? `適用法: ${lawDescription(entry)}` : null,
      entry.challenged_type ? '違憲審査対象: 申立概要と公開裁判記録に記載' : null,
      entry.verdict ? `判決: ${labelFrom(VERDICT_LABELS, verdictName(entry.verdict)) ?? '確定済み'}` : '判決: 未確定'
    ].filter(Boolean).join('\n');
  }
  if (action === 'administration') {
    const acts = publicAdministrativeActs(guildId, 50);
    return acts.map((act) => `${act.status} / ${act.summary}`).join('\n') || '行政行為はありません。';
  }
  if (action === 'administrative_act') {
    const act = requestedRecord(args, publicAdministrativeActs(guildId, 100), guildId, '行政行為', bySummaryField);
    return `${act.status}\n${act.summary}`;
  }
  throw new Error('未知のgovernance actionです。');
}
