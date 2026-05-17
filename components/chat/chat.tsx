"use client";

import { useCallback, useState, type FormEvent } from "react";
import { useChat } from "@ai-sdk/react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useUploadReady } from "@/components/upload-panel/upload-ready-context";

import { EmptyState } from "./empty-state";
import { ChatMessage } from "./message";

export function Chat() {
  const {
    messages,
    sendMessage,
    regenerate,
    setMessages,
    clearError,
    status,
    error,
  } = useChat();
  const [input, setInput] = useState("");
  const { ready } = useUploadReady();
  const isBusy = status === "submitted" || status === "streaming";
  const inputDisabled = isBusy || !ready;

  const submit = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || isBusy) return;
      setInput("");
      if (error) {
        setMessages((prev) => {
          const last = prev[prev.length - 1];
          return last?.role === "user" ? prev.slice(0, -1) : prev;
        });
        clearError();
      }
      void sendMessage({ text: trimmed });
    },
    [isBusy, sendMessage, error, setMessages, clearError],
  );

  const onRetry = useCallback(() => {
    clearError();
    void regenerate();
  }, [clearError, regenerate]);

  const onSuggested = useCallback(
    (question: string) => {
      if (ready && !isBusy) {
        submit(question);
        return;
      }
      setInput(question);
    },
    [ready, isBusy, submit],
  );

  const onSubmit = useCallback(
    (e: FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      submit(input);
    },
    [input, submit],
  );

  const isEmpty = messages.length === 0;

  return (
    <div
      className="mx-auto flex h-full w-full max-w-3xl flex-col gap-4 p-4"
      data-testid="chat-root"
    >
      <ScrollArea className="flex-1">
        <div className="flex flex-col gap-3">
          {isEmpty ? (
            <EmptyState onSelect={onSuggested} disabled={isBusy} />
          ) : (
            messages.map((m) => <ChatMessage key={m.id} message={m} />)
          )}
        </div>
      </ScrollArea>
      {error && (
        <div
          data-testid="chat-error"
          className="flex items-center justify-between gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive"
        >
          <span className="flex-1">{error.message}</span>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={onRetry}
            disabled={isBusy}
            data-testid="chat-retry"
          >
            Retry
          </Button>
        </div>
      )}
      <form
        onSubmit={onSubmit}
        data-testid="chat-form"
        className="flex items-center gap-2"
      >
        <Input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={
            ready
              ? "Ask about the bid data or plan set…"
              : "Upload a CSV or PDF to start…"
          }
          aria-label="Chat input"
          disabled={inputDisabled}
          data-testid="chat-input"
        />
        <Button
          type="submit"
          disabled={inputDisabled || input.trim().length === 0}
        >
          Send
        </Button>
      </form>
    </div>
  );
}
