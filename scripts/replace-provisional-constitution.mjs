#!/usr/bin/env node
import 'dotenv/config';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { REST, Routes } from 'discord.js';
import { governanceCategoryName, loadBootstrapDocuments } from '../src/governance/config.js';
import { governanceDatabase, writeAudit } from '../src/governance/db.js';
import { canonicalJson, policyHash, sha256 } from '../src/governance/policy.js';

const PROVISIONAL_HASH = 'cb23820a8a9f91f32f66544ebb499c660f7863781e5d65d283f1e081affdf9d2';
const PROVISIONAL_POLICY_HASH = 'e9dfe0206652e5c041342a6a53c0208d17743fdbe8b2cd49557a04a070033b89';
const EMPTY_TABLES = [
  'governance_proposals',
  'governance_laws',
  'governance_cases',
  'governance_sanctions',
  'governance_administrative_acts'
];

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : '';
}

function messageChunks(heading, body) {
  const chunks = [];
  let rest = `# ${heading}\n\n${body}`;
  while (rest.length > 0) {
    chunks.push(rest.slice(0, 1900));
    rest = rest.slice(1900);
  }
  return chunks;
}

function initialGazetteMessages(messages) {
  const ordered = [...messages].sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
  const start = ordered.findIndex((message) => message.content.startsWith('# 初期憲法 v1\n\n# Sakana Community Constitution'));
  if (start < 0) return [];
  const selected = [];
  for (const message of ordered.slice(start)) {
    if (message.author.id !== process.env.DISCORD_CLIENT_ID) return [];
    selected.push(message);
    if (message.content.includes(`policy hash: ${PROVISIONAL_POLICY_HASH}`)) return selected;
  }
  return [];
}

function replacementGazetteMessages(messages, serverName, replacementPolicyHash) {
  const ordered = [...messages].sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
  const headings = [
    `# 初期憲法 v1\n\n# ${serverName}憲法`,
    `# 初期憲法 v1（正本・差替済み）\n\n# ${serverName}憲法`
  ];
  const start = ordered.findIndex((message) => headings.some((heading) => message.content.startsWith(heading)));
  if (start < 0) return [];
  const selected = [];
  for (const message of ordered.slice(start)) {
    if (message.author.id !== process.env.DISCORD_CLIENT_ID) return [];
    selected.push(message);
    if (message.content.includes(`policy hash: ${replacementPolicyHash}`)) return selected;
  }
  return [];
}

const guildId = argument('--guild');
const serverName = argument('--server-name');
const apply = process.argv.includes('--apply');
if (!/^\d{17,20}$/.test(guildId) || !serverName.trim()) {
  console.error('usage: node scripts/replace-provisional-constitution.mjs --guild <id> --server-name <name> [--apply]');
  process.exit(2);
}

