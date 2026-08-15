import type { ConversationTurn } from './protocol';
import type { Persona } from '../models';

const NORMALIZERS: Array<[RegExp, string]> = [
  [/https?:\/\/\S+/g, '<url>'],
  [/<a?:([a-zA-Z0-9_]{2,32}):\d{15,25}>/g, ':$1:'],
  [/<@[!&]?\d{15,25}>/g, '<mention>'],
  [/<#\d{15,25}>/g, '<channel>'],
  [/<t:\d+(?::[tTdDfFR])?>/g, '<time>'],
  [/@everyone|@here/g, '<mention>'],
];

export function normalizeEvex(text: string): string {
  let output = String(text).replace(/```[a-zA-Z0-9+#-]*\n?([\s\S]*?)```/g, '<code>$1</code>');
  for (const [pattern, replacement] of NORMALIZERS) output = output.replace(pattern, replacement);
  return output.replace(/\r\n|[\n\r\u2028\u2029]/g, '<nl>').trim() || '<file>';
}

export function buildEvexPrompt(turns: ConversationTurn[], persona: Persona): string {
  const parts = ['<|conv|>'];
  for (const turn of turns) {
    parts.push(turn.role === 'assistant' ? persona.prompt : '<|other|>');
    parts.push(normalizeEvex(turn.content));
  }
  parts.push(persona.prompt);
  return parts.join('');
}

export function buildFtPrompt(turns: ConversationTurn[], persona: Persona): string {
  const assistant = persona.prompt || 'B';
  const lines = ['#other'];
  for (const turn of turns) {
    const label = turn.role === 'assistant' ? assistant : 'A';
    lines.push(`${label}: ${turn.content.replace(/[\r\n]+/g, ' ').trim()}`);
  }
  lines.push(`${assistant}:`);
  return lines.join('\n');
}

const CONTROL = /<\|s\d+\|>|<\|other\|>|<\|[a-hz]\|>|<\|end\|>|<\|conv\|>/;

function plainEvex(text: string): string {
  return text
    .replace(/<\|re\|>/g, '')
    .replace(/<nl>/g, '\n')
    .replace(/<code>/g, '```\n')
    .replace(/<\/code>/g, '\n```')
    .replace(/<file>/g, '(画像)')
    .replace(/<url>/g, '(リンク)')
    .replace(/<mention>/g, '(だれか)')
    .replace(/<channel>/g, '(チャンネル)')
    .replace(/<time>/g, '(時刻)')
    .trim();
}

export function cleanEvexReply(text: string, personaToken: string): string {
  let rest = text;
  const own: string[] = [];
  for (let index = 0; index < 4; index += 1) {
    const found = rest.match(CONTROL);
    if (!found) {
      own.push(rest);
      break;
    }
    own.push(rest.slice(0, found.index));
    if (found[0] !== personaToken || /<\|(?:end|conv)\|>/.test(found[0])) break;
    rest = rest.slice((found.index ?? 0) + found[0].length);
  }
  const turns = own.map(plainEvex).filter(Boolean);
  while (turns.length > 1 && turns.join('\n').length > 400) turns.pop();
  return turns.join('\n').slice(0, 400);
}

export function cleanFtReply(text: string, label: string): string {
  let rest = text.split(/\n#(?:ch\d+|other)\b/)[0];
  const own: string[] = [];
  for (let index = 0; index < 4; index += 1) {
    const found = rest.match(/\n([^\n:]{1,32}):[ 　]/);
    if (!found) {
      own.push(rest);
      break;
    }
    own.push(rest.slice(0, found.index));
    if (found[1] !== label) break;
    rest = rest.slice((found.index ?? 0) + found[0].length);
  }
  const turns = own.map((turn) => turn.trim()).filter(Boolean);
  while (turns.length > 1 && turns.join('\n').length > 400) turns.pop();
  return turns.join('\n').slice(0, 400);
}

const UNUSABLE = /^(?:\[(?:画像|動画|音声|ファイル|添付|圧縮ファイル|埋め込み|スタンプ)\]|https?:\/\/\S+(?:[\s　]+https?:\/\/\S+)*|@[^\s　]+)$/;

export function isUsableReply(text: string): boolean {
  const value = text.trim();
  return value.length >= 2 && !UNUSABLE.test(value);
}
