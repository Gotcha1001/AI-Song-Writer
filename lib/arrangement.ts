// lib/arrangement.ts
// Plans the "band" parts that sit around the sung melody, so the extra
// instruments sound played rather than held:
//
//   - Guitar: a strummed acoustic rhythm guitar. The whole chord is strummed in a
//     pattern (down / up strokes), with a fuller pattern in choruses.
//   - Flute: a counter-melody. It only plays in the gaps where the vocal rests
//     (call and response), moves by step, and lands on chord tones. It is not
//     constant: it answers at the end of phrases and sits out the rest.
//   - Violin: a soft harmony pad. It holds a chord tone that is NOT the root
//     (so it never doubles the bass / guitar / melody), stays below the vocal
//     and away from the flute's notes, and comes and goes in 2-bar blocks.
//
// The parts follow the song's genre (see lib/genreArrangement.ts): rock drives
// in eighths, latin syncopates, country picks "boom-chick", ambient rolls slow
// chords, jazz comps sparsely, and the flute / violin come in more or less.
//
// Song-shape awareness (so it sounds produced, not looped):
//   - Repeats differ: every section gets an occurrence number in its seed, so
//     Verse 2 is not a copy of Verse 1 (extra up-strokes, different answers).
//   - The LAST chorus (when there are two or more) gets a lift: louder, busier
//     strums, the violin always plays, and the flute sings higher.
//   - The flute echoes the vocal hook (a diatonic third above, or inverted)
//     in choruses instead of a generic fill.
//   - The violin plays a moving line in choruses (chord tones joined by passing
//     and approach notes) instead of one held note.
//   - The last bar of a section gets a drum-less "fill" into the next one
//     (a build into a chorus, lighter into anything else).
//   - Intros start soft and grow, outros fade and the final chord rolls out.
//
// The plan is pure data (no audio) and the same every time for the same song.
// Time is measured in sixteenth notes, like lib/melody.ts.
import { chordTones } from "@/lib/music";
import {
  beatUnits,
  degreeToMidi,
  unitsPerBar,
  type KeySpec,
  type Melody,
} from "@/lib/melody";
import {
  getArrangementFamily,
  type ArrangementFamily,
} from "@/lib/genreArrangement";
import type { SongSection } from "@/lib/songTypes";

/* ---------------------------------- types ---------------------------------- */

export interface NoteEvent {
  /** Start inside the bar, in sixteenths. */
  u: number;
  /** Length in sixteenths (may run past the end of the bar). */
  d: number;
  midi: number;
  /** 0-1 */
  vel: number;
}

export interface StrumEvent {
  u: number;
  d: number;
  /** Late-ness in sixteenths (0 - 0.12): a human hand is never exactly on the grid. */
  shift: number;
  /** The chord, low string to high string (MIDI). */
  notes: number[];
  vel: number;
  dir: "down" | "up";
  /** Multiplies the gap between strings (1 = normal strum, 3 = slow roll). */
  spread: number;
}

export interface Arrangement {
  unitsPerBar: number;
  /** One list of events per bar of the song (flat bar number). */
  guitar: StrumEvent[][];
  flute: NoteEvent[][];
  violin: NoteEvent[][];
}

/* --------------------------------- helpers --------------------------------- */

const mod = (n: number, m: number) => ((n % m) + m) % m;
const clamp = (n: number, lo: number, hi: number) =>
  Math.min(hi, Math.max(lo, n));

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Kind = "verse" | "chorus" | "bridge" | "other";

function sectionKind(name: string): Kind {
  if (/pre[-\s]?chorus/i.test(name)) return "bridge"; // a build, not the big moment
  if (/chorus|hook|refrain/i.test(name)) return "chorus";
  if (/verse/i.test(name)) return "verse";
  if (/bridge|middle|break/i.test(name)) return "bridge";
  return "other";
}

interface BarInfo {
  kind: Kind;
  name: string;
  /** How many sections of the same kind came before this one (Verse 2 -> 1). */
  occ: number;
  /** Bar number inside its section, and the section's length in bars. */
  pos: number;
  len: number;
  /** Chords with the sixteenth they start on (same split the player uses). */
  starts: { u: number; chord: string }[];
  last: boolean;
  intro: boolean;
  outro: boolean;
  /** The final chorus of a song that has several: it gets a lift. */
  lift: boolean;
  /** On the last bar of a section that is followed by another: the kind that follows. */
  toNext: Kind | null;
  /** Loudness scale: intro grows, outro fades, pre-chorus builds, last chorus is bigger. */
  gain: number;
}

