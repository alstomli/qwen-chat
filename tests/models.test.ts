import { test } from "node:test";
import assert from "node:assert/strict";
import { cookieHeader, issueSession, authResponse } from "./auth-fixture";
import { POST } from "../src/app/api/chat/route";
import { GET } from "../src/app/api/status/route";
import { MODELS } from "../src/lib/models";
import { modelStatusRequests, type Connection } from "../src/lib/model-status";
import { DEFAULT_SETTINGS, SETTINGS_MAX, fitSettings, fitMessages, jsonBytes, parseModelSettings } from "../src/lib/chat-settings";
import { parseConversations } from "../src/lib/storage";
import { diagnosticValues, type DiagnosticRecord } from "../src/lib/diagnostics";

test("BF16 is the only default route with verified alias and credentials, never client destinations or fallback", async () => {
  const saved = { ...process.env }; const fetcher = globalThis.fetch;
  try {
    Object.assign(process.env, { NODE_ENV: "production", CHAT_PASSWORD: "test", SESSION_SECRET: "s".repeat(48),
      RUNPOD_BF16_CHAT_URL: "https://bf.example", RUNPOD_BF16_CHAT_TOKEN: "b".repeat(48), CHAT_PREVIEW_MODE: "false" });
    const calls: { url: string; token: string | null; body: Record<string, unknown> | null }[] = [];
    let wrongAlias = false;
    globalThis.fetch = async (input, init) => {
      const auth = authResponse(input, init); if (auth) return auth;
      const url = String(input); assert.ok(url.startsWith("https://bf.example/"));
      calls.push({ url, token: new Headers(init?.headers).get("Authorization"), body: init?.body ? JSON.parse(String(init.body)) : null });
      if (url.endsWith("/health")) return Response.json({ ready: true, model: !wrongAlias ? "qwen-bf16" : "qwen", settingsVersion: 1, accountQuotaVersion: 1, accountQuotasEnforced: true,
        limits: { ...SETTINGS_MAX, contextTokens: 40960 }, diagnosticsVersion: 0,
        adapterToggleVersion: 1, adapterToggleAvailable: true });
      return new Response(`data: {"choices":[{"delta":{"content":"BF16 fixture"}}]}\n\ndata: [DONE]\n\n`, { headers: { "Content-Type": "text/event-stream", "X-Chat-Adapter-Enabled": "false" } });
    };
    const headers = { Origin: "https://chat.example", Cookie: cookieHeader(issueSession()).split(";")[0], "Content-Type": "application/json" };
    const request = (model?: unknown, extra = {}) => new Request("https://chat.example/api/chat", { method: "POST", headers,
      body: JSON.stringify({ ...(model === undefined ? {} : { model }), messages: [{ role: "user", content: "hello" }], settings: DEFAULT_SETTINGS, ...extra }) });
    for (const [model, label, origin, token] of [[undefined, "BF16 fixture", "https://bf.example", "b"], ["bf16", "BF16 fixture", "https://bf.example", "b"]] as const) {
      const response = await POST(request(model, { base: "https://attacker.example", token: "never use" }));
      assert.equal(response.status, 200); assert.match(await response.text(), new RegExp(label));
      const sent = calls.at(-1)!;
      assert.equal(sent.url, origin + "/v1/chat/completions"); assert.equal(sent.token, "Bearer " + token.repeat(48));
      assert.equal(sent.body?.model, undefined); assert.equal(sent.body?.base, undefined); assert.equal(sent.body?.token, undefined);
    }
    assert.deepEqual(MODELS.map(m => m.label), ["Qwen3.8-27B-bf16"]);
    const status = await (await GET(new Request("https://chat.example/api/status?model=bf16", { headers }))).json();
    assert.equal(status.model, "bf16"); assert.equal(status.ready, true); assert.equal(status.limits.contextTokens, 40960);
    assert.equal(status.diagnosticsAvailable, false); assert.equal(status.token, undefined); assert.equal(status.base, undefined);
    let before = calls.length;
    for (const invalid of ["4bit", "other", "https://bf.example", null, 4, {}]) assert.equal((await POST(request(invalid))).status, 400);
    for (const invalid of ["4bit", "other"]) assert.equal((await GET(new Request(`https://chat.example/api/status?model=${invalid}`, { headers }))).status, 400);
    assert.equal(calls.length, before);
    assert.equal((await (await GET(new Request("https://chat.example/api/status", { headers }))).json()).model, "bf16");
    wrongAlias = true;
    const mismatch = await (await GET(new Request("https://chat.example/api/status?model=bf16", { headers }))).json();
    assert.equal(mismatch.ready, false);
    before = calls.filter(c => c.body).length;
    assert.notEqual((await POST(request("bf16"))).status, 200);
    assert.equal(calls.filter(c => c.body).length, before);
    delete process.env.RUNPOD_BF16_CHAT_TOKEN;
    before = calls.length;
    assert.equal((await POST(request("bf16"))).status, 503);
    assert.equal(calls.length, before);
  } finally {
    globalThis.fetch = fetcher;
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }
});

