import { createHash } from 'node:crypto';
import { db } from '../archive/db.js';
import { buildSearch, withRegexGuard } from '../archive/search.js';
import { admissionFor } from './admission.js';
import { archiveEnvelope } from './message.js';

const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const clamp = (value, fallback, maximum) => {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? Math.min(number, maximum) : fallback;
};
const invalid = (message) => Object.assign(new Error(message), { code: 'AGENT_CONTEXT_INVALIDATED' });
const navigable = (row) => ['pending', 'retain'].includes(admissionFor(row).state);
const asCursor = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
const fromCursor = (value) => {
  try { return JSON.parse(Buffer.from(String(value), 'base64url').toString('utf8')); }
  catch { throw new Error('Source cursor is invalid'); }
};

/**
 * Host-owned navigation over archived Discord messages. It deliberately keeps
 * archive pagination separate from model aliases: cursors only locate the next
 * row, while every row is re-authorized and re-hashed before it is disclosed.
 */
export function createArchiveNavigator({
  guildId,
  scope,
  sourceHash,
  assertSource = () => {},
  assertCurrentScope = () => {},
  initialRows = [],
  restoredSources = [],
  restoredCursors = [],
  maxMessages = 60,
  maxBytes = 60000
} = {}) {
  if (typeof guildId !== 'string' || !guildId || typeof sourceHash !== 'function') {
    throw new Error('Archive navigator requires a guild and source hash function');
  }
  if (!scope || !Array.isArray(scope.channelIds) || !scope.channelIds.length
    || typeof scope.generation !== 'string' && typeof scope.generation !== 'number') {
    throw new Error('Archive navigator requires a finite current scope');
  }
  const allowed = new Set(scope.channelIds.map(String));
  const issued = new Map();
  const issuedCursors = new Set();
  let bytes = 0;

  const currentRow = (messageId) => db.prepare(
    'SELECT * FROM messages WHERE guild_id=? AND message_id=? AND deleted=0'
  ).get(guildId, messageId);
  const validate = (row, expectedHash) => {
    assertCurrentScope(scope);
    const current = row?.message_id ? currentRow(row.message_id) : null;
    if (!current || !allowed.has(String(current.channel_id)) || !navigable(current)) {
      throw invalid('Archive source is no longer active in the Writer scope');
    }
    const actual = sourceHash(current);
    if (expectedHash !== undefined && actual !== expectedHash) {
      throw invalid('Archive source changed during Writer navigation');
    }
    assertSource(current);
    return { row: current, hash: actual, envelope: archiveEnvelope(current) };
  };
  const add = (row, { required = false, expectedHash } = {}) => {
    const found = issued.get(String(row?.message_id));
    if (found) {
      validate(row, found.hash);
      return { entry: found, added: false };
    }
    const checked = validate(row, expectedHash);
    const size = Buffer.byteLength(JSON.stringify(checked.envelope));
    if (issued.size >= maxMessages || bytes + size > maxBytes) {
      if (required) throw new Error('Initial Writer sources exceed the episode transport bound');
      return { entry: null, added: false, exhausted: true, oversized: size > maxBytes };
    }
    const entry = { messageId: checked.row.message_id, hash: checked.hash,
      channelId: checked.row.channel_id, createdAt: checked.row.created_at,
      bytes: size, envelope: checked.envelope };
    issued.set(entry.messageId, entry);
    bytes += size;
    return { entry, added: true };
  };

  for (const source of restoredSources) {
    const row = currentRow(source.messageId);
    add(row, { required: true, expectedHash: source.hash });
  }
  for (const cursor of restoredCursors) if (typeof cursor === 'string') issuedCursors.add(cursor);
  for (const row of initialRows) add(row, { required: true });

  const transport = () => ({ messages: issued.size, bytes,
    remainingMessages: Math.max(0, maxMessages - issued.size),
    remainingBytes: Math.max(0, maxBytes - bytes) });
  const sources = () => [...issued.values()].map(({ messageId, hash, channelId }) => ({
    messageId, hash, channelId
  }));
  const sourceIds = () => [...issued.keys()];
  const assertCurrent = () => {
    for (const source of issued.values()) validate(currentRow(source.messageId), source.hash);
    return true;
  };
  const read = (messageIds) => {
    assertCurrent();
    if (!Array.isArray(messageIds) || !messageIds.length || messageIds.length > 20
      || messageIds.some((id) => typeof id !== 'string' || !issued.has(id))) {
      return { error: 'Read one to twenty issued source message IDs' };
    }
    return { messages: [...new Set(messageIds)].map((id) => issued.get(id).envelope), transport: transport() };
  };

  const expose = (rows) => {
    const messages = [];
    let exhausted = false;
    let oversized = false;
    for (const row of rows) {
      if (!row || !allowed.has(String(row.channel_id)) || !navigable(row)) continue;
      const result = add(row);
      if (result.exhausted) {
        exhausted = true;
        oversized ||= result.oversized;
        break;
      }
      messages.push(result.entry.envelope);
    }
    return { messages, exhausted, oversized };
  };

  const context = ({ messageId, before = 3, after = 3, replies = 8 } = {}) => {
    if (typeof messageId !== 'string' || !issued.has(messageId)) {
      return { error: 'source_context requires an issued message ID' };
    }
    before = clamp(before, 3, 10);
    after = clamp(after, 3, 10);
    replies = clamp(replies, 8, 12);
    if (before + after + replies > 20) return { error: 'source_context can expose at most twenty related messages' };
    assertCurrent();
    const target = currentRow(messageId);
    const older = db.prepare(`SELECT * FROM messages WHERE guild_id=? AND channel_id=? AND deleted=0
      AND (created_at<? OR (created_at=? AND message_id<?))
      ORDER BY created_at DESC,message_id DESC LIMIT ?`).all(
      guildId, target.channel_id, target.created_at, target.created_at, target.message_id, before).reverse();
    const newer = db.prepare(`SELECT * FROM messages WHERE guild_id=? AND channel_id=? AND deleted=0
      AND (created_at>? OR (created_at=? AND message_id>?))
      ORDER BY created_at ASC,message_id ASC LIMIT ?`).all(
      guildId, target.channel_id, target.created_at, target.created_at, target.message_id, after);

    const related = [];
    let parentId = target.reply_to;
    for (let hop = 0; hop < 4 && parentId && related.length < replies; hop += 1) {
      const parent = currentRow(parentId);
      if (!parent || !allowed.has(String(parent.channel_id))) break;
      related.push({ relation: 'parent', row: parent });
      parentId = parent.reply_to;
    }
    const children = db.prepare(`SELECT * FROM messages WHERE guild_id=? AND reply_to=? AND deleted=0
      ORDER BY created_at ASC,message_id ASC LIMIT ?`).all(guildId, messageId,
      Math.max(0, replies - related.length));
    for (const child of children) related.push({ relation: 'reply', row: child });

    const beforeResult = expose(older);
    const afterResult = expose(newer);
    const replyResult = expose(related.map((entry) => entry.row));
    const replyById = new Map(related.map((entry) => [entry.row.message_id, entry.relation]));
    return {
      anchor: issued.get(messageId).envelope,
      before: beforeResult.messages,
      after: afterResult.messages,
      replies: replyResult.messages.map((message) => ({ relation: replyById.get(message.id), message })),
      coverage: {
        complete: !(beforeResult.exhausted || afterResult.exhausted || replyResult.exhausted),
        ...(beforeResult.exhausted || afterResult.exhausted || replyResult.exhausted
          ? { reason: beforeResult.oversized || afterResult.oversized || replyResult.oversized
            ? 'single_source_exceeds_transport' : 'episode_transport_budget' } : {})
      },
      transport: transport()
    };
  };

  const search = ({ query = '', channelId = null, from = null, to = null,
    cursor = null, limit = 10 } = {}) => {
    query = String(query ?? '').trim();
    let decoded = null;
    if (cursor) {
      try { decoded = fromCursor(cursor); }
      catch (error) { return { error: error.message }; }
      if (!query && channelId === null && from === null && to === null && decoded?.parameters) {
        ({ query, channelId, from, to } = decoded.parameters);
      }
    }
    if (query.length > 500) return { error: 'source_search query is limited to 500 characters' };
    limit = Math.max(1, clamp(limit, 10, 20));
    if (channelId !== null && (typeof channelId !== 'string' || !allowed.has(channelId))) {
      return { error: 'source_search channel is outside the current Writer scope' };
    }
    if (from !== null && (!Number.isSafeInteger(from) || from < 0)
      || to !== null && (!Number.isSafeInteger(to) || to < 0)
      || from !== null && to !== null && from >= to) {
      return { error: 'source_search time bounds must be increasing Unix milliseconds' };
    }
    assertCurrent();
    const signature = hash({ query, channelId, from, to });
    const start = { createdAt: -1, messageId: '' };
    let position = start;
    if (cursor) {
      if (decoded?.schema !== 1 || decoded.guildId !== guildId
        || decoded.scopeGeneration !== scope.generation || decoded.signature !== signature
        || !Number.isSafeInteger(decoded.createdAt) || typeof decoded.messageId !== 'string') {
        return { error: 'source_search cursor does not belong to this query and current scope' };
      }
      position = { createdAt: decoded.createdAt, messageId: decoded.messageId };
    }
    const channelScope = { mode: 'include', ids: [...allowed] };
    const built = buildSearch({ guildId, query, channelScope, sort: 'old' });
    const clauses = [built.where,
      '(m.created_at>? OR (m.created_at=? AND m.message_id>?))'];
    const fixed = [...built.params, position.createdAt, position.createdAt, position.messageId];
    if (channelId !== null) { clauses.push('m.channel_id=?'); fixed.push(channelId); }
    if (from !== null) { clauses.push('m.created_at>=?'); fixed.push(from); }
    if (to !== null) { clauses.push('m.created_at<?'); fixed.push(to); }
    const statement = db.prepare(`SELECT m.* FROM messages m WHERE ${clauses.join(' AND ')}
      ORDER BY m.created_at ASC,m.message_id ASC LIMIT ?`);
    const messages = [];
    let complete = false;
    let reason = null;
    let scans = 0;
    while (messages.length < limit && scans < 1000) {
      const fetchLimit = Math.min(101, 1000 - scans);
      const rows = withRegexGuard(built.usesRegex, () => statement.all(...fixed.slice(0, built.params.length),
        position.createdAt, position.createdAt, position.messageId,
        ...fixed.slice(built.params.length + 3), fetchLimit));
      if (!rows.length) { complete = true; break; }
      for (const row of rows) {
        scans += 1;
        if (!navigable(row)) {
          position = { createdAt: row.created_at, messageId: row.message_id };
          continue;
        }
        const result = add(row);
        if (result.exhausted) {
          reason = result.oversized ? 'single_source_exceeds_transport' : 'episode_transport_budget';
          break;
        }
        messages.push(result.entry.envelope);
        position = { createdAt: row.created_at, messageId: row.message_id };
        if (messages.length >= limit) break;
      }
      if (reason || messages.length >= limit) break;
      if (rows.length < fetchLimit) { complete = true; break; }
    }
    if (!complete && !reason && scans >= 1000) reason = 'scan_budget';
    const nextCursor = complete ? null : asCursor({ schema: 1, guildId,
      scopeGeneration: scope.generation, signature,
      parameters: { query, channelId, from, to },
      createdAt: position.createdAt, messageId: position.messageId });
    if (nextCursor) issuedCursors.add(nextCursor);
    return { messages, cursor: nextCursor,
      coverage: { complete, ...(complete ? {} : { reason: reason ?? 'page_limit' }) },
      transport: transport() };
  };

  return { read, context, search, add, sources, sourceIds, transport, assertCurrent,
    hasCursor: (cursor) => cursor === null || issuedCursors.has(cursor),
    checkpoint: () => ({ sources: sources(), sourceIds: sourceIds(), cursors: [...issuedCursors],
      transport: transport() }) };
}
