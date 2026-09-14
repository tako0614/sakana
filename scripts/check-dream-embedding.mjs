import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const dir = mkdtempSync(join(tmpdir(), 'sakana-dream-embedding-'));
const guildId = '1255359848644608035';
Object.assign(process.env, {
  ARCHIVE_DB_PATH: join(dir, 'archive.sqlite'), ATOM_MEMORY_PATH: join(dir, 'atoms.sqlite'),
  AGENT_RUNTIME_PATH: join(dir, 'runs.sqlite'), MEMORY_DREAMING_ENABLED: 'true',
  MEMORY_DREAMING_GUILDS: guildId, MEMORY_EMBEDDINGS: 'true', SEMANTIC_SEARCH: 'false',
  OPENROUTER_API_KEY: 'fixture', MEMORY_DREAMING_EMBEDDING_DIMENSIONS: '4096'
});
const { db, saveMessage, upsertChannel } = await import('../src/archive/db.js');
const { toRecord } = await import('../src/archive/indexer.js');
const { ensureModelBudget, modelBudgetStatus, setModelBudgetPaused } = await import('../src/ai/cost.js');
const { openRouterConversationEmbedding } = await import('../src/conversation/embedding.js');
const { syncConversationMemory, updateConversationIndex, conversationMemory } = await import('../src/conversation/memory.js');
const originalFetch = globalThis.fetch;
const posts = [];
globalThis.fetch = async (url, options) => {
  if (url.endsWith('/endpoints')) return { ok: true, json: async () => ({ data: { endpoints: [{ pricing: { prompt: '0.00000001', completion: '0' } }] } }) };
  assert.equal(url, 'https://openrouter.ai/api/v1/embeddings');
  const body = JSON.parse(options.body); posts.push(body);
  return { ok: true, json: async () => ({ model: body.model, id: `embedding-${posts.length}`,
    usage: { prompt_tokens: 20, total_tokens: 20, cost: 0.0000002 },
    data: body.input.map((_, index) => ({ index, embedding: Array.from({ length: 4096 }, (_, i) => i === 0 ? 1 : 0) })) }) };
};
try {
  const budgetId = `dream:${guildId}:v1`;
  ensureModelBudget({ id: budgetId, guildId, limitUsd: 30 });
  db.exec('CREATE TABLE dream_jobs(guild_id TEXT PRIMARY KEY,state TEXT,budget_id TEXT)');
  db.prepare('INSERT INTO dream_jobs VALUES(?,?,?)').run(guildId, 'running', budgetId);
  const row = (id, guild) => ({ id, content: 'qwen_context_memory deploy condition', guildId: guild,
    channelId: `c-${guild}`, author: { id: 'alice', username: 'alice' }, createdTimestamp: 1700000000000,
    attachments: new Map(), reactions: { cache: new Map() } });
  saveMessage(toRecord(row('source', guildId)));
  saveMessage(toRecord(row('foreign', 'other')));
  for (const guild of [guildId, 'other']) upsertChannel({ channel_id: `c-${guild}`, guild_id: guild,
    parent_id: null, name: 'context', type: 0, is_thread: 0, is_private: 0 });
  await syncConversationMemory();
  const indexed = await updateConversationIndex({ guildIds: [guildId] });
  assert.ok(indexed.indexed > 0, 'Dream Qwen is independent of local SEMANTIC_SEARCH');
  assert.ok(posts.every(body => body.model === 'qwen/qwen3-embedding-8b' && body.dimensions === 4096));
  assert.ok(posts.every(body => body.input.every(text => !text.startsWith('passage: ') && !text.startsWith('Instruct: '))));
  const documentCalls = posts.length;
  assert.equal((await updateConversationIndex({ guildIds: [guildId] })).indexed, 0);
  assert.equal(posts.length, documentCalls, 'unchanged vectors reuse the Qwen index');
  await updateConversationIndex({ guildIds: ['other'] });
  assert.equal(posts.length, documentCalls, 'other guild never uses the Evex remote host');
  const guild = { id: guildId, members: { me: { id: 'bot' }, everyone: { id: guildId } }, channels: { cache: new Map() } };
  const channel = { id: `c-${guildId}`, guild, guildId, type: 0, permissionsFor: () => ({ has: () => true }) };
  guild.channels.cache.set(channel.id, channel);
  const memory = conversationMemory({ guildId, channel, member: { id: 'reader' } });
  try { assert.match((await memory.read({ context: 'qwen_context_memory' })).text, /deploy condition/); }
  finally { memory.close(); }
  assert.ok(posts.slice(documentCalls).some(body => body.input.some(text => text.startsWith('Instruct: Retrieve memories relevant to the current conversation context'))));
  assert.equal(modelBudgetStatus(budgetId).calls, posts.length, 'document and query costs share one budget');
  assert.equal(db.prepare('SELECT count(*) n FROM ai_model_calls WHERE guild_id<>? OR budget_id<>?').get(guildId, budgetId).n, 0);
  const alternate = `${budgetId}:rotated`;
  ensureModelBudget({ id: alternate, guildId, limitUsd: 30 });
  const beforeRotation = posts.length;
  const fetchFixture = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    if (url.endsWith('/endpoints')) db.prepare('UPDATE dream_jobs SET budget_id=? WHERE guild_id=?').run(alternate, guildId);
    return fetchFixture(url, options);
  };
  db.prepare('UPDATE ai_model_rates SET checked_at=0').run();
  const rotated = conversationMemory({ guildId, channel, member: { id: 'reader-rotation' } });
  try { assert.equal(await rotated.read({ context: 'qwen_context_memory rotated input' }), null); }
  finally { rotated.close(); }
  assert.equal(posts.length, beforeRotation, 'rotation during pricing cancels the stale-budget POST and skips optional recall');
  globalThis.fetch = fetchFixture;
  db.prepare('UPDATE dream_jobs SET budget_id=? WHERE guild_id=?').run(budgetId, guildId);
  const defaultId = openRouterConversationEmbedding({ guildId }).id;
  process.env.MEMORY_DREAMING_EMBEDDING_DIMENSIONS = '1024';
  assert.notEqual(openRouterConversationEmbedding({ guildId }).id, defaultId);
  setModelBudgetPaused(budgetId, true);
  const pausedPosts = posts.length;
  assert.equal((await updateConversationIndex({ guildIds: [guildId] })).paused, true);
  const lexical = conversationMemory({ guildId, channel, member: { id: 'reader' } });
  try { assert.match((await lexical.read({ context: 'qwen_context_memory' })).text, /deploy condition/); }
  finally { lexical.close(); }
  assert.equal(posts.length, pausedPosts, 'paused budget uses lexical recall without another paid request');
  console.log('Dream embeddings: Qwen routing, dimensions, query instruction, index reuse, guild accounting and paused lexical recall passed');
} finally {
  globalThis.fetch = originalFetch; db.close(); rmSync(dir, { recursive: true, force: true });
}
