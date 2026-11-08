"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { browserAuth } from "@/lib/supabase/browser";
import { authConfig } from "@/lib/supabase/config";

export function AccountForm() {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [canceled, setCanceled] = useState(false);
  const [registrationFull, setRegistrationFull] = useState(false);
  const configured = !!authConfig();
  useEffect(() => {
    const reason = new URLSearchParams(window.location.search).get("error");
    if (reason === "canceled") setCanceled(true);
    else if (reason === "capacity") setError("Registration is full. If you already have an account, you can try signing in again.");
    else if (reason) setError("We couldn’t sign you in with Google. Please try again.");
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    async function refreshCapacity() {
      try {
        const response = await fetch("/api/registration", { signal: controller.signal, cache: "no-store" });
        if (!response.ok) return;
        const result = await response.json();
        if (!controller.signal.aborted) setRegistrationFull(result.available === false);
      } catch { /* Capacity is enforced in Postgres even when this notice cannot load. */ }
    }
    void refreshCapacity();
    window.addEventListener("focus", refreshCapacity);
    return () => { controller.abort(); window.removeEventListener("focus", refreshCapacity); };
  }, []);
  useEffect(() => {
    // Browsers may restore the page from bfcache after Back from Google.
    const restore = () => setPending(false);
    window.addEventListener("pageshow", restore);
    return () => window.removeEventListener("pageshow", restore);
  }, []);
  async function signIn() {
    setPending(true); setError(""); setCanceled(false);
    try {
      const { error } = await browserAuth().auth.signInWithOAuth({
        provider: "google",
        options: { redirectTo: `${window.location.origin}/auth/callback`, scopes: "openid email profile" },
      });
      if (error) throw error;
      // Keep the button disabled while the browser leaves for Google.
    } catch {
      setError("We couldn’t sign you in with Google. Please try again.");
      setPending(false);
    }
  }
  return <div className="login-page google-sign-in"><Link href="/sign-in" className="login-brand">✳ qwen.</Link>
    <main className="login-main"><div className="eyebrow">YOUR PERSONAL WORKSPACE</div><h1>A space of your own.</h1>
      <p>Sign in with Google to start a conversation.<br />{registrationFull
        ? "Registration is full. Existing users can still sign in."
        : "New here? Your account is created automatically while a space is available."}</p>
      <div className="login-form account-form">
        {!configured && <p role="alert" className="form-error">Sign-in is temporarily unavailable. Please try again later.</p>}
        {error && <p role="alert" className="form-error">{error}</p>}
        {canceled && <p role="status" className="account-message">Sign-in was canceled. You can try again when you’re ready.</p>}
        <button type="button" className="google-button" disabled={pending || !configured} aria-busy={pending} onClick={signIn}>
          <img src="/google-g.png" alt="" aria-hidden="true" width="20" height="20" />
          {pending ? "Redirecting to Google…" : "Continue with Google"}
        </button>
        <p className="account-note"><Link href="/privacy">Privacy policy</Link></p>
        {pending && <p role="status" className="account-message">Opening Google…</p>}
      </div>
    </main><footer className="login-footer">A little curiosity goes a long way.<span>POWERED BY QWEN</span></footer></div>;
}
