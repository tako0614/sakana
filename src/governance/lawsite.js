import { governanceConfig } from './config.js';
import {
  enqueueAction,
  getConstitution,
  getLaw,
  getLawPublication,
  listConstitutions,
  listLaws,
  upsertLawPublication,
  writeAudit
} from './db.js';

// 公開状態はWeb側の一覧タグと同じ語彙にそろえる。
export function publicationState(instrumentType, status) {
  if (instrumentType === 'constitution') return status === 'active' ? '現行憲法' : '旧憲法';
  return ({
    active: '現行法',
    superseded: '旧法',
    suspended: '停止',
    unconstitutional: '違憲',
    repealed: '廃止'
  })[status] ?? status;
}

export function lawSiteConfigured() {
  return Boolean(governanceConfig.lawSiteUrl && governanceConfig.lawSiteToken);
}

export function lawSiteLink(guildId) {
  if (!governanceConfig.lawSitePublicUrl) return null;
  return `${governanceConfig.lawSitePublicUrl}/?guild=${encodeURIComponent(String(guildId))}`;
}

function instrumentPayload(guildId, instrumentType, instrument) {
  if (instrumentType === 'constitution') {
    return {
      guildId: String(guildId),
      type: 'constitution',
      instrumentId: String(instrument.id),
      rootId: 'constitution',
      code: `CONSTITUTION-V${instrument.version}`,
      title: `憲法 v${instrument.version}`,
      version: Number(instrument.version),
      status: instrument.status,
      publicationStatus: publicationState('constitution', instrument.status),
      text: instrument.content,
      provisions: instrument.rules ?? null,
      contentHash: instrument.content_hash,
      effectiveAt: Number(instrument.enacted_at),
      endedAt: null
    };
  }
  return {
    guildId: String(guildId),
    type: 'law',
    // 改正で版が変わっても同じ法令として沿革を並べる。
    instrumentId: String(instrument.id),
    rootId: String(instrument.root_law_id ?? instrument.id),
    code: instrument.code,
    title: instrument.title,
    version: Number(instrument.version ?? 1),
    status: instrument.status,
    publicationStatus: publicationState('law', instrument.status),
    text: instrument.text,
    provisions: instrument.provisions,
    contentHash: instrument.content_hash,
    effectiveAt: Number(instrument.effective_at),
    endedAt: instrument.ended_at === null || instrument.ended_at === undefined
      ? null
      : Number(instrument.ended_at)
  };
}

function instrumentsFor(guildId) {
  return [
    ...listConstitutions(guildId, { limit: 100 })
      .map((entry) => ({ instrumentType: 'constitution', instrument: entry })),
    ...listLaws(guildId, { activeOnly: false, limit: 500 })
      .map((entry) => ({ instrumentType: 'law', instrument: entry }))
  ];
}

/**
 * 公開正本はWorker + D1側にある。ここでは差分だけをoutboxへ積み、
 * 実際のHTTPは既存のoutbox処理 (冪等・再試行つき) が行う。
 */
export function syncLawSite(guild, { verifyExisting = false } = {}) {
  if (!lawSiteConfigured()) return { queued: 0, skipped: true };
  let queued = 0;
  for (const { instrumentType, instrument } of instrumentsFor(guild.id)) {
    const state = publicationState(instrumentType, instrument.status);
    const published = getLawPublication(guild.id, instrumentType, instrument.id);
    if (!verifyExisting
      && published
      && published.content_hash === instrument.content_hash
      && published.publication_status === state) {
      continue;
    }
    enqueueAction({
      guildId: guild.id,
      actionType: 'law_publish',
      targetId: `${instrumentType}:${instrument.id}`,
      payload: { instrumentType, instrumentId: String(instrument.id) },
      idempotencyKey: `law-publish:${guild.id}:${instrumentType}:${instrument.id}:${instrument.content_hash}:${state}`
    });
    queued += 1;
  }
  return { queued, skipped: false };
}

async function postInstrument(payload) {
  const response = await fetch(`${governanceConfig.lawSiteUrl}/v1/instruments`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${governanceConfig.lawSiteToken}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(governanceConfig.httpTimeoutMs)
  });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Law site HTTP ${response.status}: ${body.slice(0, 300)}`);
  }
  return response.json().catch(() => ({}));
}

export async function publishInstrument(guildId, { instrumentType, instrumentId }) {
  if (!lawSiteConfigured()) throw new Error('法令サイトの接続先が設定されていません。');
  const instrument = instrumentType === 'constitution'
    ? getConstitution(instrumentId)
    : getLaw(instrumentId);
  if (!instrument || String(instrument.guild_id) !== String(guildId)) {
    throw new Error('公開対象の法令が見つかりません。');
  }
  const payload = instrumentPayload(guildId, instrumentType, instrument);
  await postInstrument(payload);
  upsertLawPublication({
    guildId,
    instrumentType,
    instrumentId: String(instrument.id),
    contentHash: payload.contentHash,
    publicationStatus: payload.publicationStatus
  });
  writeAudit({
    guildId,
    actorType: 'system',
    action: 'lawsite.published',
    targetType: instrumentType,
    targetId: instrument.id,
    detail: { status: payload.status, publicationStatus: payload.publicationStatus, contentHash: payload.contentHash }
  });
  return payload;
}
