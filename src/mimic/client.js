// 自作モデルの推論プロセスに投げる。
//
// bot と同じプロセスで回さないのは、CPU 推論がイベントループを止めて Discord の
// REST が全部落ちるから (チャンク生成で 28 秒固めたのと同じ形)。
// 別プロセスにしておけば、推論が固まっても bot は生きている。
//
// 127.0.0.1 だけで待ち受ける。エージェントの browser ツールは urlguard が
// ループバックを塞いでいるので、SSRF でここに到達する経路は無い。

const number = (value, fallback) => (Number.isFinite(Number(value)) ? Number(value) : fallback);

export const mimicConfig = {
  url: process.env.MIMIC_URL ?? 'http://127.0.0.1:8765',
  timeoutMs: number(process.env.MIMIC_TIMEOUT_MS, 60_000),
  maxNewTokens: number(process.env.MIMIC_MAX_NEW_TOKENS, 200),
  // 返答の末尾に出す名前。世代が上がったら env で差し替える。
  //
  // 中身は evex-2 正式版 (12 epoch / v1-lr1e-3-mask)。preview (マスクなし) から
  // 差し替えた。同じ尺度で測ると 記号だけの返答 38.5% → 0%、実際に読まれる語だけの
  // val 4.0465 → 4.0330。素の val は 4.0384 → 4.0970 と悪くなるが、あの尺度は
  // <url> / <file> を当てることを点数にしているので、そこで負けるのは払って良い
  label: process.env.MIMIC_LABEL ?? 'evex-2',
  // 直列化の形式。tokens は独自の制御記号 (evex-1 / evex-2)、plain は素の日本語
  // (evex-ft-1)。既定は /health の申告から判定する
  format: process.env.MIMIC_FORMAT ?? 'auto'
};

/**
 * 世代ごとの接続先。**別プロセス・別ポートで並走させる**ので、まとめて持つ。
 *
 * 世代を差し替えるのではなく並べるのは、性質が違うものだから:
 *   evex-1     94万件だけで学習。純度は高いが荒い (5.87M)
 *   evex-ft-1  Qwen3-0.6B を追加学習。読めるが Qwen の知識が混ざる
 * どちらが面白いかは読み比べないと分からないので、/model で選べる形にする。
 *
 * format を env で固定できるようにしてあるのは、evex-ft-1 を llama.cpp で配信すると
 * server.py の /health が無く、申告から判定できないから。取り違えるとモデルが
 * 一度も見ていない入力を受け取り、例外を出さずに静かに崩れる。
 */
