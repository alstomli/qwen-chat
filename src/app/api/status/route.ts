import { requestPrincipal } from "@/lib/auth";
import { connectionConfig, gatewayCapabilities, GatewayCompatibilityError, diagnosticsAllowed, jsonError } from "@/lib/server";
import { SETTINGS_MAX } from "@/lib/chat-settings";
import { parseModelId } from "@/lib/models";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  const principal = await requestPrincipal(request);
  if (!principal) return jsonError("Please sign in.", 401);
  let model;
  try { model = parseModelId(new URL(request.url).searchParams.get("model") ?? undefined); }
  catch { return jsonError("Choose a supported model.", 400); }
  try {
    const config = connectionConfig(model);
    if (config.mode !== "live") return Response.json({ model, mode: config.mode, ready: config.mode === "preview", limits: SETTINGS_MAX, diagnosticsAvailable: false, diagnosticsVersion: 0 }, { headers: { "Cache-Control": "no-store" } });
    const capabilities = await gatewayCapabilities(config);
    const diagnosticsAvailable = principal.canUseAdvancedSettings && diagnosticsAllowed() && capabilities.diagnosticsVersion === 1;
    return Response.json({ model, mode: "live", ready: true, limits: capabilities.limits, diagnosticsAvailable,
      adapterToggleAvailable: capabilities.adapterToggleAvailable,
      ...(capabilities.imageInput ? { imageInputVersion: 1, imageInput: capabilities.imageInput } : {}),
      diagnosticsVersion: diagnosticsAvailable ? 1 : 0 }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return Response.json({ model, mode: "live", ready: false, error: error instanceof Error ? error.message : "Model unavailable." }, { status: error instanceof GatewayCompatibilityError ? 503 : 200, headers: { "Cache-Control": "no-store" } }); }
}
