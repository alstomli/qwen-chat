import { createHmac, timingSafeEqual } from "node:crypto";
import { authenticatedSession } from "./auth";

const RUNPOD_ENDPOINT = "https://api.runpod.ai/v2/black-forest-labs-flux-1-schnell";
const IMAGE_ORIGIN = "https://image.runpod.ai";
const IMAGE_SIZE = 1024;
const JOB_LIFETIME_MS = 30 * 60_000;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const MAX_JSON_BYTES = 16 * 1024;
const REQUEST_TIMEOUT_MS = 10_000;
const DOWNLOAD_TIMEOUT_MS = 15_000;
const PROVIDER_ID = /^[a-zA-Z0-9_-]{1,128}$/;
const JOB_HANDLE = /^[a-zA-Z0-9_-]{1,256}\.[a-zA-Z0-9_-]{43}$/;
const NO_STORE = { "Cache-Control": "no-store" };
const DISABLED = "Image generation hasn't been configured yet.";
const JOB_EXPIRED = "This image job expired. Generate a new image to try again.";
const PROVIDER_ERROR = "The image service is temporarily unavailable.";

export const MAX_IMAGE_PROMPT_LENGTH = 2000;

class ImageRouteError extends Error {
  constructor(message: string, readonly status: number, readonly retryAfter?: number) {
    super(message);
  }
}

type Session = NonNullable<ReturnType<typeof authenticatedSession>>;
type Job = { providerId: string; createdAt: number };
type ProviderJob =
  | { id: string; status: "queued" | "generating" }
  | { id: string; status: "completed"; url: URL }
  | { id: string; status: "failed"; error: string };

function configuredKey() {
  return process.env.RUNPOD_IMAGE_API_KEY?.trim() || undefined;
}

function requireSession(request: Request) {
  const session = authenticatedSession(request);
  if (!session) throw new ImageRouteError("Your session expired. Sign in to continue.", 401);
  return session;
}

function requireKey() {
  const key = configuredKey();
  if (!key) throw new ImageRouteError(DISABLED, 503);
  return key;
}

export function imageJson(body: unknown, status = 200) {
  return Response.json(body, { status, headers: NO_STORE });
}

export function imageRouteError(error: unknown) {
  if (!(error instanceof ImageRouteError)) return imageJson({ error: PROVIDER_ERROR }, 502);
  const headers = new Headers(NO_STORE);
  if (error.retryAfter !== undefined) headers.set("Retry-After", String(error.retryAfter));
  return Response.json({ error: error.message }, { status: error.status, headers });
}

export function imageAvailability(request: Request) {
  requireSession(request);
  const enabled = !!configuredKey();
  return {
    enabled,
    ...(enabled ? {} : { reason: DISABLED }),
    maxPromptLength: MAX_IMAGE_PROMPT_LENGTH,
  };
}

function signHandle(payload: string, session: Session) {
  return createHmac("sha256", process.env.SESSION_SECRET!)
    .update("qwen-image-job\0")
    .update(session.token)
    .update("\0")
    .update(payload)
    .digest();
}

function issueHandle(job: Job, session: Session) {
  const payload = Buffer.from(JSON.stringify(job)).toString("base64url");
  return payload + "." + signHandle(payload, session).toString("base64url");
}

function jobExpiresAt(job: Job, session: Session) {
  return Math.min(job.createdAt + JOB_LIFETIME_MS, session.expiresAt);
}

function readHandle(handle: string, session: Session): Job {
  const notFound = new ImageRouteError("Image job not found.", 404);
  if (!JOB_HANDLE.test(handle)) throw notFound;
  const [payload, signature] = handle.split(".");
  const expected = signHandle(payload, session);
  const actual = Buffer.from(signature, "base64url");
  if (!timingSafeEqual(expected, actual) || signature !== expected.toString("base64url")) throw notFound;
  const job = JSON.parse(Buffer.from(payload, "base64url").toString()) as Job;
  if (jobExpiresAt(job, session) <= Date.now()) throw new ImageRouteError(JOB_EXPIRED, 410);
  return job;
}

