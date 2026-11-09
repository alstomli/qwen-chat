// Local-only regression: real auth SDK/API proxy/UI, fake auth and streamed gateway.
// CHAT_TEST_PLAYWRIGHT=/absolute/path/to/playwright/index.mjs node scripts/check-assistant-images.mjs
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { startAuthFixture } from './auth-test-fixture.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const base = 'http://127.0.0.1:3002';
const imageBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGMIr+0AAAKLAV1gTX3oAAAAAElFTkSuQmCC', 'base64');
const imageData = 'data:image/png;base64,' + imageBytes.toString('base64');
const tracker = 'https://tracker.invalid/assistant-image-probe?private=fake-answer';
const chunks = [
  `**Useful answer**\n\n![inline](${tracker})\n\n![local](${base}/assistant-image-probe.png)\n\nStream stage one.\n\n![reference][pixel]\n\n`,
  `[pixel]: ${tracker}&reference=true\n\n[![linked](${tracker}&linked=true)](https://example.com/docs)\n\n![data](${imageData})\n\n![blob](blob:${base}/assistant-image-probe)\n\nStream stage two.\n\n![unfinished](`,
  `${tracker}&partial=true)\n\n[Documentation](https://example.com/docs)\n\n| A | B |\n| - | - |\n| one | two |\n\n\`\`\`md\n![code](${tracker})\n\`\`\`\n\n<img src="${tracker}&raw=true">\n\nSecurity check complete.`,
];
const limits = { inputCharacters: 120000, outputTokens: 10240, contextTokens: 40960,
  historyMessages: 799, historyBytes: 580000, requestBytes: 640000,
  timeoutSeconds: 2400, safetyTokens: 4096, reuseCachedPrefixes: true };
const keepAlive = setInterval(() => {}, 1000);
let app, browser, auth, gateway, activeStream, logs = '';
const payloads = [];
const tick = ms => new Promise(resolve => setTimeout(resolve, ms));

async function waitFor(test, label) {
  for (let attempt = 0; attempt < 120; attempt++) {
    if (app?.exitCode != null) throw new Error('Local app exited');
    try { if (await test()) return; } catch { /* Wait for local startup/state. */ }
    await tick(250);
  }
  throw new Error('Timed out: ' + label);
}

