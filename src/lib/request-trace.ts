/** Opt-in, per-request transport. Nothing in this module writes browser storage. */
export const MAX_TRACE_BYTES = 32 * 1024 * 1024;
export const MAX_SESSION_TRACE_BYTES = 96 * 1024 * 1024;
export type TraceEntry = { phase: string; kind: "request" | "response" | "tool" | "failure"; payload: Record<string, unknown> };
export type RequestTrace = { version: 1; requestId: string; records: TraceEntry[]; complete: boolean; reason: string; bytes: number; evicted?: boolean; partial?: string };
export type TraceUpdate = {partial: string; bytes: number} | { entry: TraceEntry; bytes: number } | { complete: boolean; reason: string };
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const bytes = (s: string) => new TextEncoder().encode(s).length;
function entry(value: unknown): TraceEntry {
  if (!object(value) || !["Chat", "Final answer", "Planning 1", "Planning 2", "Planning 3", "Planning 4"].includes(String(value.phase)) || !["request", "response", "tool", "failure"].includes(String(value.kind)) || !object(value.payload) || Object.keys(value).some(k => !["phase", "kind", "payload"].includes(k))) throw new Error("Invalid trace record.");
  // Reject hidden reasoning and transport secrets at both trust boundaries.
  function inspect(v: unknown, depth = 0) {
    if (depth > 32) throw new Error("Trace nesting limit exceeded.");
    if (Array.isArray(v)) { for (const x of v) inspect(x, depth + 1); }
    else if (object(v)) for (const [key, x] of Object.entries(v)) {
      if (/^(?:authorization|cache_salt|reasoning.*|api[_-]?key|access[_-]?token|password)$/i.test(key)) throw new Error("Unexpected private trace field.");
      inspect(x, depth + 1);
    }
  }
  inspect(value.payload);
  function keys(v: Record<string,unknown>, allowed: string[]) { if (Object.keys(v).some(k => !allowed.includes(k))) throw new Error("Unexpected trace field."); }
  function calls(v: unknown) {
    if (!Array.isArray(v)) throw new Error("Invalid tool calls.");
    for (const call of v) {
      if (!object(call)) throw new Error("Invalid tool call.");
      keys(call,["id","type","index","function"]);
      if (call.function !== undefined) {
        if (!object(call.function)) throw new Error("Invalid tool function.");
        keys(call.function,["name","arguments"]);
        for (const field of Object.values(call.function)) if (typeof field !== "string") throw new Error("Invalid tool function text.");
      }
    }
  }
  const allowed = value.kind === "request" ? ["sent", "effective"] : value.kind === "response" ? ["choices", "usage", "failure"] : value.kind === "tool" ? ["call", "result"] : ["reason", "status"];
  if (Object.keys(value.payload).some(k => !allowed.includes(k))) throw new Error("Unexpected trace payload.");
  if (value.kind === "request") {
    const sent = value.payload.sent;
    if (!object(sent) || Object.keys(sent).some(k => !["model", "messages", "tools", "tool_choice", "parallel_tool_calls", "stream", "stream_options", "max_tokens", "temperature", "chat_template_kwargs"].includes(k))) throw new Error("Unexpected model request field.");
    if (typeof sent.model !== "string" || !sent.model || !Array.isArray(sent.messages) || !sent.messages.length || sent.messages.length > 820 || typeof sent.max_tokens !== "number" || !Number.isSafeInteger(sent.max_tokens) || sent.max_tokens < 1 || typeof sent.temperature !== "number" || !Number.isFinite(sent.temperature) || typeof sent.stream !== "boolean") throw new Error("Invalid model request.");
    for (const message of sent.messages) {
      if (!object(message) || !["system","user","assistant","tool"].includes(String(message.role)) || !(typeof message.content === "string" || message.content === null || Array.isArray(message.content))) throw new Error("Invalid model message.");
      keys(message,["role","content","tool_calls","tool_call_id"]);
      if (message.tool_calls !== undefined) calls(message.tool_calls);
      if (Array.isArray(message.content)) for (const part of message.content) {
        if (!object(part) || !(part.type === "text" && typeof part.text === "string" || part.type === "image_url" && part.placeholder === "[binary image omitted]" && part.image_url === undefined)) throw new Error("Invalid image placeholder.");
      }
    }
    if (!object(value.payload.effective) || typeof value.payload.effective.useAdapter !== "boolean" || typeof value.payload.effective.reuseCachedPrefixes !== "boolean" || !object(value.payload.effective.settings)) throw new Error("Invalid effective settings.");
  }
  if (value.kind === "response" && value.payload.choices !== undefined && !Array.isArray(value.payload.choices)) throw new Error("Invalid model response.");
  if (value.kind === "response" && Array.isArray(value.payload.choices)) for (const choice of value.payload.choices) {
    if (!object(choice)) throw new Error("Invalid response choice.");
    keys(choice,["index","finish_reason","message","delta"]);
    for (const key of ["message","delta"]) if (choice[key] !== undefined) {
      const message=choice[key]; if (!object(message)) throw new Error("Invalid response message.");
      keys(message,["role","content","tool_calls"]);if (message.tool_calls !== undefined) calls(message.tool_calls);
      if (message.content !== undefined && message.content !== null && typeof message.content !== "string") throw new Error("Invalid response text.");
    }
  }
  if (value.payload.usage !== undefined) {if (!object(value.payload.usage)) throw new Error("Invalid trace usage.");keys(value.payload.usage,["prompt_tokens","completion_tokens","total_tokens"]);}
  if (value.kind === "tool" && (!object(value.payload.call) || !(object(value.payload.result) || Array.isArray(value.payload.result)))) throw new Error("Invalid tool result.");
  if (value.kind === "failure" && (typeof value.payload.reason !== "string" || value.payload.reason.length > 256)) throw new Error("Invalid trace failure.");
  return value as TraceEntry;
}
export function traceEventReader(requestId?: string) {
  let sequence = 0, record = 1, buffer = "", total = 0, ended = false;
  return { get pending() { return buffer; }, read(type: string, value: unknown): TraceUpdate | undefined {
    if (!requestId || !object(value) || value.version !== 1 || value.requestId !== requestId || value.sequence !== sequence + 1 || ended) throw new Error("The request trace could not be verified.");
    sequence++;
    if (type === "chat-trace-end") {
      if (buffer || value.records !== record - 1 || typeof value.complete !== "boolean" || typeof value.reason !== "string" || value.reason.length > 128 || Object.keys(value).some(k => !["version", "requestId", "sequence", "records", "complete", "reason"].includes(k))) throw new Error("Invalid trace completion.");
      ended = true; return { complete: value.complete, reason: value.reason };
    }
    if (type !== "chat-trace" || value.record !== record || typeof value.data !== "string" || bytes(value.data) > 4096 || typeof value.last !== "boolean" || Object.keys(value).some(k => !["version", "requestId", "sequence", "record", "data", "last"].includes(k))) throw new Error("Invalid trace chunk.");
    total += bytes(value.data); if (total > MAX_TRACE_BYTES) throw new Error("Request trace exceeded its byte limit.");
    buffer += value.data;
    if (!value.last) return;
    const size = bytes(buffer) + buffer.length * 2;
    const parsed = entry(JSON.parse(buffer)); buffer = ""; record++;
    return { entry: parsed, bytes: size };
  } };
}
export function parseFailureTrace(value: unknown, requestId?: string): RequestTrace {
  if (!requestId || !object(value) || value.version !== 1 || value.requestId !== requestId || value.complete !== false || typeof value.reason !== "string" || value.reason.length > 128 || !Array.isArray(value.records)) throw new Error("Invalid failure trace.");
  const raw = JSON.stringify(value.records);
  if (bytes(raw) > MAX_TRACE_BYTES) throw new Error("Request trace exceeded its byte limit.");
  return { version: 1, requestId, records: value.records.map(entry), complete: false, reason: value.reason, bytes: bytes(raw) + raw.length * 2 };
}
/** Drain complete frames before limiting the unfinished frame, including coalesced reads. */
export function validatedTraceStream(stream: ReadableStream<Uint8Array>, requestId?: string) {
  const reader = traceEventReader(requestId), decoder = new TextDecoder("utf-8", { fatal: true }), encoder = new TextEncoder(); let buffer = ""; let pendingFrames: string[] = []; let framedBytes = 0;
  return stream.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true }); let match;
      while ((match = /\r?\n\r?\n/.exec(buffer))) {
        const block = buffer.slice(0, match.index); buffer = buffer.slice(match.index + match[0].length);
        if (bytes(block) > 1048576) throw new Error("Stream event exceeded its limit.");
        const type = block.split(/\r?\n/).find(l => l.startsWith("event:"))?.slice(6).trim();
        if (type?.startsWith("chat-trace")) {
          if (bytes(block) > 32768) throw new Error("Trace event exceeded its limit.");
          const data = block.split(/\r?\n/).filter(l => l.startsWith("data:")).map(l => l.slice(5).trimStart()).join("\n");
          pendingFrames.push(block + "\n\n"); framedBytes += bytes(block) + 2;
          if (framedBytes > MAX_TRACE_BYTES * 3) throw new Error("Framed trace exceeded its limit.");
          const update = reader.read(type, JSON.parse(data));
          if (update) {
            for (const frame of pendingFrames) controller.enqueue(encoder.encode(frame));
            pendingFrames = []; framedBytes = 0;
          }
          continue;
        }
        controller.enqueue(encoder.encode(block + "\n\n"));
      }
      if (bytes(buffer) > 1048576) throw new Error("Stream event exceeded its limit.");
    },
    flush() { buffer += decoder.decode(); if (buffer.trim() || pendingFrames.length) throw new Error("Incomplete stream event."); },
  }));
}

export async function readFailureTrace(response: Response, requestId: string, signal?: AbortSignal) {
  const reader = response.body!.getReader(); const decoder = new TextDecoder("utf-8", {fatal:true}); let text = "", size = 0;
  try {
    while (true) {
      signal?.throwIfAborted(); const {value,done} = await reader.read(); if (done) break;
      size += value.byteLength; if (size > MAX_TRACE_BYTES + 4096) throw new Error("Failure trace exceeded its limit.");
      text += decoder.decode(value, {stream:true});
    }
    text += decoder.decode(); const value = JSON.parse(text);
    return value.trace ? parseFailureTrace(value.trace,requestId) : undefined;
  } finally { await reader.cancel().catch(() => {});reader.releaseLock(); }
}
