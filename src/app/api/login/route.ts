import { allowLogin, cookieHeader, credentialsConfigured, issueSession, passwordMatches, sameOrigin } from "@/lib/auth";
import { jsonError, readJson } from "@/lib/server";
export const runtime = "nodejs";
export async function POST(request: Request) {
  if (!sameOrigin(request)) return jsonError("This request isn't allowed.", 403);
  if (!credentialsConfigured()) return jsonError("Your workspace login hasn't been configured yet.", 503);
  if (!allowLogin(request.headers.get("x-forwarded-for")?.split(",")[0] ?? "local")) return jsonError("Too many attempts. Please wait a minute.", 429);
  try {
    const body = await readJson(request);
    if (!body || typeof body !== "object" || Array.isArray(body) || !("password" in body)) return jsonError("Please enter your workspace password.", 400);
    if (typeof body.password !== "string" || body.password.length > 256 || !passwordMatches(body.password)) return jsonError("That password isn't right. Please try again.", 401);
    return Response.json({ ok: true }, { headers: { "Set-Cookie": cookieHeader(issueSession()), "Cache-Control": "no-store" } });
  } catch { return jsonError("Please enter your workspace password.", 400); }
}
