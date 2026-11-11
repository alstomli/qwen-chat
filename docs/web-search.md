# Web search

Search web is off by default. Turn it on in the composer for one message to require a web lookup. It resets after sending, when switching conversations. Try again preserves whether that message required search. The user's question is sent to the configured search provider; the UI explains this before sending. Image input and web lookup use separate messages.

Availability is checked through the authenticated `/api/status` endpoint and the selected model/adapter profile. A gateway advertising only ordinary chat remains usable for ordinary messages. Explicit search fails if the gateway cannot verify support or does not return `X-Chat-Web-Search: 1`; it never silently becomes ordinary chat. BF16 needs an exact base/adapter profile capability. No provider key is configured in browser or Next.js public variables.

Requests use `webSearch: {version: 1, mode: "required"}`. The public contract also validates `off` and `auto`; omitted or off follows the existing chat path. The MVP exposes the explicit search control. Auth, account quotas, adapter confirmation, image handling, and legacy `docsSources` continue to apply.

Version-one SSE `web-status`, `web-sources`, and `web-complete` events have one run ID and increasing sequence numbers. Sources are cumulative and IDs cannot be rebound to a different URL. Both the server proxy and browser validate the metadata. Registered `[S1]` markers and source URLs become links scoped to that message; unregistered links in a web answer are rendered as text. Code blocks remain unchanged. The sources list distinguishes search snippets from pages actually read and records retrieval time. A failed, stopped, or interrupted run retains that state and does not show a successful web-answer label.

The proxy's web deadline is the lesser of 240 seconds and the effective request timeout, measured from route entry, below the route's 300-second limit. Stop cancels the stream and upstream request. Backend search, page-reading and model-call budgets apply within that deadline. Ordinary messages retain their existing timeout behavior.

## Rollout

1. Apply `supabase/migrations/202611100001_web_search_metadata.sql` after the two existing migrations. This replaces the existing payload cleaner additively and adds a private metadata cleaner; it preserves history RPCs, ownership controls and old docs metadata.
2. Deploy the companion inference gateway update, configure its server-side search provider key, and enable only model/adapter aliases whose native tool calling has been verified. Provider enablement and real-model verification are separate operational steps.
3. Deploy this frontend after the gateway and database changes. It needs no search provider credentials or additional public environment variables. Until an alias advertises verified availability, Search web shows an unavailable explanation.

Browser storage, cloud history and JSON/Markdown exports retain only bounded citation metadata: version, run ID, terminal outcome, and up to ten source IDs, titles, URLs, retrieval times and evidence kinds. No raw pages, snippets, tool arguments, provider keys or tool traces are saved. User messages retain the small `searchRequested` flag for retries. Follow-up model messages remain the existing text-only history; source registries are not concatenated into prompts or rebound across turns.

Local validation uses unit and route fixtures, a production build, and local PostgreSQL migration checks. These checks do not provision a search provider, apply hosted migrations, deploy services, or prove native tool calling on the live BF16 model. Those operational checks remain necessary before enabling a live profile.
