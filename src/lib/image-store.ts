const database = "kiddo.generated-images.v1";
async function access<T>(userId: string, id: string, write?: Blob | null, signal?: AbortSignal): Promise<T> {
  signal?.throwIfAborted();
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(database, 1);
    request.onupgradeneeded = () => request.result.createObjectStore("images");
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
  });
  try { return await new Promise<T>((resolve, reject) => {
    signal?.throwIfAborted();
    const tx = db.transaction("images", write === undefined ? "readonly" : "readwrite");
    const store = tx.objectStore("images"); const key = `${userId}:${id}`;
    const abort = () => tx.abort();
    signal?.addEventListener("abort", abort, { once: true });
    const result = write === undefined ? store.get(key) : write === null ? store.delete(key) : store.put(write, key);
    tx.oncomplete = () => { signal?.removeEventListener("abort", abort); resolve(result.result); }; tx.onabort = tx.onerror = () => { signal?.removeEventListener("abort", abort); reject(tx.error); };
  }); } finally { db.close(); }
}
export const loadImage = (userId: string, id: string) => access<Blob | undefined>(userId, id);
export const saveImage = (userId: string, id: string, blob: Blob, signal?: AbortSignal) => access(userId, id, blob, signal);
export const removeImage = (userId: string, id: string) => access(userId, id, null);
