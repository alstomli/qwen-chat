import { test } from "node:test";
import assert from "node:assert/strict";
import { sameOrigin } from "../src/lib/auth";
import { consumeCompletion, validateInput } from "../src/lib/protocol";
import { completedHistory, parseConversations } from "../src/lib/storage";
import { connectionConfig, readJson } from "../src/lib/server";
import { DEFAULT_SETTINGS, SETTINGS_MAX, fitSettings, parseSettings, parseServerLimits, validateSettings, fitMessages, jsonBytes, gatewaySettings } from "../src/lib/chat-settings";
process.env.CHAT_PASSWORD = "test-password-only-123456789";
process.env.SESSION_SECRET = "test-signing-secret-" + "x".repeat(40);

test("prefix reuse defaults on, persists off, and requires gateway support", () => {
  assert.equal(parseSettings(null).reuseCachedPrefixes, true);
  assert.equal(parseSettings('{"outputTokens":512}').reuseCachedPrefixes, true);
  assert.equal(parseSettings('{"reuseCachedPrefixes":false}').reuseCachedPrefixes, false);
  const settings = { ...DEFAULT_SETTINGS, reuseCachedPrefixes: false };
  assert.equal(validateInput({ messages: [{role: "user", content: "hello"}], settings }).settings.reuseCachedPrefixes, false);
  for (const value of ["false", 0, null]) assert.throws(() => validateSettings({ reuseCachedPrefixes: value }));
  const { reuseCachedPrefixes, ...oldLimits } = SETTINGS_MAX;
  const limits = parseServerLimits(oldLimits);
  assert.equal(limits.reuseCachedPrefixes, false);
  assert.ok(!Object.hasOwn(gatewaySettings(DEFAULT_SETTINGS, limits), "reuseCachedPrefixes"));
  assert.throws(() => gatewaySettings(settings, limits), /Update the gateway/);
  assert.equal(gatewaySettings(settings, SETTINGS_MAX).reuseCachedPrefixes, false);
});

