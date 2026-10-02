import "server-only";
import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { getServerEnv, type ServerEnv } from "@/lib/env";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import {
  BookRowSchema,
  type BookRow,
  type PurgeReport,
  type StorageQuota,
  type UploadUrlRequest,
  type UploadUrlResponse,
} from "@/types/schema";

// ---------------------------------------------------------------------------
// Result + error types
// ---------------------------------------------------------------------------

export type StorageErrorCode =
  | "NOT_FOUND"
  | "FORBIDDEN"
  | "FILE_TOO_LARGE"
  | "STORAGE_QUOTA_EXCEEDED"
  | "DB_QUOTA_EXCEEDED"
  | "INVALID_STATE"
  | "UPLOAD_MISMATCH"
  | "STORAGE_FAILURE"
  | "DATABASE_FAILURE";

export class StorageError extends Error {
  readonly code: StorageErrorCode;
  readonly httpStatus: number;

  constructor(code: StorageErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "StorageError";
    this.code = code;
    this.httpStatus = STATUS_BY_CODE[code];
  }
}

const STATUS_BY_CODE: Record<StorageErrorCode, number> = {
  NOT_FOUND: 404,
  FORBIDDEN: 403,
  FILE_TOO_LARGE: 413,
  STORAGE_QUOTA_EXCEEDED: 507,
  DB_QUOTA_EXCEEDED: 507,
  INVALID_STATE: 409,
  UPLOAD_MISMATCH: 422,
  STORAGE_FAILURE: 502,
  DATABASE_FAILURE: 500,
};

export type Result<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: StorageError };

const ok = <T>(value: T): Result<T> => ({ ok: true, value });
const fail = <T>(code: StorageErrorCode, message: string, cause?: unknown): Result<T> => ({
  ok: false,
  error: new StorageError(code, message, { cause }),
});

export interface CleanupReport {
  readonly scannedObjects: number;
  readonly deletedObjects: number;
  readonly freedBytes: number;
  readonly releasedReservations: number;
  readonly failedIngestionsMarked: number;
  readonly finalizedDeletions: number;
  readonly errors: readonly string[];
}

const UsageRowSchema = z.object({
  retained_file_bytes: z.coerce.number().int().nonnegative(),
  pending_file_bytes: z.coerce.number().int().nonnegative(),
  estimated_db_bytes: z.coerce.number().int().nonnegative(),
  book_count: z.coerce.number().int().nonnegative(),
});

const PurgeCandidateSchema = z.object({
  object_name: z.string(),
  book_id: z.uuid().nullable(),
  size_bytes: z.coerce.number().int().nonnegative(),
  reason: z.enum([
    "no_book_row",
    "purged_flag_set",
    "stuck_deleting",
    "abandoned_upload",
    "failed_ingestion",
    "indexed_not_purged",
  ]),
});

const StaleBookSchema = z.object({
  book_id: z.uuid(),
  file_path: z.string().nullable(),
  status: z.enum(["pending_upload", "deleting", "uploaded", "processing"]),
});

const REMOVE_BATCH_SIZE = 100;
const BOOK_COLUMNS =
  "id,user_id,title,author,file_name,mime_type,file_path,is_file_purged,keep_original,file_size_bytes,total_pages,chunk_count,status,graph_status,ingest_error,created_at,updated_at";

/** Produces a storage-safe object name, preserving the extension. */
export function sanitizeFileName(fileName: string): string {
  const trimmed = fileName.normalize("NFKD").replace(/[^\x20-\x7E]/g, "").trim();
  const dot = trimmed.lastIndexOf(".");
  const base = (dot > 0 ? trimmed.slice(0, dot) : trimmed).replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  const ext = (dot > 0 ? trimmed.slice(dot + 1) : "").replace(/[^A-Za-z0-9]/g, "").toLowerCase().slice(0, 8);
  const safeBase = (base === "" ? "book" : base).slice(0, 80);
  return ext === "" ? safeBase : `${safeBase}.${ext}`;
}

export function buildObjectPath(userId: string, bookId: string, fileName: string): string {
  return `${userId}/${bookId}/${sanitizeFileName(fileName)}`;
}

function extractPgErrorToken(message: string | undefined): StorageErrorCode | null {
  if (message === undefined) return null;
  const match = /\b(FILE_TOO_LARGE|STORAGE_QUOTA_EXCEEDED|DB_QUOTA_EXCEEDED)\b/.exec(message);
  const token = match?.[1];
  return token === "FILE_TOO_LARGE" || token === "STORAGE_QUOTA_EXCEEDED" || token === "DB_QUOTA_EXCEEDED"
    ? token
    : null;
}

