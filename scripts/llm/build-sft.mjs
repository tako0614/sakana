// 既存の大きいモデルに口調を移すためのコーパスを作る (evex-3)。
//
//   node scripts/llm/build-sft.mjs [入力 corpus/] [出力 sft/]
//
// build-corpus.mjs との違いは、出力が**素の日本語**だということ。
// あちらは自作 tokenizer 用に `<url>` `<file>` `<nl>` `<|a|>` を作るが、
// Qwen3-0.6B-Base は既に日本語を知っているので、独自の記号を渡すのは損になる:
//
//   - 新しいトークンを足すと、その埋め込みだけ未学習の状態から始まる
//   - `<nl>` は事前学習で一度も見ていない。素の改行なら 1 トークンで済む
//   - `A:` `B:` のような会話の書き方は、事前学習で大量に見ている形
//
// なので役は素の英字、改行は改行、URL は本物のまま (ただし origin だけ) にする。
//
// evex-1 の `<file>` 問題もここで消える。本文が空の 21,329 件は、あちらでは
// `<file>` 1 トークンの発言になり「発言の先頭で <file> が来る」確率を上げて
// 返答の 38% を「(画像)」だけにした。ここでは**落とす**。プレースホルダを
// 置かなければ、そもそも学習に入らない。列を足して生データを運び直す必要もない。

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { gunzipSync } from 'node:zlib';

process.env.ARCHIVE_DB_PATH = path.join(os.tmpdir(), 'sakana-sft-scratch.sqlite');
const { splitIntoChunks } = await import('../../src/archive/chunks.js');
const { assignRoles } = await import('../../src/mimic/serialize.js');

const src = process.argv[2] ?? 'corpus';
const dst = process.argv[3] ?? 'sft';

