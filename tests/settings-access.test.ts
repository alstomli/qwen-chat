import assert from "node:assert/strict";
import { test } from "node:test";
import { requestAuthenticated, requestPrincipal } from "../src/lib/auth";
import { adapterForAccess, canUseAdvancedSettings, inputForAccess, settingsForAccess } from "../src/lib/settings-access";
import { DEFAULT_SETTINGS, SETTINGS_MAX, fitSettings, type ChatSettings } from "../src/lib/chat-settings";
import { parseConversations } from "../src/lib/storage";
import { parseModelSettings } from "../src/lib/chat-settings";
import { validateInput } from "../src/lib/protocol";
import { DIAGNOSTICS_HEADER } from "../src/lib/diagnostics";
import { POST } from "../src/app/api/chat/route";
import { GET } from "../src/app/api/status/route";
import { adminIds, authResponse, cookieHeader, issueSession, user } from "./auth-fixture";

const messages = [{ role: "user", content: "Hello" }];
const sse = 'data: {"choices":[{"delta":{"content":"fixture"}}]}\n\ndata: [DONE]\n\n';
const smallLimits: ChatSettings = { inputCharacters: 50, outputTokens: 512, contextTokens: 2048,
  historyMessages: 3, historyBytes: 1500, requestBytes: 2400, timeoutSeconds: 20, safetyTokens: 16, reuseCachedPrefixes: true };

