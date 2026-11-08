"use client";
import { useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import { browserAuth } from "@/lib/supabase/browser";
import { authConfig } from "@/lib/supabase/config";
type Mode = "sign-in" | "create-account" | "forgot-password" | "reset-password";
const titles: Record<Mode, string> = { "sign-in": "Welcome back.", "create-account": "A space of your own.", "forgot-password": "Find your way back.", "reset-password": "Choose a new password." };
export function AccountForm({ mode }: { mode: Mode }) {
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [passwordChanged, setPasswordChanged] = useState(false);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const configured = !!authConfig();
  const newPassword = mode === "create-account" || mode === "reset-password";
  useEffect(() => {
    if (new URLSearchParams(window.location.search).has("error")) setError("That link is invalid or expired. Request a new email and try again.");
  }, []);
  async function submit(event: FormEvent) {
    event.preventDefault(); setPending(true); setError(""); setMessage("");
    try {
      const supabase = browserAuth();
      if (newPassword && !passwordChanged && password !== confirm) throw new Error("Your passwords don't match.");
      if (mode === "create-account") {
        const { error } = await supabase.auth.signUp({ email: email.trim(), password, options: { data: { display_name: name.trim() }, emailRedirectTo: `${window.location.origin}/auth/confirm` } });
        if (error) throw error;
        setPassword(""); setConfirm("");
        setMessage("Check your email to confirm your account before chatting. If you already have an account, sign in or reset your password.");
      } else if (mode === "sign-in") {
        const { data, error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
        if (error) throw new Error("Couldn't sign in. Check your email and password, and confirm your email first.");
        if (!data.user?.email_confirmed_at) { await supabase.auth.signOut({ scope: "local" }); throw new Error("Confirm your email before signing in."); }
        window.location.assign("/");
      } else if (mode === "forgot-password") {
        const { error } = await supabase.auth.resetPasswordForEmail(email.trim(), { redirectTo: `${window.location.origin}/auth/confirm?next=/reset-password` });
        if (error) throw error;
        setMessage("If an account exists for that email, you'll receive a password reset link.");
      } else {
        const { data } = await supabase.auth.getUser();
        if (!data.user) throw new Error("Open a valid password reset link from your email first.");
        if (!passwordChanged) {
          const { error } = await supabase.auth.updateUser({ password });
          if (error) throw error;
          setPasswordChanged(true);
        }
        const { error: signOutError } = await supabase.auth.signOut({ scope: "global" });
        if (signOutError) throw new Error("Your password was changed, but we couldn't sign out your other sessions. Retry signing out below.");
        window.location.assign("/sign-in");
      }
    } catch (err) { setError(err instanceof Error ? err.message : "Something went wrong. Please try again."); }
    finally { setPending(false); }
  }
  async function resend() {
    setPending(true); setError("");
    try {
      const { error } = await browserAuth().auth.resend({ type: "signup", email: email.trim(), options: { emailRedirectTo: `${window.location.origin}/auth/confirm` } });
      if (error) throw error;
      setMessage("If confirmation is needed, a new email is on its way. Check your inbox and spam folder.");
    } catch (err) { setError(err instanceof Error ? err.message : "Couldn't resend. Try again later."); }
    finally { setPending(false); }
  }
  return <div className="login-page"><Link href="/sign-in" className="login-brand">✳ qwen.</Link>
    <main className="login-main"><div className="eyebrow">YOUR PERSONAL WORKSPACE</div><h1>{titles[mode]}</h1>
      <p>{mode === "create-account" ? "Create an account, confirm your email, and start a conversation." : "Your ideas have a home here."}</p>
      <form className="login-form account-form" onSubmit={submit}>
        {mode === "create-account" && <label>Name<input autoComplete="name" value={name} onChange={e => setName(e.target.value)} maxLength={80} required /></label>}
        {mode !== "reset-password" && <label>Email<input type="email" autoComplete="email" value={email} onChange={e => setEmail(e.target.value)} maxLength={254} required /></label>}
        {mode !== "forgot-password" && <label>{newPassword ? "New password" : "Password"}<input aria-label={newPassword ? "New password" : "Password"} type="password" autoComplete={newPassword ? "new-password" : "current-password"} minLength={newPassword ? 12 : 1} maxLength={128} disabled={passwordChanged} value={password} onChange={e => setPassword(e.target.value)} required />{newPassword && <small>At least 12 characters.</small>}</label>}
        {newPassword && <label>Confirm password<input type="password" autoComplete="new-password" disabled={passwordChanged} value={confirm} onChange={e => setConfirm(e.target.value)} required /></label>}
        {!configured && <p role="alert" className="form-error">Account sign-in is not configured yet. Please try again later.</p>}
        {error && <p role="alert" className="form-error">{error}</p>}{message && <p role="status" className="account-message">{message}</p>}
        <button className="primary-button" disabled={pending || !configured}>{pending ? "Please wait..." : mode === "create-account" ? "Create account" : mode === "forgot-password" ? "Send reset link" : mode === "reset-password" ? (passwordChanged ? "Retry signing out" : "Save password") : "Sign in"}</button>
        {(mode === "create-account" || mode === "sign-in") && email && <button type="button" className="account-link" disabled={pending || !configured} onClick={resend}>Resend confirmation email</button>}
      </form>
      <nav className="account-links" aria-label="Account options">{mode !== "sign-in" && <Link href="/sign-in">Sign in</Link>}{mode !== "create-account" && <Link href="/create-account">Create account</Link>}{mode === "sign-in" && <Link href="/forgot-password">Forgot password?</Link>}</nav>
    </main><footer className="login-footer">A little curiosity goes a long way.<span>POWERED BY QWEN</span></footer></div>;
}
