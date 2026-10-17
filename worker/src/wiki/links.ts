// サイトの URL の作り方。記憶はサーバーごとに分け、すべての URL に /<サーバーID> を付ける。
//   /<g>/wiki  /<g>/wiki/<path>  /<g>/e/<id>  /<g>/t[/YYYY-MM]  /<g>/s  /<g>/random
// 画面は links を通して href を作る (サーバーの違うページへ、うっかり飛ばないように)。

import type { Env } from './types.ts';

export const GUILD_ID = /^\d{5,25}$/;

/** 記憶を見せるサーバー。URL の /<サーバーID> がこの一覧にあるものだけ開く (無ければ 404)。 */
export function memoryGuilds(env: Env): string[] {
  const raw = `${env.MEMORY_GUILD_IDS ?? ''} ${env.MEMORY_GUILD_ID ?? ''} ${env.DEFAULT_GUILD_ID ?? ''}`;
  return [...new Set(raw.split(/[\s,]+/).filter((id) => GUILD_ID.test(id)))];
}

export interface Links {
  guild: string;
  /** /<g> */
  base: string;
  home: string;
  wiki(path: string): string;
  episode(id: number): string;
  timeline: string;
  month(month: string, kind?: string): string;
  search: string;
  random: string;
  /** 法令集 (サーバーごとの一覧) */
  laws: string;
}

const encodePath = (path: string): string => path.split('/').filter(Boolean).map(encodeURIComponent).join('/');

export function makeLinks(guild: string): Links {
  const base = `/${guild}`;
  return {
    guild,
    base,
    home: `${base}/wiki`,
    wiki: (path) => (path ? `${base}/wiki/${encodePath(path)}` : `${base}/wiki`),
    episode: (id) => `${base}/e/${id}`,
    timeline: `${base}/t`,
    month: (month, kind = '') => `${base}/t/${month}${kind ? `?kind=${encodeURIComponent(kind)}` : ''}`,
    search: `${base}/s`,
    random: `${base}/random`,
    laws: `/?guild=${encodeURIComponent(guild)}`
  };
}
