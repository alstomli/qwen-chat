import { requestPrincipal, sameOrigin } from "./auth";
import { parseGeneratedImage } from "./generated-image";

export async function boundedBytes(stream: ReadableStream<Uint8Array> | null, limit: number) {
  if (!stream) throw new Error("Empty response");
  const reader = stream.getReader(); const chunks: Uint8Array[] = []; let total = 0;
  try { while (true) { const { value, done } = await reader.read(); if (done) break; total += value.byteLength; if (total > limit) { await reader.cancel(); throw new Error("Response too large"); } chunks.push(value); } }
  finally { reader.releaseLock(); }
  const result = new Uint8Array(total); let offset = 0; for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; } return result;
}
export function validPng(bytes: Uint8Array) {
  return bytes.length >= 33 && [137,80,78,71,13,10,26,10].every((byte,index) => bytes[index] === byte)
    && new DataView(bytes.buffer, bytes.byteOffset).getUint32(8) === 13
    && String.fromCharCode(...bytes.slice(12,16)) === "IHDR"
    && new DataView(bytes.buffer, bytes.byteOffset).getUint32(16) === 1024 && new DataView(bytes.buffer, bytes.byteOffset).getUint32(20) === 1024;
}
const safeErrors: Record<string,string> = { daily_quota: "Your daily image limit has been reached. It resets at midnight UTC.", unavailable: "The image model is loading or unavailable. Check again shortly.", idempotency_conflict: "This request ID belongs to a different prompt. Generate a new image request.", unavailable_image: "This image result is unavailable or expired.", not_completed: "This image is still being generated. Check the same job.", account_busy: "Your account already has an image in progress.", user_capacity: "Your account already has an image in progress.", queue_full: "The image queue is full. Try again shortly.", daily_limit: "Your daily image limit has been reached.", quota_exceeded: "Your daily image limit has been reached.", expired: "This image result has expired.", not_found: "This image job is unavailable.", not_ready: "The image model is loading. Check again shortly." };
const headers = { "Cache-Control": "private, no-store" };
export async function imageProxy(request: Request, jobId?: string, download = false) {
  const principal = await requestPrincipal(request);
  const error = (message: string, status: number) => Response.json({ error: { message } }, { status, headers });
  if (!principal) return error("Your session expired. Sign in to continue.", 401);
  if (!principal.canUseAdvancedSettings) return error("Image generation is available to administrators only.", 403);
  if (request.method !== "GET" && !sameOrigin(request)) return error("This request isn't allowed.", 403);
  if (jobId && !/^[a-zA-Z0-9_-]{1,128}$/.test(jobId)) return error("Invalid image job.", 400);
  const base = process.env.FLUX_IMAGE_API_URL?.replace(/\/$/, "");
  const token = process.env.FLUX_IMAGE_API_KEY;
  if (!base || !token) return error("Image generation has not been configured.", 503);
  let target: URL;
  try { target = new URL(base); if (target.username || target.password || target.search || target.hash || !(target.protocol === "https:" || (process.env.NODE_ENV !== "production" && target.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(target.hostname)))) throw new Error(); }
  catch { return error("Image service configuration is invalid.", 503); }
  let body: string | undefined;
  const outgoing: Record<string, string> = { Authorization: `Bearer ${token}`, "X-Chat-User-Id": principal.userId };
  if (request.method === "POST") {
    try {
      if (request.headers.get("Content-Type")?.split(";")[0].trim() !== "application/json") throw new Error();
      const text = new TextDecoder().decode(await boundedBytes(request.body, 12000));
      const input = JSON.parse(text); const key = request.headers.get("Idempotency-Key");
      if (!parseGeneratedImage({ version: 1, prompt: input.prompt, requestId: key, status: "submitting" })) throw new Error();
      body = JSON.stringify({ prompt: input.prompt.trim() }); outgoing["Idempotency-Key"] = key!; outgoing["Content-Type"] = "application/json";
    } catch { return error("Enter an image prompt of up to 2,000 characters.", 400); }
  }
  const path = jobId ? `/v1/image-jobs/${encodeURIComponent(jobId)}${download ? "/image" : ""}` : request.method === "GET" ? "/capabilities" : "/v1/image-jobs";
  try {
    const response = await fetch(base + path, { method: request.method, headers: outgoing, body, cache: "no-store", redirect: "error", signal: AbortSignal.any([request.signal, AbortSignal.timeout(download ? 30000 : 15000)]) });
    if (download && response.ok) {
      if (response.headers.get("content-type")?.split(";")[0] !== "image/png") { await response.body?.cancel(); return error("The image service returned an unreadable image.", 502); }
      const bytes = await boundedBytes(response.body, 4 * 1024 * 1024);
      if (!validPng(bytes)) return error("The image service returned an unreadable image.", 502);
      return new Response(bytes, { headers: { ...headers, "Content-Type": "image/png", "Content-Disposition": 'attachment; filename="kiddo-image.png"', "X-Content-Type-Options": "nosniff" } });
    }
    const raw = JSON.parse(new TextDecoder().decode(await boundedBytes(response.body, 65536)));
    if (!response.ok) {
      const retry = response.headers.get("Retry-After");
      return Response.json({ error: { message: safeErrors[raw?.error?.code] ?? (response.status === 410 ? "This image result has expired." : "The image service could not complete this request. Check the same job before starting another image.") } }, { status: [400,404,409,410,429,503].includes(response.status) ? response.status : 502, headers: { ...headers, ...(retry && /^\d{1,6}$/.test(retry) ? { "Retry-After": retry } : {}) } });
    }
    let data;
    if (!jobId && request.method === "GET") {
      if (raw.version !== 1 || raw.model !== "FLUX.2-dev" || typeof raw.enabled !== "boolean" || raw.limits?.width !== 1024 || raw.limits?.height !== 1024 || raw.limits?.maxPromptLength !== 2000) return error("The image service is incompatible.", 502);
      data = { version: 1, model: "FLUX.2-dev", enabled: raw.enabled, limits: { width: 1024, height: 1024, maxPromptLength: 2000 } };
    } else {
      const parsed = parseGeneratedImage({ version: 1, requestId: "validated", prompt: "validated", jobId: raw.jobId, status: raw.status, cancellationRequested: raw.cancellationRequested });
      if (!parsed?.jobId || (jobId && parsed.jobId !== jobId) || parsed.status === "submitting") return error("The image service returned an invalid job.", 502);
      data = { jobId: parsed.jobId, status: parsed.status, cancellationRequested: parsed.cancellationRequested === true };
    }
    const retry = response.headers.get("Retry-After");
    return Response.json(data, { status: response.status, headers: { ...headers, ...(retry && /^\d{1,6}$/.test(retry) ? { "Retry-After": retry } : {}) } });
  } catch { return error("Couldn't reach the image service. Check the same job before starting another image.", 503); }
}
