# Account setup and rollout

This release replaces the shared workspace password with Supabase email/password
accounts. Anyone may create an account; only confirmed email accounts with a live
Supabase session can use chat/status APIs. Public registration grants access to the
existing model capacity; configure Supabase auth rate limits and retain gateway
admission limits before opening production.

## Supabase configuration

1. Use a development/staging project first. Apply
   `supabase/migrations/202611080001_accounts.sql` using the Supabase SQL editor or
   your migration workflow. It creates own-row profile policies and the live-session
   check used by the server. Missing migration fails closed. No service/secret key
   is needed by the app.
2. Enable email/password signup, **Confirm email**, and set minimum password length
   to **12**, matching the form. Disable anonymous sign-ins. Supabase owns password
   hashing, email tokens, refresh tokens, and auth rate limiting. Configure those
   limits in the dashboard; the retired in-memory login limiter is not used.
3. Set Site URL to `https://qwen38-chat-zh.vercel.app`. Allow only the intended
   callback URLs: `https://qwen38-chat-zh.vercel.app/auth/confirm` and
   `https://qwen38-chat-zh.vercel.app/auth/confirm?next=/reset-password`.
   Add the equivalent URLs for your controlled staging domain and
   `http://127.0.0.1:3001` in the appropriate development project. Avoid broad
   production preview-domain wildcards.
4. Configure custom SMTP before inviting real users to register. Supabase's default
   SMTP is development-only and restricted to authorized team addresses. With
   Resend, verify an owned sending domain, configure its required DNS records, then
   use `smtp.resend.com`, port `465`, username `resend`, password your Resend API
   key, and a verified From address. Store SMTP credentials in Supabase only, never
   in source/client env. Disable email link tracking, which can damage auth links.
5. Default email templates work with the PKCE callback `code` in the same browser
   that requested the email. For links that work in another browser/device, use
   token-hash templates:

   Confirmation: `{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=signup`

   Recovery: `{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=recovery`

   Use project-specific Site URLs for staging. The handler accepts only fixed local
   success destinations and rejects invalid/expired tokens. Do not include tokens
   in logs or screenshots.
6. Set `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` in the
   local ignored `.env.local` and the correct Vercel build/runtime environment.
   These are public client configuration; secret/service-role keys must never be
   used here. Rebuild after changing public variables. Retain all Runpod variables.

## Session and data behavior

The Next.js proxy refreshes auth cookies and validates claims. Every chat/status
request independently verifies the user with Supabase and calls
`chat_session_active()`. That SQL function checks the JWT's session ID against
`auth.sessions` and requires a confirmed email. Revoked sessions cannot initiate
new inference, even while an old JWT is unexpired. Auth outages deny access.
This adds two remote auth/database checks before inference; live latency has not
been measured. Profile RLS does not itself perform session-table checks: ordinary
Supabase JWT/RLS expiry semantics apply to direct profile requests.

Sign out revokes this browser session, preserves other devices, broadcasts to
other app tabs, aborts local active streams, and clears in-memory drafts, images,
and diagnostics. Password reset signs out all sessions. Requests already accepted
by a server are not retroactively revoked by deleting a session; local tabs cancel
their streams, while remote in-flight work may finish.

Conversations and settings remain browser-local, keyed by immutable user ID.
They are not cloud-synced or encrypted against someone inspecting the same browser
profile. Old anonymous localStorage keys are preserved but never automatically
claimed/displayed by a newly signed-in user. Export/migration of that legacy data
is an explicit later task. Old `qwen_session` cookies and `CHAT_PASSWORD` /
`SESSION_SECRET` no longer authorize any request.

## Verification and release

Run `npm test`, `npm run typecheck`, `npm run build`, and `node scripts/integration.mjs`.
The integration runner starts an external Supabase-shaped HTTP fixture and the
existing Python model/gateway fixtures. Browser tests cover signup, confirmation,
unverified denial, signout/replay, recovery, account isolation, and existing chat
features. There is no production auth-bypass switch. These fixtures do not prove
real SMTP delivery or hosted RLS configuration; test those on staging before launch.

On staging, verify actual delivered confirmation/reset messages, expired/reused
links, rate limits, refresh, direct API denial for unverified users, and two real
accounts' profile RLS. Apply the migration before deploying application code.
Package the ignored generated `data/runpod-docs-index.json` with the deployment,
as required by the existing Docs feature. Merge/deployment require separate
approval. Do not remove old environment secrets until cutover is validated;
rolling back to shared-password code would restore the old authorization model.
