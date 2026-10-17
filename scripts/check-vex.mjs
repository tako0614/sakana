// vex (名前が出たらメンション扱い or 文脈で判定・呼ばれていない会話に自分から入る) の検査。
//
// 判定モデルの API は偽のサーバーで立てる (本物は叩かない)。見ているのは次の点:
//   - 名前の検出: 英字の単語としてだけ。コード・URL・引用・別の単語の中は呼びではない
//   - 名前の扱いは VEX_CALL で切り替わる: mention (既定の 1) = メンション扱いで確定 / judge = 判定モデルが文脈で決める
//   - state が、評価に使った形 (scripts/vex/questions.mjs) と同じ
//   - 自発参加の門: 許可チャンネル・相槌/短文/返信/他人宛て/NSFW・冷却・1時間の上限・1日の費用
//   - 閾値、静かになるまで待つ、会話が進んだら入らない、bot の発言でタイマーを捨てる
//   - API が落ちても入らないだけ (例外にしない)。混んだら次のモデルへ回る

import http from 'node:http';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

const dbPath = `${tmpdir()}/sakana-vex-check-${process.pid}.sqlite`;
process.env.DATABASE_PATH = dbPath;
process.env.ARCHIVE_DB_PATH = `${dbPath}.archive`;
process.env.OPENROUTER_API_KEY = 'check';
process.env.VEX_CALL = '1';
for (const base of [dbPath, `${dbPath}.archive`]) for (const suffix of ['', '-wal', '-shm']) rmSync(`${base}${suffix}`, { force: true });
process.on('exit', () => {
  for (const base of [dbPath, `${dbPath}.archive`]) for (const suffix of ['', '-wal', '-shm']) rmSync(`${base}${suffix}`, { force: true });
});

