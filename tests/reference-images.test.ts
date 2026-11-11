import assert from "node:assert/strict";
import { test } from "node:test";
import sharp from "sharp";
import { validateReferenceImage } from "../src/lib/image-reference-server";
import { IMAGE_REQUEST_MAX_BYTES, referenceEditingAvailable, REFERENCE_MAX_BYTES } from "../src/lib/image-reference";
import { requestImageJob } from "../src/lib/image-request";
import { mayStartImageRequest, parseGeneratedImage } from "../src/lib/generated-image";
import { cloudPayload } from "../src/lib/cloud-history";
import { imageProxy } from "../src/lib/image-server";
import { authResponse, adminIds, cookieHeader, issueSession } from "./auth-fixture";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ImageJobCard } from "../src/components/image-job-card";
import { ImageReferencePreview } from "../src/components/image-reference-preview";
import { parseGeneratedImage as legacyParseGeneratedImage } from "./fixtures/generated-image-v1";
import { parseConversations } from "../src/lib/storage";

const dataUrl = (bytes: Buffer, mime = "png") => `data:image/${mime};base64,${bytes.toString("base64")}`;
const png = () => sharp({ create: { width: 1024, height: 1024, channels: 3, background: "#667b51" } }).png().toBuffer();
const editCapability = { enabled: true, version: 1, maxReferenceImages: 1, mimeTypes: ["image/png", "image/jpeg"], width: 1024, height: 1024, maxImageBytes: REFERENCE_MAX_BYTES, maxRequestBytes: IMAGE_REQUEST_MAX_BYTES };

test("edit metadata uses version 2 so the deployed version-1 parser cannot reinterpret its instruction", () => {
  const edit = { version: 2 as const, prompt: "make it blue", requestId: "edit", status: "completed" as const, mode: "edit" as const, sourceImageId: "source-message" };
  assert.equal(legacyParseGeneratedImage(edit),undefined);
  assert.deepEqual(parseGeneratedImage(edit),edit);
  const text = { version: 1 as const, prompt: "blue tree", requestId: "text", status: "completed" as const };
  assert.deepEqual(legacyParseGeneratedImage(text),text); assert.deepEqual(parseGeneratedImage(text),text);
  assert.equal(parseGeneratedImage({ ...edit, version: 1 }),undefined);
  assert.equal(parseGeneratedImage({ ...edit, mode: "text" }),undefined);
  assert.equal(parseGeneratedImage({ ...edit, mode: undefined }),undefined);
  const missing = parseGeneratedImage({ ...edit, sourceImageId: undefined });
  assert.equal(missing?.mode,"edit"); assert.equal(missing?.version,2); assert.equal(missing?.sourceImageId,undefined);
  const chat = { id: "chat", title: "edit", updatedAt: 1, messages: [{ id: "message",role: "assistant" as const,content: "",state: "complete" as const,generatedImage: edit }] };
  assert.deepEqual(parseConversations(JSON.stringify([chat]))[0].messages[0].generatedImage,edit);
  assert.deepEqual(cloudPayload(chat).messages[0].generatedImage,edit);
});

test("reference preview keeps edit intent visible during preparing and missing-source states", () => {
  const render = (reference: { sourceImageId: string; dataUrl: string } | null, preparing: boolean) => renderToStaticMarkup(createElement(ImageReferencePreview, { reference, preparing, onRemove() {} }));
  const ready = render({ sourceImageId: "source-message", dataUrl: "data:image/jpeg;base64,reference" },false);
  assert.match(ready,/aria-label="Reference image for editing"/); assert.match(ready,/alt="Reference image to edit"/); assert.match(ready,/Ready to edit/); assert.match(ready,/Remove reference/);
  assert.match(render(null,true),/Preparing reference/);
  const missing = render(null,false); assert.match(missing,/Reference unavailable/); assert.match(missing,/Remove reference/); assert.doesNotMatch(missing,/<img/);
});

test("an unknown edit can be explicitly replaced without bypassing known or actively tracked work", async () => {
  const unknown = { version: 2 as const, prompt: "make it blue", requestId: "old", status: "submitting" as const, mode: "edit" as const, sourceImageId: "source-message" };
  assert.equal(mayStartImageRequest([unknown],false),true);
  assert.equal(mayStartImageRequest([unknown],true),false);
  assert.equal(mayStartImageRequest([{ ...unknown, jobId: "known" }],false),false);
  let calls = 0;
  const transport: typeof fetch = async (_url, init) => { calls++; assert.equal(new Headers(init?.headers).get("Idempotency-Key"),"new-explicit-request"); assert.ok(JSON.parse(String(init?.body)).referenceImage); return Response.json({ jobId: "new",kind: "edit" }); };
  const signal = new AbortController().signal;
  await assert.rejects(requestImageJob(unknown,true,signal,transport),/reference/); assert.equal(calls,0);
  await requestImageJob({ ...unknown, requestId: "new-explicit-request" },true,signal,transport,dataUrl(await png()));
  assert.equal(calls,1);
});

