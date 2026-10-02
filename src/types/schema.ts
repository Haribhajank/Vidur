import { z } from "zod";

export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
export const EMBEDDING_DIMENSIONS = 384;

export const ALLOWED_MIME_TYPES = ["application/pdf", "application/epub+zip"] as const;
export const MimeTypeSchema = z.enum(ALLOWED_MIME_TYPES);
export type MimeType = z.infer<typeof MimeTypeSchema>;

export const BookStatusSchema = z.enum([
  "pending_upload",
  "uploaded",
  "processing",
  "indexed",
  "failed",
  "deleting",
]);
export type BookStatus = z.infer<typeof BookStatusSchema>;

export const GraphStatusSchema = z.enum(["pending", "generating", "ready", "failed"]);
export type GraphStatus = z.infer<typeof GraphStatusSchema>;

export const BloomLevelSchema = z.enum(["remember", "understand", "apply", "analyze", "evaluate", "create"]);
export type BloomLevel = z.infer<typeof BloomLevelSchema>;

const IsoDateTime = z.iso.datetime({ offset: true });

/** Row shape of `public.books` as returned by PostgREST. */
export const BookRowSchema = z.object({
  id: z.uuid(),
  user_id: z.uuid(),
  title: z.string().min(1).max(300),
  author: z.string().max(300).nullable(),
  file_name: z.string().min(1).max(255),
  mime_type: MimeTypeSchema,
  file_path: z.string().nullable(),
  is_file_purged: z.boolean(),
  keep_original: z.boolean(),
  file_size_bytes: z.coerce.number().int().positive().max(MAX_UPLOAD_BYTES),
  total_pages: z.number().int().nonnegative().nullable(),
  chunk_count: z.number().int().nonnegative(),
  status: BookStatusSchema,
  graph_status: GraphStatusSchema,
  ingest_error: z.string().nullable(),
  created_at: IsoDateTime,
  updated_at: IsoDateTime,
});
export type BookRow = z.infer<typeof BookRowSchema>;

