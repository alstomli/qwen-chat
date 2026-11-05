import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { apiKey, failedPrompt, imageBytes } from './image-test-fixture.mjs';

const port = process.env.CHAT_IMAGE_TEST_PORT ?? '3004';
assert.ok(/^\d+$/.test(port) && Number(port) > 0 && Number(port) <= 65535);
const base = `http://127.0.0.1:${Number(port)}`;
const password = randomBytes(24).toString('hex');
const app = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'dev', '--hostname', '127.0.0.1', '--port', port], {
  cwd: fileURLToPath(new URL('..', import.meta.url)),
  stdio: ['ignore', 'pipe', 'pipe'],
  env: {
    ...process.env,
    NODE_OPTIONS: `--import=${new URL('./image-test-fixture.mjs', import.meta.url).href}`,
    NODE_ENV: 'development',
    NEXT_TELEMETRY_DISABLED: '1',
    CHAT_TEST_DIST_DIR: '.next-integration',
    CHAT_IMAGE_TEST_FIXTURE: 'true',
    CHAT_PASSWORD: password,
    SESSION_SECRET: randomBytes(32).toString('hex'),
    RUNPOD_CHAT_URL: '',
    RUNPOD_CHAT_TOKEN: '',
    RUNPOD_BF16_CHAT_URL: '',
    RUNPOD_BF16_CHAT_TOKEN: '',
    RUNPOD_IMAGE_API_KEY: apiKey,
    CHAT_PREVIEW_MODE: 'true',
  },
});
let logs = '';
app.stdout.on('data', chunk => { logs += chunk; });
app.stderr.on('data', chunk => { logs += chunk; });
app.on('error', error => { logs += error.message; });

function post(path, body, headers = {}) {
  return fetch(base + path, {
    method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body), signal: AbortSignal.timeout(15_000),
  });
}

async function login() {
  const response = await post('/api/login', { password });
  assert.equal(response.status, 200);
  return { Cookie: response.headers.get('set-cookie').split(';')[0] };
}

async function waitForApp() {
  for (let attempt = 0; attempt < 80; attempt++) {
    if (app.exitCode !== null) break;
    try {
      const response = await fetch(base, { signal: AbortSignal.timeout(5_000) });
      if (response.ok) return;
    } catch {}
    await sleep(500);
  }
  throw new Error(`The local test app did not start at ${base}`);
}

async function checkHttp() {
  const get = (path, headers) => fetch(base + path, { headers, signal: AbortSignal.timeout(15_000) });
  assert.equal((await get('/api/images')).status, 401);
  const headers = await login();
  const capability = await get('/api/images', headers);
  assert.equal(capability.status, 200);
  assert.equal((await capability.json()).enabled, true);
  assert.equal((await post('/api/images', { prompt: 'test' }, { ...headers, Origin: 'https://other.example' })).status, 403);
  assert.equal((await post('/api/images', { prompt: ' ' }, headers)).status, 400);

  const response = await post('/api/images', { prompt: 'Paint a square' }, headers);
  assert.equal(response.status, 202);
  const queued = await response.json();
  assert.equal(queued.status, 'queued');
  const statusPath = `/api/images/${encodeURIComponent(queued.jobId)}`;
  const otherSession = await login();
  assert.equal((await get(statusPath, otherSession)).status, 404);
  assert.equal((await (await get(statusPath, headers)).json()).status, 'generating');
  const completed = await (await get(statusPath, headers)).json();
  assert.equal(completed.status, 'completed');
  assert.equal(completed.image.url, `${statusPath}/download`);
  assert.equal((await get(completed.image.url)).status, 401);
  assert.equal((await get(completed.image.url, otherSession)).status, 404);
  const image = await get(completed.image.url, headers);
  assert.equal(image.status, 200);
  assert.match(image.headers.get('cache-control'), /no-store/);
  assert.equal(image.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await image.arrayBuffer()), imageBytes);
  console.log('PASS: HTTP login, same-origin submit, session-bound job, and private fixture image bytes');
}

