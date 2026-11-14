# Cloud history release and operations

This runbook describes the current source requirements; it does not establish which migrations are installed in any hosted project. See the [accepted design](adr-cloud-history.md), [account setup](accounts.md), and [image operations](image-generation.md).

## Migration order

Apply missing reviewed migrations in filename order, checking the target's migration records and actual schema first. Fresh installations need all eight; existing installations need only their unapplied suffix. Do not replay fresh-install SQL or assume an earlier release's hosted state.

| Order | Migration | Purpose |
| --- | --- | --- |
| 1 | `202611080001_accounts.sql` | Google accounts and live-session controls |
| 2 | `202611080002_cloud_history.sql` | Account-scoped history, retention and storage guard |
| 3 | `202611100001_web_search_metadata.sql` | Bounded citations and web-search cleaner |
| 4 | `202611100002_bf16_only.sql` | BF16-only history writes |
| 5 | `202611110001_generated_images.sql` | Generated-image metadata; requires the web-search cleaner |
| 6 | `202611110002_reference_image_metadata.sql` | Version-2 reference-edit metadata |
| 7 | `202611110003_versioned_image_history_reads.sql` | `get_chat_history_v2`; protects edits from older readers |
| 8 | `202611110004_versioned_image_history_writes.sql` | `save_chat_v2`; protects edits from older writers |

Migration files live in [supabase/migrations](../supabase/migrations). The current client requires the versioned read/write RPCs before activation. Keep the legacy guards: older open tabs must receive reload/conflict responses rather than strip edit intent. New client and legacy operations share session, ownership, revision and quota protections.

Do not merge to `main` to test: the linked production deployment follows `main`. Hosted migrations, scheduler installation, merge and deployment are separate release actions. Local checks do not perform them.

## Limits and the physical guard

The account counter enforces 100 registered accounts. Existing accounts remain
able to sign in at capacity. Every account gets at most 50 cloud conversations and
2,000,000 UTF-8 payload bytes, with whole oldest conversations evicted on save.
Older browser conversations stay local, including when continued. Eviction and
deletion are destructive; an app rollback cannot recreate that content.

