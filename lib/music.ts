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

export interface ChordTones {
  /** Pitch class (0-11) of the root. */
  root: number;
  /** Pitch class of the bass note (the slash note, or the root). */
  bass: number;
  /** Semitone intervals above the root, e.g. [0, 4, 7, 10]. */
  intervals: number[];
  /** The same notes as absolute pitch classes (0-11). */
  pcs: number[];
}

/** Break a chord symbol into its notes. Returns null if it can't be read. */
export function chordTones(chord: string): ChordTones | null {
  const m = CHORD_PARTS.exec(chord);
  if (!m) return null;
  const [, letter, acc, suffix, bassLetter, bassAcc] = m;
  const root = pitchClass(letter, acc);

  let third = 4;
  let fifth = 7;
  const extra: number[] = [];

  if (/^(m(?!aj)|min|-)/.test(suffix)) third = 3;
  if (/dim|°|ø|b5/.test(suffix)) {
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
  if (/6/.test(suffix) && !/6[0-9]/.test(suffix)) extra.push(9);

  const intervals = [0, third, fifth, ...extra];
  return {
    root,
    bass: bassLetter ? pitchClass(bassLetter, bassAcc) : root,
    intervals,
    pcs: intervals.map((i) => (root + i) % 12),
  };
}

const midiToHz = (n: number) => 440 * Math.pow(2, (n - 69) / 12);
export { midiToHz };

/** Frequencies (Hz) for a simple pad voicing of the chord, bass note first. */
export function chordFrequencies(chord: string): number[] {
  const t = chordTones(chord);
  if (!t) return [];
  // Keep every chord in a comfortable register around C3-B3.
  const base = 48 + t.root - (t.root > 6 ? 12 : 0);
  const bassMidi = t.bass !== t.root ? 36 + t.bass : base - 12;
  return [bassMidi, ...t.intervals.map((i) => base + i)].map(midiToHz);
}

export interface PianoVoicing {
  /** Left hand: one or two low notes (MIDI). */
  bass: number[];
  /** Right hand: the chord, spread low to high (MIDI). */
  hand: number[];
}

/**
 * Pick a piano voicing for the chord that moves as little as possible from the
 * previous one (voice leading), so a progression sounds smooth instead of
 * jumping an octave on every change.
 */
export function voiceChord(
  chord: string,
  prev: number[] | null,
): PianoVoicing | null {
  const t = chordTones(chord);
  if (!t) return null;

  // Thin out the chord for the right hand: drop the 5th of extended chords.
  let pcs = t.pcs;
  if (pcs.length >= 5) pcs = pcs.filter((_, i) => i !== 2);
  // The bass note carries the root, so the hand may leave it out of 4+ note chords.
  const LOW = 55; // G3
  const HIGH = 77; // F5

  let best: number[] = [];
  let bestScore = Infinity;
  for (let rot = 0; rot < pcs.length; rot++) {
    const order = [...pcs.slice(rot), ...pcs.slice(0, rot)];
    for (let start = LOW; start < LOW + 12; start++) {
      // Lowest note: the first chord note at or above `start`.
      const notes: number[] = [];
      let cur = start + ((((order[0] - start) % 12) + 12) % 12);
      notes.push(cur);
      for (let i = 1; i < order.length; i++) {
        let n = cur + ((((order[i] - cur) % 12) + 12) % 12);
        if (n === cur) n += 12;
        notes.push(n);
        cur = n;
      }
      const span = notes[notes.length - 1] - notes[0];
      if (span > 16 || notes[notes.length - 1] > HIGH) continue;
      let score = span * 0.15;
      if (prev && prev.length) {
        const c = notes.reduce((a, b) => a + b, 0) / notes.length;
        const pc = prev.reduce((a, b) => a + b, 0) / prev.length;
        score += Math.abs(c - pc) * 1.2;
      } else {
        const c = notes.reduce((a, b) => a + b, 0) / notes.length;
        score += Math.abs(c - 64); // start around E4
      }
      if (score < bestScore) {
        bestScore = score;
        best = notes;
      }
    }
  }
  if (!best.length) return null;

  // Left hand: the bass note in the octave E1-D#2 .. and an octave above it.
  const bassMidi = 36 + ((((t.bass - 36) % 12) + 12) % 12); // C2..B2
  return { bass: [bassMidi, bassMidi + 12], hand: best };
}

/* ----------------------------- bass and strings ----------------------------- */

/**
 * Bass guitar part: just the root of the chord, in the E1 to D#2 range
 * (MIDI 28-39). Slash chords still use their root, not the slash note.
 */
export function bassRoot(chord: string): number | null {
  const t = chordTones(chord);
  if (!t) return null;
  return 28 + ((((t.root - 28) % 12) + 12) % 12);
}

/**
 * String section part: a power chord, 1-5-1 (root, fifth, octave), with the
 * root somewhere in C3 to B3 (MIDI 48-59). The chord quality is ignored.
 */
export function stringsPowerChord(chord: string): number[] | null {
  const t = chordTones(chord);
  if (!t) return null;
  const root = 48 + ((((t.root - 48) % 12) + 12) % 12);
  return [root, root + 7, root + 12];
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