function parseBookRow(raw: unknown): Result<BookRow> {
  const parsed = BookRowSchema.safeParse(raw);
  if (!parsed.success) {
    return fail("DATABASE_FAILURE", `Unexpected book row shape: ${z.prettifyError(parsed.error)}`);
  }
  return ok(parsed.data);
}

function isNotFoundStorageError(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const record = err as { message?: unknown; status?: unknown; statusCode?: unknown };
  const status = typeof record.status === "number" ? record.status : Number(record.statusCode ?? NaN);
  const message = typeof record.message === "string" ? record.message : "";
  return status === 404 || /not.?found/i.test(message);
}

export class StorageManager {
  private readonly db: SupabaseClient;
  private readonly env: ServerEnv;

  constructor(db: SupabaseClient = getSupabaseAdmin(), env: ServerEnv = getServerEnv()) {
    this.db = db;
    this.env = env;
  }

  private get bucket() {
    return this.db.storage.from(this.env.storageBucket);
  }

  /** Loads a book and asserts ownership. Returns NOT_FOUND for foreign books to avoid id probing. */
  async getOwnedBook(userId: string, bookId: string): Promise<Result<BookRow>> {
    const { data, error } = await this.db
      .from("books")
      .select(BOOK_COLUMNS)
      .eq("id", bookId)
      .eq("user_id", userId)
      .maybeSingle();
    if (error !== null) return fail("DATABASE_FAILURE", "Failed to load book", error);
    if (data === null) return fail("NOT_FOUND", "Book not found");
    return parseBookRow(data);
  }

  async getBookById(bookId: string): Promise<Result<BookRow>> {
    const { data, error } = await this.db.from("books").select(BOOK_COLUMNS).eq("id", bookId).maybeSingle();
    if (error !== null) return fail("DATABASE_FAILURE", "Failed to load book", error);
    if (data === null) return fail("NOT_FOUND", "Book not found");
    return parseBookRow(data);
  }

  async listBooks(userId: string): Promise<Result<BookRow[]>> {
    const { data, error } = await this.db
      .from("books")
      .select(BOOK_COLUMNS)
      .eq("user_id", userId)
      .neq("status", "deleting")
      .order("created_at", { ascending: false })
      .limit(500);
    if (error !== null) return fail("DATABASE_FAILURE", "Failed to list books", error);
    const rows: BookRow[] = [];
    for (const raw of data ?? []) {
      const parsed = parseBookRow(raw);
      if (!parsed.ok) return parsed;
      rows.push(parsed.value);
    }
    return ok(rows);
  }

  async getQuota(userId: string): Promise<Result<StorageQuota>> {
    const { data, error } = await this.db.rpc("get_storage_usage", { p_user_id: userId }).single();
    if (error !== null) return fail("DATABASE_FAILURE", "Failed to compute storage usage", error);
    const parsed = UsageRowSchema.safeParse(data);
    if (!parsed.success) return fail("DATABASE_FAILURE", "Unexpected usage payload");
    const u = parsed.data;
    const dbBlocked = u.estimated_db_bytes >= this.env.maxUserDbBytes;
    const storageBlocked = u.retained_file_bytes + u.pending_file_bytes >= this.env.maxUserStorageBytes;
    return ok({
      retainedFileBytes: u.retained_file_bytes,
      pendingFileBytes: u.pending_file_bytes,
      estimatedDbBytes: u.estimated_db_bytes,
      bookCount: u.book_count,
      maxStorageBytes: this.env.maxUserStorageBytes,
      maxDbBytes: this.env.maxUserDbBytes,
      maxUploadBytes: this.env.maxUploadBytes,
      canUpload: !dbBlocked && !storageBlocked,
      blockedReason: dbBlocked ? "db_quota" : storageBlocked ? "storage_quota" : null,
    });
  }