function buildInfo(
  sections: SongSection[],
  U: number,
  beatsPerBar: number,
): BarInfo[] {
  const pulse = U / beatsPerBar;
  const out: BarInfo[] = [];
  const kinds = sections.map((s) => sectionKind(s.name));
  const totals = new Map<Kind, number>();
  for (const k of kinds) totals.set(k, (totals.get(k) ?? 0) + 1);
  const seen = new Map<Kind, number>();

  sections.forEach((section, si) => {
    const kind = kinds[si];
    const occ = seen.get(kind) ?? 0;
    seen.set(kind, occ + 1);
    const lift =
      kind === "chorus" && occ >= 1 && occ === (totals.get(kind) ?? 1) - 1;
    const intro = /intro/i.test(section.name);
    const outro = /outro|ending|coda/i.test(section.name);
    const preChorus = /pre[-\s]?chorus/i.test(section.name);
    const nextKind = si + 1 < sections.length ? kinds[si + 1] : null;
    const len = section.bars.length;

    section.bars.forEach((bar, pos) => {
      const segs = bar.segments;
      const starts: { u: number; chord: string }[] = [];
      segs.forEach((seg, i) => {
        if (!seg.chord) return;
        const beat = Math.floor((i * beatsPerBar) / segs.length);
        starts.push({ u: beat * pulse, chord: seg.chord });
      });
      const t = len > 1 ? pos / (len - 1) : 1; // 0 -> 1 through the section
      let gain = 1;
      if (intro) gain = 0.8 + 0.2 * t;
      else if (outro) gain = 1 - 0.4 * (len > 1 ? t : 0);
      else if (preChorus) gain = 0.9 + 0.1 * t;
      else if (lift) gain = 1.08;
      out.push({
        kind,
        name: section.name.toLowerCase().replace(/[^a-z0-9]+/g, ""),
        occ,
        pos,
        len,
        starts,
        last: false,
        intro,
        outro,
        lift,
        toNext: pos === len - 1 ? nextKind : null,
        gain,
      });
    });
  });
  if (out.length) {
    const end = out[out.length - 1];
    end.last = true;
    end.gain = 1; // the last chord rings at full strength
  }
  return out;
}

function chordAt(starts: BarInfo["starts"], u: number): string | null {
  let c: string | null = null;
  for (const s of starts) if (s.u <= u) c = s.chord;
  return c ?? starts[0]?.chord ?? null;
}

/** Interval class (0-6) of two notes. */
const ic = (a: number, b: number) => {
  const d = Math.abs(a - b) % 12;
  return d > 6 ? 12 - d : d;
};

/** Is `midi` a note that rubs against the chord (a semitone from a chord tone)? */
function clashesWithChord(midi: number, chord: string | null): boolean {
  const t = chord ? chordTones(chord) : null;
  if (!t) return false;
  const pc = mod(midi, 12);
  if (t.pcs.includes(pc)) return false;
  return t.pcs.some((p) => ic(p, pc) === 1);
}

function chordToneMidis(
  chord: string | null,
  lo: number,
  hi: number,
): number[] {
  const t = chord ? chordTones(chord) : null;
  if (!t) return [];
  const out: number[] = [];
  for (let m = lo; m <= hi; m++) if (t.pcs.includes(mod(m, 12))) out.push(m);
  return out;
}

function diatonic(key: KeySpec, lo: number, hi: number): number[] {
  const out: number[] = [];
  for (let m = lo; m <= hi; m++) {
    if (key.scale.includes(mod(m - key.tonicPc, 12))) out.push(m);
  }
  return out;
}

/** The sung notes of the whole song in absolute sixteenths. */
interface Span {
  s: number;
  e: number;
  midi: number;
}
function vocalSpans(melody: Melody | null, bars: number, U: number): Span[] {
  const out: Span[] = [];
  if (!melody) return out;
  for (let b = 0; b < bars; b++) {
    for (const n of melody.bars[b]?.notes ?? []) {
      if (n.deg === null) continue;
      out.push({
        s: b * U + n.u,
        e: b * U + n.u + n.d,
        midi: degreeToMidi(melody.key, n.deg),
      });
    }
  }
  return out;
}

/* ---------------------------- rhythm guitar (strum) ---------------------------- */

interface Hit {
  u: number;
  dir: "down" | "up";
  vel: number;
  /** Which strings: the whole chord, only the low ones ("boom"), or the top ones ("chick"). */
  part?: "all" | "low" | "top";
  spread?: number;
}
const D = (u: number, vel: number, part?: Hit["part"]): Hit => ({
  u,
  dir: "down",
  vel,
  part,
});
const Up = (u: number, vel: number, part?: Hit["part"]): Hit => ({
  u,
  dir: "up",
  vel,
  part,
});
const Roll = (u: number, vel: number): Hit => ({
  u,
  dir: "down",
  vel,
  spread: 3,
});

// Strum patterns on the sixteenth grid. Verses are calm, choruses drive.
const PATTERNS: Record<number, Record<Kind, Hit[]>> = {
  4: {
    chorus: [
      D(0, 1),
      D(4, 0.72),
      Up(6, 0.5),
      Up(10, 0.55),
      D(12, 0.78),
      Up(14, 0.5),
    ],
    verse: [D(0, 0.95), Up(6, 0.45), D(8, 0.7), Up(10, 0.5), Up(14, 0.4)],
    bridge: [D(0, 0.9), Up(6, 0.4), D(8, 0.7), Up(14, 0.4)],
    other: [D(0, 0.9), D(8, 0.65)],
  },
  3: {
    chorus: [D(0, 1), D(4, 0.7), Up(6, 0.5), D(8, 0.7), Up(10, 0.5)],
    verse: [D(0, 0.95), D(4, 0.6), Up(6, 0.45), Up(10, 0.45)],
    bridge: [D(0, 0.9), Up(6, 0.4), D(8, 0.6)],
    other: [D(0, 0.9), Up(6, 0.4)],
  },
  6: {
    chorus: [D(0, 1), D(4, 0.65), D(6, 0.85), Up(8, 0.5), Up(10, 0.55)],
    verse: [D(0, 0.95), D(6, 0.75), Up(8, 0.45), Up(10, 0.5)],
    bridge: [D(0, 0.9), D(6, 0.65)],
    other: [D(0, 0.9), D(6, 0.65)],
  },
};

