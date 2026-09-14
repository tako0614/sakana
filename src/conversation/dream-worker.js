import 'dotenv/config';
import { isMainThread, parentPort, workerData } from 'node:worker_threads';
import { setTimeout as delay } from 'node:timers/promises';

import { dreamConfig } from './dream-config.js';
import {
  assertDreamWorkClaim,
  claimDreamWork,
  completeDreamWork,
  continueDreamWork,
  dreamJobStatus,
  dreamReviewSnapshotRequest,
  failDreamWork,
  listRunningDreamGuilds,
  markDreamWorkWaiting,
  pauseDreamJobForError,
  quarantineDreamWork,
  renewDreamWorkLease,
  splitDreamWork,
  stageDreamReviewSnapshot,
  supersedeDreamWork
} from './dream-jobs.js';
import {
  conversationWriterScope,
  enumerateConversationReviewTargets,
  setConversationPublicChannels
} from './memory.js';
import {
  requestWriterModel,
  runConversationWriter,
  runDreamWriterBatch,
  writerStatus
} from './writer.js';

const budgetErrors = new Set(['MODEL_BUDGET_EXHAUSTED', 'MODEL_BUDGET_PAUSED',
  'MODEL_BUDGET_CONFLICT', 'MODEL_BUDGET_NOT_FOUND']);
const workerOwner = `dream-worker:${process.pid}:${Math.random().toString(36).slice(2)}`;

function channelList(readableChannels, guildId) {
  const value = readableChannels?.[guildId];
  return [...new Set((Array.isArray(value) ? value : []).map(String).filter(Boolean))];
}

function currentScopes(guildId, readableChannels, permissionGeneration = null) {
  const allowed = new Set(channelList(readableChannels, guildId));
  const scopes = new Map();
  for (const channelId of allowed) {
    const scope = conversationWriterScope({ guildId, channelId });
    if (!scope.channelIds.every((id) => allowed.has(String(id)))) continue;
    const normalized = { ...scope, channelIds: [...new Set(scope.channelIds.map(String))].sort(),
      anchorChannelId: String(scope.anchorChannelId ?? channelId) };
    const key = `${normalized.policyId}\0${normalized.generation}`;
    if (!scopes.has(key)) scopes.set(key, normalized);
    // Existing channel-policy Atoms remain reviewable after a channel joins
    // the shared public graph. Source generation still sees the public scope
    // first and therefore never forks new ordinary work into both policies.
    const channelPolicyId = `discord:${guildId}:${channelId}`;
    if (normalized.policyId !== channelPolicyId) {
      const legacy = { ...conversationWriterScope({guildId,channelId,scope:{policyId:channelPolicyId,kind:'channel',channelIds:[channelId]}}),
        anchorChannelId:channelId,reviewOnly:true };
      scopes.set(`${legacy.policyId}\0${legacy.generation}`, legacy);
    }
  }
  return [...scopes.values()];
}

function updatePublicManifest({ guildId, publicChannelIds, readableChannels }) {
  if (publicChannelIds === undefined) return null;
  const byGuild = Array.isArray(publicChannelIds) ? publicChannelIds : publicChannelIds?.[guildId];
  if (!Array.isArray(byGuild)) return null;
  return setConversationPublicChannels({ guildId, channelIds: byGuild,
    permissionGeneration: JSON.stringify([guildId,[...byGuild].sort(),channelList(readableChannels,guildId).sort()]) });
}

function targetInScopes(target, scopes) {
  const policyId = target?.policyId ?? target?.payload?.scope?.policyId
    ?? target?.payload?.scope?.policy;
  if (policyId) return scopes.some((scope) => scope.policyId === policyId);
  if (target?.channelId != null) {
    return scopes.some((scope) => scope.channelIds.includes(String(target.channelId)));
  }
  return false;
}

function prepareReviewSnapshot(guildId, scopes, now, enumerateReviewTargets) {
  const request = dreamReviewSnapshotRequest({ guildId, now });
  if (!request.needed) return request;
  const all = enumerateReviewTargets({ guildId, purpose: 'daily-review' });
  if (!Array.isArray(all)) throw new TypeError('Review target enumerator must return a finite array');
  const targets = all.filter((target) => targetInScopes(target, scopes));
  return stageDreamReviewSnapshot({ guildId, day: request.day,
    snapshotAt: request.snapshotAt, targets, now });
}

