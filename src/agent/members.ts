// 表示名 → ユーザー ID の解決。
//
// tools.js と semantic.js の両方から使うので独立させてある
// (tools.js が semantic.js を読み込んでいるので、逆向きに import すると循環する)。

import { db as archiveDb } from '../archive/db.js';
import { archive } from './boundary.js';
import type { AgentContext } from './types.js';

// channelScope は呼んだ人に見えるチャンネル。退出済みの人をアーカイブの表示名から引くときに、
// 見えないチャンネルにしか書いていない人の名前と ID を引き当てないために要る。
type MemberContext = Pick<AgentContext, 'guild' | 'channelScope'>;

/**
 * 表示名から ID を引く。
 *
 * Discord の検索 API は author_id しか受けないので、ここで詰まると検索が成立しない。
 * キャッシュに載っていないだけの人や退出済みの人で行き止まりにしないよう、
 * メンバー検索とアーカイブまで見る。
 */
export async function resolveMemberId(ctx: MemberContext, value: unknown): Promise<string | null> {
  if (!value) return null;

  const id = /(\d{16,21})/.exec(String(value))?.[1];
  if (id) return id;

  // モデルが渡す文字列なので長さを抑える (ID は上で取り出し済み。表示名は100字もあれば足りる)
  const name = String(value).replace(/^@/, '').toLowerCase().slice(0, 100);
  if (!name) return null;

  const member = ctx.guild.members.cache.find((candidate) => (
    candidate.displayName?.toLowerCase() === name
    || candidate.user.username?.toLowerCase() === name
    || candidate.user.globalName?.toLowerCase() === name
  )) ?? ctx.guild.members.cache.find((candidate) => (
    candidate.displayName?.toLowerCase().includes(name)
    || candidate.user.username?.toLowerCase().includes(name)
  ));

  if (member) return member.id;

  // キャッシュに載っていないだけの在籍者。REST の検索1回で拾える
  // (GuildMembers intent は既に有効なので追加の権限は要らない)。
  const found = await ctx.guild.members.search({ query: name, limit: 1 })
    .then((result) => result.first())
    .catch(() => null);
  if (found) return found.id;

  // 退出済みはメンバー検索にも出ない。アーカイブは当時の表示名を覚えている。
  // ただし呼んだ人に見えるチャンネルの発言だけを手がかりにする。見えないチャンネルに
  // しか書いていない人の名前から ID を引けると、そこに誰がいるかを探る道具になる。
  try {
    const pattern = `%${name.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
    const rows = archiveDb.prepare<[string, string], { author_id: string | null; channel_id: string }>(`
      SELECT author_id, channel_id FROM messages
      WHERE guild_id = ? AND author_name LIKE ? ESCAPE '\\'
      ORDER BY created_at DESC LIMIT 50
    `).all(ctx.guild.id, pattern);

    const row = rows.find((candidate) => (
      candidate.author_id && archive.isChannelAllowed(candidate.channel_id, ctx.channelScope)
    ));
    if (row?.author_id) return row.author_id;
  } catch {
    // アーカイブが無い構成でも動くようにする
  }

  return null;
}

/**
 * ローカル検索の from: に渡す値。
 *
 * author_name は書いた時点のスナップショットで、upsert のたびに上書きされる。
 * つまり改名した人を現在の名前で引くと、改名前に書かれた行には当たらない
 * (「ずっといるのに直近しかヒットしない」の主因)。引けるなら ID にする。
 * 引けなければ元の文字列に戻す (名前で当たる可能性は残す)。
 */
export async function resolveAuthorFilter(ctx: MemberContext, value: unknown): Promise<unknown> {
  if (!value) return value;
  return (await resolveMemberId(ctx, value)) ?? value;
}
