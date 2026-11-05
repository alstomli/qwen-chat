import { DEFAULT_MODEL, isModelId, type ModelId } from "./models";
export type TextMessage = { id: string; role: "user" | "assistant"; content: string; state?: "complete" | "stopped" | "error"; note?: string; model?: ModelId; useAdapter?: boolean };
export type ImageMessage = {
  id: string;
  role: "image";
  content: string;
  state: "queued" | "generating" | "ready" | "error";
  jobId?: string;
  note?: string;
  model?: never;
  useAdapter?: never;
};
export type Message = TextMessage | ImageMessage;
export type Conversation = { id: string; title: string; updatedAt: number; messages: Message[]; model?: ModelId; useAdapter?: boolean };
type StoredMessage = Message & { qwenImage?: { version: 1 } & Omit<ImageMessage, "id" | "role"> };
export const STORAGE_KEY = "qwen-chat.conversations.v1";

function isMessage(message: Message) {
  if (!message || typeof message.id !== "string" || typeof message.content !== "string") return false;
  if (message.role === "user" || message.role === "assistant") return true;
  return message.role === "image" && ["queued", "generating", "ready", "error"].includes(message.state)
    && (message.jobId === undefined || typeof message.jobId === "string")
    && (message.note === undefined || typeof message.note === "string");
}

function restoreMessage(stored: StoredMessage): Message {
  let message: Message = stored;
  if (stored.role === "assistant" && stored.content === "" && stored.qwenImage?.version === 1) {
    const { content, state, jobId, note } = stored.qwenImage;
    const image: ImageMessage = { id: stored.id, role: "image", content, state, jobId, note };
    if (isMessage(image)) message = image;
  }
  if (message.role === "image" && (message.state === "queued" || message.state === "generating") && !message.jobId) {
    return { ...message, state: "error", note: "The request was interrupted before the job could be saved. Try generating it again." };
  }
  if (message.role !== "assistant") return message;
  return {
    ...message, model: isModelId(message.model) ? message.model : DEFAULT_MODEL,
    useAdapter: message.model === "bf16" && typeof message.useAdapter === "boolean" ? message.useAdapter : undefined,
  };
}

export function serializeConversations(conversations: Conversation[]) {
  return JSON.stringify(conversations.map(chat => ({
    ...chat,
    messages: chat.messages.map(message => {
      if (message.role !== "image") return message;
      const { id, content, state, jobId, note } = message;
      // Older app builds accept empty assistant messages and omit them from text context.
      return { id, role: "assistant", content: "", qwenImage: { version: 1, content, state, jobId, note } };
    }),
  })));
}

export function parseConversations(raw: string | null): Conversation[] {
  if (!raw) return [];
  try {
    const value = JSON.parse(raw);
    if (!Array.isArray(value)) return [];
    return value.filter(c => c && typeof c.id === "string" && typeof c.title === "string" && typeof c.updatedAt === "number" && Array.isArray(c.messages) && c.messages.every(isMessage)).slice(0, 100).map(c => ({
      ...c, model: isModelId(c.model) ? c.model : DEFAULT_MODEL,
      useAdapter: typeof c.useAdapter === "boolean" ? c.useAdapter : undefined,
      messages: c.messages.map(restoreMessage),
    }));
  } catch { return []; }
}
export function completedHistory(messages: Message[]) {
  const result: { role: "user" | "assistant"; content: string }[] = [];
  let user: TextMessage | undefined;
  for (const message of messages) {
    if (message.role === "image") continue;
    if (message.role === "user") user = message;
    else if (user && message.content && message.state !== "error") {
      result.push({ role: "user", content: user.content }, { role: "assistant", content: message.content }); user = undefined;
    }
  }
  return result;
}
