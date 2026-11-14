import { test } from "node:test";
import assert from "node:assert/strict";
import { RequestDeadline, HOSTED_CHAT_TIMEOUT_MS } from "../src/lib/request-deadline";
import { POST } from "../src/app/api/chat/route";
import { GET } from "../src/app/api/status/route";
import { DEFAULT_SETTINGS, SETTINGS_MAX } from "../src/lib/chat-settings";
import { adminIds, authResponse, cookieHeader, issueSession } from "./auth-fixture";

const health = { ready: true, model: "qwen-bf16", settingsVersion: 1, accountQuotaVersion: 1, accountQuotasEnforced: true,
  adapterToggleVersion: 1, adapterToggleAvailable: true, limits: SETTINGS_MAX,
  webSearchVersion: 1, webSearchAvailable: true, webSearch: { models: [{ model: "bf16", useAdapter: false, available: true }] } };
function request(timeoutSeconds = 2400, signal?: AbortSignal, body?: ReadableStream<Uint8Array>, webSearch = false) {
  const headers = { Cookie: cookieHeader(issueSession(adminIds[0])), Origin: "https://chat.example", "Content-Type": "application/json" };
  return new Request("https://chat.example/api/chat", { method: "POST", headers, signal,
    body: body ?? JSON.stringify({ messages: [{ role: "user", content: "hello" }], useAdapter: false,
      settings: { ...DEFAULT_SETTINGS, timeoutSeconds }, ...(webSearch ? { webSearch: { version: 1, mode: "required" } } : {}) }),
    ...(body ? { duplex: "half" } : {}) } as RequestInit);
}
function configure() { Object.assign(process.env, { NODE_ENV: "production", VERCEL: "1", RUNPOD_BF16_CHAT_URL: "https://gateway.example", RUNPOD_BF16_CHAT_TOKEN: "x".repeat(48) }); }
async function observed(predicate: () => boolean) { for (let i = 0; i < 40 && !predicate(); i++) await new Promise<void>(resolve => setImmediate(resolve)); assert.ok(predicate()); }

test("route-entry budget contracts, preserves local custom limits and rejects an expired budget", t => {
  let now = 0; t.mock.method(performance, "now", () => now);
  const incoming = new AbortController(), hosted = new RequestDeadline(incoming.signal, true);
  hosted.limit(900_000); now = 30_000; assert.equal(hosted.remainingSeconds(), 210);
  hosted.limit(60_000); assert.equal(hosted.remainingSeconds(), 30);
  now = 60_001; assert.throws(() => hosted.remainingSeconds()); assert.equal(hosted.timedOut, true); hosted.finish();
  now = 0; const local = new RequestDeadline(incoming.signal, false); local.limit(900_000);
  now = 1_000; assert.equal(local.remainingSeconds(), 899); incoming.abort(); assert.equal(local.signal.aborted, true); local.finish();
});

test("hosted status and forwarding agree on the cap, counting auth and readiness time", async t => {
  const env = { ...process.env }, fetcher = globalThis.fetch; let now = 0;
  try {
    configure(); t.mock.method(performance, "now", () => now);
    let forwarded = 0;
    globalThis.fetch = async (input, init) => {
      const auth = authResponse(input, init, { userId: adminIds[0] });
      if (auth) { now += 1000; return auth; }
      if (String(input).endsWith("/health")) { now += 1000; return Response.json(health); }
      forwarded = JSON.parse(String(init?.body)).settings.timeoutSeconds;
      return new Response("data: [DONE]\n\n", { headers: { "X-Chat-Adapter-Enabled": "false" } });
    };
    const response = await POST(request()); assert.equal(response.status, 200); await response.text();
    assert.equal(forwarded, 237);
    const status = await GET(new Request("https://chat.example/api/status", { headers: request().headers }));
    assert.equal((await status.json()).limits.timeoutSeconds, 240);
    now = 0; const shorter = await POST(request(5)); assert.equal(shorter.status, 200); await shorter.text(); assert.equal(forwarded, 2);
    delete process.env.VERCEL; now = 0; const local = await POST(request(900)); assert.equal(local.status, 200); await local.text(); assert.equal(forwarded, 897);
  } finally { process.env = env; globalThis.fetch = fetcher; }
});