test("cancelling a selected model stream aborts only its chosen upstream", async () => {
  const saved = { ...process.env }; const fetcher = globalThis.fetch;
  try {
    Object.assign(process.env, { NODE_ENV: "production", CHAT_PASSWORD: "test", SESSION_SECRET: "s".repeat(48),
      RUNPOD_BF16_CHAT_URL: "https://bf.example", RUNPOD_BF16_CHAT_TOKEN: "b".repeat(48) });
    let upstreamSignal: AbortSignal | null | undefined; let cancelled = false;
    globalThis.fetch = async (input, init) => {
      const auth = authResponse(input, init); if (auth) return auth;
      assert.ok(String(input).startsWith("https://bf.example/"));
      if (String(input).endsWith("/health")) return Response.json({ ready: true, model: "qwen-bf16", settingsVersion: 1, accountQuotaVersion: 1, accountQuotasEnforced: true, limits: SETTINGS_MAX, adapterToggleVersion: 1, adapterToggleAvailable: true });
      upstreamSignal = init?.signal;
      return new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n')); }, cancel() { cancelled = true; } }), { headers: { "X-Chat-Adapter-Enabled": "false" } });
    };
    const headers = { Origin: "https://chat.example", Cookie: cookieHeader(issueSession()).split(";")[0], "Content-Type": "application/json" };
    const response = await POST(new Request("https://chat.example/api/chat", { method: "POST", headers,
      body: JSON.stringify({ model: "bf16", messages: [{ role: "user", content: "hello" }], settings: DEFAULT_SETTINGS }) }));
    assert.equal(response.status, 200);
    const reader = response.body!.getReader(); await reader.read(); await reader.cancel();
    assert.equal(upstreamSignal?.aborted, true); assert.equal(cancelled, true);
  } finally {
    globalThis.fetch = fetcher;
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }
});

test("BF16 preferences and legacy missing metadata use BF16; retired model data is discarded", () => {
  const preferences = parseModelSettings(null);
  assert.deepEqual(preferences, { bf16: DEFAULT_SETTINGS });
  assert.equal(preferences.bf16.outputTokens, 7680); assert.equal(preferences.bf16.safetyTokens, 32);
  const saved = parseModelSettings(JSON.stringify({ bf16: { ...DEFAULT_SETTINGS, outputTokens: 256 }, "4bit": { outputTokens: 128 } }));
  assert.deepEqual(Object.keys(saved), ["bf16"]); assert.equal(saved.bf16.outputTokens, 256);
  assert.deepEqual(parseModelSettings(JSON.stringify({ "4bit": { outputTokens: 128 } })), { bf16: DEFAULT_SETTINGS });
  const smaller = fitSettings(DEFAULT_SETTINGS, { ...SETTINGS_MAX, contextTokens: 4096 });
  assert.ok(smaller.contextTokens - smaller.outputTokens - smaller.safetyTokens >= 1000);
  const largeReserve = fitSettings({ ...DEFAULT_SETTINGS, safetyTokens: 4096 }, { ...SETTINGS_MAX, contextTokens: 4096 });
  assert.ok(largeReserve.contextTokens - largeReserve.outputTokens - largeReserve.safetyTokens >= 1000);
  const legacy = { id: "1", title: "legacy", updatedAt: 1, messages: [{ id: "a", role: "assistant", content: "old answer" }] };
  const chats = parseConversations(JSON.stringify([legacy]));
  assert.equal(chats[0].model, "bf16"); assert.equal(chats[0].messages[0].model, "bf16");
  for (const model of ["4bit", "unknown", null]) {
    assert.deepEqual(parseConversations(JSON.stringify([{ ...legacy, model }])), []);
    assert.deepEqual(parseConversations(JSON.stringify([{ ...legacy, model: "bf16", messages: [{ ...legacy.messages[0], model }] }])), []);
  }
  const record = { selectedModel: "bf16", settings: DEFAULT_SETTINGS, gateway: null, usage: null } as unknown as DiagnosticRecord;
  assert.equal(diagnosticValues(record).selected_model, "Qwen3.8-27B-bf16");
});

test("request fitting includes the BF16 model ID in its byte budget", () => {
  const settings = { ...DEFAULT_SETTINGS, requestBytes: 1024 };
  const messages = [{ role: "user", content: "" }];
  const overhead = jsonBytes({ messages, max_tokens: settings.outputTokens, temperature: 0.7, settings, stream: true });
  messages[0].content = "x".repeat(1024 - overhead);
  assert.throws(() => fitMessages(messages, settings, 0.7, "bf16"), /byte limit/);
  messages[0].content = messages[0].content.slice(0, -30);
  assert.deepEqual(fitMessages(messages, settings, 0.7, "bf16"), messages);
});

test("disposed or superseded status requests cannot overwrite selection, limits or readiness", async () => {
  const replies: ((response: Response) => void)[] = []; const received: Connection[] = [];
  const fetcher = (() => new Promise<Response>(resolve => replies.push(resolve))) as typeof fetch;
  const old = modelStatusRequests("bf16", status => received.push(status), () => {}, fetcher);
  const first = old.refresh(); old.dispose();
  const current = modelStatusRequests("bf16", status => received.push(status), () => {}, fetcher);
  const second = current.refresh(); const third = current.refresh();
  replies[2](Response.json({ model: "bf16", mode: "live", ready: true, limits: SETTINGS_MAX, diagnosticsAvailable: true })); await third;
  replies[1](Response.json({ model: "bf16", mode: "live", ready: false })); await second;
  replies[0](Response.json({ model: "bf16", mode: "live", ready: false, limits: { ...SETTINGS_MAX, contextTokens: 4096 }, diagnosticsAvailable: false })); await first;
  assert.equal(received.length, 1); assert.equal(received[0].model, "bf16"); assert.equal(received[0].ready, true);
  assert.equal(received[0].limits?.contextTokens, 40960); assert.equal(received[0].diagnosticsAvailable, true);
  current.dispose();
});
