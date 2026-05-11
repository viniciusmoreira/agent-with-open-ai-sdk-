import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const streamTextMock: ReturnType<typeof vi.fn<(args: Record<string, unknown>) => unknown>> =
  vi.fn(() => ({ __sentinel: "stream-text-result" }));
const convertToModelMessagesMock = vi.fn(async (msgs: unknown[]) => msgs);
const stepCountIsMock = vi.fn((n: number) => ({ __stepCount: n }));
const openaiMock = vi.fn((id: string) => ({ __modelId: id }));

vi.mock("ai", () => ({
  streamText: streamTextMock,
  convertToModelMessages: convertToModelMessagesMock,
  stepCountIs: stepCountIsMock,
}));

vi.mock("@ai-sdk/openai", () => ({
  openai: openaiMock,
}));

vi.mock("@/lib/adapters/embeddings/openai", () => ({
  createOpenAIEmbeddings: () => ({
    async embedTexts(texts: string[]) {
      return texts.map(() => [0]);
    },
  }),
}));

const ORIGINAL_ENV = { ...process.env };

async function importRunModule() {
  vi.resetModules();
  return import("./run");
}

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV, OPENAI_API_KEY: "sk-test-run" };
  delete process.env.REASONING_MODEL;
  streamTextMock.mockClear();
  convertToModelMessagesMock.mockClear();
  stepCountIsMock.mockClear();
  openaiMock.mockClear();
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("runAgent — streamText wiring", () => {
  it("calls streamText with exactly the three registered tools", async () => {
    const { runAgent } = await importRunModule();
    await runAgent({ messages: [{ role: "user", content: "hi" }] });
    expect(streamTextMock).toHaveBeenCalledTimes(1);
    const arg = streamTextMock.mock.calls[0]?.[0] as { tools: Record<string, unknown> };
    expect(Object.keys(arg.tools).sort()).toEqual([
      "find_outliers",
      "query_bids",
      "search_documents",
    ]);
  });

  it("passes a non-empty system prompt that names each tool with a worked example", async () => {
    const { runAgent, SYSTEM_PROMPT } = await importRunModule();
    await runAgent({ messages: [] });
    const arg = streamTextMock.mock.calls[0]?.[0] as { system: string };
    expect(arg.system).toBe(SYSTEM_PROMPT);
    for (const name of ["query_bids", "find_outliers", "search_documents"]) {
      expect(SYSTEM_PROMPT).toContain(name);
    }
    expect(
      (SYSTEM_PROMPT.match(/worked example/gi) ?? []).length,
    ).toBeGreaterThanOrEqual(3);
  });

  it("instructs the agent to acknowledge uncertainty rather than confabulate", async () => {
    const { SYSTEM_PROMPT } = await importRunModule();
    expect(SYSTEM_PROMPT.toLowerCase()).toMatch(/do not invent/);
    expect(SYSTEM_PROMPT.toLowerCase()).toMatch(/(clarif|ambiguous)/);
  });

  it("defaults the reasoning model to gpt-4o when REASONING_MODEL is unset", async () => {
    const { runAgent } = await importRunModule();
    await runAgent({ messages: [] });
    expect(openaiMock).toHaveBeenCalledWith("gpt-4o");
    const arg = streamTextMock.mock.calls[0]?.[0] as {
      model: { __modelId: string };
    };
    expect(arg.model.__modelId).toBe("gpt-4o");
  });

  it("reads REASONING_MODEL from env when set", async () => {
    process.env.REASONING_MODEL = "gpt-4.1";
    const { runAgent } = await importRunModule();
    await runAgent({ messages: [] });
    expect(openaiMock).toHaveBeenCalledWith("gpt-4.1");
  });

  it("converts UI messages via convertToModelMessages before invoking streamText", async () => {
    const { runAgent } = await importRunModule();
    const messages = [{ role: "user", content: "hi" }];
    await runAgent({ messages });
    expect(convertToModelMessagesMock).toHaveBeenCalledWith(messages);
    const arg = streamTextMock.mock.calls[0]?.[0] as { messages: unknown };
    expect(arg.messages).toEqual(messages);
  });

  it("enables tool chaining via a multi-step stopWhen", async () => {
    const { runAgent } = await importRunModule();
    await runAgent({ messages: [] });
    expect(stepCountIsMock).toHaveBeenCalledTimes(1);
    const stepArg = stepCountIsMock.mock.calls[0]![0];
    expect(stepArg).toBeGreaterThan(1);
    const arg = streamTextMock.mock.calls[0]?.[0] as { stopWhen: unknown };
    expect(arg.stopWhen).toBeDefined();
  });
});

describe("single-import enforcement", () => {
  it("is the only file that imports from 'ai' or '@ai-sdk/openai'", async () => {
    const repoRoot = path.resolve(__dirname, "..", "..", "..");
    const offenders: string[] = [];
    await walk(repoRoot);
    expect(offenders).toEqual([]);

    async function walk(dir: string): Promise<void> {
      const entries = await readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(full);
          continue;
        }
        if (!/\.(ts|tsx)$/.test(entry.name)) continue;
        if (entry.name.endsWith(".test.ts") || entry.name.endsWith(".test.tsx")) continue;
        if (
          full ===
          path.resolve(repoRoot, "lib", "app", "agent", "run.ts")
        ) {
          continue;
        }
        const source = await readFile(full, "utf8");
        if (/import[\s\S]*?from\s*['"](?:ai|@ai-sdk\/openai)['"]/.test(source)) {
          offenders.push(path.relative(repoRoot, full));
        }
      }
    }
  });
});
