import { DEFAULT_MODEL, isModelId, type ModelId } from "./models";
import { parseSourceMetadata, type SourceMetadata } from "./history-metadata";
import { parseWebMetadata, type WebSearchMetadata } from "./web-search";
export type Message = { id: string; role: "user" | "assistant"; content: string; state?: "complete" | "stopped" | "error"; note?: string; model?: ModelId; useAdapter?: boolean; imageName?: string; docsMode?: true; docsSources?: SourceMetadata[]; searchRequested?: true; webSearch?: WebSearchMetadata };
export type Conversation = { id: string; title: string; updatedAt: number; messages: Message[]; model?: ModelId; useAdapter?: boolean };
export const STORAGE_KEY = "qwen-chat.conversations.v1";
export function parseConversations(raw: string | null): Conversation[] {
  if (!raw) return [];
  try {
    const value = JSON.parse(raw);
    if (!Array.isArray(value)) return [];
    return value.filter(c => c && typeof c.id === "string" && typeof c.title === "string" && typeof c.updatedAt === "number" && Array.isArray(c.messages) && c.messages.every((m: Message) => m && typeof m.id === "string" && ["user", "assistant"].includes(m.role) && typeof m.content === "string")).slice(0, 100).map(c => ({
      ...c, model: isModelId(c.model) ? c.model : DEFAULT_MODEL,
      useAdapter: typeof c.useAdapter === "boolean" ? c.useAdapter : undefined,
      messages: c.messages.map((m: Message) => m.role === "assistant" ? { ...m, model: isModelId(m.model) ? m.model : DEFAULT_MODEL,
        useAdapter: m.model === "bf16" && typeof m.useAdapter === "boolean" ? m.useAdapter : undefined,
        docsSources: parseSourceMetadata(m.docsSources), webSearch: parseWebMetadata(m.webSearch) } :
        { ...m, webSearch: undefined, searchRequested: m.searchRequested === true ? true : undefined, docsMode: m.docsMode === true ? true : undefined, imageName: typeof m.imageName === "string" ? m.imageName.slice(0, 160) : undefined }),
    }));
  } catch { return []; }
}
export function completedHistory(messages: Message[]) {
  const result: { role: "user" | "assistant"; content: string }[] = [];
  let user: Message | undefined;
  for (const message of messages) {
    if (message.role === "user") user = message;
    else if (user && message.content && message.state !== "error") {
      result.push({ role: "user", content: user.content }, { role: "assistant", content: message.content }); user = undefined;
    }
  }
  return result;
}
