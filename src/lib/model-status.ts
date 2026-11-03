import type { ChatSettings } from "./chat-settings";
import type { ModelId } from "./models";

export type Connection = {
  model: ModelId; mode: "checking" | "live" | "preview" | "unconfigured";
  ready: boolean; limits?: ChatSettings; error?: string; diagnosticsAvailable?: boolean;
};

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
