import { db as archive } from '../../archive/db.js';
import { memoryDb, normalizePath } from '../store.js';
import { CATEGORIES, UNSERIOUS, type Category, type Modality } from './types.js';

// S3 解決 (機械)。主張の主体を「ページになるもの (entity)」に決める。
//   人物: author_id ごとに 1 つ。表示名は履歴 (最新の名前がページ名、昔の名前は別名)。同じ名前の別人は ~末尾4桁 で分ける
//   もの: 正規化した名前の一致だけで同一視する。意味での統合はしない (誤統合のほうが害が大きい)
// 冗談・仮定・ごっこ・wrong の主張は、ページの材料にしない (entity も作らない)。

/** 名前の比較用: 全角半角・大小・空白・記号を無視する。 */
export const nameKey = (name: string): string =>
  name.normalize('NFKC').toLowerCase().replace(/[\s\-_・･.,、。()（）「」『』[\]【】!！?？"'`~〜～/／:：;；]/g, '');

const pageName = (name: string): string => name.replace(/[/／\\]/g, '／').replace(/[#`*<>|?"[\]]/g, '').replace(/\s+/g, ' ').trim().slice(0, 40);

export interface PersonRow {
  author_id: string;
  author_name: string;
  messages: number;
  first_ms: number;
  last_ms: number;
}

/** アーカイブから、author_id ごとの名前の履歴と発言数を 1 回の走査で集める。 */
export function loadPeople(guildId: string): Map<string, { names: { name: string; lastMs: number }[]; messages: number; firstMs: number; lastMs: number }> {
  const rows = archive.prepare<[string], PersonRow>(`
    SELECT author_id, author_name, COUNT(*) AS messages, MIN(created_at) AS first_ms, MAX(created_at) AS last_ms
    FROM messages WHERE guild_id = ? AND is_bot = 0 AND deleted = 0 AND author_name <> '' GROUP BY author_id, author_name
  `).all(guildId);
  const people = new Map<string, { names: { name: string; lastMs: number }[]; messages: number; firstMs: number; lastMs: number }>();
  for (const row of rows) {
    const entry = people.get(row.author_id) ?? { names: [], messages: 0, firstMs: row.first_ms, lastMs: row.last_ms };
    entry.names.push({ name: row.author_name, lastMs: row.last_ms });
    entry.messages += row.messages;
    entry.firstMs = Math.min(entry.firstMs, row.first_ms);
    entry.lastMs = Math.max(entry.lastMs, row.last_ms);
    people.set(row.author_id, entry);
  }
  for (const entry of people.values()) entry.names.sort((a, b) => b.lastMs - a.lastMs);
  return people;
}

export interface ResolveStats { people: number; things: number; claims: number; unplaced: number }

interface ClaimKey { id: number; about_kind: string; about_key: string; category: string; modality: string; verdict: string }

export function resolveEntities(guildId: string, people = loadPeople(guildId)): ResolveStats {
  const d = memoryDb();
  const claims = d.prepare<[string], ClaimKey>(`
    SELECT id, about_kind, about_key, category, modality, verdict FROM v2_claims WHERE guild_id = ? AND verdict <> 'wrong'
  `).all(guildId).filter((claim) => !UNSERIOUS.includes(claim.modality as Modality));

  const personClaims = new Map<string, number[]>();
  const thingClaims = new Map<string, { ids: number[]; spellings: Map<string, number>; votes: Map<Category, number> }>();
  for (const claim of claims) {
    if (claim.about_kind === 'person') {
      const list = personClaims.get(claim.about_key) ?? [];
      list.push(claim.id);
      personClaims.set(claim.about_key, list);
    } else {
      const key = nameKey(claim.about_key);
      if (!key) continue;
      const entry = thingClaims.get(key) ?? { ids: [] as number[], spellings: new Map<string, number>(), votes: new Map<Category, number>() };
      entry.ids.push(claim.id);
      entry.spellings.set(claim.about_key, (entry.spellings.get(claim.about_key) ?? 0) + 1);
      const category = (CATEGORIES as readonly string[]).includes(claim.category) ? claim.category as Category : 'others';
      entry.votes.set(category, (entry.votes.get(category) ?? 0) + 1);
      thingClaims.set(key, entry);
    }
  }

  const stats: ResolveStats = { people: 0, things: 0, claims: 0, unplaced: 0 };
  const used = new Set<string>();
  const unique = (base: string, suffix: string): string => {
    let path = base;
    if (used.has(path.toLowerCase())) path = `${base}~${suffix}`;
    for (let n = 2; used.has(path.toLowerCase()); n += 1) path = `${base}~${suffix}-${n}`;
    used.add(path.toLowerCase());
    return path;
  };

  d.transaction(() => {
    d.prepare('DELETE FROM v2_entities WHERE guild_id = ?').run(guildId);
    d.prepare('UPDATE v2_claims SET entity_id = NULL WHERE guild_id = ?').run(guildId);
    const insert = d.prepare(`
      INSERT INTO v2_entities (guild_id, kind, key, name, category, path, aliases, meta) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const assign = d.prepare('UPDATE v2_claims SET entity_id = ? WHERE id = ?');

    // 人物: 主張の多い人から先にページ名を取る
    const ordered = [...personClaims].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
    for (const [authorId, ids] of ordered) {
      const info = people.get(authorId);
      const names = info?.names ?? [];
      const latest = names[0]?.name ?? '';
      const deleted = /^deleted user/i.test(latest);
      const clean = pageName(latest);
      const base = clean && !deleted ? `people/${clean}` : `people/${clean || 'user'}~${authorId.slice(-4)}`;
      const path = normalizePath(unique(base, authorId.slice(-4))) ?? `people/user~${authorId.slice(-4)}`;
      const aliases = [...new Set(names.slice(1).map((entry) => entry.name).filter((name) => name !== latest))].slice(0, 12);
      const id = Number(insert.run(guildId, 'person', authorId, latest || 'user', 'people', path, JSON.stringify(aliases),
        JSON.stringify({ messages: info?.messages ?? 0, firstMs: info?.firstMs ?? null, lastMs: info?.lastMs ?? null, names: names.length })).lastInsertRowid);
      for (const claimId of ids) assign.run(id, claimId);
      stats.people += 1;
      stats.claims += ids.length;
    }

    // もの: 正規化した名前ごと。分類は多数決、表記は最頻
    for (const [key, entry] of [...thingClaims].sort((a, b) => b[1].ids.length - a[1].ids.length || a[0].localeCompare(b[0]))) {
      const spelling = [...entry.spellings].sort((a, b) => b[1] - a[1] || a[0].length - b[0].length)[0]?.[0] ?? key;
      const category = [...entry.votes].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'others';
      const name = pageName(spelling);
      if (!name) { stats.unplaced += entry.ids.length; continue; }
      const path = normalizePath(unique(`${category}/${name}`, String(entry.ids[0]))) ?? '';
      if (!path) { stats.unplaced += entry.ids.length; continue; }
      const aliases = [...entry.spellings.keys()].filter((s) => s !== spelling).slice(0, 12);
      const id = Number(insert.run(guildId, 'thing', key, name, category, path, JSON.stringify(aliases), '{}').lastInsertRowid);
      for (const claimId of entry.ids) assign.run(id, claimId);
      stats.things += 1;
      stats.claims += entry.ids.length;
    }
  })();
  return stats;
}

/** 出来事の entities (JSON) → ページのパス。人物は author_id、ものは名前の正規化で引く。 */
export function entityPaths(guildId: string): { person: Map<string, string>; thing: Map<string, string> } {
  const person = new Map<string, string>();
  const thing = new Map<string, string>();
  for (const row of memoryDb().prepare<[string], { kind: string; key: string; path: string }>(
    'SELECT kind, key, path FROM v2_entities WHERE guild_id = ?').all(guildId)) {
    (row.kind === 'person' ? person : thing).set(row.key, row.path);
  }
  return { person, thing };
}
