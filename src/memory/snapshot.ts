import { ChannelType, type Client, type Guild } from 'discord.js';
import type { Statement } from 'better-sqlite3';
import { db as archive } from '../archive/db.js';
import { publicChannels } from '../archive/visibility.js';
import { includedChannels, savePublicChannels } from './store.js';

// builder は Discord につながらないので、どのチャンネルを読んでよいかは bot が控えておく。
// 権限が変わったら次の控えで反映される (非公開になったチャンネルは以後読まない)。
//
// 読むのは @everyone と bot の両方が読めるチャンネルと、管理者が /memory include で
// 入れたチャンネル (ロールが要るチャンネルなど) とその下の非公開でないスレッド。
// nsfw も区別しない。記憶 (要約とページ) は誰に聞かれても答えるので、入れたチャンネルの内容は
// そのチャンネルを見られない人にも思い出される (入れるのはサーバーの判断)。
// ただし原文 (引用・根拠の発言とそのリンク) は、そのチャンネルを見られる人にしか出さない
// (explore.ts / tool.ts が見ている人ごとに確かめる)。

const INTERVAL_MS = 30 * 60_000;
const PRIVATE_THREAD = ChannelType.PrivateThread;

let threadStatement: Statement<[string, string], { channel_id: string }> | null = null;
const archivedThreads = (guildId: string, parentId: string): string[] => {
  threadStatement ??= archive.prepare<[string, string], { channel_id: string }>(
    'SELECT channel_id FROM channels WHERE guild_id = ? AND parent_id = ? AND is_thread = 1 AND is_private = 0'
  );
  return threadStatement.all(guildId, parentId).map((row) => row.channel_id);
};

export interface ReadableChannelOptions {
  included?: readonly string[];
  threadsOf?: (id: string) => readonly string[];
}

/** 公開チャンネルと、追加したチャンネル (とその下の非公開でないスレッド)。 */
export function readableChannels(guild: Guild,
  { included = includedChannels(guild.id), threadsOf = (id) => archivedThreads(guild.id, id) }: ReadableChannelOptions = {}): string[] {
  const ids = new Set<string>(publicChannels(guild.id, guild));
  for (const id of included) {
    ids.add(id);
    for (const channel of guild.channels.cache.values()) {
      if (channel.parentId === id && channel.isThread() && channel.type !== PRIVATE_THREAD) ids.add(channel.id);
    }
    for (const threadId of threadsOf(id)) ids.add(threadId);
  }
  return [...ids];
}

export function snapshotPublicChannels(client: Client): void {
  for (const guild of client.guilds.cache.values()) {
    try {
      const ids = readableChannels(guild);
      // 空の控えで「全部読むな」と上書きしない (キャッシュが揃う前の起動直後など)
      if (ids.length > 0) savePublicChannels(guild.id, ids);
    } catch (error) {
      console.error(`Memory channel snapshot failed for ${guild.id}:`, error);
    }
  }
}

export function startMemorySnapshots(client: Client): void {
  snapshotPublicChannels(client);
  setInterval(() => snapshotPublicChannels(client), INTERVAL_MS).unref();
}
