import "server-only";
import OpenAI from "openai";

import { getEnv } from "@/lib/config/env";

let cached: OpenAI | undefined;

export function getOpenAIClient(): OpenAI {
  if (!cached) {
    const { OPENAI_API_KEY } = getEnv();
    cached = new OpenAI({ apiKey: OPENAI_API_KEY });
  }
  return cached;
}

export function __resetOpenAIClientForTests(): void {
  cached = undefined;
}
