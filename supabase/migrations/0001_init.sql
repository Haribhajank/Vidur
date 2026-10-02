-- BookMentor AI: initial schema
-- Requires: Supabase Postgres (auth + storage schemas present), pgvector >= 0.5 (HNSW).

CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE public.books (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  title            TEXT NOT NULL CHECK (char_length(title) BETWEEN 1 AND 300),
  author           TEXT CHECK (author IS NULL OR char_length(author) <= 300),
  file_name        TEXT NOT NULL CHECK (char_length(file_name) BETWEEN 1 AND 255),
  mime_type        TEXT NOT NULL CHECK (mime_type IN ('application/pdf', 'application/epub+zip')),
  file_path        TEXT UNIQUE,
  is_file_purged   BOOLEAN NOT NULL DEFAULT FALSE,
  keep_original    BOOLEAN NOT NULL DEFAULT FALSE,
  file_size_bytes  BIGINT NOT NULL CHECK (file_size_bytes > 0 AND file_size_bytes <= 26214400),
  total_pages      INT CHECK (total_pages IS NULL OR total_pages >= 0),
  chunk_count      INT NOT NULL DEFAULT 0 CHECK (chunk_count >= 0),
  status           TEXT NOT NULL DEFAULT 'pending_upload'
                   CHECK (status IN ('pending_upload', 'uploaded', 'processing', 'indexed', 'failed', 'deleting')),
  graph_status     TEXT NOT NULL DEFAULT 'pending'
                   CHECK (graph_status IN ('pending', 'generating', 'ready', 'failed')),
  ingest_error     TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT books_purged_has_no_path CHECK (NOT is_file_purged OR file_path IS NULL)
);

CREATE INDEX books_user_id_created_idx ON public.books (user_id, created_at DESC);
CREATE INDEX books_status_updated_idx ON public.books (status, updated_at);

CREATE TABLE public.book_chunks (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  book_id        UUID NOT NULL REFERENCES public.books(id) ON DELETE CASCADE,
  chunk_index    INT NOT NULL CHECK (chunk_index >= 0),
  chapter_title  TEXT,
  content        TEXT NOT NULL,
  word_count     INT NOT NULL CHECK (word_count >= 0),
  page_start     INT,
  page_end       INT,
  embedding      vector(384),
  fts            tsvector GENERATED ALWAYS AS (
                   setweight(to_tsvector('english', coalesce(chapter_title, '')), 'A') ||
                   setweight(to_tsvector('english', content), 'B')
                 ) STORED,
  CONSTRAINT book_chunks_page_order CHECK (page_start IS NULL OR page_end IS NULL OR page_end >= page_start),
  CONSTRAINT book_chunks_unique_index UNIQUE (book_id, chunk_index)
);

CREATE INDEX book_chunks_fts_idx ON public.book_chunks USING GIN (fts);
CREATE INDEX book_chunks_embedding_hnsw_idx ON public.book_chunks
  USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64);

