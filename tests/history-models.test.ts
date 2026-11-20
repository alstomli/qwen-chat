import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { CloudHistoryStore, cloudPayload, type HistoryRpc } from "../src/lib/cloud-history";
import { parseConversations, type Conversation } from "../src/lib/storage";

const turn = async () => { for (let n = 0; n < 12; n++) await new Promise<void>(resolve => setImmediate(resolve)); };
const usage = { bytes: 200, count: 1, maxBytes: 2000000, maxCount: 50, paused: false };
const fourBitChat = (): Conversation => ({ id: randomUUID(), title: "4-bit chat", updatedAt: 1, model: "4bit", messages: [
  { id: "u", role: "user", content: "question" },
  { id: "a", role: "assistant", content: "answer", state: "complete", model: "4bit" },
] });
function harness(rpc: HistoryRpc) {
  const records = new Map<string, string>(); const merges: Conversation[][] = [];
  const storage = { getItem: (key: string) => records.get(key) ?? null, setItem: (key: string, value: string) => { records.set(key, value); }, removeItem: (key: string) => { records.delete(key); } };
  const store = new CloudHistoryStore("qa:user:alice", storage, rpc, () => {}, chats => merges.push(chats), () => {});
  return { store, records, storage, merges };
}

test("a 4bit conversation round-trips through local history", () => {
  const chat = fourBitChat();
  const [loaded] = parseConversations(JSON.stringify([chat]));
  assert.equal(loaded.model, "4bit");
  assert.equal(loaded.messages[1].model, "4bit");
});

test("a conversation or answer saved without a model tag loads as bf16", () => {
  const legacy = { id: "old", title: "old", updatedAt: 1, messages: [
    { id: "u", role: "user", content: "question" },
    { id: "a", role: "assistant", content: "answer", state: "complete" },
  ] };
  const [loaded] = parseConversations(JSON.stringify([legacy]));
  assert.equal(loaded.model, "bf16");
  assert.equal(loaded.messages[1].model, "bf16");
});

test("a 4bit conversation saves to cloud history, survives a cache restore and loads back as 4bit", async () => {
  const saved: unknown[] = [];
  const { store, records, storage } = harness(async (name, args) => {
    if (name === "save_chat_v2") { saved.push(args!.p_payload); return { data: { status: "saved", revision: 1, evicted: [], usage }, error: null }; }
    return { data: usage, error: null };
  });
  const chat = fourBitChat();
  assert.equal(cloudPayload(chat).model, "4bit");
  store.stage(chat); await turn();
  assert.equal(saved.length, 1);
  const payload = saved[0] as ReturnType<typeof cloudPayload>;
  assert.equal(payload.model, "4bit"); assert.equal(payload.messages[1].model, "4bit");
  assert.equal(store.entries.get(chat.id)?.state, "saved");
  store.dispose();

  const restored = new CloudHistoryStore("qa:user:alice", storage, async () => ({ data: null, error: "offline" }), () => {}, () => {}, () => {});
  assert.ok(records.get("qa:user:alice")); restored.restore();
  assert.equal(restored.entries.get(chat.id)?.chat.model, "4bit");
  restored.dispose();

  const remote = harness(async name => {
    if (name === "list_chat_history") return { data: [{ id: chat.id, title: chat.title, updatedAt: 1, model: "4bit", revision: 1, cursor: new Date().toISOString() }], error: null };
    if (name === "get_chat_history_v2") return { data: { payload, revision: 1, totalMessages: 2, updatedAt: 1 }, error: null };
    return { data: usage, error: null };
  });
  await remote.store.refresh();
  assert.equal(remote.store.entries.get(chat.id)?.chat.model, "4bit", "earlier AWQ-era 4bit rows appear again");
  const loaded = await remote.store.load(chat.id);
  assert.equal(loaded?.model, "4bit"); assert.equal(loaded?.messages[1].model, "4bit");
  remote.store.dispose();
});

test("a cloud conversation saved without a model tag loads as bf16 from listings, pages and the cache", async () => {
  const id = randomUUID();
  const payload = { title: "old", messages: [{ id: "u", role: "user", content: "q" }, { id: "a", role: "assistant", content: "a", state: "complete" }] };
  const { store, storage } = harness(async name => {
    if (name === "list_chat_history") return { data: [{ id, title: "old", updatedAt: 1, revision: 1, cursor: new Date().toISOString() }], error: null };
    if (name === "get_chat_history_v2") return { data: { payload, revision: 1, totalMessages: 2, updatedAt: 1 }, error: null };
    return { data: usage, error: null };
  });
  await store.refresh();
  assert.equal(store.entries.get(id)?.chat.model, "bf16");
  const loaded = await store.load(id);
  assert.equal(loaded?.model, "bf16"); assert.equal(loaded?.messages[1].model, "bf16");
  store.dispose();
  const restored = new CloudHistoryStore("qa:user:alice", storage, async () => ({ data: null, error: "offline" }), () => {}, () => {}, () => {});
  storage.setItem("qa:user:alice", JSON.stringify([{ chat: { id, title: "old", updatedAt: 1, messages: payload.messages }, revision: 1, loaded: true, state: "saved", createdAt: new Date().toISOString() }]));
  restored.restore();
  assert.equal(restored.entries.get(id)?.chat.model, "bf16"); assert.equal(restored.entries.get(id)?.chat.messages[1].model, "bf16");
  restored.dispose();
});

test("conversations tagged with an unknown model stay out of local and cloud history", async () => {
  let saves = 0;
  const { store } = harness(async name => { if (name === "save_chat_v2") saves++; return { data: usage, error: null }; });
  const unknown = { ...fourBitChat(), model: "awq" } as unknown as Conversation;
  assert.deepEqual(parseConversations(JSON.stringify([unknown])), []);
  store.stage(unknown); await turn();
  assert.equal(saves, 0); assert.equal(store.entries.size, 0); store.dispose();
});
