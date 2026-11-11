import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { referenceEditingAvailable } from "./image-reference";
import { requestImageJob } from "./image-request";
import { imageFailureStatus, imagePending, parseGeneratedImage, type GeneratedImage } from "./generated-image";
import { ownsImageRequest, forgetImageRequest } from "./image-origin";
import { loadImage, removeImage, saveImage } from "./image-store";
import type { Conversation } from "./storage";

class ImageRequestError extends Error { constructor(message: string, readonly status: number) { super(message); } }
async function readResponse(response: Response) {
  const data = await response.json();
  if (!response.ok) throw new ImageRequestError(data?.error?.message ?? "The image service is unavailable.", response.status);
  return data;
}
async function read(url: string, init?: RequestInit) { return readResponse(await fetch(url, { cache: "no-store", ...init })); }
export function useImageJobs(userId: string, enabled: boolean, chats: Conversation[], setChats: Dispatch<SetStateAction<Conversation[]>>) {
  const [editingAvailable, setEditingAvailable] = useState(false);
  const references = useRef(new Map<string,string>());
  const [available, setAvailable] = useState(false); const [reason, setReason] = useState("Checking image service…");
  const [notes, setNotes] = useState<Record<string, string>>({});
  const epoch = useRef(0); const recovered = useRef(new Set<string>());
  const running = useRef(new Map<string, AbortController>()); const mounted = useRef(false);
  const refresh = useCallback(async () => {
    if (!enabled) return;
    const owner = epoch.current;
    try { const data = await read("/api/images"); if (!mounted.current || epoch.current !== owner) return; setAvailable(data.enabled === true); setEditingAvailable(data.enabled === true && data.referenceEditing === true && referenceEditingAvailable(data.imageEditing)); setReason(data.enabled ? "" : "Image service is loading. Check again shortly."); }
    catch (error) { if (mounted.current && epoch.current === owner) { setAvailable(false); setEditingAvailable(false); setReason(error instanceof Error ? error.message : "Image service unavailable."); } }
  }, [enabled]);
  useEffect(() => {
    epoch.current++; mounted.current = true; setAvailable(false); setEditingAvailable(false); references.current.clear(); setNotes({}); recovered.current.clear(); void refresh();
    const requests = running.current;
    return () => { epoch.current++; mounted.current = false; for (const request of requests.values()) request.abort(); requests.clear(); references.current.clear(); };
  }, [refresh, userId]);
  const track = useCallback(async (chatId: string, messageId: string, original: GeneratedImage, explicitSubmission = false, referenceImage?: string) => {
    if (!enabled || !ownsImageRequest(userId, original.requestId) || (!original.jobId && !explicitSubmission) || running.current.has(messageId)) return;
    // Keep only the latest ambiguous edit: each normalized data URL can approach 3 MiB.
    // Older unknown submissions can be restarted explicitly from their saved source.
    if (referenceImage && original.mode === "edit") { references.current.clear(); references.current.set(original.requestId, referenceImage); }
    const controller = new AbortController(); running.current.set(messageId, controller);
    const signal = controller.signal;
    const note = (text: string) => { if (!signal.aborted) setNotes(current => ({ ...current, [messageId]: text })); };
    const update = (image: GeneratedImage) => { if (!signal.aborted) setChats(current => current.map(chat => chat.id !== chatId ? chat : { ...chat, messages: chat.messages.map(message => message.id === messageId ? { ...message, generatedImage: image } : message) })); };
    let image = original;
    try {
      note("");
      const response = await requestImageJob(image, explicitSubmission, signal, fetch, references.current.get(image.requestId));
      if (!response) return;
      let job = await readResponse(response);
      while (!signal.aborted) {
        if (image.mode === "edit" && job.kind !== "edit") throw new Error("The image service did not confirm this reference edit.");
        const parsed = parseGeneratedImage({ ...image, jobId: job.jobId, status: job.status, cancellationRequested: job.cancellationRequested === true });
        if (!parsed?.jobId) throw new Error("The image service returned an invalid job.");
        image = parsed; update(image);
        if (!imagePending(image)) break;
        await new Promise<void>((resolve, reject) => {
          const abort = () => { clearTimeout(timer); reject(new DOMException("Aborted", "AbortError")); };
          const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, 2000);
          signal.addEventListener("abort", abort, { once: true });
        });
        job = await read(`/api/images/${image.jobId}`, { signal });
      }
      if (image.status === "completed") {
        if (await loadImage(userId, messageId)) return;
        note("Saving image…");
        const response = await fetch(`/api/images/${image.jobId}/image`, { signal, cache: "no-store" });
        if (!response.ok) throw new Error("Couldn't retrieve this image. Check the same job before its result expires.");
        const blob = await response.blob(); if (blob.type !== "image/png" || !blob.size) throw new Error("The image could not be read.");
        const decoded = await createImageBitmap(blob);
        try { if (decoded.width !== 1024 || decoded.height !== 1024) throw new Error("The image has unexpected dimensions."); }
        finally { decoded.close(); }
        signal.throwIfAborted(); await saveImage(userId, messageId, blob, signal); note("");
      } else if (image.status === "failed") note("The image could not be generated. Edit your prompt or generate again.");
    } catch (error) {
      if (!signal.aborted) {
        if (error instanceof ImageRequestError) { image = { ...image, status: imageFailureStatus(image, error.status) }; update(image); }
        else if (image.mode === "edit" && !image.jobId && !references.current.has(image.requestId)) { image = { ...image, status: "failed" }; update(image); }
        note(error instanceof Error ? error.message : "Connection interrupted. Check the same job.");
      }
    }
    finally { if (image.jobId || !imagePending(image)) references.current.delete(image.requestId); if (running.current.get(messageId) === controller) running.current.delete(messageId); }
  }, [enabled, userId, setChats]);
  useEffect(() => { if (enabled) for (const chat of chats) for (const message of chat.messages) {
    if (message.generatedImage && ownsImageRequest(userId, message.generatedImage.requestId) && !notes[message.id]) {
      if (imagePending(message.generatedImage) && message.generatedImage.jobId) void track(chat.id, message.id, message.generatedImage);
      else if (message.generatedImage.status === "completed" && !recovered.current.has(message.id)) {
        recovered.current.add(message.id); const owner = epoch.current; void loadImage(userId, message.id).then(blob => { if (!blob && mounted.current && epoch.current === owner) void track(chat.id, message.id, message.generatedImage!); }).catch(() => {});
      }
    }
  } }, [chats, enabled, track, notes, userId]);
  async function cancel(chatId: string, messageId: string, image: GeneratedImage) {
    if (!image.jobId || !ownsImageRequest(userId, image.requestId)) return;
    const owner = epoch.current;
    try {
      const job = await read(`/api/images/${image.jobId}`, { method: "DELETE" });
      if (image.mode === "edit" && job.kind !== "edit") throw new Error("The image service did not confirm this reference edit.");
        const parsed = parseGeneratedImage({ ...image, status: job.status, cancellationRequested: job.cancellationRequested === true });
      if (mounted.current && epoch.current === owner && parsed) setChats(current => current.map(chat => chat.id !== chatId ? chat : { ...chat, messages: chat.messages.map(message => message.id === messageId ? { ...message, generatedImage: parsed } : message) }));
    } catch (error) { if (mounted.current && epoch.current === owner) setNotes(current => ({ ...current, [messageId]: error instanceof Error ? error.message : "Cancellation could not be confirmed." })); }
  }
  function cleanup(chat: Conversation) { for (const message of chat.messages) if (message.generatedImage) { running.current.get(message.id)?.abort(); if (ownsImageRequest(userId, message.generatedImage.requestId) && imagePending(message.generatedImage) && message.generatedImage.jobId) void fetch(`/api/images/${message.generatedImage.jobId}`, { method: "DELETE" }).catch(() => {}); references.current.delete(message.generatedImage.requestId); forgetImageRequest(userId, message.generatedImage.requestId); void removeImage(userId, message.id).catch(() => {}); } }
  return { available, editingAvailable, hasTrackingRequests: () => running.current.size > 0, reason, refresh, notes, track, cancel, cleanup };
}
