// 「サーバーの誰でも読める場所」の判定。統治の調査や共有の記憶のように、
// 実行者ではなく公開範囲で絞る必要がある読み取りの共通の入口。
//
// 公開 = @everyone と bot の両方が読めるテキストチャンネルと、その下の
// プライベートでないスレッド (アーカイブ済みでキャッシュに無いものは
// archive の channels 表と親チャンネルの権限で判定する)。
// Discord の client が無いとき (起動直後・検査) は空を返す。呼び出し側は
// hasVisibilityClient() で「判定できない」と「公開チャンネルが無い」を区別する。
import { ChannelType, type Client, type Guild, type GuildBasedChannel } from 'discord.js';
import { db } from './db.js';
import { canRead } from './permissions.js';

export { canRead };

let discordClient: Client | null = null;

/** discord.js の Client を覚える。ready で1回呼ぶ。 */
export function setVisibilityClient(client: Client | null | undefined): void {
  discordClient = client ?? null;
}

export function hasVisibilityClient(): boolean {
  return Boolean(discordClient);
}

const isPrivateThread = (channel: GuildBasedChannel): boolean => channel.type === ChannelType.PrivateThread;

interface ThreadRow {
  channel_id: string;
  parent_id: string | null;
}

/**
 * @everyone と bot の両方が読めるチャンネル ID の一覧。
 * suppliedGuild を渡せばそれを使い、無ければ覚えた client のキャッシュから引く。
 */
export function publicChannels(guildId: string, suppliedGuild?: Guild | null): string[] {
  const guild = suppliedGuild ?? discordClient?.guilds?.cache?.get(String(guildId));
  const everyone = guild?.roles?.everyone;
  const me = guild?.members?.me;
  if (!guild?.channels?.cache || !everyone || !me) return [];
  const parents = new Set(
    [...guild.channels.cache.values()]
      .filter((channel) => !isPrivateThread(channel)
        && canRead(channel, everyone)
        && canRead(channel, me))
      .map((channel) => channel.id)
  );
  const visible = [...guild.channels.cache.values()]
    .filter((channel) => !isPrivateThread(channel) && channel.isTextBased?.() && parents.has(channel.id))
    .map((channel) => channel.id);
  const threads = db
    .prepare<[string], ThreadRow>('SELECT channel_id, parent_id FROM channels WHERE guild_id = ? AND is_thread = 1 AND is_private = 0')
    .all(String(guildId));
  for (const row of threads) {
    const cached = guild.channels.cache.get(row.channel_id);
    if (cached ? !isPrivateThread(cached) && parents.has(cached.id) : row.parent_id !== null && parents.has(row.parent_id)) {
      visible.push(row.channel_id);
    }
  }
  return [...new Set(visible)];
}
