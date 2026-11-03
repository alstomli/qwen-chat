export const MODELS = [
  { id: "4bit", label: "Qwen3.8-27B-4bit", alias: "qwen" },
  { id: "bf16", label: "Qwen3.8-27B-bf16", alias: "qwen-bf16" },
] as const;
export type ModelId = typeof MODELS[number]["id"];
export const DEFAULT_MODEL: ModelId = "4bit";
export function isModelId(value: unknown): value is ModelId {
  return MODELS.some(model => model.id === value);
}
export function parseModelId(value: unknown): ModelId {
  if (value === undefined) return DEFAULT_MODEL;
  if (!isModelId(value)) throw new Error("Choose a supported model.");
  return value;
}
export function modelInfo(id: ModelId) { return MODELS.find(model => model.id === id)!; }
