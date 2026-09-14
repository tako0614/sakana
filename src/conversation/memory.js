import { createHash, randomUUID } from "node:crypto";
import { Worker } from "node:worker_threads";
import {
  BudgetLedger,
  defaultBudget,
  MemoryHost,
  LexicalCandidateProvider,
  HybridCandidateProvider,
} from "../../subprojects/atom-memory/dist/index.js";
import { SqliteStorage } from "../../subprojects/atom-memory/dist/adapters/sqlite.js";
import { db } from "../archive/db.js";
import { canRead } from "../archive/permissions.js";
import { archiveEnvelope } from "./message.js";
import {
  conversationEmbedding,
  openRouterConversationEmbedding,
  dreamEmbeddingBudget,
} from "./embedding.js";
import { embedTexts } from "../embed/worker.js";
import { embedConfig } from "../embed/config.js";
import { attachMemoryDelivery } from "../ai/runtime.js";
import { isMessageAdmitted } from "./admission.js";
import { isDreamGuild, dreamConfig } from "./dream-config.js";

const digest = (value) => createHash("sha256").update(value).digest("hex");
const policy = (guild, channel) => `discord:${guild}:${channel}`;
const uniqueRefs = (refs) => [
  ...new Set(refs.filter((ref) => typeof ref === "string" && ref)),
];
const USE_BATCH_SIZE = 256;
export const conversationSourceHash = (row) => {
  if (!row || row.deleted) return digest("deleted");
  const envelope = archiveEnvelope(row);
  // Admission is workflow state, not source content. Completing a Writer
  // episode must not invalidate the very observations used to produce it.
  return digest(
    JSON.stringify({
      ...envelope,
      state: { ...envelope.state, observedAt: null },
    }),
  );
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
      if (revision.body.kind !== "inline") continue;
      let value;
      try {
        value = JSON.parse(revision.body.value);
      } catch {
        continue;
      }
      if (
        revision.provenance.producerId === "discord-memory-writer" &&
        ["discord.memory.v1", "discord.memory.v2"].includes(value.schema)
      ) {
        const batchId =
          this.metaGet(
            `sakana:writer-input:${revision.provenance.inputReceiptId}`,
          ) ?? value.batchId;
        const key = `sakana:writer-batch:${batchId}`;
        const batch = this.metaGet(key);
        if (!batch) throw new Error("Writer commit has no source checkpoint");
        this.metaSet(`sakana:writer-atom:${revision.atomId}`, {
          batchId,
          nodeId: value.nodeId,
          guildId: batch.guildId,
          channelId: batch.channelId,
          policyId: revision.policyId,
          revisionId: revision.revisionId,
        });
        this.metaSet(key, {
          ...batch,
          committed: true,
          refs: [
            ...(batch.refs ?? []).filter(
              (ref) => ref.atomId !== revision.atomId,
            ),
            {
              kind: "pinned",
              atomId: revision.atomId,
              revisionId: revision.revisionId,
              nodeId: value.nodeId,
            },
          ],
        });
      }
      if (revision.provenance.producerId !== "discord-ingestion") continue;
      if (value.sourceKey)
        this.metaSet(`sakana:source:${value.sourceKey}`, {
          kind: "pinned",
          atomId: revision.atomId,
          revisionId: revision.revisionId,
        });
    }
  }
}

const guildHosts = new Map();
function memoryHost(guildId, { recall = false } = {}) {
  if (!instance) initializeMemoryHost();
  if (
    !guildId ||
    !isDreamGuild(guildId) ||
    ["0", "false", "off"].includes(process.env.MEMORY_EMBEDDINGS ?? "true")
  )
    return instance;
  let remote = true;
  if (recall) {
    try {
      dreamEmbeddingBudget(guildId);
    } catch {
      remote = false;
    }
  }
  const key = remote ? `qwen:${guildId}` : "lexical";
  if (!guildHosts.has(key)) {
    const { storage, grants, authority } = instance;
    const embedding = remote
      ? openRouterConversationEmbedding({ guildId })
      : undefined;
    const host = new MemoryHost({
      storage,
      authority,
      cursorTtlMs: 2 * 60 * 60 * 1000,
      embedding,
      candidateProvider: embedding
        ? new HybridCandidateProvider()
        : new LexicalCandidateProvider(),
    });
    guildHosts.set(key, { host, storage, grants, authority, embedding });
  }
  return guildHosts.get(key);
}

function initializeMemoryHost() {
  const storage = new ConversationStorage(
    process.env.ATOM_MEMORY_PATH ??
      `${process.env.ARCHIVE_DB_PATH ?? "archive.sqlite"}.atoms.sqlite`,
    { synchronous: "NORMAL" },
  );
  const grants = new Map();
  const authority = {
    resolve(auth) {
      const resolve = grants.get(auth?.authorizationHandle);
      if (!resolve) throw new Error("Memory access denied");
      return resolve();
    },
  };
  const embedding =
    embedConfig.enabled &&
    !["0", "false", "off"].includes(process.env.MEMORY_EMBEDDINGS ?? "true")
      ? conversationEmbedding()
      : undefined;
  const host = new MemoryHost({
    storage,
    authority,
    cursorTtlMs: 2 * 60 * 60 * 1000,
    embedding,
    candidateProvider: embedding
      ? new HybridCandidateProvider()
      : new LexicalCandidateProvider(),
  });
  instance = { host, storage, grants, authority, embedding };
  if (!storage.metaGet("sakana:projection-v2-content-hash")) {
    db.exec(
      "INSERT OR IGNORE INTO memory_pending SELECT message_id FROM messages",
    );
    storage.metaSet("sakana:projection-v2-content-hash", true);
  }
  return instance;
}

function binding({
  subject,
  scopes,
  ingest = false,
  writable = false,
  writePolicy,
  authorizationHandle,
  generation,
}) {
  const { grants } = memoryHost();
  const auth = { authorizationHandle: authorizationHandle ?? randomUUID() };
  grants.set(auth.authorizationHandle, () => {
    const readPolicies = [...new Set(scopes())].sort();
    return {
      subject,
      readPolicies,
      writePolicies: ingest || writable ? readPolicies : [],
      canIngestSource: ingest,
      generation: digest(
        JSON.stringify([readPolicies, generation?.() ?? null]),
      ),
    };
  });
  return {
    auth,
    writePolicy: writePolicy ?? "unwritable",
    actor: ingest
      ? { type: "input-adapter" }
      : { type: "agent", generatedOrigin: "organization" },
  };
}

function messageKey(messageId, policyId) {
  return policyId?.endsWith(":public")
    ? `sakana:public-message:${messageId}`
    : `sakana:message:${messageId}`;
}
function publicManifest(guildId) {
  return memoryHost().storage.metaGet(`sakana:public-scope:${guildId}`);
}
function purgeProjection(atomId) {
  const { host, storage } = memoryHost();
  const pending = storage.metaGet("purge:pending");
  if (pending) {
    const resumed = host.purge(pending.root);
    if (!resumed.complete)
      throw Object.assign(new Error("Source erasure is still in progress"), {
        code: "MEMORY_PURGE_PENDING",
      });
  }
  if (!storage.isPurged(atomId)) {
    const result = host.purge(atomId);
    if (!result.complete)
      throw Object.assign(new Error("Source erasure is still in progress"), {
        code: "MEMORY_PURGE_PENDING",
      });
  }
}