CREATE TABLE public.concepts (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  book_id           UUID NOT NULL REFERENCES public.books(id) ON DELETE CASCADE,
  title             TEXT NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
  description       TEXT,
  bloom_level       TEXT CHECK (bloom_level IS NULL OR bloom_level IN
                      ('remember', 'understand', 'apply', 'analyze', 'evaluate', 'create')),
  source_chunk_ids  UUID[] NOT NULL DEFAULT '{}',
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX concepts_book_id_idx ON public.concepts (book_id, created_at, id);

-- parent -> child means "child depends_on parent" (parent is a prerequisite).
CREATE TABLE public.concept_relationships (
  parent_concept_id  UUID NOT NULL REFERENCES public.concepts(id) ON DELETE CASCADE,
  child_concept_id   UUID NOT NULL REFERENCES public.concepts(id) ON DELETE CASCADE,
  relationship_type  TEXT NOT NULL DEFAULT 'prerequisite' CHECK (relationship_type IN ('prerequisite')),
  PRIMARY KEY (parent_concept_id, child_concept_id),
  CONSTRAINT concept_relationships_no_self_loop CHECK (parent_concept_id <> child_concept_id)
);

CREATE INDEX concept_relationships_child_idx ON public.concept_relationships (child_concept_id);

CREATE TABLE public.fsrs_cards (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  concept_id       UUID NOT NULL REFERENCES public.concepts(id) ON DELETE CASCADE,
  user_id          UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  front            TEXT NOT NULL,
  back             TEXT NOT NULL,
  stability        DOUBLE PRECISION CHECK (stability IS NULL OR stability > 0),
  difficulty       DOUBLE PRECISION CHECK (difficulty IS NULL OR difficulty BETWEEN 1 AND 10),
  elapsed_days     INT NOT NULL DEFAULT 0 CHECK (elapsed_days >= 0),
  scheduled_days   INT NOT NULL DEFAULT 0 CHECK (scheduled_days >= 0),
  reps             INT NOT NULL DEFAULT 0 CHECK (reps >= 0),
  lapses           INT NOT NULL DEFAULT 0 CHECK (lapses >= 0),
  learning_step    INT NOT NULL DEFAULT 0 CHECK (learning_step >= 0),
  last_review      TIMESTAMPTZ,
  due_date         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  state            TEXT NOT NULL DEFAULT 'new' CHECK (state IN ('new', 'learning', 'review', 'relearning')),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX fsrs_cards_user_due_idx ON public.fsrs_cards (user_id, due_date);
CREATE INDEX fsrs_cards_concept_idx ON public.fsrs_cards (concept_id);

CREATE TABLE public.review_logs (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  card_id           UUID NOT NULL REFERENCES public.fsrs_cards(id) ON DELETE CASCADE,
  user_id           UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  rating            SMALLINT NOT NULL CHECK (rating BETWEEN 1 AND 4),
  state_before      TEXT NOT NULL CHECK (state_before IN ('new', 'learning', 'review', 'relearning')),
  stability_after   DOUBLE PRECISION NOT NULL,
  difficulty_after  DOUBLE PRECISION NOT NULL,
  elapsed_days      INT NOT NULL,
  scheduled_days    INT NOT NULL,
  reviewed_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX review_logs_card_idx ON public.review_logs (card_id, reviewed_at DESC);

CREATE TABLE public.assessment_logs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  book_id         UUID NOT NULL REFERENCES public.books(id) ON DELETE CASCADE,
  concept_id      UUID NOT NULL REFERENCES public.concepts(id) ON DELETE CASCADE,
  user_id         UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  explanation     TEXT NOT NULL,
  evaluation      JSONB NOT NULL,
  overall_score   SMALLINT NOT NULL CHECK (overall_score BETWEEN 0 AND 100),
  model           TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX assessment_logs_user_concept_idx ON public.assessment_logs (user_id, concept_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- Triggers
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.touch_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$;

CREATE TRIGGER books_touch_updated_at
  BEFORE UPDATE ON public.books
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- Rejects edges that would introduce a cycle or cross book boundaries, keeping each graph a DAG.
CREATE OR REPLACE FUNCTION public.prevent_concept_cycle()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_parent_book UUID;
  v_child_book  UUID;
BEGIN
  SELECT book_id INTO v_parent_book FROM public.concepts WHERE id = NEW.parent_concept_id;
  SELECT book_id INTO v_child_book  FROM public.concepts WHERE id = NEW.child_concept_id;
  IF v_parent_book IS DISTINCT FROM v_child_book THEN
    RAISE EXCEPTION 'CROSS_BOOK_EDGE' USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    WITH RECURSIVE descendants(id) AS (
      SELECT r.child_concept_id FROM public.concept_relationships r
       WHERE r.parent_concept_id = NEW.child_concept_id
      UNION
      SELECT r.child_concept_id FROM public.concept_relationships r
        JOIN descendants d ON r.parent_concept_id = d.id
    )
    SELECT 1 FROM descendants WHERE id = NEW.parent_concept_id
  ) THEN
    RAISE EXCEPTION 'CYCLE_DETECTED' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER concept_relationships_acyclic
  BEFORE INSERT OR UPDATE ON public.concept_relationships
  FOR EACH ROW EXECUTE FUNCTION public.prevent_concept_cycle();

-- ---------------------------------------------------------------------------
-- Row Level Security
-- Authenticated users get read access to their own data plus write access to their own
-- review/assessment history. Book lifecycle mutations (status, purge flags, deletion) are
-- performed server-side with the service role after explicit ownership checks so that
-- clients can never tamper with quota-relevant columns such as file_size_bytes.
-- ---------------------------------------------------------------------------

ALTER TABLE public.books                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.book_chunks           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.concepts              ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.concept_relationships ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fsrs_cards            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.review_logs           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.assessment_logs       ENABLE ROW LEVEL SECURITY;

CREATE POLICY books_owner_select ON public.books
  FOR SELECT TO authenticated
  USING (user_id = (SELECT auth.uid()));

CREATE POLICY book_chunks_owner_select ON public.book_chunks
  FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.books b WHERE b.id = book_id AND b.user_id = (SELECT auth.uid())));

CREATE POLICY concepts_owner_select ON public.concepts
  FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.books b WHERE b.id = book_id AND b.user_id = (SELECT auth.uid())));

