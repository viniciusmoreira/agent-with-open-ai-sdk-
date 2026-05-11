"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

import { SUGGESTED_QUESTIONS } from "./suggested-questions";

export type EmptyStateProps = {
  onSelect: (question: string) => void;
  disabled?: boolean;
};

export function EmptyState({ onSelect, disabled }: EmptyStateProps) {
  return (
    <Card className="mx-auto w-full max-w-2xl" data-testid="chat-empty-state">
      <CardHeader>
        <CardTitle>Ask the bid agent</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        {SUGGESTED_QUESTIONS.map((question) => (
          <Button
            key={question}
            type="button"
            variant="outline"
            disabled={disabled}
            className="h-auto justify-start whitespace-normal py-2 text-left"
            onClick={() => onSelect(question)}
          >
            {question}
          </Button>
        ))}
      </CardContent>
    </Card>
  );
}
