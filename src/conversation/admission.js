import { createHash } from 'node:crypto';

import { db } from '../archive/db.js';
import { archiveEnvelope } from './message.js';
import { dreamConfig, isDreamGuild } from './dream-config.js';

/**
 * Dream admission is deliberately a small, archive-owned index.  The archive
 * remains the source of truth: this table only records whether an archived
 * message is useful as an input to Dream and the generation at which that
 * decision was made.
 *
 * The public shapes in this file are consumed by the writer.  Keep the model
 * on the other side of this boundary: it receives a finite batch and returns
 * decisions, while this module checks identities, content stamps and guild
 * ownership before writing anything.
 */

const SCHEMA = 'sakana.dream.admission.v1';
const TABLE = 'dream_admissions';
const STATES = new Set(['retain', 'suppress', 'pending', 'compressed']);
const MAX_REASON = 500;
const DEFAULT_LIMIT = 60;
const DEFAULT_BYTES = 60_000;
const MAX_SCAN = 400;
const COALESCE_MS = 60_000;

let schemaReady = false;

const hash = (value) => createHash('sha256').update(String(value)).digest('hex');
const string = (value, fallback = '') => value == null ? fallback : String(value);
const idOf = (row) => string(row?.message_id ?? row?.messageId ?? row?.id, '');
const guildOf = (row) => string(row?.guild_id ?? row?.guildId ?? row?.location?.guildId, '');
const channelOf = (row) => string(row?.channel_id ?? row?.channelId ?? row?.location?.channelId, '');
const authorOf = (row) => string(row?.author_id ?? row?.authorId ?? row?.author?.id, '');
const createdOf = (row) => Number(row?.created_at ?? row?.createdAt ?? row?.timestamp ?? 0) || 0;
const botOf = (row) => Boolean(row?.is_bot ?? row?.isBot ?? row?.author?.bot);
const deletedOf = (row) => Boolean(row?.deleted ?? row?.state?.deleted);
const replyOf = (row) => string(row?.reply_to ?? row?.replyTo
  ?? row?.reference?.messageId ?? row?.structure?.reference?.messageId, '') || null;
const pinnedOf = (row) => Boolean(row?.pinned ?? row?.state?.pinned ?? row?.structure?.pinned);

function parseJson(value, fallback = null) {
  if (value && typeof value === 'object') return value;
  if (typeof value !== 'string' || !value) return fallback;
  try { return JSON.parse(value); } catch { return fallback; }
}

function structureOf(row) {
  const structure = parseJson(row?.structure_json, null) ?? parseJson(row?.structure, null);
  if (structure && typeof structure === 'object') return structure;
  // Normalized envelopes use these fields outside `structure`.  Keeping them
  // in the basis is what makes an embed-only or attachment-only message useful.
  return {
    version: 1,
    reference: { messageId: replyOf(row) },
    embeds: Array.isArray(row?.embeds) ? row.embeds : [],
    attachments: Array.isArray(row?.attachments) ? row.attachments : [],
    stickers: Array.isArray(row?.stickers) ? row.stickers : [],
    forwarded: Array.isArray(row?.forwarded) ? row.forwarded : [],
    mentions: Array.isArray(row?.mentions) ? row.mentions : [],
    pinned: pinnedOf(row)
  };
}

function bodyOf(row) {
  const body = row?.body && typeof row.body === 'object' ? row.body : null;
  return string(row?.content ?? body?.text, '');
}

function extraOf(row) {
  const body = row?.body && typeof row.body === 'object' ? row.body : null;
  const supplemental = row?.supplemental?.text ?? body?.supplemental?.text;
  if (row?.extra != null || body?.extra != null || supplemental != null) {
    return string(row?.extra ?? body?.extra ?? supplemental, '');
  }
  // Live normalized messages may not carry archive `extra` yet. Mirror the
  // archive's compact supplemental description so live and archived forms have
  // the same basis for embeds and attachments.
  const structure = parseJson(row?.structure_json, null) ?? parseJson(row?.structure, null) ?? {};
  const attachments = Array.isArray(row?.attachments) ? row.attachments : structure.attachments ?? [];
  const embeds = Array.isArray(row?.embeds) ? row.embeds : structure.embeds ?? [];
  const stickers = Array.isArray(row?.stickers) ? row.stickers : structure.stickers ?? [];
  const parts = [];
  for (const attachment of attachments) {
    const name = attachment?.name ?? attachment?.filename;
    const description = attachment?.description;
    if (name || description) parts.push(description ? `${name}: ${description}` : name);
  }
  for (const embed of embeds) {
    const head = [embed?.title, embed?.author?.name].filter(Boolean).join(' / ');
    const bodyText = [head, embed?.description].filter(Boolean).join(' — ');
    if (bodyText) parts.push(`[埋め込み] ${bodyText}`);
  }
  for (const sticker of stickers) if (sticker?.name) parts.push(`[スタンプ] ${sticker.name}`);
  return parts.filter(Boolean).join(' / ').slice(0, 120);
}

// JSON object key order is not part of the source contract. Canonicalizing it
// keeps stamps stable across discord.js versions and archive re-indexes.
function canonical(value) {
  if (value == null || typeof value === 'string' || typeof value === 'number'
    || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort()
      .filter((key) => key !== 'observedAt')
      .map((key) => [key, canonical(value[key])]));
  }
  return String(value);
}

/**
 * Content used for exact duplicate and stale-source checks.  IDs, timestamps
 * and observation time are intentionally absent: two identical notifications
 * are equivalent even when delivered at different times.  Full attachment,
 * embed and forwarding metadata stays in the basis, including when `content`
 * is empty.
 */
export function admissionBasis(row) {
  const structure = structureOf(row);
  const basis = {
    version: 1,
    content: bodyOf(row),
    extra: extraOf(row),
    structure,
    attachmentCount: Number(row?.attachment_count ?? row?.attachmentCount ?? structure.attachments?.length ?? 0) || 0,
    attachmentKinds: string(row?.attachment_kinds ?? row?.attachmentKinds, ''),
    embedCount: Number(row?.embed_count ?? row?.embedCount ?? structure.embeds?.length ?? 0) || 0,
    stickerCount: Number(row?.sticker_count ?? row?.stickerCount ?? structure.stickers?.length ?? 0) || 0,
    linkCount: Number(row?.link_count ?? row?.linkCount, 0) || 0
  };
  return canonical(basis);
}