async function checkBrowser() {
  const { chromium } = await import(pathToFileURL(process.env.CHAT_TEST_PLAYWRIGHT).href);
  const browser = await chromium.launch({ headless: true, channel: process.env.CHAT_TEST_BROWSER_CHANNEL });
  try {
    const page = await browser.newPage({ acceptDownloads: true });
    page.setDefaultTimeout(15_000);
    const browserErrors = [];
    const providerRequests = [];
    page.on('pageerror', error => browserErrors.push(error.message));
    page.on('request', request => {
      if (new URL(request.url()).hostname.endsWith('.runpod.ai')) providerRequests.push(request.url());
    });
    await page.goto(base);
    await page.getByLabel('Workspace password').fill(password);
    await page.getByRole('button', { name: 'Enter workspace' }).click();

    const cards = page.getByRole('article', { name: 'Image generation' });
    const readyImages = cards.getByRole('img');
    const generate = async (prompt, keyboard = false) => {
      await page.getByRole('button', { name: 'Create image', exact: true }).click();
      const input = page.getByRole('textbox', { name: 'Describe your image' });
      await input.fill(prompt);
      if (keyboard) await input.press('Enter');
      else await page.getByRole('button', { name: 'Generate image', exact: true }).click();
    };
    const prompt = 'A small blue square';
    await generate(prompt, true);
    await cards.getByText('Generating', { exact: true }).waitFor();

    const textPrompt = 'Verify ordinary text chat';
    await page.getByRole('button', { name: 'Chat', exact: true }).click();
    await page.getByRole('textbox', { name: 'Message Qwen' }).fill(textPrompt);
    const textRequest = page.waitForRequest(request => request.method() === 'POST' && request.url() === `${base}/api/chat`);
    await page.getByRole('button', { name: 'Send message' }).click();
    assert.deepEqual((await textRequest).postDataJSON().messages, [{ role: 'user', content: textPrompt }]);
    await page.getByText(/This is a sample reply in local preview mode/).waitFor();

    await readyImages.first().evaluate(image => image.decode());
    const downloadEvent = page.waitForEvent('download');
    await cards.getByRole('link', { name: 'Download image' }).click();
    const download = await downloadEvent;
    assert.match(download.suggestedFilename(), /\.png$/i);
    assert.deepEqual(await readFile(await download.path()), imageBytes);

    await cards.getByRole('button', { name: 'Regenerate' }).click();
    await readyImages.nth(1).evaluate(image => image.decode());
    await generate(failedPrompt);
    await cards.filter({ hasText: failedPrompt }).getByText('Error', { exact: true }).waitFor();
    assert.equal(await page.getByText('private upstream fixture error').count(), 0);

    await page.route(`${base}/api/images/**`, route => route.abort());
    await page.reload();
    await readyImages.first().evaluate(image => image.decode());
    await readyImages.nth(1).evaluate(image => image.decode());
    await page.getByRole('button', { name: 'Create image', exact: true }).waitFor();
    for (const width of [320, 390, 1280]) {
      await page.setViewportSize({ width, height: 760 });
      const layout = await page.evaluate(() => {
        const preview = document.querySelector('.image-job-visual').getBoundingClientRect();
        const controls = [...document.querySelectorAll('.composer-modes button, .send-button, .image-job-actions a, .image-job-actions button')];
        return {
          overflow: document.documentElement.scrollWidth > window.innerWidth,
          previewDelta: Math.abs(preview.width - preview.height),
          minControlHeight: Math.min(...controls.map(control => control.getBoundingClientRect().height)),
        };
      });
      assert.equal(layout.overflow, false, `Horizontal overflow at ${width}px`);
      assert.ok(layout.previewDelta < 1, `Image preview is square at ${width}px`);
      if (width < 760) assert.ok(layout.minControlHeight >= 44, `Mobile controls are at least 44px at ${width}px`);
    }
    assert.deepEqual(providerRequests, []);
    assert.deepEqual(browserErrors, []);
    console.log('PASS: Browser generation, download, regeneration, provider failure, independent text chat, reload, and responsive controls');
  } finally {
    await browser.close();
  }
}

try {
  await waitForApp();
  await checkHttp();
  if (process.env.CHAT_TEST_PLAYWRIGHT) await checkBrowser();
} catch (error) {
  console.error(logs);
  throw error;
} finally {
  if (app.pid && app.exitCode === null) {
    if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(app.pid), '/T', '/F'], { stdio: 'ignore' });
    else app.kill('SIGTERM');
  }
}
