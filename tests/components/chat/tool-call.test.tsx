// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { ToolCall } from "@/components/chat/tool-call";

describe("ToolCall", () => {
  it("renders the tool name and is collapsed by default", () => {
    render(
      <ToolCall
        toolName="query_bids"
        state="output-available"
        input={{ operation: "top_n_by_amount", n: 5 }}
        output={{ summary: "Top 5", rows: [] }}
      />,
    );
    expect(screen.getByTestId("tool-call-name")).toHaveTextContent("query_bids");
    expect(screen.queryByTestId("tool-call-arguments")).not.toBeInTheDocument();
    expect(screen.queryByTestId("tool-call-output")).not.toBeInTheDocument();
  });

  it("expands to show stringified arguments when the trigger is clicked", async () => {
    render(
      <ToolCall
        toolName="query_bids"
        state="output-available"
        input={{ operation: "top_n_by_amount", n: 5 }}
        output={{ summary: "Top 5 row(s) by extended amount.", rows: [] }}
      />,
    );
    await userEvent.click(screen.getByTestId("tool-call-trigger"));
    const args = await screen.findByTestId("tool-call-arguments");
    expect(args).toHaveTextContent('"operation": "top_n_by_amount"');
    expect(args).toHaveTextContent('"n": 5');
    const output = screen.getByTestId("tool-call-output");
    expect(output).toHaveTextContent("Top 5 row(s) by extended amount.");
  });

  it("summarizes output-available state using the tool summary", () => {
    render(
      <ToolCall
        toolName="search_documents"
        state="output-available"
        input={{ query: "drainage" }}
        output={{ chunks: [{}, {}, {}] }}
      />,
    );
    const trigger = screen.getByTestId("tool-call-trigger");
    expect(trigger).toHaveTextContent("3 chunk(s)");
  });

  it("renders an error message when state is output-error", () => {
    render(
      <ToolCall
        toolName="find_outliers"
        state="output-error"
        input={{}}
        errorText="boom"
      />,
    );
    expect(screen.getByTestId("tool-call-state")).toHaveTextContent(
      "output-error",
    );
  });
});
