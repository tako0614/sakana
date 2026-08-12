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

import { ENDPOINTS, endpointFor, isSelfHosted, status } from './client.js';
import { impersonate } from './impersonate.js';
import { clearPersona, forgetPersona, personaCounts, personaFor, setPersona } from './persona.js';
import { DEFAULT_ENGINE, ENGINES, engineCounts, engineFor, setEngine } from './prefs.js';
import { labelledSpeakers } from './plain.js';
import { hasOptedOut, learnedSpeakers, optIn, optOut } from './speakers.js';

async function overview(userId) {
  const current = engineFor(userId);
  const counts = new Map(engineCounts().map((row) => [row.engine, row.users]));

  // 自作モデルは世代ごとに別プロセス。立っていないものを選ばせないよう、
  // それぞれの状態を見る
  const selfHosted = Object.keys(ENDPOINTS).filter((key) => ENGINES[key]);
  const health = new Map(await Promise.all(
    selfHosted.map(async (key) => [key, await status(key)])
  ));

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

  // 別プロセスなので、立っていないなら選んでも答えられない。世代ごとに出す。
  for (const key of selfHosted) {
    const info = health.get(key) ?? { up: false };
    embed.addFields({
      name: `${ENGINES[key].label} の状態`,
      value: info.up
        ? [
          `起動中 (epoch ${info.epoch ?? '?'} / val ${info.val_loss?.toFixed?.(4) ?? '?'})`,
          'メンションすると会話の続きを1発言だけ返します。道具も検索も使いません。',
          '`/as` で誰として喋るかを選べます。'
        ].join('\n')
        : `推論プロセスが起動していません (${endpointFor(key).url})。選んでも答えられません。`
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

      if (!ENGINES[engine]) {
        await interaction.reply({
          content: `そのモデルは選べません: ${engine}`,
          flags: MessageFlags.Ephemeral
        });
        return;
      }

      // 自作モデルは別プロセス。立っていないものを選ばせると、話しかけるたびに
      // 「起動していません」が返るだけで、選んだ本人には理由が分からない。
      // 選択肢は登録時に固定されるので (addChoices)、ここで断る。
      if (isSelfHosted(engine)) {
        const health = await status(engine);
        if (!health.up) {
          await interaction.reply({
            content: [
              `**${ENGINES[engine].label}** はまだ動いていません (${endpointFor(engine).url})。`,
              '推論プロセスが立っていないので、選んでも答えられません。'
            ].join('\n'),
            flags: MessageFlags.Ephemeral
          });
          return;
        }
      }

      setEngine(interaction.user.id, engine);

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
        // その人が選んでいる世代で生成する。deepseek のままだと自作モデルが
        // 使われないので、既定は evex に落とす
        const chosen = engineFor(interaction.user.id);
        const engine = isSelfHosted(chosen) ? chosen : 'evex';
        const { text, how } = await impersonate(targetId, {
          topic,
          channelId: interaction.channelId,
          askerId: interaction.user.id,
          engine
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
          content: `${text}\n-# ${endpointFor(engine).label} が ${name ?? 'この人'} として書いたもの (${source})`,
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
    // /model と同じ形。あちらが「どのモデルで答えるか」で、こちらが「誰として答えるか」。
    // /mimic は1回ぶんだが、これは設定として残るので会話がずっとその口調になる。
    data: new SlashCommandBuilder()
      .setName('as')
      .setDescription('bot に誰として喋らせるか (自分のぶんだけ変わります)')
      .setContexts(InteractionContextType.Guild)
      .addStringOption((option) => option
        .setName('who')
        .setDescription('省略すると、いまの設定を表示します')
        .setRequired(false)
        .setAutocomplete(true))
      .addBooleanOption((option) => option
        .setName('off')
        .setDescription('true にすると bot 自身に戻します')
        .setRequired(false)),

    async autocomplete(interaction) {
      const typed = (interaction.options.getFocused() ?? '').toLowerCase();
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
      const who = interaction.options.getString('who');
      const off = interaction.options.getBoolean('off');
      const pool = () => (labelledSpeakers().length ? labelledSpeakers() : learnedSpeakers());
      const nameOf = (id) => pool().find((row) => row.userId === id)?.name ?? id;

      if (off) {
        const changed = clearPersona(interaction.user.id);
        await interaction.reply({
          content: changed
            ? 'bot 自身に戻しました。'
            : 'もともと bot 自身のままです。',
          flags: MessageFlags.Ephemeral
        });
        return;
      }

      // 省略なら表示だけ。確認と切り替えを同じ入口にしておく (/model と同じ)
      if (!who) {
        const current = personaFor(interaction.user.id);
        const others = personaCounts()
          .filter((row) => row.targetId !== current)
          .slice(0, 3)
          .map((row) => `${nameOf(row.targetId)} (${row.users}人)`);

        await interaction.reply({
          content: [
            current
              ? `いまのあなた: **${nameOf(current)} として**`
              : 'いまのあなた: **bot 自身**',
            others.length ? `他の人がよく選んでいるのは ${others.join(' / ')}` : null,
            '`/as who:<候補>` で変えられます。`/as off:true` で戻ります。',
            '効くのは `/model` で自作モデルを選んでいるときだけです。'
          ].filter(Boolean).join('\n'),
          flags: MessageFlags.Ephemeral
        });
        return;
      }

      const targetId = /^\d{5,}$/.test(who) ? who : (who.match(/\d{5,}/)?.[0] ?? null);
      if (!targetId || !pool().some((row) => row.userId === targetId)) {
        await interaction.reply({
          content: '候補から選んでください (学習していない人の口調は出せません)。',
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

      setPersona(interaction.user.id, targetId);

      // evex を選んでいない人には効かないので、そこを黙らせない
      const engine = engineFor(interaction.user.id);
      await interaction.reply({
        content: [
          `あなたの分を **${nameOf(targetId)} として** にしました。他の人には影響しません。`,
          isSelfHosted(engine)
            ? 'メンションすると、その口調で1発言返します。'
            : `いまのあなたは **${ENGINES[engine].label}** なので効きません。\`/model\` で自作モデルに変えてください。`
        ].join('\n'),
        flags: MessageFlags.Ephemeral
      });
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
      // 自分を選んでいた人の設定も消す。残すと黙って効かなくなって理由が分からない
      const dropped = forgetPersona(interaction.user.id);
      await interaction.reply({
        content: `外しました。あなたとしては書かれません${dropped ? ` (${dropped}人の /as を解除しました)` : ''}。\`/mimic-optout back:true\` で戻せます。`,
        flags: MessageFlags.Ephemeral
      });
    }
  }
];
