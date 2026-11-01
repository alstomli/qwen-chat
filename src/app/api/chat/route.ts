import { requestAuthenticated, sameOrigin } from "@/lib/auth";
import { connectionConfig, gatewayLimits, jsonError, readJson } from "@/lib/server";
import { validateInput } from "@/lib/protocol";
import { validateSettings } from "@/lib/chat-settings";
export const runtime = "nodejs";
export const maxDuration = 3000;
export const dynamic = "force-dynamic";
const streamHeaders = { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store, no-transform", "X-Accel-Buffering": "no" };

export async function POST(request: Request) {
  if (!requestAuthenticated(request)) return jsonError("Your session expired. Sign in to continue.", 401);
  if (!sameOrigin(request)) return jsonError("This request isn't allowed.", 403);
  let input;
  try {
    input = validateInput(await readJson(request, value => validateSettings(
      value && typeof value === "object" ? (value as Record<string, unknown>).settings : undefined,
    ).requestBytes));
  }
  catch (error) { return jsonError(error instanceof Error ? error.message : "Invalid message.", 400); }
  try {
    const config = connectionConfig();
    if (config.mode === "unconfigured") return jsonError("The model connection hasn't been configured yet.", 503);
    if (config.mode === "preview") {
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
    try { validateSettings(input.settings, await gatewayLimits(config)); }
    catch (error) { return jsonError(error instanceof Error ? error.message : "Gateway settings unavailable.", 400); }
    const controller = new AbortController();
    const cancel = () => controller.abort();
    request.signal.addEventListener("abort", cancel, { once: true });
    const timer = setTimeout(cancel, input.settings.timeoutSeconds * 1000);
    let upstream: Response;
    try {
      upstream = await fetch(config.base + "/v1/chat/completions", {
        method: "POST", headers: { Authorization: "Bearer " + config.token, "Content-Type": "application/json" },
        body: JSON.stringify({ ...input, stream: true }), signal: controller.signal, cache: "no-store"
      });
    } catch (error) {
      clearTimeout(timer); request.signal.removeEventListener("abort", cancel); throw error;
    }
    if (!upstream.ok || !upstream.body) {
      clearTimeout(timer); request.signal.removeEventListener("abort", cancel);
      let message = "Your model is unavailable or still loading. Try again shortly.";
      if (upstream.status === 429) message = "Your model is answering another request. Try again in a moment.";
      if (upstream.status === 413 || upstream.status === 400) message = "This message is too long for the model. Shorten it or start a new chat.";
      await upstream.body?.cancel();
      return jsonError(message, [400, 413, 429].includes(upstream.status) ? upstream.status : 503);
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
    return new Response(stream, { headers: { ...streamHeaders, "X-Context-Trimmed": upstream.headers.get("X-Context-Trimmed") ?? "0" } });
  } catch { return jsonError("Couldn't reach your model. It may be stopped or loading. Please try again.", 503); }
}
function previewReply(prompt: string) {
  if (/code|python|function/i.test(prompt)) return "Here's a small example to build on:\n\n```python\ndef greet(name: str) -> str:\n    return f\"Hello, {name}!\"\n\nprint(greet(\"world\"))\n```\n\nA good starting point is to make one small thing work, then add the next piece.\n\n*This is a sample reply in local preview mode. Your Runpod model is not being called.*";
  return "Let's make a little room for that idea.\n\nA useful way to begin is to separate it into three parts:\n\n1. **The goal** — what would a good result look like?\n2. **The next small step** — what can you try right now?\n3. **The feedback** — how will you know it's working?\n\nStart with a rough version. We can work through the details together, one step at a time.\n\n*This is a sample reply in local preview mode. Your Runpod model is not being called.*";
}
