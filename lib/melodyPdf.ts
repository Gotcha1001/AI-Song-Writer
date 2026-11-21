// lib/melodyPdf.ts
// Builds an A4 PDF of the melody as sheet music: treble clef, key signature,
// beamed notes, rests, chord symbols and the lyric under every note.
// It draws the very same layout as the on-screen sheet (lib/sheetModel.ts),
// as crisp vector graphics with selectable text.
import type { jsPDF } from "jspdf";
import type { Melody } from "@/lib/melody";
import { timeSignatureLabel } from "@/convex/lib/songOptions";
import {
  MARGIN as SHEET_MARGIN,
  SC,
  SECTION_HEAD,
  layoutSystem,
  planSystems,
  type Prim,
} from "@/lib/SheetModel";
import { safe } from "@/lib/songPdf";
import type { SongSection } from "@/lib/songTypes";

export interface MelodyPdfOptions {
  title: string;
  key: string;
  tempo: number;
  beatsPerBar: number;
  /** e.g. "Pop · Hopeful" */
  subtitle?: string;
  melody: Melody;
  sections: SongSection[];
  /** Most bars on one staff line (1–4). */
  barsPerRow: number;
  showChords: boolean;
}

const PT = 0.3528; // 1 pt in mm
const PAGE_W = 210;
const PAGE_H = 297;
const MARGIN = 14;
const FOOTER = 10;

// The sheet is laid out on a narrower "canvas" than the screen so the notes
// and lyrics print at a comfortable size on A4.
const CANVAS_W = 760;
const SYSTEM_PX = 140; // staff line + chords above + lyrics below
const K = (PAGE_W - 2 * MARGIN) / (CANVAS_W - 2 * SHEET_MARGIN); // mm per px

/* ------------------------------ path handling ------------------------------ */

type Seg =
  | { c: "M" | "L"; x: number; y: number }
  | {
      c: "C";
      x1: number;
      y1: number;
      x2: number;
      y2: number;
      x: number;
      y: number;
    }
  | { c: "Z" };

const ARGS: Record<string, number> = {
  M: 2,
  L: 2,
  H: 1,
  V: 1,
  Q: 4,
  C: 6,
  Z: 0,
};

/** Reads the small subset of SVG path syntax used by the notation glyphs (absolute M L H V Q C Z). */
function parsePath(d: string): Seg[] {
  const toks = d.match(/[MLHVQCZ]|-?\d*\.?\d+/g) ?? [];
  const out: Seg[] = [];
  let i = 0;
  let cx = 0;
  let cy = 0;
  let sx = 0;
  let sy = 0;
  let cmd = "";
  while (i < toks.length) {
    if (/[A-Z]/.test(toks[i])) cmd = toks[i++];
    const n = ARGS[cmd];
    if (n === undefined) break;
    if (cmd === "Z") {
      out.push({ c: "Z" });
      cx = sx;
      cy = sy;
      continue;
    }
    // Numbers may repeat the same command (and after M they mean "line to").
    do {
      const a = toks.slice(i, i + n).map(Number);
      i += n;
      if (cmd === "M") {
        cx = sx = a[0];
        cy = sy = a[1];
        out.push({ c: "M", x: cx, y: cy });
        cmd = "L";
      } else if (cmd === "L") {
        cx = a[0];
        cy = a[1];
        out.push({ c: "L", x: cx, y: cy });
      } else if (cmd === "H") {
        cx = a[0];
        out.push({ c: "L", x: cx, y: cy });
      } else if (cmd === "V") {
        cy = a[0];
        out.push({ c: "L", x: cx, y: cy });
      } else if (cmd === "Q") {
        // quadratic -> cubic
        const [qx, qy, x, y] = a;
        out.push({
          c: "C",
          x1: cx + (2 / 3) * (qx - cx),
          y1: cy + (2 / 3) * (qy - cy),
          x2: x + (2 / 3) * (qx - x),
          y2: y + (2 / 3) * (qy - y),
          x,
          y,
        });
        cx = x;
        cy = y;
      } else {
        out.push({
          c: "C",
          x1: a[0],
          y1: a[1],
          x2: a[2],
          y2: a[3],
          x: a[4],
          y: a[5],
        });
        cx = a[4];
        cy = a[5];
      }
    } while (i < toks.length && !/[A-Z]/.test(toks[i]));
  }
  return out;
}

