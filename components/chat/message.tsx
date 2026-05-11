"use client";

import { memo, type ReactNode } from "react";

import { cn } from "@/lib/utils";

import {
  Citations,
  extractCitations,
  type Citation,
} from "./citations";
import { ToolCall, type ToolCallState } from "./tool-call";

type ChatRole = "user" | "assistant" | "system" | "tool" | string;

type AnyPart = {
  type: string;
  text?: string;
  toolName?: string;
  toolCallId?: string;
  state?: string;
  input?: unknown;
  output?: unknown;
  errorText?: string;
};

export type ChatMessageView = {
  id: string;
  role: ChatRole;
  parts?: ReadonlyArray<unknown>;
};

export type ChatMessageProps = {
  message: ChatMessageView;
};

function ChatMessageImpl({ message }: ChatMessageProps) {
  const parts = (message.parts ?? []) as ReadonlyArray<AnyPart>;
  const citations: Citation[] = [];
  const nodes: ReactNode[] = [];

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!;
    if (part.type === "text" && typeof part.text === "string") {
      nodes.push(
        <p
          key={`t-${i}`}
          data-testid="message-text"
          className="whitespace-pre-wrap leading-relaxed"
        >
          {part.text}
        </p>,
      );
      continue;
    }
    const toolName = readToolName(part);
    if (toolName) {
      const state = (part.state ?? "input-streaming") as ToolCallState;
      nodes.push(
        <ToolCall
          key={`tool-${part.toolCallId ?? i}`}
          toolName={toolName}
          state={state}
          input={part.input}
          output={part.output}
          errorText={part.errorText}
        />,
      );
      if (state === "output-available") {
        for (const c of extractCitations(toolName, part.output)) {
          citations.push(c);
        }
      }
    }
  }

  return (
    <div
      data-testid={`message-${message.role}`}
      data-message-id={message.id}
      className={cn(
        "rounded-xl border border-border bg-card p-3 text-sm shadow-sm",
        message.role === "user" && "bg-muted/50",
      )}
    >
      <div className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {message.role}
      </div>
      <div className="flex flex-col gap-2">{nodes}</div>
      {message.role === "assistant" && <Citations citations={citations} />}
    </div>
  );
}

function readToolName(part: AnyPart): string | null {
  if (part.type === "dynamic-tool") {
    return typeof part.toolName === "string" ? part.toolName : null;
  }
  if (part.type.startsWith("tool-")) {
    return part.type.slice("tool-".length);
  }
  return null;
}

export const ChatMessage = memo(ChatMessageImpl);
