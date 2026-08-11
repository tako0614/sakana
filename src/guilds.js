// 動かすサーバーを絞る。
//
// 招待されただけで過去ログ検索も外付けブラウザも使えてしまうので、
// 許可したサーバー以外では機能を出さず、その場で退出する。
//
// 安全弁を2つ置く:
//   - 許可リストが空のときは何もしない (設定ミスで全サーバーから出ていかないように)
//   - ALLOWED_GUILDS_LEAVE=false なら退出はせず、機能のゲートだけ効かせる
//     (初回デプロイで挙動を確かめてから退出を有効にできる)

// 素の clone がいきなり開放状態にならないよう、既定を持たせておく。
const DEFAULT_ALLOWED = ['1255359848644608035'];

function parseList(value, fallback) {
  if (value === undefined) return fallback;
  return String(value).split(/[\s,]+/).filter(Boolean);
}

export const allowedGuilds = parseList(process.env.ALLOWED_GUILDS, DEFAULT_ALLOWED);

const leaveEnabled = !['0', 'false', 'no', 'off']
  .includes(String(process.env.ALLOWED_GUILDS_LEAVE ?? '').toLowerCase());

/** 機能を動かしてよいサーバーか。リストが空なら制限しない。 */
export function isAllowedGuild(guildId) {
  if (allowedGuilds.length === 0) return true;
  return Boolean(guildId) && allowedGuilds.includes(String(guildId));
}

/** 起動時と参加時に呼ぶ。許可外のサーバーから退出する。 */
export async function enforceGuildAllowlist(client) {
  if (allowedGuilds.length === 0) {
    console.warn('ALLOWED_GUILDS is empty. Running in every guild without restriction.');
    return;
  }

  for (const guild of client.guilds.cache.values()) {
    if (isAllowedGuild(guild.id)) continue;

    if (!leaveEnabled) {
      console.warn(`Guild ${guild.id} (${guild.name}) is not allowed. Features are disabled (leave is off).`);
      continue;
    }

    try {
      await guild.leave();
      console.log(`Left guild ${guild.id} (${guild.name}): not in ALLOWED_GUILDS.`);
    } catch (error) {
      console.error(`Failed to leave guild ${guild.id}:`, error);
    }
  }
}
