# FLUX.2 dev generation

Accepted November 11, 2026 for the administrator preview.

Image generation uses a dedicated authenticated backend, separate from Qwen chat and image understanding. The Next.js server verifies the Google account and active session, applies the existing administrator allowlist, and supplies the verified account UUID with a server-only backend credential. Browser headers and body fields never establish backend identity. The backend enforces ownership, queue capacity, one unfinished job per account, daily starts and temporary-result retention.

The browser stores image PNG bytes in IndexedDB using account-and-message keys. Cloud conversation history stores only a versioned whitelist of prompt, request ID, job ID, state and cancellation request flag. Browser-only bytes avoid adding permanent object storage in the first release. Other browsers may retrieve the temporary backend result while available; afterward they retain a clear placeholder and prompt. Downloading is the durable user-controlled export. Clearing site data removes local images; deleting cloud history does not remove exported files or disconnected browser copies.

Submissions use a stable idempotency key so unknown submission outcomes can recover the same job. Polling resumes known jobs after reload. Completed backend status and successful local image saving are distinct: the card shows an actual preview and local-save notice only after reading a stored PNG. Downloads pass through authenticated same-origin routes with bounded response reads, fixed PNG header/dimension checks, and no public URLs in history. Failed saves remain recoverable from the same temporary job.

Cancellation is cooperative. The UI distinguishes a requested cancellation from confirmed cancellation and permits completion to win after backend artifact persistence. Deleting a conversation requests cancellation of known unfinished jobs and aborts local image work before deleting its blobs. Backend TTL controls abandoned or unknown jobs.

The UI offers separate Chat and Create image modes. Only an explicit text prompt goes to FLUX; Qwen attachments and conversation context are excluded. This release uses one 1024 × 1024 PNG, 28 steps, guidance 4, an eight-job backend queue, twenty account starts per day and a 24-hour terminal-result TTL. An additive SQL migration extends the existing cloud history whitelist; rollout must apply it before frontend activation.
