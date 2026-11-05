import { CircleAlert, Clock3, Download, ImagePlus, LoaderCircle, RotateCcw } from "lucide-react";
import { useEffect, useState } from "react";
import { loadImage } from "@/lib/image-store";
import type { ImageMessage } from "@/lib/storage";

const labels = { queued: "Queued", generating: "Generating", ready: "Ready", error: "Error" };
const extensions: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" };

export function ImageJobCard({
  message, canRegenerate, onRegenerate, onResume,
}: {
  message: ImageMessage;
  canRegenerate: boolean;
  onRegenerate: () => void;
  onResume?: () => void;
}) {
  const [asset, setAsset] = useState<{ url: string; filename: string } | null>(null);
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    if (message.state !== "ready") return;
    let cancelled = false;
    let url: string | undefined;
    loadImage(message.id).then(blob => {
      if (cancelled) return;
      if (!blob) { setMissing(true); return; }
      url = URL.createObjectURL(blob);
      setAsset({ url, filename: `qwen-image-${message.id.slice(0, 8)}.${extensions[blob.type] ?? "png"}` });
    }).catch(() => { if (!cancelled) setMissing(true); });
    return () => { cancelled = true; if (url) URL.revokeObjectURL(url); };
  }, [message.id, message.state]);

  const state = missing ? "error" : message.state;
  const pending = state === "queued" || state === "generating";
  const StatusIcon = state === "error" ? CircleAlert : state === "queued" ? Clock3 : state === "generating" ? LoaderCircle : ImagePlus;

  return <article className="message image-message" aria-label="Image generation">
    <div className="message-avatar" aria-hidden="true"><ImagePlus size={15}/></div>
    <div className="message-body image-job" data-state={state}>
      <div className="image-job-heading">
        <div className="message-author">Image generation</div>
        <span className="image-job-status" role="status"><StatusIcon size={13} aria-hidden="true" className={state === "generating" ? "spin" : undefined}/>{labels[state]}</span>
      </div>
      <p className="image-job-prompt">{message.content}</p>
      {state !== "error" && <div className="image-job-visual">
        {asset ? <img src={asset.url} alt={message.content} width={1024} height={1024} onError={() => setMissing(true)}/>
          : <div className="image-job-placeholder" aria-hidden="true"><ImagePlus size={28} strokeWidth={1.3}/></div>}
      </div>}
      {state === "error" && <p className="image-job-error" role="alert">{missing ? "The saved image is unavailable in this browser." : message.note}</p>}
      {!pending && <div className="image-job-actions">
        {asset && !missing && <a href={asset.url} download={asset.filename}><Download size={14} aria-hidden="true"/>Download image</a>}
        {onResume && <button type="button" disabled={!canRegenerate} onClick={onResume}><RotateCcw size={14} aria-hidden="true"/>Resume image</button>}
        <button type="button" disabled={!canRegenerate} onClick={onRegenerate}><RotateCcw size={14} aria-hidden="true"/>Regenerate</button>
      </div>}
    </div>
  </article>;
}
