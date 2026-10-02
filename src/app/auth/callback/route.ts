import { NextResponse } from "next/server";
import { logError } from "@/lib/http";
import { getSupabaseServer } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /auth/callback — landing page for Supabase email links (sign-up confirmation, magic link).
 * Exchanges the one-time `code` for a session cookie, then returns to the dashboard.
 */
export async function GET(request: Request): Promise<NextResponse> {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const home = new URL("/", url.origin);
  if (code === null) return NextResponse.redirect(home);
  try {
    const supabase = await getSupabaseServer();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (error !== null) home.searchParams.set("authError", error.message.slice(0, 200));
  } catch (err) {
    logError("auth.callback", err);
    home.searchParams.set("authError", "Could not complete sign-in");
  }
  return NextResponse.redirect(home);
}
