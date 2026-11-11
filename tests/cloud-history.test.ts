import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { CloudHistoryStore, cloudPayload, type HistoryEntry, type HistoryRpc, type SaveState } from '../src/lib/cloud-history';
import type { Conversation } from '../src/lib/storage';

type Reply = { data: unknown; error: unknown };
const deferred = <T>() => { let resolve!: (value: T) => void, reject!: (error: unknown) => void; const promise = new Promise<T>((yes,no) => { resolve=yes; reject=no; }); return {promise,resolve,reject}; };
const turn = async () => { for(let n=0;n<12;n++) await new Promise<void>(resolve=>setImmediate(resolve)); };
const usage = {bytes:200,count:1,maxBytes:2000000,maxCount:50,paused:false};
const chat = (id: string=randomUUID(),content='hello'): Conversation => ({id,title:content,updatedAt:Date.now(),messages:[{id:'user',role:'user',content}]});
const snapshot = (c:Conversation,revision=1,state:SaveState='saved'): HistoryEntry => ({chat:c,revision,state,loaded:true,createdAt:new Date().toISOString(),fingerprint:JSON.stringify(cloudPayload(c))});
function harness(rpc:HistoryRpc) {
  const records=new Map<string,string>(); const events:{changed:number;merges:unknown[];notices:string[]}={changed:0,merges:[],notices:[]};
  const storage={getItem:(key:string)=>records.get(key)??null,setItem:(key:string,value:string)=>{records.set(key,value);},removeItem:(key:string)=>{records.delete(key);}};
  const store=new CloudHistoryStore('qa:user:alice',storage,rpc,()=>events.changed++,(...args)=>events.merges.push(args),message=>events.notices.push(message));
  return {store,records,events,storage};
}

test('refresh begun before successful create cannot remove newly acknowledged conversation',async()=>{
  const save=deferred<Reply>(), list=deferred<Reply>();
  const {store}=harness(async name=>name==='save_chat'?save.promise:name==='list_chat_history'?list.promise:{data:usage,error:null});
  const c=chat(); store.stage(c); const refresh=store.refresh();
  save.resolve({data:{status:'saved',revision:1,evicted:[],usage},error:null}); await turn();
  list.resolve({data:[],error:null}); await refresh; await turn();
  assert.equal(store.entries.get(c.id)?.state,'saved'); assert.equal(store.entries.get(c.id)?.revision,1);
  store.dispose();
});

test('refresh begun before successful update cannot regress newer acknowledged revision',async()=>{
  const save=deferred<Reply>(), list=deferred<Reply>();
  const {store}=harness(async name=>name==='save_chat'?save.promise:name==='list_chat_history'?list.promise:{data:usage,error:null});
  const c=chat(); store.entries.set(c.id,snapshot(c,2)); const refresh=store.refresh(); store.stage(chat(c.id,'updated locally'));
  save.resolve({data:{status:'saved',revision:3,evicted:[],usage},error:null}); await turn();
  list.resolve({data:[{id:c.id,title:'stale cloud',updatedAt:1,revision:1,cursor:new Date().toISOString()}],error:null}); await refresh;
  assert.equal(store.entries.get(c.id)?.revision,3); assert.equal(store.entries.get(c.id)?.chat.title,'updated locally'); store.dispose();
});

test('refresh omission preserves every unsynced recovery state for export',async()=>{
  for(const state of ['oversized','conflict','deleted','expired','create_limited','local'] as SaveState[]) {
    const {store}=harness(async name=>({data:name==='list_chat_history'?[]:usage,error:null}));
    const c=chat(); store.entries.set(c.id,snapshot(c,1,state)); await store.refresh();
    assert.equal(store.entries.get(c.id)?.chat.messages[0].content,'hello',`${state} retained`); store.dispose();
  }
});

