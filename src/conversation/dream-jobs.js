import { createHash, randomUUID } from 'node:crypto';

import { db } from '../archive/db.js';
import { coverageReport } from '../archive/indexer.js';
import { ensureModelBudget, modelBudgetStatus, setModelBudgetPaused } from '../ai/cost.js';
import {
  admissionBasisHash,
  admissionFor,
  admissionStamp,
  applyDreamSourceOutcomes,
  ensureAdmissionSchema
} from './admission.js';
import { dreamConfig, isDreamGuild } from './dream-config.js';
import { conversationSourceHash } from './memory.js';
import { archiveEnvelope } from './message.js';
import { verifyDreamWriterCompletion } from './writer.js';

const processOwner = randomUUID();
const sourceTerminal = new Set([
  'completed', 'suppressed', 'compressed', 'deleted', 'superseded', 'quarantined'
]);
const workTerminal = new Set(['completed', 'quarantined', 'superseded', 'split']);
const claimableStatuses = new Set(['claimed', 'waiting_sources', 'waiting_index', 'retry']);
const lanes = Object.freeze(['initial', 'new', 'review']);
const terminalOutcomes = new Set(['incorporated', 'context_only', 'exact_duplicate']);
let schemaReady = false;

const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const placeholders = (values) => values.map(() => '?').join(',');
const parse = (value, fallback) => {
  try { return value == null ? fallback : JSON.parse(value); } catch { return fallback; }
};
const uniqueStrings = (values) => [...new Set((values ?? []).map(String).filter(Boolean))];
const rowOf = (messageId) => db.prepare('SELECT * FROM messages WHERE message_id=?').get(messageId);
const generationKey = ({ messageId, generation }) => `${messageId}\0${Number(generation)}`;
const currentGenerationClause = `NOT EXISTS (
  SELECT 1 FROM dream_message_generations newer
  WHERE newer.guild_id=g.guild_id AND newer.message_id=g.message_id
    AND newer.generation>g.generation
)`;

function reviewWindow(now) {
  const shifted = new Date(now + 9 * 3600000);
  let day = shifted.toISOString().slice(0, 10);
  let at = Date.parse(`${day}T${String(dreamConfig.reviewHourJst).padStart(2, '0')}:00:00+09:00`);
  if (now < at) {
    day = new Date(shifted.getTime() - 86400000).toISOString().slice(0, 10);
    at = Date.parse(`${day}T${String(dreamConfig.reviewHourJst).padStart(2, '0')}:00:00+09:00`);
  }
  return { day, at, nextAt: at + 86400000 };
}

function columns(table) {
  return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name));
}

function addColumn(table, name, definition) {
  if (!columns(table).has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
}

function installGenerationTriggers() {
  db.exec(`
    DROP TRIGGER IF EXISTS dream_generation_insert;
    CREATE TRIGGER dream_generation_insert AFTER INSERT ON messages
      WHEN EXISTS(SELECT 1 FROM dream_channels
        WHERE guild_id=new.guild_id AND channel_id=new.channel_id)
    BEGIN
      INSERT INTO dream_message_generations(
        guild_id,message_id,generation,channel_id,created_at,queued_at,lane,disposition
      ) VALUES(
        new.guild_id,new.message_id,0,new.channel_id,new.created_at,
        unixepoch('subsec')*1000,'new',CASE WHEN new.deleted=1 THEN 'deleted' ELSE 'pending' END
      ) ON CONFLICT DO NOTHING;
    END;

    DROP TRIGGER IF EXISTS dream_generation_update;
    CREATE TRIGGER dream_generation_update AFTER UPDATE OF
      guild_id,channel_id,author_id,author_name,is_bot,content,extra,edited_at,
      reply_to,reaction_count,pinned,deleted,structure_json ON messages
      WHEN EXISTS(SELECT 1 FROM dream_message_generations
        WHERE guild_id=old.guild_id AND message_id=old.message_id)
        AND (old.guild_id IS NOT new.guild_id OR old.channel_id IS NOT new.channel_id
          OR old.author_id IS NOT new.author_id OR old.author_name IS NOT new.author_name
          OR old.is_bot IS NOT new.is_bot OR old.content IS NOT new.content
          OR old.extra IS NOT new.extra OR old.edited_at IS NOT new.edited_at
          OR old.reply_to IS NOT new.reply_to OR old.reaction_count IS NOT new.reaction_count
          OR old.pinned IS NOT new.pinned OR old.deleted IS NOT new.deleted
          OR json_remove(old.structure_json,'$.observedAt') IS NOT json_remove(new.structure_json,'$.observedAt'))
    BEGIN
      INSERT INTO dream_message_generations(
        guild_id,message_id,generation,channel_id,created_at,queued_at,lane,disposition
      ) VALUES(
        new.guild_id,new.message_id,
        COALESCE((SELECT max(generation)+1 FROM dream_message_generations
          WHERE guild_id=new.guild_id AND message_id=new.message_id),0),
        new.channel_id,new.created_at,unixepoch('subsec')*1000,
        COALESCE((SELECT CASE
          WHEN lane='initial' AND disposition NOT IN ('completed','suppressed','compressed','deleted')
            THEN 'initial' ELSE 'new' END
          FROM dream_message_generations WHERE guild_id=new.guild_id AND message_id=new.message_id
          ORDER BY generation DESC LIMIT 1),'new'),
        CASE WHEN new.deleted=1 THEN 'deleted' ELSE 'pending' END
      );
      UPDATE dream_message_generations SET disposition='superseded',batch_id=NULL,
        completed_at=unixepoch('subsec')*1000
        WHERE guild_id=new.guild_id AND message_id=new.message_id
          AND generation<(SELECT max(generation) FROM dream_message_generations
            WHERE guild_id=new.guild_id AND message_id=new.message_id)
          AND disposition NOT IN ('completed','suppressed','compressed','deleted','superseded');
    END;

    DROP TRIGGER IF EXISTS dream_generation_delete;
    CREATE TRIGGER dream_generation_delete AFTER DELETE ON messages
      WHEN EXISTS(SELECT 1 FROM dream_jobs WHERE guild_id=old.guild_id)
    BEGIN
      UPDATE dream_message_generations SET disposition='deleted',batch_id=NULL,
        completed_at=unixepoch('subsec')*1000
        WHERE guild_id=old.guild_id AND message_id=old.message_id
          AND generation=(SELECT max(generation) FROM dream_message_generations
            WHERE guild_id=old.guild_id AND message_id=old.message_id);
    END;
  `);
}

/** Install the v2 continuous scheduler without treating v1 batch reviews as semantic coverage. */
export function ensureDreamSchema() {
  if (schemaReady) return;
  ensureAdmissionSchema();
  db.transaction(() => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS dream_jobs (
        guild_id TEXT PRIMARY KEY,
        state TEXT NOT NULL CHECK(state IN ('running','paused')),
        phase TEXT NOT NULL CHECK(phase IN ('initial','continuous')),
        budget_id TEXT NOT NULL,
        budget_limit_usd REAL NOT NULL,
        coverage_json TEXT NOT NULL,
        frontier_at INTEGER NOT NULL,
        initial_complete INTEGER NOT NULL DEFAULT 0,
        historical_since_new INTEGER NOT NULL DEFAULT 0,
        sequence INTEGER NOT NULL DEFAULT 0,
        review_day TEXT,
        review_count INTEGER NOT NULL DEFAULT 0,
        pause_reason TEXT,
        last_error TEXT,
        started_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        scheduler_version INTEGER NOT NULL DEFAULT 2,
        next_lane TEXT NOT NULL DEFAULT 'initial'
      );
      CREATE TABLE IF NOT EXISTS dream_channels (
        guild_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        frontier_created_at INTEGER,
        frontier_message_id TEXT,
        cursor_created_at INTEGER,
        cursor_message_id TEXT,
        last_selected_sequence INTEGER NOT NULL DEFAULT 0,
        policy_id TEXT,
        scope_kind TEXT,
        permission_generation TEXT,
        PRIMARY KEY(guild_id,channel_id)
      );
      CREATE TABLE IF NOT EXISTS dream_message_generations (
        guild_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        generation INTEGER NOT NULL,
        admission_generation INTEGER,
        channel_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        queued_at INTEGER NOT NULL,
        lane TEXT NOT NULL CHECK(lane IN ('initial','new')),
        disposition TEXT NOT NULL CHECK(disposition IN (
          'pending','batched','completed','suppressed','compressed','deleted',
          'superseded','quarantined'
        )),
        batch_id TEXT,
        last_error TEXT,
        completed_at INTEGER,
        PRIMARY KEY(guild_id,message_id,generation)
      );
      CREATE TABLE IF NOT EXISTS dream_work (
        id TEXT PRIMARY KEY,
        guild_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        lane TEXT NOT NULL CHECK(lane IN ('initial','new','review')),
        status TEXT NOT NULL CHECK(status IN (
          'claimed','waiting_sources','waiting_index','retry','completed',
          'quarantined','superseded','split'
        )),
        targets_json TEXT NOT NULL,
        sources_json TEXT NOT NULL,
        review_batch_id TEXT,
        previous_fingerprint TEXT,
        review_fingerprint TEXT,
        writer_batch_id TEXT,
        attempts INTEGER NOT NULL DEFAULT 0,
        split_depth INTEGER NOT NULL DEFAULT 0,
        parent_id TEXT,
        available_at INTEGER NOT NULL DEFAULT 0,
        lease_owner TEXT,
        lease_until INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        completed_at INTEGER,
        scheduler_version INTEGER NOT NULL DEFAULT 2,
        commit_id TEXT,
        scope_json TEXT NOT NULL DEFAULT '{}',
        continuation_json TEXT,
        source_outcomes_json TEXT NOT NULL DEFAULT '[]',
        review_pass_id TEXT,
        review_target_key TEXT,
        review_target_json TEXT,
        lease_fence INTEGER NOT NULL DEFAULT 0,
        completion_key TEXT
      );
      CREATE TABLE IF NOT EXISTS dream_work_legacy_queue (
        work_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        generation INTEGER NOT NULL,
        PRIMARY KEY(work_id,message_id)
      );
      CREATE TABLE IF NOT EXISTS dream_legacy_promotions (
        guild_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        writer_generation INTEGER NOT NULL,
        dream_generation INTEGER NOT NULL,
        promoted_at INTEGER NOT NULL,
        PRIMARY KEY(guild_id,message_id,writer_generation)
      );
      CREATE TABLE IF NOT EXISTS dream_reviews (
        guild_id TEXT NOT NULL,
        batch_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        fingerprint TEXT,
        reviewed_at INTEGER,
        review_day TEXT,
        result TEXT,
        last_work_id TEXT,
        PRIMARY KEY(guild_id,batch_id)
      );
      CREATE TABLE IF NOT EXISTS dream_review_legacy_audit (
        source_kind TEXT NOT NULL,
        source_id TEXT NOT NULL,
        guild_id TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        migrated_at INTEGER NOT NULL,
        PRIMARY KEY(source_kind,source_id)
      );
      CREATE TABLE IF NOT EXISTS dream_review_passes (
        id TEXT PRIMARY KEY,
        guild_id TEXT NOT NULL,
        review_day TEXT NOT NULL,
        snapshot_at INTEGER NOT NULL,
        snapshot_fingerprint TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('active','completed','held')),
        target_count INTEGER NOT NULL DEFAULT 0,
        completed_count INTEGER NOT NULL DEFAULT 0,
        held_count INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        completed_at INTEGER,
        UNIQUE(guild_id,review_day)
      );
      CREATE TABLE IF NOT EXISTS dream_review_targets (
        pass_id TEXT NOT NULL,
        ordinal INTEGER NOT NULL,
        target_key TEXT NOT NULL,
        atom_id TEXT NOT NULL,
        atom_version TEXT NOT NULL,
        policy_id TEXT,
        channel_id TEXT,
        fingerprint TEXT NOT NULL,
        purpose TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('pending','claimed','completed','quarantined')),
        work_id TEXT,
        result TEXT,
        completed_at INTEGER,
        PRIMARY KEY(pass_id,target_key),
        UNIQUE(pass_id,ordinal)
      );
      CREATE TABLE IF NOT EXISTS dream_semantic_reviews (
        guild_id TEXT NOT NULL,
        target_key TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        purpose TEXT NOT NULL,
        reviewed_at INTEGER NOT NULL,
        result TEXT NOT NULL,
        last_work_id TEXT,
        PRIMARY KEY(guild_id,target_key)
      );
      CREATE TABLE IF NOT EXISTS dream_scheduler_migrations (
        version INTEGER PRIMARY KEY,
        applied_at INTEGER NOT NULL,
        detail_json TEXT NOT NULL
      );
    `);

    addColumn('dream_jobs', 'scheduler_version', 'INTEGER NOT NULL DEFAULT 1');
    addColumn('dream_jobs', 'next_lane', "TEXT NOT NULL DEFAULT 'initial'");
    addColumn('dream_channels', 'policy_id', 'TEXT');
    addColumn('dream_channels', 'scope_kind', 'TEXT');
    addColumn('dream_channels', 'permission_generation', 'TEXT');
    addColumn('dream_work', 'scheduler_version', 'INTEGER NOT NULL DEFAULT 1');
    addColumn('dream_work', 'commit_id', 'TEXT');
    addColumn('dream_work', 'scope_json', "TEXT NOT NULL DEFAULT '{}'");
    addColumn('dream_work', 'continuation_json', 'TEXT');
    addColumn('dream_work', 'source_outcomes_json', "TEXT NOT NULL DEFAULT '[]'");
    addColumn('dream_work', 'review_pass_id', 'TEXT');
    addColumn('dream_work', 'review_target_key', 'TEXT');
    addColumn('dream_work', 'review_target_json', 'TEXT');
    addColumn('dream_work', 'lease_fence', 'INTEGER NOT NULL DEFAULT 0');
    addColumn('dream_work', 'completion_key', 'TEXT');
    addColumn('dream_review_targets', 'policy_id', 'TEXT');

    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_dream_channel_turn
        ON dream_channels(guild_id,last_selected_sequence,channel_id);
      CREATE INDEX IF NOT EXISTS idx_dream_generation_ready
        ON dream_message_generations(guild_id,lane,disposition,queued_at,channel_id,created_at,message_id);
      CREATE INDEX IF NOT EXISTS idx_dream_generation_batch
        ON dream_message_generations(batch_id,disposition);
      CREATE INDEX IF NOT EXISTS idx_dream_generation_scope
        ON dream_message_generations(
          guild_id,channel_id,lane,disposition,queued_at,created_at,message_id,generation
        );
      CREATE INDEX IF NOT EXISTS idx_dream_work_ready
        ON dream_work(guild_id,lane,status,available_at,created_at);
      CREATE INDEX IF NOT EXISTS idx_dream_work_claim
        ON dream_work(guild_id,status,lease_until,available_at);
      CREATE INDEX IF NOT EXISTS idx_dream_work_legacy_message
        ON dream_work_legacy_queue(message_id,generation);
      CREATE INDEX IF NOT EXISTS idx_dream_legacy_promotion_generation
        ON dream_legacy_promotions(guild_id,message_id,dream_generation);
      CREATE INDEX IF NOT EXISTS idx_dream_legacy_ready
        ON memory_writer_pending(guild_id,queued_at,created_at,message_id);
      CREATE INDEX IF NOT EXISTS idx_dream_review_pass
        ON dream_review_passes(guild_id,status,review_day);
      CREATE INDEX IF NOT EXISTS idx_dream_review_target_ready
        ON dream_review_targets(pass_id,status,ordinal);
    `);

    const migrated = db.prepare('SELECT 1 FROM dream_scheduler_migrations WHERE version=?')
      .get(dreamConfig.schedulerVersion);
    if (!migrated) {
      const at = Date.now();
      const reviewRows = db.prepare('SELECT * FROM dream_reviews').all();
      const reviewWork = db.prepare("SELECT * FROM dream_work WHERE lane='review'").all();
      const audit = db.prepare(`INSERT OR IGNORE INTO dream_review_legacy_audit(
        source_kind,source_id,guild_id,payload_json,migrated_at
      ) VALUES(?,?,?,?,?)`);
      for (const row of reviewRows) audit.run('dream_reviews_v1',
        `${row.guild_id}:${row.batch_id}`, row.guild_id, JSON.stringify(row), at);
      for (const row of reviewWork) audit.run('dream_work_v1', row.id,
        row.guild_id, JSON.stringify(row), at);
      db.prepare(`UPDATE dream_work SET status='superseded',lease_owner=NULL,lease_until=0,
        last_error='scheduler_v2_review_identity_migration',completed_at=coalesce(completed_at,?),updated_at=?
        WHERE lane='review' AND scheduler_version<2 AND status NOT IN ('completed','quarantined','superseded','split')`)
        .run(at, at);
      db.prepare(`UPDATE dream_work SET scheduler_version=2,
        commit_id=coalesce(commit_id,id),scope_json=CASE WHEN scope_json IS NULL OR scope_json='{}'
          THEN json_object('policyId','discord:'||guild_id||':'||channel_id,
            'kind','channel','channelIds',json_array(channel_id),'generation','legacy',
            'anchorChannelId',channel_id) ELSE scope_json END`).run();
      db.prepare(`UPDATE dream_jobs SET scheduler_version=2,next_lane=CASE
        WHEN next_lane IN ('initial','new','review') THEN next_lane ELSE 'initial' END`).run();
      db.prepare(`INSERT INTO dream_scheduler_migrations(version,applied_at,detail_json)
        VALUES(?,?,?)`).run(dreamConfig.schedulerVersion, at, JSON.stringify({
        legacyReviewRows: reviewRows.length, legacyReviewWork: reviewWork.length,
        semanticCoverageImported: 0
      }));
    }
    installGenerationTriggers();
  }).immediate();
  schemaReady = true;
}

