process.env.MEMORY_EMBEDDINGS = '0';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const directory = mkdtempSync(join(tmpdir(), 'sakana-writer-'));
process.env.ARCHIVE_DB_PATH = join(directory, 'archive.sqlite');
process.env.ATOM_MEMORY_PATH = join(directory, 'atoms.sqlite');
process.env.AGENT_RUNTIME_PATH = join(directory, 'runs.sqlite');
process.env.MEMORY_WRITER_QUIET_MS = '1';

const { db, saveMessage } = await import('../src/archive/db.js');
const { toRecord } = await import('../src/archive/indexer.js');
const {
  conversationMemory
} = await import('../src/conversation/memory.js');
const {
  runConversationWriter,
  validateWriterPlan,
  writerStatus
} = await import('../src/conversation/writer.js');
const { SqliteStorage } = await import('../subprojects/atom-memory/dist/adapters/sqlite.js');
const { MemoryClient } = await import('../subprojects/atom-memory/dist/index.js');

function rawMessage(id, content, {
  guildId = 'g',
  channelId = 'c',
  authorId = 'alice',
  createdAt = 1700000000000,
  editedAt = null,
  replyTo = null
} = {}) {
  return {
    id,
    content,
    guildId,
    channelId,
    author: { id: authorId, username: authorId },
    attachments: new Map(),
    reactions: { cache: new Map() },
    createdTimestamp: createdAt,
    ...(editedAt === null ? {} : { editedTimestamp: editedAt }),
    ...(replyTo ? { reference: { messageId: replyTo, channelId } } : {})
  };
}

function save(message) {
  saveMessage(toRecord(message));
}

function writerInput(messages) {
  for (const message of messages) {
    try {
      const value = JSON.parse(message.content);
      if (value.schema === 'sakana.writer.input.v2') return value;
    } catch {
      // Provider messages include prompts and transient memory blocks too.
    }
  }
  throw new Error('Writer input was not supplied to the provider');
}

function incorporatedPlan(input, text = 'event') {
  const ids = input.targets.map((target) => target.messageId);
  return {
    changes: [
      {
        id: 'a1',
        op: 'create',
        text: text + ': Alice proposed automated bans under discussion.',
        sources: ids,
        links: [{ role: 'related', target: 'a2', at: 'logical', required: false }]
      },
      {
        id: 'a2',
        op: 'create',
        text: text + ': Bob opposed automation and required manual administrator action.',
        sources: ids,
        links: [{ role: 'counter-position', target: 'a1', at: 'logical', required: false }]
      }
    ],
    sourceOutcomes: input.targets.map((target) => ({
      messageId: target.messageId,
      generation: target.generation,
      outcome: 'incorporated',
      refs: ['a1', 'a2']
    })),
    continuation: null
  };
}

const channel = {
  id: 'c',
  guild: { id: 'g', members: { me: { id: 'bot' } } },
  permissionsFor: () => ({ has: () => true })
};