async function cycleGuild(guildId, { request, now, readableChannels, publicChannelIds,
  permissionGeneration, assertCurrentScope, enumerateReviewTargets, ownerId }) {
  const status = dreamJobStatus(guildId, { detailed: false });
  if (!status.exists) return { guildId, idle: true, reason: 'not_started' };
  if (status.state !== 'running') return { guildId, paused: status.pauseReason ?? 'manual' };
  if (status.budget?.paused || status.budget?.remainingUsd <= 0) {
    return { guildId, paused: status.budget?.pauseReason ?? 'budget' };
  }

  updatePublicManifest({ guildId, publicChannelIds, readableChannels });
  const scopes = currentScopes(guildId, readableChannels, permissionGeneration);
  if (!scopes.length) return { guildId, waiting: 'permission', unavailable: true };
  const review = prepareReviewSnapshot(guildId, scopes, now, enumerateReviewTargets);
  const work = claimDreamWork({ guildId, now, eligibleScopes: scopes, ownerId });
  if (!work?.id) return { guildId, ...work,
    ...(review?.staged ? { reviewSnapshot: review } : {}) };

  let heartbeatError = null;
  const heartbeat = () => {
    if (heartbeatError) throw heartbeatError;
    try { return renewDreamWorkLease(work, Date.now()); }
    catch (error) { heartbeatError = error; throw error; }
  };
  const assertClaim = () => {
    if (heartbeatError) throw heartbeatError;
    assertDreamWorkClaim(work, Date.now());
    for (const channelId of work.scope.channelIds) {
      assertCurrentScope?.({ guildId, channelId, policyId: work.scope.policyId,
        permissionGeneration: work.scope.generation });
      const current = conversationWriterScope({ guildId, channelId });
      const legacyReviewScope = work.lane === 'review' && work.scope.kind === 'channel'
        && work.scope.policyId === `discord:${guildId}:${channelId}`;
      if (!legacyReviewScope && (current.policyId !== work.scope.policyId
        || String(current.generation) !== String(work.scope.generation)
        || JSON.stringify([...current.channelIds].map(String).sort())
          !== JSON.stringify([...work.scope.channelIds].map(String).sort()))) {
        throw Object.assign(new Error('Dream Writer scope generation changed'), {
          code: 'AGENT_CONTEXT_INVALIDATED'
        });
      }
    }
    return true;
  };
  const renewal = setInterval(() => {
    try { heartbeat(); } catch { /* The foreground freshness check reports the loss. */ }
  }, dreamConfig.heartbeatMs);
  renewal.unref();
  try {
    assertClaim();
    const result = await runDreamWriterBatch({ work, request,
      budgetId: status.budget.id, now, assertCurrentScope: assertClaim,
      assertCurrentClaim: assertClaim, heartbeat });
    assertClaim();
    if (result.completed) {
      const completed = completeDreamWork(work, result, now);
      return { guildId, stage: work.lane, completed: true, workId: work.id,
        writerBatchId: result.writerBatchId, usage: result.usage,
        sourceOutcomes: result.sourceOutcomes, ...completed };
    }
    if (result.continuation && !result.waiting) {
      const continued = continueDreamWork(work, result, now);
      return { guildId, stage: work.lane, continued: true, workId: work.id,
        continuation: continued.continuation, writerBatchId: result.writerBatchId,
        usage: result.usage };
    }
    if (result.waiting === 'sources' || result.waiting === 'index') {
      markDreamWorkWaiting(work, result, now);
      return { guildId, stage: work.lane, waiting: result.waiting,
        workId: work.id, writerBatchId: result.writerBatchId,
        continuation: result.continuation, usage: result.usage };
    }
    if (result.paused === 'another_writer') {
      markDreamWorkWaiting(work, { ...result, waiting: 'sources' }, now);
      return { guildId, stage: work.lane, waiting: 'writer_lease', workId: work.id };
    }
    pauseDreamJobForError(guildId, new Error(result.paused ?? 'Dream Writer paused'), now);
    return { guildId, stage: work.lane, ...result };
  } catch (error) {
    if (error.code === 'DREAM_WORK_FENCE_LOST') {
      return { guildId, stage: work.lane, lostClaim: true, workId: work.id };
    }
    if (error.code === 'DREAM_SOURCES_NOT_READY' || error.code === 'WRITER_SOURCES_PENDING') {
      markDreamWorkWaiting(work, { waiting: 'sources' }, now);
      return { guildId, stage: work.lane, waiting: 'sources', workId: work.id };
    }
    if (error.code === 'AGENT_CONTEXT_INVALIDATED'
      || error.code === 'STALE_ADMISSION_DECISION') {
      supersedeDreamWork(work, error, now);
      return { guildId, stage: work.lane, superseded: true, workId: work.id };
    }
    if (budgetErrors.has(error.code)) {
      pauseDreamJobForError(guildId, error, now);
      return { guildId, stage: work.lane, paused: error.code, workId: work.id };
    }
    if (error.code === 'DREAM_VALIDATION_FAILED') {
      const split = splitDreamWork(work, error, now);
      return { guildId, stage: work.lane, workId: work.id,
        ...(Array.isArray(split) ? { split: split.map((item) => item.id) }
          : { quarantined: true }) };
    }
    if (error.retryable === false) {
      quarantineDreamWork(work, error, now);
      return { guildId, stage: work.lane, quarantined: true, workId: work.id,
        error: String(error.message ?? error) };
    }
    const failed = failDreamWork(work, error, now);
    return { guildId, stage: work.lane, workId: work.id,
      retryAt: failed?.retryAt, quarantined: Boolean(failed?.quarantined),
      error: String(error.message ?? error) };
  } finally {
    clearInterval(renewal);
  }
}

