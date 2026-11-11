export const REFERENCE_MAX_BYTES = 3 * 1024 * 1024;
export const IMAGE_REQUEST_MAX_BYTES = 4 * 1024 * 1024 + 16 * 1024;
export type ImageReference = { sourceImageId: string; dataUrl: string };
export function referenceEditingAvailable(value: unknown) {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return v.enabled === true && v.version === 1 && v.maxReferenceImages === 1 && v.width === 1024 && v.height === 1024
    && v.maxImageBytes === REFERENCE_MAX_BYTES && v.maxRequestBytes === IMAGE_REQUEST_MAX_BYTES
    && Array.isArray(v.mimeTypes) && v.mimeTypes.includes("image/png") && v.mimeTypes.includes("image/jpeg");
}

/** A normalized reference is held only in memory; the original is already in account-scoped IndexedDB. */
export async function prepareImageReference(blob: Blob, sourceImageId: string, signal: AbortSignal): Promise<ImageReference> {
  signal.throwIfAborted();
  if (blob.type !== "image/png" || blob.size > 4 * 1024 * 1024) throw new Error("This saved image can't be used as a reference.");
  const bitmap = await createImageBitmap(blob);
  let encoded: Blob | null = null;
  try {
    if (bitmap.width !== 1024 || bitmap.height !== 1024) throw new Error("The saved image has unexpected dimensions.");
    const canvas = document.createElement("canvas"); canvas.width = canvas.height = 1024;
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) throw new Error("This browser couldn't prepare the reference image.");
    context.fillStyle = "#ffffff"; context.fillRect(0, 0, 1024, 1024); context.drawImage(bitmap, 0, 0);
    for (const quality of [0.9, 0.8, 0.7, 0.6, 0.5]) {
      signal.throwIfAborted();
      encoded = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, "image/jpeg", quality));
      if (encoded?.type === "image/jpeg" && encoded.size <= 2 * 1024 * 1024) break;
    }
    if (!encoded || encoded.type !== "image/jpeg" || encoded.size > 2 * 1024 * 1024) throw new Error("The reference image is too large. Try a different saved image.");
  } finally { bitmap.close(); }
  signal.throwIfAborted();
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader(); const abort = () => reader.abort();
    signal.addEventListener("abort", abort, { once: true });
    const cleanup = () => signal.removeEventListener("abort", abort);
    reader.onload = () => { cleanup(); resolve(String(reader.result)); };
    reader.onerror = () => { cleanup(); reject(new Error("The reference image could not be read.")); };
    reader.onabort = () => { cleanup(); reject(new DOMException("Aborted", "AbortError")); };
    reader.readAsDataURL(encoded!);
  });
  signal.throwIfAborted();
  return { sourceImageId, dataUrl };
}