test("reference decoder validates actual PNG/JPEG pixels and rejects bad MIME, dimensions, animation and oversized data", async () => {
  const bytes = await png(); const source = dataUrl(bytes);
  assert.equal(await validateReferenceImage(source), source);
  const jpeg = dataUrl(await sharp(bytes).jpeg().toBuffer(), "jpeg");
  assert.equal(await validateReferenceImage(jpeg), jpeg);
  for (const bad of [bytes.toString("base64"), "https://private.example/reference.png", source.replace("image/png", "image/jpeg"), dataUrl(bytes.subarray(0, 33)), dataUrl(await sharp(bytes).resize(512,512).png().toBuffer()), dataUrl(Buffer.alloc(REFERENCE_MAX_BYTES + 1)), source + "=", null]) {
    await assert.rejects(validateReferenceImage(bad));
  }
  const animation = Buffer.alloc(20); animation.writeUInt32BE(8); animation.write("acTL", 4);
  await assert.rejects(validateReferenceImage(dataUrl(Buffer.concat([bytes.subarray(0,33), animation, bytes.subarray(33)]))), /single-frame/);
});

test("edit requests never downgrade to text-only or automatically POST without a known job", async () => {
  const image = { version: 2 as const, prompt: "make it blue", requestId: "edit-request", status: "submitting" as const, mode: "edit" as const, sourceImageId: "source-message" };
  let calls = 0, sent: Record<string, unknown> | undefined;
  const transport: typeof fetch = async (_url, init) => { calls++; sent = JSON.parse(String(init?.body ?? "{}")); return Response.json({ jobId: "new-job", status: "generating", kind: "edit" }); };
  const signal = new AbortController().signal, reference = dataUrl(await png());
  await assert.rejects(requestImageJob(image, true, signal, transport), /reference/); assert.equal(calls,0);
  assert.equal(await requestImageJob(image, false, signal, transport, reference), null); assert.equal(calls,0);
  await requestImageJob(image, true, signal, transport, reference);
  assert.deepEqual(sent, { prompt: image.prompt, referenceImage: reference }); assert.equal(calls,1);
  await assert.rejects(requestImageJob(image, true, signal, transport, "x".repeat(IMAGE_REQUEST_MAX_BYTES)), /limit/);
  assert.equal(calls,1);
});

test("edit provenance survives metadata while reference bytes are excluded; invalid provenance retains edit intent", () => {
  const generatedImage = { version: 2 as const, prompt: "make it blue", requestId: "edit-request", status: "completed" as const, mode: "edit" as const, sourceImageId: "source-message", referenceImage: "private bytes" };
  const metadata = cloudPayload({ id: "chat", title: "edit", updatedAt: 1, messages: [{ id: "edit-message", role: "assistant", content: "", state: "complete", generatedImage }] }).messages[0].generatedImage;
  assert.equal(metadata?.mode, "edit"); assert.equal(metadata?.sourceImageId,"source-message");
  assert.doesNotMatch(JSON.stringify(metadata), /private bytes|referenceImage/);
  const invalid = parseGeneratedImage({ ...generatedImage, sourceImageId: "../missing" });
  assert.equal(invalid?.mode,"edit"); assert.equal(invalid?.sourceImageId,undefined);
  const html = renderToStaticMarkup(createElement(ImageJobCard, { userId: "alice", id: "edit-message", image: invalid!, allowed: true, onCheck() {}, onCancel() {}, onEdit() {}, onGenerate() {} }));
  assert.match(html,/reference image edit/); assert.match(html,/Edit again/); assert.doesNotMatch(html,/Generate again|Edit this image/);
});

test("reference capability must explicitly acknowledge readiness and matching limits", () => {
  assert.equal(referenceEditingAvailable(editCapability),true);
  for (const change of [{ enabled: false }, { version: 0 }, { maxImageBytes: REFERENCE_MAX_BYTES + 1 }, { maxReferenceImages: 2 }, { width: 512 }]) assert.equal(referenceEditingAvailable({ ...editCapability, ...change }),false);
});

test("admin proxy validates reference before forwarding and requires backend edit acknowledgement", async () => {
  const original = globalThis.fetch, env = { ...process.env };
  let calls = 0, kind = "edit";
  try {
    Object.assign(process.env,{ NODE_ENV: "production", FLUX_IMAGE_API_URL: "https://flux.example", FLUX_IMAGE_API_KEY: "private" });
    globalThis.fetch = async (url, init) => {
      const auth = authResponse(url,init,{ userId: adminIds[0] }); if (auth) return auth;
      calls++; assert.equal(new Headers(init?.headers).get("X-Chat-User-Id"),adminIds[0]);
      assert.equal(JSON.parse(String(init?.body)).referenceImage,reference);
      return Response.json({ jobId: "job", status: "generating", kind });
    };
    const reference = dataUrl(await png());
    const request = (referenceImage: unknown) => new Request("https://chat.example/api/images",{ method: "POST", headers: { Cookie: cookieHeader(issueSession(adminIds[0])), Origin: "https://chat.example", "Content-Type": "application/json", "Idempotency-Key": "edit-id" }, body: JSON.stringify({ prompt: "make it blue", referenceImage }) });
    const result = await imageProxy(request(reference)); assert.equal(result.status,200); assert.equal((await result.json()).kind,"edit");
    assert.equal((await imageProxy(request("https://secret.example/image"))).status,400); assert.equal(calls,1);
    kind = "text"; assert.equal((await imageProxy(request(reference))).status,502);
    assert.equal((await imageProxy(request("x".repeat(IMAGE_REQUEST_MAX_BYTES)))).status,400);
  } finally { globalThis.fetch = original; process.env = env; }
});
