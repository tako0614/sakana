// Compact conversation source rendering: one shared speaker legend and safely quoted text.
import assert from 'node:assert/strict';
import { RefTable, createConversationFormatter } from '../src/agent/format.ts';

const SELF = '111000111000111000';
const base = { guildId: 'g1', channelId: 'c1', channelName: 'general', createdAt: 1_700_000_000_000, reactionCount: 0, attachmentCount: 0 };
const say = (id, authorId, authorName, content, extra = {}) => ({ ...base, messageId: id, authorId, authorName, content, ...extra });

const rows = [
  say('1', '42', 'さば', 'こんにちは'),
  say('2', SELF, 'sakana', 'ぼくの発言', { isBot: true }),
  say('3', '42', 'さば', 'あ'.repeat(50), { reactionCount: 3, editedAt: base.createdAt + 1 }),
  say('4', '7', 'bot', '', { isBot: true, extra: '[埋め込み] タイトル' })
];
const formatter = createConversationFormatter(rows, { refs: new RefTable(), selfId: SELF });
const text = formatter.render(rows, { bodyChars: 100, showChannel: true });
assert.match(formatter.speakers, /u1 = さば（Discord ID: 42）/);
assert.match(formatter.speakers, /u2 = sakana（Discord ID: 111000111000111000）/);
assert.match(text, /#general u1:/);
assert.match(text, /#general u2:/);
assert.match(formatter.speakers, /u2 = .*\[自分\/bot\]/);
const cut = formatter.render([rows[2]], { bodyChars: 10 });
assert.match(cut, /> あ{10}/);
assert.match(cut, /本文を途中まで表示（全50文字）/);
assert.match(text, /反応数: 3（賛同の主張とは限らない）/);
assert.match(text, /状態: 編集済み/);
assert.match(text, /補足（発言者の言葉とは限らない）:\n\| \[埋め込み\] タイト/);
assert.doesNotMatch(text, /"schema"|guildId|webhookId/);

console.log('conversation renderer compact projection ok');
