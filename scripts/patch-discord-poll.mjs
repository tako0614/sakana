// discord.js の Poll の不具合への当て布 (npm install の postinstall で走る)。
//
// discord.js 14.26.3〜14.27.0 の Poll は、メッセージの channel が手元のキャッシュに無いと
// `channel.id` を読んで落ちる (他サーバーから転送された投票など)。messages.fetch が
// ページごと例外になるので、そのチャンネルの取り込みが毎回そこで止まっていた
// (2026-10 の /index build で #裏 が "Cannot read properties of null (reading 'id')")。
//
// 何度走らせても同じ結果になる。形が変わっていたら (直った版など) 何もしない。

import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const BROKEN = 'this.channelId = data.channel_id ?? channel.id;';
const FIXED = 'this.channelId = data.channel_id ?? channel?.id ?? message?.channelId ?? null; // sakana: patched (scripts/patch-discord-poll.mjs)';

export function patchPollSource(source) {
  if (source.includes(FIXED)) return { source, state: 'already' };
  if (!source.includes(BROKEN)) return { source, state: 'unknown' };
  return { source: source.replace(BROKEN, FIXED), state: 'patched' };
}

export function pollFile() {
  const require = createRequire(import.meta.url);
  // package.json は exports で閉じているので、入口から辿る
  return join(dirname(require.resolve('discord.js')), 'structures', 'Poll.js');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  let file;
  try { file = pollFile(); } catch { process.exit(0); }   // discord.js が無い環境 (web/ など)
  const { source, state } = patchPollSource(readFileSync(file, 'utf8'));
  if (state === 'patched') writeFileSync(file, source);
  if (state === 'unknown') console.warn('patch-discord-poll: Poll.js の形が想定と違うので当てませんでした (直った版なら不要)');
  else console.log(`patch-discord-poll: ${state}`);
}