// The Bot supplies this manifest from live Discord permissions. The shared
// projection is revoked before any removed source or dependent Atom is erased.
export function setConversationPublicChannels({
  guildId,
  channelIds,
  permissionGeneration,
}) {
  const { storage } = memoryHost();
  guildId = String(guildId);
  const key = `sakana:public-scope:${guildId}`;
  const ids = [...new Set(channelIds.map(String))].sort();
  const generation = digest(JSON.stringify([ids, permissionGeneration ?? ""]));
  const old = storage.metaGet(key);
  if (old?.generation === generation && old.ready) return old;
  const removed = [
    ...new Set([
      ...(old?.revoking ?? []),
      ...(old?.channelIds ?? []).filter((id) => !ids.includes(id)),
    ]),
  ];
  const next = {
    policyId: policy(guildId, "public"),
    channelIds: ids,
    generation,
    kind: "public",
    ready: false,
    revoking: removed,
  };
  storage.metaSet(key, next);
  storage.flush();
  for (const [entityKey, ref] of storage.metaEntries(
    `sakana:source:${policy(guildId, "public")}:entity:`,
  )) {
    purgeProjection(ref.atomId);
    storage.metaDelete(entityKey);
  }
  if (removed.length) {
    for (const [sourceKey, source] of storage.metaEntries(
      "sakana:public-message:",
    )) {
      if (source.guildId !== guildId || !removed.includes(source.channelId))
        continue;
      for (const ref of source.refs ?? []) purgeProjection(ref.atomId);
      for (const pendingKey of source.pendingKeys ?? []) {
        const ref = storage.metaGet(`sakana:source:${pendingKey}`);
        if (ref) purgeProjection(ref.atomId);
      }
      storage.metaDelete(sourceKey);
    }
  }
  const added = ids.filter((id) => !(old?.channelIds ?? []).includes(id));
  if (added.length)
    db.transaction(() => {
      for (const id of added)
        db.prepare(
          "INSERT OR IGNORE INTO memory_pending SELECT message_id FROM messages WHERE guild_id=? AND channel_id=? AND deleted=0",
        ).run(guildId, id);
    })();
  const ready = { ...next, ready: true, revoking: [] };
  storage.metaSet(key, ready);
  storage.flush();
  return ready;
}

export function conversationWriterScope({ guildId, channelId, scope }) {
  const shared = publicManifest(guildId);
  const explicitChannel =
    scope?.kind === "channel" &&
    scope.policyId === policy(guildId, channelId) &&
    scope.channelIds?.length === 1 &&
    scope.channelIds[0] === String(channelId);
  if (!explicitChannel && shared?.channelIds.includes(String(channelId))) {
    if (!shared.ready)
      throw Object.assign(new Error("Public memory permissions are updating"), {
        code: "AGENT_CONTEXT_INVALIDATED",
      });
    return {
      policyId: shared.policyId,
      kind: "public",
      channelIds: shared.channelIds,
      generation: shared.generation,
      anchorChannelId: String(channelId),
    };
  }
  return {
    policyId: policy(guildId, channelId),
    kind: "channel",
    channelIds: [String(channelId)],
    generation: digest(JSON.stringify([String(guildId), String(channelId)])),
    anchorChannelId: String(channelId),
  };
}

export function enumerateConversationReviewTargets({
  guildId,
  scope,
  purpose = "daily-review",
}) {
  const { storage } = memoryHost();
  const scopes = scope
    ? [scope.policyId]
    : [
        ...new Set([
          ...db
            .prepare("SELECT channel_id FROM channels WHERE guild_id=?")
            .all(guildId)
            .map((row) => policy(guildId, row.channel_id)),
          ...(publicManifest(guildId)?.ready
            ? [policy(guildId, "public")]
            : []),
        ]),
      ];
  const at = storage.watermark(),
    targets = [];
  let after;
  for (;;) {
    const page = storage.scan({ policies: scopes, after, limit: 256 }, at);
    if (!page.length) break;
    for (const atom of page) {
      if (
        atom.provenance.producerId !== "discord-memory-writer" ||
        atom.body.kind !== "inline" ||
        atom.state !== "active" ||
        storage.isPurged(atom.atomId)
      )
        continue;
      let body;
      try {
        body = JSON.parse(atom.body.value);
      } catch {
        continue;
      }
      const batch = storage.metaGet(`sakana:writer-batch:${body.batchId}`);
      if (
        !batch ||
        batch.guildId !== guildId ||
        !currentBatch(batch, body.batchId)
      )
        continue;
      const fingerprint = digest(
        JSON.stringify([
          atom.revisionId,
          atom.body,
          atom.links,
          atom.provenance,
          batch.sources,
          purpose,
        ]),
      );
      targets.push({
        policyId: atom.policyId,
        targetKey: `${atom.atomId}:${atom.revisionId}:${purpose}`,
        atomId: atom.atomId,
        version: atom.revisionId,
        fingerprint,
        purpose,
        channelId: batch.channelId,
        payload: {
          batchId: body.batchId,
          nodeId: body.nodeId,
          ref: {
            kind: "pinned",
            atomId: atom.atomId,
            revisionId: atom.revisionId,
          },
          sources: batch.sources,
          scope: batch.scope,
          text: body.text,
        },
      });
    }
    after = page.at(-1).atomId;
    if (page.length < 256) break;
  }
  return targets;
}

// Serialized, restartable projection. Archive writes enqueue ids atomically;
// a conditional acknowledgement never loses an edit that arrived during await.
export function syncConversationMemory({ limit = 100, messageIds } = {}) {
  if (syncing) return syncing;
  syncing = project(limit, messageIds).finally(() => {
    syncing = null;
  });
  return syncing;
}

