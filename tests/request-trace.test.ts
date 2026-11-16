import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { MAX_TRACE_BYTES, parseFailureTrace, traceEventReader, validatedTraceStream, type TraceEntry, type TraceUpdate } from "../src/lib/request-trace";
import { retainDiagnostics, type DiagnosticRecord } from "../src/lib/diagnostics";
import { consumeCompletion } from "../src/lib/protocol";
import { validatedWebStream } from "../src/lib/web-search";
const id = "a".repeat(32), encoder = new TextEncoder();
const request = (text: string): TraceEntry => ({phase:"Planning 1",kind:"request",payload:{sent:{model:"synthetic",messages:[{role:"system",content:"synthetic instructions"},{role:"user",content:text},{role:"assistant",content:null,tool_calls:[{id:"call1",type:"function",function:{name:"search_web",arguments:'{"query":"synthetic"}'}}]},{role:"tool",content:"synthetic evidence"}],max_tokens:2048,temperature:0.7,stream:false},effective:{useAdapter:false,settings:{outputTokens:7680},reuseCachedPrefixes:true}}});
function frames(record: TraceEntry, start = 1) {
  const raw = JSON.stringify(record); const chunks: string[] = []; let pending="",size=0;
  for (const c of raw) { const n=encoder.encode(c).length;if(size+n>4096){chunks.push(pending);pending="";size=0}pending+=c;size+=n; }if(pending)chunks.push(pending);
  return chunks.map((data,i)=>`event: chat-trace\ndata: ${JSON.stringify({version:1,requestId:id,sequence:start+i,record:1,data,last:i===chunks.length-1})}\n\n`);
}
const end = (sequence:number) => `event: chat-trace-end\ndata: ${JSON.stringify({version:1,requestId:id,sequence,records:1,complete:true,reason:""})}\n\n`;
const stream = (text:string) => new ReadableStream<Uint8Array>({start(c){c.enqueue(encoder.encode(text));c.close()}});
test("large Unicode coalesced trace passes both boundaries losslessly with roles and JSON export",async()=>{
  const expected=request("雪🏓<script>alert(1)</script>".repeat(28000)); const chunks=frames(expected);
  const text=chunks.join("")+end(chunks.length+1)+'data: [DONE]\n\n';
  const updates: TraceUpdate[]=[];let answer="";
  await consumeCompletion(validatedTraceStream(stream(text),id),s=>answer+=s,undefined,undefined,undefined,undefined,{requestId:id,onUpdate:u=>updates.push(u)});
  assert.equal(answer,"");assert.deepEqual(updates[0],{entry:expected,bytes:encoder.encode(JSON.stringify(expected)).length+JSON.stringify(expected).length*2});
  assert.equal(JSON.parse(JSON.stringify(updates[0])).entry.payload.sent.messages[3].role,"tool");assert.deepEqual(updates[1],{complete:true,reason:""});
});
test("trace rejects unsolicited, cross-request, duplicate, malformed and hidden fields before forwarding",async()=>{
  const good=frames(request("synthetic")).join("");
  for(const text of [good.replace(id,"b".repeat(32)),good.replace('"sequence":1','"sequence":2'),good.replace('\\"model\\":\\"synthetic\\"','\\"authorization\\":\\"secret\\"')]){
    await assert.rejects(new Response(validatedTraceStream(stream(text),id)).text());
  }
  await assert.rejects(new Response(validatedTraceStream(stream(good))).text());
  await assert.rejects(consumeCompletion(stream(good),()=>{}));
  const malformed={phase:"Chat",kind:"request",payload:{sent:{}}} as TraceEntry;
  await assert.rejects(new Response(validatedTraceStream(stream(frames(malformed).join("")),id)).text());
  const reader=validatedTraceStream(stream(frames(request("x".repeat(9000))).slice(0,1).join("")),id).getReader();
  await assert.rejects(reader.read(),/Incomplete/); // Unvalidated partial record never leaves the server.
});
test("browser preserves received partial chunks explicitly on interruption",async()=>{
  const updates:TraceUpdate[]=[];const chunks=frames(request("雪🏓".repeat(5000)));
  await assert.rejects(consumeCompletion(stream(chunks[0]),()=>{},undefined,undefined,undefined,undefined,{requestId:id,onUpdate:u=>updates.push(u)}));
  assert.ok("partial" in updates[0]);assert.match((updates[0] as {partial:string}).partial,/Planning 1/);
});
test("failure carriers preserve exact prompts with bounded expected IDs and no private fields",()=>{
  const value={version:1,requestId:id,records:[request("synthetic")],complete:false,reason:"upstream_failure"};
  assert.deepEqual(parseFailureTrace(value,id).records,value.records);
  assert.throws(()=>parseFailureTrace(value,"b".repeat(32)));
  assert.throws(()=>parseFailureTrace({...value,records:[{...request("synthetic"),payload:{sent:{reasoning_content:"private"}}}]},id));
  const reader=traceEventReader(id); assert.throws(()=>reader.read("chat-trace",{version:1,requestId:id,sequence:1,record:1,data:"x".repeat(4097),last:false}));
  assert.equal(MAX_TRACE_BYTES,33554432);
});
test("trace retention clears evicted partial text and never enters summary CSV or chat storage",()=>{
  const records=Array.from({length:9},(_,i)=>({id:String(i),trace:{version:1,requestId:id,records:[request("private sentinel")],partial:"private partial",bytes:10,complete:false,reason:"incomplete"}} as DiagnosticRecord));
  const kept=retainDiagnostics(records);assert.equal(kept[0].trace?.evicted,true);assert.deepEqual(kept[0].trace?.records,[]);assert.equal(kept[0].trace?.partial,undefined);
  const workspace=readFileSync(new URL("../src/components/chat-workspace.tsx",import.meta.url),"utf8");
  assert.match(workspace,/useState\(false\);\s*const \[streamingChats/);assert.match(workspace,/active.useAdapter \?\? false/);assert.match(workspace,/setDraftAdapter\(false\)/);
  assert.doesNotMatch(workspace,/localStorage\.setItem\([^\n]*diagnosticRecords/);
});
test("web validator drains coalesced complete frames before applying pending frame cap",async()=>{
 const status='event: web-status\ndata: {"version":1,"runId":"run","sequence":1,"status":"planning"}\n\n';
 const done='event: web-complete\ndata: {"version":1,"runId":"run","sequence":2,"outcome":"completed"}\n\n';
 const text=status+('data: {"choices":[{"delta":{"content":"'+"x".repeat(1000)+'"}}]}\n\n').repeat(400)+done+'data: [DONE]\n\n';
 assert.equal(await new Response(validatedWebStream(stream(text))).text(),text);
});
