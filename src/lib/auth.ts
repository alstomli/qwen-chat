import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
export const COOKIE = "qwen_session";
const lifetime = 60 * 60 * 24;
function digest(value: string) { return createHash("sha256").update(value).digest(); }
export function credentialsConfigured() { return (process.env.CHAT_PASSWORD?.length ?? 0) > 0 && (process.env.SESSION_SECRET?.length ?? 0) >= 32; }
export function passwordMatches(password: string) {
  return credentialsConfigured() && timingSafeEqual(digest(password), digest(process.env.CHAT_PASSWORD!));
}
export function issueSession(now = Date.now()) {
  if (!credentialsConfigured()) throw new Error("Login is not configured.");
  const payload = Buffer.from(JSON.stringify({ exp: Math.floor(now / 1000) + lifetime, nonce: randomBytes(16).toString("hex") })).toString("base64url");
  return payload + "." + createHmac("sha256", process.env.SESSION_SECRET!).update(payload).digest("base64url");
}
function sessionExpiry(token: string | undefined, now = Date.now()): number | undefined {
  if (!token || !credentialsConfigured()) return undefined;
  try {
    const [payload, signature, extra] = token.split(".");
    if (extra || !payload || !signature) return undefined;
    const expected = createHmac("sha256", process.env.SESSION_SECRET!).update(payload).digest();
    const actual = Buffer.from(signature, "base64url");
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return undefined;
    const { exp } = JSON.parse(Buffer.from(payload, "base64url").toString());
    const nowSeconds = Math.floor(now / 1000);
    if (Number.isInteger(exp) && exp > nowSeconds && exp <= nowSeconds + lifetime) return exp * 1000;
  } catch { return undefined; }
}
export function validSession(token: string | undefined, now = Date.now()) {
  return sessionExpiry(token, now) !== undefined;
}
export function authenticatedSession(request: Request) {
  const cookies = request.headers.get("cookie")?.split(";").map(s => s.trim()) ?? [];
  const token = cookies.find(s => s.startsWith(COOKIE + "="))?.slice(COOKIE.length + 1);
  const expiresAt = sessionExpiry(token);
  if (token && expiresAt !== undefined) return { token, expiresAt };
}
export function requestAuthenticated(request: Request) {
  return authenticatedSession(request) !== undefined;
}
export function sameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  if (!origin) return false;
  try {
    const source = new URL(origin);
    const target = new URL(request.url);
    // Next may normalize the internal request URL to localhost in development.
    // The HTTP Host identifies the browser-facing destination.
    return source.host === (request.headers.get("host") ?? target.host) && source.protocol === target.protocol;
  } catch { return false; }
}
export function cookieHeader(token: string, remove = false) {
  return `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${remove ? 0 : lifetime}${process.env.NODE_ENV === "production" ? "; Secure" : ""}`;
}

// Best-effort per-instance login throttling. The Pod independently limits generation.
const attempts = new Map<string, { count: number; until: number }>();
export function allowLogin(key: string, now = Date.now()) {
  for (const [k, v] of attempts) if (v.until <= now) attempts.delete(k);
  if (attempts.size >= 1000 && !attempts.has(key)) return false;
  const entry = attempts.get(key) ?? { count: 0, until: now + 60_000 };
  entry.count++; attempts.set(key, entry);
  return entry.count <= 8;
}
