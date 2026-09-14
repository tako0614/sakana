import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const dir = mkdtempSync(join(tmpdir(), "sakana-public-writer-"));
Object.assign(process.env, {
  ARCHIVE_DB_PATH: join(dir, "archive.sqlite"),
  ATOM_MEMORY_PATH: join(dir, "atoms.sqlite"),
  AGENT_RUNTIME_PATH: join(dir, "runs.sqlite"),
  MEMORY_EMBEDDINGS: "0",
  MEMORY_DREAMING_ENABLED: "1",
  MEMORY_DREAMING_GUILDS: "g",
});
const { db, saveMessage } = await import("../src/archive/db.js");
const { toRecord } = await import("../src/archive/indexer.js");
const {
  conversationWriterSession,
  conversationMemory,
  conversationSourceHash,
  syncConversationMemory,
  conversationWriterScope,
  setConversationPublicChannels,
  enumerateConversationReviewTargets,
} = await import("../src/conversation/memory.js");
const row = (id) =>
  db.prepare("SELECT * FROM messages WHERE message_id=?").get(id);
const add = (id, channelId, text) =>
  saveMessage(
    toRecord({
      id,
      guildId: "g",
      channelId,
      content: text,
      author: { id: "person", username: "person" },
      attachments: new Map(),
      createdTimestamp: 1700000000000,
    }),
  );
let session;
try {
  add("one", "a", "Alpha event");
  add("two", "b", "Beta condition");
  add("secret", "private", "PRIVATE_EVIDENCE");
  setConversationPublicChannels({
    guildId: "g",
    channelIds: ["a", "b"],
    permissionGeneration: "initial",
  });
  await syncConversationMemory({ limit: 100 });
  const work = {
    id: "public-episode",
    guildId: "g",
    channelId: "a",
    scope: conversationWriterScope({ guildId: "g", channelId: "a" }),
  };
  session = conversationWriterSession(work);
  assert.deepEqual(session.scope.channelIds, ["a", "b"]);
  assert.throws(() => session.sourceRefs("secret"), /outside current scope/);
  const sources = ["one", "two"].map((messageId) => ({
    messageId,
    hash: conversationSourceHash(row(messageId)),
  }));
  session.prepare("public-commit", { sources });
  const input = session.observeModelInput({
    messages: [{ role: "user", content: "Alpha event. Beta condition." }],
    sourceIds: ["one", "two"],
  });
  const citations = ["one", "two"]
    .flatMap((id) => session.sourceRefs(id))
    .map((ref) => ({ ref }));
  const request = {
    changes: [
      {
        id: "event",
        op: "create",
        input,
        sources: citations,
        content: {
          text: JSON.stringify({
            schema: "discord.memory.v2",
            batchId: "public-commit",
            nodeId: "event",
            text: "CROSS_JOIN: Alpha requires Beta",
          }),
          links: {},
        },
      },
      {
        id: "group",
        op: "create",
        input,
        sources: citations,
        content: {
          text: JSON.stringify({
            schema: "discord.memory.v2",
            batchId: "public-commit",
            nodeId: "group",
            text: "Event organization",
          }),
          links: { member: { local: "event" } },
        },
      },
    ],
  };
  const committed = await session.write(request, {
    idempotencyKey: "stable-public-plan",
  });
  session.flush();
  session.close();
  session = conversationWriterSession(work);
  const replay = await session.write(request, {
    idempotencyKey: "stable-public-plan",
  });
  assert.equal(replay.repeated, true);
  assert.equal(replay.operationId, committed.operationId);
  assert.equal(session.checkpoint("public-commit").refs.length, 2);
  const inspected = await session.inspect(replay.changes.event.ref, {
    direction: "incoming",
  });
  assert.equal(
    inspected.neighbors.length,
    1,
    "unknown parent becomes discoverable from its child",
  );
  assert.match(inspected.neighbors[0].entry.atom.text, /Event organization/);
  assert.equal(inspected.neighbors[0].via[0].direction, "incoming");
  const reviews = enumerateConversationReviewTargets({
    guildId: "g",
    scope: session.scope,
  });
  assert.equal(reviews.length, 2);
  assert.ok(
    reviews.every(
      (target) =>
        target.fingerprint &&
        target.version &&
        target.payload.sources.length === 2,
    ),
  );
  const everyone = { id: "everyone" },
    bot = { id: "bot" },
    member = { id: "reader" };
  let memberCanReadB = true;
  const guild = {
    id: "g",
    roles: { everyone },
    members: { me: bot },
    channels: { cache: new Map() },
  };
  for (const id of ["a", "b", "private"])
    guild.channels.cache.set(id, {
      id,
      guildId: "g",
      guild,
      type: 0,
      isTextBased: () => true,
      permissionsFor: (who) => ({
        has: () =>
          who === everyone
            ? id !== "private"
            : !(who === member && id === "b" && !memberCanReadB),
      }),
    });
  const reader = () =>
    conversationMemory({
      guildId: "g",
      channel: guild.channels.cache.get("a"),
      member,
    });
  let memory = reader();
  assert.match(
    (await memory.read({ context: "CROSS_JOIN Alpha Beta" })).text,
    /CROSS_JOIN/,
  );
  assert.doesNotMatch(
    (await memory.read({ context: "PRIVATE_EVIDENCE" })).text,
    /PRIVATE_EVIDENCE/,
  );
  memberCanReadB = false;
  await assert.rejects(
    memory.assertCurrent(),
    /permission changed|authorization|current/,
  );
  memory.close();
  memory = reader();
  assert.doesNotMatch(
    (await memory.read({ context: "CROSS_JOIN" })).text,
    /CROSS_JOIN:/,
  );
  memory.close();
  setConversationPublicChannels({
    guildId: "g",
    channelIds: ["a"],
    permissionGeneration: "private-b",
  });
  assert.throws(() => session.assertSource(row("one")), /scope changed/);
  session.close();
  session = conversationWriterSession({
    id: "new-scope",
    guildId: "g",
    channelId: "a",
  });
  assert.throws(() => session.sourceRefs("two"), /outside current scope/);
  assert.equal(
    enumerateConversationReviewTargets({ guildId: "g", scope: session.scope })
      .length,
    0,
    "revoked source purges generated public dependencies",
  );
  console.log(
    "public Writer: shared source policy, one-hop discovery, durable batch replay, principal exclusion, permission revocation passed",
  );
} finally {
  session?.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
}