const documents = loadBootstrapDocuments({ serverName });
const replacementHash = sha256(documents.constitution);
const replacementPolicyHash = policyHash(documents.policy);
const governance = governanceDatabase.prepare(`
  SELECT * FROM governance_guilds WHERE guild_id = ?
`).get(guildId);
const current = governance && governanceDatabase.prepare(`
  SELECT * FROM governance_constitutions WHERE id = ?
`).get(governance.active_constitution_id);
const counts = Object.fromEntries(EMPTY_TABLES.map((table) => [
  table,
  governanceDatabase.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE guild_id = ?`).get(guildId).count
]));

if (!governance || !current) throw new Error('統治が初期化されていません。');
if (governance.status !== 'active' || governance.enforcement_mode !== 'shadow' || current.version !== 1) {
  throw new Error('activeかつshadowの初期憲法v1だけを置換できます。');
}
if (Object.values(counts).some((count) => count !== 0)) {
  throw new Error(`統治案件が既に存在します: ${JSON.stringify(counts)}`);
}
if (![PROVISIONAL_HASH, replacementHash].includes(current.content_hash)) {
  throw new Error(`想定外の現行憲法hashです: ${current.content_hash}`);
}

const summary = {
  guildId,
  serverName,
  mode: apply ? 'apply' : 'dry-run',
  currentHash: current.content_hash,
  replacementHash,
  counts,
  categoryId: governance.category_id,
  gazetteChannelId: governance.gazette_channel_id
};
if (!apply) {
  console.log(JSON.stringify(summary, null, 2));
  governanceDatabase.close();
  process.exit(0);
}

const backupDirectory = resolve('backups');
mkdirSync(backupDirectory, { recursive: true });
const databaseBackup = join(backupDirectory, `database-pre-constitution-replacement-${guildId}.sqlite`);

if (current.content_hash === PROVISIONAL_HASH) {
  if (existsSync(databaseBackup)) throw new Error(`既存のDBバックアップがあります: ${databaseBackup}`);
  await governanceDatabase.backup(databaseBackup);
  governanceDatabase.transaction(() => {
    const result = governanceDatabase.prepare(`
      UPDATE governance_constitutions
      SET content = ?, policy_json = ?, content_hash = ?, policy_hash = ?, enacted_by = ?, enacted_at = ?
      WHERE id = ? AND version = 1 AND content_hash = ?
    `).run(
      documents.constitution,
      canonicalJson(documents.policy),
      replacementHash,
      replacementPolicyHash,
      current.enacted_by,
      Date.now(),
      current.id,
      PROVISIONAL_HASH
    );
    if (result.changes !== 1) throw new Error('初期憲法の置換対象が競合しました。');
    writeAudit({
      guildId,
      actorType: 'operator',
      actorId: current.enacted_by,
      action: 'constitution.provisional_replaced',
      targetType: 'constitution',
      targetId: current.id,
      detail: {
        reason: '未承認の仮初期草案を主権者が指定した初期憲法へ置換',
        previousHash: PROVISIONAL_HASH,
        replacementHash
      }
    });
  })();
}

const token = process.env.DISCORD_TOKEN;
const clientId = process.env.DISCORD_CLIENT_ID;
if (!token || !clientId) throw new Error('DISCORD_TOKENとDISCORD_CLIENT_IDが必要です。');
const rest = new REST({ version: '10' }).setToken(token);
await rest.patch(Routes.channel(governance.category_id), {
  body: { name: governanceCategoryName(serverName) },
  reason: 'Replace provisional governance naming with server-owned naming'
});

const messages = await rest.get(Routes.channelMessages(governance.gazette_channel_id), { query: new URLSearchParams({ limit: '100' }) });
const provisionalMessages = initialGazetteMessages(messages);
const replacementMessages = replacementGazetteMessages(messages, serverName, replacementPolicyHash);
const gazetteBackup = join(backupDirectory, `gazette-pre-constitution-replacement-${guildId}.json`);
if (provisionalMessages.length > 0) {
  if (existsSync(gazetteBackup)) throw new Error(`既存の官報バックアップがあります: ${gazetteBackup}`);
  writeFileSync(gazetteBackup, `${JSON.stringify(provisionalMessages, null, 2)}\n`, { mode: 0o600 });
}

const body = `${documents.constitution}\n\n## Policy\n\n\`\`\`json\n${JSON.stringify(documents.policy, null, 2)}\n\`\`\`\n\ncontent hash: ${replacementHash}\npolicy hash: ${replacementPolicyHash}`;
const published = [];
if (replacementMessages.length === 0) {
  for (const content of messageChunks('初期憲法 v1', body)) {
    const message = await rest.post(Routes.channelMessages(governance.gazette_channel_id), {
      body: { content, allowed_mentions: { parse: [] } }
    });
    published.push(message.id);
  }
} else {
  const first = replacementMessages[0];
  const legacyHeading = '# 初期憲法 v1（正本・差替済み）';
  if (first.content.startsWith(legacyHeading)) {
    await rest.patch(Routes.channelMessage(governance.gazette_channel_id, first.id), {
      body: { content: first.content.replace(legacyHeading, '# 初期憲法 v1'), allowed_mentions: { parse: [] } }
    });
  }
}
for (const message of provisionalMessages) {
  await rest.delete(Routes.channelMessage(governance.gazette_channel_id, message.id), {
    reason: 'Remove superseded provisional initial constitution'
  });
}

console.log(JSON.stringify({
  ...summary,
  databaseBackup: existsSync(databaseBackup) ? databaseBackup : null,
  oldGazetteMessagesRemoved: provisionalMessages.map((message) => message.id),
  newGazetteMessages: published,
  existingGazetteMessages: replacementMessages.map((message) => message.id)
}, null, 2));
governanceDatabase.close();
