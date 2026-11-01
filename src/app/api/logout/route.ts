import { cookieHeader, sameOrigin } from "@/lib/auth";
import { jsonError } from "@/lib/server";
export async function POST(request: Request) {
  if (!sameOrigin(request)) return jsonError("This request isn't allowed.", 403);
  return Response.json({ ok: true }, { headers: { "Set-Cookie": cookieHeader("", true), "Cache-Control": "no-store" } });
}
