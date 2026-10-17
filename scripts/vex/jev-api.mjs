// OpenRouter 経由の Jev (typesafe/jev-1.13) で、同じ場面・同じ質問を評価する (eval.mjs の API 版)。
//   OPENROUTER_API_KEY=... node scripts/vex/jev-api.mjs --data sanity.jsonl --set short --show 1
// 本物の発言を第三者 (TypeSafe) に送ることになるので、既定では手書きの sanity.jsonl だけ。situations.jsonl は --yes-send-real-messages 1 のときだけ。
import { readFileSync } from 'node:fs';
import { buildState, QUESTION_SETS } from './questions.mjs';

const args = Object.fromEntries(process.argv.slice(2).reduce((out, value, index, all) => (value.startsWith('--') ? [...out, [value.slice(2), all[index + 1]]] : out), []));
const dataPath = args.data ?? 'sanity.jsonl';
if (!/sanity/.test(dataPath) && args['yes-send-real-messages'] !== '1') throw new Error('実際の発言を第三者に送るので、--yes-send-real-messages 1 が要る');
const key = process.env.OPENROUTER_API_KEY;
if (!key) throw new Error('OPENROUTER_API_KEY が要る');
const model = args.model ?? 'typesafe/jev-1.13';
const set = QUESTION_SETS[args.set ?? 'short'];
const rows = readFileSync(dataPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line)).slice(0, Number(args.limit ?? 1e9));

// noul は criteria (true/false の説明) つきの形にする (質問が持っていればそれを、無ければ汎用の説明)
const asApi = (questions) => Object.fromEntries(Object.entries(questions).map(([name, q]) => [name, q.type === 'noul'
  ? { type: 'noul', instructions: q.instructions, criteria: q.criteria ?? { true: 'はい。vex が返事をすると歓迎されて役に立つ。', false: 'いいえ。返事は要らない・邪魔になる。' } }
  : q]));
const messages = Number(args.messages ?? 6);
const concurrency = Number(args.concurrency ?? 1);

async function call(row) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const started = performance.now();
    const response = await fetch('https://openrouter.ai/api/alpha/decisions', {
      method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model, state: { conversation: buildState(row, { messages }) }, questions: asApi(set) })
    });
    const ms = performance.now() - started;
    const body = await response.json().catch(() => ({}));
    if (response.ok) return { ms, body };
    if (response.status === 429 || response.status >= 500) { await new Promise((resolve) => setTimeout(resolve, 800 * 2 ** attempt)); continue; }
    return { error: `HTTP ${response.status} ${JSON.stringify(body).slice(0, 160)}` };
  }
  return { error: 'retries exhausted' };
}

let cost = 0;
const times = [];
const out = new Array(rows.length).fill(null);
let next = 0;
async function worker() {
  while (next < rows.length) {
    const index = next; next += 1;
    const row = rows[index];
    const result = await call(row);
    if (result.error) { console.error(`${row.id}: ${result.error}`); continue; }
    times.push(result.ms); cost += Number(result.body.usage?.cost ?? 0);
    const p = result.body.answers?.join?.noul;
    out[index] = { id: row.id, kind: row.kind, join: row.join, p, ms: result.ms, tokens: result.body.usage?.input_tokens };
    if (args.show === '1') console.log(`${String(row.kind).padEnd(13)} ${String(row.id).padEnd(12)} p=${typeof p === 'number' ? p.toFixed(3) : 'n/a'} ${Math.round(result.ms)}ms`);
  }
}
await Promise.all(Array.from({ length: concurrency }, worker));
const done = out.filter(Boolean);
out.length = 0; out.push(...done);
const sorted = [...times].sort((a, b) => a - b);
const labeled = out.filter((entry) => entry.join !== null && typeof entry.p === 'number');
const pos = labeled.filter((entry) => entry.join === 1), neg = labeled.filter((entry) => entry.join === 0);
let wins = 0;
for (const a of pos) for (const b of neg) wins += a.p > b.p ? 1 : a.p === b.p ? 0.5 : 0;
const mean = (items) => (items.reduce((total, entry) => total + entry.p, 0) / Math.max(1, items.length));
console.error(JSON.stringify({
  model, n: out.length, auc: pos.length && neg.length ? Number((wins / (pos.length * neg.length)).toFixed(3)) : null,
  meanYes: Number(mean(pos).toFixed(2)), meanNo: Number(mean(neg).toFixed(2)),
  latencyMs: { p50: Math.round(sorted[Math.floor(sorted.length / 2)] ?? 0), max: Math.round(sorted.at(-1) ?? 0) }, costUsd: Number(cost.toFixed(6))
}));
if (args.out) (await import('node:fs')).writeFileSync(args.out, out.map((entry) => JSON.stringify(entry)).join('\n'));