async function project(limit, messageIds) {
  const { host, storage, grants } = memoryHost();
  const pendingPurge = storage.metaGet("purge:pending");
  if (pendingPurge) purgeProjection(pendingPurge.root);
  const priority = messageIds
    ? []
    : db
        .prepare(
          `SELECT p.message_id FROM memory_projection_priority p
    JOIN memory_pending m ON m.message_id=p.message_id LIMIT ?`,
        )
        .all(limit);
  const pending = messageIds
    ? [...new Set(messageIds)].map((message_id) => ({ message_id }))
    : [
        ...priority,
        ...db
          .prepare(
            `SELECT message_id FROM memory_pending
      WHERE message_id NOT IN (SELECT message_id FROM memory_projection_priority) LIMIT ?`,
          )
          .all(Math.max(0, limit - priority.length)),
      ];
  const acknowledgements = [];
  for (const { message_id: messageId } of pending) {
    const row = db
      .prepare("SELECT * FROM messages WHERE message_id = ?")
      .get(messageId);
    const snapshot = JSON.stringify(row ?? null);
    const sourceHash = conversationSourceHash(row);
    const manifest = row ? publicManifest(row.guild_id) : null;
    const sharedKey = `sakana:public-message:${messageId}`;
    const scopes = [
      {
        key: `sakana:message:${messageId}`,
        scope: row ? policy(row.guild_id, row.channel_id) : null,
      },
      {
        key: sharedKey,
        scope:
          row && manifest?.channelIds.includes(row.channel_id)
            ? manifest.policyId
            : null,
      },
    ];
    for (const { key, scope } of scopes) {
      const isPublic = key === sharedKey && Boolean(scope);
      const assertProjection = () => {
        if (isPublic) {
          const current = publicManifest(row.guild_id);
          if (
            !current?.ready ||
            current.generation !== manifest?.generation ||
            !current.channelIds.includes(row.channel_id)
          )
            throw Object.assign(new Error("Public projection scope changed"), {
              code: "AGENT_CONTEXT_INVALIDATED",
            });
        }
        return [scope];
      };
      const publish = (value) =>
        storage.transaction(() => {
          assertProjection();
          storage.metaSet(key, value);
        });
      const old = storage.metaGet(key);
      // Pending inputs are available to the Writer. Ordinary read delivery still
      // checks admission, independently of this lossless source projection.
      const requested = Boolean(
        db
          .prepare(
            "SELECT 1 FROM memory_projection_priority WHERE message_id=?",
          )
          .get(messageId),
      );
      const retained = Boolean(
        row && (isMessageAdmitted(row) || old?.refs?.length || requested),
      );
      const envelope =
        scope && row && !row.deleted && retained ? archiveEnvelope(row) : null;
      const text = envelope ? JSON.stringify(envelope) : null;
      if (!old && !text) continue;
      if (
        old?.hash !== sourceHash ||
        Boolean(old?.refs?.length) !== Boolean(text) ||
        (old?.policyId && old.policyId !== scope)
      ) {
        if (old?.refs?.length && text)
          db.prepare(
            `INSERT INTO memory_writer_pending(message_id,guild_id,channel_id,created_at,queued_at)
          VALUES(?,?,?,?,?) ON CONFLICT(message_id) DO NOTHING`,
          ).run(
            messageId,
            row.guild_id,
            row.channel_id,
            row.created_at,
            Date.now(),
          );
        for (const ref of old?.refs ?? []) purgeProjection(ref.atomId);
        for (const sourceKey of old?.pendingKeys ?? []) {
          const ref = storage.metaGet(`sakana:source:${sourceKey}`);
          if (ref) purgeProjection(ref.atomId);
        }
        const refs = [];
        if (text) {
          const bound = binding({
            subject: "discord-ingestion",
            scopes: assertProjection,
            generation: () =>
              isPublic ? publicManifest(row.guild_id)?.generation : null,
            ingest: true,
            writePolicy: scope,
          });
          try {
            const client = host.connect(bound);
            const links = {};
            for (const [role, entityId] of isPublic
              ? []
              : [
                  ["author", row.author_id],
                  ["channel", row.channel_id],
                  ...(row.parent_id ? [["thread", row.channel_id]] : []),
                ]) {
              const sourceKey = `${scope}:entity:${role}:${entityId}`;
              let ref = storage.metaGet(`sakana:source:${sourceKey}`);
              if (!ref || storage.isPurged(ref.atomId)) {
                await client.write({
                  changes: [
                    {
                      id: "source",
                      op: "create",
                      sources: [],
                      content: {
                        text: JSON.stringify({
                          sourceKey,
                          schema: `discord.${role}.v1`,
                          id: entityId,
                          guildId: row.guild_id,
                        }),
                        links: {},
                      },
                    },
                  ],
                });
                ref = storage.metaGet(`sakana:source:${sourceKey}`);
              }
              links[role] = {
                ref: host.reference(ref, bound),
                at: "logical",
                required: false,
              };
            }
            for (let offset = 0; offset < text.length; offset += 12000) {
              const sourceKey = `${scope}:discord-source:${messageId}:${sourceHash}:${offset}`;
              const part = JSON.stringify({
                sourceKey,
                messageId,
                offset,
                total: text.length,
                complete: text.length <= 12000,
                document: text.slice(offset, offset + 12000),
              });
              publish({
                hash: null,
                refs,
                pendingKeys: [sourceKey],
                guildId: row.guild_id,
                channelId: row.channel_id,
                policyId: scope,
              });
              await client.write({
                changes: [
                  {
                    id: "source",
                    op: "create",
                    sources: [],
                    content: { text: part, links },
                  },
                ],
              });
              const revision = storage.metaGet(`sakana:source:${sourceKey}`);
              if (!revision)
                throw new Error("Memory source revision was not committed");
              refs.push({
                kind: "pinned",
                atomId: revision.atomId,
                revisionId: revision.revisionId,
              });
              publish({
                hash: null,
                refs,
                guildId: row.guild_id,
                channelId: row.channel_id,
                policyId: scope,
              });
            }
          } catch (error) {
            if (isPublic) {
              const recorded = storage.metaGet(key);
              for (const ref of [...refs, ...(recorded?.refs ?? [])])
                purgeProjection(ref.atomId);
              for (const sourceKey of recorded?.pendingKeys ?? []) {
                const ref = storage.metaGet(`sakana:source:${sourceKey}`);
                if (ref) purgeProjection(ref.atomId);
              }
              storage.metaDelete(key);
              storage.flush();
            }
            throw error;
          } finally {
            grants.delete(bound.auth.authorizationHandle);
          }
        }
        publish({
          hash: sourceHash,
          refs,
          guildId: row?.guild_id ?? old?.guildId,
          channelId: row?.channel_id ?? old?.channelId,
          policyId: scope,
        });
      }
    }
    acknowledgements.push({ messageId, snapshot, sourceHash });
  }
  // Atom is a replayable projection. One durable barrier per batch precedes
  // every queue acknowledgement; a crash before it leaves all sources queued.
  if (acknowledgements.length) storage.flush();
  db.transaction(() => {
    for (const { messageId, snapshot, sourceHash } of acknowledgements) {
      const current = db
        .prepare("SELECT * FROM messages WHERE message_id = ?")
        .get(messageId);
      if (
        JSON.stringify(current ?? null) === snapshot &&
        conversationSourceHash(current) === sourceHash
      ) {
        db.prepare("DELETE FROM memory_pending WHERE message_id = ?").run(
          messageId,
        );
        db.prepare(
          "DELETE FROM memory_projection_priority WHERE message_id = ?",
        ).run(messageId);
      }
    }
  })();
  return {
    processed: acknowledgements.length,
    pending: db.prepare("SELECT count(*) n FROM memory_pending").get().n,
  };
}

export function memoryStatus({ guildId, channelIds } = {}) {
  const clauses = [],
    params = [];
  if (guildId !== undefined) {
    clauses.push("guild_id = ?");
    params.push(String(guildId));
  }
  if (channelIds !== undefined) {
    clauses.push(
      channelIds.length
        ? `channel_id IN (${channelIds.map(() => "?").join(",")})`
        : "0",
    );
    params.push(...channelIds);
  }
  const where = clauses.length ? clauses.join(" AND ") : "1";
  return {
    messages: db
      .prepare(`SELECT count(*) n FROM messages WHERE deleted = 0 AND ${where}`)
      .get(...params).n,
    pending: clauses.length
      ? db
          .prepare(
            `SELECT count(*) n FROM memory_pending WHERE message_id IN (SELECT message_id FROM messages WHERE ${where})`,
          )
          .get(...params).n
      : db.prepare("SELECT count(*) n FROM memory_pending").get().n,
    channels: db
      .prepare(`SELECT count(*) n FROM channels WHERE ${where}`)
      .get(...params).n,
  };
}

// Other workers request projection by durable ID. Only the projection worker
// executes project(), so a model await never creates a second source owner.
export function conversationSourcesReady(sources, { policyId } = {}) {
  const { storage } = memoryHost();
  let ready = true;
  for (const { messageId, hash } of sources) {
    const row = db
      .prepare("SELECT * FROM messages WHERE message_id=?")
      .get(messageId);
    if (!row || row.deleted || conversationSourceHash(row) !== hash) {
      ready = false;
      continue;
    }
    const mapped = storage.metaGet(messageKey(messageId, policyId));
    if (mapped?.hash !== hash || !mapped.refs?.length) {
      db.prepare("INSERT OR IGNORE INTO memory_pending VALUES(?)").run(
        messageId,
      );
      ready = false;
    }
    if (
      db
        .prepare("SELECT 1 FROM memory_pending WHERE message_id=?")
        .get(messageId)
    ) {
      db.prepare(
        "INSERT OR IGNORE INTO memory_projection_priority VALUES(?)",
      ).run(messageId);
      ready = false;
    }
  }
  return ready;
}

