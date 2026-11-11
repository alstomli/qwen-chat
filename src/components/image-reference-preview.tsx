import type { ImageReference } from "@/lib/image-reference";

export function ImageReferencePreview({ reference, preparing, onRemove }: { reference: ImageReference | null; preparing: boolean; onRemove: () => void }) {
  return <div className="image-reference-preview" role="group" aria-label="Reference image for editing">
    {reference && <img src={reference.dataUrl} alt="Reference image to edit" width={96} height={96}/>}
    <div><strong>Reference image</strong><p role="status">{preparing ? "Preparing reference…" : reference ? "Ready to edit. Describe the changes below." : "Reference unavailable on this browser. Load its original saved image before editing."}</p><button type="button" onClick={onRemove}>Remove reference</button></div>
  </div>;
}