// Genre patterns (4/4, sixteenth grid). Anything not listed falls back to PATTERNS.
const GENRE_PATTERNS: Partial<Record<ArrangementFamily, Record<Kind, Hit[]>>> =
  {
    rock: {
      // all down-strokes in eighths in the chorus, steady quarters in the verse
      chorus: [
        D(0, 1),
        D(2, 0.6),
        D(4, 0.8),
        D(6, 0.6),
        D(8, 0.9),
        D(10, 0.6),
        D(12, 0.8),
        D(14, 0.6),
      ],
      verse: [D(0, 0.95), D(4, 0.6), D(8, 0.8), D(12, 0.6)],
      bridge: [D(0, 0.9), D(8, 0.75)],
      other: [D(0, 0.9), D(8, 0.7)],
    },
    latin: {
      // 3-3-2 syncopation
      chorus: [
        D(0, 1),
        Up(3, 0.55),
        D(6, 0.8),
        D(8, 0.75),
        Up(11, 0.55),
        D(14, 0.65),
      ],
      verse: [D(0, 0.95), Up(3, 0.45), D(6, 0.7), Up(10, 0.5), Up(14, 0.45)],
      bridge: [D(0, 0.9), Up(6, 0.5), D(8, 0.65)],
      other: [D(0, 0.85), D(6, 0.6)],
    },
    acoustic: {
      // country / folk "boom-chick": bass note, then the chord
      chorus: [
        D(0, 1, "low"),
        D(4, 0.65, "top"),
        Up(6, 0.45, "top"),
        D(8, 0.85, "low"),
        D(12, 0.65, "top"),
        Up(14, 0.45, "top"),
      ],
      verse: [
        D(0, 0.95, "low"),
        D(4, 0.55, "top"),
        D(8, 0.75, "low"),
        D(12, 0.55, "top"),
      ],
      bridge: [D(0, 0.9, "low"), D(8, 0.7, "top")],
      other: [D(0, 0.85, "low"), D(8, 0.6, "top")],
    },
    jazz: {
      // sparse comping on the off-beats
      chorus: [
        D(0, 0.8, "top"),
        Up(6, 0.55, "top"),
        D(10, 0.6, "top"),
        Up(14, 0.45, "top"),
      ],
      verse: [D(0, 0.75, "top"), Up(6, 0.5, "top"), D(12, 0.55, "top")],
      bridge: [D(0, 0.7, "top"), Up(6, 0.45, "top")],
      other: [D(0, 0.65, "top")],
    },
    dance: {
      // four on the floor, with off-beat stabs in the chorus
      chorus: [
        D(0, 1),
        Up(2, 0.5),
        D(4, 0.75),
        Up(6, 0.5),
        D(8, 0.9),
        Up(10, 0.5),
        D(12, 0.75),
        Up(14, 0.5),
      ],
      verse: [D(0, 0.9), D(4, 0.6), D(8, 0.8), D(12, 0.6)],
      bridge: [D(0, 0.85), D(8, 0.7)],
      other: [D(0, 0.8), D(8, 0.6)],
    },
    ambient: {
      // slow rolled chords that ring
      chorus: [Roll(0, 0.75), Roll(8, 0.5)],
      verse: [Roll(0, 0.7)],
      bridge: [Roll(0, 0.65)],
      other: [Roll(0, 0.6)],
    },
  };

const AMBIENT_ANY_METER: Record<Kind, Hit[]> = {
  chorus: [Roll(0, 0.7)],
  verse: [Roll(0, 0.65)],
  bridge: [Roll(0, 0.6)],
  other: [Roll(0, 0.55)],
};

function strumTable(
  family: ArrangementFamily,
  beatsPerBar: number,
): Record<Kind, Hit[]> {
  if (family === "ambient" && beatsPerBar !== 4) return AMBIENT_ANY_METER;
  if (beatsPerBar === 4) return GENRE_PATTERNS[family] ?? PATTERNS[4];
  return PATTERNS[beatsPerBar] ?? PATTERNS[4];
}

/**
 * The whole chord as a guitarist would grip it, low string to high string:
 * root, fifth, octave, third (and the seventh / ninth if the chord has one).
 * Roughly A2 up to the E above middle C. Slash chords put the slash note low.
 */
function guitarVoicing(chord: string): number[] | null {
  const t = chordTones(chord);
  if (!t) return null;
  const base = 45 + mod(t.root - 45, 12); // A2..G#3
  const third = t.intervals[1];
  const fifth = t.intervals[2];
  const extras = t.intervals.slice(3);
  const set = new Set<number>([
    base,
    base + fifth,
    base + 12,
    base + 12 + third,
  ]);
  set.add(extras.length ? base + 12 + mod(extras[0], 12) : base + 12 + fifth);
  if (t.bass !== t.root) {
    let b = 45 + mod(t.bass - 45, 12);
    if (b > base) b -= 12;
    if (b < 40) b += 12;
    set.delete(base);
    set.add(b);
  }
  const notes = [...set].sort((a, b) => a - b);
  while (notes.length > 4 && notes[notes.length - 1] > 76) notes.pop();
  return notes;
}

