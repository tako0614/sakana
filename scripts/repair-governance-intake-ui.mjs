import 'dotenv/config';
import { REST, Routes } from 'discord.js';
import { db } from '../src/db.js';

const token = process.env.DISCORD_TOKEN;
if (!token) throw new Error('DISCORD_TOKEN is required.');

function repairContent(value) {
  return String(value ?? '')
    .replace(
      /正式受付済み:\s*(?:proposal|case|law)\s+\d+\s*（自動再試行中）/gi,
      '正式受付済み（自動再試行中）'
    );
}

const rows = db.prepare(`
  SELECT channel_id, response_message_id
  FROM governance_intakes
  WHERE response_message_id IS NOT NULL
  ORDER BY id
`).all();
const rest = new REST({ version: '10' }).setToken(token);
let updated = 0;
let missing = 0;

for (const row of rows) {
  const route = Routes.channelMessage(row.channel_id, row.response_message_id);
  const message = await rest.get(route).catch(() => null);
  if (!message) {
    missing += 1;
    continue;
  }
  const content = repairContent(message.content);
  if (content === message.content) continue;
  await rest.patch(route, { body: { content } });
  updated += 1;
}

console.log(`governance intake UI repair: ${updated} updated, ${missing} unavailable`);
