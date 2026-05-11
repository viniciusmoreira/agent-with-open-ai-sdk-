import * as React from "react";

import { cn } from "@/lib/utils";

export type ProgressProps = React.ComponentProps<"div"> & {
  value?: number | null;
  max?: number;
};

function clampPercent(value: number | null | undefined, max: number): number {
  if (value == null || !Number.isFinite(value) || !Number.isFinite(max) || max <= 0) {
    return 0;
  }
  if (value <= 0) return 0;
  if (value >= max) return 100;
  return (value / max) * 100;
}

function Progress({ className, value, max = 100, ...props }: ProgressProps) {
  const percent = clampPercent(value, max);
  const indeterminate = value == null;
  return (
    <div
      data-slot="progress"
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuenow={indeterminate ? undefined : Math.round(percent)}
      className={cn(
        "relative h-2 w-full overflow-hidden rounded-full bg-muted",
        className,
      )}
      {...props}
    >
      <div
        data-slot="progress-indicator"
        className={cn(
          "h-full bg-primary transition-all",
          indeterminate && "animate-pulse",
        )}
        style={{ width: indeterminate ? "33%" : `${percent}%` }}
      />
    </div>
  );
}

export { Progress };
