import { startAuthFixture } from "./auth-test-fixture.mjs";
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const name = 'qwen-chat-test-' + randomBytes(4).toString('hex');
const base = 'http://127.0.0.1:3002';
const token = 'integration-test-token-' + 'x'.repeat(40);
const fixturePython = process.env.CHAT_TEST_FIXTURE_PYTHON;
const fixtureRoot = resolve(root, process.env.CHAT_TEST_FIXTURE_ROOT ?? '../llm-inference-server');
const imageInput = process.env.CHAT_TEST_IMAGE_INPUT === 'true';
const imageGateway = 'http://127.0.0.1:18003';
const password = randomBytes(24).toString('hex');
assert.ok(!imageInput || fixturePython, 'Set CHAT_TEST_FIXTURE_PYTHON for the image input integration check');
let authFixture; let server; let logs = '';
const fixtures = [];
// Keep the test runner alive while native fetch uses unreferenced timeout handles.
const keepAlive = setInterval(() => {}, 1000);
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitFor(url, headers = {}) {
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(url, { headers, signal: AbortSignal.timeout(1000) }); if (r.ok) return; } catch {}
    if (server?.exitCode != null || fixtures.some(fixture => fixture.exitCode !== null)) throw new Error('Test server exited');
    await sleep(500);
  }
  throw new Error('Test service did not become ready: ' + url);
}
function startFixture(modelPort, port, vision = false) {
  const fixture = spawn(fixturePython, [resolve(fixtureRoot, 'scripts/chat_test_fixture.py')], {
    stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, CHAT_DIAGNOSTICS_ENABLED: 'true',
      CHAT_FIXTURE_MODEL_PORT: modelPort, CHAT_FIXTURE_PORT: port, CHAT_FIXTURE_IMAGE_INPUT: String(vision), CHAT_FIXTURE_ADAPTER: 'false' },
  });
  fixtures.push(fixture);
  fixture.stdout.on('data', chunk => logs += chunk); fixture.stderr.on('data', chunk => logs += chunk);
}
try {
  authFixture = await startAuthFixture(password);
  if (fixturePython) {
    startFixture('18000', '18001');
    if (imageInput) startFixture('18002', '18003', true);
  } else {
    const fixture = spawnSync('docker', ['run', '-d', '--rm', '--name', name, '-e', 'CHAT_DIAGNOSTICS_ENABLED=true', '-p', '127.0.0.1:18001:8001', '--entrypoint', 'python3', '--mount', `type=bind,source=${resolve(fixtureRoot, 'scripts')},target=/tests,readonly`, 'zihan000/qwen-inference:chat-dev', '/tests/chat_test_fixture.py'], { encoding: 'utf8' });
    assert.equal(fixture.status, 0, fixture.stderr);
  }
  await waitFor('http://127.0.0.1:18001/health', { Authorization: 'Bearer ' + token });
  if (imageInput) await waitFor(imageGateway + '/health', { Authorization: 'Bearer ' + token });
  server = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'dev', '--hostname', '127.0.0.1', '--port', '3002'], {
    cwd: root, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NODE_ENV: 'development', NEXT_TELEMETRY_DISABLED: '1', CHAT_DIAGNOSTICS_ENABLED: 'true', CHAT_TEST_DIST_DIR: '.next-integration', NEXT_PUBLIC_SUPABASE_URL: authFixture.url, NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "fixture-public-key", RUNPOD_CHAT_URL: 'http://127.0.0.1:18001', RUNPOD_CHAT_TOKEN: token, CHAT_PREVIEW_MODE: 'false',
      RUNPOD_BF16_CHAT_URL: imageInput ? imageGateway : '', RUNPOD_BF16_CHAT_TOKEN: imageInput ? token : '', RUNPOD_IMAGE_API_KEY: '' },
  });
  server.stdout.on('data', chunk => logs += chunk); server.stderr.on('data', chunk => logs += chunk);
  await waitFor(base);
  const headers = { 'Content-Type': 'application/json', Origin: base };
  assert.equal((await fetch(base + '/api/status')).status, 401);
  assert.equal((await fetch(base + '/api/login', { method: 'POST', headers: { ...headers, Origin: 'https://evil.example' }, body: '{}' })).status, 403);
  assert.equal((await fetch(base + '/api/login', { method: 'POST', headers, body: JSON.stringify({ password }) })).status, 410);
  const login = await fetch(authFixture.url + '/auth/v1/token?grant_type=password', { method: 'POST', headers, body: JSON.stringify({ email: 'test@example.com', password }) });
  assert.equal(login.status, 200);
  const session = await login.json();
  const cookie = 'sb-127-auth-token=base64-' + Buffer.from(JSON.stringify(session)).toString('base64url'); headers.Cookie = cookie;
  const status = await (await fetch(base + '/api/status', { headers: { Cookie: cookie } })).json();
  assert.equal(status.mode, 'live'); assert.equal(status.ready, true);
  assert.equal(status.limits.contextTokens, 40960);
  assert.equal(status.diagnosticsAvailable, true);
  console.log('PASS: Supabase HTTP session fixture, retired shared login, origin protection, and gateway health');
  const chat = messages => fetch(base + '/api/chat', { method: 'POST', headers, body: JSON.stringify({ messages, max_tokens: 384 }) });
  let response = await chat([{ role: 'user', content: 'Hello' }]);
  assert.equal(response.status, 200); assert.match(response.headers.get('content-type'), /text\/event-stream/);
  assert.match(await response.text(), /\[DONE\]/);
  response = await chat([{ role: 'user', content: 'old' }, { role: 'assistant', content: 'answer' }, { role: 'user', content: 'new' }]);
  assert.equal(response.headers.get('X-Context-Trimmed'), '2'); await response.text();
  assert.equal((await chat([{ role: 'system', content: 'override' }])).status, 400);
  const settings = { inputCharacters: 20, outputTokens: 512, contextTokens: 2048, historyMessages: 3, historyBytes: 4096, requestBytes: 8192, timeoutSeconds: 30, safetyTokens: 64 };
  response = await fetch(base + '/api/chat', { method: 'POST', headers, body: JSON.stringify({ messages: [{ role: 'user', content: 'Configured request' }], max_tokens: 512, settings }) });
  assert.equal(response.status, 200); assert.match(await response.text(), /\[DONE\]/);
  response = await fetch(base + '/api/chat', { method: 'POST', headers, body: JSON.stringify({ messages: [{ role: 'user', content: 'x'.repeat(21) }], max_tokens: 512, settings }) });
  assert.equal(response.status, 400);
  console.log('PASS: App → real gateway → model fixture streaming, context trimming, and validation');
  const diagnosticChat = prompt => fetch(base + '/api/chat', { method: 'POST', headers: { ...headers, 'X-Chat-Diagnostics': '1' }, body: JSON.stringify({ messages: prompt, max_tokens: 384 }) });
  response = await diagnosticChat([{ role: 'user', content: 'old' }, { role: 'assistant', content: 'answer' }, { role: 'user', content: 'new' }]);
  assert.equal(response.status, 200);
  const diagnostic = JSON.parse(response.headers.get('X-Chat-Diagnostics'));
  assert.equal(diagnostic.inputTokensBefore, 50000); assert.equal(diagnostic.inputTokensAfter, 100); assert.equal(diagnostic.gatewayTrimmedMessages, 2);
  const timedStream = await response.text();
  assert.match(timedStream, /"completion_tokens":4/);
  const timing = JSON.parse(/event: chat-timing\ndata: ([^\n]+)/.exec(timedStream)[1]);
  assert.equal(timing.requestId, diagnostic.requestId);
  assert.ok(timing.timings.contextFitMs >= 0);
  assert.ok(timing.timings.gatewayTotalMs >= timing.timings.gatewayFirstContentMs);
  assert.ok(timedStream.indexOf('event: chat-timing') < timedStream.indexOf('data: [DONE]'));
  response = await diagnosticChat([{ role: 'user', content: 'oversized' }]);
  assert.equal(response.status, 400); assert.equal(JSON.parse(response.headers.get('X-Chat-Diagnostics')).inputTokensAfter, null);
  response = await diagnosticChat([{ role: 'user', content: 'length-test' }]);
  assert.equal(response.status, 200); assert.match(await response.text(), /"finish_reason": "length"/);
  console.log('PASS: Opt-in diagnostic headers, exact trimming counts, final usage, length finish reason, and oversized rejection');
  const abort = new AbortController();
  response = await fetch(base + '/api/chat', { method: 'POST', headers, signal: abort.signal, body: JSON.stringify({ messages: [{ role: 'user', content: 'slow' }] }) });
  const reader = response.body.getReader(); await reader.read(); abort.abort(); await reader.cancel().catch(() => {});
  await sleep(700);
  response = await chat([{ role: 'user', content: 'After cancellation' }]);
  assert.equal(response.status, 200); await response.text();
  const pending = []; const running = [];
  async function admissionIs(active, waiting) {
    for (let attempt = 0; attempt < 80; attempt++) {
      const health = await (await fetch('http://127.0.0.1:18001/health', { headers: { Authorization: 'Bearer ' + token } })).json();
      if (health.admission.activeRequests === active && health.admission.waitingRequests === waiting) return;
      await sleep(25);
    }
    throw new Error(`Admission did not reach ${active} active / ${waiting} waiting`);
  }
  try {
    for (let index = 0; index < 2; index++) {
      const abort = new AbortController();
      const response = await fetch(base + '/api/chat', { method: 'POST', headers, signal: abort.signal, body: JSON.stringify({ messages: [{ role: 'user', content: 'slow' }] }) });
      assert.equal(response.status, 200);
      const reader = response.body.getReader(); await reader.read();
      running.push({ abort, reader });
    }
    await admissionIs(2, 0);
    for (let index = 0; index < 6; index++) {
      const abort = new AbortController();
      const result = fetch(base + '/api/chat', { method: 'POST', headers, signal: abort.signal, body: JSON.stringify({ messages: [{ role: 'user', content: 'Waiting request ' + index }] }) }).then(async response => ({ status: response.status, body: await response.text() })).catch(error => ({ error: error.name }));
      pending.push({ abort, result });
    }
    await admissionIs(2, 6);
    response = await chat([{ role: 'user', content: 'Queue overflow' }]);
    assert.equal(response.status, 429); assert.match((await response.json()).error, /waiting queue is full/);
    pending[0].abort.abort(); await pending[0].result;
    await admissionIs(2, 5);
    response = await fetch(base + '/api/chat', { method: 'POST', headers, body: JSON.stringify({ messages: [{ role: 'user', content: 'Queue timeout' }], max_tokens: 128, settings: { timeoutSeconds: 1, outputTokens: 128 } }) });
    // The proxy and gateway share one budget; either may expire first.
    assert.equal(response.status, 504); assert.match((await response.json()).error, /timed out while waiting/);
    await admissionIs(2, 5);
    console.log('PASS: Two simultaneous HTTP streams, six queued requests, queue-full message, queued disconnect, and bounded wait');
  } finally {
    for (const item of pending) item.abort.abort();
    for (const item of running) { item.abort.abort(); await item.reader.cancel().catch(() => {}); }
    await Promise.all(pending.map(item => item.result));
  }
  await admissionIs(0, 0);
  response = await chat([{ role: 'user', content: 'After queue cleanup' }]);
  assert.equal(response.status, 200); await response.text();
  if (imageInput) {
    const { checkImageInput } = await import('./check-image-input.mjs');
    await checkImageInput({ base, gateway: imageGateway, token, headers, password });
  }
  assert.equal((await fetch(base + '/api/logout', { method: 'POST', headers })).status, 200);
  assert.equal((await fetch(base + '/api/status', { headers: { Cookie: cookie } })).status, 401);
  console.log('PASS: Cancellation releases capacity; logout revokes the session and rejects replay');
  if (process.env.CHAT_TEST_PLAYWRIGHT) {
    const { checkAccounts } = await import('./check-accounts.mjs');
    await checkAccounts(base, password, authFixture, admissionIs);
    // Protocol/account checks share the real gateway's global 60-second rate window.
    // Let that window expire before the independent concurrent-stream UI check.
    await sleep(60_000);
    const { checkBrowserTimings } = await import('./check-browser-timings.mjs');
    await checkBrowserTimings(base, password, admissionIs);
  }
} catch (error) {
  console.error(logs);
  throw error;
} finally {
  clearInterval(keepAlive);
  authFixture?.server.close();
  if (server && server.exitCode == null) {
    if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(server.pid), '/T', '/F'], { stdio: 'ignore' });
    else server.kill('SIGTERM');
  }
  if (!fixturePython) spawnSync('docker', ['rm', '-f', name], { stdio: 'ignore' });
  for (const fixture of fixtures) {
    if (fixture.exitCode !== null) continue;
    if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(fixture.pid), '/T', '/F'], { stdio: 'ignore' });
    else fixture.kill('SIGTERM');
  }
}
