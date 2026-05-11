import { describe, expect, it } from "vitest";

import {
  SmokeAssertionError,
  SPEC_QUESTIONS,
  assertHasCitations,
  assertHasOutlier,
  extractSourceRefs,
} from "../scripts/smoke-helpers";

describe("smoke-helpers — extractSourceRefs", () => {
  it("collects csv-row ids from query_bids rows", () => {
    const refs = extractSourceRefs([
      {
        toolName: "query_bids",
        output: { rows: [{ rowId: 1 }, { rowId: 2 }] },
      },
    ]);
    expect(refs).toEqual([
      { type: "csv-row", rowId: 1 },
      { type: "csv-row", rowId: 2 },
    ]);
  });

  it("collects flagged row ids from find_outliers", () => {
    const refs = extractSourceRefs([
      { toolName: "find_outliers", output: { flagged: [{ rowId: 42 }] } },
    ]);
    expect(refs).toEqual([{ type: "csv-row", rowId: 42 }]);
  });

  it("collects pdf-page refs from search_documents chunks", () => {
    const refs = extractSourceRefs([
      {
        toolName: "search_documents",
        output: {
          chunks: [
            {
              sourceRef: { type: "pdf-page", file: "plans.pdf", page: 47 },
            },
          ],
        },
      },
    ]);
    expect(refs).toEqual([
      { type: "pdf-page", file: "plans.pdf", page: 47 },
    ]);
  });

  it("returns no refs when the output shape is unrecognized", () => {
    expect(extractSourceRefs([{ toolName: "noop", output: null }])).toEqual([]);
    expect(extractSourceRefs([{ toolName: "noop", output: 7 }])).toEqual([]);
    expect(
      extractSourceRefs([{ toolName: "search_documents", output: { chunks: [{}] } }]),
    ).toEqual([]);
  });
});

describe("smoke-helpers — assertHasCitations", () => {
  it("throws when no tool result yields a sourceRef", () => {
    expect(() =>
      assertHasCitations("test", [
        { toolName: "find_outliers", output: { flagged: [] } },
      ]),
    ).toThrow(SmokeAssertionError);
  });

  it("passes when at least one csv-row citation is present", () => {
    expect(() =>
      assertHasCitations("test", [
        { toolName: "query_bids", output: { rows: [{ rowId: 1 }] } },
      ]),
    ).not.toThrow();
  });

  it("passes when at least one pdf-page citation is present", () => {
    expect(() =>
      assertHasCitations("test", [
        {
          toolName: "search_documents",
          output: {
            chunks: [
              { sourceRef: { type: "pdf-page", file: "plans.pdf", page: 1 } },
            ],
          },
        },
      ]),
    ).not.toThrow();
  });
});

describe("smoke-helpers — assertHasOutlier", () => {
  it("throws when find_outliers flagged is empty", () => {
    expect(() =>
      assertHasOutlier({ toolName: "find_outliers", output: { flagged: [] } }),
    ).toThrow(SmokeAssertionError);
  });

  it("throws when invoked on a different tool's result", () => {
    expect(() =>
      assertHasOutlier({ toolName: "query_bids", output: { rows: [] } }),
    ).toThrow(/find_outliers/);
  });

  it("passes when find_outliers flags at least one row", () => {
    expect(() =>
      assertHasOutlier({
        toolName: "find_outliers",
        output: { flagged: [{ rowId: 1, deviation: 0.42 }] },
      }),
    ).not.toThrow();
  });
});

describe("smoke-helpers — SPEC_QUESTIONS", () => {
  it("includes the four spec example questions", () => {
    expect(SPEC_QUESTIONS).toHaveLength(4);
    const labels = SPEC_QUESTIONS.map((q) => q.label);
    expect(labels).toEqual([
      "top-N expensive items",
      "deviation outliers",
      "drainage plan-set query",
      "key-quantities summary",
    ]);
  });

  it("designates find_outliers as the expected tool for the outlier question", () => {
    const outlier = SPEC_QUESTIONS.find((q) => q.label === "deviation outliers");
    expect(outlier?.expectTool).toBe("find_outliers");
  });
});