// 役は素の英字。方針 (出現順 / 8人まで / あとは Z) は assignRoles に任せる。
// 定義を2箇所に持つとずれるので、ここでは形だけ差し替える。
// **名前が付かない人だけ**がこれを使う。
const SCHEME = { roles: ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'], overflow: 'Z' };

// 発言がこれ以上ある人は表示名をそのままラベルにする。
//
// 相対の役 (A/B/C) だけにしていた最初の版は、狙いどおり個人を漏らさなかった —
// 実測で役 A の中身は 1,062 人ぶんで、最多の人でも 10.4% (その人の全体シェア 9.4%
// とほぼ同じ)。つまり `A` は「このサーバーの平均的な人」であって誰でもない。
// おかげで「その人として喋る」が原理的に不可能だった。
//
// 名前をラベルにすると重みに個人の口調が入る。トークンの追加コストは実測 +1.32M
// (素の英字 1.76M → 3.07M) で全体の +17%。
// 閾値を 2000 件 (42人 / 被覆 83.4%) から 200 件 (147人 / 96.6%) に下げても
// 追加コストは +0.21M しか増えないので、下げた方が得。
const NAMED_MIN_MESSAGES = Number(process.env.LLM_NAMED_MIN ?? 200);

// ラベルの長さの上限。`vivacious_flamingo_38533` のような自動生成名が 24 字あり、
// 1 発言ごとに何トークンも食う。切っても本人の識別には足りる。
const LABEL_MAX = 12;

// 上位いくつのチャンネルに名前を与えるか。280 チャンネルのうち上位 16 で 97%。
// 話題の手がかりになるので入れるが、名前は書き出しに無いので番号のまま使う。
const NAMED_CHANNELS = 16;

// 会話の切り方。意味検索の既定 (15分 / 20件 / 1200字) をそのまま使っていたが、
// あれは「検索の単位」として決めた値で、学習の窓には短すぎた。
//
// 実測 (トークンは 1.62 字/tok 換算):
//   沈黙15分 上限1200   中位 262 tok / 8割位  350 / 1窓に 4.1 会話  ← 前の設定
//   沈黙60分 上限3600   中位 557 tok / 8割位 1003 / 1窓に 1.7 会話  ← これ
//   沈黙60分 上限8000   中位 201 tok / 8割位 1787
//   沈黙3時間 上限8000  中位 568 tok / 8割位 1960
//
// 上限を外しすぎると逆に悪くなる。賑やかな時間帯だけ巨大化して単発が短いまま
// 残るので、分布が歪んで中位が落ちる。上限 3600 が残っていると賑やかな部分が
// 約1000トークンに切り揃えられて均一になる。
//
// seq 1024 に対して 8割位が 1003 なので、ほとんどの会話が1窓に収まる。
// seq を 2048 に上げる手もあるが、vocab 151,936 の logits が倍になって
// T4 では OOM に戻る (batch 2 × 1024 で実際に落ちた)。
const CHUNK = {
  gapMs: Number(process.env.LLM_CHUNK_GAP_MS ?? 60 * 60 * 1000),
  maxMessages: Number(process.env.LLM_CHUNK_MAX_MESSAGES ?? 60),
  maxChars: Number(process.env.LLM_CHUNK_MAX_CHARS ?? 3600)
};

const VAL_DAYS = Number(process.env.LLM_VAL_DAYS ?? 14);

const authors = JSON.parse(await readFile(path.join(src, 'authors.json'), 'utf8'));
const channels = JSON.parse(await readFile(path.join(src, 'channels.json'), 'utf8'));

// Discord の snowflake → 書き出しの番号。本文中の `<@123>` をラベルに直すのに使う
const authorIdxById = new Map(authors.map((a) => [a.id, a.idx]));

/**
 * 表示名をラベルに使える形にする。
 *
 * `:` と改行は行の構造そのものなので必ず落とす (`名前: 本文` の形が壊れる)。
 * 空白は詰める — `it's o` のような名前で行頭が曖昧になるのを避けたい。
 */
function cleanName(name) {
  return String(name ?? '')
    .replace(/[:\n\r]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, LABEL_MAX)
    .trim();
}

// idx → ラベル。発言数の多い順に決める。
//
// 表示名は重複する (実データで `.` `羽風` `だこ` `やがみ` が各2人)。そのまま使うと
// 別人の口調が1つのラベルに混ざるので、後から来た方に連番を付ける。
const labelByIdx = new Map();
const takenLabels = new Set();

for (const author of [...authors].sort((a, b) => b.count - a.count)) {
  if (author.bot || author.count < NAMED_MIN_MESSAGES) continue;

  const base = cleanName(author.name);
  if (!base) continue;                      // 名前が記号だけなら諦めて役に回す

  let label = base;
  for (let n = 2; takenLabels.has(label); n += 1) label = `${base}${n}`;

  takenLabels.add(label);
  labelByIdx.set(author.idx, label);
}

const speakerLabelOf = (idx) => labelByIdx.get(idx) ?? null;

// 件数の多い順に 16 個だけ名前を持つ。それ以外は #other に潰す
const ranked = [...channels].sort((a, b) => b.count - a.count);
const channelLabel = new Map(
  ranked.slice(0, NAMED_CHANNELS).map((c, rank) => [c.id, `#ch${rank}`])
);
const labelOf = (id) => channelLabel.get(id) ?? '#other';

/** URL は origin だけ残す。パスは 20 トークン食って何も教えない (CDN の署名付きが多い)。 */
function shorten(url) {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}

/**
 * Discord の記法を素の日本語に直す。
 *
 * メンションはラベルに直す。名前を持つ人は名前、持たない人は会話の中に居れば役、
 * 居なければ落とす — 20 桁の ID を残しても学ぶものが無い。
 * `@たこ` の形で残ると「誰に答えているか」が本文に入るので、evex-1 が捨てていた
 * 返信先の信号がここで手に入る。
 */
function plainText(content, roleOf) {
  let out = content;

  out = out.replace(/<@!?(\d+)>/g, (match, id) => {
    const idx = authorIdxById.get(id);
    const label = speakerLabelOf(idx) ?? roleOf(idx);
    return label ? `@${label}` : '';
  });
  out = out.replace(/<@&\d+>/g, '');                       // ロール
  out = out.replace(/<#(\d+)>/g, (match, id) => labelOf(id));
  out = out.replace(/<a?:([\w~]+):\d+>/g, ':$1:');          // カスタム絵文字
  out = out.replace(/https?:\/\/\S+/g, shorten);

  return out
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// --- 会話を組む ---

const byChannel = new Map();
let read = 0;
let bots = 0;
let empty = 0;

// readline は使わない。U+2028 / U+2029 も行終端として扱うので、それを含む本文で
// JSON レコードが割れる (実データに 5 件あった)。
const raw = gunzipSync(await readFile(path.join(src, 'raw.jsonl.gz'))).toString('utf8');

/**
 * 本文が空の発言を添付・埋め込み・スタンプの中身で埋める。
 *
 * evex-1 はこれを渡されていなくて、空の発言を全部 `<file>` の1トークンにしていた。
 * 結果「発言の先頭で記号が来る」確率が上がり、返答の 38% が「(画像)」だけになった
 * (推論側でトークンを禁止して 12% に抑えたが、あれは症状の抑え込み)。
 *
 * extra は `IMG_2931.png` / `[埋め込み] タイトル — 説明` / `[スタンプ] name` の形。
 * 素のファイル名は何も教えないが、**その発言が存在すること自体**が会話の流れを
 * 教える (誰かが画像を貼って、他の人が反応する)。角括弧で囲って「喋った言葉では
 * ない」と分かる形にそろえる。
 */
const KIND = [
  [/\.(jpe?g|png|gif|webp|avif|bmp|heic)$/i, '[画像]'],
  [/\.(mp4|mov|webm|mkv|avi)$/i, '[動画]'],
  [/\.(mp3|wav|ogg|m4a|flac)$/i, '[音声]'],
  [/\.(zip|7z|rar|tar|gz)$/i, '[圧縮ファイル]'],
  [/\.(pdf|docx?|xlsx?|pptx?|txt|md|csv|json|log)$/i, '[ファイル]']
];

function fromExtra(extra) {
  const text = String(extra ?? '').trim();
  if (!text) return '';
  // 埋め込みとスタンプは既に読める形が入っている (実データでは人間の空発言に 0 件)
  if (text.startsWith('[')) return text;

  // ファイル名は捨てて種類だけ残す。実データの空発言 17,889 件は**全部ファイル名だけ**で、
  // `cat.jpeg` `IMG_4123.png` のような無意味なものが大半だった。
  //
  // 名前を残すと 8 トークン払って何も学べないうえ、モデルが返答としてそれを吐くように
  // なれば evex-1 の `<file>` 問題を移しただけになる (あれは 1 トークンで確率が跳ね上がり、
  // 返答の 38% が「(画像)」だけになった)。
  //
  // 種類だけなら 2 トークンで、しかも「画像が貼られた」という情報は残る。
  // 学びたいのは「誰かが画像を貼って、他の人が反応する」という流れの方。
  const first = text.split('\n')[0].trim();
  const found = KIND.find(([pattern]) => pattern.test(first));
  return found ? found[1] : '[添付]';
}

for (const line of raw.split('\n')) {
  if (!line) continue;
  read += 1;

  // 列が 6 個の古い書き出しも読める。extra と reply_author は後から足した
  const [ch, author, createdAt, isBot, isReply, content, extra, replyAuthor] = JSON.parse(line);
  if (isBot) { bots += 1; continue; }

  const body = (content && content.trim()) ? content : fromExtra(extra);
  if (!body) { empty += 1; continue; }

  if (!byChannel.has(ch)) byChannel.set(ch, []);
  byChannel.get(ch).push({
    author,
    created_at: createdAt,
    reply: isReply,
    reply_author: replyAuthor ?? null,
    content: body,
    // splitIntoChunks が字数で切るのに使う。正規化で少し縮むが、
    // 縮む方向なので上限を割ることはない
    char_count: body.length
  });
}

const channelIdByIdx = new Map(channels.map((c) => [c.idx, c.id]));
const conversations = [];

for (const [chIdx, rows] of byChannel) {
  const label = labelOf(channelIdByIdx.get(chIdx));

  for (const chunk of splitIntoChunks(rows, CHUNK)) {
    // 名前を持たない人だけに A,B,C... を振る。名前持ちに役を配ると、
    // 同じ会話で「たこ」と「B」が同一人物という矛盾した形になる
    const unnamed = chunk.map((row) => row.author).filter((idx) => !labelByIdx.has(idx));
    const roles = assignRoles(unnamed, SCHEME);
    const roleOf = (idx) => (idx === undefined ? null : roles.get(idx) ?? null);

    const counts = new Map();
    for (const row of chunk) counts.set(row.author, (counts.get(row.author) ?? 0) + 1);

    const lines = [];
    for (const row of chunk) {
      let text = plainText(row.content, roleOf);
      if (!text) continue;                        // 正規化で空になった (メンションだけ等)

      // 誰への返信かを本文の先頭に残す。evex-1 は「返信かどうか」の真偽値しか
      // 持っていなくて相手を捨てていたが、賑やかなチャンネルでは噛み合いの信号そのもの。
      // 既に @ で始まっているならメンションで足りているので触らない。
      const target = row.reply_author != null && row.reply_author !== row.author
        ? (speakerLabelOf(row.reply_author) ?? roleOf(row.reply_author))
        : null;
      if (target && !text.startsWith('@')) text = `@${target} ${text}`;

      lines.push(`${speakerLabelOf(row.author) ?? roles.get(row.author)}: ${text}`);
    }

    // 1 発言だけの「会話」は交代を教えないので落とす
    if (lines.length < 2) continue;

    conversations.push({
      at: chunk[chunk.length - 1].created_at,
      // priming で使う。会話の開始時刻より前からしか引かないので、
      // 同じ会話が混ざることがない
      from: chunk[0].created_at,
      channel: label,
      roles,
      counts,
      lines,
      primed: 0,
      text: `${label}\n${lines.join('\n')}`
    });
  }
}

conversations.sort((a, b) => a.at - b.at);

// --- 文脈で人を教える (persona priming) ---
//
// 窓の先頭にその人の「別の会話での発言」を置く。学習側では**その位置の損失を外す**
// (finetune.py が primed の行数を見て外す) ので、「先頭のブロックは条件、続きが
// 予測対象」という形になる。
//
// 狙いは推論側の穴を埋めること。147人はラベルで口調が出るが、残り 2,405人は
// 実発言を例として見せる経路しかなく、**モデルは「例を使う」ことを一度も学んでいない**。
// 学習データでは無名の人は A/B/C の相対の役で、実測で役 A の中身は 1,062人ぶん
// (最多でも 10.4% = その人の全体シェアと同じ) なので、A は誰でもない。
//
// 効き方には構造的な裏付けがある。学習データを位置別に数えると、URL だけの行が
// 出る確率は会話の 0 行目で 9.80% / 1 行目で 5.44% / 6 行目以降で 2.76%。
// **本人が直前1〜2行で本文を喋っていた場合は 1.94%** まで落ちる。
// いまの `/mimic` のプロンプトは生成点がちょうど 0〜1 行目 = 最悪の位置 (8.21%)。
// 本人の実発言を直前に置くだけで、意味検索の当たり外れとは無関係に改善する。
//
// **新しい記法は足さない。** `名前: 本文` の行が増えるだけなので、Qwen が
// 事前学習で見ていない並びにはならない。`[過去]` のような印を入れると、
// そこだけ未学習になって崩れる (evex-1 に <|a|> を渡して壊したのと同じ形)。
const PRIME_RATE = Number(process.env.LLM_PRIME_RATE ?? 0.5);
const PRIME_TURNS = Number(process.env.LLM_PRIME_TURNS ?? 4);
const PRIME_MIN_CHARS = 4;      // 「草」「w」は口調の情報が無い (exampleTurns と同じ)
const PRIME_MAX_CHARS = 200;    // 1 件で例が埋まるのを防ぐ
const PRIME_BUDGET = Math.round(CHUNK.maxChars * 0.4);

// 乱数は種を固定する。Math.random だと作り直すたびに中身が変わって、
// 「コーパスを変えたのか学習が揺れたのか」が切り分けられなくなる
function mulberry32(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rand = mulberry32(Number(process.env.LLM_PRIME_SEED ?? 12345));

// 人ごとの発言。時刻順にしておいて、会話の開始より前から二分探索で引く
const byAuthor = new Map();
for (const rows of byChannel.values()) {
  for (const row of rows) {
    const length = row.content.length;
    if (length < PRIME_MIN_CHARS || length > PRIME_MAX_CHARS) continue;
    if (!byAuthor.has(row.author)) byAuthor.set(row.author, []);
    byAuthor.get(row.author).push({ at: row.created_at, content: row.content });
  }
}
for (const list of byAuthor.values()) list.sort((a, b) => a.at - b.at);

/** at より前の要素数。上限を二分探索で出す (常連は5万件あるので線形に舐めない)。 */
function countBefore(list, at) {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid].at < at) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

// val は「最後の N 日ぶんの会話」。ランダム分割にしない —
// 「草」「www」のような完全一致が 23% あるので、時間で切らないと val が嘘になる
const newest = conversations[conversations.length - 1]?.at ?? Date.now();
const cutoff = newest - VAL_DAYS * 86_400_000;

const train = conversations.filter((c) => c.at < cutoff);
const val = conversations.filter((c) => c.at >= cutoff);

// priming は **train にだけ**入れる。val に入れると「例を見た状態」の尺度になって、
// preview の val 2.5898 と比べられなくなる。
let primedConversations = 0;
let primedLines = 0;

for (const conv of train) {
  if (rand() >= PRIME_RATE) continue;

  // 無名の人を優先する。名前持ちはラベルで既に効いているので、無名側にこそ効く。
  // 同じ会話で一番喋っている人を選ぶ (材料が多く、効果も測りやすい)
  const ranked = [...conv.counts.entries()].sort((a, b) => b[1] - a[1]);
  const target = ranked.find(([idx]) => conv.roles.has(idx))?.[0] ?? ranked[0]?.[0];
  if (target === undefined) continue;

  const label = speakerLabelOf(target) ?? conv.roles.get(target);
  if (!label) continue;

  const own = byAuthor.get(target);
  if (!own) continue;

  // 会話の開始より前からしか引かない。これで同じ会話が混ざらない
  // (自明なコピーになるし、val に未来を漏らす経路も塞げる)
  const before = countBefore(own, conv.from);
  if (before === 0) continue;

  // この会話に既に出ている本文。priming に同じものを入れると、目標がそのまま
  // 前に置かれた形になって「写せば当たる」問題を作る。時刻で別メッセージを
  // 選んでいても、「草」「わかる」のような繰り返しで一致する (実測 818 会話 = 9.4%)
  // 複数行の発言は継続行にラベルが無い。`indexOf` が -1 を返すので、
  // 見つからないときは行そのものを入れる (先頭1字を落とした変な値を入れない)
  const already = new Set(conv.lines.flatMap((line) => {
    const at = line.indexOf(': ');
    return at < 0 ? [line] : [line.slice(at + 2), ...line.slice(at + 2).split('\n')];
  }));

  const picked = [];
  const seen = new Set();
  let budget = PRIME_BUDGET;

  // 直近から遡る。生成点に近い側に近い発言が来る形にしたいので、最後に反転する
  for (let i = before - 1; i >= 0 && picked.length < PRIME_TURNS; i -= 1) {
    const text = plainText(own[i].content, (idx) => (
      speakerLabelOf(idx) ?? conv.roles.get(idx) ?? null
    ));
    if (!text || text.length < PRIME_MIN_CHARS) continue;

    // **改行を含む本文は使わない。** priming の範囲を「先頭 N 行」で渡すので、
    // 1 発言が複数行に跨ると行数と発言数がずれて、損失マスクが別の場所を外す
    // (実測で 1,317 会話がこれで壊れていた)。捨てても材料は足りる
    if (text.includes('\n')) continue;

    if (seen.has(text)) continue;               // 「草」を4回並べても情報が増えない
    if (already.has(text)) continue;            // 会話の中に同じ本文がある
    if (text.length > budget) continue;

    seen.add(text);
    picked.push(text);
    budget -= text.length;
  }

  if (!picked.length) continue;

  picked.reverse();
  const head = picked.map((text) => `${label}: ${text}`);
  conv.primed = head.length;
  conv.text = `${conv.channel}\n${head.join('\n')}\n${conv.lines.join('\n')}`;

  primedConversations += 1;
  primedLines += head.length;
}

// --- 聞かれたら答える形を足す ---
//
// evex-ft-1 は口調は移ったが**話を受けて返さない** (`git rebase と merge の違い` →
// `まじ？`)。原因はコーパスの分布で、発言 598,908 のうち 45.3% が10字以下・
// 76.6% が20字以下、疑問符に別人が20字以上で答えた組は 6,418 = 全体の 1.1% しかない。
// 「聞かれたら答える」信号がほぼ無いので、確率がフィラーに寄る。
//
// 実測では能力が消えたわけではない (別の日本語での perplexity は base の 1.12倍)。
// **その形を選ぶ確率**が低いだけなので、信号を増やす。2つやる。

const QA_COPIES = Number(process.env.LLM_QA_COPIES ?? 2);
const QA_MIN_ANSWER = Number(process.env.LLM_QA_MIN_ANSWER ?? 20);
const QA_CONTEXT = Number(process.env.LLM_QA_CONTEXT ?? 2);

// 継続行 (ラベルの無い行) は前の発言の一部なので飛ばす
const LABELLED = /^([^\n:]{1,12}): ([\s\S]*)$/;

/**
 * 疑問符で終わる発言に**別人が**それなりの長さで答えている箇所を、
 * 前後だけ切り出して返す。
 *
 * **会話ごと複製してはいけない。** 最初はそうしたが、この条件に当たる会話は
 * 平均 1,505 字 (全体平均 1,008 字) で長く、×3 にしたら QA 分が全体の 64% を占めた
 * (16.4M → 30.4M 字)。学習時間が倍になるうえ、その会話ごと暗記する。
 *
 * 欲しいのは「聞かれたら答える」という並びだけなので、質問の直前数行から
 * 答えまでを短い会話として切り出す。4 行前後 = 250 字程度で済む。
 */
function questionExcerpts(conv) {
  const found = [];
  const rows = [];
  for (const line of conv.lines) {
    const m = line.match(LABELLED);
    if (m) rows.push({ label: m[1], body: m[2].trim(), line });
  }

  for (let i = 1; i < rows.length; i += 1) {
    const q = rows[i - 1];
    const a = rows[i];
    if (q.label === a.label) continue;
    if (!/[?？][\s　]*$/.test(q.body)) continue;
    if (a.body.length < QA_MIN_ANSWER) continue;

    const from = Math.max(0, i - 1 - QA_CONTEXT);
    const lines = rows.slice(from, i + 1).map((r) => r.line);
    found.push({
      at: conv.at, from: conv.from, channel: conv.channel,
      roles: conv.roles, counts: conv.counts, lines, primed: 0,
      text: `${conv.channel}\n${lines.join('\n')}`
    });
  }
  return found;
}

const qaExcerpts = train.flatMap(questionExcerpts);

/**
 * 切り出しの話者を**匿名の役に付け替える**。
 *
 * bot は `/as` を指定されていないとき匿名の役で喋る (`nextRole`)。ところが
 * 「疑問→20字以上の答え」20,957 箇所のうち**答えた側が匿名の役なのは 11.9% だけ**で、
 * 88.1% は名前持ち。つまり信号を増やしても既定の経路にはほとんど届かない。
 *
 * 実測でもそうなっていて、evex-ft-1 に同じ技術的な質問を振ると
 *   `あかり:` → 20字以上 65% / 噛み合い 55%
 *   `B:`     → 20字以上 30% / 噛み合い 20%  (`うーん` `うんこ`)
 * となる。**`まじ？` の原因はモデルではなく喋らせている役。**
 *
 * 中身は変えず、誰が言ったかだけを出現順の役に移す。匿名の役はもともと
 * 「このサーバーの平均的な人」(役 A の中身は 1,062人ぶん) なので、
 * 平均的な人の振る舞いをそこに寄せるのは筋が通る。
 * 本文中の `@名前` も同じ表に従って直す — 直さないと会話に居ない人を指す。
 */
function anonymise(conv) {
  const seen = new Map();
  const roleFor = (label) => {
    if (!seen.has(label)) {
      const next = seen.size < SCHEME.roles.length ? SCHEME.roles[seen.size] : SCHEME.overflow;
      seen.set(label, next);
    }
    return seen.get(label);
  };

  // 先に全員へ役を振る。本文の `@名前` を直すときに、まだ喋っていない人も引けるように
  const parsed = conv.lines.map((line) => line.match(LABELLED)).filter(Boolean);
  for (const m of parsed) roleFor(m[1]);

  // 長いラベルから先に置き換える。`あかり` を先にやると `@あかり2` が `@A2` になる
  // (同名の人に連番を付けているので実在する形)
  const rename = [...seen.entries()].sort((a, b) => b[0].length - a[0].length);

  const lines = parsed.map((m) => {
    let body = m[2];
    for (const [label, role] of rename) body = body.split(`@${label}`).join(`@${role}`);
    return `${roleFor(m[1])}: ${body}`;
  });

  return {
    at: conv.at, from: conv.from, channel: conv.channel,
    roles: conv.roles, counts: conv.counts, lines, primed: 0,
    text: `${conv.channel}\n${lines.join('\n')}`
  };
}

// **同じ切り出しを隣に並べない。** Packed は会話を EOS で継いで 1024 に切るので、
// 隣接させると1つの窓に同じ本文が2回入って「写せば当たる」形になる。
// 1周ぶんずつ後ろに足せば、同じものの複製は必ず数千会話ぶん離れる。
//
// 2周目は匿名の役に付け替える。名前持ちと匿名の両方に信号が通る形にしたい
for (let round = 0; round < Math.max(0, QA_COPIES); round += 1) {
  for (const excerpt of qaExcerpts) {
    train.push(round % 2 === 1 ? anonymise(excerpt) : excerpt);
  }
}

// --- 説明する口調を外から借りる ---
//
// 上の複製だけでは足りない (元が 1.1% なので ×3 でも 3% 台)。公開の日本語対話を
// 少量混ぜて、「長く答える」形そのものを残す。
//
// llm-jp/oasst1-21k-ja (Apache-2.0 / 人が書いた多ターン / 中位4往復) を使う。
// dolly-ja は CC-BY-SA-3.0、alpaca 系は OpenAI 由来なのでどちらも採らない。
//
//   hf download llm-jp/oasst1-21k-ja oasst1-21k-ja.jsonl --repo-type dataset --local-dir mix
//   LLM_MIX_FILE=mix/oasst1-21k-ja.jsonl node scripts/llm/build-sft.mjs corpus-v3 sft-v5
//
// **名前ラベルには絶対に付けない。** 付けると実在の人の口調に「ご質問がありましたら」
// が混ざる。匿名の役だけに割り、役は会話ごとに振り直す — `B` に固定すると
// 「説明するのは B」を学んで、bot が別の役になった推論時に出てこない。
const MIX_FILE = process.env.LLM_MIX_FILE ?? null;
const MIX_RATE = Number(process.env.LLM_MIX_RATE ?? 0.03);
const MIX_MAX_CHARS = Number(process.env.LLM_MIX_MAX_CHARS ?? 300);

let mixedConversations = 0;
let mixedChars = 0;
let mixedDroppedTurns = 0;

if (MIX_FILE && MIX_RATE > 0) {
  const rows = (await readFile(MIX_FILE, 'utf8'))
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));

  const trainChars = train.reduce((sum, c) => sum + c.text.length, 0);
  const budget = Math.round(trainChars * MIX_RATE / (1 - MIX_RATE));

  // 決定的に混ぜる。priming と同じ種から引いて、作り直しても同じものが入るようにする
  const order = rows.map((row, i) => ({ row, key: rand() * (i + 1) }))
    .sort((a, b) => a.key - b.key)
    .map((x) => x.row);

  for (const row of order) {
    if (mixedChars >= budget) break;

    const turns = row.conversations ?? row.messages ?? [];
    if (!Array.isArray(turns) || turns.length < 2) continue;

    // 役は2つだけ引く。会話ごとに振り直して、説明する側が特定の役に固定されないようにする
    const pool = SCHEME.roles;
    const first = Math.floor(rand() * pool.length);
    const second = (first + 1 + Math.floor(rand() * (pool.length - 1))) % pool.length;
    const roleOfTurn = (from) => (from === 'gpt' || from === 'assistant' ? pool[second] : pool[first]);

    const lines = [];
    let dropped = false;
    for (const turn of turns) {
      const body = String(turn.value ?? turn.content ?? '').replace(/\s*\n\s*/g, ' ').trim();
      if (!body) continue;
      // 長大な答えは捨てる。76% が20字以下のコーパスに壁のような返答を入れると、
      // そういう返答を学んでしまう
      if (body.length > MIX_MAX_CHARS) { dropped = true; mixedDroppedTurns += 1; continue; }
      lines.push(`${roleOfTurn(turn.from ?? turn.role)}: ${body}`);
    }

    // 途中を捨てると噛み合わなくなるので、1つでも落ちた会話は丸ごと使わない
    if (dropped || lines.length < 2) continue;

    // #other 固定。実在チャンネルの話題分布を汚さない
    const text = `#other\n${lines.join('\n')}`;
    train.push({ at: 0, from: 0, channel: '#other', roles: new Map(), counts: new Map(), lines, primed: 0, text });
    mixedConversations += 1;
    mixedChars += text.length;
  }
}

await mkdir(dst, { recursive: true });

// primed は「先頭から何行が条件か」。finetune.py がこの行数ぶんの本文を損失から外す。
// 文字範囲ではなく行数で渡すのは、priming 行を必ず先頭に固めてあるから一意に決まるため
const jsonl = (list) => `${list
  .map((c) => JSON.stringify(c.primed ? { text: c.text, primed: c.primed } : { text: c.text }))
  .join('\n')}\n`;
await writeFile(path.join(dst, 'train.jsonl'), jsonl(train));
await writeFile(path.join(dst, 'val.jsonl'), jsonl(val));

// bot 側がラベルを引けるようにする。これが無いと /mimic がどの文字列で
// 呼べばいいか分からない (学習していないラベルを渡すと、モデルは一度も見ていない
// 入力を受け取って静かに崩れる)。実 ID を含むので公開物には混ぜない。
const idById = new Map(authors.map((a) => [a.idx, a.id]));
const labels = [...labelByIdx.entries()]
  .map(([idx, label]) => ({
    label,
    userId: idById.get(idx),
    name: authors.find((a) => a.idx === idx)?.name ?? '',
    count: authors.find((a) => a.idx === idx)?.count ?? 0
  }))
  .sort((a, b) => b.count - a.count);

await writeFile(path.join(dst, 'labels.json'), `${JSON.stringify(labels, null, 1)}\n`);

const chars = (list) => list.reduce((sum, c) => sum + c.text.length, 0);
await writeFile(
  path.join(dst, 'stats.json'),
  `${JSON.stringify({
    read,
    bots,
    empty_dropped: empty,
    conversations: conversations.length,
    train: train.length,
    val: val.length,
    train_chars: chars(train),
    val_chars: chars(val),
    val_days: VAL_DAYS,
    named_channels: NAMED_CHANNELS,
    chunk: CHUNK,
    named_speakers: labelByIdx.size,
    named_min_messages: NAMED_MIN_MESSAGES,
    primed_conversations: primedConversations,
    primed_lines: primedLines,
    prime_rate: PRIME_RATE,
    prime_turns: PRIME_TURNS,
    qa_excerpts: qaExcerpts.length,
    qa_copies: QA_COPIES,
    qa_context: QA_CONTEXT,
    qa_min_answer: QA_MIN_ANSWER,
    qa_chars: qaExcerpts.reduce((sum, c) => sum + c.text.length, 0) * QA_COPIES,
    mixed_conversations: mixedConversations,
    mixed_chars: mixedChars,
    mixed_dropped_turns: mixedDroppedTurns,
    mix_rate: MIX_RATE,
    mix_file: MIX_FILE
  }, null, 2)}\n`
);

const fmt = (n) => n.toLocaleString('en-US');
console.log(`読んだ           ${fmt(read)} (bot ${fmt(bots)} / 本文なし ${fmt(empty)} を除外)`);
console.log(`会話             ${fmt(conversations.length)}  train ${fmt(train.length)} / val ${fmt(val.length)}`);
console.log(`文字数           train ${fmt(chars(train))} / val ${fmt(chars(val))}`);
console.log(`1 会話あたり     ${Math.round(chars(train) / train.length)} 字`);
console.log(`名前ラベル       ${labelByIdx.size} 人 (${NAMED_MIN_MESSAGES} 件以上)`);
console.log(`priming          ${fmt(primedConversations)} 会話 / ${fmt(primedLines)} 行`);
const qaChars = qaExcerpts.reduce((sum, c) => sum + c.text.length, 0) * QA_COPIES;
console.log(`聞かれて答えた箇所 ${fmt(qaExcerpts.length)} を ×${QA_COPIES} で切り出し `
  + `(答えは ${QA_MIN_ANSWER} 字以上 / ${fmt(qaChars)} 字 = train の `
  + `${(qaChars / chars(train) * 100).toFixed(1)}%)`);
console.log(`外から混ぜた     ${fmt(mixedConversations)} 会話 / ${fmt(mixedChars)} 字 `
  + `(train の ${(mixedChars / chars(train) * 100).toFixed(1)}% / 長すぎて捨てた発言 ${fmt(mixedDroppedTurns)})`);
console.log(`\n--- 先頭の会話 ---\n${train[0]?.text.slice(0, 400)}`);