CREATE POLICY concept_relationships_owner_select ON public.concept_relationships
  FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.concepts c JOIN public.books b ON b.id = c.book_id
     WHERE c.id = parent_concept_id AND b.user_id = (SELECT auth.uid())
  ));

CREATE POLICY fsrs_cards_owner_select ON public.fsrs_cards
  FOR SELECT TO authenticated
  USING (user_id = (SELECT auth.uid()));

CREATE POLICY fsrs_cards_owner_update ON public.fsrs_cards
  FOR UPDATE TO authenticated
  USING (user_id = (SELECT auth.uid()))
  WITH CHECK (user_id = (SELECT auth.uid()));

CREATE POLICY review_logs_owner_select ON public.review_logs
  FOR SELECT TO authenticated
  USING (user_id = (SELECT auth.uid()));

CREATE POLICY review_logs_owner_insert ON public.review_logs
  FOR INSERT TO authenticated
  WITH CHECK (user_id = (SELECT auth.uid()));

CREATE POLICY assessment_logs_owner_select ON public.assessment_logs
  FOR SELECT TO authenticated
  USING (user_id = (SELECT auth.uid()));

CREATE POLICY assessment_logs_owner_insert ON public.assessment_logs
  FOR INSERT TO authenticated
  WITH CHECK (user_id = (SELECT auth.uid()));

-- ---------------------------------------------------------------------------
-- Storage bucket: private, 25 MB hard cap, PDF/EPUB only.
-- No storage.objects policies are granted to end users: uploads happen exclusively via
-- server-minted signed upload URLs, and reads/deletes happen with the service role.
-- ---------------------------------------------------------------------------

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('books', 'books', FALSE, 26214400, ARRAY['application/pdf', 'application/epub+zip'])
ON CONFLICT (id) DO UPDATE
  SET public = EXCLUDED.public,
      file_size_limit = EXCLUDED.file_size_limit,
      allowed_mime_types = EXCLUDED.allowed_mime_types;

