// lib/sheetModel.ts
// Lays out the melody as sheet music and returns plain drawing primitives
// (lines, rects, noteheads, glyph outlines, text). Both the on-screen sheet
// (app/components/songs/MelodySheet.tsx, as SVG) and the PDF export
// (lib/melodyPdf.ts, as vector PDF) draw from this, so they always match.
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

export const S = 9; // staff space in px
export const SC = S / GLYPH_UNITS_PER_SPACE; // font units -> px
export const SHEET_W = 920; // default drawing width
export const MARGIN = 10;
const UNIT_W = 11; // px per sixteenth for spacing
const STEM = 3.3 * S;
const HEAD_RX = 5.6;
const HEAD_RY = 4.1;

export const SECTION_HEAD = 26;
export const SYSTEM_H = 156;
export const STAFF_TOP = 50; // top staff line, from system top

// treble clef: bottom line = E4, diatonic step 30
const BOTTOM_STEP = 30;

const SHARP_POS = [8, 5, 9, 6, 3, 7, 4]; // F C G D A E B
const FLAT_POS = [4, 7, 3, 6, 2, 5, 1]; // B E A D G C F

/* -------------------------------- primitives ------------------------------- */

export type TextRole = "chord" | "lyric" | "section" | "timesig";

export type Prim =
  | {
      k: "line";
      x1: number;
      y1: number;
      x2: number;
      y2: number;
      w: number;
      opacity?: number;
    }
  | { k: "rect"; x: number; y: number; w: number; h: number }
  | {
      k: "ellipse";
      cx: number;
      cy: number;
      rx: number;
      ry: number;
      rot: number;
      sw: number;
      hollow: boolean;
    }
  | { k: "circle"; cx: number; cy: number; r: number }
  /** A font glyph outline, drawn as translate(x y) scale(SC). */
  | { k: "glyph"; d: string; x: number; y: number }
  /** A stroked curve (note flags), absolute coordinates. */
  | { k: "curve"; d: string; w: number }
  | {
      k: "text";
      role: TextRole;
      x: number;
      y: number;
      text: string;
      size: number;
    };

export interface BarLayout {
  /** Flat bar index. */
  bi: number;
  x0: number;
  w: number;
  top: number;
  bottom: number;
  /** Where the small bar number sits. */
  numX: number;
  numY: number;
  /** Chord symbols, notes, lyrics and the bar line. */
  prims: Prim[];
}

export interface SystemPlan {
  sectionIndex: number;
  first: boolean; // first line of its section
  barIndexes: number[]; // flat bar indexes
  songFirst: boolean;
}

export interface SystemLayout {
  /** Section name, staff, clef, key and time signature. */
  head: Prim[];
  bars: BarLayout[];
  top: number;
  bottom: number;
}

/* ---------------------------------- spacing --------------------------------- */

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

/** Y of a staff step (0 = bottom line) for a system whose bottom line is at `bottom`. */
const yOfPos = (pos: number, bottom: number) => bottom - (pos * S) / 2;

/* ---------------------------------- pieces --------------------------------- */

function glyphPrim(glyph: Glyph, x: number, y: number): Prim {
  return { k: "glyph", d: glyph.d, x, y };
}

function restPrims(d: number, x: number, top: number, bottom: number): Prim[] {
  const mid = top + 2 * S;
  if (d >= 8)
    return d >= 16
      ? [{ k: "rect", x: x - 6, y: top + S, w: 12, h: 4.5 }]
      : [{ k: "rect", x: x - 6, y: mid - 4.5, w: 12, h: 4.5 }];
  const glyph =
    d >= 4 ? GLYPHS.restQuarter : d >= 2 ? GLYPHS.rest8th : GLYPHS.rest16th;
  return [glyphPrim(glyph, x - 4, bottom)];
}

function flagPrims(x: number, y: number, up: boolean, count: number): Prim[] {
  const dir = up ? 1 : -1;
  return Array.from({ length: count }, (_, i) => {
    const dy = i * 6 * dir;
    return {
      k: "curve" as const,
      d: `M${x} ${y + dy * dir} C${x + 1} ${y + dy * dir + 8 * dir} ${x + 10} ${
        y + dy * dir + 11 * dir
      } ${x + 7.5} ${y + dy * dir + 22 * dir}`,
      w: 1.7,
    };
  });
}

interface Placed {
  note: MelodyNote;
  x: number; // notehead centre
  y: number;
  pos: number;
}

