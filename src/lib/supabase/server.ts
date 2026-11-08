import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { authConfig } from "./config";
export async function serverAuth() {
  const config = authConfig();
  if (!config) return null;
  const store = await cookies();
  return createServerClient(config.url, config.key, {
    cookies: {
      getAll: () => store.getAll(),
      setAll: values => {
        // Server Components cannot write cookies; proxy refreshes them first.
        try { values.forEach(({ name, value, options }) => store.set(name, value, options)); } catch {}
      },
    },
  });
}
