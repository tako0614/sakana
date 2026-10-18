// 想起の単位の評価 (読み取りのみ。記憶 DB は丸ごとコピーして使う)。
//   ページ単位 (いまのページのベクトル) と、本文を割った単位 (1行ずつ / 同じ節の行を何字までまとめるか) とを、同じ質問で比べる。
//
//   cd /root/sakana && set -a && . ./.env && set +a    # 本番 (埋め込みの Python は作業ディレクトリからの相対パス)
//   EVAL_PACKS=0,300,600 nice -n 10 node --import <release>/node_modules/tsx/dist/loader.mjs <release>/scripts/memory-chunks-eval.ts
//
// EVAL_PACKS: 比べる単位の字数 (カンマ区切り)。0 は 1 行ずつ、300 は「同じ節の隣り合う行を 300 字まで」。
// 評価1: 各知識の出典の出来事 (題名 + 要約) を「別の言い方の質問」にして、その知識を引けるか。
//        ページを引けるか (hit@k) と、その知識を含む単位そのものを引けるか (正解の行を含む単位が上位 k 位に入るか)。
//        本文の頭 500 字の中 / それより後ろ、で分ける (ページ単位のベクトルは頭の 500 字しか見ない)。
//        あわせて、1 位のスコア帯ごとの正解率 (閾値を決める材料)。
// 評価2: 実際の発言 (環境変数 EVAL_CHANNEL のチャンネルの最近のもの) 300 件で、1 位のスコアが閾値以上の割合。
//        実際の発言を読むので、手元に出すだけ (どこにも送らない)。
//
// MEMORY_DB_PATH / ARCHIVE_DB_PATH を向ける。GUILD は EVAL_GUILD (既定: Evex)。
import Database from 'better-sqlite3';
import { embedTexts } from '../src/embed/worker.js';
import { chunkText, packPieces, plainText, splitPieces, type Piece } from '../src/memory/chunks.js';

const G = process.env.EVAL_GUILD ?? '1255359848644608035';
const CHANNEL = process.env.EVAL_CHANNEL ?? '1437420093259907175';
const PACKS = (process.env.EVAL_PACKS ?? '0,300,600').split(',').map((value) => Number(value.trim()));
const COPY = '/tmp/mem-eval.sqlite';
await new Database(process.env.MEMORY_DB_PATH as string, { readonly: true }).backup(COPY);
const db = new Database(COPY, { readonly: true });
const archive = new Database(process.env.ARCHIVE_DB_PATH as string, { readonly: true });

const decode = (b64: string): Float32Array => {
  const bytes = Buffer.from(b64, 'base64');
  const v = new Float32Array(bytes.byteLength / 4);
  new Uint8Array(v.buffer).set(bytes);
  let n = 0; for (const x of v) n += x * x; n = Math.sqrt(n) || 1;
  return v.map((x) => x / n);
};
async function embed(texts: string[], kind: 'passage' | 'query', label: string, batch = 32): Promise<Float32Array[]> {
  const out: Float32Array[] = [];
  for (let i = 0; i < texts.length; i += batch) {
    const reply = await embedTexts(texts.slice(i, i + batch), { kind, encode: 'float32' });
    out.push(...reply.vectors.map(decode));
    if ((i / batch) % 60 === 0) console.error(`  [${label}] embedded ${Math.min(texts.length, i + batch)}/${texts.length}`);
  }
  return out;
}

// ---- 本文を割る (実装と同じ関数) ------------------------------------------------------
interface Node { id: number; path: string; body: string; pending: string; aliases: string[] }
const nodes: Node[] = db.prepare<[string], { id: number; path: string; body: string; pending: string; aliases: string }>(
  "SELECT id, path, body, pending, aliases FROM nodes WHERE guild_id = ? AND path <> '' AND (body <> '' OR pending <> '')").all(G)
  .map((row) => { let aliases: string[] = []; try { aliases = JSON.parse(row.aliases) as string[]; } catch { /* 別名なし */ } return { ...row, aliases }; });
const linePieces = new Map<number, Piece[]>(nodes.map((node) => [node.id, [...splitPieces(node.body), ...splitPieces(node.pending, '新しい知識')]]));

