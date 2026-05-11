// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import {
  Citations,
  extractCitations,
  type Citation,
} from "@/components/chat/citations";

describe("Citations", () => {
  it("renders nothing when no citations are present", () => {
    const { container } = render(<Citations citations={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders one row badge per csv-row citation", () => {
    const citations: Citation[] = [
      { type: "csv-row", rowId: 4 },
      { type: "csv-row", rowId: 17 },
    ];
    render(<Citations citations={citations} />);
    const badges = screen.getAllByTestId("citation-csv");
    expect(badges).toHaveLength(2);
    expect(badges[0]).toHaveTextContent("row 4");
    expect(badges[1]).toHaveTextContent("row 17");
  });

  it("renders pdf-page badges as `file:page` and toggles a disclosure on click", async () => {
    const citations: Citation[] = [
      { type: "pdf-page", file: "docs/plans.pdf", page: 47 },
    ];
    render(<Citations citations={citations} />);
    const badge = screen.getByTestId("citation-pdf");
    expect(badge).toHaveTextContent("plans.pdf:47");
    expect(screen.queryByTestId("citation-pdf-details")).not.toBeInTheDocument();
    await userEvent.click(badge);
    const details = await screen.findByTestId("citation-pdf-details");
    expect(details).toHaveTextContent("docs/plans.pdf");
    expect(details).toHaveTextContent("47");
  });
});

describe("extractCitations", () => {
  it("derives row citations from query_bids rows[]", () => {
    const out = extractCitations("query_bids", {
      summary: "ok",
      rows: [{ rowId: 1 }, { rowId: 2 }],
    });
    expect(out).toEqual([
      { type: "csv-row", rowId: 1 },
      { type: "csv-row", rowId: 2 },
    ]);
  });

  it("derives row citations from find_outliers flagged[]", () => {
    const out = extractCitations("find_outliers", {
      flagged: [{ rowId: 9 }],
      threshold: 0.15,
      minPeers: 3,
    });
    expect(out).toEqual([{ type: "csv-row", rowId: 9 }]);
  });

  it("derives mixed citations from search_documents chunks[]", () => {
    const out = extractCitations("search_documents", {
      chunks: [
        { sourceRef: { type: "csv-row", file: "x.csv", rowId: 3 } },
        { sourceRef: { type: "pdf-page", file: "plans.pdf", page: 12 } },
      ],
    });
    expect(out).toEqual([
      { type: "csv-row", rowId: 3, file: "x.csv" },
      { type: "pdf-page", file: "plans.pdf", page: 12 },
    ]);
  });

  it("returns [] for an unknown tool or malformed output", () => {
    expect(extractCitations("query_bids", null)).toEqual([]);
    expect(extractCitations("query_bids", {})).toEqual([]);
    expect(extractCitations("nope", { rows: [{ rowId: 1 }] })).toEqual([
      { type: "csv-row", rowId: 1 },
    ]);
  });
});
