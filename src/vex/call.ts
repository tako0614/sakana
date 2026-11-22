// 設定された呼び名を照合する。前後の英数字とは区切り、コード・URL・メンション・引用の中は見ない。
import { vexConfig, type CallMode, type VexConfig } from './config.js';

/** 判定の対象から外す部分 (コードブロック・インラインコード・URL・メンション・引用行) を取り除く。 */
export function visibleText(content: string): string {
  return String(content ?? '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`\n]*`/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/<a?:\w+:\d+>/g, ' ')
    .replace(/<[@#&][!&]?\d+>/g, ' ')
    .split('\n').filter((line) => !/^\s*>/.test(line)).join('\n');
}

const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function isVexCall(content: string, names: readonly string[] = vexConfig.names): boolean {
  if (names.length === 0) return false;
  const pattern = new RegExp(`(?<![A-Za-z0-9_])(?:${names.map(escape).join('|')})(?![A-Za-z0-9_])`, 'i');
  return pattern.test(visibleText(content));
}

/** 名前を呼んだだけなら、初回の想起に渡す話題はまだ無い。URL・引用・他のメンションも本文として残す。 */
export function isBareNameCall(content: string, names: readonly string[] = vexConfig.names): boolean {
  const text = content.trim().toLowerCase();
  const bare = text.replace(/[!！?？。、\s]+$/u, '');
  return names.some((name) => {
    const alias = name.toLowerCase();
    return alias.length > 0 && (text === alias || bare === alias);
  });
}

/** この発言で名前が出ていれば、設定された扱い (mention / judge)。出ていない・オフなら null。 */
export function nameHandling(content: string, config: Pick<VexConfig, 'names' | 'callMode'> = vexConfig): Exclude<CallMode, 'off'> | null {
  if (config.callMode === 'off') return null;
  return isVexCall(content, config.names) ? config.callMode : null;
}
