import 'dotenv/config';
import { parseArgs } from 'node:util';
const {values}=parseArgs({options:{guild:{type:'string'},name:{type:'string'},actor:{type:'string'},propose:{type:'boolean',default:false}}});
if (!values.guild || !values.name || !values.actor) throw new Error('Usage: node scripts/propose-governance-migration.mjs --guild ID --name NAME --actor OPERATOR_ID [--propose]');
const {getActiveConstitution}=await import('../src/governance/db.js');
const current=getActiveConstitution(values.guild);
if (!values.propose) {
  console.log(JSON.stringify({guild:values.guild,currentVersion:current?.version,currentHash:current?.content_hash,
    action:'--propose creates an amendment agenda item. AI review and the current public vote must pass; it does not enact a constitution or delete records.'},null,2));
} else {
  const {proposeLawDefinedGovernance}=await import('../src/governance/migration.js');
  const proposal=proposeLawDefinedGovernance({guildId:values.guild,serverName:values.name,proposerId:values.actor});
  console.log(JSON.stringify({proposalId:proposal.id,status:proposal.status,title:proposal.title},null,2));
}
