"use client";

import type { Session } from "@supabase/supabase-js";
import { useCallback, useEffect, useState } from "react";
import AuthPanel from "@/components/AuthPanel";
import LibraryPanel from "@/components/LibraryPanel";
import StorageUsageModal from "@/components/StorageUsageModal";
import StudyView from "@/components/StudyView";
import { getSupabaseBrowser } from "@/lib/supabase/browser";

export default function DashboardShell() {
  const [open, setOpen] = useState(false);
  const [refreshCount, setRefreshCount] = useState(0);
  // undefined = still checking, null = signed out
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  const [authError, setAuthError] = useState<string | null>(null);
  const [studyBookId, setStudyBookId] = useState<string | null>(null);
  const close = useCallback(() => setOpen(false), []);
  const changed = useCallback(() => setRefreshCount((n) => n + 1), []);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const error = params.get("authError");
    if (error !== null) {
      setAuthError(error);
      window.history.replaceState(null, "", window.location.pathname);
    }
    const auth = getSupabaseBrowser().auth;
    void auth.getSession().then(({ data }) => setSession(data.session));
    const { data } = auth.onAuthStateChange((_event, next) => setSession(next));
    return () => data.subscription.unsubscribe();
  }, []);

  return (
    <main className="mx-auto flex max-w-5xl flex-col gap-6 px-6 py-12">
      <header className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">BookMentor AI</h1>
          <p className="text-sm text-slate-600">Your books, turned into active-recall curricula.</p>
        </div>
        {session ? (
          <div className="flex flex-wrap items-center gap-3">
            <span className="text-sm text-slate-600">{session.user.email}</span>
            <button
              type="button"
              onClick={() => setOpen(true)}
              className="rounded-xl bg-slate-900 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-slate-700"
            >
              Manage &amp; Purge Books
            </button>
            <button
              type="button"
              onClick={() => void getSupabaseBrowser().auth.signOut()}
              className="rounded-xl px-3 py-2 text-sm font-medium text-slate-600 hover:bg-slate-100"
            >
              Sign out
            </button>
          </div>
        ) : null}
      </header>

      {session === undefined ? (
        <div className="h-40 animate-pulse rounded-2xl bg-slate-100" aria-busy="true" />
      ) : session === null ? (
        <AuthPanel initialError={authError} />
      ) : (
        <>
          {studyBookId !== null ? (
            <StudyView bookId={studyBookId} onBack={() => setStudyBookId(null)} />
          ) : (
            <LibraryPanel refreshKey={refreshCount} onChanged={changed} onOpen={(book) => setStudyBookId(book.id)} />
          )}
          <StorageUsageModal open={open} onClose={close} onChanged={changed} />
        </>
      )}
    </main>
  );
}
