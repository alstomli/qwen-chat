# Kiddo Chat

A personal chat workspace using Next.js 16, React 19, TypeScript, Supabase accounts/history, and a private Qwen BF16 service on Runpod. Optional administrator image generation uses a separate FLUX service.

```text
Browser → Next.js → authenticated Qwen gateway → private vLLM
                 → Supabase Auth and conversation history
                 → authenticated FLUX image jobs (administrators)
```

Qwen3.8-27B-bf16 is the sole supported chat model. Its base and trained-adapter modes share the same service and account quota. Unsupported model IDs are rejected; historical conversations with unsupported model metadata are omitted rather than relabeled. Browser storage keys remain stable to preserve supported history and preferences.

## Run locally

Use Node.js 22 or newer:

```sh
npm ci
npm run setup
npm run dev
```

Open [the local app](http://127.0.0.1:3001). Setup creates `.env.local` from `.env.example` only when absent. Configure Google sign-in and Supabase using [account setup](docs/accounts.md), then apply the [ordered database migrations](docs/cloud-history-operations.md) needed by this client. For this Windows workspace, `start-local.cmd` uses the project-local Node runtime when available and checks that dependencies are installed.

| Environment variable | Purpose |
| --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | Public Supabase project URL |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Public client key; never a service-role key |
| `RUNPOD_BF16_CHAT_URL` | BF16 gateway HTTPS origin, without a path |
| `RUNPOD_BF16_CHAT_TOKEN` | Private chat gateway credential |
| `FLUX_IMAGE_API_URL`, `FLUX_IMAGE_API_KEY` | Optional private FLUX service connection |
| `CHAT_DIAGNOSTICS_ENABLED` | Server diagnostics opt-in; defaults off |

Keep private credentials server-only. Configure each Vercel Production/Preview environment separately and rebuild after changing settings; local `.env.local` does not configure hosting. The public Supabase values are embedded in the client build. A missing gateway binding produces an unavailable response, with no fallback service.

For isolated sample replies, clear `RUNPOD_BF16_CHAT_URL` and set `CHAT_PREVIEW_MODE=true`. Supabase accounts remain required. Preview replies are labeled and make no model requests; this mode is disabled in production.

## Behavior

- Stream, stop, retry and copy Markdown replies; search and export conversations.
- Keep multiple conversations streaming independently. Stop/Delete affect the selected conversation; sign-out closes all its requests.
- Use Google sign-in with verified live sessions and a 100-account registration cap. New conversations sync through Supabase; older browser-only conversations remain local.
- Retain up to 50 cloud conversations or 2,000,000 bytes per account. Whole oldest conversations may be evicted on save. Settings and pending saves remain in account-scoped browser storage. See [history operations and recovery](docs/cloud-history-operations.md).
- **Attach image** sends one JPEG/PNG/WebP with a chat prompt to Qwen for text understanding when its gateway advertises vision support. Use BF16 base mode. Attachment bytes remain in the open tab; reload/retry can require reattachment. Assistant Markdown images are suppressed; user previews and generated-image cards remain available.
- **Search web** is an explicit per-message option, available only for verified backend model/adapter profiles. Provider configuration stays on the gateway. See [web search](docs/web-search.md).
- Administrators can use **Create image** for FLUX text-to-image generation and **Edit this image** for a saved local result. These are separate from Qwen chat attachments. See [image generation and reference editing](docs/image-generation.md).

Advanced settings and request diagnostics require a server-verified account from the administrator allowlist. Regular users retain Creativity, connection status and history controls, use gateway-fitted defaults, reuse prefixes, and use BF16 base mode. Browser preferences cannot grant administrator access. For administrators, adapter choice is saved per conversation and recorded on each answer; changing it does not relabel previous answers. Requests fail closed when the gateway cannot confirm the requested adapter mode.

Initial chat defaults are 40,960 context tokens, 7,680 output tokens and 32 safety tokens. Verified gateway capacity takes precedence. The gateway counts the served chat template and trims oldest full exchanges to fit; byte/character limits do not guarantee a token fit. Prefix reuse defaults on; turning it off isolates each request with a fresh server-generated cache salt without freeing reserved GPU memory.

The gateway defaults to two active requests and six waiting requests per process, bounded further by the Pod's engine setting. Per-account defaults are one active, one waiting and six accepted requests per minute; a separate global limit is 20 accepted requests per minute. Accepted requests consume quota even if later cancelled or failed. Queued time counts toward the timeout. Vercel's chat route retains a 300-second platform execution limit and enforces a 240-second application deadline from route entry, including authentication, validation, readiness, waiting and streaming. Shorter requested timeouts and the web-search deadline still apply. Local servers retain custom timeouts. The gateway receives the remaining budget and Stop/disconnect aborts upstream work. See the backend [quota decision](https://github.com/alstomli/llm-inference-server/blob/main/docs/adr-account-quotas.md).

## Development checks

```sh
npm test
npm run typecheck
npm run build
node scripts/integration.mjs
```

Unit tests use mocks. Integration runs local fake authentication and model services plus a separate app on port 3002; it does not prove live GPU performance. Clone [llm-inference-server](https://github.com/alstomli/llm-inference-server) beside this repository, or set `CHAT_TEST_FIXTURE_ROOT`. By default integration uses a disposable Docker fixture (`zihan000/qwen-inference:chat-dev`, built locally from the backend). Alternatively set `CHAT_TEST_FIXTURE_PYTHON` to an interpreter with FastAPI, HTTPX, Uvicorn and Pillow installed. Set `CHAT_TEST_IMAGE_INPUT=true` to include vision checks.

Optional browser checks use `CHAT_TEST_PLAYWRIGHT` with an installed Playwright `index.mjs`; `CHAT_TEST_BROWSER_CHANNEL=msedge` or `chrome` selects an existing browser. `node scripts/check-assistant-images.mjs` separately verifies Markdown image suppression and CSP with local fixtures. [Database checks](docs/cloud-history-operations.md#local-postgresql-verification) apply the actual migrations to disposable local PostgreSQL semantics fixtures.

## Operations and design

- [Accounts and Google sign-in](docs/accounts.md), [branding rollout](docs/branding-rollout.md), and the app's [privacy page](src/app/privacy/page.tsx).
- [Cloud history runbook and migration order](docs/cloud-history-operations.md), [history design](docs/adr-cloud-history.md), and [quota trust boundary](docs/adr-account-quotas.md).
- [Request diagnostics](docs/request-diagnostics.md) and [manual responsiveness worksheet](docs/responsiveness-pilot.md).
- [Generated-image design](docs/generated-image-adr.md), [image operations](docs/image-generation.md), and [web search](docs/web-search.md).
- Backend [current runtime snapshot](https://github.com/alstomli/llm-inference-server/blob/569575164c2d1f165cdbc151df7e684ccad72040/deployments/qwen-bf16/CURRENT.md) and [Go gateway operations](https://github.com/alstomli/llm-inference-server/blob/main/docs/GATEWAY-GO.md).

The backend owns model startup, authenticated gateway/metrics exposure, immutable image releases, and rollback. Do not copy historical Pod endpoints or old image tags into new deployments. Deploy compatible gateways and database migrations before activating a dependent frontend; check actual target state before applying changes. Source changes and local tests do not apply hosted SQL, publish images, restart Pods or deploy the frontend.
