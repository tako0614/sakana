// 自作モデルの推論プロセスに投げる。
//
// bot と同じプロセスで回さないのは、CPU 推論がイベントループを止めて Discord の
// REST が全部落ちるから (チャンク生成で 28 秒固めたのと同じ形)。
// 別プロセスにしておけば、推論が固まっても bot は生きている。
//
// 127.0.0.1 だけで待ち受ける。エージェントの browser ツールは urlguard が
// ループバックを塞いでいるので、SSRF でここに到達する経路は無い。
//
// 別の機械に置くときは、サーバー側が MIMIC_SERVER_TOKEN を必須にする (server.py)。
// bot 側も同じ env を持てば Authorization ヘッダで送る。ループバックだけなら要らない。

const number = (value: unknown, fallback: number): number => (Number.isFinite(Number(value)) ? Number(value) : fallback);

/** 世代ごとの接続先。 */
export interface EndpointConfig {
  url: string;
  timeoutMs: number;
  maxNewTokens: number;
  label: string;
  format: string;
}

/** /generate の返り。text 以外はサーバーの申告 (/health と同じもの) をそのまま持つ。 */
export interface GenerateResult {
  text: string;
  [key: string]: unknown;
}

/** /health の返り。落ちていれば up だけ。 */
export interface HealthStatus {
  up: boolean;
  [key: string]: unknown;
}

/** サーバーが申告した役の形式 (roleScheme)。 */
export interface ServerScheme {
  roles: string[];
  overflow: string | null;
  speakers: string[];
  channels: string[];
  channelOverflow: string | null;
  quality: string | null;
}

export interface GenerateOptions {
  prompt: string;
  maxNewTokens?: number | null;
  temperature?: number;
  topK?: number;
  engine?: string | null;
  stopLabel?: string | null;
  maxTurns?: number | null;
}

// 残っている自作モデルは evex-3.5 だけ (2026-10-17 に他の世代を廃止した。メモリを空けるため)。
// 18.9M / 語彙 12288 / 二段学習 (公開のなりきり掲示板で土台を作ってから、このサーバーだけで仕上げたもの)。
export const mimicConfig: EndpointConfig = {
  url: process.env.MIMIC_V35_URL ?? 'http://127.0.0.1:8771',
  timeoutMs: number(process.env.MIMIC_V35_TIMEOUT_MS, 60_000),
  maxNewTokens: number(process.env.MIMIC_V35_MAX_NEW_TOKENS, 200),
  // 返答の末尾に出す名前。世代が上がったら env で差し替える。
  label: process.env.MIMIC_V35_LABEL ?? 'evex-3.5',
  // 直列化の形式。tokens は独自の制御記号、plain は素の日本語。既定は /health の申告から判定する
  format: process.env.MIMIC_V35_FORMAT ?? 'auto'
};

/**
 * 世代ごとの接続先。**別プロセス・別ポートで並走させる**ので、まとめて持つ。
 *
 * いまは evex-3.5 だけ。ほかの世代 (evex-1・2・3・4・4.1・5・5.1・5.2・5.3・ft-1〜3) は 2026-10-17 に廃止して、
 * 推論サーバーを止めた。選んでいた人は prefs.ts の RENAMED で evex-3.5 に読み替える。
 * 世代を足すときは、ここに足せば名簿 (isSelfHosted) も /model の一覧も追随する (deploy/add-engine.sh)。
 *
 * format を env で固定できるようにしてあるのは、llama.cpp で配信するモデルは server.py の /health が無く、
 * 申告から判定できないから。取り違えるとモデルが一度も見ていない入力を受け取り、例外を出さずに静かに崩れる。
 */
export const ENDPOINTS: Record<string, EndpointConfig> = {
  'evex-3.5': mimicConfig
};

/** そのエンジンの接続先。知らないものは既定 (evex-3.5) に落とす。 */
export function endpointFor(engine: unknown): EndpointConfig {
  // 継承プロパティ (`toString` など) を接続先と取り違えないよう、自前のキーだけ引く
  return typeof engine === 'string' && Object.hasOwn(ENDPOINTS, engine) ? ENDPOINTS[engine] ?? mimicConfig : mimicConfig;
}

/**
 * 表示に出してよい形の接続先。URL に利用者名やパスワードが埋めてあれば落とす
 * (/model の表示は誰でも見られる)。埋めていなければ設定の文字列そのまま。
 */
export function publicUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (!parsed.username && !parsed.password) return url;
    parsed.username = '';
    parsed.password = '';
    return parsed.origin;
  } catch {
    return url;
  }
}

// 推論サーバーの合言葉。**値はログにも表示にも出さない。**
function authHeaders(): Record<string, string> {
  const token = process.env.MIMIC_SERVER_TOKEN;
  return token ? { authorization: `Bearer ${token}` } : {};
}