export function publicMemoryChannels(guildId, suppliedGuild) {
  const guild =
    suppliedGuild ?? discordClient?.guilds?.cache?.get(String(guildId));
  if (!guild?.channels?.cache || !guild.roles?.everyone || !guild.members?.me)
    return [];
  const parents = new Set(
    [...guild.channels.cache.values()]
      .filter(
        (channel) =>
          channel.type !== 12 &&
          canRead(channel, guild.roles.everyone) &&
          canRead(channel, guild.members.me),
      )
      .map((channel) => channel.id),
  );
  const visible = [...guild.channels.cache.values()]
    .filter(
      (channel) =>
        channel.type !== 12 &&
        channel.isTextBased?.() &&
        parents.has(channel.id),
    )
    .map((channel) => channel.id);
  for (const row of db
    .prepare(
      "SELECT channel_id,parent_id FROM channels WHERE guild_id=? AND is_thread=1 AND is_private=0",
    )
    .all(String(guildId))) {
    const cached = guild.channels.cache.get(row.channel_id);
    if (
      cached
        ? cached.type !== 12 && parents.has(cached.id)
        : parents.has(row.parent_id)
    )
      visible.push(row.channel_id);
  }
  return [...new Set(visible)];
}

export function hasConversationClient() {
  return Boolean(discordClient);
}

function currentBatch(batch, batchId) {
  if (
    !batch?.committed ||
    !batch.refs?.length ||
    db
      .prepare("SELECT 1 FROM memory_projection_state WHERE key=?")
      .get(`writer-refresh:${batchId}`)
  )
    return false;
  const { storage } = memoryHost();
  const at = storage.watermark();
  if (
    batch.schema !== "discord.writer.checkpoint.v2" &&
    !batch.refs.every(
      (ref) =>
        storage.get({ kind: "logical", atomId: ref.atomId }, at)?.revisionId ===
        ref.revisionId,
    )
  )
    return false;
  return batch.sources.every(({ messageId, hash }) => {
    const row = db
      .prepare("SELECT * FROM messages WHERE message_id = ?")
      .get(messageId);
    return (
      row &&
      !row.deleted &&
      conversationSourceHash(row) === hash &&
      storage.metaGet(
        messageKey(messageId, batch.scope?.policyId ?? batch.policyId),
      )?.hash === hash
    );
  });
}

// Atom reports stale evidence; Sakana owns the decision to schedule another AI
// pass. Reads only enqueue work: model calls, retries and cost limits belong to
// the existing Writer worker. One stale batch requests at most one refresh.
async function scheduleRefresh(client, result, bound, guildId, channelIds) {
  const { storage, host } = memoryHost();
  let queued = 0;
  for (const ref of result.stale) {
    let atom, value;
    try {
      atom = (await client.inspect(ref, { limit: 0 })).atom;
      value = JSON.parse(atom.text);
    } catch (error) {
      if (
        error instanceof SyntaxError ||
        error.code === "ACCESS_DENIED" ||
        error.code === "REFERENCE_UNAVAILABLE"
      )
        continue;
      throw error;
    }
    if (
      atom.provenance.producer !== "discord-memory-writer" ||
      !["discord.memory.v1", "discord.memory.v2"].includes(value.schema)
    )
      continue;
    const key = `sakana:writer-batch:${value.batchId}`;
    const batch = storage.metaGet(key);
    if (
      !batch?.committed ||
      batch.guildId !== guildId ||
      !channelIds.includes(batch.channelId) ||
      !batch.refs.some((target) => host.reference(target, bound) === ref)
    )
      continue;
    const now = Date.now();
    // Queue and deduplication marker share one archive transaction. Do not put
    // the marker in Atom's separate DB: it could survive a lost queue write.
    queued += db.transaction(() => {
      const requested = db
        .prepare(
          `INSERT INTO memory_projection_state(key,value) VALUES(?,?)
        ON CONFLICT(key) DO NOTHING`,
        )
        .run(`writer-refresh:${value.batchId}`, String(now));
      if (!requested.changes) return 0;
      let inserted = 0;
      for (const source of batch.sources)
        inserted += db
          .prepare(
            `
        INSERT INTO memory_writer_pending(message_id,guild_id,channel_id,created_at,queued_at)
        SELECT message_id,guild_id,channel_id,created_at,? FROM messages
        WHERE message_id=? AND guild_id=? AND channel_id=? AND deleted=0
        ON CONFLICT(message_id) DO NOTHING
      `,
          )
          .run(now, source.messageId, guildId, batch.channelId).changes;
      return inserted;
    })();
  }
  return queued;
}

function acceptedAtom(atom, bound, { allowPending = false } = {}) {
  const { host, storage } = memoryHost();
  let value;
  try {
    value = JSON.parse(atom.text);
  } catch {
    return null;
  }
  if (atom.provenance.origin === "source" && value.messageId) {
    const row = db
      .prepare("SELECT * FROM messages WHERE message_id=?")
      .get(value.messageId);
    const mapped = [
      storage.metaGet(`sakana:message:${value.messageId}`),
      storage.metaGet(`sakana:public-message:${value.messageId}`),
    ].find((mapped) =>
      mapped?.refs?.some((ref) => {
        try {
          return host.reference(ref, bound) === atom.ref;
        } catch {
          return false;
        }
      }),
    );
    if (
      !row ||
      row.deleted ||
      (!allowPending && !isMessageAdmitted(row)) ||
      !mapped ||
      mapped.hash !== conversationSourceHash(row) ||
      db
        .prepare("SELECT 1 FROM memory_pending WHERE message_id = ?")
        .get(value.messageId) ||
      !mapped.refs.some((ref) => host.reference(ref, bound) === atom.ref)
    )
      return null;
    return {
      value,
      revision: mapped.refs.find(
        (ref) => host.reference(ref, bound) === atom.ref,
      ),
      sources: [
        {
          messageId: value.messageId,
          hash: mapped.hash,
          policyId: mapped.policyId,
        },
      ],
    };
  }
  if (
    atom.provenance.producer === "discord-memory-writer" &&
    ["discord.memory.v1", "discord.memory.v2"].includes(value.schema)
  ) {
    const batch = storage.metaGet(`sakana:writer-batch:${value.batchId}`);
    if (
      !currentBatch(batch, value.batchId) ||
      !batch.refs.some((ref) => host.reference(ref, bound) === atom.ref)
    )
      return null;
    if (
      !allowPending &&
      batch.sources.some(
        (source) =>
          !isMessageAdmitted(
            db
              .prepare("SELECT * FROM messages WHERE message_id=?")
              .get(source.messageId),
          ),
      )
    )
      return null;
    return {
      value,
      revision: batch.refs.find(
        (ref) => host.reference(ref, bound) === atom.ref,
      ),
      sources: batch.sources.map((source) => ({
        ...source,
        policyId: batch.scope?.policyId ?? batch.policyId,
      })),
    };
  }
  return null;
}

function deliveryCurrent(scopes, entries) {
  const sources = new Map();
  const batches = new Set();
  for (const entry of entries) {
    for (const source of entry?.sources ?? [])
      sources.set(`${source.messageId}\0${source.hash}`, source);
    if (entry?.value?.batchId) batches.add(entry.value.batchId);
  }
  return {
    schema: "sakana.memory.current.v1",
    scopes: [...new Set(scopes)].sort(),
    sources: [...sources.values()],
    batches: [...batches],
    revisions: entries.flatMap((entry) =>
      entry?.revision ? [entry.revision] : [],
    ),
  };
}

