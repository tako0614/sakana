import 'dotenv/config';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// External access is read-only: Discord GETs and independent AI review. All
// records go to a fresh local DB; this script cannot cast a person's ballot.
const output = mkdtempSync(join(tmpdir(), 'sakana-live-review-'));
process.env.DATABASE_PATH = join(output, 'governance.sqlite');
process.env.ARCHIVE_DB_PATH = join(output, 'archive.sqlite');
let guildId = process.env.GOVERNANCE_GUILD_ID ?? process.env.DISCORD_GUILD_ID;
assert.ok(process.env.DISCORD_TOKEN, 'Discordの接続設定が必要です。');
async function discord(path) {
  const response = await fetch(`https://discord.com/api/v10${path}`, {
    headers: { Authorization: `Bot ${process.env.DISCORD_TOKEN}` }, signal: AbortSignal.timeout(20000)
  });
  if (!response.ok) throw new Error(`Discord ${path}: HTTP ${response.status}`);
  return response.json();
}
if (!/^\d{17,20}$/.test(guildId ?? '')) {
  const available = await discord('/users/@me/guilds');
  const allowed = String(process.env.ALLOWED_GUILDS ?? '').split(/[\s,]+/).filter(Boolean);
  const candidates = allowed.length ? available.filter((entry)=>allowed.includes(entry.id)) : available;
  assert.equal(candidates.length,1,'対象が複数の場合はGOVERNANCE_GUILD_IDを明示してください。');
  guildId=candidates[0].id;
}
const [guild, roles, me] = await Promise.all([discord(`/guilds/${guildId}`), discord(`/guilds/${guildId}/roles`), discord('/users/@me')]);
const rawMembers = [];
for (let after = null; ; ) {
  const page = await discord(`/guilds/${guildId}/members?limit=1000${after ? `&after=${after}` : ''}`);
  rawMembers.push(...page);
  if (page.length < 1000) break;
  after = page.at(-1).user.id;
}
const rolePermissions = new Map(roles.map((role) => [role.id, BigInt(role.permissions)]));
const members = new Map(rawMembers.map((member) => {
  const permissions = [guildId, ...member.roles].reduce((bits, id) => bits | (rolePermissions.get(id) ?? 0n), 0n);
  return [member.user.id, { id: member.user.id, user: member.user, roles: { cache: new Map(member.roles.map((id) => [id, true])) }, permissions: { has: (flag) => (permissions & flag) === flag } }];
}));
guild.ownerId = guild.owner_id;
const { loadBootstrapDocuments, governanceConfig } = await import('../src/governance/config.js');
const { selectHumanMembers } = await import('../src/governance/human-authority.js');
const administrators = selectHumanMembers(members, { scope: 'administrators' }, { guild });
assert.ok(administrators.includes(guild.owner_id), 'サーバー所有者を管理者として解決する');
assert.ok(!administrators.includes(me.id), '管理者権限を持つBotを人間の承認者に含めない');
const catalogResponse = await fetch(`${governanceConfig.lawSiteUrl}/v1/laws?guild=${guildId}`, { signal: AbortSignal.timeout(20000) });
assert.equal(catalogResponse.status, 200);
const catalog = await catalogResponse.json();
const activeCharter = catalog.instruments.find((item) => item.type === 'constitution' && item.status === 'active');
assert.ok(activeCharter, '公開された現行憲法が必要です。');
const { compileConstitution } = await import('../src/governance/rules.js');
const fullResponse = await fetch(`${governanceConfig.lawSiteUrl}/v1/laws/${encodeURIComponent(activeCharter.code)}?guild=${guildId}`, { signal: AbortSignal.timeout(20000) });
assert.equal(fullResponse.status, 200);
const full = await fullResponse.json();
const content = full.text ?? full.instrument?.text;
const activeLaws = await Promise.all(catalog.instruments.filter((item)=>item.type==='law' && item.status==='active').map(async (item) => {
  const response=await fetch(`${governanceConfig.lawSiteUrl}/v1/laws/${encodeURIComponent(item.code)}?guild=${guildId}`,{signal:AbortSignal.timeout(20000)});
  assert.equal(response.status,200);
  const law=await response.json();
  return {...law,id:Number(law.id),effective_at:law.effectiveAt,content_hash:law.contentHash};
}));
const current = { id: Number(activeCharter.id), guild_id: guildId, content, version: activeCharter.version,
  ...compileConstitution({ content, laws: activeLaws }) };
assert.ok(current.policy, '現行憲法はこの単独検証で読み取れる形式であること');
const connections = {guildId,guildName:guild.name,botId:me.id,members:members.size,administrators:administrators.length,
  publicConstitutionVersion:current.version,externalMutations:false};
writeFileSync(join(output,'connections.json'),JSON.stringify(connections,null,2));
if (process.argv.includes('--connections-only')) {
  console.log(JSON.stringify({output,...connections},null,2));
  process.exit(0);
}
assert.ok(governanceConfig.apiKey, `実AIの接続設定が必要です。Discord・法令の検証結果: ${output}/connections.json`);
const documents = loadBootstrapDocuments({ serverName: guild.name });
const db = await import('../src/governance/db.js');
db.bootstrapGovernanceGuild({guildId,enactedBy:guild.owner_id,trustedRoleId:'',enforcementMode:'shadow',...documents,
  constitution:current.content,policy:current.policy,laws:activeLaws,
  appealRoleId:'',categoryId:'local-test',parliamentForumId:'local-test',courtForumId:'local-test',courtChatChannelId:'local-test',procedureChannelId:'local-test'});
const {proposeLawDefinedGovernance} = await import('../src/governance/migration.js');
const proposal = proposeLawDefinedGovernance({guildId,serverName:guild.name,proposerId:me.id});
const { ratifyLegislativeDraft, runConstitutionalPanel } = await import('../src/governance/llm.js');
const target = { title:proposal.title, content:proposal.body.migration.constitution, bootstrapLaws:proposal.body.migration.laws,
  transition:proposal.summary };
const panel = current.rules.panels.amendmentAdoption ?? current.rules.panels.parliament;
const adoption = await ratifyLegislativeDraft({guildId,proposalId:proposal.id,constitution:current,target,activeLaws,
  institution:{name:'現行改憲案の検討',mandate:'公開された移行案の内容を独立に審議する。実際の成立は別途、現行の人間の投票に従う。',seats:panel.seats,required:{approve:panel.required.approve ?? panel.required.decision},tools:[]}});
const review = await runConstitutionalPanel({guildId,targetType:'amendment',targetId:proposal.id,phase:'pre',constitution:current,target});
const report = {guildId,guildName:guild.name,botId:me.id,members:members.size,administrators:administrators.length,
  publicConstitutionVersion:current.version,adoption,review,externalMutations:false};
writeFileSync(join(output,'report.json'), JSON.stringify(report,null,2));
console.log(JSON.stringify({output,guild:guild.name,members:members.size,administrators:administrators.length,
  adoption:adoption.verdict,review:review.outputs.map((entry)=>entry.verdict),externalMutations:false},null,2));
assert.equal(adoption.outputs.length,panel.seats);
assert.equal(review.outputs.length,current.rules.panels.constitutional.seats);
assert.equal(adoption.verdict,'approved');
assert.ok(review.outputs.every((entry)=>entry.verdict==='constitutional'), '実AIの修正指摘は保存したreport.jsonで確認してください。');