export function admissionBasisHash(row) {
  return hash(JSON.stringify(admissionBasis(row)));
}

/**
 * Stable source stamp used in every issued target.  It changes when the
 * content or its structured payload changes, while an outcome change alone
 * does not make a model decision stale.  The outcome is stored separately in
 * the admission row and is included by the archive memory source hash.
 */
export function admissionStamp(row) {
  return `v1:${admissionBasisHash(row)}`;
}

function textMask(value) {
  return string(value)
    .replace(/\b\d{4}[-/.]\d{1,2}(?:[-/.]\d{1,2})?(?:[T ]\d{1,2}:\d{2}(?::\d{2})?)?\b/g, '<DATE>')
    .replace(/\b\d{1,2}:\d{2}(?::\d{2})?\b/g, '<TIME>')
    .replace(/(?<![A-Za-zＡ-Ｚａ-ｚ])\d+(?![A-Za-zＡ-Ｚａ-ｚ])/g, '<NUM>');
}

function maskFamily(value) {
  if (typeof value === 'string') return textMask(value);
  if (Array.isArray(value)) return value.map(maskFamily);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, maskFamily(value[key])]));
  }
  return value;
}

function familyHash(row) {
  const basis = admissionBasis(row);
  // Mask text only for grouping. Every original stamp remains in the target
  // list and must receive its own Ling decision.
  return hash(JSON.stringify(maskFamily(basis)));
}

function normalizeRow(row) {
  const messageId = idOf(row);
  return {
    messageId,
    guildId: guildOf(row),
    channelId: channelOf(row),
    authorId: authorOf(row),
    authorName: string(row?.author_name ?? row?.authorName ?? row?.author?.name, 'unknown'),
    isBot: botOf(row),
    content: bodyOf(row),
    extra: extraOf(row),
    createdAt: createdOf(row),
    editedAt: row?.edited_at ?? row?.editedAt ?? null,
    deleted: deletedOf(row),
    replyTo: replyOf(row),
    pinned: pinnedOf(row),
    structure: structureOf(row),
    basis: admissionBasis(row),
    basisHash: admissionBasisHash(row),
    stamp: admissionStamp(row),
    familyHash: familyHash(row),
    raw: row
  };
}

function sourceRowForAdmission(row, normalizedInput = normalizeRow(row)) {
  // Archive rows have the snake_case source fields. Live discord.js/format.js
  // messages can be partial (notably their supplemental URL/card text), so an
  // existing archive row is authoritative for admission state and stamps.
  if (row && Object.prototype.hasOwnProperty.call(row, 'message_id')) return row;
  if (!normalizedInput.messageId || !normalizedInput.guildId || !normalizedInput.channelId) return row;
  const archived = db.prepare('SELECT * FROM messages WHERE message_id=? AND guild_id=? AND channel_id=? LIMIT 1')
    .get(normalizedInput.messageId, normalizedInput.guildId, normalizedInput.channelId);
  return archived ?? row;
}

function rawEnvelope(row) {
  // archiveEnvelope is intentionally the shared citation envelope. Add the
  // unabridged `extra` field and parsed structure so an empty-body notification
  // is still inspectable by the selection model.
  const normalized = normalizeRow(row);
  let envelope;
  try {
    envelope = archiveEnvelope(row);
  } catch {
    envelope = {
      schema: 'discord.message.v1', id: normalized.messageId,
      location: { guildId: normalized.guildId, channelId: normalized.channelId },
      author: { id: normalized.authorId, name: normalized.authorName, bot: normalized.isBot },
      body: { text: normalized.content, complete: true, characters: normalized.content.length },
      reference: { messageId: normalized.replyTo },
      state: { createdAt: normalized.createdAt, editedAt: normalized.editedAt,
        deleted: normalized.deleted, pinned: normalized.pinned }
    };
  }
  return { ...envelope, extra: normalized.extra, structure: normalized.structure };
}

function now() { return Date.now(); }

