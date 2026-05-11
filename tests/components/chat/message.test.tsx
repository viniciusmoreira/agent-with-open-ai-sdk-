// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

import { ChatMessage } from "@/components/chat/message";

type AnyMessage = Parameters<typeof ChatMessage>[0]["message"];

function makeMessage(parts: ReadonlyArray<unknown>): AnyMessage {
  return {
    id: "m1",
    role: "assistant",
    parts,
  } as unknown as AnyMessage;
}

describe("ChatMessage", () => {
  it("renders text parts and surfaces tool-call traces and citations", () => {
    const message = makeMessage([
      { type: "text", text: "Here are the top items." },
      {
        type: "tool-query_bids",
        toolCallId: "call-1",
        state: "output-available",
        input: { operation: "top_n_by_amount", n: 2 },
        output: {
          summary: "Top 2 row(s) by extended amount.",
          rows: [{ rowId: 4 }, { rowId: 7 }],
        },
      },
    ]);
    render(<ChatMessage message={message} />);
    expect(screen.getByTestId("message-text")).toHaveTextContent(
      "Here are the top items.",
    );
    expect(screen.getByTestId("tool-call-name")).toHaveTextContent(
      "query_bids",
    );
    const csv = screen.getAllByTestId("citation-csv");
    expect(csv).toHaveLength(2);
    expect(csv[0]).toHaveTextContent("row 4");
    expect(csv[1]).toHaveTextContent("row 7");
  });

  it("updates the text body in place when streaming, without re-mounting the message node", () => {
    const message1 = makeMessage([{ type: "text", text: "Hel" }]);
    const { rerender } = render(<ChatMessage message={message1} />);
    const node1 = screen.getByTestId("message-assistant");
    const text1 = screen.getByTestId("message-text");
    expect(text1).toHaveTextContent("Hel");

    const message2 = makeMessage([{ type: "text", text: "Hello world" }]);
    rerender(<ChatMessage message={message2} />);

    const node2 = screen.getByTestId("message-assistant");
    const text2 = screen.getByTestId("message-text");
    expect(node2).toBe(node1);
    expect(text2).toBe(text1);
    expect(text2).toHaveTextContent("Hello world");
  });

  it("does not render a citations group on user messages", () => {
    const message: AnyMessage = {
      id: "u1",
      role: "user",
      parts: [{ type: "text", text: "hi" }],
    } as unknown as AnyMessage;
    render(<ChatMessage message={message} />);
    expect(screen.queryByTestId("citations")).not.toBeInTheDocument();
  });
});
