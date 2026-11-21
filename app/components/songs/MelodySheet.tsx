// app/components/songs/MelodySheet.tsx
// Draws the melody as sheet music (treble clef, key signature, beamed notes,
// rests, chord symbols above and the lyric syllable under every note).
// The layout itself lives in lib/sheetModel.ts so the PDF export draws the
// exact same notation; this file only turns that layout into SVG.
"use client";

import { useMemo } from "react";
import {
  S,
  SC,
  SHEET_W as W,
  SYSTEM_H,
  SECTION_HEAD,
  layoutSystem,
  planSystems,
  type Prim,
  type SystemPlan,
} from "@/lib/SheetModel";
import type { Melody } from "@/lib/melody";
import type { SongSection } from "@/lib/songTypes";

function PrimEl({ p }: { p: Prim }) {
  switch (p.k) {
    case "line":
      return (
        <line
          x1={p.x1}
          x2={p.x2}
          y1={p.y1}
          y2={p.y2}
          strokeWidth={p.w}
          className="stroke-current"
          opacity={p.opacity}
        />
      );
    case "rect":
      return (
        <rect
          x={p.x}
          y={p.y}
          width={p.w}
          height={p.h}
          className="fill-current"
        />
      );
    case "ellipse":
      return (
        <ellipse
          cx={p.cx}
          cy={p.cy}
          rx={p.rx}
          ry={p.ry}
          transform={`rotate(${p.rot} ${p.cx} ${p.cy})`}
          strokeWidth={p.sw}
          className={
            p.hollow
              ? "fill-background stroke-current"
              : "fill-current stroke-current"
          }
        />
      );
    case "circle":
      return <circle cx={p.cx} cy={p.cy} r={p.r} className="fill-current" />;
    case "glyph":
      return (
        <path
          d={p.d}
          transform={`translate(${p.x} ${p.y}) scale(${SC})`}
          className="fill-current"
        />
      );
    case "curve":
      return (
        <path
          d={p.d}
          fill="none"
          strokeWidth={p.w}
          className="stroke-current"
        />
      );
    case "text":
      switch (p.role) {
        case "section":
          return (
            <text
              x={p.x}
              y={p.y}
              className="fill-fuchsia-600 dark:fill-fuchsia-300"
              fontSize={p.size}
              fontWeight={800}
              style={{ textTransform: "uppercase", letterSpacing: "0.05em" }}
            >
              {p.text}
            </text>
          );
        case "timesig":
          return (
            <text
              x={p.x}
              y={p.y}
              fontFamily="Georgia, 'Times New Roman', serif"
              fontWeight={700}
              fontSize={p.size}
              textAnchor="middle"
              className="fill-current"
            >
              {p.text}
            </text>
          );
        case "chord":
          return (
            <text
              x={p.x}
              y={p.y}
              fontSize={p.size}
              fontWeight={700}
              fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
              className="fill-cyan-600 dark:fill-cyan-300 print:fill-black"
            >
              {p.text}
            </text>
          );
        default:
          return (
            <text x={p.x} y={p.y} fontSize={p.size} className="fill-current">
              {p.text}
            </text>
          );
      }
  }
}

function Prims({ list }: { list: Prim[] }) {
  return (
    <>
      {list.map((p, i) => (
        <PrimEl key={i} p={p} />
      ))}
    </>
  );
}

/* -------------------------------- the sheet -------------------------------- */

export interface MelodySheetProps {
  melody: Melody;
  sections: SongSection[];
  /** Most bars allowed on one line (the view setting). */
  barsPerRow: number;
  currentIndex?: number | null;
  onBarClick?: (flatIndex: number) => void;
  /** Show only the melody (no chord symbols). */
  showChords?: boolean;
}

export function MelodySheet({
  melody,
  sections,
  barsPerRow,
  currentIndex = null,
  onBarClick,
  showChords = true,
}: MelodySheetProps) {
  const systems = useMemo(
    () => planSystems(melody, sections, barsPerRow, W),
    [melody, sections, barsPerRow],
  );

  // vertical layout
  const { rows, height } = useMemo(() => {
    const rows: { sys: SystemPlan; y: number }[] = [];
    let y = 8;
    for (const sys of systems) {
      rows.push({ sys, y });
      y += (sys.first ? SECTION_HEAD : 0) + SYSTEM_H;
    }
    return { rows, height: y + 6 };
  }, [systems]);

  return (
    <svg
      viewBox={`0 0 ${W} ${height}`}
      className="w-full select-none text-foreground print:text-black"
      role="img"
      aria-label="Melody in sheet music notation"
    >
      {rows.map(({ sys, y: sy }, ri) => {
        const layout = layoutSystem(sys, melody, sections, {
          width: W,
          showChords,
          sy,
        });
        return (
          <g key={ri}>
            <Prims list={layout.head} />

            {layout.bars.map((bar) => {
              const active = currentIndex === bar.bi;
              return (
                <g
                  key={bar.bi}
                  onClick={onBarClick ? () => onBarClick(bar.bi) : undefined}
                  className={onBarClick ? "cursor-pointer" : undefined}
                >
                  {/* hit area + highlight */}
                  <rect
                    x={bar.x0}
                    y={layout.top - 34}
                    width={bar.w}
                    height={4 * S + 86}
                    className={
                      active
                        ? "fill-cyan-400/15 stroke-cyan-400"
                        : "fill-transparent stroke-transparent hover:fill-cyan-400/5"
                    }
                    strokeWidth={active ? 2 : 0}
                  />
                  <text
                    x={bar.numX}
                    y={bar.numY}
                    fontSize={8}
                    className="fill-muted-foreground font-mono print:hidden"
                  >
                    {bar.bi + 1}
                  </text>
                  <Prims list={bar.prims} />
                </g>
              );
            })}
          </g>
        );
      })}
    </svg>
  );
}