function assertDeliveryCurrent(
  delivery,
  scopes,
  { allowPending = false } = {},
) {
  const invalid = (message) =>
    Object.assign(new Error(message), { code: "AGENT_CONTEXT_INVALIDATED" });
  const expectedScopes = JSON.stringify([...new Set(scopes)].sort());
  for (const claim of delivery?.current ?? []) {
    if (claim?.schema !== "sakana.memory.current.v1") continue;
    if (
      JSON.stringify([...new Set(claim.scopes ?? [])].sort()) !== expectedScopes
    ) {
      throw invalid(
        "Conversation memory permission changed before usage accounting",
      );
    }
    for (const { messageId, hash, policyId } of claim.sources ?? []) {
      const row = db
        .prepare("SELECT * FROM messages WHERE message_id = ?")
        .get(messageId);
      if (
        !row ||
        row.deleted ||
        (!allowPending && !isMessageAdmitted(row)) ||
        conversationSourceHash(row) !== hash ||
        db
          .prepare("SELECT 1 FROM memory_pending WHERE message_id = ?")
          .get(messageId) ||
        memoryHost().storage.metaGet(messageKey(messageId, policyId))?.hash !==
          hash
      ) {
        throw invalid("Conversation source changed before usage accounting");
      }
    }
    for (const revision of claim.revisions ?? []) {
      if (
        memoryHost().storage.get(
          { kind: "logical", atomId: revision.atomId },
          memoryHost().storage.watermark(),
        )?.revisionId !== revision.revisionId
      )
        throw invalid("Conversation organization changed before delivery");
    }
    for (const batchId of claim.batches ?? []) {
      if (
        !currentBatch(
          memoryHost().storage.metaGet(`sakana:writer-batch:${batchId}`),
          batchId,
        )
      ) {
        throw invalid(
          "Conversation organization changed before usage accounting",
        );
      }
    }
  }
}

function recordUse(host, bound, refs, options) {
  try {
    // Atom's public host limit is 256 refs per call, while the Writer can
    // retain up to 512 model-visible refs. Every chunk keeps the same durable
    // event ID: if a later chunk fails, replay repeats committed chunks and
    // records only the remainder through Atom's revision/event idempotency.
    const batches =
      Array.isArray(refs) && refs.length > USE_BATCH_SIZE
        ? Array.from(
            { length: Math.ceil(refs.length / USE_BATCH_SIZE) },
            (_, index) =>
              refs.slice(index * USE_BATCH_SIZE, (index + 1) * USE_BATCH_SIZE),
          )
        : [refs];
    let summary = null;
    for (const batch of batches) {
      const result = host.recordUse(batch, bound, options);
      summary = summary
        ? {
            acceptedAt: Math.max(summary.acceptedAt, result.acceptedAt),
            recorded: summary.recorded + result.recorded,
            repeated: summary.repeated + result.repeated,
          }
        : result;
    }
    return summary;
  } catch (error) {
    if (
      !["ACCESS_DENIED", "STATE_INVALIDATED", "REFERENCE_UNAVAILABLE"].includes(
        error.code,
      )
    )
      throw error;
    throw Object.assign(
      new Error(
        `Conversation memory usage is no longer current: ${error.message ?? error}`,
      ),
      {
        code: "AGENT_CONTEXT_INVALIDATED",
      },
    );
  }
}

