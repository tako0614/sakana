// ブラウザの通信の関門の検証 (npm run check からは check-answer.mjs が読み込む。単体でも動く)。
//
// 固定したいのは次の点。
//   A1  DNS リバインディング: Node は公開 IP と答え、Chrome は 127.0.0.1 などの内部へ繋ぐ。
//       URL の検査 (urlguard) だけでは通ってしまうので、Chrome が実際に繋いだ先を見る。
//       Chrome 149 の実測では remoteIPAddress は応答を continue したあとにしか届かない。
//       だから応答の段階では resourceIPAddressSpace で落とし、IP は事後に確かめて tainted にする。
//       ここでは偽の CDP イベントで、その判断が順序に依らず、確かめられないものを通さないことを見る。
//   A2  断る理由に解決先の IP を書かない (名前を渡すだけで内部の DNS を引けてはいけない)
//
// Chrome にも DNS にも繋がない。dns.promises.lookup は差し替える。

import assert from 'node:assert/strict';
import dns from 'node:dns';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'sakana-browser-guard-'));
process.env.DATABASE_PATH ??= join(dir, 'main.sqlite');
process.env.ARCHIVE_DB_PATH ??= join(dir, 'archive.sqlite');
process.env.OPENROUTER_API_KEY ??= 'check';
// 本物の Chrome (9222) に触れないようにする
process.env.AGENT_BROWSER = '0';

const { INTERNAL_REASON, UNRESOLVED_REASON, inspectUrl, isBlockedAddress } = await import('../src/agent/urlguard.js');
const { ResponseGuard, TAINT_REASON, classifyAddressSpace } = await import('../src/agent/netguard.js');
const { watchPopups } = await import('../src/agent/cdp.js');
const { runBrowserAction } = await import('../src/agent/browser.js');

const realLookup = dns.promises.lookup;
const realWarn = console.warn;
const warnings = [];

