// 判定モデルの1件あたりの遅さを測る (質問文ごと)。
//   node scripts/vex/latency.mjs --url http://127.0.0.1:8081 --data situations.jsonl --n 8
import { readFileSync } from 'node:fs';
import { buildState, QUESTION_SETS } from './questions.mjs';

const args = Object.fromEntries(process.argv.slice(2).reduce((out, value, index, all) => (value.startsWith('--') ? [...out, [value.slice(2), all[index + 1]]] : out), []));
const url = `${args.url ?? 'http://127.0.0.1:8081'}/v1/systemone`;
const rows = readFileSync(args.data ?? 'situations.jsonl', 'utf8').trim().split('\n').map((line) => JSON.parse(line)).filter((row) => row.kind !== 'ack').slice(0, Number(args.n ?? 8));
const sets = (args.sets ?? 'min,rubric').split(',');
for (const name of sets) {
  const times = [], tokens = [];
  for (const row of rows) {
    const started = performance.now();
    const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ state: buildState(row, { header: args.header !== '0' }), questions: QUESTION_SETS[name] }) });
    const body = await response.json();
    times.push(performance.now() - started); tokens.push(body.usage?.input_tokens ?? 0);
  }
  const sorted = [...times].sort((a, b) => a - b);
  const avgTokens = Math.round(tokens.reduce((a, b) => a + b, 0) / tokens.length);
  console.log(`${name.padEnd(8)} n=${rows.length}  tokens/件 ${avgTokens}  p50 ${Math.round(sorted[Math.floor(sorted.length / 2)])}ms  max ${Math.round(sorted.at(-1))}ms  ${Math.round(avgTokens / (times.reduce((a, b) => a + b, 0) / times.length / 1000))} tok/s`);
}