// Host integration for the Writer. Models only receive issued names and a
// finite write plan; authority, source status and version checks stay here.
export function conversationWriterSession(work, { deadlineAt } = {}) {
  const { guildId, channelId } = work;
  const { host, storage, grants, embedding } = memoryHost(guildId);
  const scope = conversationWriterScope(work);
  const invalid = (message) =>
    Object.assign(new Error(message), { code: "AGENT_CONTEXT_INVALIDATED" });
  const assertScope = () => {
    const current = conversationWriterScope(work);
    if (
      current.policyId !== scope.policyId ||
      current.generation !== scope.generation ||
      (work.scope &&
        (work.scope.policyId !== scope.policyId ||
          work.scope.generation !== scope.generation))
    )
      throw invalid("Writer scope changed");
    return [scope.policyId];
  };
  assertScope();
  const bound = binding({
    subject: "discord-memory-writer",
    scopes: assertScope,
    writable: true,
    writePolicy: scope.policyId,
    authorizationHandle:
      work.id || work.commitId
        ? `writer:${digest(JSON.stringify([guildId, scope.policyId, work.id ?? work.commitId]))}`
        : undefined,
    generation: () => conversationWriterScope(work).generation,
  });
  const client = host.connect(bound),
    receipts = [],
    presentations = [];
  const recallBudget = {
    ...defaultBudget,
    maxAtoms: 512,
    maxCandidates: 60000,
    maxBytes: 32 * 1024 * 1024,
    maxNetworkCalls: 32,
    maxModelCalls: 32,
    maxModelInputTokens: 262144,
    maxContextTokens: 131072,
    ...(Number.isFinite(deadlineAt)
      ? { deadline: new Date(deadlineAt).toISOString() }
      : {}),
  };
  const recallClient = client.forExecution({
    ledger: new BudgetLedger(recallBudget),
  });
  const assertSource = (row) => {
    assertScope();
    if (
      !row ||
      row.deleted ||
      row.guild_id !== guildId ||
      !scope.channelIds.includes(row.channel_id)
    )
      throw invalid("Writer source is outside current scope");
    return row;
  };
  const sourceRefs = (messageId) => {
    const row = assertSource(
      db.prepare("SELECT * FROM messages WHERE message_id=?").get(messageId),
    );
    const hash = conversationSourceHash(row);
    if (
      !conversationSourcesReady([{ messageId, hash }], {
        policyId: scope.policyId,
      })
    )
      throw Object.assign(new Error("Writer source projection is pending"), {
        code: "WRITER_SOURCES_PENDING",
        retryable: true,
      });
    return storage
      .metaGet(messageKey(row.message_id, scope.policyId))
      .refs.map((ref) => host.reference(ref, bound));
  };
  const entryFor = (atom) => {
    const accepted = acceptedAtom(atom, bound, { allowPending: true });
    if (!accepted) return null;
    const evidence = [],
      evidenceRefs = [];
    for (const source of accepted.sources) {
      const row = assertSource(
        db
          .prepare("SELECT * FROM messages WHERE message_id=?")
          .get(source.messageId),
      );
      evidence.push(archiveEnvelope(row));
      evidenceRefs.push(...sourceRefs(source.messageId));
    }
    return {
      atom,
      revision: accepted.revision,
      sources: accepted.sources,
      evidence,
      evidenceRefs,
    };
  };
  const inspect = async (ref, options = {}) => {
    assertScope();
    const result = await recallClient.inspect(ref, options);
    receipts.push(result.receipt);
    const entry = entryFor(result.atom);
    const neighbors = (result.neighbors ?? []).flatMap((neighbor) => {
      const entry = entryFor(neighbor.atom);
      return entry ? [{ entry, via: neighbor.via }] : [];
    });
    const refs = [
      ...(entry ? [entry.atom.ref] : []),
      ...neighbors.map((item) => item.entry.atom.ref),
    ];
    if (refs.length) presentations.push({ receipt: result.receipt, refs });
    return {
      entry,
      neighbors,
      cursor: result.cursor,
      receipt: result.receipt,
      diagnostics: result.diagnostics,
    };
  };
  return {
    client,
    storage,
    scope,
    assertSource,
    sourceRefs,
    inspect,
    observeModelInput({ messages, sourceIds = [], inherit = [] }) {
      assertScope();
      const sources = uniqueRefs(sourceIds.flatMap(sourceRefs)).map((ref) => ({
        ref,
      }));
      const token = host.observe(
        {
          payloadDigest: digest(JSON.stringify(messages)),
          sources,
          presentations,
          inherit,
        },
        bound,
      );
      storage.flush();
      return token;
    },
    async entries(batchId, { limit = 40 } = {}) {
      const batch = storage.metaGet(`sakana:writer-batch:${batchId}`);
      if (
        !batch ||
        batch.guildId !== guildId ||
        (batch.scope?.policyId ?? policy(batch.guildId, batch.channelId)) !==
          scope.policyId ||
        !currentBatch(batch, batchId)
      )
        return [];
      const entries = [];
      for (const ref of batch.refs.slice(0, Math.min(40, Math.max(1, limit)))) {
        if (
          storage.get(
            { kind: "logical", atomId: ref.atomId },
            storage.watermark(),
          )?.revisionId !== ref.revisionId
        )
          continue;
        const { entry } = await inspect(host.reference(ref, bound), {
          limit: 0,
        });
        if (entry) entries.push(entry);
      }
      return entries;
    },
    async recall(context, state = {}) {
      assertScope();
      if (
        !db
          .prepare(
            "SELECT 1 FROM memory_writer_runs WHERE guild_id=? AND atoms>0 LIMIT 1",
          )
          .get(guildId)
      )
        return [];
      const result = await recallClient.read(
        {
          ...state,
          context: [context, state.context].filter(Boolean).join("\n"),
        },
        { tokens: 8000, depth: 2, limit: 12 },
      );
      receipts.push(result.receipt);
      const entries = result.items
        .filter((atom) => atom.provenance.origin !== "source")
        .map(entryFor)
        .filter(Boolean);
      if (entries.length)
        presentations.push({
          receipt: result.receipt,
          refs: entries.map((entry) => entry.atom.ref),
        });
      return entries;
    },
    delivery(entries) {
      const refs = uniqueRefs(
        entries.flatMap((entry) => [
          entry.atom.ref,
          ...(entry.evidenceRefs ?? []),
        ]),
      );
      return {
        refs,
        current: deliveryCurrent(
          [scope.policyId],
          entries.map((entry) => ({
            value: JSON.parse(entry.atom.text),
            revision: entry.revision,
            sources: entry.sources,
          })),
        ),
      };
    },
    assertCurrent(delivery) {
      assertScope();
      assertDeliveryCurrent(delivery, [scope.policyId], { allowPending: true });
      try {
        client
          .forExecution({ ledger: new BudgetLedger(recallBudget) })
          .assertAuthorized(receipts);
      } catch (error) {
        throw invalid(`Writer observations changed: ${error.message ?? error}`);
      }
    },
    recordUse(refs, options) {
      return recordUse(host, bound, refs, options);
    },
    checkpoint(batchId) {
      return storage.metaGet(`sakana:writer-batch:${batchId}`);
    },
    rebind(atom) {
      const value = JSON.parse(atom.text);
      let ref;
      if (value.messageId) {
        assertSource(
          db
            .prepare("SELECT * FROM messages WHERE message_id=?")
            .get(value.messageId),
        );
        const mapped = storage.metaGet(
          messageKey(value.messageId, scope.policyId),
        );
        ref = mapped.refs.find(
          (ref) =>
            storage.get(ref, storage.watermark())?.body.value === atom.text,
        );
      } else {
        const batch = storage.metaGet(`sakana:writer-batch:${value.batchId}`);
        if (!currentBatch(batch, value.batchId))
          throw invalid("Recalled Writer source changed");
        ref = batch.refs.find((ref) => ref.nodeId === value.nodeId);
      }
      if (
        !ref ||
        storage.get(ref, storage.watermark())?.body.value !== atom.text
      )
        throw invalid("Recalled Atom changed");
      return { ...atom, ref: host.reference(ref, bound) };
    },
    write(request, options = {}) {
      assertScope();
      const budget = {
        ...defaultBudget,
        maxAtoms: 2000,
        maxCandidates: 10000,
        maxBytes: 16 * 1024 * 1024,
        maxNetworkCalls: 16,
        maxModelCalls: 16,
        maxModelInputTokens: 32768,
        maxContextTokens: 8192,
        ...options.budget,
        ...(options.deadline ? { deadline: options.deadline } : {}),
      };
      return client
        .forExecution({ ledger: new BudgetLedger(budget) })
        .write(request, options);
    },
    prepare(batchId, data) {
      assertScope();
      const previous = storage.metaGet(`sakana:writer-batch:${batchId}`);
      if (previous?.committed) return;
      storage.transaction(() => {
        storage.metaSet(`sakana:writer-batch:${batchId}`, {
          ...data,
          schema: "discord.writer.checkpoint.v2",
          guildId,
          channelId,
          scope,
          refs: [],
          committed: false,
        });
        if (data.inputToken)
          storage.metaSet(`sakana:writer-input:${data.inputToken}`, batchId);
      });
    },
    requestIndex(batchId) {
      const batch = this.checkpoint(batchId);
      if (
        !batch?.committed ||
        batch.guildId !== guildId ||
        (batch.scope?.policyId ?? policy(guildId, batch.channelId)) !==
          scope.policyId
      )
        throw new Error("Uncommitted Writer index request");
      if (!batch.indexed || batch.embeddingId !== (embedding?.id ?? null))
        storage.metaSet(`sakana:writer-index-pending:${batchId}`, {
          batchId,
          guildId,
          channelId,
          scope,
        });
    },
    indexReady(batchId) {
      const batch = this.checkpoint(batchId);
      return Boolean(
        batch?.committed &&
        batch.indexed &&
        batch.embeddingId === (embedding?.id ?? null) &&
        batch.guildId === guildId &&
        conversationSourcesReady(batch.sources ?? [], {
          policyId: scope.policyId,
        }) &&
        (!batch.refs.length || currentBatch(batch, batchId)),
      );
    },
    async index(batchId) {
      if (!embedding) return { indexed: 0, disabled: true, embeddingId: null };
      const batch = this.checkpoint(batchId);
      const at = storage.watermark();
      const refs = [
        ...batch.refs
          .filter(
            (ref) =>
              storage.get({ kind: "logical", atomId: ref.atomId }, at)
                ?.revisionId === ref.revisionId,
          )
          .map((ref) => host.reference(ref, bound)),
        ...batch.sources.flatMap((source) => sourceRefs(source.messageId)),
      ];
      const result = await host.indexAtoms(refs, bound, {
        limit: 512,
        budget: {
          maxModelCalls: 512,
          maxNetworkCalls: 512,
          maxCandidates: 10000,
          maxBytes: 16000000,
          maxModelInputTokens: 1000000,
        },
        deadline: new Date(Date.now() + 120000).toISOString(),
      });
      return { ...result, embeddingId: embedding.id };
    },
    flush() {
      storage.flush();
    },
    close() {
      grants.delete(bound.auth.authorizationHandle);
    },
  };
}

