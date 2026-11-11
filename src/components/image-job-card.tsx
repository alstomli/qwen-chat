"use client";
import { useEffect, useState } from "react";
import { Download, ImagePlus, LoaderCircle } from "lucide-react";
import { imagePending, type GeneratedImage } from "@/lib/generated-image";
import { ownsImageRequest } from "@/lib/image-origin";
import { loadImage } from "@/lib/image-store";
const labels = { submitting: "Awaiting confirmation", queued: "Queued", generating: "Creating image…", completed: "Complete", failed: "Failed", cancelled: "Canceled", expired: "Result expired" };
export function ImageJobCard({ userId, id, image, note, allowed, onCheck, onCancel, onEdit, onGenerate }: {
  userId: string; id: string; image: GeneratedImage; note?: string; allowed: boolean;
  onCheck: () => void; onCancel: () => void; onEdit: () => void; onGenerate: () => void;
}) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    setUrl(null);
    let active = true; let objectUrl: string | undefined;
    if (image.status === "completed") void loadImage(userId, id).then(blob => { if (active && blob) { objectUrl = URL.createObjectURL(blob); setUrl(objectUrl); } }).catch(() => {});
    return () => { active = false; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [userId, id, image.status, note]);
  const pending = imagePending(image);
  const localOrigin = ownsImageRequest(userId, image.requestId);
  return <article className="message image-message" aria-label="Generated image">
    <div className="message-avatar" aria-hidden="true"><ImagePlus size={15}/></div>
    <div className="message-body image-job">
      <div className="image-job-heading"><div className="message-author">FLUX.2 dev</div><span role="status">{pending && localOrigin && <LoaderCircle size={14} className="spin" aria-hidden="true"/>}{!localOrigin && !url ? "Saved job details" : image.cancellationRequested && pending ? "Cancellation requested" : labels[image.status]}</span></div>
      <p className="image-job-prompt">{image.prompt}</p>
      {url ? <img className="generated-image" src={url} alt={`Generated image: ${image.prompt.slice(0, 180)}`} width={1024} height={1024}/>
        : pending && localOrigin ? <div className="image-job-placeholder" aria-hidden="true"><ImagePlus size={32}/></div> : null}
      {!localOrigin && !url && <p className="image-job-note">Only the prompt and job details are available here. Open the browser that created the image, or generate again to create one here.</p>}
      {image.status === "completed" && (localOrigin || url) && <p className="image-job-note">{url ? "Saved on this browser · 1024 × 1024 PNG" : "This image is unavailable on this browser. Prompt and job details sync across devices; image files stay in the browser that created them."}</p>}
      {image.cancellationRequested && image.status === "completed" && <p className="image-job-note">The image finished before cancellation took effect.</p>}
      {localOrigin && !image.jobId && pending && <p className="image-job-note">If this submission was interrupted, its outcome is unknown. Checking is manual: if the image service restarted, checking this request may start another generation.</p>}
      {note && <p className="image-job-note" role="status">{note}</p>}
      <div className="image-job-actions">
        {url && <a href={url} download={`kiddo-${id.slice(0, 8)}.png`}><Download size={14} aria-hidden="true"/>Download image</a>}
        {allowed && <>
          {localOrigin && (pending || image.status === "completed") && !url && <button type="button" onClick={onCheck}>Check same job</button>}
          {localOrigin && pending && image.jobId && <button type="button" disabled={image.cancellationRequested} onClick={onCancel}>Cancel generation</button>}
          <button type="button" onClick={onEdit}>Edit prompt</button>
          {(!pending || !localOrigin) && <button type="button" onClick={onGenerate}>Generate again</button>}
        </>}
      </div>
    </div>
  </article>;
}
