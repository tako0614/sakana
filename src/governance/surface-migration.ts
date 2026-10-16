import { ChannelType, type Guild, type GuildBasedChannel, type Message } from 'discord.js';
import {
  archiveLegacyGovernanceMessage,
  getGovernanceGuild,
  getGovernanceSurfaceMigration,
  listCases,
  listLaws,
  markLegacyGovernanceChannelDeleted,
  markLegacyGovernanceMessageDeleted,
  updateGovernanceSurfaceMigration
} from './db.js';
import {
  authorityChangeContent,
  ensureGovernanceOperationsThread,
  postAuthorityChange,
  syncGovernanceRecordUi,
  withoutLegacyPublicIds
} from './discord.js';
import { syncLawSite } from './lawsite.js';
import { ensureGovernanceUx } from './ux.js';
import { ensurePublicCaseRecord } from './service.js';
import type { GovernanceGuild, SurfaceMigration } from './types.js';

const AUTHORITY_HEADINGS = [
  /統治機能を(?:開始|再開|一時停止)/,
  /実執行を(?:有効化|停止)/,
  /記録のみに変更/,
  /特別有権者(?:ロール変更|ロール設定|機能を無効化|機能を自動無効化)/,
  /「.+」に追加/,
  /「.+」から削除/
];
const COURT_HEADINGS = [
  /AI取締り判定/,
  /即時処分/,
  /判決/,
  /上訴/,
  /裁判/
];

export interface LegacyClassification {
  kind: 'unknown' | 'empty' | 'authority' | 'statute' | 'court';
  heading: string;
  text: string;
}

// discord.js はまだ JS で、既定値 (procedureMessage = null) から引数の型が null に狭く推論される。
// TS へ移るまでの境界として、ここで渡す形の型を一度だけ与える。
const ensureOperationsThread = ensureGovernanceOperationsThread as (guild: Guild, governance: GovernanceGuild, procedureMessage?: unknown) => ReturnType<typeof ensureGovernanceOperationsThread>;

