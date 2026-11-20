// app/components/songs/MelodySheet.tsx
// Draws the melody as sheet music (treble clef, key signature, beamed notes,
// rests, chord symbols above and the lyric syllable under every note).
"use client";

import { useMemo } from "react";
import {
  GLYPHS,
  GLYPH_UNITS_PER_SPACE,
  type Glyph,
} from "@/lib/notationGlyphs";
import {
  beatUnits,
  degreeToStep,
  type Melody,
  type MelodyNote,
} from "@/lib/melody";
import type { SongSection } from "@/lib/songTypes";

/* --------------------------------- geometry -------------------------------- */

const S = 9; // staff space in px
const SC = S / GLYPH_UNITS_PER_SPACE; // font units -> px
const W = 920; // drawing width
const MARGIN = 10;
const UNIT_W = 11; // px per sixteenth for spacing
const STEM = 3.3 * S;
const HEAD_RX = 5.6;
const HEAD_RY = 4.1;

const SECTION_HEAD = 26;
const SYSTEM_H = 156;
const STAFF_TOP = 50; // top staff line, from system top

// treble clef: bottom line = E4, diatonic step 30
const BOTTOM_STEP = 30;

const SHARP_POS = [8, 5, 9, 6, 3, 7, 4]; // F C G D A E B
const FLAT_POS = [4, 7, 3, 6, 2, 5, 1]; // B E A D G C F

interface Slot {
  note: MelodyNote;
  /** px from the start of the bar's content */
  x: number;
  w: number;
}

function textWidth(n: MelodyNote): number {
  return n.text.length * 6.8 + (n.joinNext ? 5 : 0);
}

function layoutBar(notes: MelodyNote[], scale: number): Slot[] {
  const slots: Slot[] = [];
  let x = 0;
  for (const note of notes) {
    const base =
      note.deg === null
        ? Math.max(18, note.d * UNIT_W)
        : Math.max(note.d * UNIT_W, textWidth(note) + 9, 22);
    const w = base * scale;
    slots.push({ note, x, w });
    x += w;
  }
  return slots;
}

const naturalWidth = (notes: MelodyNote[]) =>
  notes.length === 1 && notes[0].deg === null
    ? 64
    : layoutBar(notes, 1).reduce((a, s) => a + s.w, 0);

/** Break a rest into printable pieces (in sixteenths). */
function restPieces(d: number): number[] {
  const out: number[] = [];
  let left = d;
  for (const p of [8, 4, 2, 1]) {
    while (left >= p) {
      out.push(p);
      left -= p;
    }
  }
  return out;
}

/* --------------------------------- pieces ---------------------------------- */

function GlyphPath({
  glyph,
  x,
  y,
  className,
}: {
  glyph: Glyph;
  x: number;
  y: number;
  className?: string;
}) {
  return (
    <path
      d={glyph.d}
      transform={`translate(${x} ${y}) scale(${SC})`}
      className={className ?? "fill-current"}
    />
  );
}

/** Y of a staff step (0 = bottom line) for a system whose bottom line is at `bottom`. */
const yOfPos = (pos: number, bottom: number) => bottom - (pos * S) / 2;

function Rest({
  d,
  x,
  top,
  bottom,
}: {
  d: number;
  x: number;
  top: number;
  bottom: number;
}) {
  const mid = top + 2 * S;
  if (d >= 8)
    return d >= 16 ? (
      <rect
        x={x - 6}
        y={top + S}
        width={12}
        height={4.5}
        className="fill-current"
      />
    ) : (
      <rect
        x={x - 6}
        y={mid - 4.5}
        width={12}
        height={4.5}
        className="fill-current"
      />
    );
  const glyph =
    d >= 4 ? GLYPHS.restQuarter : d >= 2 ? GLYPHS.rest8th : GLYPHS.rest16th;
  return <GlyphPath glyph={glyph} x={x - 4} y={bottom} />;
}

interface Placed {
  note: MelodyNote;
  x: number; // notehead centre
  y: number;
  pos: number;
}

