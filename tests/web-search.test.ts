import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MessageMarkdown } from "../src/components/chat-workspace";
import { WebSources } from "../src/components/web-sources";
import { consumeCompletion, validateInput } from "../src/lib/protocol";
import { parseWebMetadata, parseWebSearchProfiles, webSearchForProfile, validatedWebStream, webEventReader, type WebEvent } from "../src/lib/web-search";
import { completedHistory, parseConversations, type Message } from "../src/lib/storage";
import { cloudPayload, historyMarkdown } from "../src/lib/cloud-history";
import { POST } from "../src/app/api/chat/route";
import { GET } from "../src/app/api/status/route";
import { authResponse, cookieHeader, issueSession } from "./auth-fixture";
import { SETTINGS_MAX } from "../src/lib/chat-settings";

const runId = "web_run_1";
const source = { runId, sourceId: "S1", title: "Useful source", url: "https://example.com/docs", retrievedAt: "2026-11-10T13:00:00Z", evidenceKind: "page" as const };
const metadata = { version: 1 as const, runId, outcome: "completed" as const, sources: [source] };
const messages = [{ role: "user", content: "Look it up" }];
const frame = (name: string, sequence: number, extra = {}) => `event: ${name}\ndata: ${JSON.stringify({ version: 1, runId, sequence, ...extra })}\n\n`;
const webStream = frame("web-status", 1, { status: "searching" }) + frame("web-sources", 2, { sources: [source] }) +
  'data: {"choices":[{"delta":{"content":"Useful café [S1]"}}]}\n\n' + frame("web-complete", 3, { outcome: "completed" }) + "data: [DONE]\n\n";
function bytes(text: string, split = 1) {
  const data = new TextEncoder().encode(text);
  return new ReadableStream<Uint8Array>({ start(c) { for (let i = 0; i < data.length; i += split) c.enqueue(data.slice(i, i + split)); c.close(); } });
}

test("web search is opt-in, versioned, strict and incompatible with image input", () => {
  assert.equal(validateInput({ messages }).webSearch, undefined);
  assert.equal(validateInput({ messages, webSearch: { version: 1, mode: "off" } }).webSearch, undefined);
  for (const mode of ["required", "auto"]) assert.equal(validateInput({ messages, webSearch: { version: 1, mode } }).webSearch?.mode, mode);
  for (const webSearch of [null, true, "required", {}, { version: 2, mode: "required" }, { version: 1, mode: "sometimes" }, { version: 1, mode: "required", apiKey: "forbidden" }])
    assert.throws(() => validateInput({ messages, webSearch }));
  assert.throws(() => validateInput({ messages, image: "bad", webSearch: { version: 1, mode: "required" } }), /separate messages/);
});

test("source metadata strips raw evidence and rejects unsafe or rebound identities", () => {
  assert.deepEqual(parseWebMetadata({ ...metadata, providerKey: "no", sources: [{ ...source, body: "private raw page", snippet: "no" }] }), metadata);
  for (const bad of [{ url: "javascript:alert(1)" }, { url: "https://name:password@example.com/" }, { url: "https://example.com/\nfoo" }, { sourceId: "S0" }, { runId: "other" }, { retrievedAt: "yesterday" }, { evidenceKind: "invented" }])
    assert.equal(parseWebMetadata({ ...metadata, sources: [{ ...source, ...bad }] }), undefined);
  const events = webEventReader();
  events.read("web-sources", { ...metadata, sequence: 1 });
  assert.throws(() => events.read("web-sources", { ...metadata, sequence: 2, sources: [{ ...source, url: "https://other.com/" }] }));
});

test("web capabilities distinguish verified base and adapter aliases", () => {
  const capability = { webSearchAvailable: false, webSearchProfiles: parseWebSearchProfiles([
    { useAdapter: true, available: false, model: "unverified-adapter" }, { useAdapter: false, available: true, model: "verified-base" },
  ]) };
  assert.equal(webSearchForProfile(capability, "bf16", true), false);
  assert.equal(webSearchForProfile(capability, "bf16", false), true);
  assert.equal(webSearchForProfile({ webSearchAvailable: true }, "bf16", false), false);
  assert.equal(parseWebSearchProfiles([{ useAdapter: false, available: true }, { useAdapter: false, available: false }]), undefined);
});

test("server and browser parse split UTF-8 SSE, preserving deltas and run-scoped sources", async () => {
  const events: WebEvent[] = []; let answer = "";
  await consumeCompletion(validatedWebStream(bytes(webStream)), text => answer += text, undefined, undefined, undefined, event => events.push(event));
  assert.equal(answer, "Useful café [S1]");
  assert.deepEqual(events.map(e => [e.type, e.sequence]), [["web-status", 1], ["web-sources", 2], ["web-complete", 3]]);
  assert.deepEqual(events[1].type === "web-sources" && events[1].sources, [source]);
});

test("web streams reject stale runs, duplicate order, malformed sources and missing terminal events", async () => {
  for (const extra of [{ sequence: 0, status: "reading" }, { sequence: 2, runId: "stale", status: "reading" }, { sequence: 2, status: "invented" }]) {
    const invalid = frame("web-status", 1, { status: "planning" }) + frame("web-status", 2, extra);
    await assert.rejects(consumeCompletion(validatedWebStream(bytes(invalid)), () => {}));
  }
  await assert.rejects(consumeCompletion(validatedWebStream(bytes("data: [DONE]\n\n")), () => {}));
  await assert.rejects(consumeCompletion(bytes("data: [DONE]\n\n"), () => {}, undefined, undefined, undefined, () => {}));
  let stopped = false;
  const stream = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new TextEncoder().encode(frame("web-status", 1, { status: "planning" }))); }, cancel() { stopped = true; } });
  await assert.rejects(consumeCompletion(stream, () => {}, undefined, undefined, undefined, () => { throw new Error("stop"); }), /stop/);
  assert.equal(stopped, true);
});

