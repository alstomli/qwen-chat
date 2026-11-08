# Google account setup and rollout

This release replaces the shared workspace password with Google sign-in through
Supabase. Anyone with an eligible Google account may register by continuing with
Google while the 100-account registration limit has capacity. Existing users can
still sign in when full, and deleting an account frees a slot. Only a
server-verified user with a confirmed email, a matching verified
Google identity, and a live Supabase session may use chat/status APIs. Public
registration grants access to existing model capacity; retain gateway admission
limits and configure Supabase authentication rate limits before launch.

## Google and Supabase configuration

1. Apply `supabase/migrations/202611080001_accounts.sql` in the intended Supabase
   project using the SQL editor or your migration workflow. It creates own-row
   profile policies and a live-session check. Missing migration fails closed.
   The migration is a fresh-install migration, not an idempotent upgrade script.
   If an older email-account draft was applied elsewhere, explicitly replace the
   two functions with the revised definitions before testing. No app service-role
   key is required.
2. Create a **Web application** OAuth client in Google Cloud. Configure Google
   Auth Platform branding/support details and an **External** audience for public
   Google accounts. During Testing, add test users; use the publishing/verification
   steps Google requires before public launch. Request only `openid`, `email`,
   and `profile` (identity/basic profile scopes), with no Gmail, Drive, offline
   access, or other Google API permissions. The app does not restrict users to
   Gmail addresses.
3. Set the Google OAuth client's **Authorized redirect URI** to the Supabase
   callback: `https://ykoziqgafuxdjrtjxuel.supabase.co/auth/v1/callback`.
   This is different from the app's `/auth/callback`. The Google client secret
   belongs only in Supabase's Google provider configuration, never in app source,
   browser variables, screenshots, logs, or Vercel environment variables. This
   redirect-based flow does not embed Google Identity Services in the app.
4. In Supabase Authentication, enable the **Google** provider with that client ID
   and secret. Turn **email/password** and **anonymous sign-in** off, leave new
   user signup on, and keep other unused providers disabled. Leave Google's
   email-verification checks enabled. These settings are required: app UI removal
   alone does not disable direct provider/password authentication. No SMTP or
   custom domain is needed for this Google-only flow.
5. In Supabase URL configuration, set Site URL to
   `https://qwen38-chat-zh.vercel.app`. Allow exactly
   `https://qwen38-chat-zh.vercel.app/auth/callback` and the equivalent exact
   callback for each controlled staging/branch preview origin you test. For local
   development allow `http://127.0.0.1:3001/auth/callback` in the appropriate dev
   project. Avoid production preview-domain wildcards. App callback success is
   fixed to `/`; failure is fixed to `/sign-in`. Caller-supplied `next` URLs are
   never used. Complete OAuth in the browser that started it, which holds the
   PKCE verifier.
6. Set `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` in
   the ignored local `.env.local` and the matching Vercel build/runtime environment.
   These two settings are public client configuration; never use secret or
   service-role keys. Rebuild after changes. Retain all Runpod variables.
7. The app's public privacy page is `/privacy`. Review its factual data-flow
   description against deployed providers and any policy Google requires before
   publishing OAuth branding. It does not invent provider retention/deletion
   guarantees or legal terms.

Official setup references: [Supabase Google sign-in](https://supabase.com/docs/guides/auth/social-sign-in/auth-google),
[redirect allowlists](https://supabase.com/docs/guides/auth/redirect-urls), and
[Google button branding](https://developers.google.com/identity/branding-guidelines).
The bundled `public/google-g.png` is Google's current official logo from that
branding guide. Google Sans Medium and its SIL Open Font License are bundled in
`public/fonts`; the browser does not request Google Identity Services or Google
Fonts for this button.

## Session and data behavior

The Next.js proxy refreshes auth cookies and validates claims. Home and every
chat/status request independently call Supabase `getUser()` and require a
confirmed, non-anonymous account with a Google identity whose email matches the
account email and whose provider verification is boolean true. Editable
`user_metadata` never authorizes access. Names from Google profile metadata are
used only to seed a display name, with a legacy display-name fallback.

Before inference, `chat_session_active()` checks the JWT session ID against
`auth.sessions` plus the same confirmed email/Google identity constraints in
`auth.identities`. Revoked sessions cannot initiate new inference while an old
JWT is unexpired. Auth outages deny access. These remote auth/database checks add
latency; hosted latency has not been measured. Profile RLS uses ordinary Supabase
JWT expiry semantics, rather than live session-table checks for direct requests.

Sign out revokes this browser session, preserves other devices, broadcasts to
other app tabs, aborts local active streams, and clears in-memory drafts, images,
and diagnostics. Remote requests already accepted may finish. Google account
recovery is managed by Google. Old signup, confirmation, and password reset
routes redirect to sign-in and do not exchange email tokens or update passwords.

New conversations sync through the cloud-history migration and authenticated RPCs.
Each account retains at most 50 conversations or 2,000,000 UTF-8 bytes of serialized
content and metadata, with oldest-message conversations evicted on quota pressure.
Existing account-scoped browser history remains local, including when continued;
there is no automatic import. Settings and pending saves remain account-scoped in
the browser. Browser storage is not encrypted against someone inspecting the same
browser profile, and signout can retain saved data there. Legacy anonymous keys
are preserved but never automatically claimed/displayed by a signed-in account.
Old `qwen_session` cookies and `CHAT_PASSWORD` / `SESSION_SECRET` no longer
authorize any request. See [Cloud history operations](cloud-history-operations.md)
for migration order, capacity enforcement, storage guards, and release checks.

## Verification and release

Run `npm test`, `npm run typecheck`, `npm run build`, and
`node scripts/integration.mjs` with the existing fixture environment described in
the README. The integration runner starts an external Supabase-shaped HTTP
fixture and the Python model/gateway fixtures. It verifies OAuth provider/scopes,
a one-use PKCE code and verifier, Google account creation/sign-in, cancellation,
unverified/non-Google denial, same-origin fixed redirects, account isolation,
logout/replay, cross-tab stream cancellation, images, Docs, and existing
concurrency/timing behavior. There is no production auth-bypass switch.

These fixtures do **not** prove hosted Google consent, provider enablement, real
Supabase cookie refresh, or hosted RLS. Before launch, test actual Google login
with two accounts, cancellation and replay/expired-code failure, refresh/reload,
logout in multiple tabs, direct API denial and profile RLS. Verify email/password
and anonymous sign-in are disabled in the hosted dashboard. Apply SQL before app
cutover. Hosted Google verification remains pending until provider setup and
real account tests are completed; a fixture pass is not a hosted login pass.

Package the ignored generated `data/runpod-docs-index.json` with deployments as
required by Docs. Merge and production deployment require separate approval.
Do not remove old environment secrets until cutover is validated; rolling back to
shared-password code restores the old authorization model.