export const ENDPOINTS = {
  // キーは 'evex' のまま evex-2 を指す。agent_engine 表に 'evex' を選んだ人の行が
  // 残っているので、キーを消すとその人たちが黙って DeepSeek に戻る
  evex: mimicConfig,
  // 元の 5.87M (val 4.2404)。evex-2 に差し替えたあとも比べられるように残す。
  // 同じ server.py / 同じ tok.model で、違うのは ckpt だけ
  'evex-1': {
    url: process.env.MIMIC_V1_URL ?? 'http://127.0.0.1:8767',
    timeoutMs: number(process.env.MIMIC_V1_TIMEOUT_MS, 60_000),
    maxNewTokens: number(process.env.MIMIC_V1_MAX_NEW_TOKENS, 200),
    label: process.env.MIMIC_V1_LABEL ?? 'evex-1',
    format: process.env.MIMIC_V1_FORMAT ?? 'auto'
  },
  'evex-ft': {
    url: process.env.MIMIC_FT_URL ?? 'http://127.0.0.1:8766',
    timeoutMs: number(process.env.MIMIC_FT_TIMEOUT_MS, 120_000),
    // 連投を許すぶん長く取る。実際は stop_label で必要なところで止まる
    maxNewTokens: number(process.env.MIMIC_FT_MAX_NEW_TOKENS, 160),
    label: process.env.MIMIC_FT_LABEL ?? 'evex-ft-1',
    format: process.env.MIMIC_FT_FORMAT ?? 'plain'
  },
  // ft-1 と同じ base・同じ形式で、コーパスだけ違う (sft-v5)。
  //
  // ft-1 は口調は移ったが話を受けて返さない — 疑問に20字以上で答えた組が全発言の
  // 1.1% しか無かったので、確率がフィラーに寄っていた (`まじ？` `うーん`)。
  // v5 でそこを 10.0% にし、片方を匿名の役に付け替えて bot の既定経路にも通した。
  //
  // **置き換えず並走させる。** int8 で 0.62GB / 27 tok/s (実測) なので両方立てられる。
  // 「会話できるようになったか」と「evex のままか」は読み比べないと分からない
  'evex-ft-2': {
    url: process.env.MIMIC_FT2_URL ?? 'http://127.0.0.1:8768',
    timeoutMs: number(process.env.MIMIC_FT2_TIMEOUT_MS, 120_000),
    maxNewTokens: number(process.env.MIMIC_FT2_MAX_NEW_TOKENS, 160),
    label: process.env.MIMIC_FT2_LABEL ?? 'evex-ft-2',
    format: process.env.MIMIC_FT2_FORMAT ?? 'plain'
  },
  // ft-2 と同じコーパス (sft-v5) で、**base を instruct 版に変えたもの**。
  //
  // ft-2 の不満が「間違っている」ではなく「文の体をなしていない」だったので、
  // 答えの形にする性質を持っている instruct を土台にした。実測では狙い通り
  // 答えの形になった (敬体の漏れは 0%) が、なりきり時の噛み合いが 55% → 33% に
  // 落ちて逐語コピーが 13.3% に増えた。**数字では決まらないので並べて読む。**
  'evex-ft-3': {
    url: process.env.MIMIC_FT3_URL ?? 'http://127.0.0.1:8769',
    timeoutMs: number(process.env.MIMIC_FT3_TIMEOUT_MS, 120_000),
    maxNewTokens: number(process.env.MIMIC_FT3_MAX_NEW_TOKENS, 160),
    label: process.env.MIMIC_FT3_LABEL ?? 'evex-ft-3',
    format: process.env.MIMIC_FT3_FORMAT ?? 'plain'
  },
  // ゼロから学習した系の 3 代目。**tokenizer が別物**なので、corpus-v4 の
  // tok.model を持つ専用ディレクトリで起動する (evex-1/2 の mimic/ と混ぜない)。
  //
  // evex-2 との違いはコーパスと大きさの両方:
  //   話者トークン 48 → 147 (発言の被覆 85.3% → 96.6%)
  //   返信先を <|re|><|sM|> で残す (evex-2 は「返信かどうか」だけで相手を捨てていた)
  //   窓 15分/20件/1200字 → 60分/60件/3600字、context 512 → 1024
  //   噛み合いと長い発言の切り出し (train の 12.5% / 24.5%)
  //   窓の切り方 3 通りで 2.08 倍 → train 6.48M → 23.95M トークン
  //   5.87M → 15.74M パラメータ
  // 同じコーパスで 5.87M も回してあるので、良くなった分の出どころが分かる
  'evex-3': {
    url: process.env.MIMIC_V3_URL ?? 'http://127.0.0.1:8770',
    timeoutMs: number(process.env.MIMIC_V3_TIMEOUT_MS, 60_000),
    maxNewTokens: number(process.env.MIMIC_V3_MAX_NEW_TOKENS, 200),
    label: process.env.MIMIC_V3_LABEL ?? 'evex-3',
    format: process.env.MIMIC_V3_FORMAT ?? 'auto'
  },
  // evex-3 と**語彙が別物** (4096 → 12288)。専用ディレクトリで起動する。
  //
  // 変えたのは 2 つだけ:
  //   語彙 12288  日本語 1.56 → 2.06 字/token / 英字 1.94 → 2.62 (英字トークン 641 → 3,058)
  //   二段学習    なりきり掲示板で土台を作ってから evex だけで仕上げる
  // 大きさは 15.74M → 18.9M だが、増えたのは埋め込み表だけで transformer 側は同じ。
  //
  // **evex-3 を置き換えず並走させる。**tokenizer もコーパスも違うので val で
  // 比べられない。読み比べないと「良くなったか」が決まらない
  'evex-3.5': {
    url: process.env.MIMIC_V35_URL ?? 'http://127.0.0.1:8771',
    timeoutMs: number(process.env.MIMIC_V35_TIMEOUT_MS, 60_000),
    maxNewTokens: number(process.env.MIMIC_V35_MAX_NEW_TOKENS, 200),
    label: process.env.MIMIC_V35_LABEL ?? 'evex-3.5',
    format: process.env.MIMIC_V35_FORMAT ?? 'auto'
  },
  // evex-3.5 と**同じ形・同じ語彙**で、変えたのはコーパスと学習の配分だけ。
  // だから読み比べれば「コーパスの工夫が効いたか」がそのまま出る。
  //
  //   段1 の外部     23.3M → 158.1M トークン (なりきり + JESC字幕 + open2ch)
  //   外部の形       Discord の粒度に直した (`<|re|>` 0% → 18〜25% / 連投 0% → 22〜44%)
  //   リアクション   22,667 件を切り出しに。段3 でそこだけ流す
  //   チャンネル     <|c0|>..<|c15|> / <|cx|> を窓の先頭に (evex 系で初)
  //   返信の鎖       時間の輪切りに加えてスレッド単位の窓
  //   話者の学習率   件数の幾何平均を基準に ×0.33〜×2.42
  //
  // **channels.json を mimic-v4/ に置くこと。**無いとチャンネルが全部
  // `<|cx|>` に落ちて、足した信号が推論だけ死ぬ (例外は出ない)
  'evex-4': {
    url: process.env.MIMIC_V4_URL ?? 'http://127.0.0.1:8772',
    timeoutMs: number(process.env.MIMIC_V4_TIMEOUT_MS, 60_000),
    maxNewTokens: number(process.env.MIMIC_V4_MAX_NEW_TOKENS, 200),
    label: process.env.MIMIC_V4_LABEL ?? 'evex-4',
    format: process.env.MIMIC_V4_FORMAT ?? 'auto'
  },
  // evex-4 と同じ形・同じ語彙で、コーパスだけ v8 (evex 比率 30% / 連投の分布合わせ /
  // 切り方 8 通り)。**数字は evex-4 の方が良い** (役の噛み合い 53.3% 対 36.7%) が、
  // 切り出しが薄まったのが原因で分かっており、手触りは別に読む価値がある。
  // train-val の差が大きく (2.5067/5.2162)、逐語コピー 0% のまま学習分布に寄っている
  'evex-4.1': {
    url: process.env.MIMIC_V41_URL ?? 'http://127.0.0.1:8773',
    timeoutMs: number(process.env.MIMIC_V41_TIMEOUT_MS, 60_000),
    maxNewTokens: number(process.env.MIMIC_V41_MAX_NEW_TOKENS, 200),
    label: process.env.MIMIC_V41_LABEL ?? 'evex-4.1',
    format: process.env.MIMIC_V41_FORMAT ?? 'auto'
  },
  // **形が初めて変わった世代。**25.8M だが、増えたのは PLE の引き表なので
  // 行列積は 18.88M 世代とほぼ同じ (1 トークン 113 → 117 MFLOP)。
  //
  //   PLE (Gemma 3n)  トークンごと・層ごとの補助ベクトル。容量 +36% / 計算 +3%
  //   QK-norm         q/k を RoPE の前に RMSNorm
  //   Muon            行列 14.75M を直交化して更新。埋め込みは AdamW
  //   WSD             段1 を一定・段2 を減衰相に。途中の重みから分岐できる
  //   文書内マスク     1024 の窓に約 7 会話入るので、前の会話を見せない
  //   <|hi|>          リアクションが付いた発言の印。推論では常に置く
  //
  // **語彙が別物** (corpus-v10 は `<|hi|>` のぶんずれている) ので、
  // mimic-v5/ の tok.model と対で動かすこと
  'evex-5': {
    url: process.env.MIMIC_V5_URL ?? 'http://127.0.0.1:8774',
    timeoutMs: number(process.env.MIMIC_V5_TIMEOUT_MS, 60_000),
    maxNewTokens: number(process.env.MIMIC_V5_MAX_NEW_TOKENS, 200),
    label: process.env.MIMIC_V5_LABEL ?? 'evex-5',
    format: process.env.MIMIC_V5_FORMAT ?? 'auto'
  },
  // evex-5 と**同じ形・同じ技術**で、切り出しの割合だけ evex-4 の値に戻したもの
  // (噛み合い 8.4% → 11.8%)。**狙いは外れた** — 噛み合いは 33.3% → 16.7% と
  // 逆に下がったので、evex-5 が evex-4 に負けている理由は切り出しではない。
  // 読み比べ用に並べてある
  'evex-5.1': {
    url: process.env.MIMIC_V51_URL ?? 'http://127.0.0.1:8775',
    timeoutMs: number(process.env.MIMIC_V51_TIMEOUT_MS, 60_000),
    maxNewTokens: number(process.env.MIMIC_V51_MAX_NEW_TOKENS, 200),
    label: process.env.MIMIC_V51_LABEL ?? 'evex-5.1',
    format: process.env.MIMIC_V51_FORMAT ?? 'auto'
  },
  // **a / b の対照実験は終わった。**同じコーパス (v12) で違うのは
  // Muon / WSD / 文書内マスク の有無だけ、という比較で **a を採った** —
  // b は「うん」「あ」のような相槌で終わる率が高かった。8776 が a。
  // 8777 (b) は落としたので、名前も port も 1 本だけ残す
  'evex-5.2': {
    url: process.env.MIMIC_V52_URL ?? 'http://127.0.0.1:8776',
    timeoutMs: number(process.env.MIMIC_V52_TIMEOUT_MS, 60_000),
    maxNewTokens: number(process.env.MIMIC_V52_MAX_NEW_TOKENS, 200),
    label: process.env.MIMIC_V52_LABEL ?? 'evex-5.2',
    format: process.env.MIMIC_V52_FORMAT ?? 'auto'
  }
};

