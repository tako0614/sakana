import 'dotenv/config';

import { once } from 'node:events';
import { Client, GatewayIntentBits } from 'discord.js';
import {
  applyGovernanceSurfaceMigration,
  planGovernanceSurfaceMigration
} from '../src/governance/surface-migration.js';

function option(name) {
  const at = process.argv.indexOf(name);
  return at >= 0 ? process.argv[at + 1] : null;
}

function usage() {
  return [
    'Usage:',
    '  node scripts/migrate-governance-surfaces.mjs plan --guild <guild-id>',
    '  LIVE_GOVERNANCE_SURFACE_MIGRATION=1 node scripts/migrate-governance-surfaces.mjs apply --guild <guild-id> --confirm <server-name>',
    '',
    'applyは旧案内・旧官報を内部監査へ保存し、公開記録を読み戻した後にだけ削除します。'
  ].join('\n');
}

const mode = process.argv[2];
const guildId = option('--guild');
if (!['plan', 'apply'].includes(mode) || !guildId) {
  console.error(usage());
  process.exitCode = 2;
} else {
  const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages] });
  try {
    await client.login(process.env.DISCORD_TOKEN);
    if (!client.isReady()) await once(client, 'clientReady');
    const guild = await client.guilds.fetch(guildId);
    if (mode === 'apply') {
      if (process.env.LIVE_GOVERNANCE_SURFACE_MIGRATION !== '1') {
        throw new Error('applyには LIVE_GOVERNANCE_SURFACE_MIGRATION=1 が必要です。');
      }
      if (option('--confirm') !== guild.name) throw new Error('確認用サーバー名が一致しません。');
    }
    const result = mode === 'plan'
      ? await planGovernanceSurfaceMigration(guild)
      : await applyGovernanceSurfaceMigration(guild);
    console.log(JSON.stringify(result, null, 2));
    if (result.blockers?.length) process.exitCode = 1;
  } finally {
    client.destroy();
  }
}
