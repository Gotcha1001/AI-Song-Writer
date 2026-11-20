// lib/melody.ts
// Turns the chords + lyrics of a song into a singable melody.
//
// The AI only writes chords and words, so the tune is composed here, the same
// way every time for the same song (it is seeded, not random):
//   - every syllable gets one note, so the words always fit the bar
//   - strong beats land on notes of the chord that is playing
//   - weak beats move by step, phrases rise and fall, and every 4 bars
//     (and the end of each section) come to rest on a chord note / the tonic
//   - the same section name (Verse 1 / Verse 2, Chorus ...) gets the same tune
//
// Notes are stored as SCALE DEGREES (0 = tonic, 7 = the octave above), so the
// melody keeps its shape when the song is transposed.
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

const V = "aeiouyàáâãäåèéêëìíîïòóôõöùúûüæœ";
const isVowel = (ch: string) => V.includes(ch.toLowerCase());

/** Split one word into singable syllables (a good-enough rule of thumb). */
export function syllabify(word: string): string[] {
  const w = word;
  // vowel groups; "y" at the start of a word is a consonant
  const groups: { s: number; e: number }[] = [];
  let i = 0;
  while (i < w.length) {
    const c = w[i];
    const vowel = isVowel(c) && !(i === 0 && c.toLowerCase() === "y");
    if (vowel) {
      let j = i;
      while (j < w.length && isVowel(w[j])) j++;
      groups.push({ s: i, e: j });
      i = j;
    } else i++;
  }
  if (groups.length <= 1) return [w];

  const lower = w.toLowerCase().replace(/[^a-z]+$/, "");
  const last = groups[groups.length - 1];
  const endsInLetters = lower.length;
  // silent final "e" (made, love) but not "le" (table) or a lone "e" word
  if (
    last.e - last.s === 1 &&
    lower.endsWith("e") &&
    last.e >= endsInLetters &&
    !/[^aeiouy]le$/.test(lower) &&
    !isVowel(lower[lower.length - 2] ?? "a")
  ) {
    groups.pop();
  } else if (
    // silent "ed" (walked, loved) but not after t / d (wanted, needed)
    /[^aeiouytd]ed$/.test(lower) &&
    last.e - last.s === 1
  ) {
    groups.pop();
  }
  if (groups.length <= 1) return [w];

  const cuts: number[] = [];
  for (let g = 0; g < groups.length - 1; g++) {
    const between = groups[g + 1].s - groups[g].e;
    cuts.push(groups[g].e + (between <= 1 ? 0 : Math.floor(between / 2)));
  }
  const out: string[] = [];
  let from = 0;
  for (const c of cuts) {
    out.push(w.slice(from, c));
    from = c;
  }
  out.push(w.slice(from));
  return out.filter((x) => x.length > 0);
}

export interface Syllable {
  text: string;
  /** More of the same word follows (draw a hyphen under the lyric). */
  joinNext: boolean;
}

/** All the syllables sung in one bar, in order. */
export function barSyllables(segments: { lyric: string }[]): Syllable[] {
  const out: Syllable[] = [];
  for (const seg of segments) {
    const tokens = seg.lyric
      .split(/\s+/)
      .filter((t) => /[\p{L}\p{N}]/u.test(t));
    for (const raw of tokens) {
      const cont = raw.endsWith("-");
      const token = cont ? raw.slice(0, -1) : raw;
      const parts = syllabify(token);
      parts.forEach((text, i) =>
        out.push({ text, joinNext: i < parts.length - 1 || cont }),
      );
    }
  }
  return out;
}

/* --------------------------------- rhythm --------------------------------- */

/** Time is measured in sixteenth notes. */
export function unitsPerBar(beatsPerBar: number): number {
  return beatsPerBar === 4 ? 16 : 12; // 4/4 -> 16, 3/4 and 6/8 -> 12
}

/** Length of one beat group in sixteenths (a quarter, or a dotted quarter in 6/8). */
export function beatUnits(beatsPerBar: number): number {
  return beatsPerBar === 6 ? 6 : 4;
}

// Positive = a sung note, negative = a rest. Each template adds up to the bar.
const TEMPLATES: Record<number, Record<number, number[]>> = {
  4: {
    0: [-16],
    1: [8, -8],
    2: [8, 8],
    3: [4, 4, 8],
    4: [4, 4, 4, 4],
    5: [4, 4, 2, 2, 4],
    6: [4, 2, 2, 4, 2, 2],
    7: [4, 2, 2, 2, 2, 2, 2],
    8: [2, 2, 2, 2, 2, 2, 2, 2],
  },
  3: {
    0: [-12],
    1: [12],
    2: [8, 4],
    3: [4, 4, 4],
    4: [4, 4, 2, 2],
    5: [4, 2, 2, 2, 2],
    6: [2, 2, 2, 2, 2, 2],
  },
  6: {
    0: [-12],
    1: [12],
    2: [6, 6],
    3: [6, 4, 2],
    4: [4, 2, 4, 2],
    5: [4, 2, 2, 2, 2],
    6: [2, 2, 2, 2, 2, 2],
  },
};

function rhythmFor(n: number, beatsPerBar: number): number[] {
  const U = unitsPerBar(beatsPerBar);
  const table = TEMPLATES[beatsPerBar] ?? TEMPLATES[4];
  if (table[n]) return table[n];
  // Busy bars: a mix of eighths and sixteenths (2a + b = U, a + b = n).
  const a = Math.max(0, U - n);
  const b = Math.max(0, 2 * n - U);
  return [...Array(a).fill(2), ...Array(b).fill(1)];
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
 * @param seed     anything stable for this song (its id), so the tune never changes
 */
export function buildMelody(
  sections: SongSection[],
  key: string,
  beatsPerBar: number,
  seed: string,
): Melody {
  const k = parseKeySpec(key);
  const U = unitsPerBar(beatsPerBar);
  const BU = beatUnits(beatsPerBar);
  const pulseUnits = beatsPerBar === 6 ? 2 : 4; // sixteenths per chord "beat"

  const pcOfDeg = (d: number) => (k.tonicPc + k.scale[mod(d, 7)]) % 12;
  const allDegs: number[] = [];
  for (let d = LOW_DEG; d <= HIGH_DEG; d++) allDegs.push(d);

  const bars: MelodyBar[] = [];

  for (const section of sections) {
    const shape = sectionShape(section.name);
    const tuneId = section.name.toLowerCase().replace(/[^a-z]+/g, "");
    const total = section.bars.length;
    let prev = shape.base;
    let prev2 = shape.base - 1;
    const written: { notes: MelodyNote[] }[] = [];

    section.bars.forEach((bar, bi) => {
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
      let syl = barSyllables(segs);
      if (syl.length > U) {
        const head = syl.slice(0, U - 1);
        const tail = syl.slice(U - 1);
        syl = [
          ...head,
          {
            text: tail.map((s) => s.text).join(""),
            joinNext: tail[tail.length - 1].joinNext,
          },
        ];
      }
      const rhythm = rhythmFor(syl.length, beatsPerBar);

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
        u += 0;
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