export function conversationMemory({
  guildId,
  channel,
  member,
  onObservation,
  onInterpretation,
  canRecall,
  governance = false,
}) {
  if (!guildId) throw new Error("Conversation memory requires a guildId");
  if (
    !governance &&
    String(channel?.guildId ?? channel?.guild?.id) !== String(guildId)
  ) {
    throw new Error("Conversation memory channel belongs to another guild");
  }
  const { host, storage, grants } = memoryHost(guildId, { recall: true });
  const channels = () => {
    if (governance) return publicMemoryChannels(guildId);
    if (
      !channel ||
      !member ||
      !canRead(channel, member) ||
      !canRead(channel, channel.guild?.members?.me)
    )
      return [];
    if (!isDreamGuild(guildId)) return [channel.id];
    const guild = channel.guild;
    const shared = publicMemoryChannels(guildId, guild).filter((id) => {
      const target = guild.channels.cache.get(id);
      if (target)
        return canRead(target, member) && canRead(target, guild.members.me);
      const archived = db
        .prepare(
          "SELECT parent_id,is_private FROM channels WHERE channel_id=? AND guild_id=?",
        )
        .get(id, guildId);
      const parent = guild.channels.cache.get(archived?.parent_id);
      return (
        archived &&
        !archived.is_private &&
        parent &&
        canRead(parent, member) &&
        canRead(parent, guild.members.me)
      );
    });
    return [...new Set([channel.id, ...shared])];
  };
  const scopes = () => {
    const ids = channels(),
      shared = publicManifest(guildId);
    const result = ids.map((id) => policy(guildId, id));
    // Grant the whole shared graph only when every source channel remains
    // readable to this principal. Filtering a broader grant after retrieval is
    // too late: even link metadata or a generated summary could disclose it.
    const livePublic = new Set(publicMemoryChannels(guildId, channel?.guild));
    if (
      shared?.ready &&
      shared.channelIds.length &&
      shared.channelIds.every((id) => ids.includes(id) && livePublic.has(id))
    )
      result.push(shared.policyId);
    return result;
  };
  const bound = binding({
    subject: governance
      ? `institution:${guildId}`
      : `chat:${guildId}:${member?.id}`,
    scopes,
    generation: () => publicManifest(guildId)?.generation,
  });
  const client = host.connect(bound);
  let observedScopes = null;
  const receipts = [];
  const observed = new Map();
  const observedRevisions = new Map();
  const observedBatches = new Set();
  return {
    async read({ context, thought, observations = [] } = {}) {
      if (!scopes().length || canRecall?.() === false) return null;
      let result;
      try {
        result = await client.read(
          {
            context: String(context ?? "").slice(-6000),
            thought: String(thought ?? "").slice(0, 3000),
            observations: observations.map((text) =>
              String(text).slice(0, 2000),
            ),
          },
          { tokens: 16000, depth: 2, limit: 16 },
        );
      } catch (error) {
        // A reservation may exhaust the budget after this session was opened.
        // Skip optional recall for this round; new sessions use lexical recall.
        if (
          [
            "DREAM_EMBEDDING_PAUSED",
            "MODEL_BUDGET_PAUSED",
            "MODEL_BUDGET_EXHAUSTED",
          ].includes(error.code)
        )
          return null;
        throw error;
      }
      const channelIds = channels();
      const refreshQueued = await scheduleRefresh(
        client,
        result,
        bound,
        guildId,
        channelIds,
      );
      observedScopes = JSON.stringify(scopes().sort());
      receipts.push(result.receipt);
      const accepted = new Map();
      const acceptedEntries = new Map();
      for (const atom of result.items) {
        try {
          const entry = acceptedAtom(atom, bound);
          if (!entry) continue;
          const part = entry.value;
          if (
            onObservation &&
            atom.provenance.origin === "source" &&
            (!part.complete ||
              onObservation(
                JSON.parse(part.document),
                Buffer.byteLength(JSON.stringify(part)),
              ) === false)
          )
            continue;
          for (const source of entry.sources)
            observed.set(
              `${source.policyId ?? ""}\0${source.messageId}`,
              source,
            );
          if (atom.provenance.origin !== "source")
            observedBatches.add(part.batchId);
          if (entry.revision)
            observedRevisions.set(entry.revision.atomId, entry.revision);
          accepted.set(atom.ref, atom);
          acceptedEntries.set(atom.ref, entry);
        } catch {
          /* A revoked or pending source never becomes current evidence. */
        }
      }
      // Keep Atom's packed text (including shared quotes and role-bearing links),
      // rather than converting it back to a raw-message-only search result.
      // Required companions are indivisible, also when host evidence budgets fail.
      let changed;
      do {
        changed = false;
        for (const atom of accepted.values()) {
          if (
            atom.links.some((link) => link.required && !accepted.has(link.ref))
          ) {
            accepted.delete(atom.ref);
            changed = true;
          }
        }
      } while (changed);
      if (onInterpretation) {
        for (const atom of accepted.values())
          if (
            atom.provenance.origin !== "source" &&
            !onInterpretation(atom.ref, Buffer.byteLength(JSON.stringify(atom)))
          )
            accepted.delete(atom.ref);
        do {
          changed = false;
          for (const atom of accepted.values())
            if (
              atom.links.some(
                (link) => link.required && !accepted.has(link.ref),
              )
            ) {
              accepted.delete(atom.ref);
              changed = true;
            }
        } while (changed);
      }
      const packed = result.text
        ? JSON.parse(result.text)
        : { memory: [], evidence: [] };
      packed.memory = (packed.memory ?? []).filter((atom) =>
        accepted.has(atom.ref),
      );
      const quotes = new Set(
        packed.memory.flatMap((atom) => (atom.quote ? [atom.quote.ref] : [])),
      );
      packed.evidence = (packed.evidence ?? []).filter((entry) =>
        quotes.has(entry.ref),
      );
      const deliveredRefs = uniqueRefs([
        ...packed.memory.map((atom) => atom.ref),
        ...packed.evidence.map((entry) => entry.ref),
      ]);
      const deliveredEntries = deliveredRefs.flatMap((ref) =>
        acceptedEntries.has(ref) ? [acceptedEntries.get(ref)] : [],
      );
      const output = {
        ...result,
        text: JSON.stringify({
          ...packed,
          interpretation:
            "AI-generated organization is interpretation, not a direct quote, verified fact, vote or legal authority.",
          coverage: {
            ...memoryStatus({ guildId, channelIds }),
            refreshQueued,
            diagnostics: result.diagnostics,
          },
        }),
      };
      return attachMemoryDelivery(
        output,
        deliveredRefs,
        deliveryCurrent(JSON.parse(observedScopes), deliveredEntries),
      );
    },
    async assertCurrent(delivery) {
      const invalid = (message) =>
        Object.assign(new Error(message), {
          code: "AGENT_CONTEXT_INVALIDATED",
        });
      assertDeliveryCurrent(delivery, scopes());
      if (
        observedScopes !== null &&
        observedScopes !== JSON.stringify(scopes().sort())
      )
        throw invalid(
          "Conversation memory permission changed during execution",
        );
      for (const {
        messageId,
        hash: sourceHash,
        policyId,
      } of observed.values()) {
        if (
          db
            .prepare("SELECT 1 FROM memory_pending WHERE message_id = ?")
            .get(messageId) ||
          storage.metaGet(messageKey(messageId, policyId))?.hash !== sourceHash
        )
          throw invalid("Conversation source changed during execution");
      }
      for (const revision of observedRevisions.values())
        if (
          storage.get(
            { kind: "logical", atomId: revision.atomId },
            storage.watermark(),
          )?.revisionId !== revision.revisionId
        )
          throw invalid("Conversation organization changed during execution");
      for (const batchId of observedBatches)
        if (
          !currentBatch(
            storage.metaGet(`sakana:writer-batch:${batchId}`),
            batchId,
          )
        ) {
          throw invalid("Conversation organization changed during execution");
        }
      try {
        client.assertAuthorized(receipts);
      } catch (error) {
        throw invalid(String(error.message ?? error));
      }
    },
    recordUse(refs, options) {
      return recordUse(host, bound, refs, options);
    },
    close() {
      grants.delete(bound.auth.authorizationHandle);
    },
  };
}