interface Unit { path: string; text: string; text4embed: string }
const unitsFor = (pack: number): Unit[] => nodes.flatMap((node) => {
  const pieces = linePieces.get(node.id) ?? [];
  return (pack > 0 ? packPieces(pieces, pack) : pieces).map((piece) => ({ path: node.path, text: piece.text, text4embed: chunkText(node.path, node.aliases, piece.heading, piece.text) }));
});

// ---- 評価の問い (出典の出来事 → その知識) ---------------------------------------------
const episodes = new Map(db.prepare<[string], { id: number; title: string; summary: string }>('SELECT id, title, summary FROM episodes WHERE guild_id = ?').all(G).map((e) => [e.id, e]));
interface Case { path: string; gold: string; query: string; tail: boolean }
const cases: Case[] = [];
let seed = 7; const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
const candidates = nodes.flatMap((node) => {
  let cursor = 0;
  return (linePieces.get(node.id) ?? []).map((piece) => {
    const at = node.body.indexOf(piece.text.slice(0, 12), cursor);
    if (at >= 0) cursor = at;
    return { node, piece, offset: Math.max(0, at) };
  });
});
for (const { node, piece, offset } of candidates.sort(() => rnd() - 0.5)) {
  if (!node.path.includes('/') || piece.cites.length === 0 || piece.heading === '新しい知識') continue;
  const ep = episodes.get(piece.cites[0]!); if (!ep) continue;
  const tail = offset > 500;
  if (cases.filter((c) => c.tail === tail).length >= 400) { if (cases.length >= 800) break; continue; }
  cases.push({ path: node.path, gold: piece.text, query: `${ep.title}\n${plainText(ep.summary).slice(0, 150)}`, tail });
}
const qvecs = await embed(cases.map((c) => c.query), 'query', 'questions');
const messages = archive.prepare<[string, number], { content: string }>(
  `SELECT content FROM messages WHERE channel_id = ? AND is_bot = 0 AND created_at > ? AND length(content) BETWEEN 20 AND 160 AND content NOT LIKE 'http%' AND content NOT LIKE '<@%' ORDER BY RANDOM() LIMIT 300`)
  .all(CHANNEL, Date.now() - 4 * 86_400_000);
const mvecs = messages.length ? await embed(messages.map((m) => m.content), 'query', 'messages') : [];

// ---- 道具 ---------------------------------------------------------------------------
const pageVecs = db.prepare<[string], { id: number; vec: Buffer }>("SELECT id, vec FROM memory_vectors WHERE guild_id = ? AND kind = 'node'").all(G)
  .map((r) => ({ id: r.id, vec: new Float32Array(r.vec.buffer.slice(r.vec.byteOffset, r.vec.byteOffset + r.vec.byteLength)) }));
const pathOf = new Map(db.prepare<[string], { id: number; path: string }>('SELECT id, path FROM nodes WHERE guild_id = ?').all(G).map((n) => [n.id, n.path]));
const dim = qvecs[0]!.length;
const dot = (a: Float32Array, b: Float32Array) => { let s = 0; for (let i = 0; i < dim; i += 1) s += a[i]! * b[i]!; return s; };
const pct = (n: number, d: number) => Math.round(100 * n / Math.max(1, d));
const rankIn = (list: string[], path: string) => { const r = list.indexOf(path); return r < 0 ? 999 : r + 1; };
const pagesByScore = (q: Float32Array) => pageVecs.map((p) => ({ path: pathOf.get(p.id) ?? '', score: dot(p.vec, q) })).filter((x) => x.path).sort((a, b) => b.score - a.score);
const buckets = [[0, 0.84], [0.84, 0.86], [0.86, 0.87], [0.87, 0.88], [0.88, 0.89], [0.89, 0.90], [0.90, 1.01]] as const;

console.log(`## 評価1: 出典の出来事の題名と要約を質問にして、その知識を引けるか (n=${cases.length}: 本文の頭 500 字の中 ${cases.filter((c) => !c.tail).length} / 500 字より後ろ ${cases.filter((c) => c.tail).length})`);
const baseline = qvecs.map((q) => pagesByScore(q).map((x) => x.path));
const line = (label: string, rank: (i: number) => number, sel: (c: Case) => boolean) => {
  const rows = cases.map((c, i) => ({ c, i })).filter(({ c }) => sel(c));
  const at = (k: number) => pct(rows.filter(({ i }) => rank(i) <= k).length, rows.length);
  return `${label} ${at(1)}/${at(3)}/${at(10)}%`;
};
const groups: [string, (c: Case) => boolean][] = [['頭 500 字の中', (c) => !c.tail], ['500 字より後ろ', (c) => c.tail], ['全部', () => true]];
console.log('(ページを引けるか hit@1/3/10)');
for (const [name, sel] of groups) console.log(`  ${name}: ${line('ページ単位', (i) => rankIn(baseline[i]!, cases[i]!.path), sel)}`);

