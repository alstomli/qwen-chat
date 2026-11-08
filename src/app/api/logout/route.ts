import { sameOrigin } from "@/lib/auth";
import { serverAuth } from "@/lib/supabase/server";
import { jsonError } from "@/lib/server";
export async function POST(request: Request) {
  if (!sameOrigin(request)) return jsonError("This request isn't allowed.", 403);
  const supabase = await serverAuth();
  if (!supabase) return jsonError("Account sign-in is not configured.", 503);
  const { error } = await supabase.auth.signOut({ scope: "local" });
  if (error) return jsonError("Couldn't sign out. Please try again.", 503);
  return Response.json({ ok: true }, { headers: { "Cache-Control": "no-store", "Set-Cookie": "qwen_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0" } });
}