  /**
   * Checks quota and reserves a `books` row in one advisory-locked RPC, then mints a signed upload
   * URL so the browser uploads directly to Storage (bypassing Vercel's request-body limit).
   */
  async createSignedUpload(userId: string, request: UploadUrlRequest): Promise<Result<UploadUrlResponse>> {
    if (request.fileSizeBytes > this.env.maxUploadBytes) {
      return fail("FILE_TOO_LARGE", "File exceeds the 25 MB upload limit");
    }
    const bookId = randomUUID();
    const path = buildObjectPath(userId, bookId, request.fileName);

    const { error: reserveError } = await this.db.rpc("reserve_book_upload", {
      p_user_id: userId,
      p_book_id: bookId,
      p_title: request.title,
      p_author: request.author ?? null,
      p_file_name: request.fileName,
      p_mime_type: request.mimeType,
      p_file_path: path,
      p_file_size_bytes: request.fileSizeBytes,
      p_keep_original: request.keepOriginal,
      p_max_file_bytes: this.env.maxUploadBytes,
      p_max_storage_bytes: this.env.maxUserStorageBytes,
      p_max_db_bytes: this.env.maxUserDbBytes,
    });
    if (reserveError !== null) {
      const token = extractPgErrorToken(reserveError.message);
      if (token === "STORAGE_QUOTA_EXCEEDED") {
        return fail(token, "Storage quota reached. Purge books or disable 'Keep Original PDF' to free space.");
      }
      if (token === "DB_QUOTA_EXCEEDED") {
        return fail(token, "Index quota reached. Delete a book to free space before uploading.");
      }
      if (token === "FILE_TOO_LARGE") return fail(token, "File exceeds the 25 MB upload limit");
      return fail("DATABASE_FAILURE", "Could not reserve upload", reserveError);
    }

    const { data, error } = await this.bucket.createSignedUploadUrl(path, { upsert: false });
    if (error !== null) {
      await this.db.from("books").delete().eq("id", bookId);
      return fail("STORAGE_FAILURE", "Could not create signed upload URL", error);
    }
    return ok({ bookId, path: data.path, token: data.token, signedUrl: data.signedUrl });
  }

  /**
   * Confirms the uploaded object exists and its real size matches the reservation, defeating
   * clients that reserve a small size and upload a larger file. Transitions to `uploaded`.
   */
  async verifyUploadedObject(userId: string, bookId: string): Promise<Result<BookRow>> {
    const book = await this.getOwnedBook(userId, bookId);
    if (!book.ok) return book;
    const row = book.value;
    if (row.status !== "pending_upload" && row.status !== "uploaded") {
      return fail("INVALID_STATE", `Book is already ${row.status}`);
    }
    if (row.file_path === null) return fail("INVALID_STATE", "Book has no file path");

    const { data, error } = await this.bucket.info(row.file_path);
    if (error !== null || data === null) {
      return fail(isNotFoundStorageError(error) ? "UPLOAD_MISMATCH" : "STORAGE_FAILURE", "Uploaded file not found", error);
    }
    const actualSize = data.size ?? -1;
    if (actualSize <= 0 || actualSize > this.env.maxUploadBytes || actualSize > row.file_size_bytes) {
      await this.deleteObjects([row.file_path]);
      await this.db.from("books").delete().eq("id", bookId);
      return fail("UPLOAD_MISMATCH", "Uploaded file size does not match the reservation; upload discarded");
    }

    const { data: updated, error: updateError } = await this.db
      .from("books")
      .update({ status: "uploaded", file_size_bytes: actualSize })
      .eq("id", bookId)
      .in("status", ["pending_upload", "uploaded"])
      .select(BOOK_COLUMNS)
      .maybeSingle();
    if (updateError !== null) return fail("DATABASE_FAILURE", "Failed to mark upload complete", updateError);
    if (updated === null) return fail("INVALID_STATE", "Book changed state during verification");
    return parseBookRow(updated);
  }

  /** Short-lived signed download URL for the ML service to fetch the raw file. */
  async createIngestionDownloadUrl(filePath: string, expiresInSeconds = 900): Promise<Result<string>> {
    const { data, error } = await this.bucket.createSignedUrl(filePath, expiresInSeconds);
    if (error !== null) return fail("STORAGE_FAILURE", "Could not sign download URL", error);
    return ok(data.signedUrl);
  }

  /** Removes objects in batches; a 404 is treated as already-deleted (idempotent). */
  private async deleteObjects(paths: readonly string[]): Promise<Result<number>> {
    let removed = 0;
    for (let i = 0; i < paths.length; i += REMOVE_BATCH_SIZE) {
      const batch = paths.slice(i, i + REMOVE_BATCH_SIZE);
      const { data, error } = await this.bucket.remove([...batch]);
      if (error !== null && !isNotFoundStorageError(error)) {
        return fail("STORAGE_FAILURE", `Failed to delete ${batch.length} object(s)`, error);
      }
      removed += data?.length ?? 0;
    }
    return ok(removed);
  }

