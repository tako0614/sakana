import { ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } from 'discord.js';

// 記憶のサイト (worker/ の /wiki) への入り口。/memory url と explore の「サイトで開く」が使う。
//
// サイトは誰でも読める公開サイト (ログインは無い)。リンクはただの URL。
//
// 設定が揃っているときだけ出す (サイトを配備する前に URL だけが出て「not found」になった、2026-10-17):
//   MEMORY_SITE_PUBLIC_URL    サイトの origin (https のみ。開発の localhost を除く)
// サイトはサーバーごとに URL を分ける (/<サーバーID>/wiki/…)。案内するのは、サイトに載せているサーバー
// (MEMORY_SITE_GUILDS、無ければ builder が記憶を作る MEMORY_TREE_GUILD。Worker の MEMORY_GUILD_IDS と同じ一覧) だけ。
// 載せていないサーバーでは、リンクもボタンも出さない。

export type SiteTarget =
  | { kind: 'home' }
  | { kind: 'page'; path: string }
  | { kind: 'episode'; id: number };

export function siteOrigin(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = (env.MEMORY_SITE_PUBLIC_URL ?? '').trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
    return url.protocol === 'https:' || (url.protocol === 'http:' && local) ? url.origin : null;
  } catch {
    return null;
  }
}

/** サイトに載せているサーバー (カンマ・空白区切り)。 */
export function siteGuilds(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = env.MEMORY_SITE_GUILDS ?? env.MEMORY_SITE_GUILD ?? env.MEMORY_TREE_GUILD ?? '';
  return [...new Set(raw.split(/[\s,]+/).filter((id) => /^\d{5,25}$/.test(id)))];
}

export interface SiteConfig {
  origin: string;
  guildId: string;
}

/** そのサーバーで入り口を出してよいときの設定。足りない・別のサーバーなら null。 */
export function siteConfigFor(guildId: string, env: NodeJS.ProcessEnv = process.env): SiteConfig | null {
  const origin = siteOrigin(env);
  return origin && siteGuilds(env).includes(guildId) ? { origin, guildId } : null;
}

/** サイトの中のパス (/<サーバーID>/…)。パスの区切りは / のまま、各部分だけ percent-encode する。 */
export function sitePath(guildId: string, target: SiteTarget): string {
  if (target.kind === 'episode') return `/${guildId}/e/${target.id}`;
  if (target.kind === 'page') return `/${guildId}/wiki/${target.path.split('/').filter(Boolean).map(encodeURIComponent).join('/')}`;
  return `/${guildId}/wiki`;
}

export const siteUrl = (origin: string, guildId: string, target: SiteTarget): string => `${origin}${sitePath(guildId, target)}`;

/** 'e12' / 'E12' / '12' → 12。それ以外は null。 */
export function parseEpisodeId(text: string): number | null {
  const match = /^\s*e?(\d{1,9})\s*$/i.exec(text);
  const id = match?.[1] ? Number(match[1]) : NaN;
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

interface ReplyingInteraction {
  guildId: string | null;
  reply(options: { content: string; components: ActionRowBuilder<ButtonBuilder>[]; flags: MessageFlags.Ephemeral; allowedMentions: { parse: [] } }): Promise<unknown>;
}

/** サイトへのリンクを、押した人にだけ返す (他の人の画面を埋めない。リンクそのものは誰にでも使える)。 */
export async function replyWithSiteLink(interaction: ReplyingInteraction, config: SiteConfig, target: SiteTarget, label: string): Promise<void> {
  const url = siteUrl(config.origin, config.guildId, target);
  await interaction.reply({
    content: `📖 **${label.slice(0, 200)}**`,
    components: [new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('🌐 サイトで開く').setURL(url))],
    flags: MessageFlags.Ephemeral,
    allowedMentions: { parse: [] }
  });
}
