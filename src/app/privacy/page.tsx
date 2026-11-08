import Link from "next/link";
export const metadata = { title: "Privacy policy · qwen" };
export default function Privacy() {
  return <div className="login-page"><Link href="/sign-in" className="login-brand">✳ qwen.</Link>
    <main className="privacy-main"><div className="eyebrow">PRIVACY & DATA</div><h1>How this workspace uses data.</h1>
      <section><h2>Your Google account</h2><p>Google handles sign-in. Supabase receives your Google identity and basic profile information, including your email address and name, and manages your app account and session. The app requests only identity, email, and basic profile access. Your Google password is entered on Google’s sign-in page.</p></section>
      <section><h2>Conversations in this browser</h2><p>Chat history and settings are saved in this browser’s local storage, separately for each app account. They are not synced across devices. Signing out leaves saved history in this browser; someone with access to this browser profile can inspect it. Deleting a conversation removes its saved browser copy. Clearing site data removes saved conversations and settings from this browser.</p></section>
      <section><h2>Messages and images you send</h2><p>To generate replies, the app sends the conversation context and any attached images through its server to the configured Runpod model service. Runpod processes this content for inference. The app does not write conversation history to Supabase; Supabase stores account and profile data. Hosting and service providers may also process operational request data.</p></section>
      <section><h2>Before sharing sensitive information</h2><p>This page describes the app’s current data flow. It does not set a provider retention period or promise deletion from provider systems. Avoid sending information you do not want processed by these services.</p></section>
      <Link className="privacy-back" href="/sign-in">Back to sign in</Link>
    </main></div>;
}
