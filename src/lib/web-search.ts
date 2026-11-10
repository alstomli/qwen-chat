/** Public web-search protocol. Provider credentials and page bodies never enter this module. */
export const WEB_SEARCH_HEADER = "X-Chat-Web-Search";
export const WEB_SEARCH_TIMEOUT_MS = 240_000;
export const WEB_SEARCH_UNAVAILABLE = "Web search is unavailable for this model. Refresh the connection or turn off Search web.";
export type WebSearchRequest = { version: 1; mode: "off" | "auto" | "required" };
export type WebSource = { runId: string; sourceId: string; title: string; url: string; retrievedAt: string; evidenceKind: "search" | "page" };
export type WebSearchMetadata = { version: 1; runId: string; outcome: "completed" | "failed" | "stopped" | "interrupted"; sources: WebSource[] };
export type WebStatus = "planning" | "searching" | "reading" | "answering";
export type WebSearchProfile = { useAdapter: boolean; available: boolean };
export function parseWebSearchProfiles(value: unknown): WebSearchProfile[] | undefined {
  if (!Array.isArray(value) || value.length < 1 || value.length > 2) return undefined;
  const result: WebSearchProfile[] = [];
  for (const p of value) {
    if (!p || typeof p.useAdapter !== "boolean" || typeof p.available !== "boolean" || result.some(x => x.useAdapter === p.useAdapter)) return undefined;
    result.push({ useAdapter: p.useAdapter, available: p.available });
  }
  return result;
}
export function webSearchForProfile(capability: { webSearchProfiles?: WebSearchProfile[]; webSearchAvailable?: boolean }, model: string, useAdapter?: boolean) {
  if (capability.webSearchProfiles) return capability.webSearchProfiles.find(p => p.useAdapter === (useAdapter ?? false))?.available === true;
  // Older version-one single-profile gateways can only establish the ordinary 4-bit alias.
  return model === "4bit" && capability.webSearchAvailable === true;
}
export type WebEvent = { version: 1; runId: string; sequence: number } & (
  { type: "web-status"; status: WebStatus } | { type: "web-sources"; sources: WebSource[] } |
  { type: "web-complete"; outcome: "completed" | "failed" });
const runPattern = /^[a-zA-Z0-9_-]{1,80}$/;
const sourcePattern = /^S[1-9][0-9]{0,2}$/;

export function validateWebSearch(value: unknown): WebSearchRequest | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid web search selection.");
  const v = value as Record<string, unknown>;
  if (Object.keys(v).some(k => !["version", "mode"].includes(k)) || v.version !== 1 || !["off", "auto", "required"].includes(String(v.mode)))
    throw new Error("Choose a supported web search mode and version.");
  return v.mode === "off" ? undefined : { version: 1, mode: v.mode as WebSearchRequest["mode"] };
}

export function parseWebSources(value: unknown, runId: string): WebSource[] | undefined {
  if (!Array.isArray(value) || value.length > 10) return undefined;
  const ids = new Set<string>(); const sources: WebSource[] = [];
  for (const s of value) {
    if (!s || typeof s !== "object" || typeof s.sourceId !== "string" || !sourcePattern.test(s.sourceId) || ids.has(s.sourceId) ||
      (s.runId !== undefined && s.runId !== runId) || typeof s.title !== "string" || !s.title.trim() || s.title.length > 300 ||
      typeof s.url !== "string" || s.url.length > 2048 || /[\u0000-\u0020\u007f]/.test(s.url) ||
      typeof s.retrievedAt !== "string" || s.retrievedAt.length > 64 || !/^\d{4}-\d\d-\d\dT/.test(s.retrievedAt) || !Number.isFinite(Date.parse(s.retrievedAt)) ||
      !["search", "page"].includes(s.evidenceKind)) return undefined;
    try { const url = new URL(s.url); if (!["https:", "http:"].includes(url.protocol) || !url.hostname || url.username || url.password) return undefined; }
    catch { return undefined; }
    ids.add(s.sourceId);
    sources.push({ runId, sourceId: s.sourceId, title: s.title, url: s.url, retrievedAt: s.retrievedAt, evidenceKind: s.evidenceKind });
  }
  return sources;
}

export function parseWebMetadata(value: unknown): WebSearchMetadata | undefined {
  if (!value || typeof value !== "object") return undefined;
  const v = value as Record<string, unknown>;
  if (v.version !== 1 || typeof v.runId !== "string" || !runPattern.test(v.runId) || !["completed", "failed", "stopped", "interrupted"].includes(String(v.outcome))) return undefined;
  const sources = parseWebSources(v.sources, v.runId);
  return sources ? { version: 1, runId: v.runId, outcome: v.outcome as WebSearchMetadata["outcome"], sources } : undefined;
}

/** Per-response registry prevents stale runs, duplicate events, and source-ID rebinding. */
export function webEventReader() {
  let runId: string | undefined; let sequence = -1; let complete = false; let registry: WebSource[] = [];
  return {
    get complete() { return complete; },
    read(type: string, value: unknown): WebEvent {
      const v = value as Record<string, unknown> | null;
      if (!v || v.version !== 1 || typeof v.runId !== "string" || !runPattern.test(v.runId) ||
        (runId && runId !== v.runId) || !Number.isSafeInteger(v.sequence) || Number(v.sequence) <= sequence || complete)
        throw new Error("The web search response could not be verified. Please retry.");
      const base = { version: 1 as const, runId: v.runId, sequence: Number(v.sequence) };
      let event: WebEvent;
      if (type === "web-status" && ["planning", "searching", "reading", "answering"].includes(String(v.status)))
        event = { ...base, type, status: v.status as WebStatus };
      else if (type === "web-sources") {
        const sources = parseWebSources(v.sources, v.runId);
        if (!sources || registry.some(old => !sources.some(s => s.sourceId === old.sourceId && s.url === old.url)))
          throw new Error("The web search sources could not be verified. Please retry.");
        registry = sources; event = { ...base, type, sources };
      } else if (type === "web-complete" && ["completed", "failed"].includes(String(v.outcome))) {
        complete = true; event = { ...base, type, outcome: v.outcome as "completed" | "failed" };
      } else throw new Error("The web search response could not be verified. Please retry.");
      runId = v.runId; sequence = Number(v.sequence); return event;
    },
  };
}

/** Validate web metadata at the authenticated server boundary before exposing citation links. */
export function validatedWebStream(stream: ReadableStream<Uint8Array>) {
  const decoder = new TextDecoder(); const encoder = new TextEncoder(); const events = webEventReader(); let buffer = "";
  return stream.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });
      if (buffer.length > 262144) throw new Error("Web search stream exceeded its event limit.");
      let match;
      while ((match = /\r?\n\r?\n/.exec(buffer))) {
        const block = buffer.slice(0, match.index); buffer = buffer.slice(match.index + match[0].length);
        const type = block.split(/\r?\n/).find(l => l.startsWith("event:"))?.slice(6).trim();
        const data = block.split(/\r?\n/).filter(l => l.startsWith("data:")).map(l => l.slice(5).trimStart()).join("\n");
        if (type?.startsWith("web-")) {
          const event = events.read(type, JSON.parse(data));
          const { type: _type, ...safe } = event;
          controller.enqueue(encoder.encode(`event: ${type}\ndata: ${JSON.stringify(safe)}\n\n`));
        } else {
          if (data === "[DONE]" && !events.complete) throw new Error("Web search ended before its result was verified.");
          controller.enqueue(encoder.encode(block + "\n\n"));
        }
      }
    },
    flush() { if (buffer.trim() || !events.complete) throw new Error("Web search ended before its result was verified."); },
  }));
}
