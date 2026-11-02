# Qwen Chat

Advanced settings includes **Reuse cached prefixes**, on by default and saved in this browser. Turning it off makes the gateway isolate each request's prefix cache using a fresh server-generated salt. It does not free reserved GPU memory or disable cache writes. The toggle requires the companion inference-server gateway update; older gateways remain usable with the default behavior and the toggle disabled. Deploy the backend update before the frontend. Deployment requires separate approval.

A personal chat workspace for the existing Qwen model on Runpod. The frontend and server-side API are built with Next.js 16, React 19, and TypeScript, ready for a later Vercel deployment.

**Current status (November 1, 2026):** the production frontend is running on this PC at `http://127.0.0.1:3001`; it has not been deployed to Vercel. Active Runpod Pod `fj04zaugwd1u83` uses `zihan000/qwen-inference:0.3.0`, with authenticated chat and monitoring startup. The model is ready and advertises a verified 40,960-token context ceiling. Frontend Advanced settings are enforced by the deployed gateway. The local `.env.local` points to `https://fj04zaugwd1u83-8001.proxy.runpod.net`; preview mode is disabled. The frontend stops when its local process or PC stops.

## Run locally

This PC has a project-local Node.js 22 runtime at `D:\AILearn\.tools\node_modules\node\bin\node.exe`; the system's Node.js 19 default was not changed.

From PowerShell:

```powershell
cd D:\AILearn\qwen-chat
.\start-local.cmd
```

Then open http://127.0.0.1:3001. The password is in `.local/login.txt` and `CHAT_PASSWORD` in `.env.local`. These files are ignored and must remain private. The setup script generates them once and preserves existing credentials on subsequent runs.

On another machine with Node.js 22 or newer:

```bash
npm ci
npm run setup
npm run dev
```

No database, paid chat provider, or OpenAI account is required. The app is configured for your live Runpod model. For an isolated local preview, clear `RUNPOD_CHAT_URL` and set `CHAT_PREVIEW_MODE=true`; sample replies are clearly labeled and make no model requests. Stop the local server with Ctrl+C.

## Included behavior

- Streaming replies; stop generation, retry, copy response/code, Markdown, tables, and safe links.
- Multiple conversations, search, new chat, confirmed deletion, and recovery after a page reload.
- Desktop and mobile layouts, keyboard submission, accessible labels, and reduced-motion support.
- Persistent Advanced settings for input characters, output tokens, context tokens, history messages/bytes, request bytes, generation timeout, and safety tokens, plus adjustable creativity.
- Personal password login, expiring signed HttpOnly sessions, same-origin mutation checks, and bounded request bodies.
- Live readiness checks and clear offline, loading, interrupted, and context-limit messages.
- Conversations are stored in this browser's local storage, not synced between devices or encrypted by the app. In live mode the selected conversation history is sent through the Vercel server and Runpod gateway to your model. The app and gateway do not log prompts or replies; hosting platforms may retain operational metadata.

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

1. Save a separate chat token of at least 32 characters at `/workspace/chat/chat-token`, readable only by the service owner. The generated `RUNPOD_CHAT_TOKEN` in this app's `.env.local` is prepared for this purpose; do not reuse the monitoring token.
2. Deploy the new image with the existing network volume. Keep `METRICS_ENABLED=true` and `METRICS_HOST=0.0.0.0`; add `CHAT_ENABLED=true`, `CHAT_HOST=0.0.0.0`, and `CHAT_PORT=8001`. Keep vLLM bound to `127.0.0.1`.
3. Add HTTP port 8001 to the existing port list, preserving 8888. Keep the current model configuration and persistent caches.
4. Set this app's `RUNPOD_CHAT_URL` to the gateway's HTTPS origin, without `/v1` or another path. Set the matching `RUNPOD_CHAT_TOKEN`, then restart/redeploy the frontend.
5. Verify authentication failures, streaming, cancellation, Pod restart, and monitoring before relying on the live connection.

