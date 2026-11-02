import { validateSettings, jsonBytes, type ChatSettings } from "./chat-settings";
import { parseUsage, type TokenUsage } from "./diagnostics";
export type ChatMessage = { role: "user" | "assistant"; content: string };
export type ChatInput = { messages: ChatMessage[]; max_tokens: number; temperature: number; settings: ChatSettings };

export function validateInput(value: unknown): ChatInput {
  if (!value || typeof value !== "object") throw new Error("Please send a message.");
  const data = value as Record<string, unknown>;
  if (!Array.isArray(data.messages) || !data.messages.length || data.messages.length > 800)
    throw new Error("Start a new conversation or send fewer messages.");
  const messages = data.messages.map((item: unknown, index: number): ChatMessage => {
    if (!item || typeof item !== "object") throw new Error("Invalid conversation.");
    const m = item as Record<string, unknown>;
    if (m.role !== (index % 2 === 0 ? "user" : "assistant") || typeof m.content !== "string" || !m.content.trim())
      throw new Error("Conversation messages must alternate between you and the assistant.");
    return { role: m.role as ChatMessage["role"], content: m.content };
  });
  if (messages.at(-1)?.role !== "user") throw new Error("The last message must be yours.");
  const settings = validateSettings(data.settings);
  const max_tokens = data.max_tokens ?? settings.outputTokens;
  const temperature = data.temperature ?? 0.7;
  if (typeof max_tokens !== "number" || !Number.isInteger(max_tokens) || max_tokens < 128 || max_tokens > 10240)
    throw new Error("Choose a response length between 128 and 10240 tokens.");
  if (typeof temperature !== "number" || !Number.isFinite(temperature) || temperature < 0 || temperature > 1.5)
    throw new Error("Temperature must be between 0 and 1.5.");
  if (data.settings !== undefined && max_tokens !== settings.outputTokens) throw new Error("Conflicting output budget.");
  settings.outputTokens = max_tokens;
  validateSettings(settings);
  if (messages.at(-1)!.content.length > settings.inputCharacters) throw new Error("Input character limit exceeded.");
  if (messages.length > settings.historyMessages || jsonBytes(messages) > settings.historyBytes) throw new Error("History limit exceeded.");
  const input = { messages, max_tokens, temperature, settings };
  if (jsonBytes({ ...input, stream: true }) > settings.requestBytes) throw new Error("Request byte limit exceeded.");
  return input;
}

/** Decode SSE across arbitrary network boundaries, including split UTF-8 characters. */
export async function consumeCompletion(
  stream: ReadableStream<Uint8Array>, onDelta: (text: string) => void,
  onFinish?: (reason: string) => void,
  onUsage?: (usage: TokenUsage) => void,
) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let completed = false;
  function event(block: string) {
    const data = block.split(/\r?\n/).filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
    if (!data) return;
    if (data === "[DONE]") { completed = true; return; }
    const item = JSON.parse(data);
    if (item.error) throw new Error(typeof item.error === "string" ? item.error : item.error.message ?? "The response was interrupted.");
    const usage = parseUsage(item.usage);
    if (usage) onUsage?.(usage);
    const choice = item.choices?.[0];
    if (typeof choice?.delta?.content === "string") onDelta(choice.delta.content);
    if (typeof choice?.finish_reason === "string") onFinish?.(choice.finish_reason);
  }
  try {
    while (!completed) {
      const { value, done } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      let boundary;
      while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
        event(buffer.slice(0, boundary.index));
        buffer = buffer.slice(boundary.index + boundary[0].length);
      }
      if (done) break;
    }
    if (!completed) throw new Error("The connection ended before the reply finished. You can retry.");
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