function stubDns(table) {
  dns.promises.lookup = async (hostname) => {
    const answer = table[hostname];
    if (!answer) throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' });
    return answer.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
  };
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 関門の待ち時間のタイマーは unref してある (本番では他の処理がプロセスを生かす)。
// 検証では待っているあいだにイベントループが空にならないよう、止まらない印を立てておく。
const keepAlive = setInterval(() => {}, 1000);

try {
  console.warn = (...args) => { warnings.push(args.join(' ')); };

  // ---------------------------------------------------------------- A2: 理由に IP を書かない
  stubDns({
    'public.test': ['93.184.216.34'],
    'loopback.test': ['127.0.0.1'],
    'metadata.test': ['169.254.169.254'],
    'lan.test': ['192.168.0.22'],
    'mixed.test': ['93.184.216.34', '10.1.2.3'],
    'v6.test': ['fd00::1234']
  });

  const verdicts = new Map();
  for (const host of ['loopback.test', 'metadata.test', 'lan.test', 'mixed.test', 'v6.test', 'missing.test']) {
    const verdict = await inspectUrl(`http://${host}/`);
    assert.equal(verdict.ok, false, `${host} は断る`);
    verdicts.set(host, verdict.reason);
    assert.doesNotMatch(verdict.reason, /\d+\.\d+\.\d+\.\d+/, `${host}: 理由に IPv4 を書かない`);
    assert.doesNotMatch(verdict.reason, /fd00|::/, `${host}: 理由に IPv6 を書かない`);
  }
  // 「内部を指す」と「引けない」で文が違うと、社内 DNS にその名前があるかを調べられる
  assert.equal(new Set(verdicts.values()).size, 1, `内部宛と解決失敗は同じ文: ${[...new Set(verdicts.values())].join(' | ')}`);
  assert.equal(verdicts.get('loopback.test'), UNRESOLVED_REASON);
  assert.ok(INTERNAL_REASON.length > 0 && !/\d/.test(INTERNAL_REASON));

  // どこに解決されたかはサーバーのログにだけ残る
  assert.ok(
    warnings.some((line) => line.includes('loopback.test') && line.includes('127.0.0.1')),
    `アドレスはログに残す: ${warnings.join(' / ')}`
  );

  assert.deepEqual(await inspectUrl('http://public.test/x'), { ok: true, url: 'http://public.test/x' });
  console.log('urlguard ok (理由に解決先を書かない / 内部宛と解決失敗は同じ文)');

  // ---------------------------------------------------------------- A1: 応答の関門

  /** 送られたコマンドを控えて、購読にイベントを流せる偽の CDP 接続。 */
  class FakeCdp {
    constructor() {
      this.handlers = new Map();
      this.sent = [];
      this.log = [];
      this.failOn = new Map(); // `${method}|${sessionId ?? ''}` -> Error
    }

    send(method, params, _timeoutMs, sessionId) {
      this.sent.push({ method, params, sessionId });
      this.log.push(`send:${method}`);
      const failure = this.failOn.get(`${method}|${sessionId ?? ''}`);
      return failure ? Promise.reject(failure) : Promise.resolve({});
    }

    on(method, handler) {
      this.log.push(`on:${method}`);
      let set = this.handlers.get(method);
      if (!set) this.handlers.set(method, (set = new Set()));
      set.add(handler);
      return () => set.delete(handler);
    }

    /** 購読側の処理が終わるまで待つ (Fetch の返事は非同期)。 */
    async emit(method, params, sessionId) {
      const results = [...(this.handlers.get(method) ?? [])].map((handler) => handler(params, sessionId));
      await Promise.all(results);
    }

    replies(sessionId) {
      return this.sent.filter((entry) => entry.method.startsWith('Fetch.') && entry.method !== 'Fetch.enable' && entry.sessionId === sessionId);
    }

    last(sessionId) {
      return this.replies(sessionId).at(-1);
    }
  }

  // Node の DNS は公開と答える設定の検査。ホスト名 *.test は公開、IP リテラルは本物の判定。
  const inspect = (url) => inspectUrl(url);
  const quick = { extraInfoWaitMs: 40, cacheWaitMs: 15 };

  async function makeGuard(options = {}) {
    const cdp = new FakeCdp();
    const tainted = [];
    const guard = new ResponseGuard(cdp, { inspect, onTaint: (reason) => tainted.push(reason), ...quick, ...options });
    await guard.install();
    return { cdp, guard, tainted };
  }

  const requestPaused = (cdp, { requestId, url, networkId, status, errorReason, resourceType = 'Document' }, sessionId) => cdp.emit('Fetch.requestPaused', {
    requestId,
    request: { url },
    resourceType,
    ...(networkId ? { networkId } : {}),
    ...(status !== undefined ? { responseStatusCode: status } : {}),
    ...(errorReason ? { responseErrorReason: errorReason } : {})
  }, sessionId);

  const extraInfo = (cdp, requestId, space, sessionId) => cdp.emit('Network.responseReceivedExtraInfo', {
    requestId, resourceIPAddressSpace: space, statusCode: 200
  }, sessionId);

  const received = (cdp, url, remoteIPAddress, extra = {}) => cdp.emit('Network.responseReceived', {
    requestId: 'r', response: { url, ...(remoteIPAddress ? { remoteIPAddress } : {}), ...extra }
  });

  // 設置の順序と失敗
  {
    const { cdp } = await makeGuard();
    const firstEnable = cdp.log.findIndex((entry) => entry === 'send:Network.enable');
    for (const method of ['Fetch.requestPaused', 'Network.responseReceivedExtraInfo', 'Network.responseReceived', 'Network.requestWillBeSent', 'Target.attachedToTarget']) {
      const at = cdp.log.indexOf(`on:${method}`);
      assert.ok(at >= 0 && at < firstEnable, `${method} は有効化より先に購読する (止まった要求に返事ができなくなる)`);
    }
    const enable = cdp.sent.find((entry) => entry.method === 'Fetch.enable');
    assert.deepEqual(enable.params.patterns.map((pattern) => pattern.requestStage).sort(), ['Request', 'Response'], 'Request と Response の両方で止める');
    const attach = cdp.sent.find((entry) => entry.method === 'Target.setAutoAttach');
    assert.equal(attach.params.flatten, true);
    assert.equal(attach.params.waitForDebuggerOnStart, true, '子のターゲットは関門を張るまで止めておく');

    const broken = new FakeCdp();
    broken.failOn.set('Fetch.enable|', new Error('no fetch'));
    const guard = new ResponseGuard(broken, { inspect });
    await assert.rejects(guard.install(), /no fetch/, '関門を張れなかったら例外 (検査なしで続けない)');
    assert.equal([...broken.handlers.values()].reduce((sum, set) => sum + set.size, 0), 0, '失敗したら購読も外す');
  }

  // Request の段階
  {
    const { cdp, guard } = await makeGuard();
    await requestPaused(cdp, { requestId: 'a', url: 'https://public.test/' });
    assert.equal(cdp.last().method, 'Fetch.continueRequest');

    await requestPaused(cdp, { requestId: 'b', url: 'http://127.0.0.1:9222/json' });
    assert.equal(cdp.last().method, 'Fetch.failRequest');
    assert.equal(cdp.last().params.errorReason, 'BlockedByClient');

    await requestPaused(cdp, { requestId: 'c', url: 'http://loopback.test/' });
    assert.equal(cdp.last().method, 'Fetch.failRequest', '名前が内部を指すなら Request の段階でも落とす');
    assert.equal(guard.blocked, 2);

    for (const url of ['about:blank', 'data:text/plain,x', 'blob:https://public.test/abc']) {
      await requestPaused(cdp, { requestId: `l-${url}`, url });
      assert.equal(cdp.last().method, 'Fetch.continueRequest', `${url} はネットワークに出ない`);
    }

    // 検査が例外でも通さない
    const broken = await makeGuard({ inspect: async () => { throw new Error('boom'); } });
    await requestPaused(broken.cdp, { requestId: 'e', url: 'https://public.test/' });
    assert.equal(broken.cdp.last().method, 'Fetch.failRequest', '検査に失敗したら断る側に倒す');
  }

  // Response の段階: 空間の分類と、イベントの順序に依らないこと
  assert.equal(classifyAddressSpace('Public'), 'public');
  for (const space of ['Loopback', 'Local', 'Private']) assert.equal(classifyAddressSpace(space), 'internal');
  for (const space of ['Unknown', 'Future', '', undefined, null]) assert.equal(classifyAddressSpace(space), 'unknown');

  for (const [space, expected] of [['Public', 'Fetch.continueResponse'], ['Loopback', 'Fetch.failRequest'], ['Local', 'Fetch.failRequest'], ['Unknown', 'Fetch.failRequest'], ['Future', 'Fetch.failRequest']]) {
    // 情報が先に届く
    const early = await makeGuard();
    await extraInfo(early.cdp, 'n1', space);
    await requestPaused(early.cdp, { requestId: 'p1', url: 'https://public.test/page', networkId: 'n1', status: 200 });
    assert.equal(early.cdp.last().method, expected, `${space}: 情報が先 -> ${expected}`);

    // 応答の段階の方が先に来て、情報が遅れて届く
    const late = await makeGuard({ extraInfoWaitMs: 500 });
    const pending = requestPaused(late.cdp, { requestId: 'p2', url: 'https://public.test/page', networkId: 'n2', status: 200 });
    await wait(15);
    assert.equal(late.cdp.replies().length, 0, `${space}: 情報が届くまで返事をしない`);
    await extraInfo(late.cdp, 'n2', space);
    await pending;
    assert.equal(late.cdp.last().method, expected, `${space}: 情報が後 -> ${expected}`);
  }

  {
    // 内部の応答は本文を渡さずに落とす。リダイレクトの 3xx も同じ段階で落ちるので辿らない
    const { cdp, guard, tainted } = await makeGuard();
    await extraInfo(cdp, 'nr', 'Loopback');
    await requestPaused(cdp, { requestId: 'redir', url: 'https://public.test/go', networkId: 'nr', status: 302 });
    assert.equal(cdp.last().method, 'Fetch.failRequest', '内部が返した 302 は辿らない');
    assert.equal(guard.blocked, 1);
    assert.equal(tainted.length, 0, '応答を落とせたなら本文はページに渡っていない (tainted にはしない)');

    // 公開の 302 の次の段 (同じ networkId) で情報が無ければ、前の値を使い回さず確かめられないとして落とす
    const chain = await makeGuard();
    await extraInfo(chain.cdp, 'nc', 'Public');
    await requestPaused(chain.cdp, { requestId: 'hop1', url: 'https://public.test/a', networkId: 'nc', status: 302 });
    assert.equal(chain.cdp.last().method, 'Fetch.continueResponse');
    await requestPaused(chain.cdp, { requestId: 'hop2', url: 'https://public.test/b', networkId: 'nc', status: 200 });
    assert.equal(chain.cdp.last().method, 'Fetch.failRequest', '1つ前の段の値を使い回さない');

    // 情報が来ない初見の URL は、確かめられないので落とす。見たことのある URL (キャッシュ) は通す
    const cache = await makeGuard();
    await requestPaused(cache.cdp, { requestId: 'u', url: 'https://public.test/new', networkId: 'nu', status: 200 });
    assert.equal(cache.cdp.last().method, 'Fetch.failRequest', '初見で情報が無いものは通さない');
    await extraInfo(cache.cdp, 'n3', 'Public');
    await requestPaused(cache.cdp, { requestId: 'v1', url: 'https://public.test/img.png', networkId: 'n3', status: 200, resourceType: 'Image' });
    await requestPaused(cache.cdp, { requestId: 'v2', url: 'https://public.test/img.png', networkId: 'n4', status: 200, resourceType: 'Image' });
    assert.equal(cache.cdp.last().method, 'Fetch.continueResponse', '検査を通った URL のキャッシュ応答は通す');
    await requestPaused(cache.cdp, { requestId: 'v3', url: 'https://public.test/other.png', networkId: 'n5', status: 200, resourceType: 'Image' });
    assert.equal(cache.cdp.last().method, 'Fetch.failRequest', '別の URL にはその例外は効かない');

    // 通信エラーの応答は渡すものが無い。理由をそのまま返す
    const failed = await makeGuard();
    await requestPaused(failed.cdp, { requestId: 'x', url: 'https://public.test/', networkId: 'nx', errorReason: 'ConnectionRefused' });
    assert.equal(failed.cdp.last().method, 'Fetch.failRequest');
    assert.equal(failed.cdp.last().params.errorReason, 'ConnectionRefused');
    assert.equal(failed.guard.blocked, 0, '通信エラーは遮断に数えない');

    // 運営が内部宛を許している設定では応答も検査しない
    const open = await makeGuard({ allowInternal: true });
    await extraInfo(open.cdp, 'no', 'Loopback');
    await requestPaused(open.cdp, { requestId: 'o', url: 'http://127.0.0.1/', networkId: 'no', status: 200 });
    assert.equal(open.cdp.last().method, 'Fetch.continueResponse');
  }

  // 事後の IP 確認: Chrome が「公開」と分類した範囲に内部アドレスが混ざっていたら tainted
  for (const ip of ['100.64.0.1', '127.0.0.1', '169.254.169.254', '10.0.0.5', '192.168.0.22', '[fe80::1]', '[::1]', '::ffff:7f00:1', '198.18.0.1']) {
    assert.ok(isBlockedAddress(ip), `${ip} は内部`);
    const { cdp, guard, tainted } = await makeGuard();
    await received(cdp, 'https://public.test/', ip);
    assert.equal(guard.taintedReason, TAINT_REASON, `${ip}: 応答が内部から来たら tainted`);
    assert.equal(tainted.length, 1);
    await received(cdp, 'https://public.test/2', ip);
    assert.equal(tainted.length, 1, '通知は1回だけ');
  }
  for (const ip of ['93.184.216.34', '1.1.1.1', '[2606:2800:220:1:248:1893:25c8:1946]', undefined]) {
    const { cdp, guard } = await makeGuard();
    await received(cdp, 'https://public.test/', ip);
    assert.equal(guard.taintedReason, null, `${ip ?? '(IP なし: キャッシュ・data:)'} は tainted にしない`);
  }
  {
    // リダイレクトを返した側の IP は、次の要求のイベントに載る
    const { cdp, guard } = await makeGuard();
    await cdp.emit('Network.requestWillBeSent', {
      requestId: 'q', request: { url: 'https://public.test/next' },
      redirectResponse: { url: 'https://public.test/go', status: 302, remoteIPAddress: '10.1.2.3' }
    });
    assert.equal(guard.taintedReason, TAINT_REASON, 'リダイレクト元が内部なら tainted');

    const open = await makeGuard({ allowInternal: true });
    await received(open.cdp, 'http://127.0.0.1/', '127.0.0.1');
    assert.equal(open.guard.taintedReason, null, '内部宛を許す設定では事後確認もしない');
  }

  // 子のターゲット (別プロセスの iframe / worker)
  {
    const { cdp, guard, tainted } = await makeGuard();
    await cdp.emit('Target.attachedToTarget', { sessionId: 'S1', targetInfo: { type: 'iframe', url: '' }, waitingForDebugger: true });
    const forChild = cdp.sent.filter((entry) => entry.sessionId === 'S1').map((entry) => entry.method);
    assert.deepEqual(forChild, ['Network.enable', 'Fetch.enable', 'Target.setAutoAttach', 'Runtime.runIfWaitingForDebugger'], '子にも同じ関門を張ってから走らせる');
    assert.equal(guard.taintedReason, null);

    // 子で起きた要求には子のセッションで返事をする。親と requestId が同じでも取り違えない
    await requestPaused(cdp, { requestId: 'same', url: 'http://loopback.test/x', resourceType: 'XHR' }, 'S1');
    assert.equal(cdp.last('S1').method, 'Fetch.failRequest');
    assert.equal(cdp.replies(undefined).length, 0, '子の要求に親のセッションで返事をしない');

    await extraInfo(cdp, 'shared-id', 'Loopback', 'S1');
    await extraInfo(cdp, 'shared-id', 'Public', undefined);
    await requestPaused(cdp, { requestId: 'rp1', url: 'https://public.test/p', networkId: 'shared-id', status: 200 }, undefined);
    await requestPaused(cdp, { requestId: 'rp2', url: 'https://public.test/c', networkId: 'shared-id', status: 200 }, 'S1');
    assert.equal(cdp.last(undefined).method, 'Fetch.continueResponse', '親の応答は親の値で判断する');
    assert.equal(cdp.last('S1').method, 'Fetch.failRequest', '子の応答は子の値で判断する');
    assert.equal(tainted.length, 0);

    // worker は Fetch ドメインを持たない。失敗しても許すが、走らせる (止めたままにしない)
    const worker = await makeGuard();
    worker.cdp.failOn.set('Fetch.enable|W1', new Error("'Fetch.enable' wasn't found"));
    await worker.cdp.emit('Target.attachedToTarget', { sessionId: 'W1', targetInfo: { type: 'worker' }, waitingForDebugger: true });
    assert.equal(worker.guard.taintedReason, null, 'worker は Fetch が無くてもよい');
    assert.ok(worker.cdp.sent.some((entry) => entry.method === 'Runtime.runIfWaitingForDebugger' && entry.sessionId === 'W1'));

    // iframe に関門を張れなかったら、そこに何が読み込まれるか分からない。ページを返さない
    const broken = await makeGuard();
    broken.cdp.failOn.set('Fetch.enable|S2', new Error('cannot enable'));
    await broken.cdp.emit('Target.attachedToTarget', { sessionId: 'S2', targetInfo: { type: 'iframe' }, waitingForDebugger: true });
    assert.equal(broken.guard.taintedReason, TAINT_REASON, '見張れない iframe があるページは返さない');
    assert.ok(broken.cdp.sent.some((entry) => entry.method === 'Runtime.runIfWaitingForDebugger' && entry.sessionId === 'S2'), '失敗しても走らせる');
  }
  console.log('response guard ok (応答の段階で空間を見る / 順序に依らない / 確かめられないものを通さない / 事後に IP / 子のターゲット)');

  // ---------------------------------------------------------------- ポップアップ
  {
    const cdp = new FakeCdp();
    const stop = await watchPopups(cdp, 'ctx-1');
    const created = (info) => cdp.emit('Target.targetCreated', { targetInfo: info });
    await created({ targetId: 't-own', type: 'page', browserContextId: 'ctx-1' });
    await created({ targetId: 't-other-ctx', type: 'page', browserContextId: 'ctx-2', openerId: 'x' });
    await created({ targetId: 't-frame', type: 'iframe', browserContextId: 'ctx-1', openerId: 'x' });
    await created({ targetId: 't-popup', type: 'page', browserContextId: 'ctx-1', openerId: 'tab' });
    const closed = cdp.sent.filter((entry) => entry.method === 'Target.closeTarget').map((entry) => entry.params.targetId);
    assert.deepEqual(closed, ['t-popup'], '自分で作ったタブと他のコンテキストは閉じない。opener 付きのページだけ閉じる');
    assert.ok(cdp.sent.some((entry) => entry.method === 'Target.setDiscoverTargets'));
    stop();
    await created({ targetId: 't-popup-2', type: 'page', browserContextId: 'ctx-1', openerId: 'tab' });
    assert.equal(cdp.sent.filter((entry) => entry.method === 'Target.closeTarget').length, 1, '解除したら閉じない');
  }
  console.log('popup guard ok');

  // ---------------------------------------------------------------- browser.ts: tainted なら何も返さない
  {
    const ctx = {
      browserFull: false,
      screenshots: [Buffer.from('keep')],
      browser: { contextId: 'c', sandboxTargetId: 't', opened: [], tainted: TAINT_REASON }
    };
    // Chrome に触る前に返す (ここでは繋ぐ先が無い)
    for (const action of ['open', 'text', 'html', 'links', 'screenshot', 'search', 'reload']) {
      assert.equal(await runBrowserAction(ctx, { action, url: 'https://public.test/', query: 'x' }), TAINT_REASON, `${action}: tainted なら理由だけ返す`);
    }
    assert.equal(ctx.screenshots.length, 1, '画像も増やさない');
    // 権限の判定は tainted より先 (操作系を許していない人には従来どおりの断り)
    assert.match(await runBrowserAction(ctx, { action: 'eval', expression: '1' }), /権限が必要/);
  }
  console.log('tainted gate ok');
} finally {
  clearInterval(keepAlive);
  dns.promises.lookup = realLookup;
  console.warn = realWarn;
}

console.log('browser guard ok');