The gateway uses vLLM's `/tokenize` endpoint to count the exact chat template, reserves space for the reply plus the configured safety reserve (default 32 tokens), and drops the oldest full exchanges until the request fits the configured context (local default: 40,960 tokens). A single message that cannot fit is rejected. The updated gateway admits up to two active requests and six FIFO waiting requests per process, with no batching collection window. A separate rolling limit of 20 accepted requests per minute remains. Queue-full and rate-limit responses have distinct messages; accepted requests may still expire while waiting. The launcher defaults to `MAX_NUM_SEQS=2`; an existing Pod override of `1` retains one active request. This requires the companion gateway release and GPU validation; it does not describe an already deployed concurrency change. The composer allows 120,000 characters; the UI retains at most 799 messages within a 580,000-byte serialized history budget. The API and gateway accept request bodies up to 640,000 bytes and output budgets of 128–10,240 tokens (default 7,680). Character and byte limits do not guarantee that a message fits the token budget. Open **Your workspace → Advanced settings**, enter values, and choose **Apply settings**. Preferences and creativity are saved in this browser; **Reset defaults** restores the limit defaults for the current server. Changes affect the next request and do not modify an active reply. The frontend removes oldest full exchanges to satisfy history and complete-request byte budgets; an oversized newest message is rejected. Both backend layers validate settings, and the gateway enforces them even for direct API requests.

The gateway advertises versioned limits through authenticated `/health`, reads actual `max_model_len` from private vLLM `/v1/models`, and rechecks capacity for each generation. Context is capped by both that value and `MAX_MODEL_LEN`. A smaller connected server automatically lowers effective browser budgets. The displayed ranges are deployment ceilings, not values the browser can override: raising ceilings requires updating server configuration/code and redeploying. The timeout ranges from 1 to 2,400 seconds and covers queue wait, tokenization, model prefill, and streaming; the safety reserve ranges from 0 to 4,096 tokens. Output plus reserve must leave space for input.

Deploy both updated projects together. An older gateway cannot enforce these settings; the frontend reports that it needs updating rather than silently ignoring preferences. The 40,960-token serving configuration started successfully on the live GPU. Live smoke tests verified a 128-token output cap, a 5-character input rejection, a 512-token context budget trimming one old exchange, and rejection above the deployed context ceiling. These checks do not benchmark maximum-length generation or sustained load. Existing Pod `MAX_MODEL_LEN` overrides still take precedence.

## Later Vercel deployment

Import this folder as a Next.js project using a supported Node.js 22+ runtime. Add these server-side environment variables:

| Variable | Purpose |
| --- | --- |
| `CHAT_PASSWORD` | A non-empty personal workspace password; no minimum length |
| `SESSION_SECRET` | Random signing secret, at least 32 characters |
| `RUNPOD_CHAT_URL` | HTTPS origin of the deployed chat gateway |
| `RUNPOD_CHAT_TOKEN` | Matching separate chat gateway token |

Never use `NEXT_PUBLIC_` for credentials. Local preview is forcibly disabled in production, even if `CHAT_PREVIEW_MODE=true`; missing gateway configuration returns an honest setup/unavailable response. The chat route declares a 300-second maximum execution time for Vercel Hobby compatibility. This includes validation, waiting for the model, and streaming the reply. The configurable generation timeout can be longer locally, but it does not override Vercel’s execution limit; on Vercel, choose a timeout below 300 seconds. Login throttling is best-effort per server instance; it is not a distributed account lockout. Add centralized rate limiting and proper user accounts before opening the app to multiple people.

No Vercel project, GitHub repository, or frontend cloud deployment was created. The live model and chat gateway run on the existing Runpod Pod.

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

For optional real-browser assertions during `node scripts/integration.mjs`, set `CHAT_TEST_PLAYWRIGHT` to the absolute path of an installed Playwright `index.mjs`. Use its installed Chromium, or set `CHAT_TEST_BROWSER_CHANNEL=msedge` (or `chrome`) for an existing browser. The isolated headless browser signs in only to the local fake-model test app, verifies that first render follows content and precedes completion, and checks partial timing after Stop. No browser package is needed for the default HTTP integration test.

## Concurrent requests and waiting

Different users or browser tabs can submit while the updated gateway is busy: two requests are active and up to six more wait in arrival order. The current tab still permits one active send. Stop or disconnect cancels a queued request and frees its waiting slot. The configured timeout includes waiting; a proxy timeout before response headers reports that the model did not start a reply in time. Hosting limits, including the declared 300-second Vercel route limit, still apply. Gateway admission is in-memory, and queued requests are lost on a gateway restart. The new `X-Chat-Rejection` reasons provide queue-full, rate-limit, and queue-timeout messages; older gateways retain the existing generic busy message. No prompts or raw gateway error bodies are copied into these errors.

The integration test checks two live HTTP streams, six waiting requests, overflow, queued disconnect/timeout cleanup and successful requests after cleanup using a fake model. This does not benchmark the GPU. Deploy the updated backend and frontend through their normal release processes after approval; set `MAX_NUM_SEQS=2` explicitly on the Pod and verify real concurrent generation and KV-cache pressure.