/* --------------------------------- drawing --------------------------------- */

const INK: [number, number, number] = [20, 20, 30];
const CHORD: [number, number, number] = [15, 70, 150];
const SECTION: [number, number, number] = [120, 30, 120];
const FAINT: [number, number, number] = [165, 165, 175];

class Pen {
  constructor(
    private doc: jsPDF,
    /** page position (mm) of the sheet's left margin and of the system's top */
    private ox: number,
    private oy: number,
  ) {}

  X = (x: number) => this.ox + (x - SHEET_MARGIN) * K;
  Y = (y: number) => this.oy + y * K;

  /** Fill and/or stroke a path made of several parts (so holes in glyphs stay holes). */
  private path(
    segs: Seg[],
    map: (x: number, y: number) => [number, number],
    op: "f" | "S" | "B",
  ) {
    // jsPDF has no multi-part filled path call, so we write the raw PDF
    // operators (m, l, c, h, f, S, B). Those use points with y pointing up,
    // unlike the rest of jsPDF's API (millimetres, y down), so convert here.
    const internal = this.doc.internal as unknown as {
      write: (s: string) => void;
      scaleFactor: number;
      pageSize: { getHeight: () => number };
    };
    const sf = internal.scaleFactor;
    const pageH = internal.pageSize.getHeight();
    const n = (v: number) => v.toFixed(3);
    const pt = (x: number, y: number): [number, number] => [
      x * sf,
      (pageH - y) * sf,
    ];
    const w = (s: string) => internal.write(s);
    for (const s of segs) {
      if (s.c === "M" || s.c === "L") {
        const [x, y] = pt(...map(s.x, s.y));
        w(`${n(x)} ${n(y)} ${s.c === "M" ? "m" : "l"}`);
      } else if (s.c === "C") {
        const [a, b] = pt(...map(s.x1, s.y1));
        const [c, d] = pt(...map(s.x2, s.y2));
        const [e, f] = pt(...map(s.x, s.y));
        w(`${n(a)} ${n(b)} ${n(c)} ${n(d)} ${n(e)} ${n(f)} c`);
      } else w("h");
    }
    w(op);
  }

  draw(p: Prim) {
    const { doc } = this;
    switch (p.k) {
      case "line": {
        // opacity .75 black on white
        const c =
          p.opacity !== undefined ? Math.round(255 * (1 - p.opacity)) : null;
        if (c !== null) doc.setDrawColor(c, c, c);
        else doc.setDrawColor(...INK);
        doc.setLineWidth(p.w * K);
        doc.line(this.X(p.x1), this.Y(p.y1), this.X(p.x2), this.Y(p.y2));
        return;
      }
      case "rect":
        doc.setFillColor(...INK);
        doc.rect(this.X(p.x), this.Y(p.y), p.w * K, p.h * K, "F");
        return;
      case "circle":
        doc.setFillColor(...INK);
        doc.circle(this.X(p.cx), this.Y(p.cy), p.r * K, "F");
        return;
      case "glyph": {
        doc.setFillColor(...INK);
        this.path(
          parsePath(p.d),
          (x, y) => [this.X(p.x + x * SC), this.Y(p.y + y * SC)],
          "f",
        );
        return;
      }
      case "curve": {
        doc.setDrawColor(...INK);
        doc.setLineWidth(p.w * K);
        this.path(parsePath(p.d), (x, y) => [this.X(x), this.Y(y)], "S");
        return;
      }
      case "ellipse": {
        const kap = 0.5522847498;
        const a = (p.rot * Math.PI) / 180;
        const cos = Math.cos(a);
        const sin = Math.sin(a);
        const rot = (x: number, y: number): [number, number] => [
          p.cx + x * cos - y * sin,
          p.cy + x * sin + y * cos,
        ];
        const { rx, ry } = p;
        const pts: [number, number][][] = [
          [
            [rx, kap * ry],
            [kap * rx, ry],
            [0, ry],
          ],
          [
            [-kap * rx, ry],
            [-rx, kap * ry],
            [-rx, 0],
          ],
          [
            [-rx, -kap * ry],
            [-kap * rx, -ry],
            [0, -ry],
          ],
          [
            [kap * rx, -ry],
            [rx, -kap * ry],
            [rx, 0],
          ],
        ];
        const segs: Seg[] = [{ c: "M", x: rot(rx, 0)[0], y: rot(rx, 0)[1] }];
        for (const [c1, c2, e] of pts) {
          const [x1, y1] = rot(...c1);
          const [x2, y2] = rot(...c2);
          const [x, y] = rot(...e);
          segs.push({ c: "C", x1, y1, x2, y2, x, y });
        }
        segs.push({ c: "Z" });
        if (p.hollow) doc.setFillColor(255, 255, 255);
        else doc.setFillColor(...INK);
        doc.setDrawColor(...INK);
        doc.setLineWidth(p.sw * K);
        this.path(segs, (x, y) => [this.X(x), this.Y(y)], "B");
        return;
      }
      case "text": {
        const pt = (p.size * K) / PT;
        let text = p.text;
        if (p.role === "chord") {
          doc.setFont("courier", "bold");
          doc.setTextColor(...CHORD);
        } else if (p.role === "section") {
          doc.setFont("helvetica", "bold");
          doc.setTextColor(...SECTION);
          text = text.toUpperCase();
        } else if (p.role === "timesig") {
          doc.setFont("times", "bold");
          doc.setTextColor(...INK);
        } else {
          doc.setFont("helvetica", "normal");
          doc.setTextColor(...INK);
        }
        doc.setFontSize(pt);
        doc.text(safe(text), this.X(p.x), this.Y(p.y), {
          align: p.role === "timesig" ? "center" : "left",
        });
      }
    }
  }
}

