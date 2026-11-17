// app/components/songs/ChordChart.tsx
"use client";

import { Pencil } from "lucide-react";
import { cn } from "@/lib/utils";
import type { SongBar, SongSection } from "@/lib/songTypes";

export interface ChordChartProps {
  sections: SongSection[];
  /** 1–4. On small screens the chart always falls back to fewer columns. */
  barsPerRow: number;
  showChords: boolean;
  showLyrics: boolean;
  /** rem multiplier for the chart text (1 = normal). */
  textScale: number;
  /** Flat bar index (across all sections) that is currently playing. */
  currentIndex?: number | null;
  onBarClick?: (flatIndex: number) => void;
  onEditBar?: (sectionIndex: number, barIndex: number) => void;
}

const GRID: Record<number, string> = {
  1: "grid-cols-1",
  2: "grid-cols-1 sm:grid-cols-2",
  3: "grid-cols-1 sm:grid-cols-2 lg:grid-cols-3",
  4: "grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 print:grid-cols-4",
};

interface BarCellProps {
  bar: SongBar;
  flatIndex: number;
  active: boolean;
  showChords: boolean;
  showLyrics: boolean;
  onClick?: () => void;
  onEdit?: () => void;
}

function BarCell({
  bar,
  flatIndex,
  active,
  showChords,
  showLyrics,
  onClick,
  onEdit,
}: BarCellProps) {
  return (
    <div
      onClick={onClick}
      data-active={active}
      className={cn(
        "group relative border-b border-r border-cyan-500/30 px-3 pb-2 pt-4 transition-colors print:break-inside-avoid print:border-black/40",
        onClick && "cursor-pointer hover:bg-cyan-400/5",
        active && "bg-cyan-400/15 shadow-[inset_0_0_0_2px_var(--accent-400)]",
      )}
    >
      {/* Bar numbers are a real sequence, so they earn their place. */}
      <span className="absolute left-1 top-0.5 font-mono text-[9px] text-muted-foreground print:hidden">
        {flatIndex + 1}
      </span>

      {onEdit && (
        <button
          type="button"
          aria-label={`Edit bar ${flatIndex + 1}`}
          onClick={(e) => {
            e.stopPropagation();
            onEdit();
          }}
          className="absolute right-1 top-1 rounded p-1 text-muted-foreground opacity-60 transition hover:bg-cyan-400/10 hover:text-cyan-300 sm:opacity-0 sm:group-hover:opacity-100 print:hidden"
        >
          <Pencil size={12} />
        </button>
      )}

      <div className="flex flex-wrap items-end">
        {bar.segments.map((seg, i) => (
          <div key={i} className="flex flex-col">
            {showChords && (
              <span className="h-[1.7em] whitespace-pre pr-3 font-mono font-bold leading-[1.7em] text-cyan-600 dark:text-cyan-300 print:text-black">
                {seg.chord ?? "\u00A0"}
              </span>
            )}
            {showLyrics && (
              <span className="min-h-[1.4em] whitespace-pre-wrap leading-snug text-foreground print:text-black">
                {seg.lyric === "" ? "\u00A0" : seg.lyric}
              </span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

export function ChordChart({
  sections,
  barsPerRow,
  showChords,
  showLyrics,
  textScale,
  currentIndex = null,
  onBarClick,
  onEditBar,
}: ChordChartProps) {
  // First flat bar index of each section.
  const starts = sections.reduce<number[]>((acc, _s, i) => {
    acc.push(i === 0 ? 0 : acc[i - 1] + sections[i - 1].bars.length);
    return acc;
  }, []);

  return (
    <div className="space-y-8" style={{ fontSize: `${textScale}rem` }}>
      {sections.map((section, si) => (
        <section key={section.id} className="print:break-inside-avoid-page">
          <h3 className="mb-2 flex items-baseline gap-3 text-[0.9em] font-black uppercase tracking-wide text-fuchsia-600 dark:text-fuchsia-300 print:text-black">
            {section.name}
            <span className="font-mono text-[0.7em] font-normal normal-case tracking-normal text-muted-foreground">
              {section.bars.length} bars
            </span>
          </h3>
          <div
            className={cn(
              "grid border-l border-t border-cyan-500/30 print:border-black/40",
              GRID[barsPerRow] ?? GRID[4],
            )}
          >
            {section.bars.map((bar, bi) => {
              const flatIndex = starts[si] + bi;
              return (
                <BarCell
                  key={bi}
                  bar={bar}
                  flatIndex={flatIndex}
                  active={currentIndex === flatIndex}
                  showChords={showChords}
                  showLyrics={showLyrics}
                  onClick={onBarClick ? () => onBarClick(flatIndex) : undefined}
                  onEdit={onEditBar ? () => onEditBar(si, bi) : undefined}
                />
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}
