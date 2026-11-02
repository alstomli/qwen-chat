"use client";
import { useState } from "react";
import { DEFAULT_SETTINGS, SETTING_FIELDS, SETTINGS_MIN, fitSettings, validateSettings, type ChatSettings } from "@/lib/chat-settings";

export function AdvancedSettings({ value, limits, available, preview, busy, onApply, diagnosticsAvailable, diagnosticsEnabled, onDiagnosticsChange }: {
  value: ChatSettings; limits: ChatSettings; available: boolean; preview: boolean; busy: boolean; onApply: (settings: ChatSettings) => void;
  diagnosticsAvailable: boolean; diagnosticsEnabled: boolean; onDiagnosticsChange: (enabled: boolean) => void;
}) {
  const [draft, setDraft] = useState(() => Object.fromEntries(SETTING_FIELDS.map(({ key }) => [key, String(value[key])])));
  const [error, setError] = useState("");
  const [reuseCachedPrefixes, setReuseCachedPrefixes] = useState(value.reuseCachedPrefixes);
  function apply() {
    try {
      const next = validateSettings({ ...Object.fromEntries(SETTING_FIELDS.map(({ key }) => [key, draft[key] === "" ? NaN : Number(draft[key])])), reuseCachedPrefixes }, limits);
      onApply(next); setError("");
    } catch (error) { setError(error instanceof Error ? error.message : "Invalid settings."); }
  }
  function reset() {
    const next = fitSettings(DEFAULT_SETTINGS, limits);
    setReuseCachedPrefixes(next.reuseCachedPrefixes);
    setDraft(Object.fromEntries(SETTING_FIELDS.map(({ key }) => [key, String(next[key])])));
    setError(""); onApply(next);
  }
  return <section className="advanced-settings" aria-labelledby="advanced-settings-heading">
    <h3 id="advanced-settings-heading">Advanced settings</h3>
    {diagnosticsAvailable && <div>
      <label className="prefix-cache-setting" htmlFor="request-diagnostics"><input id="request-diagnostics" type="checkbox" role="switch" checked={diagnosticsEnabled} disabled={busy} onChange={event => onDiagnosticsChange(event.target.checked)}/><span>Request diagnostics</span></label>
      <p className="settings-help">Collect token counts for new requests in this session. Records contain no prompts or answers and are saved to a file only when you export.</p>
    </div>}
    <p className="settings-help">Saved in this browser. Changes apply to your next request.</p>
    <p className="settings-help">{preview ? "Preview limits are shown below. A live connection will supply the running model’s context ceiling." : available ? <>Server context ceiling: <strong>{limits.contextTokens.toLocaleString()} tokens</strong>. Raising the server ceiling requires a vLLM restart.</> : "Connect to an updated gateway to verify server limits and apply settings."}</p>
    <fieldset disabled={busy || !available}>
      <label className="prefix-cache-setting" htmlFor="reuse-cached-prefixes">
        <input id="reuse-cached-prefixes" type="checkbox" role="switch" checked={reuseCachedPrefixes} disabled={!limits.reuseCachedPrefixes} aria-describedby="prefix-cache-help" onChange={event => { setReuseCachedPrefixes(event.target.checked); setError(""); }}/>
        <span>Reuse cached prefixes</span>
      </label>
      <p id="prefix-cache-help" className="settings-help">Reuse earlier prompt processing for faster replies. Off recomputes the prompt for each request; it does not free reserved GPU memory.{!limits.reuseCachedPrefixes && " Update the gateway to change this setting."}</p>
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
