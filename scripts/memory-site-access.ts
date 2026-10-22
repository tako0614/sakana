import 'dotenv/config';
import { changeSiteAccess } from '../src/memory/site-access.js';
import { SITE_ACCESS_VALUES, getSiteAccess, type SiteAccess } from '../src/memory/store.js';

// 記憶のサイト (sakana.takos.jp/<サーバーID>/wiki) の公開を、コマンドラインから切り替える (/memory site と同じ)。
//
//   tsx scripts/memory-site-access.ts <サーバーID>                 今の状態を見る
//   tsx scripts/memory-site-access.ts <サーバーID> off|members|public
//
// bot の記憶 DB (MEMORY_DB_PATH) に書き、サイト (Worker) にも送る。off はメンバーにも見せない。

const [guildId, mode] = process.argv.slice(2);
if (!guildId || !/^\d{5,25}$/.test(guildId)) {
  console.error('使い方: tsx scripts/memory-site-access.ts <サーバーID> [off|members|public]');
  process.exit(2);
}
if (!mode) {
  console.log(`${guildId}: ${getSiteAccess(guildId) ?? '(未設定。サイトの既定に従う)'}`);
} else if (!SITE_ACCESS_VALUES.some((value) => value === mode)) {
  console.error(`mode は ${SITE_ACCESS_VALUES.join(' / ')} のどれか: ${mode}`);
  process.exit(2);
} else {
  const result = await changeSiteAccess(guildId, mode as SiteAccess, 'cli');
  console.log(`${guildId}: ${mode} — bot 側に保存しました。サイトへ: ${result.ok ? '反映しました' : `届いていません (${result.reason ?? '?'})`}`);
  if (!result.ok) process.exitCode = 1;
}
