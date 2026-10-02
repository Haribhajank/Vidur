"use client";

import { useCallback, useState } from "react";
import StorageUsageModal from "@/components/StorageUsageModal";

export default function DashboardShell() {
  const [open, setOpen] = useState(false);
  const [refreshCount, setRefreshCount] = useState(0);
  const close = useCallback(() => setOpen(false), []);
  const changed = useCallback(() => setRefreshCount((n) => n + 1), []);

  return (
    <main className="mx-auto flex max-w-5xl flex-col gap-6 px-6 py-12">
      <header className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">BookMentor AI</h1>
          <p className="text-sm text-slate-600">Your books, turned into active-recall curricula.</p>
        </div>
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="rounded-xl bg-slate-900 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-slate-700"
        >
          Manage &amp; Purge Books
        </button>
      </header>
      <p className="text-xs text-slate-500" aria-live="polite">
        {refreshCount > 0 ? `Library updated ${refreshCount} time${refreshCount === 1 ? "" : "s"} this session.` : ""}
      </p>
      <StorageUsageModal open={open} onClose={close} onChanged={changed} />
    </main>
  );
}
