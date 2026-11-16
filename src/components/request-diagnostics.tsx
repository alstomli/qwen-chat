"use client";
import { useState } from "react";
import { diagnosticValues, diagnosticsCsv, type DiagnosticRecord } from "@/lib/diagnostics";
import type { RequestTrace } from "@/lib/request-trace";

function TraceInspector({ trace }: { trace: RequestTrace }) {
  const [open, setOpen] = useState(false);
  function download() {
    const url = URL.createObjectURL(new Blob([JSON.stringify(trace, null, 2)], {type:"application/json"}));
    const anchor = document.createElement("a"); anchor.href=url; anchor.download=`request-trace-${trace.requestId}.json`;
    document.body.append(anchor);anchor.click();anchor.remove();setTimeout(() => URL.revokeObjectURL(url),1000);
  }
  return <details onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>Model request trace · {trace.evicted ? "evicted" : trace.complete ? "complete" : "incomplete"}</summary>
    <p className="diagnostic-caption">{trace.complete ? "All available records received." : `Incomplete: ${trace.reason || "stream ended or was stopped before completion"}.`} Text is rendered as plain text. Export may contain private conversation text.</p>
    <button type="button" onClick={download} disabled={trace.evicted}>Export trace JSON</button>
    {open && trace.partial && <details><summary>Received partial record (incomplete)</summary><pre style={{whiteSpace:"pre-wrap",overflowWrap:"anywhere"}}>{trace.partial}</pre></details>}
    {open && [...new Set(trace.records.map(record => record.phase))].map(phase => <details key={phase}>
      <summary>{phase}</summary>
      {trace.records.filter(record => record.phase === phase && record.kind === "request").map((record,index) => {
        const sent = record.payload.sent as Record<string,unknown>;
        const messages = sent.messages as {role:string;content:unknown;tool_calls?:unknown}[];
        return <div key={index}>
          {messages.map((message,i) => <details key={i}><summary>{i+1}. {message.role}</summary><pre style={{whiteSpace:"pre-wrap",overflowWrap:"anywhere"}}>{typeof message.content === "string" ? message.content : JSON.stringify(message.content,null,2)}{message.tool_calls ? `\n${JSON.stringify(message.tool_calls,null,2)}` : ""}</pre></details>)}
          <details><summary>Tools, model and effective settings</summary><pre style={{whiteSpace:"pre-wrap",overflowWrap:"anywhere"}}>{JSON.stringify({...record.payload,sent:{...sent,messages:undefined}},null,2)}</pre></details>
        </div>;
      })}
      <details><summary>Response, tool results and failures</summary><pre style={{whiteSpace:"pre-wrap",overflowWrap:"anywhere"}}>{JSON.stringify(trace.records.filter(record => record.phase === phase && record.kind !== "request"),null,2)}</pre></details>
    </details>)}
  </details>;
}

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
  const ms = (value: number | null) => value === null ? "Unavailable" : `${value.toLocaleString(undefined, { maximumFractionDigits: 1 })} ms`;
  const rows: [string, string][] = [
    ["Send → first content received", ms(values.browser_first_content_ms)],
    ["Send → first answer rendered (paint estimate)", ms(values.browser_first_render_ms)],
    ["Send → response completed", ms(values.browser_completion_ms)],
    ["Send → request ended (including stop/error)", ms(values.browser_elapsed_ms)],
    ["Gateway context fitting", ms(values.gateway_context_fit_ms)],
    ["Upstream request → first content at gateway", ms(values.gateway_upstream_first_content_ms)],
    ["Gateway entry → first content", ms(values.gateway_first_content_ms)],
    ["Gateway entry → stream end", ms(values.gateway_total_ms)],
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
    {record.trace ? <TraceInspector trace={record.trace}/> : <p className="diagnostic-caption">Full trace unavailable or not yet received.</p>}
    {values.selected_model && <p className="diagnostic-caption">{values.selected_model}</p>}
    <p className="diagnostic-caption">Before/after counts include the system instructions and chat template. “Before” starts after browser trimming.</p>
    <p className="diagnostic-caption">Browser timings start at Send; gateway timings use its own clock. First render is estimated after committed answer content and a visible paint opportunity, not an exact display timestamp. Gateway timings arrive at stream end and may be unavailable after cancellation. Use Grafana for engine TTFT and ITL; these durations have different boundaries.</p>
    <dl>{rows.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
    {values.input_tokens_sent !== null && <p className="diagnostic-budget">{n(values.input_tokens_sent)} input + {n(values.output_budget)} output budget + {n(values.safety_reserve)} reserve = {n(values.input_tokens_sent + values.output_budget + values.safety_reserve)} / {n(values.context_budget)}</p>}
    {record.gateway?.inputTokensAfter === null && record.gateway.lastCountedInputTokens !== null && <p className="diagnostic-caption">Last tokenizer count: {n(record.gateway.lastCountedInputTokens)}. This input was not confirmed for generation.</p>}
    {values.input_tokens_sent !== null && values.actual_prompt_tokens !== null && values.input_tokens_sent !== values.actual_prompt_tokens && <p className="message-note error">Tokenizer and vLLM usage counts differ. Check the served template/configuration before comparing this run.</p>}
    <p className="diagnostic-caption">Request: {values.request_id} · Model: {values.model ?? "Unavailable"}. Prefix reuse is a policy setting, not a measured cache hit.</p>
    <div className="diagnostic-actions"><button type="button" onClick={copy}>Copy record</button><button type="button" onClick={() => exportDiagnostics([record])}>Export CSV</button><span role="status">{copied}</span></div>
  </details>;
}
