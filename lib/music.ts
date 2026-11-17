// lib/music.ts
// Pure helpers: transposing, chord → notes for playback, plain-text export.
import type { SongSection } from "@/lib/songTypes";

const SHARP = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const FLAT = ["C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B"];

// Pitch classes of keys that are conventionally written with flats.
const FLAT_MAJOR = new Set([5, 10, 3, 8, 1, 6]); // F Bb Eb Ab Db Gb
const FLAT_MINOR = new Set([2, 7, 0, 5, 10, 3]); // Dm Gm Cm Fm Bbm Ebm

function pitchClass(letter: string, accidental: string): number {
  const base = SHARP.indexOf(letter);
  if (accidental === "#") return (base + 1) % 12;
  if (accidental === "b") return (base + 11) % 12;
  return base;
}

const CHORD_PARTS = /^([A-G])([#b]?)([^/]*)(?:\/([A-G])([#b]?))?$/;

function shiftNote(pc: number, steps: number, flats: boolean): string {
  const i = (((pc + steps) % 12) + 12) % 12;
  return (flats ? FLAT : SHARP)[i];
}

/** Should the transposed song use flat names? Decided from the new key. */
export function prefersFlats(key: string, steps: number): boolean {
  const m = /^([A-G])([#b]?)(m?)$/.exec(key);
  if (!m) return false;
  const pc = (pitchClass(m[1], m[2]) + steps + 120) % 12;
  return m[3] ? FLAT_MINOR.has(pc) : FLAT_MAJOR.has(pc);
}

export function transposeChord(
  chord: string,
  steps: number,
  flats: boolean,
): string {
  const m = CHORD_PARTS.exec(chord);
  if (!m) return chord;
  const [, letter, acc, suffix, bassLetter, bassAcc] = m;
  const root = shiftNote(pitchClass(letter, acc), steps, flats);
  const bass = bassLetter
    ? "/" + shiftNote(pitchClass(bassLetter, bassAcc), steps, flats)
    : "";
  return root + suffix + bass;
}

export function transposeKey(key: string, steps: number): string {
  const m = /^([A-G])([#b]?)(m?)$/.exec(key);
  if (!m) return key;
  return (
    shiftNote(pitchClass(m[1], m[2]), steps, prefersFlats(key, steps)) + m[3]
  );
}

export function transposeSections(
  sections: SongSection[],
  key: string,
  steps: number,
): SongSection[] {
  if (steps === 0) return sections;
  const flats = prefersFlats(key, steps);
  return sections.map((s) => ({
    ...s,
    bars: s.bars.map((b) => ({
      segments: b.segments.map((seg) =>
        seg.chord
          ? { ...seg, chord: transposeChord(seg.chord, steps, flats) }
          : seg,
      ),
    })),
  }));
}

/* ------------------------------ chord playback ------------------------------ */

/** Frequencies (Hz) for a simple pad voicing of the chord, bass note first. */
export function chordFrequencies(chord: string): number[] {
  const m = CHORD_PARTS.exec(chord);
  if (!m) return [];
  const [, letter, acc, suffix, bassLetter, bassAcc] = m;
  const pc = pitchClass(letter, acc);

  let third = 4;
  let fifth = 7;
  const extra: number[] = [];

  if (/^(m(?!aj)|min|-)/.test(suffix)) third = 3;
  if (/dim|°/.test(suffix)) {
    third = 3;
    fifth = 6;
  }
  if (/aug|\+/.test(suffix)) fifth = 8;
  if (/sus2/.test(suffix)) third = 2;
  else if (/sus/.test(suffix)) third = 5;
  if (/maj7|M7|Δ/.test(suffix)) extra.push(11);
  else if (/dim.*7/.test(suffix)) extra.push(9);
  else if (/7/.test(suffix)) extra.push(10);
  if (/9/.test(suffix)) extra.push(14);

  // Keep every chord in a comfortable register around C3–B3.
  const base = 48 + pc - (pc > 6 ? 12 : 0);
  const bassMidi = bassLetter
    ? 36 + pitchClass(bassLetter, bassAcc)
    : base - 12;

  const midi = [
    bassMidi,
    base,
    base + third,
    base + fifth,
    ...extra.map((e) => base + e),
  ];
  return midi.map((n) => 440 * Math.pow(2, (n - 69) / 12));
}

/* -------------------------------- text export -------------------------------- */

/** Chords-over-lyrics plain text, bars separated by "|", for copy / paste. */
export function formatSongText(
  title: string,
  key: string,
  tempo: number,
  sections: SongSection[],
  barsPerRow = 4,
): string {
  const out: string[] = [title, `Key: ${key}   Tempo: ${tempo} BPM`, ""];

  for (const section of sections) {
    out.push(`[${section.name}]`);
    for (let i = 0; i < section.bars.length; i += barsPerRow) {
      let chordLine = "|";
      let lyricLine = "|";
      for (const bar of section.bars.slice(i, i + barsPerRow)) {
        let chords = " ";
        let lyrics = " ";
        for (const seg of bar.segments) {
          const c = seg.chord ?? "";
          const width = Math.max(c.length + 1, seg.lyric.length);
          chords += c.padEnd(width);
          lyrics += seg.lyric.padEnd(width);
        }
        const w = Math.max(chords.length, lyrics.length) + 1;
        chordLine += chords.padEnd(w) + "|";
        lyricLine += lyrics.padEnd(w) + "|";
      }
      out.push(chordLine, lyricLine.trimEnd(), "");
    }
  }
  return out.join("\n").trimEnd() + "\n";
}