-- ---------------------------------------------------------------------------
-- RPC (service role): storage usage accounting
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.get_storage_usage(p_user_id UUID)
RETURNS TABLE (
  retained_file_bytes BIGINT,
  pending_file_bytes  BIGINT,
  estimated_db_bytes  BIGINT,
  book_count          INT
)
LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT
    COALESCE((SELECT SUM(b.file_size_bytes) FROM books b
               WHERE b.user_id = p_user_id AND NOT b.is_file_purged AND b.file_path IS NOT NULL
                 AND b.status <> 'pending_upload'), 0)::BIGINT,
    COALESCE((SELECT SUM(b.file_size_bytes) FROM books b
               WHERE b.user_id = p_user_id AND b.status = 'pending_upload'), 0)::BIGINT,
    (COALESCE((SELECT SUM(pg_column_size(c.content) + COALESCE(pg_column_size(c.embedding), 0)
                          + pg_column_size(c.fts) + 64)
                 FROM book_chunks c JOIN books b ON b.id = c.book_id
                WHERE b.user_id = p_user_id), 0)
     + COALESCE((SELECT SUM(pg_column_size(k.title) + COALESCE(pg_column_size(k.description), 0) + 64)
                   FROM concepts k JOIN books b ON b.id = k.book_id
                  WHERE b.user_id = p_user_id), 0)
     + COALESCE((SELECT SUM(pg_column_size(f.front) + pg_column_size(f.back) + 96)
                   FROM fsrs_cards f WHERE f.user_id = p_user_id), 0))::BIGINT,
    (SELECT COUNT(*) FROM books b WHERE b.user_id = p_user_id)::INT;
$$;

-- ---------------------------------------------------------------------------
-- RPC (service role): quota-guarded upload reservation. A per-user advisory lock
-- serializes concurrent reservations so parallel uploads cannot jointly exceed quota.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.reserve_book_upload(
  p_user_id           UUID,
  p_book_id           UUID,
  p_title             TEXT,
  p_author            TEXT,
  p_file_name         TEXT,
  p_mime_type         TEXT,
  p_file_path         TEXT,
  p_file_size_bytes   BIGINT,
  p_keep_original     BOOLEAN,
  p_max_file_bytes    BIGINT,
  p_max_storage_bytes BIGINT,
  p_max_db_bytes      BIGINT
)
RETURNS SETOF public.books
LANGUAGE plpgsql VOLATILE SET search_path = public AS $$
DECLARE
  v_usage RECORD;
BEGIN
  IF p_file_size_bytes <= 0 OR p_file_size_bytes > p_max_file_bytes THEN
    RAISE EXCEPTION 'FILE_TOO_LARGE' USING ERRCODE = '22023';
  END IF;
  IF split_part(p_file_path, '/', 1) <> p_user_id::text THEN
    RAISE EXCEPTION 'INVALID_PATH' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(p_user_id::text, 0));

  SELECT * INTO v_usage FROM public.get_storage_usage(p_user_id);

  IF v_usage.estimated_db_bytes >= p_max_db_bytes THEN
    RAISE EXCEPTION 'DB_QUOTA_EXCEEDED' USING ERRCODE = '53400';
  END IF;
  IF v_usage.retained_file_bytes + v_usage.pending_file_bytes + p_file_size_bytes > p_max_storage_bytes THEN
    RAISE EXCEPTION 'STORAGE_QUOTA_EXCEEDED' USING ERRCODE = '53400';
  END IF;

  RETURN QUERY
  INSERT INTO public.books (id, user_id, title, author, file_name, mime_type, file_path,
                            file_size_bytes, keep_original, status)
  VALUES (p_book_id, p_user_id, p_title, p_author, p_file_name, p_mime_type, p_file_path,
          p_file_size_bytes, p_keep_original, 'pending_upload')
  RETURNING *;
END;
$$;

