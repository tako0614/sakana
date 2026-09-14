process.env.MEMORY_EMBEDDINGS = "0";
process.env.MEMORY_WRITER_QUIET_MS = "1";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const directory = mkdtempSync(join(tmpdir(), "sakana-memory-use-"));
process.env.ARCHIVE_DB_PATH = join(directory, "archive.sqlite");
process.env.ATOM_MEMORY_PATH = join(directory, "atoms.sqlite");
process.env.AGENT_RUNTIME_PATH = join(directory, "runs.sqlite");

const { MemoryClient, MemoryHost } =
  await import("../subprojects/atom-memory/dist/index.js");
const { attachMemoryDelivery, deliveryOf, runAgent } =
  await import("../src/ai/runtime.js");
const { db, markMessageDeleted, saveMessage } =
  await import("../src/archive/db.js");
const { toRecord } = await import("../src/archive/indexer.js");
const { chatRunId } = await import("../src/agent/index.js");
const {
  conversationMemory,
  conversationWriterSession,
  startConversationMemory,
  syncConversationMemory,
} = await import("../src/conversation/memory.js");
const { runConversationWriter } = await import("../src/conversation/writer.js");

const message = (id, content, extra = {}) => ({
  id,
  content,
  guildId: "g",
  channelId: "c",
  author: { id: "alice", username: "alice" },
  attachments: new Map(),
  createdTimestamp: 1700000000000,
  reactions: { cache: new Map() },
  ...extra,
});
const channelFor = (guild, id) => ({
  id,
  guildId: guild.id,
  guild,
  type: 0,
  isTextBased: () => true,
  permissionsFor: () => ({ has: () => true }),
});

const originalRecordUse = MemoryHost.prototype.recordUse;
const originalRead = MemoryClient.prototype.read;
const useCalls = [];
let interruptChatUse = true;
let interruptBulkUse = false;
let interruptBeforeUse = null;
let syntheticConversationPack = true;
let keptRef;

MemoryHost.prototype.recordUse = function (refs, binding, options) {
  if (interruptBeforeUse && options.eventId.includes(interruptBeforeUse)) {
    interruptBeforeUse = null;
    throw new Error("simulated crash before durable memory use");
  }
  const result = originalRecordUse.call(this, refs, binding, options);
  useCalls.push({ refs: [...refs], eventId: options.eventId, result });
  if (interruptChatUse && options.eventId.includes("resume-memory-use-chat")) {
    interruptChatUse = false;
    throw new Error("simulated crash after durable memory use");
  }
  if (interruptBulkUse && options.eventId.includes("bulk-memory-use")) {
    interruptBulkUse = false;
    throw new Error("simulated crash after first memory-use chunk");
  }
  return result;
};

// Exercise Sakana's post-pack filter independently from Atom's own packer:
// one delivered source is represented by a shared quote twice, while another
// source appears in Atom's result but is rejected by the host observation gate.
MemoryClient.prototype.read = async function (...args) {
  const result = await originalRead.apply(this, args);
  if (!syntheticConversationPack) return result;
  const byMessage = new Map(
    result.items.flatMap((atom) => {
      try {
        const part = JSON.parse(atom.text);
        return part.messageId ? [[part.messageId, atom]] : [];
      } catch {
        return [];
      }
    }),
  );
  const keep = byMessage.get("memory-keep");
  const drop = byMessage.get("memory-drop");
  assert.ok(
    keep && drop,
    "synthetic recall requires both scoped source messages",
  );
  keptRef = keep.ref;
  const { text: _text, ...quotedKeep } = keep;
  const evidence = {
    ref: keep.ref,
    unit: "utf8",
    ranges: [{ start: 0, end: Buffer.byteLength(keep.text), text: keep.text }],
  };
  return {
    ...result,
    refs: [keep.ref, drop.ref],
    text: JSON.stringify({
      memory: [
        {
          ...quotedKeep,
          quote: {
            ref: keep.ref,
            start: 0,
            end: Buffer.byteLength(keep.text),
            unit: "utf8",
          },
        },
        drop,
      ],
      evidence: [evidence, evidence],
    }),
  };
};