export function ensureAdmissionSchema() {
  if (schemaReady) return;
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_projection_priority (message_id TEXT PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS ${TABLE} (
      message_id TEXT PRIMARY KEY,
      guild_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      author_id TEXT NOT NULL,
      is_bot INTEGER NOT NULL DEFAULT 0,
      basis_hash TEXT NOT NULL,
      stamp TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('retain','suppress','pending','compressed')),
      generation INTEGER NOT NULL DEFAULT 0,
      representative_id TEXT,
      reason TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_dream_admission_scope
      ON ${TABLE}(guild_id, state, created_at, message_id);
    CREATE INDEX IF NOT EXISTS idx_dream_admission_group
      ON ${TABLE}(guild_id, channel_id, author_id, basis_hash, created_at);
    CREATE INDEX IF NOT EXISTS idx_dream_admission_exact_representative
      ON ${TABLE}(guild_id, channel_id, author_id, basis_hash, state, created_at, message_id);
    CREATE INDEX IF NOT EXISTS idx_dream_admission_generation
      ON ${TABLE}(guild_id, generation, updated_at);
    CREATE INDEX IF NOT EXISTS idx_dream_messages_bot_scope
      ON messages(guild_id, is_bot, deleted, created_at, message_id);
    CREATE INDEX IF NOT EXISTS idx_dream_messages_reply_target
      ON messages(reply_to, guild_id, channel_id, is_bot, deleted, message_id);

    DROP TRIGGER IF EXISTS dream_admission_message_update;
    CREATE TRIGGER dream_admission_message_update
      AFTER UPDATE OF guild_id, channel_id, author_id, is_bot, content, extra,
        edited_at, reply_to, pinned, deleted, structure_json ON messages
      WHEN old.guild_id IS NOT new.guild_id OR old.channel_id IS NOT new.channel_id
        OR old.author_id IS NOT new.author_id OR old.is_bot IS NOT new.is_bot
        OR old.content IS NOT new.content OR old.extra IS NOT new.extra
        OR old.edited_at IS NOT new.edited_at OR old.reply_to IS NOT new.reply_to
        OR old.pinned IS NOT new.pinned OR old.deleted IS NOT new.deleted
        OR json_remove(old.structure_json, '$.observedAt') IS NOT json_remove(new.structure_json, '$.observedAt')
    BEGIN
      UPDATE ${TABLE} SET stamp='', basis_hash='',
        state=CASE WHEN new.is_bot=1 THEN 'pending' ELSE 'retain' END,
        generation=generation+1, representative_id=NULL,
        reason='source_changed', updated_at=unixepoch('subsec') * 1000
        WHERE message_id=new.message_id;
      INSERT INTO memory_pending(message_id) VALUES(new.message_id)
        ON CONFLICT(message_id) DO NOTHING;
      INSERT INTO memory_writer_pending(message_id,guild_id,channel_id,created_at,queued_at)
        SELECT message_id,guild_id,channel_id,created_at,unixepoch('subsec') * 1000
        FROM messages WHERE message_id=new.message_id AND deleted=0
        ON CONFLICT(message_id) DO UPDATE SET generation=generation+1,
          queued_at=excluded.queued_at,retry_at=0;
    END;

    DROP TRIGGER IF EXISTS dream_admission_human_reply;
    CREATE TRIGGER dream_admission_human_reply
      AFTER INSERT ON messages
      WHEN new.is_bot=0 AND new.reply_to IS NOT NULL
    BEGIN
      UPDATE ${TABLE} SET state='retain', representative_id=NULL,
        generation=generation+1, reason='human_reply_retention_signal',
        updated_at=unixepoch('subsec') * 1000
        WHERE message_id=new.reply_to AND guild_id=new.guild_id AND channel_id=new.channel_id;
      INSERT INTO memory_pending(message_id)
        SELECT message_id FROM messages WHERE message_id=new.reply_to
        ON CONFLICT(message_id) DO NOTHING;
      INSERT INTO memory_writer_pending(message_id,guild_id,channel_id,created_at,queued_at)
        SELECT message_id,guild_id,channel_id,created_at,unixepoch('subsec') * 1000
        FROM messages WHERE message_id=new.reply_to AND deleted=0
        ON CONFLICT(message_id) DO UPDATE SET generation=generation+1,
          queued_at=excluded.queued_at,retry_at=0;
    END;

    DROP TRIGGER IF EXISTS dream_admission_pin;
    CREATE TRIGGER dream_admission_pin
      AFTER UPDATE OF pinned ON messages
      WHEN new.pinned=1 AND old.pinned IS NOT 1
    BEGIN
      UPDATE ${TABLE} SET state='retain', representative_id=NULL,
        generation=generation+1, reason='pin_retention_signal',
        updated_at=unixepoch('subsec') * 1000
        WHERE message_id=new.message_id;
      INSERT INTO memory_pending(message_id) VALUES(new.message_id)
        ON CONFLICT(message_id) DO NOTHING;
      INSERT INTO memory_writer_pending(message_id,guild_id,channel_id,created_at,queued_at)
        SELECT message_id,guild_id,channel_id,created_at,unixepoch('subsec') * 1000
        FROM messages WHERE message_id=new.message_id AND deleted=0
        ON CONFLICT(message_id) DO UPDATE SET generation=generation+1,
          queued_at=excluded.queued_at,retry_at=0;
    END;
  `);
  schemaReady = true;
}

function getAdmission(messageId) {
  if (!messageId) return null;
  return db.prepare(`SELECT * FROM ${TABLE} WHERE message_id=?`).get(messageId) ?? null;
}

function writeAdmission(record) {
  db.prepare(`INSERT INTO ${TABLE} (
      message_id,guild_id,channel_id,author_id,is_bot,basis_hash,stamp,state,
      generation,representative_id,reason,created_at,updated_at
    ) VALUES (@messageId,@guildId,@channelId,@authorId,@isBot,@basisHash,@stamp,
      @state,@generation,@representativeId,@reason,@createdAt,@updatedAt)
    ON CONFLICT(message_id) DO UPDATE SET guild_id=excluded.guild_id,
      channel_id=excluded.channel_id,author_id=excluded.author_id,
      is_bot=excluded.is_bot,basis_hash=excluded.basis_hash,stamp=excluded.stamp,
      state=excluded.state,generation=excluded.generation,
      representative_id=excluded.representative_id,reason=excluded.reason,
      created_at=excluded.created_at,updated_at=excluded.updated_at`).run(record);
}

function queueChanged(ids) {
  const unique = [...new Set(ids.filter(Boolean).map(String))];
  if (!unique.length) return 0;
  const placeholders = unique.map(() => '?').join(',');
  const at = now();
  return db.transaction(() => {
    const direct = db.prepare(`INSERT INTO memory_pending(message_id)
      SELECT message_id FROM messages WHERE message_id IN (${placeholders})
      ON CONFLICT(message_id) DO NOTHING`).run(...unique).changes;
    db.prepare(`INSERT OR IGNORE INTO memory_projection_priority(message_id)
      SELECT message_id FROM messages WHERE message_id IN (${placeholders})`).run(...unique);
    // Re-run the same writer inputs that observed a changed source. This is
    // intentionally a source-level queue, not a second semantic store.
    db.prepare(`INSERT INTO memory_writer_pending(message_id,guild_id,channel_id,created_at,queued_at)
      SELECT m.message_id,m.guild_id,m.channel_id,m.created_at,?
      FROM messages m WHERE m.deleted=0 AND m.message_id IN (
        SELECT i.message_id FROM memory_writer_inputs i WHERE i.batch_id IN (
          SELECT batch_id FROM memory_writer_inputs WHERE message_id IN (${placeholders})
        )
      )
      ON CONFLICT(message_id) DO UPDATE SET generation=generation+1,
        queued_at=excluded.queued_at,retry_at=0`).run(at, ...unique);
    db.prepare(`INSERT INTO memory_writer_pending(message_id,guild_id,channel_id,created_at,queued_at)
      SELECT message_id,guild_id,channel_id,created_at,? FROM messages
      WHERE deleted=0 AND message_id IN (${placeholders})
      ON CONFLICT(message_id) DO UPDATE SET generation=generation+1,
        queued_at=excluded.queued_at,retry_at=0`).run(at, ...unique);
    return direct;
  })();
}

function duplicateRepresentative(normalized) {
  if (!normalized.messageId || !normalized.guildId || !normalized.channelId || !normalized.authorId) return null;
  // Exact bases are persisted in the admission index. This avoids hashing an
  // author's unbounded raw history and still finds a repeat after arbitrarily
  // many unrelated messages. Only a current, directly retained source may be
  // used as the representative.
  const row = db.prepare(`SELECT a.message_id FROM ${TABLE} a
    INDEXED BY idx_dream_admission_exact_representative
    JOIN messages m ON m.message_id=a.message_id
    WHERE a.guild_id=? AND a.channel_id=? AND a.author_id=? AND a.basis_hash=?
      AND a.state='retain' AND a.message_id<>? AND m.deleted=0
    ORDER BY a.created_at ASC, a.message_id ASC LIMIT 1`).get(
    normalized.guildId, normalized.channelId, normalized.authorId, normalized.basisHash,
    normalized.messageId
  );
  return row?.message_id == null ? null : String(row.message_id);
}

function defaultOutcome(normalized) {
  if (normalized.pinned) return { state: 'retain', representativeId: null, reason: 'pin_retention_signal' };
  if (!normalized.isBot) {
    const representativeId = duplicateRepresentative(normalized);
    return representativeId
      ? { state: 'compressed', representativeId, reason: 'exact_repeated_payload' }
      : { state: 'retain', representativeId: null, reason: 'human_default_retain' };
  }
  return { state: 'pending', representativeId: null, reason: 'bot_requires_ling_selection' };
}

function persistDefault(normalized, outcome, previous = null, { queue = true } = {}) {
  const generation = previous ? Number(previous.generation) + 1 : 0;
  const record = {
    messageId: normalized.messageId, guildId: normalized.guildId, channelId: normalized.channelId,
    authorId: normalized.authorId, isBot: normalized.isBot ? 1 : 0,
    basisHash: normalized.basisHash, stamp: normalized.stamp, state: outcome.state,
    generation, representativeId: outcome.representativeId, reason: outcome.reason,
    createdAt: normalized.createdAt, updatedAt: now()
  };
  writeAdmission(record);
  if (queue && previous && (previous.state !== record.state || previous.stamp !== record.stamp
    || previous.representative_id !== record.representativeId)) queueChanged([normalized.messageId]);
  return { state: record.state, generation, representativeId: record.representativeId,
    reason: record.reason };
}

/** Return the current local admission state for an archive or normalized row. */
export function admissionFor(row) {
  ensureAdmissionSchema();
  const input = normalizeRow(row);
  const normalized = normalizeRow(sourceRowForAdmission(row, input));
  if (!normalized.messageId) return { state: 'retain', generation: 0, representativeId: null, reason: 'missing_message_id' };
  if (!isDreamGuild(normalized.guildId)) {
    return { state: 'retain', generation: 0, representativeId: null, reason: 'dream_guild_bypass' };
  }
  let previous = getAdmission(normalized.messageId);
  const humanReply = db.prepare(`SELECT 1 FROM messages INDEXED BY idx_dream_messages_reply_target
    WHERE reply_to=? AND guild_id=? AND channel_id=? AND is_bot=0 AND deleted=0
      AND message_id<>? LIMIT 1`)
    .get(normalized.messageId, normalized.guildId, normalized.channelId, normalized.messageId);
  if (normalized.pinned || humanReply) {
    const reason = normalized.pinned ? 'pin_retention_signal' : 'human_reply_retention_signal';
    if (!previous || previous.state !== 'retain' || previous.stamp !== normalized.stamp) {
      return persistDefault(normalized, { state: 'retain', representativeId: null, reason }, previous);
    }
  }
  // A changed source gets a fresh generation before a stale Ling result can be
  // applied. This path is point-lookups only; it never sweeps the archive.
  if (previous && (previous.stamp !== normalized.stamp || previous.basis_hash !== normalized.basisHash)) {
    previous = { ...previous, state: previous.is_bot ? 'pending' : 'retain' };
    return persistDefault(normalized, {
      state: previous.state,
      representativeId: null,
      reason: 'source_changed'
    }, previous);
  }
  if (previous) return {
    state: previous.state, generation: Number(previous.generation) || 0,
    representativeId: previous.representative_id ?? null, reason: previous.reason ?? ''
  };
  const outcome = defaultOutcome(normalized);
  return persistDefault(normalized, outcome, null, { queue: false });
}

export function isMessageAdmitted(row) {
  return admissionFor(row).state === 'retain';
}

/** Resolve a persisted disposition without making callers know the archive schema. */
export function admissionDisposition(messageId) {
  ensureAdmissionSchema();
  const id = String(messageId ?? '');
  if (!id) return null;
  const row = db.prepare('SELECT * FROM messages WHERE message_id=?').get(id);
  if (!row) return null;
  return { messageId: id, guildId: row.guild_id, channelId: row.channel_id,
    authorId: row.author_id, ...admissionFor(row) };
}

function replyCompatible(left, right, group) {
  const a = replyOf(left);
  const b = replyOf(right);
  if (a === b) return true;
  if (!a || !b) return false;
  // A run of same-author messages may answer one of its own earlier turns;
  // preserve that actual target if it is already in this unit.
  const ids = new Set(group.map((message) => idOf(message)));
  return ids.has(a) && ids.has(b) && a === b;
}

function contextUnit(group, selfId = null) {
  const messages = group.map((message) => {
    const normalized = normalizeRow(message);
    const structure = normalized.structure;
    const replyTo = normalized.replyTo;
    return {
      ...message,
      messageId: normalized.messageId,
      guildId: normalized.guildId,
      channelId: normalized.channelId,
      authorId: normalized.authorId,
      authorName: normalized.authorName,
      isBot: normalized.isBot,
      content: normalized.content,
      extra: normalized.extra,
      createdAt: normalized.createdAt,
      replyTo,
      replyRole: replyTo ? (structure?.reference?.kind ?? 'reply') : null,
      admission: admissionFor(message)
    };
  });
  const ids = messages.map((message) => message.messageId).filter(Boolean);
  const first = messages[0] ?? {};
  const replyTargets = [...new Set(messages.map((message) => message.replyTo).filter(Boolean))];
  return {
    schema: 'sakana.dream.context-unit.v1',
    unitId: ids[0] ?? null,
    messageId: ids[0] ?? null,
    messageIds: ids,
    ids,
    guildId: first.guildId ?? null,
    channelId: first.channelId ?? null,
    authorId: first.authorId ?? null,
    authorName: first.authorName ?? 'unknown',
    // Discord bot authors are participants too. Only the caller's explicit
    // selfId may become `self`; an arbitrary `isBot` flag is never authority
    // to label a foreign message as the assistant's own turn.
    role: selfId != null && first.authorId === String(selfId) ? 'self' : 'participant',
    origin: first.isBot ? 'bot' : 'human',
    replyTo: messages.length === 1 ? (first.replyTo ?? null) : null,
    replyTargets,
    replyRoles: messages.map(({ messageId, replyTo, replyRole }) => ({ messageId, replyTo, role: replyRole })),
    createdAt: first.createdAt ?? 0,
    endedAt: messages[messages.length - 1]?.createdAt ?? first.createdAt ?? 0,
    messages
  };
}

/**
 * Filter and coalesce normalized messages into bounded conversation units.
 * Only adjacent, same-author turns within 60 seconds and with equal real reply
 * targets are merged. IDs and reply metadata remain on every child message.
 */
export function selectContextMessages(messages, opts = {}) {
  ensureAdmissionSchema();
  const input = Array.isArray(messages) ? messages : [];
  const guildId = opts.guildId == null ? null : String(opts.guildId);
  const channelId = opts.channelId == null ? null : String(opts.channelId);
  const includePending = Boolean(opts.includePending);
  const maxUnits = Number.isFinite(opts.maxUnits) ? Math.max(1, Math.floor(opts.maxUnits)) : Infinity;
  const maxBytes = Number.isFinite(opts.maxBytes) ? Math.max(1, Math.floor(opts.maxBytes)) : Infinity;
  const maxGapMs = Number.isFinite(opts.coalesceMs) ? Math.max(0, Number(opts.coalesceMs)) : COALESCE_MS;
  const candidates = [];
  const candidateIds = new Set();
  const addCandidate = (candidate) => {
    const candidateId = idOf(candidate);
    if (!candidateId || candidateIds.has(candidateId)) return;
    candidateIds.add(candidateId);
    candidates.push(candidate);
  };
  const orderedInput = [...input].sort((a, b) => createdOf(a) - createdOf(b) || idOf(a).localeCompare(idOf(b)));
  const inputById = new Map(orderedInput.map((message) => [idOf(message), message]));
  for (const message of orderedInput) {
    const normalized = normalizeRow(message);
    if (!normalized.messageId || normalized.deleted
      || (guildId !== null && normalized.guildId !== guildId)
      || (channelId !== null && normalized.channelId !== channelId)) continue;
    const decision = admissionFor(message);
    const own = opts.selfId != null && normalized.authorId === String(opts.selfId);
    if (decision.state === 'suppress') continue;
    if (decision.state === 'compressed') {
      const representative = inputById.get(String(decision.representativeId ?? ''));
      if (!representative || idOf(representative) === normalized.messageId) continue;
      const exact = normalizeRow(representative);
      if (exact.deleted || exact.guildId !== normalized.guildId || exact.channelId !== normalized.channelId
        || exact.authorId !== normalized.authorId || exact.basisHash !== normalized.basisHash) continue;
      // A representative may have been edited, suppressed or compressed after
      // this source was decided. Revalidate its current, direct disposition
      // before exposing it to the live prompt.
      const representativeDecision = admissionFor(representative);
      if (representativeDecision.state !== 'retain'
        || (representativeDecision.representativeId
          && representativeDecision.representativeId !== exact.messageId)) continue;
      addCandidate(representative);
      continue;
    }
    if (decision.state === 'pending' && !includePending && normalized.isBot && !own) continue;
    addCandidate(message);
  }
  candidates.sort((a, b) => createdOf(a) - createdOf(b) || idOf(a).localeCompare(idOf(b)));
  const units = [];
  let current = [];
  for (const message of candidates) {
    const previous = current[current.length - 1];
    const canMerge = previous && authorOf(previous) === authorOf(message)
      && guildOf(previous) === guildOf(message) && channelOf(previous) === channelOf(message)
      && Math.abs(createdOf(message) - createdOf(previous)) <= maxGapMs
      && replyCompatible(previous, message, current);
    if (!canMerge && current.length) {
      units.push(contextUnit(current, opts.selfId));
      current = [];
    }
    current.push(message);
  }
  if (current.length) units.push(contextUnit(current, opts.selfId));
  const bounded = [];
  let bytes = 0;
  for (let index = units.length - 1; index >= 0; index -= 1) {
    const unit = units[index];
    const size = Buffer.byteLength(JSON.stringify(unit));
    if (bounded.length >= maxUnits || size > maxBytes || bytes + size > maxBytes) break;
    bounded.unshift(unit); bytes += size;
  }
  return bounded;
}

function boundedInteger(value, fallback, maximum) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? Math.min(maximum, Math.max(1, parsed)) : fallback;
}

function schemaForDecisions() {
  return {
    type: 'array', minItems: 1,
    items: {
      type: 'object', additionalProperties: false,
      required: ['messageId', 'state', 'reason'],
      properties: {
        messageId: { type: 'string', minLength: 1 },
        state: { type: 'string', enum: ['retain', 'suppress', 'pending', 'compressed'] },
        representativeId: { type: ['string', 'null'] },
        reason: { type: 'string', minLength: 1, maxLength: MAX_REASON },
        generation: { type: 'integer', minimum: 0 }
      }
    }
  };
}

function targetFor(row, admission) {
  const normalized = normalizeRow(row);
  return {
    messageId: normalized.messageId, guildId: normalized.guildId,
    channelId: normalized.channelId, authorId: normalized.authorId,
    generation: Number(admission.generation) || 0,
    stamp: normalized.stamp, basis: normalized.basisHash, basisHash: normalized.basisHash,
    family: normalized.familyHash, createdAt: normalized.createdAt
  };
}

function groupKey(target) {
  return [target.guildId, target.channelId, target.authorId, target.family].join('\0');
}

/**
 * Build a finite Ling input. No message is removed from `messages`; the batch
 * carries only raw representative envelopes and hash-addressed target rows.
 */
export function selectAdmissionBatch({ guildId, channelIds, limit = DEFAULT_LIMIT, maxBytes = DEFAULT_BYTES } = {}) {
  ensureAdmissionSchema();
  const scope = String(guildId ?? '');
  const boundedLimit = boundedInteger(limit, DEFAULT_LIMIT, MAX_SCAN);
  const boundedBytes = Math.max(1, Number(maxBytes) || DEFAULT_BYTES);
  const empty = (reason) => ({ schema: SCHEMA, guildId: scope, generation: 0, issuedAt: now(),
    limit: boundedLimit, maxBytes: boundedBytes, groups: [], targets: [], issuedIds: [],
    decisionSchema: schemaForDecisions(), reason });
  if (!isDreamGuild(scope)) return empty('dream_guild_bypass');
  let channels = null;
  if (channelIds !== undefined) {
    if (channelIds == null || typeof channelIds[Symbol.iterator] !== 'function') {
      throw new TypeError('channelIds must be an iterable of channel IDs');
    }
    channels = [...new Set([...channelIds].map((id) => String(id)).filter(Boolean))];
    if (!channels.length) return empty('no_readable_channels');
  }

  const channelFilter = channels ? `AND m.channel_id IN (${channels.map(() => '?').join(',')})` : '';
  const rows = db.prepare(`SELECT m.* FROM messages m
    LEFT JOIN ${TABLE} a ON a.message_id=m.message_id
    WHERE m.guild_id=? AND m.deleted=0 AND m.is_bot=1
      ${channelFilter}
      AND (a.message_id IS NULL OR a.state='pending' OR a.stamp='')
    ORDER BY CASE WHEN a.message_id IS NULL THEN 0 ELSE 1 END,
      COALESCE(a.updated_at, 0) ASC, m.created_at ASC, m.message_id ASC
    LIMIT ?`).all(scope, ...(channels ?? []), Math.min(MAX_SCAN, boundedLimit * 8));
  const groups = new Map();
  const targets = [];
  for (const row of rows) {
    if (targets.length >= boundedLimit) break;
    const admission = admissionFor(row);
    if (admission.state !== 'pending') continue;
    const target = targetFor(row, admission);
    const key = groupKey(target);
    if (!groups.has(key)) groups.set(key, {
      groupId: `g${groups.size + 1}`, kind: 'bot', guildId: target.guildId,
      channelId: target.channelId, authorId: target.authorId, family: target.family,
      exact: new Map(), variants: [], representative: null
    });
    const group = groups.get(key);
    const exact = target.basis;
    if (!group.exact.has(exact)) group.exact.set(exact, []);
    const withRow = { ...target, row };
    group.exact.get(exact).push(withRow);
    group.variants.push(withRow);
    if (!group.representative || target.createdAt < group.representative.createdAt
      || (target.createdAt === group.representative.createdAt && target.messageId < group.representative.messageId)) {
      group.representative = { ...target, row };
    }
    targets.push({ ...target, row });
  }

  const outputGroups = [];
  const outputTargets = [];
  let bytes = 0;
  const valuesForGroup = (group, exactEntries, suffix = '') => {
    const flattened = exactEntries.flat();
    const representatives = exactEntries.map((entry) => entry[0]).filter(Boolean);
    if (!flattened.length || !representatives.length) return null;
    const first = representatives[0];
    const variants = flattened.map(({ row, ...target }) => target);
    const payloads = Object.fromEntries(representatives.map((target) => [target.basis, {
      messageId: target.messageId, targetIds: exactEntries.find((entry) => entry[0]?.basis === target.basis)
        .map((item) => item.messageId), envelope: rawEnvelope(target.row)
    }]));
    const targetIds = variants.map((target) => target.messageId);
    const value = {
      groupId: `${group.groupId}${suffix}`,
      kind: exactEntries.some((entry) => entry.length > 1) ? 'template' : 'bot',
      guildId: group.guildId, channelId: group.channelId, authorId: group.authorId,
      family: group.family, representativeId: first.messageId,
      // The first envelope remains the compact representative for consumers
      // that only need a sample. `payloads` is lossless across all distinct
      // exact bases, so release/status/negation changes are visible to Ling.
      representative: rawEnvelope(first.row), payloads,
      targetIds, sourceIds: targetIds,
      sourceIdMap: Object.fromEntries(variants.map((target) => {
        const exact = payloads[target.basis];
        return [target.messageId, { representativeId: exact.messageId,
          exact: target.basis === first.basis, payloadId: exact.messageId }];
      })),
      exactDuplicateCount: Math.max(...exactEntries.map((entry) => entry.length)),
      variants: variants.map((target) => ({ ...target,
        payloadId: payloads[target.basis].messageId })),
      period: {
        from: Math.min(...variants.map((target) => target.createdAt)),
        to: Math.max(...variants.map((target) => target.createdAt))
      }
    };
    return value;
  };
  for (const group of groups.values()) {
    if (!group.representative) continue;
    const exactEntries = [...group.exact.values()];
    let values = [valuesForGroup(group, exactEntries)];
    let firstValue = values[0];
    // If all variants together exceed the transport budget, split by exact
    // payload. This keeps each source lossless and lets later groups proceed.
    if (firstValue && Buffer.byteLength(JSON.stringify(firstValue)) > boundedBytes) {
      values = exactEntries.map((entry, index) => valuesForGroup(group, [entry], `.${index + 1}`));
    }
    for (const value of values) {
      if (!value) continue;
      const size = Buffer.byteLength(JSON.stringify(value));
      if (size > boundedBytes || (outputGroups.length && bytes + size > boundedBytes)) continue;
      outputGroups.push(value);
      const ids = value.targetIds;
      const byId = new Map(group.variants.map((target) => [target.messageId, target]));
      outputTargets.push(...ids.map((id) => byId.get(id)).filter(Boolean));
      bytes += size;
    }
  }
  const instruction = 'Return exactly one decision for every issued target messageId. Preserve release, version, negation and status differences. Use compressed only for exact duplicate payloads and set representativeId to the retained representative.';
  const fitsBatch = () => Buffer.byteLength(JSON.stringify({
    schema: SCHEMA, guildId: scope, generation: '0'.repeat(64), issuedAt: 0, limit: boundedLimit,
    maxBytes: boundedBytes, groups: outputGroups, targets: outputTargets,
    issuedIds: outputTargets.map((target) => target.messageId), decisionSchema: schemaForDecisions(),
    instruction
  })) <= boundedBytes;
  while (outputGroups.length && !fitsBatch()) {
    const removed = outputGroups.pop();
    const removedIds = new Set(removed.targetIds);
    for (let index = outputTargets.length - 1; index >= 0; index -= 1) {
      if (removedIds.has(outputTargets[index].messageId)) outputTargets.splice(index, 1);
    }
  }
  const issuedIds = outputTargets.map((target) => target.messageId);
  const generation = hash(outputTargets.map((target) => [target.messageId, target.generation, target.stamp]));
  return {
    schema: SCHEMA, guildId: scope, generation, issuedAt: now(), limit: boundedLimit,
    maxBytes: boundedBytes, groups: outputGroups, targets: outputTargets, issuedIds,
    decisionSchema: schemaForDecisions(),
    instruction
  };
}

function normalizeDecisions(value) {
  if (Array.isArray(value)) return value;
  if (value && Array.isArray(value.decisions)) return value.decisions;
  throw new Error('Admission decisions must be an array or {decisions:[]}');
}

/**
 * Apply one complete Ling phase. Validation is all-or-nothing: an edited row,
 * foreign guild, unknown target or missing target rejects the phase before any
 * outcome is persisted.
 */
export function applyAdmissionDecisions(batch, decisions) {
  ensureAdmissionSchema();
  if (!batch || batch.schema !== SCHEMA) throw new Error('Unknown admission batch schema');
  const scope = String(batch.guildId ?? '');
  if (!isDreamGuild(scope)) {
    if (normalizeDecisions(decisions).length) throw new Error('Dream admission is disabled for this guild');
    return { schema: SCHEMA, guildId: scope, applied: 0, generation: batch.generation, invalid: [], bypassed: true };
  }
  const issued = new Map((Array.isArray(batch.targets) ? batch.targets : []).map((target) => [String(target.messageId), target]));
  const externalRepresentatives = new Map((Array.isArray(batch.representatives)
    ? batch.representatives : []).map((target) => [String(target.messageId), target]));
  const values = normalizeDecisions(decisions);
  if (values.length !== issued.size) throw new Error('Admission phase must decide every issued target exactly once');
  const seen = new Set();
  const checked = [];
  for (const decision of values) {
    if (!decision || !idOf(decision) || seen.has(idOf(decision)) || !issued.has(idOf(decision))) {
      throw new Error('Admission decision contains an unknown or duplicate target');
    }
    const messageId = idOf(decision);
    const target = issued.get(messageId);
    const row = db.prepare('SELECT * FROM messages WHERE message_id=?').get(messageId);
    if (!row || row.guild_id !== scope || target.guildId !== scope
      || row.guild_id !== target.guildId || row.channel_id !== target.channelId
      || row.author_id !== target.authorId || row.deleted) throw new Error('Admission decision crosses source scope or deleted source');
    const current = admissionFor(row);
    if (current.generation !== Number(target.generation)
      || admissionStamp(row) !== target.stamp
      || admissionBasisHash(row) !== target.basis) {
      throw Object.assign(new Error(`Stale admission decision for ${messageId}`), { code: 'STALE_ADMISSION_DECISION' });
    }
    const state = string(decision.state, '');
    if (!STATES.has(state)) throw new Error(`Invalid admission state for ${messageId}`);
    const reason = string(decision.reason, '').trim();
    if (!reason || reason.length > MAX_REASON) throw new Error(`Invalid admission reason for ${messageId}`);
    let representativeId = decision.representativeId == null ? null : String(decision.representativeId);
    if (state === 'compressed' && (!representativeId
      || !issued.has(representativeId) && !externalRepresentatives.has(representativeId))) {
      throw new Error(`Compressed admission needs an issued representative for ${messageId}`);
    }
    if (representativeId && !issued.has(representativeId)
      && !externalRepresentatives.has(representativeId)) {
      throw new Error(`Foreign representative for ${messageId}`);
    }
    if (state === 'compressed') {
      const representative = issued.get(representativeId)
        ?? externalRepresentatives.get(representativeId);
      const sameIssuedScope = representative.channelId === target.channelId
        || (batch.scope?.kind === 'public'
          && Array.isArray(batch.scope.channelIds)
          && batch.scope.channelIds.includes(representative.channelId)
          && batch.scope.channelIds.includes(target.channelId));
      if (representative.guildId !== target.guildId || !sameIssuedScope
        || representative.authorId !== target.authorId || representative.basis !== target.basis) {
        throw new Error(`Compressed admission is not an exact equivalent for ${messageId}`);
      }
    }
    if (state !== 'compressed' && representativeId) {
      if (state !== 'retain' || representativeId !== messageId) {
        throw new Error(`Only compressed admission may name a representative for ${messageId}`);
      }
      // Accept legacy model output that names a retained target itself, but
      // persist the direct form so compressed chains cannot be introduced.
      representativeId = null;
    }
    if (decision.generation !== undefined && Number(decision.generation) !== Number(target.generation)) {
      throw Object.assign(new Error(`Stale admission generation for ${messageId}`), { code: 'STALE_ADMISSION_DECISION' });
    }
    seen.add(messageId);
    checked.push({ row, target, state, reason, representativeId });
  }
  const missing = [...issued.keys()].filter((messageId) => !seen.has(messageId));
  if (missing.length) throw new Error(`Admission phase omitted target ${missing[0]}`);
  const checkedById = new Map(checked.map((item) => [item.row.message_id, item]));
  for (const item of checked) {
    if (item.state !== 'compressed') continue;
    const representative = checkedById.get(item.representativeId);
    const external = externalRepresentatives.get(item.representativeId);
    const externalRow = external ? db.prepare('SELECT * FROM messages WHERE message_id=?')
      .get(item.representativeId) : null;
    const externalDecision = externalRow ? admissionFor(externalRow) : null;
    if (representative
      ? representative.state !== 'retain' || representative.representativeId
      : !external || !externalRow || externalDecision?.state !== 'retain'
        || externalDecision.representativeId || externalRow.guild_id !== external.guildId
        || externalRow.channel_id !== external.channelId
        || externalRow.author_id !== external.authorId
        || admissionStamp(externalRow) !== external.stamp
        || admissionBasisHash(externalRow) !== external.basis) {
      throw new Error(`Compressed admission needs a directly retained representative for ${item.row.message_id}`);
    }
  }
  const changed = db.transaction(() => {
    const ids = [];
    for (const item of checked) {
      const current = getAdmission(item.row.message_id);
      const generation = Number(current?.generation ?? item.target.generation) + 1;
      writeAdmission({
        messageId: item.row.message_id, guildId: item.row.guild_id, channelId: item.row.channel_id,
        authorId: item.row.author_id, isBot: item.row.is_bot ? 1 : 0,
        basisHash: item.target.basis, stamp: item.target.stamp, state: item.state,
        generation, representativeId: item.representativeId, reason: item.reason,
        createdAt: item.row.created_at, updatedAt: now()
      });
      ids.push(item.row.message_id);
    }
    queueChanged(ids);
    return ids;
  })();
  return { schema: SCHEMA, guildId: scope, applied: changed.length,
    generation: hash(changed.map((messageId) => `${messageId}:${getAdmission(messageId)?.generation ?? 0}`)),
    ids: changed, invalid: [] };
}

/**
 * Apply the semantic source outcomes returned by the unified Writer. The
 * scheduler calls this inside its fenced completion transaction; raw archive
 * rows remain untouched. `context_only` is an explicit processed outcome and
 * therefore remains retained for provenance, while exact duplicates must name
 * a directly retained, exact source from the same issued work.
 */
export function applyDreamSourceOutcomes({ guildId, workId, scope: workScope,
  targets, sources = [], outcomes } = {}) {
  ensureAdmissionSchema();
  const scope = String(guildId ?? '');
  const issuedTargets = Array.isArray(targets) ? targets : [];
  const values = Array.isArray(outcomes) ? outcomes : [];
  if (!workId) throw new TypeError('Dream source outcomes require a workId');
  const batchTargets = issuedTargets.map((target) => {
    const messageId = String(target?.messageId ?? '');
    const row = db.prepare('SELECT * FROM messages WHERE message_id=?').get(messageId);
    if (!row || row.deleted || row.guild_id !== scope
      || row.channel_id !== String(target?.channelId ?? row.channel_id)
      || row.author_id !== String(target?.authorId ?? row.author_id)
      || admissionStamp(row) !== String(target?.admissionStamp ?? '')
      || admissionBasisHash(row) !== String(target?.basisHash ?? '')) {
      throw Object.assign(new Error(`Stale Dream source outcome for ${messageId}`), {
        code: 'STALE_ADMISSION_DECISION'
      });
    }
    return {
      messageId, guildId: scope, channelId: row.channel_id, authorId: row.author_id,
      generation: Number(target.admissionGeneration), stamp: target.admissionStamp,
      basis: target.basisHash, basisHash: target.basisHash
    };
  });
  const decisions = values.map((outcome) => {
    const kind = String(outcome?.outcome ?? '');
    if (!['incorporated', 'context_only', 'exact_duplicate'].includes(kind)) {
      throw new Error(`Invalid Dream source outcome ${kind}`);
    }
    return {
      messageId: String(outcome.messageId ?? ''),
      generation: Number(outcome.generation),
      state: kind === 'exact_duplicate' ? 'compressed' : 'retain',
      representativeId: kind === 'exact_duplicate'
        ? String(outcome.representativeId ?? '') : null,
      reason: `dream_writer_${kind}:${String(workId).slice(0, 64)}`.slice(0, MAX_REASON)
    };
  });
  const issuedIds = new Set(batchTargets.map((target) => target.messageId));
  const sourceIds = new Set((Array.isArray(sources) ? sources : [])
    .map((source) => String(source?.messageId ?? '')).filter(Boolean));
  const representatives = [];
  for (const outcome of values) {
    if (outcome?.outcome !== 'exact_duplicate') continue;
    const representativeId = String(outcome.representativeId ?? '');
    if (issuedIds.has(representativeId)
      || representatives.some((target) => target.messageId === representativeId)) continue;
    if (!sourceIds.has(representativeId)) {
      throw new Error(`Dream duplicate representative ${representativeId} was not an issued source`);
    }
    const row = db.prepare('SELECT * FROM messages WHERE message_id=?').get(representativeId);
    const admitted = row ? admissionFor(row) : null;
    if (!row || row.deleted || row.guild_id !== scope || admitted?.state !== 'retain'
      || admitted.representativeId || !workScope?.channelIds?.includes(String(row.channel_id))) {
      throw new Error(`Dream duplicate representative ${representativeId} is not directly retained in scope`);
    }
    representatives.push({ messageId: representativeId, guildId: scope,
      channelId: row.channel_id, authorId: row.author_id,
      generation: admitted.generation, stamp: admissionStamp(row),
      basis: admissionBasisHash(row), basisHash: admissionBasisHash(row) });
  }
  const result = applyAdmissionDecisions({
    schema: SCHEMA, guildId: scope, targets: batchTargets,
    scope: workScope, representatives,
    generation: hash(batchTargets.map((target) => [target.messageId,
      target.generation, target.stamp]))
  }, decisions);
  // Admission generation is part of Dream's own stale-decision token even
  // though it is no longer part of the stable archive source hash.
  const generationsExist = db.prepare(`SELECT 1 FROM sqlite_master
    WHERE type='table' AND name='dream_message_generations'`).get();
  if (generationsExist) for (const target of batchTargets) {
    const current = getAdmission(target.messageId);
    db.prepare(`UPDATE dream_message_generations SET admission_generation=?
      WHERE guild_id=? AND message_id=? AND generation=? AND batch_id=?`)
      .run(Number(current?.generation ?? target.generation), scope, target.messageId,
        Number(issuedTargets.find((item) => String(item.messageId) === target.messageId)?.generation),
        String(workId));
  }
  return result;
}

export const admissionSchema = Object.freeze({
  schema: SCHEMA, states: Object.freeze([...STATES]), decisionSchema: schemaForDecisions(),
  table: TABLE
});
