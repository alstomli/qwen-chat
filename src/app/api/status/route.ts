import { requestAuthenticated } from "@/lib/auth";
import { connectionConfig, jsonError } from "@/lib/server";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  if (!requestAuthenticated(request)) return jsonError("Please sign in.", 401);
  try {
    const config = connectionConfig();
    if (config.mode !== "live") return Response.json({ mode: config.mode, ready: config.mode === "preview" }, { headers: { "Cache-Control": "no-store" } });
    const response = await fetch(config.base + "/health", { headers: { Authorization: "Bearer " + config.token }, cache: "no-store", signal: AbortSignal.timeout(5000) });
    return Response.json({ mode: "live", ready: response.ok }, { headers: { "Cache-Control": "no-store" } });
  } catch { return Response.json({ mode: "live", ready: false }, { headers: { "Cache-Control": "no-store" } }); }
}
