import { requestAuthenticated, sameOrigin } from "@/lib/auth";
import { connectionConfig, gatewayCapabilities, diagnosticsAllowed, jsonError, readJson } from "@/lib/server";
import { DIAGNOSTICS_HEADER, parseDiagnosticHeader } from "@/lib/diagnostics";
import { validateInput } from "@/lib/protocol";
import { validateSettings, gatewaySettings } from "@/lib/chat-settings";
import { IMAGE_ACCEPTED_HEADER, IMAGE_ADAPTER_ERROR, IMAGE_UNSUPPORTED_ERROR, validateImageInput } from "@/lib/image-input";
import { DOCS_GATEWAY_ERROR, DOCS_INDEX_ERROR, DOCS_MODE_HEADER, DOCS_SOURCES_HEADER, DOCS_UNAVAILABLE_ERROR, sectionDocsUrl, type DocsSource } from "@/lib/docs-sources";
import { runpodDocsIndex, searchRunpodDocs } from "@/lib/runpod-docs.server";
export const runtime = "nodejs";
export const maxDuration = 300;
export const dynamic = "force-dynamic";
const streamHeaders = { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store, no-transform", "X-Accel-Buffering": "no" };

export async function POST(request: Request) {
  if (!requestAuthenticated(request)) return jsonError("Your session expired. Sign in to continue.", 401);
  if (!sameOrigin(request)) return jsonError("This request isn't allowed.", 403);
  const diagnosticRequested = request.headers.get(DIAGNOSTICS_HEADER) === "1";
  if (diagnosticRequested && !diagnosticsAllowed()) return jsonError("Request diagnostics are disabled.", 403);
  let input;
  try {
    input = validateInput(await readJson(request, value => validateSettings(
      value && typeof value === "object" ? (value as Record<string, unknown>).settings : undefined,
    ).requestBytes));
  }
  catch (error) { return jsonError(error instanceof Error ? error.message : "Invalid message.", 400); }
  try {
    const { model, docsMode, ...gatewayInput } = input;
    const config = connectionConfig(model);
    if (config.mode === "unconfigured") return jsonError("The model connection hasn't been configured yet.", 503);
    if (config.mode === "preview") {
      if (docsMode) return jsonError(DOCS_UNAVAILABLE_ERROR, 503);
      if (input.image) return jsonError(IMAGE_UNSUPPORTED_ERROR, 400);
      if (diagnosticRequested) return jsonError("Diagnostics require a live model connection.", 400);
      const encoder = new TextEncoder(); let timer: ReturnType<typeof setTimeout>; let index = 0;
      const words = previewReply(input.messages.at(-1)!.content).match(/\S+\s*/g) ?? [];
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const send = () => {
            if (request.signal.aborted) { controller.close(); return; }
            if (index < words.length) {
              controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: words[index++] } }] })}\n\n`));
              timer = setTimeout(send, 35);
            } else {
              controller.enqueue(encoder.encode('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'));
              controller.close();
            }
          }; send();
        }, cancel() { clearTimeout(timer); }
      });
      return new Response(stream, { headers: { ...streamHeaders, "X-Chat-Mode": "preview" } });
    }
    let docsPassages: { heading: string; passage: string }[] | undefined;
    let docsHeaders = {};
    if (docsMode) {
      const index = runpodDocsIndex();
      if (!index) return jsonError(DOCS_INDEX_ERROR, 503);
      const hits = searchRunpodDocs(index, input.messages.at(-1)!.content);
      docsPassages = hits.map(({ heading, passage }) => ({ heading, passage }));
      const sources: DocsSource[] = hits.map(({ heading, url }, index) => ({ id: index + 1, heading, url: sectionDocsUrl(url, heading) }));
      docsHeaders = { [DOCS_MODE_HEADER]: "1", [DOCS_SOURCES_HEADER]: encodeURIComponent(JSON.stringify(sources)) };
    }
    let settings;
    try {
      const capabilities = await gatewayCapabilities(config);
      if (docsMode && capabilities.docsModeVersion !== 1) return jsonError(DOCS_GATEWAY_ERROR, 503);
      if (input.image) {
        if (!capabilities.imageInput) return jsonError(IMAGE_UNSUPPORTED_ERROR, 400);
        if (capabilities.adapterToggleAvailable && input.useAdapter !== false) return jsonError(IMAGE_ADAPTER_ERROR, 400);
        validateImageInput(input.image, capabilities.imageInput);
      }
      if (input.useAdapter !== undefined && !capabilities.adapterToggleAvailable)
        return jsonError("Adapter selection is unavailable for this connection.", 503);
      if (diagnosticRequested && capabilities.diagnosticsVersion !== 1) return jsonError("Enable diagnostics on an updated gateway first.", 503);
      settings = gatewaySettings(input.settings, capabilities.limits);
    }
    catch (error) { return jsonError(error instanceof Error ? error.message : "Gateway settings unavailable.", 400); }
    if (docsPassages?.length === 0) {
      const content = "I couldn’t find a matching passage in the available Runpod Docs. Try a more specific Runpod question.";
      const chunk = JSON.stringify({ choices: [{ delta: { content } }] });
      return new Response(`data: ${chunk}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n`,
        { headers: { ...streamHeaders, ...docsHeaders } });
    }
    const payload = { ...gatewayInput, settings, stream: true, docsPassages };
    let body = JSON.stringify(payload);
    let docsTrimmed = 0;
    if (docsMode && Buffer.byteLength(body) > input.settings.requestBytes) {
      payload.messages = [...payload.messages];
      while (payload.messages.length > 1 && Buffer.byteLength(body) > input.settings.requestBytes) {
        payload.messages.splice(0, 2);
        docsTrimmed += 2;
        body = JSON.stringify(payload);
      }
      if (Buffer.byteLength(body) > input.settings.requestBytes)
        return jsonError("Your message and Runpod Docs excerpts exceed the request byte limit. Shorten the message or raise the limit.", 413);
    }
    const controller = new AbortController();
    let timedOut = false;
    const cancel = () => controller.abort();
    request.signal.addEventListener("abort", cancel, { once: true });
    const timer = setTimeout(() => { timedOut = true; cancel(); }, input.settings.timeoutSeconds * 1000);
    let upstream: Response;
    try {
      upstream = await fetch(config.base + "/v1/chat/completions", {
        method: "POST", headers: { Authorization: "Bearer " + config.token, "Content-Type": "application/json", ...(diagnosticRequested ? { [DIAGNOSTICS_HEADER]: "1" } : {}) },
        body, signal: controller.signal, cache: "no-store"
      });
    } catch (error) {
      clearTimeout(timer); request.signal.removeEventListener("abort", cancel);
      if (timedOut) return jsonError("Your request timed out while waiting for the model to start a reply. Please try again.", 504);
      throw error;
    }
    const imageVerified = !input.image || upstream.headers.get(IMAGE_ACCEPTED_HEADER) === "true";
    const adapterVerified = input.useAdapter === undefined || upstream.headers.get("X-Chat-Adapter-Enabled") === String(input.useAdapter);
    const docsVerified = !docsMode || upstream.headers.get(DOCS_MODE_HEADER) === "1";
    if (upstream.ok && (!imageVerified || !adapterVerified || !docsVerified)) {
      clearTimeout(timer); request.signal.removeEventListener("abort", cancel);
      await upstream.body?.cancel(); controller.abort();
      return jsonError(!imageVerified ? "The model did not confirm receipt of the attached image."
        : !adapterVerified ? "The selected adapter mode could not be verified." : "Runpod Docs mode could not be verified at the gateway.", 503);
    }
    const diagnostic = diagnosticRequested ? parseDiagnosticHeader(upstream.headers.get(DIAGNOSTICS_HEADER)) : null;
    const diagnosticHeaders: Record<string, string> = diagnostic ? { [DIAGNOSTICS_HEADER]: JSON.stringify(diagnostic) } : {};
    if (!upstream.ok || !upstream.body) {
      clearTimeout(timer); request.signal.removeEventListener("abort", cancel);
      let message = "Your model is unavailable or still loading. Try again shortly.";
      if (upstream.status === 429) message = "Your model is answering another request. Try again in a moment.";
      const rejection = upstream.headers.get("X-Chat-Rejection");
      if (upstream.status === 429 && rejection === "queue_full") message = "The model's waiting queue is full. Please try again shortly.";
      if (upstream.status === 429 && rejection === "rate_limit") message = "The chat request rate limit has been reached. Please wait a minute and try again.";
      if (upstream.status === 504 && rejection === "queue_timeout") message = "Your request timed out while waiting for the model. Please try again.";
      if (upstream.status === 413 || upstream.status === 400) message = "This message is too long for the model. Shorten it or start a new chat.";
      if (input.image && upstream.status === 413) message = "The image and prompt exceed the model's request limit. Try a smaller image or a shorter prompt.";
      if (input.image && rejection === "image_adapter") message = IMAGE_ADAPTER_ERROR;
      if (input.image && rejection === "image_unsupported") message = IMAGE_UNSUPPORTED_ERROR;
      if (input.image && rejection === "image_invalid") message = "The model rejected the attached image. Try a different JPEG, PNG, or WebP file.";
      if (input.image && rejection === "image_processing") message = "The model could not process the attached image. Try again.";
      await upstream.body?.cancel();
      const response = jsonError(message, [400, 413, 429].includes(upstream.status) || (upstream.status === 504 && rejection === "queue_timeout") ? upstream.status : 503);
      for (const [key, value] of Object.entries(diagnosticHeaders)) response.headers.set(key, value);
      return response;
    }
    const reader = upstream.body.getReader();
    const finish = () => { clearTimeout(timer); request.signal.removeEventListener("abort", cancel); };
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const { value, done } = await reader.read();
          if (done) { finish(); controller.close(); } else controller.enqueue(value);
        } catch (error) { finish(); controller.error(error); }
      }, async cancel() { cancel(); finish(); await reader.cancel().catch(() => {}); }
    });
    const upstreamTrimmed = upstream.headers.get("X-Context-Trimmed") ?? "0";
    return new Response(stream, { headers: { ...streamHeaders, ...diagnosticHeaders, ...docsHeaders,
      ...(input.useAdapter === undefined ? {} : { "X-Chat-Adapter-Enabled": String(input.useAdapter) }),
      ...(input.image ? { [IMAGE_ACCEPTED_HEADER]: "true" } : {}),
      "X-Context-Trimmed": docsTrimmed ? String(docsTrimmed + (Number(upstreamTrimmed) || 0)) : upstreamTrimmed } });
  } catch { return jsonError("Couldn't reach your model. It may be stopped or loading. Please try again.", 503); }
}
function previewReply(prompt: string) {
  if (/code|python|function/i.test(prompt)) return "Here's a small example to build on:\n\n```python\ndef greet(name: str) -> str:\n    return f\"Hello, {name}!\"\n\nprint(greet(\"world\"))\n```\n\nA good starting point is to make one small thing work, then add the next piece.\n\n*This is a sample reply in local preview mode. Your Runpod model is not being called.*";
  return "Let's make a little room for that idea.\n\nA useful way to begin is to separate it into three parts:\n\n1. **The goal** — what would a good result look like?\n2. **The next small step** — what can you try right now?\n3. **The feedback** — how will you know it's working?\n\nStart with a rough version. We can work through the details together, one step at a time.\n\n*This is a sample reply in local preview mode. Your Runpod model is not being called.*";
}
