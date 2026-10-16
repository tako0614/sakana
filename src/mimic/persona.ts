// 「誰として喋るか」の設定。/model と同じで、誰でも自分のぶんだけ変えられる。
//
// /mimic は1回ぶんの生成だが、こちらは設定として残る。`/as -akku-` を打つと、
// 以降その人に話しかけたときの返答がずっとその口調で来る。
//
// サーバーとユーザーの組み合わせごとに設定する。別サーバーへ引き継がない。
// 1人が変えると全員の見え方が変わる形は事故になりやすいから。

import { db } from '../db.js';
import { migrateGuildPreference, requireGuildId } from './scope.js';

/** agent_persona の内訳の1行。 */
interface PersonaCountRow {
  target_id: string;
  n: number;
}

function targetColumn(row: unknown): string | null {
  return typeof row === 'object' && row !== null && 'target_id' in row && typeof row.target_id === 'string'
    ? row.target_id
    : null;
}

function isPersonaCountRow(row: unknown): row is PersonaCountRow {
  return typeof row === 'object' && row !== null
    && 'target_id' in row && typeof row.target_id === 'string'
    && 'n' in row && typeof row.n === 'number';
}

migrateGuildPreference(db, 'agent_persona', 'target_id');
const getStmt = db.prepare<[string, string]>('SELECT target_id FROM agent_persona WHERE guild_id = ? AND user_id = ?');
const setStmt = db.prepare<[string, string, string, number]>(`
  INSERT INTO agent_persona (guild_id, user_id, target_id, updated_at) VALUES (?, ?, ?, ?)
  ON CONFLICT(guild_id, user_id) DO UPDATE SET target_id = excluded.target_id, updated_at = excluded.updated_at
`);
const clearStmt = db.prepare<[string, string]>('DELETE FROM agent_persona WHERE guild_id = ? AND user_id = ?');
const countStmt = db.prepare<[string]>('SELECT target_id, COUNT(*) n FROM agent_persona WHERE guild_id = ? GROUP BY target_id ORDER BY n DESC');

/** その人が誰として喋らせているか。設定が無ければ null (bot 自身として喋る)。 */
export function personaFor(userId: string, guildId: unknown): string | null {
  return targetColumn(getStmt.get(requireGuildId(guildId), String(userId)));
}

export function setPersona(userId: string, targetId: string, guildId: unknown): void {
  setStmt.run(requireGuildId(guildId), String(userId), String(targetId), Date.now());
}

export function clearPersona(userId: string, guildId: unknown): boolean {
  return clearStmt.run(requireGuildId(guildId), String(userId)).changes > 0;
}

/** 誰が人気かの内訳。/as の表示に出す。 */
export function personaCounts(guildId: unknown): Array<{ targetId: string; users: number }> {
  return countStmt.all(requireGuildId(guildId)).filter(isPersonaCountRow)
    .map((row) => ({ targetId: row.target_id, users: row.n }));
}

// 対象から外れた人の設定は残しておくと「なぜか効かない」状態になるので、
// 抜けたときに掃除できるようにしておく
const forgetStmt = db.prepare<[string, string]>('DELETE FROM agent_persona WHERE guild_id = ? AND target_id = ?');

export function forgetPersona(targetId: string, guildId: unknown): number {
  return forgetStmt.run(requireGuildId(guildId), String(targetId)).changes;
}
