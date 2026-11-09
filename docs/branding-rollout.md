# Kiddo Chat branding rollout

The app is named **Kiddo Chat**, with **kiddo.** as its wordmark. Qwen remains the underlying model name: model selectors, answer model labels, settings, diagnostics, backend aliases, and “Powered by Qwen” attribution retain it. Existing conversation text is not rewritten.

The source rename covers chat, sign-in, privacy, browser metadata, accessibility labels, and history download filenames. The existing abstract asterisk symbol and favicon contain no Qwen text and are retained.

## Compatibility

Keep the `qwen-chat.*` browser storage keys, legacy logout cookie cleanup, model IDs and gateway aliases intact. Renaming them would add a data migration or risk breaking routing without improving the user interface. The repository, local directory, package name, and Vercel project identifier can retain their technical names.

## Hosted cutover

Inspection on November 9, 2026 confirmed that Vercel project `qwen-chat` still has `qwen38-chat-zh.vercel.app` as its attached public domain. The source rename does not change this address or Google/Supabase dashboard settings. No replacement domain has been provisioned by this change.

1. Select and verify an available Kiddo public address on the existing Vercel project. Keep the current address available during the transition.
2. Add the exact new origin's `/auth/callback` URL to Supabase Authentication's redirect allowlist before inviting users to sign in there. Configure its Site URL for the new public origin at cutover. Retain exact callbacks for supported old and preview origins during the transition.
3. Update Google Auth Platform's public app name to **Kiddo Chat**, and its home/privacy links to the new origin and `/privacy`. Update authorized domains/origins where the Google configuration requires them. The OAuth client's redirect URI remains the existing Supabase `/auth/v1/callback` address unless the authentication architecture changes. Complete any required Google review.
4. Verify a full Google sign-in, privacy link, account access, cloud history, both models, sign-out, and download on the new origin, on desktop and mobile.
5. Offer export of old-origin browser-only conversations and resolve pending saves before redirecting users. Browser storage is scoped by origin: local legacy history, cached history, pending changes, preferences, and sessions do not move automatically. Cloud-saved conversations remain associated with the same Supabase account. This rename adds no history import or cross-origin migration.
6. Once the new origin works and local-data transition is addressed, redirect the old address and update the current production URL in README.md and docs/accounts.md. Retire old callbacks only when they are no longer needed.

Deployment, domain cutover, and provider-dashboard branding must be verified separately from a passing source build. Do not replace a documented working production URL with an unprovisioned address.
