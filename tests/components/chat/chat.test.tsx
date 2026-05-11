// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from "vitest";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";

type FakeMessage = {
  id: string;
  role: "user" | "assistant";
  parts: ReadonlyArray<{ type: "text"; text: string }>;
};

const sendMessage = vi.fn<(input: { text: string }) => Promise<void>>();
let messagesRef: FakeMessage[] = [];
let setMessagesRef: ((next: FakeMessage[]) => void) | null = null;
let statusRef: "ready" | "submitted" | "streaming" = "ready";

vi.mock("@ai-sdk/react", () => ({
  useChat: () => {
    const [messages, setMessages] = useState<FakeMessage[]>(messagesRef);
    setMessagesRef = (next) => {
      messagesRef = next;
      setMessages(next);
    };
    return {
      messages,
      sendMessage,
      status: statusRef,
      error: undefined,
    };
  },
}));

import { Chat } from "@/components/chat/chat";
import { SUGGESTED_QUESTIONS } from "@/components/chat/suggested-questions";

beforeEach(() => {
  sendMessage.mockReset();
  messagesRef = [];
  setMessagesRef = null;
  statusRef = "ready";
});

describe("Chat — empty-state to first-message integration", () => {
  it("renders the empty state on first mount", () => {
    render(<Chat />);
    expect(screen.getByTestId("chat-empty-state")).toBeInTheDocument();
    for (const q of SUGGESTED_QUESTIONS) {
      expect(screen.getByRole("button", { name: q })).toBeInTheDocument();
    }
  });

  it("clicking a suggested question calls sendMessage with that text and clears the empty state once a user message lands", async () => {
    sendMessage.mockImplementation(async ({ text }) => {
      setMessagesRef?.([
        { id: "u1", role: "user", parts: [{ type: "text", text }] },
      ]);
    });
    render(<Chat />);
    await userEvent.click(
      screen.getByRole("button", { name: SUGGESTED_QUESTIONS[0] }),
    );
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith({ text: SUGGESTED_QUESTIONS[0] });
    expect(screen.queryByTestId("chat-empty-state")).not.toBeInTheDocument();
    expect(screen.getByTestId("message-user")).toHaveTextContent(
      SUGGESTED_QUESTIONS[0],
    );
  });

  it("submitting the form sends the typed text and resets the input", async () => {
    sendMessage.mockResolvedValue();
    render(<Chat />);
    const input = screen.getByTestId("chat-input") as HTMLInputElement;
    await userEvent.type(input, "What about drainage?");
    await userEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(sendMessage).toHaveBeenCalledWith({ text: "What about drainage?" });
    expect(input.value).toBe("");
  });

  it("does not send when the input is whitespace only", async () => {
    sendMessage.mockResolvedValue();
    render(<Chat />);
    const input = screen.getByTestId("chat-input") as HTMLInputElement;
    await userEvent.type(input, "   ");
    // Send button should be disabled for whitespace-only input.
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("appends streamed assistant text without re-mounting the assistant message node", () => {
    render(<Chat />);
    act(() => {
      setMessagesRef?.([
        { id: "u1", role: "user", parts: [{ type: "text", text: "hi" }] },
        { id: "a1", role: "assistant", parts: [{ type: "text", text: "Hel" }] },
      ]);
    });
    const assistantNode = screen.getByTestId("message-assistant");
    const textNode = assistantNode.querySelector(
      '[data-testid="message-text"]',
    );
    expect(textNode).toHaveTextContent("Hel");
    act(() => {
      setMessagesRef?.([
        { id: "u1", role: "user", parts: [{ type: "text", text: "hi" }] },
        {
          id: "a1",
          role: "assistant",
          parts: [{ type: "text", text: "Hello world" }],
        },
      ]);
    });
    expect(screen.getByTestId("message-assistant")).toBe(assistantNode);
    const textNodeAfter = assistantNode.querySelector(
      '[data-testid="message-text"]',
    );
    expect(textNodeAfter).toBe(textNode);
    expect(textNodeAfter).toHaveTextContent("Hello world");
  });
});
