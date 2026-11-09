import { createServerClient } from "@supabase/ssr";
import { authConfig } from "./supabase/config";
import { isVerifiedGoogleUser } from "./google-user";
import { canUseAdvancedSettings } from "./settings-access";
export async function requestPrincipal(request: Request) {
  const config = authConfig();
  if (!config) return null;
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
    if (error || !isVerifiedGoogleUser(data.user)) return null;
    const { data: active, error: sessionError } = await supabase.rpc("chat_session_active");
    if (sessionError || active !== true) return null;
    return { userId: data.user.id, canUseAdvancedSettings: canUseAdvancedSettings(data.user.id) };
  } catch { return null; }
}
export async function requestAuthenticated(request: Request) {
  return (await requestPrincipal(request)) !== null;
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
