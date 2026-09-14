import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const directory = mkdtempSync(join(tmpdir(), 'sakana-dream-writer-'));
process.env.ARCHIVE_DB_PATH = join(directory, 'archive.sqlite');
process.env.ATOM_MEMORY_PATH = join(directory, 'atoms.sqlite');
process.env.AGENT_RUNTIME_PATH = join(directory, 'agent.sqlite');
process.env.MEMORY_EMBEDDINGS = 'false';
process.env.MEMORY_WRITER_ENABLED = 'true';
process.env.MEMORY_WRITER_QUIET_MS = '1';
process.env.OPENROUTER_API_KEY = 'fixture-only';

const { db, saveMessage } = await import('../src/archive/db.js');
const {
  conversationSourceHash,
  conversationWriterScope,
  drainConversationWriterIndex,
  syncConversationMemory
} = await import('../src/conversation/memory.js');
const { createArchiveNavigator } = await import('../src/conversation/archive-navigator.js');
const {
  dreamWriterBatchId,
  runConversationWriter,
  runDreamWriterBatch,
  verifyDreamWriterCompletion
} = await import('../src/conversation/writer.js');
const { SqliteStorage } = await import('../subprojects/atom-memory/dist/adapters/sqlite.js');

const now = Date.now();

function structure({ guildId, channelId, replyTo = null, observedAt }) {
  return JSON.stringify({
    version: 1,
    messageType: 0,
    reference: {
      kind: replyTo ? 'reply' : 'none',
      messageId: replyTo,
      channelId: replyTo ? channelId : null,
      guildId,
      availability: replyTo ? 'not_fetched' : 'not_applicable',
      authorId: null
    },
    thread: { id: null, parentChannelId: null, name: null, archived: null, locked: null },
    mentions: [],
    forwarded: [],
    attachments: [],
    embeds: [],
    stickers: [],
    pinned: false,
    partial: false,
    observedAt
  });
}

function record({ id, guildId, channelId, createdAt, content, authorId = 'human',
  replyTo = null, editedAt = null, isBot = 0 }) {
  return {
    message_id: id,
    guild_id: guildId,
    channel_id: channelId,
    parent_id: null,
    author_id: authorId,
    author_name: authorId,
    is_bot: isBot,
    content,
    extra: '',
    created_at: createdAt,
    edited_at: editedAt,
    reply_to: replyTo,
    structure_json: structure({ guildId, channelId, replyTo, observedAt: editedAt ?? createdAt }),
    attachment_count: 0,
    attachment_kinds: '',
    embed_count: 0,
    sticker_count: 0,
    link_count: 0,
    reaction_count: 0,
    char_count: content.length,
    pinned: 0,
    mentions: [],
    reactions: [],
    links: []
  };
}

function save(row) {
  saveMessage(row);
  return db.prepare('SELECT * FROM messages WHERE message_id=?').get(row.message_id);
}

function inputFrom(messages) {
  for (const message of messages) {
    if (typeof message.content !== 'string') continue;
    try {
      const value = JSON.parse(message.content);
      if (value.schema === 'sakana.writer.input.v2') return value;
    } catch {
      // Prompts and tool observations are not Writer input envelopes.
    }
  }
  throw new Error('Writer request did not include its v2 input envelope');
}

function toolResult(messages) {
  const message = [...messages].reverse().find((entry) => entry.role === 'tool');
  assert.ok(message, 'Writer tool result was not returned to the next generation');
  return JSON.parse(message.content);
}

function source(messageId) {
  const row = db.prepare('SELECT * FROM messages WHERE message_id=?').get(messageId);
  assert.ok(row, `Missing fixture source ${messageId}`);
  return { messageId, channelId: row.channel_id, hash: conversationSourceHash(row) };
}

function workFor({ id, guildId, channelId, targetIds, sources = targetIds,
  lane = 'new', continuation = null, sourceOutcomes = [], reviewTarget = null }) {
  return {
    id,
    commitId: id,
    guildId,
    channelId,
    lane,
    scope: conversationWriterScope({ guildId, channelId }),
    targets: targetIds.map((messageId, index) => ({
      ...source(messageId),
      generation: index + 1
    })),
    sources: sources.map((messageId) => source(messageId)),
    sourceOutcomes,
    continuation,
    ...(reviewTarget ? { reviewTarget } : {})
  };
}