function planGuitar(
  info: BarInfo[],
  U: number,
  beatsPerBar: number,
  family: ArrangementFamily,
): StrumEvent[][] {
  const table = strumTable(family, beatsPerBar);
  const cache = new Map<string, number[] | null>();
  const voicing = (c: string) => {
    if (!cache.has(c)) cache.set(c, guitarVoicing(c));
    return cache.get(c) ?? null;
  };
  const pulse = U / beatsPerBar;
  const beat = beatUnits(beatsPerBar);
  const groups = Math.max(1, Math.round(U / beat));
  // jazz / country comp on the top strings only, everything else on all of them
  const thin: Hit["part"] = family === "jazz" ? "top" : undefined;

  return info.map((b) => {
    const rand = rng(hash(`g|${b.name}|${b.occ}|${b.pos}`));
    let hits: Hit[];

    if (b.last) {
      // one big final strum, rolled slowly so it rings out
      hits = [{ u: 0, dir: "down", vel: 1, spread: 2 }];
    } else if (b.intro && b.pos === 0) {
      // the song opens with a single soft, rolled chord
      hits = [{ u: 0, dir: "down", vel: 0.65, spread: 2 }];
    } else {
      hits = table[b.kind].map((h) => ({ ...h }));

      // repeats differ: later verses pick up a few extra up-strokes
      if (b.kind === "verse" && b.occ >= 1 && family !== "ambient") {
        const chance = 0.45 * Math.min(b.occ, 2);
        for (let k = 0; k < beatsPerBar; k++) {
          const u = Math.round(k * pulse + pulse / 2);
          if (u < U && !hits.some((h) => h.u === u) && rand() < chance) {
            hits.push(Up(u, 0.4, thin));
          }
        }
      }

      // the last chorus lifts: fill in the off-beats
      if (b.lift && family !== "ambient") {
        for (let k = 0; k < beatsPerBar; k++) {
          const u = Math.round(k * pulse + pulse / 2);
          if (u < U && !hits.some((h) => h.u === u) && rand() < 0.7) {
            hits.push(Up(u, 0.5, thin));
          }
        }
      }

      // transition fill: the last bar of a section pushes into the next one
      if (b.toNext && family !== "ambient") {
        const build = b.toNext === "chorus";
        const from = Math.max(0, groups - 2);
        hits = hits.filter((h) => h.u < from * beat);
        for (let k = from; k < groups; k++) {
          hits.push(D(k * beat, build ? 0.8 + 0.08 * (k - from) : 0.72, thin));
          hits.push(
            Up(k * beat + Math.round(beat / 2), build ? 0.55 : 0.4, thin),
          );
        }
        if (build) hits.push(Up(U - 1, 0.7, thin)); // the push into the downbeat
      }
    }

    // a chord change always gets a down-stroke of its own
    if (!b.last) {
      for (const s of b.starts) {
        if (!hits.some((h) => h.u === s.u)) hits.push(D(s.u, 0.85));
      }
    }
    hits.sort((x, y) => x.u - y.u);

    const events: StrumEvent[] = [];
    hits.forEach((h, i) => {
      const chord = chordAt(b.starts, h.u);
      const all = chord ? voicing(chord) : null;
      if (!all) return;
      const notes =
        h.part === "low"
          ? all.slice(0, 2)
          : h.part === "top"
            ? all.slice(-3)
            : all;
      const next = hits[i + 1]?.u ?? U;
      events.push({
        u: h.u,
        d: b.last ? U + 8 : clamp(next - h.u, 2, 8),
        shift: i === 0 ? 0 : rand() * 0.12,
        notes,
        vel: clamp(h.vel * b.gain * (0.94 + rand() * 0.12), 0.1, 1),
        dir: h.dir,
        spread: h.spread ?? 1,
      });
    });
    return events;
  });
}

/* ------------------------------ flute counter-melody ------------------------------ */

const FLUTE_LO = 67; // G4
const FLUTE_HI = 84; // C6

const intoFluteRange = (m: number) => {
  let x = m;
  while (x < FLUTE_LO) x += 12;
  while (x > FLUTE_HI) x -= 12;
  return x;
};

/** Genre scaling: the flute stays out of the way of a driving guitar, shows up more in jazz. */
const FLUTE_GAIN: Record<ArrangementFamily, number> = {
  pop: 1,
  rock: 0.7,
  dance: 0.6,
  latin: 1,
  acoustic: 1,
  jazz: 1.15,
  ambient: 1,
};

/** How likely the flute is to answer, by bar position inside a 4-bar phrase. */
const FLUTE_ANSWERS: Record<Kind, number[]> = {
  verse: [0.1, 0.35, 0.1, 0.8],
  chorus: [0.3, 0.6, 0.3, 0.85],
  bridge: [0.2, 0.45, 0.2, 0.65],
  other: [0.55, 0.55, 0.55, 0.55],
};

function nearest(
  cands: number[],
  aim: number,
  avoid: number | null,
  rand: () => number,
): number | null {
  const pool = cands
    .filter((c) => c !== avoid)
    .sort((a, b) => Math.abs(a - aim) - Math.abs(b - aim));
  if (!pool.length) return null;
  return pool[rand() < 0.7 || pool.length === 1 ? 0 : 1];
}

/** Rhythm of a fill that has `avail` sixteenths: a few short notes, then one longer note. */
function fillRhythm(
  avail: number,
  rand: () => number,
  calm: boolean,
): number[] {
  const maxNotes = Math.min(
    avail >= 12 ? 6 : avail >= 8 ? 4 : avail >= 5 ? 3 : 2,
    calm ? 2 : 6, // ambient: a few long, singing notes
  );
  const durs: number[] = [];
  let rem = avail;
  while (rem > 0) {
    if (durs.length === maxNotes - 1 || rem <= 4) {
      const fit = [12, 8, 6, 4, 3, 2].find((x) => x <= rem) ?? rem;
      durs.push(fit);
      break;
    }
    const options = (calm ? [4, 4, 6] : [2, 2, 4]).filter((x) => x <= rem - 2);
    const d = options[Math.floor(rand() * options.length)] ?? 2;
    durs.push(d);
    rem -= d;
  }
  return durs;
}

