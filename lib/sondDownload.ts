// lib/songDownload.ts
// Browser downloads for a song:
//   - the melody as sheet music (PDF)
//   - the melody as a MIDI file
//   - everything in one ZIP: lyrics + chords (PDF), melody sheet (PDF), melody (MIDI)
import type { Melody } from "@/lib/melody";
import { buildMelodyPdf, type MelodyPdfOptions } from "@/lib/melodyPdf";
import { buildSongMidi } from "@/lib/songMidi";
import { buildSongPdf, type SongPdfOptions } from "@/lib/songPdf";
import { buildZip } from "@/lib/zip";

export function fileSlug(title: string): string {
  const slug = title
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .toLowerCase();
  return slug || "song";
}

function saveBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

// Copy into a fresh ArrayBuffer-backed array so it is always a valid BlobPart.
const toBlob = (data: Uint8Array, type: string) =>
  new Blob([new Uint8Array(data)], { type });

export interface SongMidiDownload {
  title: string;
  bpm: number;
  melody: Melody;
  includeChords?: boolean;
}

/** Downloads the melody (and chords) as a .mid file. */
export function downloadSongMidi(o: SongMidiDownload): void {
  const bytes = buildSongMidi(o);
  saveBlob(toBlob(bytes, "audio/midi"), `${fileSlug(o.title)}-melody.mid`);
}

/** Downloads the melody as printable sheet music (PDF). */
export async function downloadMelodySheetPdf(
  o: MelodyPdfOptions,
): Promise<void> {
  const doc = await buildMelodyPdf(o);
  doc.save(`${fileSlug(o.title)}-melody-sheet.pdf`);
}

/**
 * Downloads one ZIP holding the lyrics + chords PDF, the melody sheet PDF
 * and the melody MIDI.
 */
export async function downloadSongBundle(
  pdf: SongPdfOptions,
  sheet: MelodyPdfOptions,
  midi: SongMidiDownload,
): Promise<void> {
  const slug = fileSlug(pdf.title);
  const [chartDoc, sheetDoc] = await Promise.all([
    buildSongPdf(pdf),
    buildMelodyPdf(sheet),
  ]);
  const zip = buildZip([
    {
      name: `${slug}-lyrics-and-chords.pdf`,
      data: new Uint8Array(chartDoc.output("arraybuffer")),
    },
    {
      name: `${slug}-melody-sheet.pdf`,
      data: new Uint8Array(sheetDoc.output("arraybuffer")),
    },
    { name: `${slug}-melody.mid`, data: buildSongMidi(midi) },
  ]);
  saveBlob(toBlob(zip, "application/zip"), `${slug}.zip`);
}
