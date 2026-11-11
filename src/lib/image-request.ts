import type { GeneratedImage } from "./generated-image";

/** Process-local backend idempotency cannot make an automatic re-POST safe after restart. */
export async function requestImageJob(image: GeneratedImage, explicitSubmission: boolean, signal: AbortSignal, fetcher: typeof fetch = fetch): Promise<Response | null> {
  if (image.jobId) return fetcher(`/api/images/${image.jobId}`, { cache: "no-store", signal });
  if (!explicitSubmission) return null;
  return fetcher("/api/images", { method: "POST", signal, cache: "no-store", headers: { "Content-Type": "application/json", "Idempotency-Key": image.requestId }, body: JSON.stringify({ prompt: image.prompt }) });
}