/* --------------------------------- the PDF --------------------------------- */

export async function buildMelodyPdf(o: MelodyPdfOptions): Promise<jsPDF> {
  const { jsPDF: PDF } = await import("jspdf");
  const doc = new PDF({ unit: "mm", format: "a4", compress: true });
  doc.setProperties({
    title: safe(`${o.title} - melody`),
    creator: "Song Writer",
  });

  const contentW = PAGE_W - MARGIN * 2;
  const bottomLimit = PAGE_H - MARGIN - FOOTER;
  let y = MARGIN;

  /* header */
  doc.setFont("helvetica", "bold");
  doc.setFontSize(22);
  doc.setTextColor(20, 20, 30);
  const titleLines = doc.splitTextToSize(safe(o.title), contentW) as string[];
  doc.text(titleLines, MARGIN, y + 7);
  y += 7 + (titleLines.length - 1) * 9;

  doc.setFont("helvetica", "normal");
  doc.setFontSize(10);
  doc.setTextColor(95, 95, 110);
  const meta = [
    "Melody",
    `Key ${o.key}`,
    `${o.tempo} BPM`,
    timeSignatureLabel(o.beatsPerBar),
    o.subtitle,
  ]
    .filter(Boolean)
    .join("   ·   ");
  doc.text(safe(meta), MARGIN, y + 6);
  y += 9;
  doc.setDrawColor(120, 120, 140);
  doc.setLineWidth(0.4);
  doc.line(MARGIN, y, PAGE_W - MARGIN, y);
  y += 5;

  /* staff lines */
  const systems = planSystems(o.melody, o.sections, o.barsPerRow, CANVAS_W);
  for (const sys of systems) {
    const h = ((sys.first ? SECTION_HEAD : 0) + SYSTEM_PX) * K;
    if (y + h > bottomLimit) {
      doc.addPage();
      y = MARGIN;
    }
    const layout = layoutSystem(sys, o.melody, o.sections, {
      width: CANVAS_W,
      showChords: o.showChords,
      sy: 0,
    });
    const pen = new Pen(doc, MARGIN, y);
    layout.head.forEach((p) => pen.draw(p));
    for (const bar of layout.bars) {
      // small bar number
      doc.setFont("helvetica", "normal");
      doc.setFontSize((8 * K) / PT);
      doc.setTextColor(...FAINT);
      doc.text(String(bar.bi + 1), pen.X(bar.numX), pen.Y(bar.numY));
      bar.prims.forEach((p) => pen.draw(p));
    }
    y += h;
  }

  /* footer */
  const pages = doc.getNumberOfPages();
  for (let p = 1; p <= pages; p++) {
    doc.setPage(p);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(8);
    doc.setTextColor(150, 150, 160);
    doc.text(safe(o.title), MARGIN, PAGE_H - 8);
    doc.text(`Page ${p} of ${pages}`, PAGE_W - MARGIN, PAGE_H - 8, {
      align: "right",
    });
  }
  return doc;
}
