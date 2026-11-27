// app/components/songs/GeneratingModal.tsx
"use client";

import { useEffect, useState, type CSSProperties } from "react";
import { Dialog as DialogPrimitive } from "radix-ui";
import { Music } from "lucide-react";

/**
 * Full-screen cyberpunk "song forge" shown while a song is being written.
 * All the visuals live in globals.css under the `.gm-*` classes and follow the
 * chosen accent colour. Pass `onDismiss` to let the person hide it and keep
 * browsing (generation carries on in the background).
 */

const STEPS = [
  "booting the neural song forge",
  "writing lyrics & chords",
  "picking a key that feels right",
  "dropping chords under every word",
  "hunting for the hook",
  "composing the melody",
  "arranging the band",
  "polishing the bridge",
  "final mix, hold tight",
  "the free model is thinking hard, hang on",
];

const GLYPHS = ["♪", "♫", "✦", "◇", "♬", "01", "▲", "♩"];

// Fixed pseudo-random layout so it never changes between renders.
const FLOATERS = Array.from({ length: 14 }, (_, i) => ({
  glyph: GLYPHS[i % GLYPHS.length],
  style: {
    "--x": `${(i * 37 + 8) % 96}%`,
    "--size": `${14 + ((i * 11) % 22)}px`,
    "--dur": `${9 + ((i * 5) % 9)}s`,
    "--delay": `${-((i * 7) % 12)}s`,
    "--rot": `${(i % 2 ? 1 : -1) * (40 + i * 13)}deg`,
  } as CSSProperties,
}));

const BARS = Array.from({ length: 32 }, (_, i) => ({
  "--s": `${(0.55 + ((i * 53) % 9) / 10).toFixed(2)}s`,
  "--d": `${(-((i * 29) % 10) / 10).toFixed(1)}s`,
})) as CSSProperties[];

function stepIndex(seconds: number): number {
  if (seconds >= 40) return STEPS.length - 1;
  return Math.min(Math.floor(seconds / 2.6), STEPS.length - 2);
}

interface GeneratingModalProps {
  open: boolean;
  topic?: string;
  /** Show a "hide" button and allow Esc to close. */
  onDismiss?: () => void;
}

/** Everything inside is mounted only while open, so the clock resets itself. */
function ForgeBody({
  topic,
  onDismiss,
}: Pick<GeneratingModalProps, "topic" | "onDismiss">) {
  const [seconds, setSeconds] = useState(0);

  useEffect(() => {
    const started = Date.now();
    const id = setInterval(
      () => setSeconds(Math.floor((Date.now() - started) / 1000)),
      250,
    );
    return () => clearInterval(id);
  }, []);

  const idx = stepIndex(seconds);
  const pct = Math.min(94, Math.round(94 * (1 - Math.exp(-seconds / 28))));
  const mm = String(Math.floor(seconds / 60)).padStart(2, "0");
  const ss = String(seconds % 60).padStart(2, "0");
  const history = [idx - 2, idx - 1].filter((n) => n >= 0);
  const current = STEPS[idx];

  return (
    <>
      {/* ---- background: sun, grid, rain of glyphs, scanlines ---- */}
      <div className="gm-sun gm-trip" aria-hidden="true" />
      <div className="gm-grid" aria-hidden="true" />
      <div className="gm-floaters" aria-hidden="true">
        {FLOATERS.map((f, i) => (
          <span key={i} className="gm-float" style={f.style}>
            {f.glyph}
          </span>
        ))}
      </div>
      <div className="gm-scan" aria-hidden="true" />
      <div className="gm-sweep" aria-hidden="true" />

      {/* ---- the panel ---- */}
      <div className="gm-inner">
        <div className="gm-panel cy-panel">
          <div className="gm-head">
            <span className="cy-label">
              <i className="gm-dot" />
              signal: generating
            </span>
            <span className="cy-label tabular-nums">
              {mm}:{ss}
            </span>
          </div>

          <div className="gm-orb gm-trip" aria-hidden="true">
            <span className="gm-ripple" />
            <span className="gm-ripple" style={{ animationDelay: "1.2s" }} />
            <span className="gm-ring gm-ring-a" />
            <span className="gm-ring gm-ring-b" />
            <span className="gm-ring gm-ring-c" />
            <span className="gm-core">
              <Music className="size-7" strokeWidth={2.5} />
            </span>
          </div>

          <DialogPrimitive.Title asChild>
            <h2
              className="cy-title cy-glitch gm-title"
              data-text="Writing your song"
            >
              Writing your song
            </h2>
          </DialogPrimitive.Title>

          <DialogPrimitive.Description className="sr-only">
            Your song is being generated. This can take up to a minute.
          </DialogPrimitive.Description>

          {topic && (
            <p className="gm-topic">
              “{topic.slice(0, 140)}
              {topic.length > 140 ? "…" : ""}”
            </p>
          )}

          <div className="gm-term" role="status" aria-live="polite">
            {history.map((n) => (
              <p key={n} className="gm-old">
                <span className="gm-ok">✓</span> {STEPS[n]}
              </p>
            ))}
            <p>
              <span className="gm-arrow">▸</span>{" "}
              <span
                key={idx}
                className="gm-type"
                style={{ "--chars": current.length } as CSSProperties}
              >
                {current}
              </span>
              <span className="gm-caret" aria-hidden="true" />
            </p>
          </div>

          <div className="gm-eq" aria-hidden="true">
            {BARS.map((s, i) => (
              <i key={i} style={s} />
            ))}
          </div>

          <div>
            <div className="gm-meter-row">
              <span className="cy-label">encoding</span>
              <span className="cy-label tabular-nums">{pct}%</span>
            </div>
            <div className="cy-meter">
              <div
                className="cy-meter-fill gm-fill"
                style={{ width: `${Math.max(pct, 3)}%` }}
              />
            </div>
          </div>

          <div className="gm-foot">
            <p>Free models can take a minute.</p>
            {onDismiss && (
              <button type="button" className="cy-pill" onClick={onDismiss}>
                Hide · keep writing in background
              </button>
            )}
          </div>
        </div>
      </div>
    </>
  );
}

export function GeneratingModal({
  open,
  topic,
  onDismiss,
}: GeneratingModalProps) {
  return (
    <DialogPrimitive.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) onDismiss?.();
      }}
    >
      <DialogPrimitive.Portal>
        <DialogPrimitive.Content
          className="gm-root"
          onInteractOutside={(e) => e.preventDefault()}
        >
          <ForgeBody topic={topic} onDismiss={onDismiss} />
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