  /** Explicitly deletes a single object; idempotent. */
  async deleteFile(filePath: string): Promise<Result<boolean>> {
    const result = await this.deleteObjects([filePath]);
    return result.ok ? ok(true) : result;
  }

  /**
   * Ephemeral File Mode: deletes the raw upload once chunks + embeddings are persisted.
   * Skipped when the user opted into "Keep Original". Storage is deleted *before* flipping the
   * flag so a crash leaves `is_file_purged=false` and the cron retries (never a leaked blob).
   */
  async purgeRawFile(bookId: string, options: { force?: boolean } = {}): Promise<Result<{ purged: boolean }>> {
    const book = await this.getBookById(bookId);
    if (!book.ok) return book;
    const row = book.value;
    if (row.is_file_purged || row.file_path === null) return ok({ purged: false });
    if (row.keep_original && options.force !== true) return ok({ purged: false });
    if (row.status !== "indexed" && options.force !== true) {
      return fail("INVALID_STATE", "Raw file can only be auto-purged after successful indexing");
    }

    const removed = await this.deleteFile(row.file_path);
    if (!removed.ok) return removed;

    const { error } = await this.db
      .from("books")
      .update({ is_file_purged: true, file_path: null })
      .eq("id", bookId)
      .eq("file_path", row.file_path);
    if (error !== null) return fail("DATABASE_FAILURE", "Raw file deleted but purge flag not recorded", error);
    return ok({ purged: true });
  }

  /** Toggles "Keep Original PDF". Disabling it on an indexed book purges the raw file immediately. */
  async setKeepOriginal(userId: string, bookId: string, keepOriginal: boolean): Promise<Result<BookRow>> {
    const book = await this.getOwnedBook(userId, bookId);
    if (!book.ok) return book;
    if (book.value.status === "deleting") return fail("INVALID_STATE", "Book is being deleted");
    if (keepOriginal && book.value.is_file_purged) {
      return fail("INVALID_STATE", "The original file was already purged and cannot be restored");
    }

    const { error } = await this.db
      .from("books")
      .update({ keep_original: keepOriginal })
      .eq("id", bookId)
      .eq("user_id", userId);
    if (error !== null) return fail("DATABASE_FAILURE", "Failed to update retention preference", error);

    if (!keepOriginal && book.value.status === "indexed") {
      const purge = await this.purgeRawFile(bookId);
      if (!purge.ok) return purge;
    }
    return this.getOwnedBook(userId, bookId);
  }

  /**
   * Hard cascade purge. Order guarantees no partial user-visible state:
   *  1. Mark `deleting` (hides the book, blocks concurrent ingestion callbacks).
   *  2. DELETE the row → ON DELETE CASCADE removes chunks, embeddings, concepts, edges, cards,
   *     review logs and assessment logs in one Postgres transaction.
   *  3. Delete the storage object. If Storage is unavailable the blob becomes an orphan
   *     (no book row) which `cleanupOrphans` removes on its next run.
   */
  async purgeBook(userId: string, bookId: string): Promise<Result<PurgeReport>> {
    const book = await this.getOwnedBook(userId, bookId);
    if (!book.ok) return book;
    const filePath = book.value.file_path;

    const { error: markError } = await this.db
      .from("books")
      .update({ status: "deleting" })
      .eq("id", bookId)
      .eq("user_id", userId);
    if (markError !== null) return fail("DATABASE_FAILURE", "Failed to begin deletion", markError);

    const { data: deletedRows, error: deleteError } = await this.db
      .from("books")
      .delete()
      .eq("id", bookId)
      .eq("user_id", userId)
      .select("id");
    if (deleteError !== null) return fail("DATABASE_FAILURE", "Failed to delete book records", deleteError);
    const databaseRowsDeleted = (deletedRows ?? []).length > 0;

    let storageObjectDeleted = filePath === null;
    if (filePath !== null) {
      const removed = await this.deleteFile(filePath);
      storageObjectDeleted = removed.ok;
    }

    return ok({
      bookId,
      databaseRowsDeleted,
      storageObjectDeleted,
      storageObjectPath: filePath,
      deferredToCleanup: !storageObjectDeleted,
    });
  }

