# Image generation in Qwen Chat

Accepted for the first version on November 5, 2026.

## Image jobs run on a separate service

Use the managed FLUX.1 Schnell endpoint on Runpod. Next.js submits one 1024 × 1024 image job and exposes short status requests. The browser polls while Runpod owns queuing, generation, and the temporary result. The existing Qwen route handles text. Only the current image prompt goes to the image service, and both sides of an image turn are excluded from Qwen's text history.

A synchronous route would hold a Vercel invocation open for the whole generation. A dedicated worker would give us control of model versions and GPU scheduling and would require a separate deployment. Revisit if we need a different model, tighter control over latency or data retention, or more predictable capacity.

## The browser owns saved images

Save the file in IndexedDB and keep its key and prompt in the browser's conversation history. Download the result as soon as the job completes because [Runpod's result URLs expire](https://docs.runpod.io/public-endpoints/requests). The app can show an image after reload from that browser's copy. Use authenticated same-origin retrieval so the client can save the file even if the provider does not allow cross-origin downloads.

Saving provider URLs alone would let history entries expire. Private object storage would support shared or synced history and would add storage, authorization, and deletion responsibilities. Revisit if users need backups, sharing, or access from another device.

Keep the existing conversation storage format readable by previous builds. Save image metadata in a versioned payload on an empty assistant record and restore it as an image card in the new client. A previous build can still read the text conversation, and the blank record carries no text into Qwen's history.

## The app server owns provider access

Reuse the workspace login and keep a dedicated Runpod key on the server. Sign job handles and bind them to the workspace session for up to 30 minutes from submission. Retrieval also depends on the provider retaining the job result. The server derives the download target from the provider response and accepts only the trusted image host, expected image types, and files up to 4 MiB. The browser can resume polling a known job after reload. If a submission times out before a handle arrives, Runpod may already have accepted it, so a new submission requires a user action.

A server-side job table would allow recovery across sessions and stronger deduplication. This first version uses signed handles and a best-effort per-instance submission throttle. Revisit if we need durable idempotency, recovery after login expiry, or an app-wide spending limit.

Revoke the dedicated key in Runpod to cut off provider access. Removing it from Vercel configuration takes effect after redeploying.

## App API

| Request | Result |
| --- | --- |
| `GET /api/images` | Returns image mode availability and the prompt length limit. |
| `POST /api/images` with `{ prompt }` | Returns `202` with the initial job state and an opaque job handle. |
| `GET /api/images/{jobId}` | Returns the current job state: `queued`, `generating`, `completed`, or `failed`. |
| `GET` the returned `image.url` | Returns the image bytes for a completed job under the same session. The retrieval URL expires independently of a local copy. |
