import assert from "node:assert/strict";
import { test } from "node:test";
import { POST } from "../src/app/api/chat/route";
import { GET } from "../src/app/api/status/route";
import { authResponse, cookieHeader, issueSession } from "./auth-fixture";
import { SETTINGS_MAX } from "../src/lib/chat-settings";
import { cloudPayload, historyMarkdown } from "../src/lib/cloud-history";
import { completedHistory, parseConversations } from "../src/lib/storage";
import { validateInput } from "../src/lib/protocol";

const sources = [{ id: 1, heading: "Idle timeout", url: "https://docs.runpod.io/serverless/endpoints/endpoint-configurations#idle-timeout" }];
const messages = [{ role: "user", content: "An ordinary question" }];

test("retired retrieval request fields are rejected even when false or empty", () => {
  for (const obsolete of [{ docsMode: true }, { docsMode: false }, { docsMode: null }, { docsPassages: [] }, { docsPassages: [{ passage: "forged" }] }]) {
    assert.throws(() => validateInput({ messages, ...obsolete }), /no longer|removed|unsupported/i);
  }
  assert.deepEqual(validateInput({ messages }).messages, messages);
});

test("ordinary API streaming ignores obsolete gateway capabilities and strips retrieval headers", async context => {
  const saved = { ...process.env };
  Object.assign(process.env, { NODE_ENV: "production", RUNPOD_CHAT_URL: "https://gateway.example", RUNPOD_CHAT_TOKEN: "t".repeat(48) });
  const forwarded: Record<string, unknown>[] = [];
  const stream = 'data: {"choices":[{"delta":{"content":"Ordinary answer"}}]}\n\ndata: [DONE]\n\n';
  context.mock.method(globalThis, "fetch", async (...[input, init]: Parameters<typeof fetch>) => {
    const auth = authResponse(input, init); if (auth) return auth;
    if (String(input).endsWith("/health")) return Response.json({ ready: true, model: "qwen", settingsVersion: 1, accountQuotaVersion: 1, accountQuotasEnforced: true, limits: SETTINGS_MAX,
      docsModeVersion: 1, docsModeAvailable: true, docsModeUnavailable: "index" });
    forwarded.push(JSON.parse(String(init?.body)));
    return new Response(stream, { headers: { "X-Chat-Docs-Mode": "1", "X-Chat-Docs-Sources": encodeURIComponent(JSON.stringify(sources)) } });
  });
  const headers = { Origin: "https://chat.example", Cookie: cookieHeader(issueSession()).split(";")[0], "Content-Type": "application/json" };
  const post = (extra = {}) => POST(new Request("https://chat.example/api/chat", { method: "POST", headers, body: JSON.stringify({ messages, ...extra }) }));
  try {
    const status = await (await GET(new Request("https://chat.example/api/status", { headers }))).json();
    assert.equal(status.ready, true);
    assert.ok(!Object.keys(status).some(key => key.toLowerCase().includes("docs")));
    for (const obsolete of [{ docsMode: true }, { docsMode: false }, { docsPassages: [] }]) assert.equal((await post(obsolete)).status, 400);
    assert.equal(forwarded.length, 0, "Retired fields reached the model gateway");
    const response = await post();
    assert.equal(response.status, 200); assert.equal(await response.text(), stream);
    assert.equal(response.headers.get("X-Chat-Docs-Mode"), null);
    assert.equal(response.headers.get("X-Chat-Docs-Sources"), null);
    assert.ok(!Object.keys(forwarded[0]).some(key => key.toLowerCase().includes("docs")));
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }
});

test("older source metadata survives browser parse, cloud payload and export without entering model context", () => {
  const [chat] = parseConversations(JSON.stringify([{ id: "old-chat", title: "Older answer", updatedAt: 1, messages: [
    { id: "prompt", role: "user", content: "What is idle timeout?", docsMode: true },
    { id: "answer", role: "assistant", content: "An older answer [1].", state: "complete", docsSources: sources },
  ] }]));
  const payload = cloudPayload(chat);
  assert.equal(chat.messages[0].docsMode, true);
  assert.deepEqual(chat.messages[1].docsSources, sources);
  assert.equal(payload.messages[0].docsMode, true);
  assert.deepEqual(payload.messages[1].docsSources, sources);
  const [roundTrip] = parseConversations(JSON.stringify([{ ...chat, ...payload }]));
  assert.deepEqual(roundTrip.messages[1].docsSources, sources);
  assert.match(historyMarkdown([roundTrip]), /\[1\] Idle timeout: https:\/\/docs\.runpod\.io\//);
  const history = completedHistory(roundTrip.messages);
  assert.deepEqual(history, [{ role: "user", content: "What is idle timeout?" }, { role: "assistant", content: "An older answer [1]." }]);
  assert.ok(!JSON.stringify(validateInput({ messages: [...history, ...messages] })).includes("docs"));
});