export function startConversationMemory(client) {
  discordClient = client;
  let closed = false;
  const workers = new Map(),
    retries = new Map();
  const snapshot = () => {
    const guildIds = [...client.guilds.cache.keys()],
      readableChannels = {},
      publicChannelIds = {};
    for (const guildId of guildIds) {
      const guild = client.guilds.cache.get(guildId),
        me = guild.members.me;
      const allowed = new Set();
      if (me) {
        for (const channel of guild.channels.cache.values())
          if (canRead(channel, me)) allowed.add(channel.id);
        for (const row of db
          .prepare(
            "SELECT channel_id,parent_id,is_private FROM channels WHERE guild_id=? AND is_thread=1",
          )
          .all(guildId)) {
          const parent = guild.channels.cache.get(row.parent_id);
          if (!row.is_private && parent && canRead(parent, me))
            allowed.add(row.channel_id);
        }
      }
      readableChannels[guildId] = [...allowed].sort();
      publicChannelIds[guildId] = publicMemoryChannels(guildId, guild).sort();
    }
    return {
      guildIds,
      readableChannels,
      publicChannelIds,
      permissionGeneration: digest(
        JSON.stringify([readableChannels, publicChannelIds]),
      ),
    };
  };
  const updateGuilds = () => {
    const current = snapshot();
    for (const worker of workers.values()) worker.postMessage(current);
  };
  const events = [
    "guildCreate",
    "guildDelete",
    "channelCreate",
    "channelUpdate",
    "channelDelete",
    "threadCreate",
    "threadUpdate",
    "threadDelete",
    "threadMembersUpdate",
    "roleUpdate",
    "roleDelete",
    "guildMemberUpdate",
  ];
  for (const event of events) client.on(event, updateGuilds);
  const permissionsTimer = setInterval(updateGuilds, 30000);
  permissionsTimer.unref();
  const start = (file) => {
    if (closed) return;
    const worker = new Worker(new URL(file, import.meta.url), {
      workerData: snapshot(),
    });
    workers.set(file, worker);
    worker.on("error", (error) =>
      console.error("Conversation memory worker failed:", error),
    );
    worker.on("message", (status) => {
      if (status.embedding) {
        const { id, texts, options } = status.embedding;
        const owner = worker;
        const send = (result) => {
          try {
            owner?.postMessage({ embeddingResult: { id, ...result } });
          } catch {
            /* The requesting worker exited. */
          }
        };
        embedTexts(texts, options).then(
          (result) => send({ result }),
          (error) => send({ error: String(error.message ?? error) }),
        );
      } else
        console.log(
          file === "./dream-worker.js"
            ? "Conversation dreaming:"
            : "Conversation memory:",
          JSON.stringify(status),
        );
    });
    worker.on("exit", (code) => {
      if (!closed) {
        console.error("Conversation memory worker exited:", code);
        const retry = setTimeout(() => start(file), 5000);
        retries.set(file, retry);
        retry.unref();
      }
    });
    worker.unref();
  };
  start("./projection-worker.js");
  if (dreamConfig.enabled) start("./dream-worker.js");
  return () => {
    closed = true;
    clearInterval(permissionsTimer);
    for (const retry of retries.values()) clearTimeout(retry);
    for (const event of events) client.off(event, updateGuilds);
    for (const worker of workers.values()) void worker.terminate();
  };
}

// Priority index requests are a small durable queue (one active AI writer),
// independent of the ordinary full-history revision-feed cursor.
export async function drainConversationWriterIndex({ guildIds } = {}) {
  if (!guildIds?.length) return { indexed: 0 };
  const { storage } = memoryHost();
  const item = storage
    .metaEntries("sakana:writer-index-pending:")
    .find(([, value]) => guildIds.includes(value.guildId));
  if (!item) return { indexed: 0 };
  const [key, pending] = item;
  if (
    isDreamGuild(pending.guildId) &&
    !["0", "false", "off"].includes(process.env.MEMORY_EMBEDDINGS ?? "true")
  ) {
    try {
      dreamEmbeddingBudget(pending.guildId);
    } catch {
      return { indexed: 0, paused: true };
    }
  }
  let session;
  try {
    session = conversationWriterSession(pending);
    const batch = session.checkpoint(pending.batchId);
    if (
      !batch?.committed ||
      !conversationSourcesReady(batch.sources ?? [], {
        policyId: batch.scope?.policyId,
      }) ||
      (batch.refs.length && !currentBatch(batch, pending.batchId))
    ) {
      storage.metaDelete(key);
      return { indexed: 0, invalidated: pending.batchId };
    }
    const basis = digest(JSON.stringify([batch.refs, batch.sources]));
    const result = await session.index(pending.batchId);
    const current = session.checkpoint(pending.batchId);
    if (
      basis !== digest(JSON.stringify([current?.refs, current?.sources])) ||
      !conversationSourcesReady(current.sources ?? [], {
        policyId: current.scope?.policyId,
      }) ||
      (current.refs.length && !currentBatch(current, pending.batchId))
    ) {
      storage.metaDelete(key);
      return { indexed: 0, invalidated: pending.batchId };
    }
    storage.metaSet(`sakana:writer-batch:${pending.batchId}`, {
      ...current,
      indexed: true,
      embeddingId: result.embeddingId ?? null,
    });
    storage.flush();
    storage.metaDelete(key);
    return { ...result, writerBatchId: pending.batchId };
  } catch (error) {
    if (error.code === "AGENT_CONTEXT_INVALIDATED") {
      storage.metaDelete(key);
      storage.flush();
      return { indexed: 0, invalidated: pending.batchId };
    }
    throw error;
  } finally {
    session?.close();
  }
}

// Called by Sakana's scheduler. Atom itself owns no timer, provider or daemon.
export async function updateConversationIndex({ guildIds, limit = 32 } = {}) {
  if (!guildIds?.length) return { indexed: 0, pending: false };
  const { storage, grants } = memoryHost();
  const channels = db
    .prepare(
      `SELECT guild_id,channel_id FROM channels WHERE guild_id IN (${guildIds.map(() => "?").join(",")})`,
    )
    .all(...guildIds);
  for (const guildId of guildIds)
    if (publicManifest(guildId)?.ready)
      channels.push({ guild_id: guildId, channel_id: "public" });
  const ordered = channels.sort((a, b) =>
    a.channel_id.localeCompare(b.channel_id),
  );
  if (!ordered.length) return { indexed: 0, pending: false };
  const last = storage.metaGet("sakana:index-channel") ?? "";
  const selected = ordered.find((row) => row.channel_id > last) ?? ordered[0];
  storage.metaSet("sakana:index-channel", selected.channel_id);
  const { host, embedding } = memoryHost(selected.guild_id);
  if (!embedding) return { indexed: 0, disabled: true };
  if (isDreamGuild(selected.guild_id)) {
    try {
      dreamEmbeddingBudget(selected.guild_id);
    } catch {
      return { indexed: 0, paused: true };
    }
  }
  const bound = binding({
    subject: "discord-indexer",
    scopes: () => [policy(selected.guild_id, selected.channel_id)],
  });
  try {
    const result = await host.updateIndex(bound, {
      limit,
      budget: {
        maxModelCalls: limit,
        maxNetworkCalls: limit,
        maxModelInputTokens: 300000,
        maxCandidates: 10000,
        maxBytes: 16000000,
      },
      deadline: new Date(Date.now() + 120000).toISOString(),
    });
    storage.flush();
    return result;
  } finally {
    grants.delete(bound.auth.authorizationHandle);
  }
}
