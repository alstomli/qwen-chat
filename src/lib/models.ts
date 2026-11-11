export const MODELS = [
  { id: "bf16", label: "Qwen3.8-27B-bf16", alias: "qwen-bf16" },
] as const;
export type ModelId = typeof MODELS[number]["id"];
export const DEFAULT_MODEL: ModelId = "bf16";
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
  return typeof useAdapter === "boolean"
    ? useAdapter ? "BF16 + adapter" : "BF16 base" : modelInfo(id).label;
}
