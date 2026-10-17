// モデルに見せる発言の形 (既定値を省いた JSON) の検証 (npm run check から tsx で呼ぶ)。
import assert from 'node:assert/strict';
import { RefTable, formatMessages } from '../src/agent/format.ts';

const SELF = '111000111000111000';
const base = { guildId: 'g1', channelId: 'c1', channelName: 'general', createdAt: 1_700_000_000_000, reactionCount: 0, attachmentCount: 0 };
const say = (id, authorId, authorName, content, extra = {}) => ({ ...base, messageId: id, authorId, authorName, content, ...extra });
const lineOf = (message, options = {}) => JSON.parse(formatMessages([message], { refs: new RefTable(), selfId: SELF, ...options }).replace(/^\d+\) /, ''));

// 普通の発言は、中身のある欄だけ
const plain = lineOf(say('1', '42', 'さば', 'こんにちは'));
assert.deepEqual(Object.keys(plain).sort(), ['author', 'body', 'id', 'state'], `only what matters: ${Object.keys(plain)}`);
assert.deepEqual(plain.author, { id: '42', name: 'さば' });
assert.deepEqual(plain.body, { text: 'こんにちは' });
assert.equal(plain.state.createdAt, base.createdAt);
const raw = formatMessages([say('1', '42', 'さば', 'こんにちは')], { refs: new RefTable() });
assert.ok(raw.length < 330, `a short message stays short (${raw.length} chars)`);
for (const noise of ['schema', 'guildId', 'webhookId', 'participant', 'observedAt', 'reaction_not_statement', 'embed_attachment_or_quoted_material', '"mentions"']) {
  assert.ok(!raw.includes(noise), `no ${noise}`);
}

// 意味のある欄は残る: 自分の発言・bot・本文の途中切れ・反応・添付・編集済み・削除
assert.equal(lineOf(say('2', SELF, 'sakana', 'ぼくの発言')).author.identity, 'あなた自身の発言');
assert.equal(lineOf(say('3', '7', 'bot', 'x', { isBot: true })).author.bot, true);
const cut = lineOf(say('4', '42', 'さば', 'あ'.repeat(50)), { bodyChars: 10 });
assert.deepEqual([cut.body.complete, cut.body.characters, cut.body.text.length], [false, 50, 10], 'a cut body says so');
assert.equal(lineOf(say('5', '42', 'さば', 'x', { reactionCount: 3 })).reactions, 3);
const edited = lineOf(say('6', '42', 'さば', 'x', { editedAt: 1_700_000_100_000, deleted: true }));
assert.deepEqual([edited.state.editedAt, edited.state.deleted], [1_700_000_100_000, true]);
const extra = lineOf(say('7', '42', 'さば', '', { extra: '[埋め込み] タイトル' }));
assert.deepEqual([extra.supplemental.text, extra.supplemental.attribution], ['[埋め込み] タイトル', 'embed_attachment_or_quoted_material'], 'embedded material stays marked as not the sender');

// 返信: 先があるものだけ reference が付く。古い記録で先が引けないものも残る
const reply = lineOf(say('8', '42', 'さば', 'それな', { replyTo: '1' }));
assert.equal(reply.reference.kind, 'unknown_reference');
assert.equal(reply.reference.messageId, '1');
assert.equal(reply.reference.availability, 'not_fetched');
assert.equal(plain.reference, undefined, 'no reference means it is not a reply');
assert.equal(reply.state.metadata, 'legacy_incomplete', 'an old record says its structure was not kept');

// チャンネルをまたぐ結果 (showChannel) だけ場所が付く
assert.equal(plain.location, undefined);
const where = lineOf(say('9', '42', 'さば', 'x'), { showChannel: true });
assert.deepEqual(where.location, { channelId: 'c1', channelName: 'general' });

// スレッドの発言は、スレッドであることが分かる
const thread = lineOf(say('10', '42', 'さば', 'x', { structure: { version: 1, reference: { kind: 'none', messageId: null, availability: 'not_applicable' }, thread: { id: 't1', parentChannelId: 'c0', name: '相談', archived: false, locked: false }, mentions: [], forwarded: [], attachments: [], embeds: [], stickers: [], pinned: false } }));
assert.deepEqual(thread.location.thread, { id: 't1', name: '相談', parentChannelId: 'c0' });

console.log('slim envelope ok (既定値を省く / 意味のある欄は残す / 1件 1,100 文字 → 約 250 文字)');