/** Client-facing camelCase book DTO. */
export const BookSchema = z.object({
  id: z.uuid(),
  title: z.string(),
  author: z.string().nullable(),
  fileName: z.string(),
  mimeType: MimeTypeSchema,
  isFilePurged: z.boolean(),
  keepOriginal: z.boolean(),
  fileSizeBytes: z.number().int().nonnegative(),
  totalPages: z.number().int().nonnegative().nullable(),
  chunkCount: z.number().int().nonnegative(),
  status: BookStatusSchema,
  graphStatus: GraphStatusSchema,
  ingestError: z.string().nullable(),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type Book = z.infer<typeof BookSchema>;

export function toBookDto(row: BookRow): Book {
  return {
    id: row.id,
    title: row.title,
    author: row.author,
    fileName: row.file_name,
    mimeType: row.mime_type,
    isFilePurged: row.is_file_purged,
    keepOriginal: row.keep_original,
    fileSizeBytes: row.file_size_bytes,
    totalPages: row.total_pages,
    chunkCount: row.chunk_count,
    status: row.status,
    graphStatus: row.graph_status,
    ingestError: row.ingest_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export const ChunkSchema = z.object({
  id: z.uuid(),
  bookId: z.uuid(),
  chunkIndex: z.number().int().nonnegative(),
  chapterTitle: z.string().nullable(),
  content: z.string().min(1),
  wordCount: z.number().int().nonnegative(),
  pageStart: z.number().int().nullable(),
  pageEnd: z.number().int().nullable(),
  embedding: z.array(z.number()).length(EMBEDDING_DIMENSIONS).nullable(),
});
export type Chunk = z.infer<typeof ChunkSchema>;

/** Row returned by `public.hybrid_search_chunks`. */
export const RetrievedChunkSchema = z.object({
  id: z.uuid(),
  chunk_index: z.number().int(),
  chapter_title: z.string().nullable(),
  content: z.string(),
  page_start: z.number().int().nullable(),
  page_end: z.number().int().nullable(),
  score: z.number(),
});
export type RetrievedChunk = z.infer<typeof RetrievedChunkSchema>;

/** Row returned by `public.sample_book_chunks`. */
export const SampledChunkSchema = z.object({
  id: z.uuid(),
  chunk_index: z.number().int(),
  chapter_title: z.string().nullable(),
  content: z.string(),
  page_start: z.number().int().nullable(),
  page_end: z.number().int().nullable(),
  word_count: z.number().int(),
});
export type SampledChunk = z.infer<typeof SampledChunkSchema>;

/** Row returned by `public.get_chapter_outline`. */
export const ChapterOutlineRowSchema = z.object({
  chapter_title: z.string(),
  page_start: z.number().int().nullable(),
  page_end: z.number().int().nullable(),
  first_chunk_index: z.number().int(),
  chunk_count: z.number().int(),
});
export type ChapterOutlineRow = z.infer<typeof ChapterOutlineRowSchema>;

export const CitationSchema = z.object({
  chunkId: z.uuid(),
  pageStart: z.number().int().nullable(),
  pageEnd: z.number().int().nullable(),
  rawSnippet: z.string().max(600),
});
export type Citation = z.infer<typeof CitationSchema>;

export const ConceptNodeSchema = z.object({
  id: z.uuid(),
  bookId: z.uuid(),
  title: z.string().min(1).max(200),
  description: z.string().nullable(),
  bloomLevel: BloomLevelSchema.nullable(),
  sourceChunkIds: z.array(z.uuid()),
});
export type ConceptNode = z.infer<typeof ConceptNodeSchema>;

/** Edge semantics: `child` depends_on `parent` (parent is a prerequisite). */
export const ConceptEdgeSchema = z.object({
  parentConceptId: z.uuid(),
  childConceptId: z.uuid(),
  relationshipType: z.literal("prerequisite"),
});
export type ConceptEdge = z.infer<typeof ConceptEdgeSchema>;

interface DirectedEdge {
  readonly from: string;
  readonly to: string;
}

/** Kahn's algorithm. Returns node ids in topological order, or `null` if edges are invalid or cyclic. */
export function topologicalOrder(nodeIds: readonly string[], edges: readonly DirectedEdge[]): string[] | null {
  const inDegree = new Map<string, number>(nodeIds.map((id) => [id, 0]));
  const adjacency = new Map<string, string[]>(nodeIds.map((id) => [id, []]));
  for (const edge of edges) {
    const children = adjacency.get(edge.from);
    const childDegree = inDegree.get(edge.to);
    if (children === undefined || childDegree === undefined || edge.from === edge.to) return null;
    children.push(edge.to);
    inDegree.set(edge.to, childDegree + 1);
  }
  const queue = nodeIds.filter((id) => inDegree.get(id) === 0);
  const order: string[] = [];
  let head = 0;
  while (head < queue.length) {
    const current = queue[head++] as string;
    order.push(current);
    for (const child of adjacency.get(current) ?? []) {
      const next = (inDegree.get(child) ?? 0) - 1;
      inDegree.set(child, next);
      if (next === 0) queue.push(child);
    }
  }
  return order.length === nodeIds.length ? order : null;
}

export const ConceptGraphSchema = z
  .object({
    bookId: z.uuid(),
    nodes: z.array(ConceptNodeSchema),
    edges: z.array(ConceptEdgeSchema),
  })
  .superRefine((graph, ctx) => {
    const ids = graph.nodes.map((n) => n.id);
    if (new Set(ids).size !== ids.length) {
      ctx.addIssue({ code: "custom", message: "Duplicate concept ids", path: ["nodes"] });
      return;
    }
    const directed = graph.edges.map((e) => ({ from: e.parentConceptId, to: e.childConceptId }));
    if (topologicalOrder(ids, directed) === null) {
      ctx.addIssue({ code: "custom", message: "Edges reference unknown nodes, self-loop, or form a cycle", path: ["edges"] });
    }
  });
export type ConceptGraph = z.infer<typeof ConceptGraphSchema>;

/** Raw graph shape the LLM must emit (local string keys, resolved to UUIDs on persist). */
export const LlmConceptGraphSchema = z.object({
  concepts: z
    .array(
      z.object({
        key: z.string().min(1).max(64),
        title: z.string().min(1).max(200),
        description: z.string().min(1).max(1200),
        bloomLevel: BloomLevelSchema,
        sourceChunkIds: z.array(z.string()).max(12),
        flashcards: z
          .array(z.object({ front: z.string().min(1).max(600), back: z.string().min(1).max(1500) }))
          .min(1)
          .max(4),
      }),
    )
    .min(1)
    .max(60),
  dependencies: z
    .array(z.object({ conceptKey: z.string(), dependsOnKey: z.string() }))
    .max(240),
});
export type LlmConceptGraph = z.infer<typeof LlmConceptGraphSchema>;

export const FsrsStateSchema = z.enum(["new", "learning", "review", "relearning"]);
export type FsrsState = z.infer<typeof FsrsStateSchema>;

export const RatingSchema = z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]);
export type RatingValue = z.infer<typeof RatingSchema>;

export const FSRSCardSchema = z.object({
  id: z.uuid(),
  conceptId: z.uuid(),
  userId: z.uuid(),
  front: z.string().min(1),
  back: z.string().min(1),
  stability: z.number().positive().nullable(),
  difficulty: z.number().min(1).max(10).nullable(),
  elapsedDays: z.number().int().nonnegative(),
  scheduledDays: z.number().int().nonnegative(),
  reps: z.number().int().nonnegative(),
  lapses: z.number().int().nonnegative(),
  learningStep: z.number().int().nonnegative(),
  state: FsrsStateSchema,
  lastReview: IsoDateTime.nullable(),
  dueDate: IsoDateTime,
});
export type FSRSCard = z.infer<typeof FSRSCardSchema>;

const AxisScore = z.number().int().min(0).max(100);

export const FeynmanEvaluationSchema = z.object({
  accuracy: z.object({ score: AxisScore, rationale: z.string().min(1).max(1500) }),
  coverage: z.object({
    score: AxisScore,
    coveredPoints: z.array(z.string().max(300)).max(20),
    rationale: z.string().min(1).max(1500),
  }),
  missingNuances: z
    .array(z.object({ point: z.string().min(1).max(400), whyItMatters: z.string().min(1).max(600) }))
    .max(12),
  misconceptions: z
    .array(
      z.object({
        studentClaim: z.string().min(1).max(400),
        correction: z.string().min(1).max(800),
        severity: z.enum(["minor", "moderate", "critical"]),
      }),
    )
    .max(12),
  overallScore: AxisScore,
  suggestedFollowUpQuestion: z.string().min(1).max(500),
  citedChunkIds: z.array(z.string()).max(12),
});
export type FeynmanEvaluation = z.infer<typeof FeynmanEvaluationSchema>;

export const StorageQuotaSchema = z.object({
  retainedFileBytes: z.number().int().nonnegative(),
  pendingFileBytes: z.number().int().nonnegative(),
  estimatedDbBytes: z.number().int().nonnegative(),
  bookCount: z.number().int().nonnegative(),
  maxStorageBytes: z.number().int().positive(),
  maxDbBytes: z.number().int().positive(),
  maxUploadBytes: z.number().int().positive(),
  canUpload: z.boolean(),
  blockedReason: z.enum(["storage_quota", "db_quota"]).nullable(),
});
export type StorageQuota = z.infer<typeof StorageQuotaSchema>;

// ---------------------------------------------------------------------------
// API contracts
// ---------------------------------------------------------------------------

export const UploadUrlRequestSchema = z.object({
  title: z.string().trim().min(1).max(300),
  author: z.string().trim().max(300).optional(),
  fileName: z.string().trim().min(1).max(255),
  mimeType: MimeTypeSchema,
  fileSizeBytes: z.number().int().positive().max(MAX_UPLOAD_BYTES),
  keepOriginal: z.boolean().default(false),
});
export type UploadUrlRequest = z.infer<typeof UploadUrlRequestSchema>;

export const UploadUrlResponseSchema = z.object({
  bookId: z.uuid(),
  path: z.string(),
  token: z.string(),
  signedUrl: z.url(),
});
export type UploadUrlResponse = z.infer<typeof UploadUrlResponseSchema>;

export const UpdateBookRequestSchema = z.object({ keepOriginal: z.boolean() }).strict();
export type UpdateBookRequest = z.infer<typeof UpdateBookRequestSchema>;

export const PurgeReportSchema = z.object({
  bookId: z.uuid(),
  databaseRowsDeleted: z.boolean(),
  storageObjectDeleted: z.boolean(),
  storageObjectPath: z.string().nullable(),
  deferredToCleanup: z.boolean(),
});
export type PurgeReport = z.infer<typeof PurgeReportSchema>;

export const UpdateBookResponseSchema = z.object({ book: BookSchema });
export type UpdateBookResponse = z.infer<typeof UpdateBookResponseSchema>;

export const StorageOverviewSchema = z.object({
  quota: StorageQuotaSchema,
  books: z.array(BookSchema),
});
export type StorageOverview = z.infer<typeof StorageOverviewSchema>;

export const IngestionCallbackSchema = z.discriminatedUnion("status", [
  z.object({
    bookId: z.uuid(),
    status: z.literal("indexed"),
    chunkCount: z.number().int().nonnegative(),
    totalPages: z.number().int().nonnegative(),
    title: z.string().max(300).nullable(),
    author: z.string().max(300).nullable(),
  }),
  z.object({
    bookId: z.uuid(),
    status: z.literal("failed"),
    error: z.string().max(2000),
  }),
]);
export type IngestionCallback = z.infer<typeof IngestionCallbackSchema>;

export const ChatTurnSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string().min(1).max(8000),
});
export type ChatTurn = z.infer<typeof ChatTurnSchema>;

