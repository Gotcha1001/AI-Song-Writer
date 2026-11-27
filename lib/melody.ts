// lib/melody.ts
// Turns the chords + lyrics of a song into a singable melody.
//
// The tune is composed by the AI (convex/ai.ts -> composeMelody) and stored on
// the song. This file turns that stored melody into notes for the sheet and the
// player, checking every bar against the current lyrics. Any bar that is
// missing or no longer fits (older songs, a lyric you edited, a bar the AI got
// wrong) gets a fallback tune from the rules below, so there is always a tune:
//
//   - every syllable gets one note, so the words always fit the bar
//   - strong beats land on notes of the chord that is playing
//   - weak beats move by step, phrases rise and fall, and every 4 bars
//     (and the end of each section) come to rest on a chord note / the tonic
//   - AI bars are tidied by repairBar(): chord notes on beats / long notes,
//     stepwise passing notes, a long-short pair to break up a monotone bar,
//     and a real rest at the end of every phrase (genre decides how long)
//   - the same section name (Verse 1 / Verse 2, Chorus ...) gets the same tune
//
// Notes are stored as SCALE DEGREES (0 = tonic, 7 = the octave above), so the
// melody keeps its shape when the song is transposed.
import { capSyllables, barSyllables } from "@/convex/lib/syllables";
import {
  buildBarSpecs,
  repairBar,
  type Breath,
  type SpecOptions,
  type StoredBar,
} from "@/convex/lib/melodyPrompt";
import { chordTones } from "@/lib/music";
import type { SongSection } from "@/lib/songTypes";

/* ---------------------------------- keys ---------------------------------- */

const LETTERS = ["C", "D", "E", "F", "G", "A", "B"];
const LETTER_PC = [0, 2, 4, 5, 7, 9, 11];
const MAJOR = [0, 2, 4, 5, 7, 9, 11];
const MINOR = [0, 2, 3, 5, 7, 8, 10];
// Position of each letter on the line of fifths (F = -1 ... B = 5).
const LETTER_FIFTHS = [0, 2, 4, -1, 1, 3, 5];

export interface KeySpec {
  name: string;
  minor: boolean;
  /** Letter index of the tonic, 0 = C ... 6 = B. */
  letter: number;
  /** -1 for a flat tonic, +1 for sharp. */
  accidental: number;
  tonicPc: number;
  /** Sharps (positive) or flats (negative) in the key signature. */
  fifths: number;
  /** MIDI note of the tonic, kept between A3 and G#4 (a comfortable voice range). */
  tonicMidi: number;
  /** Absolute diatonic index of the tonic (octave * 7 + letter). */
  tonicStep: number;
  scale: number[];
}