function fail(message) {
  throw new Error(message);
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// --- 偽の Decisions API ---

const api = {
  calls: [],
  /** (model, body) => { status, p, cost } */
  respond: () => ({ status: 200, p: 0.9, cost: 0.000003 }),
  onCall: null
};
const server = http.createServer((request, response) => {
  let raw = '';
  request.on('data', (chunk) => { raw += chunk; });
  request.on('end', () => {
    const body = JSON.parse(raw);
    api.calls.push({ auth: request.headers.authorization, body });
    api.onCall?.(body);
    const answer = api.respond(body.model, body);
    response.statusCode = answer.status;
    response.setHeader('content-type', 'application/json');
    if (answer.status !== 200) return response.end(JSON.stringify({ error: 'x' }));
    if (answer.malformed) return response.end(JSON.stringify({ answers: {} }));
    response.end(JSON.stringify({ answers: { join: { noul: answer.p } }, usage: { input_tokens: 300, output_tokens: 1, cost: answer.cost ?? 0 } }));
  });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const endpoint = `http://127.0.0.1:${server.address().port}/api/alpha/decisions`;
process.env.VEX_API_URL = endpoint;

const { loadVexConfig } = await import('../src/vex/config.js');
const { isVexCall, nameHandling, visibleText } = await import('../src/vex/call.js');
const { buildVexState, cleanLine, VEX_QUESTIONS } = await import('../src/vex/questions.js');
const { decide, resetDecideState } = await import('../src/vex/decide.js');
const { AmbientJudge } = await import('../src/vex/ambient.js');
const { isPassAnswer, AMBIENT_HINT } = await import('../src/vex/pass.js');
const { db } = await import('../src/db.js');
const { isAgentRequest } = await import('../src/agent/index.js');

// --- 設定 ---

{
  const off = loadVexConfig({});
  if (off.call || off.ambient) fail('vex は既定でオフ');
  if (off.nameThreshold !== 0.45 || off.nameDelayMs !== 2000) fail(`名前が出たときの既定: ${off.nameThreshold} / ${off.nameDelayMs}`);
  if (off.channels.size !== 0) fail('許可チャンネルは既定で空');
  if (off.model !== 'perplexity/pplx-decider-flash-v1.2') fail(`既定のモデル: ${off.model}`);
  if (off.threshold !== 0.6 || off.contextMessages !== 6) fail('閾値は 0.6、文脈は 6 件 (評価した値)');
  if (!off.endpoint.endsWith('/api/alpha/decisions')) fail(`API の URL: ${off.endpoint}`);
  const on = loadVexConfig({ VEX_CALL: '1', VEX_AMBIENT: 'true', VEX_CHANNELS: 'a, b c', VEX_NAMES: 'Vex,ベクス', VEX_THRESHOLD: '0.7' });
  if (!on.call || !on.ambient || on.channels.size !== 3 || on.threshold !== 0.7) fail('env が読めていない');
  if (on.names.join() !== 'vex,ベクス') fail(`名前は小文字にして持つ: ${on.names}`);
  if (loadVexConfig({ VEX_CALL: 'off' }).call) fail('off は偽');
  for (const [value, mode] of [[undefined, 'off'], ['', 'off'], ['0', 'off'], ['false', 'off'], ['off', 'off'], ['1', 'mention'], ['true', 'mention'], ['mention', 'mention'], ['judge', 'judge'], ['JUDGE', 'judge']]) {
    const got = loadVexConfig({ VEX_CALL: value }).callMode;
    if (got !== mode) fail(`VEX_CALL=${JSON.stringify(value)} は ${mode} のはず: ${got}`);
  }
}

// --- 名前の検出 ---

{
  const yes = ['vex', 'Vex', 'VEX', 'vex、これ教えて', 'ねえvex今日の天気は', 'hey vex?', 'vexは何か知ってる？', '(vex)', 'vex-san どう思う',
    '<@123456789012345678> vex 見て', '> 引用の行\nvex ちょっと来て'];
  const no = ['evex', 'Evex公式', 'vexx', 'vex2', '_vex', 'hexvex', 'ベクス', '`vex` って何', '```\nvex\n```', 'https://vex.example.com/a',
    'https://example.com/?q=vex', '> vex が言った\nふーん', '<@123456789012345678> 見て', '', 'vexillology'];
  for (const text of yes) if (!isVexCall(text, ['vex'])) fail(`呼びのはず: ${JSON.stringify(text)}`);
  for (const text of no) if (isVexCall(text, ['vex'])) fail(`呼びではない: ${JSON.stringify(text)}`);
  if (!isVexCall('ベクスどう思う', ['vex', 'ベクス'])) fail('別名も呼びになる');
  if (isVexCall('vex', [])) fail('名前が空なら呼びは無い');
  if (visibleText('a `b` ```c``` https://x.y d').replace(/\s+/g, ' ').trim() !== 'a d') fail('コード・URL は見ない');
}

// --- VEX_CALL=1 (mention): 名前が出た発言はメンションと同じに agent を起動する。judge では確定にしない ---

{
  const client = { user: { id: 'bot' } };
  const message = (content, extra = {}) => ({
    guildId: 'g', content, author: { id: 'u', bot: false }, webhookId: null,
    mentions: { has: () => false }, reference: null, ...extra
  });
  if (!isAgentRequest(message('vex 教えて'), client)) fail('vex と呼べば起動する');
  if (!isAgentRequest(message('vex'), client)) fail('名前だけでも起動する');
  if (isAgentRequest(message('evex 教えて'), client)) fail('evex は呼びではない');
  if (isAgentRequest(message('`vex` って何'), client)) fail('コードの中は呼びではない');
  if (isAgentRequest(message('vex 教えて', { author: { id: 'u', bot: true } }), client)) fail('bot の発言では起動しない');
  if (isAgentRequest(message('vex 教えて', { webhookId: 'w' }), client)) fail('webhook では起動しない');
  if (isAgentRequest(message('vex 教えて', { guildId: null }), client)) fail('サーバーの外では起動しない');
  const mention = { mentions: { has: () => true } };
  if (!isAgentRequest(message('教えて', mention), client)) fail('メンションは従来どおり起動する');
  // 設定ごとの名前の扱い (judge は確定にしない・off は何もしない)
  const handling = (mode) => nameHandling('vex 教えて', { names: ['vex'], callMode: mode });
  if (handling('mention') !== 'mention' || handling('judge') !== 'judge' || handling('off') !== null) fail('名前の扱い');
  if (nameHandling('evex 教えて', { names: ['vex'], callMode: 'mention' }) !== null) fail('evex は数えない');
}

// --- 「返す価値が無い」の見分け ---

{
  for (const text of ['(skip)', 'skip', '（skip）', ' (SKIP) ', '(skip)。', '「skip」']) if (!isPassAnswer(text)) fail(`skip のはず: ${text}`);
  for (const text of ['skipしたいけど', 'それは skip できないよ', '', 'ええと (skip) でもいい', 'skipping']) {
    if (isPassAnswer(text)) fail(`skip ではない: ${JSON.stringify(text)}`);
  }
  if (!AMBIENT_HINT.includes('(skip)')) fail('前置きに (skip) の指示がある');
}

// --- state: 評価に使った形と同じ ---

{
  const { buildState, QUESTION_SETS } = await import('./vex/questions.mjs');
  const lines = [
    { author: 'alice', bot: false, minutesAgo: 12.4, text: cleanLine('どう思う？\nこれ https://example.com/a も') },
    { author: 'bob', bot: false, minutesAgo: 0.4, text: cleanLine('<@222> 聞いてる？', { botId: 'bot', names: new Map([['222', 'carol']]) }) },
    { author: 'sakana', bot: true, minutesAgo: 7, text: cleanLine('<@bot> <@!bot>'.replace(/bot/g, '999'), { botId: '999' }) },
    { author: 'dave', bot: false, minutesAgo: 1.5, text: cleanLine('x'.repeat(300)) }
  ];
  if (lines[0].text !== 'どう思う？ ⏎ これ <url> も') fail(`整形: ${lines[0].text}`);
  if (lines[1].text !== '@carol 聞いてる？') fail(`メンション: ${lines[1].text}`);
  if (lines[2].text !== '@vex @vex') fail(`bot へのメンションは @vex: ${lines[2].text}`);
  if (lines[3].text.length !== 140) fail('140 字で切る');
  const mine = buildVexState(lines, { idleMinutes: 1.5, sinceVexMinutes: 3 });
  const theirs = buildState({
    recent: lines.map((line) => ({ author: line.author, bot: line.bot, minutes_ago: line.minutesAgo, text: line.text })),
    idle_minutes: 1.5, minutes_since_vex: 3
  }, { messages: 99 });
  if (mine !== theirs) fail(`state が評価の形と違う:\n${mine}\n---\n${theirs}`);
  if (JSON.stringify(VEX_QUESTIONS.join) !== JSON.stringify(QUESTION_SETS.about.join)) fail('質問が評価した形 (about) と違う');
  if (!/vex は 3 分前に発言した/.test(mine) || !/最後の発言から 1.5 分/.test(mine)) fail(`補足の行: ${mine}`);
  if (/発言した/.test(buildVexState(lines, { sinceVexMinutes: 9 }))) fail('5 分以上前なら書かない');
}

// --- 判定の呼び出し (API クライアント) ---

const base = loadVexConfig({ VEX_API_URL: endpoint, VEX_TIMEOUT_MS: '1500', VEX_FALLBACK_MODELS: 'fb/one,fb/two' });
{
  resetDecideState();
  api.calls.length = 0;
  api.respond = () => ({ status: 200, p: 0.73, cost: 0.000004 });
  const result = await decide('state text', { config: base });
  if (!result || result.p !== 0.73 || result.model !== base.model || result.costUsd !== 0.000004) fail(`判定: ${JSON.stringify(result)}`);
  const call = api.calls[0];
  if (call.auth !== 'Bearer check') fail('鍵は Bearer で送る');
  if (call.body.model !== base.model || call.body.state.conversation !== 'state text') fail('body が違う');
  if (call.body.questions.join.type !== 'noul' || !call.body.questions.join.criteria.true) fail('質問が付いていない');
  if (api.calls.length !== 1) fail('1 回で済むはず');

  // 混んでいる (429) → 次のモデルへ
  resetDecideState(); api.calls.length = 0;
  api.respond = (model) => (model === base.model ? { status: 429 } : { status: 200, p: 0.8 });
  const moved = await decide('s', { config: base });
  if (!moved || moved.model !== 'fb/one' || api.calls.length !== 2) fail(`429 は次のモデルへ: ${JSON.stringify(moved)}`);

  // 失敗したモデルはしばらく飛ばす
  api.calls.length = 0;
  await decide('s', { config: base });
  if (api.calls.length !== 1 || api.calls[0].body.model !== 'fb/one') fail('失敗したモデルは次の判定で飛ばす');

  // 形の壊れた返事も失敗。全部だめなら null
  resetDecideState(); api.calls.length = 0;
  api.respond = (model) => (model === base.model ? { status: 200, malformed: true } : { status: 500 });
  if (await decide('s', { config: base }) !== null) fail('全部失敗なら null');
  if (api.calls.length !== 3) fail(`全部のモデルを試す: ${api.calls.length}`);

  // 範囲外の確率は信用しない
  resetDecideState();
  api.respond = () => ({ status: 200, p: 1.5 });
  if (await decide('s', { config: { ...base, fallbacks: [] } }) !== null) fail('範囲外の確率は失敗');

  // 鍵が無ければ呼ばない
  resetDecideState(); api.calls.length = 0;
  if (await decide('s', { config: { ...base, apiKey: '' } }) !== null || api.calls.length) fail('鍵が無ければ API を叩かない');

  // 時間切れ
  resetDecideState();
  const slow = http.createServer(() => {});
  await new Promise((resolve) => slow.listen(0, '127.0.0.1', resolve));
  const started = Date.now();
  const timedOut = await decide('s', { config: { ...base, fallbacks: [], timeoutMs: 150, endpoint: `http://127.0.0.1:${slow.address().port}/x` } });
  slow.closeAllConnections?.(); slow.close();
  if (timedOut !== null || Date.now() - started > 1500) fail('時間切れは null で早く返る');
  resetDecideState();
}

// --- 自発参加 ---

let clock = 0;
function makeChannel(id, { name = 'chat', nsfw = false } = {}) {
  const store = [];
  const channel = {
    id, name, nsfw, store,
    messages: {
      fetch: async ({ limit, before }) => {
        const upto = before ? store.filter((entry) => BigInt(entry.id) < BigInt(before)) : store;
        return new Map(upto.slice(-limit).map((entry) => [entry.id, entry]));
      }
    }
  };
  return channel;
}
let nextId = 1000;
function say(channel, content, { author, bot = false, ago = 0, reference = null, mentions = [], webhookId = null } = {}) {
  const who = author ?? { id: `u-${bot ? 'bot' : 'human'}`, bot, username: bot ? 'otherbot' : 'alice' };
  const entry = {
    id: String(nextId++), guildId: 'guild', channelId: channel.id, content, createdTimestamp: Date.now() - ago * 60_000,
    author: { ...who, bot: bot || who.bot }, member: null, webhookId, reference,
    mentions: { users: { size: mentions.length, has: (id) => mentions.includes(id) } },
    channel
  };
  channel.store.push(entry);
  return entry;
}

function ambientConfig(overrides = {}) {
  return loadVexConfig({
    VEX_API_URL: endpoint, VEX_CALL: 'judge', VEX_NAME_DELAY_MS: '30', VEX_AMBIENT: '1', VEX_CHANNELS: 'chan1 chan2 chan3 chan4 chan5 chan6 chan7 chan8 chan9',
    VEX_QUIET_MS: '40', VEX_COOLDOWN_MS: '60000', VEX_MAX_PER_HOUR: '3', VEX_THRESHOLD: '0.6', VEX_TIMEOUT_MS: '1500',
    VEX_FALLBACK_MODELS: 'fb/one', VEX_DAILY_USD: '1', ...overrides
  });
}

function makeJudge(config, { canSpeak = true } = {}) {
  const joins = [];
  const judge = new AmbientJudge({
    config, selfId: () => 'bot-self', canSpeak: () => canSpeak,
    join: async (message, join) => { joins.push({ message, join }); }
  });
  return { judge, joins };
}

const ledger = (channelId) => db.prepare('SELECT action, note, p, model FROM vex_decisions WHERE channel_id = ? ORDER BY id').all(channelId);
const actions = (channelId) => ledger(channelId).map((row) => row.action + (row.note ? `:${row.note}` : '')).join(',');

{
  // 高い確率 → 静かになったあとに 1 回だけ入る
  resetDecideState(); api.calls.length = 0; api.onCall = null;
  api.respond = () => ({ status: 200, p: 0.85, cost: 0.000003 });
  const channel = makeChannel('chan1');
  say(channel, '昨日のライブどうだった？', { ago: 3 });
  const { judge, joins } = makeJudge(ambientConfig());
  const last = say(channel, 'この曲のタイトルって何だっけ、誰か知ってる？');
  judge.observe(last);
  if (api.calls.length) fail('静かになるまで判定しない');
  await sleep(250);
  if (api.calls.length !== 1) fail(`判定は 1 回: ${api.calls.length}`);
  if (joins.length !== 1 || joins[0].message.id !== last.id) fail('入るはず');
  if (actions('chan1') !== 'joined') fail(`台帳: ${actions('chan1')}`);
  const state = api.calls[0].body.state.conversation;
  if (!state.includes('alice: この曲のタイトルって何だっけ、誰か知ってる？') || !state.includes('3分前 alice: 昨日のライブどうだった？')) fail(`state: ${state}`);

  // 入ったあとの結果が台帳に残る / 送る直前の確認
  if (!(await joins[0].join.stillLatest())) fail('最後の発言のままなら送ってよい');
  joins[0].join.report('sent');
  say(channel, '知らないなあ');
  say(channel, 'ところで今日寒くない？');
  if (!(await joins[0].join.stillLatest())) fail('少し進んだだけなら送ってよい');
  say(channel, 'それな');
  if (await joins[0].join.stillLatest()) fail('3 件以上進んでいたら送らない');
  joins[0].join.report('moved_on');
  joins[0].join.report('passed');
  if (actions('chan1') !== 'joined,sent,moved_on:before_send,passed') fail(`結果の台帳: ${actions('chan1')}`);
}

{
  // 送る直前: 答え (その発言への返信) が付いたら送らない
  resetDecideState();
  api.respond = () => ({ status: 200, p: 0.9 });
  const channel = makeChannel('chan9');
  const { judge, joins } = makeJudge(ambientConfig({ VEX_COOLDOWN_MS: '0', VEX_MAX_PER_HOUR: '99' }));
  const asked = say(channel, 'この関数って結局どう書くのが正解なんだろう？');
  judge.observe(asked);
  await sleep(200);
  if (joins.length !== 1) fail('入るはず');
  say(channel, 'ちょっと待ってね');
  if (!(await joins[0].join.stillLatest())) fail('関係ない発言が 1 件増えただけなら送ってよい');
  say(channel, 'それはこう書けばいいよ', { reference: { messageId: asked.id } });
  if (await joins[0].join.stillLatest()) fail('答えが付いたら送らない');
}

{
  // 名前が出た発言: 確定では答えず判定モデルが決める。許可チャンネルの外でも、冷却や 1 時間の上限があっても、後から発言が来ても判定する
  db.exec("DELETE FROM vex_decisions");
  resetDecideState(); api.calls.length = 0;
  const config = ambientConfig({ VEX_AMBIENT: '0', VEX_CHANNELS: '' });
  if (config.ambient) fail('設定');
  const { judge, joins } = makeJudge(config);

  // p が高い → 答える (join は null = 普通の依頼として)。その発言までを見せる
  api.respond = () => ({ status: 200, p: 0.7 });
  const channel = makeChannel('free-channel');
  say(channel, '今日は寒いね', { ago: 2 });
  const called = say(channel, 'vexちゃんおやすみ');
  judge.observe(called);
  const later = say(channel, 'この発言は呼ばれたあとに来た');
  judge.observe(later);
  judge.cancel('free-channel');
  await sleep(250);
  if (joins.length !== 1 || joins[0].message.id !== called.id || joins[0].join !== null) fail(`名前が出たら判定して答える: ${joins.length}`);
  const state = api.calls.at(-1).body.state.conversation;
  if (!state.includes('vexちゃんおやすみ') || state.includes('呼ばれたあとに来た')) fail(`その発言までを見せる: ${state}`);
  if (actions('free-channel') !== 'joined:named') fail(`台帳: ${actions('free-channel')}`);
  // 続けて呼んでも冷却は掛からない
  judge.observe(say(channel, 'vex どう思う？'));
  await sleep(250);
  if (joins.length !== 2) fail('名前が出た発言に冷却は掛けない');

  // 名前が出ても p が低ければ答えない (文脈で決める)。閾値は名前用
  for (const [p, expectJoin] of [[0.44, false], [0.45, true]]) {
    const before = joins.length;
    api.respond = () => ({ status: 200, p });
    judge.observe(say(channel, 'vexにするか'));
    await sleep(250);
    if ((joins.length - before === 1) !== expectJoin) fail(`名前が出たときの閾値 p=${p}`);
  }
  if (!actions('free-channel').endsWith('below:named,joined:named')) fail(`台帳: ${actions('free-channel')}`);

  // 名前が出ていても判定に回さない発言 / 名前が出ていない発言 (許可チャンネルの外)
  api.calls.length = 0;
  judge.observe(say(channel, 'vex が言ってた', { bot: true }));
  judge.observe(say(makeChannel('x', { nsfw: true }), 'vex どう思う？'));
  judge.observe(say(channel, 'evex どう思う？'));
  judge.observe(say(channel, 'これってどうなってるの？誰か分かる人いる？'));
  await sleep(250);
  if (api.calls.length) fail('bot・NSFW・名前が出ていない発言は、許可チャンネルの外では判定しない');

  // オフ・メンション扱いのときは、名前が出ても判定しない (メンション扱いは isAgentRequest が確定で起動するので重ねない)
  for (const mode of ['0', '1']) {
    const other = makeJudge(ambientConfig({ VEX_CALL: mode, VEX_AMBIENT: '0', VEX_CHANNELS: '' }));
    other.judge.observe(say(channel, 'vex どう思う？'));
    await sleep(250);
    if (api.calls.length || other.joins.length) fail(`VEX_CALL=${mode} なら判定しない`);
  }

  // 判定費用の上限は掛かる / 判定が壊れたら答えない
  db.exec("DELETE FROM vex_decisions");
  api.respond = () => ({ status: 200, p: 0.9, cost: 0.2 });
  const budget = makeJudge(ambientConfig({ VEX_AMBIENT: '0', VEX_CHANNELS: '', VEX_DAILY_USD: '0.1' }));
  budget.judge.observe(say(channel, 'vex どう思う？'));
  await sleep(250);
  budget.judge.observe(say(channel, 'vex もう一回'));
  await sleep(250);
  if (budget.joins.length !== 1 || !actions('free-channel').endsWith('joined:named,skipped:daily_budget')) fail(`費用の上限: ${actions('free-channel')}`);

  // 許可チャンネルでは、名前が出た発言を名前として 1 回だけ扱う (自発参加と重ねない)
  db.exec("DELETE FROM vex_decisions");
  resetDecideState(); api.calls.length = 0;
  api.respond = () => ({ status: 200, p: 0.9 });
  const both = makeJudge(ambientConfig());
  both.judge.observe(say(makeChannel('chan1'), 'vex これって誰か答えられる？'));
  await sleep(300);
  if (both.joins.length !== 1 || both.joins[0].join !== null || api.calls.length !== 1) fail(`名前と自発参加を重ねない: joins=${both.joins.length} calls=${api.calls.length}`);
}

{
  // 閾値に届かなければ入らない (0.59 と 0.6 の境目も)
  for (const [p, expectJoin] of [[0.59, false], [0.6, true], [0.2, false]]) {
    resetDecideState();
    api.respond = () => ({ status: 200, p });
    const channel = makeChannel('chan2');
    const { judge, joins } = makeJudge(ambientConfig({ VEX_COOLDOWN_MS: '0', VEX_MAX_PER_HOUR: '99' }));
    judge.observe(say(channel, 'これって結局どっちが正しいの？'));
    await sleep(200);
    if ((joins.length === 1) !== expectJoin) fail(`p=${p} の扱い: joins=${joins.length}`);
  }
  if (!actions('chan2').startsWith('below,joined,below')) fail(`台帳: ${actions('chan2')}`);
}

{
  // デバウンス: 続けて発言があれば最後の 1 件だけを、静かになってから判定する
  resetDecideState(); api.calls.length = 0;
  api.respond = () => ({ status: 200, p: 0.9 });
  const channel = makeChannel('chan3');
  const { judge, joins } = makeJudge(ambientConfig());
  judge.observe(say(channel, 'ちょっと聞きたいんだけど、いま空いてる？'));
  await sleep(15);
  const second = say(channel, 'この関数の戻り値って何になるんだっけ');
  judge.observe(second);
  await sleep(250);
  if (api.calls.length !== 1 || joins.length !== 1 || joins[0].message.id !== second.id) fail(`デバウンス: calls=${api.calls.length} joins=${joins.length}`);

  // bot の発言 (cancel) でタイマーを捨てる
  api.calls.length = 0;
  const channel2 = makeChannel('chan4');
  const { judge: judge2, joins: joins2 } = makeJudge(ambientConfig());
  judge2.observe(say(channel2, 'これ誰か答えられる人いる？いたら教えてほしい'));
  judge2.cancel('chan4');
  await sleep(200);
  if (api.calls.length || joins2.length) fail('cancel のあとは判定しない');
  // observe は bot の発言を相手にしない
  const bot = say(channel2, 'こんにちは、いまのところ質問は受け付けています', { bot: true });
  judge2.observe(bot);
  await sleep(150);
  if (api.calls.length || judge2.worthJudging(bot)) fail('bot の発言には反応しない (輪を作らない)');
}

{
  // 判定に回さない発言
  const channel = makeChannel('chan5');
  const { judge } = makeJudge(ambientConfig());
  const ok = (text, extra) => judge.worthJudging(say(channel, text, extra));
  if (!ok('これってどうやって設定するのか分かる人いる？')) fail('質問は判定に回す');
  if (ok('ありがとう')) fail('相槌は回さない');
  if (ok('うん')) fail('短すぎる発言は回さない');
  if (ok('')) fail('本文が無い (画像だけ) は回さない');
  if (!ok('そうだよね、それで合ってると思うよ', { reference: { messageId: '1' } })) fail('返信も回す (雑談は返信が多い)');
  if (ok('<@222> これってどうなってるの？', { mentions: ['222'] })) fail('別の人宛ては回さない');
  if (!ok('<@bot-self> これってどうなってるの？', { mentions: ['bot-self'] })) fail('自分宛てのメンションだけなら回す (呼びは別経路で扱う)');
  if (ok('これってどうなってるの？', { webhookId: 'w' })) fail('webhook は回さない');
  if (judge.worthJudging(say(makeChannel('chan5', { nsfw: true }), 'これってどうなってるの？'))) fail('NSFW は回さない');
  if (judge.worthJudging(say(makeChannel('chan5', { name: 'nsfw-art' }), 'これってどうなってるの？'))) fail('名前に nsfw があれば回さない');
}

{
  // 許可・無効
  api.calls.length = 0; api.respond = () => ({ status: 200, p: 0.9 });
  const other = makeChannel('not-allowed');
  const { judge, joins } = makeJudge(ambientConfig());
  judge.observe(say(other, 'これって誰か分かる人いる？教えてほしい'));
  const off = makeChannel('chan6');
  const { judge: disabled } = makeJudge(ambientConfig({ VEX_AMBIENT: '0' }));
  disabled.observe(say(off, 'これって誰か分かる人いる？教えてほしい'));
  const empty = makeChannel('chan6');
  const { judge: noChannels } = makeJudge(ambientConfig({ VEX_CHANNELS: '' }));
  noChannels.observe(say(empty, 'これって誰か分かる人いる？教えてほしい'));
  await sleep(200);
  if (api.calls.length || joins.length) fail('許可されていない・無効・許可リストが空なら動かない');
  if (!ambientConfig().ambient || ambientConfig({ VEX_CHANNELS: '' }).channels.size) fail('設定');
}

{
  // 冷却と 1 時間の上限
  resetDecideState(); api.calls.length = 0;
  api.respond = () => ({ status: 200, p: 0.9 });
  const channel = makeChannel('chan7');
  const { judge, joins } = makeJudge(ambientConfig({ VEX_COOLDOWN_MS: '60000' }));
  judge.observe(say(channel, 'この問題の答えって何になる？誰か分かる？'));
  await sleep(200);
  judge.observe(say(channel, 'じゃあこっちの問題は？これも分からなくて'));
  await sleep(200);
  if (joins.length !== 1 || api.calls.length !== 1) fail(`冷却中は判定もしない: joins=${joins.length} calls=${api.calls.length}`);
  if (actions('chan7') !== 'joined,skipped:cooldown') fail(`台帳: ${actions('chan7')}`);

  const capped = makeChannel('chan8');
  const { judge: judge2, joins: joins2 } = makeJudge(ambientConfig({ VEX_COOLDOWN_MS: '0', VEX_MAX_PER_HOUR: '2' }));
  for (let i = 0; i < 4; i += 1) {
    judge2.observe(say(capped, `${i} 問目: これってどう考えたらいいんだろう？`));
    await sleep(200);
  }
  if (joins2.length !== 2) fail(`1 時間の上限: ${joins2.length}`);
  if (actions('chan8') !== 'joined,joined,skipped:hourly_cap,skipped:hourly_cap') fail(`台帳: ${actions('chan8')}`);
}

{
  // 判定の費用の上限 (1 日)
  resetDecideState(); api.calls.length = 0;
  db.exec("DELETE FROM vex_decisions");
  api.respond = () => ({ status: 200, p: 0.1, cost: 0.01 });
  const { judge } = makeJudge(ambientConfig({ VEX_DAILY_USD: '0.015', VEX_COOLDOWN_MS: '0' }));
  for (const id of ['chan1', 'chan2', 'chan3']) {
    judge.observe(say(makeChannel(id), 'これってどういう意味なんだろう？調べてほしい'));
    await sleep(120);
  }
  if (api.calls.length !== 2) fail(`費用の上限に届いたら判定しない: ${api.calls.length}`);
  const skipped = db.prepare("SELECT note FROM vex_decisions WHERE action = 'skipped'").all().map((row) => row.note);
  if (skipped.join() !== 'daily_budget') fail(`台帳: ${skipped}`);
}

{
  // 判定が壊れても入らないだけ。台帳には error
  db.exec("DELETE FROM vex_decisions");
  resetDecideState(); api.calls.length = 0;
  api.respond = () => ({ status: 500 });
  const channel = makeChannel('chan1');
  const { judge, joins } = makeJudge(ambientConfig());
  judge.observe(say(channel, 'これって誰か答えてくれたりしないかな？'));
  await sleep(250);
  if (joins.length) fail('判定できなければ入らない');
  if (actions('chan1') !== 'error:no_decision') fail(`台帳: ${actions('chan1')}`);

  // 混んだ (429) ときは別のモデルで判定して入る
  db.exec("DELETE FROM vex_decisions");
  resetDecideState();
  api.respond = (model) => (model === 'perplexity/pplx-decider-flash-v1.2' ? { status: 429 } : { status: 200, p: 0.9 });
  const channel2 = makeChannel('chan1');
  const { judge: judge2, joins: joins2 } = makeJudge(ambientConfig());
  judge2.observe(say(channel2, 'これって誰か答えてくれたりしないかな？'));
  await sleep(250);
  if (joins2.length !== 1 || ledger('chan1')[0].model !== 'fb/one') fail(`フォールバック: ${JSON.stringify(ledger('chan1'))}`);
}

{
  // 判定のあいだに会話が進んだら入らない / 判定の前に進んでいても入らない
  db.exec("DELETE FROM vex_decisions");
  resetDecideState();
  api.respond = () => ({ status: 200, p: 0.95 });
  const channel = makeChannel('chan1');
  const { judge, joins } = makeJudge(ambientConfig());
  const asked = say(channel, 'これって結局どっちが速いのか誰か知ってる？');
  api.onCall = () => { say(channel, 'ベンチ取ったことあるよ'); api.onCall = null; };
  judge.observe(asked);
  await sleep(250);
  if (joins.length) fail('判定中に誰かが答えたら入らない');
  if (actions('chan1') !== 'moved_on:after_decision') fail(`台帳: ${actions('chan1')}`);

  db.exec("DELETE FROM vex_decisions");
  const channel2 = makeChannel('chan1');
  const { judge: judge2, joins: joins2 } = makeJudge(ambientConfig());
  const first = say(channel2, 'これって結局どっちが速いのか誰か知ってる？');
  judge2.observe(first);
  say(channel2, '(別の bot か編集で、observe を通らない発言が増えた)', { bot: true });
  await sleep(250);
  if (joins2.length) fail('最後の発言が違えば入らない');
  if (actions('chan1') !== 'moved_on:before_decision') fail(`台帳: ${actions('chan1')}`);
}

{
  // 話せない場所では判定もしない
  db.exec("DELETE FROM vex_decisions");
  api.calls.length = 0; api.respond = () => ({ status: 200, p: 0.9 });
  const channel = makeChannel('chan1');
  const { judge, joins } = makeJudge(ambientConfig(), { canSpeak: false });
  judge.observe(say(channel, 'これって誰か答えてくれたりしないかな？'));
  await sleep(200);
  if (joins.length || api.calls.length) fail('話せない場所では判定もしない');
  if (actions('chan1') !== 'skipped:cannot_speak') fail(`台帳: ${actions('chan1')}`);
}

{
  // 同じチャンネルの判定は重ならない
  db.exec("DELETE FROM vex_decisions");
  resetDecideState(); api.calls.length = 0;
  api.respond = () => ({ status: 200, p: 0.1 });
  const channel = makeChannel('chan1');
  const { judge } = makeJudge(ambientConfig());
  const message = say(channel, 'これって誰か答えてくれたりしないかな？');
  await Promise.all([judge.judge(message), judge.judge(message)]);
  if (api.calls.length !== 1) fail(`同じチャンネルの判定は重ならない: ${api.calls.length}`);
}

{
  // 自発参加は誰の依頼でもない: 読めるのは @everyone に見えるチャンネルだけ (最後に発言した人の権限では読ませない)
  const { getPublicChannelScope } = await import('../src/archive/permissions.js');
  const { isChannelAllowed } = await import('../src/archive/search.js');
  const { db: archiveDb } = await import('../src/archive/db.js');
  const { ChannelType } = await import('discord.js');
  const everyone = { id: 'role-everyone' };
  const visibleToEveryone = new Set(['pub']);
  const channel = (id) => ({
    id, type: ChannelType.GuildText,
    permissionsFor: (who) => ({ has: () => who !== everyone || visibleToEveryone.has(id) })
  });
  const guild = { id: 'scope-guild', roles: { everyone }, channels: { cache: new Map([['pub', channel('pub')], ['priv', channel('priv')]]) } };
  for (const id of ['pub', 'priv']) archiveDb.prepare('INSERT OR REPLACE INTO channels (channel_id, guild_id, name, type, is_thread, is_private) VALUES (?, ?, ?, ?, 0, 0)').run(id, guild.id, id, ChannelType.GuildText);
  const scope = getPublicChannelScope(guild);
  if (!isChannelAllowed('pub', scope)) fail('全員に見えるチャンネルは読める');
  if (isChannelAllowed('priv', scope)) fail('一部の人にしか見えないチャンネルは、自発参加では読ませない');
}

server.closeAllConnections?.();
server.close();
console.log('vex ok');
