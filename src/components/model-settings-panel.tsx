"use client";
import { AdvancedSettings } from "./advanced-settings";
import { MODELS, type ModelId } from "@/lib/models";
import { SETTINGS_MAX, fitSettings, type ChatSettings, type ModelSettings } from "@/lib/chat-settings";
import type { Connection, ModelConnections } from "@/lib/model-status";

function statusLabel(connection: Connection) {
  if (connection.mode === "checking") return "Checking connection";
  if (connection.mode === "preview") return "Local preview";
  if (connection.mode === "unconfigured") return "Gateway connection not configured";
  return connection.ready ? "Ready" : "Unavailable or loading";
}

export function ModelSettingsPanel({ connections, preferences, busy, temperature, onTemperatureChange, diagnosticsEnabled, onDiagnosticsChange, onApply, onRefresh }: {
  connections: ModelConnections; preferences: ModelSettings; busy: boolean;
  temperature: number; onTemperatureChange: (value: number) => void;
  diagnosticsEnabled: Record<ModelId, boolean>; onDiagnosticsChange: (model: ModelId, enabled: boolean) => void;
  onApply: (model: ModelId, value: ChatSettings) => void; onRefresh: () => void;
}) {
  return <>
    <section className="model-connections" aria-labelledby="model-connections-heading">
      <div className="model-connections-heading"><h3 id="model-connections-heading">Model connections</h3><button type="button" onClick={onRefresh}>Refresh connections</button></div>
      <div className="model-status-grid">{MODELS.map(model => {
        const connection = connections[model.id];
        return <article className="model-status-card" aria-label={`${model.label} connection`} key={model.id}>
          <strong>{model.label}</strong>
          <p role="status"><span className={`status-dot ${connection.ready ? "ready" : ""}`}/>{statusLabel(connection)}</p>
          {connection.ready && connection.limits && <small>{connection.mode === "preview" ? "Preview context" : "Verified context"}: {connection.limits.contextTokens.toLocaleString()} tokens</small>}
          {connection.error && <small>{connection.error}</small>}
          {connection.mode === "unconfigured" && <small>This model needs its own server-side gateway configuration.</small>}
        </article>;
      })}</div>
    </section>
    <label className="setting-label" htmlFor="temperature">Creativity <span>{temperature.toFixed(1)}</span><input id="temperature" type="range" min="0" max="1.5" step="0.1" value={temperature} onChange={event => onTemperatureChange(Number(event.target.value))}/></label>
    <div className="model-settings-list">{MODELS.map(model => {
      const connection = connections[model.id];
      const currentLimits = connection.ready ? connection.limits : undefined;
      const verifiedLimits = currentLimits ?? connection.lastVerifiedLimits;
      const limits = verifiedLimits ?? SETTINGS_MAX;
      return <details className="model-settings-section" key={model.id}>
        <summary><strong>{model.label}</strong><span>Advanced settings</span></summary>
        <AdvancedSettings key={`${model.id}:${JSON.stringify(limits)}`} idPrefix={model.id}
          value={fitSettings(preferences[model.id], limits)} limits={limits}
          available={!!verifiedLimits} usingLastVerifiedLimits={!currentLimits && !!connection.lastVerifiedLimits}
          diagnosticsAvailable={connection.diagnosticsAvailable === true} diagnosticsEnabled={diagnosticsEnabled[model.id]}
          onDiagnosticsChange={enabled => onDiagnosticsChange(model.id, enabled)} preview={connection.mode === "preview"}
          busy={busy} onApply={value => onApply(model.id, value)}/>
      </details>;
    })}</div>
  </>;
}
