import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  PermissionFlagsBits,
  type ButtonInteraction,
  type Client,
  type Guild,
  type GuildMember,
  type Message,
  type MessageMentionOptions
} from 'discord.js';
import { parseDiscordRef, fromDiscordMessage } from '../agent/format.js';
import { messageEnvelope } from '../conversation/message.js';
import {
  claimGovernanceIntake,
  createGovernanceIntake,
  createMentionInvestigation,
  findAcceptedMentionInvestigationForCase,
  findCaseByPoliceEvent,
  findGovernanceIntakeByResult,
  findMentionInvestigationByResult,
  getActiveConstitution,
  getCase,
  getGovernanceGuild,
  getGovernanceIntake,
  getMentionInvestigationBySource,
  getLaw,
  listCases,
  listInvestigationEvidence,
  listPendingGovernanceIntakes,
  listStaleMentionInvestigations,
  listLaws,
  recordInvestigationEvidence,
  updateGovernanceIntake,
  updateMentionInvestigation
} from './db.js';
import { interpretJudicialRequest, screenJudicialMention } from './llm.js';
import { actingMember, postCourtRecord, publicMemberLabel } from './discord.js';
import { evidenceLink, investigationContextSettings, investigationTargets } from './context.js';
import { investigationSummary } from './tools.js';
import { normalizeActivityContent, sha256 } from './policy.js';
import { governanceActionAllowed } from './restrictions.js';
import {
  addEvidenceToCase,
  appealCase,
  fileConstitutionalChallenge,
  fileCriminalCase,
  reserveGovernanceIntakeAttempt
} from './service.js';
import { idOrNull, type CaseRecord, type GovernanceGuild, type Intake, type MentionInvestigation } from './types.js';
import {
  arrayOf,
  errorCode,
  errorMessage,
  isNumber,
  isRecord,
  isString,
  isStringArray,
  optional,
  requireRow,
  requireValue,
  shape,
  type EvidenceToRevalidate,
  type GovernanceReservation,
  type IntakeResult,
  type InvestigationContext,
  type InvestigationOutcome,
  type MentionMessage,
  type PanelRecord,
  type RetriedResult,
  type ScreenedCase,
  type ScreeningRecordCandidate,
  type SourceEvidence,
  type StoredCandidate,
  type ValidatedEvidence
} from './types-service.js';

const INTAKE_TTL_MS = 30 * 60_000;
const NO_MENTIONS: MessageMentionOptions = { parse: [], repliedUser: true };
const PROCEDURAL_JUDICIARY = /(違憲|上訴|控訴|証拠.{0,8}(?:追加|提出)|事件.{0,8}(?:状況|状態|どうな))/u;

// 保存した JSON の項目 (payload / result) から引く id は、識別子の形でなければ「無い」として探さない。
const caseById = (caseId: unknown): CaseRecord | null => getCase(idOrNull(caseId));
const lawById = (lawId: unknown) => getLaw(idOrNull(lawId));

/** メッセージのサーバーの統治設定。サーバー外 (DM) の呼びかけには無い。 */
function governanceOf(guildId: string | null | undefined): GovernanceGuild | null {
  return guildId ? getGovernanceGuild(guildId) : null;
}

function roleMentioned(message: MentionMessage, roleId: string): boolean {
  return Boolean(roleId && message.mentions?.roles?.has?.(roleId));
}

export function governanceMentionBranch(message: MentionMessage, governance = governanceOf(message?.guildId)): 'judiciary' | null {
  // 他のAI botはコミュニティ参加者として発議できるが、統治bot自身の出力では再帰発火させない。
  if (!governance || (message?.author?.bot && message.author.id === message.client?.user?.id)) return null;
  // 立法の入口は議会Forumへの投稿。mentionで受けるのは通報と司法手続だけ。
  return roleMentioned(message, governance.judiciary_role_id) ? 'judiciary' : null;
}

