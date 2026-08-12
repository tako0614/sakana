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
  // 返答の末尾に出す名前。世代が上がったら env で差し替える
  label: process.env.MIMIC_LABEL ?? 'evex-1',
  // 直列化の形式。tokens は独自の制御記号 (evex-1 / evex-2)、plain は素の日本語
  // (evex-ft-1)。既定は /health の申告から判定する
  format: process.env.MIMIC_FORMAT ?? 'auto'
};

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
export async function generate({ prompt, maxNewTokens, temperature = 0.9, topK = 40 }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), mimicConfig.timeoutMs);
  timer.unref?.();

  try {
    const response = await fetch(`${mimicConfig.url}/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        prompt,
        max_new_tokens: maxNewTokens ?? mimicConfig.maxNewTokens,
        temperature,
        top_k: topK
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
let scheme = null;

/** 役の形式。まだ聞いていなければ /health で取りに行く。 */
export async function roleScheme() {
  if (scheme) return scheme;

  const info = await status();
  if (!info.up || !info.roles?.length) return null;

  // speakers は実在の人物に紐づくトークン。持っているのは evex-1 だけ。
  // 申告に無いものを渡さないために、bot 側はここだけを見る
  scheme = { roles: info.roles, overflow: info.overflow, speakers: info.speakers ?? [] };
  return scheme;
}

/** 生きているか。/model の表示で使う。 */
export async function status() {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    timer.unref?.();

    const response = await fetch(`${mimicConfig.url}/health`, { signal: controller.signal });
    clearTimeout(timer);

    if (!response.ok) return { up: false };
    return { up: true, ...(await response.json()) };
  } catch {
    return { up: false };
  }
}
