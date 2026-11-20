import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ModelPicker } from "../src/components/model-picker";
import { initialModelConnections, updateModelConnection } from "../src/lib/model-status";
import { DEFAULT_MODEL } from "../src/lib/models";
import { SETTINGS_MAX } from "../src/lib/chat-settings";

const option = (html: string, value: string) => html.match(new RegExp(`<option[^>]*value="${value}"[^>]*>[^<]*</option>`))?.[0] ?? "";

test("new chats default to 4bit, and a model whose status says unavailable cannot be picked", () => {
  assert.equal(DEFAULT_MODEL, "4bit");
  let connections = updateModelConnection(initialModelConnections(), { model: "4bit", mode: "live", ready: true, limits: SETTINGS_MAX });
  connections = updateModelConnection(connections, { model: "bf16", mode: "live", ready: false, error: "The model is unavailable or still loading." });
  const html = renderToStaticMarkup(createElement(ModelPicker, { connections, value: DEFAULT_MODEL, disabled: false, onChange() {} }));
  assert.match(html, /aria-label="Model"/);
  assert.match(option(html, "4bit"), /Qwen3\.8-27B-4bit/); assert.doesNotMatch(option(html, "4bit"), /disabled/);
  assert.match(option(html, "4bit"), /selected/);
  assert.match(option(html, "bf16"), /disabled/); assert.match(option(html, "bf16"), /Qwen3\.8-27B-bf16 \(unavailable\)/);
});

test("a ready BF16 can be picked; a busy picker is disabled", () => {
  let connections = initialModelConnections();
  for (const model of ["4bit", "bf16"] as const) connections = updateModelConnection(connections, { model, mode: "live", ready: true, limits: SETTINGS_MAX });
  const html = renderToStaticMarkup(createElement(ModelPicker, { connections, value: "bf16", disabled: false, onChange() {} }));
  assert.doesNotMatch(option(html, "bf16"), /disabled/); assert.match(option(html, "bf16"), /selected/);
  assert.match(renderToStaticMarkup(createElement(ModelPicker, { connections, value: "4bit", disabled: true, onChange() {} })), /<select[^>]*disabled/);
});
