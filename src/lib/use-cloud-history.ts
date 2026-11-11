"use client";
import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { accountStorageKey } from "./account-storage";
import { CLOUD_CACHE_KEY, CloudHistoryStore } from "./cloud-history";
import { browserAuth } from "./supabase/browser";
import type { Conversation } from "./storage";

export function useCloudHistory(userId: string, authenticated: boolean, loaded: boolean,
  legacyIds: React.RefObject<Set<string>>, chats: Conversation[],
  setChats: Dispatch<SetStateAction<Conversation[]>>, notify: (message: string) => void,
  controllers: React.RefObject<Map<string, AbortController>>) {
  const store = useRef<CloudHistoryStore | null>(null);
  const checkpoints = useRef(new Map<string, { chat: Conversation; marker: string }>());
  const [, render] = useState(0);
  useEffect(() => {
    if (!loaded || !authenticated) return;
    // Access storage inside controller try/catch: denied storage must never prevent chatting.
    const storage = { getItem: (key: string) => localStorage.getItem(key), setItem: (key: string, value: string) => localStorage.setItem(key, value), removeItem: (key: string) => localStorage.removeItem(key) };
    const current = new CloudHistoryStore(accountStorageKey(CLOUD_CACHE_KEY, userId), storage,
      async (name, args) => {
        const client = browserAuth();
        const { data } = await client.auth.getSession();
        if (current.disposed || data.session?.user.id !== userId) throw new Error("Account changed");
        // Pin this request to the checked account even if the shared client switches accounts.
        return await client.rpc(name, args).setHeader("Authorization", `Bearer ${data.session.access_token}`).abortSignal(AbortSignal.timeout(15_000));
      }, () => render(n => n + 1), (incoming, removed = []) => {
        setChats(previous => {
          const additions = new Map(incoming.map(chat => [chat.id, chat]));
          return [...previous.filter(chat => !removed.includes(chat.id)).map(chat => {
            const update = additions.get(chat.id); additions.delete(chat.id); return controllers.current.has(chat.id) ? chat : update ?? chat;
          }), ...additions.values()].sort((a, b) => b.updatedAt - a.updatedAt);
        });
      }, notify, id => controllers.current.has(id));
    store.current = current; current.restore(); void current.refresh();
    const focus = () => { void current.retry().then(() => current.refresh()); };
    window.addEventListener("focus", focus); window.addEventListener("online", focus);
    render(n => n + 1);
    return () => { current.dispose(); checkpoints.current.clear(); window.removeEventListener("focus", focus); window.removeEventListener("online", focus); if (store.current === current) store.current = null; };
  }, [userId, authenticated, loaded, setChats, notify, controllers]);
  useEffect(() => {
    if (!loaded || !authenticated || !store.current) return;
    for (const chat of chats) {
      if (legacyIds.current.has(chat.id)) continue;
      const previous = checkpoints.current.get(chat.id);
      if (previous?.chat === chat) continue;
      const last = chat.messages.at(-1);
      const imagesMarker = chat.messages.filter(message => message.generatedImage).map(message => `${message.id}:${JSON.stringify(message.generatedImage)}`).join("|");
      const marker = `${imagesMarker}:${chat.messages.length}:${last?.id}:${last?.state ?? "streaming"}:${chat.model}:${chat.useAdapter}`;
      checkpoints.current.set(chat.id, { chat, marker });
      // Streaming changes only the unfinished assistant's content. Serialize at prompt/terminal checkpoints.
      if (previous?.marker === marker) continue;
      store.current.stage(chat);
    }
  }, [chats, loaded, authenticated, legacyIds]);
  return store.current;
}
