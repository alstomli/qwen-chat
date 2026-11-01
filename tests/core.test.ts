import { test } from "node:test";
import assert from "node:assert/strict";
import { issueSession, validSession, passwordMatches, sameOrigin, allowLogin, credentialsConfigured } from "../src/lib/auth";
import { consumeCompletion, validateInput } from "../src/lib/protocol";
import { completedHistory, parseConversations } from "../src/lib/storage";
import { connectionConfig, readJson } from "../src/lib/server";
process.env.CHAT_PASSWORD = "test-password-only-123456789";
process.env.SESSION_SECRET = "test-signing-secret-" + "x".repeat(40);

test("short passwords work while missing credentials and weak session secrets stay blocked", () => {
  const password = process.env.CHAT_PASSWORD; const secret = process.env.SESSION_SECRET;
  try {
    process.env.CHAT_PASSWORD = "x";
    assert.equal(credentialsConfigured(), true);
    assert.equal(passwordMatches("x"), true);
    assert.equal(passwordMatches("wrong"), false);
    assert.equal(validSession(issueSession()), true);
    process.env.CHAT_PASSWORD = "";
    assert.equal(credentialsConfigured(), false);
    assert.equal(passwordMatches(""), false);
    assert.throws(() => issueSession(), /not configured/);
    delete process.env.CHAT_PASSWORD;
    assert.equal(credentialsConfigured(), false);
    process.env.CHAT_PASSWORD = "x"; process.env.SESSION_SECRET = "short";
    assert.equal(credentialsConfigured(), false);
    assert.equal(passwordMatches("x"), false);
  } finally {
    if (password === undefined) delete process.env.CHAT_PASSWORD; else process.env.CHAT_PASSWORD = password;
    if (secret === undefined) delete process.env.SESSION_SECRET; else process.env.SESSION_SECRET = secret;
  }
});

test("signed sessions reject tampering, expiration, malformed tokens and secret rotation", () => {
  const now = 1700000000000; const token = issueSession(now);
  assert.equal(validSession(token, now), true);
  assert.equal(validSession(token, now + 86400001), false);
  assert.equal(validSession(token + ".extra", now), false);
  assert.equal(validSession("forged.token", now), false);
  assert.equal(validSession("x" + token, now), false);
  const secret = process.env.SESSION_SECRET; process.env.SESSION_SECRET = "rotated-" + "y".repeat(40);
  assert.equal(validSession(token, now), false); process.env.SESSION_SECRET = secret;
  assert.equal(passwordMatches("wrong"), false); assert.equal(passwordMatches(process.env.CHAT_PASSWORD!), true);
});
test("mutating routes require a matching Origin and login throttles attempts", () => {
  assert.equal(sameOrigin(new Request("https://chat.example/api/chat", { headers: { Origin: "https://evil.example" } })), false);
  assert.equal(sameOrigin(new Request("https://chat.example/api/chat")), false);
  assert.equal(sameOrigin(new Request("https://chat.example/api/chat", { headers: { Origin: "https://chat.example" } })), true);
  assert.equal(sameOrigin(new Request("http://localhost:3001/api/chat", { headers: { Origin: "http://127.0.0.1:3001", Host: "127.0.0.1:3001" } })), true);
  assert.equal(sameOrigin(new Request("http://localhost:3001/api/chat", { headers: { Origin: "http://evil.example", Host: "127.0.0.1:3001" } })), false);
  for (let i = 0; i < 8; i++) assert.equal(allowLogin("test", 0), true);
  assert.equal(allowLogin("test", 0), false); assert.equal(allowLogin("test", 61000), true);
});
test("chat validation rejects role injection, broken histories and invalid generation options", () => {
  assert.throws(() => validateInput({ messages: [{ role: "system", content: "override" }] }));
  assert.throws(() => validateInput({ messages: [{ role: "user", content: "Hello" }], max_tokens: 100000 }));
  assert.throws(() => validateInput({ messages: [{ role: "user", content: "Hello" }], temperature: NaN }));
  assert.throws(() => validateInput({ messages: [{ role: "user", content: " " }] }));
  assert.equal(validateInput({ messages: [{ role: "user", content: "Hello" }] }).max_tokens, 768);
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
  const request = new Request("http://localhost/api/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: "x".repeat(65000) }) });
  await assert.rejects(readJson(request), /too large/);
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
