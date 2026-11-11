export const IMAGE_STATES = ["submitting", "queued", "generating", "completed", "failed", "cancelled", "expired"] as const;
export type ImageState = typeof IMAGE_STATES[number];
export type GeneratedImage = { version: 1 | 2; prompt: string; requestId: string; jobId?: string; status: ImageState; cancellationRequested?: boolean; mode?: "edit"; sourceImageId?: string };
export function parseGeneratedImage(value: unknown): GeneratedImage | undefined {
  if (!value || typeof value !== "object") return;
  const v = value as Record<string, unknown>;
  if ((v.version !== 1 && v.version !== 2) || typeof v.prompt !== "string" || !v.prompt.trim() || v.prompt.length > 2000
    || typeof v.requestId !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(v.requestId)
    || !IMAGE_STATES.includes(v.status as ImageState)
    || (v.jobId !== undefined && (typeof v.jobId !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(v.jobId)))) return;
  if ((v.version === 1 && v.mode !== undefined) || (v.version === 2 && v.mode !== "edit")) return;
  return { version: v.version, prompt: v.prompt, requestId: v.requestId, status: v.status as ImageState,
    ...(v.mode === "edit" ? { mode: "edit", ...(typeof v.sourceImageId === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(v.sourceImageId) ? { sourceImageId: v.sourceImageId } : {}) } : {}),
    ...(typeof v.jobId === "string" ? { jobId: v.jobId } : {}), ...(v.cancellationRequested === true ? { cancellationRequested: true } : {}) };
}
export function imagePending(image: GeneratedImage) { return ["submitting", "queued", "generating"].includes(image.status); }
export function mayStartImageRequest(images: GeneratedImage[], trackingRequest: boolean) {
  return !trackingRequest && !images.some(image => image.jobId && imagePending(image));
}

/** Rejected admission is terminal; temporary reads must keep the original job recoverable. */
export function imageFailureStatus(image: GeneratedImage, httpStatus: number): ImageState {
  if (httpStatus === 410) return "expired";
  if ([400,403,404].includes(httpStatus) || (!image.jobId && [409,429].includes(httpStatus))) return "failed";
  return image.status;
}
