import { NextResponse } from "next/server";
import { serverAuth } from "@/lib/supabase/server";
import { isVerifiedGoogleUser } from "@/lib/google-user";

export async function GET(request: Request) {
  const url = new URL(request.url);
  // Preserve the browser's cookie host when Next normalizes localhost in dev.
  const origin = new URL(`${url.protocol}//${request.headers.get("host") ?? url.host}`).origin;
  const destination = (path: string) => NextResponse.redirect(new URL(path, origin), {
    headers: { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" },
  });
  const code = url.searchParams.get("code");
  if (url.searchParams.has("error")) return destination(url.searchParams.get("error") === "access_denied" ? "/sign-in?error=canceled" : "/sign-in?error=google");
  if (!code) return destination("/sign-in?error=google");
  try {
    const supabase = await serverAuth();
    if (supabase) {
      const result = await supabase.auth.exchangeCodeForSession(code);
      if (!result.error) {
        const { data, error } = await supabase.auth.getUser();
        if (!error && isVerifiedGoogleUser(data.user)) return destination("/");
        await supabase.auth.signOut({ scope: "local" });
      }
    }
  } catch { /* Failed exchanges and auth outages return a retryable local page. */ }
  // No caller-controlled next URL or provider error text is reflected.
  return destination("/sign-in?error=google");
}
