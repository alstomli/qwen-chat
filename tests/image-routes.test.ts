import { test } from "node:test";
import assert from "node:assert/strict";
import { GET as availability, POST as submit } from "../src/app/api/images/route";
import { GET as status } from "../src/app/api/images/[jobId]/route";
import { GET as download } from "../src/app/api/images/[jobId]/download/route";
import { COOKIE, issueSession } from "../src/lib/auth";

const origin = "https://chat.example";
const endpoint = "https://api.runpod.ai/v2/black-forest-labs-flux-1-schnell";
const providerId = "run-job-123";
const outputUrl = "https://image.runpod.ai/generated/result.png";
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+KmL8AAAAASUVORK5CYII=", "base64");

test("image routes validate, scope and download asynchronous Runpod jobs", async (t) => {
  t.mock.method(Date, "now", () => 1_800_000_000_000);
  process.env.CHAT_PASSWORD = "image-route-test-password";
  process.env.SESSION_SECRET = "image-route-test-secret-" + "x".repeat(40);
  delete process.env.RUNPOD_IMAGE_API_KEY;
  const token = issueSession();
  const request = (path: string, options: RequestInit = {}, session: string | null = token) => new Request(origin + path, {
    ...options,
    headers: { ...(session ? { cookie: `${COOKIE}=${session}` } : {}), ...options.headers },
  });
  const post = (prompt: unknown, source = origin, session: string | null = token) => submit(request("/api/images", {
    method: "POST",
    headers: { origin: source, "Content-Type": "application/json" },
    body: JSON.stringify({ prompt }),
  }, session));

  let providerStatus = "IN_QUEUE";
  let providerImage = outputUrl;
  let imageBody: BodyInit = png;
  let imageMime = "image/png";
  const fetchMock = t.mock.method(globalThis, "fetch", async (input: URL | string, options: RequestInit) => {
    const url = String(input);
    assert.equal(options.cache, "no-store");
    assert.equal(options.redirect, "error");
    if (url === outputUrl) {
      assert.equal(new Headers(options.headers).has("authorization"), false);
      return new Response(imageBody, { headers: { "Content-Type": imageMime } });
    }
    assert.equal(new Headers(options.headers).get("authorization"), "Bearer mock-key");
    if (url === endpoint + "/run") {
      assert.equal(options.method, "POST");
      assert.deepEqual(JSON.parse(String(options.body)), { input: { prompt: "A seascape", width: 1024, height: 1024 } });
      return Response.json({ id: providerId, status: "IN_QUEUE" });
    }
    assert.equal(url, endpoint + "/status/" + providerId);
    return Response.json({ id: providerId, status: providerStatus, output: { image_url: providerImage }, error: "private provider details" });
  });

  const disabled = availability(request("/api/images"));
  assert.equal((await disabled.json()).enabled, false);
  assert.equal((await post("A seascape")).status, 503);
  assert.equal(availability(request("/api/images", {}, null)).status, 401);
  process.env.RUNPOD_IMAGE_API_KEY = "mock-key";
  const enabled = availability(request("/api/images"));
  assert.deepEqual(await enabled.json(), { enabled: true, maxPromptLength: 2000 });
  assert.equal(enabled.headers.get("Cache-Control"), "no-store");
  assert.equal((await post("A seascape", "https://foreign.example")).status, 403);
  assert.equal((await post("A seascape", origin, null)).status, 401);
  for (const prompt of [null, "", "  ", "x".repeat(2001), "x".repeat(20_000)]) {
    assert.equal((await post(prompt)).status, 400);
  }
  assert.equal(fetchMock.mock.callCount(), 0);

  const submitted = await post("  A seascape  ");
  assert.equal(submitted.status, 202);
  const pending = await submitted.json();
  assert.equal(pending.status, "queued");
  const jobPath = `/api/images/${pending.jobId}`;
  const jobParams = { params: Promise.resolve({ jobId: pending.jobId }) };
  assert.notEqual(pending.jobId, providerId);
  assert.equal((await status(request(jobPath, {}, null), jobParams)).status, 401);
  assert.equal((await status(request(jobPath, {}, issueSession()), jobParams)).status, 404);
  assert.equal((await download(request(jobPath + "/download", {}, issueSession()), jobParams)).status, 404);
  assert.equal((await status(request(jobPath), { params: Promise.resolve({ jobId: providerId }) })).status, 404);
  assert.equal(fetchMock.mock.callCount(), 1);

  providerStatus = "IN_PROGRESS";
  assert.equal((await (await status(request(jobPath), jobParams)).json()).status, "generating");
  assert.equal((await download(request(jobPath + "/download"), jobParams)).status, 409);

  providerStatus = "COMPLETED";
  const completed = await (await status(request(jobPath), jobParams)).json();
  assert.equal(completed.status, "completed");
  assert.deepEqual(completed.image, {
    url: jobPath + "/download",
    width: 1024,
    height: 1024,
    expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
  });
  assert.equal(JSON.stringify(completed).includes("image.runpod.ai"), false);
  const assetRequest = () => download(request(completed.image.url), jobParams);
  const asset = await assetRequest();
  assert.equal(asset.status, 200);
  assert.equal(asset.headers.get("Content-Type"), "image/png");
  assert.equal(asset.headers.get("Cache-Control"), "no-store");
  assert.deepEqual(Buffer.from(await asset.arrayBuffer()), png);

  imageMime = "image/svg+xml";
  assert.equal((await assetRequest()).status, 502);
  imageMime = "image/png";
  imageBody = "not an image";
  assert.equal((await assetRequest()).status, 502);
  imageBody = new Uint8Array(4 * 1024 * 1024 + 1);
  assert.equal((await assetRequest()).status, 502);
  for (const invalidUrl of ["http://image.runpod.ai/image.png", "https://image.runpod.ai.evil.test/x.png", "blob:https://image.runpod.ai/abc"]) {
    providerImage = invalidUrl;
    const failed = await (await status(request(jobPath), jobParams)).json();
    assert.equal(failed.status, "failed");
    assert.equal(failed.image, undefined);
    assert.equal((await assetRequest()).status, 422);
  }
  providerStatus = "FAILED";
  const failed = await (await status(request(jobPath), jobParams)).json();
  assert.equal(failed.status, "failed");
  assert.equal(JSON.stringify(failed).includes("private provider details"), false);

  for (let count = 1; count < 10; count++) assert.equal((await post("A seascape")).status, 202);
  const throttled = await post("A seascape");
  assert.equal(throttled.status, 429);
  assert.equal(throttled.headers.get("Retry-After"), "60");
  t.mock.method(Date, "now", () => 1_800_000_000_000 + 30 * 60_000);
  assert.equal((await status(request(jobPath), jobParams)).status, 410);
});