-- ---------------------------------------------------------------------------
-- RPC (service role): hybrid retrieval — Postgres FTS (ts_rank_cd) + pgvector cosine,
-- fused with Reciprocal Rank Fusion. A NULL embedding degrades to keyword-only search.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.hybrid_search_chunks(
  p_book_id          UUID,
  p_query_text       TEXT,
  p_query_embedding  vector(384) DEFAULT NULL,
  p_match_count      INT DEFAULT 8,
  p_full_text_weight DOUBLE PRECISION DEFAULT 1.0,
  p_semantic_weight  DOUBLE PRECISION DEFAULT 1.0,
  p_rrf_k            INT DEFAULT 50
)
RETURNS TABLE (
  id            UUID,
  chunk_index   INT,
  chapter_title TEXT,
  content       TEXT,
  page_start    INT,
  page_end      INT,
  score         DOUBLE PRECISION
)
LANGUAGE sql STABLE SET search_path = public AS $$
  WITH params AS (
    SELECT LEAST(GREATEST(p_match_count, 1), 30) AS k,
           websearch_to_tsquery('english', COALESCE(p_query_text, '')) AS q
  ),
  full_text AS (
    SELECT c.id,
           ROW_NUMBER() OVER (ORDER BY ts_rank_cd(c.fts, p.q) DESC) AS rank_ix
      FROM book_chunks c, params p
     WHERE c.book_id = p_book_id AND c.fts @@ p.q
     ORDER BY rank_ix
     LIMIT (SELECT k * 2 FROM params)
  ),
  semantic AS (
    SELECT c.id,
           ROW_NUMBER() OVER (ORDER BY c.embedding <=> p_query_embedding) AS rank_ix
      FROM book_chunks c
     WHERE p_query_embedding IS NOT NULL AND c.book_id = p_book_id AND c.embedding IS NOT NULL
     ORDER BY rank_ix
     LIMIT (SELECT k * 2 FROM params)
  )
  SELECT c.id, c.chunk_index, c.chapter_title, c.content, c.page_start, c.page_end,
         (COALESCE(1.0 / (p_rrf_k + ft.rank_ix), 0.0) * p_full_text_weight
          + COALESCE(1.0 / (p_rrf_k + s.rank_ix), 0.0) * p_semantic_weight)::DOUBLE PRECISION AS score
    FROM full_text ft
    FULL OUTER JOIN semantic s ON ft.id = s.id
    JOIN book_chunks c ON c.id = COALESCE(ft.id, s.id)
   ORDER BY score DESC
   LIMIT (SELECT k FROM params);
$$;

-- ---------------------------------------------------------------------------
-- RPC (service role): storage objects eligible for purge. Read-only: deletion goes through
-- the Storage API so the underlying blob is removed (deleting storage.objects rows directly
-- would orphan the S3 object).
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.list_purge_candidates(
  p_bucket     TEXT,
  p_older_than INTERVAL,
  p_limit      INT DEFAULT 500
)
RETURNS TABLE (object_name TEXT, book_id UUID, size_bytes BIGINT, reason TEXT)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT o.name,
         b.id,
         COALESCE((o.metadata ->> 'size')::BIGINT, 0),
         CASE
           WHEN b.id IS NULL THEN 'no_book_row'
           WHEN b.is_file_purged THEN 'purged_flag_set'
           WHEN b.status = 'deleting' THEN 'stuck_deleting'
           WHEN b.status = 'pending_upload' THEN 'abandoned_upload'
           WHEN b.status = 'failed' THEN 'failed_ingestion'
           ELSE 'indexed_not_purged'
         END
    FROM storage.objects o
    LEFT JOIN public.books b ON b.file_path = o.name
   WHERE o.bucket_id = p_bucket
     AND o.created_at < NOW() - p_older_than
     AND (
       b.id IS NULL
       OR b.is_file_purged
       OR b.status IN ('pending_upload', 'failed', 'deleting')
       OR (b.status = 'indexed' AND NOT b.keep_original)
     )
   ORDER BY o.created_at
   LIMIT LEAST(GREATEST(p_limit, 1), 1000);
$$;

