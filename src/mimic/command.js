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

import { mimicConfig, status } from './client.js';
import { impersonate } from './impersonate.js';
import { DEFAULT_ENGINE, ENGINES, engineCounts, engineFor, setEngine } from './prefs.js';
import { labelledSpeakers } from './plain.js';
import { hasOptedOut, learnedSpeakers, optIn, optOut } from './speakers.js';

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
    embed.addFields({
      name: 'Evex の状態',
      value: [
        `起動中 (epoch ${health.epoch ?? '?'} / val ${health.val_loss?.toFixed?.(4) ?? '?'})`,
        'メンションすると会話の続きを1発言だけ返します。道具も検索も使いません。'
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
  },

  {
    // ユーザー選択にしない。上位48人の外は「実発言を例に真似る」浅い方に落ちるので、
    // 深く似る人を先に出したい。autocomplete なら学習済みの人を上に並べられる。
    data: new SlashCommandBuilder()
      .setName('mimic')
      .setDescription('その人として1発言書かせる (生成物です)')
      .setContexts(InteractionContextType.Guild)
      .addStringOption((option) => option
        .setName('who')
        .setDescription('学習量の多い人ほど似ます')
        .setRequired(true)
        .setAutocomplete(true))
      .addStringOption((option) => option
        .setName('topic')
        .setDescription('振るお題 (省略すると勝手に喋ります)')
        .setRequired(false)),

    async autocomplete(interaction) {
      const typed = (interaction.options.getFocused() ?? '').toLowerCase();

      // 候補は載っているモデルに合わせる。evex-1 は 48 人、evex-ft-1 は 147 人。
      // 学習していない人を候補に出すと、選んだ人だけ浅い返答になって理由が分からない
      const pool = labelledSpeakers().length ? labelledSpeakers() : learnedSpeakers();
      const found = pool
        .filter((row) => !hasOptedOut(row.userId))
        .filter((row) => !typed || (row.name ?? '').toLowerCase().includes(typed))
        .slice(0, 25);

      await interaction.respond(found.map((row) => ({
        name: `${row.name} (${(row.count ?? 0).toLocaleString('en-US')}件)`,
        value: row.userId
      }))).catch(() => {});
    },

    async execute(interaction) {
      const who = interaction.options.getString('who', true);
      const topic = interaction.options.getString('topic');

      // autocomplete を使わず名前を打たれると ID にならない。
      // 数字でなければメンションからの抽出を試して、それでも駄目なら断る
      const targetId = /^\d{5,}$/.test(who) ? who : (who.match(/\d{5,}/)?.[0] ?? null);
      if (!targetId) {
        await interaction.reply({
          content: '候補から選んでください (名前を直接打つと誰か分かりません)。',
          flags: MessageFlags.Ephemeral
        });
        return;
      }

      if (hasOptedOut(targetId)) {
        await interaction.reply({
          content: 'この人は対象から外れています。',
          flags: MessageFlags.Ephemeral
        });
        return;
      }

      // CPU 推論で数秒かかる。黙っていると落ちたように見える
      await interaction.deferReply();

      try {
        const { text, how } = await impersonate(targetId, {
          topic,
          channelId: interaction.channelId,
          askerId: interaction.user.id
        });

        if (!text) {
          await interaction.editReply(how === 'empty'
            ? 'この人の発言が足りず、真似る材料がありません。'
            : '何も出てきませんでした。もう一度呼ぶと違うものが出ます。');
          return;
        }

        const pool = labelledSpeakers().length ? labelledSpeakers() : learnedSpeakers();
        const name = pool.find((row) => row.userId === targetId)?.name;
        // どちらの手で作ったかを出す。深さが違うので、読む側の期待を合わせておく
        const source = (how === 'token' || how === 'label')
          ? '学習済みの口調'
          : '直近の発言から真似';

        await interaction.editReply({
          content: `${text}\n-# ${mimicConfig.label} が ${name ?? 'この人'} として書いたもの (${source})`,
          allowedMentions: { parse: [], repliedUser: false }
        });
      } catch (error) {
        console.error('mimic failed:', error);
        await interaction.editReply(error?.down
          ? 'Evex の推論プロセスが起動していません。'
          : `失敗しました: ${error?.message ?? '不明なエラー'}`);
      }
    }
  },

  {
    // 実在の人の口調を誰でも呼び出せる状態にするので、本人が抜けられる入口を必ず置く
    data: new SlashCommandBuilder()
      .setName('mimic-optout')
      .setDescription('自分を /mimic の対象から外す (いつでも戻せます)')
      .setContexts(InteractionContextType.Guild)
      .addBooleanOption((option) => option
        .setName('back')
        .setDescription('true にすると対象に戻します')
        .setRequired(false)),

    async execute(interaction) {
      const back = interaction.options.getBoolean('back');

      if (back) {
        const changed = optIn(interaction.user.id);
        await interaction.reply({
          content: changed ? '対象に戻しました。' : 'もともと外れていません。',
          flags: MessageFlags.Ephemeral
        });
        return;
      }

      optOut(interaction.user.id);
      await interaction.reply({
        content: '外しました。あなたとしては書かれません。`/mimic-optout back:true` で戻せます。',
        flags: MessageFlags.Ephemeral
      });
    }
  }
];
