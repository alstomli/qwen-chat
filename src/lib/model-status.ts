import type { ChatSettings } from "./chat-settings";
import { MODELS, type ModelId } from "./models";
import type { ImageInputLimits } from "./image-input";

export type Connection = {
  model: ModelId; mode: "checking" | "live" | "preview" | "unconfigured";
  ready: boolean; limits?: ChatSettings; error?: string; diagnosticsAvailable?: boolean;
  lastVerifiedLimits?: ChatSettings;
  adapterToggleAvailable?: boolean;
  imageInput?: ImageInputLimits;
};

export type ModelConnections = Record<ModelId, Connection>;
export function initialModelConnections(): ModelConnections {
  return { "4bit": { model: "4bit", mode: "checking", ready: false }, bf16: { model: "bf16", mode: "checking", ready: false } };
}
export function updateModelConnection(current: ModelConnections, next: Connection): ModelConnections {
  const lastVerifiedLimits = next.mode === "live" && next.ready && next.limits
    ? next.limits : current[next.model].lastVerifiedLimits;
  return { ...current, [next.model]: { ...next, lastVerifiedLimits } };
}

/** A later refresh or selection always wins, even if an old fetch ignores abort. */
export function modelStatusRequests(model: ModelId, receive: (status: Connection) => void,
  unauthorized: () => void, fetcher: typeof fetch = fetch) {
  let disposed = false; let version = 0; let current: AbortController | undefined;
  return {
    async refresh() {
      const request = ++version;
      current?.abort(); current = new AbortController();
      try {
        const response = await fetcher(`/api/status?model=${model}`, { cache: "no-store", signal: current.signal });
        if (disposed || request !== version) return;
        if (response.status === 401) { unauthorized(); return; }
        const body = await response.json();
        if (disposed || request !== version) return;
        if (!response.ok || body.model !== model) throw new Error("Model status could not be verified.");
        receive(body);
      } catch {
        if (!disposed && request === version) receive({ model, mode: "live", ready: false });
      }
    },
    dispose() { disposed = true; version++; current?.abort(); },
  };
}

/** Each model has its own request identity and failure state. */
export function allModelStatusRequests(receive: (status: Connection) => void, unauthorized: () => void, fetcher: typeof fetch = fetch) {
  const requests = MODELS.map(model => modelStatusRequests(model.id, receive, unauthorized, fetcher));
  return { refresh: () => Promise.allSettled(requests.map(request => request.refresh())), dispose: () => requests.forEach(request => request.dispose()) };
}
