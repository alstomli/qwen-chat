import { parseGeneratedImage, type GeneratedImage } from "./generated-image";
import { isModelId, UNTAGGED_MODEL, type ModelId } from "./models";
import { parseSourceMetadata, type SourceMetadata } from "./history-metadata";
import { parseWebMetadata, type WebSearchMetadata } from "./web-search";
export type Message = { generatedImage?: GeneratedImage; id: string; role: "user" | "assistant"; content: string; state?: "complete" | "stopped" | "error"; note?: string; model?: ModelId; useAdapter?: boolean; imageName?: string; docsMode?: true; docsSources?: SourceMetadata[]; searchRequested?: true; webSearch?: WebSearchMetadata };
export type Conversation = { id: string; title: string; updatedAt: number; messages: Message[]; model?: ModelId; useAdapter?: boolean };
export const STORAGE_KEY = "qwen-chat.conversations.v1";

/** Ignore conversations tagged with an unknown model instead of relabeling their answers as another model. */
export function hasSupportedModels(value: { model?: unknown; messages?: { role?: unknown; model?: unknown }[] }) {
  return (value.model === undefined || isModelId(value.model))
    && (value.messages === undefined || (Array.isArray(value.messages) && value.messages.every(message => message
      && (message.role !== "assistant" || message.model === undefined || isModelId(message.model)))));
}

/** Conversations and answers saved without a model tag predate the 4-bit default, so they stay BF16. */
export function withModelTags<T extends Pick<Conversation, "model" | "messages">>(chat: T): T {
  return { ...chat, model: chat.model ?? UNTAGGED_MODEL,
    messages: chat.messages.map(m => m.role === "assistant" ? { ...m, model: m.model ?? UNTAGGED_MODEL } : m) };
}

export function parseConversations(raw: string | null): Conversation[] {
  if (!raw) return [];
  try {
    const value = JSON.parse(raw);
    if (!Array.isArray(value)) return [];
    return value.filter(c => c && typeof c.id === "string" && typeof c.title === "string" && typeof c.updatedAt === "number" && Array.isArray(c.messages) && c.messages.every((m: Message) => m && typeof m.id === "string" && ["user", "assistant"].includes(m.role) && typeof m.content === "string") && hasSupportedModels(c)).slice(0, 100).map(c => withModelTags({
      ...c,
      useAdapter: typeof c.useAdapter === "boolean" ? c.useAdapter : undefined,
      messages: c.messages.map((m: Message) => m.role === "assistant" ? { ...m,
        useAdapter: typeof m.useAdapter === "boolean" ? m.useAdapter : undefined,
        generatedImage: parseGeneratedImage(m.generatedImage), docsSources: parseSourceMetadata(m.docsSources), webSearch: parseWebMetadata(m.webSearch) } :
        { ...m, webSearch: undefined, searchRequested: m.searchRequested === true ? true : undefined, docsMode: m.docsMode === true ? true : undefined, imageName: typeof m.imageName === "string" ? m.imageName.slice(0, 160) : undefined }),
    }));
  } catch { return []; }
}
export function completedHistory(messages: Message[]) {
  const result: { role: "user" | "assistant"; content: string }[] = [];
  let user: Message | undefined;
  for (const message of messages) {
    if (message.generatedImage) continue;
    if (message.role === "user") user = message;
    else if (user && message.content && message.state !== "error") {
      result.push({ role: "user", content: user.content }, { role: "assistant", content: message.content }); user = undefined;
    }
  }
  return result;
}
