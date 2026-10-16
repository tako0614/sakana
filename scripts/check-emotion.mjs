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
for (const bad of [null, {}, { emotions: [] }, { emotions: [{ label: 1, score: 0.5 }] }, { emotions: [{ label: 'joy', score: 'x' }] }, { emotions: [{ label: 'joy', score: Infinity }] }]) {
  assert.throws(() => parseEmotionResult(bad), /Invalid analyzer output/, `must refuse ${JSON.stringify(bad)}`);
}

const chrome = process.env.EMOTION_CHROME_PATH ?? '/usr/bin/google-chrome';
if (existsSync(chrome)) {
  const png = await renderEmotionImage({ authorName: 'たこ', avatarUrl: 'https://cdn.discordapp.com/embed/avatars/0.png', text: 'テスト', result });
  assert.equal(png.subarray(1, 4).toString(), 'PNG', 'renders a PNG');
  assert.equal(png.readUInt32BE(16), 960, 'the image is 960 wide');
  assert.equal(png.readUInt32BE(20), 540, 'and 540 high');
  console.log(`emotion ok (エスケープ / CSP / 読み込みは Discord のアバターだけ / 解析結果の形 / 描画 ${png.length} bytes)`);
} else {
  console.log('emotion ok (エスケープ / CSP / 読み込みは Discord のアバターだけ / 解析結果の形 / Chrome が無いので描画は省略)');
}
