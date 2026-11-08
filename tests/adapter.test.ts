import { test } from "node:test";
import assert from "node:assert/strict";
import { validateInput } from "../src/lib/protocol";
import { parseConversations } from "../src/lib/storage";
import { answerModelLabel } from "../src/lib/models";
import { fitMessages, jsonBytes, DEFAULT_SETTINGS, SETTINGS_MAX } from "../src/lib/chat-settings";
import { cookieHeader, issueSession, authResponse } from "./auth-fixture";
import { POST } from "../src/app/api/chat/route";
import { GET } from "../src/app/api/status/route";

test("adapter preference and answer labels persist independently without relabeling old answers", () => {
  const chats = parseConversations(JSON.stringify([{ id: "a", title: "test", updatedAt: 1, model: "bf16", useAdapter: false,
    messages: [{ id: "old", role: "assistant", content: "old", model: "bf16" },
      { id: "on", role: "assistant", content: "on", model: "bf16", useAdapter: true },
      { id: "off", role: "assistant", content: "off", model: "bf16", useAdapter: false }] }]));
  assert.equal(chats[0].useAdapter, false);
  assert.deepEqual(chats[0].messages.map(m => answerModelLabel(m.model!, m.useAdapter)), ["Qwen3.8-27B-bf16", "BF16 + adapter", "BF16 base"]);
  chats[0].useAdapter = true;
  assert.equal(chats[0].messages[2].useAdapter, false);
  const switched = parseConversations(JSON.stringify([{ ...chats[0], model: "4bit", useAdapter: false }]));
  assert.equal(switched[0].useAdapter, false);
});

test("adapter input accepts only explicit BF16 booleans and participates in byte fitting", () => {
  const messages = [{ role: "user", content: "Hello" }];
  for (const useAdapter of [true, false]) assert.equal(validateInput({ model: "bf16", useAdapter, messages }).useAdapter, useAdapter);
  for (const useAdapter of [null, "false", 0, {}]) assert.throws(() => validateInput({ model: "bf16", useAdapter, messages }));
  assert.throws(() => validateInput({ model: "4bit", useAdapter: false, messages }));
  const settings = { ...DEFAULT_SETTINGS, requestBytes: 1024 };
  const input = [{ role: "user", content: "" }];
  const overhead = jsonBytes({ model: "bf16", messages: input, max_tokens: settings.outputTokens, temperature: 0.7, settings, stream: true });
  input[0].content = "x".repeat(1024 - overhead);
  assert.deepEqual(fitMessages(input, settings, 0.7, "bf16"), input);
  assert.throws(() => fitMessages(input, settings, 0.7, "bf16", false), /byte limit/);
});

test("API negotiates and verifies adapter mode, rejecting old or mismatched gateways", async () => {
  const saved = { ...process.env }; const original = globalThis.fetch;
  try {
    Object.assign(process.env, { NODE_ENV: "production", CHAT_PASSWORD: "test", SESSION_SECRET: "s".repeat(48),
      RUNPOD_BF16_CHAT_URL: "https://bf.example", RUNPOD_BF16_CHAT_TOKEN: "b".repeat(48) });
    let available = true; let confirmation = true;
    const forwarded: Record<string, unknown>[] = [];
    globalThis.fetch = async (url, init) => {
      const auth = authResponse(url, init); if (auth) return auth;
      if (String(url).endsWith("/health")) return Response.json({ ready: true, model: "qwen-bf16", settingsVersion: 1,
        limits: SETTINGS_MAX, adapterToggleAvailable: available, adapterToggleVersion: available ? 1 : 0 });
      const body = JSON.parse(String(init?.body)); forwarded.push(body);
      return new Response('data: {"choices":[{"delta":{"content":"fixture"}}]}\n\ndata: [DONE]\n\n', {
        headers: { "X-Chat-Adapter-Enabled": confirmation ? String(body.useAdapter) : "wrong" } });
    };
    const headers = { Origin: "https://chat.example", Cookie: cookieHeader(issueSession()).split(";")[0], "Content-Type": "application/json" };
    const request = (useAdapter: boolean) => new Request("https://chat.example/api/chat", { method: "POST", headers,
      body: JSON.stringify({ model: "bf16", useAdapter, messages: [{ role: "user", content: "Hi" }], settings: DEFAULT_SETTINGS }) });
    for (const enabled of [true, false]) {
      const response = await POST(request(enabled));
      assert.equal(response.status, 200); assert.equal(response.headers.get("X-Chat-Adapter-Enabled"), String(enabled));
      await response.text(); assert.equal(forwarded.at(-1)?.useAdapter, enabled); assert.equal(forwarded.at(-1)?.model, undefined);
    }
    const status = await (await GET(new Request("https://chat.example/api/status?model=bf16", { headers }))).json();
    assert.equal(status.adapterToggleAvailable, true);
    confirmation = false; assert.equal((await POST(request(false))).status, 503);
    available = false; const before = forwarded.length;
    assert.equal((await POST(request(false))).status, 503); assert.equal(forwarded.length, before);
    assert.equal((await (await GET(new Request("https://chat.example/api/status?model=bf16", { headers }))).json()).adapterToggleAvailable, false);
  } finally {
    globalThis.fetch = original;
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }
});