function stripAddressMentions(content: unknown, governance: GovernanceGuild, clientId: string | undefined): string {
  const ids = [governance.judiciary_role_id].filter(Boolean);
  let output = String(content ?? '');
  for (const id of ids) output = output.replaceAll(`<@&${id}>`, ' ');
  if (clientId) output = output.replace(new RegExp(`<@!?${clientId}>`, 'g'), ' ');
  return output.replace(/[^\S\n]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

function safeError(error: unknown): string {
  const message = errorMessage(error);
  if (/Governance model HTTP|Governance AI is busy|fetch failed|JSON|SQLITE|DiscordAPIError/i.test(message)) {
    return 'AI・Discord・DBの一時エラーです。少し待ってからもう一度呼んでください。';
  }
  return message.slice(0, 500);
}

function linkToThread(guildId: string, threadId: unknown): string {
  return `[投稿を開く](https://discord.com/channels/${guildId}/${String(threadId)})`;
}

function sourceLink(guildId: string, evidence: unknown): string | null {
  return isRecord(evidence) && evidence['messageId'] && evidence['channelId']
    ? `[証拠の投稿を開く](https://discord.com/channels/${guildId}/${String(evidence['channelId'])}/${String(evidence['messageId'])})`
    : null;
}

// 受信した添付 (Collection) と検査用の配列の両方を読む。
function attachmentLines(attachments: unknown): string[] {
  const values: unknown[] = attachments instanceof Map ? [...attachments.values()] : Array.isArray(attachments) ? attachments : [];
  return values.map((attachment) => {
    const entry = isRecord(attachment) ? attachment : {};
    return `[添付] ${String(entry['name'])} ${String(entry['url'])}`;
  });
}

function sourceContent(source: Message): string {
  return [
    source.content,
    ...attachmentLines(source.attachments)
  ].filter(Boolean).join('\n').slice(0, 8000);
}

async function fetchSourceMessage(message: MentionMessage, governance: GovernanceGuild): Promise<SourceEvidence | null> {
  let channelId: string = message.reference?.channelId ?? message.channelId;
  let messageId: string | null = message.reference?.messageId ?? null;
  if (!messageId) {
    const cleaned = stripAddressMentions(message.content, governance, message.client.user?.id);
    if (/https?:\/\/(?:\w+\.)?discord(?:app)?\.com\/channels\//i.test(cleaned)) {
      const parsed = parseDiscordRef(cleaned);
      if (parsed?.guildId && parsed.guildId !== message.guildId) throw new Error('別サーバーのメッセージは証拠にできません。');
      channelId = parsed?.channelId ?? channelId;
      messageId = parsed?.messageId ?? null;
    }
  }
  if (!messageId) return null;
  const guild = requireValue(message.guild, 'サーバー内でのみ使えます。');
  const channel = await guild.channels.fetch(channelId).catch(() => null);
  if (!channel?.isTextBased?.()) throw new Error('証拠メッセージのチャンネルを読めません。');
  const requester = message.member ?? await guild.members.fetch(message.author.id);
  if (!channel.permissionsFor(requester)?.has(PermissionFlagsBits.ViewChannel)) {
    throw new Error('自分が閲覧できないメッセージは証拠にできません。');
  }
  const source = await channel.messages.fetch(messageId).catch(() => null);
  if (!source) throw new Error('証拠メッセージが見つかりません。');
  const content = sourceContent(source);
  if (!content) throw new Error('証拠として保存できる本文または添付がありません。');
  return {
    messageId: source.id,
    channelId: source.channelId,
    authorId: source.author.id,
    authorIsBot: source.author.bot,
    content: content.slice(0, 8000),
    conversation: messageEnvelope(fromDiscordMessage(source)),
    occurredAt: source.createdTimestamp
  };
}

export async function revalidateInvestigationEvidence(
  message: { guild: Guild },
  rows: readonly EvidenceToRevalidate[],
  partyIds: readonly (string | null | undefined)[] = [],
  { allowBots = false }: { allowBots?: boolean } = {}
): Promise<ValidatedEvidence[]> {
  const validated: ValidatedEvidence[] = [];
  const fetchOrAbsent = async <T>(read: () => Promise<T>): Promise<T | null> => {
    try { return await read(); } catch (error) {
      if ([10003, 10007, 10008, 50001, 50013].includes(errorCode(error))) return null;
      throw error; // A transport outage is not evidence that a source disappeared.
    }
  };
  for (const row of rows) {
    const channel = await fetchOrAbsent(() => message.guild.channels.fetch(row.channelId));
    if (!channel?.isTextBased?.()) continue;
    const everyone = message.guild.roles.everyone;
    if (!everyone || !channel.permissionsFor(everyone)?.has(PermissionFlagsBits.ViewChannel)) continue;
    let visible = true;
    for (const userId of new Set(partyIds.filter((id): id is string => Boolean(id)))) {
      const member = await fetchOrAbsent(() => message.guild.members.fetch(userId));
      if (!member || !channel.permissionsFor(member)?.has(PermissionFlagsBits.ViewChannel)) {
        visible = false;
        break;
      }
    }
    if (!visible) continue;
    const source = await fetchOrAbsent(() => channel.messages.fetch(row.messageId));
    if (!source || (!allowBots && source.author.bot) || String(source.author.id) !== String(row.authorId)) continue;
    const content = sourceContent(source);
    const currentHash = sha256(normalizeActivityContent(content));
    const plainHash = sha256(normalizeActivityContent(source.content));
    if (row.contentHash && row.contentHash !== currentHash && row.contentHash !== plainHash) continue;
    validated.push({
      messageId: source.id,
      channelId: source.channelId,
      authorId: source.author.id,
      content,
      contentHash: currentHash,
      conversation: messageEnvelope(fromDiscordMessage(source)),
      occurredAt: source.createdTimestamp
    });
  }
  return validated;
}

async function assertEvidenceVisibleTo(guild: Guild, evidence: unknown, userIds: readonly unknown[]): Promise<void> {
  const channelId = isRecord(evidence) ? String(evidence['channelId']) : 'undefined';
  const channel = await guild.channels.fetch(channelId).catch(() => null);
  if (!channel?.isTextBased?.()) throw new Error('証拠チャンネルを読めません。');
  for (const userId of new Set(userIds.filter(Boolean).map(String))) {
    const member = await guild.members.fetch(userId).catch(() => null);
    if (!member || !channel.permissionsFor(member)?.has(PermissionFlagsBits.ViewChannel)) {
      throw new Error('当事者が閲覧できない場所の内容は証拠にできません。裁判所の事件投稿へ提示してください。');
    }
  }
  const everyone = guild.roles?.everyone;
  if (!everyone || !channel.permissionsFor(everyone)?.has(PermissionFlagsBits.ViewChannel)) {
    throw new Error('裁判は公開審理です。非公開場所の内容は、公開可能な形に整理して裁判所の事件投稿へ提示してください。');
  }
}

function intakeButtons(intake: Intake): ActionRowBuilder<ButtonBuilder>[] {
  const buttons = [
    new ButtonBuilder()
      .setCustomId(`gov:intake:${intake.id}:confirm`)
      .setLabel('審議に進める')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`gov:intake:${intake.id}:cancel`)
      .setLabel('取り消す')
      .setStyle(ButtonStyle.Danger)
  ];
  return [new ActionRowBuilder<ButtonBuilder>().addComponents(buttons)];
}

const TARGET_LABELS: Record<string, string> = { sanction: '処分', administrative_act: '行政行為' };

function renderIntake(intake: Intake, suffix = ''): string {
  const payload = intake.payload;
  const pending = intake.status === 'pending' || intake.status === 'processing';
  const lines: (string | null)[] = [intake.status === 'completed' ? '## 正式受付済み' : pending ? '## 受付前の確認' : '## 受付結果', ''];
  if (intake.action === 'criminal_case') {
    const law = lawById(payload['lawId']);
    const offense = law?.provisions?.offenses?.find((entry) => entry.code === payload['offenseCode']);
    lines.push(
      '種別: 法律違反の申立て',
      `被申立人: ${publicMemberLabel(payload['accusedId'])}`,
      `適用法候補: ${law?.title ?? '裁判記録に記載'}`,
      offense?.title ? `対象となる違反: ${offense.title}` : null,
      pending ? `申立内容: ${String(payload['summary'])}` : null,
      pending ? `証拠: ${sourceLink(intake.guild_id, payload['evidence'])}` : null
    );
  } else if (intake.action === 'constitutional_challenge') {
    const target = payload['targetType'] === 'law'
      ? lawById(payload['targetId'])?.title
      : payload['targetType'] === 'case'
        ? caseById(payload['targetId'])?.summary
        : (TARGET_LABELS[String(payload['targetType'])] ?? '統治行為');
    lines.push(
      '種別: 違憲審査',
      `対象: ${target ?? '指定した統治行為'}`,
      pending ? `申立理由: ${String(payload['summary'])}` : null
    );
  } else if (intake.action === 'evidence') {
    lines.push('種別: 証拠追加', '対象: 指定した裁判', `証拠: ${sourceLink(intake.guild_id, payload['evidence'])}`);
  } else if (intake.action === 'appeal') {
    lines.push('種別: 上訴', '対象: 指定した裁判', `上訴理由: ${String(payload['summary'])}`);
  }
  lines.push('', suffix || '内容が正しければ「審議に進める」を押してください。押すまでは正式案件になりません。');
  return lines.filter((line) => line !== null).join('\n').slice(0, 2000);
}

function retriedResultText(intake: Intake, resultType: string, result: RetriedResult): string {
  if (resultType === 'case') {
    const link = result.public_thread_id ? `\n${linkToThread(intake.guild_id, result.public_thread_id)}` : '';
    return `裁判所の受付処理が完了しました。${link}`;
  }
  return '受付処理が完了しました。';
}

export async function updateRetriedIntakeMessage(guild: Guild, resultType: string, result: RetriedResult): Promise<boolean> {
  const intake = findGovernanceIntakeByResult(guild.id, resultType, result.id);
  if (!intake?.response_message_id) return false;
  const channel = await guild.channels.fetch(intake.channel_id).catch(() => null);
  if (!channel?.isTextBased?.()) return false;
  const message = await channel.messages.fetch(intake.response_message_id).catch(() => null);
  if (!message) return false;
  const completed = { ...intake, last_error: null };
  await message.edit({
    content: renderIntake(completed, retriedResultText(completed, resultType, result)),
    components: [],
    allowedMentions: NO_MENTIONS
  });
  updateGovernanceIntake(intake.id, { last_error: null });
  return true;
}

// 事件化した候補は調査記録 (result_json) に残し、公開の再試行で読み戻す。
const isStoredElement = shape({
  element: isString,
  messageIds: arrayOf(isString),
  supportingSeats: optional(isNumber),
  reason: optional(isString)
});
const isStoredCandidate = shape({
  accusedId: isString,
  lawId: isNumber,
  offenseCode: isString,
  summary: isString,
  supportingSeats: isNumber,
  evidenceMessageIds: isStringArray,
  elementEvidence: arrayOf(isStoredElement)
});
const isStoredScreening = shape({
  failedSeats: isNumber,
  required: optional(isNumber),
  totalSeats: isNumber,
  candidates: arrayOf(isStoredCandidate)
});

function caseIdList(value: unknown, fallback: unknown[]): unknown[] {
  return Array.isArray(value) ? value : fallback;
}

export async function updateRetriedMentionInvestigationMessage(guild: Guild, resultType: string, result: RetriedResult): Promise<boolean> {
  const investigation = findMentionInvestigationByResult(guild.id, resultType, result.id)
    ?? (resultType === 'case' ? findAcceptedMentionInvestigationForCase(guild.id, result.id) : null);
  if (!investigation || investigation.status !== 'accepted') return false;
  if (resultType === 'case') {
    const rawScreening = investigation.result['screening'];
    const screening = isStoredScreening(rawScreening) ? rawScreening : undefined;
    const caseIds = caseIdList(investigation.result['caseIds'], [result.id]);
    const published = new Set(caseIdList(investigation.result['publishedCaseIds'], []).map(String));
    const evidenceRows = listInvestigationEvidence(investigation.id, 'judicial_charge');
    for (const caseId of caseIds) {
      const currentCase = caseById(caseId);
      if (!currentCase?.public_thread_id || published.has(String(caseId))) continue;
      const candidate = screening?.candidates?.find((entry) => (
        String(entry.accusedId) === String(currentCase.accused_id)
        && Number(entry.lawId) === Number(currentCase.law_id)
        && entry.offenseCode === currentCase.offense_code
      ));
      if (!screening || !candidate) continue;
      const evidence = evidenceRows
        .filter((entry) => candidate.evidenceMessageIds.includes(String(entry.message_id)))
        .map((entry) => ({
          messageId: String(entry.message_id), channelId: String(entry.channel_id),
          authorId: String(entry.author_id), content: entry.content,
          contentHash: entry.content_hash, occurredAt: entry.occurred_at
        }));
      await publishJudicialScreeningRecord(guild, investigation, currentCase, candidate, evidence, {
        outputs: Array.from({ length: Math.max(0, screening.totalSeats - screening.failedSeats) }),
        failedSeats: screening.failedSeats
      });
      published.add(String(caseId));
    }
    const ready = caseIds.every((caseId) => {
      const currentCase = caseById(caseId);
      return currentCase?.public_thread_id && !currentCase.retry_after
        && !['filing', 'police_review'].includes(currentCase.status);
    });
    updateMentionInvestigation(investigation.id, {
      result: { ...investigation.result, publishedCaseIds: [...published] },
      record_published_at: ready ? Date.now() : null
    });
    if (!ready) return false;
  }
  if (investigation.response_message_id) {
    const channel = await guild.channels.fetch(investigation.channel_id).catch(() => null);
    const response = channel?.isTextBased?.()
      ? await channel.messages.fetch(investigation.response_message_id).catch(() => null)
      : null;
    if (response) {
      const caseLinks = resultType === 'case'
        ? caseIdList(investigation.result['caseIds'], [result.id])
          .flatMap((caseId) => {
            const caseRecord = caseById(caseId);
            return caseRecord?.public_thread_id ? [linkToThread(guild.id, caseRecord.public_thread_id)] : [];
          })
        : [];
      const text = `裁判所の公開準備が完了しました。\n${caseLinks.join('\n')}`;
      await response.edit({ content: text, allowedMentions: NO_MENTIONS });
    }
  }
  updateMentionInvestigation(investigation.id, {
    status: 'completed', outcome: 'filed', last_error: null, completed_at: Date.now()
  });
  return true;
}

export async function syncPendingIntakeMessages(guild: Guild): Promise<number> {
  const governance = getGovernanceGuild(guild.id);
  const constitution = getActiveConstitution(guild.id);
  if (!governance || !constitution) return 0;
  let updatedCount = 0;
  for (const intake of listPendingGovernanceIntakes(guild.id)) {
    if (!intake.response_message_id) continue;
    const current = intake;
    const channel = await guild.channels.fetch(current.channel_id).catch(() => null);
    if (!channel?.isTextBased?.()) continue;
    const message = current.response_message_id ? await channel.messages.fetch(current.response_message_id).catch(() => null) : null;
    if (!message) continue;
    await message.edit({
      content: renderIntake(current),
      components: intakeButtons(current),
      allowedMentions: NO_MENTIONS
    });
    updatedCount += 1;
  }
  return updatedCount;
}

async function createPreview(message: MentionMessage, branch: string, action: string, payload: Record<string, unknown>): Promise<boolean> {
  const intake = requireRow(createGovernanceIntake({
    guildId: requireValue(message.guildId, 'サーバー内でのみ使えます。'),
    branch,
    action,
    requesterId: message.author.id,
    channelId: message.channelId,
    sourceMessageId: message.id,
    payload,
    expiresAt: Date.now() + INTAKE_TTL_MS
  }), 'intake');
  const response = await message.reply({
    content: renderIntake(intake),
    components: intakeButtons(intake),
    allowedMentions: NO_MENTIONS
  });
  updateGovernanceIntake(intake.id, { response_message_id: response.id });
  return true;
}

function reservationMessage(reservation: GovernanceReservation): string {
  const retry = reservation.retryAt ? ` <t:${Math.floor(reservation.retryAt / 1000)}:R>に空きます。` : '';
  if (reservation.reason === 'interim_protection') return `一時保全中は自分の裁判事件でだけ発言できます。${retry}`;
  if (reservation.scope === 'sanction') return `現在の判決によりAI受付が制限されています。${retry}`;
  return `AI受付の24時間回数枠に達しました (${reservation.used}/${reservation.limit})。${retry}`;
}

const CASE_STATUS_LABELS: Record<string, string> = {
  filing: '受付中', police_review: '警察が確認中', contest_window: '処分中・不服申立て可',
  defense: '答弁期間', deliberation: '審理中', approval: '執行承認待ち',
  appeal_window: '上訴受付中', appeal: '上訴審理中', execution: '執行処理中', final: '確定',
  overturned: '取消', acquitted: '責任なし', dismissed: '棄却',
  constitutional_uncertain: '違憲判断不能', unenforceable: '執行不能'
};

function caseStatusText(caseRecord: CaseRecord, guildId: string): string {
  const status = CASE_STATUS_LABELS[caseRecord.status] ?? caseRecord.status;
  const law = caseRecord.law_id ? lawById(caseRecord.law_id) : null;
  const offense = law?.provisions?.offenses?.find((entry) => entry.code === caseRecord.offense_code);
  const challenged = caseRecord.challenged_type === 'law'
    ? lawById(caseRecord.challenged_id)?.title
    : caseRecord.challenged_type === 'case'
      ? caseById(caseRecord.challenged_id)?.summary
      : null;
  return [
    `${caseRecord.kind === 'constitutional' ? '違憲審査' : '法律違反の申立て'}`,
    `状態: ${status}`,
    caseRecord.accused_id ? `被申立人: ${publicMemberLabel(caseRecord.accused_id)}` : null,
    law ? `適用法: ${law.title}` : null,
    offense?.title ? `対象となる違反: ${offense.title}` : null,
    caseRecord.challenged_type ? `違憲審査対象: ${challenged ?? (TARGET_LABELS[caseRecord.challenged_type] ?? '統治行為')}` : null,
    caseRecord.public_thread_id ? linkToThread(guildId, caseRecord.public_thread_id) : null
  ].filter(Boolean).join('\n');
}

/** service が「受理済み・公開準備は再試行」として投げた例外から事件を引く。 */
function acceptedResult(error: unknown): { resultType: unknown; resultId: unknown } | null {
  if (!isRecord(error) || !isRecord(error['accepted'])) return null;
  return { resultType: error['accepted']['resultType'], resultId: error['accepted']['resultId'] };
}

function acceptedCaseResult(error: unknown): CaseRecord | null {
  const accepted = acceptedResult(error);
  if (accepted?.resultType !== 'case') return null;
  return caseById(accepted.resultId);
}

// 席の調査は要約だけ公開する（憲法第九条8・実行規則 investigation.publicRecord）。
const PANEL_LENS_LABELS = ['textual', 'rights', 'adversarial'];

function publicRecordMode(policy: unknown): unknown {
  const investigation = isRecord(policy) ? policy['investigation'] : undefined;
  return isRecord(investigation) ? investigation['publicRecord'] : undefined;
}

function investigationLines(panel: PanelRecord, policy: unknown): string[] {
  if ((publicRecordMode(policy) ?? 'none') === 'none') return [];
  return (panel.traces ?? [])
    .flatMap(({ seat, trace }) => {
      const summary = investigationSummary(trace, {
        seat,
        lens: PANEL_LENS_LABELS[(seat - 1) % PANEL_LENS_LABELS.length] ?? null,
        maximumSteps: panel.maximumSteps ?? 0
      });
      return summary ? [summary] : [];
    });
}

async function publishJudicialScreeningRecord(
  guild: Guild,
  investigation: MentionInvestigation,
  caseRecord: CaseRecord,
  candidate: ScreeningRecordCandidate,
  evidence: readonly { messageId: string; channelId: string }[],
  panel: PanelRecord
): Promise<boolean> {
  if (!caseRecord?.public_thread_id) return false;
  const law = lawById(candidate.lawId);
  const offense = law?.provisions?.offenses?.find((entry) => entry.code === candidate.offenseCode);
  const links = new Map(evidence.map((row, index) => [row.messageId, `[記録${index + 1}](${String(evidenceLink(guild.id, row))})`]));
  await postCourtRecord(guild, caseRecord, [
    '## AI事前審査の記録',
    `適用法: ${law?.title ?? '成立法'}`,
    `対象となる違反: ${offense?.title ?? candidate.offenseCode}`,
    `事件化を支持したAI席: ${candidate.supportingSeats}/${panel.outputs.length + panel.failedSeats}`,
    ...candidate.elementEvidence.map((entry) => (
      `- ${entry.element}（${entry.supportingSeats ?? candidate.supportingSeats}席が認定）: ${entry.messageIds.map((id) => links.get(String(id))).filter(Boolean).join('、')}`
    )),
    candidate.reasons?.length ? `事件化の理由: ${candidate.reasons.join(' / ')}` : null,
    '',
    ...investigationLines(panel, getActiveConstitution(guild.id)?.policy),
    '',
    'これは事件を開始するための審査です。有罪・処分は成立法に基づく別の司法パネルが判断します。'
  ].filter((line) => line !== null).join('\n'));
  return true;
}

const PETITION_BLOCKED = '事件申立てが制裁により停止されています。';

async function runProceduralJudiciary(
  message: MentionMessage,
  request: string,
  anchor: SourceEvidence | null,
  investigation: MentionInvestigation,
  reservation: GovernanceReservation,
  member: GuildMember
): Promise<InvestigationOutcome> {
  const guild = requireValue(message.guild, 'サーバー内でのみ使えます。');
  const constitution = requireValue(getActiveConstitution(guild.id), '有効な憲法がありません。');
  const output = await interpretJudicialRequest({
    guildId: guild.id,
    request: {
      text: request,
      authorId: message.author.id,
      repliedEvidence: anchor ? {
        messageId: anchor.messageId,
        channelId: anchor.channelId,
        authorId: anchor.authorId,
        content: anchor.content,
        occurredAt: anchor.occurredAt
      } : null
    },
    constitution,
    activeLaws: listLaws(guild.id),
    recentCases: listCases(guild.id, { limit: 25 })
  });
  if (reservation.scope === 'constitutional_challenge' && output.intent !== 'constitutional_challenge') {
    const general = reserveGovernanceIntakeAttempt(member, `${message.id}:general`);
    if (!general.ok) return { outcome: 'limited', text: reservationMessage(general) };
  }
  // 依頼文の言い回しでは違憲審査に見えなくても、席が違憲審査と読んだなら違憲審査の回数枠を使う。
  // (文面で回数枠を選ばせると、言い換えだけで1日の申立て上限を越えられる)
  if (output.intent === 'constitutional_challenge' && reservation.scope !== 'constitutional_challenge') {
    const constitutional = reserveGovernanceIntakeAttempt(member, `${message.id}:constitutional`, { constitutional: true });
    if (!constitutional.ok) return { outcome: 'limited', text: reservationMessage(constitutional) };
  }
  updateMentionInvestigation(investigation.id, { outcome: 'procedural', result: { procedural: output } });
  if (output.intent === 'case_status') {
    const caseRecord = caseById(output.caseId);
    if (!caseRecord || caseRecord.guild_id !== message.guildId) throw new Error('事件が見つかりません。');
    return { outcome: 'information', text: caseStatusText(caseRecord, guild.id) };
  }
  if (output.intent === 'information' || output.intent === 'unclear') {
    return { outcome: output.intent, text: output.question ?? '' };
  }
  if (output.intent === 'constitutional_challenge') {
    try {
      const caseRecord = await fileConstitutionalChallenge(guild, { id: message.client.user.id }, {
        targetType: output.targetType,
        targetId: output.targetId,
        reason: output.summary,
        eventId: message.id,
        attemptReserved: true,
        official: true
      });
      return {
        outcome: 'filed', resultType: 'case', resultId: caseRecord.id,
        text: `違憲審査を正式受理しました。\n${linkToThread(guild.id, caseRecord.public_thread_id)}`
      };
    } catch (error) {
      const accepted = acceptedCaseResult(error);
      if (!accepted) throw error;
      return {
        outcome: 'accepted_pending', resultType: 'case', resultId: accepted.id,
        text: '違憲審査を正式受理しました。公開記録の準備は自動で再試行します。'
      };
    }
  }
  if (output.intent === 'evidence') {
    if (!anchor) return { outcome: 'unclear', text: '追加する投稿へ返信して、もう一度 @通報 を呼んでください。' };
    const caseRecord = caseById(output.caseId);
    if (!caseRecord || caseRecord.guild_id !== message.guildId) throw new Error('事件が見つかりません。');
    await assertEvidenceVisibleTo(guild, anchor, [caseRecord.reporter_id, caseRecord.accused_id]);
    const evidenceId = await addEvidenceToCase(guild, member, requireValue(output.caseId, '事件が見つかりません。'), anchor);
    return { outcome: 'evidence_added', resultType: 'evidence', resultId: evidenceId, text: '証拠を裁判記録へ追加しました。' };
  }
  if (output.intent === 'appeal') {
    const caseRecord = await appealCase(guild, member, requireValue(output.caseId, '事件が見つかりません。'), output.summary ?? '');
    return {
      outcome: 'appealed', resultType: 'case', resultId: caseRecord.id,
      text: `上訴を正式受理しました。\n${linkToThread(guild.id, caseRecord.public_thread_id)}`
    };
  }
  return { outcome: 'unclear', text: output.question ?? '審査対象を特定できませんでした。' };
}

async function runAutomaticJudiciary(
  message: MentionMessage,
  request: string,
  anchor: SourceEvidence | null,
  context: InvestigationContext,
  investigation: MentionInvestigation,
  reservation: GovernanceReservation,
  member: GuildMember
): Promise<InvestigationOutcome> {
  if (PROCEDURAL_JUDICIARY.test(request)) {
    return runProceduralJudiciary(message, request, anchor, investigation, reservation, member);
  }
  const guild = requireValue(message.guild, 'サーバー内でのみ使えます。');
  // 通報は bot 名義の公式申立てになる。申立権を止められた本人の通報から事件を作らない。
  if (!governanceActionAllowed(guild.id, message.author.id, 'petition')) return { outcome: 'limited', text: PETITION_BLOCKED };
  const constitution = requireValue(getActiveConstitution(guild.id), '有効な憲法がありません。');
  const laws = listLaws(guild.id).filter((law) => law.status === 'active');
  const panel = await screenJudicialMention({
    guildId: guild.id,
    request: {
      messageId: message.id,
      text: request,
      authorId: message.author.id,
      targetUserIds: context.targetUserIds,
      repliedTo: anchor
        ? { messageId: anchor.messageId, channelId: anchor.channelId, authorId: anchor.authorId }
        : null
    },
    constitution,
    activeLaws: laws,
    recentCases: listCases(guild.id, { limit: 25 }),
    panel: constitution.rules?.panels.judicialScreening,
    investigation: constitution.policy.investigation
  });
  if (panel.outputs.length < panel.required) {
    return { outcome: 'failed_closed', text: '警察の席が必要数そろわなかったため、事件化も処分も行いませんでした。' };
  }
  const candidates = panel.candidates.slice(0, context.settings.caseLimit);
  if (!candidates.length) {
    return { outcome: 'no_case', text: '公開記録と成立法を照合しましたが、全構成要件を証拠で確認できる違反は見つかりませんでした。' };
  }
  const results: ScreenedCase[] = [];
  const storedCandidates: StoredCandidate[] = [];
  const publishedCaseIds: string[] = [];
  for (const candidate of candidates) {
    // 席が自分で取得した行だけが候補になる。完全な行はパネルの台帳から引く。
    const selected = candidate.evidenceMessageIds
      .flatMap((id) => {
        const row = panel.retrieved.get(String(id));
        return row ? [row] : [];
      });
    const evidence = await revalidateInvestigationEvidence({ guild }, selected, [candidate.accusedId]);
    const validIds = new Set(evidence.map((row) => row.messageId));
    if (candidate.elementEvidence.some((entry) => entry.messageIds.every((id) => !validIds.has(String(id))))) continue;
    const accused = await guild.members.fetch(candidate.accusedId).catch(() => null);
    if (!accused || accused.user?.bot) continue;
    const policeEventKey = `ai-screen:${sha256([
      guild.id,
      candidate.accusedId,
      candidate.lawId,
      candidate.offenseCode,
      ...evidence.map((row) => row.messageId).sort()
    ].join('|'))}`;
    const duplicate = findCaseByPoliceEvent(guild.id, policeEventKey);
    if (duplicate) {
      results.push({ caseRecord: duplicate, candidate, evidence, duplicate: true });
      continue;
    }
    recordInvestigationEvidence(investigation.id, evidence, 'judicial_charge');
    storedCandidates.push({
      accusedId: candidate.accusedId,
      lawId: candidate.lawId,
      offenseCode: candidate.offenseCode,
      summary: candidate.summary,
      supportingSeats: candidate.supportingSeats,
      evidenceMessageIds: evidence.map((row) => row.messageId),
      elementEvidence: candidate.elementEvidence
    });
    updateMentionInvestigation(investigation.id, {
      outcome: 'filing',
      result: { screening: {
        failedSeats: panel.failedSeats,
        required: panel.required,
        totalSeats: panel.outputs.length + panel.failedSeats,
        candidates: storedCandidates
      } }
    });
    try {
      const caseRecord = await fileCriminalCase(guild, { id: message.client.user.id }, {
        accused,
        lawId: candidate.lawId,
        offenseCode: candidate.offenseCode,
        summary: candidate.summary,
        evidences: evidence,
        eventId: message.id,
        attemptReserved: true,
        policeEventKey,
        official: true
      });
      results.push({ caseRecord, candidate, evidence, duplicate: false });
    } catch (error) {
      const accepted = acceptedCaseResult(error);
      if (!accepted) throw error;
      results.push({ caseRecord: accepted, candidate, evidence, duplicate: false, pending: true });
    }
  }
  const representative = results.find((entry) => entry.pending) ?? results[0];
  if (!representative) {
    return { outcome: 'no_case', text: '候補はありましたが、公開性・改変有無・当事者の閲覧権限を再確認できず、事件化も処分も行いませんでした。' };
  }
  for (const result of results) {
    if (!result.duplicate && !result.pending) {
      await publishJudicialScreeningRecord(
        guild, investigation, result.caseRecord, result.candidate, result.evidence, panel
      );
      publishedCaseIds.push(String(result.caseRecord.id));
    }
  }
  const links = results
    .flatMap((result) => (result.caseRecord.public_thread_id ? [linkToThread(guild.id, result.caseRecord.public_thread_id)] : []));
  return {
    outcome: results.some((result) => result.pending) ? 'accepted_pending' : 'filed',
    resultType: 'case',
    resultId: representative.caseRecord.id,
    result: {
      screening: {
        failedSeats: panel.failedSeats,
        required: panel.required,
        totalSeats: panel.outputs.length + panel.failedSeats,
        candidates: storedCandidates
      },
      caseIds: results.map((entry) => entry.caseRecord.id),
      publishedCaseIds,
      omittedCandidates: Math.max(0, panel.candidates.length - candidates.length)
    },
    text: [
      `${results.length}件を成立法に基づいて警察が受理しました。`,
      ...links,
      panel.candidates.length > candidates.length
        ? `安全上限により、残り${panel.candidates.length - candidates.length}件は今回事件化していません。`
        : null
    ].filter(Boolean).join('\n')
  };
}

function investigationSettings(guildId: string): InvestigationContext['settings'] {
  return { caseLimit: investigationContextSettings(guildId).caseLimit };
}

function isRetryHinted(error: unknown): boolean {
  return isRecord(error) && Boolean(error['governanceRetryHint']);
}

async function executeAutomaticInvestigation(
  message: MentionMessage,
  governance: GovernanceGuild,
  request: string,
  investigation: MentionInvestigation,
  reservation: GovernanceReservation,
  member: GuildMember,
  progress: Message | null
): Promise<boolean> {
  try {
    const anchor = await fetchSourceMessage(message, governance);
    const context: InvestigationContext = {
      settings: investigationSettings(String(message.guildId)),
      targetUserIds: investigationTargets(message, anchor)
    };
    const result = await runAutomaticJudiciary(
      message, request, anchor, context, investigation, reservation, member
    );
    const current = getMentionInvestigationBySource(message.id);
    const status = result.outcome === 'accepted_pending' ? 'accepted' : 'completed';
    updateMentionInvestigation(investigation.id, {
      status,
      outcome: result.outcome,
      result_type: result.resultType ?? current?.result_type ?? null,
      result_id: result.resultId === undefined ? (current?.result_id ?? null) : String(result.resultId),
      result: result.result ?? current?.result ?? {},
      last_error: null,
      completed_at: status === 'completed' ? Date.now() : null
    });
    if (typeof progress?.edit === 'function') {
      await progress.edit({ content: result.text.slice(0, 2000), allowedMentions: NO_MENTIONS });
    }
    return true;
  } catch (error) {
    console.error(`Governance ${investigation.branch} investigation failed:`, error);
    const current = getMentionInvestigationBySource(message.id) ?? investigation;
    const retryCount = Number(current.result['retryCount'] ?? 0) + 1;
    const retryable = isRetryHinted(error)
      || /Governance model HTTP|Governance AI is busy|fetch failed|JSON|SQLITE|DiscordAPIError/i.test(errorMessage(error));
    const willRetry = retryable && retryCount < 3;
    updateMentionInvestigation(investigation.id, {
      status: willRetry ? 'processing' : 'failed',
      outcome: willRetry ? 'retrying' : 'failed',
      result: { ...current.result, retryCount },
      last_error: errorMessage(error).slice(0, 500),
      completed_at: willRetry ? null : Date.now()
    });
    if (typeof progress?.edit === 'function') {
      await progress.edit({
        content: willRetry
          ? 'AI・Discord・DBの一時エラーです。調査記録を保持し、自動で再試行します。'
          : `調査を完了できません: ${safeError(error)}`,
        allowedMentions: NO_MENTIONS
      });
    }
    return true;
  }
}

export async function resumePendingMentionInvestigations(guild: Guild, now = Date.now()): Promise<number> {
  const governance = getGovernanceGuild(guild.id);
  if (!governance || governance.status !== 'active') return 0;
  let resumed = 0;
  for (const stale of listStaleMentionInvestigations(guild.id, now - 15 * 60_000, 5)) {
    updateMentionInvestigation(stale.id, { outcome: 'resuming', last_error: null });
    const fetched = await guild.channels.fetch(stale.channel_id).catch(() => null);
    const channel = fetched?.isTextBased?.() ? fetched : null;
    const source = channel
      ? await channel.messages.fetch(stale.source_message_id).catch(() => null)
      : null;
    const member = await guild.members.fetch(stale.requester_id).catch(() => null);
    if (!channel || !source || !member) {
      updateMentionInvestigation(stale.id, {
        status: 'failed', outcome: 'source_unavailable',
        last_error: '元の呼びかけまたはメンバーを取得できません。', completed_at: Date.now()
      });
      continue;
    }
    let progress = stale.response_message_id
      ? await channel.messages.fetch(stale.response_message_id).catch(() => null)
      : null;
    if (!progress) {
      progress = await source.reply({
        content: '中断したAI調査を再開しています。',
        allowedMentions: NO_MENTIONS
      }).catch(() => null);
      if (progress) updateMentionInvestigation(stale.id, { response_message_id: progress.id });
    }
    const constitutional = stale.branch === 'judiciary'
      && /(違憲|憲法.{0,12}(?:違反|反する)|constitutional)/i.test(stale.request_text);
    await executeAutomaticInvestigation(
      source,
      governance,
      stale.request_text,
      { ...stale, outcome: 'resuming' },
      { ok: true, scope: constitutional ? 'constitutional_challenge' : 'attempt' },
      member,
      progress
    );
    resumed += 1;
  }
  return resumed;
}

export async function handleGovernanceMention(message: MentionMessage): Promise<boolean> {
  const governance = governanceOf(message?.guildId);
  const branch = governanceMentionBranch(message, governance);
  if (!governance || !branch) return false;
  if (governance.status !== 'active') {
    await message.reply({ content: '統治機能は現在一時停止中です。', allowedMentions: NO_MENTIONS });
    return true;
  }
  const request = stripAddressMentions(message.content, governance, message.client.user?.id);
  if (!request) {
    await message.reply({
      content: '通報したい内容を書いてください。違反の通報なら対象発言へ返信してください。上訴・取り下げ・違憲審査もここです。',
      allowedMentions: NO_MENTIONS
    });
    return true;
  }
  if (getMentionInvestigationBySource(message.id)) return true;
  const constitutional = branch === 'judiciary' && /(違憲|憲法.{0,12}(?:違反|反する)|constitutional)/i.test(request);
  const member = message.member ?? await message.guild?.members.fetch(message.author.id).catch(() => null) ?? null;
  if (!member) {
    await message.reply({ content: 'サーバーメンバー情報を取得できません。', allowedMentions: NO_MENTIONS });
    return true;
  }
  const reservation = reserveGovernanceIntakeAttempt(member, message.id, { constitutional });
  if (!reservation.ok) {
    await message.reply({ content: reservationMessage(reservation), allowedMentions: NO_MENTIONS });
    return true;
  }
  const investigation = requireRow(createMentionInvestigation({
    guildId: requireValue(message.guildId, 'サーバー内でのみ使えます。'),
    branch,
    requesterId: message.author.id,
    channelId: message.channelId,
    sourceMessageId: message.id,
    requestText: request
  }), 'mention investigation');
  if ('sendTyping' in message.channel) await message.channel.sendTyping().catch(() => {});
  const progress = await message.reply({
    content: '警察が公開記録と成立法を照合しています。根拠がそろった場合だけ処分または送検に移します。',
    allowedMentions: NO_MENTIONS
  });
  updateMentionInvestigation(investigation.id, { response_message_id: progress.id });
  return executeAutomaticInvestigation(message, governance, request, investigation, reservation, member, progress);
}

async function executeIntake(interaction: ButtonInteraction, intake: Intake): Promise<IntakeResult> {
  const guild = requireValue(interaction.guild, 'サーバー内でのみ使えます。');
  const member = await actingMember(interaction, guild);
  const payload = intake.payload;
  if (intake.action === 'criminal_case') {
    await assertEvidenceVisibleTo(guild, payload['evidence'], [interaction.user.id, payload['accusedId']]);
    const accusedId = payload['accusedId'];
    if (typeof accusedId !== 'string') throw new Error('被申立人を確認できません。');
    const accused = await guild.members.fetch(accusedId);
    const result = await fileCriminalCase(guild, member, {
      accused,
      lawId: payload['lawId'],
      offenseCode: payload['offenseCode'],
      summary: payload['summary'],
      evidence: payload['evidence'],
      eventId: intake.source_message_id,
      attemptReserved: true
    });
    return { type: 'case', id: result.id, text: result.public_thread_id
      ? `法律違反の申立てを受理しました。\n${linkToThread(guild.id, result.public_thread_id)}`
      : '法律違反の申立てを受理し、AI判定を開始しました。処分がある場合は本人へ通知します。' };
  }
  if (intake.action === 'constitutional_challenge') {
    const result = await fileConstitutionalChallenge(guild, member, {
      targetType: payload['targetType'],
      targetId: payload['targetId'],
      reason: payload['summary'],
      eventId: intake.source_message_id,
      attemptReserved: Boolean(payload['constitutionalAttemptReserved'])
    });
    return { type: 'case', id: result.id, text: `違憲審査を受理しました。\n${linkToThread(guild.id, result.public_thread_id)}` };
  }
  if (intake.action === 'evidence') {
    const caseRecord = caseById(payload['caseId']);
    if (!caseRecord || caseRecord.guild_id !== interaction.guildId) throw new Error('事件が見つかりません。');
    await assertEvidenceVisibleTo(guild, payload['evidence'], [caseRecord.reporter_id, caseRecord.accused_id]);
    const id = await addEvidenceToCase(guild, member, caseRecord.id, payload['evidence']);
    return { type: 'evidence', id, text: '証拠を裁判記録へ追加しました。' };
  }
  if (intake.action === 'appeal') {
    const result = await appealCase(guild, member, Number(payload['caseId']), String(payload['summary'] ?? ''));
    return { type: 'appeal', id: result.id, text: '上訴を受理しました。' };
  }
  throw new Error('未対応の受付種別です。');
}

export async function handleGovernanceIntakeComponent(interaction: ButtonInteraction, intakeId: number, value: string | undefined): Promise<boolean> {
  const intake = getGovernanceIntake(intakeId);
  if (!intake || intake.guild_id !== interaction.guildId) {
    await interaction.reply({ content: '受付が見つかりません。', flags: MessageFlags.Ephemeral });
    return true;
  }
  if (intake.requester_id !== interaction.user.id) {
    await interaction.reply({ content: '発議・申立てを開始した本人だけが確定できます。', flags: MessageFlags.Ephemeral });
    return true;
  }
  if (intake.status !== 'pending' || intake.expires_at <= Date.now()) {
    await interaction.reply({ content: 'この受付は確定済み、取消済み、または期限切れです。', flags: MessageFlags.Ephemeral });
    return true;
  }
  if (value === 'cancel') {
    const updated = requireRow(updateGovernanceIntake(intake.id, { status: 'cancelled' }), 'intake');
    await interaction.update({
      content: renderIntake(updated, '本人が取り消しました。正式案件にはなっていません。'),
      components: [],
      allowedMentions: { parse: [] }
    });
    return true;
  }
  if (value !== 'confirm') {
    await interaction.reply({ content: '未対応の受付操作です。', flags: MessageFlags.Ephemeral });
    return true;
  }
  const claimed = claimGovernanceIntake(intake.id, interaction.user.id);
  if (!claimed) {
    await interaction.reply({ content: 'この受付は既に処理されています。', flags: MessageFlags.Ephemeral });
    return true;
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    const result = await executeIntake(interaction, claimed);
    const completed = requireRow(updateGovernanceIntake(claimed.id, {
      status: 'completed',
      result_type: result.type,
      result_id: result.id,
      last_error: null
    }), 'intake');
    await interaction.message.edit({
      content: renderIntake(completed, result.text),
      components: [],
      allowedMentions: { parse: [] }
    }).catch(() => {});
    await interaction.editReply(result.text);
  } catch (error) {
    console.error(`Governance intake ${claimed.id} execution failed:`, error);
    const accepted = acceptedResult(error);
    if (accepted?.resultType && accepted.resultId) {
      const acceptedIntake = requireRow(updateGovernanceIntake(claimed.id, {
        status: 'completed',
        result_type: accepted.resultType,
        result_id: accepted.resultId,
        last_error: errorMessage(error).slice(0, 500)
      }), 'intake');
      await interaction.message.edit({
        content: renderIntake(acceptedIntake, '受け付けました。準備ができると公開記録に表示されます。'),
        components: [],
        allowedMentions: { parse: [] }
      }).catch(() => {});
      await interaction.editReply(errorMessage(error));
      return true;
    }
    const failed = requireRow(updateGovernanceIntake(claimed.id, { status: 'failed', last_error: errorMessage(error).slice(0, 500) }), 'intake');
    await interaction.message.edit({
      content: renderIntake(failed, '受付処理に失敗しました。重複防止のため再実行はしません。内容を直して新しく呼び出してください。'),
      components: [],
      allowedMentions: { parse: [] }
    }).catch(() => {});
    await interaction.editReply(`実行できません: ${safeError(error)}`);
  }
  return true;
}

export async function updateExpiredIntakeMessages(client: Client, intakes: readonly Intake[]): Promise<number> {
  let updated = 0;
  for (const intake of intakes) {
    if (!intake.response_message_id) continue;
    const channel = await client.channels.fetch(intake.channel_id).catch(() => null);
    if (!channel?.isTextBased?.()) continue;
    const message = await channel.messages.fetch(intake.response_message_id).catch(() => null);
    if (!message) continue;
    const expired = { ...intake, status: 'expired' };
    await message.edit({
      content: renderIntake(expired, '確認期限が切れました。正式案件にはなっていません。必要なら改めて呼び出してください。'),
      components: [],
      allowedMentions: NO_MENTIONS
    }).catch(() => {});
    updated += 1;
  }
  return updated;
}
