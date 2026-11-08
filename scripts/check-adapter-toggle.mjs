// Run against a local app connected to chat_test_fixture.py in adapter mode.
import assert from 'node:assert/strict';
const base = process.env.CHAT_ADAPTER_TEST_BASE ?? 'http://127.0.0.1:3003';
assert.ok(['127.0.0.1', 'localhost'].includes(new URL(base).hostname), 'Use a local fixture app only');
const headers = { Origin: base, 'Content-Type': 'application/json' };
assert.ok(process.env.CHAT_ADAPTER_TEST_COOKIE, 'Set CHAT_ADAPTER_TEST_COOKIE to a verified fixture account session cookie');
headers.Cookie = process.env.CHAT_ADAPTER_TEST_COOKIE;
const status = await (await fetch(base + '/api/status?model=bf16', { headers })).json();
assert.equal(status.ready, true); assert.equal(status.adapterToggleAvailable, true);
for (const enabled of [true, false, true]) {
  const response = await fetch(base + '/api/chat', { method: 'POST', headers, body: JSON.stringify({
    model: 'bf16', useAdapter: enabled, messages: [{ role: 'user', content: 'Adapter integration fixture' }], max_tokens: 128,
  }) });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('X-Chat-Adapter-Enabled'), String(enabled));
  const stream = await response.text();
  assert.match(stream, /\[DONE\]/);
  assert.ok(stream.includes(`using ${enabled ? 'qwen-bf16.' : 'qwen-bf16-base.'}`));
}
const invalid = await fetch(base + '/api/chat', { method: 'POST', headers, body: JSON.stringify({
  model: '4bit', useAdapter: false, messages: [{ role: 'user', content: 'invalid' }], max_tokens: 128,
}) });
assert.equal(invalid.status, 400);
console.log('PASS: local app → real gateway → model fixture; on/off/on routes, confirmation headers, completed streams and 4bit rejection');
