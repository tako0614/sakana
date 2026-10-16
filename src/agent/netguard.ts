// 隔離ブラウザの通信の関門。DNS リバインディングで内部ネットワークに届かせないための層。
//
// urlguard.ts は URL のホスト名を Node の dns.lookup で引いて内部宛を断る。けれど実際に
// 接続するのは Chrome で、Chrome は自分でもう一度名前を引く。攻撃者の DNS が「Node には公開 IP、
// Chrome には 127.0.0.1 / 169.254.169.254 / 192.168.x.x」と答え分けると、検査を通ったまま
// 内部へ繋がる (Chrome 自身の CDP ポート 9222 や社内の管理画面)。URL を検査するだけでは足りず、
// Chrome が実際に繋いだ先を見るしかない。
//
// 実際に繋いだ先が分かるのはいつか (Chrome 149 で実測した):
//   - Network.responseReceived の response.remoteIPAddress は正確な IP を持つが、届くのは
//     Fetch.requestPaused (Response の段階) を continue したあと。止めたままでは来ない。
//     つまり「IP を見てから応答を止める」はできない。
//   - Network.responseReceivedExtraInfo の resourceIPAddressSpace (Loopback / Local / Public) は
//     Response の段階の直前 (ほぼ同時) に届く。IP そのものではないが、内部か公開かの区別はつく。
//     ネットワークを使わないキャッシュ応答には付かない。
// そこで二段に分ける:
//   1. Response の段階: 空間が Loopback / Local の応答は Fetch.failRequest で落とす。ページの
//      JS には本文が一切渡らない (リダイレクトの 3xx も同じ段階で落ちるので辿らない)。
//      空間が分からない応答は、以前に検査を通った URL (= キャッシュ) だけ通す。
//   2. continue のあとに届く remoteIPAddress を isBlockedAddress で正確に確かめ、
//      Chrome が「公開」と分類した範囲に内部アドレスが混ざっていたら tainted にする
//      (以後このページの本文もスクリーンショットも返さない)。
//
// 見張る範囲: 文書・サブリソース・リダイレクト・別プロセスの iframe (Target.setAutoAttach で
// 子のセッションにも同じ関門を張る)・専用 worker (親のセッションで見える)。
// 見張れない範囲: WebSocket / WebTransport と、Fetch ドメインを持たない shared / service worker。
// これらは Chrome のローカルネットワークアクセス制限に任せる (公開ページから内部への接続は
// 許可が要る)。ここで塞げると書かないこと。

import type { CdpConnection } from './cdp.js';
import { isBlockedAddress, type UrlVerdict } from './urlguard.js';
import { isRecord, recordField, stringField } from './types.js';

/** CdpSession が満たす最小の形。検証では偽物を渡す。 */
export type GuardCdp = CdpConnection;

export interface GuardOptions {
  /** Request の段階の検査 (URL を解決して内部宛を断る)。urlguard.inspectUrl を渡す。 */
  inspect: (url: string) => Promise<UrlVerdict>;
  /** 運営が AGENT_BROWSER_ALLOW_LOCAL で内部宛を許しているとき。応答の検査もしない。 */
  allowInternal?: boolean;
  /** 初めて見る URL で、繋いだ先の情報が届くのを待つ上限。超えたら断る (確かめられないものは通さない)。 */
  extraInfoWaitMs?: number;
  /** 以前に検査を通った URL で待つ上限。超えたらキャッシュから返った応答とみなして通す。 */
  cacheWaitMs?: number;
  /** 内部アドレスから応答が来たことが分かったとき。 */
  onTaint?: (reason: string) => void;
}

export type AddressSpaceClass = 'public' | 'internal' | 'unknown';

/** Chrome の resourceIPAddressSpace を、通す / 断る / 判断できない に分ける。 */
export function classifyAddressSpace(space: unknown): AddressSpaceClass {
  switch (space) {
    case 'Public':
      return 'public';
    case 'Loopback':
    case 'Local':
    case 'Private':
      return 'internal';
    default:
      // 新しい値や Unknown。公開と言い切れないものは通さない。
      return 'unknown';
  }
}

export const TAINT_REASON = '内部ネットワークから応答があったため、このページの内容は返しません。';

const FETCH_PATTERNS = [
  { urlPattern: '*', requestStage: 'Request' },
  { urlPattern: '*', requestStage: 'Response' }
];

const AUTO_ATTACH = { autoAttach: true, waitForDebuggerOnStart: true, flatten: true };

// ネットワークに出ない URL。Fetch は data: を止めないが、about: / blob: は止まることがある。
const LOCAL_ONLY_URL = /^(?:about:|data:|blob:)/i;

// Fetch ドメインを持たないターゲット。通信は親のセッションで見える (専用 worker) か、見張れない。
const WORKER_TYPES = new Set(['worker', 'shared_worker', 'service_worker']);

const MAX_PENDING_SPACES = 1000;
const MAX_VERIFIED_URLS = 2000;

function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return '(不明な URL)';
  }
}

