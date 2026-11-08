import { createClient } from "@supabase/supabase-js";
import { authConfig } from "./supabase/config";

// Capacity is advisory UI data. The database trigger enforces admission atomically.
// Unknown capacity must never disable signin for an existing account.
export async function registrationAvailable(): Promise<boolean | null> {
  const config = authConfig();
  if (!config) return null;
  try {
    const client = createClient(config.url, config.key, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      global: { fetch: (url, options) => fetch(url, { ...options, signal: AbortSignal.timeout(4000), cache: "no-store" }) },
    });
    const { data, error } = await client.rpc("registration_capacity");
    return !error && typeof data?.available === "boolean" ? data.available : null;
  } catch { return null; }
}
