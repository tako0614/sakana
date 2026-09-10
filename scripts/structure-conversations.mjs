// No bot listeners, sends, moderation, or governance scheduler are started here.
import { Client, Events, GatewayIntentBits } from 'discord.js';
import { parseArgs } from 'node:util';
import { db } from '../src/archive/db.js';
import { runIndexJob, coverageReport } from '../src/archive/indexer.js';
import { syncConversationMemory, memoryStatus } from '../src/conversation/memory.js';

const { values } = parseArgs({ options: {
  guild: { type: 'string' }, discord: { type: 'boolean', default: false },
  'refresh-structure': { type: 'boolean', default: false },
  'index-only': { type: 'boolean', default: false }
} });
if (values.discord && !values.guild) throw new Error('--discord requires an explicit --guild ID');
let client;
try {
  if (values.discord) {
    if (!process.env.DISCORD_TOKEN) throw new Error('DISCORD_TOKEN is missing');
    client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });
    const ready = new Promise((resolve) => client.once(Events.ClientReady, resolve));
    await client.login(process.env.DISCORD_TOKEN);
    await ready;
    const guild = await client.guilds.fetch(values.guild);
    await guild.channels.fetch();
    if (values['refresh-structure']) {
      db.prepare('UPDATE channels SET complete = 0, oldest_id = NULL WHERE guild_id = ?').run(guild.id);
    }
    let lastLog = 0;
    await runIndexJob(guild, { mode: 'full', onProgress: (status) => {
      if (Date.now() - lastLog < 15000) return;
      lastLog = Date.now(); console.log(JSON.stringify(status));
    } });
    console.log(JSON.stringify({ guildId: guild.id, coverage: coverageReport(guild.id) }));
  }
  if (!values['index-only']) {
    let status;
    do {
      status = await syncConversationMemory({ limit: 200 });
      console.log(JSON.stringify(status));
    } while (status.pending);
    console.log(JSON.stringify({ projectionComplete: true, ...memoryStatus() }));
  }
} finally { client?.destroy(); }