// Best-effort limit for this server instance. Runpod also applies its own limits.
let submissionWindow = { until: 0, count: 0 };

function checkSubmissionLimit(now: number) {
  if (now >= submissionWindow.until) submissionWindow = { until: now + 60_000, count: 0 };
  if (submissionWindow.count >= 10) {
    throw new ImageRouteError("Too many image requests. Try again in a moment.", 429, Math.ceil((submissionWindow.until - now) / 1000));
  }
  submissionWindow.count++;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readBytes(source: Request | Response, maxBytes: number) {
  if (!source.body) throw new Error("Missing body");
  if (Number(source.headers.get("content-length")) > maxBytes) {
    await source.body.cancel().catch(() => undefined);
    throw new Error("Body exceeds size limit");
  }
  const reader = source.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error("Body exceeds size limit");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function readJson(source: Request | Response): Promise<unknown> {
  const bytes = await readBytes(source, MAX_JSON_BYTES);
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}

async function readPrompt(request: Request) {
  if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") {
    throw new ImageRouteError("Expected a JSON image request.", 400);
  }
  let value: unknown;
  try { value = await readJson(request); }
  catch { throw new ImageRouteError("Invalid image request.", 400); }
  if (!isRecord(value) || typeof value.prompt !== "string") {
    throw new ImageRouteError("Enter an image prompt.", 400);
  }
  const prompt = value.prompt.trim();
  if (!prompt) throw new ImageRouteError("Enter an image prompt.", 400);
  if (prompt.length > MAX_IMAGE_PROMPT_LENGTH) {
    throw new ImageRouteError(`Use an image prompt of at most ${MAX_IMAGE_PROMPT_LENGTH} characters.`, 400);
  }
  return prompt;
}

function imageUrl(value: unknown) {
  if (typeof value !== "string" || value.length > 4096) return;
  try {
    const url = new URL(value);
    if (url.protocol === "https:" && url.origin === IMAGE_ORIGIN && !url.username && !url.password && !url.hash && url.pathname !== "/") return url;
  } catch { return; }
}

function parseProviderJob(value: unknown, providerId?: string): ProviderJob {
  if (!isRecord(value)) throw new ImageRouteError(PROVIDER_ERROR, 502);
  if (providerId && value.status === "NOT_FOUND") throw new ImageRouteError(JOB_EXPIRED, 410);
  const { id, status, output } = value;
  if (typeof id !== "string" || !PROVIDER_ID.test(id) || (providerId && providerId !== id)) {
    throw new ImageRouteError(PROVIDER_ERROR, 502);
  }
  switch (status) {
    case "IN_QUEUE":
      return { id, status: "queued" };
    case "IN_PROGRESS":
      return { id, status: "generating" };
    case "COMPLETED": {
      const url = imageUrl(isRecord(output) ? output.image_url : undefined);
      return url ? { id, status: "completed", url } : { id, status: "failed", error: "The image service returned an unavailable image." };
    }
    case "FAILED":
    case "CANCELLED":
    case "TIMED_OUT":
      return { id, status: "failed", error: "Image generation failed. You can try again." };
    default:
      throw new ImageRouteError(PROVIDER_ERROR, 502);
  }
}

async function callProvider(key: string, requestSignal: AbortSignal, operation: { prompt: string } | { providerId: string }) {
  const submitting = "prompt" in operation;
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(RUNPOD_ENDPOINT + (submitting ? "/run" : "/status/" + encodeURIComponent(operation.providerId)), {
      method: submitting ? "POST" : "GET",
      headers: {
        Authorization: "Bearer " + key,
        Accept: "application/json",
        ...(submitting ? { "Content-Type": "application/json" } : {}),
      },
      body: submitting ? JSON.stringify({ input: { prompt: operation.prompt, width: IMAGE_SIZE, height: IMAGE_SIZE } }) : undefined,
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.any([requestSignal, timeout]),
    });
  } catch {
    const message = submitting ? "Image submission could not be confirmed." : PROVIDER_ERROR;
    throw new ImageRouteError(message, timeout.aborted ? 504 : 502);
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    if (!submitting && response.status === 404) throw new ImageRouteError(JOB_EXPIRED, 410);
    if (response.status === 429) throw new ImageRouteError("The image service is busy. Try again in a moment.", 429, 5);
    throw new ImageRouteError(PROVIDER_ERROR, 502);
  }
  let value: unknown;
  try { value = await readJson(response); }
  catch {
    const message = submitting ? "Image submission could not be confirmed." : PROVIDER_ERROR;
    throw new ImageRouteError(message, timeout.aborted ? 504 : 502);
  }
  return parseProviderJob(value, submitting ? undefined : operation.providerId);
}

