import { createHmac, randomBytes } from 'node:crypto';
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags, type User } from 'discord.js';

// 記憶の本のサイト (worker/ の /wiki) への入り口。/memory url と explore の「サイトで開く」が使う。
//
// サイトはメンバーだけに見せる。入り方は bot のログインリンク: メンバーがこの bot を使うと、bot は
// (そのサーバーにいる人だと分かっているので) 10分だけ有効な1回限りのリンクを、その人にだけ返す。
// リンクの署名は bot と Worker が同じ鍵 (MEMORY_SITE_LINK_SECRET / Worker の MEMORY_LINK_SECRET) で作り・確かめる。
//
// 設定が揃っているときだけ出す (サイトを配備する前に URL だけが出て「not found」になった、2026-10-17):
//   MEMORY_SITE_PUBLIC_URL    サイトの origin (https のみ。開発の localhost を除く)
//   MEMORY_SITE_LINK_SECRET   署名の鍵 (16文字以上)
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
  secret: string;
  guildId: string;
}

/** そのサーバーで入り口を出してよいときの設定。足りない・別のサーバーなら null。 */
export function siteConfigFor(guildId: string, env: NodeJS.ProcessEnv = process.env): SiteConfig | null {
  const origin = siteOrigin(env);
  const secret = (env.MEMORY_SITE_LINK_SECRET ?? '').trim();
  return origin && secret.length >= 16 && siteGuilds(env).includes(guildId) ? { origin, secret, guildId } : null;
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

// ---- ログインリンク -------------------------------------------------------------

const LINK_PREFIX = 'sakana-memory-link.v1';
export const LINK_TTL_SECONDS = 600;

export interface LinkUser {
  id: string;
  name: string;
  avatar: string | null;
}

const base64Url = (bytes: Buffer): string => bytes.toString('base64url');

/** Worker が確かめる署名つきの入場券。サーバー・本人・発行と期限・1回限りの印 (jti) を持つ。 */
export function mintLoginToken(config: SiteConfig, user: LinkUser, now = Date.now(), random: (size: number) => Buffer = randomBytes): string {
  const iat = Math.floor(now / 1000);
  const payload = base64Url(Buffer.from(JSON.stringify({
    g: config.guildId, uid: user.id, name: user.name.slice(0, 40), avatar: user.avatar, iat, exp: iat + LINK_TTL_SECONDS, jti: base64Url(random(16))
  })));
  const signature = base64Url(createHmac('sha256', config.secret).update(`${LINK_PREFIX}.${payload}`).digest());
  return `${payload}.${signature}`;
}

/** その人専用のログインリンク。開くと cookie が渡り、next (サイトの中のパス) へ進む。 */
export function siteLoginUrl(config: SiteConfig, user: LinkUser, target: SiteTarget, now = Date.now()): string {
  const query = new URLSearchParams({ t: mintLoginToken(config, user, now), next: sitePath(config.guildId, target) });
  return `${config.origin}/auth/link?${query.toString()}`;
}

interface ReplyingInteraction {
  guildId: string | null;
  user: Pick<User, 'id' | 'avatar' | 'displayName'>;
  reply(options: { content: string; components: ActionRowBuilder<ButtonBuilder>[]; flags: MessageFlags.Ephemeral; allowedMentions: { parse: [] } }): Promise<unknown>;
}

/** その人にだけ、サイトへのログインリンクを返す (リンクは本人専用なので、他の人には見せない)。 */
export async function replyWithSiteLink(interaction: ReplyingInteraction, config: SiteConfig, target: SiteTarget, label: string): Promise<void> {
  const url = siteLoginUrl(config, { id: interaction.user.id, name: interaction.user.displayName, avatar: interaction.user.avatar }, target);
  await interaction.reply({
    content: `📖 **${label.slice(0, 200)}**\n-# あなただけのリンクです。${LINK_TTL_SECONDS / 60}分以内に、1回だけ開けます (他の人に渡さないでください)`,
    components: [new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('🌐 サイトで開く').setURL(url))],
    flags: MessageFlags.Ephemeral,
    allowedMentions: { parse: [] }
  });
}