function Flag({
  x,
  y,
  up,
  count,
}: {
  x: number;
  y: number;
  up: boolean;
  count: number;
}) {
  const dir = up ? 1 : -1;
  const one = (dy: number) => (
    <path
      key={dy}
      d={`M${x} ${y + dy * dir} C${x + 1} ${y + dy * dir + 8 * dir} ${x + 10} ${
        y + dy * dir + 11 * dir
      } ${x + 7.5} ${y + dy * dir + 22 * dir}`}
      fill="none"
      strokeWidth={1.7}
      className="stroke-current"
    />
  );
  return <>{Array.from({ length: count }, (_, i) => one(i * 6 * dir))}</>;
}

function Bar({
  notes,
  U,
  BU,
  x0,
  width,
  top,
  bottom,
  keyStep,
}: {
  notes: MelodyNote[];
  U: number;
  BU: number;
  x0: number;
  width: number;
  top: number;
  bottom: number;
  keyStep: (deg: number) => number;
}) {
  const wholeRest =
    notes.length === 1 && notes[0].deg === null && notes[0].d >= U;
  const natural = naturalWidth(notes);
  const inner = Math.max(20, width - 16);
  const scale = wholeRest ? 1 : inner / natural;
  const slots = wholeRest ? [] : layoutBar(notes, scale);
  const left = x0 + 10;

  // Place notes.
  const placed: (Placed | null)[] = slots.map((s) => {
    if (s.note.deg === null) return null;
    const pos = keyStep(s.note.deg) - BOTTOM_STEP;
    return { note: s.note, x: left + s.x + 8, y: yOfPos(pos, bottom), pos };
  });

  // Group eighths / sixteenths into beams, per beat, with no rest in between.
  const beamOf = new Map<number, number>(); // note index -> group id
  const groups: number[][] = [];
  let cur: number[] = [];
  let curBeat = -1;
  const flush = () => {
    if (cur.length >= 2) {
      groups.push(cur);
      cur.forEach((i) => beamOf.set(i, groups.length - 1));
    }
    cur = [];
  };
  slots.forEach((s, i) => {
    const n = s.note;
    const beamable = n.deg !== null && n.d <= 3;
    const beat = Math.floor(n.u / BU);
    if (beamable && (cur.length === 0 || beat === curBeat)) {
      cur.push(i);
      curBeat = beat;
    } else {
      flush();
      if (beamable) {
        cur = [i];
        curBeat = beat;
      }
    }
  });
  flush();

  const els: React.ReactNode[] = [];

  // Beams
  groups.forEach((g, gi) => {
    const pts = g.map((i) => placed[i] as Placed);
    const avg = pts.reduce((a, p) => a + p.pos, 0) / pts.length;
    const up = avg < 4;
    const yb = up
      ? Math.min(...pts.map((p) => p.y)) - STEM
      : Math.max(...pts.map((p) => p.y)) + STEM;
    const sx = (p: Placed) => (up ? p.x + HEAD_RX - 0.5 : p.x - HEAD_RX + 0.5);
    pts.forEach((p, k) => {
      els.push(
        <line
          key={`st${gi}-${k}`}
          x1={sx(p)}
          x2={sx(p)}
          y1={p.y}
          y2={yb}
          strokeWidth={1.4}
          className="stroke-current"
        />,
      );
    });
    const thick = 3.6;
    const rect = (x1: number, x2: number, level: number, key: string) => {
      const y = up ? yb + level * 5.4 : yb - level * 5.4 - thick;
      els.push(
        <rect
          key={key}
          x={x1}
          y={y}
          width={Math.max(1, x2 - x1)}
          height={thick}
          className="fill-current"
        />,
      );
    };
    rect(sx(pts[0]), sx(pts[pts.length - 1]), 0, `b1-${gi}`);
    // second beam for sixteenths
    pts.forEach((p, k) => {
      if (p.note.d !== 1) return;
      const nextIs16 = pts[k + 1]?.note.d === 1;
      const prevIs16 = pts[k - 1]?.note.d === 1;
      if (nextIs16) rect(sx(p), sx(pts[k + 1]), 1, `b2-${gi}-${k}`);
      else if (!prevIs16)
        rect(
          k === pts.length - 1 ? sx(p) - 7 : sx(p),
          k === pts.length - 1 ? sx(p) : sx(p) + 7,
          1,
          `b2s-${gi}-${k}`,
        );
    });
  });

  // Noteheads, stems, flags, dots, ledger lines, rests
  slots.forEach((s, i) => {
    const n = s.note;
    if (n.deg === null) {
      restPieces(n.d).reduce((off, piece) => {
        const px = left + s.x + 8 + (off / n.d) * s.w * 0.9;
        els.push(
          <Rest
            key={`r${i}-${off}`}
            d={piece}
            x={px}
            top={top}
            bottom={bottom}
          />,
        );
        return off + piece;
      }, 0);
      return;
    }
    const p = placed[i] as Placed;
    const hollow = n.d >= 8;
    const beamed = beamOf.has(i);
    const up = p.pos < 4;

    // ledger lines
    const ledgers: number[] = [];
    if (p.pos <= -2)
      for (let l = -2; l >= p.pos - (p.pos % 2 === 0 ? 0 : -1); l -= 2)
        ledgers.push(l);
    if (p.pos >= 10)
      for (let l = 10; l <= p.pos - (p.pos % 2 === 0 ? 0 : 1); l += 2)
        ledgers.push(l);
    ledgers.forEach((l) =>
      els.push(
        <line
          key={`l${i}-${l}`}
          x1={p.x - 9}
          x2={p.x + 9}
          y1={yOfPos(l, bottom)}
          y2={yOfPos(l, bottom)}
          strokeWidth={1.2}
          className="stroke-current"
        />,
      ),
    );

    // stem + flag for unbeamed notes
    if (n.d < 16 && !beamed) {
      const sx = up ? p.x + HEAD_RX - 0.5 : p.x - HEAD_RX + 0.5;
      const tip = up ? p.y - STEM : p.y + STEM;
      els.push(
        <line
          key={`s${i}`}
          x1={sx}
          x2={sx}
          y1={p.y}
          y2={tip}
          strokeWidth={1.4}
          className="stroke-current"
        />,
      );
      if (n.d <= 3)
        els.push(
          <Flag
            key={`f${i}`}
            x={sx}
            y={tip}
            up={up}
            count={n.d === 1 ? 2 : 1}
          />,
        );
    }

    els.push(
      <ellipse
        key={`h${i}`}
        cx={p.x}
        cy={p.y}
        rx={HEAD_RX}
        ry={HEAD_RY}
        transform={`rotate(-20 ${p.x} ${p.y})`}
        strokeWidth={hollow ? 1.6 : 0.6}
        className={
          hollow
            ? "fill-background stroke-current"
            : "fill-current stroke-current"
        }
      />,
    );

    if (n.d === 3 || n.d === 6 || n.d === 12) {
      const dotY = p.pos % 2 === 0 ? p.y - S / 2 : p.y;
      els.push(
        <circle
          key={`d${i}`}
          cx={p.x + 10}
          cy={dotY}
          r={1.7}
          className="fill-current"
        />,
      );
    }
  });

  if (wholeRest) {
    els.push(
      <rect
        key="wr"
        x={left + inner / 2 - 6}
        y={top + S}
        width={12}
        height={4.5}
        className="fill-current"
      />,
    );
  }

  return <>{els}</>;
}

