import { IMAGE_REQUEST_MAX_BYTES } from "./image-reference";
import type { GeneratedImage } from "./generated-image";

/** Process-local backend idempotency cannot make an automatic re-POST safe after restart. */
export async function requestImageJob(image: GeneratedImage, explicitSubmission: boolean, signal: AbortSignal, fetcher: typeof fetch = fetch, referenceImage?: string): Promise<Response | null> {
  if (image.jobId) return fetcher(`/api/images/${image.jobId}`, { cache: "no-store", signal });
  if (!explicitSubmission) return null;
  if (image.mode === "edit" && !referenceImage) throw new Error("The original reference is no longer in memory. Start a new edit from its saved image.");
  if (image.mode !== "edit" && referenceImage) throw new Error("A reference image requires an explicit edit request.");
  const body = JSON.stringify({ prompt: image.prompt, ...(referenceImage ? { referenceImage } : {}) });
  if (new TextEncoder().encode(body).byteLength > IMAGE_REQUEST_MAX_BYTES) throw new Error("The reference and instruction exceed the image request limit.");
  return fetcher("/api/images", { method: "POST", signal, cache: "no-store", headers: { "Content-Type": "application/json", "Idempotency-Key": image.requestId }, body });
}
