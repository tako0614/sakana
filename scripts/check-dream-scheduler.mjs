import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isMainThread, parentPort, Worker, workerData } from 'node:worker_threads';

if (!isMainThread) {
  process.env.ARCHIVE_DB_PATH = workerData.archive;
  process.env.ATOM_MEMORY_PATH = workerData.atoms;
  process.env.AGENT_RUNTIME_PATH = workerData.runtime;
  process.env.MEMORY_DREAMING_ENABLED = 'true';
  process.env.MEMORY_DREAMING_GUILDS = workerData.guildId;
  process.env.MEMORY_EMBEDDINGS = 'false';
  try {
    const { claimDreamWork } = await import('../src/conversation/dream-jobs.js');
    const result = claimDreamWork({ guildId: workerData.guildId, now: workerData.now,
      eligibleScopes: workerData.scopes, ownerId: workerData.ownerId });
    parentPort.postMessage(result);
  } catch (error) {
    parentPort.postMessage({ workerError: String(error.message ?? error), code: error.code,
      stack: error.stack });
  }
} else {
  const directory = mkdtempSync(join(tmpdir(), 'sakana-dream-scheduler-'));
  const guildId = '1255359848644608035';
  const archive = join(directory, 'archive.sqlite');
  const atoms = join(directory, 'atoms.sqlite');
  const runtime = join(directory, 'runtime.sqlite');
  process.env.ARCHIVE_DB_PATH = archive;
  process.env.ATOM_MEMORY_PATH = atoms;
  process.env.AGENT_RUNTIME_PATH = runtime;
  process.env.MEMORY_DREAMING_ENABLED = 'true';
  process.env.MEMORY_DREAMING_GUILDS = guildId;
  process.env.MEMORY_EMBEDDINGS = 'false';

  const { db, msToSnowflake, recordSpan, saveMessage } = await import('../src/archive/db.js');
  const {
    claimDreamWork,
    continueDreamWork,
    dreamJobInternals,
    dreamReviewSnapshotRequest,
    ensureDreamSchema,
    failDreamWork,
    markDreamWorkWaiting,
    stageDreamReviewSnapshot,
    startDreamJob,
    supersedeDreamWork
  } = await import('../src/conversation/dream-jobs.js');
  const { dreamConfig } = await import('../src/conversation/dream-config.js');

  const startedAt = Date.parse('2026-09-12T00:00:00Z');
  const idAt = (at, offset = 0) => String(BigInt(msToSnowflake(at)) + BigInt(offset));
  const channelA = '1255359848644608101';
  const channelB = '1255359848644608102';
  const historicalA = idAt(startedAt - 5000, 1);
  const historicalB = idAt(startedAt - 4000, 2);
  const newMessage = idAt(startedAt + 1000, 3);
  const structure = JSON.stringify({ version: 1, reference: { kind: 'none', messageId: null },
    embeds: [], attachments: [], forwarded: [], mentions: [], pinned: false,
    observedAt: startedAt });
  const add = (id, channelId, createdAt, content) => saveMessage({
    message_id: id, guild_id: guildId, channel_id: channelId, parent_id: null,
    author_id: `human-${id}`, author_name: `Human ${id}`, is_bot: 0,
    content, extra: '', created_at: createdAt, edited_at: null, reply_to: null,
    attachment_count: 0, attachment_kinds: '', embed_count: 0, sticker_count: 0,
    link_count: 0, reaction_count: 0, char_count: content.length, pinned: 0,
    structure_json: structure, mentions: [], reactions: [], links: []
  });

  try {
    for (const channelId of [channelA, channelB]) db.prepare(`INSERT INTO channels(
      channel_id,guild_id,name,type,is_thread,is_private,complete,message_count,updated_at
    ) VALUES(?,?,?,0,0,0,1,0,?)`).run(channelId, guildId, channelId, startedAt);
    add(historicalA, channelA, startedAt - 5000, 'historical a');
    add(historicalB, channelB, startedAt - 4000, 'historical b');
    for (const channelId of [channelA, channelB]) {
      const rows = db.prepare(`SELECT message_id FROM messages WHERE channel_id=?
        ORDER BY created_at,message_id`).all(channelId);
      db.prepare(`UPDATE channels SET message_count=?,oldest_id=?,newest_id=? WHERE channel_id=?`)
        .run(rows.length, rows[0].message_id, rows.at(-1).message_id, channelId);
      recordSpan(channelId, rows[0].message_id, rows.at(-1).message_id);
    }
    ensureDreamSchema();
    db.prepare(`INSERT INTO memory_projection_state(key,value) VALUES(?,?)`).run(
      `archive-full-coverage:${guildId}`, JSON.stringify({ schema: 1, guildId,
        mode: 'full', startedAt: startedAt - 1000, finishedAt: startedAt,
        complete: true, channelIds: [channelA, channelB], skipped: [], errors: [] }));
    startDreamJob({ guildId, now: startedAt });
    add(newMessage, channelB, startedAt + 1000, 'new source');
    db.prepare(`UPDATE dream_message_generations SET queued_at=?
      WHERE message_id=? AND lane='new'`).run(startedAt + 1000, newMessage);

    const publicScope = { policyId: `discord:${guildId}:public`, kind: 'public',
      channelIds: [channelA, channelB], generation: 'permission-1',
      anchorChannelId: channelA };
    const workerOptions = (ownerId) => ({ workerData: { archive, atoms, runtime, guildId,
      now: startedAt + 70000, scopes: [publicScope], ownerId } });
    const race = (ownerId) => new Promise((resolve, reject) => {
      const worker = new Worker(new URL(import.meta.url), workerOptions(ownerId));
      worker.once('message', resolve); worker.once('error', reject);
    });
    const raced = await Promise.all([race('owner-a'), race('owner-b')]);
    const winners = raced.filter((value) => value?.id);
    const waiters = raced.filter((value) => value?.waiting === 'lease');
    assert.equal(winners.length, 1, JSON.stringify(raced));
    assert.equal(waiters.length, 1, 'only one independent DB handle may own the guild lease');
    const first = winners[0];
    assert.equal(first.scope.policyId, publicScope.policyId);
    assert.deepEqual(first.scope.channelIds, [channelA, channelB]);
    assert.deepEqual(first.targets.map((target) => target.messageId),
      [historicalA, historicalB]);
    assert.ok(first.commitId && first.claim.fence === 1);

    const reclaimedAt = first.claim.leaseUntil + 1;
    const reclaimed = claimDreamWork({ guildId, now: reclaimedAt,
      eligibleScopes: [publicScope], ownerId: 'owner-restart' });
    assert.equal(reclaimed.id, first.id, 'restart must reclaim the same stable work ID');
    assert.equal(reclaimed.commitId, first.commitId, 'restart must retain the stable Atom commit ID');
    assert.ok(reclaimed.claim.fence > first.claim.fence);
    for (const transition of [
      () => failDreamWork(first, new Error('stale fail'), reclaimedAt),
      () => markDreamWorkWaiting(first, { waiting: 'sources' }, reclaimedAt),
      () => supersedeDreamWork(first, new Error('stale supersede'), reclaimedAt)
    ]) assert.throws(transition, (error) => error.code === 'DREAM_WORK_FENCE_LOST');

    const unresolved = reclaimed.targets.map(({ messageId, generation }) => ({ messageId, generation }));
    db.prepare('UPDATE dream_work SET writer_batch_id=? WHERE id=?')
      .run('writer-checkpoint-from-previous-episode', reclaimed.id);
    continueDreamWork(reclaimed, { continuation: { sourceCursor: '2', nextAtom: 0, unresolved } },
      reclaimedAt + 1);
    assert.equal(db.prepare('SELECT writer_batch_id writerBatchId FROM dream_work WHERE id=?')
      .get(reclaimed.id).writerBatchId, null,
    'continuation must clear the prior Writer checkpoint before the next episode');
    const next = claimDreamWork({ guildId, now: reclaimedAt + 2 + dreamConfig.quietMs,
      eligibleScopes: [publicScope], ownerId: 'owner-next' });
    assert.equal(next.lane, 'new', 'new work must get the next slice without a 3:1 historical gate');
    assert.equal(next.targets[0].messageId, newMessage);
    continueDreamWork(next, { continuation: { sourceCursor: '1', nextAtom: 0,
      unresolved: next.targets.map(({ messageId, generation }) => ({ messageId, generation })) } },
    reclaimedAt + 3 + dreamConfig.quietMs);

    // Clear the source fixture so the review scheduler can be tested in isolation.
    db.prepare(`UPDATE dream_work SET status='superseded',lease_owner=NULL,lease_until=0
      WHERE status IN ('retry','waiting_sources','waiting_index','claimed')`).run();
    db.prepare(`UPDATE dream_message_generations SET disposition='completed',completed_at=?
      WHERE disposition IN ('pending','batched')`).run(reclaimedAt + 4);
    db.prepare('DELETE FROM memory_writer_pending').run();
    db.prepare(`UPDATE dream_jobs SET initial_complete=1,phase='continuous',next_lane='new'`).run();

    // insertWork is the source inclusion boundary. A stale Atom marker which
    // arrives after W is already batched must survive W and form W2.
    const refreshBatch = 'refresh-unchanged-source';
    const refreshKey = `writer-refresh:${refreshBatch}`;
    const refreshAt = reclaimedAt + dreamConfig.quietMs + 100;
    const refreshQueuedAt = refreshAt - dreamConfig.quietMs - 1;
    const beforeRefreshGeneration = db.prepare(`SELECT max(generation) generation
      FROM dream_message_generations WHERE guild_id=? AND message_id=?`)
      .get(guildId, historicalA).generation;
    db.prepare(`INSERT INTO dream_message_generations(
      guild_id,message_id,generation,channel_id,created_at,queued_at,lane,disposition
    ) VALUES(?,?,?,?,?,?,'new','pending')`).run(guildId, historicalA,
      beforeRefreshGeneration + 1, channelA, startedAt - 5000, refreshQueuedAt);
    const workBeforeMarker = claimDreamWork({ guildId, now: refreshAt,
      eligibleScopes: [publicScope], ownerId: 'pre-refresh-owner' });
    assert.equal(workBeforeMarker.targets[0].messageId, historicalA);
    assert.equal(db.prepare(`SELECT 1 FROM dream_work_legacy_queue
      WHERE work_id=? AND message_id=?`).get(workBeforeMarker.id, historicalA), undefined,
    'W must have no legacy token before the marker exists');

    // The marker arrives after W was formed (and may be after its model or Atom
    // commit). Polling must not retroactively add it to W.
    db.prepare('INSERT INTO memory_writer_inputs(batch_id,message_id) VALUES(?,?)')
      .run(refreshBatch, historicalA);
    db.prepare('INSERT INTO memory_projection_state(key,value) VALUES(?,?)')
      .run(refreshKey, String(refreshAt));
    db.prepare(`INSERT INTO memory_writer_pending(
      message_id,guild_id,channel_id,created_at,queued_at,generation
    ) VALUES(?,?,?,?,?,7)`).run(historicalA, guildId, channelA,
      startedAt - 5000, refreshQueuedAt);
    const generationCountDuringW = db.prepare(`SELECT count(*) n
      FROM dream_message_generations WHERE guild_id=? AND message_id=?`)
      .get(guildId, historicalA).n;
    const lateMarkerPoll = claimDreamWork({ guildId, now: refreshAt + 1,
      eligibleScopes: [publicScope], ownerId: 'pre-refresh-owner' });
    assert.equal(lateMarkerPoll.id, workBeforeMarker.id);
    assert.equal(db.prepare(`SELECT count(*) n FROM dream_message_generations
      WHERE guild_id=? AND message_id=?`).get(guildId, historicalA).n,
    generationCountDuringW, 'a late marker must not create a generation while W is batched');
    assert.equal(db.prepare(`SELECT 1 FROM dream_work_legacy_queue
      WHERE work_id=? AND message_id=?`).get(workBeforeMarker.id, historicalA), undefined,
    'polling must never attach a marker which missed insertWork');
    assert.equal(db.prepare(`SELECT 1 FROM dream_legacy_promotions
      WHERE guild_id=? AND message_id=? AND writer_generation=7`)
      .get(guildId, historicalA), undefined,
    'a late marker must remain eligible for promotion after W settles');
    assert.equal(dreamJobInternals.consumeCapturedLegacyQueue(workBeforeMarker.id), 0);
    assert.ok(db.prepare('SELECT 1 FROM memory_projection_state WHERE key=?').get(refreshKey),
      'W completion must leave a marker which was not in W');
    assert.ok(db.prepare('SELECT 1 FROM memory_writer_pending WHERE message_id=? AND generation=7')
      .get(historicalA), 'W completion must leave the exact late queue token');
    db.prepare(`UPDATE dream_work SET status='completed',lease_owner=NULL,lease_until=0,
      completed_at=?,updated_at=? WHERE id=?`).run(refreshAt + 2, refreshAt + 2,
      workBeforeMarker.id);
    db.prepare(`UPDATE dream_message_generations SET disposition='completed',completed_at=?
      WHERE guild_id=? AND message_id=? AND generation=?`).run(refreshAt + 2,
      guildId, historicalA, workBeforeMarker.targets[0].generation);

    const replacement = claimDreamWork({ guildId, now: refreshAt + 3,
      eligibleScopes: [publicScope], ownerId: 'refresh-replacement' });
    assert.equal(replacement.targets[0].messageId, historicalA);
    assert.equal(replacement.targets[0].generation, workBeforeMarker.targets[0].generation + 1,
      'the late marker must create a fresh Dream generation after W settles');
    const replacementGenerationCount = db.prepare(`SELECT count(*) n
      FROM dream_message_generations WHERE guild_id=? AND message_id=?`)
      .get(guildId, historicalA).n;
    assert.equal(claimDreamWork({ guildId, now: refreshAt + 4,
      eligibleScopes: [publicScope], ownerId: 'refresh-replacement' }).id, replacement.id);
    assert.equal(db.prepare(`SELECT count(*) n FROM dream_message_generations
      WHERE guild_id=? AND message_id=?`).get(guildId, historicalA).n,
    replacementGenerationCount, 'the promoted marker must remain idempotent on later polls');
    const exactAtCompletion = dreamJobInternals.currentCapturedLegacyQueue(replacement.id);
    assert.deepEqual(exactAtCompletion, [{ messageId: historicalA, generation: 7 }]);
    // This mirrors the local admission queue write inside completeDreamWork,
    // after the Writer checkpoint and replacement index have been verified.
    db.prepare(`UPDATE memory_writer_pending SET generation=8 WHERE message_id=? AND generation=7`)
      .run(historicalA);
    dreamJobInternals.includeCompletionQueueWrites(replacement.id, exactAtCompletion);
    assert.equal(dreamJobInternals.consumeCapturedLegacyQueue(replacement.id), 1);
    assert.equal(db.prepare('SELECT 1 FROM memory_writer_pending WHERE message_id=?')
      .get(historicalA), undefined);
    assert.equal(db.prepare('SELECT 1 FROM memory_projection_state WHERE key=?')
      .get(refreshKey), undefined,
    'the refresh barrier must clear only after W2 durably replaces the late token');
    db.prepare(`UPDATE dream_work SET status='completed',lease_owner=NULL,lease_until=0,
      completed_at=?,updated_at=? WHERE id=?`).run(refreshAt + 5, refreshAt + 5, replacement.id);
    db.prepare(`UPDATE dream_message_generations SET disposition='completed',completed_at=?
      WHERE guild_id=? AND message_id=? AND generation=?`).run(refreshAt + 5,
      guildId, historicalA, replacement.targets[0].generation);

    // The pre-existing exact CAS rule still protects a token which becomes
    // stale after it was captured by a work item.
    const staleBatch = 'refresh-newer-generation';
    const staleKey = `writer-refresh:${staleBatch}`;
    db.prepare('INSERT INTO memory_writer_inputs(batch_id,message_id) VALUES(?,?)')
      .run(staleBatch, historicalB);
    db.prepare('INSERT INTO memory_projection_state(key,value) VALUES(?,?)')
      .run(staleKey, String(refreshAt + 6));
    db.prepare(`INSERT INTO memory_writer_pending(
      message_id,guild_id,channel_id,created_at,queued_at,generation
    ) VALUES(?,?,?,?,?,11)`).run(historicalB, guildId, channelB,
      startedAt - 4000, refreshQueuedAt);
    const staleWork = claimDreamWork({ guildId, now: refreshAt + 6,
      eligibleScopes: [publicScope], ownerId: 'stale-refresh-owner' });
    assert.deepEqual(dreamJobInternals.currentCapturedLegacyQueue(staleWork.id),
      [{ messageId: historicalB, generation: 11 }]);
    db.prepare(`UPDATE memory_writer_pending SET generation=12
      WHERE message_id=? AND generation=11`).run(historicalB);
    assert.equal(dreamJobInternals.consumeCapturedLegacyQueue(staleWork.id), 0);
    assert.ok(db.prepare('SELECT 1 FROM memory_projection_state WHERE key=?').get(staleKey),
      'a captured stale token must not clear a newer queue generation');
    db.prepare(`UPDATE dream_work SET status='completed',lease_owner=NULL,lease_until=0,
      completed_at=?,updated_at=? WHERE id=?`).run(refreshAt + 7, refreshAt + 7, staleWork.id);
    db.prepare(`UPDATE dream_message_generations SET disposition='completed',completed_at=?
      WHERE guild_id=? AND message_id=? AND generation=?`).run(refreshAt + 7,
      guildId, historicalB, staleWork.targets[0].generation);
    const staleReplacement = claimDreamWork({ guildId, now: refreshAt + 8,
      eligibleScopes: [publicScope], ownerId: 'stale-refresh-replacement' });
    assert.deepEqual(dreamJobInternals.currentCapturedLegacyQueue(staleReplacement.id),
      [{ messageId: historicalB, generation: 12 }]);
    assert.equal(dreamJobInternals.consumeCapturedLegacyQueue(staleReplacement.id), 1);
    assert.equal(db.prepare('SELECT 1 FROM memory_projection_state WHERE key=?')
      .get(staleKey), undefined);
    db.prepare(`UPDATE dream_work SET status='completed',lease_owner=NULL,lease_until=0,
      completed_at=?,updated_at=? WHERE id=?`).run(refreshAt + 9, refreshAt + 9,
      staleReplacement.id);
    db.prepare(`UPDATE dream_message_generations SET disposition='completed',completed_at=?
      WHERE guild_id=? AND message_id=? AND generation=?`).run(refreshAt + 9,
      guildId, historicalB, staleReplacement.targets[0].generation);
    db.prepare(`UPDATE dream_jobs SET next_lane='review'`).run();

    const reviewAt = Date.parse('2026-09-13T04:00:00+09:00');
    const requested = dreamReviewSnapshotRequest({ guildId, now: reviewAt });
    assert.equal(requested.needed, true);
    const reviewTargets = [{
      targetKey: 'aaa-legacy@v1', atomId: 'aaa-legacy', version: 'v1',
      fingerprint: 'legacy-fingerprint', purpose: 'daily-review',
      policyId: `discord:${guildId}:${channelA}`, channelId: channelA,
      payload: { scope: { policyId: `discord:${guildId}:${channelA}` }, text: 'legacy atom' }
    }, ...Array.from({ length: 7 }, (_, index) => ({
      targetKey: `atom-${index}@v1`, atomId: `atom-${index}`, version: 'v1',
      fingerprint: `fingerprint-${index}`, purpose: 'daily-review',
      policyId: publicScope.policyId, channelId: channelA,
      payload: { scope: publicScope, text: `atom ${index}` }
    }))];
    const staged = stageDreamReviewSnapshot({ guildId, day: requested.day,
      snapshotAt: requested.snapshotAt, targets: reviewTargets, now: reviewAt });
    assert.equal(staged.targetCount, 8, 'the daily pass must not stop at four review targets');
    assert.equal(db.prepare(`SELECT count(*) n FROM dream_review_targets WHERE pass_id=?`)
      .get(staged.passId).n, 8);
    const sameDay = stageDreamReviewSnapshot({ guildId, day: requested.day,
      snapshotAt: requested.snapshotAt, targets: reviewTargets, now: reviewAt + 1 });
    assert.equal(sameDay.staged, false);
    assert.equal(db.prepare('SELECT count(*) n FROM dream_review_passes').get().n, 1,
      'snapshot replay must not duplicate a pass');

    const reviewWork = claimDreamWork({ guildId, now: reviewAt + 2,
      eligibleScopes: [publicScope], ownerId: 'review-owner' });
    assert.equal(reviewWork.lane, 'review');
    assert.equal(reviewWork.reviewTarget.targetKey, 'atom-0@v1');
    assert.equal(db.prepare(`SELECT status FROM dream_review_targets
      WHERE pass_id=? AND target_key='aaa-legacy@v1'`).get(staged.passId).status, 'pending',
    'a channel-policy Atom must not be claimed under the public policy');
    const tomorrow = reviewAt + 86400000;
    const unfinished = dreamReviewSnapshotRequest({ guildId, now: tomorrow });
    assert.equal(unfinished.reason, 'active', 'an unfinished prior pass must resume before a new day');
    assert.equal(unfinished.passId, staged.passId);

    // Failure retries preserve identity and quarantine the exact input on the third failure.
    let retry = reviewWork;
    let failureAt = reviewAt + 3;
    for (let attempt = 1; attempt <= dreamConfig.maximumFailures; attempt += 1) {
      const failed = failDreamWork(retry, new Error(`fixture failure ${attempt}`),
        failureAt);
      if (attempt < dreamConfig.maximumFailures) {
        retry = claimDreamWork({ guildId, now: failed.retryAt,
          eligibleScopes: [publicScope], ownerId: `review-retry-${attempt}` });
        assert.equal(retry.id, reviewWork.id);
        failureAt = failed.retryAt + 1;
      } else {
        assert.equal(failed.quarantined, true);
        assert.equal(db.prepare('SELECT status FROM dream_work WHERE id=?')
          .get(reviewWork.id).status, 'quarantined');
        assert.equal(db.prepare('SELECT status FROM dream_review_passes WHERE id=?')
          .get(staged.passId).status, 'held', 'quarantine must never look like completed coverage');
      }
    }

    // A previous semantic result skips only the exact same version/dependency fingerprint.
    db.prepare(`UPDATE dream_review_passes SET status='completed',completed_count=target_count,
      held_count=0,completed_at=? WHERE id=?`).run(tomorrow, staged.passId);
    db.prepare(`INSERT INTO dream_semantic_reviews(
      guild_id,target_key,fingerprint,purpose,reviewed_at,result,last_work_id
    ) VALUES(?,?,?,?,?,'reviewed','fixture')`).run(guildId, 'atom-0@v1',
      'fingerprint-0', 'daily-review', reviewAt);
    const dayTwo = dreamReviewSnapshotRequest({ guildId, now: tomorrow });
    assert.equal(dayTwo.needed, true);
    const changed = reviewTargets.map((target) => target.targetKey === 'atom-1@v1'
      ? { ...target, fingerprint: 'relationship-changed' } : target);
    const stagedTwo = stageDreamReviewSnapshot({ guildId, day: dayTwo.day,
      snapshotAt: dayTwo.snapshotAt, targets: changed, now: tomorrow });
    const exactNoop = db.prepare(`SELECT status,result FROM dream_review_targets
      WHERE pass_id=? AND target_key='atom-0@v1'`).get(stagedTwo.passId);
    assert.deepEqual(exactNoop, { status: 'completed', result: 'stable_noop' });
    const changedDependency = db.prepare(`SELECT status FROM dream_review_targets
      WHERE pass_id=? AND target_key='atom-1@v1'`).get(stagedTwo.passId);
    assert.equal(changedDependency.status, 'pending',
      'a relationship/source fingerprint change must be reviewed again');

    console.log('dream scheduler: atomic claim, fencing, restart identity, legacy refresh promotion/CAS, lane rotation, daily snapshots, no four-cap, no-op and quarantine passed');
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
}
