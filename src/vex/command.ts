// /vex: vex (名前呼びと、呼ばれていない会話への自発参加) の状態を見る・切り替える (管理者用)。
//
// 環境変数だけだと、切り替えのたびに本番の .env を触って再起動が要る。ここで変えた値は DB に残り、
// 環境変数より優先する (settings.ts)。/vex reset で環境変数の値に戻る。サーバー全体ではなく bot 全体の設定。
import {
  ChannelType,
  InteractionContextType,
  MessageFlags,
  SlashCommandBuilder,
  type ChatInputCommandInteraction
} from 'discord.js';

import { canManageIndex } from '../archive/permissions.js';
import { vexConfig, type CallMode } from './config.js';
import { vexStats } from './ledger.js';
import {
  CALL_MODES,
  NUMBER_SETTINGS,
  changedSettings,
  envValues,
  resetVexSettings,
  setAmbient,
  setArbiter,
  setCallMode,
  setChannel,
  setNumber
} from './settings.js';

const MODE_TEXT: Record<CallMode, string> = {
  off: '何もしない (名前が出ても反応しない。メンションと bot への返信は、いつも通り答える)',
  mention: 'メンションと同じ。名前が出たら確定で答える (判定モデルは使わない)',
  judge: '名前が出た発言を判定モデルに回し、文脈で決める (確定では答えない)'
};

const STAT_LABELS: [string, string][] = [
  ['sent', '送った'], ['passed', '(skip) で黙った'], ['joined', '入ると決めた'], ['below', '閾値未満'],
  ['skipped', '門で止めた'], ['moved_on', '会話が進んだ'], ['error', '失敗']
];

function statusText(): string {
  const stats = vexStats(Date.now() - 86_400_000);
  const env = envValues();
  const changed = changedSettings();
  const channels = [...vexConfig.channels];
  return [
    '**vex の状態**',
    `名前 (vex): **${vexConfig.callMode}** — ${MODE_TEXT[vexConfig.callMode]}`,
    `自発参加: **${vexConfig.ambient ? 'オン' : 'オフ'}** — チャンネル: ${channels.length ? channels.map((id) => `<#${id}>`).join(' ') : 'なし (どこにも入らない)'}`,
    `審判 (LLM が会話の履歴と記憶の概要を読んで最終判断): **${vexConfig.arbiter ? 'オン' : 'オフ'}**`,
    `閾値 ${vexConfig.threshold} (名前が出たとき ${vexConfig.nameThreshold}) / 静かになってから ${Math.round(vexConfig.quietMs / 1000)} 秒 / `
      + `入ったあとの冷却 ${Math.round(vexConfig.cooldownMs / 60_000)} 分 / 1 時間に ${vexConfig.maxPerHour} 回まで`,
    stats.decisions === 0
      ? '直近 24 時間: 判定なし'
      : `直近 24 時間: 判定 ${stats.decisions} 回 ($${stats.costUsd.toFixed(5)}) — ${STAT_LABELS.filter(([key]) => stats.byAction[key]).map(([key, label]) => `${label} ${stats.byAction[key]}`).join(' / ')}`,
    changed.length
      ? `コマンドで変えた項目: ${changed.join(', ')} (\`/vex reset\` で環境変数の値 — 名前 ${env.callMode}・自発参加 ${env.ambient ? 'オン' : 'オフ'} — に戻る)`
      : '環境変数のまま (コマンドでは変えていません)'
  ].join('\n');
}

async function requireAdmin(interaction: ChatInputCommandInteraction): Promise<boolean> {
  const member = interaction.inCachedGuild()
    ? interaction.member
    : (await interaction.guild?.members.fetch(interaction.user.id).catch(() => null)) ?? null;
  if (canManageIndex(member)) return true;
  await interaction.reply({
    content: 'vex の設定を変えられるのは「サーバー管理」権限を持つ人か、`ARCHIVE_ADMIN_USERS` に登録された人だけです。',
    allowedMentions: { parse: [] },
    flags: MessageFlags.Ephemeral
  });
  return false;
}

