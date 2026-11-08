import { sameOrigin } from "@/lib/auth";
import { jsonError } from "@/lib/server";
export async function POST(request: Request) {
  if (!sameOrigin(request)) return jsonError("This request isn't allowed.", 403);
  return jsonError("Shared-password sign-in has been retired. Sign in with your account.", 410);
}