/** そのエンジンの接続先。知らないものは既定 (evex) に落とす。 */
export function endpointFor(engine) {
  return ENDPOINTS[engine] ?? mimicConfig;
}

/**
 * 自分で配信しているモデルか (= 127.0.0.1 の推論プロセスに投げるか)。
 *
 * ここを判定の唯一の入口にする。呼ぶ側でエンジン名を並べていたら、evex-1 を足した
 * ときに `chosen === 'evex' || chosen === 'evex-ft'` の書き足しを落として、
 * evex-1 を選んだ人が黙って DeepSeek に回っていた (料金も掛かるし、選んだものと
 * 違う答えが返る)。名簿は ENDPOINTS だけにしておけば足し忘れが起きない。
 */
export function isSelfHosted(engine) {
  return Object.hasOwn(ENDPOINTS, String(engine));
}

/**
 * 生成結果からプロンプトぶんを落として、続きだけを取る。
 *
 * `slice(prompt.length)` で済ませていたが、それは**サーバーがプロンプトを一字一句
 * そのまま返す**前提だった。推論サーバーはどちらも窓を超えたプロンプトを左から
 * 捨てる (server.py は context-1、server-ft.py は 1023 トークン)。超えた瞬間に
 * echo がプロンプトより短くなり、slice が空文字を返す。呼び出し側は 3 回引き直して
 * 「何も出てきませんでした」で終わる — **原因がどこにも出ない壊れ方**。
 *
 * 先頭一致で駄目なら末尾側を錨にして探す。先頭側で探すと、同じラベルが何度も
 * 出るプロンプト (なりきりで本人の過去発言を並べる形) で誤爆する。
 */