export function parseKeySpec(key: string): KeySpec {
  const m = /^([A-G])([#b]?)(m?)$/.exec(key.trim());
  const letter = m ? LETTERS.indexOf(m[1]) : 0;
  const accidental = m ? (m[2] === "#" ? 1 : m[2] === "b" ? -1 : 0) : 0;
  const minor = m ? m[3] === "m" : false;
  const tonicPc = (LETTER_PC[letter] + accidental + 12) % 12;
  const fifths = LETTER_FIFTHS[letter] + 7 * accidental - (minor ? 3 : 0);

  const tonicMidi = 57 + ((((tonicPc - 57) % 12) + 12) % 12);
  const octave = Math.floor((tonicMidi - accidental) / 12) - 1;
  return {
    name: m ? key.trim() : "C",
    minor,
    letter,
    accidental,
    tonicPc,
    fifths,
    tonicMidi,
    tonicStep: octave * 7 + letter,
    scale: minor ? MINOR : MAJOR,
  };
}

const mod = (n: number, m: number) => ((n % m) + m) % m;

/** MIDI note number of a scale degree. */
export function degreeToMidi(k: KeySpec, deg: number): number {
  return k.tonicMidi + 12 * Math.floor(deg / 7) + k.scale[mod(deg, 7)];
}

/** Absolute diatonic step (octave * 7 + letter) of a scale degree. */
export function degreeToStep(k: KeySpec, deg: number): number {
  return k.tonicStep + deg;
}

/* -------------------------------- syllables -------------------------------- */

// The split lives in convex/lib/syllables.ts so the AI prompt and the sheet agree.
export { barSyllables, syllabify, type Syllable } from "@/convex/lib/syllables";

/* --------------------------------- rhythm --------------------------------- */

/** Time is measured in sixteenth notes. */
export function unitsPerBar(beatsPerBar: number): number {
  return beatsPerBar === 4 ? 16 : 12; // 4/4 -> 16, 3/4 and 6/8 -> 12
}

/** Length of one beat group in sixteenths (a quarter, or a dotted quarter in 6/8). */
export function beatUnits(beatsPerBar: number): number {
  return beatsPerBar === 6 ? 6 : 4;
}

/**
 * Positive = a sung note, negative = a rest.
 * Templates are deliberately sparse so the singer has room to breathe.
 * Preference order for low syllable counts: held note + rest, short phrase + rest.
 */
const TEMPLATES: Record<number, Record<number, number[]>> = {
  4: {
    0: [-16],
    1: [8, -8], // long note, half-bar rest
    2: [4, 4, -8], // two quarters, then rest
    3: [4, 4, 4, -4], // three quarters + quarter rest
    4: [4, 4, 4, 2, -2], // slightly more movement, still ends with air
    5: [4, 2, 2, 4, -4], // classic short-short-long + rest
    6: [2, 2, 4, 2, 2, -4], // mixed + breathing room
    7: [2, 2, 2, 2, 4, 2, -2], // denser but still ends open
    8: [2, 2, 2, 2, 2, 2, 2, -2], // never completely fill the bar
  },
  3: {
    0: [-12],
    1: [8, -4],
    2: [4, 4, -4],
    3: [4, 4, 2, -2],
    4: [4, 2, 2, 2, -2],
    5: [2, 2, 2, 2, 2, -2],
    6: [2, 2, 2, 2, 2, 2],
  },
  6: {
    0: [-12],
    1: [6, -6],
    2: [6, 4, -2],
    3: [4, 2, 4, -2],
    4: [4, 2, 4, 2],
    5: [4, 2, 2, 2, 2],
    6: [2, 2, 2, 2, 2, 2],
  },
};

/**
 * Build a rhythm that respects both syllable count and the breath marks
 * coming from the lyric (punctuation / end-of-line).
 * The result always contains exactly `n` positive values (one per syllable)
 * and the absolute values sum to one full bar.
 */
function rhythmFor(
  n: number,
  beatsPerBar: number,
  pauses: number[] = [],
  breath: Breath = { short: 2, long: 4 },
): number[] {
  const U = unitsPerBar(beatsPerBar);
  const maxBreath = Math.max(1, Math.floor(U / 2));
  const table = TEMPLATES[beatsPerBar] ?? TEMPLATES[4];

  // Prefer the pre-written sparse templates when they exist.
  let base = table[n] ? [...table[n]] : null;

  if (!base) {
    // Busy bars: mix of eighths and sixteenths, but still leave a little air
    // at the end whenever possible.
    const a = Math.max(0, U - n);
    const b = Math.max(0, 2 * n - U);
    base = [...Array(a).fill(2), ...Array(b).fill(1)];
    // If we can, turn the final note into a shorter note + rest.
    if (base.length > 0 && base[base.length - 1] >= 2 && n < U) {
      const last = base.pop()!;
      base.push(last - 1, -1);
    }
  }

  // Now inject / enlarge rests according to the lyric’s pause levels.
  // pauses[i] = 0/1/2 after the i-th syllable.
  if (pauses.length === n && n > 0) {
    const sung: number[] = [];
    let restBudget = 0;

    // Collect the positive (sung) slots and the existing rest slots.
    for (const r of base) {
      if (r > 0) sung.push(r);
      else restBudget += -r;
    }

    // Guarantee at least a short rest after any syllable that wants one,
    // and a longer rest after strong punctuation, by stealing length from
    // the preceding note if necessary.
    const final: number[] = [];
    for (let i = 0; i < sung.length; i++) {
      const len = sung[i];
      const want = pauses[i] ?? 0;
      if (want > 0) {
        const needed = Math.min(
          want === 2 ? breath.long : breath.short,
          maxBreath,
        );
        if (len > needed) {
          final.push(len - needed);
          final.push(-needed);
        } else if (len > 1) {
          final.push(1);
          final.push(-(len - 1));
        } else {
          final.push(len);
        }
      } else {
        final.push(len);
      }
    }

    // Any remaining rest budget that was in the original template goes at the end.
    const used = final.reduce((s, v) => s + Math.abs(v), 0);
    if (used < U) {
      final.push(-(U - used));
    }

    // Safety: make sure we still have exactly n positive numbers.
    const positive = final.filter((v) => v > 0).length;
    if (positive === n) return final;
  }

  return base;
}

/* ---------------------------------- melody ---------------------------------- */

export interface MelodyNote {
  /** Start inside the bar, in sixteenths. */
  u: number;
  /** Length in sixteenths (always 1, 2, 3, 4, 6, 8, 12 or 16). */
  d: number;
  /** Scale degree, or null for a rest. */
  deg: number | null;
  /** The syllable sung on this note ("" for rests). */
  text: string;
  joinNext: boolean;
}

export interface MelodyBar {
  notes: MelodyNote[];
  /** Chord symbols with the sixteenth they start on (for the sheet). */
  chords: { u: number; chord: string }[];
}

export interface Melody {
  key: KeySpec;
  beatsPerBar: number;
  unitsPerBar: number;
  bars: MelodyBar[];
}

/**
 * Turns one AI-composed bar into notes, or null if it does not fit the bar:
 * lengths must add up to the bar and every syllable needs exactly one note.
 */
function storedBarToNotes(
  stored: StoredBar | undefined,
  syl: { text: string; joinNext: boolean }[],
  U: number,
): MelodyNote[] | null {
  if (!stored || stored.length === 0) return null;
  const total = stored.reduce((a, n) => a + n.d, 0);
  const sung = stored.filter((n) => n.deg !== undefined).length;
  if (total !== U || sung !== syl.length) return null;

  const notes: MelodyNote[] = [];
  let u = 0;
  let si = 0;
  for (const n of stored) {
    if (n.deg === undefined) {
      notes.push({ u, d: n.d, deg: null, text: "", joinNext: false });
    } else {
      const s = syl[si++];
      notes.push({
        u,
        d: n.d,
        deg: n.deg,
        text: s.text,
        joinNext: s.joinNext,
      });
    }
    u += n.d;
  }
  return notes;
}

function hash(str: string): number {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const LOW_DEG = -1;
const HIGH_DEG = 7;

/** Where each kind of section tends to sit, and how far its phrases arch. */
function sectionShape(name: string): { base: number; height: number } {
  const n = name.toLowerCase();
  if (/chorus|hook/.test(n)) return { base: 3, height: 3 };
  if (/pre/.test(n)) return { base: 2, height: 2 };
  if (/bridge/.test(n)) return { base: 4, height: 2 };
  if (/intro|outro|solo|inter/.test(n)) return { base: 2, height: 1 };
  return { base: 1, height: 2 };
}

/**
 * @param sections the (possibly transposed) song sections
 * @param key      the key of those sections, e.g. "Am"
 * @param seed     anything stable for this song (its id), so the fallback tune never changes
 * @param composed the AI's melody, one list of notes per bar in song order
 * @param opts     genre / tempo / language of the song: they decide how long the
 *                 breaths are and how the lyric is phrased (pass the same values
 *                 the melody was composed with)
 */
export function buildMelody(
  sections: SongSection[],
  key: string,
  beatsPerBar: number,
  seed: string,
  composed?: StoredBar[] | null,
  opts: SpecOptions = {},
): Melody {
  const k = parseKeySpec(key);
  const U = unitsPerBar(beatsPerBar);
  const BU = beatUnits(beatsPerBar);
  const pulseUnits = beatsPerBar === 6 ? 2 : 4; // sixteenths per chord "beat"

  const pcOfDeg = (d: number) => (k.tonicPc + k.scale[mod(d, 7)]) % 12;
  const allDegs: number[] = [];
  for (let d = LOW_DEG; d <= HIGH_DEG; d++) allDegs.push(d);

  const bars: MelodyBar[] = [];
  let flatIndex = 0;
  // Chords, syllables and breath points for every bar (same order as `composed`).
  const specs = buildBarSpecs(sections, beatsPerBar, opts);

  for (const section of sections) {
    const shape = sectionShape(section.name);
    const tuneId = section.name.toLowerCase().replace(/[^a-z]+/g, "");
    const total = section.bars.length;
    let prev = shape.base;
    let prev2 = shape.base - 1;
    const written: { notes: MelodyNote[] }[] = [];

    section.bars.forEach((bar, bi) => {
      const flat = flatIndex++;
      const rand = rng(hash(`${seed}|${tuneId}|${bi}`));

      /* chords by position */
      const segs = bar.segments;
      const chords: { u: number; chord: string }[] = [];
      segs.forEach((seg, i) => {
        if (!seg.chord) return;
        const startBeat = Math.floor((i * beatsPerBar) / segs.length);
        chords.push({ u: startBeat * pulseUnits, chord: seg.chord });
      });
      const chordAt = (u: number): string | null => {
        let c: string | null = null;
        for (const x of chords) if (x.u <= u) c = x.chord;
        return c ?? chords[0]?.chord ?? null;
      };

      /* syllables -> rhythm */
      const syl = capSyllables(barSyllables(segs), U);
      const spec = specs[flat];
      const pauses = spec?.pauses ?? [];

      /* the AI's tune, when it fits this bar's words */
      const stored = composed?.[flat];
      const repaired =
        stored && stored.length > 0 && spec
          ? repairBar(
              stored,
              spec,
              key,
              beatsPerBar,
              written.length ? prev : null,
            )
          : stored;
      const fromAi = storedBarToNotes(repaired, syl, U);
      if (fromAi) {
        const lastPitch = [...fromAi].reverse().find((n) => n.deg !== null);
        if (lastPitch && lastPitch.deg !== null) {
          prev2 = prev;
          prev = lastPitch.deg;
        }
        written.push({ notes: fromAi });
        bars.push({ notes: fromAi, chords });
        return;
      }

      // Fallback: build a more natural, breathing rhythm.
      const rhythm = rhythmFor(syl.length, beatsPerBar, pauses, spec?.breath);

      /* where this bar should be heading (a gentle arch over each 4 bars) */
      const inPhrase = bi % 4;
      const phraseNo = Math.floor(bi / 4);
      const wobble =
        Math.floor(rng(hash(`${seed}|${tuneId}|p${phraseNo}`))() * 3) - 1;
      const arch = Math.sin((Math.PI * (inPhrase + 0.5)) / 4);
      let target = Math.round(shape.base + shape.height * arch) + wobble;
      const isPhraseEnd = inPhrase === 3 || bi === total - 1;
      if (isPhraseEnd) target = shape.base - 1 + (wobble > 0 ? 1 : 0);
      target = Math.min(HIGH_DEG - 1, Math.max(LOW_DEG + 1, target));

      /* the 3rd bar of a phrase echoes the 1st when the rhythm matches */
      const echo = inPhrase === 2 ? written[bi - 2] : undefined;
      const echoOk =
        echo &&
        echo.notes.length === rhythm.length &&
        echo.notes.every((n, i) => n.d === Math.abs(rhythm[i]));

      const notes: MelodyNote[] = [];
      let u = 0;
      let si = 0;
      let lastSungIndex = -1;
      rhythm.forEach((r, ri) => {
        if (r < 0) {
          notes.push({ u, d: -r, deg: null, text: "", joinNext: false });
          u += -r;
          return;
        }
        lastSungIndex = ri;
        notes.push({ u, d: r, deg: 0, text: "", joinNext: false });
        u += r;
      });

      // Assign pitches + text to sung notes.
      let sung = 0;
      const sungCount = notes.filter((n) => n.deg !== null).length;
      const echoFirst = echoOk ? echo.notes.find((n) => n.deg !== null) : null;
      notes.forEach((n, ri) => {
        if (n.deg === null) return;
        const s = syl[si++];
        n.text = s?.text ?? "";
        n.joinNext = s?.joinNext ?? false;

        const strong = n.u % BU === 0;
        const isLastSung = ri === lastSungIndex;
        const chord = chordAt(n.u);
        const tones = chord ? chordTones(chord) : null;
        const chordDegs = tones
          ? allDegs.filter((d) => tones.pcs.includes(pcOfDeg(d)))
          : allDegs;

        let pool: number[];
        if (isPhraseEnd && isLastSung) {
          const lastBar = bi === total - 1;
          const home = [0, 7].filter((d) => d >= LOW_DEG && d <= HIGH_DEG);
          pool = lastBar || !chordDegs.length ? home : chordDegs;
        } else if (strong) pool = chordDegs.length ? chordDegs : allDegs;
        else pool = allDegs.filter((d) => Math.abs(d - prev) <= 2);
        if (!pool.length) pool = allDegs;

        let pick = pool[0];
        if (echoOk && echoFirst && n.u !== 0 && !isLastSung) {
          // follow the echoed bar's shape, nudged onto the new harmony
          const orig = echo.notes[ri].deg ?? prev;
          const want = orig;
          pick = pool.reduce((a, b) =>
            Math.abs(b - want) < Math.abs(a - want) ? b : a,
          );
        } else {
          let best = Infinity;
          for (const c of pool) {
            const leap = Math.abs(c - prev);
            let cost = leap * (strong ? 0.7 : 1);
            cost += Math.abs(c - target) * 0.55;
            if (leap === 0) cost += 1.5;
            if (c === prev2) cost += 0.6; // avoid circling back and forth
            if (leap > 4) cost += 4;
            if (sung === 0 && leap > 2) cost += 1; // gentle entry
            // Prefer longer notes on strong beats / phrase ends (more natural emphasis)
            if (strong || isLastSung) cost -= 0.3;
            cost += rand() * 1.6;
            if (cost < best) {
              best = cost;
              pick = c;
            }
          }
        }
        n.deg = Math.min(HIGH_DEG, Math.max(LOW_DEG, pick));
        prev2 = prev;
        prev = n.deg;
        sung++;
      });

      // If the bar has no sung notes but the lyric is empty, it is one long rest.
      if (sungCount === 0) {
        notes.length = 0;
        notes.push({ u: 0, d: U, deg: null, text: "", joinNext: false });
      }
      written.push({ notes });
      bars.push({ notes, chords });
    });
  }

  return { key: k, beatsPerBar, unitsPerBar: U, bars };
}
