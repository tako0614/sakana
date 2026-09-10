import { createHash, randomUUID } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { MemoryHost } from '../../subprojects/atom-memory/dist/index.js';
import { SqliteStorage } from '../../subprojects/atom-memory/dist/adapters/sqlite.js';
import { db } from '../archive/db.js';
import { canRead } from '../archive/permissions.js';
import { archiveEnvelope } from './message.js';

const digest = (value) => createHash('sha256').update(value).digest('hex');
const policy = (guild, channel) => `discord:${guild}:${channel}`;
let instance;
let discordClient;
let syncing;

// Atom commits and host source pointers share the storage transaction. This
// uses the public StorageAdapter contract instead of decoding opaque AtomRefs.
class ConversationStorage extends SqliteStorage {
  append(revisions) {
    super.append(revisions);
    for (const revision of revisions) {
      if (revision.provenance.producerId !== 'discord-ingestion' || revision.body.kind !== 'inline') continue;
      let value;
      try { value = JSON.parse(revision.body.value); } catch { continue; }
      if (value.sourceKey) this.metaSet(`sakana:source:${value.sourceKey}`, {
        kind: 'pinned', atomId: revision.atomId, revisionId: revision.revisionId
      });
    }
  }
}

function memoryHost() {
  if (instance) return instance;
  const storage = new ConversationStorage(process.env.ATOM_MEMORY_PATH ?? `${process.env.ARCHIVE_DB_PATH ?? 'archive.sqlite'}.atoms.sqlite`, { synchronous: 'NORMAL' });
  const grants = new Map();
  const authority = { resolve(auth) {
    const resolve = grants.get(auth?.authorizationHandle);
    if (!resolve) throw new Error('Memory access denied');
    return resolve();
  } };
  const host = new MemoryHost({ storage, authority });
  instance = { host, storage, grants };
  if (!storage.metaGet('sakana:projection-v1')) {
    db.exec('INSERT OR IGNORE INTO memory_pending SELECT message_id FROM messages');
    storage.metaSet('sakana:projection-v1', true);
  }
  return instance;
}

function binding({ subject, scopes, ingest = false, writePolicy }) {
  const { grants } = memoryHost();
  const auth = { authorizationHandle: randomUUID() };
  grants.set(auth.authorizationHandle, () => {
    const readPolicies = [...new Set(scopes())].sort();
    return { subject, readPolicies, writePolicies: ingest ? readPolicies : [],
      canIngestSource: ingest, generation: digest(JSON.stringify(readPolicies)) };
  });
  return { auth, writePolicy: writePolicy ?? 'unwritable', actor: { type: ingest ? 'input-adapter' : 'agent' } };
}

// Serialized, restartable projection. Archive writes enqueue ids atomically;
// a conditional acknowledgement never loses an edit that arrived during await.
export function syncConversationMemory({ limit = 100 } = {}) {
  if (syncing) return syncing;
  syncing = project(limit).finally(() => { syncing = null; });
  return syncing;
}