test('snapshot staged for earlier chat while later chat is saving is eventually flushed',async()=>{
  const calls:{args:Record<string,unknown>|undefined;response:ReturnType<typeof deferred<Reply>>}[]=[];
  const {store}=harness(async(name,args)=>{
    if(name!=='save_chat') return {data:usage,error:null};
    const response=deferred<Reply>(); calls.push({args,response}); return response.promise;
  });
  const a=chat(),b=chat(); store.entries.set(a.id,snapshot(a)); store.entries.set(b.id,snapshot(b));
  store.stage(chat(a.id,'a2')); store.stage(chat(b.id,'b2')); assert.equal(calls.length,1);
  calls[0].response.resolve({data:{status:'saved',revision:2,evicted:[],usage},error:null}); await turn();
  assert.equal(calls.length,2); assert.equal(calls[1].args?.p_id,b.id);
  store.stage(chat(a.id,'a3')); calls[1].response.resolve({data:{status:'saved',revision:2,evicted:[],usage},error:null}); await turn();
  assert.equal(calls.length,3); assert.equal(calls[2].args?.p_id,a.id);
  calls[2].response.resolve({data:{status:'saved',revision:3,evicted:[],usage},error:null}); await turn();
  assert.equal(store.entries.get(a.id)?.state,'saved'); assert.equal(store.entries.get(a.id)?.chat.title,'a3'); store.dispose();
});

test('dispose suppresses successful late RPC callbacks and preserves durable outbox',async()=>{
  const save=deferred<Reply>(); const {store,events,records}=harness(async()=>save.promise); store.stage(chat());
  const before=records.get('qa:user:alice'); store.dispose(); const changes=events.changed;
  save.resolve({data:{status:'saved',revision:1,evicted:[],usage},error:null}); await turn();
  assert.equal(records.get('qa:user:alice'),before); assert.equal(events.changed,changes); assert.equal(store.entries.size,0);
});

test('dispose suppresses failing late RPC callbacks and preserves durable outbox',async()=>{
  const save=deferred<Reply>(); const {store,events,records}=harness(async()=>save.promise); store.stage(chat());
  const before=records.get('qa:user:alice'); store.dispose(); const changes=events.changed;
  save.reject(new Error('network disconnected after account switch')); await turn();
  assert.equal(records.get('qa:user:alice'),before); assert.equal(events.changed,changes); assert.equal(store.entries.size,0);
});

test('restore preserves all local recovery entries beyond150 without automatic loss',async()=>{
  const {store,storage}=harness(async()=>({data:null,error:'offline'}));
  const entries=Array.from({length:175},()=>snapshot(chat(),0,'local'));
  storage.setItem('qa:user:alice',JSON.stringify(entries)); store.restore(); assert.equal(store.entries.size,175); store.dispose();
});

test('repeated sign-out disposal preserves local recovery and clears retry operations',async()=>{
  const pending=deferred<Reply>(); const {store,records}=harness(async()=>pending.promise); const c=chat();
  store.stage(c); store.dispose(true); const saved=records.get('qa:user:alice'); store.dispose(true);
  assert.equal(records.get('qa:user:alice'),saved);
  const rows=JSON.parse(saved!); assert.equal(rows[0].state,'local'); assert.equal(rows[0].operation,undefined);
  pending.reject(new Error('late network failure')); await turn(); assert.equal(records.get('qa:user:alice'),saved);
});

test('payload keeps terminal text and historical metadata but omits unfinished tokens and arbitrary data',async()=>{
  const c=chat(); c.messages.push({id:'stream',role:'assistant',content:'partial'}, {id:'answer',role:'assistant',content:'text',state:'error',note:'secret gateway URL',model:'bf16',useAdapter:false});
  (c as Conversation & {image:string}).image='base64-image';
  const payload=cloudPayload(c); assert.equal(payload.messages.length,2); assert.ok(!JSON.stringify(payload).includes('partial')); assert.ok(!JSON.stringify(payload).includes('secret gateway')); assert.ok(!JSON.stringify(payload).includes('base64-image'));
});