async function gatewayFixture(run: (fixture: {
  auth: Parameters<typeof authResponse>[2]; limits: ChatSettings; adapterAvailable: boolean; adapterConfirmation: string;
  calls: { url: string; headers: Headers; body?: ReturnType<typeof validateInput> }[];
  request: (body?: object, headers?: Record<string, string>, cookieUserId?: string) => Request;
}) => Promise<void>) {
  const savedEnv = { ...process.env }; const savedFetch = globalThis.fetch;
  Object.assign(process.env, { NODE_ENV: "production",
    RUNPOD_BF16_CHAT_URL: "https://bf.example", RUNPOD_BF16_CHAT_TOKEN: "b".repeat(48), CHAT_DIAGNOSTICS_ENABLED: "true" });
  const fixture = { auth: {} as Parameters<typeof authResponse>[2], limits: { ...SETTINGS_MAX }, adapterAvailable: true,
    adapterConfirmation: "false", calls: [] as { url: string; headers: Headers; body?: ReturnType<typeof validateInput> }[],
    request: (body: object = {}, headers: Record<string, string> = {}, cookieUserId = user.id) => new Request("https://chat.example/api/chat", {
      method: "POST", headers: { Origin: "https://chat.example", Cookie: cookieHeader(issueSession(cookieUserId)), "Content-Type": "application/json", ...headers },
      body: JSON.stringify({ messages, ...body }),
    }),
  };
  globalThis.fetch = async (input, init) => {
    const auth = authResponse(input, init, fixture.auth); if (auth) return auth;
    const url = String(input); const headers = new Headers(init?.headers);
    fixture.calls.push({ url, headers, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (url.endsWith("/health")) return Response.json({ ready: true, model: "qwen-bf16",
      settingsVersion: 1, accountQuotaVersion: 1, accountQuotasEnforced: true, limits: fixture.limits, adapterToggleVersion: 1, adapterToggleAvailable: fixture.adapterAvailable, diagnosticsVersion: 1 });
    return new Response(sse, { headers: { "X-Chat-Adapter-Enabled": fixture.adapterConfirmation } });
  };
  try { await run(fixture); }
  finally {
    globalThis.fetch = savedFetch;
    for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
    Object.assign(process.env, savedEnv);
  }
}

test("only the two verified account IDs grant advanced access; metadata, headers and cached identity cannot", async () => {
  assert.equal(canUseAdvancedSettings(user.id), false);
  for (const id of adminIds) assert.equal(canUseAdvancedSettings(id), true);
  await gatewayFixture(async fixture => {
    const request = fixture.request({}, { "X-User-Id": adminIds[0], "X-Admin": "true" }, adminIds[0]);
    fixture.auth = { userMetadata: { role: "admin", canUseAdvancedSettings: true, id: adminIds[0] } };
    assert.deepEqual(await requestPrincipal(request), { userId: user.id, canUseAdvancedSettings: false });
    assert.equal(await requestAuthenticated(request), true);
    for (const id of adminIds) {
      fixture.auth = { userId: id };
      assert.deepEqual(await requestPrincipal(request), { userId: id, canUseAdvancedSettings: true });
      for (const rejected of [{ confirmed: false }, { google: false }, { active: false }, { invalid: true }]) {
        fixture.auth = { userId: id, ...rejected };
        assert.equal(await requestPrincipal(request), null);
        assert.equal(await requestAuthenticated(request), false);
      }
    }
  });
});

test("restored preferences and conversation adapter flags cannot override normal account defaults", () => {
  const preferences = parseModelSettings(JSON.stringify({ bf16: { ...DEFAULT_SETTINGS, outputTokens: 256, reuseCachedPrefixes: false } }));
  const [chat] = parseConversations(JSON.stringify([{ id: "restored", title: "Old admin preferences", updatedAt: 1, model: "bf16",
    useAdapter: true, messages: [{ id: "old", role: "assistant", model: "bf16", useAdapter: true, content: "Historical answer" }] }]));
  assert.deepEqual(settingsForAccess(preferences.bf16, false, smallLimits), fitSettings(DEFAULT_SETTINGS, smallLimits));
  assert.equal(settingsForAccess(preferences.bf16, false).reuseCachedPrefixes, true);
  assert.equal(adapterForAccess("bf16", chat.useAdapter, false), false);
  assert.equal(adapterForAccess("bf16", undefined, false), false);
  assert.equal(adapterForAccess("bf16", chat.useAdapter, true), true);
  assert.equal(chat.messages[0].useAdapter, true, "Historical attribution must remain accurate");
  assert.equal(settingsForAccess(preferences.bf16, true).outputTokens, 256);
});

test("normal crafted requests replace every restricted field and fit defaults to gateway limits", async () => {
  await gatewayFixture(async fixture => {
    fixture.limits = smallLimits;
    const expected = fitSettings(DEFAULT_SETTINGS, smallLimits);
    for (const settings of [null, "forged", [], { unknown: true }, { ...SETTINGS_MAX, reuseCachedPrefixes: false },
      { inputCharacters: -1, outputTokens: "bad", timeoutSeconds: 0, safetyTokens: Infinity }]) {
      for (const useAdapter of [true, "false", null]) {
        const response = await POST(fixture.request({ model: "bf16", useAdapter, settings, max_tokens: "forged",
          canUseAdvancedSettings: true, isAdmin: true, userId: adminIds[0], temperature: 1.2 }));
        assert.equal(response.status, 200, await response.clone().text()); await response.text();
        const sent = fixture.calls.at(-1)!.body!;
        const effective = sent.settings as typeof expected;
        assert.deepEqual({ ...effective, timeoutSeconds: expected.timeoutSeconds }, expected);
        assert.ok(effective.timeoutSeconds <= expected.timeoutSeconds && effective.timeoutSeconds >= expected.timeoutSeconds - 1);
        assert.equal(sent.max_tokens, expected.outputTokens);
        assert.equal(sent.useAdapter, false); assert.equal(sent.temperature, 1.2);
        assert.equal(fixture.calls.at(-1)!.headers.get("X-Chat-User-Id"), user.id);
        assert.equal(Object.hasOwn(sent, "isAdmin"), false);
      }
    }
    for (const settings of [undefined, { outputTokens: 128, inputCharacters: 1 }]) {
      const response = await POST(fixture.request({ settings, max_tokens: 10240 }));
      assert.equal(response.status, 200); await response.text();
      assert.equal(fixture.calls.at(-1)!.body!.max_tokens, expected.outputTokens);
      assert.equal(fixture.calls.at(-1)!.body!.useAdapter, false);
    }
    const sentCount = fixture.calls.filter(call => call.body).length;
    for (const body of [{ messages: [{ role: "user", content: "x".repeat(51) }] },
      { messages: [messages[0], { role: "assistant", content: "reply" }, messages[0], { role: "assistant", content: "reply" }, messages[0]] },
      { temperature: 2 }, { docsMode: false }]) assert.equal((await POST(fixture.request(body))).status, 400);
    assert.equal(fixture.calls.filter(call => call.body).length, sentCount);
    fixture.limits = { ...smallLimits, reuseCachedPrefixes: false };
    const response = await POST(fixture.request({ settings: { reuseCachedPrefixes: false } }));
    assert.equal(response.status, 200); await response.text();
    assert.equal(Object.hasOwn(fixture.calls.at(-1)!.body!.settings, "reuseCachedPrefixes"), false, "Old gateways keep their default prefix reuse behavior");
    const before = fixture.calls.length;
    assert.equal((await POST(fixture.request({ ignored: "x".repeat(SETTINGS_MAX.requestBytes) }))).status, 400);
    assert.equal(fixture.calls.length, before, "Raw oversized JSON must not reach a gateway");
  });
});

test("normal BF16 requests fail closed without adapter capability or explicit false acknowledgement", async () => {
  await gatewayFixture(async fixture => {
    fixture.adapterAvailable = false;
    assert.equal((await POST(fixture.request({ model: "bf16", useAdapter: true }))).status, 503);
    assert.equal(fixture.calls.filter(call => call.body).length, 0);
    fixture.adapterAvailable = true; fixture.adapterConfirmation = "true";
    assert.equal((await POST(fixture.request({ model: "bf16", useAdapter: true }))).status, 503);
    assert.equal(fixture.calls.at(-1)!.body!.useAdapter, false);
  });
});

test("normal diagnostics requests are denied and status remains unavailable despite stale admin cookie", async () => {
  await gatewayFixture(async fixture => {
    const headers = { [DIAGNOSTICS_HEADER]: "1", "X-Admin": "true" };
    assert.equal((await POST(fixture.request({ canUseAdvancedSettings: true }, headers, adminIds[0]))).status, 403);
    assert.equal(fixture.calls.length, 0);
    const request = fixture.request({}, {}, adminIds[0]);
    const status = await GET(new Request("https://chat.example/api/status", { headers: request.headers }));
    assert.equal(status.headers.get("Cache-Control"), "no-store");
    const body = await status.json();
    assert.equal(body.diagnosticsAvailable, false); assert.equal(body.diagnosticsVersion, 0);
  });
});

test("both admins preserve adapter, numeric, prefix and diagnostic controls with strict validation", async () => {
  await gatewayFixture(async fixture => {
    for (const userId of adminIds) {
      fixture.auth = { userId }; fixture.adapterConfirmation = "true";
      const settings = { ...DEFAULT_SETTINGS, outputTokens: 512, timeoutSeconds: 30, reuseCachedPrefixes: false };
      const response = await POST(fixture.request({ model: "bf16", useAdapter: true, settings, max_tokens: 512 }, { [DIAGNOSTICS_HEADER]: "1" }, userId));
      assert.equal(response.status, 200); await response.text();
      const sent = fixture.calls.at(-1)!;
      const effectiveSettings = sent.body!.settings as typeof settings;
      assert.deepEqual({ ...effectiveSettings, timeoutSeconds: settings.timeoutSeconds }, settings);
      assert.ok(effectiveSettings.timeoutSeconds <= 30 && effectiveSettings.timeoutSeconds >= 29);
      assert.equal(sent.body!.useAdapter, true);
      assert.equal(sent.headers.get("X-Chat-User-Id"), userId);
      assert.equal(sent.body!.max_tokens, 512); assert.equal(sent.headers.get(DIAGNOSTICS_HEADER), "1");
      const status = await GET(new Request("https://chat.example/api/status", { headers: fixture.request({}, {}, userId).headers }));
      assert.equal((await status.json()).diagnosticsAvailable, true);
      const before = fixture.calls.filter(call => call.body).length;
      for (const body of [{ settings: null }, { settings: { unknown: true } }, { settings, max_tokens: 256 },
        { useAdapter: "false", model: "bf16" }, { settings: { ...settings, outputTokens: 10241 } }]) {
        assert.equal((await POST(fixture.request(body, {}, userId))).status, 400);
      }
      fixture.limits = smallLimits;
      assert.equal((await POST(fixture.request({ settings }, {}, userId))).status, 400);
      assert.equal(fixture.calls.filter(call => call.body).length, before);
      fixture.limits = { ...SETTINGS_MAX };
    }
  });
});

test("normal policy leaves regular message validation in force", () => {
  assert.throws(() => validateInput(inputForAccess({ messages, docsPassages: [] }, false)), /removed/);
  assert.throws(() => validateInput(inputForAccess({ messages, model: "unknown" }, false)), /supported/);
  assert.throws(() => validateInput(inputForAccess({ messages, temperature: "hot" }, false)), /Temperature/);
});
