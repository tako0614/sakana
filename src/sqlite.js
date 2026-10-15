// SQLite の接続を速くする共通設定。
//
// 2026-10 の本番 (CT102 / DB は回転式 HDD 上) で、どの DB も既定のまま
// (キャッシュ 16MB・mmap なし・統計情報なし) だった。2.7GB の archive.sqlite では
// 同じページを何度もディスクから読み直し、索引の選び方も当て推量になっていた。
//
//   cache_size:  よく読むページ (索引の上の方) をプロセス内に置く
//   mmap_size:   読み取りを OS のページキャッシュから直接読む (read() の往復とコピーを省く)
//   temp_store:  ORDER BY / GROUP BY の一時領域をディスクに書かない
//   optimize:    統計情報 (sqlite_stat1) を少しずつ作り直し、索引の選び方を正しくする。
//                analysis_limit で1回の手間を絞るので、HDD でも数秒で済む

const MIB = 1024 * 1024;
const OPTIMIZE_DELAY_MS = 60_000;
const OPTIMIZE_INTERVAL_MS = 6 * 3_600_000;

export function tuneSqlite(db, { cacheMiB = 32, mmapMiB = 256, label = 'sqlite' } = {}) {
  try {
    db.pragma(`cache_size = -${Math.round(cacheMiB * 1024)}`);
    db.pragma(`mmap_size = ${Math.round(mmapMiB * MIB)}`);
    db.pragma('temp_store = MEMORY');
  } catch (error) {
    console.warn(`${label}: could not tune SQLite connection:`, error.message);
  }
  return db;
}

/**
 * 統計情報を育てる。起動直後は避けて1分後に1回、以後6時間ごと。
 * 0x10002 は「最近使われていない表も対象にする」(新しい接続の最初の1回用)。
 */
export function scheduleOptimize(db, { label = 'sqlite', limit = 1000 } = {}) {
  const run = (mask) => {
    try {
      const started = Date.now();
      db.pragma(`analysis_limit = ${limit}`);
      db.pragma(mask ? `optimize = ${mask}` : 'optimize');
      const ms = Date.now() - started;
      if (ms > 1000) console.log(`${label}: PRAGMA optimize took ${ms}ms`);
    } catch (error) {
      // ロック中などで失敗しても次の回でやり直せる。会話や取り込みは止めない
      console.warn(`${label}: PRAGMA optimize skipped:`, error.message);
    }
  };
  setTimeout(() => run('0x10002'), OPTIMIZE_DELAY_MS).unref?.();
  setInterval(() => run(null), OPTIMIZE_INTERVAL_MS).unref?.();
}

export const envMiB = (name, fallback) => {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
};
