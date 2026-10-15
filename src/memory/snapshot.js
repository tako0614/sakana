import { publicChannels } from '../archive/visibility.js';
import { savePublicChannels } from './store.js';

// builder は Discord につながらないので、どのチャンネルを読んでよいかは bot が控えておく。
// 権限が変わったら次の控えで反映される (非公開になったチャンネルは以後読まない)。
// nsfw のチャンネルも公開なら読む (サーバーの判断)。提供元が拒否した区切りは
// failed として記録され、--retry-failed で読み直せる。

const INTERVAL_MS = 30 * 60_000;

export function snapshotPublicChannels(client) {
  for (const guild of client.guilds.cache.values()) {
    try {
      const ids = publicChannels(guild.id, guild);
      // 空の控えで「全部読むな」と上書きしない (キャッシュが揃う前の起動直後など)
      if (ids.length > 0) savePublicChannels(guild.id, ids);
    } catch (error) {
      console.error(`Memory channel snapshot failed for ${guild.id}:`, error);
    }
  }
}

export function startMemorySnapshots(client) {
  snapshotPublicChannels(client);
  setInterval(() => snapshotPublicChannels(client), INTERVAL_MS).unref();
}