-- Books stuck in a transient state: reservations that never received an upload, deletions
-- that crashed mid-way, and ingestions that never reported back (e.g. the ML Space restarted).
CREATE OR REPLACE FUNCTION public.list_stale_books(p_older_than INTERVAL, p_limit INT DEFAULT 500)
RETURNS TABLE (book_id UUID, file_path TEXT, status TEXT)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT b.id, b.file_path, b.status
    FROM public.books b
   WHERE b.status IN ('pending_upload', 'deleting', 'uploaded', 'processing')
     AND b.updated_at < NOW() - p_older_than
   ORDER BY b.updated_at
   LIMIT LEAST(GREATEST(p_limit, 1), 1000);
$$;

-- Chapter outline aggregated server-side (avoids PostgREST's max-rows cap on large books).
CREATE OR REPLACE FUNCTION public.get_chapter_outline(p_book_id UUID)
RETURNS TABLE (chapter_title TEXT, page_start INT, page_end INT, first_chunk_index INT, chunk_count INT)
LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT COALESCE(c.chapter_title, 'Untitled section'),
         MIN(c.page_start), MAX(c.page_end), MIN(c.chunk_index), COUNT(*)::INT
    FROM book_chunks c
   WHERE c.book_id = p_book_id
   GROUP BY COALESCE(c.chapter_title, 'Untitled section')
   ORDER BY MIN(c.chunk_index)
   LIMIT 400;
$$;

-- Evenly spaced chunk sample plus the opening chunk of every chapter, used to give the LLM a
-- representative, bounded view of the whole book for concept-graph construction.
CREATE OR REPLACE FUNCTION public.sample_book_chunks(p_book_id UUID, p_max_chunks INT)
RETURNS TABLE (id UUID, chunk_index INT, chapter_title TEXT, content TEXT, page_start INT, page_end INT, word_count INT)
LANGUAGE sql STABLE SET search_path = public AS $$
  WITH total AS (
    SELECT COUNT(*)::INT AS n FROM book_chunks WHERE book_id = p_book_id
  ),
  stride AS (
    SELECT GREATEST(1, CEIL(n::NUMERIC / GREATEST(p_max_chunks, 1)))::INT AS s FROM total
  ),
  chapter_openers AS (
    SELECT DISTINCT ON (COALESCE(chapter_title, '')) id
      FROM book_chunks
     WHERE book_id = p_book_id
     ORDER BY COALESCE(chapter_title, ''), chunk_index
  )
  SELECT c.id, c.chunk_index, c.chapter_title, c.content, c.page_start, c.page_end, c.word_count
    FROM book_chunks c, stride st
   WHERE c.book_id = p_book_id
     AND (c.chunk_index % st.s = 0 OR c.id IN (SELECT co.id FROM chapter_openers co))
   ORDER BY c.chunk_index
   LIMIT GREATEST(p_max_chunks, 1) * 2;
$$;

REVOKE ALL ON FUNCTION public.get_storage_usage(UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.reserve_book_upload(UUID, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, BIGINT, BOOLEAN, BIGINT, BIGINT, BIGINT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.hybrid_search_chunks(UUID, TEXT, vector, INT, DOUBLE PRECISION, DOUBLE PRECISION, INT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.list_purge_candidates(TEXT, INTERVAL, INT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.list_stale_books(INTERVAL, INT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.get_chapter_outline(UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.sample_book_chunks(UUID, INT) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.get_storage_usage(UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.reserve_book_upload(UUID, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, BIGINT, BOOLEAN, BIGINT, BIGINT, BIGINT) TO service_role;
GRANT EXECUTE ON FUNCTION public.hybrid_search_chunks(UUID, TEXT, vector, INT, DOUBLE PRECISION, DOUBLE PRECISION, INT) TO service_role;
GRANT EXECUTE ON FUNCTION public.list_purge_candidates(TEXT, INTERVAL, INT) TO service_role;
GRANT EXECUTE ON FUNCTION public.list_stale_books(INTERVAL, INT) TO service_role;
GRANT EXECUTE ON FUNCTION public.get_chapter_outline(UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.sample_book_chunks(UUID, INT) TO service_role;
