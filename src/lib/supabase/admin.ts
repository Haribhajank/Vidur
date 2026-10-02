import "server-only";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { getServerEnv } from "@/lib/env";

let adminClient: SupabaseClient | null = null;

/** Service-role client. Bypasses RLS: callers MUST enforce ownership explicitly. */
export function getSupabaseAdmin(): SupabaseClient {
  if (adminClient !== null) return adminClient;
  const env = getServerEnv();
  adminClient = createClient(env.supabaseUrl, env.supabaseServiceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { headers: { "x-application-name": "bookmentor-server" } },
  });
  return adminClient;
}
