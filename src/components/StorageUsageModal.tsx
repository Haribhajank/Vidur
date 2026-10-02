"use client";

import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { Component, useCallback, useEffect, useId, useRef, useState, type ErrorInfo, type ReactNode } from "react";
import {
  ApiErrorSchema,
  PurgeReportSchema,
  safeJsonParse,
  StorageOverviewSchema,
  UpdateBookResponseSchema,
  type Book,
  type StorageQuota,
} from "@/types/schema";
import type { z } from "zod";

// ---------------------------------------------------------------------------
// Typed fetch with defensive parsing
// ---------------------------------------------------------------------------

type FetchResult<T> = { ok: true; data: T } | { ok: false; message: string };

async function requestJson<T>(url: string, schema: z.ZodType<T>, init?: RequestInit): Promise<FetchResult<T>> {
  let response: Response;
  try {
    response = await fetch(url, { ...init, headers: { "content-type": "application/json", ...init?.headers } });
  } catch {
    return { ok: false, message: "Network error. Check your connection and try again." };
  }
  const text = await response.text().catch(() => "");
  if (!response.ok) {
    const parsed = safeJsonParse(text, ApiErrorSchema);
    return { ok: false, message: parsed.ok ? parsed.data.error.message : `Request failed (${response.status})` };
  }
  const parsed = safeJsonParse(text, schema);
  return parsed.ok ? { ok: true, data: parsed.data } : { ok: false, message: "Unexpected response from server." };
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

const MB = 1024 * 1024;

export function formatMegabytes(bytes: number): string {
  const mb = bytes / MB;
  return `${mb < 10 ? mb.toFixed(2) : mb.toFixed(1)} MB`;
}

function percent(used: number, max: number): number {
  return max <= 0 ? 0 : Math.min(100, Math.max(0, (used / max) * 100));
}

const STATUS_LABEL: Record<Book["status"], { label: string; tone: string }> = {
  pending_upload: { label: "Uploading", tone: "bg-slate-100 text-slate-700" },
  uploaded: { label: "Queued", tone: "bg-sky-100 text-sky-800" },
  processing: { label: "Indexing", tone: "bg-amber-100 text-amber-800" },
  indexed: { label: "Ready", tone: "bg-emerald-100 text-emerald-800" },
  failed: { label: "Failed", tone: "bg-rose-100 text-rose-800" },
  deleting: { label: "Deleting", tone: "bg-slate-200 text-slate-600" },
};

// ---------------------------------------------------------------------------
// Error boundary
// ---------------------------------------------------------------------------

interface BoundaryProps {
  readonly children: ReactNode;
  readonly onReset: () => void;
}

class StorageModalErrorBoundary extends Component<BoundaryProps, { error: Error | null }> {
  override state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("StorageUsageModal crashed", error, info.componentStack);
  }

  override render(): ReactNode {
    if (this.state.error === null) return this.props.children;
    return (
      <div role="alert" className="space-y-3 p-6 text-sm">
        <p className="font-semibold text-rose-700">Something went wrong while showing your storage.</p>
        <button
          type="button"
          className="rounded-lg bg-slate-900 px-3 py-1.5 font-medium text-white hover:bg-slate-700"
          onClick={() => {
            this.setState({ error: null });
            this.props.onReset();
          }}
        >
          Try again
        </button>
      </div>
    );
  }
}

// ---------------------------------------------------------------------------
// Usage meter
// ---------------------------------------------------------------------------

function UsageMeter({ label, used, max, hint }: { label: string; used: number; max: number; hint: string }) {
  const pct = percent(used, max);
  const tone = pct >= 90 ? "bg-rose-500" : pct >= 70 ? "bg-amber-500" : "bg-emerald-500";
  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between text-sm">
        <span className="font-medium text-slate-800">{label}</span>
        <span className="tabular-nums text-slate-600">
          {formatMegabytes(used)} / {formatMegabytes(max)}
        </span>
      </div>
      <div
        className="h-2.5 w-full overflow-hidden rounded-full bg-slate-200"
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(pct)}
      >
        <motion.div
          className={`h-full rounded-full ${tone}`}
          initial={{ width: 0 }}
          animate={{ width: `${pct}%` }}
          transition={{ type: "spring", stiffness: 120, damping: 20 }}
        />
      </div>
      <p className="text-xs text-slate-500">{hint}</p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Book row
