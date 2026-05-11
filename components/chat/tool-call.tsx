"use client";

import { useState } from "react";

import { Badge } from "@/components/ui/badge";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";

export type ToolCallState =
  | "input-streaming"
  | "input-available"
  | "output-available"
  | "output-error"
  | "approval-requested"
  | "approval-responded"
  | "output-denied";

export type ToolCallProps = {
  toolName: string;
  state: ToolCallState;
  input: unknown;
  output?: unknown;
  errorText?: string;
};

export function ToolCall({
  toolName,
  state,
  input,
  output,
  errorText,
}: ToolCallProps) {
  const [open, setOpen] = useState(false);
  const summary = summarizeOutput(state, output, errorText);
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger
        data-testid="tool-call-trigger"
        className="flex w-full items-center justify-between gap-2 rounded-md border border-border px-2 py-1 text-left text-xs hover:bg-muted/50"
      >
        <span className="flex items-center gap-2">
          <Badge variant="outline" data-testid="tool-call-name">
            {toolName}
          </Badge>
          <span data-testid="tool-call-state" className="text-muted-foreground">
            {state}
          </span>
        </span>
        <span className="truncate text-muted-foreground">{summary}</span>
      </CollapsibleTrigger>
      <CollapsibleContent
        data-testid="tool-call-details"
        className="mt-1 flex flex-col gap-2 rounded-md border border-border bg-muted/30 p-2 text-xs"
      >
        <div>
          <div className="font-medium text-muted-foreground">arguments</div>
          <pre
            data-testid="tool-call-arguments"
            className="mt-1 overflow-x-auto whitespace-pre-wrap break-words font-mono text-[11px]"
          >
            {stringify(input)}
          </pre>
        </div>
        {state === "output-available" && (
          <div>
            <div className="font-medium text-muted-foreground">result</div>
            <pre
              data-testid="tool-call-output"
              className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px]"
            >
              {stringify(output)}
            </pre>
          </div>
        )}
        {state === "output-error" && errorText && (
          <div data-testid="tool-call-error" className="text-destructive">
            {errorText}
          </div>
        )}
      </CollapsibleContent>
    </Collapsible>
  );
}

function summarizeOutput(
  state: ToolCallState,
  output: unknown,
  errorText?: string,
): string {
  if (state === "output-error") return errorText ?? "error";
  if (state !== "output-available") return state;
  if (output === null || typeof output !== "object") return "done";
  const o = output as {
    summary?: string;
    rows?: ReadonlyArray<unknown>;
    flagged?: ReadonlyArray<unknown>;
    chunks?: ReadonlyArray<unknown>;
  };
  if (typeof o.summary === "string") return o.summary;
  if (Array.isArray(o.rows)) return `${o.rows.length} row(s)`;
  if (Array.isArray(o.flagged)) return `${o.flagged.length} flagged`;
  if (Array.isArray(o.chunks)) return `${o.chunks.length} chunk(s)`;
  return "done";
}

function stringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
