import { redirect } from "next/navigation";
import { serverAuth } from "@/lib/supabase/server";
import ChatWorkspace from "@/components/chat-workspace";
export const dynamic = "force-dynamic";
export default async function Home() {
  const supabase = await serverAuth();
  const result = await supabase?.auth.getUser();
  const user = result?.data.user;
  if (!user?.email_confirmed_at) redirect("/sign-in");
  const { data: active } = await supabase!.rpc("chat_session_active");
  if (!active) redirect("/sign-in");
  return <ChatWorkspace key={user.id} userId={user.id} email={user.email ?? "Your account"} />;
}
