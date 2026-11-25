// convex/lib/songOptions.ts
// Plain constants shared by the Convex functions AND the React UI.
// (No Convex imports in here, so it is safe to import from client code.)

export const LENGTH_OPTIONS = [
  { key: "short", label: "Short", bars: 16, blurb: "Verse + chorus" },
  {
    key: "standard",
    label: "Standard",
    bars: 32,
    blurb: "2 verses, 2 choruses",
  },
  {
    key: "full",
    label: "Full song",
    bars: 64,
    blurb: "Intro to outro, with a bridge",
  },
] as const;

export type LengthKey = (typeof LENGTH_OPTIONS)[number]["key"];

export const MOOD_SUGGESTIONS = [
  "Hopeful",
  "Melancholy",
  "Nostalgic",
  "Romantic",
  "Angry",
  "Playful",
  "Dreamy",
  "Defiant",
  "Peaceful",
  "Bittersweet",
] as const;

export const GENRES = [
  "Pop",
  "Rock",
  "Folk / Acoustic",
  "Country",
  "Blues",
  "Soul / R&B",
  "Reggae",
  "Indie",
  "Power ballad",
  "Gospel",
  "Jazz",
  "Punk",
  "Lo-fi",
] as const;

export const KEY_OPTIONS = [
  "C",
  "G",
  "D",
  "A",
  "E",
  "B",
  "F#",
  "F",
  "Bb",
  "Eb",
  "Ab",
  "Db",
  "Am",
  "Em",
  "Bm",
  "F#m",
  "C#m",
  "Dm",
  "Gm",
  "Cm",
  "Fm",
  "Bbm",
] as const;

/**
 * `beats` is the number of pulses per bar (what is stored on the song).
 * 6 means 6/8: six eighth-note pulses felt as two groups of three.
 * For 6/8 the tempo (BPM) counts the dotted-quarter, so two beats per bar.
 */
export const TIME_SIGNATURES = [
  { beats: 4, label: "4/4" },
  { beats: 3, label: "3/4" },
  { beats: 6, label: "6/8" },
] as const;

export type BeatsPerBar = (typeof TIME_SIGNATURES)[number]["beats"];

export function timeSignatureLabel(beatsPerBar: number): string {
  return (
    TIME_SIGNATURES.find((t) => t.beats === beatsPerBar)?.label ??
    `${beatsPerBar}/4`
  );
}

export const LIMITS = {
  topicMin: 3,
  topicMax: 600,
  moodMax: 60,
  languageMax: 40,
  titleMax: 80,
  maxBars: 128,
  maxSegmentsPerBar: 6,
  lyricMax: 120,
  minTempo: 40,
  maxTempo: 220,
  dailyGenerations: 30,
} as const;

/** C, Am, F#m7, Gsus4, Dmaj7, D/F#, Bb7b9 … */
export const CHORD_RE = /^[A-G][#b]?[A-Za-z0-9#b+()°ø\-]{0,10}(\/[A-G][#b]?)?$/;

/**
 * Optional extra instruments the user can request when generating a song.
 * Core layers (piano/chords, bass, strings, drums) are always available.
 * These are synthesised in the browser as separate, toggleable voices.
 */
export const EXTRA_INSTRUMENTS = [
  {
    key: "violin",
    label: "Violin",
    description: "Warm bowed solo violin with vibrato",
  },
  {
    key: "electricGuitar",
    label: "Electric Guitar",
    description: "Clean electric guitar with slight drive",
  },
  {
    key: "fluteLead",
    label: "Flute",
    description: "Breathy flute for melody / countermelody",
  },
  {
    key: "shaker",
    label: "Shaker",
    description: "Soft rhythmic shaker / egg shaker",
  },
  {
    key: "tambourine",
    label: "Tambourine",
    description: "Bright tambourine on off-beats",
  },
  {
    key: "percussion",
    label: "Hand Percussion",
    description: "Light conga / bongo fills",
  },
] as const;

export type ExtraInstrumentKey = (typeof EXTRA_INSTRUMENTS)[number]["key"];

export const EXTRA_INSTRUMENT_KEYS = EXTRA_INSTRUMENTS.map(
  (i) => i.key,
) as ExtraInstrumentKey[];
