# Bounded cloud history for the test project

Status: accepted for implementation; hosted rollout is separate.

## Decision

Use the existing Supabase Postgres project for new conversations. Keep all
pre-existing browser conversations local, even when they are continued. Do not
import anonymous or account-scoped legacy history automatically.

Cap registered accounts at 100 with a transactionally maintained database counter.
The signin page reports availability but is not an enforcement boundary. Existing
accounts can sign in at capacity; deleting an account frees its slot. A signup
failure must roll back both the account and counter update.

Each account may retain 50 cloud conversations and 2,000,000 bytes of serialized
UTF-8 conversation content and metadata. Enforce both limits in the same database
transaction as the save. Evict whole conversations in last-message order, never
the conversation being saved. Reading a conversation must not renew its age.
Do not truncate an oversized active conversation: retain unsaved content locally
and offer export or a new conversation.

Use a compact conversation payload rather than a separate row for every streamed
token. Keep list metadata outside the payload so listing titles never downloads
message bodies. Return message bodies in pages. The server calculates quota usage;
client-supplied counts, ownership, or timestamps cannot authorize extra space.

## Reliability and access

History persistence is independent of inference. Save the prompt and terminal
response snapshots through an account-scoped local outbox; do not wait for history
writes before starting inference and do not write each streaming token to Postgres.
A closed browser can interrupt generation and leave an incomplete answer. The UI
must distinguish a confirmed cloud save from a local pending copy.

Owner-only database access, revision checks, and idempotent retries protect against
cross-account access, lost-response retries, and stale tabs. A deleted conversation
must not be recreated automatically. Retry metadata must itself have bounded
retention; expired or conflicting work stays local for explicit recovery.

Cloud history contains text, model/adapter choices, message status, attachment
filenames, and citations. It excludes attachment bytes, auth tokens, and diagnostic
records. Explicit exports contain the complete conversation, not only its loaded
page. Deletion and eviction remove cloud history across devices; offline browser
copies are not a guaranteed backup.

## Tradeoffs and operating limits

The quotas allow at most 200 MB of serialized conversation payload across 100 accounts.
This is not the physical database size: accounts, indexes, retry metadata, and
Postgres maintenance overhead also consume space. A physical-size guard and
operational monitoring therefore complement the per-account quota. Reads and
deletion remain available when cloud writes are paused.

Saving conversation snapshots simplifies atomic quotas and the existing client
integration, but rewrites more data than appending individual message rows. The
small fixed per-account budget makes that tradeoff acceptable for this test
project. Revisit normalized message storage before increasing quotas or scale.

Keep the Supabase Free plan and add no paid storage or automatic upgrade. Monitor
database size and monthly egress separately; bounded storage does not bound
repeated downloads. Paginated reads, caching, and focus-based refresh reduce
traffic. Free-tier service restrictions remain possible if provider quotas are
exhausted. See the operations runbook for guard thresholds and release checks.