const tops = new Map<number, { mean: number; hits: Record<string, number>; best: number[] }>();
for (const pack of PACKS) {
  const units = unitsFor(pack);
  const label = pack > 0 ? `まとめ${pack}字` : '1行ずつ';
  const started = Date.now();
  const vecs = await embed(units.map((u) => u.text4embed), 'passage', label);
  const mean = Math.round(units.reduce((total, u) => total + u.text.length, 0) / units.length);
  console.log(`\n### ${label}: 単位 ${units.length} 個 (平均 ${mean} 字、埋め込み ${Math.round((Date.now() - started) / 1000)} 秒)`);
  const scoreAll = (q: Float32Array) => vecs.map((v, i) => ({ i, score: dot(v, q) })).sort((a, b) => b.score - a.score);
  const ranked = qvecs.map((q) => scoreAll(q));
  const pageRank = ranked.map((list) => { const seen = new Set<string>(); const paths: string[] = []; for (const { i } of list) { const p = units[i]!.path; if (!seen.has(p)) { seen.add(p); paths.push(p); } } return paths; });
  const exactRank = ranked.map((list, c) => { const r = list.slice(0, 10).findIndex(({ i }) => units[i]!.path === cases[c]!.path && units[i]!.text.includes(cases[c]!.gold)); return r < 0 ? 999 : r + 1; });
  console.log('(ページを引けるか / 正解の知識を含む単位を引けるか  hit@1/3/10)');
  for (const [name, sel] of groups) console.log(`  ${name}: ${line('ページ', (i) => rankIn(pageRank[i]!, cases[i]!.path), sel)}   ${line('その知識を含む単位', (i) => exactRank[i]!, sel)}`);
  console.log('(1位のスコア帯ごとの「1位のページが正解」の割合)');
  console.log('  ' + buckets.map(([lo, hi]) => {
    const rows = ranked.map((list, c) => ({ c, top: list[0]! })).filter(({ top }) => top.score >= lo && top.score < hi);
    return `${lo.toFixed(2)}〜${hi.toFixed(2)}: n=${rows.length} ${pct(rows.filter(({ c, top }) => units[top.i]!.path === cases[c]!.path).length, rows.length)}%`;
  }).join(' | '));
  if (mvecs.length) {
    const best = mvecs.map((q) => scoreAll(q)[0]!.score);
    tops.set(pack, { mean, hits: {}, best });
    console.log('(実際の発言 300 件で、1位のスコアが閾値以上の割合) ' + [0.85, 0.86, 0.87, 0.88, 0.89, 0.90].map((t) => `≥${t}: ${pct(best.filter((s) => s >= t).length, best.length)}%`).join('  '));
    if (pack === PACKS[Math.min(1, PACKS.length - 1)]) {
      console.log('(上位の例)');
      for (const m of [...messages.keys()].sort(() => rnd() - 0.5).slice(0, 8)) {
        const top = scoreAll(mvecs[m]!).slice(0, 2);
        console.log(`  発言: ${messages[m]!.content.replace(/\n/g, ' ').slice(0, 80)}`);
        for (const h of top) console.log(`    ${h.score.toFixed(3)} [[${units[h.i]!.path}]] ${units[h.i]!.text.replace(/\n/g, ' / ').slice(0, 90)}`);
      }
    }
  }
}
const pagesTop = mvecs.map((q) => pagesByScore(q)[0]?.score ?? 0);
if (pagesTop.length) console.log('\n(参考) ページ単位の 1 位が閾値以上の割合: ' + [0.85, 0.86, 0.87, 0.88, 0.89, 0.90].map((t) => `≥${t}: ${pct(pagesTop.filter((s) => s >= t).length, pagesTop.length)}%`).join('  '));
process.exit(0);