function describeJob(provider: ProviderJob, job: Job, jobId: string, session: Session) {
  const metadata = { jobId, status: provider.status, createdAt: new Date(job.createdAt).toISOString() };
  if (provider.status === "failed") return { ...metadata, error: provider.error };
  if (provider.status !== "completed") return metadata;
  return {
    ...metadata,
    image: {
      url: `/api/images/${jobId}/download`,
      width: IMAGE_SIZE,
      height: IMAGE_SIZE,
      expiresAt: new Date(jobExpiresAt(job, session)).toISOString(),
    },
  };
}

export async function createImageJob(request: Request) {
  const session = requireSession(request);
  const key = requireKey();
  const prompt = await readPrompt(request);
  const createdAt = Date.now();
  checkSubmissionLimit(createdAt);
  const provider = await callProvider(key, request.signal, { prompt });
  const job = { providerId: provider.id, createdAt };
  return describeJob(provider, job, issueHandle(job, session), session);
}

async function findImageJob(request: Request, jobId: string) {
  const session = requireSession(request);
  const key = requireKey();
  const job = readHandle(jobId, session);
  const provider = await callProvider(key, request.signal, { providerId: job.providerId });
  return { provider, job, session };
}

export async function inspectImageJob(request: Request, jobId: string) {
  const { provider, job, session } = await findImageJob(request, jobId);
  return describeJob(provider, job, jobId, session);
}

const IMAGE_TYPES = {
  "image/png": { extension: "png", magic: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  "image/jpeg": { extension: "jpg", magic: [0xff, 0xd8, 0xff] },
  "image/webp": { extension: "webp", magic: [0x52, 0x49, 0x46, 0x46] },
} as const;

export async function downloadImageJob(request: Request, jobId: string) {
  const { provider } = await findImageJob(request, jobId);
  if (provider.status === "failed") throw new ImageRouteError(provider.error, 422);
  if (provider.status !== "completed") throw new ImageRouteError("The image is still being generated.", 409);

  const timeout = AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS);
  try {
    const response = await fetch(provider.url, {
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.any([request.signal, timeout]),
    });
    if (response.status === 404 || response.status === 410) {
      await response.body?.cancel().catch(() => undefined);
      throw new ImageRouteError(JOB_EXPIRED, 410);
    }
    const mime = response.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
    if (response.status !== 200 || !mime || !Object.hasOwn(IMAGE_TYPES, mime)) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error("Unexpected image response");
    }
    const { extension, magic } = IMAGE_TYPES[mime as keyof typeof IMAGE_TYPES];
    const bytes = await readBytes(response, MAX_IMAGE_BYTES);
    if (!magic.every((byte, index) => bytes[index] === byte)) throw new Error("Unexpected image bytes");
    if (mime === "image/webp" && String.fromCharCode(...bytes.subarray(8, 12)) !== "WEBP") throw new Error("Unexpected WebP bytes");
    return new Response(bytes, { headers: {
      ...NO_STORE,
      "Content-Type": mime,
      "Content-Disposition": `attachment; filename="generated-image.${extension}"`,
      "Content-Length": String(bytes.byteLength),
      "X-Content-Type-Options": "nosniff",
      "Cross-Origin-Resource-Policy": "same-origin",
    } });
  } catch (error) {
    if (error instanceof ImageRouteError) throw error;
    throw new ImageRouteError("The generated image could not be downloaded.", timeout.aborted ? 504 : 502);
  }
}
