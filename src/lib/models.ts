export const MODELS = [
  { id: "4bit", label: "Qwen3.8-27B-4bit", alias: "qwen-4bit" },
  { id: "bf16", label: "Qwen3.8-27B-bf16", alias: "qwen-bf16" },
] as const;
export type ModelId = typeof MODELS[number]["id"];
/** New chats start here. */
export const DEFAULT_MODEL: ModelId = "4bit";
/** Stored conversations and answers saved without a model tag predate the 4-bit default. */
export const UNTAGGED_MODEL: ModelId = "bf16";
/** Only BF16 serves a trained adapter. */
export function hasAdapter(id: ModelId) { return id === "bf16"; }
export function isModelId(value: unknown): value is ModelId {
  return MODELS.some(model => model.id === value);
}
export function parseModelId(value: unknown): ModelId {
  if (value === undefined) return DEFAULT_MODEL;
  if (!isModelId(value)) throw new Error("Choose a supported model.");
  return value;
}
export function modelInfo(id: ModelId) { return MODELS.find(model => model.id === id)!; }
export function answerModelLabel(id: ModelId, useAdapter?: boolean) {
  if (id === "4bit") return "4-bit base";
  return typeof useAdapter === "boolean"
    ? useAdapter ? "BF16 + adapter" : "BF16 base" : modelInfo(id).label;
}
