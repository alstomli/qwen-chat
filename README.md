# Qwen Chat

A personal chat workspace for the existing Qwen model on Runpod. The frontend and server-side API are built with Next.js 16, React 19, and TypeScript, ready for a later Vercel deployment.

**Current status:** the frontend is built locally and has not been deployed to Vercel. Runpod Pod `hrqjt6otlehqgh` uses inference image `zihan000/qwen-inference:0.2.0`, including automatic chat gateway and monitoring startup. The local `.env.local` points to the authenticated live gateway at `https://hrqjt6otlehqgh-8001.proxy.runpod.net`, and preview mode is disabled. On each Pod restart, the model needs to load and warm up before chat and live metrics are available.

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
- Adjustable response length (384/768/1024 tokens) and creativity.
- Personal password login, expiring signed HttpOnly sessions, same-origin mutation checks, and bounded request bodies.
- Live readiness checks and clear offline, loading, interrupted, and context-limit messages.
- Conversations are stored in this browser's local storage, not synced between devices or encrypted by the app. In live mode the selected conversation history is sent through the Vercel server and Runpod gateway to your model. The app and gateway do not log prompts or replies; hosting platforms may retain operational metadata.

## Live model connection

The configured flow is:

```text
Browser → local Next.js /api/chat → token-protected Runpod gateway → private vLLM
```

The source for the gateway and its startup integration is in the sibling `../llm-inference-server` project:

- `scripts/chat-gateway.py`: authenticated `/health` and streaming `POST /v1/chat/completions` only. Model-management, metrics, docs, and arbitrary upstream paths are not exposed.
- `scripts/start-server.sh`: `CHAT_ENABLED=true` starts the gateway automatically; `METRICS_ENABLED=true` retains automatic monitoring. A service failure stops the launcher and other services. This is not a guarantee of automatic host recovery.
- `Dockerfile`: includes the gateway without any secrets. The live release is `zihan000/qwen-inference:0.2.0`; the local test image is `zihan000/qwen-inference:chat-dev`. Do not replace published release tags when changing code.

The following settings were applied to the existing Pod; retain them when replacing it:

1. Save a separate chat token of at least 32 characters at `/workspace/chat/chat-token`, readable only by the service owner. The generated `RUNPOD_CHAT_TOKEN` in this app's `.env.local` is prepared for this purpose; do not reuse the monitoring token.
2. Deploy the new image with the existing network volume. Keep `METRICS_ENABLED=true` and `METRICS_HOST=0.0.0.0`; add `CHAT_ENABLED=true`, `CHAT_HOST=0.0.0.0`, and `CHAT_PORT=8001`. Keep vLLM bound to `127.0.0.1`.
3. Add HTTP port 8001 to the existing port list, preserving 8888. Keep the current model configuration and persistent caches.
4. Set this app's `RUNPOD_CHAT_URL` to the gateway's HTTPS origin, without `/v1` or another path. Set the matching `RUNPOD_CHAT_TOKEN`, then restart/redeploy the frontend.
5. Verify authentication failures, streaming, cancellation, Pod restart, and monitoring before relying on the live connection.

The gateway uses vLLM's `/tokenize` endpoint to count the exact chat template, reserves space for the reply, and drops the oldest full exchanges until the request fits the configured 4,096-token context. A single message that cannot fit is rejected. One generation is allowed at a time, with a per-process limit of 20 accepted requests per minute. This matches the existing single-sequence model. The UI also caps histories to fit its request body limit.

## Later Vercel deployment

Import this folder as a Next.js project using a supported Node.js 22+ runtime. Add these server-side environment variables:

| Variable | Purpose |
| --- | --- |
| `CHAT_PASSWORD` | A strong personal workspace password, at least 16 characters |
| `SESSION_SECRET` | Random signing secret, at least 32 characters |
| `RUNPOD_CHAT_URL` | HTTPS origin of the deployed chat gateway |
| `RUNPOD_CHAT_TOKEN` | Matching separate chat gateway token |

Never use `NEXT_PUBLIC_` for credentials. Local preview is forcibly disabled in production, even if `CHAT_PREVIEW_MODE=true`; missing gateway configuration returns an honest setup/unavailable response. The chat route allows up to 300 seconds, with shorter internal model and proxy timeouts. Check the eventual Vercel plan limits before deploying. Login throttling is best-effort per server instance; it is not a distributed account lockout. Add centralized rate limiting and proper user accounts before opening the app to multiple people.

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
