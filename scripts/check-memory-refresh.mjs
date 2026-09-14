process.env.MEMORY_EMBEDDINGS = "0";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const directory = mkdtempSync(join(tmpdir(), "sakana-refresh-"));
process.env.ARCHIVE_DB_PATH = join(directory, "archive.sqlite");
process.env.ATOM_MEMORY_PATH = join(directory, "atoms.sqlite");
process.env.AGENT_RUNTIME_PATH = join(directory, "runs.sqlite");
process.env.MEMORY_WRITER_QUIET_MS = "1";
const { db, saveMessage } = await import("../src/archive/db.js");
const { toRecord } = await import("../src/archive/indexer.js");
const { conversationMemory, conversationWriterSession } =
  await import("../src/conversation/memory.js");
const { runConversationWriter, writerStatus } =
  await import("../src/conversation/writer.js");
const { runAgent } = await import("../src/ai/runtime.js");
const channel = {
  id: "c",
  guild: { id: "g", members: { me: { id: "bot" } } },
  permissionsFor: () => ({ has: () => true }),
};
const reader = () =>
  conversationMemory({ guildId: "g", channel, member: { id: "viewer" } });
let calls = 0;
const request = async ({ messages, final }) => {
  if (final) calls++;
  const targets = JSON.parse(
    messages.find((message) => message.role === "user").content,
  ).targets;
  return {
    choices: [
      {
        message: {
          content: JSON.stringify({
            changes: [
              {
                id: "a1",
                op: "create",
                text: `refresh_topic: interpretation ${calls}`,
                sources: ["original"],
                links: [],
              },
              {
                id: "a2",
                op: "create",
                text: `refresh_topic: group ${calls}`,
                sources: ["original"],
                links: [
                  {
                    role: "member",
                    target: "a1",
                    at: "logical",
                    required: false,
                  },
                ],
              },
            ],
            sourceOutcomes: targets.map((target) => ({
              ...target,
              outcome: "incorporated",
              refs: ["a1", "a2"],
            })),
            continuation: null,
          }),
        },
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 20 },
  };
};
let session;
try {
  saveMessage(
    toRecord({
      id: "original",
      content: "refresh_topic: community proposal",
      guildId: "g",
      channelId: "c",
      author: { id: "alice", username: "alice" },
      attachments: new Map(),
      createdTimestamp: 1700000000000,
      reactions: { cache: new Map() },
    }),
  );
  const first = await runConversationWriter({
    guildIds: ["g"],
    now: Date.now() + 1000,
    request,
  });
  assert.equal(calls, 1);
  assert.equal(writerStatus(["g"]).pending, 0);
  session = conversationWriterSession({ guildId: "g", channelId: "c" });
  const entries = await session.recall("refresh_topic");
  const claim = entries.find(
    (entry) => JSON.parse(entry.atom.text).nodeId === "a1",
  ).atom;
  // Make the group genuinely derived from an observed claim in a separate
  // generation. Merely sharing an atomic write never creates this dependency.
  const group = entries.find(
    (entry) => JSON.parse(entry.atom.text).nodeId === "a2",
  ).atom;
  await session.inspect(claim.ref, { limit: 0 });
  const groupInput = session.observeModelInput({
    messages: [{ role: "user", content: claim.text }],
    sourceIds: ["original"],
  });
  const sources = session.checkpoint(first.completedBatch).sources;
  session.prepare("dependent-group", { sources, inputToken: groupInput });
  await session.write({
    changes: [
      {
        id: "a2",
        op: "revise",
        target: group.ref,
        input: groupInput,
        sources: group.sources,
        content: {
          text: JSON.stringify({
            ...JSON.parse(group.text),
            batchId: "dependent-group",
          }),
          links: [],
        },
      },
    ],
  });
  session.close();
  const inFlight = reader();
  await inFlight.read({ context: "refresh_topic" });
  session = conversationWriterSession({
    id: "revise-claim",
    guildId: "g",
    channelId: "c",
  });
  const liveClaim = (await session.recall("refresh_topic")).find(
    (entry) => JSON.parse(entry.atom.text).nodeId === "a1",
  ).atom;
  const claimInput = session.observeModelInput({
    messages: [{ role: "user", content: liveClaim.text }],
    sourceIds: ["original"],
  });
  session.prepare("revised-claim", { sources, inputToken: claimInput });
  await session.write({
    changes: [
      {
        id: "a1",
        op: "revise",
        target: liveClaim.ref,
        input: claimInput,
        sources: liveClaim.sources,
        content: {
          text: JSON.stringify({
            ...JSON.parse(liveClaim.text),
            batchId: "revised-claim",
            text: "refresh_topic: revised claim",
          }),
          links: [],
        },
      },
    ],
  });
  await assert.rejects(inFlight.assertCurrent(), /organization changed/);
  inFlight.close();
  db.exec(`CREATE TRIGGER fail_refresh BEFORE INSERT ON memory_writer_pending
    BEGIN SELECT RAISE(ABORT, 'refresh queue unavailable'); END`);
  const failed = reader();
  await assert.rejects(
    failed.read({ context: "refresh_topic" }),
    /refresh queue unavailable/,
  );
  failed.close();
  assert.equal(
    db
      .prepare(
        "SELECT count(*) n FROM memory_projection_state WHERE key LIKE 'writer-refresh:%'",
      )
      .get().n,
    0,
    "a failed queue write must not consume the refresh request",
  );
  db.exec("DROP TRIGGER fail_refresh");
  const a = reader();
  const recalled = await a.read({ context: "refresh_topic" });
  assert.ok(recalled.stale.length);
  assert.equal(JSON.parse(recalled.text).coverage.refreshQueued, 1);
  assert.equal(calls, 1, "recall never calls the Writer model");
  assert.equal(writerStatus(["g"]).pending, 1);
  assert.doesNotMatch(recalled.text, /group 1/);
  a.close();
  const pending = db.prepare("SELECT * FROM memory_writer_pending").all();
  const b = reader();
  await b.read({ context: "refresh_topic" });
  b.close();
  assert.deepEqual(
    db.prepare("SELECT * FROM memory_writer_pending").all(),
    pending,
    "repeated recall neither resets retry timing nor creates another refresh",
  );
  const other = conversationMemory({
    guildId: "other",
    channel: { ...channel, guild: { ...channel.guild, id: "other" } },
    member: { id: "viewer" },
  });
  assert.doesNotMatch(
    (await other.read({ context: "refresh_topic" })).text,
    /community proposal/,
  );
  other.close();
  assert.equal(writerStatus(["other"]).pending, 0);
  const next = await runConversationWriter({
    guildIds: ["g"],
    now: Date.now() + 100000,
    request,
  });
  assert.notEqual(
    next.completedBatch,
    first.completedBatch,
    "unchanged sources may need a new AI organization",
  );
  assert.equal(calls, 2);
  assert.equal(writerStatus(["g"]).pending, 0);
  const c = reader();
  assert.match(
    (await c.read({ context: "refresh_topic" })).text,
    /interpretation 2/,
  );
  c.close();
  assert.equal(
    writerStatus(["g"]).pending,
    0,
    "old stale nodes do not trigger endless paid refreshes",
  );

  let reads = 0,
    requests = 0;
  const focuses = [];
  await runAgent({
    guildId: "g",
    runId: "refresh-focus",
    system: "test",
    userContent: "question",
    maximumSteps: 4,
    toolset: {
      definitions: [
        {
          type: "function",
          function: { name: "lookup", parameters: { type: "object" } },
        },
      ],
      readOnly: true,
      call: async () => "",
    },
    memory: {
      async read(state) {
        focuses.push(state);
        return { text: `memory_step_${++reads}` };
      },
    },
    request: async ({ messages }) => {
      requests++;
      const blocks = messages.filter((message) =>
        message.content?.startsWith("REFERENCE MEMORY"),
      );
      assert.equal(blocks.length, 1);
      assert.ok(blocks[0].content.endsWith(`memory_step_${requests}`));
      return requests === 1
        ? {
            choices: [
              {
                message: {
                  tool_calls: [
                    {
                      id: "focus",
                      function: {
                        name: "memory_focus",
                        arguments:
                          '{"context":"new focus","thought":"explicit state"}',
                      },
                    },
                  ],
                },
              },
            ],
          }
        : { choices: [{ message: { content: "answer" } }] };
    },
  });
  assert.equal(reads, 2);
  assert.match(focuses[1].context, /user: question/);
  assert.doesNotMatch(focuses[1].context, /new focus|explicit state/);
  assert.match(focuses[1].thought, /memory_focus.context: new focus/);
  assert.match(focuses[1].thought, /memory_focus.thought: explicit state/);
  assert.deepEqual(focuses[1].observations, []);
  console.log(
    "memory refresh: host queue, deduplication, Writer execution, scope and per-step recall passed",
  );
} finally {
  session?.close();
  db.close();
  rmSync(directory, { recursive: true, force: true });
}