function planFill(opts: {
  gapStart: number;
  gapLen: number;
  chordAtU: (u: number) => string | null;
  ladder: number[];
  start: number;
  dir: 1 | -1;
  rand: () => number;
  calm: boolean;
  lo: number;
  hi: number;
}): NoteEvent[] {
  const { gapStart, gapLen, chordAtU, rand, lo, hi } = opts;
  const ladder = opts.ladder.filter((m) => m >= lo && m <= hi);
  let dir = opts.dir;
  const lead = gapLen >= 6 ? 2 : 0; // a breath before the flute speaks
  const avail = gapLen - lead;
  if (avail < 3) return [];

  const durs = fillRhythm(avail, rand, opts.calm);
  const events: NoteEvent[] = [];
  let u = gapStart + lead;
  let prev: number | null = null;

  durs.forEach((d, i) => {
    const chord = chordAtU(u);
    const cands = chordToneMidis(chord, lo, hi);
    const strong = i === 0 || i === durs.length - 1;
    let m: number | null = null;

    if (strong && cands.length) {
      const aim: number = prev === null ? opts.start : prev + dir * 3;
      m = nearest(cands, aim, prev, rand);
    } else if (ladder.length && prev !== null) {
      // passing note: one or two steps along the scale, bouncing off the range
      let idx = 0;
      for (let k = 0; k < ladder.length; k++) {
        if (Math.abs(ladder[k] - prev) < Math.abs(ladder[idx] - prev)) idx = k;
      }
      const step = rand() < 0.25 ? 2 : 1;
      let ni = idx + dir * step;
      if (ni < 0 || ni >= ladder.length) {
        dir = dir === 1 ? -1 : 1;
        ni = idx + dir * step;
      }
      m = ladder[clamp(ni, 0, ladder.length - 1)];
      if (m === prev) m = ladder[clamp(ni + dir, 0, ladder.length - 1)];
      if (clashesWithChord(m, chord)) {
        m = nearest(cands, m, prev, rand) ?? m;
      }
    } else if (cands.length) {
      m = nearest(cands, (prev ?? opts.start) + dir * 2, prev, rand);
    }

    if (m === null) {
      u += d;
      return;
    }
    // no big leaps inside a fill
    if (prev !== null && Math.abs(m - prev) > 7 && cands.length) {
      const close = cands.filter((c) => Math.abs(c - prev!) <= 7);
      m = nearest(close.length ? close : cands, prev, prev, rand) ?? m;
    }

    const first = i === 0;
    const last = i === durs.length - 1;
    events.push({
      u,
      d,
      midi: m,
      vel: clamp(
        (first || last ? 0.5 : 0.62) + (rand() - 0.5) * 0.1,
        0.35,
        0.75,
      ),
    });
    if (rand() < 0.3) dir = dir === 1 ? -1 : 1; // keep the contour alive
    prev = m;
    u += d;
  });
  return events;
}

/**
 * The flute answers the vocal hook: it repeats the last few sung notes a
 * diatonic third above (or turned upside down), squeezed into the rest. Notes
 * that would rub against the chord are moved to the nearest chord tone, and if
 * nothing usable is left the caller falls back to a generic fill.
 */
function planEcho(opts: {
  gapStart: number;
  gapLen: number;
  motif: { midi: number; d: number }[];
  chordAtU: (u: number) => string | null;
  ladder: number[];
  lo: number;
  hi: number;
  invert: boolean;
  rand: () => number;
}): NoteEvent[] {
  const { gapStart, gapLen, motif, chordAtU, lo, hi, rand } = opts;
  const ladder = opts.ladder.filter((m) => m >= lo && m <= hi);
  const lead = gapLen >= 6 ? 2 : 0;
  const avail = gapLen - lead;
  if (avail < 4 || motif.length < 2 || ladder.length < 5) return [];

  // the tail of the hook that fits the rest
  let take = motif.slice(-3);
  let total = take.reduce((n, x) => n + x.d, 0);
  while (take.length > 2 && total > avail) {
    total -= take[0].d;
    take = take.slice(1);
  }
  const scale = total > avail ? avail / total : 1;

  const idxOf = (m: number) => {
    let x = m;
    while (x < lo) x += 12;
    while (x > hi) x -= 12;
    let best = 0;
    for (let k = 1; k < ladder.length; k++) {
      if (Math.abs(ladder[k] - x) < Math.abs(ladder[best] - x)) best = k;
    }
    return best;
  };
  const idx = take.map((n) => idxOf(n.midi));
  const a0 = idx[0];
  const mapped = idx.map((i) =>
    clamp(opts.invert ? a0 + 2 - (i - a0) : i + 2, 0, ladder.length - 1),
  );

  const events: NoteEvent[] = [];
  let u = gapStart + lead;
  const end = gapStart + gapLen;
  for (let i = 0; i < take.length; i++) {
    const room = end - u;
    if (room < 2) break;
    let d = Math.max(2, Math.round(take[i].d * scale));
    if (i === take.length - 1) d += Math.min(Math.max(0, end - u - d), 6);
    d = Math.min(d, room);

    let m = ladder[mapped[i]];
    const chord = chordAtU(u);
    if ((d >= 3 || u % 4 === 0) && clashesWithChord(m, chord)) {
      const cands = chordToneMidis(chord, lo, hi);
      if (!cands.length) return [];
      m = nearest(cands, m, null, rand) ?? m;
    }
    events.push({
      u,
      d,
      midi: m,
      vel: clamp(0.58 + (rand() - 0.5) * 0.1 + (i === 1 ? 0.04 : 0), 0.4, 0.75),
    });
    u += d;
  }
  return events.length >= 2 ? events : [];
}

