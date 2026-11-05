const DATABASE = "qwen-chat.image-files";
const STORE = "images";

async function withImageStore<T>(
  mode: IDBTransactionMode,
  action: (store: IDBObjectStore) => IDBRequest<T>,
  signal?: AbortSignal,
): Promise<T> {
  signal?.throwIfAborted();
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => { request.result.createObjectStore(STORE); };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  try {
    signal?.throwIfAborted();
    return await new Promise<T>((resolve, reject) => {
      const transaction = db.transaction(STORE, mode);
      const request = action(transaction.objectStore(STORE));
      transaction.oncomplete = () => resolve(request.result);
      transaction.onabort = () => reject(request.error ?? transaction.error ?? new Error("Image storage was interrupted."));
    });
  } finally {
    db.close();
  }
}

export function loadImage(id: string): Promise<Blob | undefined> {
  return withImageStore("readonly", store => store.get(id));
}

export function saveImage(id: string, blob: Blob, signal: AbortSignal) {
  return withImageStore("readwrite", store => store.put(blob, id), signal);
}

export function removeImage(id: string) {
  return withImageStore("readwrite", store => store.delete(id));
}
