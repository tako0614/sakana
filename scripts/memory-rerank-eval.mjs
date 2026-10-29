// 再順位づけ (判定モデル jev) の効果を測る (Phase 0)。検索の候補 20 件を、依頼ごとに 1 回の呼び出しで採点する。
//
//   OPENROUTER_API_KEY=… node scripts/memory-rerank-eval.mjs cands.jsonl off.jsonl [N=300] [out.json]
//
// cands.jsonl: scripts/memory-retrieval-eval.py --rerank-out の出力 (質問と、融合した上位 20 件の断片)
// off.jsonl:   同 --off-out (記憶に関係ない質問と、その上位 20 件)
// 依頼を state にして、候補ごとに「この記憶は依頼に答える材料になるか」を noul の質問にする (候補 20 個 = 質問 20 個、1 回)。
// 出すもの: 順位の入れ替え (hit@1/3 の前後)・関係ある候補と無い候補のスコアの分離 (AUC)・閾値ごとの
//           「関係ある質問に 1 件以上残る率」「関係ない質問で何も出ない率」「1 質問あたりに残る関係の無い候補の数」。
import { readFileSync, writeFileSync } from 'node:fs';

const [candPath, offPath, nArg, outPath] = process.argv.slice(2);
if (!candPath || !offPath) throw new Error('使い方: memory-rerank-eval.mjs cands.jsonl off.jsonl [N] [out.json]');
const key = process.env.OPENROUTER_API_KEY;
if (!key) throw new Error('OPENROUTER_API_KEY が要る');
const N = Number(nArg || 300);
const MODELS = (process.env.EMOTION_MODELS || 'typesafe/jev-1.14,perplexity/pplx-decider-flash-v1.2').split(',');
const read = (path) => readFileSync(path, 'utf8').trim().split('\n').map((line) => JSON.parse(line));

const on = read(candPath).filter((row) => row.kind === 'B1' || row.kind === 'B2');
// 種類ごとに均等に N 件 (決まった間隔で取る)
const sample = [];
for (const kind of ['B1', 'B2']) {
  const list = on.filter((row) => row.kind === kind);
  const step = Math.max(1, Math.floor(list.length / (N / 2)));
  sample.push(...list.filter((_, i) => i % step === 0).slice(0, Math.floor(N / 2)));
}
const off = read(offPath);

const STYLE = process.env.RERANK_STYLE || 'loose';
const STYLES = {
  loose: (c) => ({
    instructions: `この依頼に答えたり、会話の材料にしたりするのに、次の記憶は役に立つか。記憶: 「${c.path}${c.heading ? ` › ${c.heading}` : ''}: ${String(c.text).slice(0, 180)}」`,
    criteria: { true: 'その記憶は依頼の内容に直接関係していて、返事の材料になる。', false: 'その記憶は依頼とは関係がない (言葉が似ているだけ)。' }
  }),
  strict: (c) => ({
    instructions: `この依頼は、次の記憶に書かれている具体的な人物・出来事・もの・話題について尋ねたり、触れたりしているか。記憶: 「${c.path}${c.heading ? ` › ${c.heading}` : ''}: ${String(c.text).slice(0, 180)}」`,
    criteria: { true: '依頼は、その記憶に書かれている具体的な人物・出来事・もの・話題を指している。', false: '依頼は、その記憶の具体的な人物・出来事・もの・話題を指していない (一般的な話・挨拶・別の話題)。' }
  })
};
const questionsOf = (row) => Object.fromEntries(row.candidates.map((c, i) => [`q${i}`, { type: 'noul', ...STYLES[STYLE](c) }]));

// 入口の門: 依頼そのものが「このサーバーの具体的な人・出来事・過去の話」に触れているか (記憶が要るか)
const GATE = { gate: { type: 'noul', instructions: 'この発言は、このコミュニティの具体的な人物・出来事・作ったもの・過去の話題・内輪のネタについて尋ねたり触れたりしているか。',
  criteria: { true: 'コミュニティの具体的な人・出来事・もの・過去の話に触れている。', false: '挨拶・雑談・一般的な知識の質問・独り言で、コミュニティの具体的な話には触れていない。' } } };
async function gateOf(text) {
  for (const model of MODELS) {
    try {
      const response = await fetch('https://openrouter.ai/api/alpha/decisions', {
        method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model, state: { text: text.slice(0, 1000) }, questions: GATE }), signal: AbortSignal.timeout(20000)
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const p = (await response.json()).answers?.gate?.noul;
      if (typeof p === 'number') return p;
    } catch { /* 次のモデル */ }
  }
  return null;
}

