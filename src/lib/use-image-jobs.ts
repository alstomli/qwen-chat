import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { downloadImage, getImageCapability, ImageRequestError, isTransientImageError, pollImage, submitImage, type ImageCapability } from "./image-client";
import { loadImage, removeImage, saveImage } from "./image-store";
import type { Conversation, ImageMessage } from "./storage";

export function useImageJobs(
  active: boolean,
  setChats: Dispatch<SetStateAction<Conversation[]>>,
  onUnauthorized: () => void,
) {
  const [capability, setCapability] = useState<ImageCapability | null>(null);
  const requests = useRef(new Map<string, AbortController>());

  useEffect(() => {
    setCapability(null);
    if (!active) return;
    const abort = new AbortController();
    getImageCapability(abort.signal)
      .then(result => { if (!abort.signal.aborted) setCapability(result); })
      .catch(error => {
        if (abort.signal.aborted) return;
        if (error instanceof ImageRequestError && error.status === 401) onUnauthorized();
        else setCapability({ enabled: false, maxPromptLength: 0, reason: "Image generation is unavailable right now." });
      });
    return () => {
      abort.abort();
      for (const request of requests.current.values()) request.abort();
      requests.current.clear();
    };
  }, [active, onUnauthorized]);

  const track = useCallback(async (
    chatId: string, imageId: string, source: { prompt: string } | { jobId: string; state: ImageMessage["state"] },
  ) => {
    if (requests.current.has(imageId)) return;
    const abort = new AbortController();
    requests.current.set(imageId, abort);

    function update(patch: Partial<ImageMessage>) {
      setChats(current => current.map(chat => chat.id === chatId ? {
        ...chat, messages: chat.messages.map(message =>
          message.role === "image" && message.id === imageId ? { ...message, ...patch } : message),
      } : chat));
    }

    let jobId = "jobId" in source ? source.jobId : undefined;
    let lastStatus: ImageMessage["state"] = "state" in source ? source.state : "queued";
    let storageFailed = false;
    try {
      if ("jobId" in source) {
        if (source.state === "error") {
          lastStatus = "generating";
          update({ state: lastStatus, note: undefined });
        }
        const saved = await loadImage(imageId).catch(() => undefined);
        abort.signal.throwIfAborted();
        if (saved) {
          update({ state: "ready", jobId: undefined });
          return;
        }
      }
      let job = "prompt" in source
        ? await submitImage(source.prompt, abort.signal)
        : await pollImage(source.jobId, abort.signal, false);
      abort.signal.throwIfAborted();
      while (job.status === "queued" || job.status === "generating") {
        if (job.status !== lastStatus || job.jobId !== jobId) {
          update({ state: job.status, jobId: job.jobId });
          lastStatus = job.status;
          jobId = job.jobId;
        }
        job = await pollImage(job.jobId, abort.signal, true);
        abort.signal.throwIfAborted();
      }
      if (job.status === "failed") throw new Error(typeof job.error === "string" ? job.error : "The image could not be generated. Try again.");
      if (lastStatus !== "generating" || jobId !== job.jobId) update({ state: "generating", jobId: job.jobId });
      jobId = job.jobId;
      const blob = await downloadImage(job, abort.signal);
      try { await saveImage(imageId, blob, abort.signal); }
      catch {
        storageFailed = true;
        throw new Error("This browser couldn't save the image. Check your browser storage, then resume the same job.");
      }
      abort.signal.throwIfAborted();
      update({ state: "ready", jobId: undefined });
    } catch (error) {
      if (abort.signal.aborted) return;
      if (error instanceof ImageRequestError && error.status === 401) onUnauthorized();
      else update({
        state: "error", jobId: storageFailed || isTransientImageError(error) ? jobId : undefined,
        note: error instanceof TypeError ? "Couldn't reach the image service. Try again."
          : error instanceof Error ? error.message : "The image could not be generated. Try again.",
      });
    } finally {
      if (requests.current.get(imageId) === abort) requests.current.delete(imageId);
    }
  }, [onUnauthorized, setChats]);

  const resume = useCallback((chats: Conversation[]) => {
    for (const chat of chats) {
      for (const message of chat.messages) {
        if (message.role === "image" && message.jobId && (message.state === "queued" || message.state === "generating")) {
          void track(chat.id, message.id, { jobId: message.jobId, state: message.state });
        }
      }
    }
  }, [track]);

  function deleteImages(chat: Conversation) {
    for (const message of chat.messages) {
      if (message.role !== "image") continue;
      requests.current.get(message.id)?.abort();
      void removeImage(message.id).catch(() => {});
    }
  }

  return { capability, track, resume, deleteImages };
}
