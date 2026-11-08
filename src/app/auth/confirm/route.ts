import { NextResponse } from "next/server";
import { serverAuth } from "@/lib/supabase/server";
export async function GET(request: Request) {
  const url = new URL(request.url);
  // Next's development server may normalize request.url to localhost even when
  // the browser uses 127.0.0.1. Keep redirects on the browser's cookie host.
  const origin = new URL(`${url.protocol}//${request.headers.get("host") ?? url.host}`).origin;
  const supabase = await serverAuth();
  const token_hash = url.searchParams.get("token_hash");
  const type = url.searchParams.get("type");
  const code = url.searchParams.get("code");
  // Only these fixed local destinations are allowed, never arbitrary next URLs.
  const destination = type === "recovery" || url.searchParams.get("next") === "/reset-password" ? "/reset-password" : "/";
  if (supabase) {
    const result = code ? await supabase.auth.exchangeCodeForSession(code)
      : token_hash && (type === "signup" || type === "email" || type === "recovery")
        ? await supabase.auth.verifyOtp({ token_hash, type }) : null;
    if (result && !result.error) return NextResponse.redirect(new URL(destination, origin), { headers: { "Cache-Control": "no-store" } });
  }
  return NextResponse.redirect(new URL("/sign-in?error=link", origin), { headers: { "Cache-Control": "no-store" } });
}
