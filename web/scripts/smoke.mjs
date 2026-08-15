import { chromium } from 'playwright-core';

const baseURL = process.env.SMOKE_URL ?? 'http://127.0.0.1:4173';
const executablePath = process.env.CHROME_PATH ?? '/usr/bin/google-chrome';
const modelId = process.env.SMOKE_MODEL ?? 'evex-2';
const backend = process.env.SMOKE_BACKEND ?? 'wasm';
const expectedBackend = modelId === 'evex-ft-1' ? 'webgpu' : backend;
const loadOnly = process.env.SMOKE_LOAD_ONLY === '1';
const loadTimeout = modelId === 'evex-ft-1' ? 900_000 : 180_000;
const generationTimeout = modelId === 'evex-ft-1' ? 300_000 : 120_000;
const browser = await chromium.launch({
  executablePath,
  headless: true,
  args: ['--enable-unsafe-webgpu'],
});
const page = await browser.newPage();
const errors = [];
const requests = [];
page.on('pageerror', (error) => errors.push(error.message));
page.on('console', (message) => {
  const text = message.text();
  if (
    message.type() === 'error' &&
    !text.startsWith('Failed to load resource:') &&
    !text.includes('[W:onnxruntime:')
  ) {
    errors.push(text);
  }
});
page.on('response', (response) => {
  if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`);
});
page.on('request', (request) => requests.push(request.url()));

try {
  await page.goto(baseURL, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.getByLabel('モデル', { exact: true }).selectOption(modelId);
  await page.getByRole('button', { name: '設定', exact: true }).click();
  await page.getByLabel('実行方法', { exact: true }).waitFor();
  if (modelId !== 'evex-ft-1') await page.getByLabel('実行方法', { exact: true }).selectOption(backend);
  await page.locator('.primary-load').click();
  await page.locator('.main-shell[data-model-ready="true"]').waitFor({ timeout: loadTimeout });
  const requestsAfterLoad = requests.length;

  if (loadOnly) {
    if (errors.length) throw new Error(`browser errors: ${errors.join(' | ')}`);
    console.log(`browser load smoke ok; ${modelId} ready on ${expectedBackend}`);
  } else {
    await page.getByLabel('メッセージ').fill('こんにちは。今日は何してた？');
    await page.getByRole('button', { name: '送信' }).click();
    await page.waitForFunction(
      () => {
        const replies = document.querySelectorAll('.message.assistant .message-body > p');
        return Boolean(replies.length && replies[replies.length - 1].textContent?.trim());
      },
      { timeout: generationTimeout },
    );
    await page.getByRole('button', { name: '停止' }).waitFor({ state: 'detached', timeout: generationTimeout });
    await page.locator('.message.assistant').last().waitFor();
    await page.screenshot({ path: '/tmp/evex-chat-smoke.png', fullPage: true });

    const inferenceRequests = requests.slice(requestsAfterLoad);
    if (inferenceRequests.length) {
      throw new Error(`generation made network requests: ${inferenceRequests.join(', ')}`);
    }
    if (errors.length) throw new Error(`browser errors: ${errors.join(' | ')}`);
    const reply = await page.locator('.message.assistant .message-body > p').last().textContent();
    console.log(`browser smoke ok; local reply: ${JSON.stringify(reply)}`);
  }
} catch (error) {
  await page.screenshot({ path: '/tmp/evex-chat-smoke-failure.png', fullPage: true }).catch(() => {});
  console.error('browser errors:', errors);
  console.error('page text:', await page.locator('body').innerText().catch(() => '(unavailable)'));
  console.error('requests:', requests);
  throw error;
} finally {
  await browser.close();
}
