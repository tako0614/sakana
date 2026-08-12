// 素の日本語形式 (evex-ft-1) の「なりきり」が実際に効いているか測る。
//
//   node scripts/llm/probe-ft.mjs [1人あたりの回数]
//
// probe-mimic.mjs は evex-1 の話者トークン用で、あちらは speakers.json が要る。
// こちらは labels.json + 実発言の2経路を持つ evex-ft-1 用。**bot サーバーで走らせる**
// (推論サーバー 8766 と archive の DB があるのはあちらだけ)。
//
// 見るのは4つ。どれも出力を読まないと分からない — 形がずれていても例外は出ず、
// 静かに崩れるだけだから (evex-1 に <|a|> を渡して実際に壊した)。
//
//   1. 名前持ち (147人) で how が 'label' になり、人ごとに違うものが出るか
//   2. 名前無しで how が 'examples' になり、例を渡したぶんの調子が乗るか
//   3. 空返答の率     … 3回引いても3文字未満だったもの
//   4. 逐語コピーの率 … その人の実発言と完全一致したもの (覚えただけなら意味がない)

import { db as archive } from '../../src/archive/db.js';
import { continuationOf, endpointFor, generate, status } from '../../src/mimic/client.js';
import { impersonate } from '../../src/mimic/impersonate.js';
import { isUnusableReply, labelFor, labelledSpeakers } from '../../src/mimic/plain.js';
import { buildMimicPrompt } from '../../src/mimic/respond.js';
import { hasOptedOut } from '../../src/mimic/speakers.js';

const ENGINE = 'evex-ft';
const times = Number(process.argv[2] ?? 2);
const config = endpointFor(ENGINE);

const health = await status(ENGINE);
if (!health.up) {
  console.error(`推論サーバーが起動していません (${config.url})`);
  process.exit(1);
}

console.log(`${config.url} / ${health.label} / epoch ${health.epoch} / val ${health.val_loss?.toFixed?.(4)}`);
console.log(`申告された形式: ${health.format} / 手元のラベル: ${labelledSpeakers().length} 人\n`);

if (health.format !== 'plain') {
  console.error(`このスクリプトは素の日本語形式のみ。申告は ${health.format}`);
  process.exit(1);
}

// 名前持ちは件数の多い順に。学習量が多い人ほど濃く出るはずなので、
// 効いていないときに「量の問題」と言い逃れできない上位から見る
const named = labelledSpeakers()
  .filter((row) => !hasOptedOut(row.userId))
  .slice(0, 3);

// 名前無しは「例が取れる程度に喋っているが 147人には入っていない人」を探す。
// 例が2件も取れない人だと examples 経路そのものが動かず、測りたいものが測れない
const unnamed = archive.prepare(`
  SELECT author_id, author_name, COUNT(*) n
    FROM messages
   WHERE deleted = 0 AND is_bot = 0 AND LENGTH(content) >= 4
   GROUP BY author_id
  HAVING n >= 20
   ORDER BY n DESC
   LIMIT 400
`).all()
  .filter((row) => !labelFor(row.author_id) && !hasOptedOut(row.author_id))
  .slice(0, 3)
  .map((row) => ({ userId: String(row.author_id), name: row.author_name, count: row.n }));

// 逐語コピーの判定。その人の実発言と完全一致したら「覚えただけ」
const ownSaid = archive.prepare(`
  SELECT 1 FROM messages
   WHERE author_id = @author_id AND deleted = 0 AND TRIM(content) = @text
   LIMIT 1
`);
const isVerbatim = (userId, text) => {
  try {
    return Boolean(ownSaid.get({ author_id: String(userId), text }));
  } catch {
    return false;
  }
};

const topics = [null, 'これバグってる？'];
const tally = { total: 0, empty: 0, verbatim: 0, how: new Map() };

async function probe(group, people) {
  console.log(`--- ${group} (${people.length}人)`);
  for (const person of people) {
    const label = labelFor(person.userId);
    console.log(`\n${person.name} / ${(person.count ?? 0).toLocaleString('en-US')}件 / ラベル ${label ?? '(無し)'}`);

    for (const topic of topics) {
      for (let i = 0; i < times; i += 1) {
        const { text, how } = await impersonate(person.userId, {
          topic, channelId: null, askerId: null, engine: ENGINE
        });

        tally.total += 1;
        tally.how.set(how, (tally.how.get(how) ?? 0) + 1);
        if (!text) tally.empty += 1;

        const copied = text ? isVerbatim(person.userId, text) : false;
        if (copied) tally.verbatim += 1;

        const head = topic ? `「${topic}」→ ` : '(お題なし) ';
        console.log(`  ${head}${JSON.stringify(text)} [${how}${copied ? ' / 逐語コピー' : ''}]`);
      }
    }
  }
  console.log('');
}

await probe('名前持ち (重みに口調が入っている)', named);
await probe('名前無し (実発言を例に渡す)', unnamed);

// --- /as の経路 ---
//
// /mimic (impersonate.js) と別物。あちらはお題だけを渡すが、/as はチャンネルの
// 会話を並べた末尾に人格のラベルを置く。同じラベルでも前に何が並んでいるかで出る
// ものが変わるので、/mimic が動いていても /as が効いているとは限らない。
{
  console.log('--- /as (会話の続きを人格で書く)');

  // 会話は誰でもいい。名前持ち2人のやり取りにして、学習データと同じ形にする
  const [a, b] = named;
  const messages = [
    { authorId: b?.userId, content: 'これ動かんのやけど', isReply: false },
    { authorId: a?.userId, content: 'どこで止まってる？', isReply: false },
    { authorId: b?.userId, content: 'ビルドのとこ', isReply: true }
  ].filter((turn) => turn.authorId);

  for (const person of named) {
    const built = await buildMimicPrompt(messages, {
      wanted: person.userId, engine: ENGINE, channelId: null
    });

    if (!built.as) {
      console.error(`  ${person.name}: 人格が乗っていない (as が null)`);
      process.exitCode = 1;
      continue;
    }

    // 末尾がその人のラベルで終わっていないと、続きは別人として書かれる
    if (!built.prompt.endsWith(`\n${built.as}:`)) {
      console.error(`  ${person.name}: 末尾がラベルで終わっていない`);
      process.exitCode = 1;
    }

    for (let i = 0; i < times; i += 1) {
      const result = await generate({ prompt: built.prompt, engine: ENGINE });
      let text = built.cut(continuationOf(result.text, built.prompt));
      if (isUnusableReply(text)) text = '(使えない返答)';
      console.log(`  ${built.as}: ${JSON.stringify(text)}`);
    }
  }
  console.log('');
}

const pct = (n) => `${((n / tally.total) * 100).toFixed(0)}%`;
console.log('--- まとめ');
console.log(`生成 ${tally.total} 回 / 空 ${tally.empty} (${pct(tally.empty)}) / 逐語コピー ${tally.verbatim} (${pct(tally.verbatim)})`);
console.log(`経路: ${[...tally.how].map(([how, n]) => `${how} ${n}`).join(' / ')}`);

// 名前持ちが examples に落ちていたら labels.json が読めていない。
// 静かに浅い返答になるだけなので、ここで落とす
if (named.length && !tally.how.get('label')) {
  console.error('\n名前持ちでも label 経路に入っていません (mimic/labels.json を確認)');
  process.exit(1);
}
