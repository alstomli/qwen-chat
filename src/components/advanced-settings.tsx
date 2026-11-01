"use client";
import { useState } from "react";
import { DEFAULT_SETTINGS, SETTING_FIELDS, SETTINGS_MIN, fitSettings, validateSettings, type ChatSettings } from "@/lib/chat-settings";

export function AdvancedSettings({ value, limits, available, preview, busy, onApply }: {
  value: ChatSettings; limits: ChatSettings; available: boolean; preview: boolean; busy: boolean; onApply: (settings: ChatSettings) => void;
}) {
  const [draft, setDraft] = useState(() => Object.fromEntries(SETTING_FIELDS.map(({ key }) => [key, String(value[key])])));
  const [error, setError] = useState("");
  function apply() {
    try {
      const next = validateSettings(Object.fromEntries(SETTING_FIELDS.map(({ key }) => [key, draft[key] === "" ? NaN : Number(draft[key])])), limits);
      onApply(next); setError("");
    } catch (error) { setError(error instanceof Error ? error.message : "Invalid settings."); }
  }
  function reset() {
    const next = fitSettings(DEFAULT_SETTINGS, limits);
    setDraft(Object.fromEntries(SETTING_FIELDS.map(({ key }) => [key, String(next[key])])));
    setError(""); onApply(next);
  }
  return <section className="advanced-settings" aria-labelledby="advanced-settings-heading">
    <h3 id="advanced-settings-heading">Advanced settings</h3>
    <p className="settings-help">Saved in this browser. Changes apply to your next request.</p>
    <p className="settings-help">{preview ? "Preview limits are shown below. A live connection will supply the running model’s context ceiling." : available ? <>Server context ceiling: <strong>{limits.contextTokens.toLocaleString()} tokens</strong>. Raising the server ceiling requires a vLLM restart.</> : "Connect to an updated gateway to verify server limits and apply settings."}</p>
    <fieldset disabled={busy || !available}>
      <div className="settings-grid">{SETTING_FIELDS.map(({ key, label, help }) => <label className="advanced-field" key={key} htmlFor={`setting-${key}`}>
        <span>{label}</span>
        <input id={`setting-${key}`} type="number" inputMode="numeric" min={SETTINGS_MIN[key]} max={limits[key]} step="1" value={draft[key]} aria-describedby={`help-${key}`} onChange={event => { setDraft(previous => ({ ...previous, [key]: event.target.value })); setError(""); }}/>
        <small id={`help-${key}`}>{help} Range: {SETTINGS_MIN[key].toLocaleString()}–{limits[key].toLocaleString()}.</small>
      </label>)}</div>
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="settings-actions"><button className="secondary-button" type="button" onClick={reset}>Reset defaults</button><button className="primary-button" type="button" onClick={apply}>Apply settings</button></div>
    </fieldset>
    {busy && <p className="settings-help">Stop the current reply before changing limits.</p>}
  </section>;
}
