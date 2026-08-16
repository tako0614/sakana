#!/usr/bin/env node
import 'dotenv/config';
import { existsSync, mkdirSync } from 'node:fs';
import { once } from 'node:events';
import { join, resolve } from 'node:path';
import { Client, GatewayIntentBits } from 'discord.js';
import { governanceCategoryName, loadBootstrapDocuments } from '../src/governance/config.js';
import { getGovernanceGuild, governanceDatabase, writeAudit } from '../src/governance/db.js';
import { syncLawSite } from '../src/governance/lawsite.js';
import { ensureGovernanceUx } from '../src/governance/ux.js';
import { canonicalJson, policyHash, sha256 } from '../src/governance/policy.js';
import { compileConstitution } from '../src/governance/rules.js';

// 統治案件がまだ1件も無い導入直後だけ、初期憲法を差し替えられる。
// 法律・事件・処分が1件でもあれば、変更は改憲手続にしか通せない。
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

const summary = {
  guildId,
  serverName,
  mode: apply ? 'apply' : 'dry-run',
  currentHash: current.content_hash,
  replacementHash,
  counts,
  categoryId: governance.category_id
};
if (!apply) {
  console.log(JSON.stringify(summary, null, 2));
  governanceDatabase.close();
  process.exit(0);
}

const backupDirectory = resolve('backups');
mkdirSync(backupDirectory, { recursive: true });
const databaseBackup = join(backupDirectory, `database-pre-constitution-replacement-${guildId}.sqlite`);

if (current.content_hash !== replacementHash) {
  if (existsSync(databaseBackup)) throw new Error(`既存のDBバックアップがあります: ${databaseBackup}`);
  await governanceDatabase.backup(databaseBackup);
  governanceDatabase.transaction(() => {
    // 実行規則も一緒に差し替える。ここを忘れるとbotは古いrules_jsonを読み続ける。
    const compiled = compileConstitution({ content: documents.constitution });
    const result = governanceDatabase.prepare(`
      UPDATE governance_constitutions
      SET content = ?, policy_json = ?, content_hash = ?, policy_hash = ?, enacted_by = ?, enacted_at = ?,
          source_format = ?, rules_json = ?, rules_hash = ?, compiler_version = ?
      WHERE id = ? AND version = 1 AND content_hash = ?
    `).run(
      documents.constitution,
      canonicalJson(compiled.policy),
      replacementHash,
      replacementPolicyHash,
      current.enacted_by,
      Date.now(),
      compiled.sourceFormat,
      canonicalJson(compiled.rules),
      compiled.rulesHash,
      compiled.compilerVersion,
      current.id,
      current.content_hash
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
        previousHash: current.content_hash,
        replacementHash
      }
    });
  })();
}

const token = process.env.DISCORD_TOKEN;
if (!token) throw new Error('DISCORD_TOKENが必要です。');
const client = new Client({ intents: [GatewayIntentBits.Guilds] });
await client.login(token);
if (!client.isReady()) await once(client, 'ready');
let synced;
try {
  const guild = client.guilds.cache.get(guildId) ?? await client.guilds.fetch(guildId);
  await guild.channels.fetch();
  const category = await guild.channels.fetch(governance.category_id);
  if (category.name !== governanceCategoryName(serverName)) {
    await category.setName(governanceCategoryName(serverName), '仮の統治名をサーバー名へ置換');
  }
  const ux = await ensureGovernanceUx(guild, getGovernanceGuild(guildId));
  const queued = syncLawSite(guild, { verifyExisting: true });
  synced = {
    procedureChannelId: ux.governance.procedure_channel_id,
    lawSiteQueued: queued.queued,
    lawSiteConfigured: !queued.skipped
  };
} finally {
  client.destroy();
}

console.log(JSON.stringify({
  ...summary,
  databaseBackup: existsSync(databaseBackup) ? databaseBackup : null,
  synced
}, null, 2));
governanceDatabase.close();
