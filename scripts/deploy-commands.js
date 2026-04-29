import 'dotenv/config';
import { REST, Routes } from 'discord.js';
import { commandData } from '../src/commands.js';

const token = process.env.DISCORD_TOKEN;
const clientId = process.env.DISCORD_CLIENT_ID;
const guildId = process.env.DISCORD_GUILD_ID;

if (!token || !clientId) {
  console.error('DISCORD_TOKEN and DISCORD_CLIENT_ID are required.');
  process.exit(1);
}

const rest = new REST({ version: '10' }).setToken(token);

try {
  if (guildId) {
    await rest.put(
      Routes.applicationGuildCommands(clientId, guildId),
      { body: commandData }
    );
    console.log(`Registered ${commandData.length} guild command(s).`);
  } else {
    await rest.put(
      Routes.applicationCommands(clientId),
      { body: commandData }
    );
    console.log(`Registered ${commandData.length} global command(s).`);
    console.log('Global commands can take up to 1 hour to appear.');
  }
} catch (error) {
  console.error('Failed to register slash commands:', error);
  process.exit(1);
}