// ---------------------------------------------------------------------------

interface BookRowProps {
  readonly book: Book;
  readonly busy: "toggle" | "delete" | null;
  readonly onToggleKeep: (book: Book, keep: boolean) => void;
  readonly onDelete: (book: Book) => void;
}

function BookRow({ book, busy, onToggleKeep, onDelete }: BookRowProps) {
  const [confirming, setConfirming] = useState(false);
  const switchId = useId();
  const status = STATUS_LABEL[book.status];
  const toggleDisabled = busy !== null || book.status === "deleting" || (book.isFilePurged && !book.keepOriginal);
  const retained = !book.isFilePurged && book.status !== "pending_upload";

  return (
    <motion.li
      layout
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, x: -24, transition: { duration: 0.18 } }}
      className="flex flex-col gap-3 rounded-xl border border-slate-200 bg-white p-4 sm:flex-row sm:items-center"
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <p className="truncate font-medium text-slate-900" title={book.title}>
            {book.title}
          </p>
          <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${status.tone}`}>{status.label}</span>
        </div>
        <p className="mt-0.5 truncate text-xs text-slate-500">
          {book.author === null ? "Unknown author" : book.author} · {book.chunkCount} chunks ·{" "}
          {retained ? `${formatMegabytes(book.fileSizeBytes)} original stored` : "original purged (index only)"}
        </p>
        {book.status === "failed" && book.ingestError !== null ? (
          <p className="mt-1 text-xs text-rose-700">{book.ingestError}</p>
        ) : null}
      </div>

      <div className="flex items-center gap-4">
        <div className="flex items-center gap-2">
          <button
            id={switchId}
            type="button"
            role="switch"
            aria-checked={book.keepOriginal}
            aria-label={`Keep original file for ${book.title}`}
            disabled={toggleDisabled}
            onClick={() => onToggleKeep(book, !book.keepOriginal)}
            className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600 disabled:cursor-not-allowed disabled:opacity-50 ${
              book.keepOriginal ? "bg-indigo-600" : "bg-slate-300"
            }`}
          >
            <motion.span
              layout
              transition={{ type: "spring", stiffness: 500, damping: 32 }}
              className={`inline-block h-5 w-5 rounded-full bg-white shadow ${book.keepOriginal ? "ml-5" : "ml-0.5"}`}
            />
          </button>
          <label htmlFor={switchId} className="cursor-pointer text-xs text-slate-600 select-none">
            Keep Original PDF
          </label>
        </div>

        {confirming ? (
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => {
                setConfirming(false);
                onDelete(book);
              }}
              className="rounded-lg bg-rose-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-rose-700 disabled:opacity-50"
            >
              Confirm delete
            </button>
            <button
              type="button"
              onClick={() => setConfirming(false)}
              className="rounded-lg px-2 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-100"
            >
              Cancel
            </button>
          </div>
        ) : (
          <button
            type="button"
            disabled={busy !== null || book.status === "deleting"}
            onClick={() => setConfirming(true)}
            aria-label={`Delete ${book.title}`}
            className="rounded-lg border border-rose-200 px-3 py-1.5 text-xs font-semibold text-rose-700 hover:bg-rose-50 disabled:opacity-50"
          >
            {busy === "delete" ? "Deleting…" : "Delete Book"}
          </button>
        )}
      </div>
    </motion.li>
  );
}

// ---------------------------------------------------------------------------
// Modal body: data loading + optimistic mutations with rollback
// ---------------------------------------------------------------------------

type LoadState =
  | { readonly kind: "loading" }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "ready"; readonly quota: StorageQuota; readonly books: readonly Book[] };

type Notice = { readonly tone: "error" | "info"; readonly text: string };

