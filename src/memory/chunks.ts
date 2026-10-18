import { createHash } from 'node:crypto';
import { memoryDb } from './store.js';

// ページの本文を、意味検索の最小の単位 (1つの知識) に割る。
//
// ページは「見出し + 箇条書き (1行 = 1つの知識、末尾に [e12] で根拠の出来事)」で書かれている。
// ページ1枚を1本のベクトルにすると、頭の 500 字しか効かず (ページの約 3 割は本文がそれより長い)、
// 中身が混ざって薄まる。1行ずつ振れば、「どのページの、どの節の、どの話か」まで届く。
// 割った断片は memory_chunks に持ち、ベクトルは memory_vectors (kind = 'chunk') に持つ (vectors.ts)。

export interface Piece {
  /** 節の見出し。入れ子は ' › ' でつなぐ。節の外は空。 */
  heading: string;
  /** 出典番号とリンクの記号を外した1つの知識。 */
  text: string;
  /** 根拠の出来事の番号。 */
  cites: number[];
}

/**
 * 断片の大きさ: 同じ節の隣り合う行を、何字までまとめて 1 つの断片にするか。0 なら 1 行ずつ。
 * 環境変数 MEMORY_CHUNK_CHARS で変える (変えると次の定期実行で作り直し、振り直す)。値は docs/memory-chunks.md の測定で決めた。
 */
export const DEFAULT_CHUNK_CHARS = 0;
export function chunkChars(): number {
  const value = Number(process.env.MEMORY_CHUNK_CHARS ?? DEFAULT_CHUNK_CHARS);
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : DEFAULT_CHUNK_CHARS;
}

