/** Passive source metadata retained when loading, saving, and exporting older chats. */
export type SourceMetadata = { id: number; heading: string; url: string };

export function parseSourceMetadata(value: unknown): SourceMetadata[] | undefined {
  if (!Array.isArray(value) || value.length > 3) return undefined;
  const result: SourceMetadata[] = [];
  for (const [index, source] of value.entries()) {
    if (!source || source.id !== index + 1 || typeof source.heading !== "string" ||
      !source.heading.trim() || source.heading.length > 160 || typeof source.url !== "string") return undefined;
    try {
      const url = new URL(source.url);
      if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
    } catch { return undefined; }
    result.push({ id: source.id, heading: source.heading, url: source.url });
  }
  return result;
}
