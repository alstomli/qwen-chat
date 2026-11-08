import { redirect } from "next/navigation";
import { serverAuth } from "@/lib/supabase/server";
import { isVerifiedGoogleUser } from "@/lib/google-user";
import ChatWorkspace from "@/components/chat-workspace";
export const dynamic = "force-dynamic";
export default async function Home() {
  const supabase = await serverAuth();
  const result = await supabase?.auth.getUser();
  const user = result?.data.user;
  if (result?.error || !isVerifiedGoogleUser(user)) redirect("/sign-in");
  const { data: active, error } = await supabase!.rpc("chat_session_active");
  if (error || active !== true) redirect("/sign-in");
  return <ChatWorkspace key={user.id} userId={user.id} email={user.email ?? "Your account"} />;
}