async function project(limit) {
  const { host, storage, grants } = memoryHost();
  const pending = db.prepare('SELECT message_id FROM memory_pending LIMIT ?').all(limit);
  const acknowledgements = [];
  for (const { message_id: messageId } of pending) {
    const row = db.prepare('SELECT * FROM messages WHERE message_id = ?').get(messageId);
    const snapshot = JSON.stringify(row ?? null);
    const key = `sakana:message:${messageId}`;
    const old = storage.metaGet(key);
    const envelope = row && !row.deleted ? archiveEnvelope(row) : null;
    // Observation time changes during reindexing without changing the source.
    const text = envelope ? JSON.stringify(envelope) : null;
    const semanticSnapshot = envelope ? { ...envelope, state: { ...envelope.state, observedAt: null } } : null;
    const sourceHash = digest(semanticSnapshot ? JSON.stringify(semanticSnapshot) : 'deleted');
    if (old?.hash !== sourceHash) {
      // Purge makes old observations and dependent generated notes unusable.
      // Source edit history remains in the archive's restricted audit table.
      for (const ref of old?.refs ?? []) host.purge(ref.atomId);
      for (const sourceKey of old?.pendingKeys ?? []) {
        const ref = storage.metaGet(`sakana:source:${sourceKey}`);
        if (ref) host.purge(ref.atomId);
      }
      const refs = [];
      if (text) {
        const scope = policy(row.guild_id, row.channel_id);
        const bound = binding({ subject: 'discord-ingestion', scopes: () => [scope], ingest: true, writePolicy: scope });
        try {
          const client = host.connect(bound);
          const links = {};
          // Entities are channel-scoped too: even graph traversal cannot reveal
          // membership or message relationships from a different private room.
          for (const [role, entityId] of [['author', row.author_id], ['channel', row.channel_id],
            ...(row.parent_id ? [['thread', row.channel_id]] : [])]) {
            const sourceKey = `${scope}:entity:${role}:${entityId}`;
            let ref = storage.metaGet(`sakana:source:${sourceKey}`);
            if (!ref || storage.isPurged(ref.atomId)) {
              await client.write(JSON.stringify({ sourceKey, schema: `discord.${role}.v1`, id: entityId, guildId: row.guild_id }));
              ref = storage.metaGet(`sakana:source:${sourceKey}`);
            }
            links[role] = { ref: host.reference(ref, bound), at: 'logical', required: false };
          }
          // Atom's inline body limit is 64KiB. Split oversized envelopes with
          // explicit byte-independent string offsets, never silent truncation.
          for (let offset = 0; offset < text.length; offset += 12000) {
            const sourceKey = `discord-source:${messageId}:${sourceHash}:${offset}`;
            const part = JSON.stringify({ sourceKey, messageId, offset, total: text.length,
              complete: text.length <= 12000, document: text.slice(offset, offset + 12000) });
            storage.metaSet(key, { hash: null, refs, pendingKeys: [sourceKey], guildId: row.guild_id, channelId: row.channel_id });
            await client.write({ text: part, links });
            const revision = storage.metaGet(`sakana:source:${sourceKey}`);
            if (!revision) throw new Error('Memory source revision was not committed');
            refs.push({ kind: 'pinned', atomId: revision.atomId, revisionId: revision.revisionId });
            // Save each committed part so a crash cannot leave untracked sources.
            storage.metaSet(key, { hash: null, refs, guildId: row.guild_id, channelId: row.channel_id });
          }
        } finally { grants.delete(bound.auth.authorizationHandle); }
      }
      storage.metaSet(key, { hash: sourceHash, refs, guildId: row?.guild_id ?? old?.guildId, channelId: row?.channel_id ?? old?.channelId });
    }
    acknowledgements.push({ messageId, snapshot });
  }
  // Atom is a replayable projection. One durable barrier per batch precedes
  // every queue acknowledgement; a crash before it leaves all sources queued.
  if (acknowledgements.length) storage.flush();
  db.transaction(() => {
    for (const { messageId, snapshot } of acknowledgements) {
      const current = db.prepare('SELECT * FROM messages WHERE message_id = ?').get(messageId);
      if (JSON.stringify(current ?? null) === snapshot) db.prepare('DELETE FROM memory_pending WHERE message_id = ?').run(messageId);
    }
  })();
  return memoryStatus();
}

export function memoryStatus({ guildId, channelIds } = {}) {
  const clauses = [], params = [];
  if (guildId !== undefined) { clauses.push('guild_id = ?'); params.push(String(guildId)); }
  if (channelIds !== undefined) {
    clauses.push(channelIds.length ? `channel_id IN (${channelIds.map(() => '?').join(',')})` : '0');
    params.push(...channelIds);
  }
  const where = clauses.length ? clauses.join(' AND ') : '1';
  return { messages: db.prepare(`SELECT count(*) n FROM messages WHERE deleted = 0 AND ${where}`).get(...params).n,
    pending: clauses.length
      ? db.prepare(`SELECT count(*) n FROM memory_pending WHERE message_id IN (SELECT message_id FROM messages WHERE ${where})`).get(...params).n
      : db.prepare('SELECT count(*) n FROM memory_pending').get().n,
    channels: db.prepare(`SELECT count(*) n FROM channels WHERE ${where}`).get(...params).n };
}

export function publicMemoryChannels(guildId) {
  const guild = discordClient?.guilds?.cache?.get(String(guildId));
  if (!guild) return [];
  const visible = [...guild.channels.cache.values()].filter((channel) =>
    // Private threads require explicit membership even if their parent is public.
    channel.type !== 12 && channel.isTextBased?.() && canRead(channel, guild.roles.everyone)
      && canRead(channel, guild.members.me)).map((channel) => channel.id);
  const parents = new Set(visible);
  for (const row of db.prepare('SELECT channel_id, parent_id FROM channels WHERE guild_id = ? AND is_thread = 1 AND is_private = 0').all(String(guildId))) {
    if (parents.has(row.parent_id)) visible.push(row.channel_id);
  }
  return [...new Set(visible)];
}