The maximum 200 MB payload allocation is not a database reservation or a physical
size bound. Auth, indexes, TOAST, deleted-row space, tombstones, catalog data, and
other application data consume the same database. Supabase Free currently has a
[500 MB database allowance](https://supabase.com/docs/guides/platform/billing-on-supabase).
The guard measures `pg_database_size(current_database())`, which PostgreSQL
[defines as total database disk space](https://www.postgresql.org/docs/current/functions-admin.html#FUNCTIONS-ADMIN-DBSIZE).
It is separate from WAL/disk provisioning and provider usage reports.

Thresholds use decimal bytes, not MiB:

| Measurement | Action |
| --- | --- |
| Below 350,000,000 | Clear the automatic pause |
| 350,000,000 through 399,999,999 | Warn; preserve an existing pause |
| At least 400,000,000 | Pause cloud saves |

`public.chat_storage_guard` is an owner-only singleton with `singleton`,
`measured_bytes`, `measured_at`, and `writes_paused`. The service-role/operator-only
RPC `public.measure_chat_storage()` returns `bytes`, `paused`, `warning`, and
`measuredAt`. Each actual payload write also measures inside the guarded
transaction; it does not trust a day-old sample. A daily job provides measurements
during inactivity. Idempotent acknowledgements and rejected saves may return
before measurement.
No service-role key belongs in the app or its browser bundle.
Measurement also prunes deletion markers older than **48 hours**. This retention
period is separate from the **24-hour initial-create window**: creating an absent
conversation requires its original `p_created_at` to be within the preceding
24 hours (with at most one minute of future clock skew). An expired initial save
stays local for explicit recovery. Updates to an existing conversation do not
expire solely because its creation was more than 24 hours ago; revision checks
still apply. An absent conversation submitted with a positive revision returns
`deleted` even after its deletion marker is pruned. Verify these boundaries with
the client before release; do not describe all retries as having a 48-hour window.
New creates also return `create_limited` while an account has at least 1,000
deletion markers; existing conversations can still be updated. Inspect marker
retention and the daily measurement job before retrying that condition.
Deleting an absent ID also records a marker, preventing an in-flight first save
from recreating it later. These new absent-ID markers are capped at 1,000 per
account; at capacity, that deletion stays pending until expiry allows a retry.
Deleting an existing conversation or replaying an existing marker still works.

The check is before a save, so one accepted transaction can take the measured
database above 400 MB. Other services can also grow it. The headroom is deliberate,
not an absolute guarantee against a provider restriction. Saves share a guard-row
lock; measure real save latency and contention before increasing traffic.
Reads, deletion, sign-in, and inference must continue while cloud saves are paused.
The guard does not configure database-wide read-only mode or disable Auth.

## Preflight before any hosted changes

1. Record the approved source commit, current deployment ID, target project ref,
   Supabase plan, and current organization billing-cycle dates. Confirm this is the
   existing Google-only account project, not another database.
2. Compare recorded migrations and actual functions, triggers and policies with
   the ordered chain above. Investigate partial/manual installs before proceeding.
   Do not replay already-applied migrations. For a fresh install begin with 001.
3. Run the read-only SQL below in the intended project's SQL editor as owner.
   Stop if the database is already at the warning threshold, the account counter
   would begin above 100, permissions differ, or existing triggers conflict.
4. Export a protected logical backup and record its timestamp and restore steps
   before applying any missing migrations. Validate the backup in a disposable database. Do not place
   backups in this repository or a public artifact. Supabase recommends off-site
   CLI exports for Free projects; [automatic daily backups and PITR are not Free
   guarantees](https://supabase.com/docs/guides/platform/backups). Backups consume
   egress and a restore can overwrite newer writes; choose cadence against the
   measured quota. No paid backup service or automatic upgrade is configured.
5. Run `npm test`, `npm run typecheck`, `npm run build`, and the fixture integration
   runner described in the README. Run the release checks below. Embedded
   PostgreSQL tests do not establish real separate-session locking; genuine
   concurrent transaction tests against a disposable/approved hosted PostgreSQL
   project are a release gate.

```sql
select current_database(), current_user, version(),
       pg_database_size(current_database()) as database_bytes;
select count(*) as registered_accounts from auth.users;
select to_regclass('public.profiles') as profiles,
       to_regprocedure('public.chat_session_active()') as session_check,
       to_regclass('public.chat_history') as history_table,
       to_regclass('public.chat_storage_guard') as storage_guard;
select proname, pg_get_function_identity_arguments(oid) as arguments
from pg_proc where pronamespace = 'public'::regnamespace
  and proname in ('get_chat_history_v2', 'save_chat_v2');
select tgname, pg_get_triggerdef(oid)
from pg_trigger where tgrelid = 'auth.users'::regclass and not tgisinternal;
select name, default_version, installed_version
from pg_available_extensions where name = 'pg_cron';
```

Apply only missing reviewed SQL in the order above using the approved migration
path. Migration 002 briefly locks `auth.users` while initializing the account
counter; later migrations replace history functions. Schedule a quiet window and
investigate any lock timeout or failed statement before retrying. Record completion and refresh PostgREST's schema cache
through the normal Supabase migration mechanism before verifying RPC availability.
Do not cut over the app while RPCs return schema-cache errors.

## Free daily measurement job

[Supabase Cron](https://supabase.com/docs/guides/cron) runs SQL in Postgres through
`pg_cron`. Its documented installation uses the
[Cron integration and extension](https://supabase.com/docs/guides/cron/install),
with no paid scheduler or external HTTP call needed for this SQL job. The docs do
not establish that this particular hosted project's extension is already enabled;
confirm `pg_available_extensions` and the first real run before calling monitoring
operational. An unavailable job must not break Auth or per-save measurement.

After migration approval, enable `pg_cron` through Supabase's Cron integration if
needed. Then install exactly this named SQL job as an operator, after checking
`cron.job` for an existing job with the same name. Scheduling a duplicate name
updates that job. The schedule is 03:00 UTC daily. The cleanup affects only this
job's completed run records older than 30 days; it never deletes conversations.

```sql
select public.measure_chat_storage();
select cron.schedule(
  'chat-storage-daily',
  '0 3 * * *',
  $job$
    select public.measure_chat_storage();
    delete from cron.job_run_details
    where jobid = (select jobid from cron.job where jobname = 'chat-storage-daily')
      and end_time < now() - interval '30 days';
  $job$
);
```

Supabase's [Cron quickstart](https://supabase.com/docs/guides/cron/quickstart)
documents scheduling and notes that run history is not cleaned up automatically.
This job stores only the latest byte measurement plus bounded run records, not
copies of history. No API polling, paid monitoring, Edge Function, or new runtime
credential is necessary. Check the initial sample immediately and the scheduled
execution after the first 03:00 UTC. Record the evidence:

```sql
select measured_bytes, measured_at, writes_paused
from public.chat_storage_guard where singleton;
select jobid, jobname, schedule, active from cron.job
where jobname = 'chat-storage-daily';
select r.status, r.start_time, r.end_time, r.return_message
from cron.job_run_details r join cron.job j using(jobid)
where j.jobname = 'chat-storage-daily'
order by r.start_time desc limit 5;
```

In a quiet database, a sample older than 26 hours or a failed/missing run needs
investigation. Per-save measurement can make `measured_at` fresh even if Cron has
failed, so inspect job status as well. This is a dashboard/operator check, not an
outbound email alert. During the test launch, review daily; review weekly once
usage is stable, and immediately on a pause or provider usage notice.

## Storage and egress response

At 350 MB, inspect the largest relations and `n_dead_tup`, including Auth, history
payload/TOAST, indexes, and tombstones. Compare against Supabase's usage panel.
At 400 MB, confirm new saves report paused and unsaved text remains locally
recoverable/exportable. Verify existing Google users still sign in and can chat,
read history, and delete. Do not bypass the pause by editing its flag.

```sql
select schemaname, relname, n_live_tup, n_dead_tup,
       pg_total_relation_size(relid) as relation_bytes
from pg_stat_user_tables
order by pg_total_relation_size(relid) desc limit 20;
```

Ordinary deletion/vacuum may free reusable pages without shrinking database files;
do not promise that deleting chats clears the physical pause immediately. Any
rewrite/reindex/`VACUUM FULL` is a separately reviewed maintenance action: it may
need locks and extra space. Do not delete Auth data or tombstones ad hoc; removing
tombstones can allow stale offline writes to recreate deleted chats. Re-measure
after the approved remedy; automatic resume requires **below** 350 MB.

Check monthly **uncached** egress separately in the organization Usage dashboard,
using the real billing-cycle boundary and all projects/services. Supabase lists
[5 GB uncached and 5 GB cached quotas on Free](https://supabase.com/docs/guides/platform/manage-your-usage/egress);
cached storage bandwidth is not extra allowance for database history responses.
Use internal review marks at 3.5 GB and 4 GB uncached or an extrapolated overrun.
At those marks, investigate Database/Auth/Realtime/pooler breakdowns and repeated
downloads; reduce unnecessary refreshes before provider restrictions occur.
The physical storage pause does not stop egress. Current app reads should fetch
title metadata, fetch selected conversation pages on demand, cache loaded data,
and avoid periodic full-history polling. Full exports/backups also count toward
traffic. There is no automatic egress kill switch or guarantee that Auth survives
a provider-wide restriction; the app's storage guard only isolates its own saves.

## Release source and build checks

Normal Git deployments need no generated document index. For a reviewed local
source package, run:

```powershell
npm run build
node scripts/check-history-release.mjs --build-dir .next
# Requires a clean, committed source tree and a new destination:
node scripts/check-history-release.mjs --prepare .local/chat-source-<commit>
node scripts/check-history-release.mjs --verify-package .local/chat-source-<commit>
```

The package contains committed regular source files and a manifest recording the
source commit, sizes, and SHA-256 hashes. It excludes local/build artifacts,
credentials, and the removed document index. Verification rejects changed,
missing, additional, or symlink files. Review tracked contents as well; the
credential scan is not a universal secret detector. Package preparation does not
install, build, upload, or deploy. Inject server secrets through the hosting
platform. Packaging does not modify the database or replay migrations. Legacy message
metadata remains readable for compatibility.

## Local PostgreSQL verification

`scripts/check-history-sql.mjs` applies the actual migrations to disposable PGlite
PostgreSQL with a simulated Supabase Auth schema. Install `@electric-sql/pglite`
in a separate verification directory; it is not an application dependency. Point
`CHAT_TEST_PGLITE` at that installation's `dist/index.js`, then run:

```powershell
$env:CHAT_TEST_PGLITE = 'D:\path\to\verification\node_modules\@electric-sql\pglite\dist\index.js'
node scripts/check-history-sql.mjs
```

The six suites cover existing-account admission and rollback, RLS and privileges,
idempotency and revisions, count/UTF-8 limits and whole-chat eviction, paginated
messages, bounded deletion markers and delayed-save rejection, and storage guard
hysteresis. Guard threshold checks replace only the physical-size measurement
inside the production function with a controlled local value. No hosted service
is contacted. PGlite serializes its single connection: parallel submissions here
do not replace the independent PostgreSQL-session race checks below.

For actual concurrent sessions, `scripts/check-history-concurrency.mjs` uses a
disposable PostgreSQL server listening only on `127.0.0.1`. It creates and removes
its own uniquely named database, applies the unchanged migrations with a simulated
Supabase Auth schema, and verifies distinct backend PIDs and server lock waits
before releasing each race. It never accepts a hosted database URL. The nine
suites cover the 100th signup, rolled-back admission, concurrent count/UTF-8 quota
writes, conflicting revisions and identical retries, delete/save ordering,
eviction rollback, and independent-account access.

Use a disposable local installation, such as the Windows binary archive linked
from [PostgreSQL's official Windows download page](https://www.postgresql.org/download/windows/)
to [EDB's binary downloads](https://www.enterprisedb.com/download-postgresql-binaries).
The verification was run with PostgreSQL 17.11 and the external `pg` 8.16.3 driver.
Keep the binaries, cluster and driver outside this repository, for example under
`D:\AILearn\.tools\postgres-concurrency`. Start the cluster on port 55439 with
`initdb -D <disposable-cluster> --username=postgres --auth=trust --encoding=UTF8 --locale=C`, then
`pg_ctl -D <disposable-cluster> -o "-h 127.0.0.1 -p 55439" -l <local-log> -w start`.
The local test cluster uses the `postgres` account with local trust authentication.

```powershell
npm install --prefix D:\AILearn\.tools\postgres-concurrency pg@8.16.3 --no-audit --no-fund
$env:CHAT_TEST_POSTGRES_DISPOSABLE = 'true'
$env:CHAT_TEST_PG = 'D:\AILearn\.tools\postgres-concurrency\node_modules\pg\lib\index.js'
$env:CHAT_TEST_POSTGRES_EVIDENCE = 'D:\AILearn\.tools\postgres-concurrency\results.json'
node scripts/check-history-concurrency.mjs
# Stop the disposable server after verification:
pg_ctl -D <disposable-cluster> -m fast -w stop
```

The optional evidence file records the server version, migration hashes, distinct
backend PIDs, lock/blocker observations and quota outcomes. This verifies actual
PostgreSQL concurrency locally; hosted Google/OAuth, scheduled jobs and final
deployment checks still require the environment-specific checks below.

## Hosted verification and rollback

Before enabling production traffic, use two real Google accounts and verify:

- Direct table/RPC calls cannot access another account; anonymous calls cannot
  read history. Live revoked sessions are denied. Migration 001 profile behavior
  and Google sign-in/callback/session refresh still work.
- New chats follow the account across two devices; older local chats remain local.
  Long histories paginate; complete export contains unloaded messages. Images
  remain absent from cloud payloads.
- Two genuine PostgreSQL sessions race the 100th signup; only one succeeds and
  rollback leaves no leaked slot. Existing accounts sign in when full. Check
  `(select accounts from public.registration_slots where singleton)` equals
  `(select count(*) from auth.users)` afterwards.
- Two devices race saves and delete/save; revisions and deletion markers prevent
  lost updates and resurrection. Fifty chats and the byte budget are enforced
  transactionally; reads do not change eviction order. Retry a response lost after
  commit and confirm the same operation does not duplicate or evict twice.
- Verify an absent conversation's initial save expires after 24 hours, updates to
  an existing conversation remain valid with the current revision, and an absent
  positive-revision save stays deleted after 48-hour marker cleanup. Expired work
  must remain locally recoverable; reaching 1,000 markers limits new creates.
- Exercise physical threshold transitions in a disposable environment, using
  controlled measurement fixtures rather than filling production. Confirm
  350 MB warning, 400 MB pause, preserved pause at 375 MB, and resume below 350 MB.
  Paused saves retain recovery data, while Auth/inference/read/delete still work.
- Confirm Cron's first scheduled run, small paginated responses, and no background
  full-history downloads. Verify ordinary chat and status routes in the final package.

Rollback the **app deployment** to its recorded previous version first when a
client/API regression prevents safe operation. Keep additive 002 tables/functions
and saved content in place; the previous local-history app will not display new
cloud chats, and will not automatically receive them as local chats. Preserve
exports/outbox data for an intentional recovery path. Do not claim deployment
rollback restores deleted/evicted chats, failed generations, or unsaved content.

If needed, deactivate only this job after recording its definition:

```sql
select cron.alter_job(jobid, active := false)
from cron.job where jobname = 'chat-storage-daily';
```

Do not drop `pg_cron`: that deletes unrelated jobs. Do not automatically reverse
002: dropping history objects destroys data, and dropping capacity triggers
removes the registration cap. If 002 causes Auth trouble, assess its new triggers
with the operator and prepare a targeted forward fix while keeping migration 001
intact. Any destructive schema rollback or backup restore needs a protected backup,
explicit data-loss review, and release approval. There is no guaranteed lossless
rollback once deletion/eviction or post-backup writes have occurred.

## BF16-only model writes

After the web-search metadata migration, apply `202611100002_bf16_only.sql`.
The payload cleaner accepts the BF16 model ID and rejects explicitly unsupported
conversation or assistant-answer IDs. Missing optional model metadata remains
accepted. Existing rows and earlier migration files remain unchanged. The frontend
omits explicit unsupported histories from local cache, cloud listings, and loaded
message pages. Hidden cloud rows still count against the account storage quota;
this update does not delete them or stop any model service.
