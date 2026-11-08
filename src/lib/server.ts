import { SETTINGS_MAX, parseServerLimits } from "./chat-settings";
import { DEFAULT_MODEL, modelInfo, parseModelId, type ModelId } from "./models";
import { parseImageInputLimits } from "./image-input";
export const MAX_BODY = SETTINGS_MAX.requestBytes;
export async function readJson(request: Request, limitForValue?: (value: unknown) => number) {
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
  let value: unknown;
  try { value = JSON.parse(new TextDecoder().decode(merged)); }
  catch { throw new Error("Invalid request. Please try again."); }
  if (limitForValue && bytes > limitForValue(value)) throw new Error("This request exceeds your configured byte limit.");
  return value;
}
export function connectionConfig(selected: ModelId = DEFAULT_MODEL) {
  const model = parseModelId(selected);
  const base = (model === "4bit" ? process.env.RUNPOD_CHAT_URL : process.env.RUNPOD_BF16_CHAT_URL)?.replace(/\/$/, "");
  const token = model === "4bit" ? process.env.RUNPOD_CHAT_TOKEN : process.env.RUNPOD_BF16_CHAT_TOKEN;
  if (base && token && token.length >= 32) {
    const url = new URL(base);
    if (url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new Error("Invalid gateway URL.");
    if (url.protocol !== "https:" && !(process.env.NODE_ENV !== "production" && url.protocol === "http:" && ["127.0.0.1", "localhost"].includes(url.hostname))) throw new Error("The gateway must use HTTPS.");
    return { mode: "live" as const, base, token, model };
  }
  return { mode: process.env.NODE_ENV !== "production" && process.env.CHAT_PREVIEW_MODE === "true" ? "preview" as const : "unconfigured" as const, base: "", token: "", model };
}
export function diagnosticsAllowed(env: Record<string, string | undefined> = process.env) {
  return env.CHAT_DIAGNOSTICS_ENABLED === "true";
}
export async function gatewayCapabilities(config: ReturnType<typeof connectionConfig>) {
  const response = await fetch(config.base + "/health", { headers: { Authorization: "Bearer " + config.token }, cache: "no-store", signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error("The model is unavailable or still loading.");
  const body = await response.json();
  if (body.ready !== true || body.model !== modelInfo(config.model).alias) throw new Error("The selected model could not be verified at its gateway.");
  if (body.settingsVersion !== 1) throw new Error("Update the chat gateway to use configurable settings.");
  return { limits: parseServerLimits(body.limits), diagnosticsVersion: body.diagnosticsVersion === 1 ? 1 : 0,
    docsModeVersion: body.docsModeVersion === 1 ? 1 : 0,
    adapterToggleAvailable: config.model === "bf16" && body.adapterToggleVersion === 1 && body.adapterToggleAvailable === true,
    imageInput: config.model === "bf16" && body.imageInputVersion === 1 ? parseImageInputLimits(body.imageInput) : undefined };
}
export async function gatewayLimits(config: ReturnType<typeof connectionConfig>) {
  return (await gatewayCapabilities(config)).limits;
}
export const jsonError = (error: string, status: number) => Response.json({ error }, { status, headers: { "Cache-Control": "no-store" } });