export class ResponseGuard {
  private readonly cdp: GuardCdp;
  private readonly inspect: (url: string) => Promise<UrlVerdict>;
  private readonly allowInternal: boolean;
  private readonly extraInfoWaitMs: number;
  private readonly cacheWaitMs: number;
  private readonly onTaint: ((reason: string) => void) | undefined;

  // `${sessionId}\0${requestId}` -> resourceIPAddressSpace。Response の段階で一度だけ読む。
  private readonly spaces = new Map<string, string>();
  private readonly waiters = new Map<string, (space: string | undefined) => void>();
  // 応答が検査を通った URL。ネットワークを使わない応答 (キャッシュ) はこれにある URL だけ通す。
  private readonly verified = new Set<string>();
  private stops: (() => void)[] = [];

  /** 内部アドレスからの応答が確認されたら理由が入る。入ったら本文も画像も返さない。 */
  taintedReason: string | null = null;
  /** 関門が落とした要求の数。操作の前後で比べて「遮断が起きたか」を見る。 */
  blocked = 0;

  constructor(cdp: GuardCdp, options: GuardOptions) {
    this.cdp = cdp;
    this.inspect = options.inspect;
    this.allowInternal = options.allowInternal ?? false;
    this.extraInfoWaitMs = options.extraInfoWaitMs ?? 3000;
    this.cacheWaitMs = options.cacheWaitMs ?? 250;
    this.onTaint = options.onTaint;
  }

  /**
   * 関門を張る。張れなかったら例外を投げる (呼び出し側はブラウザを使わせない)。
   * 検査なしで続けると、それが抜け道になる。
   */
  async install(): Promise<void> {
    // 購読は有効化より先。有効化した瞬間から Fetch は返事を待って止まる。
    this.stops = [
      this.cdp.on('Fetch.requestPaused', (params, sessionId) => this.onPaused(params, sessionId)),
      this.cdp.on('Network.responseReceivedExtraInfo', (params, sessionId) => this.onExtraInfo(params, sessionId)),
      this.cdp.on('Network.responseReceived', (params) => this.onReceived(params)),
      this.cdp.on('Network.requestWillBeSent', (params) => this.onRequestSent(params)),
      this.cdp.on('Target.attachedToTarget', (params) => this.onAttached(params))
    ];

    try {
      await this.cdp.send('Network.enable');
      await this.cdp.send('Fetch.enable', { patterns: FETCH_PATTERNS });
      await this.cdp.send('Target.setAutoAttach', AUTO_ATTACH);
    } catch (error) {
      this.dispose();
      throw error;
    }
  }

  dispose(): void {
    for (const stop of this.stops) stop();
    this.stops = [];
    for (const wake of this.waiters.values()) wake(undefined);
    this.waiters.clear();
  }

  private key(sessionId: string | undefined, requestId: string): string {
    return `${sessionId ?? ''}\0${requestId}`;
  }

  // ---------------------------------------------------------------- 繋いだ先の情報

  private onExtraInfo(params: unknown, sessionId: string | undefined): void {
    const requestId = stringField(params, 'requestId');
    const space = stringField(params, 'resourceIPAddressSpace');
    if (!requestId || space === undefined) return;

    const key = this.key(sessionId, requestId);
    const wake = this.waiters.get(key);
    if (wake) {
      this.waiters.delete(key);
      wake(space);
      return;
    }

    this.spaces.set(key, space);
    // 読まれないまま溜まらないように古いものから捨てる (Map は挿入順)
    if (this.spaces.size > MAX_PENDING_SPACES) {
      const oldest = this.spaces.keys().next();
      if (!oldest.done) this.spaces.delete(oldest.value);
    }
  }