export function hasConversationClient() { return Boolean(discordClient); }

export function conversationMemory({ guildId, channel, member, query, onObservation, canRecall, governance = false }) {
  if (!guildId) throw new Error('Conversation memory requires a guildId');
  if (!governance && String(channel?.guildId ?? channel?.guild?.id) !== String(guildId)) {
    throw new Error('Conversation memory channel belongs to another guild');
  }
  const { host, storage, grants } = memoryHost();
  const scopes = () => governance ? publicMemoryChannels(guildId).map((id) => policy(guildId, id))
    : channel && member && canRead(channel, member) && canRead(channel, channel.guild?.members?.me)
      ? [policy(guildId, channel.id)] : [];
  const bound = binding({ subject: governance ? `institution:${guildId}` : `chat:${guildId}:${member?.id}`, scopes });
  const client = host.connect(bound);
  let observedScopes = null;
  const receipts = [];
  const observed = new Map();
  return {
    async read() {
      if (!scopes().length || canRecall?.() === false) return null;
      const result = await client.read({ query: String(query ?? '').slice(0, 4000) }, { tokens: 12000, depth: 0, limit: 8 });
      observedScopes = JSON.stringify(scopes().sort());
      receipts.push(result.receipt);
      const shown = new Set(result.refs);
      const documents = [];
      for (const atom of result.items) {
        if (!shown.has(atom.ref) || atom.provenance.origin !== 'source') continue;
        try {
          const part = JSON.parse(atom.text);
          const mapped = storage.metaGet(`sakana:message:${part.messageId}`);
          if (!mapped || db.prepare('SELECT 1 FROM memory_pending WHERE message_id = ?').get(part.messageId)) continue;
          // A crash between a library commit and host checkpoint can leave an
          // orphan revision. Only the committed current projection is exposed.
          if (!mapped.refs.some((ref) => host.reference(ref, bound) === atom.ref)) continue;
          // Institutions can accept only complete sources within their enacted
          // output budget. Chat may still inspect an explicitly partial source.
          if (onObservation && (!part.complete || onObservation(JSON.parse(part.document), Buffer.byteLength(JSON.stringify(part))) === false)) continue;
          observed.set(part.messageId, mapped.hash);
          documents.push(part);
        } catch { /* Non-message atoms never become evidence. */ }
      }
      const channelIds = governance ? publicMemoryChannels(guildId) : [channel.id];
      return { ...result, text: JSON.stringify({ documents,
        coverage: { ...memoryStatus({ guildId, channelIds }), diagnostics: result.diagnostics } }) };
    },
    async assertCurrent() {
      const invalid = (message) => Object.assign(new Error(message), { code: 'AGENT_CONTEXT_INVALIDATED' });
      if (observedScopes !== null && observedScopes !== JSON.stringify(scopes().sort())) throw invalid('Conversation memory permission changed during execution');
      for (const [messageId, sourceHash] of observed) {
        if (db.prepare('SELECT 1 FROM memory_pending WHERE message_id = ?').get(messageId)
          || storage.metaGet(`sakana:message:${messageId}`)?.hash !== sourceHash) throw invalid('Conversation source changed during execution');
      }
      try { client.assertAuthorized(receipts); } catch (error) { throw invalid(String(error.message ?? error)); }
    },
    close() { grants.delete(bound.auth.authorizationHandle); }
  };
}

export function startConversationMemory(client) {
  discordClient = client;
  let worker, retry, closed = false;
  const start = () => {
    if (closed) return;
    worker = new Worker(new URL('./projection-worker.js', import.meta.url));
    worker.on('error', (error) => console.error('Conversation memory worker failed:', error));
    worker.on('message', (status) => console.log('Conversation memory:', JSON.stringify(status)));
    worker.on('exit', (code) => {
      if (!closed) {
        console.error('Conversation memory worker exited:', code);
        retry = setTimeout(start, 5000);
        retry.unref();
      }
    });
    worker.unref();
  };
  start();
  return () => { closed = true; clearTimeout(retry); void worker?.terminate(); };
}