export async function runDreamCycle({ guildId, guildIds, request = requestWriterModel,
  now = Date.now(), readableChannels, publicChannelIds, permissionGeneration,
  assertCurrentScope, enumerateReviewTargets = enumerateConversationReviewTargets,
  ownerId = workerOwner } = {}) {
  const allowed = guildId ? [String(guildId)] : guildIds;
  const running = listRunningDreamGuilds(allowed);
  if (!running.length) return { idle: true, reason: 'no_running_dream_jobs' };
  return cycleGuild(running[0], { request, now, readableChannels, publicChannelIds,
    permissionGeneration, assertCurrentScope, enumerateReviewTargets, ownerId });
}

async function workerLoop() {
  const guildIds = [...(workerData?.guildIds ?? [])];
  let readableChannels = workerData?.readableChannels ?? {};
  let publicChannelIds = workerData?.publicChannelIds;
  let permissionGeneration = workerData?.permissionGeneration ?? null;
  parentPort?.on('message', (message) => {
    if (Array.isArray(message.guildIds)) guildIds.splice(0, guildIds.length, ...message.guildIds);
    if (message.readableChannels && typeof message.readableChannels === 'object') {
      readableChannels = message.readableChannels;
    }
    if (message.publicChannelIds !== undefined) publicChannelIds = message.publicChannelIds;
    if (message.permissionGeneration !== undefined) permissionGeneration = message.permissionGeneration;
  });
  let nextLegacyAt = 0;
  for (;;) {
    try {
      const capturedGeneration = permissionGeneration;
      const capturedChannels = readableChannels;
      const capturedPublic = publicChannelIds;
      const assertCurrentScope = ({ guildId, channelId }) => {
        if (permissionGeneration !== capturedGeneration
          || !channelList(capturedChannels, guildId).includes(String(channelId))
          || !channelList(readableChannels, guildId).includes(String(channelId))) {
          throw Object.assign(new Error('Dream channel permission changed during execution'), {
            code: 'AGENT_CONTEXT_INVALIDATED'
          });
        }
      };
      const dreamed = await runDreamCycle({ guildIds, readableChannels: capturedChannels,
        publicChannelIds: capturedPublic, permissionGeneration: capturedGeneration,
        assertCurrentScope });
      if (!dreamed.idle || dreamed.blocked || dreamed.paused) {
        parentPort?.postMessage({ dream: dreamed });
      }
    } catch (error) {
      parentPort?.postMessage({ dreamError: String(error.message ?? error) });
    }
    const nonDream = guildIds.filter((id) => !dreamConfig.guildIds.includes(String(id)));
    if (nonDream.length && Date.now() >= nextLegacyAt) {
      try {
        const legacy = await runConversationWriter({ guildIds: nonDream, managed: true });
        if (legacy.retryAt) nextLegacyAt = legacy.retryAt;
        if (legacy.completedBatch || legacy.committedBatch) parentPort?.postMessage({ writer: legacy });
      } catch (error) {
        parentPort?.postMessage({ writerError: String(error.message ?? error),
          writer: writerStatus(nonDream) });
      }
    }
    await delay(1000);
  }
}

if (!isMainThread) await workerLoop();

export const dreamWorkerInternals = Object.freeze({
  channelList, currentScopes, targetInScopes, prepareReviewSnapshot
});
