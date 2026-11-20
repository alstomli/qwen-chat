import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ModelSettingsPanel } from "../src/components/model-settings-panel";
import { allModelStatusRequests, initialModelConnections, updateModelConnection, type Connection } from "../src/lib/model-status";
import { DEFAULT_SETTINGS, SETTINGS_MAX, type ModelSettings } from "../src/lib/chat-settings";

function renderPanel(connections = initialModelConnections(), preferences: ModelSettings = { "4bit": { ...DEFAULT_SETTINGS }, bf16: { ...DEFAULT_SETTINGS } }, options: Partial<Parameters<typeof ModelSettingsPanel>[0]> = {}) {
  return renderToStaticMarkup(createElement(ModelSettingsPanel, {
    canUseAdvancedSettings: true, connections, preferences, busy: false, temperature: 0.7, onTemperatureChange() {},
    diagnosticsEnabled: { "4bit": false, bf16: false }, onDiagnosticsChange() {}, onApply() {}, onRefresh() {},
    selectedModel: "bf16", selectedAdapter: true, adapterBusy: false, onAdapterChange() {}, ...options,
  }));
}

test("normal accounts see connections and creativity without advanced controls even with stale capability flags", () => {
  let connections = initialModelConnections();
  for (const model of ["4bit", "bf16"] as const) connections = updateModelConnection(connections,
    { model, mode: "live", ready: true, limits: SETTINGS_MAX, diagnosticsAvailable: true, adapterToggleAvailable: true });
  const html = renderPanel(connections, undefined, { canUseAdvancedSettings: false,
    diagnosticsEnabled: { "4bit": true, bf16: true }, selectedAdapter: true });
  assert.match(html, /Model connections/); assert.match(html, /Qwen3\.8-27B-4bit connection/); assert.match(html, /Qwen3\.8-27B-bf16 connection/); assert.match(html, /Creativity/);
  assert.doesNotMatch(html, /<details|Advanced settings|Use trained adapter|Reuse cached prefixes|Request diagnostics|Apply settings|Reset defaults|setting-outputTokens/);
});

test("the adapter control belongs only to BF16 Advanced settings and respects selection, readiness and busy state", () => {
  let connections = initialModelConnections();
  for (const model of ["4bit", "bf16"] as const)
    connections = updateModelConnection(connections, { model, mode: "live", ready: true, limits: SETTINGS_MAX, adapterToggleAvailable: true });
  const html = renderPanel(connections);
  assert.equal((html.match(/aria-label="Use trained adapter"/g) ?? []).length, 1);
  const sections = html.split('<details class="model-settings-section">').slice(1);
  assert.equal(sections.length, 2);
  assert.match(sections[0], /Qwen3\.8-27B-4bit/); assert.doesNotMatch(sections[0], /adapter/i);
  assert.match(sections[1], /Advanced settings/);
  assert.match(sections[1], /aria-label="Use trained adapter"[^>]*checked/);
  assert.doesNotMatch(sections[1].match(/<input[^>]*aria-label="Use trained adapter"[^>]*>/)?.[0] ?? "", /disabled/);
  for (const options of [{ adapterBusy: true }, { selectedModel: "4bit" as const }]) {
    assert.match(renderPanel(connections, undefined, options).match(/<input[^>]*aria-label="Use trained adapter"[^>]*>/)?.[0] ?? "", /disabled/);
  }
  connections = updateModelConnection(connections, { model: "bf16", mode: "live", ready: false });
  assert.match(renderPanel(connections).match(/<input[^>]*aria-label="Use trained adapter"[^>]*>/)?.[0] ?? "", /disabled/);
});

test("each model's settings have unique associated input IDs and verified caps", () => {
  let connections = initialModelConnections();
  connections = updateModelConnection(connections, { model: "bf16", mode: "live", ready: true, limits: SETTINGS_MAX, diagnosticsAvailable: true });
  const html = renderPanel(connections, { "4bit": { ...DEFAULT_SETTINGS, outputTokens: 128 }, bf16: { ...DEFAULT_SETTINGS, outputTokens: 256 } });
  assert.equal((html.match(/<details/g) ?? []).length, 2);
  assert.match(html, /Qwen3\.8-27B-bf16 connection/);
  assert.match(html, /id="bf16-setting-outputTokens"[^>]*value="256"/);
  assert.match(html, /id="4bit-setting-outputTokens"[^>]*value="128"/);
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
  assert.equal(new Set(ids).size, ids.length);
  for (const match of html.matchAll(/\bfor="([^"]+)"/g)) assert.ok(ids.includes(match[1]), `Unassociated label: ${match[1]}`);
  for (const match of html.matchAll(/aria-describedby="([^"]+)"/g)) assert.ok(ids.includes(match[1]), `Missing help: ${match[1]}`);
  assert.equal((html.match(/Apply settings/g) ?? []).length, 2); assert.equal((html.match(/Reset defaults/g) ?? []).length, 2);
  assert.equal((html.match(/Verified context/g) ?? []).length, 1);
});

test("unconfigured BF16 disables settings without inventing verified limits", () => {
  let connections = initialModelConnections();
  assert.deepEqual(Object.keys(connections), ["4bit", "bf16"]);
  connections = updateModelConnection(connections, { model: "bf16", mode: "unconfigured", ready: false, limits: SETTINGS_MAX });
  const html = renderPanel(connections);
  assert.match(html, /Gateway connection not configured/);
  assert.equal((html.match(/Verified context/g) ?? []).length, 0);
  assert.equal((html.match(/<fieldset disabled/g) ?? []).length, 2);
  assert.equal(connections.bf16.lastVerifiedLimits, undefined);
});

test("temporary outage retains only that model's own last verified limits with honest labels", () => {
  let connections = initialModelConnections();
  connections = updateModelConnection(connections, { model: "bf16", mode: "live", ready: true, limits: { ...SETTINGS_MAX, contextTokens: 4096 } });
  connections = updateModelConnection(connections, { model: "bf16", mode: "live", ready: false });
  assert.equal(connections.bf16.lastVerifiedLimits?.contextTokens, 4096);
  const html = renderPanel(connections);
  assert.match(html, /Unavailable or loading/); assert.match(html, /Using last verified limits/);
  assert.equal((html.match(/<fieldset disabled/g) ?? []).length, 1);
});

test("status refresh requests each model separately", async () => {
  const pending: { url: string; resolve: (response: Response) => void }[] = []; const received: Connection[] = [];
  const fetcher = ((input: unknown) => new Promise<Response>(resolve => pending.push({ url: String(input), resolve }))) as typeof fetch;
  const requests = allModelStatusRequests(value => received.push(value), () => {}, fetcher);
  const refresh = requests.refresh();
  assert.deepEqual(pending.map(p => p.url), ["/api/status?model=4bit", "/api/status?model=bf16"]);
  pending[0].resolve(Response.json({ model: "4bit", mode: "live", ready: true, limits: SETTINGS_MAX }));
  pending[1].resolve(Response.json({ model: "bf16", mode: "live", ready: false, error: "The model is unavailable or still loading." })); await refresh;
  assert.deepEqual(received.map(r => [r.model, r.ready]), [["4bit", true], ["bf16", false]]);
  requests.dispose();
});