export const TutorRequestSchema = z.object({
  bookId: z.uuid(),
  conceptId: z.uuid().optional(),
  message: z.string().trim().min(1).max(4000),
  history: z.array(ChatTurnSchema).max(40).default([]),
});
export type TutorRequest = z.infer<typeof TutorRequestSchema>;

export const FeynmanRequestSchema = z.object({
  conceptId: z.uuid(),
  explanation: z.string().trim().min(20).max(8000),
});
export type FeynmanRequest = z.infer<typeof FeynmanRequestSchema>;

export const StudyConceptSchema = z.object({
  id: z.uuid(),
  title: z.string(),
  description: z.string().nullable(),
  bloomLevel: BloomLevelSchema.nullable(),
  /** Ids of concepts that should be learned first. */
  prerequisiteIds: z.array(z.uuid()),
  cardCount: z.number().int().nonnegative(),
});
export type StudyConcept = z.infer<typeof StudyConceptSchema>;

export const StudyCardSchema = z.object({
  id: z.uuid(),
  conceptId: z.uuid(),
  front: z.string(),
  back: z.string(),
  state: FsrsStateSchema,
  dueDate: z.string(),
});
export type StudyCard = z.infer<typeof StudyCardSchema>;

/** GET /api/books/:id/study — concepts in learning order plus the cards due now. */
export const StudyOverviewSchema = z.object({
  book: BookSchema,
  concepts: z.array(StudyConceptSchema),
  dueCards: z.array(StudyCardSchema),
  totalCards: z.number().int().nonnegative(),
  nextDueDate: z.string().nullable(),
});
export type StudyOverview = z.infer<typeof StudyOverviewSchema>;

