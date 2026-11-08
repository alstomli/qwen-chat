"use client";
import { createBrowserClient } from "@supabase/ssr";
import { authConfig } from "./config";
export function browserAuth() {
  const config = authConfig();
  if (!config) throw new Error("Account sign-in is not configured yet.");
  return createBrowserClient(config.url, config.key);
}
