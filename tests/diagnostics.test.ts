import { test } from "node:test";
import assert from "node:assert/strict";
import { diagnosticsAllowed } from "../src/lib/server";
import { DIAGNOSTICS_HEADER, parseDiagnosticHeader, parseTimingEvent, diagnosticValues, diagnosticsCsv, type DiagnosticRecord } from "../src/lib/diagnostics";
import { consumeCompletion } from "../src/lib/protocol";
import { DEFAULT_SETTINGS, SETTINGS_MAX } from "../src/lib/chat-settings";
import { adminIds, cookieHeader, issueSession, authResponse } from "./auth-fixture";
import { POST } from "../src/app/api/chat/route";
import { GET } from "../src/app/api/status/route";

const summary = { version: 1, requestId: "a".repeat(32), model: "qwen", inputTokensBefore: 5000, inputTokensAfter: 150, lastCountedInputTokens: 150, outputBudget: 7680, safetyReserve: 32, contextBudget: 40960, gatewayTrimmedMessages: 2, reuseCachedPrefixes: true };
const record: DiagnosticRecord = { id: "local-id", createdAt: "2026-11-01T12:00:00Z", status: "completed", browserOriginalMessages: 7, browserSentMessages: 5, browserOriginalBytes: 2000, browserSentBytes: 1000, outputBudget: 7680, safetyReserve: 32, contextBudget: 40960, reuseCachedPrefixes: true, settings: { ...DEFAULT_SETTINGS }, temperature: 0.7, gateway: parseDiagnosticHeader(JSON.stringify(summary)), usage: { promptTokens: 150, outputTokens: 23 }, finishReason: "stop" };
const sse = 'data: {"choices":[{"delta":{"content":"你好"},"finish_reason":null}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"length"}]}\n\ndata: {"choices":[],"usage":{"prompt_tokens":150,"completion_tokens":128,"secret":"not exported"}}\n\ndata: [DONE]\n\n';

test("diagnostics require explicit server opt-in in every environment", () => {
  assert.equal(diagnosticsAllowed({ NODE_ENV: "development" }), false);
  assert.equal(diagnosticsAllowed({ NODE_ENV: "production", VERCEL_ENV: "production" }), false);
  assert.equal(diagnosticsAllowed({ CHAT_DIAGNOSTICS_ENABLED: "false" }), false);
  assert.equal(diagnosticsAllowed({ CHAT_DIAGNOSTICS_ENABLED: "TRUE" }), false);
  assert.equal(diagnosticsAllowed({ NODE_ENV: "development", CHAT_DIAGNOSTICS_ENABLED: "true" }), true);
  assert.equal(diagnosticsAllowed({ NODE_ENV: "production", CHAT_DIAGNOSTICS_ENABLED: "true" }), true);
  assert.equal(diagnosticsAllowed({ NODE_ENV: "production", VERCEL_ENV: "preview", CHAT_DIAGNOSTICS_ENABLED: "true" }), true);
  assert.equal(diagnosticsAllowed({ NODE_ENV: "production", VERCEL_ENV: "production", CHAT_DIAGNOSTICS_ENABLED: "true" }), true);
});

