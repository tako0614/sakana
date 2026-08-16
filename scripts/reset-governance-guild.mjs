#!/usr/bin/env node
// 立法をAI国会へ作り直したため、旧手続で動いていたサーバーは統治DBを白紙に戻して
// `/governance` から導入し直します。このスクリプトはDiscord側を一切触りません。
// 旧「法令集」channelと旧「立法」roleの削除は、内容を確認したうえで人が行います。
import 'dotenv/config';
import { existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { governanceDatabase } from '../src/governance/db.js';

// guild_id を持つ統治テーブルだけ。子テーブルは親の削除前に個別で消す。
const GUILD_TABLES = [
  'governance_active_restrictions',
  'governance_activity',
  'governance_administrative_acts',
  'governance_agent_attempts',
  'governance_ai_calls',
  'governance_audit',
  'governance_cases',
  'governance_constitutions',
  'governance_instrument_relations',
  'governance_intakes',
  'governance_interim_protections',
  'governance_law_publications',
  'governance_laws',
  'governance_legacy_message_archive',
  'governance_mention_investigations',
  'governance_notifications',
  'governance_outbox',
  'governance_parliament_sessions',
  'governance_proposals',
  'governance_reviews',
  'governance_sanction_definitions',
  'governance_sanctions',
  'governance_settings',
  'governance_setup_sessions',
  'governance_statute_publications',
  'governance_surface_migrations',
  'governance_trusted_mutations',
  'governance_workflow_instances',
  'governance_guilds'
];

// 親行の guild_id からしか辿れない子テーブル。親より先に消す。
const CHILD_TABLES = [
  ['governance_workflow_events', 'workflow_instance_id', 'governance_workflow_instances'],
  ['governance_appeals', 'case_id', 'governance_cases'],
  ['governance_case_approvals', 'case_id', 'governance_cases'],
  ['governance_case_decisions', 'case_id', 'governance_cases'],
  ['governance_case_evidence', 'case_id', 'governance_cases'],
  ['governance_case_submissions', 'case_id', 'governance_cases'],
  ['governance_proposal_deliberations', 'proposal_id', 'governance_proposals'],
  ['governance_proposal_voters', 'proposal_id', 'governance_proposals'],
  ['governance_votes', 'proposal_id', 'governance_proposals'],
  ['governance_vote_history', 'proposal_id', 'governance_proposals'],
  ['governance_investigation_evidence', 'investigation_id', 'governance_mention_investigations'],
  ['governance_restriction_usage', 'restriction_id', 'governance_active_restrictions']
];

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : '';
}

const guildId = argument('--guild');
const confirm = argument('--confirm');
const apply = process.argv.includes('--apply');
if (!/^\d{17,20}$/.test(guildId)) {
  console.error('usage: node scripts/reset-governance-guild.mjs --guild <id> [--confirm <server name>] [--apply]');
  process.exit(2);
}

const governance = governanceDatabase.prepare('SELECT * FROM governance_guilds WHERE guild_id = ?').get(guildId);
if (!governance) throw new Error('このサーバーでは統治が初期化されていません。');

const existing = new Set(governanceDatabase.prepare(
  "SELECT name FROM sqlite_master WHERE type = 'table'"
).all().map((row) => row.name));
const tables = GUILD_TABLES.filter((table) => existing.has(table));
const counts = Object.fromEntries(tables.map((table) => [
  table,
  governanceDatabase.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE guild_id = ?`).get(guildId).count
]).filter(([, count]) => count > 0));

const summary = { guildId, apply, counts };
if (!apply) {
  console.log(JSON.stringify({ ...summary, note: '--apply と --confirm <サーバー名> を付けると削除します。' }, null, 2));
  process.exit(0);
}

// 実行時だけサーバー名の再入力を要求する。取り違えた瞬間に統治記録が消えるため。
const serverName = String(governanceDatabase.prepare(
  'SELECT content FROM governance_constitutions WHERE id = ?'
).get(governance.active_constitution_id)?.content ?? '').match(/^#\s*(.+?)憲法$/m)?.[1] ?? '';
if (!confirm || confirm.trim() !== serverName.replace(/\\([\\`*_{}[\]()<>#+\-.!|])/g, '$1')) {
  throw new Error(`--confirm には現行憲法のサーバー名をそのまま渡してください: ${serverName}`);
}

const backupDirectory = resolve('backups');
if (!existsSync(backupDirectory)) mkdirSync(backupDirectory, { recursive: true });
const backup = join(backupDirectory, `database-pre-governance-reset-${guildId}.sqlite`);
if (existsSync(backup)) throw new Error(`既存のbackupがあります: ${backup}`);
await governanceDatabase.backup(backup);

const removed = governanceDatabase.transaction(() => {
  const result = {};
  for (const [child, column, parent] of CHILD_TABLES) {
    if (!existing.has(child) || !existing.has(parent)) continue;
    result[child] = governanceDatabase.prepare(`
      DELETE FROM ${child} WHERE ${column} IN (SELECT id FROM ${parent} WHERE guild_id = ?)
    `).run(guildId).changes;
  }
  for (const table of tables) {
    result[table] = governanceDatabase.prepare(`DELETE FROM ${table} WHERE guild_id = ?`).run(guildId).changes;
  }
  return result;
})();

console.log(JSON.stringify({
  ...summary,
  databaseBackup: backup,
  removed,
  next: '`/governance` を実行し、新しい初期憲法で導入し直してください。旧「法令集」channelと旧「立法」roleは手で削除します。'
}, null, 2));
governanceDatabase.close();
