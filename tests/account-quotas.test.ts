import { test } from "node:test";
import assert from "node:assert/strict";
import { POST } from "../src/app/api/chat/route";
import { GET } from "../src/app/api/status/route";
import { requestPrincipal } from "../src/lib/auth";
import { SETTINGS_MAX } from "../src/lib/chat-settings";
import { modelStatusRequests, type Connection } from "../src/lib/model-status";
import { authResponse, cookieHeader, issueSession, user } from "./auth-fixture";

const health = { ready: true, model: "qwen", settingsVersion: 1, accountQuotaVersion: 1, accountQuotasEnforced: true, limits: SETTINGS_MAX };
function headers() { return { Cookie: cookieHeader(issueSession()), Origin: "https://chat.example", "Content-Type": "application/json" }; }
function request(extraHeaders = {}, extraBody = {}) {
  return new Request("https://chat.example/api/chat", { method: "POST", headers: { ...headers(), ...extraHeaders },
    body: JSON.stringify({ messages: [{ role: "user", content: "hello" }], ...extraBody }) });
}
function configure() {
  Object.assign(process.env, { NODE_ENV: "production", RUNPOD_CHAT_URL: "https://gateway.example", RUNPOD_CHAT_TOKEN: "x".repeat(48) });
}

test("chat resolves one verified principal and overwrites inbound and body identity", async () => {
  const env = { ...process.env }, original = globalThis.fetch;
  try {
    configure(); let users = 0, sessions = 0, sent = 0;
    globalThis.fetch = async (input, init) => {
      const auth = authResponse(input, init);
      if (auth) { if (String(input).endsWith("/user")) users++; else sessions++; return auth; }
      if (String(input).endsWith("/health")) {
        assert.equal(new Headers(init?.headers).get("X-Chat-User-Id"), null);
        return Response.json(health);
      }
      sent++;
      assert.equal(new Headers(init?.headers).get("X-Chat-User-Id"), user.id);
      const body = JSON.parse(String(init?.body));
      for (const key of ["userId", "user_id", "accountId", "principal", "X-Chat-User-Id"]) assert.equal(body[key], undefined);
      return new Response("data: [DONE]\n\n");
    };
    const response = await POST(request({ "X-Chat-User-Id": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
      { userId: "spoofed", user_id: "spoofed", accountId: "spoofed", principal: "spoofed", "X-Chat-User-Id": "spoofed" }));
    assert.equal(response.status, 200); await response.text();
    assert.deepEqual([users, sessions, sent], [1, 1, 1]);
    globalThis.fetch = async (input, init) => {
      const auth = authResponse(input, init);
      if (String(input).endsWith("/user")) return Response.json({ ...user, id: "malformed" });
      assert.ok(auth); return auth!;
    };
    assert.equal(await requestPrincipal(request()), null);
  } finally { process.env = env; globalThis.fetch = original; }
});

test("chat and status fail503 when quota version or enforcement cannot be verified", async () => {
  const env = { ...process.env }, original = globalThis.fetch;
  try {
    configure(); let calls = 0, capability: Record<string, unknown>;
    globalThis.fetch = async (input, init) => {
      const auth = authResponse(input, init); if (auth) return auth;
      if (String(input).endsWith("/health")) return Response.json(capability);
      calls++; return new Response("must not stream");
    };
    for (const fields of [{ accountQuotaVersion: undefined }, { accountQuotaVersion: 0 }, { accountQuotaVersion: "1" },
      { accountQuotasEnforced: false }, { accountQuotasEnforced: undefined }, { accountQuotasEnforced: "true" }]) {
      capability = { ...health, ...fields };
      const chat = await POST(request()); assert.equal(chat.status, 503);
      const status = await GET(new Request("https://chat.example/api/status", { headers: headers() }));
      assert.equal(status.status, 503); assert.equal((await status.json()).ready, false);
    }
    assert.equal(calls, 0);
  } finally { process.env = env; globalThis.fetch = original; }
});

test("quota errors use safe allowlisted codes and bounded integer Retry-After", async () => {
  const env = { ...process.env }, original = globalThis.fetch;
  try {
    configure(); let code = "user_rate_limit", retry = "1", status = 429;
    globalThis.fetch = async (input, init) => {
      const auth = authResponse(input, init); if (auth) return auth;
      if (String(input).endsWith("/health")) return Response.json(health);
      return Response.json({ error: "secret upstream detail" }, { status, headers: { "X-Chat-Rejection": code, "Retry-After": retry } });
    };
    for (const value of ["1", "60", "0", "61", "01", "1.5", "Wed, 21 Oct 2015 07:28:00 GMT", "garbage"]) {
      retry = value; const response = await POST(request()); assert.equal(response.status, 429);
      assert.equal(response.headers.get("X-Chat-Rejection"), "user_rate_limit");
      assert.equal(response.headers.get("Retry-After"), ["1", "60"].includes(value) ? value : null);
      const { error } = await response.json(); assert.doesNotMatch(error, /secret upstream/);
      assert.match(error, ["1", "60"].includes(value) ? new RegExp("Try again in " + value + (value === "1" ? " second\\." : " seconds\\.")) : /Wait a minute/);
    }
    code = "user_capacity"; retry = "5";
    let response = await POST(request()); assert.equal(response.status, 429); assert.equal(response.headers.get("Retry-After"), null);
    assert.match((await response.json()).error, /Your account already has requests in progress/);
    code = "unknown";
    response = await POST(request()); assert.equal(response.headers.get("X-Chat-Rejection"), null); assert.equal(response.headers.get("Retry-After"), null);
    code = "user_identity"; status = 400;
    response = await POST(request()); assert.equal(response.status, 503); assert.equal(response.headers.get("X-Chat-Rejection"), null);
    assert.match((await response.json()).error, /account limits could not be verified/);
    code = "rate_limit"; retry = "60"; status = 429;
    response = await POST(request()); assert.equal(response.headers.get("Retry-After"), "60"); assert.equal(response.headers.get("X-Chat-Rejection"), "rate_limit");
    code = "user_rate_limit"; status = 503;
    response = await POST(request()); assert.equal(response.headers.get("X-Chat-Rejection"), null); assert.equal(response.headers.get("Retry-After"), null);
  } finally { process.env = env; globalThis.fetch = original; }
});

test("status503 replaces an earlier ready model with a nonready state", async () => {
  const states: Connection[] = []; let healthy = true;
  const loader = modelStatusRequests("4bit", state => states.push(state), () => assert.fail("unexpected signout"),
    (async () => Response.json({ model: "4bit", mode: "live", ready: healthy }, { status: healthy ? 200 : 503 })) as typeof fetch);
  await loader.refresh(); healthy = false; await loader.refresh(); loader.dispose();
  assert.deepEqual(states.map(state => state.ready), [true, false]);
});
