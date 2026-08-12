// 「誰として喋るか」の設定。/model と同じで、誰でも自分のぶんだけ変えられる。
//
// /mimic は1回ぶんの生成だが、こちらは設定として残る。`/as -akku-` を打つと、
// 以降その人に話しかけたときの返答がずっとその口調で来る。
//
// チャンネル単位ではなくユーザー単位にする。/model がそうなっているのと揃えるのと、
// 1人が変えると全員の見え方が変わる形は事故になりやすいから。

import { db } from '../db.js';

db.exec(`
  CREATE TABLE IF NOT EXISTS agent_persona (
    user_id    TEXT PRIMARY KEY,
    target_id  TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
`);

const getStmt = db.prepare('SELECT target_id FROM agent_persona WHERE user_id = ?');
const setStmt = db.prepare(`
  INSERT INTO agent_persona (user_id, target_id, updated_at) VALUES (?, ?, ?)
  ON CONFLICT(user_id) DO UPDATE SET target_id = excluded.target_id, updated_at = excluded.updated_at
`);
const clearStmt = db.prepare('DELETE FROM agent_persona WHERE user_id = ?');
const countStmt = db.prepare('SELECT target_id, COUNT(*) n FROM agent_persona GROUP BY target_id ORDER BY n DESC');

/** その人が誰として喋らせているか。設定が無ければ null (bot 自身として喋る)。 */
export function personaFor(userId) {
  return getStmt.get(String(userId))?.target_id ?? null;
}

export function setPersona(userId, targetId) {
  setStmt.run(String(userId), String(targetId), Date.now());
}

export function clearPersona(userId) {
  return clearStmt.run(String(userId)).changes > 0;
}

/** 誰が人気かの内訳。/as の表示に出す。 */
export function personaCounts() {
  return countStmt.all().map((row) => ({ targetId: row.target_id, users: row.n }));
}

// 対象から外れた人の設定は残しておくと「なぜか効かない」状態になるので、
// 抜けたときに掃除できるようにしておく
const forgetStmt = db.prepare('DELETE FROM agent_persona WHERE target_id = ?');

export function forgetPersona(targetId) {
  return forgetStmt.run(String(targetId)).changes;
}