test('server eviction preserves an older chat with unsynced local recovery content',async()=>{
  const save=deferred<Reply>(); const {store}=harness(async()=>save.promise); const local=chat(undefined,'oversized local recovery');
  store.entries.set(local.id,snapshot(local,1,'oversized')); store.stage(chat());
  save.resolve({data:{status:'saved',revision:1,evicted:[local.id],usage},error:null}); await turn();
  assert.equal(store.entries.get(local.id)?.chat.messages[0].content,'oversized local recovery'); store.dispose();
});

test('message load started before newer refresh cannot regress observed revision',async()=>{
  const load=deferred<Reply>(); const c=chat(); let loads=0;
  const {store}=harness(async name=>name==='get_chat_history_v2'?(++loads===1?load.promise:{data:{payload:cloudPayload(chat(c.id,'revision3')),revision:3,totalMessages:1,updatedAt:3},error:null}):name==='list_chat_history'?{data:[{id:c.id,title:'revision3',updatedAt:3,revision:3,cursor:new Date().toISOString()}],error:null}:{data:usage,error:null});
  store.entries.set(c.id,{...snapshot(c,2),loaded:false});
  const pending=store.load(c.id); await store.refresh();
  assert.equal(store.entries.get(c.id)?.revision,3);
  load.resolve({data:{payload:cloudPayload(c),revision:2,totalMessages:1,updatedAt:2},error:null}); await pending;
  assert.equal(store.entries.get(c.id)?.revision,3); assert.equal(store.entries.get(c.id)?.chat.title,'revision3'); store.dispose();
});

test('stale refresh usage cannot replace newer successful save usage acknowledgement',async()=>{
  const save=deferred<Reply>(), list=deferred<Reply>(), oldUsage=deferred<Reply>();
  const {store}=harness(async name=>name==='save_chat'?save.promise:name==='list_chat_history'?list.promise:oldUsage.promise);
  const refresh=store.refresh(); store.stage(chat());
  save.resolve({data:{status:'saved',revision:1,evicted:[],usage},error:null}); await turn();
  assert.equal(store.usage.count,1);
  oldUsage.resolve({data:{...usage,count:0,bytes:0},error:null}); list.resolve({data:[],error:null}); await refresh;
  assert.equal(store.usage.count,1); store.dispose();
});

test('deleting an uncertain creation after sign-out removes its possible cloud copy without replaying content',async()=>{
  const pending=deferred<Reply>(); const original=harness(async()=>pending.promise); const c=chat();
  original.store.stage(c); original.store.dispose(true);
  const recovered=original.records.get('qa:user:alice'); assert.ok(recovered?.includes(c.id));
  const calls:string[]=[];
  const restored=harness(async name=>{ calls.push(name); return {data:{...usage,count:0,bytes:0},error:null}; });
  restored.storage.setItem('qa:user:alice',recovered!); restored.store.restore();
  assert.equal(restored.store.entries.get(c.id)?.revision,0);
  await restored.store.remove(c.id); await turn();
  assert.deepEqual(calls,['delete_chat']); assert.equal(restored.store.entries.has(c.id),false);
  pending.resolve({data:{status:'saved',revision:1,evicted:[],usage},error:null}); await turn();
  restored.store.dispose();
});

test('cloud load, later save and durable restore preserve older source metadata', async()=>{
  const sources=[{id:1,heading:'Idle timeout',url:'https://docs.runpod.io/serverless/endpoints/endpoint-configurations#idle-timeout'}];
  const c=chat(); c.messages[0].docsMode=true;
  c.messages.push({id:'answer',role:'assistant',content:'An older answer [1].',state:'complete',docsSources:sources});
  let saved:Record<string,unknown>|undefined;
  const {store,storage}=harness(async(name,args)=>{
    if(name==='get_chat_history_v2') return {data:{payload:cloudPayload(c),revision:1,totalMessages:2,updatedAt:c.updatedAt},error:null};
    if(name==='save_chat') {saved=args; return {data:{status:'saved',revision:2,evicted:[],usage},error:null};}
    return {data:usage,error:null};
  });
  store.entries.set(c.id,{...snapshot(c),loaded:false});
  const loaded=await store.load(c.id); assert.ok(loaded);
  assert.equal(loaded.messages[0].docsMode,true); assert.deepEqual(loaded.messages[1].docsSources,sources);
  store.stage({...loaded,title:'Continued older chat'}); await turn();
  const payload=saved?.p_payload as ReturnType<typeof cloudPayload>;
  assert.equal(payload.messages[0].docsMode,true); assert.deepEqual(payload.messages[1].docsSources,sources);
  const copy=storage.getItem('qa:user:alice'); store.dispose();
  const restored=harness(async()=>({data:null,error:'offline'}));
  restored.storage.setItem('qa:user:alice',copy!); restored.store.restore();
  assert.deepEqual(restored.store.entries.get(c.id)?.chat.messages[1].docsSources,sources);
  restored.store.dispose();
});

