import { DEFAULT_SETTINGS, SETTINGS_MAX, fitSettings, type ChatSettings } from "./chat-settings";
import type { ModelId } from "./models";

/** Call with the ID returned by verified server authentication, never request metadata. */
export function canUseAdvancedSettings(userId: string) {
  return userId === "71fd4edb-4aeb-472c-a96b-3b2fdeb4f285"
    || userId === "d06b78ab-e282-4760-8698-884ec5b5fc85";
}

export function settingsForAccess(value: unknown, allowed: boolean, limits: ChatSettings = SETTINGS_MAX) {
  return fitSettings(allowed ? value : DEFAULT_SETTINGS, limits);
}

/** Stored conversations describe past requests; their adapter flag cannot grant access. */
export function adapterForAccess(model: ModelId, value: boolean | undefined, allowed: boolean) {
  return model === "bf16" ? allowed ? value : false : undefined;
}

/** Replace restricted fields before validation, including legacy max_tokens overrides. */
export function inputForAccess(value: unknown, allowed: boolean, limits: ChatSettings = SETTINGS_MAX): unknown {
  if (allowed || !value || typeof value !== "object" || Array.isArray(value)) return value;
  const data = value as Record<string, unknown>;
  const settings = settingsForAccess(undefined, false, limits);
  return { ...data, settings, max_tokens: settings.outputTokens,
    useAdapter: data.model === "bf16" ? false : undefined };
}
