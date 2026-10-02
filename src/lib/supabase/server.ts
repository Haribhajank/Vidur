import "server-only";
import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";
import type { SupabaseClient, User } from "@supabase/supabase-js";
import { getServerEnv } from "@/lib/env";

/** Cookie-bound, RLS-enforced client for the current request's user. */
export async function getSupabaseServer(): Promise<SupabaseClient> {
  const env = getServerEnv();
  const cookieStore = await cookies();
  return createServerClient(env.supabaseUrl, env.supabaseAnonKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options);
          }
        } catch {
          // Cookies are read-only in some render contexts; session refresh is handled by middleware.
        }
      },
    },
  });
}

/** Returns the authenticated user verified against Supabase Auth, or null. */
export async function getAuthenticatedUser(): Promise<User | null> {
  const supabase = await getSupabaseServer();
  const { data, error } = await supabase.auth.getUser();
  if (error !== null || data.user === null) return null;
  return data.user;
}
