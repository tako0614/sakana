// vex の設定を、再起動なしで切り替える (/vex コマンド)。
//
// 起動時の値は環境変数 (config.ts)。コマンドで変えた値は DB に残り、環境変数より優先する。
// vexConfig は同じ object を全員が参照していて、使うときに値を読むので、ここで中身を書き換えれば
// 名前の扱い・自発参加・閾値などがすぐ全体に効く。reset すると環境変数の値に戻る。
import { db } from '../db.js';
import { vexConfig, type CallMode, type VexConfig } from './config.js';

db.exec(`
  CREATE TABLE IF NOT EXISTS vex_settings (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    updated_by TEXT
  );
`);

/** 起動時 (環境変数) の値。reset でここに戻す。 */
const ENV_VALUES = {
  callMode: vexConfig.callMode,
  ambient: vexConfig.ambient,
  arbiter: vexConfig.arbiter,
  channels: [...vexConfig.channels],
  threshold: vexConfig.threshold,
  quietMs: vexConfig.quietMs,
  cooldownMs: vexConfig.cooldownMs,
  maxPerHour: vexConfig.maxPerHour
};

export const CALL_MODES: readonly CallMode[] = ['off', 'mention', 'judge'];

/** 数値の設定。キー (コマンドの選択肢) → 範囲と、config の項目への変換。 */
export const NUMBER_SETTINGS = {
  threshold: { label: '自発参加の閾値 (0〜1)', min: 0.05, max: 0.99, integer: false },
  quiet_seconds: { label: '静かになってから判定するまで (秒)', min: 3, max: 600, integer: false },
  cooldown_minutes: { label: '入ったあとの冷却 (分)', min: 0, max: 1440, integer: false },
  max_per_hour: { label: '1 時間に入る上限 (回)', min: 0, max: 60, integer: true }
} as const;
export type NumberSettingKey = keyof typeof NUMBER_SETTINGS;

const rows = (): Record<string, string> => Object.fromEntries(
  db.prepare<[], { key: string; value: string }>('SELECT key, value FROM vex_settings').all().map((row) => [row.key, row.value])
);

/** 保存してある値を config に反映する (保存が無い項目は環境変数の値)。起動時と、設定を変えたあとに呼ぶ。 */
export function applyVexSettings(config: VexConfig = vexConfig): void {
  const saved = rows();
  const mode = CALL_MODES.find((value) => value === saved['call']) ?? ENV_VALUES.callMode;
  config.callMode = mode;
  config.call = mode !== 'off';
  config.ambient = saved['ambient'] === undefined ? ENV_VALUES.ambient : saved['ambient'] === '1';
  config.arbiter = saved['arbiter'] === undefined ? ENV_VALUES.arbiter : saved['arbiter'] === '1';

  let channels = ENV_VALUES.channels;
  if (saved['channels'] !== undefined) {
    try {
      const parsed: unknown = JSON.parse(saved['channels']);
      if (Array.isArray(parsed)) channels = parsed.filter((id): id is string => typeof id === 'string');
    } catch { /* 壊れていれば環境変数の値 */ }
  }
  config.channels.clear();
  for (const id of channels) config.channels.add(id);

  const number = (key: NumberSettingKey, fallback: number): number => {
    const value = Number(saved[key]);
    return saved[key] !== undefined && Number.isFinite(value) ? value : fallback;
  };
  config.threshold = number('threshold', ENV_VALUES.threshold);
  config.quietMs = saved['quiet_seconds'] !== undefined ? number('quiet_seconds', 0) * 1000 : ENV_VALUES.quietMs;
  config.cooldownMs = saved['cooldown_minutes'] !== undefined ? number('cooldown_minutes', 0) * 60_000 : ENV_VALUES.cooldownMs;
  config.maxPerHour = number('max_per_hour', ENV_VALUES.maxPerHour);
}

function save(key: string, value: string, by: string | null): void {
  db.prepare(`
    INSERT INTO vex_settings (key, value, updated_at, updated_by) VALUES (?, ?, ?, ?)
    ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by
  `).run(key, value, Date.now(), by);
}

/** 名前 (vex) の扱いを変える。 */
export function setCallMode(mode: string, by: string | null): boolean {
  if (!CALL_MODES.some((value) => value === mode)) return false;
  save('call', mode, by);
  applyVexSettings();
  return true;
}

export function setAmbient(enabled: boolean, by: string | null): void {
  save('ambient', enabled ? '1' : '0', by);
  applyVexSettings();
}

export function setArbiter(enabled: boolean, by: string | null): void {
  save('arbiter', enabled ? '1' : '0', by);
  applyVexSettings();
}

/** 自発参加してよいチャンネルを足す / 外す。変わったら true。 */
export function setChannel(channelId: string, allowed: boolean, by: string | null): boolean {
  const next = new Set(vexConfig.channels);
  const had = next.has(channelId);
  if (allowed) next.add(channelId); else next.delete(channelId);
  if (had === allowed) return false;
  save('channels', JSON.stringify([...next]), by);
  applyVexSettings();
  return true;
}

/** 数値の設定を変える。範囲外・数でなければ false。 */
export function setNumber(key: string, value: number, by: string | null): boolean {
  if (!Object.hasOwn(NUMBER_SETTINGS, key)) return false;
  const spec = NUMBER_SETTINGS[key as NumberSettingKey];
  if (!Number.isFinite(value) || value < spec.min || value > spec.max || (spec.integer && !Number.isInteger(value))) return false;
  save(key, String(value), by);
  applyVexSettings();
  return true;
}

/** コマンドで変えた値をすべて捨てて、環境変数の値に戻す。消した件数を返す。 */
export function resetVexSettings(): number {
  const removed = db.prepare('DELETE FROM vex_settings').run().changes;
  applyVexSettings();
  return removed;
}

/** コマンドで変えてある項目 (環境変数の値と違うかどうかではなく、保存してあるもの)。 */
export function changedSettings(): string[] {
  return Object.keys(rows());
}

/** 環境変数の値 (reset で戻る先)。 */
export function envValues(): typeof ENV_VALUES {
  return { ...ENV_VALUES, channels: [...ENV_VALUES.channels] };
}

// 起動したら、前に変えた値を反映する
applyVexSettings();
