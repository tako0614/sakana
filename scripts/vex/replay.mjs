// 実際の会話 (チャンネルの直近の発言) に、質問の基準を何通りか当てて比べる。
//   OPENROUTER_API_KEY=... node scripts/vex/replay.mjs --file live.json --sets api,about --yes-send-real-messages 1
// live.json は archive の messages から書き出した配列 (id, created_at, author_id, author_name, is_bot, content, reply_to)。
// 発言を判定モデルの提供元 (OpenRouter) に送るので、--yes-send-real-messages 1 が要る。出力は p が高かった発言の一覧。
import { readFileSync } from 'node:fs';
import { buildState, QUESTION_SETS } from './questions.mjs';

const args = Object.fromEntries(process.argv.slice(2).reduce((out, value, index, all) => (value.startsWith('--') ? [...out, [value.slice(2), all[index + 1]]] : out), []));
if (args['yes-send-real-messages'] !== '1') throw new Error('実際の発言を第三者に送るので、--yes-send-real-messages 1 が要る');
const key = process.env.OPENROUTER_API_KEY;
if (!key) throw new Error('OPENROUTER_API_KEY が要る');
const model = args.model ?? 'perplexity/pplx-decider-flash-v1.2';
const sets = (args.sets ?? 'api').split(',');
const idle = Number(args.idle ?? 0.25);
const messages = JSON.parse(readFileSync(args.file, 'utf8'));
const botId = messages.find((m) => m.is_bot)?.author_id;
const names = new Map(messages.map((m) => [m.author_id, m.author_name]));

const clean = (text) => String(text ?? '')
  .replace(/<@!?(\d+)>/g, (_, id) => (id === botId ? '@vex' : `@${names.get(id) ?? 'someone'}`))
  .replace(/https?:\/\/\S+/g, '<url>').replace(/\s*\n\s*/g, ' ⏎ ').trim();

const targets = [];
messages.forEach((m, index) => {
  if (m.is_bot || m.content.trim().length < 6) return;
  const window = messages.slice(Math.max(0, index - 5), index + 1);
  const now = m.created_at + idle * 60000;
  const lastBot = [...messages.slice(0, index + 1)].reverse().find((x) => x.is_bot);
  targets.push({
    index, id: m.id, text: `${m.author_name}: ${clean(m.content)}`.slice(0, 80),
    row: {
      recent: window.map((x) => ({ author: x.author_name, bot: Boolean(x.is_bot) && x.author_id !== botId, minutes_ago: (now - x.created_at) / 60000, text: clean(x.content) })),
      idle_minutes: idle, minutes_since_vex: lastBot ? (now - lastBot.created_at) / 60000 : null
    }
  });
});

async function ask(target, setName) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const response = await fetch('https://openrouter.ai/api/alpha/decisions', {
      method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model, state: { conversation: buildState(target.row, { messages: 6 }) }, questions: QUESTION_SETS[setName] })
    });
    if (response.ok) return (await response.json()).answers?.join?.noul;
    if (response.status === 429 || response.status >= 500) { await new Promise((resolve) => setTimeout(resolve, 800 * 2 ** attempt)); continue; }
    return null;
  }
  return null;
}

let next = 0;
await Promise.all(Array.from({ length: Number(args.concurrency ?? 6) }, async () => {
  while (next < targets.length) {
    const target = targets[next]; next += 1;
    target.p = {};
    for (const name of sets) target.p[name] = await ask(target, name);
  }
}));

for (const name of sets) {
  const ps = targets.map((t) => t.p[name]).filter((p) => typeof p === 'number');
  const share = (t) => `${(100 * ps.filter((p) => p >= t).length / ps.length).toFixed(0)}%`;
  console.log(`${name.padEnd(8)} n=${ps.length}  >=.3:${share(0.3)} >=.4:${share(0.4)} >=.5:${share(0.5)} >=.6:${share(0.6)} >=.7:${share(0.7)}`);
}
const bar = Number(args.show ?? 0.45);
console.log(`\n-- いずれかの基準で p >= ${bar} の発言 (${sets.join(' / ')}) --`);
for (const t of targets.filter((x) => sets.some((n) => (t => t.p[n] ?? 0)(x) >= bar)).sort((a, b) => Math.max(...sets.map((n) => b.p[n] ?? 0)) - Math.max(...sets.map((n) => a.p[n] ?? 0)))) {
  console.log(sets.map((n) => (t.p[n] ?? 0).toFixed(2)).join(' '), ' ', t.text);
}