  /** Marks a book failed and releases its raw file (failed ingestions never retain storage). */
  async markIngestionFailed(bookId: string, message: string): Promise<Result<void>> {
    const { error } = await this.db
      .from("books")
      .update({ status: "failed", ingest_error: message.slice(0, 2000) })
      .eq("id", bookId)
      .neq("status", "deleting");
    if (error !== null) return fail("DATABASE_FAILURE", "Failed to record ingestion failure", error);
    const purge = await this.purgeRawFile(bookId, { force: true });
    return purge.ok ? ok(undefined) : purge;
  }

  /**
   * Cron: reconciles Storage with Postgres for anything older than `ORPHAN_MAX_AGE_HOURS`.
   *  - Objects with no book row, purged/failed/abandoned books, or indexed books that should have
   *    been auto-purged → deleted from Storage.
   *  - Stale `pending_upload` reservations → rows deleted (releases reserved quota).
   *  - Stuck `deleting` rows → deletion finalized (cascade).
   *  - Stuck `uploaded`/`processing` ingestions → marked failed (also releases the file).
   */
  async cleanupOrphans(): Promise<Result<CleanupReport>> {
    const olderThan = `${this.env.orphanMaxAgeHours} hours`;
    const errors: string[] = [];

    const { data: candidateData, error: candidateError } = await this.db.rpc("list_purge_candidates", {
      p_bucket: this.env.storageBucket,
      p_older_than: olderThan,
      p_limit: 1000,
    });
    if (candidateError !== null) return fail("DATABASE_FAILURE", "Failed to list purge candidates", candidateError);
    const candidates = z.array(PurgeCandidateSchema).safeParse(candidateData ?? []);
    if (!candidates.success) return fail("DATABASE_FAILURE", "Unexpected purge candidate payload");

    let deletedObjects = 0;
    let freedBytes = 0;
    const paths = candidates.data.map((c) => c.object_name);
    for (let i = 0; i < paths.length; i += REMOVE_BATCH_SIZE) {
      const batch = candidates.data.slice(i, i + REMOVE_BATCH_SIZE);
      const removed = await this.deleteObjects(batch.map((c) => c.object_name));
      if (!removed.ok) {
        errors.push(removed.error.message);
        continue;
      }
      deletedObjects += batch.length;
      freedBytes += batch.reduce((sum, c) => sum + c.size_bytes, 0);
      const purgedBookIds = batch
        .filter((c) => c.book_id !== null && (c.reason === "indexed_not_purged" || c.reason === "failed_ingestion"))
        .map((c) => c.book_id as string);
      if (purgedBookIds.length > 0) {
        const { error } = await this.db
          .from("books")
          .update({ is_file_purged: true, file_path: null })
          .in("id", purgedBookIds);
        if (error !== null) errors.push(`Failed to flag purged books: ${error.message}`);
      }
    }

    const { data: staleData, error: staleError } = await this.db.rpc("list_stale_books", {
      p_older_than: olderThan,
      p_limit: 1000,
    });
    let releasedReservations = 0;
    let failedIngestionsMarked = 0;
    let finalizedDeletions = 0;
    if (staleError !== null) {
      errors.push(`Failed to list stale books: ${staleError.message}`);
    } else {
      const stale = z.array(StaleBookSchema).safeParse(staleData ?? []);
      if (!stale.success) {
        errors.push("Unexpected stale-book payload");
      } else {
        for (const book of stale.data) {
          if (book.status === "pending_upload" || book.status === "deleting") {
            if (book.file_path !== null) {
              const removed = await this.deleteFile(book.file_path);
              if (!removed.ok) {
                errors.push(`Book ${book.book_id}: ${removed.error.message}`);
                continue;
              }
            }
            const { error } = await this.db.from("books").delete().eq("id", book.book_id).eq("status", book.status);
            if (error !== null) {
              errors.push(`Book ${book.book_id}: ${error.message}`);
              continue;
            }
            if (book.status === "pending_upload") releasedReservations++;
            else finalizedDeletions++;
          } else {
            const marked = await this.markIngestionFailed(book.book_id, "Ingestion timed out without a completion callback");
            if (marked.ok) failedIngestionsMarked++;
            else errors.push(`Book ${book.book_id}: ${marked.error.message}`);
          }
        }
      }
    }

    return ok({
      scannedObjects: candidates.data.length,
      deletedObjects,
      freedBytes,
      releasedReservations,
      failedIngestionsMarked,
      finalizedDeletions,
      errors,
    });
  }
}

let defaultManager: StorageManager | null = null;

export function getStorageManager(): StorageManager {
  if (defaultManager === null) defaultManager = new StorageManager();
  return defaultManager;
}
