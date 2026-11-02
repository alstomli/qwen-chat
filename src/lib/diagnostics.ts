import type { ChatSettings } from "./chat-settings";
export const DIAGNOSTICS_HEADER = "X-Chat-Diagnostics";
export type TokenUsage = { promptTokens: number; outputTokens: number };
export type GatewayDiagnostic = {
  version: 1; requestId: string; model: string;
  inputTokensBefore: number | null; inputTokensAfter: number | null;
  lastCountedInputTokens: number | null; outputBudget: number | null;
  safetyReserve: number | null; contextBudget: number | null;
  gatewayTrimmedMessages: number; reuseCachedPrefixes: boolean | null;
};
export type DiagnosticRecord = {
  id: string; createdAt: string;
  status: "pending" | "streaming" | "completed" | "stopped" | "interrupted" | "error";
  browserOriginalMessages: number; browserSentMessages: number;
  browserOriginalBytes: number; browserSentBytes: number;
  outputBudget: number; safetyReserve: number; contextBudget: number;
  reuseCachedPrefixes: boolean;
  settings: ChatSettings; temperature: number;
  gateway: GatewayDiagnostic | null; usage: TokenUsage | null; finishReason: string | null;
};
const count = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

export function parseUsage(value: unknown): TokenUsage | null {
  if (!value || typeof value !== "object") return null;
  const usage = value as Record<string, unknown>;
  return count(usage.prompt_tokens) && count(usage.completion_tokens)
    ? { promptTokens: usage.prompt_tokens, outputTokens: usage.completion_tokens } : null;
}

/** Allowlist metadata so prompts, credentials and arbitrary upstream fields cannot enter exports. */
export function parseDiagnosticHeader(raw: string | null): GatewayDiagnostic | null {
  if (!raw || raw.length > 4096) return null;
  try {
    const value = JSON.parse(raw);
    if (!value || value.version !== 1 || typeof value.requestId !== "string" || !/^[a-f0-9]{32}$/.test(value.requestId) || typeof value.model !== "string" || value.model.length > 256) return null;
    const numeric = ["inputTokensBefore", "inputTokensAfter", "lastCountedInputTokens", "outputBudget", "safetyReserve", "contextBudget"] as const;
    for (const key of numeric) if (value[key] !== null && !count(value[key])) return null;
    if (!count(value.gatewayTrimmedMessages) || value.gatewayTrimmedMessages % 2 !== 0 || ![true, false, null].includes(value.reuseCachedPrefixes)) return null;
    return {
      version: 1, requestId: value.requestId, model: value.model,
      inputTokensBefore: value.inputTokensBefore, inputTokensAfter: value.inputTokensAfter,
      lastCountedInputTokens: value.lastCountedInputTokens, outputBudget: value.outputBudget,
      safetyReserve: value.safetyReserve, contextBudget: value.contextBudget,
      gatewayTrimmedMessages: value.gatewayTrimmedMessages, reuseCachedPrefixes: value.reuseCachedPrefixes,
    };
  } catch { return null; }
}

export function diagnosticValues(record: DiagnosticRecord) {
  const g = record.gateway;
  const output = g?.outputBudget ?? record.outputBudget;
  const reserve = g?.safetyReserve ?? record.safetyReserve;
  const context = g?.contextBudget ?? record.contextBudget;
  const after = g?.inputTokensAfter ?? null;
  return {
    request_id: g?.requestId ?? record.id, created_at: record.createdAt, status: record.status,
    model: g?.model ?? null, browser_messages_before: record.browserOriginalMessages,
    browser_messages_sent: record.browserSentMessages,
    browser_bytes_before: record.browserOriginalBytes, browser_bytes_sent: record.browserSentBytes,
    browser_trimmed_messages: record.browserOriginalMessages - record.browserSentMessages,
    gateway_trimmed_messages: g?.gatewayTrimmedMessages ?? null,
    input_tokens_before: g?.inputTokensBefore ?? null, input_tokens_sent: after,
    last_counted_input_tokens: g?.lastCountedInputTokens ?? null,
    removed_tokens: after !== null && g?.inputTokensBefore !== null && g?.inputTokensBefore !== undefined ? g.inputTokensBefore - after : null,
    output_budget: output, safety_reserve: reserve, context_budget: context,
    unreserved_tokens: after === null ? null : context - after - output - reserve,
    actual_prompt_tokens: record.usage?.promptTokens ?? null,
    actual_output_tokens: record.usage?.outputTokens ?? null, finish_reason: record.finishReason,
    prefix_reuse: (g?.reuseCachedPrefixes ?? record.reuseCachedPrefixes) ? "allowed" : "bypassed",
    temperature: record.temperature, input_character_limit: record.settings.inputCharacters,
    history_message_limit: record.settings.historyMessages, history_byte_limit: record.settings.historyBytes,
    request_byte_limit: record.settings.requestBytes, timeout_seconds: record.settings.timeoutSeconds,
  };
}

export function diagnosticsCsv(records: DiagnosticRecord[]): string {
  if (!records.length) return "";
  const rows = records.map(diagnosticValues);
  const keys = Object.keys(rows[0]) as (keyof typeof rows[number])[];
  const cell = (value: unknown) => {
    let text = value === null ? "" : String(value);
    if (/^[\s]*[=+\-@]/.test(text)) text = "'" + text;
    return '"' + text.replaceAll('"', '""') + '"';
  };
  return [keys.map(cell).join(","), ...rows.map(row => keys.map(key => cell(row[key])).join(","))].join("\r\n") + "\r\n";
}
