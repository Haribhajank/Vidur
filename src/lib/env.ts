import "server-only";
import { z } from "zod";
import { MAX_UPLOAD_BYTES } from "@/types/schema";

const MB = 1024 * 1024;

const ServerEnvSchema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z.url(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(20),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(20),
  SUPABASE_STORAGE_BUCKET: z.string().min(1).default("books"),
  ANTHROPIC_API_KEY: z.string().min(10),
  ANTHROPIC_MODEL: z.string().min(1).default("claude-sonnet-5-5"),
  ML_SERVICE_URL: z.url(),
  ML_SHARED_SECRET: z.string().min(32),
  ML_SERVICE_TOKEN: z.preprocess((v) => (v === "" ? undefined : v), z.string().min(8).optional()),
  APP_BASE_URL: z.url(),
  CRON_SECRET: z.string().min(16),
  MAX_USER_STORAGE_MB: z.coerce.number().int().positive().default(200),
  MAX_USER_DB_MB: z.coerce.number().int().positive().default(50),
  ORPHAN_MAX_AGE_HOURS: z.coerce.number().int().positive().default(24),
});

export interface ServerEnv {
  readonly supabaseUrl: string;
  readonly supabaseAnonKey: string;
  readonly supabaseServiceRoleKey: string;
  readonly storageBucket: string;
  readonly anthropicApiKey: string;
  readonly anthropicModel: string;
  readonly mlServiceUrl: string;
  readonly mlSharedSecret: string;
  /** Hugging Face token for a private Space / per-account ZeroGPU quota; null when unset. */
  readonly mlServiceToken: string | null;
  readonly appBaseUrl: string;
  readonly cronSecret: string;
  readonly maxUploadBytes: number;
  readonly maxUserStorageBytes: number;
  readonly maxUserDbBytes: number;
  readonly orphanMaxAgeHours: number;
}

let cached: ServerEnv | null = null;

/** Validates server env lazily so `next build` does not require secrets at compile time. */
export function getServerEnv(): ServerEnv {
  if (cached !== null) return cached;
  const parsed = ServerEnvSchema.safeParse(process.env);
  if (!parsed.success) {
    throw new Error(`Invalid server environment:\n${z.prettifyError(parsed.error)}`);
  }
  const e = parsed.data;
  cached = Object.freeze({
    supabaseUrl: e.NEXT_PUBLIC_SUPABASE_URL,
    supabaseAnonKey: e.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    supabaseServiceRoleKey: e.SUPABASE_SERVICE_ROLE_KEY,
    storageBucket: e.SUPABASE_STORAGE_BUCKET,
    anthropicApiKey: e.ANTHROPIC_API_KEY,
    anthropicModel: e.ANTHROPIC_MODEL,
    mlServiceUrl: e.ML_SERVICE_URL.replace(/\/+$/, ""),
    mlSharedSecret: e.ML_SHARED_SECRET,
    mlServiceToken: e.ML_SERVICE_TOKEN ?? null,
    appBaseUrl: e.APP_BASE_URL.replace(/\/+$/, ""),
    cronSecret: e.CRON_SECRET,
    maxUploadBytes: MAX_UPLOAD_BYTES,
    maxUserStorageBytes: e.MAX_USER_STORAGE_MB * MB,
    maxUserDbBytes: e.MAX_USER_DB_MB * MB,
    orphanMaxAgeHours: e.ORPHAN_MAX_AGE_HOURS,
  });
  return cached;
}