export const vexCommands = [
  {
    data: new SlashCommandBuilder()
      .setName('vex')
      .setDescription('vex (名前呼び・自発参加) の状態を見る / 切り替える (管理者用)')
      .setContexts(InteractionContextType.Guild)
      .addSubcommand((sub) => sub.setName('status').setDescription('いまの状態と、直近 24 時間の判定を表示します'))
      .addSubcommand((sub) => sub
        .setName('call')
        .setDescription('「vex」と名前が出た発言の扱いを変えます')
        .addStringOption((option) => option
          .setName('mode')
          .setDescription('off=何もしない / mention=確定で答える / judge=判定モデルが文脈で決める')
          .setRequired(true)
          .addChoices(...CALL_MODES.map((mode) => ({ name: mode, value: mode })))))
      .addSubcommand((sub) => sub
        .setName('ambient')
        .setDescription('呼ばれていない会話への自発参加をオン / オフします')
        .addBooleanOption((option) => option.setName('enabled').setDescription('オンにするか').setRequired(true)))
      .addSubcommand((sub) => sub
        .setName('arbiter')
        .setDescription('判定モデルのあとの審判 (LLM) をオン / オフします。オフだと判定モデルの閾値だけで決まります')
        .addBooleanOption((option) => option.setName('enabled').setDescription('オンにするか').setRequired(true)))
      .addSubcommand((sub) => sub
        .setName('channel')
        .setDescription('自発参加してよいチャンネルを足す / 外します')
        .addStringOption((option) => option
          .setName('action')
          .setDescription('足す / 外す')
          .setRequired(true)
          .addChoices({ name: 'add', value: 'add' }, { name: 'remove', value: 'remove' }))
        .addChannelOption((option) => option
          .setName('channel')
          .setDescription('対象。省略するとこのチャンネル')
          .addChannelTypes(ChannelType.GuildText, ChannelType.PublicThread, ChannelType.PrivateThread, ChannelType.GuildAnnouncement)
          .setRequired(false)))
      .addSubcommand((sub) => sub
        .setName('set')
        .setDescription('閾値などの数値を変えます')
        .addStringOption((option) => option
          .setName('key')
          .setDescription('変える項目')
          .setRequired(true)
          .addChoices(...Object.entries(NUMBER_SETTINGS).map(([key, spec]) => ({ name: `${key} — ${spec.label}`.slice(0, 100), value: key }))))
        .addNumberOption((option) => option.setName('value').setDescription('新しい値').setRequired(true)))
      .addSubcommand((sub) => sub.setName('reset').setDescription('コマンドで変えた値をすべて捨てて、環境変数の値に戻します')),

    async execute(interaction: ChatInputCommandInteraction): Promise<void> {
      if (!await requireAdmin(interaction)) return;
      const sub = interaction.options.getSubcommand();
      const by = interaction.user.id;
      const say = (content: string): Promise<unknown> => interaction.reply({ content, allowedMentions: { parse: [] }, flags: MessageFlags.Ephemeral });

      if (sub === 'call') {
        const mode = interaction.options.getString('mode', true);
        if (!setCallMode(mode, by)) { await say(`その値は使えません: ${mode}`); return; }
        await say(`名前 (vex) の扱いを **${mode}** にしました。${MODE_TEXT[mode as CallMode]}\n\n${statusText()}`);
        return;
      }
      if (sub === 'ambient') {
        const enabled = interaction.options.getBoolean('enabled', true);
        setAmbient(enabled, by);
        await say(`自発参加を${enabled ? 'オン' : 'オフ'}にしました。${enabled && vexConfig.channels.size === 0 ? '\n(入ってよいチャンネルがまだありません。`/vex channel add` で足してください)' : ''}\n\n${statusText()}`);
        return;
      }
      if (sub === 'arbiter') {
        const enabled = interaction.options.getBoolean('enabled', true);
        setArbiter(enabled, by);
        await say(`審判を${enabled ? 'オン' : 'オフ'}にしました。\n\n${statusText()}`);
        return;
      }
      if (sub === 'channel') {
        const add = interaction.options.getString('action', true) === 'add';
        const target = interaction.options.getChannel('channel');
        const channelId = target?.id ?? interaction.channelId;
        const changed = setChannel(channelId, add, by);
        await say(`${changed ? '' : '(変わりません) '}<#${channelId}> を自発参加${add ? 'してよい' : 'しない'}チャンネルに${changed ? 'しました' : 'しています'}。\n\n${statusText()}`);
        return;
      }
      if (sub === 'set') {
        const key = interaction.options.getString('key', true);
        const value = interaction.options.getNumber('value', true);
        if (!setNumber(key, value, by)) {
          const spec = (NUMBER_SETTINGS as Record<string, (typeof NUMBER_SETTINGS)[keyof typeof NUMBER_SETTINGS]>)[key];
          await say(`その値は使えません: ${value}${spec ? ` (${spec.label}は ${spec.min}〜${spec.max}${spec.integer ? ' の整数' : ''})` : ''}`);
          return;
        }
        await say(`${key} を ${value} にしました。\n\n${statusText()}`);
        return;
      }
      if (sub === 'reset') {
        const removed = resetVexSettings();
        await say(`${removed} 件の変更を捨てて、環境変数の値に戻しました。\n\n${statusText()}`);
        return;
      }
      await say(statusText());
    }
  }
];
