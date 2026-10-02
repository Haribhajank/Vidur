"use client";

import { useState, type FormEvent } from "react";
import { getSupabaseBrowser } from "@/lib/supabase/browser";

type Mode = "signIn" | "signUp";
type Notice = { readonly tone: "error" | "info"; readonly text: string };

export default function AuthPanel({ initialError }: { readonly initialError?: string | null }) {
  const [mode, setMode] = useState<Mode>("signIn");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(
    initialError ? { tone: "error", text: initialError } : null,
  );

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setNotice(null);
    const auth = getSupabaseBrowser().auth;
    try {
      if (mode === "signIn") {
        const { error } = await auth.signInWithPassword({ email, password });
        if (error !== null) setNotice({ tone: "error", text: error.message });
      } else {
        const { data, error } = await auth.signUp({
          email,
          password,
          options: { emailRedirectTo: `${window.location.origin}/auth/callback` },
        });
        if (error !== null) setNotice({ tone: "error", text: error.message });
        else if (data.session === null) {
          setNotice({ tone: "info", text: `Check ${email} for a confirmation link, then come back here.` });
        }
      }
    } catch {
      setNotice({ tone: "error", text: "Network error. Check your connection and try again." });
    } finally {
      setBusy(false);
    }
  }

  const isSignIn = mode === "signIn";
  return (
    <section className="mx-auto w-full max-w-sm rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
      <h2 className="text-lg font-semibold text-slate-900">{isSignIn ? "Sign in" : "Create an account"}</h2>
      <p className="mt-1 text-sm text-slate-600">
        {isSignIn ? "Welcome back. Your library is waiting." : "Upload a book and start studying in minutes."}
      </p>
      <form onSubmit={(e) => void submit(e)} className="mt-5 space-y-3">
        <label className="block text-sm">
          <span className="font-medium text-slate-800">Email</span>
          <input
            type="email"
            required
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 focus:border-indigo-500 focus:outline-none"
          />
        </label>
        <label className="block text-sm">
          <span className="font-medium text-slate-800">Password</span>
          <input
            type="password"
            required
            minLength={isSignIn ? 1 : 8}
            autoComplete={isSignIn ? "current-password" : "new-password"}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 focus:border-indigo-500 focus:outline-none"
          />
        </label>
        {notice !== null ? (
          <p
            role={notice.tone === "error" ? "alert" : "status"}
            className={`rounded-lg px-3 py-2 text-sm ${notice.tone === "error" ? "bg-rose-50 text-rose-800" : "bg-emerald-50 text-emerald-900"}`}
          >
            {notice.text}
          </p>
        ) : null}
        <button
          type="submit"
          disabled={busy}
          className="w-full rounded-xl bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-700 disabled:opacity-50"
        >
          {busy ? "Please wait…" : isSignIn ? "Sign in" : "Sign up"}
        </button>
      </form>
      <button
        type="button"
        onClick={() => {
          setMode(isSignIn ? "signUp" : "signIn");
          setNotice(null);
        }}
        className="mt-4 text-sm font-medium text-indigo-700 hover:underline"
      >
        {isSignIn ? "New here? Create an account" : "Already have an account? Sign in"}
      </button>
    </section>
  );
}
