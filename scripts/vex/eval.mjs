// 判定モデルの評価 (llama-server の /v1/systemone を叩く)。
//
//   node scripts/vex/eval.mjs --url http://127.0.0.1:8081 --data situations.jsonl --set rubric [--limit 600] [--out results.jsonl]
//
// 出力: 遅さ (p50 / p95)・弱ラベルに対する AUC と最良の閾値・種類ごとの平均確率・暗黙の「入る」と会話の続きの分離。
import { readFileSync, writeFileSync } from 'node:fs';
import { buildState, QUESTION_SETS } from './questions.mjs';

const args = Object.fromEntries(process.argv.slice(2).reduce((out, value, index, all) => (value.startsWith('--') ? [...out, [value.slice(2), all[index + 1]]] : out), []));
const url = `${args.url ?? 'http://127.0.0.1:8081'}/v1/systemone`;
const set = QUESTION_SETS[args.set ?? 'rubric'];
if (!set) throw new Error(`unknown set: ${args.set}`);
// 相槌・スタンプだけの発言は、bot の門 (src/agent/ack.ts の isBareAck) で先に落とすので、判定モデルの評価には入れない (--ack 1 で入れる)
const rows = args.from ? [] : readFileSync(args.data ?? 'situations.jsonl', 'utf8').trim().split('\n').map((line) => JSON.parse(line))
  .filter((row) => args.ack === '1' || row.kind !== 'ack').slice(0, Number(args.limit ?? 1e9));
const header = args.header !== '0';

async function ask(situation) {
  const started = performance.now();
  const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ state: buildState(situation, { header }), questions: set }) });
  const ms = performance.now() - started;
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`);
  const body = await response.json();
  return { p: body.answers?.join?.noul ?? null, ms, tokens: body.usage?.input_tokens ?? 0, answers: body.answers };
}

let results = [];
if (args.from) {
  // 保存した結果から数字だけ出し直す (サーバーは叩かない)
  results = readFileSync(args.from, 'utf8').trim().split('\n').map((line) => JSON.parse(line)).filter((row) => args.ack === '1' || row.kind !== 'ack');
} else {
  for (const [index, situation] of rows.entries()) {
    try { results.push({ id: situation.id, kind: situation.kind, join: situation.join, ...(await ask(situation)) }); }
    catch (error) { console.error(`#${index} ${error.message}`); }
    if ((index + 1) % 100 === 0) console.error(`${index + 1}/${rows.length}`);
  }
  if (args.out) writeFileSync(args.out, results.map((entry) => JSON.stringify(entry)).join('\n'));
}

const percentile = (values, q) => { const sorted = [...values].sort((a, b) => a - b); return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]; };
function auc(items) {  // Mann-Whitney
  const pos = items.filter((item) => item.join === 1), neg = items.filter((item) => item.join === 0);
  if (!pos.length || !neg.length) return NaN;
  let wins = 0;
  for (const a of pos) for (const b of neg) wins += a.p > b.p ? 1 : a.p === b.p ? 0.5 : 0;
  return wins / (pos.length * neg.length);
}
function bestThreshold(items) {
  let best = { f1: -1 };
  for (const threshold of [...new Set(items.map((item) => item.p))].sort((a, b) => a - b)) {
    const tp = items.filter((item) => item.p >= threshold && item.join === 1).length;
    const fp = items.filter((item) => item.p >= threshold && item.join === 0).length;
    const fn = items.filter((item) => item.p < threshold && item.join === 1).length;
    const precision = tp / Math.max(1, tp + fp), recall = tp / Math.max(1, tp + fn);
    const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
    if (f1 > best.f1) best = { f1, threshold, precision, recall };
  }
  return best;
}
function precisionAtRecall(items, target = 0.5) {
  const pos = items.filter((item) => item.join === 1).length;
  const sorted = [...items].sort((a, b) => b.p - a.p);
  let tp = 0;
  for (const [index, item] of sorted.entries()) { if (item.join === 1) tp += 1; if (tp / pos >= target) return tp / (index + 1); }
  return 0;
}
const mean = (values) => values.reduce((a, b) => a + b, 0) / Math.max(1, values.length);
if (args.show === '1') for (const entry of results) console.log(`${entry.kind.padEnd(13)} ${String(entry.id).padEnd(12)} p=${typeof entry.p === 'number' ? entry.p.toFixed(3) : 'n/a'} ${entry.ms ? Math.round(entry.ms) + 'ms' : ''}`);
const valid = results.filter((entry) => typeof entry.p === 'number' && entry.join !== null);
const kinds = [...new Set(valid.map((entry) => entry.kind))];
const hard = valid.filter((entry) => entry.kind === 'implicit' || entry.kind === 'active' || entry.kind.startsWith('sanity'));
const best = bestThreshold(valid);
console.log(JSON.stringify({
  set: args.set ?? 'rubric', header, n: valid.length, errors: (args.from ? results.length : rows.length) - valid.length,
  latencyMs: { p50: Math.round(percentile(valid.map((entry) => entry.ms), 0.5)), p95: Math.round(percentile(valid.map((entry) => entry.ms), 0.95)), mean: Math.round(mean(valid.map((entry) => entry.ms))) },
  inputTokens: Math.round(mean(valid.map((entry) => entry.tokens))),
  auc: Number(auc(valid).toFixed(3)), aucHard_implicit_vs_active: Number(auc(hard).toFixed(3)),
  best: { threshold: Number(best.threshold?.toFixed(3)), precision: Number(best.precision?.toFixed(3)), recall: Number(best.recall?.toFixed(3)), f1: Number(best.f1?.toFixed(3)) },
  precisionAtRecall50: Number(precisionAtRecall(valid).toFixed(3)),
  meanProbByKind: Object.fromEntries(kinds.map((kind) => [kind, Number(mean(valid.filter((entry) => entry.kind === kind).map((entry) => entry.p)).toFixed(3))]))
}, null, 1));
