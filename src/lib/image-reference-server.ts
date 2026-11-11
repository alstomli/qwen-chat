import sharp from "sharp";
import { REFERENCE_MAX_BYTES } from "./image-reference";

export async function validateReferenceImage(value: unknown): Promise<string> {
  if (typeof value !== "string" || value.length > REFERENCE_MAX_BYTES * 4 / 3 + 32) throw new Error("Invalid reference image.");
  const match = /^data:image\/(png|jpeg);base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!match || match[2].length % 4 !== 0) throw new Error("Use a PNG or JPEG reference image.");
  const bytes = Buffer.from(match[2], "base64");
  if (!bytes.length || bytes.length > REFERENCE_MAX_BYTES || bytes.toString("base64") !== match[2]) throw new Error("Invalid reference image encoding.");
  if (match[1] === "png") {
    // libvips may read only the first APNG frame; reject its animation control
    // chunk before decoding so a valid first frame cannot hide extra frames.
    for (let offset = 8; offset + 12 <= bytes.length;) {
      const length = bytes.readUInt32BE(offset);
      if (length > bytes.length - offset - 12) throw new Error("Invalid PNG reference.");
      const type = bytes.toString("ascii", offset + 4, offset + 8);
      if (type === "acTL") throw new Error("Use a single-frame reference image.");
      offset += length + 12;
      if (type === "IEND") break;
    }
  }
  const image = sharp(bytes, { failOn: "warning", limitInputPixels: 1024 * 1024 });
  const metadata = await image.metadata();
  if (metadata.format !== (match[1] === "jpeg" ? "jpeg" : "png") || metadata.width !== 1024 || metadata.height !== 1024 || (metadata.pages ?? 1) !== 1) throw new Error("Use one 1024 × 1024 PNG or JPEG reference.");
  // Metadata alone does not prove that the encoded image can be decoded.
  await image.removeAlpha().toColourspace("srgb").raw().toBuffer();
  return value;
}
