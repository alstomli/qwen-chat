# Qwen Chat

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

The gateway uses vLLM's `/tokenize` endpoint to count the exact chat template, reserves space for the reply plus the configured safety reserve (default 32 tokens), and drops the oldest full exchanges until the request fits the configured context (local default: 40,960 tokens). A single message that cannot fit is rejected. One generation is allowed at a time, with a per-process limit of 20 accepted requests per minute. This matches the existing single-sequence model. The composer allows 120,000 characters; the UI retains at most 799 messages within a 580,000-byte serialized history budget. The API and gateway accept request bodies up to 640,000 bytes and output budgets of 128–10,240 tokens (default 7,680). Character and byte limits do not guarantee that a message fits the token budget. Open **Your workspace → Advanced settings**, enter values, and choose **Apply settings**. Preferences and creativity are saved in this browser; **Reset defaults** restores the limit defaults for the current server. Changes affect the next request and do not modify an active reply. The frontend removes oldest full exchanges to satisfy history and complete-request byte budgets; an oversized newest message is rejected. Both backend layers validate settings, and the gateway enforces them even for direct API requests.

The gateway advertises versioned limits through authenticated `/health`, reads actual `max_model_len` from private vLLM `/v1/models`, and rechecks capacity for each generation. Context is capped by both that value and `MAX_MODEL_LEN`. A smaller connected server automatically lowers effective browser budgets. The displayed ranges are deployment ceilings, not values the browser can override: raising ceilings requires updating server configuration/code and redeploying. The timeout ranges from 1 to 2,400 seconds and covers tokenization, model prefill, and streaming; the safety reserve ranges from 0 to 4,096 tokens. Output plus reserve must leave space for input.

Deploy both updated projects together. An older gateway cannot enforce these settings; the frontend reports that it needs updating rather than silently ignoring preferences. The 40,960-token serving configuration started successfully on the live GPU. Live smoke tests verified a 128-token output cap, a 5-character input rejection, a 512-token context budget trimming one old exchange, and rejection above the deployed context ceiling. These checks do not benchmark maximum-length generation or sustained load. Existing Pod `MAX_MODEL_LEN` overrides still take precedence.

## Later Vercel deployment

Import this folder as a Next.js project using a supported Node.js 22+ runtime. Add these server-side environment variables:

| Variable | Purpose |
| --- | --- |
| `CHAT_PASSWORD` | A non-empty personal workspace password; no minimum length |
| `SESSION_SECRET` | Random signing secret, at least 32 characters |
| `RUNPOD_CHAT_URL` | HTTPS origin of the deployed chat gateway |
| `RUNPOD_CHAT_TOKEN` | Matching separate chat gateway token |

Never use `NEXT_PUBLIC_` for credentials. Local preview is forcibly disabled in production, even if `CHAT_PREVIEW_MODE=true`; missing gateway configuration returns an honest setup/unavailable response. The chat route allows up to 3,000 seconds, with shorter internal model and proxy timeouts. Check the eventual Vercel plan limits before deploying. Login throttling is best-effort per server instance; it is not a distributed account lockout. Add centralized rate limiting and proper user accounts before opening the app to multiple people.

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
