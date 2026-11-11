# Kiddo Chat

Optional **Search web** looks up sources for one explicitly selected message. It requires the companion gateway's verified search capability and the additive history metadata migration. See [web search setup and behavior](docs/web-search.md). It remains unavailable until the backend provider and exact model/adapter profile are enabled; no provider key belongs in the frontend.

Advanced settings are available only to the two verified admin accounts configured in `src/lib/settings-access.ts`. The server checks the authenticated Supabase user ID and active session; browser preferences and request fields cannot grant access. Regular users retain Creativity, connection status, and chat history controls. Their advanced settings use defaults fitted to the selected gateway, prefix reuse is always on, request diagnostics are unavailable, and the BF16 adapter is always off, including when continuing saved conversations. BF16 requires a gateway that supports adapter switching and confirms base-model mode on its response; unsupported gateways fail closed.

For admins, Advanced settings includes **Reuse cached prefixes**, on by default and saved in this browser. Turning it off makes the gateway isolate each request's prefix cache using a fresh server-generated salt. It does not free reserved GPU memory or disable cache writes. The toggle requires the companion inference-server gateway update; quota-compatible gateways without prefix reuse controls retain the default prefix behavior with the toggle disabled. Deploy the backend update before the frontend. Deployment requires separate approval.

A personal chat workspace for the existing Qwen model on Runpod. The frontend and server-side API are built with Next.js 16, React 19, and TypeScript, deployed to Vercel with local development support.

Kiddo Chat is the product name; Qwen names identify the underlying model in the header, settings, diagnostics, and attribution. Browser storage keys retain their existing names. See [branding rollout](docs/branding-rollout.md) for the coordinated public URL and Google sign-in branding cutover.

The frontend can run locally at `http://127.0.0.1:3001`; the hosted production site is `https://qwen38-chat-zh.vercel.app`. Each deployment has its own server environment configuration. **Qwen3.8-27B-bf16** is the sole supported model and the default, routed to its authenticated Runpod gateway.

## BF16 model and adapter

For admins, when the BF16 gateway advertises adapter switching, **Use trained adapter**
appears under **Your workspace → Qwen3.8-27B-bf16 → Advanced settings**. Their new conversations default to On:
On requests the registered adapter, while Off requests the original BF16 base.
The choice is saved per conversation; each new assistant answer records its own
mode and is labeled **BF16 + adapter** or **BF16 base**. Changing the choice does
not relabel earlier answers. Legacy answers retain their existing model labels
because their original adapter state cannot be inferred. The control is unavailable
when its gateway does not support switching, and is disabled while
that conversation is generating. Switching an active conversation keeps its history;
start fresh conversations with the same settings for a controlled comparison.

Deploy the companion gateway update first, retaining the current LoRA Pod
environment settings. The frontend checks the gateway's versioned capability
and verifies `X-Chat-Adapter-Enabled` on successful responses. A saved Off choice
on an incompatible connection fails instead of silently using the adapter.
No new frontend environment variables are needed. Switching requests needs no
model reload; installing the backend update uses the normal image deployment.

Validation includes `npm test`, `npm run typecheck`, `npm run build`, and the
local HTTP check `node scripts/check-adapter-toggle.mjs`. The latter expects a
local app connected to the companion backend's `chat_test_fixture.py` with
`CHAT_FIXTURE_ADAPTER=true`; it uses a fake model and never calls the live Pod.
The optional `CHAT_ADAPTER_TEST_BASE` defaults to `http://127.0.0.1:3003` and
`CHAT_ADAPTER_TEST_COOKIE` must be a verified fixture account session cookie.

The header displays `Qwen3.8-27B-bf16`. New conversations and requests that omit
the model ID use BF16. Requests for other model IDs are rejected. Conversations
with explicit unsupported model metadata are omitted from browser and cloud
history rather than relabeled. Existing BF16 preferences remain available;
preferences belonging to a retired model are ignored.

Configure the local frontend's ignored `.env.local` and restart its process:

| Model | Gateway origin | Server-side credential |
| --- | --- | --- |
| `bf16` (default) | `RUNPOD_BF16_CHAT_URL` | `RUNPOD_BF16_CHAT_TOKEN` |

