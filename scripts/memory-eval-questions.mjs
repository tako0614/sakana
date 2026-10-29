// 記憶の検索の評価用に、断片 (sample.jsonl) ごとに「短い自然な質問」を LLM で作る (Phase 0)。
//
//   OPENROUTER_API_KEY=… node scripts/memory-eval-questions.mjs sample.jsonl queries_b.jsonl
//
// 質問 B1: その知識で答えられる、Discord の人が bot に聞きそうな短い質問 (10〜35 字)。断片の特徴的な言い回しは写さない。
// 質問 B2: 状況や関係だけで指す、あいまいな聞き方 (人名・固有名を一部ぼかす)。
// 正解は、その断片 (gold = 断片の id)。deepseek-v4.1-flash-1017 (DeepInfra の fp8 を先に)。1 回 25 件。費用は全体で約 $0.03。
import { readFileSync, writeFileSync } from 'node:fs';

const [inputPath, outputPath] = process.argv.slice(2);
if (!inputPath || !outputPath) throw new Error('使い方: node scripts/memory-eval-questions.mjs <sample.jsonl> <queries_b.jsonl>');
const key = process.env.OPENROUTER_API_KEY;
if (!key) throw new Error('OPENROUTER_API_KEY が要る');
const items = readFileSync(inputPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line));

const SYSTEM = `あなたは検索の評価データを作る係です。Discord サーバーの「記憶」の 1 つの知識 (ページ名・節・本文) ごとに、その知識を引き出すための質問を 2 つ作ります。
- q1: Discord の人が bot に聞きそうな短い質問 (10〜35 字)。その知識だけで答えられる。本文の特徴的な言い回し・固有名の綴りをそのまま写さない (言い換える)。
- q2: あいまいな聞き方 (人名や固有名の一部を「あの人」「あれ」のようにぼかし、状況や関係で指す。15〜45 字)。それでも、その知識が一番の答えになる。
出力は JSON 配列だけ: [{"id": 番号, "q1": "…", "q2": "…"}, …] (入力の id をそのまま使う。入力と同じ件数)。`;

async function ask(batch) {
  const user = batch.map((item) => `id ${item.id} | ページ ${item.path}${item.heading ? ` › ${item.heading}` : ''}\n${item.text}`).join('\n\n');
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'deepseek/deepseek-v4.1-flash-1017', max_tokens: 6000, temperature: 0.3, reasoning: { effort: 'low' }, usage: { include: true },
        messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: user }],
        provider: { sort: 'price', require_parameters: true, allow_fallbacks: true, order: ['DeepInfra'], quantizations: ['fp8'] }
      })
    });
    const body = await response.json().catch(() => ({}));
    const text = body.choices?.[0]?.message?.content ?? '';
    const match = text.match(/\[[\s\S]*\]/);
    if (response.ok && match) {
      try { return { rows: JSON.parse(match[0]), cost: Number(body.usage?.cost ?? 0) }; } catch { /* 再試行 */ }
    }
    await new Promise((resolve) => setTimeout(resolve, 1500 * (attempt + 1)));
  }
  return { rows: [], cost: 0 };
}

const lines = [];
let cost = 0;
let missing = 0;
for (let i = 0; i < items.length; i += 25) {
  const batch = items.slice(i, i + 25);
  const { rows, cost: spent } = await ask(batch);
  cost += spent;
  const byId = new Map(rows.map((row) => [Number(row.id), row]));
  for (const item of batch) {
    const row = byId.get(item.id);
    if (!row?.q1 || !row?.q2) { missing += 1; continue; }
    lines.push(JSON.stringify({ gold: item.id, path: item.path, query: String(row.q1), kind: 'B1' }));
    lines.push(JSON.stringify({ gold: item.id, path: item.path, query: String(row.q2), kind: 'B2' }));
  }
  console.error(`${Math.min(items.length, i + 25)}/${items.length} cost $${cost.toFixed(4)} missing ${missing}`);
}
writeFileSync(outputPath, lines.join('\n') + '\n');
console.log(`wrote ${lines.length} queries (${missing} items missing), cost $${cost.toFixed(4)}`);
