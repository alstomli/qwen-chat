import { validateImageInput, type ImageInputLimits } from "./image-input";

export type ImageAttachment = { name: string; dataUrl: string };

function asDataUrl(blob: Blob) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("Couldn't read this image. Try choosing it again."));
    reader.readAsDataURL(blob);
  });
}

function encodeCanvas(canvas: HTMLCanvasElement, type: string, quality: number) {
  return new Promise<Blob | null>(resolve => canvas.toBlob(resolve, type, quality));
}

export async function prepareImage(file: File, limits: ImageInputLimits, requestMaxBytes: number): Promise<ImageAttachment> {
  const maxBytes = Math.min(limits.maxBytes, requestMaxBytes);
  if (!limits.mimeTypes.some(type => type === file.type) || !file.size) throw new Error("Choose a JPEG, PNG, or WebP image.");
  if (file.size > 25 * 1024 * 1024) throw new Error("Choose an image file under 25 MB.");
  if (maxBytes <= 0) throw new Error("The prompt leaves too little room for an image. Shorten it or raise the request byte limit.");

  let bitmap: ImageBitmap;
  try { bitmap = await createImageBitmap(file); }
  catch { throw new Error("Couldn't open this image. Try a different JPEG, PNG, or WebP file."); }
  try {
    const longest = Math.max(bitmap.width, bitmap.height);
    const name = file.name.trim().slice(0, 160) || "Image";
    if (longest <= limits.maxDimension && file.size <= maxBytes) {
      return { name, dataUrl: validateImageInput(await asDataUrl(file), limits) };
    }
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d");
    if (!context) throw new Error("This browser couldn't resize the image.");
    const type = limits.mimeTypes.includes("image/webp") ? "image/webp" : limits.mimeTypes[0];
    const initial = Math.min(longest, limits.maxDimension);
    const minimum = Math.min(initial, 640);
    let size = initial;
    while (true) {
      canvas.width = Math.max(1, Math.round(bitmap.width * size / longest));
      canvas.height = Math.max(1, Math.round(bitmap.height * size / longest));
      if (type === "image/jpeg") {
        context.fillStyle = "#fff";
        context.fillRect(0, 0, canvas.width, canvas.height);
      }
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      for (const quality of type === "image/png" ? [1] : [0.9, 0.8, 0.68]) {
        const blob = await encodeCanvas(canvas, type, quality);
        if (blob && limits.mimeTypes.some(mime => mime === blob.type) && blob.size <= maxBytes) {
          return { name, dataUrl: validateImageInput(await asDataUrl(blob), limits) };
        }
      }
      if (size === minimum) break;
      size = Math.max(minimum, Math.floor(size * 0.8));
    }
    throw new Error("Couldn't make this image small enough. Try a smaller image or raise the request byte limit.");
  } finally {
    bitmap.close();
  }
}
