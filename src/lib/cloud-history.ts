import { parseSourceMetadata } from "./history-metadata";
import { parseWebMetadata } from "./web-search";
import { isModelId } from "./models";
import type { Conversation, Message } from "./storage";

export const CLOUD_CACHE_KEY = "qwen-chat.cloud-history.v1";
export const HISTORY_NOTICE_KEY = "qwen-chat.history-notice.v1";
export const CLOUD_MAX_BYTES = 2_000_000;
export type HistoryUsage = { bytes: number; count: number; maxBytes: number; maxCount: number; paused: boolean };
export type SaveState = "saved" | "saving" | "pending" | "local" | "oversized" | "conflict" | "deleted" | "expired" | "create_limited";
export type HistoryEntry = { chat: Conversation; revision: number; loaded: boolean; state: SaveState; createdAt: string; fingerprint?: string; operation?: { id: string; payload: ReturnType<typeof cloudPayload>; revision: number }; deleting?: boolean; mayExistRemotely?: boolean };
export type HistoryRpc = (name: string, args?: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }>;
type Storage = Pick<globalThis.Storage, "getItem" | "setItem" | "removeItem">;

// Whitelist twice (here and SQL). A streaming placeholder is omitted until its terminal state.
export function cloudPayload(chat: Conversation): Pick<Conversation, "title" | "model" | "useAdapter" | "messages"> {
  return {
    title: chat.title.slice(0, 160), model: isModelId(chat.model) ? chat.model : undefined,
    useAdapter: typeof chat.useAdapter === "boolean" ? chat.useAdapter : undefined,
    messages: chat.messages.filter(m => m.role === "user" || m.state).map(m => ({
      id: m.id, role: m.role, content: m.content,
      ...(m.role === "user" ? { imageName: m.imageName?.slice(0, 160), docsMode: m.docsMode === true ? true : undefined, searchRequested: m.searchRequested === true ? true : undefined } : {
        state: m.state, model: isModelId(m.model) ? m.model : undefined,
        useAdapter: typeof m.useAdapter === "boolean" ? m.useAdapter : undefined,
        note: m.state === "error" ? "The reply failed. Please retry." : m.state === "stopped" ? "You stopped this reply." : undefined,
        docsSources: parseSourceMetadata(m.docsSources),
        webSearch: parseWebMetadata(m.webSearch),
      }),
    })),
  };
}
export function historyMarkdown(chats: Conversation[]) {
  return chats.map(chat => `# ${chat.title}\n\n${chat.messages.map(m => `## ${m.role === "user" ? "You" : "Assistant"}${m.model ? ` (${m.model}${m.useAdapter === true ? " + adapter" : ""})` : ""}\n\n${m.content}${m.imageName ? `\n\n[Image filename: ${m.imageName}; image not included]` : ""}${m.state ? `\n\n_State: ${m.state}_` : ""}${m.note ? `\n\n${m.note}` : ""}${m.docsSources?.map(s => `\n\n[${s.id}] ${s.heading}: ${s.url}`).join("") ?? ""}${m.webSearch ? `\n\n_Web search: ${m.webSearch.outcome}_` + m.webSearch.sources.map(s => `\n\n[${s.sourceId}] ${s.title}: ${s.url} (retrieved ${s.retrievedAt}; ${s.evidenceKind})`).join("") : ""}`).join("\n\n")}`).join("\n\n---\n\n");
}
export function exportHistory(chats: Conversation[], format: "json" | "md") {
  const safe = chats.map(chat => ({ id: chat.id, updatedAt: chat.updatedAt, ...cloudPayload(chat) }));
  const blob = new Blob([format === "json" ? JSON.stringify(safe, null, 2) : historyMarkdown(safe)], { type: format === "json" ? "application/json" : "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob); const link = document.createElement("a");
  link.href = url; link.download = `kiddo-history-${new Date().toISOString().slice(0, 10)}.${format}`; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Account-scoped, serial writer. UI streaming never awaits database work. */
export class CloudHistoryStore {
  entries = new Map<string, HistoryEntry>();
  usage: HistoryUsage = { bytes: 0, count: 0, maxBytes: CLOUD_MAX_BYTES, maxCount: 50, paused: false };
  ready = false; offline = false; durable = true; disposed = false;
  private running = false;
  private mutationEpoch = 0;
  private loads = new Map<string, Promise<Conversation | null>>();
  constructor(private key: string, private storage: Storage, private rpc: HistoryRpc,
    private changed: () => void, private merge: (chats: Conversation[], removed?: string[]) => void,
    private notify: (message: string) => void, private protectedChat: (id: string) => boolean = () => false) {}
  restore() {
    try {
      const rows: HistoryEntry[] = JSON.parse(this.storage.getItem(this.key) ?? "[]");
      if (Array.isArray(rows)) for (const e of rows) {
        if (!e?.chat?.id || !Array.isArray(e.chat.messages) || typeof e.revision !== "number") continue;
        e.chat = { ...e.chat, ...cloudPayload(e.chat) }; this.entries.set(e.chat.id, e);
      }
      this.merge([...this.entries.values()].filter(e => !e.deleting).map(e => e.chat));
    } catch { this.durable = false; }
  }
  private persist() {
    try { this.storage.setItem(this.key, JSON.stringify([...this.entries.values()])); this.durable = true; }
    catch { this.durable = false; }
    this.changed();
  }
  async refresh() {
    const epoch = this.mutationEpoch;
    try {
      const [usage, first] = await Promise.all([this.rpc("chat_history_usage"), this.rpc("list_chat_history", { p_limit: 20 })]);
      if (this.disposed) return;
      if (usage.error || first.error || !Array.isArray(first.data)) throw new Error("History unavailable");
      const rows = [...first.data] as (Conversation & { revision: number; cursor: string })[];
      let page = first.data as typeof rows;
      while (page.length === 20) {
        const tail = page.at(-1)!;
        const next = await this.rpc("list_chat_history", { p_before: tail.cursor, p_before_id: tail.id, p_limit: 20 });
        if (this.disposed) return;
        if (next.error || !Array.isArray(next.data)) throw new Error("History unavailable");
        page = next.data; rows.push(...page);
      }
      // A response that started before any local mutation cannot reconcile newer local state.
      if (epoch !== this.mutationEpoch) { this.ready = true; this.changed(); return; }
      this.usage = usage.data as HistoryUsage;
      const ids = new Set(rows.map(r => r.id)); const removed: string[] = [];
      for (const [id, entry] of this.entries) {
        if (entry.revision > 0 && !ids.has(id) && !entry.deleting) {
          if (entry.operation || entry.state !== "saved" || this.protectedChat(id)) {
            entry.state = "deleted"; entry.operation = undefined;
            this.notify("This chat was removed from cloud history. Your unsynced copy stays on this browser.");
          } else { this.entries.delete(id); removed.push(id); }
        }
      }
      for (const row of rows) {
        const current = this.entries.get(row.id);
        if (current?.deleting || current?.operation || this.protectedChat(row.id) || (current && !["saved", "saving"].includes(current.state))) continue;
        if (!current || current.revision < row.revision) {
          this.entries.set(row.id, { chat: { id: row.id, title: row.title, updatedAt: row.updatedAt, messages: [], model: row.model, useAdapter: row.useAdapter }, revision: row.revision, loaded: false, state: "saved", createdAt: new Date(row.updatedAt).toISOString() });
        }
      }
      this.offline = false; this.ready = true;
      this.merge([...this.entries.values()].filter(e => !e.deleting).map(e => e.chat), removed);
      this.persist(); void this.flush();
    } catch {
      if (this.disposed) return;
      this.ready = true; this.offline = true; this.changed();
    }
  }
  async load(id: string): Promise<Conversation | null> {
    const entry = this.entries.get(id);
    if (!entry || entry.deleting) return null;
    if (entry.loaded) return entry.chat;
    const pending = this.loads.get(id); if (pending) return pending;
    const task = this.loadPages(id); this.loads.set(id, task);
    try { return await task; } finally { this.loads.delete(id); }
  }
  private async loadPages(id: string): Promise<Conversation | null> {
    for (let attempt = 0; attempt < 3; attempt++) {
      let offset = 0, revision: number | undefined, result: Conversation | undefined; let changed = false;
      do {
        const response = await this.rpc("get_chat_history", { p_id: id, p_offset: offset, p_limit: 100 });
        if (this.disposed) return null;
        if (response.error) throw new Error("Couldn't load this conversation. Try again.");
        const data = response.data as { payload: ReturnType<typeof cloudPayload>; revision: number; totalMessages: number; updatedAt: number } | null;
        if (!data) { this.entries.delete(id); this.merge([], [id]); this.persist(); return null; }
        if (revision !== undefined && revision !== data.revision) { changed = true; break; }
        revision = data.revision;
        result ??= { id, ...data.payload, messages: [], updatedAt: data.updatedAt };
        result.messages.push(...data.payload.messages as Message[]); offset += data.payload.messages.length;
        if (offset >= data.totalMessages) break;
        if (!data.payload.messages.length) throw new Error("Incomplete history page");
      } while (true);
      if (changed) continue;
      const entry = this.entries.get(id);
      if (!entry || entry.operation || entry.deleting) return entry?.chat ?? null;
      if (entry.revision > revision!) continue;
      entry.chat = result!; entry.revision = revision!; entry.loaded = true;
      entry.fingerprint = JSON.stringify(cloudPayload(result!));
      this.merge([result!]); this.persist(); return result!;
    }
    throw new Error("This conversation keeps changing on another device. Try again.");
  }
  stage(chat: Conversation) {
    if (this.disposed) return;
    let entry = this.entries.get(chat.id);
    if (entry && (!entry.loaded || entry.deleting)) return;
    const payload = cloudPayload(chat), fingerprint = JSON.stringify(payload);
    if (entry?.fingerprint === fingerprint) return;
    this.mutationEpoch++;
    if (!entry) {
      entry = { chat, revision: 0, loaded: true, state: "saving", createdAt: new Date().toISOString() };
      this.entries.set(chat.id, entry);
    }
    entry.chat = { ...chat, ...payload }; entry.fingerprint = fingerprint;
    if (["oversized", "conflict", "deleted", "expired", "create_limited", "local"].includes(entry.state)) { this.persist(); return; }
    // Keep an uncertain/in-flight operation immutable. New snapshots follow its acknowledgement.
    entry.state = this.offline ? "pending" : "saving"; this.persist(); void this.flush();
  }
  async retry() {
    for (const entry of this.entries.values()) if (entry.state === "pending") entry.state = "saving";
    this.offline = false; this.changed(); await this.flush();
  }
  async remove(id: string) {
    const entry = this.entries.get(id); if (!entry) return;
    this.mutationEpoch++;
    if (entry.revision === 0 && !entry.operation && !entry.mayExistRemotely) { this.entries.delete(id); this.persist(); return; }
    // Finish uncertain creation before deletion; deletion can never race the create.
    entry.deleting = true; entry.state = "saving"; this.persist(); void this.flush();
  }
  private async flush() {
    if (this.running || this.disposed || this.offline) return;
    this.running = true;
    try {
      for (const [id, entry] of this.entries) {
        if (this.disposed) break;
        if (!["saving", "pending"].includes(entry.state)) continue;
        while (true) {
          if (entry.deleting && !entry.operation) {
            const response = await this.rpc("delete_chat", { p_id: id });
            if (this.disposed) return;
            if (response.error) throw new Error("Delete failed");
            this.mutationEpoch++;
            this.usage = response.data as HistoryUsage; this.entries.delete(id); this.persist(); break;
          }
          const operation = entry.operation ?? { id: crypto.randomUUID(), payload: cloudPayload(entry.chat), revision: entry.revision };
          entry.operation = operation; entry.mayExistRemotely = true; this.persist();
          // Do not enqueue a request unless the local outbox is durable.
          // Chat/inference still works in memory, and explicit Retry can recover storage later.
          if (!this.durable) { entry.state = "pending"; this.changed(); break; }
          const response = await this.rpc("save_chat", { p_id: id, p_payload: operation.payload, p_revision: operation.revision, p_operation: operation.id, p_created_at: entry.createdAt });
          if (this.disposed) return;
          if (response.error) throw new Error("Save failed");
          this.mutationEpoch++;
          const data = response.data as { status: string; revision?: number; evicted?: string[]; usage?: HistoryUsage };
          if (!data || !["saved", "conflict", "deleted", "oversized", "paused", "expired", "create_limited"].includes(data.status)) throw new Error("Invalid save response");
          if (data.status !== "saved") {
            if (data.status === "paused") { entry.state = "pending"; this.offline = true; this.usage = { ...this.usage, paused: true }; }
            else { entry.state = data.status as SaveState; entry.operation = undefined; }
            if (entry.deleting) { entry.operation = undefined; continue; }
            this.persist(); break;
          }
          entry.revision = data.revision!; entry.operation = undefined;
          if (data.usage) this.usage = data.usage;
          for (const evicted of data.evicted ?? []) {
            const old = this.entries.get(evicted);
            if (old && (old.operation || old.state !== "saved" || this.protectedChat(evicted))) { old.state = "deleted"; old.operation = undefined; }
            else this.entries.delete(evicted);
          }
          if (data.evicted?.length) { this.merge([], data.evicted.filter(evicted => !this.entries.has(evicted))); this.notify(`Cloud history full. Removed ${data.evicted.length} older conversation${data.evicted.length === 1 ? "" : "s"}.`); }
          if (entry.deleting || JSON.stringify(operation.payload) !== entry.fingerprint) { this.persist(); continue; }
          entry.state = "saved"; this.persist(); break;
        }
      }
    } catch {
      if (this.disposed) return;
      this.offline = true;
      for (const entry of this.entries.values()) if (entry.state === "saving") entry.state = "pending";
      this.persist();
    } finally {
      this.running = false; if (!this.disposed) this.changed();
      if (!this.disposed && !this.offline && this.durable && [...this.entries.values()].some(entry => entry.state === "saving")) void this.flush();
    }
  }
  dispose(signOut = false) {
    if (this.disposed) return;
    this.disposed = true;
    if (signOut) {
      for (const entry of this.entries.values()) {
        if (entry.operation || entry.state === "pending" || entry.state === "saving") { entry.mayExistRemotely ||= !!entry.operation; entry.operation = undefined; entry.state = "local"; }
        entry.deleting = false;
      }
      this.persist();
    }
    this.entries.clear(); this.loads.clear();
  }
}