const MIN_CHARS = 8;
/** 1つの断片の長さの上限。超える行は句点で割る (実データでは 99% が 350 字以下)。 */
const MAX_CHARS = 300;
const CITE_GROUP = /\[(e\d+(?:\s*,\s*e\d+)*)\]/g;
const HEADING = /^(#{1,6})\s+(.*)$/;
const BULLET = /^(?:[-*]|\d+\.)\s+/;

/** [[people/たこ]] → たこ、[[people/たこ|作者]] → 作者、[e12] と **太字** の記号は消す。 */
export function plainText(text: string): string {
  return text
    .replace(/\[\[([^\]|]*)(?:\|([^\]]*))?\]\]/g, (_match, path: string, label?: string) => label || path.split('/').pop() || path)
    .replace(CITE_GROUP, '')
    .replace(/\*\*([^*\n]+)\*\*/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

export function citesOf(text: string): number[] {
  const ids: number[] = [];
  for (const match of text.matchAll(CITE_GROUP)) {
    for (const id of (match[1] ?? '').matchAll(/\d+/g)) {
      const value = Number(id[0]);
      if (!ids.includes(value)) ids.push(value);
    }
  }
  return ids;
}

/** 1行を、上限を超えるときだけ句点の後ろで割る (出典番号が付いたまま)。 */
function packSentences(line: string): string[] {
  if (plainText(line).length <= MAX_CHARS) return [line];
  const packed: string[] = [];
  let current = '';
  for (const sentence of line.split(/(?<=。)/)) {
    if (current && plainText(current + sentence).length > MAX_CHARS) {
      packed.push(current);
      current = sentence;
    } else {
      current += sentence;
    }
  }
  if (current) packed.push(current);
  return packed;
}

/**
 * 本文を 1 つの知識ごとに割る。見出しは前から引き継ぎ、箇条書きの記号は外す。
 * 短すぎる行 (見出しだけ・記号だけ) は捨てる。同じ行に複数の文があれば、上限までは1つのまま。
 */
export function splitPieces(body: string, baseHeading = ''): Piece[] {
  const stack: string[] = [];
  const pieces: Piece[] = [];
  for (const rawLine of body.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    const heading = HEADING.exec(line);
    if (heading) {
      const level = (heading[1] ?? '#').length;
      stack.length = level - 1;
      stack[level - 1] = plainText(heading[2] ?? '');
      continue;
    }
    const where = stack.filter(Boolean).join(' › ') || baseHeading;
    const pending: string[] = [];
    for (const part of packSentences(line.replace(BULLET, ''))) {
      const text = plainText(part);
      if (text.length >= MIN_CHARS) pending.push(part);
      // 前の断片に足せるときは足す (「…した。」のあとに [e1] だけの行が続く、など)
      else if (pending.length > 0) pending[pending.length - 1] += part;
    }
    for (const part of pending) {
      const text = plainText(part);
      if (text.length >= MIN_CHARS) pieces.push({ heading: where, text, cites: citesOf(part) });
    }
  }
  return pieces;
}

/**
 * 同じ節の隣り合う行を、maxChars までまとめて 1 つの「区切り」にする (節をまたがない)。
 * 1 行だけだと「推奨」「持論」のように何の話か分からない行があるので、前後の行といっしょに振る単位。
 * 行は改行でつなぎ、根拠の出来事 (cites) は合わせる。1 行がすでに上限を超えるなら、その行がそのまま 1 つになる。
 */
export function packPieces(pieces: readonly Piece[], maxChars: number): Piece[] {
  const out: Piece[] = [];
  let current: Piece | null = null;
  for (const piece of pieces) {
    if (current && current.heading === piece.heading && current.text.length + 1 + piece.text.length <= maxChars) {
      current = { heading: current.heading, text: `${current.text}\n${piece.text}`, cites: [...new Set([...current.cites, ...piece.cites])] };
      continue;
    }
    if (current) out.push(current);
    current = { ...piece, cites: [...piece.cites] };
  }
  if (current) out.push(current);
  return out;
}

/**
 * 節だけを取り出す (長いページを丸ごと読まずに、見つかった節だけ開くため)。
 * section は見出しの全体 (「立場と意見 › 言語」) か、その最後の部分 (「言語」)。上の見出しを指せば下の節も含む。
 */
export function sectionOf(body: string, section: string): string | null {
  const wanted = section.trim();
  if (!wanted) return null;
  const stack: string[] = [];
  const out: string[] = [];
  let level = 0;   // 0 はまだ見つかっていない
  for (const line of body.split('\n')) {
    const heading = HEADING.exec(line.trim());
    if (heading) {
      const depth = (heading[1] ?? '#').length;
      if (level > 0) {
        if (depth <= level) break;   // 同じか上の見出しで、その節は終わり
        out.push(line);
        continue;
      }
      stack.length = depth - 1;
      stack[depth - 1] = plainText(heading[2] ?? '');
      if (stack.filter(Boolean).join(' › ') === wanted || stack[depth - 1] === wanted) {
        level = depth;
        out.push(line);
      }
      continue;
    }
    if (level > 0) out.push(line);
  }
  return level > 0 ? out.join('\n').trim() : null;
}

const bigramsOf = (text: string): Set<string> => {
  const flat = text.replace(/\s+/g, '');
  const out = new Set<string>();
  for (let index = 0; index + 1 < flat.length; index += 1) out.add(flat.slice(index, index + 2));
  return out;
};

/**
 * まとめた断片のうち、質問にいちばん言葉が重なる行。想起の行に出す頭を、当たった行にするため
 * (まとめた先頭の行を出すと、当たっていない話が出る)。1 行なら、その行。
 */
export function bestLine(unit: string, query: string): string {
  const lines = unit.split('\n').filter(Boolean);
  if (lines.length <= 1) return lines[0] ?? unit;
  const wanted = bigramsOf(query);
  let best = lines[0] as string;
  let top = -1;
  for (const line of lines) {
    let overlap = 0;
    for (const gram of bigramsOf(line)) if (wanted.has(gram)) overlap += 1;
    if (overlap > top) { top = overlap; best = line; }
  }
  return best;
}

/** 本文の見出し (入れ子は ' › ' でつないだ全体)。節を開くときの手がかり。 */
export function headingsOf(body: string): string[] {
  const stack: string[] = [];
  const out: string[] = [];
  for (const line of body.split('\n')) {
    const heading = HEADING.exec(line.trim());
    if (!heading) continue;
    const depth = (heading[1] ?? '#').length;
    stack.length = depth - 1;
    stack[depth - 1] = plainText(heading[2] ?? '');
    out.push(stack.filter(Boolean).join(' › '));
  }
  return out;
}

/** 埋め込む文: ページの名前と別名 + 節 + 1つの知識。ページ名が付くので、「誰の話か」が断片の中に残る。 */
export function chunkText(path: string, aliases: readonly string[], heading: string, text: string): string {
  const head = `${path || '記憶の根'}${aliases.length ? ` (${aliases.slice(0, 6).join(', ')})` : ''}`;
  return [head, `${heading ? `${heading}: ` : ''}${text.slice(0, 700)}`].join('\n');
}

const hashOf = (heading: string, text: string): string => createHash('sha1').update(heading).update('\n').update(text).digest('hex');

export interface ChunkSync { added: number; removed: number; kept: number }

/**
 * ページの本文から断片の表を作り直す。本文の書き直しで同じ文が残っていれば、その行 (id) を引き継ぐので、
 * ベクトルも振り直さない。無くなったページ・本文のあとから消えた文は消す。根 (全体の概要) は断片にしない。
 * 本文のあとに、まだ統合していない新しい知識 (pending) も断片にする (builder の次の回を待たずに引けるように)。
 */
export function syncChunks(guildId: string): ChunkSync {
  const db = memoryDb();
  const nodes = db.prepare<[string], { id: number; path: string; body: string; pending: string }>(
    "SELECT id, path, body, pending FROM nodes WHERE guild_id = ? AND path <> '' AND (body <> '' OR pending <> '')").all(guildId);
  const rows = db.prepare<[string], { id: number; node_id: number; hash: string }>('SELECT id, node_id, hash FROM memory_chunks WHERE guild_id = ?').all(guildId);
  const byNode = new Map<number, Map<string, number>>();
  for (const row of rows) {
    const map = byNode.get(row.node_id) ?? new Map<string, number>();
    map.set(row.hash, row.id);
    byNode.set(row.node_id, map);
  }

  const insert = db.prepare<[string, number, string, number, string, string, string, string]>(
    'INSERT INTO memory_chunks (guild_id, node_id, path, ord, heading, text, cites, hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  const update = db.prepare<[string, number, string, string, number]>('UPDATE memory_chunks SET path = ?, ord = ?, heading = ?, cites = ? WHERE id = ?');
  const remove = db.prepare<[number]>('DELETE FROM memory_chunks WHERE id = ?');
  const result: ChunkSync = { added: 0, removed: 0, kept: 0 };
  const size = chunkChars();

  db.transaction(() => {
    const live = new Set<number>();
    for (const node of nodes) {
      live.add(node.id);
      const have = byNode.get(node.id) ?? new Map<string, number>();
      const wanted = new Map<string, { piece: Piece; ord: number }>();
      const lines = [...splitPieces(node.body), ...splitPieces(node.pending, '新しい知識')];
      (size > 0 ? packPieces(lines, size) : lines).forEach((piece, ord) => {
        const hash = hashOf(piece.heading, piece.text);
        if (!wanted.has(hash)) wanted.set(hash, { piece, ord });
      });
      for (const [hash, id] of have) {
        if (wanted.has(hash)) continue;
        remove.run(id);
        result.removed += 1;
      }
      for (const [hash, { piece, ord }] of wanted) {
        const id = have.get(hash);
        if (id === undefined) {
          insert.run(guildId, node.id, node.path, ord, piece.heading, piece.text, JSON.stringify(piece.cites), hash);
          result.added += 1;
        } else {
          update.run(node.path, ord, piece.heading, JSON.stringify(piece.cites), id);
          result.kept += 1;
        }
      }
    }
    // ページが消えた・本文が空になったぶん
    for (const [nodeId, map] of byNode) {
      if (live.has(nodeId)) continue;
      for (const id of map.values()) { remove.run(id); result.removed += 1; }
    }
  })();
  return result;
}