  /** 読んだら消す。リダイレクトは同じ requestId で次の段が来るので、古い値を残さない。 */
  private waitForSpace(key: string, ms: number): Promise<string | undefined> {
    const known = this.spaces.get(key);
    if (known !== undefined) {
      this.spaces.delete(key);
      return Promise.resolve(known);
    }

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.waiters.delete(key);
        resolve(undefined);
      }, ms);
      timer.unref?.();

      this.waiters.set(key, (space) => {
        clearTimeout(timer);
        resolve(space);
      });
    });
  }

  // ---------------------------------------------------------------- 止めた要求への返事

  private async onPaused(params: unknown, sessionId: string | undefined): Promise<void> {
    if (!isRecord(params)) return;

    const requestId = stringField(params, 'requestId');
    if (!requestId) return;

    const url = stringField(recordField(params, 'request'), 'url') ?? '';
    const errorReason = stringField(params, 'responseErrorReason');
    const isResponse = params.responseStatusCode !== undefined || errorReason !== undefined;

    // 通信が失敗した応答には渡して困るものが無い。失敗のまま返す。
    if (errorReason !== undefined) {
      await this.cdp.send('Fetch.failRequest', { requestId, errorReason }, undefined, sessionId).catch(() => {});
      return;
    }

    // 判定に失敗したら断る側へ倒す (確かめられないものは通さない)。
    let allow = false;
    try {
      allow = isResponse
        ? await this.allowResponse(url, stringField(params, 'networkId'), sessionId)
        : await this.allowRequest(url);
    } catch {
      allow = false;
    }

    if (!allow) {
      this.blocked += 1;
      await this.cdp
        .send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' }, undefined, sessionId)
        .catch(() => {});
      return;
    }

    await this.cdp
      .send(isResponse ? 'Fetch.continueResponse' : 'Fetch.continueRequest', { requestId }, undefined, sessionId)
      .catch(() => {});
  }

  /** Request の段階。名前を引いて内部宛なら断る。ここは Chrome の再解決を防げない (下の段が受け持つ)。 */
  private async allowRequest(url: string): Promise<boolean> {
    if (LOCAL_ONLY_URL.test(url)) return true;
    return (await this.inspect(url)).ok;
  }

  /** Response の段階。Chrome が実際に繋いだ先の空間で決める。 */
  private async allowResponse(url: string, networkId: string | undefined, sessionId: string | undefined): Promise<boolean> {
    if (LOCAL_ONLY_URL.test(url) || this.allowInternal) return true;

    const seen = this.verified.has(url);
    const space = networkId === undefined
      ? undefined
      : await this.waitForSpace(this.key(sessionId, networkId), seen ? this.cacheWaitMs : this.extraInfoWaitMs);

    // 繋いだ先の情報が無い = ネットワークを使っていない (キャッシュ)。以前に検査を通った
    // URL の応答だけがそうなりうる。初めて見る URL で情報が来なければ確かめられない。
    if (space === undefined) return seen;

    const kind = classifyAddressSpace(space);
    if (kind === 'internal') {
      console.warn(`Browser response refused: ${originOf(url)} answered from an internal address space (${space}).`);
      return false;
    }
    if (kind === 'unknown') {
      console.warn(`Browser response refused: ${originOf(url)} answered from an unclassified address space (${space}).`);
      return false;
    }

    this.verified.add(url);
    if (this.verified.size > MAX_VERIFIED_URLS) {
      const oldest = this.verified.values().next();
      if (!oldest.done) this.verified.delete(oldest.value);
    }
    return true;
  }

  // ---------------------------------------------------------------- 正確な IP の事後確認

  private onReceived(params: unknown): void {
    const response = recordField(params, 'response');
    this.checkRemote(stringField(response, 'remoteIPAddress'), stringField(response, 'url'));
  }

  /** リダイレクトを返した側の IP は、次の要求のイベントに redirectResponse として載る。 */
  private onRequestSent(params: unknown): void {
    const redirected = recordField(params, 'redirectResponse');
    this.checkRemote(stringField(redirected, 'remoteIPAddress'), stringField(redirected, 'url'));
  }

  private checkRemote(ip: string | undefined, url: string | undefined): void {
    // data: やキャッシュ・service worker の応答には IP が無い。ここは二段目の確認で、
    // 一段目 (空間) を通ったものに内部アドレスが混ざっていないかだけを見る。
    if (!ip || this.allowInternal || !isBlockedAddress(ip)) return;

    console.warn(`Browser response came from an internal address and the page is discarded: ${originOf(url ?? '')} (${ip}).`);
    this.taint();
  }

  private taint(): void {
    if (this.taintedReason !== null) return;
    this.taintedReason = TAINT_REASON;
    this.onTaint?.(TAINT_REASON);
  }

  // ---------------------------------------------------------------- 子のターゲット

  /**
   * iframe (別プロセスになるもの) や worker が付いたとき、同じ関門をそこにも張る。
   * waitForDebuggerOnStart で止まっているので、有効化が済むまで子は何も読み込まない。
   */
  private async onAttached(params: unknown): Promise<void> {
    const sessionId = stringField(params, 'sessionId');
    if (!sessionId) return;

    const type = stringField(recordField(params, 'targetInfo'), 'type') ?? '';
    // worker は Fetch ドメインを持たない。専用 worker の通信は親のセッションに出てくる。
    const guardable = !WORKER_TYPES.has(type);

    try {
      await this.cdp.send('Network.enable', undefined, undefined, sessionId).catch((error: unknown) => {
        if (guardable) throw error;
      });
      await this.cdp.send('Fetch.enable', { patterns: FETCH_PATTERNS }, undefined, sessionId).catch((error: unknown) => {
        if (guardable) throw error;
      });
      await this.cdp.send('Target.setAutoAttach', AUTO_ATTACH, undefined, sessionId).catch((error: unknown) => {
        if (guardable) throw error;
      });
    } catch (error) {
      // 見張れない子が走り出す。そこに何が読み込まれるか分からないので、このページは返さない。
      console.warn(`Browser child target (${type}) could not be guarded: ${error instanceof Error ? error.message : String(error)}`);
      this.taint();
    } finally {
      await this.cdp.send('Runtime.runIfWaitingForDebugger', undefined, undefined, sessionId).catch(() => {});
    }
  }
}