function advanceStream(index) {
  assert.ok(activeStream, 'No gateway stream received');
  activeStream.write(`data: ${JSON.stringify({ choices: [{ delta: { content: chunks[index] } }] })}\n\n`);
  if (index === chunks.length - 1) {
    activeStream.end('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
    activeStream = undefined;
  }
}

async function checkBrowser(bypassCSP) {
  // Repeat with CSP bypassed to prove the renderer itself prevents requests/preloads.
  const context = await browser.newContext({ bypassCSP });
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: base });
  const page = await context.newPage();
  page.setDefaultTimeout(20_000);
  const requests = [], errors = [], statuses = [];
  page.on('response', response => {
    if (response.url().includes('/api/status?')) void response.json().then(status => statuses.push(status)).catch(() => {});
  });
  page.on('request', request => {
    if (request.url().includes('assistant-image-probe')) requests.push(request.url());
  });
  page.on('pageerror', error => errors.push(error.message));
  await page.route('https://tracker.invalid/**', route => route.abort());
  await page.route(`${base}/assistant-image-probe*`, route => route.abort());
  await page.addInitScript(() => {
    window.assistantImageNodes = [];
    const record = node => {
      if (!(node instanceof Element)) return;
      const candidates = [node, ...node.querySelectorAll('img, link[as="image"]')];
      for (const element of candidates) {
        if (element.matches('link[as="image"]') ||
          (element.matches('img') && element.closest('.assistant'))) {
          window.assistantImageNodes.push(element.outerHTML);
        }
      }
    };
    new MutationObserver(records => {
      for (const mutation of records) for (const node of mutation.addedNodes) record(node);
    }).observe(document, { childList: true, subtree: true });
  });
  try {
    const signIn = await page.goto(base);
    assert.equal(signIn.headers()['content-security-policy'], "img-src 'self' data: blob:;");
    await page.locator('img[src="/google-g.png"]').waitFor();
    assert.equal(await page.locator('img[src="/google-g.png"]').evaluate(async img => { await img.decode(); return img.naturalWidth > 0; }), true);
    auth.setNextIdentity('test@example.com');
    await page.getByRole('button', { name: 'Continue with Google', exact: true }).click();
    // The model select is server-rendered; wait for client effects before changing it.
    await waitFor(() => statuses.some(status => status.model === 'bf16' && status.ready), 'hydrated model capabilities');
    await page.getByRole('combobox', { name: 'Model', exact: true }).selectOption('bf16');
    await page.locator('button[aria-label="Attach image"]:not(:disabled)').waitFor();
    await page.locator('input[type=file]').setInputFiles({ name: 'fixture.png', mimeType: 'image/png', buffer: imageBytes });
    const preview = page.getByRole('img', { name: 'Image preview', exact: true });
    await preview.waitFor();
    assert.equal(await preview.evaluate(async img => { await img.decode(); return img.naturalWidth > 0; }), true);
    const prompt = `Security image test ${bypassCSP ? 'renderer alone' : 'with CSP'}`;
    await page.getByRole('textbox', { name: 'Message Kiddo' }).fill(prompt);
    const request = page.waitForRequest(request => request.url() === base + '/api/chat' && request.method() === 'POST');
    await page.getByRole('button', { name: 'Send message' }).click();
    const posted = (await request).postDataJSON();
    assert.equal(posted.image, imageData);
    await waitFor(() => activeStream !== undefined, 'gateway accepted image');
    assert.equal(payloads.at(-1).image, imageData);
    for (const [index, marker] of ['Stream stage one.', 'Stream stage two.', 'Security check complete.'].entries()) {
      advanceStream(index);
      await page.locator('.assistant').filter({ hasText: marker }).waitFor();
      assert.equal(await page.locator('.assistant img, link[as="image"]').count(), 0);
      assert.deepEqual(await page.evaluate(() => window.assistantImageNodes), []);
      assert.deepEqual(requests, []);
    }
    await page.getByRole('button', { name: 'Send message' }).waitFor();
    const sent = page.getByRole('img', { name: 'Attached image', exact: true });
    assert.equal(await sent.evaluate(async img => { await img.decode(); return img.naturalWidth > 0; }), true);
    const answer = page.locator('.assistant').last();
    assert.equal(await answer.locator('strong').textContent(), 'Useful answer');
    assert.equal(await answer.getByRole('link', { name: 'Documentation', exact: true }).getAttribute('href'), 'https://example.com/docs');
    assert.equal(await answer.locator('table').count(), 1);
    assert.match(await answer.locator('pre code').textContent(), /!\[code\]/);
    await answer.locator('.code-block').getByRole('button', { name: 'Copy code', exact: true }).click();
    await answer.locator('.code-block').getByRole('button', { name: 'Copy code', exact: true }).filter({ hasText: 'Copied' }).waitFor();
    assert.match(await page.evaluate(() => navigator.clipboard.readText()), /^!\[code\]/);
    await answer.locator('.message-actions').getByRole('button', { name: 'Copy response', exact: true }).click();
    await answer.locator('.message-actions').getByRole('button', { name: 'Copied', exact: true }).waitFor();
    assert.equal((await page.evaluate(() => navigator.clipboard.readText())).replace(/\r\n/g, '\n'), chunks.join(''));
    await waitFor(() => [...(auth.history.get(auth.users.get('test@example.com').user.id)?.values() ?? [])]
      .some(row => row.payload.title === prompt && row.payload.messages.at(-1)?.content === chunks.join('')), 'completed cloud history save');
    await page.reload();
    await page.getByRole('button', { name: prompt, exact: true }).click();
    await page.locator('.assistant').filter({ hasText: 'Security check complete.' }).waitFor();
    assert.equal(await page.locator('.assistant img, link[as="image"]').count(), 0);
    assert.deepEqual(await page.evaluate(() => window.assistantImageNodes), []);
    assert.deepEqual(requests, []);
    assert.equal(await page.getByRole('img', { name: 'Attached image', exact: true }).count(), 0, 'Attachment bytes should stay session-only');
    assert.equal(await page.locator('.message-attachment').getByText('fixture.png', { exact: true }).count(), 1);
    assert.deepEqual(errors, []);
    console.log(`PASS: ${bypassCSP ? 'CSP bypassed' : 'CSP enforced'}: staged SSE/reloaded images absent, no preloads/probe requests; previews, links, tables, code/copy preserved`);

    if (!bypassCSP) {
      // Verify the header also blocks an accidentally introduced external image.
      const blocked = page.waitForEvent('requestfailed', { predicate: request => request.url() === tracker + '&csp=true' });
      const violation = await page.evaluate(url => new Promise((resolve, reject) => {
        const timer = setTimeout(() => { document.removeEventListener('securitypolicyviolation', onViolation); reject(new Error('No image CSP violation received')); }, 5000);
        function onViolation(event) {
          if (event.blockedURI !== url) return;
          clearTimeout(timer); document.removeEventListener('securitypolicyviolation', onViolation);
          resolve(event.effectiveDirective);
        }
        document.addEventListener('securitypolicyviolation', onViolation);
        const image = new Image(); image.src = url; document.body.append(image);
      }), tracker + '&csp=true');
      assert.equal(violation, 'img-src');
      assert.match((await blocked).failure()?.errorText ?? '', /csp/i);
      console.log('PASS: CSP independently rejects an external image (img-src violation and CSP request failure)');
    }
  } catch (error) {
    console.error('Browser state:', JSON.stringify({ statuses, model: await page.getByRole('combobox', { name: 'Model', exact: true }).inputValue().catch(() => null),
      imageHelp: await page.locator('#image-input-help').textContent().catch(() => null), errors }));
    throw error;
  } finally { await context.close(); }
}

