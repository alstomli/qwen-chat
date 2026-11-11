type OriginStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;
const key = (userId: string, requestId: string) => `kiddo.image-origin.v1:${userId}:${requestId}`;
function browserStorage(): OriginStorage | undefined { try { return typeof window === "undefined" ? undefined : window.localStorage; } catch { return; } }

/** Kept outside cloud history: metadata alone never starts/retrieves GPU work. */
export function ownsImageRequest(userId: string, requestId: string, storage = browserStorage()) {
  try { return storage?.getItem(key(userId, requestId)) === "origin"; } catch { return false; }
}
export function rememberImageRequest(userId: string, requestId: string, storage = browserStorage()) {
  if (!storage) throw new Error("Browser storage is unavailable. Enable site storage before generating an image.");
  try {
    storage.setItem(key(userId, requestId), "origin");
    if (!ownsImageRequest(userId, requestId, storage)) throw new Error();
  } catch { throw new Error("This browser couldn't save the image request. Free up browser storage before generating an image."); }
}
export function forgetImageRequest(userId: string, requestId: string, storage = browserStorage()) {
  try { storage?.removeItem(key(userId, requestId)); } catch { /* Never grant ownership after a failed read. */ }
}