/**
 * 自分で配信しているモデルか (= 127.0.0.1 の推論プロセスに投げるか)。
 *
 * ここを判定の唯一の入口にする。呼ぶ側でエンジン名を並べていたら、evex-1 を足した
 * ときに `chosen === 'evex' || chosen === 'evex-ft'` の書き足しを落として、
 * evex-1 を選んだ人が黙って DeepSeek に回っていた (料金も掛かるし、選んだものと
 * 違う答えが返る)。名簿は ENDPOINTS だけにしておけば足し忘れが起きない。
 */
export function isSelfHosted(engine: unknown): boolean {
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
export function continuationOf(full: unknown, prompt: string): string {
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

// --- 同時に回す数 ---
//
// CPU 推論はコアを張り付かせるので、bot 全体で同時に1件だけ通す。
// 待たせる方が、全員ぶん遅くするより素直。
//
// **返答 (respond.ts) と /mimic (command.ts) で同じ枠を使う。**返答の側だけが数えて
// いたので、/mimic は連打しただけ推論が積み上がった (1回で最大 3 回引き直し、
// それぞれ 60 秒まで待つ)。その間は返答も全部詰まる。
const MAX_CONCURRENT = 1;
let running = 0;

/** 推論の枠を取る。空いていなければ false (呼んだ側で断る)。 */
export function tryAcquireSlot(): boolean {
  if (running >= MAX_CONCURRENT) return false;
  running += 1;
  return true;
}

/** tryAcquireSlot で取った枠を返す。必ず finally で呼ぶ。 */
export function releaseSlot(): void {
  running = Math.max(0, running - 1);
}

// speakers.json は使わない。話者は会話ごとの相対トークンになったので、
// Discord の user_id と結びつける表がそもそも要らない。

export class MimicError extends Error {
  down: boolean;

  constructor(message: string, { down = false }: { down?: boolean } = {}) {
    super(message);
    this.down = down;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isAbortError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'name' in error && error.name === 'AbortError';
}

const stringList = (value: unknown): string[] =>
  (Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []);
const stringOrNull = (value: unknown): string | null => (typeof value === 'string' ? value : null);

/**
 * 生成する。prompt は学習時と同じ直列化形式で渡す。
 * 落ちているときは down を立てて返す (呼び出し側で文面を変えたいので)。
 */
export async function generate({
  prompt, maxNewTokens, temperature = 0.9, topK = 40, engine = null,
  stopLabel = null, maxTurns = null
}: GenerateOptions): Promise<GenerateResult> {
  const config = endpointFor(engine);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  timer.unref?.();

  try {
    const response = await fetch(`${config.url}/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeaders() },
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

    // 形は保証されないので text だけ確かめる。無ければ空 (続きが取れない扱いになる)
    const payload: unknown = await response.json();
    const fields = isRecord(payload) ? payload : {};
    return { ...fields, text: typeof fields.text === 'string' ? fields.text : '' };
  } catch (error) {
    // 立っていない / 応答しないのは「壊れた」ではなく「まだ使えない」なので分ける
    if (error instanceof MimicError) throw error;
    if (isAbortError(error)) {
      throw new MimicError('推論が時間内に終わりませんでした。', { down: false });
    }
    throw new MimicError('推論サーバーが起動していません。', { down: true });
  } finally {
    clearTimeout(timer);
  }
}

// サーバーが申告した役の形式。世代が違うトークンを渡さないために使う。
// エンジンごとに別プロセスなので、エンジンごとに覚える。
const schemes = new Map<string, ServerScheme>();

/** 役の形式。まだ聞いていなければ /health で取りに行く。 */
export async function roleScheme(engine: string | null = null): Promise<ServerScheme | null> {
  const key = engine ?? 'evex-3.5';
  const known = schemes.get(key);
  if (known) return known;

  const info = await status(engine);
  const roles = stringList(info.roles);
  if (!info.up || !roles.length) return null;

  // speakers は実在の人物に紐づくトークン。持っているのは evex-1 だけ。
  // 申告に無いものを渡さないために、bot 側はここだけを見る
  const found: ServerScheme = {
    roles,
    overflow: stringOrNull(info.overflow),
    speakers: stringList(info.speakers),
    // チャンネルトークン (evex-4 以降)。**申告が空の世代には何も渡さない** —
    // 語彙に無い `<|c0|>` を渡すとバイトに分解されて先頭から形が崩れる
    channels: stringList(info.channels),
    channelOverflow: stringOrNull(info.channel_overflow),
    // リアクションの印 (evex-4.1 以降)。申告が無ければ渡さない
    quality: stringOrNull(info.quality)
  };
  schemes.set(key, found);
  return found;
}

/** 生きているか。/model の表示で使う。 */
export async function status(engine: string | null = null): Promise<HealthStatus> {
  const config = endpointFor(engine);
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    timer.unref?.();

    const response = await fetch(`${config.url}/health`, { headers: authHeaders(), signal: controller.signal });
    clearTimeout(timer);

    if (!response.ok) return { up: false };
    // 申告はそのまま持つ (epoch / val_loss / format などを表示に使う)。up はこちらで決める
    const info: unknown = await response.json();
    return { ...(isRecord(info) ? info : {}), up: true };
  } catch {
    return { up: false };
  }
}