test("citations resolve only registered message sources and never rewrite code", () => {
  const message: Message = { id: "a", role: "assistant", content: "Registered [S1], unknown [S2]. `literal [S1]`\n\n```txt\n[S1]\n```", state: "complete", webSearch: metadata };
  const html = renderToStaticMarkup(createElement(MessageMarkdown, { message }));
  assert.match(html, /href="https:\/\/example.com\/docs"[^>]*class="web-citation"/);
  assert.match(html, /aria-label="S1: Useful source/);
  assert.match(html, /unknown \[S2\]/);
  assert.match(html, /<code>literal \[S1\]<\/code>/);
  assert.match(html, /<code class="language-txt">\[S1\]/);
  const other = renderToStaticMarkup(createElement(MessageMarkdown, { message: { ...message, webSearch: undefined } }));
  assert.doesNotMatch(other, /web-citation|example.com/);
  const forged = renderToStaticMarkup(createElement(MessageMarkdown, { message: { ...message, content: "[S1](https://forged.invalid/) [S2](https://forged.invalid/) [Invented](https://forged.invalid/)" } }));
  assert.doesNotMatch(forged, /forged.invalid/);
  assert.match(forged, /href="https:\/\/example.com\/docs"/);
  assert.match(renderToStaticMarkup(createElement(WebSources, { message })), /Answer with web sources/);
  assert.doesNotMatch(renderToStaticMarkup(createElement(WebSources, { message: { ...message, state: "error" } })), /Answer with web sources/);
});

test("browser, cloud and exports preserve compact citations without putting metadata into model messages", () => {
  const [chat] = parseConversations(JSON.stringify([{ id: "chat", title: "Web", updatedAt: 1, messages: [
    { id: "u", role: "user", content: "Look up", searchRequested: true },
    { id: "a", role: "assistant", content: "Found [S1]", state: "complete", webSearch: { ...metadata, sources: [{ ...source, body: "do not persist" }] } },
  ] }]));
  assert.deepEqual(chat.messages[1].webSearch, metadata);
  const payload = cloudPayload(chat);
  assert.deepEqual(payload.messages[1].webSearch, metadata);
  assert.equal(payload.messages[0].searchRequested, true);
  assert.match(historyMarkdown([chat]), /\[S1\] Useful source: https:\/\/example.com\/docs/);
  assert.doesNotMatch(JSON.stringify(payload), /do not persist|body/);
  assert.deepEqual(completedHistory(chat.messages), [{ role: "user", content: "Look up" }, { role: "assistant", content: "Found [S1]" }]);
});

test("authenticated API fails closed on unsupported or unconfirmed search and validates streamed sources", async context => {
  const saved = { ...process.env }; let available = true; let accepted = true; let forwarded: Record<string, unknown> | undefined; let abortDuringHealth: (() => void) | undefined;
  Object.assign(process.env, { NODE_ENV: "production", RUNPOD_BF16_CHAT_URL: "https://gateway.example", RUNPOD_BF16_CHAT_TOKEN: "x".repeat(48) });
  context.mock.method(globalThis, "fetch", async (...[url, init]: Parameters<typeof fetch>) => {
    const auth = authResponse(url, init); if (auth) return auth;
    if (String(url).endsWith("/health")) {
      abortDuringHealth?.();
      return Response.json({ ready: true, model: "qwen-bf16", settingsVersion: 1, accountQuotaVersion: 1, accountQuotasEnforced: true, adapterToggleVersion: 1, adapterToggleAvailable: true, limits: SETTINGS_MAX, webSearchVersion: 1, webSearchAvailable: available, webSearch: { models: [{ useAdapter: false, available }] } });
    }
    forwarded = JSON.parse(String(init?.body));
    return new Response(webStream, { headers: { "X-Chat-Adapter-Enabled": "false", ...(accepted ? { "X-Chat-Web-Search": "1" } : {}) } });
  });
  const headers = { Origin: "https://chat.example", Cookie: cookieHeader(issueSession()).split(";")[0], "Content-Type": "application/json" };
  const request = (signal?: AbortSignal) => new Request("https://chat.example/api/chat", { method: "POST", headers, signal, body: JSON.stringify({ messages, webSearch: { version: 1, mode: "required" } }) });
  try {
    assert.equal((await POST(new Request("https://chat.example/api/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ messages }) }))).status, 401);
    const status = await (await GET(new Request("https://chat.example/api/status", { headers }))).json();
    assert.equal(status.webSearchAvailable, true);
    const response = await POST(request()); assert.equal(response.status, 200); assert.equal(response.headers.get("X-Chat-Web-Search"), "1");
    assert.match(await response.text(), /web-sources/); assert.deepEqual(forwarded?.webSearch, { version: 1, mode: "required" });
    accepted = false; assert.equal((await POST(request())).status, 503);
    available = false; forwarded = undefined; assert.equal((await POST(request())).status, 503); assert.equal(forwarded, undefined);
    available = true; accepted = true;
    const abort = new AbortController(); abortDuringHealth = () => abort.abort();
    assert.equal((await POST(request(abort.signal))).status, 499);
    assert.equal(forwarded, undefined, "Stop during capability setup must never start model or paid search work");
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }
});
