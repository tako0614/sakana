// Discord に**いま登録されている**コマンドを出す。
//
//   node scripts/list-commands.js
//
// deploy-commands.js は「送った」ことしか分からない。選択肢のラベル (`/model` の
// evex-2 など) は登録データに焼き付くので、コードを直して再起動しても Discord 側を
// 更新しないと変わらない — その取り違えを目で確かめられるようにする。
//
// 選択肢まで出すのは、名前だけ見ても「中身が古い」ことに気付けないから。

import 'dotenv/config';
import { REST, Routes } from 'discord.js';

const token = process.env.DISCORD_TOKEN;
const clientId = process.env.DISCORD_CLIENT_ID;
const guildId = process.env.DISCORD_GUILD_ID;

if (!token || !clientId) {
  console.error('DISCORD_TOKEN と DISCORD_CLIENT_ID が必要です。');
  process.exit(1);
}

const rest = new REST({ version: '10' }).setToken(token);
const route = guildId
  ? Routes.applicationGuildCommands(clientId, guildId)
  : Routes.applicationCommands(clientId);

const commands = await rest.get(route);
console.log(`${guildId ? `guild ${guildId}` : 'global'} / ${commands.length} 個\n`);

for (const command of commands) {
  console.log(`/${command.name}`);
  for (const option of command.options ?? []) {
    const choices = (option.choices ?? []).map((choice) => choice.name);
    const tail = choices.length
      ? ` = ${choices.join(' / ')}`
      : (option.autocomplete ? ' (autocomplete)' : '');
    console.log(`    ${option.name}${tail}`);
  }
}
