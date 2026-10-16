// 外から来た値 (例外・JSON・ワーカーの返事) を unknown のまま読むための小さな道具。

export function isRecord(value: unknown): value is object {
  return typeof value === 'object' && value !== null;
}

/** key を持つオブジェクトか (中身の型は問わない)。 */
export function hasField<K extends string>(value: unknown, key: K): value is Record<K, unknown> {
  return isRecord(value) && key in value;
}

/** オブジェクトの1項目を unknown のまま取り出す。無ければ undefined。 */
export function field<K extends string>(value: unknown, key: K): unknown {
  return hasField(value, key) ? value[key] : undefined;
}

/** 例外の文面。Error でなければ文字列にする (以前の String(error.message ?? error) と同じ見え方)。 */
export function errorMessage(error: unknown): string {
  const message = field(error, 'message');
  return String(message ?? error);
}

/** Discord / SQLite のエラーが持つ code や status。数値か文字列だけを返す。 */
export function errorCode(error: unknown, key: 'code' | 'status'): string | number | undefined {
  const value = field(error, key);
  return typeof value === 'string' || typeof value === 'number' ? value : undefined;
}