export function continuationOf(full, prompt) {
  const text = String(full ?? '');
  if (text.startsWith(prompt)) return text.slice(prompt.length);

  // 末尾 64 字を錨にする。窓溢れで頭が削られていても末尾は残っている
  const anchor = prompt.slice(-64);
  const at = anchor ? text.lastIndexOf(anchor) : -1;
  if (at >= 0) return text.slice(at + anchor.length);

  console.warn(
    `推論サーバーの echo がプロンプトと一致しません (prompt ${prompt.length} 字 / `
    + `返り ${text.length} 字)。窓を超えて切られた可能性があります。`
  );
  return '';
}

// speakers.json は使わない。話者は会話ごとの相対トークンになったので、
// Discord の user_id と結びつける表がそもそも要らない。

class MimicError extends Error {
  constructor(message, { down = false } = {}) {
    super(message);
    this.down = down;
  }
}

/**
 * 生成する。prompt は学習時と同じ直列化形式で渡す。
 * 落ちているときは down を立てて返す (呼び出し側で文面を変えたいので)。
 */
export async function generate({
  prompt, maxNewTokens, temperature = 0.9, topK = 40, engine = null,
  stopLabel = null, maxTurns = null
}) {
  const config = endpointFor(engine);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  timer.unref?.();

  try {
    const response = await fetch(`${config.url}/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        prompt,
        max_new_tokens: maxNewTokens ?? config.maxNewTokens,
        temperature,
        top_k: topK,
        // 末尾に置いた話者ラベル。素の日本語形式には終端トークンが無いので、
        // 渡さないと max_new_tokens を必ず使い切る (server-ft.py が他人の発言を
        // 見た時点で打ち切る)。トークン形式の server.py は無視する
        ...(stopLabel ? { stop_label: stopLabel } : {}),
        ...(maxTurns ? { max_turns: maxTurns } : {})
      }),
      signal: controller.signal
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new MimicError(`推論サーバーが ${response.status} を返しました: ${detail.slice(0, 200)}`);
    }

    return await response.json();
  } catch (error) {
    // 立っていない / 応答しないのは「壊れた」ではなく「まだ使えない」なので分ける
    if (error instanceof MimicError) throw error;
    if (error.name === 'AbortError') {
      throw new MimicError('推論が時間内に終わりませんでした。', { down: false });
    }
    throw new MimicError('推論サーバーが起動していません。', { down: true });
  } finally {
    clearTimeout(timer);
  }
}

// サーバーが申告した役の形式。世代が違うトークンを渡さないために使う。
// エンジンごとに別プロセスなので、エンジンごとに覚える。
const schemes = new Map();

/** 役の形式。まだ聞いていなければ /health で取りに行く。 */
export async function roleScheme(engine = null) {
  const key = engine ?? 'evex';
  if (schemes.has(key)) return schemes.get(key);

  const info = await status(engine);
  if (!info.up || !info.roles?.length) return null;

  // speakers は実在の人物に紐づくトークン。持っているのは evex-1 だけ。
  // 申告に無いものを渡さないために、bot 側はここだけを見る
  const found = {
    roles: info.roles,
    overflow: info.overflow,
    speakers: info.speakers ?? [],
    // チャンネルトークン (evex-4 以降)。**申告が空の世代には何も渡さない** —
    // 語彙に無い `<|c0|>` を渡すとバイトに分解されて先頭から形が崩れる
    channels: info.channels ?? [],
    channelOverflow: info.channel_overflow ?? null,
    // リアクションの印 (evex-4.1 以降)。申告が無ければ渡さない
    quality: info.quality ?? null
  };
  schemes.set(key, found);
  return found;
}

/** 生きているか。/model の表示で使う。 */
export async function status(engine = null) {
  const config = endpointFor(engine);
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    timer.unref?.();

    const response = await fetch(`${config.url}/health`, { signal: controller.signal });
    clearTimeout(timer);

    if (!response.ok) return { up: false };
    return { up: true, ...(await response.json()) };
  } catch {
    return { up: false };
  }
}
