import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const dir = mkdtempSync(join(tmpdir(), "sakana-projection-race-"));
Object.assign(process.env, {
  ARCHIVE_DB_PATH: join(dir, "archive.sqlite"),
  ATOM_MEMORY_PATH: join(dir, "atoms.sqlite"),
  MEMORY_EMBEDDINGS: "0",
});
const { db, saveMessage } = await import("../src/archive/db.js");
const { toRecord } = await import("../src/archive/indexer.js");
const { MemoryClient } =
  await import("../subprojects/atom-memory/dist/index.js");
const {
  setConversationPublicChannels,
  syncConversationMemory,
  conversationWriterSession,
  drainConversationWriterIndex,
} = await import("../src/conversation/memory.js");
const original = MemoryClient.prototype.write;
let session;
try {
  for (const stage of ["before", "after"]) {
    setConversationPublicChannels({
      guildId: "g",
      channelIds: ["a", "b"],
      permissionGeneration: stage,
    });
    saveMessage(
      toRecord({
        id: stage,
        guildId: "g",
        channelId: "b",
        content: `RACE_SECRET_${stage}`,
        author: { id: "author", username: "author" },
        attachments: new Map(),
        createdTimestamp: 1700000000000,
      }),
    );
    let reached, release;
    const paused = new Promise((resolve) => {
      reached = resolve;
    });
    const resume = new Promise((resolve) => {
      release = resolve;
    });
    MemoryClient.prototype.write = async function (request, options) {
      const content = request.changes?.[0]?.content?.text ?? "";
      const match = content.includes(
        `discord:g:public:discord-source:${stage}:`,
      );
      if (match && stage === "before") {
        reached();
        await resume;
      }
      const result = await original.call(this, request, options);
      if (match && stage === "after") {
        reached();
        await resume;
      }
      return result;
    };
    const projection = syncConversationMemory({ messageIds: [stage] });
    await paused;
    setConversationPublicChannels({
      guildId: "g",
      channelIds: ["a"],
      permissionGeneration: `revoked-${stage}`,
    });
    release();
    await assert.rejects(
      projection,
      /scope changed|not committed|unavailable|Access denied/i,
    );
    MemoryClient.prototype.write = original;
    session = conversationWriterSession({
      id: `reader-${stage}`,
      guildId: "g",
      channelId: "a",
    });
    assert.equal(
      session.storage.metaGet(`sakana:public-message:${stage}`),
      undefined,
    );
    const graph = session.storage.scan(
      { policies: ["discord:g:public"], limit: 100 },
      session.storage.watermark(),
    );
    assert.ok(
      graph.every((atom) => !atom.body.value?.includes(`RACE_SECRET_${stage}`)),
      "revocation cannot leave an orphan public source",
    );
    assert.ok(
      db.prepare("SELECT 1 FROM memory_pending WHERE message_id=?").get(stage),
      "raced projection stays queued",
    );
    session.close();
  }
  setConversationPublicChannels({
    guildId: "g",
    channelIds: ["a"],
    permissionGeneration: "index-one",
  });
  session = conversationWriterSession({
    id: "index-one",
    guildId: "g",
    channelId: "a",
  });
  session.prepare("stale-index", { sources: [] });
  session.storage.metaSet("sakana:writer-batch:stale-index", {
    ...session.checkpoint("stale-index"),
    committed: true,
  });
  session.requestIndex("stale-index");
  session.close();
  setConversationPublicChannels({
    guildId: "g",
    channelIds: ["a"],
    permissionGeneration: "index-two",
  });
  session = conversationWriterSession({
    id: "index-two",
    guildId: "g",
    channelId: "a",
  });
  session.prepare("valid-index", { sources: [] });
  session.storage.metaSet("sakana:writer-batch:valid-index", {
    ...session.checkpoint("valid-index"),
    committed: true,
  });
  session.requestIndex("valid-index");
  assert.equal(
    (await drainConversationWriterIndex({ guildIds: ["g"] })).invalidated,
    "stale-index",
  );
  assert.equal(
    (await drainConversationWriterIndex({ guildIds: ["g"] })).writerBatchId,
    "valid-index",
  );
  assert.equal(session.indexReady("valid-index"), true);
  console.log(
    "projection race: before/after append revocation, no public orphan, queued retry and stale index marker recovery passed",
  );
} finally {
  MemoryClient.prototype.write = original;
  session?.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
}
