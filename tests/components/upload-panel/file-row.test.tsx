// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";

import { FileRow } from "@/components/upload-panel/file-row";
import type { UploadFileEntry } from "@/components/upload-panel/types";

function makeFile(overrides: Partial<UploadFileEntry> = {}): UploadFileEntry {
  return {
    id: "file-1",
    name: "bids.csv",
    kind: "csv",
    status: "uploading",
    ...overrides,
  };
}

describe("FileRow", () => {
  it("renders a cached badge when the upload returned cached: true", () => {
    render(<FileRow file={makeFile({ status: "cached", fileHash: "abc" })} />);
    expect(screen.getByTestId("upload-file-cached-badge")).toHaveTextContent(
      /cached/i,
    );
    expect(screen.queryByTestId("upload-file-progress-text")).toBeNull();
  });

  it("renders csv-progress as a row count", () => {
    render(
      <FileRow
        file={makeFile({
          status: "ingesting",
          progress: { kind: "csv-rows", rows: 240 },
        })}
      />,
    );
    expect(screen.getByTestId("upload-file-progress-text")).toHaveTextContent(
      "240 rows",
    );
  });

  it("renders page-progress as X/Y pages with the extraction path", () => {
    render(
      <FileRow
        file={makeFile({
          kind: "pdf",
          name: "plans.pdf",
          status: "ingesting",
          progress: {
            kind: "pdf-pages",
            page: 5,
            total: 12,
            path: "vision",
          },
        })}
      />,
    );
    expect(screen.getByTestId("upload-file-progress-text")).toHaveTextContent(
      "5/12 pages (vision)",
    );
  });

  it("renders the error message as plain text without stack traces", () => {
    render(
      <FileRow
        file={makeFile({
          status: "error",
          errorMessage:
            "Failed to parse CSV: unexpected token\n    at parse (/abs/path.js:1)",
        })}
      />,
    );
    const error = screen.getByTestId("upload-file-error");
    expect(error).toHaveTextContent("Failed to parse CSV: unexpected token");
    expect(error.textContent).not.toMatch(/\/abs\/path\.js/);
  });

  it("renders an unmapped-headers warning under the file", () => {
    render(
      <FileRow
        file={makeFile({
          status: "done",
          chunks: 12,
          unmapped: ["MYSTERY_COLUMN", "Extra"],
        })}
      />,
    );
    const warn = screen.getByTestId("upload-file-unmapped");
    expect(warn).toHaveTextContent(/MYSTERY_COLUMN/);
    expect(warn).toHaveTextContent(/Extra/);
  });
});
