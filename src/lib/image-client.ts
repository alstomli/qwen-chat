export type ImageCapability = { enabled: boolean; reason?: string; maxPromptLength: number };
type ImageJob = {
  jobId: string;
  status: "queued" | "generating" | "completed" | "failed";
  error?: string;
  image?: { url: string };
};

export class ImageRequestError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

export function isTransientImageError(error: unknown) {
  return error instanceof TypeError
    || (error instanceof ImageRequestError && (error.status === 429 || error.status >= 500));
}

async function request(url: string, options: RequestInit) {
  const response = await fetch(url, { cache: "no-store", redirect: "error", ...options });
  if (!response.ok) {
    const data = await response.json().catch(() => null);
    const message = typeof data?.error === "string" ? data.error : "The image service is unavailable. Try again.";
    throw new ImageRequestError(message, response.status);
  }
  return response;
}

export async function getImageCapability(signal: AbortSignal): Promise<ImageCapability> {
  const data = await (await request("/api/images", { signal })).json();
  return {
    enabled: data?.enabled === true && Number.isInteger(data.maxPromptLength) && data.maxPromptLength > 0,
    reason: typeof data?.reason === "string" ? data.reason : undefined,
    maxPromptLength: Number.isInteger(data?.maxPromptLength) ? data.maxPromptLength : 0,
  };
}

function imagePath(jobId: string) {
  return `/api/images/${encodeURIComponent(jobId)}`;
}

async function readJob(response: Response): Promise<ImageJob> {
  const data = await response.json();
  if (typeof data?.jobId !== "string" || !data.jobId || !["queued", "generating", "completed", "failed"].includes(data.status)) {
    throw new Error("The image service returned an invalid job.");
  }
  return data;
}

export async function submitImage(prompt: string, signal: AbortSignal) {
  return readJob(await request("/api/images", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ prompt }), signal,
  }));
}

function wait(ms: number, signal: AbortSignal) {
  signal.throwIfAborted();
  return new Promise<void>((resolve, reject) => {
    const cancel = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", cancel); resolve(); }, ms);
    signal.addEventListener("abort", cancel, { once: true });
  });
}

async function retryImageRead<T>(read: () => Promise<T>, signal: AbortSignal) {
  let retries = 0;
  while (true) {
    try { return await read(); }
    catch (error) {
      if (!isTransientImageError(error) || retries === 4) throw error;
      await wait(Math.min(2 ** retries * 1000, 8000), signal);
      retries++;
    }
  }
}

export async function pollImage(jobId: string, signal: AbortSignal, delay: boolean) {
  if (delay) await wait(2000, signal);
  return retryImageRead(async () => readJob(await request(imagePath(jobId), { signal })), signal);
}

export async function downloadImage(job: ImageJob, signal: AbortSignal) {
  const path = `${imagePath(job.jobId)}/download`;
  if (job.image?.url !== path) throw new Error("The image service returned an invalid download.");
  return retryImageRead(async () => {
    const blob = await (await request(path, { signal })).blob();
    if (!blob.size || !["image/png", "image/jpeg", "image/webp"].includes(blob.type)) {
      throw new Error("The image service returned an unreadable image.");
    }
    return blob;
  }, signal);
}
