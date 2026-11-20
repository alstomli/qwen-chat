"use client";
import { ChevronDown } from "lucide-react";
import { MODELS, type ModelId } from "@/lib/models";
import type { ModelConnections } from "@/lib/model-status";

/** Picks the model for a new chat; models whose status polling says they are unavailable cannot be picked. */
export function ModelPicker({ connections, value, disabled, onChange }: {
  connections: ModelConnections; value: ModelId; disabled: boolean; onChange: (model: ModelId) => void;
}) {
  return <label className="model-picker"><span className="sr-only">Model</span>
    <select aria-label="Model" value={value} disabled={disabled} onChange={event => onChange(event.target.value as ModelId)}>
      {MODELS.map(model => {
        const available = connections[model.id].ready;
        return <option key={model.id} value={model.id} disabled={!available}>{model.label}{available ? "" : " (unavailable)"}</option>;
      })}
    </select>
    <ChevronDown size={14} aria-hidden="true"/>
  </label>;
}
