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
  // 中身は 12 epoch / val 4.0613 の evex-2 (ckpt を差し替え済み)
  label: process.env.MIMIC_LABEL ?? 'evex-2-preview',
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
    label: process.env.MIMIC_FT_LABEL ?? 'evex-ft-1-preview',
    format: process.env.MIMIC_FT_FORMAT ?? 'plain'
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
  const found = { roles: info.roles, overflow: info.overflow, speakers: info.speakers ?? [] };
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