/* ------------------------------ key signature ------------------------------ */

function KeySignature({
  fifths,
  x,
  bottom,
}: {
  fifths: number;
  x: number;
  bottom: number;
}) {
  const sharp = fifths > 0;
  const list = (sharp ? SHARP_POS : FLAT_POS).slice(0, Math.abs(fifths));
  const g = sharp ? GLYPHS.sharp : GLYPHS.flat;
  const h = g.maxY - g.minY;
  const anchor = sharp ? (g.minY + g.maxY) / 2 : g.maxY - 0.33 * h;
  return (
    <>
      {list.map((pos, i) => (
        <GlyphPath
          key={i}
          glyph={g}
          x={x + i * 9 - g.minX * SC}
          y={yOfPos(pos, bottom) - anchor * SC}
        />
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

interface SystemPlan {
  sectionIndex: number;
  first: boolean; // first line of its section
  barIndexes: number[]; // flat bar indexes
  songFirst: boolean;
}

export function MelodySheet({
  melody,
  sections,
  barsPerRow,
  currentIndex = null,
  onBarClick,
  showChords = true,
}: MelodySheetProps) {
  const { key, beatsPerBar, unitsPerBar: U } = melody;
  const BU = beatUnits(beatsPerBar);
  const keyStep = useMemo(() => (deg: number) => degreeToStep(key, deg), [key]);
  const nFifths = Math.abs(key.fifths);

  const systems = useMemo(() => {
    const out: SystemPlan[] = [];
    let flat = 0;
    sections.forEach((sec, si) => {
      let i = 0;
      let first = true;
      while (i < sec.bars.length) {
        const songFirst = out.length === 0;
        const prefix = 34 + nFifths * 9 + (songFirst ? 26 : 8);
        const avail = W - 2 * MARGIN - prefix;
        const idx: number[] = [];
        let used = 0;
        while (i < sec.bars.length && idx.length < Math.max(1, barsPerRow)) {
          const w = naturalWidth(melody.bars[flat + i].notes) + 18;
          if (idx.length > 0 && used + w > avail) break;
          idx.push(flat + i);
          used += w;
          i++;
        }
        out.push({ sectionIndex: si, first, barIndexes: idx, songFirst });
        first = false;
      }
      flat += sec.bars.length;
    });
    return out;
  }, [sections, melody, barsPerRow, nFifths]);

  // vertical layout
  let y = 8;
  const rows = systems.map((sys) => {
    const head = sys.first ? SECTION_HEAD : 0;
    const row = { sys, y, head };
    y += head + SYSTEM_H;
    return row;
  });
  const height = y + 6;

  return (
    <svg
      viewBox={`0 0 ${W} ${height}`}
      className="w-full select-none text-foreground print:text-black"
      role="img"
      aria-label="Melody in sheet music notation"
    >
      {rows.map(({ sys, y: sy, head }, ri) => {
        const top = sy + head + STAFF_TOP;
        const bottom = top + 4 * S;
        const prefix = 34 + nFifths * 9 + (sys.songFirst ? 26 : 8);
        const avail = W - 2 * MARGIN - prefix;
        const naturals = sys.barIndexes.map(
          (bi) => naturalWidth(melody.bars[bi].notes) + 18,
        );
        const total = naturals.reduce((a, b) => a + b, 0);
        const factor = Math.min(avail / total, 1.5);
        const widths = naturals.map((n) => n * factor);
        const startX = MARGIN + prefix;
        const endX = startX + widths.reduce((a, b) => a + b, 0);
        const sectionEnd =
          sys.barIndexes[sys.barIndexes.length - 1] ===
          sections
            .slice(0, sys.sectionIndex + 1)
            .reduce((a, s) => a + s.bars.length, 0) -
            1;

        let bx = startX;
        return (
          <g key={ri}>
            {sys.first && (
              <text
                x={MARGIN}
                y={sy + 16}
                className="fill-fuchsia-600 dark:fill-fuchsia-300"
                fontSize={14}
                fontWeight={800}
                style={{ textTransform: "uppercase", letterSpacing: "0.05em" }}
              >
                {sections[sys.sectionIndex].name}
              </text>
            )}

            {/* staff lines */}
            {[0, 1, 2, 3, 4].map((l) => (
              <line
                key={l}
                x1={MARGIN}
                x2={endX}
                y1={top + l * S}
                y2={top + l * S}
                strokeWidth={1}
                className="stroke-current"
                opacity={0.75}
              />
            ))}
            <line
              x1={MARGIN}
              x2={MARGIN}
              y1={top}
              y2={bottom}
              strokeWidth={1.4}
              className="stroke-current"
            />

            {/* clef, key, time */}
            <GlyphPath
              glyph={GLYPHS.gClef}
              x={MARGIN + 6 - GLYPHS.gClef.minX * SC}
              y={bottom}
            />
            <KeySignature fifths={key.fifths} x={MARGIN + 34} bottom={bottom} />
            {sys.songFirst && (
              <g
                fontFamily="Georgia, 'Times New Roman', serif"
                fontWeight={700}
                fontSize={22}
                textAnchor="middle"
                className="fill-current"
              >
                <text x={MARGIN + 34 + nFifths * 9 + 12} y={top + 2 * S - 2}>
                  {beatsPerBar === 6 ? 6 : beatsPerBar}
                </text>
                <text x={MARGIN + 34 + nFifths * 9 + 12} y={top + 4 * S - 2}>
                  {beatsPerBar === 6 ? 8 : 4}
                </text>
              </g>
            )}

            {sys.barIndexes.map((bi, k) => {
              const bar = melody.bars[bi];
              const x0 = bx;
              const w = widths[k];
              bx += w;
              const active = currentIndex === bi;
              const last = k === sys.barIndexes.length - 1;

              // map a sixteenth to an x for chord symbols
              const inner = Math.max(20, w - 16);
              const wholeRest =
                bar.notes.length === 1 &&
                bar.notes[0].deg === null &&
                bar.notes[0].d >= U;
              const slots = layoutBar(
                bar.notes,
                inner / naturalWidth(bar.notes),
              );
              const xAt = (u: number) => {
                if (wholeRest || !slots.length) return x0 + 10;
                const s =
                  slots.find((q) => u >= q.note.u && u < q.note.u + q.note.d) ??
                  slots[0];
                return (
                  x0 + 10 + s.x + ((u - s.note.u) / s.note.d) * s.w * 0.5 + 3
                );
              };

              return (
                <g
                  key={bi}
                  onClick={onBarClick ? () => onBarClick(bi) : undefined}
                  className={onBarClick ? "cursor-pointer" : undefined}
                >
                  {/* hit area + highlight */}
                  <rect
                    x={x0}
                    y={top - 34}
                    width={w}
                    height={4 * S + 86}
                    className={
                      active
                        ? "fill-cyan-400/15 stroke-cyan-400"
                        : "fill-transparent stroke-transparent hover:fill-cyan-400/5"
                    }
                    strokeWidth={active ? 2 : 0}
                  />
                  <text
                    x={x0 + 3}
                    y={top - 24}
                    fontSize={8}
                    className="fill-muted-foreground font-mono print:hidden"
                  >
                    {bi + 1}
                  </text>

                  {showChords &&
                    bar.chords.map((c, ci) => (
                      <text
                        key={ci}
                        x={xAt(c.u)}
                        y={top - 16}
                        fontSize={13}
                        fontWeight={700}
                        fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
                        className="fill-cyan-600 dark:fill-cyan-300 print:fill-black"
                      >
                        {c.chord}
                      </text>
                    ))}

                  <Bar
                    notes={bar.notes}
                    U={U}
                    BU={BU}
                    x0={x0}
                    width={w}
                    top={top}
                    bottom={bottom}
                    keyStep={keyStep}
                  />

                  {/* lyrics */}
                  {(() => {
                    return slots.map((s, si) =>
                      s.note.deg === null || !s.note.text ? null : (
                        <text
                          key={si}
                          x={x0 + 10 + s.x + 8 - 5}
                          y={bottom + 44}
                          fontSize={13.5}
                          className="fill-current"
                        >
                          {s.note.text + (s.note.joinNext ? "-" : "")}
                        </text>
                      ),
                    );
                  })()}

                  {/* bar line */}
                  <line
                    x1={x0 + w}
                    x2={x0 + w}
                    y1={top}
                    y2={bottom}
                    strokeWidth={last && sectionEnd ? 2.4 : 1.2}
                    className="stroke-current"
                  />
                  {last && sectionEnd && (
                    <line
                      x1={x0 + w - 4}
                      x2={x0 + w - 4}
                      y1={top}
                      y2={bottom}
                      strokeWidth={1.2}
                      className="stroke-current"
                    />
                  )}
                </g>
              );
            })}
          </g>
        );
      })}
    </svg>
  );
}
