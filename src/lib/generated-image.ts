export const IMAGE_STATES = ["submitting", "queued", "generating", "completed", "failed", "cancelled", "expired"] as const;
export type ImageState = typeof IMAGE_STATES[number];
export type GeneratedImage = { version: 1; prompt: string; requestId: string; jobId?: string; status: ImageState; cancellationRequested?: boolean };
export function parseGeneratedImage(value: unknown): GeneratedImage | undefined {
  if (!value || typeof value !== "object") return;
  const v = value as Record<string, unknown>;
  if (v.version !== 1 || typeof v.prompt !== "string" || !v.prompt.trim() || v.prompt.length > 2000
    || typeof v.requestId !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(v.requestId)
    || !IMAGE_STATES.includes(v.status as ImageState)
    || (v.jobId !== undefined && (typeof v.jobId !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(v.jobId)))) return;
  return { version: 1, prompt: v.prompt, requestId: v.requestId, status: v.status as ImageState,
    ...(typeof v.jobId === "string" ? { jobId: v.jobId } : {}), ...(v.cancellationRequested === true ? { cancellationRequested: true } : {}) };
}
export function imagePending(image: GeneratedImage) { return ["submitting", "queued", "generating"].includes(image.status); }
