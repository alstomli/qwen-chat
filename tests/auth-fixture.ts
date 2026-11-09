export const user = { id: "11111111-1111-4111-8111-111111111111", aud: "authenticated", role: "authenticated", email: "test@example.com", email_confirmed_at: "2026-01-01T00:00:00Z", identities: [{ id: "google-test", identity_id: "google-test", user_id: "11111111-1111-4111-8111-111111111111", provider: "google", identity_data: { email: "test@example.com", email_verified: true }, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" }], app_metadata: {}, user_metadata: {}, created_at: "2026-01-01T00:00:00Z" };
export const adminIds = ["71fd4edb-4aeb-472c-a96b-3b2fdeb4f285", "d06b78ab-e282-4760-8698-884ec5b5fc85"] as const;
function fixtureUser(userId: string) {
  return { ...user, id: userId, identities: user.identities.map(identity => ({ ...identity, user_id: userId })) };
}
export function issueSession(userId = user.id) {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://fixture.supabase.co";
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = "fixture-public-key";
  const access_token = [Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url"), Buffer.from(JSON.stringify({ sub: userId, exp: Math.floor(Date.now()/1000)+3600, session_id: "22222222-2222-4222-8222-222222222222" })).toString("base64url"), "fixture-signature"].join(".");
  return "base64-" + Buffer.from(JSON.stringify({ access_token, refresh_token: "fixture-refresh", expires_at: Math.floor(Date.now()/1000)+3600, expires_in: 3600, token_type: "bearer", user: fixtureUser(userId) })).toString("base64url");
}
export function cookieHeader(session: string) { return `sb-fixture-auth-token=${session}`; }
export function authResponse(input: RequestInfo | URL, init?: RequestInit, options: { userId?: string; confirmed?: boolean; active?: boolean; invalid?: boolean; google?: boolean; userMetadata?: Record<string, unknown> } = {}) {
  const url = String(input);
  if (!url.startsWith("https://fixture.supabase.co/")) return null;
  if (options.invalid || !new Headers(init?.headers).get("Authorization")?.startsWith("Bearer ")) return Response.json({ message: "invalid token" }, { status: 401 });
  const verifiedUser = fixtureUser(options.userId ?? user.id);
  if (url.endsWith("/auth/v1/user")) return Response.json({ ...verifiedUser, user_metadata: options.userMetadata ?? {}, identities: options.google === false ? [] : verifiedUser.identities, email_confirmed_at: options.confirmed === false ? null : user.email_confirmed_at });
  if (url.endsWith("/rest/v1/rpc/chat_session_active")) return Response.json(options.active !== false);
  throw new Error(`Unexpected auth fixture request: ${url}`);
}
