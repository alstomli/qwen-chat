/** Each profile has its own gateway settings; only BF16 serves a trained adapter. */
export const MODELS = [
  { id: "4bit", label: "Qwen3.8-27B-4bit", alias: "qwen-4bit", gatewayEnv: "RUNPOD_4BIT_CHAT", baseLabel: "4-bit base", adapter: false },
  { id: "bf16", label: "Qwen3.8-27B-bf16", alias: "qwen-bf16", gatewayEnv: "RUNPOD_BF16_CHAT", baseLabel: "BF16 base", adapter: true },
] as const;
export type ModelId = typeof MODELS[number]["id"];
/** New chats start here. */
export const DEFAULT_MODEL: ModelId = "4bit";
/** Stored conversations and answers saved without a model tag predate the 4-bit default. */
export const UNTAGGED_MODEL: ModelId = "bf16";
export function isModelId(value: unknown): value is ModelId {
  return MODELS.some(model => model.id === value);
}
export function parseModelId(value: unknown): ModelId {
  if (value === undefined) return DEFAULT_MODEL;
  if (!isModelId(value)) throw new Error("Choose a supported model.");
  return value;
}
export function modelInfo(id: ModelId) { return MODELS.find(model => model.id === id)!; }
export function hasAdapter(id: ModelId) { return modelInfo(id).adapter; }
/** One value per model, e.g. per-model settings or flags. */
export function perModel<T>(value: (id: ModelId) => T): Record<ModelId, T> {
  return Object.fromEntries(MODELS.map(({ id }) => [id, value(id)])) as Record<ModelId, T>;
}
export function answerModelLabel(id: ModelId, useAdapter?: boolean) {
  if (!hasAdapter(id)) return modelInfo(id).baseLabel;
  return typeof useAdapter === "boolean"
    ? useAdapter ? "BF16 + adapter" : modelInfo(id).baseLabel : modelInfo(id).label;
}
