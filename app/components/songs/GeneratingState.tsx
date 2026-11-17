// app/components/songs/GeneratingState.tsx
"use client";

import { AlertTriangle, Loader2, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";

export function GeneratingState({ topic }: { topic?: string }) {
  return (
    <div
      className="rounded-xl border border-cyan-500/30 p-6"
      role="status"
      aria-live="polite"
    >
      <div className="mb-5 flex items-center gap-3">
        <Loader2 className="size-5 animate-spin text-cyan-500" />
        <div>
          <p className="font-bold">Writing your song…</p>
          <p className="text-sm text-muted-foreground">
            {topic
              ? `“${topic.slice(0, 90)}${topic.length > 90 ? "…" : ""}”`
              : "Free models can take a minute."}
          </p>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-px sm:grid-cols-4">
        {Array.from({ length: 8 }).map((_, i) => (
          <div
            key={i}
            className="h-16 animate-pulse border border-cyan-500/20 bg-cyan-500/5"
            style={{ animationDelay: `${i * 120}ms` }}
          />
        ))}
      </div>
    </div>
  );
}

interface FailedStateProps {
  error?: string;
  busy?: boolean;
  onRetry: () => void;
}

export function FailedState({ error, busy, onRetry }: FailedStateProps) {
  return (
    <div className="rounded-xl border border-red-500/40 bg-red-500/5 p-6">
      <div className="mb-4 flex items-start gap-3">
        <AlertTriangle className="mt-0.5 size-5 shrink-0 text-red-500" />
        <div>
          <p className="font-bold">The song didn’t come out right</p>
          <p className="text-sm text-muted-foreground">
            {error ?? "Unknown error."}
          </p>
        </div>
      </div>
      <Button onClick={onRetry} disabled={busy}>
        <RotateCcw /> Try again
      </Button>
    </div>
  );
}
