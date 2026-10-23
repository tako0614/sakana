// 「きもち」の画像の検証 (npm run check から呼ぶ)。
//
// 2026-10-16、描画を node-html-to-image (古い puppeteer・Chrome 128・handlebars に既知の脆弱性) から
// puppeteer-core + 手で書いた CSS に替えた。
//   - 発言の文字は HTML としてエスケープされる (タグを書いても効かない)
//   - 画像の中から取りに行けるのは Discord のアバター画像だけ (CSP と Chrome 側の読み込み制限)
//   - 解析スクリプトの出力の形を確かめる
//   - Chrome があれば実際に描画して PNG になることを確かめる

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';

const { renderEmotionHtml } = await import('../src/emotion-image.js');
const { EMOTIONS, EMOTION_QUESTIONS, analyzeEmotion, loadEmotionJevConfig, resetEmotionJevState } = await import('../src/emotion-jev.js');
const { DESIRE_QUESTIONS, analyzeDesire } = await import('../src/desire-jev.js');
const { isDesireRequest } = await import('../src/desire.js');
const { renderDesireHtml } = await import('../src/emotion-image.js');
const { isAllowedImageRequest, parseEmotionResult, renderEmotionImage } = await import('../src/emotion.js');

const result = { emotions: [{ label: 'joy', score: 0.8 }, { label: 'anger', score: 0.1 }, { label: 'unknown<b>', score: 0.05 }] };
const html = renderEmotionHtml({ authorName: '<img src=x onerror=alert(1)>', avatarUrl: 'https://cdn.discordapp.com/avatars/1/a.png', text: '</div><script>alert(1)</script>', result });
assert.ok(!html.includes('<script>alert'), 'message text must be escaped');
assert.ok(!html.includes('<img src=x'), 'names must be escaped');
assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
assert.match(html, /Content-Security-Policy" content="default-src 'none'; img-src https:\/\/cdn\.discordapp\.com https:\/\/media\.discordapp\.net data:; style-src 'unsafe-inline'"/);
assert.match(html, /喜んでいる/, 'the top emotion picks its verb');

for (const url of ['https://cdn.discordapp.com/avatars/1/a.png', 'https://media.discordapp.net/x.png', 'data:image/png;base64,AAAA', 'about:blank']) {
  assert.ok(isAllowedImageRequest(url), `must allow ${url}`);
}
for (const url of ['http://cdn.discordapp.com/a.png', 'https://evil.example/a.png', 'http://127.0.0.1:9222/json', 'file:///etc/passwd',
  'https://cdn.discordapp.com.evil.example/a.png', 'https://192.168.0.22:8006/', 'chrome://version', 'not a url']) {
  assert.ok(!isAllowedImageRequest(url), `must block ${url}`);
}

assert.deepEqual(parseEmotionResult({ emotions: [{ label: 'joy', score: 0.5 }] }), { emotions: [{ label: 'joy', score: 0.5 }] });
assert.deepEqual(parseEmotionResult({ emotions: [{ label: 'joy', score: 0.1 }], neutral: true }), { emotions: [{ label: 'joy', score: 0.1 }], neutral: true });
for (const bad of [null, {}, { emotions: [] }, { emotions: [{ label: 1, score: 0.5 }] }, { emotions: [{ label: 'joy', score: 'x' }] }, { emotions: [{ label: 'joy', score: Infinity }] }]) {
  assert.throws(() => parseEmotionResult(bad), /Invalid analyzer output/, `must refuse ${JSON.stringify(bad)}`);
}

// ---- 判定モデル (jev) での分析: 偽の Decisions API で確かめる ----------------------------------------------------
assert.deepEqual(Object.keys(EMOTION_QUESTIONS), ['joy', 'sadness', 'anticipation', 'surprise', 'anger', 'fear', 'disgust', 'trust'], '8 感情を、画像の表と同じ順で聞く');
for (const [id, question] of Object.entries(EMOTION_QUESTIONS)) {
  assert.equal(question.type, 'noul');
  assert.ok(question.criteria.true.includes(EMOTIONS[id][0].slice(0, 1)) || question.criteria.true.length > 5, `${id} has a criterion`);
}
assert.match(renderEmotionHtml({ authorName: 'a', avatarUrl: 'https://cdn.discordapp.com/a.png', text: 'おはよう', result: { emotions: [{ label: 'joy', score: 0.2 }], neutral: true } }), /落ち着いている/, 'neutral gets its own headline');

const calls = [];
const answers = (scores) => ({ answers: Object.fromEntries(Object.keys(EMOTIONS).map((id) => [id, { noul: scores[id] ?? 0.05 }])), usage: { cost: 0.000005 } });
const respond = (handler) => async (url, init) => {
  const body = JSON.parse(init.body);
  calls.push({ url, auth: init.headers.authorization, body });
  const result = handler(body.model, calls.length);
  return { ok: result.status === undefined, status: result.status ?? 200, json: async () => result.body };
};
const config = loadEmotionJevConfig({ EMOTION_API_URL: 'http://emotion.test/decisions', OPENROUTER_API_KEY: 'key', EMOTION_MODELS: 'm/one,m/two' });
assert.deepEqual(config.models, ['m/one', 'm/two']);
assert.equal(config.neutralBelow, 0.4);

resetEmotionJevState();
let analyzed = await analyzeEmotion('夜道怖すぎて動けない', { config, fetchImpl: respond(() => ({ body: answers({ fear: 0.98, sadness: 0.12 }) })) });
assert.equal(calls[0].url, 'http://emotion.test/decisions');
assert.equal(calls[0].auth, 'Bearer key');
assert.equal(calls[0].body.model, 'm/one');
assert.equal(calls[0].body.state.text, '夜道怖すぎて動けない');
assert.equal(Object.keys(calls[0].body.questions).length, 8);
assert.ok(!analyzed.neutral, 'a strong emotion is not neutral');
assert.deepEqual(analyzed.emotions.map((emotion) => emotion.label), Object.keys(EMOTIONS));
assert.equal(analyzed.emotions.find((emotion) => emotion.label === 'fear').score, 0.98);
assert.deepEqual(parseEmotionResult(analyzed), analyzed, 'the result passes the shape check the image relies on');

analyzed = await analyzeEmotion('おはよう', { config, fetchImpl: respond(() => ({ body: answers({ joy: 0.28, trust: 0.34 }) })) });
assert.equal(analyzed.neutral, true, 'every emotion below the threshold is neutral');
assert.equal(parseEmotionResult(analyzed).neutral, true, 'and the flag survives the shape check');

// 長い発言は切る
calls.length = 0;
await analyzeEmotion('あ'.repeat(5000), { config, fetchImpl: respond(() => ({ body: answers({}) })) });
assert.equal(calls[0].body.state.text.length, 1000);

// 混んだら次のモデルへ。一度失敗したモデルは次の呼び出しでは飛ばす
resetEmotionJevState();
calls.length = 0;
analyzed = await analyzeEmotion('x', { config, fetchImpl: respond((model) => (model === 'm/one' ? { status: 429, body: {} } : { body: answers({ joy: 0.9 }) })) });
assert.deepEqual(calls.map((call) => call.body.model), ['m/one', 'm/two'], 'falls back on a busy model');
assert.equal(analyzed.emotions[0].score, 0.9);
calls.length = 0;
await analyzeEmotion('y', { config, fetchImpl: respond(() => ({ body: answers({}) })) });
assert.deepEqual(calls.map((call) => call.body.model), ['m/two'], 'a model that just failed is skipped');

// 答えが欠けていたら失敗扱い。全部失敗したら投げる / キーが無ければ投げる
resetEmotionJevState();
await assert.rejects(analyzeEmotion('z', { config, fetchImpl: respond(() => ({ body: { answers: { joy: { noul: 0.5 } } } })) }), /no probability/);
resetEmotionJevState();
await assert.rejects(analyzeEmotion('z', { config, fetchImpl: respond(() => ({ status: 500, body: {} })) }), /HTTP 500/);
await assert.rejects(analyzeEmotion('z', { config: { ...config, apiKey: '' }, fetchImpl: respond(() => ({ body: answers({}) })) }), /OPENROUTER_API_KEY/);
resetEmotionJevState();

// ---- よっきゅう (三大欲求): 同じ聞き方で、質問が 3 つ -----------------------------------------------------------
assert.deepEqual(Object.keys(DESIRE_QUESTIONS), ['hunger', 'sleep', 'sex'], '食欲・睡眠欲・性欲の順');
for (const question of Object.values(DESIRE_QUESTIONS)) assert.equal(question.type, 'noul');
{
  calls.length = 0;
  const desireAnswers = (scores) => ({ answers: Object.fromEntries(Object.keys(DESIRE_QUESTIONS).map((id) => [id, { noul: scores[id] ?? 0.04 }])), usage: { cost: 0.000003 } });
  resetEmotionJevState();
  let read = await analyzeDesire('お腹すいた〜ラーメン食べたい', { config, fetchImpl: respond(() => ({ body: desireAnswers({ hunger: 0.98 }) })) });
  assert.equal(Object.keys(calls[0].body.questions).join(), 'hunger,sleep,sex', 'three questions in one call');
  assert.equal(calls[0].body.state.text, 'お腹すいた〜ラーメン食べたい');
  assert.deepEqual(read.desires.map((desire) => desire.label), ['hunger', 'sleep', 'sex']);
  assert.equal(read.desires[0].score, 0.98);
  assert.ok(!read.neutral);
  read = await analyzeDesire('おはよう', { config, fetchImpl: respond(() => ({ body: desireAnswers({ hunger: 0.29, sleep: 0.24 }) })) });
  assert.equal(read.neutral, true, 'every desire below the threshold is neutral');
  await assert.rejects(analyzeDesire('x', { config, fetchImpl: respond(() => ({ body: { answers: { hunger: { noul: 0.5 } } } })) }), /no probability/);
  resetEmotionJevState();

  const html = renderDesireHtml({ authorName: '<b>たこ</b>', avatarUrl: 'https://cdn.discordapp.com/a.png', text: '</div><script>alert(1)</script>', result: { desires: [{ label: 'hunger', score: 0.1 }, { label: 'sleep', score: 0.98 }, { label: 'sex', score: 0.05 }] } });
  assert.ok(!html.includes('<script>alert') && !html.includes('<b>たこ'), 'desire image escapes text and names');
  assert.match(html, /食欲/); assert.match(html, /睡眠欲/); assert.match(html, /性欲/);
  assert.match(html, /width:98%/, 'the gauge length is the probability');
  assert.match(html, /眠たがっている/, 'the headline follows the strongest desire');
  assert.match(renderDesireHtml({ authorName: 'a', avatarUrl: 'https://cdn.discordapp.com/a.png', text: 'おはよう', result: { desires: [{ label: 'hunger', score: 0.29 }], neutral: true } }), /欲求は落ち着いている/);
  assert.match(renderDesireHtml({ authorName: 'a', avatarUrl: 'https://cdn.discordapp.com/a.png', text: 'x', result: { desires: [{ label: 'sex', score: 0.9 }] } }), /煩悩があふれている/, 'the third desire has a mild headline');

  const message = (content, reference = { messageId: '1' }) => ({ content, reference });
  assert.equal(isDesireRequest(message('よっきゅう')), true);
  assert.equal(isDesireRequest(message('  よっきゅう \n')), true, 'surrounding whitespace is fine');
  assert.equal(isDesireRequest(message('よっきゅう', null)), false, 'it must be a reply');
  assert.equal(isDesireRequest(message('よっきゅうして')), false);
  assert.equal(isDesireRequest(message('きもち')), false);
}

const chrome = process.env.EMOTION_CHROME_PATH ?? '/usr/bin/google-chrome';
if (existsSync(chrome)) {
  const png = await renderEmotionImage({ authorName: 'たこ', avatarUrl: 'https://cdn.discordapp.com/embed/avatars/0.png', text: 'テスト', result });
  assert.equal(png.subarray(1, 4).toString(), 'PNG', 'renders a PNG');
  assert.equal(png.readUInt32BE(16), 960, 'the image is 960 wide');
  assert.equal(png.readUInt32BE(20), 540, 'and 540 high');
  const { renderHtmlImage } = await import('../src/emotion.js');
  const desirePng = await renderHtmlImage(renderDesireHtml({ authorName: 'たこ', avatarUrl: 'https://cdn.discordapp.com/embed/avatars/0.png', text: 'お腹すいたし眠いし', result: { desires: [{ label: 'hunger', score: 0.94 }, { label: 'sleep', score: 0.98 }, { label: 'sex', score: 0.06 }] } }));
  assert.equal(desirePng.subarray(1, 4).toString(), 'PNG', 'the desire image renders a PNG');
  assert.equal(desirePng.readUInt32BE(16), 960);
  assert.equal(desirePng.readUInt32BE(20), 540);
  if (process.env.DESIRE_PREVIEW) (await import('node:fs')).writeFileSync(process.env.DESIRE_PREVIEW, desirePng);
  console.log(`emotion ok (エスケープ / CSP / 読み込みは Discord のアバターだけ / 解析結果の形 / jev での分析・フォールバック・neutral / よっきゅう (3 問・ゲージ・トリガー) / 描画 ${png.length} bytes)`);
} else {
  console.log('emotion ok (エスケープ / CSP / 読み込みは Discord のアバターだけ / 解析結果の形 / jev での分析・フォールバック・neutral / よっきゅう (3 問・ゲージ・トリガー) / Chrome が無いので描画は省略)');
}