for (const stage of ["auth", "body", "health", "queue"] as const) test(`hosted deadline covers stalled ${stage} and cancels its work`, async t => {
  const env = { ...process.env }, fetcher = globalThis.fetch; let entered = false, aborted = false, bodyCancelled = false;
  try {
    configure(); t.mock.timers.enable({ apis: ["setTimeout"] });
    globalThis.fetch = async (input, init) => {
      const auth = authResponse(input, init, { userId: adminIds[0] });
      const stall = (stage === "auth" && auth) || (stage === "health" && String(input).endsWith("/health"))
        || (stage === "queue" && String(input).endsWith("/v1/chat/completions"));
      if (stall) { entered = true; init?.signal?.addEventListener("abort", () => { aborted = true; }); return new Promise<Response>(() => {}); }
      if (auth) return auth;
      return Response.json(health);
    };
    const body = stage === "body" ? new ReadableStream<Uint8Array>({ start() { entered = true; }, cancel() { bodyCancelled = true; } }) : undefined;
    const req = request(2400, undefined, body);
    const pending = POST(req); await observed(() => stage === "body" ? req.body!.locked : entered);
    t.mock.timers.tick(HOSTED_CHAT_TIMEOUT_MS);
    const response = await pending; assert.equal(response.status, 504);
    if (stage === "body") { await observed(() => bodyCancelled); } else assert.equal(aborted, true);
  } finally { t.mock.timers.reset(); process.env = env; globalThis.fetch = fetcher; }
});

test("client cancellation reaches readiness, and stream deadline cancels the upstream reader", async t => {
  const env = { ...process.env }, fetcher = globalThis.fetch; let healthSignal: AbortSignal | undefined;
  try {
    configure();
    globalThis.fetch = async (input, init) => {
      const auth = authResponse(input, init, { userId: adminIds[0] }); if (auth) return auth;
      healthSignal = init?.signal ?? undefined; return new Promise<Response>(() => {});
    };
    const incoming = new AbortController(); const pending = POST(request(2400, incoming.signal));
    await observed(() => !!healthSignal); incoming.abort(); assert.equal((await pending).status, 499); assert.equal(healthSignal!.aborted, true);
    t.mock.timers.enable({ apis: ["setTimeout"] }); let cancelled = false, upstreamSignal: AbortSignal | undefined;
    globalThis.fetch = async (input, init) => {
      const auth = authResponse(input, init, { userId: adminIds[0] }); if (auth) return auth;
      if (String(input).endsWith("/health")) return Response.json(health);
      upstreamSignal = init?.signal ?? undefined;
      return new Response(new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } }), { headers: { "X-Chat-Adapter-Enabled": "false" } });
    };
    const response = await POST(request()); const reading = response.text();
    t.mock.timers.tick(HOSTED_CHAT_TIMEOUT_MS); await assert.rejects(reading);
    await observed(() => cancelled); assert.equal(upstreamSignal!.aborted, true);
  } finally { t.mock.timers.reset(); process.env = env; globalThis.fetch = fetcher; }
});


test("web search retains its route-entry cap outside hosting and cancels on reader cancellation", async t => {
  const env = { ...process.env }, fetcher = globalThis.fetch; let now = 0;
  try {
    configure(); delete process.env.VERCEL; t.mock.method(performance, "now", () => now);
    let forwarded = 0, cancelled = false;
    globalThis.fetch = async (input, init) => {
      const auth = authResponse(input, init, { userId: adminIds[0] }); if (auth) { now += 1000; return auth; }
      if (String(input).endsWith("/health")) { now += 1000; return Response.json(health); }
      forwarded = JSON.parse(String(init?.body)).settings.timeoutSeconds;
      init?.signal?.addEventListener("abort", () => { cancelled = true; });
      return new Response(new ReadableStream<Uint8Array>(), { headers: { "X-Chat-Adapter-Enabled": "false", "X-Chat-Web-Search": "1" } });
    };
    const response = await POST(request(900, undefined, undefined, true)); assert.equal(response.status, 200); assert.equal(forwarded, 237);
    await response.body!.cancel(); assert.equal(cancelled, true);
  } finally { process.env = env; globalThis.fetch = fetcher; }
});


test("one-second requests reach upstream but a fractional remainder never resets the outer deadline", async t => {
  const env = { ...process.env }, fetcher = globalThis.fetch; let now = 0;
  try {
    configure(); t.mock.method(performance, "now", () => now); t.mock.timers.enable({ apis: ["setTimeout"] });
    let forwarded = 0, upstreamSignal: AbortSignal | undefined, cancelled = false;
    globalThis.fetch = async (input, init) => {
      const auth = authResponse(input, init, { userId: adminIds[0] }); if (auth) { now += 100; return auth; }
      if (String(input).endsWith("/health")) { now += 100; return Response.json(health); }
      forwarded = JSON.parse(String(init?.body)).settings.timeoutSeconds; upstreamSignal = init?.signal ?? undefined;
      return new Response(new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } }), { headers: { "X-Chat-Adapter-Enabled": "false" } });
    };
    const response = await POST(request(1)); assert.equal(response.status, 200); assert.equal(forwarded, 1); assert.equal(now, 300);
    const reading = response.text(); t.mock.timers.tick(699); assert.equal(upstreamSignal!.aborted, false);
    t.mock.timers.tick(1); await assert.rejects(reading); await observed(() => cancelled); assert.equal(upstreamSignal!.aborted, true);
  } finally { t.mock.timers.reset(); process.env = env; globalThis.fetch = fetcher; }
});
