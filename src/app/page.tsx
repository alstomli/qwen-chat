import { cookies } from "next/headers";
import { COOKIE, credentialsConfigured, validSession } from "@/lib/auth";
import ChatWorkspace from "@/components/chat-workspace";
export const dynamic = "force-dynamic";
export default async function Home() {
  const cookie = (await cookies()).get(COOKIE)?.value;
  return <ChatWorkspace initialAuthenticated={validSession(cookie)} loginConfigured={credentialsConfigured()} />;
}
