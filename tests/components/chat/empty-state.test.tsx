// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { EmptyState } from "@/components/chat/empty-state";
import { SUGGESTED_QUESTIONS } from "@/components/chat/suggested-questions";

describe("EmptyState", () => {
  it("renders the four brief example questions verbatim", () => {
    render(<EmptyState onSelect={() => {}} />);
    for (const q of SUGGESTED_QUESTIONS) {
      expect(screen.getByRole("button", { name: q })).toBeInTheDocument();
    }
    expect(screen.getAllByRole("button")).toHaveLength(4);
  });

  it("invokes onSelect with the question text when a suggestion is clicked", async () => {
    const onSelect = vi.fn();
    render(<EmptyState onSelect={onSelect} />);
    await userEvent.click(
      screen.getByRole("button", { name: SUGGESTED_QUESTIONS[0] }),
    );
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith(SUGGESTED_QUESTIONS[0]);
  });

  it("disables suggestion buttons when disabled prop is true", () => {
    render(<EmptyState onSelect={() => {}} disabled />);
    for (const button of screen.getAllByRole("button")) {
      expect(button).toBeDisabled();
    }
  });
});