function headingOf(content: unknown): string {
  return (String(content ?? '').split('\n', 1)[0] ?? '').replace(/^#+\s*/, '').trim();
}

export function classifyLegacyGazetteContent(content: unknown, lawTitles: readonly string[] = []): LegacyClassification {
  const text = String(withoutLegacyPublicIds(content));
  const heading = headingOf(text);
  if (!heading) return { kind: 'unknown', heading, text };
  if (['行政行為はありません。', '現行法はありません。'].includes(heading)) {
    return { kind: 'empty', heading, text };
  }
  if (AUTHORITY_HEADINGS.some((pattern) => pattern.test(heading))) return { kind: 'authority', heading, text };
  if (/憲法.*(?:v\d+|公布|改正)/i.test(heading)
    || lawTitles.some((title) => heading === title || heading.startsWith(`${title} v`))) {
    return { kind: 'statute', heading, text };
  }
  if (COURT_HEADINGS.some((pattern) => pattern.test(heading))) return { kind: 'court', heading, text };
  return { kind: 'unknown', heading, text };
}

async function fetchAllMessages(channel: GuildBasedChannel | null | undefined): Promise<Message[]> {
  if (!channel?.isTextBased?.()) return [];
  const messages: Message[] = [];
  let before: string | undefined;
  for (;;) {
    const batch = await channel.messages.fetch({ limit: 100, ...(before ? { before } : {}) });
    if (batch.size === 0) break;
    messages.push(...batch.values());
    before = batch.last()?.id;
    if (batch.size < 100 || !before) break;
  }
  return messages.sort((left, right) => left.createdTimestamp - right.createdTimestamp);
}

async function archivedAttachments(message: Message) {
  const output = [];
  for (const attachment of message.attachments.values()) {
    if (attachment.size > 5_000_000) {
      throw new Error(`添付 ${attachment.name} は5 MBを超えるため、旧channelを削除しません。`);
    }
    const response = await fetch(attachment.url);
    if (!response.ok) throw new Error(`添付 ${attachment.name} を保存できません (HTTP ${response.status})。`);
    output.push({
      id: attachment.id,
      name: attachment.name,
      contentType: attachment.contentType,
      size: attachment.size,
      url: attachment.url,
      dataBase64: Buffer.from(await response.arrayBuffer()).toString('base64')
    });
  }
  return output;
}

function legacyAuthorityRecord(classification: LegacyClassification): { heading: string; body: string } {
  const lines = classification.text.split('\n');
  const body = lines.slice(1)
    .filter((line) => !/詳細な監査情報は添付ファイル/.test(line))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  return { heading: classification.heading, body: body || '変更を記録しました。' };
}

interface ClassifiedMessage {
  message: Message;
  classification: LegacyClassification;
}

/** 移行が不要・完了済みのときは、旧公開面を読まない。 */
interface IdleFields {
  governance: GovernanceGuild;
  blockers: string[];
  guideMessages?: undefined;
  gazetteMessages?: undefined;
  counts?: undefined;
}
type IdleInspection =
  | (IdleFields & { status: 'not-needed'; migration: null })
  | (IdleFields & { status: 'completed'; migration: SurfaceMigration });

interface PendingInspection {
  governance: GovernanceGuild;
  migration: SurfaceMigration;
  status: 'blocked' | 'ready';
  blockers: string[];
  guide: GuildBasedChannel | null;
  gazette: GuildBasedChannel | null;
  guideMessages: Message[];
  gazetteMessages: Message[];
  classified: ClassifiedMessage[];
  counts: Record<string, number>;
}

async function inspect(guild: Guild): Promise<IdleInspection | PendingInspection> {
  const governance = getGovernanceGuild(guild.id);
  if (!governance) throw new Error('統治機能が初期化されていません。');
  const migration = getGovernanceSurfaceMigration(guild.id);
  if (!migration) return { governance, migration: null, status: 'not-needed', blockers: [] };
  if (migration.status === 'completed') {
    return { governance, migration, status: 'completed', blockers: [] };
  }
  const guide = migration.legacy_guide_channel_id
    ? await guild.channels.fetch(migration.legacy_guide_channel_id).catch(() => null)
    : null;
  const gazette = migration.legacy_gazette_channel_id
    ? await guild.channels.fetch(migration.legacy_gazette_channel_id).catch(() => null)
    : null;
  const blockers: string[] = [];
  const deleting = migration.status === 'running' && migration.detail?.phase === 'deleting';
  if (migration.legacy_guide_channel_id && !guide && !deleting) blockers.push('旧案内channelを読み戻せません。');
  if (migration.legacy_gazette_channel_id && !gazette && !deleting) blockers.push('旧官報channelを読み戻せません。');
  if (guide && guide.type !== ChannelType.GuildText) blockers.push('旧案内がtext channelではありません。');
  if (gazette && gazette.type !== ChannelType.GuildText) blockers.push('旧官報がtext channelではありません。');
  const [guideMessages, gazetteMessages] = await Promise.all([
    fetchAllMessages(guide),
    fetchAllMessages(gazette)
  ]);
  const lawTitles = listLaws(guild.id).map((law) => law.title);
  const classified = gazetteMessages.map((message) => ({
    message,
    classification: classifyLegacyGazetteContent(message.content, lawTitles)
  }));
  for (const message of guideMessages) {
    if (message.author.id !== guild.client.user.id) {
      blockers.push(`旧案内にbot以外の投稿があります: ${message.id}`);
    }
  }
  for (const entry of classified) {
    if (entry.message.author.id !== guild.client.user.id) {
      blockers.push(`旧官報にbot以外の投稿があります: ${entry.message.id}`);
    } else if (entry.classification.kind === 'unknown') {
      blockers.push(`分類できない旧官報投稿があります: ${entry.classification.heading || entry.message.id}`);
    }
  }
  for (const message of [...guideMessages, ...gazetteMessages]) {
    for (const attachment of message.attachments.values()) {
      if (attachment.size > 5_000_000) {
        blockers.push(`5 MBを超える添付があります: ${attachment.name}`);
      }
    }
  }
  return {
    governance,
    migration,
    status: blockers.length ? 'blocked' : 'ready',
    blockers,
    guide,
    gazette,
    guideMessages,
    gazetteMessages,
    classified,
    counts: classified.reduce<Record<string, number>>((counts, entry) => {
      counts[entry.classification.kind] = (counts[entry.classification.kind] ?? 0) + 1;
      return counts;
    }, {})
  };
}

export interface SurfaceMigrationPlan {
  guildId: string;
  status: string;
  legacyGuideChannelId: string;
  legacyGazetteChannelId: string;
  guideMessages: number;
  gazetteMessages: number;
  classifications: Record<string, number>;
  blockers: string[];
}

export async function planGovernanceSurfaceMigration(guild: Guild): Promise<SurfaceMigrationPlan> {
  const result = await inspect(guild);
  return {
    guildId: guild.id,
    status: result.status,
    legacyGuideChannelId: result.migration?.legacy_guide_channel_id ?? '',
    legacyGazetteChannelId: result.migration?.legacy_gazette_channel_id ?? '',
    guideMessages: result.guideMessages?.length ?? 0,
    gazetteMessages: result.gazetteMessages?.length ?? 0,
    classifications: result.counts ?? {},
    blockers: result.blockers
  };
}

function requireGovernance(governance: GovernanceGuild | null): GovernanceGuild {
  if (!governance) throw new Error('統治機能が初期化されていません。');
  return governance;
}

export async function applyGovernanceSurfaceMigration(guild: Guild): Promise<SurfaceMigrationPlan> {
  const inspected = await inspect(guild);
  if (inspected.status === 'not-needed' || inspected.status === 'completed') {
    return await planGovernanceSurfaceMigration(guild);
  }
  if (inspected.blockers.length) throw new Error(inspected.blockers.join(' / '));
  if (inspected.migration.status === 'running' && inspected.migration.detail?.phase === 'deleting') {
    for (const channel of [inspected.guide, inspected.gazette].filter((entry) => entry !== null)) {
      if (channel.id === inspected.governance.procedure_channel_id) throw new Error('手続channelを旧channelとして削除しようとしました。');
      await channel.delete(`${guild.name} governance: resume 4 surface migration`);
    }
    for (const channelId of [
      inspected.migration.legacy_guide_channel_id,
      inspected.migration.legacy_gazette_channel_id
    ].filter(Boolean)) {
      markLegacyGovernanceChannelDeleted(guild.id, channelId);
    }
    updateGovernanceSurfaceMigration(guild.id, {
      status: 'completed',
      completed_at: Date.now(),
      detail: { ...inspected.migration.detail, phase: 'completed' }
    });
    return await planGovernanceSurfaceMigration(guild);
  }
  updateGovernanceSurfaceMigration(guild.id, {
    status: 'running',
    detail: { phase: 'publishing', classifications: inspected.counts }
  });
  // ux.js・discord.js はまだ JS。ここで使う戻り値の形を明示する。
  const ux: { governance: GovernanceGuild | null; procedureMessage: unknown } = await ensureGovernanceUx(guild, inspected.governance);
  let governance = requireGovernance(ux.governance);
  syncLawSite(guild, { verifyExisting: true });
  for (const caseRecord of listCases(guild.id, { limit: 1_000 })) {
    if (caseRecord.summary.startsWith('[E2E:')) continue;
    if (!caseRecord.public_thread_id) await ensurePublicCaseRecord(guild, caseRecord);
  }
  governance = requireGovernance(getGovernanceGuild(guild.id));
  await syncGovernanceRecordUi(guild, governance);
  const operations: GuildBasedChannel | null = await ensureOperationsThread(guild, governance, ux.procedureMessage);
  const existingOperationMessages = new Set((await fetchAllMessages(operations)).map((message) => message.content));

  const allLegacyMessages = [...inspected.guideMessages, ...inspected.gazetteMessages];
  for (const message of allLegacyMessages) {
    archiveLegacyGovernanceMessage({
      guildId: guild.id,
      channelId: message.channelId,
      messageId: message.id,
      authorId: message.author.id,
      content: message.content,
      attachments: await archivedAttachments(message),
      createdAt: message.createdTimestamp,
      reason: '4面統治UXへの移行'
    });
  }
  for (const entry of inspected.classified.filter((item) => item.classification.kind === 'authority')) {
    const record = legacyAuthorityRecord(entry.classification);
    const expected = authorityChangeContent(record.heading, record.body);
    if (!existingOperationMessages.has(expected)) {
      await postAuthorityChange(guild, governance, record.heading, record.body);
      existingOperationMessages.add(expected);
    }
  }

  const refreshed = await inspect(guild);
  if (refreshed.blockers.length) throw new Error(refreshed.blockers.join(' / '));
  updateGovernanceSurfaceMigration(guild.id, {
    status: 'running',
    detail: { phase: 'deleting', classifications: inspected.counts, archivedMessages: allLegacyMessages.length }
  });
  for (const channel of [inspected.guide, inspected.gazette].filter((entry) => entry !== null)) {
    if (channel.id === governance.procedure_channel_id) throw new Error('手続channelを旧channelとして削除しようとしました。');
    await channel.delete(`${guild.name} governance: 4 surface migration`);
  }
  for (const message of allLegacyMessages) {
    markLegacyGovernanceMessageDeleted(guild.id, message.channelId, message.id);
  }
  for (const channelId of [
    inspected.migration.legacy_guide_channel_id,
    inspected.migration.legacy_gazette_channel_id
  ].filter(Boolean)) {
    markLegacyGovernanceChannelDeleted(guild.id, channelId);
  }
  updateGovernanceSurfaceMigration(guild.id, {
    status: 'completed',
    completed_at: Date.now(),
    detail: { phase: 'completed', classifications: inspected.counts, archivedMessages: allLegacyMessages.length }
  });
  return await planGovernanceSurfaceMigration(guild);
}