try {
  assert.ok(process.env.CHAT_TEST_PLAYWRIGHT, 'Set CHAT_TEST_PLAYWRIGHT to an installed Playwright index.mjs (no package download required)');
  const { chromium } = await import(pathToFileURL(process.env.CHAT_TEST_PLAYWRIGHT).href);
  auth = await startAuthFixture();
  gateway = createServer(async (req, res) => {
    if (req.url === '/health') {
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({ ready: true, model: 'qwen-bf16', settingsVersion: 1, limits,
        imageInputVersion: 1, imageInput: { maxBytes: 262144, maxDimension: 2048, mimeTypes: ['image/png', 'image/jpeg', 'image/webp'] } }));
    }
    assert.equal(req.url, '/v1/chat/completions');
    let raw = ''; for await (const part of req) raw += part;
    payloads.push(JSON.parse(raw));
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'X-Chat-Image-Accepted': 'true' });
    res.flushHeaders(); activeStream = res;
  });
  await new Promise(resolve => gateway.listen(18003, '127.0.0.1', resolve));
  app = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'dev', '--hostname', '127.0.0.1', '--port', '3002', '--webpack'], {
    cwd: root, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env,
      NODE_ENV: 'development', NEXT_TELEMETRY_DISABLED: '1', CHAT_TEST_DIST_DIR: '.next-integration',
      NEXT_PUBLIC_SUPABASE_URL: auth.url, NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'fixture-public-key',
      RUNPOD_CHAT_URL: '', RUNPOD_CHAT_TOKEN: '', RUNPOD_BF16_CHAT_URL: 'http://127.0.0.1:18003',
      RUNPOD_BF16_CHAT_TOKEN: 'local-fixture-token-' + 'x'.repeat(40), CHAT_PREVIEW_MODE: 'false' },
  });
  app.stdout.on('data', chunk => logs += chunk); app.stderr.on('data', chunk => logs += chunk);
  await waitFor(async () => (await fetch(base, { signal: AbortSignal.timeout(5000) })).ok, 'local app startup');
  browser = await chromium.launch({ headless: true, channel: process.env.CHAT_TEST_BROWSER_CHANNEL });
  await checkBrowser(false);
  await checkBrowser(true);
} catch (error) {
  console.error(logs);
  throw error;
} finally {
  clearInterval(keepAlive);
  activeStream?.destroy();
  await browser?.close();
  auth?.server.closeAllConnections(); auth?.server.close();
  gateway?.closeAllConnections(); gateway?.close();
  if (app && app.exitCode == null) {
    if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(app.pid), '/T', '/F'], { stdio: 'ignore' });
    else app.kill('SIGTERM');
  }
}
