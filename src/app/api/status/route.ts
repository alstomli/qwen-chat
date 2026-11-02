import { requestAuthenticated } from "@/lib/auth";
import { connectionConfig, gatewayCapabilities, diagnosticsAllowed, jsonError } from "@/lib/server";
import { SETTINGS_MAX } from "@/lib/chat-settings";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  if (!requestAuthenticated(request)) return jsonError("Please sign in.", 401);
  try {
    const config = connectionConfig();
    if (config.mode !== "live") return Response.json({ mode: config.mode, ready: config.mode === "preview", limits: SETTINGS_MAX, diagnosticsAvailable: false, diagnosticsVersion: 0 }, { headers: { "Cache-Control": "no-store" } });
    const capabilities = await gatewayCapabilities(config);
    const diagnosticsAvailable = diagnosticsAllowed() && capabilities.diagnosticsVersion === 1;
    return Response.json({ mode: "live", ready: true, limits: capabilities.limits, diagnosticsAvailable, diagnosticsVersion: diagnosticsAvailable ? 1 : 0 }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return Response.json({ mode: "live", ready: false, error: error instanceof Error ? error.message : "Model unavailable." }, { headers: { "Cache-Control": "no-store" } }); }
}
