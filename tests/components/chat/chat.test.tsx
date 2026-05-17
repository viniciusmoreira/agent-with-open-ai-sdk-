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
const regenerate = vi.fn<() => Promise<void>>();
const clearError = vi.fn<() => void>();
let messagesRef: FakeMessage[] = [];
let setMessagesRef: ((next: FakeMessage[]) => void) | null = null;
let statusRef: "ready" | "submitted" | "streaming" = "ready";
let errorRef: Error | undefined = undefined;

vi.mock("@ai-sdk/react", () => ({
  useChat: () => {
    const [messages, setMessages] = useState<FakeMessage[]>(messagesRef);
    setMessagesRef = (next) => {
      messagesRef = next;
      setMessages(next);
    };
    const setMessagesApi = (
      updater: FakeMessage[] | ((prev: FakeMessage[]) => FakeMessage[]),
    ) => {
      const next =
        typeof updater === "function"
          ? (updater as (prev: FakeMessage[]) => FakeMessage[])(messages)
          : updater;
      messagesRef = next;
      setMessages(next);
    };
    return {
      messages,
      sendMessage,
      regenerate,
      setMessages: setMessagesApi,
      clearError,
      status: statusRef,
      error: errorRef,
    };
  },
}));

import { Chat } from "@/components/chat/chat";
import { SUGGESTED_QUESTIONS } from "@/components/chat/suggested-questions";
import { UploadReadyProvider } from "@/components/upload-panel/upload-ready-context";

beforeEach(() => {
  sendMessage.mockReset();
  regenerate.mockReset();
  clearError.mockReset();
  messagesRef = [];
  setMessagesRef = null;
  statusRef = "ready";
  errorRef = undefined;
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

  it("clicking a suggested question while upload is not ready pre-fills the input instead of sending", async () => {
    sendMessage.mockResolvedValue();
    render(
      <UploadReadyProvider>
        <Chat />
      </UploadReadyProvider>,
    );
    await userEvent.click(
      screen.getByRole("button", { name: SUGGESTED_QUESTIONS[0] }),
    );
    expect(sendMessage).not.toHaveBeenCalled();
    const input = screen.getByTestId("chat-input") as HTMLInputElement;
    expect(input.value).toBe(SUGGESTED_QUESTIONS[0]);
    expect(screen.getByTestId("chat-empty-state")).toBeInTheDocument();
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

describe("Chat — error recovery", () => {
  it("renders a Retry button on error that calls regenerate after clearing the error", async () => {
    errorRef = new Error("boom");
    messagesRef = [
      { id: "u1", role: "user", parts: [{ type: "text", text: "hello?" }] },
    ];
    render(<Chat />);
    const retry = screen.getByTestId("chat-retry");
    expect(retry).toBeInTheDocument();
    await userEvent.click(retry);
    expect(clearError).toHaveBeenCalledTimes(1);
    expect(regenerate).toHaveBeenCalledTimes(1);
  });

  it("submitting a new message while in error drops the failed user turn instead of duplicating it", async () => {
    errorRef = new Error("boom");
    messagesRef = [
      { id: "u1", role: "user", parts: [{ type: "text", text: "first try" }] },
    ];
    sendMessage.mockImplementation(async ({ text }) => {
      // The failed user message should be gone before sendMessage runs; the
      // new submission is what the user sees in the transcript.
      expect(messagesRef.find((m) => m.id === "u1")).toBeUndefined();
      messagesRef = [
        { id: "u2", role: "user", parts: [{ type: "text", text }] },
      ];
      setMessagesRef?.(messagesRef);
    });
    render(<Chat />);
    const input = screen.getByTestId("chat-input") as HTMLInputElement;
    await userEvent.type(input, "second try");
    await userEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(sendMessage).toHaveBeenCalledWith({ text: "second try" });
    expect(clearError).toHaveBeenCalledTimes(1);
  });
});