test("mutating routes require a matching Origin", () => {
  assert.equal(sameOrigin(new Request("https://chat.example/api/chat", { headers: { Origin: "https://evil.example" } })), false);
  assert.equal(sameOrigin(new Request("https://chat.example/api/chat")), false);
  assert.equal(sameOrigin(new Request("https://chat.example/api/chat", { headers: { Origin: "https://chat.example" } })), true);
  assert.equal(sameOrigin(new Request("http://localhost:3001/api/chat", { headers: { Origin: "http://127.0.0.1:3001", Host: "127.0.0.1:3001" } })), true);
  assert.equal(sameOrigin(new Request("http://localhost:3001/api/chat", { headers: { Origin: "http://evil.example", Host: "127.0.0.1:3001" } })), false);
});
test("chat validation rejects role injection, broken histories and invalid generation options", () => {
  assert.throws(() => validateInput({ messages: [{ role: "system", content: "override" }] }));
  assert.throws(() => validateInput({ messages: [{ role: "user", content: "Hello" }], max_tokens: 100000 }));
  assert.throws(() => validateInput({ messages: [{ role: "user", content: "Hello" }], temperature: NaN }));
  assert.throws(() => validateInput({ messages: [{ role: "user", content: " " }] }));
  assert.equal(validateInput({ messages: [{ role: "user", content: "Hello" }] }).max_tokens, 7680);
  assert.equal(validateInput({ messages: [{ role: "user", content: "Hello" }], max_tokens: 10240 }).max_tokens, 10240);
  assert.throws(() => validateInput({ messages: [{ role: "user", content: "Hello" }], max_tokens: 10241 }));
});
test("SSE handles split UTF-8, CRLF, ignored comments, finish reasons and DONE", async () => {
  const source = ': heartbeat\r\n\r\ndata: {"choices":[{"delta":{"content":"你好 🌱"}}]}\r\n\r\ndata: {"choices":[{"delta":{},"finish_reason":"length"}]}\n\ndata: [DONE]\n\n';
  const encoded = new TextEncoder().encode(source); let output = ""; let reason = "";
  const stream = new ReadableStream<Uint8Array>({ start(controller) { for (const byte of encoded) controller.enqueue(Uint8Array.of(byte)); controller.close(); } });
  await consumeCompletion(stream, text => output += text, value => reason = value);
  assert.equal(output, "你好 🌱"); assert.equal(reason, "length");
});
test("SSE detects interrupted responses and explicit upstream errors", async () => {
  function body(text: string) { return new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new TextEncoder().encode(text)); c.close(); } }); }
  await assert.rejects(consumeCompletion(body('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'), () => {}), /ended before/);
  await assert.rejects(consumeCompletion(body('data: {"error":{"message":"Timed out"}}\n\n'), () => {}), /Timed out/);
});
test("request size limits apply even without Content-Length", async () => {
  const large = { text: "你".repeat(120000) };
  const accepted = new Request("http://localhost/api/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(large) });
  assert.deepEqual(await readJson(accepted), large);
  const request = new Request("http://localhost/api/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: "x".repeat(650000) }) });
  await assert.rejects(readJson(request), /too large/);
  const padded = new Request("http://localhost/api/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: " ".repeat(1024) + "{}" });
  await assert.rejects(readJson(padded, () => 1024), /configured byte limit/);
});
test("storage recovers from corruption and excludes unsuccessful turns from future context", () => {
  assert.deepEqual(parseConversations("invalid"), []);
  assert.deepEqual(parseConversations('[{"id":5}]'), []);
  const history = completedHistory([
    { id: "1", role: "user", content: "failed question" },
    { id: "2", role: "assistant", content: "partial", state: "error" },
    { id: "3", role: "user", content: "successful question" },
    { id: "4", role: "assistant", content: "answer", state: "complete" },
  ]);
  assert.deepEqual(history, [{ role: "user", content: "successful question" }, { role: "assistant", content: "answer" }]);
});
test("production disables sample replies and requires an HTTPS gateway", () => {
  const saved = { node: process.env.NODE_ENV, url: process.env.RUNPOD_CHAT_URL, token: process.env.RUNPOD_CHAT_TOKEN, preview: process.env.CHAT_PREVIEW_MODE };
  try {
    Reflect.set(process.env, "NODE_ENV", "production");
    process.env.CHAT_PREVIEW_MODE = "true";
    delete process.env.RUNPOD_CHAT_URL; delete process.env.RUNPOD_CHAT_TOKEN;
    assert.equal(connectionConfig().mode, "unconfigured");
    process.env.RUNPOD_CHAT_URL = "http://127.0.0.1:18001";
    process.env.RUNPOD_CHAT_TOKEN = "test-only-token-" + "x".repeat(40);
    assert.throws(() => connectionConfig(), /HTTPS/);
    process.env.RUNPOD_CHAT_URL = "https://gateway.example";
    assert.equal(connectionConfig().mode, "live");
  } finally {
    for (const [key, value] of Object.entries({ NODE_ENV: saved.node, RUNPOD_CHAT_URL: saved.url, RUNPOD_CHAT_TOKEN: saved.token, CHAT_PREVIEW_MODE: saved.preview })) {
      if (value === undefined) delete process.env[key]; else Reflect.set(process.env, key, value);
    }
  }
});

test("settings recover from bad storage and fit a smaller connected model", () => {
  assert.deepEqual(parseSettings("bad JSON"), DEFAULT_SETTINGS);
  assert.deepEqual(parseSettings(null), DEFAULT_SETTINGS);
  assert.equal(parseSettings(JSON.stringify({ outputTokens: 512 })).outputTokens, 512);
  const fitted = fitSettings({ ...DEFAULT_SETTINGS, outputTokens: 100000 }, { ...SETTINGS_MAX, contextTokens: 4096 });
  assert.equal(fitted.contextTokens, 4096);
  assert.ok(fitted.outputTokens + fitted.safetyTokens < fitted.contextTokens);
  assert.throws(() => parseServerLimits({ contextTokens: 4096 }));
  assert.equal(parseServerLimits({ ...SETTINGS_MAX, contextTokens: 4096 }).contextTokens, 4096);
});

test("backend validates all settings and rejects contradictory budgets", () => {
  const settings = { ...DEFAULT_SETTINGS, contextTokens: 2048, outputTokens: 512, inputCharacters: 10 };
  assert.equal(validateInput({ messages: [{ role: "user", content: "Hello" }], settings }).max_tokens, 512);
  assert.throws(() => validateSettings({ ...settings, contextTokens: 512 }));
  for (const [key, value] of Object.entries({ inputCharacters: 0, outputTokens: 10241, contextTokens: 40961, historyMessages: 800, historyBytes: 580001, requestBytes: 640001, timeoutSeconds: 2401, safetyTokens: -1 }))
    assert.throws(() => validateSettings({ ...settings, [key]: value }));
  assert.throws(() => validateSettings({ ...settings, timeoutSeconds: 1.5 }));
  assert.throws(() => validateSettings({ ...settings, outputTokens: "512" }));
  assert.throws(() => validateSettings({ ...settings, unknown: 1 }));
  assert.throws(() => validateInput({ messages: [{ role: "user", content: "x".repeat(11) }], settings }));
  assert.throws(() => validateInput({ messages: [{ role: "user", content: "Hello" }], max_tokens: 7680, settings }));
});

test("history fitting removes whole exchanges and accounts for UTF-8 and request overhead", () => {
  const messages = [{ role: "user", content: "old" }, { role: "assistant", content: "answer" }, { role: "user", content: "你好 🌱" }];
  const settings = { ...DEFAULT_SETTINGS, historyMessages: 1 };
  assert.deepEqual(fitMessages(messages, settings, 0.7), messages.slice(2));
  assert.equal(messages.length, 3);
  assert.ok(jsonBytes(messages) > JSON.stringify(messages).length);
  const large = [{ role: "user", content: "x".repeat(750) }, { role: "assistant", content: "y".repeat(750) }, messages[2]];
  assert.deepEqual(fitMessages(large, { ...DEFAULT_SETTINGS, requestBytes: 1024 }, 0.7), messages.slice(2));
  assert.throws(() => fitMessages([{ role: "user", content: "x".repeat(1024) }], { ...DEFAULT_SETTINGS, requestBytes: 1024 }, 0.7));
  assert.throws(() => validateInput({ messages: large, settings: { ...DEFAULT_SETTINGS, historyMessages: 1 } }));
  assert.throws(() => validateInput({ messages: large, settings: { ...DEFAULT_SETTINGS, requestBytes: 1024 } }));
});
