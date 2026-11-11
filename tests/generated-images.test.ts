import assert from "node:assert/strict";
import { test } from "node:test";
import { imageProxy, boundedBytes, validPng } from "../src/lib/image-server";
import { imageFailureStatus, parseGeneratedImage } from "../src/lib/generated-image";
import { cloudPayload, historyMarkdown } from "../src/lib/cloud-history";
import { completedHistory, parseConversations, type Conversation } from "../src/lib/storage";
import { adminIds, authResponse, cookieHeader, issueSession } from "./auth-fixture";
import { ownsImageRequest, rememberImageRequest, forgetImageRequest } from "../src/lib/image-origin";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ImageJobCard } from "../src/components/image-job-card";
import { requestImageJob } from "../src/lib/image-request";

test("reload never re-POSTs an unconfirmed submission; new explicit actions may submit", async () => {
  const calls: { url: string; method: string; key: string | null }[] = [];
  const transport: typeof fetch = async (url, init) => {
    calls.push({ url: String(url), method: init?.method ?? "GET", key: new Headers(init?.headers).get("Idempotency-Key") });
    return Response.json({ jobId: "known", status: "generating" });
  };
  const unknown = { version: 1 as const, requestId: "stable", prompt: "tree", status: "submitting" as const };
  const signal = new AbortController().signal;
  assert.equal(await requestImageJob(unknown, false, signal, transport), null);
  assert.deepEqual(calls, []);
  await requestImageJob(unknown, true, signal, transport);
  assert.deepEqual(calls, [{ url: "/api/images", method: "POST", key: "stable" }]);
  calls.length = 0;
  await requestImageJob({ ...unknown, jobId: "known" }, false, signal, transport);
  assert.deepEqual(calls, [{ url: "/api/images/known", method: "GET", key: null }]);
});

test("foreign pending image cards offer explicit regeneration without live-job controls", () => {
  for (const status of ["submitting", "generating", "completed"] as const) {
    const html = renderToStaticMarkup(createElement(ImageJobCard, { userId: "alice", id: "message", image: { version: 1, requestId: "foreign", prompt: "tree", status }, allowed: true, onCheck() {}, onCancel() {}, onEdit() {}, onGenerate() {} }));
    assert.match(html, /Saved job details/);
    assert.match(html, /Generate again/);
    assert.doesNotMatch(html, /Check same job|Cancel generation|Saved on this browser/);
  }
});

test("only the originating browser and account can resume a synced image request", () => {
  const browser = () => { const data = new Map<string,string>(); return { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key,value); }, removeItem: (key: string) => { data.delete(key); } }; };
  const origin = browser(), otherBrowser = browser();
  rememberImageRequest("alice", "request", origin);
  assert.equal(ownsImageRequest("alice", "request", origin), true);
  assert.equal(ownsImageRequest("bob", "request", origin), false);
  assert.equal(ownsImageRequest("alice", "request", otherBrowser), false);
  // Cloud metadata can be identical; it does not establish origin in another store.
  const synced = { version: 1, prompt: "tree", requestId: "request", status: "submitting" };
  assert.ok(parseGeneratedImage(synced));
  assert.equal(ownsImageRequest("alice", synced.requestId, otherBrowser), false);
  forgetImageRequest("alice", "request", origin);
  assert.equal(ownsImageRequest("alice", "request", origin), false);
});