try {
  saveMessage(
    toRecord(message("memory-keep", "memory_use_needle KEEP_MEMORY_BODY")),
  );
  saveMessage(
    toRecord(
      message("memory-drop", "memory_use_needle DROP_MEMORY_BODY", {
        createdTimestamp: 1700000001000,
      }),
    ),
  );
  await syncConversationMemory();

  const guild = {
    id: "g",
    roles: { everyone: { id: "everyone" } },
    members: { me: { id: "bot" } },
    channels: { cache: new Map() },
  };
  const channel = channelFor(guild, "c");
  guild.channels.cache.set(channel.id, channel);
  const memoryOptions = {
    guildId: "g",
    channel,
    member: { id: "reader" },
    onObservation: (entry) => entry.id !== "memory-drop",
  };

  const probe = conversationMemory(memoryOptions);
  const packed = await probe.read({ context: "memory_use_needle" });
  const delivery = deliveryOf(packed);
  assert.deepEqual(
    delivery.refs,
    [keptRef],
    "delivery metadata comes from the final filtered memory/evidence body set and dedupes shared quotes",
  );
  assert.doesNotMatch(packed.text, /DROP_MEMORY_BODY/);
  assert.equal(useCalls.length, 0, "reading memory alone is not a use event");
  probe.close();

  let chatRequests = 0;
  const durableChatRunId = chatRunId({
    guildId: "g",
    channelId: "c",
    memberId: "reader",
    messageId: "resume-memory-use-chat",
  });
  const chatInput = {
    guildId: "g",
    runId: durableChatRunId,
    system: "s",
    userContent: "memory_use_needle",
    reuseCompleted: true,
    request: async ({ messages }) => {
      chatRequests += 1;
      assert.match(JSON.stringify(messages), /KEEP_MEMORY_BODY/);
      assert.doesNotMatch(
        JSON.stringify(messages),
        /DROP_MEMORY_BODY|memoryDelivery/,
      );
      return { choices: [{ message: { content: "chat answer" } }] };
    },
  };
  let chatMemory = conversationMemory(memoryOptions);
  await assert.rejects(
    runAgent({ ...chatInput, memory: chatMemory }),
    /simulated crash/,
  );
  chatMemory.close();
  chatMemory = conversationMemory(memoryOptions);
  const chatResult = await runAgent({
    ...chatInput,
    memory: chatMemory,
    request: async () => {
      throw new Error("durable response must resume without a model call");
    },
  });
  chatMemory.close();
  assert.equal(chatResult.text, "chat answer");
  assert.equal(chatRequests, 1);
  const chatUses = useCalls.filter((entry) =>
    entry.eventId.includes("resume-memory-use-chat"),
  );
  assert.equal(chatUses.length, 2);
  assert.deepEqual(
    chatUses.map((entry) => entry.result),
    [
      { acceptedAt: chatUses[0].result.acceptedAt, recorded: 1, repeated: 0 },
      { acceptedAt: chatUses[1].result.acceptedAt, recorded: 0, repeated: 1 },
    ],
    "the resumed auth handle repeats the same subject/policy/revision/event tuple",
  );
  assert.deepEqual(chatUses[0].refs, [keptRef]);
  assert.equal(chatUses[0].eventId, chatUses[1].eventId);
  assert.match(chatUses[0].eventId, /:model:0$/);

  // Writer recall can retain more refs than Atom accepts in one host call.
  // Sakana chunks one durable event, and a crash after the first committed
  // chunk replays it idempotently before recording the untouched remainder.
  const bulkIds = Array.from(
    { length: 300 },
    (_, index) => `bulk-memory-${index}`,
  );
  for (const [index, id] of bulkIds.entries())
    saveMessage(
      toRecord(
        message(id, `bulk delivered memory body ${index}`, {
          guildId: "bulk-g",
          channelId: "bulk-c",
          createdTimestamp: 1750000000000 + index,
        }),
      ),
    );
  await syncConversationMemory({ messageIds: bulkIds });
  let bulkSession = conversationWriterSession({
    guildId: "bulk-g",
    channelId: "bulk-c",
  });
  const bulkRefs = [
    ...new Set(bulkIds.flatMap((id) => bulkSession.sourceRefs(id))),
  ];
  assert.equal(
    bulkRefs.length,
    300,
    "the test must deliver more than Atom host.maxBatch refs",
  );
  const bulkText = bulkIds
    .map((id, index) => `${id}: bulk delivered memory body ${index}`)
    .join("\n");
  const bulkMemory = (session) => ({
    read: async () => attachMemoryDelivery({ text: bulkText }, bulkRefs),
    assertCurrent: (delivery) => session.assertCurrent(delivery),
    recordUse: (refs, options) => session.recordUse(refs, options),
  });
  let bulkRequests = 0;
  const bulkInput = {
    guildId: "bulk-g",
    runId: "bulk-memory-use",
    system: "s",
    userContent: "u",
    reuseCompleted: true,
    request: async () => {
      bulkRequests += 1;
      return { choices: [{ message: { content: "bulk answer" } }] };
    },
  };
  interruptBulkUse = true;
  await assert.rejects(
    runAgent({ ...bulkInput, memory: bulkMemory(bulkSession) }),
    /simulated crash after first memory-use chunk/,
  );
  bulkSession.close();
  bulkSession = conversationWriterSession({
    guildId: "bulk-g",
    channelId: "bulk-c",
  });
  const bulkResult = await runAgent({
    ...bulkInput,
    memory: bulkMemory(bulkSession),
    request: async () => {
      throw new Error("chunk resume must not call the provider");
    },
  });
  bulkSession.close();
  assert.equal(bulkResult.text, "bulk answer");
  assert.equal(
    bulkRequests,
    1,
    "partial use acknowledgement resumes without another paid model call",
  );
  const bulkCalls = useCalls.filter((entry) =>
    entry.eventId.includes("bulk-memory-use"),
  );
  assert.deepEqual(
    bulkCalls.map((entry) => entry.refs.length),
    [256, 256, 44],
  );
  assert.ok(bulkCalls.every((entry) => entry.eventId === bulkCalls[0].eventId));
  assert.deepEqual(
    bulkCalls[1].refs,
    bulkCalls[0].refs,
    "resume retries the first committed chunk",
  );
  assert.deepEqual(
    bulkCalls.map((entry) => [entry.result.recorded, entry.result.repeated]),
    [
      [256, 0],
      [0, 256],
      [44, 0],
    ],
  );
  assert.equal(new Set(bulkCalls.flatMap((entry) => entry.refs)).size, 300);
  assert.equal(
    bulkCalls.reduce((sum, entry) => sum + entry.result.recorded, 0),
    300,
    "each delivered revision is credited exactly once across the partial retry",
  );

  // Governance receives the same canonical source under its institution
  // subject. Its first event remains independent from the member chat event.
  const client = new EventEmitter();
  client.guilds = { cache: new Map([["g", guild]]) };
  const stopMemoryWorker = startConversationMemory(client);
  stopMemoryWorker();
  const institutionMemory = conversationMemory({
    guildId: "g",
    governance: true,
    onObservation: (entry) => entry.id !== "memory-drop",
  });
  await runAgent({
    guildId: "g",
    runId: "governance-memory-use",
    system: "s",
    userContent: "memory_use_needle",
    memory: institutionMemory,
    request: async () => ({
      choices: [{ message: { content: "institution answer" } }],
    }),
  });
  institutionMemory.close();
  const institutionUse = useCalls.find((entry) =>
    entry.eventId.includes("governance-memory-use"),
  );
  assert.ok(institutionUse);
  assert.deepEqual(institutionUse.refs, [keptRef]);
  assert.equal(
    institutionUse.result.recorded,
    1,
    "institution and member activation are isolated even for the same revision and policy",
  );

  // A saved response is not enough to authorize a delayed notification. If its
  // delivered source is purged before resume, Sakana rejects the checkpoint
  // before either recordUse or another provider call.
  syntheticConversationPack = false;
  saveMessage(
    toRecord(
      message("memory-purge", "purge_use_needle body", {
        createdTimestamp: 1700000002000,
      }),
    ),
  );
  await syncConversationMemory();
  interruptBeforeUse = "purged-memory-use";
  let purgeRequests = 0;
  let purgeMemory = conversationMemory({
    guildId: "g",
    channel,
    member: { id: "reader" },
  });
  const purgeInput = {
    guildId: "g",
    runId: "purged-memory-use",
    system: "s",
    userContent: "purge_use_needle",
    memory: purgeMemory,
    request: async () => {
      purgeRequests += 1;
      return {
        choices: [{ message: { content: "answer from soon-purged memory" } }],
      };
    },
  };
  await assert.rejects(
    runAgent(purgeInput),
    /simulated crash before durable memory use/,
  );
  purgeMemory.close();
  markMessageDeleted("memory-purge");
  await syncConversationMemory();
  const callsBeforePurgedResume = useCalls.length;
  purgeMemory = conversationMemory({
    guildId: "g",
    channel,
    member: { id: "reader" },
  });
  await assert.rejects(
    runAgent({
      ...purgeInput,
      memory: purgeMemory,
      request: async () => {
        throw new Error("purged response must not call the provider");
      },
    }),
    { code: "AGENT_CONTEXT_INVALIDATED" },
  );
  purgeMemory.close();
  assert.equal(purgeRequests, 1);
  assert.equal(
    useCalls.length,
    callsBeforePurgedResume,
    "purged delivered memory receives no delayed credit",
  );

  // The Writer uses the same runtime path for its automatic recall and its
  // explicit memory_search result. Only messages retained for the next model
  // round enter that round's final deduplicated ref set.
  saveMessage(
    toRecord(
      message("writer-base", "writer_use_topic: base source", {
        guildId: "writer-g",
        channelId: "writer-c",
        createdTimestamp: 1800000000000,
      }),
    ),
  );
  const writerPlan = (messages, text, source) => ({
    changes: [{ id: "a1", op: "create", text, sources: [source], links: [] }],
    sourceOutcomes: JSON.parse(
      messages.find((message) => message.role === "user").content,
    ).targets.map((target) => ({
      ...target,
      outcome: "incorporated",
      refs: ["a1"],
    })),
    continuation: null,
  });
  await runConversationWriter({
    guildIds: ["writer-g"],
    now: Date.now() + 1000000,
    request: async ({ messages }) => ({
      choices: [
        {
          message: {
            content: JSON.stringify(
              writerPlan(
                messages,
                "writer_use_topic: established organization",
                "writer-base",
              ),
            ),
          },
        },
      ],
    }),
  });
  saveMessage(
    toRecord(
      message("writer-next", "writer_use_topic: next source", {
        guildId: "writer-g",
        channelId: "writer-c",
        createdTimestamp: 1800000001000,
      }),
    ),
  );
  let writerRequests = 0;
  await runConversationWriter({
    guildIds: ["writer-g"],
    now: Date.now() + 2000000,
    request: async ({ messages }) => {
      writerRequests += 1;
      const reference =
        messages.findLast((entry) =>
          entry.content?.startsWith("REFERENCE MEMORY"),
        )?.content ?? "";
      assert.match(reference, /established organization/);
      assert.doesNotMatch(JSON.stringify(messages), /memoryDelivery/);
      if (writerRequests === 1)
        return {
          choices: [
            {
              message: {
                tool_calls: [
                  {
                    id: "writer-memory-1",
                    function: {
                      name: "memory_search",
                      arguments: '{"query":"writer_use_topic"}',
                    },
                  },
                ],
              },
            },
          ],
        };
      assert.match(
        messages.find((entry) => entry.role === "tool")?.content ?? "",
        /established organization/,
        "the retained memory_search body is delivered to the next model round",
      );
      return {
        choices: [
          {
            message: {
              content: JSON.stringify(
                writerPlan(
                  messages,
                  "writer_use_topic: organization used in a later batch",
                  "writer-next",
                ),
              ),
            },
          },
        ],
      };
    },
  });
  assert.equal(writerRequests, 3);
  const writerUses = useCalls.filter((entry) =>
    entry.eventId.includes("conversation-writer:"),
  );
  assert.equal(writerUses.length, 3);
  assert.match(writerUses[0].eventId, /:model:0$/);
  assert.match(writerUses[1].eventId, /:model:1$/);
  for (const entry of writerUses) {
    assert.equal(
      new Set(entry.refs).size,
      entry.refs.length,
      "one Writer round dedupes automatic and tool deliveries",
    );
    assert.ok(entry.refs.length > 0);
    assert.equal(entry.result.recorded, entry.refs.length);
  }

  // A provider failure after a delivered read never reaches recordUse.
  const beforeFailure = useCalls.length;
  const failedMemory = {
    read: async () =>
      attachMemoryDelivery({ text: "failed request memory" }, [
        "not-an-atom-ref",
      ]),
    assertCurrent: async () => {},
    recordUse: () => {
      throw new Error("recordUse must not run");
    },
  };
  await assert.rejects(
    runAgent({
      guildId: "g",
      runId: "failed-provider-use",
      system: "s",
      userContent: "u",
      memory: failedMemory,
      request: async () => {
        throw new Error("provider request failed");
      },
    }),
    /provider request failed/,
  );
  assert.equal(useCalls.length, beforeFailure);

  console.log(
    "memory use: filtered delivery, durable ack, chat/institution isolation and Writer tool retention passed",
  );
} finally {
  MemoryHost.prototype.recordUse = originalRecordUse;
  MemoryClient.prototype.read = originalRead;
  db.close();
  rmSync(directory, { recursive: true, force: true });
}