function planFlute(
  info: BarInfo[],
  melody: Melody | null,
  U: number,
  family: ArrangementFamily,
): NoteEvent[][] {
  const out: NoteEvent[][] = info.map(() => []);
  // diatonic notes up to a third above the normal top note (the lift reaches there)
  const ladder = melody ? diatonic(melody.key, FLUTE_LO, FLUTE_HI + 4) : [];
  let fluteLast: number | null = null;
  let prevFilled = -9;
  const heard: { midi: number; d: number }[] = []; // the last few sung notes, in order

  info.forEach((b, bi) => {
    const rand = rng(hash(`f|${b.name}|${b.occ}|${b.pos}`));
    const sung = (melody?.bars[bi]?.notes ?? []).filter((n) => n.deg !== null);

    // which sixteenths does the vocal fill?
    const busy = new Array<boolean>(U).fill(false);
    if (melody) {
      for (const n of sung) {
        for (let x = n.u; x < Math.min(U, n.u + n.d); x++) busy[x] = true;
      }
    } else {
      for (let x = 0; x < U / 2; x++) busy[x] = true; // no tune: keep to the 2nd half
    }

    // rests of a beat or longer
    const gaps: { s: number; len: number }[] = [];
    let from = -1;
    for (let x = 0; x <= U; x++) {
      const free = x < U && !busy[x];
      if (free && from < 0) from = x;
      if (!free && from >= 0) {
        if (x - from >= 4) gaps.push({ s: from, len: x - from });
        from = -1;
      }
    }
    gaps.sort((a, c) => c.len - a.len || c.s - a.s);
    const gap = gaps[0];

    const instrumental = !!melody && sung.length === 0;
    let p = Math.min(
      0.95,
      FLUTE_ANSWERS[b.kind][b.pos % 4] * FLUTE_GAIN[family],
    );
    if (b.lift) p = Math.min(0.95, p * 1.35); // the last chorus is busier
    if (b.toNext) p = Math.max(p, 0.7); // a little run into the next section
    if (b.outro && b.pos === b.len - 2) p = Math.max(p, 0.8); // a last answer
    if (instrumental) p = Math.max(p, 0.85);
    if (bi - prevFilled === 1 && !instrumental && !b.toNext) p *= 0.35; // not two bars in a row
    if (b.last) p = 0; // the song ends on held chords
    const roll = rand();

    if (gap && roll < p && melody) {
      // what was the vocal doing just before the gap?
      const motif = [...heard];
      for (const n of sung.filter((x) => x.u < gap.s)) {
        motif.push({ midi: degreeToMidi(melody.key, n.deg as number), d: n.d });
      }
      const lastV = motif[motif.length - 1]?.midi;
      const prevV = motif[motif.length - 2]?.midi;
      const lo = FLUTE_LO;
      const hi = b.lift ? FLUTE_HI + 4 : FLUTE_HI;
      let start = intoFluteRange(lastV ?? 72);
      if (fluteLast !== null && Math.abs(fluteLast - start) <= 7)
        start = fluteLast;
      if (b.lift) start = Math.min(hi, start + 5);
      // answer the vocal in the opposite direction (contrary motion);
      // a run into a chorus always climbs
      const vocalDir =
        lastV !== undefined && prevV !== undefined
          ? Math.sign(lastV - prevV)
          : 0;
      const dir: 1 | -1 = b.toNext === "chorus" || vocalDir <= 0 ? 1 : -1;
      const chordAtU = (u: number) => chordAt(b.starts, u);

      // choruses echo the hook; other sections do it now and then
      const echoP =
        b.kind === "chorus" ? 0.75 : b.kind === "bridge" ? 0.4 : 0.3;
      let events: NoteEvent[] = [];
      if (motif.length >= 2 && rand() < echoP) {
        events = planEcho({
          gapStart: gap.s,
          gapLen: gap.len,
          motif,
          chordAtU,
          ladder,
          lo,
          hi,
          // the first time a chorus returns it is a plain echo, then it turns over
          invert: b.occ % 2 === 1 ? rand() < 0.7 : rand() < 0.25,
          rand,
        });
      }
      if (!events.length) {
        events = planFill({
          gapStart: gap.s,
          gapLen: gap.len,
          chordAtU,
          ladder,
          start,
          dir,
          rand,
          calm: family === "ambient",
          lo,
          hi,
        });
      }
      events = events.map((e) => ({
        ...e,
        vel: clamp(e.vel * b.gain, 0.2, 0.85),
      }));
      if (events.length) {
        out[bi] = events;
        prevFilled = bi;
        fluteLast = events[events.length - 1].midi;
      }
    }

    for (const n of sung) {
      heard.push({ midi: degreeToMidi(melody!.key, n.deg as number), d: n.d });
    }
    if (heard.length > 4) heard.splice(0, heard.length - 4);
  });
  return out;
}

/* -------------------------------- violin harmony -------------------------------- */

/** Genre scaling: strings are central in ambient / cinematic, a fiddle suits country, rock and dance keep it light. */
const VIOLIN_GAIN: Record<ArrangementFamily, number> = {
  pop: 1,
  rock: 0.5,
  dance: 0.5,
  latin: 0.8,
  acoustic: 1.1,
  jazz: 0.6,
  ambient: 1.5,
};
const VIOLIN_VEL: Record<ArrangementFamily, number> = {
  pop: 0,
  rock: -0.04,
  dance: -0.04,
  latin: 0,
  acoustic: 0,
  jazz: -0.02,
  ambient: 0.06,
};

