"use client";

import { useCallback, useState, type FormEvent } from "react";
import { useChat } from "@ai-sdk/react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";

import { EmptyState } from "./empty-state";
import { ChatMessage } from "./message";

export function Chat() {
  const { messages, sendMessage, status, error } = useChat();
  const [input, setInput] = useState("");
  const isBusy = status === "submitted" || status === "streaming";

  const submit = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || isBusy) return;
      setInput("");
      void sendMessage({ text: trimmed });
    },
    [isBusy, sendMessage],
  );

  const onSuggested = useCallback(
    (question: string) => submit(question),
    [submit],
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
          className="rounded-md border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive"
        >
          {error.message}
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
          placeholder="Ask about the bid data or plan set…"
          aria-label="Chat input"
          disabled={isBusy}
          data-testid="chat-input"
        />
        <Button type="submit" disabled={isBusy || input.trim().length === 0}>
          Send
        </Button>
      </form>
    </div>
  );
}
