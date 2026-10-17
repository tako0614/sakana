// 「vex」と呼ばれたか。英字の単語として (evex や vexx は別物)、コード・URL・メンション・引用の中は見ない。
import { vexConfig } from './config.js';

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
