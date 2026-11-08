import { DEFAULT_MODEL, type ModelId } from "./models";
export const SETTINGS_KEY = "qwen-chat.settings.v1";
export const MODEL_SETTINGS_KEY = "qwen-chat.model-settings.v1";
export const DEFAULT_SETTINGS = {
  inputCharacters: 120000,
  outputTokens: 7680,
  contextTokens: 40960,
  historyMessages: 799,
  historyBytes: 580000,
  requestBytes: 640000,
  timeoutSeconds: 2400,
  safetyTokens: 32,
  reuseCachedPrefixes: true,
};
export type ChatSettings = typeof DEFAULT_SETTINGS;
export const SETTINGS_MAX: ChatSettings = { ...DEFAULT_SETTINGS, outputTokens: 10240, safetyTokens: 4096 };
export const SETTINGS_MIN: ChatSettings = {
  inputCharacters: 1, outputTokens: 128, contextTokens: 256, historyMessages: 1,
  historyBytes: 128, requestBytes: 1024, timeoutSeconds: 1, safetyTokens: 0,
  reuseCachedPrefixes: false,
};
type NumericSetting = Exclude<keyof ChatSettings, "reuseCachedPrefixes">;
export const SETTING_FIELDS: { key: NumericSetting; label: string; help: string }[] = [
  { key: "inputCharacters", label: "Input character limit", help: "Maximum length of your newest message." },
  { key: "outputTokens", label: "Output token budget", help: "Maximum tokens generated per reply." },
  { key: "contextTokens", label: "Context token budget", help: "Input + output + safety reserve must fit." },
  { key: "historyMessages", label: "History message limit", help: "Includes the new message; oldest full exchanges are removed first." },
  { key: "historyBytes", label: "History byte limit", help: "UTF-8 size of messages sent to the model gateway." },
  { key: "requestBytes", label: "Request byte limit", help: "Total request size, including settings. May further reduce history." },
  { key: "timeoutSeconds", label: "Generation timeout (seconds)", help: "Total time allowed for a request, including queue wait, prompt processing, and streaming." },
  { key: "safetyTokens", label: "Safety reserve (tokens)", help: "Extra context space kept free." },
];

export function validateSettings(value: unknown, limits: ChatSettings = SETTINGS_MAX): ChatSettings {
  if (value === undefined) return fitSettings(DEFAULT_SETTINGS, limits);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid chat settings.");
  const data = value as Record<string, unknown>;
  if (Object.keys(data).some(key => !Object.hasOwn(DEFAULT_SETTINGS, key))) throw new Error("Unknown chat setting.");
  const result = { ...DEFAULT_SETTINGS, ...data } as ChatSettings;
  if (typeof result.reuseCachedPrefixes !== "boolean") throw new Error("Reuse cached prefixes must be on or off.");
  if (!result.reuseCachedPrefixes && !limits.reuseCachedPrefixes) throw new Error("Update the gateway to control prefix reuse.");
  for (const { key, label } of SETTING_FIELDS) {
    if (!Number.isInteger(result[key]) || result[key] < SETTINGS_MIN[key] || result[key] > limits[key])
      throw new Error(`${label} must be between ${SETTINGS_MIN[key]} and ${limits[key]}.`);
  }
  if (result.outputTokens + result.safetyTokens >= result.contextTokens)
    throw new Error("Context budget must leave room for input after output and safety tokens.");
  return result;
}

/** Recover stored preferences and adapt them to the currently connected server. */
export function fitSettings(value: unknown, limits: ChatSettings = SETTINGS_MAX): ChatSettings {
  const data = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const result = { ...DEFAULT_SETTINGS };
  result.reuseCachedPrefixes = limits.reuseCachedPrefixes && typeof data.reuseCachedPrefixes === "boolean" ? data.reuseCachedPrefixes : true;
  for (const { key } of SETTING_FIELDS) {
    const candidate = data[key];
    result[key] = Math.max(SETTINGS_MIN[key], Math.min(limits[key], typeof candidate === "number" && Number.isInteger(candidate) ? candidate : DEFAULT_SETTINGS[key]));
  }
  result.safetyTokens = Math.min(result.safetyTokens, result.contextTokens - SETTINGS_MIN.outputTokens - 1);
  if (result.outputTokens + result.safetyTokens >= result.contextTokens) {
    // A smaller server must leave usable input space, not just one token.
    result.safetyTokens = Math.min(result.safetyTokens, Math.floor(result.contextTokens / 4));
    result.outputTokens = Math.max(SETTINGS_MIN.outputTokens, Math.floor((result.contextTokens - result.safetyTokens) / 2));
  }
  result.outputTokens = Math.min(result.outputTokens, result.contextTokens - result.safetyTokens - 1);
  return result;
}

export function parseSettings(raw: string | null): ChatSettings {
  try { return fitSettings(JSON.parse(raw ?? "null")); } catch { return { ...DEFAULT_SETTINGS }; }
}

export type ModelSettings = Record<ModelId, ChatSettings>;
export function parseModelSettings(raw: string | null, legacy: string | null): ModelSettings {
  let value;
  try { value = JSON.parse(raw ?? "null"); } catch { value = null; }
  return { "4bit": value?.["4bit"] ? fitSettings(value["4bit"]) : parseSettings(legacy),
    bf16: value?.bf16 ? fitSettings(value.bf16) : { ...DEFAULT_SETTINGS } };
}

export function parseServerLimits(value: unknown): ChatSettings {
  if (!value || typeof value !== "object") throw new Error("Gateway settings are unavailable. Update the gateway first.");
  const result = { ...SETTINGS_MAX };
  result.reuseCachedPrefixes = (value as Record<string, unknown>).reuseCachedPrefixes === true;
  for (const { key } of SETTING_FIELDS) {
    const candidate = (value as Record<string, unknown>)[key];
    if (typeof candidate !== "number" || !Number.isInteger(candidate) || candidate < SETTINGS_MIN[key]) throw new Error("Invalid gateway limits.");
    result[key] = Math.min(candidate, SETTINGS_MAX[key]);
  }
  return result;
}

export const jsonBytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;

/** Keep the default request compatible with gateways predating this option. */
export function gatewaySettings(settings: ChatSettings, limits: ChatSettings): Omit<ChatSettings, "reuseCachedPrefixes"> & { reuseCachedPrefixes?: boolean } {
  validateSettings(settings, limits);
  const { reuseCachedPrefixes, ...numeric } = settings;
  return limits.reuseCachedPrefixes ? settings : numeric;
}

export function fitMessages<T extends { role: string; content: string }>(
  messages: T[], settings: ChatSettings, temperature: number, model: ModelId = DEFAULT_MODEL, useAdapter?: boolean, image?: string, docsMode?: true,
): T[] {
  const result = [...messages];
  const requestOverhead = jsonBytes({ model, useAdapter, messages: [], max_tokens: settings.outputTokens, temperature, settings, image, docsMode, stream: true }) - 2;
  const oversized = () => {
    if (result.length > settings.historyMessages) return true;
    const bytes = jsonBytes(result);
    return bytes > settings.historyBytes || requestOverhead + bytes > settings.requestBytes;
  };
  while (result.length > 1 && oversized()) result.splice(0, 2);
  if (oversized()) throw new Error(image
    ? "Your prompt and image exceed the history or request byte limit. Try a smaller image, shorten the prompt, or raise the limit."
    : "Your newest message exceeds the history or request byte limit. Raise the limit or shorten the message.");
  return result;
}
