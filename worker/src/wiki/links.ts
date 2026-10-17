// サイトの URL の作り方。記憶の本はサーバーごとに分け、すべての URL に /<サーバーID> を付ける。
//   /<g>/wiki  /<g>/wiki/<path>  /<g>/e/<id>  /<g>/t[/YYYY-MM]  /<g>/s  /<g>/random  /<g>/auth/logout
// 画面は links を通して href を作る (サーバーの違うページへ、うっかり飛ばないように)。

export const GUILD_ID = /^\d{5,25}$/;

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
  logout: string;
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
    logout: `${base}/auth/logout`,
    laws: `/?guild=${encodeURIComponent(guild)}`
  };
}
