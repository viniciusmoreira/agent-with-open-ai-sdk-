import "server-only";
import { APIError } from "openai";

import { getOpenAIClient } from "@/lib/adapters/openai/client";
import { getEnv } from "@/lib/config/env";
import type { EmbeddingsPort } from "@/lib/domain/ports/embeddings-port";

const BATCH_SIZE = 100;
const RETRY_DELAYS_MS = [500, 1000, 2000] as const;

export type OpenAIEmbeddingsOptions = {
  model?: string;
  sleep?: (ms: number) => Promise<void>;
};

export function createOpenAIEmbeddings(
  options: OpenAIEmbeddingsOptions = {},
): EmbeddingsPort {
  const model = options.model ?? getEnv().EMBEDDING_MODEL;
  const sleep = options.sleep ?? defaultSleep;

  return {
    async embedTexts(texts: string[]): Promise<number[][]> {
      if (texts.length === 0) return [];
      const client = getOpenAIClient();
      const out: number[][] = [];
      for (let i = 0; i < texts.length; i += BATCH_SIZE) {
        const batch = texts.slice(i, i + BATCH_SIZE);
        const res = await withRetry(
          () => client.embeddings.create({ model, input: batch }),
          sleep,
        );
        const slot = new Array<number[]>(batch.length);
        for (const item of res.data) {
          if (
            typeof item.index !== "number" ||
            item.index < 0 ||
            item.index >= batch.length
          ) {
            throw new Error(`embedding index out of range: ${item.index}`);
          }
          slot[item.index] = item.embedding;
        }
        for (let j = 0; j < batch.length; j++) {
          const v = slot[j];
          if (!v) throw new Error(`missing embedding for batch index ${j}`);
          out.push(v);
        }
      }
      return out;
    },
  };
}

async function withRetry<T>(
  call: () => Promise<T>,
  sleep: (ms: number) => Promise<void>,
): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    try {
      return await call();
    } catch (err) {
      lastErr = err;
      if (!isRetryable(err) || attempt === RETRY_DELAYS_MS.length) throw err;
      await sleep(RETRY_DELAYS_MS[attempt]!);
    }
  }
  throw lastErr;
}

function isRetryable(err: unknown): boolean {
  if (!(err instanceof APIError)) return false;
  const status = err.status;
  if (typeof status !== "number") return false;
  return status === 429 || (status >= 500 && status < 600);
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
