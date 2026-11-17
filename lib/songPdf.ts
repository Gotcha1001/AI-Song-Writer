// lib/songPdf.ts
// Builds a real, selectable-text A4 PDF of the chord chart (no browser print dialog).
// Needs:  npm i jspdf
import type { jsPDF } from "jspdf";
import type { SongSection } from "@/lib/songTypes";

export interface SongPdfOptions {
  title: string;
  key: string;
  tempo: number;
  beatsPerBar: number;
  /** e.g. "Pop · Hopeful" */
  subtitle?: string;
  sections: SongSection[];
  barsPerRow: number; // 1–4
  showChords: boolean;
  showLyrics: boolean;
  /** 0.8–1.6, same slider as the on-screen chart */
  textScale: number;
}

const PT = 0.3528; // 1 pt in mm
const PAGE_W = 210;
const PAGE_H = 297;
const MARGIN = 14;
const FOOTER = 10;

/** Standard PDF fonts cover Latin-1 only: keep é, ü, ñ …, swap the rest. */
function safe(s: string): string {
  return s
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2013\u2014]/g, "-")
    .replace(/\u2026/g, "...")
    .replace(/♭/g, "b")
    .replace(/♯/g, "#")
    .split("")
    .map((ch) => (ch.charCodeAt(0) <= 255 ? ch : "?"))
    .join("");
}

interface Placed {
  x: number;
  chord?: string;
  lyric: string;
}

export async function buildSongPdf(o: SongPdfOptions): Promise<jsPDF> {
  const { jsPDF: PDF } = await import("jspdf");
  const doc = new PDF({ unit: "mm", format: "a4", compress: true });
  doc.setProperties({ title: safe(o.title), creator: "Song Writer" });

  const contentW = PAGE_W - MARGIN * 2;
  const perRow = Math.min(4, Math.max(1, o.barsPerRow));
  const barW = contentW / perRow;
  const pad = 2.2;
  const innerW = barW - pad * 2;

  const scale = Math.min(1.4, Math.max(0.8, o.textScale));
  const fs = 10 * scale; // pt
  const fsMm = fs * PT;
  const bothLines = o.showChords && o.showLyrics;
  const lineH = bothLines ? fsMm * 2.75 : fsMm * 1.7;
  const topPad = 4.2; // room for the bar number
  const bottomPad = 1.8;
  const bottomLimit = PAGE_H - MARGIN - FOOTER;

  // A line with chords needs the full chord+lyric height; a wrapped
  // lyric-only continuation line only needs a normal line of text.
  const heightOf = (line: Placed[]): number =>
    bothLines && !line.some((p) => p.chord) ? fsMm * 1.6 : lineH;

  let y = MARGIN;

  /* ------------------------------- header ------------------------------- */
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
    `Key ${o.key}`,
    `${o.tempo} BPM`,
    `${o.beatsPerBar}/4`,
    o.subtitle,
  ]
    .filter(Boolean)
    .join("   ·   ");
  doc.text(safe(meta), MARGIN, y + 6);
  y += 9;
  doc.setDrawColor(120, 120, 140);
  doc.setLineWidth(0.4);
  doc.line(MARGIN, y, PAGE_W - MARGIN, y);
  y += 7;

  /* ----------------------------- layout a bar ---------------------------- */
  const layoutBar = (bar: SongSection["bars"][number]): Placed[][] => {
    const lines: Placed[][] = [[]];
    let x = 0;
    doc.setFontSize(fs);
    for (const seg of bar.segments) {
      const chord = o.showChords && seg.chord ? safe(seg.chord) : undefined;
      const lyric = o.showLyrics ? safe(seg.lyric) : "";
      doc.setFont("helvetica", "bold");
      const chordW = chord ? doc.getTextWidth(chord) + 2 : 0;
      doc.setFont("helvetica", "normal");
      const lyricW = lyric ? doc.getTextWidth(lyric) : 0;
      const w = Math.max(chordW, lyricW, 3);

      // A lyric wider than the whole bar wraps onto extra lines inside it.
      if (lyricW > innerW) {
        const parts = doc.splitTextToSize(lyric, innerW) as string[];
        if (x > 0) {
          lines.push([]);
          x = 0;
        }
        parts.forEach((part, pi) => {
          if (pi > 0) lines.push([]);
          lines[lines.length - 1].push({
            x: 0,
            chord: pi === 0 ? chord : undefined,
            lyric: part,
          });
        });
        x = innerW; // the next segment starts a fresh line
        continue;
      }

      if (x > 0 && x + w > innerW) {
        lines.push([]);
        x = 0;
      }
      lines[lines.length - 1].push({ x, chord, lyric });
      x += w;
    }
    return lines;
  };

  /* ------------------------------- sections ------------------------------ */
  let barNumber = 0;

  for (const section of o.sections) {
    const headerH = 9;
    // Keep the heading together with its first row of bars.
    if (y + headerH + topPad + lineH + bottomPad > bottomLimit) {
      doc.addPage();
      y = MARGIN;
    }

    doc.setFont("helvetica", "bold");
    doc.setFontSize(11);
    doc.setTextColor(120, 30, 120);
    const name = safe(section.name).toUpperCase();
    doc.text(name, MARGIN, y + 4.5);
    const nameW = doc.getTextWidth(name);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(8);
    doc.setTextColor(130, 130, 145);
    doc.text(`${section.bars.length} bars`, MARGIN + nameW + 3, y + 4.5);
    y += headerH;

    for (let i = 0; i < section.bars.length; i += perRow) {
      const rowBars = section.bars.slice(i, i + perRow);
      const laid = rowBars.map(layoutBar);
      const contentH = Math.max(
        ...laid.map((lines) =>
          lines.reduce((sum, line) => sum + heightOf(line), 0),
        ),
      );
      const rowH = topPad + contentH + bottomPad;

      if (y + rowH > bottomLimit) {
        doc.addPage();
        y = MARGIN;
      }

      laid.forEach((lines, b) => {
        const bx = MARGIN + b * barW;
        barNumber += 1;

        // cell border
        doc.setDrawColor(150, 160, 175);
        doc.setLineWidth(0.25);
        doc.rect(bx, y, barW, rowH);

        // bar number
        doc.setFont("helvetica", "normal");
        doc.setFontSize(6);
        doc.setTextColor(165, 165, 175);
        doc.text(String(barNumber), bx + 0.9, y + 2.4);

        let top = y + topPad;
        lines.forEach((line) => {
          const hasChord = line.some((p) => p.chord);
          for (const p of line) {
            const px = bx + pad + p.x;
            if (p.chord) {
              doc.setFont("helvetica", "bold");
              doc.setFontSize(fs);
              doc.setTextColor(15, 70, 150);
              doc.text(p.chord, px, top + fsMm * 0.95);
            }
            if (p.lyric.trim()) {
              doc.setFont("helvetica", "normal");
              doc.setFontSize(fs);
              doc.setTextColor(20, 20, 30);
              const ly =
                bothLines && hasChord ? top + fsMm * 2.1 : top + fsMm * 0.95;
              doc.text(p.lyric, px, ly);
            }
          }
          top += heightOf(line);
        });
      });
      y += rowH;
    }
    y += 6;
  }

  /* -------------------------------- footer ------------------------------- */
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

export function pdfFileName(title: string): string {
  const slug = title
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .toLowerCase();
  return `${slug || "song"}.pdf`;
}

/** Builds the PDF and triggers a normal browser download. */
export async function downloadSongPdf(o: SongPdfOptions): Promise<void> {
  const doc = await buildSongPdf(o);
  doc.save(pdfFileName(o.title));
}
