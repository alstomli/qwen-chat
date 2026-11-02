# Responsiveness pilot

Use Grafana for engine TTFT, ITL and queue time; use Request diagnostics for browser/gateway durations. A standalone benchmark runner is deferred. This worksheet does not claim measured live results.

1. Enable diagnostics on both services and switch Request diagnostics on under Your workspace → Advanced settings. Verify the timing-enabled gateway/frontend versions are deployed. Keep temperature, output budget (start at 128), thinking settings (off), context budget, and prefix reuse fixed. Record the model, image/commit, GPU, settings, and Grafana time window.
2. With no overlapping requests, run each fixed prompt below in a new chat. Record the first run separately, then repeat each prompt twice. Stay in the visible chat with the answer in view. A warm engine and an already cached matching prefix are different conditions; note first/repeated requests and reuse policy without claiming a cache hit.
3. Expand Request diagnostics and export the session CSV. Confirm actual prompt/output usage and finish reason; note failures or `length` truncation. Missing values remain unavailable. Token counts come from the served template/tokenizer, not word estimates.
4. Compare first content and first render in each browser record, context-fitting costs, and upstream first content at the gateway. Inspect the matching Grafana window for engine TTFT/ITL and queueing. These boundaries overlap; do not add durations as independent phases or subtract their percentiles.
5. Keep this a small pilot (nine requests). Report individual values/ranges, not a reliable p95 or a causal speedup. If one path looks costly, choose one controlled follow-up comparison and a numerical target after the baseline exists.

Fixed prompts:

| Case | Prompt |
| --- | --- |
| Short explanation | Explain prefill and decode in three short sentences. |
| Chinese | 用三句话解释大语言模型中的 KV 缓存，并说明它为什么不是长期记忆。 |
| Code | Write a Python function that returns the average of a list of numbers. Raise ValueError for an empty list. Include one example. |

Attach raw CSV and record one row per request:

| Case / repetition | Actual input / output tokens | Browser first content / first render / completion (ms) | Gateway context fit / upstream first content / total (ms) | Finish reason / quality / failures | Cache conditions / Grafana window |
| --- | --- | --- | --- | --- | --- |
| To measure | | | | | |

If any gateway timing is unavailable, check that the gateway emits `chat-timing`, that the request finished normally, and that its request ID matches the diagnostic header. A stopped/disconnected stream may lose final gateway metadata and usage. Browser first render can remain unavailable while the tab/chat is hidden or the answer is offscreen.
