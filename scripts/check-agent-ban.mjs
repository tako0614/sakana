// /agentban: AI エージェントを使えなくした人には応えない (サーバーごと)。
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'sakana-agent-ban-'));
process.env.ARCHIVE_DB_PATH = join(dir, 'archive.sqlite');
process.env.OPENROUTER_API_KEY = 'check';

const { isAgentBanned, banAgentUser, unbanAgentUser, listAgentBans } = await import('../src/agent/ratelimit.js');
const { isAgentRequest } = await import('../src/agent/index.js');
const { agentCommands } = await import('../src/agent/commands.js');

// ---- 保存 -------------------------------------------------------------------
assert.equal(isAgentBanned('g1', 'u1'), false, 'nobody is banned at first');
assert.equal(isAgentBanned(null, 'u1'), false);
assert.equal(isAgentBanned('g1', undefined), false);
assert.equal(banAgentUser('g1', 'u1', 'admin', 'spam'), true, 'a new ban says so');
assert.equal(isAgentBanned('g1', 'u1'), true);
assert.equal(isAgentBanned('g2', 'u1'), false, 'a ban is per server');
assert.equal(isAgentBanned('g1', 'u2'), false, 'and per person');
assert.equal(banAgentUser('g1', 'u1', 'admin2', '  もう一度  '), false, 'banning again only updates the note');
assert.deepEqual(listAgentBans('g1').map((row) => [row.userId, row.reason, row.bannedBy]), [['u1', 'もう一度', 'admin2']]);
assert.equal(banAgentUser('g1', 'u3', null, ''), true);
assert.equal(listAgentBans('g1').find((row) => row.userId === 'u3').reason, null, 'an empty reason is no reason');
assert.deepEqual(listAgentBans('g2'), []);
assert.equal(unbanAgentUser('g1', 'u3'), true);
assert.equal(unbanAgentUser('g1', 'u3'), false, 'unbanning someone who is not banned says so');

// ---- 呼びかけに応えるか ------------------------------------------------------------
const client = { user: { id: 'bot' } };
const mention = (guildId, userId) => ({
  guildId, author: { id: userId, bot: false }, webhookId: null, content: '<@bot> こんにちは',
  mentions: { has: () => true }, reference: null
});
assert.equal(isAgentRequest(mention('g1', 'u2'), client), true, 'a mention from someone allowed starts the agent');
assert.equal(isAgentRequest(mention('g1', 'u1'), client), false, 'a banned person is ignored');
assert.equal(isAgentRequest(mention('g2', 'u1'), client), true, 'in another server the same person is fine');
assert.equal(unbanAgentUser('g1', 'u1'), true);
assert.equal(isAgentRequest(mention('g1', 'u1'), client), true, 'after the ban is lifted the agent answers again');

// ---- コマンド ----------------------------------------------------------------------
const ban = agentCommands.find((entry) => entry.data.name === 'agentban');
assert.ok(ban, '/agentban is registered with the agent commands');
assert.deepEqual(ban.data.options.map((option) => option.name), ['add', 'remove', 'list']);

console.log('agent ban ok (サーバーごと・人ごと / 理由の更新 / 呼びかけを無視 / 戻すと応える / add・remove・list)');