The BF16 gateway origin is `https://o6f2qoctk798tq-8001.proxy.runpod.net`.
It serves the original BF16 checkpoint on an RTX PRO 6000 with CPU offloading
disabled. The public model ID, display name and bearer token are unchanged by
the hardware migration. Production and local servers must load the updated
`RUNPOD_BF16_CHAT_URL`; Preview bindings are managed separately. Redeploy/restart
the affected frontend after changing its environment. See the backend's
[migration record](https://github.com/alstomli/llm-inference-server/blob/main/deployments/qwen-bf16/RTX6000-MIGRATION.md)
for verification, monitoring and rollback. The prior BF16 origin on
`ftntkktzid9f4p` is retained only for migration rollback.
Use the matching private BF16 chat credential; monitoring credentials are separate. Never use
`NEXT_PUBLIC_` for either connection or credential.

Browser requests contain only the allowlisted public ID `bf16`.
The Next.js server uses its configured BF16 endpoint and token, verifies the
reported serving alias `qwen-bf16`, and strips the public selector before
forwarding. Credentials and gateway origins are not returned in status.

Readiness, diagnostics support, and actual server limits are checked before
sending. Initial defaults are 40,960 context tokens,
7,680 output tokens, and 32 safety tokens. Actual gateway limits take precedence.
Advanced preferences are saved for BF16. If a smaller context is reported, effective settings leave input space
without overwriting the stored preferences. Exact token fitting and any old
exchange removal remain the selected gateway's responsibility.

### Model settings

Open **Your workspace** to see the BF16 connection at the top.
**Refresh connection** checks its gateway readiness and capabilities.

Admins can expand `Qwen3.8-27B-bf16` to edit Advanced settings using its
Apply and Reset controls. Unsaved drafts remain available while opening and
closing the section. Apply and Reset update BF16 browser preferences. Initial defaults remain
40,960 context tokens, 7,680 output tokens, and 32 safety tokens. Creativity
retains its existing behavior; diagnostics opt-ins last for the session.

A model with current verified limits is editable. During a temporary outage,
its own last verified limits remain available in that browser page, clearly
labeled as such. A never-verified connection stays disabled until its limits
can be checked. Every chat request still verifies the gateway and actual limits before sending.

### Hosted connection configuration

Local `.env.local` settings do not configure Vercel. Add both BF16 connection
variables to the intended Vercel environment as server-only values, then redeploy. Configure Production and Preview
separately as needed. A missing `RUNPOD_BF16_CHAT_URL` or
`RUNPOD_BF16_CHAT_TOKEN` produces **Gateway connection not configured** for BF16;
it does not mean the BF16 Pod itself is stopped. This was the cause of the
hosted site's missing BF16 connection. Keep credentials private and never prefix them with `NEXT_PUBLIC_`.

Verification includes `npm test`, `npm run typecheck`, and `npm run build`.
The model tests use isolated BF16 mock gateways; live acceptance must separately
confirm readiness, a streamed BF16 reply, stopping, adapter behavior, and gateway limits.

## Run locally

This PC has a project-local Node.js 22 runtime at `D:\AILearn\.tools\node_modules\node\bin\node.exe`; the system's Node.js 19 default was not changed.

From PowerShell:

```powershell
cd D:\AILearn\qwen-chat
.\start-local.cmd
```

Then configure Supabase and apply the account migration using [Account setup](docs/accounts.md).
Open http://127.0.0.1:3001 and choose **Continue with Google**. New Google users get an account automatically while registration has capacity (100 accounts maximum); existing users can still sign in when full.
The setup script preserves existing `.env.local`; replace legacy login settings with the Supabase public variables in `.env.example`.

On another machine with Node.js 22 or newer:

```bash
npm ci
npm run setup
npm run dev
```

Supabase Auth and Postgres are required for accounts. No OpenAI account is required. The app is configured for your live Runpod model. For an isolated local preview, clear `RUNPOD_BF16_CHAT_URL` and set `CHAT_PREVIEW_MODE=true`; sample replies are clearly labeled and make no model requests. Stop the local server with Ctrl+C.

## Included behavior

- Streaming replies; stop generation, retry, copy response/code, Markdown, tables, and safe links.
- Multiple conversations, search, new chat, confirmed deletion, and recovery after a page reload.
- Desktop and mobile layouts, keyboard submission, accessible labels, and reduced-motion support.
- Persistent Advanced settings for input characters, output tokens, context tokens, history messages/bytes, request bytes, generation timeout, and safety tokens, plus adjustable creativity.
- Public Google sign-in/signup, server-verified Google identities, live Supabase sessions, same-origin mutation checks, and bounded request bodies.
- Live readiness checks and clear offline, loading, interrupted, and context-limit messages.
- New conversations sync through Supabase, scoped to the signed-in account. Each account retains at most 50 conversations or 2,000,000 bytes of content and metadata; oldest-message conversations are replaced when necessary. Pre-existing browser history remains local even when continued. Local pending saves are labeled and can be exported. This is not end-to-end encrypted storage. In live mode the selected conversation context is sent through the Vercel server and Runpod gateway to your model; hosting platforms may retain operational metadata.

### Cloud history limits and release

The sidebar's **HISTORY** list combines synced and browser-only conversations in
latest-activity order. Its count includes both; the footer reports the separate
synced-storage quota. Opening an older local conversation explains its storage scope.

New cloud history stores text, model metadata, message status, image filenames,
and citations, not image files or request diagnostics. Save operations enforce
ownership, revisions, and quotas in Postgres. An oversized active conversation
is retained locally instead of being silently truncated. Settings remain local.
Export important chats as JSON or Markdown before rolling retention removes them.

Apply the additive cloud-history migration after the account migration, following
[Cloud history operations](docs/cloud-history-operations.md). Keep the existing
Supabase Free plan; database-size and egress monitoring remain necessary even with
the 100-account cap. The [design decision](docs/adr-cloud-history.md) explains the
storage and retry tradeoffs. Ordinary Git deployments require no generated document index.

Apply `supabase/migrations/202611100002_bf16_only.sql` after the web-search
metadata migration for BF16-only history writes. It rejects explicit unsupported
model IDs while preserving account controls and citation metadata. Older migration
files remain historical records. This source change does not apply hosted SQL,
remove hosted data, change hosting environment variables, or stop any Pod.

## Ask about an image

Use **Attach image** to add one JPEG, PNG, or WebP to a text prompt. If **Use trained adapter** is available, open **Your workspace → Qwen3.8-27B-bf16 → Advanced settings** and switch it off to use the BF16 base model for the image request. Qwen streams a text reply through the same chat connection.

The attachment control is available when the connected BF16 gateway advertises image input. The uploaded image shares the request byte budget with the text. The app keeps recent image bytes in the open tab for retry, and the saved conversation retains an attachment marker. Reattach the file to retry after a reload or to ask another question about the same image.

Assistant Markdown images are omitted, including images inside links and reference images. They create no image elements or React image preloads while streaming or when reopening history. Text, links, code, and user attachment previews remain available. An image-only Content Security Policy also limits image sources to this app, `data:`, and `blob:` URLs.

## Live model connection

The configured flow is:

```text
Browser → local Next.js /api/chat → token-protected Runpod gateway → private vLLM
```

The source for the gateway and its startup integration is in the [llm-inference-server repository](https://github.com/alstomli/llm-inference-server). For local integration checks, clone it beside this repository as `../llm-inference-server`:

- `scripts/chat-gateway.py`: authenticated `/health` and streaming `POST /v1/chat/completions` only. Model-management, metrics, docs, and arbitrary upstream paths are not exposed.
- `scripts/start-server.sh`: `CHAT_ENABLED=true` starts the gateway automatically; `METRICS_ENABLED=true` retains automatic monitoring. A service failure stops the launcher and other services. This is not a guarantee of automatic host recovery.
- `Dockerfile`: includes the gateway without any secrets. The live release is `zihan000/qwen-inference:0.3.0`; the local test image is `zihan000/qwen-inference:chat-dev`. Do not replace published release tags when changing code.

The following settings were applied to the existing Pod; retain them when replacing it:

1. Save a separate chat token of at least 32 characters at `/workspace/chat/chat-token`, readable only by the service owner. Configure the matching `RUNPOD_BF16_CHAT_TOKEN` in this app; do not reuse the monitoring token.
2. Deploy the new image with the existing network volume. Keep `METRICS_ENABLED=true` and `METRICS_HOST=0.0.0.0`; add `CHAT_ENABLED=true`, `CHAT_HOST=0.0.0.0`, and `CHAT_PORT=8001`. Keep vLLM bound to `127.0.0.1`.
3. Add HTTP port 8001 to the existing port list, preserving 8888. Keep the current model configuration and persistent caches.
4. Set this app's `RUNPOD_BF16_CHAT_URL` to the gateway's HTTPS origin, without `/v1` or another path. Set the matching `RUNPOD_BF16_CHAT_TOKEN`, then restart/redeploy the frontend.
5. Verify authentication failures, streaming, cancellation, Pod restart, and monitoring before relying on the live connection.

The gateway uses vLLM's `/tokenize` endpoint to count the exact chat template, reserves space for the reply plus the configured safety reserve (default 32 tokens), and drops the oldest full exchanges until the request fits the configured context (local default: 40,960 tokens). A single message that cannot fit is rejected. The updated gateway admits up to two active requests and six waiting requests per process, with FIFO promotion among eligible accounts and no batching collection window. Each signed-in account defaults to one active request, one waiting request, and six accepted requests per rolling minute on each Pod. A separate global rolling limit of 20 accepted requests per minute remains. Queue-full and rate-limit responses have distinct messages; accepted requests may still expire while waiting. The launcher defaults to `MAX_NUM_SEQS=2`; an existing Pod override of `1` retains one active request. This requires the companion gateway release and GPU validation; it does not describe an already deployed concurrency change. The composer allows 120,000 characters; the UI retains at most 799 messages within a 580,000-byte serialized history budget. The API and gateway accept request bodies up to 640,000 bytes and output budgets of 128–10,240 tokens (default 7,680). Character and byte limits do not guarantee that a message fits the token budget. Open **Your workspace → Advanced settings**, enter values, and choose **Apply settings**. Preferences and creativity are saved in this browser; **Reset defaults** restores the limit defaults for the current server. Changes affect the next request and do not modify an active reply. The frontend removes oldest full exchanges to satisfy history and complete-request byte budgets; an oversized newest message is rejected. Both backend layers validate settings, and the gateway enforces them even for direct API requests.


The server resolves the verified Supabase user and `chat_session_active` result once for each chat request, then sends its canonical UUID in private `X-Chat-User-Id`. Client headers/body identity cannot select another account. Base and adapter modes share that Pod's account budget. Account capacity and rate 429 messages are distinct from model-wide limits. Safe rate responses may include validated integer `Retry-After` (1–60 seconds); retries remain manual. The rejected prompt remains in the transcript, recent attachment bytes remain available in the tab, and **Try again** asks you to finish or clear a newer composer draft before retrying. Accepted requests consume quota even if subsequently cancelled or failed; rejections before gateway reservation do not.

Both chat and status fail 503 if gateway health lacks `accountQuotaVersion: 1` or does not set `accountQuotasEnforced: true`. For rollout, first deploy the companion gateway with explicit temporary `CHAT_REQUIRE_USER_ID=false` for old callers, deploy this frontend that sends verified identity, then restart the BF16 gateway with `CHAT_REQUIRE_USER_ID=true` (default). Hold frontend traffic activation until strict health and authenticated streaming are verified for the BF16 Pod; the fail-closed check can cause temporary 503 between these stages. Compatibility mode bounds all missing identities to one shared legacy account and always rejects malformed identity. Normal rollback keeps strict enforcement with a compatible frontend, or disables chat. An old frontend plus temporary compatibility requires an explicit operator security tradeoff. The account limits are gateway-side startup settings, not browser preferences. See [the trust and deployment decision](docs/adr-account-quotas.md).

The gateway advertises versioned limits through authenticated `/health`, reads actual `max_model_len` from private vLLM `/v1/models`, and rechecks capacity for each generation. Context is capped by both that value and `MAX_MODEL_LEN`. A smaller connected server automatically lowers effective browser budgets. The displayed ranges are deployment ceilings, not values the browser can override: raising ceilings requires updating server configuration/code and redeploying. The timeout ranges from 1 to 2,400 seconds and covers queue wait, tokenization, model prefill, and streaming; the safety reserve ranges from 0 to 4,096 tokens. Output plus reserve must leave space for input.

Deploy both updated projects together. An older gateway cannot enforce these settings; the frontend reports that it needs updating rather than silently ignoring preferences. The 40,960-token serving configuration started successfully on the live GPU. Live smoke tests verified a 128-token output cap, a 5-character input rejection, a 512-token context budget trimming one old exchange, and rejection above the deployed context ceiling. These checks do not benchmark maximum-length generation or sustained load. Existing Pod `MAX_MODEL_LEN` overrides still take precedence.

## Vercel deployment

Import this folder as a Next.js project using a supported Node.js 22+ runtime. Add these environment variables (the two Supabase settings are intentionally public; Runpod secrets remain server-only):

| Variable | Purpose |
| --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase project URL |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Supabase publishable key, never secret/service-role key |
| `RUNPOD_BF16_CHAT_URL` | BF16 gateway HTTPS origin |
| `RUNPOD_BF16_CHAT_TOKEN` | Matching separate BF16 chat gateway token |

Never use `NEXT_PUBLIC_` for secret credentials. Local preview is forcibly disabled in production, even if `CHAT_PREVIEW_MODE=true`; missing gateway configuration returns an honest setup/unavailable response. The chat route declares a 300-second maximum execution time for Vercel Hobby compatibility. This includes validation, waiting for the model, and streaming the reply. The configurable generation timeout can be longer locally, but it does not override Vercel’s execution limit; on Vercel, choose a timeout below 300 seconds. Supabase handles authentication rate limits. Complete the migration, Google OAuth provider, disabled email/password and anonymous sign-in, and callback allowlist configuration in [Account setup](docs/accounts.md) before production cutover.

The hosted frontend uses its configured Vercel environment and is linked to `main`; merging changes there triggers a deployment. The BF16 engine and its authenticated gateway run on Runpod. Updating server-side connection variables requires a new frontend deployment.

## Verification

Live deployment verification completed on 2026-10-31 (America/New_York): the protected Runpod gateway served a real streamed Qwen reply and trimmed old turns to the model context. The local browser interface also received a real reply and showed `Model online`. Railway monitoring remained connected. The temporary local verification server was stopped after testing; use `start-local.cmd` to run the frontend on this PC.

Using Node.js 22+:

```bash
npm run typecheck
npm test
npm run build
node scripts/integration.mjs
```

The integration check requires Docker and the sibling inference project. It creates a disposable local gateway container and a separate Next.js process on port 3002, tests real HTTP streaming and cancellation, then removes both. The model in that check is a controlled fixture, not the live GPU model.

For the image attachment check, set `CHAT_TEST_IMAGE_INPUT=true` and `CHAT_TEST_FIXTURE_PYTHON` to a local Python interpreter with FastAPI, HTTPX, Uvicorn, and Pillow installed. `CHAT_TEST_FIXTURE_ROOT` can point to an inference worktree with image input support. Set `CHAT_TEST_PLAYWRIGHT` to the path of an installed Playwright `index.mjs` to also exercise the browser composer.

The focused assistant-image security browser check needs Node.js 22+, existing app dependencies, and an installed Playwright package/browser. In PowerShell:

```powershell
$env:CHAT_TEST_PLAYWRIGHT = 'C:\path\to\playwright\index.mjs'
$env:CHAT_TEST_BROWSER_CHANNEL = 'msedge' # Optional: use an installed Edge instead of Playwright Chromium.
node scripts/check-assistant-images.mjs
```

This check uses only local fake auth and model services on ports 18005 and 18003, plus a test app on port 3002. Leave those ports free. It checks staged SSE responses through the real API proxy and reloaded cloud history, rejects image elements/preloads/network probes even with CSP bypassed, and verifies the CSP separately with a blocked fake external image. It also checks working attachment previews, ordinary Markdown, and copy actions. External image probes are intercepted; no real model, database, credentials, or deployment is needed. The default `npm test` suite also covers rendered markup for every prefix of image Markdown, including same-origin URLs.

From `../llm-inference-server`, build the local image and run the Python checks without a GPU:

```powershell
docker buildx build --platform linux/amd64 --load -t zihan000/qwen-inference:chat-dev .
docker run --rm --entrypoint python3 --mount type=bind,source="${PWD}\scripts",target=/tests,readonly zihan000/qwen-inference:chat-dev /tests/test_chat_gateway.py
docker run --rm --entrypoint python3 --mount type=bind,source="${PWD}\scripts",target=/tests,readonly zihan000/qwen-inference:chat-dev /tests/test_start_server.py
```

## Request diagnostics

Set the server-side environment variable `CHAT_DIAGNOSTICS_ENABLED=true` on both the updated gateway and the frontend. This opt-in works in development, Vercel Preview, and production; it defaults off everywhere. On Vercel, set the variable for the intended environment and redeploy to apply it. The existing session authentication and same-origin checks remain required. The authenticated gateway `/health` advertises `diagnosticsVersion: 1` only when enabled. The frontend's authenticated `/api/status` reports `diagnosticsAvailable: true` and `diagnosticsVersion: 1` only when both services are enabled; older/disabled gateways keep the toggle hidden. Sample-reply preview mode cannot provide tokenizer diagnostics.

Open **Your workspace → Advanced settings → Request diagnostics**. The toggle starts off and affects new requests only; it does not alter message selection, token limits, sampling, or prefix-reuse policy. Each captured reply has an expandable panel showing exact input token counts before/after gateway trimming, removed tokens, output/context budgets, safety reserve, unreserved space, browser/gateway trimming separately, finish reason and vLLM-reported usage when available. The first count already includes system instructions, the served chat template and generation marker, and starts after browser message/byte trimming. Browser byte counts describe the message array serialized as UTF-8 JSON, not tokens or the full request. The gateway reuses its existing tokenizer calls, without extra tokenization requests. A rejected request may have a last tokenizer count but no final input confirmed for generation.

Diagnostic metadata travels in `X-Chat-Diagnostics`; the proxy forwards only a validated versioned summary. Actual usage is requested with `stream_options.include_usage` and read from the final usage-only SSE event. Missing usage/finish reason stays **Unavailable**; stop, error and interrupted states preserve partial records. The parser never counts network chunks as tokens. Prefix reuse is shown as **allowed/bypassed**, not a measured hit. A disagreement between the final tokenizer count and vLLM prompt usage is flagged for investigation.

**Copy record** exports one allowlisted JSON summary. **Export CSV** exports that request; **Export session CSV** in workspace settings exports the latest 100 captured requests across chats, including their status. CSV cells escape quotes/newlines and guard spreadsheet formulas. Neither record nor export includes prompt text, answers, system instructions, credentials, or cache salts. Records and the toggle live only in React memory: reloading or signing out clears them, and nothing is automatically saved to local storage, logs, or disk. Capturing a diagnostic does not change ordinary conversation saving. Files are created only on explicit export. Existing records remain available when the toggle is switched off.

The diagnostics integration test uses a fake model; its tokenizer/usage counts validate transport and UI plumbing, not the real model's tokenization. When Docker is unavailable, use an isolated Python environment containing `httpx`, `fastapi`, and `uvicorn`, set `CHAT_TEST_FIXTURE_PYTHON` to its executable (and `PYTHONPATH` if using a target directory), then run `node scripts/integration.mjs`. Without that variable the test uses the existing Docker fixture. Both paths are localhost-only from the host, opt in to diagnostics explicitly, and clean up their processes after testing.

### Measure responsiveness (learning stage 2)

Request diagnostics now includes browser and gateway durations, and Copy record / CSV exports include the same fields. Browser measurements use `performance.now()` from the accepted Send handler invocation, including local validation/history fitting and the Next.js proxy path:

- **First content received** ends at the first nonempty parsed assistant content, excluding empty/role-only/usage events.
- **First answer rendered (paint estimate)** is recorded separately after nonblank rendered answer text is committed to the DOM, intersects the viewport, and gets a double-animation-frame paint opportunity in a visible tab. It is an estimate, not an exact compositor/display timestamp. Hidden tabs, offscreen answers, navigation, and Markdown-only partial chunks can delay it or leave it unavailable. It can follow stream completion for very short replies.
- **Response completed** ends when the parser receives `[DONE]` successfully. **Request ended** also covers stop/error paths. Stop/error leaves completion unavailable while keeping first-content/render measurements already observed.

Gateway durations arrive in a named `chat-timing` SSE event at stream end, and are accepted only when its request ID matches the validated header. They cover context fitting (including tokenization and trimming), upstream POST to first content, gateway entry to first content, and gateway entry to stream end. Old gateways continue to work with unavailable gateway timings. Metadata uses an allowlist, is session-only, and contains no prompts, answers, secrets, or absolute cross-machine timing timestamps. Never compare wall-clock timestamps between machines or subtract browser/engine p95 values. Grafana remains the source for engine TTFT/ITL/queue metrics.

Start with the [manual pilot worksheet](docs/responsiveness-pilot.md). Deploy the gateway change and frontend through their usual release processes to collect both layers against the live model; the local fixture only verifies instrumentation.

For optional real-browser assertions during `node scripts/integration.mjs`, set `CHAT_TEST_PLAYWRIGHT` to the absolute path of an installed Playwright `index.mjs`. Use its installed Chromium, or set `CHAT_TEST_BROWSER_CHANNEL=msedge` (or `chrome`) for an existing browser. The isolated headless browser signs in only to the local fake-model test app, verifies that two conversations stream together, Stop cancels only the selected reply, the other reply completes, and timing records stay with their replies. No browser package is needed for the default HTTP integration test.

## Concurrent requests and waiting

Different users or browser tabs can submit while the updated gateway is busy: two requests are active and up to six more wait in arrival order. Each conversation permits one active reply, and different conversations in the same browser tab can stream independently. Opening a new conversation or switching conversations keeps background replies running. Stop and Delete cancel only that conversation; signing out or closing the workspace cancels all its requests. Cancelling a queued request frees its waiting slot. The configured timeout includes waiting; a proxy timeout before response headers reports that the model did not start a reply in time. Hosting limits, including the declared 300-second Vercel route limit, still apply. Gateway admission is in-memory, and queued requests are lost on a gateway restart. The new `X-Chat-Rejection` reasons provide queue-full, rate-limit, and queue-timeout messages; older gateways retain the existing generic busy message. No prompts or raw gateway error bodies are copied into these errors.

The integration test checks two live HTTP streams, six waiting requests, overflow, queued disconnect/timeout cleanup and successful requests after cleanup using a fake model. This does not benchmark the GPU. Deploy the updated backend and frontend through their normal release processes after approval; set `MAX_NUM_SEQS=2` explicitly on the Pod and verify real concurrent generation and KV-cache pressure.


## FLUX.2 dev image generation (administrator preview)

Configure the dedicated backend's HTTPS origin in `FLUX_IMAGE_API_URL` and its shared server credential in `FLUX_IMAGE_API_KEY`. These values are server-only. Apply migrations in order before enabling the frontend. In particular, `supabase/migrations/202611100001_web_search_metadata.sql` must already provide `public.clean_web_search_metadata(jsonb)` before applying `supabase/migrations/202611110001_generated_images.sql`. The image migration fails transactionally with a clear prerequisite error if that helper is missing, preserving the previous history cleaner. The backend must implement capability contract version 1 and authenticate all job access by its API credential plus the server-verified `X-Chat-User-Id`; inbound browser identities are never forwarded.

The existing advanced-settings administrator allowlist gates every image route and the Create image composer. Chat attachments continue to use Qwen image understanding. Create image accepts text only and requests one 1024 × 1024 PNG with backend defaults of 28 steps and guidance 4. The backend accepts one generation at a time with no waiting queue; additional submissions receive a busy response. Temporary status, idempotency records, and twenty-starts-per-account/day counters are held in memory and reset when the service restarts. Results expire after 24 hours at most and can become unavailable sooner after a container replacement.

Image bytes are saved in IndexedDB under account-and-message keys. Prompts, request IDs, job IDs and states sync as compact cloud history metadata. Downloads use authenticated `/api/images/{jobId}/image` requests; no public asset URL is stored. A separate account-scoped browser marker is saved before submission and never included in cloud history. Only that originating browser resumes submission, polling or image retrieval after reload. Other browsers display a metadata placeholder and can explicitly generate a new image. If the browser cannot persist its origin marker, generation does not start. Download important results: clearing browser data removes local images, and text history exports do not include image files. History deletion removes this browser's matching blobs and requests cancellation of unfinished known jobs; copies downloaded or retained on another browser are unaffected.

Submission IDs remain stable through retries and reloads, so an interrupted submission checks the same idempotent backend request. Cancellation is cooperative; completion may win if an image has already been persisted. Backend status and result retention remain authoritative. The proxy permits HTTPS in production, bounds JSON and image bodies, validates fixed-size PNG headers, and returns allowlisted metadata and errors.