function barPrims(
  notes: MelodyNote[],
  U: number,
  BU: number,
  x0: number,
  width: number,
  top: number,
  bottom: number,
  keyStep: (deg: number) => number,
): Prim[] {
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

  const els: Prim[] = [];

  // Beams
  groups.forEach((g) => {
    const pts = g.map((i) => placed[i] as Placed);
    const avg = pts.reduce((a, p) => a + p.pos, 0) / pts.length;
    const up = avg < 4;
    const yb = up
      ? Math.min(...pts.map((p) => p.y)) - STEM
      : Math.max(...pts.map((p) => p.y)) + STEM;
    const sx = (p: Placed) => (up ? p.x + HEAD_RX - 0.5 : p.x - HEAD_RX + 0.5);
    pts.forEach((p) => {
      els.push({ k: "line", x1: sx(p), x2: sx(p), y1: p.y, y2: yb, w: 1.4 });
    });
    const thick = 3.6;
    const rect = (x1: number, x2: number, level: number) => {
      const y = up ? yb + level * 5.4 : yb - level * 5.4 - thick;
      els.push({ k: "rect", x: x1, y, w: Math.max(1, x2 - x1), h: thick });
    };
    rect(sx(pts[0]), sx(pts[pts.length - 1]), 0);
    // second beam for sixteenths
    pts.forEach((p, k) => {
      if (p.note.d !== 1) return;
      const nextIs16 = pts[k + 1]?.note.d === 1;
      const prevIs16 = pts[k - 1]?.note.d === 1;
      if (nextIs16) rect(sx(p), sx(pts[k + 1]), 1);
      else if (!prevIs16)
        rect(
          k === pts.length - 1 ? sx(p) - 7 : sx(p),
          k === pts.length - 1 ? sx(p) : sx(p) + 7,
          1,
        );
    });
  });

  // Noteheads, stems, flags, dots, ledger lines, rests
  slots.forEach((s, i) => {
    const n = s.note;
    if (n.deg === null) {
      restPieces(n.d).reduce((off, piece) => {
        const px = left + s.x + 8 + (off / n.d) * s.w * 0.9;
        els.push(...restPrims(piece, px, top, bottom));
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
      els.push({
        k: "line",
        x1: p.x - 9,
        x2: p.x + 9,
        y1: yOfPos(l, bottom),
        y2: yOfPos(l, bottom),
        w: 1.2,
      }),
    );

    // stem + flag for unbeamed notes
    if (n.d < 16 && !beamed) {
      const sx = up ? p.x + HEAD_RX - 0.5 : p.x - HEAD_RX + 0.5;
      const tip = up ? p.y - STEM : p.y + STEM;
      els.push({ k: "line", x1: sx, x2: sx, y1: p.y, y2: tip, w: 1.4 });
      if (n.d <= 3) els.push(...flagPrims(sx, tip, up, n.d === 1 ? 2 : 1));
    }

    els.push({
      k: "ellipse",
      cx: p.x,
      cy: p.y,
      rx: HEAD_RX,
      ry: HEAD_RY,
      rot: -20,
      sw: hollow ? 1.6 : 0.6,
      hollow,
    });

    if (n.d === 3 || n.d === 6 || n.d === 12) {
      const dotY = p.pos % 2 === 0 ? p.y - S / 2 : p.y;
      els.push({ k: "circle", cx: p.x + 10, cy: dotY, r: 1.7 });
    }
  });

  if (wholeRest) {
    els.push({
      k: "rect",
      x: left + inner / 2 - 6,
      y: top + S,
      w: 12,
      h: 4.5,
    });
  }

  return els;
}

function keySignaturePrims(fifths: number, x: number, bottom: number): Prim[] {
  const sharp = fifths > 0;
  const list = (sharp ? SHARP_POS : FLAT_POS).slice(0, Math.abs(fifths));
  const g = sharp ? GLYPHS.sharp : GLYPHS.flat;
  const h = g.maxY - g.minY;
  const anchor = sharp ? (g.minY + g.maxY) / 2 : g.maxY - 0.33 * h;
  return list.map((pos, i) =>
    glyphPrim(g, x + i * 9 - g.minX * SC, yOfPos(pos, bottom) - anchor * SC),
  );
}

/* --------------------------------- the sheet -------------------------------- */

/** Which bars go on which staff line. */
export function planSystems(
  melody: Melody,
  sections: SongSection[],
  barsPerRow: number,
  width: number = SHEET_W,
): SystemPlan[] {
  const nFifths = Math.abs(melody.key.fifths);
  const out: SystemPlan[] = [];
  let flat = 0;
  sections.forEach((sec, si) => {
    let i = 0;
    let first = true;
    while (i < sec.bars.length) {
      const songFirst = out.length === 0;
      const prefix = 34 + nFifths * 9 + (songFirst ? 26 : 8);
      const avail = width - 2 * MARGIN - prefix;
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
}

/** Height of a planned system, including the section heading when it has one. */
export const systemHeight = (sys: SystemPlan) =>
  (sys.first ? SECTION_HEAD : 0) + SYSTEM_H;

/**
 * Lays out one staff line. `sy` is the y of the top of the system (above the
 * section heading, if there is one).
 */
export function layoutSystem(
  sys: SystemPlan,
  melody: Melody,
  sections: SongSection[],
  opts: { width?: number; showChords?: boolean; sy?: number } = {},
): SystemLayout {
  const width = opts.width ?? SHEET_W;
  const showChords = opts.showChords ?? true;
  const sy = opts.sy ?? 0;

  const { key, beatsPerBar, unitsPerBar: U } = melody;
  const BU = beatUnits(beatsPerBar);
  const keyStep = (deg: number) => degreeToStep(key, deg);
  const nFifths = Math.abs(key.fifths);

  const head = sys.first ? SECTION_HEAD : 0;
  const top = sy + head + STAFF_TOP;
  const bottom = top + 4 * S;
  const prefix = 34 + nFifths * 9 + (sys.songFirst ? 26 : 8);
  const avail = width - 2 * MARGIN - prefix;
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

  /* ---- section name, staff lines, clef, key, time ---- */
  const headPrims: Prim[] = [];
  if (sys.first) {
    headPrims.push({
      k: "text",
      role: "section",
      x: MARGIN,
      y: sy + 16,
      text: sections[sys.sectionIndex].name,
      size: 14,
    });
  }
  for (let l = 0; l < 5; l++) {
    headPrims.push({
      k: "line",
      x1: MARGIN,
      x2: endX,
      y1: top + l * S,
      y2: top + l * S,
      w: 1,
      opacity: 0.75,
    });
  }
  headPrims.push({
    k: "line",
    x1: MARGIN,
    x2: MARGIN,
    y1: top,
    y2: bottom,
    w: 1.4,
  });
  headPrims.push(
    glyphPrim(GLYPHS.gClef, MARGIN + 6 - GLYPHS.gClef.minX * SC, bottom),
  );
  headPrims.push(...keySignaturePrims(key.fifths, MARGIN + 34, bottom));
  if (sys.songFirst) {
    const tx = MARGIN + 34 + nFifths * 9 + 12;
    headPrims.push({
      k: "text",
      role: "timesig",
      x: tx,
      y: top + 2 * S - 2,
      text: String(beatsPerBar === 6 ? 6 : beatsPerBar),
      size: 22,
    });
    headPrims.push({
      k: "text",
      role: "timesig",
      x: tx,
      y: top + 4 * S - 2,
      text: String(beatsPerBar === 6 ? 8 : 4),
      size: 22,
    });
  }

  /* ---- bars ---- */
  let bx = startX;
  const bars: BarLayout[] = sys.barIndexes.map((bi, k) => {
    const bar = melody.bars[bi];
    const x0 = bx;
    const w = widths[k];
    bx += w;
    const last = k === sys.barIndexes.length - 1;

    // map a sixteenth to an x for chord symbols
    const inner = Math.max(20, w - 16);
    const wholeRest =
      bar.notes.length === 1 &&
      bar.notes[0].deg === null &&
      bar.notes[0].d >= U;
    const slots = layoutBar(bar.notes, inner / naturalWidth(bar.notes));
    const xAt = (u: number) => {
      if (wholeRest || !slots.length) return x0 + 10;
      const s =
        slots.find((q) => u >= q.note.u && u < q.note.u + q.note.d) ?? slots[0];
      return x0 + 10 + s.x + ((u - s.note.u) / s.note.d) * s.w * 0.5 + 3;
    };

    const prims: Prim[] = [];

    if (showChords)
      bar.chords.forEach((c) =>
        prims.push({
          k: "text",
          role: "chord",
          x: xAt(c.u),
          y: top - 16,
          text: c.chord,
          size: 13,
        }),
      );

    prims.push(...barPrims(bar.notes, U, BU, x0, w, top, bottom, keyStep));

    // lyrics
    slots.forEach((s) => {
      if (s.note.deg === null || !s.note.text) return;
      prims.push({
        k: "text",
        role: "lyric",
        x: x0 + 10 + s.x + 8 - 5,
        y: bottom + 44,
        text: s.note.text + (s.note.joinNext ? "-" : ""),
        size: 13.5,
      });
    });

    // bar line
    prims.push({
      k: "line",
      x1: x0 + w,
      x2: x0 + w,
      y1: top,
      y2: bottom,
      w: last && sectionEnd ? 2.4 : 1.2,
    });
    if (last && sectionEnd)
      prims.push({
        k: "line",
        x1: x0 + w - 4,
        x2: x0 + w - 4,
        y1: top,
        y2: bottom,
        w: 1.2,
      });

    return { bi, x0, w, top, bottom, numX: x0 + 3, numY: top - 24, prims };
  });

  return { head: headPrims, bars, top, bottom };
}
