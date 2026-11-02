import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const name = 'qwen-chat-test-' + randomBytes(4).toString('hex');
const base = 'http://127.0.0.1:3002';
const token = 'integration-test-token-' + 'x'.repeat(40);
let server; let fixtureProcess; let logs = '';
// Keep the test runner alive while native fetch uses unreferenced timeout handles.
const keepAlive = setInterval(() => {}, 1000);
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitFor(url, headers = {}) {
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(url, { headers, signal: AbortSignal.timeout(1000) }); if (r.ok) return; } catch {}
    if (server?.exitCode != null) throw new Error('Test server exited: ' + logs);
    await sleep(500);
  }
  throw new Error('Test service did not become ready: ' + url);
}
try {
  if (process.env.CHAT_TEST_FIXTURE_PYTHON) {
    fixtureProcess = spawn(process.env.CHAT_TEST_FIXTURE_PYTHON, [resolve(root, '../llm-inference-server/scripts/chat_test_fixture.py')], {
      stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, CHAT_DIAGNOSTICS_ENABLED: 'true', CHAT_FIXTURE_MODEL_PORT: '18000', CHAT_FIXTURE_PORT: '18001' },
    });
    fixtureProcess.stdout.on('data', chunk => logs += chunk); fixtureProcess.stderr.on('data', chunk => logs += chunk);
  } else {
    const fixture = spawnSync('docker', ['run', '-d', '--rm', '--name', name, '-e', 'CHAT_DIAGNOSTICS_ENABLED=true', '-p', '127.0.0.1:18001:8001', '--entrypoint', 'python3', '--mount', `type=bind,source=${resolve(root, '../llm-inference-server/scripts')},target=/tests,readonly`, 'zihan000/qwen-inference:chat-dev', '/tests/chat_test_fixture.py'], { encoding: 'utf8' });
    assert.equal(fixture.status, 0, fixture.stderr);
  }
  await waitFor('http://127.0.0.1:18001/health', { Authorization: 'Bearer ' + token });
  server = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'dev', '--hostname', '127.0.0.1', '--port', '3002'], {
    cwd: root, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NODE_ENV: 'development', NEXT_TELEMETRY_DISABLED: '1', CHAT_DIAGNOSTICS_ENABLED: 'true', CHAT_TEST_DIST_DIR: '.next-integration', CHAT_PASSWORD: 'integration-password-' + 'x'.repeat(24), SESSION_SECRET: randomBytes(32).toString('hex'), RUNPOD_CHAT_URL: 'http://127.0.0.1:18001', RUNPOD_CHAT_TOKEN: token, CHAT_PREVIEW_MODE: 'false' },
  });
  server.stdout.on('data', chunk => logs += chunk); server.stderr.on('data', chunk => logs += chunk);
  await waitFor(base);
  const headers = { 'Content-Type': 'application/json', Origin: base };
  assert.equal((await fetch(base + '/api/status')).status, 401);
  assert.equal((await fetch(base + '/api/login', { method: 'POST', headers: { ...headers, Origin: 'https://evil.example' }, body: '{}' })).status, 403);
  assert.equal((await fetch(base + '/api/login', { method: 'POST', headers, body: JSON.stringify({ password: 'wrong' }) })).status, 401);
  const login = await fetch(base + '/api/login', { method: 'POST', headers, body: JSON.stringify({ password: 'integration-password-' + 'x'.repeat(24) }) });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0]; headers.Cookie = cookie;
  const status = await (await fetch(base + '/api/status', { headers: { Cookie: cookie } })).json();
  assert.equal(status.mode, 'live'); assert.equal(status.ready, true);
  assert.equal(status.limits.contextTokens, 40960);
  assert.equal(status.diagnosticsAvailable, true);
  console.log('PASS: Real HTTP login, cross-origin protection, and gateway health');
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
  assert.match(await response.text(), /"completion_tokens":4/);
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
  assert.equal((await fetch(base + '/api/logout', { method: 'POST', headers })).status, 200);
  console.log('PASS: Cancellation releases gateway capacity; logout clears the session cookie');
} finally {
  clearInterval(keepAlive);
  if (server && server.exitCode == null) {
    if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(server.pid), '/T', '/F'], { stdio: 'ignore' });
    else server.kill('SIGTERM');
  }
  spawnSync('docker', ['rm', '-f', name], { stdio: 'ignore' });
  if (fixtureProcess && fixtureProcess.exitCode == null) {
    if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(fixtureProcess.pid), '/T', '/F'], { stdio: 'ignore' });
    else fixtureProcess.kill('SIGTERM');
  }
}
