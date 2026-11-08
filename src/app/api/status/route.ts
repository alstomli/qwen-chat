import { requestAuthenticated } from "@/lib/auth";
import { connectionConfig, gatewayCapabilities, diagnosticsAllowed, jsonError } from "@/lib/server";
import { SETTINGS_MAX } from "@/lib/chat-settings";
import { parseModelId } from "@/lib/models";
import { runpodDocsIndex } from "@/lib/runpod-docs.server";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  if (!requestAuthenticated(request)) return jsonError("Please sign in.", 401);
  let model;
  try { model = parseModelId(new URL(request.url).searchParams.get("model") ?? undefined); }
  catch { return jsonError("Choose a supported model.", 400); }
  try {
    const config = connectionConfig(model);
    if (config.mode !== "live") return Response.json({ model, mode: config.mode, ready: config.mode === "preview", limits: SETTINGS_MAX, diagnosticsAvailable: false, diagnosticsVersion: 0 }, { headers: { "Cache-Control": "no-store" } });
    const capabilities = await gatewayCapabilities(config);
    const diagnosticsAvailable = diagnosticsAllowed() && capabilities.diagnosticsVersion === 1;
    const docsStatus = capabilities.docsModeVersion !== 1 ? { docsModeUnavailable: "gateway" }
      : runpodDocsIndex() ? { docsModeAvailable: true } : { docsModeUnavailable: "index" };
    return Response.json({ model, mode: "live", ready: true, limits: capabilities.limits, diagnosticsAvailable,
      adapterToggleAvailable: capabilities.adapterToggleAvailable,
      ...docsStatus,
      ...(capabilities.imageInput ? { imageInputVersion: 1, imageInput: capabilities.imageInput } : {}),
      diagnosticsVersion: diagnosticsAvailable ? 1 : 0 }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return Response.json({ model, mode: "live", ready: false, error: error instanceof Error ? error.message : "Model unavailable." }, { headers: { "Cache-Control": "no-store" } }); }
}