async function project(messageIds) {
  const result = await syncConversationMemory({ messageIds });
  assert.equal(result.pending >= 0, true);
}

async function indexAndResume(work, waiting, request = async () => {
  throw new Error('A committed Writer checkpoint must not call the provider');
}) {
  assert.equal(waiting.waiting, 'index', JSON.stringify(waiting));
  const indexed = await drainConversationWriterIndex({ guildIds: [work.guildId] });
  assert.equal(indexed.writerBatchId, waiting.writerBatchId, JSON.stringify(indexed));
  return runDreamWriterBatch({ work, request });
}

try {
  // Archive navigation uses (created_at,message_id) keysets, preserves real
  // reply edges, and revalidates source and permission generations on every read.
  const navGuild = 'navigator-guild';
  const navA = 'navigator-a';
  const navB = 'navigator-b';
  const navRows = [
    record({ id: 'n001', guildId: navGuild, channelId: navA,
      createdAt: now - 10000, content: 'parent statement' }),
    record({ id: 'n002', guildId: navGuild, channelId: navA,
      createdAt: now - 10000, content: 'reply anchor', replyTo: 'n001' }),
    record({ id: 'n003', guildId: navGuild, channelId: navA,
      createdAt: now - 10000, content: 'same millisecond neighbor' }),
    record({ id: 'n004', guildId: navGuild, channelId: navA,
      createdAt: now - 9999, content: 'direct reply', replyTo: 'n002' }),
    ...['n010', 'n011', 'n012', 'n013'].map((id, index) => record({
      id,
      guildId: navGuild,
      channelId: index % 2 ? navB : navA,
      createdAt: now - 9000,
      content: `episodeprobe tie ${index}`
    }))
  ];
  for (const row of navRows) save(row);
  save(record({ id: 'n999', guildId: navGuild, channelId: 'private-channel',
    createdAt: now - 8000, content: 'episodeprobe must stay outside scope' }));

  let permissionGeneration = 1;
  const navScope = {
    policyId: `discord:${navGuild}:public`,
    kind: 'public',
    channelIds: [navA, navB],
    generation: 'scope-1'
  };
  const navigator = createArchiveNavigator({
    guildId: navGuild,
    scope: navScope,
    sourceHash: conversationSourceHash,
    initialRows: [db.prepare('SELECT * FROM messages WHERE message_id=?').get('n002')],
    assertSource: (row) => assert.ok(navScope.channelIds.includes(row.channel_id)),
    assertCurrentScope: () => {
      if (permissionGeneration !== 1) {
        throw Object.assign(new Error('permission generation changed'), {
          code: 'AGENT_CONTEXT_INVALIDATED'
        });
      }
    }
  });
  const context = navigator.context({ messageId: 'n002', before: 2, after: 2, replies: 4 });
  assert.ok(context.before.some((message) => message.id === 'n001'));
  assert.ok(context.after.some((message) => message.id === 'n003'));
  assert.ok(context.replies.some((item) =>
    item.relation === 'parent' && item.message.id === 'n001'));
  assert.ok(context.replies.some((item) =>
    item.relation === 'reply' && item.message.id === 'n004'));

  const firstPage = navigator.search({ query: 'episodeprobe', limit: 2 });
  const secondPage = navigator.search({ cursor: firstPage.cursor, limit: 2 });
  assert.deepEqual(
    [...firstPage.messages, ...secondPage.messages].map((message) => message.id),
    ['n010', 'n011', 'n012', 'n013'],
    'same-millisecond keyset pages neither skip nor duplicate a source'
  );
  assert.doesNotMatch(JSON.stringify([firstPage, secondPage]), /private-channel/);
  save(record({ id: 'n010', guildId: navGuild, channelId: navA,
    createdAt: now - 9000, content: 'episodeprobe edited', editedAt: now }));
  assert.throws(() => navigator.assertCurrent(), { code: 'AGENT_CONTEXT_INVALIDATED' });

  const permissionNavigator = createArchiveNavigator({
    guildId: navGuild,
    scope: navScope,
    sourceHash: conversationSourceHash,
    initialRows: [db.prepare('SELECT * FROM messages WHERE message_id=?').get('n002')],
    assertCurrentScope: () => {
      if (permissionGeneration !== 1) {
        throw Object.assign(new Error('permission generation changed'), {
          code: 'AGENT_CONTEXT_INVALIDATED'
        });
      }
    }
  });
  permissionGeneration = 2;
  assert.throws(() => permissionNavigator.read(['n002']), {
    code: 'AGENT_CONTEXT_INVALIDATED'
  });

  // Seed a group -> relation -> event graph through the public Writer API.
  // The review starts from the group and must inspect the relation before the
  // event becomes an issued eN capability.
  const graphGuild = 'graph-guild';
  const graphChannel = 'graph-channel';
  const graphIds = ['graph-group-source', 'graph-relation-source', 'graph-event-source'];
  for (const [index, messageId] of graphIds.entries()) {
    save(record({ id: messageId, guildId: graphGuild, channelId: graphChannel,
      createdAt: now + index, content: `graph seed ${index}` }));
  }
  let seedRequests = 0;
  const seeded = await runConversationWriter({
    guildIds: [graphGuild],
    now: now + 10000,
    request: async ({ messages, consumeRequest, model }) => {
      consumeRequest({ model });
      seedRequests += 1;
      const input = inputFrom(messages);
      const byId = new Set(input.messages.map((message) => message.id));
      for (const id of graphIds) assert.ok(byId.has(id));
      return {
        choices: [{ message: { content: JSON.stringify({
          changes: [
            { id: 'a1', op: 'create', text: 'graph group root',
              sources: [graphIds[0]], links: [
                { role: 'contains-relation', target: 'a2', at: 'logical', required: false }
              ] },
            { id: 'a2', op: 'create', text: 'graph relation bridge',
              sources: [graphIds[1]], links: [
                { role: 'group', target: 'a1', at: 'logical', required: false },
                { role: 'event', target: 'a3', at: 'logical', required: true }
              ] },
            { id: 'a3', op: 'create', text: 'graph unseen event',
              sources: [graphIds[2]], links: [] }
          ],
          sourceOutcomes: input.targets.map((target) => ({
            ...target,
            outcome: 'incorporated',
            refs: [target.messageId === graphIds[0] ? 'a1'
              : target.messageId === graphIds[1] ? 'a2' : 'a3']
          })),
          continuation: null
        }) } }]
      };
    }
  });
  assert.equal(seeded.pending, 0, JSON.stringify(seeded));
  assert.equal(seedRequests, 2);

  const storage = new SqliteStorage(process.env.ATOM_MEMORY_PATH);
  const seedCheckpoint = storage.metaGet(`sakana:writer-batch:${seeded.completedBatch}`);
  const groupRef = seedCheckpoint.refs.find((ref) => ref.nodeId === 'a1');
  const eventRef = seedCheckpoint.refs.find((ref) => ref.nodeId === 'a3');
  assert.ok(groupRef && eventRef);
  db.prepare('DELETE FROM memory_writer_runs WHERE guild_id=?').run(graphGuild);

  const reviewId = 'graph-review-source';
  save(record({ id: reviewId, guildId: graphGuild, channelId: graphChannel,
    createdAt: now + 100, content: 'new evidence for the unseen event' }));
  await project([reviewId]);
  const reviewWork = workFor({
    id: 'graph-review-work',
    guildId: graphGuild,
    channelId: graphChannel,
    targetIds: [reviewId],
    lane: 'review',
    reviewTarget: {
      passId: 'review-pass',
      targetKey: `${groupRef.atomId}:${groupRef.revisionId}:daily-review`,
      atomId: groupRef.atomId,
      version: groupRef.revisionId,
      fingerprint: 'review-fingerprint',
      purpose: 'daily-review',
      payload: {
        batchId: seeded.completedBatch,
        nodeId: 'a1',
        ref: groupRef,
        sources: seedCheckpoint.sources,
        scope: seedCheckpoint.scope,
        text: 'graph group root'
      }
    }
  });
  let reviewRound = 0;
  let eventAlias;
  let heartbeats = 0;
  let claimChecks = 0;
  const reviewRequest = async ({ messages, tools, final, consumeRequest, beforeSend, model }) => {
    await beforeSend();
    consumeRequest({ model });
    reviewRound += 1;
    if (reviewRound === 1) {
      const input = inputFrom(messages);
      assert.ok(input.existing.some((entry) => entry.text === 'graph group root'));
      const relation = input.existing.find((entry) => entry.text === 'graph relation bridge');
      assert.ok(relation, 'group inspection must expose its relation Atom');
      assert.equal(input.existing.some((entry) => entry.text === 'graph unseen event'), false,
        'a one-hop group inspection must not issue the event two hops away');
      return {
        choices: [{ message: { tool_calls: [{ id: 'inspect-relation', type: 'function',
          function: { name: 'memory_inspect', arguments: JSON.stringify({ ref: relation.ref }) } }] } }]
      };
    }
    if (reviewRound === 2) {
      const inspected = toolResult(messages);
      const event = inspected.neighbors.map((item) => item.entry)
        .find((entry) => entry.text === 'graph unseen event');
      assert.ok(event, 'inspecting the issued relation must issue its previously unseen event');
      eventAlias = event.ref;
      return { choices: [{ message: { content: 'evidence inspected' } }] };
    }
    assert.equal(final, true);
    assert.equal(tools, null);
    return {
      choices: [{ message: { content: JSON.stringify({
        changes: [{ id: 'a1', op: 'revise', target: eventAlias,
          text: 'graph unseen event revised with new evidence',
          sources: [reviewId], links: [] }],
        sourceOutcomes: [{ messageId: reviewId, generation: 1,
          outcome: 'incorporated', refs: ['a1'] }],
        continuation: null
      }) } }]
    };
  };
  const reviewWaiting = await runDreamWriterBatch({
    work: reviewWork,
    request: reviewRequest,
    heartbeat: () => { heartbeats += 1; },
    assertCurrentClaim: () => { claimChecks += 1; }
  });
  assert.equal(reviewWaiting.waiting, 'index', JSON.stringify(reviewWaiting));
  assert.equal(reviewRound, 3);
  assert.ok(heartbeats >= reviewRound && claimChecks >= reviewRound,
    'claim fencing runs at every provider and commit freshness boundary');
  assert.deepEqual(new Set(reviewWaiting.sources.map((item) => item.messageId)),
    new Set([...graphIds, reviewId]),
    'inspection evidence becomes an authoritative source dependency');
  const reviewReplay = await runDreamWriterBatch({
    work: reviewWork,
    request: async () => { throw new Error('committed review must not call provider'); }
  });
  assert.equal(reviewReplay.waiting, 'index');
  const reviewCompleted = await indexAndResume(reviewWork, reviewWaiting);
  assert.equal(reviewCompleted.completed, true, JSON.stringify(reviewCompleted));
  const verified = verifyDreamWriterCompletion(reviewWork, reviewCompleted);
  assert.deepEqual(verified.sources, reviewCompleted.sources);
  const revisedEvent = storage.scan({ policies: [reviewWork.scope.policyId], limit: 100 },
    storage.watermark()).find((row) => row.atomId === eventRef.atomId);
  assert.match(JSON.parse(revisedEvent.body.value).text, /revised with new evidence/);

  // A raw source found by a tool may not be projected yet. The episode yields
  // without another provider request, returns that source dependency, and
  // resumes the same durable tool transcript once projection catches up.
  const pendingGuild = 'pending-source-guild';
  const pendingChannel = 'pending-source-channel';
  const pendingTarget = 'pending-target';
  const pendingNeighbor = 'pending-neighbor';
  save(record({ id: pendingTarget, guildId: pendingGuild, channelId: pendingChannel,
    createdAt: now + 1000, content: 'pending source anchor' }));
  await project([pendingTarget]);
  save(record({ id: pendingNeighbor, guildId: pendingGuild, channelId: pendingChannel,
    createdAt: now + 1001, content: 'newly navigated source' }));
  let pendingRound = 0;
  const pendingWork = workFor({ id: 'pending-source-work', guildId: pendingGuild,
    channelId: pendingChannel, targetIds: [pendingTarget] });
  const pendingRequest = async ({ messages, final, consumeRequest, model }) => {
    consumeRequest({ model });
    pendingRound += 1;
    if (pendingRound === 1) {
      inputFrom(messages);
      return { choices: [{ message: { tool_calls: [{ id: 'source-context', type: 'function',
        function: { name: 'source_context', arguments: JSON.stringify({
          messageId: pendingTarget, before: 0, after: 1, replies: 0
        }) } }] } }] };
    }
    if (pendingRound === 2) {
      assert.match(JSON.stringify(toolResult(messages)), /newly navigated source/);
      return { choices: [{ message: { content: 'source is ready' } }] };
    }
    assert.equal(final, true);
    return { choices: [{ message: { content: JSON.stringify({
      changes: [{ id: 'a1', op: 'create', text: 'pending source event',
        sources: [pendingTarget, pendingNeighbor], links: [] }],
      sourceOutcomes: [{ messageId: pendingTarget, generation: 1,
        outcome: 'incorporated', refs: ['a1'] }],
      continuation: null
    }) } }] };
  };
  const sourceWait = await runDreamWriterBatch({ work: pendingWork, request: pendingRequest });
  assert.equal(sourceWait.waiting, 'sources', JSON.stringify(sourceWait));
  assert.equal(pendingRound, 1, 'projection wait does not consume another provider request');
  assert.ok(sourceWait.sources.some((item) => item.messageId === pendingNeighbor));
  await project([pendingNeighbor]);
  const resumedPendingWork = { ...pendingWork, sources: sourceWait.sources };
  const pendingIndex = await runDreamWriterBatch({ work: resumedPendingWork, request: pendingRequest });
  assert.equal(pendingIndex.waiting, 'index', JSON.stringify(pendingIndex));
  assert.equal(pendingRound, 3);
  assert.deepEqual(new Set(pendingIndex.sources.map((item) => item.messageId)),
    new Set([pendingTarget, pendingNeighbor]));
  const pendingComplete = await indexAndResume(resumedPendingWork, pendingIndex);
  assert.equal(pendingComplete.completed, true);

  // A continuation acknowledges only terminal generations. The next episode
  // sees cumulative outcomes but receives just the unresolved raw target.
  const continuationGuild = 'continuation-guild';
  const continuationChannel = 'continuation-channel';
  const continuationIds = ['continuation-one', 'continuation-two'];
  for (const [index, messageId] of continuationIds.entries()) {
    save(record({ id: messageId, guildId: continuationGuild, channelId: continuationChannel,
      createdAt: now + 2000 + index, content: `continuation source ${index + 1}` }));
  }
  await project(continuationIds);
  const continuationWork = workFor({ id: 'continuation-work', guildId: continuationGuild,
    channelId: continuationChannel, targetIds: continuationIds });
  let firstSliceRound = 0;
  const firstSlice = await runDreamWriterBatch({
    work: continuationWork,
    request: async ({ messages, final, consumeRequest, model }) => {
      consumeRequest({ model });
      firstSliceRound += 1;
      const input = inputFrom(messages);
      if (!final) return { choices: [{ message: { content: 'slice planned' } }] };
      assert.deepEqual(input.targets.map((target) => target.messageId), continuationIds);
      return { choices: [{ message: { content: JSON.stringify({
        changes: [{ id: 'a1', op: 'create', text: 'one continuing event',
          sources: [continuationIds[0]], links: [] }],
        sourceOutcomes: [
          { messageId: continuationIds[0], generation: 1,
            outcome: 'incorporated', refs: ['a1'] },
          { messageId: continuationIds[1], generation: 2,
            outcome: 'continuation', refs: [], unresolved: 'needs the next episode' }
        ],
        continuation: { sourceCursor: null, nextAtom: 'a1',
          unresolved: [{ messageId: continuationIds[1], generation: 2,
            reason: 'needs the next episode' }] }
      }) } }] };
    }
  });
  assert.equal(firstSlice.waiting, 'index', JSON.stringify(firstSlice));
  assert.equal(firstSlice.sourceOutcomes.length, 1);
  assert.equal(firstSlice.continuation.unresolved.length, 1);
  const continued = await indexAndResume(continuationWork, firstSlice);
  assert.equal(continued.completed, undefined);
  assert.ok(continued.continuation);
  const nextWork = { ...continuationWork, writerBatchId: undefined,
    sources: continued.sources, sourceOutcomes: continued.sourceOutcomes,
    continuation: continued.continuation };
  assert.notEqual(dreamWriterBatchId(nextWork), firstSlice.writerBatchId);
  let secondSliceRound = 0;
  const secondSlice = await runDreamWriterBatch({
    work: nextWork,
    request: async ({ messages, final, consumeRequest, model }) => {
      consumeRequest({ model });
      secondSliceRound += 1;
      const input = inputFrom(messages);
      assert.deepEqual(input.targets.map((target) => target.messageId), [continuationIds[1]]);
      assert.equal(input.completedSourceOutcomes.length, 1);
      assert.ok(input.messages.some((message) => message.id === continuationIds[1]));
      assert.deepEqual(new Set(input.messages.map((message) => message.id)),
        new Set(continuationIds),
        'the next episode carries the unresolved target and the prior Atom evidence');
      const carried = input.existing.find((entry) => entry.text === 'one continuing event');
      assert.ok(carried);
      if (!final) return { choices: [{ message: { content: 'finish continuation' } }] };
      return { choices: [{ message: { content: JSON.stringify({
        changes: [{ id: 'a1', op: 'revise', target: carried.ref,
          text: 'one continuing event completed in a later episode',
          sources: [continuationIds[1]], links: [] }],
        sourceOutcomes: [{ messageId: continuationIds[1], generation: 2,
          outcome: 'incorporated', refs: ['a1'] }],
        continuation: null
      }) } }] };
    }
  });
  assert.equal(secondSlice.waiting, 'index', JSON.stringify(secondSlice));
  assert.equal(secondSlice.sourceOutcomes.length, 2,
    'every Writer result exposes cumulative terminal dispositions');
  assert.equal(secondSlice.continuation, null);
  const continuationComplete = await indexAndResume(nextWork, secondSlice);
  assert.equal(continuationComplete.completed, true);
  assert.equal(firstSliceRound, 2);
  assert.equal(secondSliceRound, 2);

  // Two keyset pages preserve one conditional, explicitly unexecuted event,
  // a later recurrence, and a disagreement as separate ordinary Atoms.
  const semanticGuild = 'semantic-guild';
  const semanticChannel = 'semantic-channel';
  const semanticTarget = 'semantic-target';
  const semanticSources = ['semantic-1', 'semantic-2', 'semantic-3', 'semantic-4'];
  save(record({ id: semanticTarget, guildId: semanticGuild, channelId: semanticChannel,
    createdAt: now + 3000, content: 'investigate the deployment incident' }));
  const semanticText = [
    'semanticprobe same event: enable fallback only if the service is unavailable',
    'semanticprobe same event: fallback was not enabled',
    'semanticprobe one week later: a separate outage recurred',
    'semanticprobe disagreement: Bob rejected automatic fallback even under the condition'
  ];
  for (const [index, messageId] of semanticSources.entries()) {
    save(record({ id: messageId, guildId: semanticGuild, channelId: semanticChannel,
      createdAt: now + 4000, content: semanticText[index],
      authorId: index === 3 ? 'bob' : 'alice' }));
  }
  await project([semanticTarget, ...semanticSources]);
  const semanticWork = workFor({ id: 'semantic-work', guildId: semanticGuild,
    channelId: semanticChannel, targetIds: [semanticTarget] });
  let semanticRound = 0;
  const semanticWaiting = await runDreamWriterBatch({
    work: semanticWork,
    request: async ({ messages, final, consumeRequest, model }) => {
      consumeRequest({ model });
      semanticRound += 1;
      if (semanticRound === 1) {
        return { choices: [{ message: { tool_calls: [{ id: 'semantic-page-1', type: 'function',
          function: { name: 'source_search', arguments: JSON.stringify({
            query: 'semanticprobe', limit: 2
          }) } }] } }] };
      }
      if (semanticRound === 2) {
        const page = toolResult(messages);
        assert.match(JSON.stringify(page.messages), /only if/);
        assert.match(JSON.stringify(page.messages), /not enabled/);
        assert.ok(page.cursor);
        return { choices: [{ message: { tool_calls: [{ id: 'semantic-page-2', type: 'function',
          function: { name: 'source_search', arguments: JSON.stringify({
            cursor: page.cursor, limit: 2
          }) } }] } }] };
      }
      if (semanticRound === 3) {
        const page = toolResult(messages);
        assert.match(JSON.stringify(page.messages), /separate outage recurred/);
        assert.match(JSON.stringify(page.messages), /disagreement/);
        return { choices: [{ message: { content: 'semantic distinctions preserved' } }] };
      }
      assert.equal(final, true);
      inputFrom(messages);
      return { choices: [{ message: { content: JSON.stringify({
        changes: [
          { id: 'a1', op: 'create',
            text: 'During the first incident, fallback was conditional on unavailability and was not enabled.',
            sources: [semanticTarget, semanticSources[0], semanticSources[1]], links: [] },
          { id: 'a2', op: 'create', text: 'A separate outage recurred one week later.',
            sources: [semanticSources[2]], links: [] },
          { id: 'a3', op: 'create',
            text: 'Bob disagreed with automatic fallback even when the condition held.',
            sources: [semanticSources[3]], links: [
              { role: 'disagrees-with', target: 'a1', at: 'observed', required: false }
            ] }
        ],
        sourceOutcomes: [{ messageId: semanticTarget, generation: 1,
          outcome: 'incorporated', refs: ['a1', 'a2', 'a3'] }],
        continuation: null
      }) } }] };
    }
  });
  assert.equal(semanticWaiting.waiting, 'index', JSON.stringify(semanticWaiting));
  assert.equal(semanticRound, 4);
  assert.deepEqual(new Set(semanticWaiting.sources.map((item) => item.messageId)),
    new Set([semanticTarget, ...semanticSources]));
  const semanticComplete = await indexAndResume(semanticWork, semanticWaiting);
  assert.equal(semanticComplete.completed, true);
  const semanticAtoms = storage.scan({ policies: [semanticWork.scope.policyId], limit: 100 },
    storage.watermark()).map((row) => {
      try { return JSON.parse(row.body.value).text; } catch { return ''; }
    });
  assert.ok(semanticAtoms.some((text) => /conditional/.test(text) && /not enabled/.test(text)));
  assert.ok(semanticAtoms.some((text) => /separate outage recurred/.test(text)));
  assert.ok(semanticAtoms.some((text) => /disagreed/.test(text)));

  // A source edit after the provider starts invalidates the generation before
  // response acknowledgement and no stale Atom is committed.
  const editGuild = 'edit-guild';
  const editChannel = 'edit-channel';
  const editId = 'edit-target';
  save(record({ id: editId, guildId: editGuild, channelId: editChannel,
    createdAt: now + 5000, content: 'old source text' }));
  await project([editId]);
  const editWork = workFor({ id: 'edit-work', guildId: editGuild,
    channelId: editChannel, targetIds: [editId] });
  await assert.rejects(runDreamWriterBatch({
    work: editWork,
    request: async ({ consumeRequest, model }) => {
      consumeRequest({ model });
      save(record({ id: editId, guildId: editGuild, channelId: editChannel,
        createdAt: now + 5000, content: 'new source text', editedAt: now + 6000 }));
      return { choices: [{ message: { content: 'stale exploration' } }] };
    }
  }), { code: 'AGENT_CONTEXT_INVALIDATED' });
  assert.equal(storage.metaGet(`sakana:writer-batch:${dreamWriterBatchId(editWork)}`), undefined);

  storage.close();
  console.log('dream writer: keyset navigation, graph expansion, source waits, ' +
    'continuations, semantic distinctions, fencing and edit invalidation passed');
} finally {
  db.close();
  rmSync(directory, { recursive: true, force: true });
}
