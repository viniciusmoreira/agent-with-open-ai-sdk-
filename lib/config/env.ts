import "server-only";
import { z } from "zod";

const envSchema = z.object({
  OPENAI_API_KEY: z.string().min(1, "OPENAI_API_KEY is required"),
  EMBEDDING_MODEL: z.string().min(1).default("text-embedding-3-small"),
  REASONING_MODEL: z.string().min(1).default("gpt-4o"),
  VISION_OCR_MODEL: z.string().min(1).default("gpt-4o-mini"),
  MAX_UPLOAD_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(50 * 1024 * 1024),
  UPLOAD_INGEST_CONCURRENCY: z.coerce
    .number()
    .int()
    .positive()
    .default(2),
});

export type Env = z.infer<typeof envSchema>;

export function loadEnv(
  source: Record<string, string | undefined> = process.env,
): Env {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    throw new Error(`Invalid environment configuration: ${issues}`);
  }
  return parsed.data;
}

let cached: Env | undefined;

export function getEnv(): Env {
  if (!cached) cached = loadEnv();
  return cached;
}