try {
  const targets = [{ messageId: 'one', generation: 4 }];
  assert.throws(() => validateWriterPlan({
    changes: [],
    sourceOutcomes: [],
    continuation: null
  }, { targets, sourceIds: ['one'] }), /every target/i);
  assert.throws(() => validateWriterPlan({
    changes: [{
      id: 'a1',
      op: 'create',
      text: 'unissued source',
      sources: ['secret'],
      links: []
    }],
    sourceOutcomes: [{
      messageId: 'one',
      generation: 4,
      outcome: 'incorporated',
      refs: ['a1']
    }],
    continuation: null
  }, { targets, sourceIds: ['one'] }), /issued sources/i);
  assert.doesNotThrow(() => validateWriterPlan({
    changes: [{
      id: 'a1',
      op: 'create',
      text: 'ordinary context does not need a kind',
      sources: ['one'],
      links: [{ role: 'self-cycle', target: 'a1', at: 'logical', required: false }]
    }],
    sourceOutcomes: [{
      messageId: 'one',
      generation: 4,
      outcome: 'incorporated',
      refs: ['a1']
    }],
    continuation: null
  }, { targets, sourceIds: ['one'] }));
  assert.doesNotThrow(() => validateWriterPlan({
    changes: [],
    sourceOutcomes: [{
      messageId: 'one',
      generation: 4,
      outcome: 'context_only',
      refs: []
    }],
    continuation: null
  }, { targets, sourceIds: ['one'] }));

  save(rawMessage('proposal', 'Botがbanを自動実行する案。'));
  save(rawMessage('correction', '反対。banは管理者が手動実行する。', {
    authorId: 'bob',
    createdAt: 1700000001000,
    replyTo: 'proposal'
  }));
  save(rawMessage('secret', 'OTHER_GUILD_SECRET', {
    guildId: 'other',
    channelId: 'other'
  }));

  let calls = 0;
  const request = async ({ messages, consumeRequest, model }) => {
    await consumeRequest({ model });
    calls += 1;
    const input = writerInput(messages);
    assert.ok(input.messages.every((row) =>
      row.location.guildId === 'g' && row.location.channelId === 'c'));
    assert.equal(
      input.messages.find((row) => row.id === 'correction').reference.messageId,
      'proposal'
    );
    return {
      choices: [{
        message: { content: JSON.stringify(incorporatedPlan(input, 'golden_semantic')) }
      }],
      usage: { prompt_tokens: 20, completion_tokens: 10 }
    };
  };

  const first = await runConversationWriter({
    guildIds: ['g'],
    now: Date.now() + 1000,
    request
  });
  assert.equal(first.pending, 0, JSON.stringify(first));
  assert.equal(first.batchAtoms, 2);
  assert.equal(calls, 2, 'exploration and capability-closed final are separate generations');
  assert.equal(writerStatus(['other']).pending, 1);

  const storage = new SqliteStorage(process.env.ATOM_MEMORY_PATH);
  const revisions = storage.scan(
    { policies: ['discord:g:c'], limit: 100 },
    storage.watermark()
  ).filter((row) => row.provenance.producerId === 'discord-memory-writer');
  const firstAtom = revisions.find((row) =>
    row.body.kind === 'inline' && row.body.value.includes('Alice proposed'));
  const secondAtom = revisions.find((row) =>
    row.body.kind === 'inline' && row.body.value.includes('Bob opposed'));
  assert.ok(firstAtom && secondAtom, 'one atomic event operation wrote both ordinary Atoms');
  assert.ok(firstAtom.slots.some((slot) =>
    slot.target.atomId === secondAtom.atomId));
  assert.ok(secondAtom.slots.some((slot) =>
    slot.target.atomId === firstAtom.atomId),
  'batch-local links preserve a cycle without host topological sorting');

  const reader = conversationMemory({
    guildId: 'g',
    channel,
    member: { id: 'viewer' }
  });
  const recalled = await reader.read({ context: 'golden_semantic manual administrator' });
  assert.match(recalled.text, /manual administrator/);
  assert.doesNotMatch(recalled.text, /OTHER_GUILD_SECRET/);
  reader.close();

  save(rawMessage('context-only', '了解', {
    guildId: 'context-g',
    channelId: 'context-c',
    createdAt: 1701000000000
  }));
  const contextOnly = await runConversationWriter({
    guildIds: ['context-g'],
    now: Date.now() + 2000,
    request: async ({ messages, consumeRequest, model }) => {
      await consumeRequest({ model });
      const input = writerInput(messages);
      return {
        choices: [{
          message: {
            content: JSON.stringify({
              changes: [],
              sourceOutcomes: input.targets.map((target) => ({
                messageId: target.messageId,
                generation: target.generation,
                outcome: 'context_only',
                refs: []
              })),
              continuation: null
            })
          }
        }]
      };
    }
  });
  assert.equal(contextOnly.pending, 0, JSON.stringify(contextOnly));
  assert.equal(contextOnly.batchAtoms, 0,
    'host records an explicit context-only outcome without calling Atom write');

  save(rawMessage('restart-source', 'restart_plan_topic', {
    guildId: 'restart-g',
    channelId: 'restart-c',
    createdAt: 1702000000000
  }));
  let restartCalls = 0;
  const restartRequest = async ({ messages, consumeRequest, model }) => {
    await consumeRequest({ model });
    restartCalls += 1;
    const input = writerInput(messages);
    return {
      choices: [{
        message: {
          content: JSON.stringify(incorporatedPlan(input, 'restart_plan_topic'))
        }
      }]
    };
  };
  const originalWrite = MemoryClient.prototype.write;
  let interrupted = false;
  MemoryClient.prototype.write = async function (...args) {
    const result = await originalWrite.apply(this, args);
    const writerChange = args[0]?.changes?.some((change) => change.input);
    if (writerChange && !interrupted) {
      interrupted = true;
      throw new Error('writer interruption after atomic write');
    }
    return result;
  };
  try {
    await assert.rejects(runConversationWriter({
      guildIds: ['restart-g'],
      now: Date.now() + 3000,
      request: restartRequest
    }), /after atomic write/);
  } finally {
    MemoryClient.prototype.write = originalWrite;
  }
  const resumed = await runConversationWriter({
    guildIds: ['restart-g'],
    now: Date.now() + 4000000,
    request: async () => {
      throw new Error('durable model result must be reused');
    }
  });
  assert.equal(resumed.pending, 0, JSON.stringify(resumed));
  assert.equal(restartCalls, 2,
    'planned idempotent replay performs no additional provider generation');

  save(rawMessage('edited-source', 'old source during await', {
    guildId: 'edit-g',
    channelId: 'edit-c',
    createdAt: 1703000000000
  }));
  await assert.rejects(runConversationWriter({
    guildIds: ['edit-g'],
    now: Date.now() + 5000,
    request: async ({ messages, consumeRequest, model }) => {
      await consumeRequest({ model });
      const input = writerInput(messages);
      save(rawMessage('edited-source', 'new source wins during await', {
        guildId: 'edit-g',
        channelId: 'edit-c',
        createdAt: 1703000000000,
        editedAt: 1703000001000
      }));
      return {
        choices: [{
          message: { content: JSON.stringify(incorporatedPlan(input, 'stale')) }
        }]
      };
    }
  }), { code: 'AGENT_CONTEXT_INVALIDATED' });
  assert.ok(writerStatus(['edit-g']).pending > 0,
    'a source edit during provider await remains pending and publishes no stale plan');

  assert.equal(
    storage.scan({ policies: ['discord:edit-g:edit-c'], limit: 100 }, storage.watermark())
      .some((row) => row.body.kind === 'inline' && row.body.value.includes('"stale"')),
    false
  );
  storage.close();

  console.log(
    'memory writer: v2 outcomes, atomic local cycles, context-only handling, ' +
    'idempotent plan replay, source fencing and guild isolation passed'
  );
} finally {
  db.close();
  rmSync(directory, { recursive: true, force: true });
}
