import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Keep this checker independent from a configured production archive.
const directory = mkdtempSync(join(tmpdir(), 'sakana-dream-admission-'));
process.env.ARCHIVE_DB_PATH = join(directory, 'archive.sqlite');
process.env.MEMORY_DREAMING_ENABLED = '1';
process.env.MEMORY_DREAMING_GUILDS = '1255359848644608035';

const { db } = await import('../src/archive/db.js');
const {
  ensureAdmissionSchema, admissionBasisHash, admissionFor, admissionDisposition, admissionStamp,
  applyDreamSourceOutcomes,
  selectAdmissionBatch, applyAdmissionDecisions, selectContextMessages,
  isMessageAdmitted
} = await import('../src/conversation/admission.js');

const guild = '1255359848644608035';
const foreignGuild = 'foreign-guild';
const structure = ({ embeds = [], attachments = [], reference = null } = {}) => JSON.stringify({
  version: 1,
  reference: { kind: reference ? 'reply' : 'none', messageId: reference },
  embeds, attachments, forwarded: [], mentions: [], pinned: false
});

function add(id, options = {}) {
  const value = {
    guild: guild, channel: 'channel-a', author: 'bot-a', isBot: 1,
    content: '', extra: '', created: Number(id), replyTo: null, pinned: 0,
    embeds: [], attachments: [], ...options
  };
  db.prepare(`INSERT INTO messages (
    message_id,guild_id,channel_id,parent_id,author_id,author_name,is_bot,
    content,extra,created_at,edited_at,reply_to,attachment_count,attachment_kinds,
    embed_count,sticker_count,link_count,reaction_count,char_count,pinned,deleted,structure_json
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    id, value.guild, value.channel, null, value.author, value.author, value.isBot ? 1 : 0,
    value.content, value.extra, value.created, null, value.replyTo,
    value.attachments.length, '', value.embeds.length, 0, 0, 0,
    value.content.length, value.pinned, 0,
    structure({ embeds: value.embeds, attachments: value.attachments, reference: value.replyTo })
  );
  return db.prepare('SELECT * FROM messages WHERE message_id=?').get(id);
}

function decisions(batch, choose = () => ({ state: 'retain', reason: 'meaningful' })) {
  return batch.targets.map((target) => ({ messageId: target.messageId, ...choose(target) }));
}

try {
  ensureAdmissionSchema();

  // Both hot lookups must begin with their exact key. In particular, reply
  // detection must not walk every human message in a guild, and duplicate
  // detection must not hash a fixed prefix of an author's raw history.
  const replyPlan = db.prepare(`EXPLAIN QUERY PLAN SELECT 1
    FROM messages INDEXED BY idx_dream_messages_reply_target
    WHERE reply_to=? AND guild_id=? AND channel_id=? AND is_bot=0 AND deleted=0
      AND message_id<>? LIMIT 1`).all('target', guild, 'channel-a', 'target')
    .map((step) => step.detail).join('\n');
  assert.match(replyPlan, /idx_dream_messages_reply_target/);
  assert.doesNotMatch(replyPlan, /SCAN messages/);

  const exactPlan = db.prepare(`EXPLAIN QUERY PLAN SELECT a.message_id
    FROM dream_admissions a INDEXED BY idx_dream_admission_exact_representative
    JOIN messages m ON m.message_id=a.message_id
    WHERE a.guild_id=? AND a.channel_id=? AND a.author_id=? AND a.basis_hash=?
      AND a.state='retain' AND a.message_id<>? AND m.deleted=0
    ORDER BY a.created_at ASC, a.message_id ASC LIMIT 1`)
    .all(guild, 'channel-a', 'human', 'basis', 'target')
    .map((step) => step.detail).join('\n');
  assert.match(exactPlan, /idx_dream_admission_exact_representative/);
  assert.doesNotMatch(exactPlan, /SCAN (?:a|dream_admissions)|USE TEMP B-TREE/);

  // Empty content does not imply noise: the full embed/attachment structure is
  // present in the representative payload and the bot remains pending.
  const embed = add('100', { content: '', extra: '', embeds: [{ title: 'Deploy', description: 'v1.2.3' }],
    attachments: [{ id: 'attachment-1', name: 'release.json', contentType: 'application/json' }] });
  assert.equal(admissionFor(embed).state, 'pending');
  let batch = selectAdmissionBatch({ guildId: guild, limit: 60, maxBytes: 60000 });
  const embedGroup = batch.groups.find((group) => group.targetIds.includes('100'));
  assert.ok(embedGroup, 'embed-only notification should be issued');
  assert.deepEqual(embedGroup.representative.structure.embeds, [{ title: 'Deploy', description: 'v1.2.3' }]);
  assert.deepEqual(embedGroup.representative.structure.attachments, [{ id: 'attachment-1', name: 'release.json', contentType: 'application/json' }]);

  // Exact duplicates are one template group with a source-id map; a changed
  // release/version remains an independently decidable variant in that family.
  const duplicate = add('101', { content: 'release 2026-09-13 version 1', created: 101 });
  const duplicate2 = add('102', { content: 'release 2026-09-13 version 1', created: 102 });
  const changed = add('103', { content: 'release 2026-09-13 version 2', created: 103 });
  const negated = add('104', { content: 'release 2026-09-13 version 2 is not ready', created: 104 });
  batch = selectAdmissionBatch({ guildId: guild });
  const template = batch.groups.find((group) => group.targetIds.includes('101'));
  assert.ok(template);
  assert.equal(template.kind, 'template');
  assert.equal(template.exactDuplicateCount, 2);
  assert.ok(template.targetIds.includes('102') && template.targetIds.includes('103'));
  assert.ok(template.variants.find((target) => target.messageId === '103').stamp !== template.variants.find((target) => target.messageId === '101').stamp);
  assert.ok(batch.targets.some((target) => target.messageId === '104'), 'negation stays available for Ling');
  assert.match(JSON.stringify(batch), /version 1/);
  assert.match(JSON.stringify(batch), /version 2/);
  assert.match(JSON.stringify(batch), /not ready/);
  const sourceCount = db.prepare('SELECT count(*) AS n FROM messages').get().n;

  // Model output is per-message and strict. Keep one exact representative and
  // compress only its repeated payload.
  const apply = applyAdmissionDecisions(batch, decisions(batch, (target) => target.messageId === '102'
    ? { state: 'compressed', representativeId: '101', reason: 'exact duplicate' }
    : { state: 'retain', reason: 'version or status is meaningful' }));
  assert.equal(apply.applied, batch.targets.length);
  assert.equal(admissionDisposition('102').state, 'compressed');
  assert.equal(isMessageAdmitted(duplicate), true);
  assert.equal(db.prepare('SELECT count(*) AS n FROM messages').get().n, sourceCount, 'raw rows are never deleted');

  // Compression is valid only when the final decision keeps a same-scope,
  // exact representative directly. Suppressed, pending and cyclic/chained
  // representatives reject the entire phase.
  const compressedSource = add('110', { content: 'same provider event', created: 110 });
  const compressedRepresentative = add('111', { content: 'same provider event', created: 111 });
  const compressionBatch = selectAdmissionBatch({ guildId: guild });
  const compressionDecisions = (representativeState) => decisions(compressionBatch, (target) => {
    if (target.messageId === '110') {
      return { state: 'compressed', representativeId: '111', reason: 'exact duplicate' };
    }
    if (target.messageId === '111') {
      return representativeState === 'compressed'
        ? { state: 'compressed', representativeId: '110', reason: 'cycle' }
        : { state: representativeState, reason: 'representative outcome' };
    }
    return { state: 'retain', reason: 'unrelated target' };
  });
  assert.throws(() => applyAdmissionDecisions(compressionBatch, compressionDecisions('suppress')),
    /directly retained representative/);
  assert.throws(() => applyAdmissionDecisions(compressionBatch, compressionDecisions('pending')),
    /directly retained representative/);
  assert.throws(() => applyAdmissionDecisions(compressionBatch, compressionDecisions('compressed')),
    /directly retained representative/);
  assert.equal(admissionDisposition('110').state, 'pending', 'invalid phase must not write a prefix');
  applyAdmissionDecisions(compressionBatch, compressionDecisions('retain'));
  for (const laterState of ['suppress', 'pending', 'compressed']) {
    db.prepare(`UPDATE dream_admissions SET state=?, representative_id=?, reason=?
      WHERE message_id='111'`).run(laterState, laterState === 'compressed' ? '110' : null,
      `later_${laterState}`);
    assert.deepEqual(selectContextMessages([compressedSource, compressedRepresentative], {
      guildId: guild, channelId: 'channel-a'
    }), [], `a later-${laterState} representative must never enter the live prompt`);
  }

  // Human bursts coalesce only when real reply targets are compatible; all IDs
  // and per-message reply roles survive the unit compression.
  const human1 = add('200', { author: 'human', isBot: 0, content: 'one', created: 200 });
  const human2 = add('201', { author: 'human', isBot: 0, content: 'two', created: 201 });
  const human3 = add('202', { author: 'human', isBot: 0, content: 'answer', created: 202, replyTo: '100' });
  const units = selectContextMessages([human1, human2, human3], { guildId: guild, channelId: 'channel-a' });
  assert.deepEqual(units[0].messageIds, ['200', '201']);
  assert.deepEqual(units[1].messageIds, ['202']);
  assert.equal(units[1].messages[0].replyTo, '100');

  // Pinned and human-replied exact repeats are retention signals, so selector
  // compaction must keep both source IDs instead of dropping the second one.
  const pinnedHuman1 = add('210', { author: 'retained-human', isBot: 0,
    content: 'same retained statement', created: 210 });
  const pinnedHuman2 = add('211', { author: 'retained-human', isBot: 0,
    content: 'same retained statement', created: 211, pinned: 1 });
  assert.equal(admissionFor(pinnedHuman1).state, 'retain');
  assert.equal(admissionFor(pinnedHuman2).reason, 'pin_retention_signal');
  const pinnedUnit = selectContextMessages([pinnedHuman1, pinnedHuman2], {
    guildId: guild, channelId: 'channel-a'
  });
  assert.deepEqual(pinnedUnit.flatMap((unit) => unit.messageIds), ['210', '211']);

  const repliedHuman1 = add('212', { author: 'replied-human', isBot: 0,
    content: 'same replied statement', created: 212 });
  const repliedHuman2 = add('213', { author: 'replied-human', isBot: 0,
    content: 'same replied statement', created: 213 });
  admissionFor(repliedHuman1);
  assert.equal(admissionFor(repliedHuman2).state, 'compressed');
  add('214', { author: 'another-human', isBot: 0, content: 'reply preserves target',
    created: 214, replyTo: '213' });
  assert.equal(admissionDisposition('213').reason, 'human_reply_retention_signal');
  const repliedUnit = selectContextMessages([repliedHuman1, repliedHuman2], {
    guildId: guild, channelId: 'channel-a'
  });
  assert.deepEqual(repliedUnit.flatMap((unit) => unit.messageIds), ['212', '213']);

  // Unit and byte limits retain the newest complete chronological suffix.
  const recent = Array.from({ length: 10 }, (_, index) => add(String(500 + index), {
    author: `recent-${index}`, isBot: 0, content: `recent message ${index}`,
    created: 500 + index
  }));
  const recentThree = selectContextMessages(recent, {
    guildId: guild, channelId: 'channel-a', maxUnits: 3
  });
  assert.deepEqual(recentThree.map((unit) => unit.messageIds), [['507'], ['508'], ['509']]);
  assert.deepEqual(recentThree.flatMap((unit) => unit.messages.map((message) => message.messageId)),
    ['507', '508', '509']);
  const allRecent = selectContextMessages(recent, { guildId: guild, channelId: 'channel-a' });
  const newestTwoBytes = allRecent.slice(-2)
    .reduce((total, unit) => total + Buffer.byteLength(JSON.stringify(unit)), 0);
  const recentByBytes = selectContextMessages(recent, {
    guildId: guild, channelId: 'channel-a', maxBytes: newestTwoBytes
  });
  assert.deepEqual(recentByBytes.map((unit) => unit.messageIds), [['508'], ['509']]);

  // An exact repeat after more than 64 unrelated messages still resolves via
  // the persisted basis index, with no fixed candidate window.
  for (let index = 0; index < 65; index += 1) {
    admissionFor(add(String(1000 + index), { author: 'long-history-human', isBot: 0,
      content: `unrelated history ${index}`, created: 1000 + index }));
  }
  const longOriginal = add('1065', { author: 'long-history-human', isBot: 0,
    content: 'periodic exact event', created: 1065 });
  const longRepeat = add('1066', { author: 'long-history-human', isBot: 0,
    content: 'periodic exact event', created: 1066 });
  assert.equal(admissionFor(longOriginal).state, 'retain');
  assert.deepEqual(admissionFor(longRepeat), {
    state: 'compressed', generation: 0, representativeId: '1065',
    reason: 'exact_repeated_payload'
  });

  const arrivedLater = add('1202', { author: 'out-of-order-human', isBot: 0,
    content: 'out of order exact event', created: 1202 });
  const arrivedEarlier = add('1201', { author: 'out-of-order-human', isBot: 0,
    content: 'out of order exact event', created: 1201 });
  assert.equal(admissionFor(arrivedLater).state, 'retain');
  assert.deepEqual(admissionFor(arrivedEarlier), {
    state: 'compressed', generation: 0, representativeId: '1202',
    reason: 'exact_repeated_payload'
  });

  // A source edit invalidates an issued decision before it can be applied.
  add('105', { content: 'a pending source', created: 105 });
  const stale = selectAdmissionBatch({ guildId: guild });
  const staleTarget = stale.targets.find((target) => target.messageId === '105');
  assert.ok(staleTarget);
  db.prepare('UPDATE messages SET content=?, char_count=? WHERE message_id=?').run('pending source changed', 21, '105');
  assert.throws(() => applyAdmissionDecisions(stale, decisions(stale)), /Stale admission/);

  // Human reply and pin signals promote a suppressed bot source and enqueue
  // both the projection and writer work for the same guild/channel.
  add('106', { content: 'repetitive candidate', created: 106 });
  const promotedBatch = selectAdmissionBatch({ guildId: guild });
  const promoted = promotedBatch.targets.find((target) => target.messageId === '106');
  assert.ok(promoted);
  applyAdmissionDecisions(promotedBatch, decisions(promotedBatch, () => ({ state: 'suppress', reason: 'repetitive' })));
  assert.equal(admissionDisposition('106').state, 'suppress');
  add('203', { author: 'human', isBot: 0, content: 'this matters', created: 203, replyTo: '106' });
  assert.equal(admissionDisposition('106').state, 'retain');
  assert.equal(db.prepare('SELECT 1 FROM memory_pending WHERE message_id=?').get('106')?.['1'], 1);
  db.prepare('UPDATE messages SET pinned=1 WHERE message_id=?').run('104');
  assert.equal(admissionDisposition('104').state, 'retain');
  assert.equal(db.prepare('SELECT 1 FROM memory_pending WHERE message_id=?').get('104')?.['1'], 1);

  // A partial live-normalized shape must not overwrite the archive's richer
  // supplemental basis before ingestion has saved it.
  const archived = add('107', { content: 'card', extra: '[埋め込み] Card', created: 107,
    embeds: [{ title: 'Card', description: 'stable' }] });
  const archivedState = admissionFor(archived);
  const livePartial = { messageId: '107', guildId: guild, channelId: 'channel-a',
    authorId: 'bot-a', isBot: true, content: 'card', createdAt: 107,
    structure: { version: 1, reference: { kind: 'none', messageId: null }, embeds: [], attachments: [] } };
  assert.deepEqual(admissionFor(livePartial), archivedState);

  // The unified Writer finalizes semantic admission in the coordinator's
  // fenced completion transaction. Context-only sources stay retained for
  // provenance; only an exact issued duplicate may compress.
  const writerRows = [
    add('1400', { content: 'writer exact payload', created: 1400 }),
    add('1401', { content: 'writer exact payload', created: 1401 }),
    add('1402', { content: 'writer incorporated payload', created: 1402 }),
    add('1403', { channel: 'channel-b', content: 'writer exact payload', created: 1403 })
  ];
  const writerTargets = writerRows.map((row) => {
    const admission = admissionFor(row);
    return { messageId: row.message_id, generation: 0,
      admissionGeneration: admission.generation, channelId: row.channel_id,
      authorId: row.author_id, admissionStamp: admissionStamp(row),
      basisHash: admissionBasisHash(row) };
  });
  const rawBeforeWriterOutcomes = db.prepare('SELECT count(*) n FROM messages').get().n;
  applyDreamSourceOutcomes({ guildId: guild, workId: 'writer-work',
    scope: { kind: 'public', channelIds: ['channel-a', 'channel-b'] },
    targets: writerTargets, outcomes: [
      { messageId: '1400', generation: 0, outcome: 'context_only' },
      { messageId: '1401', generation: 0, outcome: 'exact_duplicate', representativeId: '1400' },
      { messageId: '1402', generation: 0, outcome: 'incorporated', refs: ['atom-ref'] },
      { messageId: '1403', generation: 0, outcome: 'exact_duplicate', representativeId: '1400' }
    ] });
  assert.equal(admissionDisposition('1400').state, 'retain');
  assert.deepEqual(admissionDisposition('1401'), {
    messageId: '1401', guildId: guild, channelId: 'channel-a', authorId: 'bot-a',
    state: 'compressed', generation: 1, representativeId: '1400',
    reason: 'dream_writer_exact_duplicate:writer-work'
  });
  assert.equal(admissionDisposition('1402').state, 'retain');
  assert.equal(admissionDisposition('1403').representativeId, '1400',
    'a public-policy exact duplicate may use a direct representative in another public channel');
  assert.equal(db.prepare('SELECT count(*) n FROM messages').get().n, rawBeforeWriterOutcomes,
    'Writer outcomes never delete raw archive rows');

  // Foreign/non-enabled guilds bypass Dream and cannot be selected.
  const foreign = add('300', { guild: foreignGuild, channel: 'foreign-channel', content: 'foreign' });
  assert.equal(admissionFor(foreign).reason, 'dream_guild_bypass');
  assert.equal(selectAdmissionBatch({ guildId: foreignGuild }).groups.length, 0);

  // The Discord host may restrict Dream to the channels the current bot can
  // still read. Omission keeps legacy guild-wide behavior; an explicit empty
  // iterable must not issue work.
  add('1300', { channel: 'channel-b', content: 'readable channel candidate', created: 1300 });
  const scopedBatch = selectAdmissionBatch({ guildId: guild, channelIds: new Set(['channel-b']) });
  assert.ok(scopedBatch.targets.some((target) => target.messageId === '1300'));
  assert.ok(scopedBatch.targets.every((target) => target.channelId === 'channel-b'));
  assert.deepEqual(selectAdmissionBatch({ guildId: guild, channelIds: [] }).targets, []);

  assert.equal(admissionStamp(embed), admissionStamp(embed), 'stamps are deterministic');
  console.log('check-dream-admission: ok');
} finally {
  db.close();
  rmSync(directory, { recursive: true, force: true });
}
