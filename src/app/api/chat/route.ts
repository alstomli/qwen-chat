import { RequestDeadline } from "@/lib/request-deadline";
import { requestPrincipal, sameOrigin } from "@/lib/auth";
import { connectionConfig, gatewayCapabilities, GatewayCompatibilityError, diagnosticsAllowed, jsonError, readJson } from "@/lib/server";
import { DIAGNOSTICS_HEADER, parseDiagnosticHeader } from "@/lib/diagnostics";
import { validateInput } from "@/lib/protocol";
import { validateSettings, gatewaySettings } from "@/lib/chat-settings";
import { inputForAccess } from "@/lib/settings-access";
import { IMAGE_ACCEPTED_HEADER, IMAGE_ADAPTER_ERROR, IMAGE_UNSUPPORTED_ERROR, validateImageInput } from "@/lib/image-input";
import { WEB_SEARCH_HEADER, WEB_SEARCH_TIMEOUT_MS, WEB_SEARCH_UNAVAILABLE, validatedWebStream, webSearchForProfile } from "@/lib/web-search";
export const runtime = "nodejs";
export const maxDuration = 300;
export const dynamic = "force-dynamic";
const streamHeaders = { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store, no-transform", "X-Accel-Buffering": "no" };

export async function POST(request: Request) {
  const deadline = new RequestDeadline(request.signal, process.env.VERCEL === "1");
  try {
    const response = await handle(request, deadline);
    if (!response.headers.get("Content-Type")?.startsWith("text/event-stream")) deadline.finish();
    return response;
  } catch {
    deadline.finish();
    if (deadline.timedOut) return jsonError("Your request timed out while waiting for the model to start a reply. Please try again.", 504);
    if (deadline.signal.aborted) return jsonError("You stopped this request.", 499);
    return jsonError("Couldn't reach your model. It may be stopped or loading. Please try again.", 503);
  }
}
async function handle(request: Request, deadline: RequestDeadline) {
  const principal = await deadline.run(requestPrincipal(request, deadline.signal));
  if (!principal) return jsonError("Your session expired. Sign in to continue.", 401);
  if (!sameOrigin(request)) return jsonError("This request isn't allowed.", 403);
  const diagnosticRequested = request.headers.get(DIAGNOSTICS_HEADER) === "1";
  if (diagnosticRequested && (!principal.canUseAdvancedSettings || !diagnosticsAllowed())) return jsonError("Request diagnostics are disabled.", 403);
  let input;
  try {
    const value = await deadline.run(readJson(request, value => {
      const effective = inputForAccess(value, principal.canUseAdvancedSettings);
      return validateSettings(effective && typeof effective === "object"
        ? (effective as Record<string, unknown>).settings : undefined).requestBytes;
    }, deadline.signal));
    input = validateInput(inputForAccess(value, principal.canUseAdvancedSettings));
  }
  catch (error) { if (deadline.signal.aborted) throw error; return jsonError(error instanceof Error ? error.message : "Invalid message.", 400); }
  if (deadline.signal.aborted) throw deadline.signal.reason;
  deadline.limit(Math.min(input.settings.timeoutSeconds * 1000, input.webSearch ? WEB_SEARCH_TIMEOUT_MS : Infinity));
  try {
    const { model } = input;
    const config = connectionConfig(model);
    if (config.mode === "unconfigured") return jsonError("The model connection hasn't been configured yet.", 503);
    if (config.mode === "preview") {
      if (input.webSearch) return jsonError(WEB_SEARCH_UNAVAILABLE, 503);
      if (input.image) return jsonError(IMAGE_UNSUPPORTED_ERROR, 400);
      if (diagnosticRequested) return jsonError("Diagnostics require a live model connection.", 400);
      const encoder = new TextEncoder(); let timer: ReturnType<typeof setTimeout>; let index = 0;
      const words = previewReply(input.messages.at(-1)!.content).match(/\S+\s*/g) ?? [];
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const send = () => {
            if (deadline.signal.aborted) { deadline.finish(); controller.close(); return; }
            if (index < words.length) {
              controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: words[index++] } }] })}\n\n`));
              timer = setTimeout(send, 35);
            } else {
              controller.enqueue(encoder.encode('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'));
              deadline.finish(); controller.close();
            }
          }; send();
        }, cancel() { clearTimeout(timer); deadline.abort(); deadline.finish(); }
      });
      return new Response(stream, { headers: { ...streamHeaders, "X-Chat-Mode": "preview" } });
    }
    let settings;
    try {
      const capabilities = await deadline.run(gatewayCapabilities(config, deadline.signal));
      if (deadline.signal.aborted) throw deadline.signal.reason;
      // Defaults must be fitted to this gateway before checking or forwarding a normal request.
      input = validateInput(inputForAccess(input, principal.canUseAdvancedSettings, capabilities.limits));
      if (input.webSearch && !webSearchForProfile(capabilities, model, input.useAdapter)) return jsonError(WEB_SEARCH_UNAVAILABLE, 503);
      if (input.image) {
        if (!capabilities.imageInput) return jsonError(IMAGE_UNSUPPORTED_ERROR, 400);
        if (capabilities.adapterToggleAvailable && input.useAdapter !== false) return jsonError(IMAGE_ADAPTER_ERROR, 400);
        validateImageInput(input.image, capabilities.imageInput);
      }
      if (input.useAdapter !== undefined && !capabilities.adapterToggleAvailable)
        return jsonError("Adapter selection is unavailable for this connection.", 503);
      if (diagnosticRequested && capabilities.diagnosticsVersion !== 1) return jsonError("Enable diagnostics on an updated gateway first.", 503);
      settings = gatewaySettings({ ...input.settings, timeoutSeconds: Math.min(input.settings.timeoutSeconds, capabilities.limits.timeoutSeconds) }, capabilities.limits);
      deadline.limit(Math.min(settings.timeoutSeconds * 1000, input.webSearch ? WEB_SEARCH_TIMEOUT_MS : Infinity));
    }
    catch (error) { if (deadline.signal.aborted) throw error; return jsonError(error instanceof Error ? error.message : "Gateway settings unavailable.", error instanceof GatewayCompatibilityError ? 503 : 400); }
    const { model: _model, ...gatewayInput } = input;
    settings = { ...settings, timeoutSeconds: Math.min(settings.timeoutSeconds, deadline.remainingSeconds()) };
    const body = JSON.stringify({ ...gatewayInput, settings, stream: true });
    const controller = deadline.controller;
    const cancel = () => deadline.abort();
    let upstream: Response;
    try {
      upstream = await deadline.run(fetch(config.base + "/v1/chat/completions", {
        method: "POST", headers: { Authorization: "Bearer " + config.token, "X-Chat-User-Id": principal.userId, "Content-Type": "application/json", ...(diagnosticRequested ? { [DIAGNOSTICS_HEADER]: "1" } : {}) },
        body, signal: controller.signal, cache: "no-store"
      }));
    } catch (error) {
      deadline.finish();
      if (deadline.timedOut) return jsonError("Your request timed out while waiting for the model to start a reply. Please try again.", 504);
      throw error;
    }
    const imageVerified = !input.image || upstream.headers.get(IMAGE_ACCEPTED_HEADER) === "true";
    const adapterVerified = input.useAdapter === undefined || upstream.headers.get("X-Chat-Adapter-Enabled") === String(input.useAdapter);
    const searchVerified = !input.webSearch || upstream.headers.get(WEB_SEARCH_HEADER) === "1";
    if (upstream.ok && (!imageVerified || !adapterVerified || !searchVerified)) {
      deadline.finish();
      controller.abort(); void upstream.body?.cancel().catch(() => {});
      return jsonError(!searchVerified ? "The model did not confirm web search. No web-backed answer was produced."
        : !imageVerified ? "The model did not confirm receipt of the attached image."
        : "The selected adapter mode could not be verified.", 503);
    }
    const diagnostic = diagnosticRequested ? parseDiagnosticHeader(upstream.headers.get(DIAGNOSTICS_HEADER)) : null;
    const diagnosticHeaders: Record<string, string> = diagnostic ? { [DIAGNOSTICS_HEADER]: JSON.stringify(diagnostic) } : {};
    if (!upstream.ok || !upstream.body) {
      deadline.finish();
      let message = "Your model is unavailable or still loading. Try again shortly.";
      if (upstream.status === 429) message = "Your model is answering another request. Try again in a moment.";
      const upstreamRejection = upstream.headers.get("X-Chat-Rejection");
      const allowedRejections = ["queue_full", "rate_limit", "user_capacity", "user_rate_limit", "queue_timeout", "user_identity", "image_adapter", "image_unsupported", "image_invalid", "image_processing", "web_unavailable", "web_incompatible", "web_failed"];
      const rejection = allowedRejections.includes(upstreamRejection ?? "") ? upstreamRejection : null;
      const retryValue = upstream.headers.get("Retry-After");
      const retryAfter = upstream.status === 429 && (rejection === "user_rate_limit" || rejection === "rate_limit")
        && retryValue !== null && /^(?:[1-9]|[1-5][0-9]|60)$/.test(retryValue) ? Number(retryValue) : null;
      if (upstream.status === 429 && rejection === "user_capacity")
        message = "Your account already has requests in progress for this model. Wait for one to finish, then try again.";
      if (upstream.status === 429 && rejection === "user_rate_limit")
        message = retryAfter === null ? "Your account has sent too many requests to this model. Wait a minute, then try again."
          : "Your account has sent too many requests to this model. Try again in " + retryAfter + (retryAfter === 1 ? " second." : " seconds.");
      if (upstream.status === 429 && rejection === "queue_full") message = "The model's waiting queue is full. Please try again shortly.";
      if (upstream.status === 429 && rejection === "rate_limit") message = "The chat request rate limit has been reached. Please wait a minute and try again.";
      if (upstream.status === 504 && rejection === "queue_timeout") message = "Your request timed out while waiting for the model. Please try again.";
      if (upstream.status === 413 || upstream.status === 400) message = "This message is too long for the model. Shorten it or start a new chat.";
      if (input.image && upstream.status === 413) message = "The image and prompt exceed the model's request limit. Try a smaller image or a shorter prompt.";
      if (input.image && rejection === "image_adapter") message = IMAGE_ADAPTER_ERROR;
      if (input.image && rejection === "image_unsupported") message = IMAGE_UNSUPPORTED_ERROR;
      if (input.image && rejection === "image_invalid") message = "The model rejected the attached image. Try a different JPEG, PNG, or WebP file.";
      if (input.image && rejection === "image_processing") message = "The model could not process the attached image. Try again.";
      if (upstream.status === 400 && rejection === "user_identity")
        message = "The model account limits could not be verified. Please try again shortly.";
      if (input.webSearch && rejection?.startsWith("web_")) message = rejection === "web_incompatible"
        ? "Use web search and image attachments in separate messages." : "Web search could not finish. No web-backed answer was produced. Please retry.";
      controller.abort(); void upstream.body?.cancel().catch(() => {});
      const response = jsonError(message, upstream.status === 400 && rejection === "user_identity" ? 503 : [400, 413, 429].includes(upstream.status) || (upstream.status === 504 && rejection === "queue_timeout") ? upstream.status : 503);
      if (upstream.status === 429 && rejection !== null && ["queue_full", "rate_limit", "user_capacity", "user_rate_limit"].includes(rejection))
        response.headers.set("X-Chat-Rejection", rejection);
      if (retryAfter !== null) response.headers.set("Retry-After", String(retryAfter));
      for (const [key, value] of Object.entries(diagnosticHeaders)) response.headers.set(key, value);
      return response;
    }
    const reader = (input.webSearch ? validatedWebStream(upstream.body) : upstream.body).getReader();
    const finish = () => { deadline.finish(); };
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const { value, done } = await deadline.run(reader.read());
          if (done) { finish(); controller.close(); } else controller.enqueue(value);
        } catch (error) { cancel(); finish(); void reader.cancel(error).catch(() => {}); controller.error(error); }
      }, cancel() { cancel(); finish(); void reader.cancel().catch(() => {}); }
    });
    const upstreamTrimmed = upstream.headers.get("X-Context-Trimmed") ?? "0";
    return new Response(stream, { headers: { ...streamHeaders, ...diagnosticHeaders,
      ...(input.useAdapter === undefined ? {} : { "X-Chat-Adapter-Enabled": String(input.useAdapter) }),
      ...(input.image ? { [IMAGE_ACCEPTED_HEADER]: "true" } : {}),
      ...(input.webSearch ? { [WEB_SEARCH_HEADER]: "1" } : {}),
      "X-Context-Trimmed": upstreamTrimmed } });
  } catch (error) { if (deadline.signal.aborted) throw error; return jsonError("Couldn't reach your model. It may be stopped or loading. Please try again.", 503); }
}
function previewReply(prompt: string) {
  if (/code|python|function/i.test(prompt)) return "Here's a small example to build on:\n\n```python\ndef greet(name: str) -> str:\n    return f\"Hello, {name}!\"\n\nprint(greet(\"world\"))\n```\n\nA good starting point is to make one small thing work, then add the next piece.\n\n*This is a sample reply in local preview mode. Your Runpod model is not being called.*";
  return "Let's make a little room for that idea.\n\nA useful way to begin is to separate it into three parts:\n\n1. **The goal** — what would a good result look like?\n2. **The next small step** — what can you try right now?\n3. **The feedback** — how will you know it's working?\n\nStart with a rough version. We can work through the details together, one step at a time.\n\n*This is a sample reply in local preview mode. Your Runpod model is not being called.*";
}
