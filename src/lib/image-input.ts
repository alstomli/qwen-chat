const MIME_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
const MAX_BYTES = 256 * 1024;
const MAX_DIMENSION = 2048;
export const IMAGE_ACCEPTED_HEADER = "X-Chat-Image-Accepted";
export const IMAGE_ADAPTER_ERROR = "Turn off the trained adapter to attach an image.";
export const IMAGE_UNSUPPORTED_ERROR = "This model connection does not accept images.";

export type ImageInputLimits = {
  maxBytes: number;
  maxDimension: number;
  mimeTypes: (typeof MIME_TYPES[number])[];
};

export function parseImageInputLimits(value: unknown): ImageInputLimits | undefined {
  if (!value || typeof value !== "object") return;
  const { maxBytes, maxDimension, mimeTypes } = value as Partial<ImageInputLimits>;
  if (typeof maxBytes !== "number" || !Number.isInteger(maxBytes) || maxBytes <= 0 ||
      typeof maxDimension !== "number" || !Number.isInteger(maxDimension) || maxDimension <= 0 ||
      !Array.isArray(mimeTypes)) return;
  const supported = MIME_TYPES.filter(type => mimeTypes.includes(type));
  if (supported.length) return { maxBytes: Math.min(maxBytes, MAX_BYTES), maxDimension: Math.min(maxDimension, MAX_DIMENSION), mimeTypes: supported };
}

export function validateImageInput(value: unknown, limits?: ImageInputLimits): string {
  const maxBytes = limits?.maxBytes ?? MAX_BYTES;
  if (typeof value !== "string") throw new Error("Attach one JPEG, PNG, or WebP image.");
  if (value.length > Math.ceil(maxBytes / 3) * 4 + 24) throw new Error("The attached image exceeds the image byte limit.");
  const match = /^data:(image\/(?:jpeg|png|webp));base64,([a-zA-Z0-9+/]+={0,2})$/.exec(value);
  if (!match || match[0] !== value || match[2].length % 4 !== 0) throw new Error("Attach one JPEG, PNG, or WebP image.");
  const [, type, encoded] = match;
  if (limits && !limits.mimeTypes.some(mime => mime === type)) throw new Error("This model does not support the attached image format.");
  const padding = encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0;
  if (encoded.length / 4 * 3 - padding > maxBytes) throw new Error("The attached image exceeds the image byte limit.");
  const tail = encoded.slice(-4);
  const prefix = atob(encoded.slice(0, 16));
  const matchesType = type === "image/jpeg" ? prefix.startsWith("\xff\xd8\xff")
    : type === "image/png" ? prefix.startsWith("\x89PNG\r\n\x1a\n")
    : prefix.startsWith("RIFF") && prefix.slice(8, 12) === "WEBP";
  if (!matchesType || btoa(atob(tail)) !== tail) throw new Error("The attached image is invalid.");
  return value;
}
