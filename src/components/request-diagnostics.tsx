"use client";
import { useState } from "react";
import { diagnosticValues, diagnosticsCsv, type DiagnosticRecord } from "@/lib/diagnostics";

export function exportDiagnostics(records: DiagnosticRecord[]) {
  const url = URL.createObjectURL(new Blob(["\uFEFF", diagnosticsCsv(records)], { type: "text/csv;charset=utf-8" }));
  const anchor = document.createElement("a");
  anchor.href = url; anchor.download = "request-diagnostics.csv";
  document.body.append(anchor); anchor.click(); anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function RequestDiagnostics({ record }: { record: DiagnosticRecord }) {
  const [copied, setCopied] = useState("");
  const values = diagnosticValues(record);
  const n = (value: number | null) => value === null ? "Unavailable" : value.toLocaleString();
  const rows: [string, string][] = [
    ["Input tokens before gateway trimming", n(values.input_tokens_before)],
    ["Input tokens sent to model", n(values.input_tokens_sent)],
    ["Tokens removed by gateway", n(values.removed_tokens)],
    ["Output budget", n(values.output_budget)], ["Safety reserve", n(values.safety_reserve)],
    ["Context budget", n(values.context_budget)], ["Unreserved space", n(values.unreserved_tokens)],
    ["Browser trimming", `${values.browser_trimmed_messages / 2} exchanges / ${values.browser_trimmed_messages} messages`],
    ["Gateway trimming", values.gateway_trimmed_messages === null ? "Unavailable" : `${values.gateway_trimmed_messages / 2} exchanges / ${values.gateway_trimmed_messages} messages`],
    ["Browser messages: before → sent", `${values.browser_messages_before} → ${values.browser_messages_sent}`],
    ["Browser JSON bytes: before → sent", `${n(values.browser_bytes_before)} → ${n(values.browser_bytes_sent)}`],
    ["Actual output tokens", n(values.actual_output_tokens)],
    ["vLLM-reported input tokens", n(values.actual_prompt_tokens)],
    ["Finish reason", values.finish_reason ?? "Unavailable"], ["Prefix reuse", values.prefix_reuse],
  ];
  async function copy() {
    try { await navigator.clipboard.writeText(JSON.stringify(values, null, 2)); setCopied("Copied"); }
    catch { setCopied("Copy failed. Use CSV export."); }
  }
  return <details className="request-diagnostics">
    <summary>Request diagnostics · {record.status}</summary>
    <p className="diagnostic-caption">Before/after counts include the system instructions and chat template. “Before” starts after browser trimming.</p>
    <dl>{rows.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
    {values.input_tokens_sent !== null && <p className="diagnostic-budget">{n(values.input_tokens_sent)} input + {n(values.output_budget)} output budget + {n(values.safety_reserve)} reserve = {n(values.input_tokens_sent + values.output_budget + values.safety_reserve)} / {n(values.context_budget)}</p>}
    {record.gateway?.inputTokensAfter === null && record.gateway.lastCountedInputTokens !== null && <p className="diagnostic-caption">Last tokenizer count: {n(record.gateway.lastCountedInputTokens)}. This input was not confirmed for generation.</p>}
    {values.input_tokens_sent !== null && values.actual_prompt_tokens !== null && values.input_tokens_sent !== values.actual_prompt_tokens && <p className="message-note error">Tokenizer and vLLM usage counts differ. Check the served template/configuration before comparing this run.</p>}
    <p className="diagnostic-caption">Request: {values.request_id} · Model: {values.model ?? "Unavailable"}. Prefix reuse is a policy setting, not a measured cache hit.</p>
    <div className="diagnostic-actions"><button type="button" onClick={copy}>Copy record</button><button type="button" onClick={() => exportDiagnostics([record])}>Export CSV</button><span role="status">{copied}</span></div>
  </details>;
}