const VIOLIN_LO = 60; // C4
const VIOLIN_HI = 79; // G5

function planViolin(
  info: BarInfo[],
  vocal: Span[],
  flute: NoteEvent[][],
  U: number,
  family: ArrangementFamily,
  key: KeySpec | null,
): NoteEvent[][] {
  const out: NoteEvent[][] = info.map(() => []);

  const fluteSpans: Span[] = [];
  flute.forEach((evs, b) => {
    for (const e of evs) {
      fluteSpans.push({ s: b * U + e.u, e: b * U + e.u + e.d, midi: e.midi });
    }
  });
  const overlapping = (spans: Span[], s: number, e: number) =>
    spans.filter((x) => x.s < e && x.e > s);

  /** How badly `m` fights a sounding note: doubling and semitone rubs are worst. */
  const clash = (m: number, o: number) => {
    const c = ic(m, o);
    return c === 0 ? 3 : c === 1 ? 6 : c === 2 ? 1.5 : c === 6 ? 1.5 : 0;
  };
  /** Stay under the vocal and out of the flute's way. */
  const penalty = (m: number, vs: Span[], fs: Span[]) => {
    let worst = 0;
    for (const v of vs) {
      const above = m >= v.midi - 2 ? 2.5 + Math.max(0, m - v.midi) * 0.08 : 0;
      worst = Math.max(worst, clash(m, v.midi) + above);
    }
    let fw = 0;
    for (const f of fs) fw = Math.max(fw, clash(m, f.midi));
    return worst + fw;
  };

  /** The best chord tone for a spot: the third first, the root last, close to `prev`. */
  const bestTone = (
    chord: string,
    vs: Span[],
    fs: Span[],
    prev: number | null,
  ): number | null => {
    const t = chordTones(chord);
    if (!t) return null;
    let best: number | null = null;
    let bestScore = Infinity;
    for (let m = VIOLIN_LO; m <= VIOLIN_HI; m++) {
      const idx = t.pcs.indexOf(mod(m, 12));
      if (idx < 0) continue;
      // third first, then the colour notes, then the fifth, the root last
      let score = idx === 0 ? 4 : idx === 1 ? 0 : idx === 2 ? 1.2 : 0.4;
      score +=
        prev === null ? Math.abs(m - 67) * 0.2 : Math.abs(m - prev) * 0.35;
      score += Math.abs(m - 67) * 0.05;
      score += penalty(m, vs, fs);
      if (score < bestScore) {
        bestScore = score;
        best = m;
      }
    }
    return best;
  };

  const ladder = key ? diatonic(key, VIOLIN_LO, VIOLIN_HI) : [];
  /** The scale note `steps` places above (or below) `m`, or null off the ends. */
  const stepFrom = (m: number, steps: number): number | null => {
    if (!ladder.length) return null;
    let idx = 0;
    for (let k = 1; k < ladder.length; k++) {
      if (Math.abs(ladder[k] - m) < Math.abs(ladder[idx] - m)) idx = k;
    }
    const ni = idx + steps;
    return ni < 0 || ni >= ladder.length ? null : ladder[ni];
  };

  const P: Record<Kind, number> = {
    verse: 0.35,
    chorus: 0.85,
    bridge: 0.65,
    other: 0.6,
  };
  let last: number | null = null;

  for (let bi = 0; bi < info.length; bi++) {
    const b = info[bi];
    if (b.pos % 2 !== 0) continue; // blocks of two bars
    const block = [bi];
    if (
      info[bi + 1] &&
      info[bi + 1].name === b.name &&
      info[bi + 1].occ === b.occ &&
      info[bi + 1].pos === b.pos + 1
    ) {
      block.push(bi + 1);
    }

    const lastBlock = b.pos + 2 >= b.len;
    const endsSong = block.some((j) => info[j].last);
    let p = Math.min(0.95, P[b.kind] * VIOLIN_GAIN[family]);
    if (b.pos === 0 && b.kind !== "chorus") p *= 0.3; // let the vocal come in clean
    if (lastBlock && b.kind === "verse") p = 0.65; // a verse builds into the chorus
    if (b.intro) p = lastBlock ? 0.7 : 0.2; // strings join the intro late
    if (b.outro) p = 0.9; // and sing the song out
    if (b.lift) p = 0.95; // the last chorus always has strings
    if (endsSong) p = 0.9; // swell to the end
    const rand = rng(hash(`v|${b.name}|${b.occ}|${b.pos / 2}`));
    if (rand() >= p) continue;

    // chord runs across the block (a held chord is one long note)
    const entries: { abs: number; chord: string }[] = [];
    for (const j of block) {
      for (const s of info[j].starts)
        entries.push({ abs: j * U + s.u, chord: s.chord });
    }
    if (!entries.length) continue;
    entries[0].abs = bi * U;
    const merged = entries.filter(
      (e, i) => i === 0 || e.chord !== entries[i - 1].chord,
    );
    const blockEnd = (block[block.length - 1] + 1) * U;
    const afterChord =
      info[block[block.length - 1] + 1]?.starts[0]?.chord ?? null;

    // choruses move; everything else holds. Ambient moves slowly, the lift quickly.
    const moves = b.kind === "chorus" && ladder.length > 0 && !endsSong;
    const seg =
      family === "ambient"
        ? U
        : b.lift
          ? Math.max(4, Math.round(U / 4))
          : Math.round(U / 2);

    const velFor = (vs: Span[], s: number, e: number, soft = 0) => {
      let sungUnits = 0;
      for (const v of vs) sungUnits += Math.min(v.e, e) - Math.max(v.s, s);
      const sungFrac = sungUnits / (e - s);
      return clamp(
        ((sungFrac > 0.5 ? 0.34 : 0.46) +
          (b.kind === "chorus" ? 0.04 : 0) +
          VIOLIN_VEL[family] -
          soft) *
          b.gain,
        0.15,
        0.8,
      );
    };
    const push = (s: number, d: number, midi: number, vel: number) => {
      out[Math.floor(s / U)].push({ u: s % U, d, midi, vel });
    };

    merged.forEach((run, k) => {
      const start = run.abs;
      const end = merged[k + 1]?.abs ?? blockEnd;
      if (end - start < 4) return;
      const nextChord = merged[k + 1]?.chord ?? afterChord;

      if (!moves || end - start < Math.round(U / 2)) {
        // held pad: one chord tone for the whole run
        const vs = overlapping(vocal, start, end);
        const fs = overlapping(fluteSpans, start, end);
        const best = bestTone(run.chord, vs, fs, last);
        if (best === null) return;
        last = best;
        push(start, end - start, best, velFor(vs, start, end));
        return;
      }

      // moving line: a chord tone, a passing note, a chord tone ... then a
      // stepwise approach into the next chord
      const pieces: { s: number; e: number }[] = [];
      for (let s = start; s < end; s += seg) {
        pieces.push({ s, e: Math.min(end, s + seg) });
      }
      if (pieces.length > 1) {
        const tail = pieces[pieces.length - 1];
        if (tail.e - tail.s < 4) {
          pieces.pop();
          pieces[pieces.length - 1].e = tail.e;
        }
      }
      let dir = 1;
      pieces.forEach((pc, j) => {
        const vs = overlapping(vocal, pc.s, pc.e);
        const fs = overlapping(fluteSpans, pc.s, pc.e);
        const prev = last;
        let m: number | null = null;
        let passing = false;

        if (j > 0 && prev !== null) {
          if (j === pieces.length - 1 && nextChord) {
            const target = chordToneMidis(nextChord, VIOLIN_LO, VIOLIN_HI).sort(
              (x, y) => Math.abs(x - prev) - Math.abs(y - prev),
            )[0];
            if (target !== undefined) {
              // step in from the side we are on; if that is where we already
              // are (no movement), come in from the other side instead
              const sides = prev > target ? [1, -1] : [-1, 1];
              for (const side of sides) {
                const c = stepFrom(target, side);
                if (c !== null && c !== prev && penalty(c, vs, fs) < 3) {
                  m = c;
                  break;
                }
              }
            }
          } else if (j % 2 === 1) {
            const cands = [
              stepFrom(prev, dir),
              stepFrom(prev, -dir),
              stepFrom(prev, 2 * dir),
            ].filter((x): x is number => x !== null && x !== prev);
            let bestScore = Infinity;
            for (const c of cands) {
              const sc =
                penalty(c, vs, fs) +
                (clashesWithChord(c, run.chord) ? 1.5 : 0) +
                (Math.sign(c - prev) === dir ? 0 : 0.6);
              if (sc < bestScore) {
                bestScore = sc;
                m = c;
              }
            }
          }
          // a passing or approach note must not rub the vocal or the flute
          if (m !== null) {
            if (penalty(m, vs, fs) >= 3) m = null;
            else passing = true;
          }
        }
        if (m === null) m = bestTone(run.chord, vs, fs, prev);
        if (m === null) return;

        if (prev !== null && m !== prev) dir = m > prev ? 1 : -1;
        if (m >= VIOLIN_HI - 3) dir = -1;
        if (m <= VIOLIN_LO + 3) dir = 1;
        last = m;
        push(pc.s, pc.e - pc.s, m, velFor(vs, pc.s, pc.e, passing ? 0.03 : 0));
      });
    });
  }
  return out;
}