test("unavailable, full or nonpersistent browser storage never grants image origin", () => {
  const unavailable = { getItem() { throw new Error("denied"); }, setItem() { throw new Error("full"); }, removeItem() {} };
  assert.equal(ownsImageRequest("alice", "request", unavailable), false);
  assert.throws(() => rememberImageRequest("alice", "request", unavailable), /couldn't save/);
  const silentFailure = { getItem() { return null; }, setItem() {}, removeItem() {} };
  assert.throws(() => rememberImageRequest("alice", "request", silentFailure), /couldn't save/);
});

test("generated prompts survive cloud/export whitelists without entering Qwen context", () => {
  const generatedImage = { version: 1 as const, requestId: "request", prompt: "An olive tree", status: "queued" as const, jobId: "job", url: "https://secret.example/file", token: "secret" };
  const chat: Conversation = { id: "chat", title: "Tree", updatedAt: 1, messages: [{ id: "image", role: "assistant", content: "", state: "complete", generatedImage }] };
  const payload = cloudPayload(chat);
  assert.deepEqual(payload.messages[0].generatedImage, { version: 1, requestId: "request", prompt: "An olive tree", status: "queued", jobId: "job" });
  assert.deepEqual(completedHistory(chat.messages), []);
  assert.match(historyMarkdown([chat]), /An olive tree/);
  assert.deepEqual(parseConversations(JSON.stringify([chat]))[0].messages[0].generatedImage, payload.messages[0].generatedImage);
  assert.equal(parseGeneratedImage({ ...generatedImage, jobId: "../other/image" }), undefined);
});

test("bounded readers stop oversized streams and verify fixed PNG dimensions", async () => {
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({ pull(controller) { controller.enqueue(new Uint8Array(9)); }, cancel() { cancelled = true; } });
  await assert.rejects(boundedBytes(stream, 10)); assert.equal(cancelled, true);
  const png = new Uint8Array(33); png.set([137,80,78,71,13,10,26,10,0,0,0,13,73,72,68,82]);
  new DataView(png.buffer).setUint32(16,1024); new DataView(png.buffer).setUint32(20,1024);
  assert.equal(validPng(png), true); png[20] = 1; assert.equal(validPng(png), false);
});

test("image proxy enforces admin identity, origin, bounds, trusted paths and sanitized errors", async () => {
  const original = globalThis.fetch, env = { ...process.env };
  let admin = true, upstream = 0, reply: () => Response = () => Response.json({ jobId: "job1", status: "queued", token: "secret" });
  const request = (body = { prompt: "tree" }, origin = "https://chat.example") => new Request("https://chat.example/api/images", { method: "POST", headers: { Cookie: cookieHeader(issueSession(adminIds[0])), Origin: origin, "Content-Type": "application/json", "Idempotency-Key": "request1", "X-Chat-User-Id": "spoofed" }, body: JSON.stringify(body) });
  try {
    Object.assign(process.env, { NODE_ENV: "production", FLUX_IMAGE_API_URL: "https://flux.example", FLUX_IMAGE_API_KEY: "private-key" });
    globalThis.fetch = async (input, init) => {
      const auth = authResponse(input, init, admin ? { userId: adminIds[0] } : {}); if (auth) return auth;
      upstream++; assert.equal(String(input), "https://flux.example/v1/image-jobs");
      assert.equal(new Headers(init?.headers).get("X-Chat-User-Id"), adminIds[0]);
      assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer private-key");
      return reply();
    };
    assert.deepEqual(await (await imageProxy(request())).json(), { jobId: "job1", status: "queued", cancellationRequested: false });
    admin = false; assert.equal((await imageProxy(request())).status, 403); admin = true;
    assert.equal((await imageProxy(request(undefined, "https://evil.example"))).status, 403);
    assert.equal((await imageProxy(request({ prompt: "x".repeat(13000) }))).status, 400);
    assert.equal(upstream, 1);
    reply = () => Response.json({ error: { code: "busy", message: "private detail" } }, { status: 429, headers: { "Retry-After": "5" } });
    const busy = await imageProxy(request());
    assert.equal(busy.status, 429); assert.equal(busy.headers.get("Retry-After"), "5");
    assert.match((await busy.json()).error.message, /busy creating another image/);
    reply = () => Response.json({ error: { code: "unknown", message: "private secret" } }, { status: 500 });
    assert.doesNotMatch(await (await imageProxy(request())).text(), /private secret/);
    reply = () => Response.json({ jobId: "../secret", status: "completed" });
    assert.equal((await imageProxy(request())).status, 502);
    process.env.FLUX_IMAGE_API_URL = "http://flux.example";
    assert.equal((await imageProxy(request())).status, 503);
  } finally { globalThis.fetch = original; process.env = env; }
});


test("no-queue busy admission fails visibly while transient reads retain the known job", () => {
  const image = { version: 1 as const, requestId: "request", prompt: "tree", status: "submitting" as const };
  assert.equal(imageFailureStatus(image,429), "failed");
  const generating = { ...image, jobId: "known", status: "generating" as const };
  assert.equal(imageFailureStatus(generating,429), "generating");
  assert.equal(imageFailureStatus(generating,503), "generating");
  assert.equal(imageFailureStatus(generating,404), "failed");
  assert.equal(imageFailureStatus(generating,410), "expired");
});
