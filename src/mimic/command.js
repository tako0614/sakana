// /model — 答えさせるモデルを選ぶ。誰でも自分のぶんだけ変えられる。
//
// 「モデル名が違う」だけの切り替えではない。deepseek は道具を持ったエージェントで、
// evex は 94万件だけで学習した 5.87M の言語モデル。答えの形そのものが変わるので、
// 何が変わるかを毎回出す。

import {
  EmbedBuilder,
  InteractionContextType,
  MessageFlags,
  SlashCommandBuilder
} from 'discord.js';

import { speakerFor, status } from './client.js';
import { DEFAULT_ENGINE, ENGINES, engineCounts, engineFor, setEngine } from './prefs.js';

async function overview(userId) {
  const current = engineFor(userId);
  const counts = new Map(engineCounts().map((row) => [row.engine, row.users]));
  const health = await status();

  const embed = new EmbedBuilder()
    .setColor('#2b2d31')
    .setTitle('🧠 使うモデル')
    .setDescription(`いまのあなた: **${ENGINES[current].label}**`);

  for (const [key, info] of Object.entries(ENGINES)) {
    const marks = [];
    if (key === current) marks.push('← あなた');
    if (key === DEFAULT_ENGINE) marks.push('既定');

    const users = counts.get(key) ?? 0;
    if (users > 0) marks.push(`${users}人が選択`);

    embed.addFields({
      name: `${info.label}${marks.length ? ` (${marks.join(' / ')})` : ''}`,
      value: info.summary
    });
  }

  // evex は別プロセスなので、立っていないなら選んでも答えられない。先に出す。
  if (health.up) {
    const speaker = speakerFor(userId);
    embed.addFields({
      name: 'Evex の状態',
      value: [
        `起動中 (epoch ${health.epoch ?? '?'} / val ${health.val_loss?.toFixed?.(4) ?? '?'})`,
        speaker
          ? `あなたは学習データに ${speaker.count.toLocaleString()} 件あるので、口調を真似られます`
          : 'あなたは学習データの上位48人に入っていないので、話者の指定はできません'
      ].join('\n')
    });
  } else {
    embed.addFields({
      name: 'Evex の状態',
      value: '推論プロセスが起動していません。選んでも答えられないので、先に立ててください。'
    });
  }

  return embed;
}

export const mimicCommands = [
  {
    data: new SlashCommandBuilder()
      .setName('model')
      .setDescription('答えさせるモデルを選ぶ (自分のぶんだけ変わります)')
      .setContexts(InteractionContextType.Guild)
      .addStringOption((option) => option
        .setName('engine')
        .setDescription('省略すると、いまの選択と違いを表示します')
        .setRequired(false)
        .addChoices(
          ...Object.entries(ENGINES).map(([value, info]) => ({ name: info.label, value }))
        )),

    async execute(interaction) {
      const engine = interaction.options.getString('engine');

      // 省略なら表示だけ。誰でも叩けるので、確認と切り替えを同じ入口にしておく
      if (!engine) {
        await interaction.reply({
          embeds: [await overview(interaction.user.id)],
          flags: MessageFlags.Ephemeral
        });
        return;
      }

      if (!setEngine(interaction.user.id, engine)) {
        await interaction.reply({
          content: `そのモデルは選べません: ${engine}`,
          flags: MessageFlags.Ephemeral
        });
        return;
      }

      await interaction.reply({
        content: `あなたの分を **${ENGINES[engine].label}** にしました。他の人には影響しません。`,
        embeds: [await overview(interaction.user.id)],
        flags: MessageFlags.Ephemeral
      });
    }
  }
];