let cost = 0;
async function score(row) {
  const questions = questionsOf(row);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    for (const model of MODELS) {
      try {
        const response = await fetch('https://openrouter.ai/api/alpha/decisions', {
          method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
          body: JSON.stringify({ model, state: { text: row.query.slice(0, 1000) }, questions }), signal: AbortSignal.timeout(20000)
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const body = await response.json();
        const probs = row.candidates.map((_, i) => body.answers?.[`q${i}`]?.noul);
        if (probs.some((p) => typeof p !== 'number')) throw new Error('missing probability');
        return { probs, model };
      } catch (error) {
        if (attempt === 2 && model === MODELS.at(-1)) return { probs: null, error: String(error) };
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 1500 * (attempt + 1)));
  }
  return { probs: null };
}

async function pool(rows, width) {
  const out = new Array(rows.length);
  let next = 0;
  await Promise.all(Array.from({ length: width }, async () => {
    for (let i = next++; i < rows.length; i = next++) out[i] = await score(rows[i]);
  }));
  return out;
}

const started = Date.now();
const gateOn = [];
const gateOff = [];
{
  let next = 0;
  const all = [...sample.map((r) => ({ r, on: true })), ...off.map((r) => ({ r, on: false }))];
  await Promise.all(Array.from({ length: 8 }, async () => {
    for (let i = next++; i < all.length; i = next++) { const p = await gateOf(all[i].r.query); if (p !== null) (all[i].on ? gateOn : gateOff).push([all[i].r.query, p]); }
  }));
}
const onScores = await pool(sample, 8);
const offScores = await pool(off, 8);
console.error(`scored ${sample.length} + ${off.length} in ${((Date.now() - started) / 1000).toFixed(0)}s, failures ${[...onScores, ...offScores].filter((s) => !s.probs).length}`);

const relevant = (row, c) => c.path === row.path;   // 寛容: 正解と同じページ
const strict = (row, c) => c.id === row.gold;
const hit = (order, row, k, pred) => order.slice(0, k).some((i) => pred(row, row.candidates[i])) ? 1 : 0;
const rows = sample.map((row, i) => ({ row, p: onScores[i].probs })).filter((x) => x.p);
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const report = { n: rows.length, models: [...new Set(onScores.map((s) => s.model))] };
for (const [name, pred] of [['strict', strict], ['page', relevant]]) {
  const base = rows.map(({ row }) => row.candidates.map((_, i) => i));
  const re = rows.map(({ row, p }) => row.candidates.map((_, i) => i).sort((a, b) => p[b] - p[a]));
  report[name] = {
    before: [1, 3, 10].map((k) => Math.round(1000 * mean(rows.map(({ row }, j) => hit(base[j], row, k, pred)))) / 10),
    after: [1, 3, 10].map((k) => Math.round(1000 * mean(rows.map(({ row }, j) => hit(re[j], row, k, pred)))) / 10)
  };
}
// 関係ある候補 (同じページ) と無い候補のスコアの分離
const pos = rows.flatMap(({ row, p }) => row.candidates.map((c, i) => (relevant(row, c) ? p[i] : null)).filter((x) => x !== null));
const neg = rows.flatMap(({ row, p }) => row.candidates.map((c, i) => (relevant(row, c) ? null : p[i])).filter((x) => x !== null));
let wins = 0;
const sortedNeg = [...neg].sort((a, b) => a - b);
for (const x of pos) {
  let lo = 0; let hi = sortedNeg.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (sortedNeg[mid] < x) lo = mid + 1; else hi = mid; }
  wins += lo / sortedNeg.length;
}
report.auc = Math.round(1000 * wins / pos.length) / 1000;
report.pos_mean = Math.round(1000 * mean(pos)) / 1000;
report.neg_mean = Math.round(1000 * mean(neg)) / 1000;
// 閾値ごと
report.thresholds = [0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9].map((t) => {
  const kept = rows.map(({ row, p }) => row.candidates.filter((c, i) => p[i] >= t && true));
  const offOk = offScores.filter((s) => s.probs);
  return {
    t,
    on_has_relevant: Math.round(1000 * mean(rows.map(({ row, p }) => (row.candidates.some((c, i) => p[i] >= t && relevant(row, c)) ? 1 : 0)))) / 10,
    on_has_gold: Math.round(1000 * mean(rows.map(({ row, p }) => (row.candidates.some((c, i) => p[i] >= t && strict(row, c)) ? 1 : 0)))) / 10,
    on_noise_per_query: Math.round(10 * mean(rows.map(({ row, p }, j) => kept[j].filter((c) => !relevant(row, c)).length))) / 10,
    on_kept_per_query: Math.round(10 * mean(kept.map((k) => k.length))) / 10,
    off_silent: Math.round(1000 * mean(offOk.map((s) => (s.probs.every((x) => x < t) ? 1 : 0)))) / 10,
    off_kept_per_query: Math.round(10 * mean(offOk.map((s) => s.probs.filter((x) => x >= t).length))) / 10
  };
});
const meanOf = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
report.gate = {
  on_mean: Math.round(1000 * meanOf(gateOn.map((x) => x[1]))) / 1000, off_mean: Math.round(1000 * meanOf(gateOff.map((x) => x[1]))) / 1000,
  thresholds: [0.2, 0.3, 0.4, 0.5, 0.6, 0.7].map((t) => ({ t, on_pass: Math.round(1000 * gateOn.filter((x) => x[1] >= t).length / gateOn.length) / 10, off_pass: Math.round(1000 * gateOff.filter((x) => x[1] >= t).length / gateOff.length) / 10 })),
  b1_pass_at_05: Math.round(1000 * sample.map((r, i) => [r, gateOn[i]]).filter(([r]) => r.kind === 'B1').length) / 1000,
  off_high: gateOff.sort((a, b) => b[1] - a[1]).slice(0, 6), on_low: gateOn.sort((a, b) => a[1] - b[1]).slice(0, 6)
};
report.style = STYLE;
report.off_top = off.map((o, i) => (offScores[i].probs ? [o.query, Math.round(1000 * Math.max(...offScores[i].probs)) / 1000] : null)).filter(Boolean).sort((a, b) => b[1] - a[1]).slice(0, 8);
console.log(JSON.stringify(report, null, 1));
if (outPath) writeFileSync(outPath, JSON.stringify({ report, sample: sample.map((row, i) => ({ query: row.query, kind: row.kind, gold: row.gold, probs: onScores[i].probs })), off: off.map((o, i) => ({ query: o.query, probs: offScores[i].probs })) }));
void cost;
