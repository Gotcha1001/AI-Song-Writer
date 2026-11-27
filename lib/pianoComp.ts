// lib/pianoComp.ts
// How the piano COMPS (accompanies) in each genre. Instead of one rolled block
// chord per chord change, every genre has its own rhythm:
//   reggae  -> short off-beat chops (the "skank") with a soft root on beat 1
//   rock    -> driving eighth-note chords
//   folk    -> "boom-chick" (bass on 1 and 3, chord on 2 and 4)
//   soul    -> long chord with syncopated pushes
//   jazz    -> swung "Charleston" comping
//   ... and so on (see STYLES).
//
// Pure data + one helper, so the player can ask "what does the piano play on
// this beat?" without knowing anything about genres.
//
// Positions are measured in SCHEDULER BEATS from the start of the bar: quarter
// notes in 4/4 and 3/4, eighth notes in 6/8 (that is how the player counts).
// 0.5 is therefore "the and of beat 1" (an off-beat) in 4/4 and 3/4.

export type CompKind = "chord" | "bass";

export interface CompHit {
  /** Beats from the start of the bar. */
  pos: number;
  /** Length in beats. A hit that reaches the end of its chord rings until the chord changes. */
  len: number;
  vel: number;
  kind: CompKind;
  /** bass only: also play the octave above (a fuller left hand). */
  full?: boolean;
}

export interface CompStyle {
  id: string;
  label: string;
  /** Does this style use the sustain pedal (when the pedal switch is on)? Chops stay dry. */
  pedal: boolean;
  /** Seconds between the notes of a chord (a small roll sounds like a hand). 0 = struck together. */
  roll: number;
  hits: { 3: CompHit[]; 4: CompHit[]; 6: CompHit[] };
}

const C = (pos: number, len: number, vel: number): CompHit => ({
  pos,
  len,
  vel,
  kind: "chord",
});
const B = (pos: number, len: number, vel: number, full = false): CompHit => ({
  pos,
  len,
  vel,
  kind: "bass",
  full,
});

/** The same stab on every beat, shifted by `off` (0.5 = the off-beat). */
const everyBeat = (
  beats: number,
  off: number,
  len: number,
  vel: (b: number) => number,
): CompHit[] =>
  Array.from({ length: beats }, (_, b) => C(b + off, len, vel(b)));

const SWING = 2 / 3; // an off-beat eighth, swung

