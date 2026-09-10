import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const directory = mkdtempSync(join(tmpdir(), 'sakana-manual-'));
process.env.DATABASE_PATH = join(directory, 'main.sqlite');
process.env.ARCHIVE_DB_PATH = join(directory, 'archive.sqlite');
const db = await import('../src/governance/db.js');
const { loadBootstrapDocuments } = await import('../src/governance/config.js');
const { executeDiscordSanction, governancePermissionReport } = await import('../src/governance/discord.js');
const { advanceCase, processGovernanceOutbox } = await import('../src/governance/service.js');
const { manualExecutionDetail, reportManualExecution } = await import('../src/governance/manual-execution.js');
const { renderGovernanceActionCards } = await import('../src/governance/ux.js');
const { PermissionFlagsBits } = await import('discord.js');
const guildId = 'manual-guild';
db.bootstrapGovernanceGuild({ guildId, enactedBy: 'owner', trustedRoleId: 'trusted', enforcementMode: 'live',
  ...loadBootstrapDocuments({ serverName: 'Manual Test' }), appealRoleId: 'appeal', categoryId: 'category',
  parliamentForumId: 'parliament', courtForumId: 'court', courtChatChannelId: 'court', procedureChannelId: 'procedure' });
const root = db.getActiveConstitution(guildId);
let externalCalls = 0;
const roles = new Map();
const guild = { id: guildId, name: 'Manual Test', ownerId: 'owner', roles: { cache: roles },
  members: { me: { permissions: { has: (permission) => ![PermissionFlagsBits.KickMembers, PermissionFlagsBits.BanMembers].includes(permission) } },
    fetch: async (input) => { const id = typeof input === 'string' ? input : input.user; return {
      id, user: { bot: id === 'bot' }, permissions: { has: () => id === 'admin' || id === 'bot' },
      roles: { remove: async () => {} }, kick: async () => { externalCalls++; }
    }; }, ban: async () => { externalCalls++; }, unban: async () => { externalCalls++; } },
  channels: { fetch: async () => null } };
guild.client = { user: { id: 'bot' }, guilds: { cache: new Map([[guildId, guild]]) } };
assert.equal(governancePermissionReport(guild).ok, true, 'ban/kick権限を要求しない');
const makeSanction = (type, required = 0) => {
  const record = db.createCase({ guildId, reporterId: 'reporter', accusedId: `target-${type}`, summary: '裁定済みのテスト', constitutionId: root.id });
  db.updateCase(record.id, { status: 'execution' });
  const sanction = db.createSanction({ caseId: record.id, guildId, userId: record.accused_id, type,
    status: 'queued', requiredApprovals: required });
  db.enqueueAction({ guildId, actionType: 'sanction_execute', targetId: sanction.id,
    payload: { sanctionId: sanction.id }, idempotencyKey: `manual-test:${sanction.id}` });
  return sanction;
};
for (const type of ['ban', 'kick']) {
  const sanction = makeSanction(type);
  await assert.rejects(() => executeDiscordSanction(guild, sanction), /手動執行/);
  await processGovernanceOutbox(guild.client);
  let current = db.getSanction(sanction.id);
  assert.equal(current.status, 'pending_manual_execution');
  assert.equal(current.executed_at, null);
  assert.equal(db.getCase(current.case_id).finalized_at, null);
  const requestKey = manualExecutionDetail(current).manualRequest.key;
  const input = { sanctionId: current.id, requestKey, result: 'done' };
  const card = renderGovernanceActionCards(guild).find((card) => card.key === `manual:${current.id}`);
  assert.equal(card.components[0].toJSON().components[0].custom_id, `gov:manual:${current.id}:${requestKey}-done`);
  assert.equal(card.components[0].toJSON().components[0].label, '執行完了');
  await advanceCase(guild, db.getCase(current.case_id));
  assert.equal(db.getSanction(current.id).status, 'pending_manual_execution', '待機を自動執行キューへ戻さない');
  await assert.rejects(() => reportManualExecution(guild, 'regular', input), /管理者/);
  await assert.rejects(() => reportManualExecution(guild, 'bot', input), /管理者/);
  await assert.rejects(() => reportManualExecution({ ...guild, id: 'other' }, 'admin', input), /変更・取消/);
  await assert.rejects(() => reportManualExecution(guild, 'admin', { ...input, requestKey: 'stale' }), /変更・取消/);
  await reportManualExecution(guild, 'admin', input);
  current = db.getSanction(current.id);
  assert.equal(current.status, 'executed');
  assert.ok(db.getCase(current.case_id).finalized_at);
  assert.equal(manualExecutionDetail(current).manualReports[0].reportedBy, 'admin');
  assert.equal(manualExecutionDetail(current).manualReports[0].evidence, 'administrator_report');
  await assert.rejects(() => reportManualExecution(guild, 'admin', input), /変更・取消/);
  db.enqueueAction({ guildId, actionType: 'sanction_reverse', targetId: current.id,
    payload: { sanctionId: current.id }, idempotencyKey: `reverse-test:${current.id}` });
  await processGovernanceOutbox(guild.client);
  current = db.getSanction(current.id);
  assert.equal(current.status, 'pending_manual_reversal');
  await reportManualExecution(guild, 'owner', { sanctionId: current.id, requestKey: manualExecutionDetail(current).manualRequest.key, result: 'done' });
  assert.equal(db.getSanction(current.id).status, 'reversed');
}
const unapproved = makeSanction('ban', 2);
await processGovernanceOutbox(guild.client);
assert.equal(db.getSanction(unapproved.id).status, 'queued', '承認不足なら管理者への執行依頼も開始しない');
assert.equal(externalCalls, 0, 'Botはban/kick/unbanを一度も呼ばない');
console.log('check-manual-execution: ok (human buttons, authority, stale/replayed reports, reversal, no bot ban/kick)');