test('retired model cache entries and pending writes never restore or reach the cloud', async () => {
  let saves = 0;
  const { store, records } = harness(async name => { if (name === 'save_chat') saves++; return { data: usage, error: null }; });
  const retained = chat(); retained.model = 'bf16';
  const removed = { ...chat(), model: '4bit' } as unknown as Conversation;
  const legacyAnswer = { ...chat(), model: 'bf16', messages: [{ id: 'old', role: 'assistant', content: 'old', model: '4bit' }] } as unknown as Conversation;
  const pending = snapshot(chat());
  pending.operation = { id: randomUUID(), revision: 0, payload: { ...cloudPayload(pending.chat), model: '4bit' } as unknown as ReturnType<typeof cloudPayload> };
  records.set('qa:user:alice', JSON.stringify([snapshot(retained), snapshot(removed), snapshot(legacyAnswer), pending]));
  store.restore();
  assert.deepEqual([...store.entries.keys()], [retained.id]);
  store.stage(removed); store.stage(legacyAnswer); await turn();
  assert.equal(saves, 0); assert.equal(store.entries.size, 1); store.dispose();
});

test('retired cloud summaries and unsupported assistant metadata in later pages stay out of browser history', async () => {
  const supported = chat(); supported.model = 'bf16';
  const retired = { ...chat(), model: '4bit', revision: 1 };
  let pages = 0;
  const { store } = harness(async name => {
    if (name === 'list_chat_history') return { data: [retired, { ...supported, revision: 1 }], error: null };
    if (name !== 'get_chat_history_v2') return { data: usage, error: null };
    pages++;
    const messages = pages === 1 ? [{ id: 'u', role: 'user', content: 'question' }]
      : [{ id: 'a', role: 'assistant', content: 'retired answer', state: 'complete', model: '4bit' }];
    return { data: { payload: { title: supported.title, model: 'bf16', messages }, revision: 1, totalMessages: 2, updatedAt: 1 }, error: null };
  });
  await store.refresh(); assert.deepEqual([...store.entries.keys()], [supported.id]);
  assert.equal(await store.load(supported.id), null); assert.equal(pages, 2);
  assert.equal(store.entries.size, 0); store.dispose();
});

test('a rejected later history page cannot merge an earlier partial page into the workspace', async () => {
  const c = chat(); let pages = 0;
  const { store, events } = harness(async name => {
    assert.equal(name,'get_chat_history_v2'); pages++;
    if (pages === 2) return { data: null, error: { message: 'Reload Kiddo Chat to open reference-image edits' } };
    return { data: { payload: { title: c.title, messages: [{ id: 'u',role: 'user',content: 'first page' }] }, revision: 1,totalMessages: 2,updatedAt: 1 },error: null };
  });
  store.entries.set(c.id,{ ...snapshot(c),loaded: false,chat: { ...c,messages: [] } });
  await assert.rejects(store.load(c.id),/load this conversation/);
  assert.equal(pages,2); assert.equal(events.merges.length,0);
  assert.equal(store.entries.get(c.id)?.loaded,false); assert.deepEqual(store.entries.get(c.id)?.chat.messages,[]);
  store.dispose();
});