export const COMP_STYLES: Record<string, CompStyle> = {
  /** Slow / big: one sustained chord per chord, bass + octave (the original sound). */
  block: {
    id: "block",
    label: "Sustained chords",
    pedal: true,
    roll: 0.016,
    hits: {
      4: [B(0, 99, 0.72, true), C(0, 99, 0.5)],
      3: [B(0, 99, 0.72, true), C(0, 99, 0.5)],
      6: [B(0, 99, 0.72, true), C(0, 99, 0.5)],
    },
  },

  /** Reggae: dry chops on the off-beat of every beat, bass only on beat 1. */
  reggae: {
    id: "reggae",
    label: "Reggae off-beat skank",
    pedal: false,
    roll: 0.004,
    hits: {
      4: [
        B(0, 0.9, 0.62),
        ...everyBeat(4, 0.5, 0.28, (b) => (b % 2 === 1 ? 0.6 : 0.5)),
        B(2, 0.9, 0.4),
      ],
      3: [B(0, 0.9, 0.62), ...everyBeat(3, 0.5, 0.28, () => 0.52)],
      // 6/8 counted in eighths: chop on the last eighth of each group of three
      6: [B(0, 2.5, 0.62), C(2, 0.6, 0.55), C(5, 0.6, 0.55)],
    },
  },

  /** Pop: bass on 1 and 3, chord pushes with a little syncopation. */
  pop: {
    id: "pop",
    label: "Pop pulse",
    pedal: true,
    roll: 0.012,
    hits: {
      4: [
        B(0, 2, 0.7, true),
        B(2, 2, 0.5),
        C(0, 1.5, 0.52),
        C(1.5, 0.5, 0.42),
        C(2, 1.5, 0.48),
        C(3.5, 0.5, 0.4),
      ],
      3: [B(0, 3, 0.7, true), C(0, 1.5, 0.5), C(1.5, 0.5, 0.4), C(2, 1, 0.45)],
      6: [B(0, 6, 0.7, true), C(0, 3, 0.5), C(3, 3, 0.45)],
    },
  },

  /** Rock / punk: driving eighth-note chords, accented on the beat. */
  rock: {
    id: "rock",
    label: "Driving eighths",
    pedal: false,
    roll: 0.006,
    hits: {
      4: [
        B(0, 2, 0.72, true),
        B(2, 2, 0.62, true),
        ...Array.from({ length: 8 }, (_, i) =>
          C(i / 2, 0.42, i % 2 === 0 ? (i % 4 === 0 ? 0.6 : 0.52) : 0.4),
        ),
      ],
      3: [
        B(0, 3, 0.72, true),
        ...Array.from({ length: 6 }, (_, i) =>
          C(i / 2, 0.42, i % 2 === 0 ? 0.55 : 0.4),
        ),
      ],
      6: [
        B(0, 3, 0.72, true),
        B(3, 3, 0.62, true),
        ...Array.from({ length: 6 }, (_, i) =>
          C(i, 0.85, i % 3 === 0 ? 0.58 : 0.42),
        ),
      ],
    },
  },

  /** Folk / country: "boom-chick" (waltz: "oom-pah-pah"). */
  folk: {
    id: "folk",
    label: "Boom-chick",
    pedal: false,
    roll: 0.01,
    hits: {
      4: [
        B(0, 1.8, 0.7),
        C(1, 0.9, 0.5),
        B(2, 1.8, 0.55, true),
        C(3, 0.9, 0.5),
      ],
      3: [B(0, 1.8, 0.7), C(1, 0.9, 0.48), C(2, 0.9, 0.48)],
      6: [B(0, 2.8, 0.7), C(3, 2.6, 0.5)],
    },
  },

  /** Soul / R&B / gospel: a long chord, then syncopated pushes. */
  soul: {
    id: "soul",
    label: "Soul pushes",
    pedal: true,
    roll: 0.018,
    hits: {
      4: [
        B(0, 99, 0.7, true),
        C(0, 1.4, 0.55),
        C(1.5, 0.5, 0.42),
        C(2.5, 0.5, 0.4),
        C(3.5, 0.5, 0.38),
      ],
      3: [
        B(0, 99, 0.7, true),
        C(0, 1.4, 0.55),
        C(1.5, 0.5, 0.42),
        C(2.5, 0.5, 0.4),
      ],
      6: [
        B(0, 99, 0.7, true),
        C(0, 2.5, 0.55),
        C(3, 1.4, 0.42),
        C(5, 0.8, 0.38),
      ],
    },
  },

  /** Jazz: swung "Charleston" comping, light and off the beat. */
  jazz: {
    id: "jazz",
    label: "Swung comping",
    pedal: false,
    roll: 0.014,
    hits: {
      4: [
        B(0, 1.8, 0.5),
        C(0, 1.4, 0.48),
        C(1 + SWING, 0.5, 0.42),
        C(3, 0.7, 0.38),
        B(2, 1.8, 0.4),
      ],
      3: [B(0, 1.8, 0.5), C(0, 1.4, 0.48), C(1 + SWING, 0.5, 0.42)],
      6: [B(0, 2.8, 0.5), C(0, 2.5, 0.48), C(4, 1.4, 0.4)],
    },
  },

  /** Blues: shuffle chords with a swung off-beat on 2 and 4. */
  blues: {
    id: "blues",
    label: "Shuffle",
    pedal: false,
    roll: 0.01,
    hits: {
      4: [
        B(0, 1.8, 0.66, true),
        C(0, 0.62, 0.55),
        C(1, 0.62, 0.46),
        C(1 + SWING, 0.3, 0.36),
        C(2, 0.62, 0.52),
        C(3, 0.62, 0.46),
        C(3 + SWING, 0.3, 0.36),
        B(2, 1.8, 0.5),
      ],
      3: [
        B(0, 1.8, 0.66, true),
        C(0, 0.62, 0.55),
        C(1, 0.62, 0.46),
        C(2, 0.62, 0.46),
      ],
      6: [B(0, 2.8, 0.66, true), C(0, 1.8, 0.52), C(3, 1.8, 0.48)],
    },
  },

  /** Bossa / latin: syncopated chord stabs over a steady bass. */
  latin: {
    id: "latin",
    label: "Syncopated stabs",
    pedal: false,
    roll: 0.008,
    hits: {
      4: [
        B(0, 1.4, 0.62),
        B(1.5, 0.9, 0.45),
        B(2.5, 0.9, 0.5),
        C(0, 0.9, 0.5),
        C(1.5, 0.5, 0.45),
        C(2.5, 0.5, 0.48),
        C(3.5, 0.5, 0.4),
      ],
      3: [
        B(0, 1.4, 0.62),
        C(0.5, 0.4, 0.46),
        C(1.5, 0.4, 0.46),
        C(2.5, 0.4, 0.42),
      ],
      6: [B(0, 2.8, 0.62), C(1, 0.8, 0.46), C(4, 0.8, 0.46)],
    },
  },

  /** Indie / lo-fi: one soft, long chord with a single lift. */
  soft: {
    id: "soft",
    label: "Soft and sparse",
    pedal: true,
    roll: 0.022,
    hits: {
      4: [B(0, 99, 0.55, true), C(0, 2.5, 0.4), C(2.5, 0.5, 0.3)],
      3: [B(0, 99, 0.55, true), C(0, 2.5, 0.4)],
      6: [B(0, 99, 0.55, true), C(0, 3, 0.4), C(4, 0.8, 0.3)],
    },
  },

  /** Dance: off-beat chord stabs over a four-on-the-floor root. */
  dance: {
    id: "dance",
    label: "Off-beat stabs",
    pedal: false,
    roll: 0,
    hits: {
      4: [
        ...Array.from({ length: 4 }, (_, b) => B(b, 0.4, 0.6)),
        ...everyBeat(4, 0.5, 0.3, () => 0.55),
      ],
      3: [
        ...Array.from({ length: 3 }, (_, b) => B(b, 0.4, 0.6)),
        ...everyBeat(3, 0.5, 0.3, () => 0.55),
      ],
      6: [B(0, 1.2, 0.6), B(3, 1.2, 0.6), C(2, 0.6, 0.5), C(5, 0.6, 0.5)],
    },
  },
};

