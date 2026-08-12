// 自作モデルの推論プロセスに投げる。
//
// bot と同じプロセスで回さないのは、CPU 推論がイベントループを止めて Discord の
// REST が全部落ちるから (チャンク生成で 28 秒固めたのと同じ形)。
// 別プロセスにしておけば、推論が固まっても bot は生きている。
//
// 127.0.0.1 だけで待ち受ける。エージェントの browser ツールは urlguard が
// ループバックを塞いでいるので、SSRF でここに到達する経路は無い。

import { readFileSync } from 'node:fs';
import path from 'node:path';

const number = (value, fallback) => (Number.isFinite(Number(value)) ? Number(value) : fallback);

export const mimicConfig = {
  url: process.env.MIMIC_URL ?? 'http://127.0.0.1:8765',
  timeoutMs: number(process.env.MIMIC_TIMEOUT_MS, 60_000),
  corpusDir: process.env.MIMIC_CORPUS_DIR ?? 'corpus',
  maxNewTokens: number(process.env.MIMIC_MAX_NEW_TOKENS, 200)
};

/**
 * Discord の user_id → 話者トークンの順位。
 *
 * corpus/speakers.json は build-corpus.mjs が書く。上位48人だけ固有トークンを
 * 持っていて、それ以外は <|other|> になる (2,647 人ぶんの語彙は持てない)。
 */
let speakerMap = null;

function speakers() {
  if (speakerMap) return speakerMap;

  speakerMap = new Map();
  try {
    const file = path.join(mimicConfig.corpusDir, 'speakers.json');
    for (const entry of JSON.parse(readFileSync(file, 'utf8'))) {
      if (entry.userId) speakerMap.set(String(entry.userId), entry);
    }
  } catch {
    // 学習前・コーパス未生成でも bot は動く。話者指定が効かないだけ。
  }
  return speakerMap;
}

/** その人に固有の話者トークンがあるか。無ければ <|other|> 扱いになる。 */
export function speakerFor(userId) {
  return speakers().get(String(userId)) ?? null;
}

export function speakerList() {
  return [...speakers().values()];
}

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
