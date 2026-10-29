import { loadPublicChannels, memoryDb, setState } from '../store.js';
import { planGuild, SECTION_CHARS } from './prepare.js';
import { ensureV2Schema } from './schema.js';

// 準備: v2 の DB に、v1 から引き継ぐ小さな表を写し、区間を計画する。何度呼んでもよい (続きから)。
//   写すもの: 公開チャンネルの控え・記憶に入れたチャンネル・サイトの公開状態・その state。
//   既知のページ名: v1 の人物以外のページの上位 (抽出で同じものに同じ名前を付けさせる。実行中は変えない)。

const KNOWN_LIMIT = 150;

export const knownKey = (guildId: string): string => `v2:known:${guildId}`;

export interface InitStats { channels: number; sections: number; added: number; known: number; seeded: boolean }

/** v1 の DB (ファイル) から小さな表を写す。v1 が無ければ (テスト) 何もしない。 */
export function seedFromV1(guildId: string, v1Path: string | null): { known: string[]; seeded: boolean } {
  const d = memoryDb();
  if (!v1Path) return { known: [], seeded: false };
  d.exec(`ATTACH DATABASE '${v1Path.replace(/'/g, "''")}' AS v1`);
  try {
    d.transaction(() => {
      for (const table of ['public_channels', 'included_channels', 'site_access']) {
        d.prepare(`DELETE FROM main.${table} WHERE guild_id = ?`).run(guildId);
        d.prepare(`INSERT INTO main.${table} SELECT * FROM v1.${table} WHERE guild_id = ?`).run(guildId);
      }
      d.prepare("DELETE FROM main.state WHERE key LIKE ? OR key LIKE ?").run(`public-channels:${guildId}`, `removed-top:${guildId}`);
      d.prepare("INSERT INTO main.state SELECT * FROM v1.state WHERE key LIKE ? OR key LIKE ?").run(`public-channels:${guildId}`, `removed-top:${guildId}`);
    })();
    const names = d.prepare<[string], { path: string }>(`
      SELECT path FROM v1.nodes WHERE guild_id = ? AND path LIKE '%/%' AND path NOT LIKE 'people/%' ORDER BY weight DESC LIMIT ${KNOWN_LIMIT}
    `).all(guildId).map((row) => row.path.slice(row.path.lastIndexOf('/') + 1));
    return { known: [...new Set(names)], seeded: true };
  } finally {
    d.exec('DETACH DATABASE v1');
  }
}

export function initV2(guildId: string, { v1Path = null, target = SECTION_CHARS, now = Date.now(), settleMs = 0 }: { v1Path?: string | null; target?: number; now?: number; settleMs?: number } = {}): InitStats {
  ensureV2Schema();
  const seeded = seedFromV1(guildId, v1Path);
  if (seeded.seeded) setState(knownKey(guildId), seeded.known);
  const channels = loadPublicChannels(guildId)?.channelIds ?? [];
  const planned = planGuild(guildId, channels, target, now, { settleMs });
  return { channels: planned.channels, sections: planned.sections, added: planned.added, known: seeded.known.length, seeded: seeded.seeded };
}
