// 道具の結果の1行形式の検証 (npm run check から tsx で呼ぶ)。
import assert from 'node:assert/strict';
import { RefTable, formatMessageLines, formatMessages } from '../src/agent/format.ts';

const SELF = 'BOT';
const base = { guildId: 'g1', channelId: 'c1', channelName: '雑談', createdAt: Date.UTC(2026, 7, 14, 5, 2), reactionCount: 0, attachmentCount: 0 };
const say = (id, authorId, authorName, content, extra = {}) => ({ ...base, messageId: id, authorId, authorName, content, ...extra });
const lines = (messages, options = {}) => formatMessageLines(messages, { refs: new RefTable(), selfId: SELF, ...options }).split('\n');

// 普通の発言: 番号・日時・名前・本文だけ (JSON の飾りは無い)
const [plain] = lines([say('100', '42', 'たこ', 'レビュー無しはやめよう')]);
assert.match(plain, /^1\) \d{2}\/\d{2} \d{2}:\d{2} たこ: レビュー無しはやめよう$/);
assert.ok(!/schema|guildId|webhook|"/.test(plain), 'no envelope noise');

// 場所は、チャンネルをまたぐ結果 (showChannel) のときだけ
assert.match(lines([say('1', '42', 'たこ', 'x')], { showChannel: true })[0], / #雑談 たこ: x$/);
assert.ok(!lines([say('1', '42', 'たこ', 'x')])[0].includes('#雑談'));

// 自分の発言・bot・返信 (↩N)・反応・編集済み
const rows = lines([
  say('100', '42', 'たこ', 'もとの発言'),
  say('101', '43', 'さば', 'それな', { replyTo: '100', reactionCount: 3 }),
  say('102', SELF, 'Evex公式', '前に言った', { isBot: true, replyTo: '101' }),
  say('103', '44', 'ねずみ', '改行を\nふくむ', { editedAt: base.createdAt + 1000 })
]);
assert.match(rows[1], /さば ↩1: それな \(反応3\)$/, 'a reply points at its parent by number');
assert.match(rows[2], /Evex公式\(あなた\)\[bot\] ↩2: 前に言った$/, 'my own lines are marked');
assert.ok(!rows[0].includes('(あなた)') && !rows[1].includes('(あなた)'), 'others are not marked as me');
assert.match(rows[3], /改行を ⏎ ふくむ \(編集済\)$/, 'newlines stay on one line');

// 返信先が引けない・消えている (推測で補わせない)
const [orphan] = lines([say('200', '42', 'たこ', 'x', { replyTo: '999' })]);
assert.match(orphan, /たこ ↩\(未取得\): x$/);
const [gone] = lines([say('201', '42', 'たこ', 'x', { replyTo: '998', structure: { version: 1, reference: { kind: 'reply', messageId: '998', availability: 'deleted' }, thread: { id: null }, mentions: [], forwarded: [], attachments: [], embeds: [], stickers: [], pinned: false } })]);
assert.match(gone, /↩\(削除済\)/);

// 本文の切り詰め・補足 (発言者の言葉ではない)・本文なし
const [cut] = lines([say('300', '42', 'たこ', 'あ'.repeat(50))], { bodyChars: 10 });
assert.match(cut, /あ{10}…\(全50字\)$/);
const [extra] = lines([say('301', '42', 'たこ', '見て', { extra: '[埋め込み] 記憶 / wiki' })]);
assert.match(extra, /見て ※補足\(発言者の言葉ではない\): \[埋め込み\] 記憶 \/ wiki$/);
const [onlyExtra] = lines([say('302', '42', 'たこ', '', { extra: '[スタンプ] うごく' })]);
assert.match(onlyExtra, /たこ: ※補足/);
assert.match(lines([say('303', '42', 'たこ', '')])[0], /たこ: \(本文なし\)$/);

// スレッドの発言はスレッドだと分かる
const [inThread] = lines([say('400', '42', 'たこ', 'x', { structure: { version: 1, reference: { kind: 'none', messageId: null, availability: 'not_applicable' }, thread: { id: 't1', parentChannelId: 'c0', name: '相談', archived: false, locked: false }, mentions: [], forwarded: [], attachments: [], embeds: [], stickers: [], pinned: false } })]);
assert.match(inThread, /\[スレッド:相談\] たこ: x$/);

// 番号は RefTable と共通 (read の at に渡せる)。親が子より後ろに並んでも ↩ が付く
const refs = new RefTable();
const out = formatMessageLines([say('501', '43', 'さば', '子', { replyTo: '500' }), say('500', '42', 'たこ', '親')], { refs, selfId: SELF }).split('\n');
assert.match(out[0], /^1\) .*さば ↩2: 子$/);
assert.match(out[1], /^2\) .*たこ: 親$/);
assert.equal(refs.byMessageId.get('500').ref ?? refs.byMessageId.get('500'), refs.byMessageId.get('500').ref ?? refs.byMessageId.get('500'));

// 大きさ: JSON の 1/4 以下
const many = Array.from({ length: 10 }, (_, i) => say(String(600 + i), '42', 'たこ', `発言 ${i} です`));
const asLines = formatMessageLines(many, { refs: new RefTable(), selfId: SELF }).length;
const asJson = formatMessages(many, { refs: new RefTable(), selfId: SELF }).length;
assert.ok(asLines * 3 < asJson, `lines ${asLines} vs json ${asJson}`);

console.log(`message lines ok (1件 約 ${Math.round(asLines / 10)} 文字 / JSON は 約 ${Math.round(asJson / 10)} 文字)`);