function configuredGuild(guildId) {
  const id = String(guildId ?? '').trim();
  if (!id) throw new Error('Dream operation requires --guild');
  if (!isDreamGuild(id)) throw new Error(`Dreaming is not enabled for guild ${id}`);
  return id;
}

function jobRow(guildId) {
  return db.prepare('SELECT * FROM dream_jobs WHERE guild_id=?').get(guildId) ?? null;
}

export function startDreamJob({ guildId, now = Date.now() } = {}) {
  ensureDreamSchema();
  const id = configuredGuild(guildId);
  if (jobRow(id)) return dreamJobStatus(id);
  const report = coverageReport(id);
  if (!report?.clean || !report?.verifiedFull) {
    throw Object.assign(new Error('Dream initial history requires verified full local archive coverage'), {
      code: 'DREAM_ARCHIVE_INCOMPLETE', coverage: report
    });
  }
  const verifiedChannelIds = uniqueStrings(report.verifiedChannelIds);
  if (!verifiedChannelIds.length) {
    throw Object.assign(new Error('Dream initial history has no verified retrievable channels'), {
      code: 'DREAM_ARCHIVE_INCOMPLETE', coverage: report
    });
  }
  const budgetId = `dream:${id}:v1`;
  ensureModelBudget({ id: budgetId, guildId: id, limitUsd: dreamConfig.maxUsd });
  db.transaction(() => {
    db.prepare(`INSERT INTO dream_jobs(
      guild_id,state,phase,budget_id,budget_limit_usd,coverage_json,frontier_at,
      started_at,updated_at,scheduler_version,next_lane
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(id, 'running', 'initial', budgetId,
      dreamConfig.maxUsd, JSON.stringify(report), now, now, now,
      dreamConfig.schedulerVersion, 'initial');
    const channelScope = placeholders(verifiedChannelIds);
    const channels = db.prepare(`SELECT c.channel_id,
      (SELECT created_at FROM messages m WHERE m.guild_id=? AND m.channel_id=c.channel_id
        AND m.deleted=0 ORDER BY created_at DESC,message_id DESC LIMIT 1) frontier_created_at,
      (SELECT message_id FROM messages m WHERE m.guild_id=? AND m.channel_id=c.channel_id
        AND m.deleted=0 ORDER BY created_at DESC,message_id DESC LIMIT 1) frontier_message_id
      FROM channels c WHERE c.guild_id=? AND c.channel_id IN (${channelScope})
      ORDER BY c.channel_id`).all(id, id, id, ...verifiedChannelIds);
    if (channels.length !== verifiedChannelIds.length) {
      throw new Error('Verified archive channel set changed before Dream frontier snapshot');
    }
    const addChannel = db.prepare(`INSERT INTO dream_channels(
      guild_id,channel_id,frontier_created_at,frontier_message_id
    ) VALUES(?,?,?,?)`);
    for (const channel of channels) addChannel.run(id, channel.channel_id,
      channel.frontier_created_at ?? null, channel.frontier_message_id ?? null);
    db.prepare(`INSERT INTO dream_message_generations(
      guild_id,message_id,generation,channel_id,created_at,queued_at,lane,disposition
    ) SELECT guild_id,message_id,0,channel_id,created_at,0,'initial','pending'
      FROM messages WHERE guild_id=? AND channel_id IN (${channelScope}) AND deleted=0
      ON CONFLICT DO NOTHING`).run(id, ...verifiedChannelIds);
  }).immediate();
  refreshInitialState(id, now);
  return dreamJobStatus(id);
}

export function pauseDreamJob(guildId, reason = 'manual') {
  ensureDreamSchema();
  const id = configuredGuild(guildId);
  const job = jobRow(id);
  if (!job) throw Object.assign(new Error(`Dream job not found for ${id}`), { code: 'DREAM_JOB_NOT_FOUND' });
  setModelBudgetPaused(job.budget_id, true);
  db.prepare(`UPDATE dream_jobs SET state='paused',pause_reason=?,updated_at=? WHERE guild_id=?`)
    .run(String(reason).slice(0, 240), Date.now(), id);
  return dreamJobStatus(id);
}

export function resumeDreamJob(guildId) {
  ensureDreamSchema();
  const id = configuredGuild(guildId);
  const job = jobRow(id);
  if (!job) throw Object.assign(new Error(`Dream job not found for ${id}`), { code: 'DREAM_JOB_NOT_FOUND' });
  setModelBudgetPaused(job.budget_id, false);
  db.prepare(`UPDATE dream_jobs SET state='running',pause_reason=NULL,last_error=NULL,updated_at=?
    WHERE guild_id=?`).run(Date.now(), id);
  return dreamJobStatus(id);
}

function currentCounts(guildId) {
  const rows = db.prepare(`SELECT lane,disposition,count(*) count
    FROM dream_message_generations g WHERE guild_id=? AND ${currentGenerationClause}
    GROUP BY lane,disposition`).all(guildId);
  const result = { initial: {}, new: {} };
  for (const row of rows) result[row.lane][row.disposition] = row.count;
  return result;
}

export function dreamJobStatus(guildId, { detailed = true } = {}) {
  ensureDreamSchema();
  const id = String(guildId ?? '').trim();
  if (!id) throw new Error('Dream status requires a guildId');
  const job = jobRow(id);
  if (!job) return { guildId: id, exists: false };
  let budget;
  try { budget = modelBudgetStatus(job.budget_id); }
  catch (error) { budget = { id: job.budget_id, error: String(error.message ?? error) }; }
  const summary = {
    guildId: id, exists: true, state: job.state, phase: job.phase,
    schedulerVersion: Number(job.scheduler_version), nextLane: job.next_lane,
    initialComplete: Boolean(job.initial_complete), frontierAt: job.frontier_at,
    budget, pauseReason: job.pause_reason, lastError: job.last_error,
    startedAt: job.started_at, updatedAt: job.updated_at
  };
  if (!detailed) return summary;
  const work = db.prepare(`SELECT status,count(*) count FROM dream_work WHERE guild_id=?
    GROUP BY status`).all(id);
  const activePass = db.prepare(`SELECT * FROM dream_review_passes WHERE guild_id=?
    ORDER BY review_day DESC LIMIT 1`).get(id);
  const reviews = db.prepare(`SELECT count(*) reviewed,max(reviewed_at) lastReviewedAt
    FROM dream_semantic_reviews WHERE guild_id=?`).get(id);
  const channels = db.prepare(`SELECT channel_id channelId,frontier_created_at frontierCreatedAt,
    frontier_message_id frontierMessageId,cursor_created_at cursorCreatedAt,
    cursor_message_id cursorMessageId,policy_id policyId,scope_kind scopeKind,
    permission_generation permissionGeneration FROM dream_channels WHERE guild_id=?
    ORDER BY channel_id`).all(id);
  const window = reviewWindow(Date.now());
  return { ...summary, coverage: parse(job.coverage_json, null),
    generations: currentCounts(id),
    work: Object.fromEntries(work.map((row) => [row.status, row.count])), channels,
    reviews: { ...reviews, day: activePass?.review_day ?? null,
      status: activePass?.status ?? null, countToday: activePass?.completed_count ?? 0,
      totalToday: activePass?.target_count ?? 0, heldToday: activePass?.held_count ?? 0,
      nextAt: activePass?.status === 'active' ? null
        : activePass?.review_day === window.day ? window.nextAt : window.at }
  };
}

export function listRunningDreamGuilds(guildIds) {
  ensureDreamSchema();
  const values = guildIds == null ? null : uniqueStrings(guildIds);
  if (values && !values.length) return [];
  const scope = values ? `AND guild_id IN (${placeholders(values)})` : '';
  return db.prepare(`SELECT guild_id FROM dream_jobs WHERE state='running' ${scope}
    ORDER BY updated_at,guild_id`).all(...(values ?? [])).map((row) => row.guild_id);
}

function latestGeneration(guildId, messageId) {
  return db.prepare(`SELECT * FROM dream_message_generations WHERE guild_id=? AND message_id=?
    ORDER BY generation DESC LIMIT 1`).get(guildId, messageId);
}

function reconcileAdmission(row, now) {
  const current = latestGeneration(row.guild_id, row.message_id);
  if (!current) return null;
  const admission = admissionFor(row);
  const desired = admission.state === 'retain' ? 'pending' : admission.state;
  if (current.admission_generation == null && current.disposition === 'pending') {
    db.prepare(`UPDATE dream_message_generations SET admission_generation=?,disposition=?,
      completed_at=CASE WHEN ? IN ('suppressed','compressed') THEN ? ELSE completed_at END
      WHERE guild_id=? AND message_id=? AND generation=?`).run(admission.generation,
      desired, desired, now, row.guild_id, row.message_id, current.generation);
    return { ...current, admission_generation: admission.generation, disposition: desired };
  }
  if (Number(current.admission_generation) === Number(admission.generation)) {
    if (['suppressed', 'compressed'].includes(current.disposition) && desired === 'pending') {
      db.prepare(`UPDATE dream_message_generations SET disposition='pending',queued_at=?,completed_at=NULL
        WHERE guild_id=? AND message_id=? AND generation=?`).run(now, row.guild_id,
        row.message_id, current.generation);
      return { ...current, disposition: 'pending' };
    }
    if (current.disposition === 'pending' && desired !== 'pending') {
      db.prepare(`UPDATE dream_message_generations SET disposition=?,completed_at=?
        WHERE guild_id=? AND message_id=? AND generation=?`).run(desired, now,
        row.guild_id, row.message_id, current.generation);
      return { ...current, disposition: desired };
    }
    return current;
  }
  if (current.disposition === 'pending' && !current.batch_id) {
    db.prepare(`UPDATE dream_message_generations SET admission_generation=?,disposition=?,
      completed_at=CASE WHEN ? IN ('suppressed','compressed') THEN ? ELSE NULL END
      WHERE guild_id=? AND message_id=? AND generation=?`).run(admission.generation,
      desired, desired, now, row.guild_id, row.message_id, current.generation);
    return { ...current, admission_generation: admission.generation, disposition: desired };
  }
  if (current.disposition === 'batched') return current;
  const lane = current.lane === 'initial' && !sourceTerminal.has(current.disposition) ? 'initial' : 'new';
  return db.transaction(() => {
    db.prepare(`UPDATE dream_message_generations SET disposition='superseded',batch_id=NULL,
      completed_at=? WHERE guild_id=? AND message_id=? AND generation=?`).run(now,
      row.guild_id, row.message_id, current.generation);
    const generation = Number(current.generation) + 1;
    db.prepare(`INSERT INTO dream_message_generations(
      guild_id,message_id,generation,admission_generation,channel_id,created_at,
      queued_at,lane,disposition,completed_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?)`).run(row.guild_id, row.message_id, generation,
      admission.generation, row.channel_id, row.created_at, now, lane, desired,
      desired === 'pending' ? null : now);
    return latestGeneration(row.guild_id, row.message_id);
  })();
}

function refreshInitialState(guildId, now) {
  const blocked = db.prepare(`SELECT 1 FROM dream_message_generations g
    WHERE guild_id=? AND lane='initial' AND ${currentGenerationClause}
      AND disposition IN ('pending','batched','quarantined') LIMIT 1`).get(guildId);
  const complete = !blocked;
  const phase = complete ? 'continuous' : 'initial';
  db.prepare(`UPDATE dream_jobs SET initial_complete=?,phase=?,updated_at=?
    WHERE guild_id=? AND (initial_complete<>? OR phase<>?)`).run(
    complete ? 1 : 0, phase, now, guildId, complete ? 1 : 0, phase);
  return complete;
}

function normalizeScope(scope, guildId) {
  if (!scope || typeof scope !== 'object') throw new TypeError('Dream scope is required');
  const policyId = String(scope.policyId ?? '').trim();
  const kind = scope.kind === 'public' ? 'public' : scope.kind === 'channel' ? 'channel' : null;
  const channelIds = uniqueStrings(scope.channelIds);
  const generation = String(scope.generation ?? '').trim();
  const anchorChannelId = String(scope.anchorChannelId ?? channelIds[0] ?? '').trim();
  if (!policyId || !kind || !generation || !channelIds.length || !channelIds.includes(anchorChannelId)) {
    throw new TypeError('Dream scope needs policyId, kind, generation, channelIds and anchorChannelId');
  }
  if (kind === 'channel' && channelIds.length !== 1) {
    throw new TypeError('Private/channel Dream scope must contain exactly one channel');
  }
  return { policyId, kind, channelIds: [...channelIds].sort(), generation,
    anchorChannelId, guildId: String(guildId), reviewOnly: Boolean(scope.reviewOnly) };
}

function normalizeScopes(guildId, eligibleScopes, allowedChannelIds) {
  if (eligibleScopes !== undefined) {
    const values = Array.isArray(eligibleScopes) ? eligibleScopes : [...eligibleScopes];
    const unique = new Map();
    for (const input of values) {
      const scope = normalizeScope(input, guildId);
      const key = `${scope.policyId}\0${scope.generation}`;
      const previous = unique.get(key);
      if (previous && JSON.stringify(previous.channelIds) !== JSON.stringify(scope.channelIds)) {
        throw new Error('A Dream policy generation has conflicting channel manifests');
      }
      unique.set(key, scope);
    }
    return [...unique.values()];
  }
  if (allowedChannelIds === undefined) return db.prepare(`SELECT channel_id FROM dream_channels
    WHERE guild_id=? ORDER BY channel_id`).all(guildId).map(({ channel_id: channelId }) =>
    normalizeScope({ policyId: `discord:${guildId}:${channelId}`, kind: 'channel',
      channelIds: [channelId], generation: 'legacy', anchorChannelId: channelId }, guildId));
  return uniqueStrings(allowedChannelIds).map((channelId) => normalizeScope({
    policyId: `discord:${guildId}:${channelId}`, kind: 'channel', channelIds: [channelId],
    generation: 'legacy', anchorChannelId: channelId
  }, guildId));
}

function syncScopeChannels(job, scopes, now) {
  const touch = db.prepare(`INSERT INTO dream_channels(
    guild_id,channel_id,frontier_created_at,frontier_message_id,policy_id,scope_kind,permission_generation
  ) VALUES(?,?,?,?,?,?,?) ON CONFLICT(guild_id,channel_id) DO UPDATE SET
    policy_id=excluded.policy_id,scope_kind=excluded.scope_kind,
    permission_generation=excluded.permission_generation`);
  for (const scope of scopes) {
    if (scope.reviewOnly) continue;
    for (const channelId of scope.channelIds) {
    const latest = db.prepare(`SELECT created_at,message_id FROM messages
      WHERE guild_id=? AND channel_id=? AND deleted=0 ORDER BY created_at DESC,message_id DESC LIMIT 1`)
      .get(job.guild_id, channelId);
    touch.run(job.guild_id, channelId, latest?.created_at ?? null, latest?.message_id ?? null,
      scope.policyId, scope.kind, scope.generation);
    // Channels created after the initial archive frontier are continuous input.
    // Older history is admitted only by a verified full-history start snapshot.
    db.prepare(`INSERT INTO dream_message_generations(
      guild_id,message_id,generation,channel_id,created_at,queued_at,lane,disposition
    ) SELECT guild_id,message_id,0,channel_id,created_at,?,'new','pending'
      FROM messages m WHERE guild_id=? AND channel_id=? AND deleted=0 AND created_at>?
        AND NOT EXISTS(SELECT 1 FROM dream_message_generations g
          WHERE g.guild_id=m.guild_id AND g.message_id=m.message_id)
      ON CONFLICT DO NOTHING`).run(now, job.guild_id, channelId, job.frontier_at);
    }
  }
}

// The legacy Writer queue can request a semantic refresh without changing the
// archive row. Bridge each exact queue generation into the Dream generation
// ledger once, so an unchanged source becomes claimable without creating a new
// generation on every scheduler poll.
function promoteLegacyWriterQueue(job, scopes, now, limit = 60) {
  const channelIds = uniqueStrings(scopes
    .filter((scope) => !scope.reviewOnly)
    .flatMap((scope) => scope.channelIds));
  if (!channelIds.length) return { inspected: 0, promoted: 0, created: 0 };
  const bounded = Math.max(1, Math.min(60, Number(limit) || 60));
  const markers = db.prepare(`SELECT p.* FROM memory_writer_pending p
    INDEXED BY idx_dream_legacy_ready
    JOIN messages m ON m.message_id=p.message_id
    WHERE p.guild_id=? AND p.retry_at<=?
      AND p.channel_id IN (${placeholders(channelIds)})
      AND m.guild_id=p.guild_id AND m.channel_id=p.channel_id AND m.deleted=0
      AND NOT EXISTS(
        SELECT 1 FROM dream_legacy_promotions x
        WHERE x.guild_id=p.guild_id AND x.message_id=p.message_id
          AND x.writer_generation=p.generation
      )
    ORDER BY p.queued_at,p.created_at,p.message_id LIMIT ?`)
    .all(job.guild_id, now, ...channelIds, bounded);
  const exactMarker = db.prepare(`SELECT * FROM memory_writer_pending
    WHERE guild_id=? AND message_id=? AND generation=?`);
  const insertGeneration = db.prepare(`INSERT INTO dream_message_generations(
    guild_id,message_id,generation,admission_generation,channel_id,created_at,
    queued_at,lane,disposition
  ) VALUES(?,?,?,NULL,?,?,?,'new','pending')`);
  const insertPromotion = db.prepare(`INSERT INTO dream_legacy_promotions(
    guild_id,message_id,writer_generation,dream_generation,promoted_at
  ) VALUES(?,?,?,?,?) ON CONFLICT DO NOTHING`);
  const capturedByWork = db.prepare(`SELECT generation FROM dream_work_legacy_queue
    WHERE work_id=? AND message_id=?`);
  let promoted = 0;
  let created = 0;
  for (const candidate of markers) {
    const marker = exactMarker.get(job.guild_id, candidate.message_id, candidate.generation);
    if (!marker || !channelIds.includes(String(marker.channel_id))) continue;
    let current = latestGeneration(job.guild_id, marker.message_id);
    if (!current) {
      insertGeneration.run(job.guild_id, marker.message_id, 0, marker.channel_id,
        marker.created_at, marker.queued_at);
      current = latestGeneration(job.guild_id, marker.message_id);
      created += 1;
    } else if (!['pending', 'batched', 'quarantined'].includes(current.disposition)) {
      insertGeneration.run(job.guild_id, marker.message_id, Number(current.generation) + 1,
        marker.channel_id, marker.created_at, marker.queued_at);
      current = latestGeneration(job.guild_id, marker.message_id);
      created += 1;
    }
    // insertWork is the inclusion boundary. A marker which arrived after the
    // batch was formed was never part of its model input, even when the archive
    // row itself is unchanged. Leave it unmapped until that batch settles so a
    // fresh Dream generation and work item must process it.
    if (current.disposition === 'batched' && current.batch_id) {
      const captured = capturedByWork.get(current.batch_id, marker.message_id);
      if (Number(captured?.generation) !== Number(marker.generation)) continue;
    }
    promoted += insertPromotion.run(job.guild_id, marker.message_id,
      marker.generation, current.generation, now).changes;
  }
  return { inspected: markers.length, promoted, created };
}

function scopeForChannels(scopes, channelIds) {
  const needed = new Set(channelIds.map(String));
  return scopes.find((scope) => [...needed].every((channelId) => scope.channelIds.includes(channelId))) ?? null;
}

function sameScope(left, right) {
  return Boolean(left && right && left.policyId === right.policyId
    && left.kind === right.kind && left.generation === right.generation
    && JSON.stringify(left.channelIds) === JSON.stringify(right.channelIds));
}

function laneOrder(nextLane) {
  const start = Math.max(0, lanes.indexOf(nextLane));
  return Array.from({ length: lanes.length }, (_, offset) => lanes[(start + offset) % lanes.length]);
}

function nextLane(lane) {
  return lanes[(lanes.indexOf(lane) + 1) % lanes.length];
}

function rotateLane(guildId, lane, now) {
  db.prepare('UPDATE dream_jobs SET next_lane=?,updated_at=? WHERE guild_id=?')
    .run(nextLane(lane), now, guildId);
}

function pendingTime(guildId, lane, scope, cutoff = Number.MAX_SAFE_INTEGER) {
  const ids = scope.channelIds;
  return db.prepare(`SELECT min(queued_at) at FROM dream_message_generations g
    WHERE guild_id=? AND lane=? AND disposition='pending' AND queued_at<=?
      AND channel_id IN (${placeholders(ids)}) AND ${currentGenerationClause}`)
    .get(guildId, lane, cutoff, ...ids)?.at ?? null;
}

function captureLegacyQueue(workId, { guildId, targets }) {
  if (!targets.length) return;
  const ids = uniqueStrings(targets.map((target) => target.messageId));
  if (!ids.length) return;
  const rows = db.prepare(`SELECT message_id,generation FROM memory_writer_pending
    WHERE guild_id=? AND message_id IN (${placeholders(ids)})`).all(guildId, ...ids);
  const insert = db.prepare(`INSERT INTO dream_work_legacy_queue(work_id,message_id,generation)
    VALUES(?,?,?) ON CONFLICT(work_id,message_id) DO NOTHING`);
  for (const row of rows) insert.run(workId, row.message_id, row.generation);
}

function currentCapturedLegacyQueue(workId) {
  return db.prepare(`SELECT q.message_id messageId,q.generation
    FROM dream_work_legacy_queue q
    JOIN memory_writer_pending p ON p.message_id=q.message_id AND p.generation=q.generation
    WHERE q.work_id=?`).all(workId);
}

// applyDreamSourceOutcomes updates admission inside the same IMMEDIATE
// completion transaction and can enqueue the source itself. If the captured
// token was still exact at transaction entry, advance it over only those local
// queue writes so the already-indexed replacement acknowledges its own side
// effects. A marker which was newer before completion is deliberately ignored.
function includeCompletionQueueWrites(workId, exactAtStart) {
  const update = db.prepare(`UPDATE dream_work_legacy_queue SET generation=?
    WHERE work_id=? AND message_id=? AND generation=?`);
  for (const token of exactAtStart) {
    const current = db.prepare(`SELECT generation FROM memory_writer_pending
      WHERE message_id=?`).get(token.messageId);
    if (current && Number(current.generation) !== Number(token.generation)) {
      update.run(current.generation, workId, token.messageId, token.generation);
    }
  }
}

function consumeCapturedLegacyQueue(workId) {
  const captured = db.prepare(`SELECT q.message_id,q.generation,w.guild_id
    FROM dream_work_legacy_queue q JOIN dream_work w ON w.id=q.work_id
    WHERE q.work_id=?`).all(workId);
  const remove = db.prepare(`DELETE FROM memory_writer_pending
    WHERE guild_id=? AND message_id=? AND generation=?`);
  const removePromotion = db.prepare(`DELETE FROM dream_legacy_promotions
    WHERE guild_id=? AND message_id=? AND writer_generation=?`);
  const removeAllPromotions = db.prepare(`DELETE FROM dream_legacy_promotions
    WHERE guild_id=? AND message_id=?
      AND NOT EXISTS(SELECT 1 FROM memory_writer_pending WHERE message_id=?)`);
  let removed = 0;
  for (const row of captured) {
    const changes = remove.run(row.guild_id, row.message_id, row.generation).changes;
    removed += changes;
    if (!changes) continue;
    removePromotion.run(row.guild_id, row.message_id, row.generation);
    removeAllPromotions.run(row.guild_id, row.message_id, row.message_id);
  }
  // A writer-refresh marker is the stale Atom barrier. Remove it only after
  // every still-live source of the related legacy batch has had its exact
  // queue generation acknowledged by a verified Dream completion.
  db.prepare(`DELETE FROM memory_projection_state
    WHERE key LIKE 'writer-refresh:%'
      AND substr(key,length('writer-refresh:')+1) IN (
        SELECT DISTINCT i.batch_id FROM memory_writer_inputs i
        JOIN dream_work_legacy_queue q ON q.message_id=i.message_id
        WHERE q.work_id=?
      )
      AND NOT EXISTS(
        SELECT 1 FROM memory_writer_inputs i
        JOIN messages m ON m.message_id=i.message_id AND m.deleted=0
        JOIN memory_writer_pending p ON p.message_id=i.message_id
        WHERE i.batch_id=substr(memory_projection_state.key,length('writer-refresh:')+1)
      )`).run(workId);
  return removed;
}

function selectSourceRows(job, scope, lane, cutoff, now) {
  const ids = scope.channelIds;
  const generations = db.prepare(`SELECT g.* FROM dream_message_generations g
    WHERE g.guild_id=? AND g.channel_id IN (${placeholders(ids)}) AND g.lane=?
      AND g.disposition='pending' AND g.queued_at<=? AND ${currentGenerationClause}
    ORDER BY g.created_at,g.message_id LIMIT 240`).all(job.guild_id, ...ids, lane, cutoff);
  const targets = [];
  const targetRows = [];
  let bytes = 0;
  for (const generation of generations) {
    const row = rowOf(generation.message_id);
    if (!row || row.deleted || row.guild_id !== job.guild_id
      || !scope.channelIds.includes(String(row.channel_id))) {
      db.prepare(`UPDATE dream_message_generations SET disposition='deleted',completed_at=?
        WHERE guild_id=? AND message_id=? AND generation=? AND disposition='pending'`)
        .run(now, job.guild_id, generation.message_id, generation.generation);
      continue;
    }
    const current = reconcileAdmission(row, now);
    if (!current || current.disposition !== 'pending') continue;
    const envelope = archiveEnvelope(row);
    const size = Buffer.byteLength(JSON.stringify(envelope));
    if (targets.length && (targets.length >= 60 || bytes + size > 60000)) break;
    const admission = admissionFor(row);
    targets.push({ messageId: row.message_id, generation: Number(current.generation),
      admissionGeneration: Number(admission.generation), channelId: row.channel_id,
      authorId: row.author_id, admissionStamp: admissionStamp(row),
      basisHash: admissionBasisHash(row), createdAt: row.created_at,
      queuedAt: Number(current.queued_at), sourceHash: conversationSourceHash(row) });
    targetRows.push(row);
    bytes += size;
  }
  if (!targets.length) return null;

  const sourceRows = [...targetRows];
  const seen = new Set(targetRows.map((row) => row.message_id));
  const addContext = (row) => {
    if (!row || row.deleted || row.guild_id !== job.guild_id
      || !scope.channelIds.includes(String(row.channel_id)) || seen.has(row.message_id)
      || admissionFor(row).state !== 'retain') return;
    const size = Buffer.byteLength(JSON.stringify(archiveEnvelope(row)));
    if (bytes + size > 60000) return;
    seen.add(row.message_id); sourceRows.push(row); bytes += size;
  };
  const first = targetRows[0];
  const prior = db.prepare(`SELECT * FROM messages WHERE guild_id=?
    AND channel_id IN (${placeholders(ids)}) AND deleted=0
    AND (created_at<? OR (created_at=? AND message_id<?))
    ORDER BY created_at DESC,message_id DESC LIMIT 6`).all(job.guild_id, ...ids,
    first.created_at, first.created_at, first.message_id).reverse();
  for (const row of prior) addContext(row);
  for (const row of targetRows) if (row.reply_to) addContext(rowOf(row.reply_to));
  sourceRows.sort((a, b) => a.created_at - b.created_at
    || a.message_id.localeCompare(b.message_id));
  return { targets, sources: sourceRows.map((row) => ({
    messageId: row.message_id, channelId: row.channel_id, hash: conversationSourceHash(row)
  })) };
}

function workIdentity({ guildId, lane, scope, targets, reviewPassId, reviewTargetKey,
  splitDepth = 0, parentId = null }) {
  return digest({ version: dreamConfig.schedulerVersion, guildId, lane,
    scope: [scope.policyId, scope.kind, scope.generation, scope.channelIds],
    targets: targets.map((target) => [target.messageId, target.generation,
      target.admissionGeneration, target.sourceHash, target.queuedAt]),
    reviewPassId, reviewTargetKey, splitDepth, parentId });
}

function insertWork({ guildId, lane, scope, targets = [], sources = [], reviewPassId = null,
  reviewTarget = null, splitDepth = 0, parentId = null, status = 'claimed', ownerId = null }, now) {
  const reviewTargetKey = reviewTarget?.targetKey ?? null;
  const id = workIdentity({ guildId, lane, scope, targets, reviewPassId,
    reviewTargetKey, splitDepth, parentId });
  const commitId = digest({ version: 2, workId: id, guildId, lane,
    targets: targets.map(({ messageId, generation }) => [messageId, generation]),
    reviewPassId, reviewTargetKey });
  const claimed = status === 'claimed';
  const result = db.prepare(`INSERT INTO dream_work(
    id,guild_id,channel_id,lane,status,targets_json,sources_json,
    split_depth,parent_id,available_at,lease_owner,lease_until,created_at,updated_at,
    scheduler_version,commit_id,scope_json,review_pass_id,review_target_key,
    review_target_json,lease_fence
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING`).run(
    id, guildId, scope.anchorChannelId, lane, status, JSON.stringify(targets),
    JSON.stringify(sources), splitDepth, parentId, now, claimed ? ownerId : null,
    claimed ? now + dreamConfig.leaseMs : 0, now, now, dreamConfig.schedulerVersion,
    commitId, JSON.stringify(scope), reviewPassId, reviewTargetKey,
    reviewTarget ? JSON.stringify(reviewTarget) : null, claimed ? 1 : 0);
  if (!result.changes) return loadDreamWork(id);
  captureLegacyQueue(id, { guildId, targets });
  for (const target of targets) db.prepare(`UPDATE dream_message_generations
    SET disposition='batched',batch_id=? WHERE guild_id=? AND message_id=?
      AND generation=? AND disposition='pending'`).run(id, guildId,
    target.messageId, target.generation);
  if (reviewPassId && reviewTargetKey) db.prepare(`UPDATE dream_review_targets
    SET status='claimed',work_id=? WHERE pass_id=? AND target_key=? AND status='pending'`)
    .run(id, reviewPassId, reviewTargetKey);
  const job = jobRow(guildId);
  const sequence = Number(job.sequence) + 1;
  db.prepare('UPDATE dream_jobs SET sequence=?,updated_at=? WHERE guild_id=?')
    .run(sequence, now, guildId);
  for (const channelId of uniqueStrings(targets.map((target) => target.channelId))) {
    db.prepare(`UPDATE dream_channels SET last_selected_sequence=?
      WHERE guild_id=? AND channel_id=?`).run(sequence, guildId, channelId);
  }
  return loadDreamWork(id);
}

function selectNewSourceWork(job, scope, lane, now, ownerId) {
  if (lane === 'review' || scope.reviewOnly) return null;
  const cutoff = lane === 'new' ? now - dreamConfig.quietMs : now;
  const pending = pendingTime(job.guild_id, lane, scope, cutoff);
  if (pending == null) return null;
  const selected = selectSourceRows(job, scope, lane, cutoff, now);
  if (!selected?.targets.length) return null;
  return insertWork({ guildId: job.guild_id, lane, scope, ...selected,
    status: 'claimed', ownerId }, now);
}

function normalizeReviewTarget(input) {
  if (!input || typeof input !== 'object') throw new TypeError('Review target must be an object');
  const atomId = String(input.atomId ?? '').trim();
  const version = String(input.version ?? input.revisionId ?? '').trim();
  const targetKey = String(input.targetKey ?? (atomId && version ? `${atomId}@${version}` : '')).trim();
  const fingerprint = String(input.fingerprint ?? '').trim();
  const purpose = String(input.purpose ?? '').trim();
  const channelId = input.channelId == null ? null : String(input.channelId);
  const policyId = String(input.policyId ?? input.payload?.scope?.policyId ?? '').trim() || null;
  if (!atomId || !version || !targetKey || !fingerprint || !purpose || !policyId) {
    throw new TypeError('Review target needs atomId, version, targetKey, fingerprint, purpose and policyId');
  }
  return { targetKey, atomId, version, fingerprint, purpose, policyId, channelId,
    payload: input.payload ?? input };
}

export function dreamReviewSnapshotRequest({ guildId, now = Date.now() } = {}) {
  ensureDreamSchema();
  const id = configuredGuild(guildId);
  const job = jobRow(id);
  if (!job) return { needed: false, reason: 'not_started' };
  const active = db.prepare(`SELECT * FROM dream_review_passes WHERE guild_id=?
    AND status IN ('active','held') ORDER BY review_day LIMIT 1`).get(id);
  if (active) return { needed: false, reason: active.status === 'held' ? 'held' : 'active',
    passId: active.id, day: active.review_day };
  if (!job.initial_complete) return { needed: false, reason: 'initial' };
  const window = reviewWindow(now);
  if (now < window.at) return { needed: false, reason: 'not_due', retryAt: window.at };
  const existing = db.prepare(`SELECT * FROM dream_review_passes
    WHERE guild_id=? AND review_day=?`).get(id, window.day);
  if (existing) return { needed: false, reason: existing.status, passId: existing.id,
    retryAt: window.nextAt };
  return { needed: true, guildId: id, day: window.day, snapshotAt: window.at };
}

function finishReviewPass(passId, now) {
  const counts = db.prepare(`SELECT count(*) total,
    sum(status='completed') completed,sum(status='quarantined') held
    FROM dream_review_targets WHERE pass_id=?`).get(passId);
  const total = Number(counts?.total ?? 0);
  const completed = Number(counts?.completed ?? 0);
  const held = Number(counts?.held ?? 0);
  const status = held ? 'held' : completed === total ? 'completed' : 'active';
  db.prepare(`UPDATE dream_review_passes SET status=?,target_count=?,completed_count=?,
    held_count=?,updated_at=?,completed_at=CASE WHEN ?='completed' THEN ? ELSE NULL END
    WHERE id=?`).run(status, total, completed, held, now, status, now, passId);
  return status;
}

/** Persist one finite 04:00 JST Atom-version snapshot. Replays never append targets. */
export function stageDreamReviewSnapshot({ guildId, day, snapshotAt, targets, now = Date.now() } = {}) {
  ensureDreamSchema();
  const id = configuredGuild(guildId);
  const requested = dreamReviewSnapshotRequest({ guildId: id, now });
  if (!requested.needed) {
    const pass = requested.passId ? db.prepare('SELECT * FROM dream_review_passes WHERE id=?')
      .get(requested.passId) : null;
    return { staged: false, ...requested, targetCount: pass?.target_count ?? 0 };
  }
  const expectedDay = day ?? requested.day;
  const expectedAt = Number(snapshotAt ?? requested.snapshotAt);
  if (expectedDay !== requested.day || expectedAt !== requested.snapshotAt) {
    throw Object.assign(new Error('Review snapshot window changed before persistence'), {
      code: 'AGENT_CONTEXT_INVALIDATED'
    });
  }
  if (!Array.isArray(targets)) throw new TypeError('Review snapshot targets must be an array');
  const normalized = targets.map(normalizeReviewTarget)
    .sort((a, b) => a.targetKey.localeCompare(b.targetKey));
  const keys = new Set();
  for (const target of normalized) {
    if (keys.has(target.targetKey)) throw new Error(`Duplicate review target ${target.targetKey}`);
    keys.add(target.targetKey);
  }
  const snapshotFingerprint = digest(normalized.map((target) => [target.targetKey,
    target.fingerprint, target.purpose]));
  const passId = digest({ version: 2, guildId: id, day: expectedDay,
    snapshotAt: expectedAt, snapshotFingerprint });
  return db.transaction(() => {
    const insert = db.prepare(`INSERT INTO dream_review_passes(
      id,guild_id,review_day,snapshot_at,snapshot_fingerprint,status,
      target_count,created_at,updated_at
    ) VALUES(?,?,?,?,?,'active',?,?,?) ON CONFLICT(guild_id,review_day) DO NOTHING`)
      .run(passId, id, expectedDay, expectedAt, snapshotFingerprint,
        normalized.length, now, now);
    const existing = db.prepare(`SELECT * FROM dream_review_passes
      WHERE guild_id=? AND review_day=?`).get(id, expectedDay);
    if (!insert.changes) {
      if (existing.snapshot_fingerprint !== snapshotFingerprint) {
        throw new Error('Review day already has a different immutable snapshot');
      }
      return { staged: false, passId: existing.id, day: expectedDay,
        targetCount: existing.target_count, status: existing.status };
    }
    const add = db.prepare(`INSERT INTO dream_review_targets(
      pass_id,ordinal,target_key,atom_id,atom_version,channel_id,fingerprint,
      policy_id,purpose,payload_json,status,result,completed_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    normalized.forEach((target, ordinal) => {
      const previous = db.prepare(`SELECT 1 FROM dream_semantic_reviews
        WHERE guild_id=? AND target_key=? AND fingerprint=? AND purpose=?`).get(
        id, target.targetKey, target.fingerprint, target.purpose);
      add.run(passId, ordinal, target.targetKey, target.atomId, target.version,
        target.channelId, target.fingerprint, target.policyId, target.purpose,
        JSON.stringify(target.payload), previous ? 'completed' : 'pending',
        previous ? 'stable_noop' : null, previous ? now : null);
    });
    const status = finishReviewPass(passId, now);
    return { staged: true, passId, day: expectedDay,
      targetCount: normalized.length, status };
  }).immediate();
}

function reviewCandidate(guildId, scope) {
  const ids = scope.channelIds;
  return db.prepare(`SELECT t.*,p.guild_id,p.review_day FROM dream_review_targets t
    JOIN dream_review_passes p ON p.id=t.pass_id
    WHERE p.guild_id=? AND p.status='active' AND t.status='pending'
      AND t.policy_id=?
      AND (t.channel_id IS NULL OR t.channel_id IN (${placeholders(ids)}))
    ORDER BY p.review_day,t.ordinal LIMIT 1`).get(guildId, scope.policyId, ...ids);
}

function selectNewReviewWork(job, scope, now, ownerId) {
  if (!job.initial_complete) return null;
  const target = reviewCandidate(job.guild_id, scope);
  if (!target) return null;
  const reviewTarget = { passId: target.pass_id, targetKey: target.target_key,
    atomId: target.atom_id, version: target.atom_version, fingerprint: target.fingerprint,
    purpose: target.purpose, payload: parse(target.payload_json, null) };
  return insertWork({ guildId: job.guild_id, lane: 'review', scope,
    reviewPassId: target.pass_id, reviewTarget, status: 'claimed', ownerId }, now);
}

function workScope(row) {
  return parse(row.scope_json, null);
}

function workChannels(row) {
  const scope = workScope(row);
  if (scope?.channelIds?.length) return uniqueStrings(scope.channelIds);
  const targets = parse(row.targets_json, []);
  return uniqueStrings([...targets.map((target) => target.channelId), row.channel_id]);
}

function claimError(message = 'Dream work claim is no longer current') {
  return Object.assign(new Error(message), { code: 'DREAM_WORK_FENCE_LOST', retryable: false });
}

function claimRow(row, ownerId, now) {
  const result = db.prepare(`UPDATE dream_work SET status='claimed',lease_owner=?,
    lease_until=?,lease_fence=lease_fence+1,updated_at=? WHERE id=? AND status=?
    AND (?<>'claimed' OR lease_until<=? OR lease_owner=?)`).run(ownerId,
    now + dreamConfig.leaseMs, now, row.id, row.status, row.status, now, ownerId);
  return result.changes ? loadDreamWork(row.id) : null;
}

function releaseStaleScope(row, claimed, now) {
  const result = db.prepare(`UPDATE dream_work SET status='superseded',last_error=?,
    lease_owner=NULL,lease_until=0,completed_at=?,updated_at=?
    WHERE id=? AND status='claimed' AND lease_owner=? AND lease_fence=?`)
    .run('scope_generation_changed', now, now, row.id,
      claimed.claim.owner, claimed.claim.fence);
  if (!result.changes) throw claimError();
  for (const target of claimed.targets) db.prepare(`UPDATE dream_message_generations
    SET disposition='pending',batch_id=NULL,queued_at=?,last_error='scope_generation_changed'
    WHERE guild_id=? AND message_id=? AND generation=? AND disposition='batched' AND batch_id=?`)
    .run(now, claimed.guildId, target.messageId, target.generation, claimed.id);
  if (claimed.reviewPassId && claimed.reviewTarget?.targetKey) db.prepare(`UPDATE dream_review_targets
    SET status='pending',work_id=NULL WHERE pass_id=? AND target_key=?
      AND status='claimed' AND work_id=?`).run(claimed.reviewPassId,
    claimed.reviewTarget.targetKey, claimed.id);
}

function claimExistingLane(job, lane, scopes, ownerId, now) {
  const rows = db.prepare(`SELECT * FROM dream_work WHERE guild_id=? AND lane=?
    AND status IN ('claimed','waiting_sources','waiting_index','retry')
    AND (status<>'retry' OR available_at<=?)
    AND (status<>'claimed' OR lease_until<=? OR lease_owner=?)
    ORDER BY CASE status WHEN 'waiting_index' THEN 0 WHEN 'waiting_sources' THEN 1
      WHEN 'retry' THEN 2 ELSE 3 END,created_at,id LIMIT 64`).all(job.guild_id,
      lane, now, now, ownerId);
  for (const row of rows) {
    const channels = workChannels(row);
    const persisted = workScope(row);
    const scope = scopes.find((candidate) => sameScope(persisted, candidate))
      ?? scopes.find((candidate) => candidate.policyId === persisted?.policyId
        && candidate.kind === persisted?.kind
        && channels.every((channelId) => candidate.channelIds.includes(String(channelId))))
      ?? (lane === 'review' ? null : scopeForChannels(scopes, channels));
    if (!scope) continue;
    const claimed = claimRow(row, ownerId, now);
    if (!claimed) continue;
    if (sameScope(claimed.scope, scope)) return claimed;
    releaseStaleScope(row, claimed, now);
  }
  return null;
}

function activeClaim(guildId, ownerId, now) {
  const row = db.prepare(`SELECT * FROM dream_work WHERE guild_id=? AND status='claimed'
    AND lease_until>? ORDER BY updated_at,id LIMIT 1`).get(guildId, now);
  if (!row) return null;
  if (row.lease_owner === ownerId) return loadDreamWork(row.id);
  return { waiting: 'lease', retryAt: row.lease_until, owner: row.lease_owner };
}

/** Atomically claim one bounded slice. A guild can have only one live Writer owner. */
export function claimDreamWork({ guildId, now = Date.now(), eligibleScopes,
  allowedChannelIds, ownerId = processOwner } = {}) {
  ensureDreamSchema();
  const id = configuredGuild(guildId);
  const owner = String(ownerId ?? '').trim();
  if (!owner) throw new TypeError('Dream claim requires a non-empty ownerId');
  return db.transaction(() => {
    let job = jobRow(id);
    if (!job) return { idle: true, reason: 'not_started' };
    if (job.state !== 'running') return { paused: job.pause_reason ?? 'manual' };
    const scopes = normalizeScopes(id, eligibleScopes, allowedChannelIds);
    if (!scopes.length) return { waiting: 'permission', unavailable: true };
    syncScopeChannels(job, scopes, now);
    promoteLegacyWriterQueue(job, scopes, now);
    const active = activeClaim(id, owner, now);
    if (active) return active;
    refreshInitialState(id, now);
    job = jobRow(id);
    for (const lane of laneOrder(job.next_lane)) {
      if (lane === 'review' && !job.initial_complete) continue;
      const existing = claimExistingLane(job, lane, scopes, owner, now);
      if (existing) return existing;
      for (const scope of scopes) {
        const created = lane === 'review'
          ? selectNewReviewWork(job, scope, now, owner)
          : selectNewSourceWork(job, scope, lane, now, owner);
        if (created) return created;
      }
    }
    refreshInitialState(id, now);
    job = jobRow(id);
    const quarantine = db.prepare(`SELECT 1 FROM dream_message_generations g
      WHERE guild_id=? AND disposition='quarantined' AND ${currentGenerationClause} LIMIT 1`).get(id);
    if (quarantine) return { blocked: 'quarantine', quarantined: true };
    const nextRetry = db.prepare(`SELECT min(available_at) at FROM dream_work
      WHERE guild_id=? AND status='retry'`).get(id)?.at;
    const quiet = db.prepare(`SELECT min(queued_at) at FROM dream_message_generations g
      WHERE guild_id=? AND lane='new' AND disposition='pending' AND ${currentGenerationClause}`)
      .get(id)?.at;
    if (nextRetry != null && nextRetry > now) return { waiting: 'retry', retryAt: nextRetry };
    if (quiet != null && quiet > now - dreamConfig.quietMs) {
      return { waiting: 'quiet', retryAt: quiet + dreamConfig.quietMs };
    }
    const pending = db.prepare(`SELECT channel_id FROM dream_message_generations g
      WHERE guild_id=? AND disposition IN ('pending','batched') AND ${currentGenerationClause}
      LIMIT 1`).get(id);
    if (pending && !scopes.some((scope) => scope.channelIds.includes(String(pending.channel_id)))) {
      return { waiting: 'permission', unavailable: true };
    }
    const request = dreamReviewSnapshotRequest({ guildId: id, now });
    if (request.needed) return { waiting: 'review_snapshot', reviewSnapshot: request };
    if (request.reason === 'held') return { blocked: 'review_quarantine', quarantined: true };
    return request.retryAt ? { idle: true, retryAt: request.retryAt } : { idle: true };
  }).immediate();
}

export function loadDreamWork(workId) {
  ensureDreamSchema();
  const row = db.prepare('SELECT * FROM dream_work WHERE id=?').get(workId);
  if (!row) return null;
  const targets = parse(row.targets_json, []);
  const sources = parse(row.sources_json, []);
  const scope = parse(row.scope_json, null) ?? {
    policyId: `discord:${row.guild_id}:${row.channel_id}`, kind: 'channel',
    channelIds: [row.channel_id], generation: 'legacy', anchorChannelId: row.channel_id
  };
  return {
    id: row.id, commitId: row.commit_id ?? row.id, guildId: row.guild_id,
    channelId: row.channel_id, lane: row.lane, status: row.status, scope,
    targets, sources, rows: sources.map((source) => rowOf(source.messageId)).filter(Boolean),
    continuation: parse(row.continuation_json, null),
    sourceOutcomes: parse(row.source_outcomes_json, []),
    reviewPassId: row.review_pass_id,
    reviewTarget: parse(row.review_target_json, null),
    reviewBatchId: row.review_batch_id,
    previousFingerprint: row.previous_fingerprint,
    reviewFingerprint: row.review_fingerprint,
    writerBatchId: row.writer_batch_id,
    attempts: Number(row.attempts), splitDepth: Number(row.split_depth),
    parentId: row.parent_id, availableAt: Number(row.available_at),
    completionKey: row.completion_key,
    claim: row.status === 'claimed' ? { owner: row.lease_owner,
      fence: Number(row.lease_fence), leaseUntil: Number(row.lease_until) } : null
  };
}

function claimOf(workOrId, supplied) {
  if (supplied?.owner && Number.isInteger(Number(supplied.fence))) return {
    owner: String(supplied.owner), fence: Number(supplied.fence)
  };
  if (workOrId && typeof workOrId === 'object' && workOrId.claim?.owner) return {
    owner: String(workOrId.claim.owner), fence: Number(workOrId.claim.fence)
  };
  throw claimError('Dream transition requires the owner and fencing token returned by claimDreamWork');
}

function idOfWork(workOrId) {
  return typeof workOrId === 'object' ? String(workOrId.id) : String(workOrId);
}

export function assertDreamWorkClaim(workOrId, now = Date.now(), suppliedClaim) {
  ensureDreamSchema();
  const id = idOfWork(workOrId);
  const claim = claimOf(workOrId, suppliedClaim);
  const row = db.prepare(`SELECT 1 FROM dream_work WHERE id=? AND status='claimed'
    AND lease_owner=? AND lease_fence=? AND lease_until>?`).get(id,
    claim.owner, claim.fence, now);
  if (!row) throw claimError();
  return true;
}

export function renewDreamWorkLease(workOrId, now = Date.now(), suppliedClaim) {
  ensureDreamSchema();
  const id = idOfWork(workOrId);
  const claim = claimOf(workOrId, suppliedClaim);
  const until = now + dreamConfig.leaseMs;
  const result = db.prepare(`UPDATE dream_work SET lease_until=?,updated_at=?
    WHERE id=? AND status='claimed' AND lease_owner=? AND lease_fence=? AND lease_until>?`)
    .run(until, now, id, claim.owner, claim.fence, now);
  if (!result.changes) throw claimError();
  if (typeof workOrId === 'object' && workOrId.claim) workOrId.claim.leaseUntil = until;
  return { owner: claim.owner, fence: claim.fence, leaseUntil: until };
}

function normalizeUnresolved(value) {
  const rows = Array.isArray(value?.unresolved) ? value.unresolved : [];
  return rows.map((item) => ({ messageId: String(item?.messageId ?? ''),
    generation: Number(item?.generation) }));
}

function mergeExecutionState(work, result, { requireComplete = false } = {}) {
  const targets = new Map(work.targets.map((target) => [generationKey(target), target]));
  const outcomes = new Map(work.sourceOutcomes.map((outcome) => [generationKey(outcome), outcome]));
  for (const outcome of result?.sourceOutcomes ?? []) {
    const normalized = { ...outcome, messageId: String(outcome?.messageId ?? ''),
      generation: Number(outcome?.generation), outcome: String(outcome?.outcome ?? '') };
    const key = generationKey(normalized);
    if (!targets.has(key) || !terminalOutcomes.has(normalized.outcome)) {
      throw Object.assign(new Error('Dream Writer returned an unknown source outcome'), {
        code: 'DREAM_VALIDATION_FAILED'
      });
    }
    if (normalized.outcome === 'incorporated'
      && (!Array.isArray(normalized.refs) || !normalized.refs.length)) {
      throw Object.assign(new Error('An incorporated source outcome needs an Atom reference'), {
        code: 'DREAM_VALIDATION_FAILED'
      });
    }
    const previous = outcomes.get(key);
    if (previous && digest(previous) !== digest(normalized)) {
      throw Object.assign(new Error('Dream Writer changed a persisted source outcome'), {
        code: 'DREAM_VALIDATION_FAILED'
      });
    }
    outcomes.set(key, normalized);
  }
  const continuation = result?.continuation === undefined ? work.continuation : result.continuation;
  const unresolved = normalizeUnresolved(continuation);
  const unresolvedKeys = new Set();
  for (const item of unresolved) {
    const key = generationKey(item);
    if (!targets.has(key) || outcomes.has(key) || unresolvedKeys.has(key)) {
      throw Object.assign(new Error('Dream continuation contains an invalid or resolved source'), {
        code: 'DREAM_VALIDATION_FAILED'
      });
    }
    unresolvedKeys.add(key);
  }
  if (continuation) {
    for (const key of targets.keys()) if (!outcomes.has(key) && !unresolvedKeys.has(key)) {
      throw Object.assign(new Error('Dream continuation omitted an issued source generation'), {
        code: 'DREAM_VALIDATION_FAILED'
      });
    }
  }
  if (requireComplete && (continuation || outcomes.size !== targets.size)) {
    throw Object.assign(new Error('Dream completion did not account for every source generation'), {
      code: 'DREAM_VALIDATION_FAILED'
    });
  }
  let sources = work.sources;
  if (Array.isArray(result?.sources)) {
    const seen = new Set();
    sources = result.sources.map((source) => {
      const messageId = String(source?.messageId ?? '');
      const hash = String(source?.hash ?? '');
      const row = rowOf(messageId);
      if (!messageId || !hash || seen.has(messageId) || !row
        || row.guild_id !== work.guildId || !work.scope.channelIds.includes(String(row.channel_id))) {
        throw Object.assign(new Error('Dream Writer returned an invalid source checkpoint'), {
          code: 'DREAM_VALIDATION_FAILED'
        });
      }
      seen.add(messageId);
      return { messageId, channelId: row.channel_id, hash };
    });
  }
  return { outcomes: [...outcomes.values()], continuation: continuation ?? null, sources };
}

function casUpdate(work, sql, params, now) {
  const result = db.prepare(`${sql} WHERE id=? AND status='claimed'
    AND lease_owner=? AND lease_fence=? AND lease_until>?`).run(...params,
    work.id, work.claim.owner, work.claim.fence, now);
  if (!result.changes) throw claimError();
}

/** Release a successful bounded slice while keeping its stable work/commit identity. */
export function continueDreamWork(workOrId, result = {}, now = Date.now(), suppliedClaim) {
  ensureDreamSchema();
  const id = idOfWork(workOrId);
  const work = loadDreamWork(id);
  if (!work) throw new Error(`Unknown Dream work ${id}`);
  work.claim = claimOf(workOrId, suppliedClaim);
  const state = mergeExecutionState(work, result);
  if (!state.continuation) throw new Error('continueDreamWork requires continuation state');
  db.transaction(() => {
    casUpdate(work, `UPDATE dream_work SET status='retry',available_at=?,attempts=0,
      continuation_json=?,source_outcomes_json=?,sources_json=?,
      writer_batch_id=NULL,review_fingerprint=coalesce(?,review_fingerprint),
      lease_owner=NULL,lease_until=0,last_error=NULL,updated_at=?`, [now,
      JSON.stringify(state.continuation), JSON.stringify(state.outcomes), JSON.stringify(state.sources),
      result.reviewFingerprint ?? null, now], now);
    rotateLane(work.guildId, work.lane, now);
  }).immediate();
  return loadDreamWork(id);
}

export function markDreamWorkWaiting(workOrId, result, now = Date.now(), suppliedClaim) {
  ensureDreamSchema();
  const id = idOfWork(workOrId);
  const work = loadDreamWork(id);
  if (!work) throw new Error(`Unknown Dream work ${id}`);
  work.claim = claimOf(workOrId, suppliedClaim);
  const state = mergeExecutionState(work, result ?? {});
  const status = result?.waiting === 'index' ? 'waiting_index' : 'waiting_sources';
  db.transaction(() => {
    casUpdate(work, `UPDATE dream_work SET status=?,continuation_json=?,
      source_outcomes_json=?,sources_json=?,writer_batch_id=coalesce(?,writer_batch_id),
      review_fingerprint=coalesce(?,review_fingerprint),lease_owner=NULL,lease_until=0,
      updated_at=?`, [status, state.continuation == null ? null : JSON.stringify(state.continuation),
      JSON.stringify(state.outcomes), JSON.stringify(state.sources), result?.writerBatchId ?? null,
      result?.reviewFingerprint ?? null, now], now);
    rotateLane(work.guildId, work.lane, now);
  }).immediate();
  return loadDreamWork(id);
}

function updateCursors(work) {
  const byChannel = new Map();
  for (const target of work.targets) {
    const previous = byChannel.get(target.channelId);
    if (!previous || target.createdAt > previous.createdAt
      || (target.createdAt === previous.createdAt && target.messageId > previous.messageId)) {
      byChannel.set(target.channelId, target);
    }
  }
  for (const target of byChannel.values()) db.prepare(`UPDATE dream_channels
    SET cursor_created_at=?,cursor_message_id=? WHERE guild_id=? AND channel_id=?`)
    .run(target.createdAt, target.messageId, work.guildId, target.channelId);
}

function verifyOutcomeAdmissions(work, outcomes) {
  const byKey = new Map(outcomes.map((outcome) => [generationKey(outcome), outcome]));
  for (const target of work.targets) {
    const outcome = byKey.get(generationKey(target));
    const row = rowOf(target.messageId);
    const generation = latestGeneration(work.guildId, target.messageId);
    if (!row || row.deleted || !generation || Number(generation.generation) !== Number(target.generation)
      || generation.disposition !== 'batched' || generation.batch_id !== work.id) {
      throw Object.assign(new Error('Dream source changed before coordinator acknowledgement'), {
        code: 'AGENT_CONTEXT_INVALIDATED'
      });
    }
    const admission = admissionFor(row);
    if (outcome.outcome === 'exact_duplicate') {
      if (admission.state !== 'compressed'
        || String(admission.representativeId ?? '') !== String(outcome.representativeId ?? '')) {
        throw Object.assign(new Error('Dream exact duplicate admission was not durably applied'), {
          code: 'AGENT_CONTEXT_INVALIDATED'
        });
      }
    } else if (admission.state !== 'retain') {
      throw Object.assign(new Error('Dream retained source admission was not durably applied'), {
        code: 'AGENT_CONTEXT_INVALIDATED'
      });
    }
  }
}

function recordSemanticReview(guildId, target, result, workId, now) {
  db.prepare(`INSERT INTO dream_semantic_reviews(
    guild_id,target_key,fingerprint,purpose,reviewed_at,result,last_work_id
  ) VALUES(?,?,?,?,?,?,?) ON CONFLICT(guild_id,target_key) DO UPDATE SET
    fingerprint=excluded.fingerprint,purpose=excluded.purpose,
    reviewed_at=excluded.reviewed_at,result=excluded.result,last_work_id=excluded.last_work_id`)
    .run(guildId, target.target_key, target.fingerprint, target.purpose,
      now, result, workId);
}

function completeReviewTargets(work, result, now) {
  if (!work.reviewPassId || !work.reviewTarget) throw new Error('Review work has no Atom-version target');
  const review = result.reviewOutcome;
  if (!review || review.targetKey !== work.reviewTarget.targetKey
    || review.fingerprint !== work.reviewTarget.fingerprint) {
    throw Object.assign(new Error('Review completion does not match its Atom-version snapshot'), {
      code: 'DREAM_VALIDATION_FAILED'
    });
  }
  const accounted = [{ targetKey: review.targetKey, fingerprint: review.fingerprint },
    ...(review.visitedRefs ?? []).filter((item) => item?.accounted === true)
      .map((item) => ({ targetKey: String(item.targetKey ?? ''),
        fingerprint: String(item.fingerprint ?? '') }))];
  const seen = new Set();
  for (const item of accounted) {
    if (!item.targetKey || seen.has(item.targetKey)) continue;
    seen.add(item.targetKey);
    const target = db.prepare(`SELECT * FROM dream_review_targets
      WHERE pass_id=? AND target_key=? AND fingerprint=?`).get(work.reviewPassId,
      item.targetKey, item.fingerprint);
    if (!target) throw Object.assign(new Error('Reviewed related reference was not in this finite snapshot'), {
      code: 'DREAM_VALIDATION_FAILED'
    });
    const changed = db.prepare(`UPDATE dream_review_targets SET status='completed',
      result=?,completed_at=? WHERE pass_id=? AND target_key=?
      AND status IN ('pending','claimed')`).run(item.targetKey === review.targetKey
      ? (review.stableNoop ? 'stable_noop' : 'reviewed') : 'related_accounted',
      now, work.reviewPassId, item.targetKey);
    if (changed.changes) recordSemanticReview(work.guildId, target,
      item.targetKey === review.targetKey ? (review.stableNoop ? 'stable_noop' : 'reviewed')
        : 'related_accounted', work.id, now);
  }
  finishReviewPass(work.reviewPassId, now);
}

export function completeDreamWork(workOrId, result = {}, now = Date.now(), suppliedClaim) {
  ensureDreamSchema();
  const id = idOfWork(workOrId);
  let work = loadDreamWork(id);
  if (!work) throw new Error(`Unknown Dream work ${id}`);
  const claim = claimOf(workOrId, suppliedClaim);
  const completionKey = String(result.operationId ?? result.writerBatchId
    ?? digest({ sourceOutcomes: result.sourceOutcomes, reviewOutcome: result.reviewOutcome }));
  if (work.status === 'completed') {
    if (work.completionKey === completionKey) return dreamJobStatus(work.guildId, { detailed: false });
    throw claimError('Dream work already completed with another operation');
  }
  work.claim = claim;
  const state = mergeExecutionState(work, result, { requireComplete: work.lane !== 'review' });
  const verification = verifyDreamWriterCompletion(work, result);
  const finalSources = Array.isArray(verification?.sources)
    ? verification.sources.map((source) => ({ ...source })) : state.sources;
  db.transaction(() => {
    assertDreamWorkClaim(work, now, work.claim);
    const exactLegacyQueue = currentCapturedLegacyQueue(work.id);
    if (work.lane !== 'review') {
      applyDreamSourceOutcomes({ guildId: work.guildId, workId: work.id,
        scope: work.scope, targets: work.targets,
        sources: finalSources, outcomes: state.outcomes });
      verifyOutcomeAdmissions(work, state.outcomes);
      includeCompletionQueueWrites(work.id, exactLegacyQueue);
    }
    const verified = new Map(finalSources
      .map((source) => [String(source.messageId), source]));
    for (const source of finalSources) {
      const row = rowOf(source.messageId);
      if (!row || row.deleted || row.guild_id !== work.guildId
        || !work.scope.channelIds.includes(String(row.channel_id))
        || conversationSourceHash(row) !== String(source.hash)
        || (verified.has(source.messageId)
          && String(verified.get(source.messageId).hash) !== String(source.hash))) {
        throw Object.assign(new Error('Dream dependency changed before coordinator acknowledgement'), {
          code: 'AGENT_CONTEXT_INVALIDATED'
        });
      }
    }
    casUpdate(work, `UPDATE dream_work SET status='completed',completion_key=?,
      continuation_json=NULL,source_outcomes_json=?,sources_json=?,
      writer_batch_id=coalesce(?,writer_batch_id),review_fingerprint=coalesce(?,review_fingerprint),
      lease_owner=NULL,lease_until=0,completed_at=?,updated_at=?`, [completionKey,
      JSON.stringify(state.outcomes), JSON.stringify(finalSources),
      result.writerBatchId ?? null, result.reviewFingerprint ?? null, now, now], now);
    for (const target of work.targets) db.prepare(`UPDATE dream_message_generations
      SET disposition='completed',batch_id=?,completed_at=?,last_error=NULL
      WHERE guild_id=? AND message_id=? AND generation=?
      AND disposition='batched' AND batch_id=?`).run(work.id, now, work.guildId,
      target.messageId, target.generation, work.id);
    consumeCapturedLegacyQueue(work.id);
    updateCursors(work);
    if (work.lane === 'review') completeReviewTargets(work, result, now);
    rotateLane(work.guildId, work.lane, now);
    refreshInitialState(work.guildId, now);
  }).immediate();
  return dreamJobStatus(work.guildId, { detailed: false });
}

function resetWorkTargets(work, message, now) {
  for (const target of work.targets) db.prepare(`UPDATE dream_message_generations
    SET disposition='pending',batch_id=NULL,queued_at=?,last_error=?
    WHERE guild_id=? AND message_id=? AND generation=?
      AND disposition='batched' AND batch_id=?`).run(now, message,
    work.guildId, target.messageId, target.generation, work.id);
  if (work.reviewPassId && work.reviewTarget?.targetKey) db.prepare(`UPDATE dream_review_targets
    SET status='pending',work_id=NULL WHERE pass_id=? AND target_key=?
      AND status='claimed' AND work_id=?`).run(work.reviewPassId,
    work.reviewTarget.targetKey, work.id);
}

export function supersedeDreamWork(workOrId, error, now = Date.now(), suppliedClaim) {
  ensureDreamSchema();
  const id = idOfWork(workOrId);
  const work = loadDreamWork(id);
  if (!work) return null;
  if (work.status === 'superseded') return dreamJobStatus(work.guildId, { detailed: false });
  work.claim = claimOf(workOrId, suppliedClaim);
  const message = String(error?.message ?? error ?? 'source_changed').slice(0, 500);
  db.transaction(() => {
    casUpdate(work, `UPDATE dream_work SET status='superseded',last_error=?,
      lease_owner=NULL,lease_until=0,completed_at=?,updated_at=?`, [message, now, now], now);
    resetWorkTargets(work, message, now);
    rotateLane(work.guildId, work.lane, now);
  }).immediate();
  return dreamJobStatus(work.guildId, { detailed: false });
}

function quarantineClaimed(work, error, now) {
  const message = String(error?.message ?? error ?? 'quarantined').slice(0, 500);
  casUpdate(work, `UPDATE dream_work SET status='quarantined',attempts=attempts+1,
    last_error=?,lease_owner=NULL,lease_until=0,completed_at=?,updated_at=?`,
  [message, now, now], now);
  for (const target of work.targets) db.prepare(`UPDATE dream_message_generations
    SET disposition='quarantined',last_error=?,completed_at=?
    WHERE guild_id=? AND message_id=? AND generation=?
      AND disposition='batched' AND batch_id=?`).run(message, now, work.guildId,
    target.messageId, target.generation, work.id);
  if (work.reviewPassId && work.reviewTarget?.targetKey) {
    db.prepare(`UPDATE dream_review_targets SET status='quarantined',result=?,completed_at=?
      WHERE pass_id=? AND target_key=? AND status='claimed' AND work_id=?`).run(message,
      now, work.reviewPassId, work.reviewTarget.targetKey, work.id);
    finishReviewPass(work.reviewPassId, now);
  }
  db.prepare('UPDATE dream_jobs SET last_error=?,updated_at=? WHERE guild_id=?')
    .run(message, now, work.guildId);
  rotateLane(work.guildId, work.lane, now);
  refreshInitialState(work.guildId, now);
}

export function failDreamWork(workOrId, error, now = Date.now(), suppliedClaim) {
  ensureDreamSchema();
  const id = idOfWork(workOrId);
  const work = loadDreamWork(id);
  if (!work) return null;
  work.claim = claimOf(workOrId, suppliedClaim);
  const attempts = work.attempts + 1;
  if (attempts >= dreamConfig.maximumFailures) {
    db.transaction(() => quarantineClaimed(work, error, now)).immediate();
    return { quarantined: true, attempts, work: loadDreamWork(id) };
  }
  const retryAt = now + Math.min(3600000, 30000 * 2 ** (attempts - 1));
  const message = String(error?.message ?? error).slice(0, 500);
  db.transaction(() => {
    casUpdate(work, `UPDATE dream_work SET status='retry',attempts=?,available_at=?,
      last_error=?,lease_owner=NULL,lease_until=0,updated_at=?`,
    [attempts, retryAt, message, now], now);
    db.prepare('UPDATE dream_jobs SET last_error=?,updated_at=? WHERE guild_id=?')
      .run(message, now, work.guildId);
    rotateLane(work.guildId, work.lane, now);
  }).immediate();
  return { retryAt, attempts, work: loadDreamWork(id) };
}

export function quarantineDreamWork(workOrId, error, now = Date.now(), suppliedClaim) {
  ensureDreamSchema();
  const id = idOfWork(workOrId);
  const work = loadDreamWork(id);
  if (!work) return null;
  if (work.status === 'quarantined') return dreamJobStatus(work.guildId, { detailed: false });
  work.claim = claimOf(workOrId, suppliedClaim);
  db.transaction(() => quarantineClaimed(work, error, now)).immediate();
  return dreamJobStatus(work.guildId, { detailed: false });
}

export function splitDreamWork(workOrId, error, now = Date.now(), suppliedClaim) {
  ensureDreamSchema();
  const id = idOfWork(workOrId);
  const work = loadDreamWork(id);
  if (!work) return null;
  work.claim = claimOf(workOrId, suppliedClaim);
  if (work.splitDepth >= 1 || work.targets.length < 2 || work.lane === 'review'
    || work.sourceOutcomes.length) return quarantineDreamWork(work, error, now);
  const middle = Math.ceil(work.targets.length / 2);
  const halves = [work.targets.slice(0, middle), work.targets.slice(middle)];
  return db.transaction(() => {
    const message = String(error?.message ?? error).slice(0, 500);
    casUpdate(work, `UPDATE dream_work SET status='split',last_error=?,lease_owner=NULL,
      lease_until=0,completed_at=?,updated_at=?`, [message, now, now], now);
    const children = halves.map((targets, index) => insertWork({
      guildId: work.guildId, lane: work.lane, scope: work.scope, targets,
      sources: work.sources, splitDepth: work.splitDepth + 1,
      parentId: `${work.id}:${index}`, status: 'retry'
    }, now));
    for (const child of children) for (const target of child.targets) {
      db.prepare(`UPDATE dream_message_generations SET batch_id=? WHERE guild_id=?
        AND message_id=? AND generation=? AND disposition='batched' AND batch_id=?`)
        .run(child.id, work.guildId, target.messageId, target.generation, work.id);
    }
    rotateLane(work.guildId, work.lane, now);
    return children;
  }).immediate();
}

export function pauseDreamJobForError(guildId, error, now = Date.now()) {
  ensureDreamSchema();
  const message = String(error?.message ?? error).slice(0, 500);
  db.prepare(`UPDATE dream_jobs SET state='paused',pause_reason=?,last_error=?,updated_at=?
    WHERE guild_id=?`).run(error?.code ?? 'error', message, now, guildId);
  return dreamJobStatus(guildId, { detailed: false });
}

export const dreamJobInternals = Object.freeze({
  reviewWindow, normalizeScope, mergeExecutionState, processOwner,
  promoteLegacyWriterQueue, currentCapturedLegacyQueue,
  includeCompletionQueueWrites, consumeCapturedLegacyQueue
});
