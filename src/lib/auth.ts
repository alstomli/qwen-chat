import { createServerClient } from "@supabase/ssr";
import { authConfig } from "./supabase/config";
export async function requestAuthenticated(request: Request) {
  const config = authConfig();
  if (!config) return false;
  try {
    const supabase = createServerClient(config.url, config.key, { cookies: {
      getAll: () => (request.headers.get("cookie") ?? "").split(";").map(cookie => {
        const index = cookie.indexOf("=");
        return { name: cookie.slice(0, index).trim(), value: cookie.slice(index + 1).trim() };
      }).filter(cookie => cookie.name),
      // Proxy owns refresh cookies; do not share this client between requests.
      setAll: () => {},
    } });
    const { data, error } = await supabase.auth.getUser();
    if (error || !data.user?.email_confirmed_at) return false;
    const { data: active, error: sessionError } = await supabase.rpc("chat_session_active");
    return !sessionError && active === true;
  } catch { return false; }
}
export function sameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  if (!origin) return false;
  try {
    const source = new URL(origin);
    const target = new URL(request.url);
    // Next may normalize the internal request URL to localhost in development.
    // The HTTP Host identifies the browser-facing destination.
    return source.host === (request.headers.get("host") ?? target.host) && source.protocol === target.protocol;
  } catch { return false; }
}