/** Picks the comping style for a genre name ("Reggae", "Soul / R&B", "Power ballad" ...). */
export function pianoCompFor(genre: string): CompStyle {
  const g = (genre || "").toLowerCase();
  if (/reggae|ska|dub/.test(g)) return COMP_STYLES.reggae;
  if (/ballad|ambient|cinematic|classical|soundtrack/.test(g))
    return COMP_STYLES.block;
  if (/soul|r&b|r\s*and\s*b|gospel|funk/.test(g)) return COMP_STYLES.soul;
  if (/blues/.test(g)) return COMP_STYLES.blues;
  if (/jazz|swing/.test(g)) return COMP_STYLES.jazz;
  if (/latin|salsa|bossa|samba/.test(g)) return COMP_STYLES.latin;
  if (/folk|acoustic|country|bluegrass/.test(g)) return COMP_STYLES.folk;
  if (/rock|metal|punk|alternative/.test(g)) return COMP_STYLES.rock;
  if (/indie|lo-?fi|chill/.test(g)) return COMP_STYLES.soft;
  if (/dance|edm|electro|house|techno/.test(g)) return COMP_STYLES.dance;
  return COMP_STYLES.pop;
}

/** Everything the piano plays inside scheduler beat `beat` of a bar (pos in [beat, beat + 1)). */
export function compHitsAt(
  style: CompStyle,
  beatsPerBar: number,
  beat: number,
): CompHit[] {
  const table =
    beatsPerBar === 3
      ? style.hits[3]
      : beatsPerBar === 6
        ? style.hits[6]
        : style.hits[4];
  return table.filter((h) => h.pos >= beat - 1e-6 && h.pos < beat + 1 - 1e-6);
}