test("summary parsing and exports allowlist metadata and preserve unavailable values", () => {
  const parsed = parseDiagnosticHeader(JSON.stringify({ ...summary, messages: ["private prompt"], token: "credential" }));
  assert.deepEqual(parsed, summary);
  assert.equal(parseDiagnosticHeader(JSON.stringify({ ...summary, inputTokensBefore: -1 })), null);
  assert.equal(parseDiagnosticHeader(JSON.stringify({ ...summary, gatewayTrimmedMessages: 3 })), null);
  assert.equal(parseDiagnosticHeader("x".repeat(5000)), null);
  const values = diagnosticValues(record);
  assert.equal(values.removed_tokens, 4850);
  assert.equal(values.browser_trimmed_messages, 2);
  assert.equal(values.gateway_trimmed_messages, 2);
  assert.equal(values.unreserved_tokens, 33098);
  const missing = { ...record, status: "stopped" as const, usage: null, finishReason: null };
  assert.equal(diagnosticValues(missing).actual_output_tokens, null);
  const csv = diagnosticsCsv([record, missing]);
  assert.match(csv, /actual_output_tokens/); assert.match(csv, /"23","stop"/);
  assert.doesNotMatch(csv, /credential|private prompt|secret/);
  assert.match(diagnosticsCsv([{ ...record, finishReason: '=HYPERLINK("bad")' }]), /'=HYPERLINK/);
  assert.equal(diagnosticsCsv([]), "");
});

test("stream parser captures final usage independently of text, chunk boundaries and finish reason", async () => {
  const bytes = new TextEncoder().encode(sse); let text = ""; let reason = ""; let usage;
  const stream = new ReadableStream<Uint8Array>({ start(c) { for (const byte of bytes) c.enqueue(Uint8Array.of(byte)); c.close(); } });
  await consumeCompletion(stream, delta => text += delta, value => reason = value, value => usage = value);
  assert.equal(text, "你好"); assert.equal(reason, "length");
  assert.deepEqual(usage, { promptTokens: 150, outputTokens: 128 });
  const interrupted = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n')); c.close(); } });
  let unavailable = null;
  await assert.rejects(consumeCompletion(interrupted, () => {}, undefined, value => { unavailable = value; }));
  assert.equal(unavailable, null);
});

test("timing events survive fragmented UTF-8, are allowlisted, and never become answer content", async () => {
  const event = { version: 1, requestId: summary.requestId, timings: { contextFitMs: 12.5, upstreamFirstContentMs: 200, gatewayFirstContentMs: 220, gatewayTotalMs: 400 } };
  assert.deepEqual(parseTimingEvent({ ...event, secret: "not exported", timings: { ...event.timings, prompt: "private" } }), event);
  for (const invalid of [-1, Infinity, "20", undefined]) assert.equal(parseTimingEvent({ ...event, timings: { ...event.timings, contextFitMs: invalid } }), null);
  const streamText = sse.replace('data: [DONE]', `event: chat-timing\r\ndata: ${JSON.stringify(event)}\r\n\r\nevent: chat-timing\ndata: {broken}\n\nevent: chat-timing\ndata: ${JSON.stringify({ ...event, version: 2 })}\n\ndata: [DONE]`);
  const bytes = new TextEncoder().encode(streamText);
  let text = ""; const timings: unknown[] = [];
  await consumeCompletion(new ReadableStream({ start(c) { for (const byte of bytes) c.enqueue(Uint8Array.of(byte)); c.close(); } }), delta => text += delta, undefined, undefined, value => timings.push(value));
  assert.equal(text, "你好"); assert.deepEqual(timings, [event]);
  const values = diagnosticValues({ ...record, gatewayTimings: event.timings, browserTimings: { firstContentMs: 250, firstRenderMs: 280, completionMs: null, elapsedMs: 300 }, status: "stopped" });
  assert.equal(values.browser_completion_ms, null); assert.equal(values.browser_elapsed_ms, 300);
  assert.equal(values.gateway_context_fit_ms, 12.5);
  assert.equal(diagnosticValues(record).browser_first_content_ms, null);
  assert.match(diagnosticsCsv([{ ...record, gatewayTimings: event.timings }]), /gateway_context_fit_ms/);
});

test("API forwards diagnostics only with both opt-ins, including errors, and reports capability", async () => {
  const savedEnv = { ...process.env }; const savedFetch = globalThis.fetch;
  try {
    Object.assign(process.env, { CHAT_PASSWORD: "test-only", SESSION_SECRET: "x".repeat(48), RUNPOD_CHAT_URL: "https://gateway.example", RUNPOD_CHAT_TOKEN: "x".repeat(48), CHAT_DIAGNOSTICS_ENABLED: "true", NODE_ENV: "production", VERCEL_ENV: "production" });
    const calls: { url: string; init?: RequestInit }[] = [];
    let supported = true; let failure = false; let rejection = ""; let failureStatus = 400;
    globalThis.fetch = async (input, init) => {
      const auth = authResponse(input, init, { userId: adminIds[0] }); if (auth) return auth;
      const url = String(input); calls.push({ url, init });
      if (url.endsWith("/health")) return Response.json({ ready: true, model: "qwen", settingsVersion: 1, limits: SETTINGS_MAX, diagnosticsVersion: supported ? 1 : 0 });
      return new Response(failure ? '{"error":"private upstream detail"}' : sse, { status: failure ? failureStatus : 200, headers: { [DIAGNOSTICS_HEADER]: JSON.stringify({ ...summary, credentials: "never forward" }), "Content-Type": "text/event-stream", "X-Chat-Rejection": rejection } });
    };
    const headers = { Origin: "https://chat.example", Cookie: cookieHeader(issueSession(adminIds[0])).split(";")[0], "Content-Type": "application/json" };
    const request = (diagnostic: boolean) => new Request("https://chat.example/api/chat", { method: "POST", headers: { ...headers, ...(diagnostic ? { [DIAGNOSTICS_HEADER]: "1" } : {}) }, body: JSON.stringify({ messages: [{ role: "user", content: "Hi" }], settings: DEFAULT_SETTINGS }) });
    const status = await GET(new Request("https://chat.example/api/status", { headers }));
    const statusBody = await status.json();
    assert.equal(statusBody.diagnosticsAvailable, true);
    assert.equal(statusBody.diagnosticsVersion, 1);
    let response = await POST(request(true));
    assert.equal(response.status, 200);
    assert.deepEqual(JSON.parse(response.headers.get(DIAGNOSTICS_HEADER)!), summary);
    assert.equal(new Headers(calls.at(-1)!.init!.headers).get(DIAGNOSTICS_HEADER), "1");
    await response.text();
    response = await POST(request(false));
    assert.equal(response.headers.get(DIAGNOSTICS_HEADER), null);
    assert.equal(new Headers(calls.at(-1)!.init!.headers).get(DIAGNOSTICS_HEADER), null);
    await response.text();
    failure = true;
    response = await POST(request(true));
    assert.equal(response.status, 400); assert.ok(response.headers.get(DIAGNOSTICS_HEADER));
    for (const [status, reason, expected] of [
      [429, "queue_full", "waiting queue is full"],
      [429, "rate_limit", "rate limit has been reached"],
      [504, "queue_timeout", "timed out while waiting"],
      [429, "unrecognized", "answering another request"],
    ] as const) {
      failureStatus = status; rejection = reason;
      response = await POST(request(true));
      assert.equal(response.status, status);
      const body = await response.json();
      assert.match(body.error, new RegExp(expected));
      assert.doesNotMatch(body.error, /private upstream/);
      assert.ok(response.headers.get(DIAGNOSTICS_HEADER));
    }
    supported = false;
    assert.equal((await POST(request(true))).status, 503);
    assert.equal((await (await GET(new Request("https://chat.example/api/status", { headers }))).json()).diagnosticsVersion, 0);
    supported = true;
    process.env.CHAT_DIAGNOSTICS_ENABLED = "false";
    const before = calls.length;
    assert.equal((await POST(request(true))).status, 403);
    assert.equal(calls.length, before);
    const disabled = await (await GET(new Request("https://chat.example/api/status", { headers }))).json();
    assert.equal(disabled.diagnosticsAvailable, false);
    assert.equal(disabled.diagnosticsVersion, 0);
  } finally {
    globalThis.fetch = savedFetch;
    for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
    Object.assign(process.env, savedEnv);
  }
});
