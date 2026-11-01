export const MAX_BODY = 64_000;
export async function readJson(request: Request) {
  if (!request.headers.get("content-type")?.includes("application/json")) throw new Error("Expected a JSON request.");
  if (Number(request.headers.get("content-length")) > MAX_BODY) throw new Error("This conversation is too large. Start a new chat.");
  const reader = request.body?.getReader();
  if (!reader) throw new Error("Please send a message.");
  let bytes = 0; const parts: Uint8Array[] = [];
  try {
    while (true) {
      const { value, done } = await reader.read(); if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_BODY) { await reader.cancel(); throw new Error("This conversation is too large. Start a new chat."); }
      parts.push(value);
    }
  } finally { reader.releaseLock(); }
  const merged = new Uint8Array(bytes); let offset = 0;
  for (const part of parts) { merged.set(part, offset); offset += part.byteLength; }
  try { return JSON.parse(new TextDecoder().decode(merged)); }
  catch { throw new Error("Invalid request. Please try again."); }
}
export function connectionConfig() {
  const base = process.env.RUNPOD_CHAT_URL?.replace(/\/$/, "");
  const token = process.env.RUNPOD_CHAT_TOKEN;
  if (base && token && token.length >= 32) {
    const url = new URL(base);
    if (url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new Error("Invalid gateway URL.");
    if (url.protocol !== "https:" && !(process.env.NODE_ENV !== "production" && url.protocol === "http:" && ["127.0.0.1", "localhost"].includes(url.hostname))) throw new Error("The gateway must use HTTPS.");
    return { mode: "live" as const, base, token };
  }
  return { mode: process.env.NODE_ENV !== "production" && process.env.CHAT_PREVIEW_MODE === "true" ? "preview" as const : "unconfigured" as const, base: "", token: "" };
}
export const jsonError = (error: string, status: number) => Response.json({ error }, { status, headers: { "Cache-Control": "no-store" } });