export const ApiErrorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.unknown().optional(),
  }),
});
export type ApiError = z.infer<typeof ApiErrorSchema>;

// ---------------------------------------------------------------------------
// Defensive JSON parsing
// ---------------------------------------------------------------------------

export type ParseResult<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly error: string; readonly issues?: z.core.$ZodIssue[] };

/** Parses untrusted JSON text and validates it, never throwing. */
export function safeJsonParse<T>(raw: string, schema: z.ZodType<T>): ParseResult<T> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { ok: false, error: `Invalid JSON: ${err instanceof Error ? err.message : String(err)}` };
  }
  const result = schema.safeParse(parsed);
  if (!result.success) {
    return { ok: false, error: z.prettifyError(result.error), issues: result.error.issues };
  }
  return { ok: true, data: result.data };
}

/** Extracts the first balanced top-level JSON object from free text (e.g. fenced LLM output). */
export function extractJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/** Reads and validates a JSON request body with a byte cap; never throws. */
export async function parseRequestJson<T>(
  request: Request,
  schema: z.ZodType<T>,
  maxBytes = 64 * 1024,
): Promise<ParseResult<T>> {
  const lengthHeader = request.headers.get("content-length");
  if (lengthHeader !== null && Number(lengthHeader) > maxBytes) {
    return { ok: false, error: `Request body exceeds ${maxBytes} bytes` };
  }
  let text: string;
  try {
    text = await request.text();
  } catch (err) {
    return { ok: false, error: `Unreadable body: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (new TextEncoder().encode(text).byteLength > maxBytes) {
    return { ok: false, error: `Request body exceeds ${maxBytes} bytes` };
  }
  return safeJsonParse(text, schema);
}
