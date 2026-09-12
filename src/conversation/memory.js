import { createHash, randomUUID } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { MemoryHost, LexicalCandidateProvider, HybridCandidateProvider } from '../../subprojects/atom-memory/dist/index.js';
import { SqliteStorage } from '../../subprojects/atom-memory/dist/adapters/sqlite.js';
import { db } from '../archive/db.js';
import { canRead } from '../archive/permissions.js';
import { archiveEnvelope } from './message.js';
import { conversationEmbedding } from './embedding.js';
import { embedTexts } from '../embed/worker.js';
import { embedConfig } from '../embed/config.js';

const digest = (value) => createHash('sha256').update(value).digest('hex');
const policy = (guild, channel) => `discord:${guild}:${channel}`;
export const conversationSourceHash = (row) => {
  if (!row || row.deleted) return digest('deleted');
  const envelope = archiveEnvelope(row);
  return digest(JSON.stringify({ ...envelope, state: { ...envelope.state, observedAt: null } }));
};
let instance;
let discordClient;
let syncing;

// Atom commits and host source pointers share the storage transaction. This
// uses the public StorageAdapter contract instead of decoding opaque AtomRefs.
class ConversationStorage extends SqliteStorage {
  append(revisions) {
    super.append(revisions);
    for (const revision of revisions) {
      if (revision.body.kind !== 'inline') continue;
      let value;
      try { value = JSON.parse(revision.body.value); } catch { continue; }
      if (revision.provenance.producerId === 'discord-memory-writer' && value.schema === 'discord.memory.v1') {
        const key = `sakana:writer-batch:${value.batchId}`;
        const batch = this.metaGet(key);
        if (!batch) throw new Error('Writer commit has no source checkpoint');
        this.metaSet(key, { ...batch, committed: true, refs: [...(batch.refs ?? []), {
          kind: 'pinned', atomId: revision.atomId, revisionId: revision.revisionId, nodeId: value.nodeId
        }] });
      }
      if (revision.provenance.producerId !== 'discord-ingestion') continue;
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
  const embedding = embedConfig.enabled && !['0', 'false', 'off'].includes(process.env.MEMORY_EMBEDDINGS ?? 'true') ? conversationEmbedding() : undefined;
  const host = new MemoryHost({ storage, authority, embedding, candidateProvider: embedding ? new HybridCandidateProvider() : new LexicalCandidateProvider() });
  instance = { host, storage, grants, embedding };
  if (!storage.metaGet('sakana:projection-v1')) {
    db.exec('INSERT OR IGNORE INTO memory_pending SELECT message_id FROM messages');
    storage.metaSet('sakana:projection-v1', true);
  }
  return instance;
}

function binding({ subject, scopes, ingest = false, writable = false, writePolicy }) {
  const { grants } = memoryHost();
  const auth = { authorizationHandle: randomUUID() };
  grants.set(auth.authorizationHandle, () => {
    const readPolicies = [...new Set(scopes())].sort();
    return { subject, readPolicies, writePolicies: ingest || writable ? readPolicies : [],
      canIngestSource: ingest, generation: digest(JSON.stringify(readPolicies)) };
  });
  return { auth, writePolicy: writePolicy ?? 'unwritable', actor: ingest ? { type: 'input-adapter' }
    : { type: 'agent', generatedOrigin: 'organization' } };
}

// Serialized, restartable projection. Archive writes enqueue ids atomically;
// a conditional acknowledgement never loses an edit that arrived during await.
export function syncConversationMemory({ limit = 100, messageIds } = {}) {
  if (syncing) return syncing;
  syncing = project(limit, messageIds).finally(() => { syncing = null; });
  return syncing;
}

async function project(limit, messageIds) {
  const { host, storage, grants } = memoryHost();
  const pending = messageIds ? [...new Set(messageIds)].map((message_id) => ({ message_id }))
    : db.prepare('SELECT message_id FROM memory_pending LIMIT ?').all(limit);
  const acknowledgements = [];
  for (const { message_id: messageId } of pending) {
    const row = db.prepare('SELECT * FROM messages WHERE message_id = ?').get(messageId);
    const snapshot = JSON.stringify(row ?? null);
    const key = `sakana:message:${messageId}`;
    const old = storage.metaGet(key);
    const envelope = row && !row.deleted ? archiveEnvelope(row) : null;
    // Observation time changes during reindexing without changing the source.
    const text = envelope ? JSON.stringify(envelope) : null;
    const sourceHash = conversationSourceHash(row);
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

function currentBatch(batch) {
  if (!batch?.committed || !batch.refs?.length) return false;
  const { storage } = memoryHost();
  return batch.sources.every(({ messageId, hash }) => {
    const row = db.prepare('SELECT * FROM messages WHERE message_id = ?').get(messageId);
    return row && !row.deleted && conversationSourceHash(row) === hash
      && storage.metaGet(`sakana:message:${messageId}`)?.hash === hash;
  });
}

function acceptedAtom(atom, bound) {
  const { host, storage } = memoryHost();
  let value;
  try { value = JSON.parse(atom.text); } catch { return null; }
  if (atom.provenance.origin === 'source' && value.messageId) {
    const mapped = storage.metaGet(`sakana:message:${value.messageId}`);
    if (!mapped || db.prepare('SELECT 1 FROM memory_pending WHERE message_id = ?').get(value.messageId)
      || !mapped.refs.some((ref) => host.reference(ref, bound) === atom.ref)) return null;
    return { value, sources: [{ messageId: value.messageId, hash: mapped.hash }] };
  }
  if (atom.provenance.producer === 'discord-memory-writer' && value.schema === 'discord.memory.v1') {
    const batch = storage.metaGet(`sakana:writer-batch:${value.batchId}`);
    if (!currentBatch(batch) || !batch.refs.some((ref) => host.reference(ref, bound) === atom.ref)) return null;
    return { value, sources: batch.sources };
  }
  return null;
}

// Host integration for the Writer. Models only receive issued names and a
// finite write plan; authority, source status and version checks stay here.
export function conversationWriterSession({ guildId, channelId }) {
  const { host, storage, grants } = memoryHost();
  const scope = policy(guildId, channelId);
  const bound = binding({ subject: 'discord-memory-writer', scopes: () => [scope], writable: true, writePolicy: scope });
  const client = host.connect(bound);
  return {
    client, storage,
    sourceRefs(messageId) {
      const mapped = storage.metaGet(`sakana:message:${messageId}`);
      if (mapped?.guildId !== guildId || mapped?.channelId !== channelId) throw new Error('Writer source is outside its channel');
      return (mapped.refs ?? []).map((ref) => host.reference(ref, bound));
    },
    async recall(context, state = {}) {
      // The Writer searches existing organization, while its input already
      // carries source messages. Do not scan a cold raw corpus before the first
      // completed organization in this channel exists.
      if (!db.prepare('SELECT 1 FROM memory_writer_runs WHERE guild_id=? AND channel_id=? AND atoms>0 LIMIT 1').get(guildId, channelId)) return [];
      const result = await client.read({ ...state, context: [context, state.context].filter(Boolean).join('\n') }, { tokens: 8000, depth: 2, limit: 12 });
      const evidence = result.items.filter((atom) => atom.provenance.origin === 'source')
        .flatMap((atom) => {
          const entry = acceptedAtom(atom, bound);
          return entry?.value.complete ? [{ ref: atom.ref, document: JSON.parse(entry.value.document) }] : [];
        });
      return result.items.flatMap((atom) => {
        if (atom.provenance.origin === 'source') return [];
        const accepted = acceptedAtom(atom, bound);
        return accepted ? [{ atom, sources: accepted.sources,
          evidence: evidence.filter((item) => atom.sources.some((source) => source.ref === item.ref)).map((item) => item.document) }] : [];
      });
    },
    checkpoint(batchId) { return storage.metaGet(`sakana:writer-batch:${batchId}`); },
    rebind(atom) {
      const value = JSON.parse(atom.text);
      const batch = storage.metaGet(`sakana:writer-batch:${value.batchId}`);
      if (!currentBatch(batch)) throw Object.assign(new Error('Recalled Writer memory changed during execution'), { code: 'AGENT_CONTEXT_INVALIDATED' });
      const ref = batch.refs.find((ref) => ref.nodeId === value.nodeId);
      if (!ref) throw new Error('Recalled Writer reference is unavailable');
      return { ...atom, ref: host.reference(ref, bound) };
    },
    prepare(batchId, data) { storage.metaSet(`sakana:writer-batch:${batchId}`, { ...data, refs: [], committed: false }); },
    current: currentBatch,
    async index(batchId) {
      if (!memoryHost().embedding) return { indexed: 0, disabled: true };
      const batch = storage.metaGet(`sakana:writer-batch:${batchId}`);
      const refs = [...batch.refs.map(ref => host.reference(ref, bound)), ...batch.sources.flatMap(source => this.sourceRefs(source.messageId))];
      return host.indexAtoms(refs, bound, { limit: 512, budget: { maxModelCalls: 512, maxCandidates: 10000, maxBytes: 16000000, maxModelInputTokens: 1000000 }, deadline: new Date(Date.now() + 120000).toISOString() });
    },
    flush() { storage.flush(); },
    close() { grants.delete(bound.auth.authorizationHandle); }
  };
}

export function conversationMemory({ guildId, channel, member, query, onObservation, onInterpretation, canRecall, governance = false }) {
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
    async read({ context, thought, observations = [] } = {}) {
      if (!scopes().length || canRecall?.() === false) return null;
      const result = await client.read({ query: String(query ?? '').slice(0, 4000),
        context: String(context ?? '').slice(-6000), thought: String(thought ?? '').slice(0, 3000),
        observations: observations.map((text) => String(text).slice(0, 2000)) }, { tokens: 16000, depth: 2, limit: 16 });
      observedScopes = JSON.stringify(scopes().sort());
      receipts.push(result.receipt);
      const accepted = new Map();
      for (const atom of result.items) {
        try {
          const entry = acceptedAtom(atom, bound);
          if (!entry) continue;
          const part = entry.value;
          if (onObservation && atom.provenance.origin === 'source'
            && (!part.complete || onObservation(JSON.parse(part.document), Buffer.byteLength(JSON.stringify(part))) === false)) continue;
          for (const source of entry.sources) observed.set(source.messageId, source.hash);
          accepted.set(atom.ref, atom);
        } catch { /* A revoked or pending source never becomes current evidence. */ }
      }
      // Keep Atom's packed text (including shared quotes and role-bearing links),
      // rather than converting it back to a raw-message-only search result.
      // Required companions are indivisible, also when host evidence budgets fail.
      let changed;
      do {
        changed = false;
        for (const atom of accepted.values()) {
          if (atom.links.some((link) => link.required && !accepted.has(link.ref))) {
            accepted.delete(atom.ref); changed = true;
          }
        }
      } while (changed);
      if (onInterpretation) {
        for (const atom of accepted.values()) if (atom.provenance.origin !== 'source'
          && !onInterpretation(atom.ref, Buffer.byteLength(JSON.stringify(atom)))) accepted.delete(atom.ref);
        do {
          changed = false;
          for (const atom of accepted.values()) if (atom.links.some((link) => link.required && !accepted.has(link.ref))) {
            accepted.delete(atom.ref); changed = true;
          }
        } while (changed);
      }
      const packed = result.text ? JSON.parse(result.text) : { memory: [], evidence: [] };
      packed.memory = (packed.memory ?? []).filter((atom) => accepted.has(atom.ref));
      const quotes = new Set(packed.memory.flatMap((atom) => atom.quote ? [atom.quote.ref] : []));
      packed.evidence = (packed.evidence ?? []).filter((entry) => quotes.has(entry.ref));
      // No configured generator currently creates ephemeral explanations.
      packed.temporary = [];
      const channelIds = governance ? publicMemoryChannels(guildId) : [channel.id];
      return { ...result, text: JSON.stringify({ ...packed,
        interpretation: 'AI-generated organization is interpretation, not a direct quote, verified fact, vote or legal authority.',
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
  const updateGuilds = () => worker?.postMessage({ guildIds: [...client.guilds.cache.keys()] });
  client.on('guildCreate', updateGuilds);
  client.on('guildDelete', updateGuilds);
  const start = () => {
    if (closed) return;
    worker = new Worker(new URL('./projection-worker.js', import.meta.url), {
      workerData: { guildIds: [...client.guilds.cache.keys()] }
    });
    worker.on('error', (error) => console.error('Conversation memory worker failed:', error));
    worker.on('message', (status) => {
      if (status.embedding) {
        const { id, texts, options } = status.embedding;
        const owner = worker;
        const send = result => { try { owner?.postMessage({ embeddingResult: { id, ...result } }); } catch { /* The requesting worker exited. */ } };
        embedTexts(texts, options).then(result => send({ result }), error => send({ error: String(error.message ?? error) }));
      } else console.log('Conversation memory:', JSON.stringify(status));
    });
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
  return () => {
    closed = true; clearTimeout(retry);
    client.off('guildCreate', updateGuilds); client.off('guildDelete', updateGuilds);
    void worker?.terminate();
  };
}

// Called by Sakana's scheduler. Atom itself owns no timer, provider or daemon.
export async function updateConversationIndex({ guildIds, limit = 32 } = {}) {
  if (!guildIds?.length) return { indexed: 0, pending: false };
  const { host, storage, grants } = memoryHost();
  if (!memoryHost().embedding) return { indexed: 0, disabled: true };
  const channels = db.prepare(`SELECT guild_id,channel_id FROM channels WHERE guild_id IN (${guildIds.map(() => '?').join(',')})`).all(...guildIds);
  const ordered = channels.sort((a,b) => a.channel_id.localeCompare(b.channel_id));
  if (!ordered.length) return { indexed: 0, pending: false };
  const last = storage.metaGet('sakana:index-channel') ?? '';
  const selected = ordered.find(row => row.channel_id > last) ?? ordered[0];
  storage.metaSet('sakana:index-channel', selected.channel_id);
  const bound = binding({ subject: 'discord-indexer', scopes: () => [policy(selected.guild_id, selected.channel_id)] });
  try {
    const result = await host.updateIndex(bound, { limit, budget: { maxModelCalls: limit, maxModelInputTokens: 300000, maxCandidates: 10000, maxBytes: 16000000 }, deadline: new Date(Date.now() + 120000).toISOString() });
    storage.flush();
    return result;
  } finally { grants.delete(bound.auth.authorizationHandle); }
}
