"use client";

import { useCallback, useEffect, useRef, useState, type ChangeEvent } from "react";
import { z } from "zod";
import { requestJson } from "@/lib/apiClient";
import {
  BookSchema,
  MAX_UPLOAD_BYTES,
  StorageOverviewSchema,
  UploadUrlResponseSchema,
  type Book,
  type MimeType,
} from "@/types/schema";

const MIME_BY_EXTENSION: Record<string, MimeType> = { pdf: "application/pdf", epub: "application/epub+zip" };
const INGEST_RETRIES = 4;
const INGEST_RETRY_DELAY_MS = 20_000;
const POLL_MS = 5_000;

const STATUS: Record<Book["status"], { label: string; tone: string }> = {
  pending_upload: { label: "Uploading", tone: "bg-slate-100 text-slate-700" },
  uploaded: { label: "Queued", tone: "bg-sky-100 text-sky-800" },
  processing: { label: "Indexing…", tone: "bg-amber-100 text-amber-800" },
  indexed: { label: "Ready", tone: "bg-emerald-100 text-emerald-800" },
  failed: { label: "Failed", tone: "bg-rose-100 text-rose-800" },
  deleting: { label: "Deleting", tone: "bg-slate-200 text-slate-600" },
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Upload pipeline: reserve + signed URL → direct PUT to Storage → start ingestion (retrying while the Space wakes). */
async function uploadBook(file: File, onStep: (text: string) => void): Promise<string | null> {
  const extension = file.name.split(".").pop()?.toLowerCase() ?? "";
  const mimeType = MIME_BY_EXTENSION[extension];
  if (mimeType === undefined) return "Only PDF and EPUB files are supported.";
  if (file.size > MAX_UPLOAD_BYTES) return "That file is larger than the 25 MB limit.";

  onStep("Reserving space…");
  const reserved = await requestJson("/api/books/upload-url", UploadUrlResponseSchema, {
    method: "POST",
    body: JSON.stringify({
      title: file.name.replace(/\.[^.]+$/, "").slice(0, 300) || "Untitled",
      fileName: file.name,
      mimeType,
      fileSizeBytes: file.size,
    }),
  });
  if (!reserved.ok) return reserved.message;

  onStep("Uploading file…");
  try {
    const put = await fetch(reserved.data.signedUrl, { method: "PUT", headers: { "content-type": mimeType }, body: file });
    if (!put.ok) return `Upload failed (${put.status}).`;
  } catch {
    return "Upload failed. Check your connection and try again.";
  }

  const IngestSchema = z.object({ book: BookSchema });
  for (let attempt = 1; attempt <= INGEST_RETRIES; attempt++) {
    onStep(attempt === 1 ? "Starting indexing…" : `Waking the indexing service (attempt ${attempt}/${INGEST_RETRIES})…`);
    const started = await requestJson(`/api/books/${reserved.data.bookId}/ingest`, IngestSchema, { method: "POST" });
    if (started.ok) return null;
    if (started.status !== 503) return started.message;
    if (attempt < INGEST_RETRIES) await sleep(INGEST_RETRY_DELAY_MS);
  }
  return "The indexing service did not wake up in time. Your file is uploaded; please try again in a minute.";
}

export default function LibraryPanel({
  refreshKey,
  onChanged,
  onOpen,
}: {
  readonly refreshKey: number;
  readonly onChanged: () => void;
  readonly onOpen: (book: Book) => void;
}) {
  const [books, setBooks] = useState<readonly Book[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [step, setStep] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    const result = await requestJson("/api/storage/quota", StorageOverviewSchema, { method: "GET" });
    if (result.ok) {
      setBooks(result.data.books);
      setLoadError(null);
    } else {
      setLoadError(result.message);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  const inFlight = books?.some((b) => b.status === "processing" || b.status === "uploaded") ?? false;
  useEffect(() => {
    if (!inFlight) return;
    const timer = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(timer);
  }, [inFlight, load]);

  async function onFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (file === undefined) return;
    setUploadError(null);
    const error = await uploadBook(file, (text) => {
      setStep(text);
      void load();
    });
    setStep(null);
    if (error !== null) setUploadError(error);
    await load();
    onChanged();
  }

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-dashed border-slate-300 bg-white p-5">
        <div>
          <h2 className="font-semibold text-slate-900">Add a book</h2>
          <p className="text-sm text-slate-600">PDF or EPUB, up to 25 MB. Indexing usually takes under a minute.</p>
        </div>
        <input ref={inputRef} type="file" accept=".pdf,.epub,application/pdf,application/epub+zip" className="hidden" onChange={(e) => void onFile(e)} />
        <button
          type="button"
          disabled={step !== null}
          onClick={() => inputRef.current?.click()}
          className="rounded-xl bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-500 disabled:opacity-60"
        >
          {step ?? "Upload book"}
        </button>
      </div>
      {uploadError !== null ? (
        <p role="alert" className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-800">
          {uploadError}
        </p>
      ) : null}

      <div>
        <h2 className="mb-2 text-sm font-semibold text-slate-900">Your library</h2>
        {loadError !== null ? (
          <p role="alert" className="text-sm text-rose-700">{loadError}</p>
        ) : books === null ? (
          <div className="h-16 animate-pulse rounded-xl bg-slate-100" aria-busy="true" />
        ) : books.length === 0 ? (
          <p className="rounded-xl border border-slate-200 bg-white p-6 text-center text-sm text-slate-500">
            No books yet. Upload one to get started.
          </p>
        ) : (
          <ul className="space-y-2">
            {books.map((book) => (
              <li key={book.id} className="rounded-xl border border-slate-200 bg-white p-4">
                <div className="flex items-center gap-2">
                  <p className="min-w-0 flex-1 truncate font-medium text-slate-900" title={book.title}>
                    {book.title}
                  </p>
                  <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${STATUS[book.status].tone}`}>
                    {STATUS[book.status].label}
                  </span>
                </div>
                <p className="mt-0.5 text-xs text-slate-500">
                  {book.author ?? "Unknown author"}
                  {book.status === "indexed" ? ` · ${book.chunkCount} chunks` : ""}
                </p>
                {book.status === "failed" && book.ingestError !== null ? (
                  <p className="mt-1 text-xs text-rose-700">{book.ingestError}</p>
                ) : null}
                {book.status === "indexed" ? (
                  <button
                    type="button"
                    onClick={() => onOpen(book)}
                    className="mt-3 rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-slate-700"
                  >
                    Study this book →
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