/* ----------------------------------- public ----------------------------------- */

export function arrangeSong(
  sections: SongSection[],
  melody: Melody | null,
  beatsPerBar: number,
  genre = "pop",
): Arrangement {
  const family = getArrangementFamily(genre);
  const U = unitsPerBar(beatsPerBar);
  const info = buildInfo(sections, U, beatsPerBar);
  const vocal = vocalSpans(melody, info.length, U);
  const guitar = planGuitar(info, U, beatsPerBar, family);
  const flute = planFlute(info, melody, U, family);
  const violin = planViolin(info, vocal, flute, U, family, melody?.key ?? null);
  return { unitsPerBar: U, guitar, flute, violin };
}

/**
 * Violin notes that began before `startBar` but are still ringing at it, so
 * pressing play from the middle of the song doesn't drop a held note.
 */
export function violinCarry(
  arr: Arrangement,
  startBar: number,
): { midi: number; vel: number; units: number }[] {
  const U = arr.unitsPerBar;
  const at = startBar * U;
  const out: { midi: number; vel: number; units: number }[] = [];
  for (let b = Math.max(0, startBar - 4); b < startBar; b++) {
    for (const e of arr.violin[b] ?? []) {
      const end = b * U + e.u + e.d;
      if (end > at + 2) out.push({ midi: e.midi, vel: e.vel, units: end - at });
    }
  }
  return out;
}
