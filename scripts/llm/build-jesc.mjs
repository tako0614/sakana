// JESC (映画字幕の日英対訳) の日本語側を evex と同じ行形式に変換する。
//
//   node scripts/llm/build-jesc.mjs [出力 corpus-v7/jesc.txt]
//
// nntsuzu/JESC (CC-BY-4.0 / 280万行)。**カードに出典を書く義務が付く。**
//
// --- なぜ字幕なのか ---
//
// 段1 に足せる日本語の会話データを探した結果、なりきり掲示板の次に使えるのがこれ。
// 1行 14.8 字の短い口語で、地の文も敬体の押し付けも無く **register が Discord に近い**:
//
//   もういいよ、ごちそうさま、ううん。
//   もう会社には来ないでくれ、電話もするな。
//
// 41M字 = 約15M トークンで、段1 を 1.8 倍にできる。
//
// --- 話者ラベルが無いことについて ---
//
// 字幕に話者は入っていない。**それで構わない** — 外部データの役目は
// 「会話の交代・話の受け方・日本語」までで、**誰が誰かは evex だけが持つ**。
// 話者トークン `<|sN|>` は絶対に出さない (最後にアサートで止める)。
//
// 連続する行を交互に `<|a|>` `<|b|>` へ振る。同じ人が続けて喋る箇所は
// 取り違えるが、狙いは「発話が交代する」形を見せることなので許容する。
// **場面の切れ目は分からない**ので、窓は行数で切って短めにしておく。

import { createWriteStream } from 'node:fs';
import { mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

process.env.ARCHIVE_DB_PATH = path.join(os.tmpdir(), 'sakana-jesc-scratch.sqlite');
const { ROLE_TOKENS, buildPrompt, messageText } =
  await import('../../src/mimic/serialize.js');

const src = process.env.LLM_JESC_DIR ?? 'external/jesc';
const out = process.argv[2] ?? 'corpus-v7/jesc.txt';

// 1 窓の行数。字幕は 1 行 15 字前後なので、24 行で 360 字前後になる。
// なりきり掲示板 (3600字) より短くするのは、**場面の切れ目が分からない**から —
// 長く取るほど無関係なやり取りが 1 窓に混ざる
const LINES_PER_WINDOW = Number(process.env.LLM_JESC_WINDOW ?? 24);

// 使う行数の上限。全部 (280万) 入れると段1 の外部比率が字幕に偏る
const MAX_LINES = Number(process.env.LLM_JESC_MAX ?? 2_800_000);

// 字幕特有の記号。話者名の前置き (`- `) や音声表記は会話ではない
const SPEAKER_DASH = /^[-–—]\s*/;
const SOUND = /^[（(\[【].{0,20}[）)\]】]$/;      // (笑) [音楽] など単体の行

// **かなを必須にする。**漢字だけで通すと中国語が素通りする —
// 実測で 400,000 行のうち 6,221 行 (1.6%) が
// `由于地形复杂、自然环境恶劣、人迹罕至。` のような中国語だった。
// 日本語の文はほぼ必ずかなを含み、中国語は含まない。
// 副作用として `本能。` のような漢字だけの短い日本語も落ちるが、実害は無い
const KANA = /[ぁ-んァ-ヶ]/;

function usable(text) {
  const body = String(text ?? '').replace(SPEAKER_DASH, '').trim();
  if (!body || body.length < 2) return null;
  if (SOUND.test(body)) return null;
  if (!KANA.test(body)) return null;
  return body;
}

await mkdir(path.dirname(out), { recursive: true });
const sink = createWriteStream(out, { encoding: 'utf8' });
const write = (line) => new Promise((resolve) => {
  if (sink.write(`${line}\n`)) resolve();
  else sink.once('drain', resolve);
});

// parquet は読めないので、`hf download` で落とした jsonl を読む前提にする。
// 落とし方は README とこのファイルの手順に書いておく
const files = (await readdir(src).catch(() => []))
  .filter((f) => f.endsWith('.jsonl'))
  .sort();

if (!files.length) {
  console.error(`${src}/ に .jsonl が無い。先にこれを回す:`);
  console.error('  .venv-llm/bin/python scripts/llm/fetch-jesc.py external/jesc');
  process.exit(1);
}

const stats = { read: 0, used: 0, dropped: 0, windows: 0, chars: 0 };
let buffer = [];

async function flush() {
  if (buffer.length < 4) { buffer = []; return; }   // 4 行未満は交代を教えない
  const turns = buffer.map((content, i) => ({
    token: ROLE_TOKENS[i % 2],                       // <|a|> と <|b|> を交互に
    content
  }));
  const text = `${buildPrompt(turns)}<|end|>`;
  stats.windows += 1;
  stats.chars += text.length;
  await write(text);
  buffer = [];
}

for (const file of files) {
  const { createReadStream } = await import('node:fs');
  let rest = '';
  const stream = createReadStream(path.join(src, file), { encoding: 'utf8' });

  for await (const chunk of stream) {
    const parts = (rest + chunk).split('\n');
    rest = parts.pop();

    for (const line of parts) {
      if (!line.trim() || stats.read >= MAX_LINES) continue;
      stats.read += 1;

      let ja;
      try {
        const row = JSON.parse(line);
        ja = row.ja ?? row.translation?.ja ?? null;
      } catch { continue; }

      const body = usable(ja);
      if (!body) { stats.dropped += 1; continue; }

      stats.used += 1;
      buffer.push(messageText(body));
      if (buffer.length >= LINES_PER_WINDOW) await flush();
    }
  }
}
await flush();
await new Promise((resolve) => sink.end(resolve));

const fmt = (n) => n.toLocaleString();
console.log(`読んだ行     ${fmt(stats.read)}`);
console.log(`  使った     ${fmt(stats.used)}`);
console.log(`  落とした   ${fmt(stats.dropped)} (短い / 音声表記 / 日本語なし)`);
console.log(`窓           ${fmt(stats.windows)} (${LINES_PER_WINDOW} 行ずつ) / ${fmt(stats.chars)} 字`);
console.log(`\n出力 ${out}`);
console.log('CC-BY-4.0 — **モデルカードに nntsuzu/JESC の出典を書くこと**');