function useStorageOverview(onChanged?: () => void) {
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [busy, setBusy] = useState<Readonly<Record<string, "toggle" | "delete">>>({});
  const [notice, setNotice] = useState<Notice | null>(null);
  const stateRef = useRef(state);
  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  const load = useCallback(async () => {
    const result = await requestJson("/api/storage/quota", StorageOverviewSchema, { method: "GET", cache: "no-store" });
    setState(result.ok ? { kind: "ready", quota: result.data.quota, books: result.data.books } : { kind: "error", message: result.message });
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const setBookBusy = useCallback((id: string, value: "toggle" | "delete" | null) => {
    setBusy((prev) => {
      const next = { ...prev };
      if (value === null) delete next[id];
      else next[id] = value;
      return next;
    });
  }, []);

  const toggleKeep = useCallback(
    async (book: Book, keep: boolean) => {
      const snapshot = stateRef.current;
      if (snapshot.kind !== "ready") return;
      setBookBusy(book.id, "toggle");
      setNotice(null);
      setState({ ...snapshot, books: snapshot.books.map((b) => (b.id === book.id ? { ...b, keepOriginal: keep } : b)) });
      const result = await requestJson(`/api/books/${book.id}`, UpdateBookResponseSchema, {
        method: "PATCH",
        body: JSON.stringify({ keepOriginal: keep }),
      });
      setBookBusy(book.id, null);
      if (!result.ok) {
        setState(snapshot);
        setNotice({ tone: "error", text: result.message });
        return;
      }
      if (!keep && result.data.book.isFilePurged && !book.isFilePurged) {
        setNotice({ tone: "info", text: `Original file for “${book.title}” was purged. Your study index is unaffected.` });
      }
      await load();
      onChanged?.();
    },
    [load, onChanged, setBookBusy],
  );

  const deleteBook = useCallback(
    async (book: Book) => {
      const snapshot = stateRef.current;
      if (snapshot.kind !== "ready") return;
      setBookBusy(book.id, "delete");
      setNotice(null);
      setState({ ...snapshot, books: snapshot.books.filter((b) => b.id !== book.id) });
      const result = await requestJson(`/api/books/${book.id}`, PurgeReportSchema, { method: "DELETE" });
      setBookBusy(book.id, null);
      if (!result.ok) {
        setState(snapshot);
        setNotice({ tone: "error", text: `Could not delete “${book.title}”: ${result.message}` });
        return;
      }
      setNotice({
        tone: "info",
        text: result.data.deferredToCleanup
          ? `“${book.title}” was deleted. Its stored file will be removed by the next cleanup run.`
          : `“${book.title}” and all its chunks, concepts and cards were permanently deleted.`,
      });
      await load();
      onChanged?.();
    },
    [load, onChanged, setBookBusy],
  );

  const retry = useCallback(() => {
    setState({ kind: "loading" });
    void load();
  }, [load]);

  return { state, busy, notice, toggleKeep, deleteBook, retry };
}

function StorageUsageBody({ onChanged }: { readonly onChanged?: () => void }) {
  const { state, busy, notice, toggleKeep, deleteBook, retry } = useStorageOverview(onChanged);

  if (state.kind === "loading") {
    return (
      <div className="space-y-3 p-6" aria-busy="true" aria-live="polite">
        <div className="h-4 w-1/3 animate-pulse rounded bg-slate-200" />
        <div className="h-2.5 w-full animate-pulse rounded-full bg-slate-200" />
        <div className="h-16 w-full animate-pulse rounded-xl bg-slate-100" />
      </div>
    );
  }

  if (state.kind === "error") {
    return (
      <div role="alert" className="space-y-3 p-6 text-sm">
        <p className="text-rose-700">{state.message}</p>
        <button type="button" onClick={retry} className="rounded-lg bg-slate-900 px-3 py-1.5 font-medium text-white hover:bg-slate-700">
          Retry
        </button>
      </div>
    );
  }

  const { quota, books } = state;
  return (
    <div className="space-y-6 p-6">
      <section aria-label="Storage usage" className="grid gap-5 sm:grid-cols-2">
        <UsageMeter
          label="Original files"
          used={quota.retainedFileBytes + quota.pendingFileBytes}
          max={quota.maxStorageBytes}
          hint="Raw PDFs/EPUBs are kept only when “Keep Original PDF” is on."
        />
        <UsageMeter
          label="Study index"
          used={quota.estimatedDbBytes}
          max={quota.maxDbBytes}
          hint="Text chunks, embeddings, concepts and flashcards."
        />
      </section>

      {!quota.canUpload ? (
        <p role="status" className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">
          {quota.blockedReason === "db_quota"
            ? "Your study index is full. Delete a book before uploading new ones."
            : "Original-file storage is full. Delete a book or turn off “Keep Original PDF” to free space."}
        </p>
      ) : null}

      <AnimatePresence>
        {notice !== null ? (
          <motion.p
            key={notice.text}
            role={notice.tone === "error" ? "alert" : "status"}
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            className={`rounded-lg px-3 py-2 text-sm ${notice.tone === "error" ? "bg-rose-50 text-rose-800" : "bg-emerald-50 text-emerald-900"}`}
          >
            {notice.text}
          </motion.p>
        ) : null}
      </AnimatePresence>

      <section aria-label="Active books">
        <div className="mb-2 flex items-baseline justify-between">
          <h3 className="text-sm font-semibold text-slate-900">Active books ({books.length})</h3>
          <span className="text-xs text-slate-500">Max {formatMegabytes(quota.maxUploadBytes)} per upload</span>
        </div>
        {books.length === 0 ? (
          <p className="rounded-xl border border-dashed border-slate-300 p-6 text-center text-sm text-slate-500">
            No books yet. Uploaded books will appear here.
          </p>
        ) : (
          <ul className="max-h-[50vh] space-y-2 overflow-y-auto pr-1">
            <AnimatePresence initial={false}>
              {books.map((book) => (
                <BookRow
                  key={book.id}
                  book={book}
                  busy={busy[book.id] ?? null}
                  onToggleKeep={(b, keep) => void toggleKeep(b, keep)}
                  onDelete={(b) => void deleteBook(b)}
                />
              ))}
            </AnimatePresence>
          </ul>
        )}
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Dialog shell: focus trap, Escape to close, scroll lock, focus restore
// ---------------------------------------------------------------------------

export interface StorageUsageModalProps {
  readonly open: boolean;
  readonly onClose: () => void;
  /** Called after a book is deleted or its retention changes (e.g. to refresh the dashboard). */
  readonly onChanged?: () => void;
}

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), [tabindex]:not([tabindex="-1"])';

export default function StorageUsageModal({ open, onClose, onChanged }: StorageUsageModalProps) {
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const [resetKey, setResetKey] = useState(0);
  const reduceMotion = useReducedMotion();

  useEffect(() => {
    if (!open) return;
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const focusTimer = window.setTimeout(() => dialogRef.current?.querySelector<HTMLElement>(FOCUSABLE)?.focus(), 0);

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key !== "Tab" || dialogRef.current === null) return;
      const focusables = Array.from(dialogRef.current.querySelectorAll<HTMLElement>(FOCUSABLE));
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (first === undefined || last === undefined) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      window.clearTimeout(focusTimer);
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
      previouslyFocused?.focus();
    };
  }, [open, onClose]);

  return (
    <AnimatePresence>
      {open ? (
        <motion.div
          className="fixed inset-0 z-50 flex items-end justify-center bg-slate-950/50 backdrop-blur-sm sm:items-center sm:p-4"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) onClose();
          }}
        >
          <motion.div
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            className="w-full max-w-2xl overflow-hidden rounded-t-2xl bg-slate-50 shadow-2xl sm:rounded-2xl"
            initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 24, scale: 0.98 }}
            animate={reduceMotion ? { opacity: 1 } : { opacity: 1, y: 0, scale: 1 }}
            exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 16, scale: 0.98 }}
            transition={{ type: "spring", stiffness: 260, damping: 26 }}
          >
            <header className="flex items-center justify-between border-b border-slate-200 bg-white px-6 py-4">
              <div>
                <h2 id={titleId} className="text-base font-semibold text-slate-900">
                  Manage &amp; Purge Books
                </h2>
                <p className="text-xs text-slate-500">Originals are auto-deleted after indexing unless you choose to keep them.</p>
              </div>
              <button
                type="button"
                onClick={onClose}
                aria-label="Close"
                className="rounded-lg p-2 text-slate-500 hover:bg-slate-100 hover:text-slate-800"
              >
                <svg viewBox="0 0 20 20" fill="currentColor" className="h-5 w-5" aria-hidden="true">
                  <path d="M6.28 5.22a.75.75 0 0 0-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 1 0 1.06 1.06L10 11.06l3.72 3.72a.75.75 0 1 0 1.06-1.06L11.06 10l3.72-3.72a.75.75 0 0 0-1.06-1.06L10 8.94 6.28 5.22Z" />
                </svg>
              </button>
            </header>
            <StorageModalErrorBoundary onReset={() => setResetKey((k) => k + 1)}>
              <StorageUsageBody key={resetKey} onChanged={onChanged} />
            </StorageModalErrorBoundary>
          </motion.div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}
