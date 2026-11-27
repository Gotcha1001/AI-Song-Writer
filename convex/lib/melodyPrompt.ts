// convex/lib/melodyPrompt.ts
// The AI composes the vocal melody bar by bar from the finished lyrics + chords.
// This file builds that prompt and, just as important, CHECKS what comes back:
// a bar is only accepted if its note lengths add up to exactly one bar and it
// has exactly one pitched note per syllable. Bad bars are asked for again, and
// anything still missing falls back to the built-in tune on screen.
//
// How the melody is kept from sounding "cheesy" (a note on every beat, no air):
//   1. buildBarSpecs() works out the PHRASES of the song (lines, cut into
//      breaths of 1-2 bars), which syllables are stressed, and where a singer
//      would breathe. The prompt shows all of that to the AI.
//   2. The prompt carries a genre-specific phrasing guide plus a worked
//      good-vs-cheesy example.
//   3. After the AI answers, repairBar() tidies every bar so it sounds right:
//        - long notes / notes on the beat / the last note of a bar are chord
//          notes (no more F held over Am); quick passing notes move by step
//        - a run of identical note lengths is broken up (a long-short pair on
//          a stressed -> unstressed syllable)
//        - a real breath (rest) is made after every phrase end. The time is
//          taken from a long, unimportant note, not from the word the phrase
//          lands on, so the last word of a line stays held.
//
// Pitches are SCALE DEGREES (0 = tonic, 7 = the octave above, -1 = the note
// below the tonic), so the melody keeps its shape when the song is transposed.
import { timeSignatureLabel } from "./songOptions";
import { barSyllables, capSyllables, type Syllable } from "./syllables";

/* --------------------------------- types ---------------------------------- */

/** One stored note. `deg` missing = a rest. `d` is in sixteenth notes. */
export interface StoredNote {
  d: number;
  deg?: number;
}
export type StoredBar = StoredNote[];

interface SectionLike {
  name: string;
  bars: { segments: { chord?: string; lyric: string }[] }[];
}

/** Size of a short / long breath, in sixteenths. */
export interface Breath {
  short: number;
  long: number;
}

export interface BarSpec {
  /** Position in the whole song (0-based, across all sections). */
  index: number;
  section: string;
  /** 1-based bar number inside its section. */
  barInSection: number;
  /** Chords with the sixteenth they start on. */
  chords: { u: number; chord: string }[];
  /** What is sung, already split into syllables (empty = instrumental). */
  syllables: string[];
  /**
   * Breath wanted AFTER each syllable (same length as `syllables`):
   * 0 = none, 1 = short, 2 = long. Comes from punctuation in the lyric, from
   * the end of every phrase, and from the end of a line (next bar is
   * instrumental / new section).
   */
  pauses: number[];
  /**
   * How much each syllable matters (same length as `syllables`):
   * 2 = stressed syllable of an important word, 1 = medium, 0 = light.
   */
  stress: number[];
  /** Phrase number in the whole song (a phrase = what is sung in one breath). */
  phrase: number;
  /** 1-based position of this bar inside its phrase, and the phrase length. */
  phraseBar: number;
  phraseBars: number;
  /** Size of a short / long breath for this song (genre + tempo). */
  breath: Breath;
  /** Chance (0-1) that a monotone bar gets a dotted long-short pair. */
  dotted: number;
}

/** Extra facts about the song that change how it should be phrased. */
export interface SpecOptions {
  genre?: string;
  tempo?: number;
  language?: string;
}

export const NOTE_LENGTHS = [1, 2, 3, 4, 6, 8, 12, 16];
export const MIN_DEG = -2;
export const MAX_DEG = 8;

export function unitsPerBar(beatsPerBar: number): number {
  return beatsPerBar === 4 ? 16 : 12; // 4/4 -> 16, 3/4 and 6/8 -> 12
}

/* ------------------------------ key + chords ------------------------------ */

const mod7 = (n: number) => ((n % 7) + 7) % 7;

const LETTERS = ["C", "D", "E", "F", "G", "A", "B"];
const LETTER_PC = [0, 2, 4, 5, 7, 9, 11];
const MAJOR = [0, 2, 4, 5, 7, 9, 11];
const MINOR = [0, 2, 3, 5, 7, 8, 10];

interface KeyLite {
  name: string;
  minor: boolean;
  tonicPc: number;
  /** Note names of degrees 0..6, spelled correctly for the key. */
  names: string[];
  /** Pitch class of each degree 0..6. */
  pcs: number[];
}

function parseKeyLite(key: string): KeyLite {
  const m = /^([A-G])([#b]?)(m?)$/.exec(key.trim());
  const letter = m ? LETTERS.indexOf(m[1]) : 0;
  const acc = m ? (m[2] === "#" ? 1 : m[2] === "b" ? -1 : 0) : 0;
  const minor = m ? m[3] === "m" : false;
  const tonicPc = (LETTER_PC[letter] + acc + 12) % 12;
  const scale = minor ? MINOR : MAJOR;
  const pcs = scale.map((s) => (tonicPc + s) % 12);
  const names = pcs.map((pc, i) => {
    const l = (letter + i) % 7;
    const diff = ((pc - LETTER_PC[l] + 18) % 12) - 6; // -1, 0 or +1
    return LETTERS[l] + (diff === 1 ? "#" : diff === -1 ? "b" : "");
  });
  return { name: m ? key.trim() : "C", minor, tonicPc, names, pcs };
}

const CHORD_PARTS = /^([A-G])([#b]?)([^/]*)(?:\/([A-G])([#b]?))?$/;

function chordPcs(chord: string): number[] | null {
  const m = CHORD_PARTS.exec(chord);
  if (!m) return null;
  const root =
    (LETTER_PC[LETTERS.indexOf(m[1])] +
      (m[2] === "#" ? 1 : m[2] === "b" ? -1 : 0) +
      12) %
    12;
  const suffix = m[3];
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
  return [0, third, fifth, ...extra].map((i) => (root + i) % 12);
}

/** The scale degrees (0-6) that are notes of this chord, e.g. "0 2 4". */
function chordDegrees(chord: string, key: KeyLite): string {
  const pcs = chordPcs(chord);
  if (!pcs) return "?";
  const degs = key.pcs
    .map((pc, i) => (pcs.includes(pc) ? i : -1))
    .filter((i) => i >= 0);
  return degs.length ? degs.join(" ") : "none";
}

/* ------------------------------ genre phrasing ----------------------------- */

export interface GenreProfile {
  id: string;
  label: string;
  /** Plain-English phrasing advice that goes straight into the prompt. */
  guide: string;
  breath: Breath;
  /** Longest phrase, in bars, before a breath is forced. */
  phraseBars: number;
  /** Chance (0-1) that a monotone bar gets a dotted long-short pair. */
  dotted: number;
}

const PROFILES: Record<string, Omit<GenreProfile, "id">> = {
  ballad: {
    label: "Power ballad",
    guide:
      "Slow and big. One phrase per breath, with long notes and wide arcs. Verses sit low and intimate with plenty of silence (enter late, leave the downbeat empty now and then). The chorus climbs to the highest note of the song, which is HELD for one to two beats on the most important word, followed by a clear rest. A leap of a 5th or 6th at an emotional peak is right; everywhere else move by step.",
    breath: { short: 2, long: 6 },
    phraseBars: 2,
    dotted: 0.5,
  },
  soul: {
    label: "Soul / R&B / Gospel",
    guide:
      "Smooth and rhythmic; the voice floats over the beat instead of sitting on it. Enter just AFTER the beat (a rest of one eighth on the downbeat is typical). Stretch the emotional word into a long note, often on a high chord note, and leave a deliberate rest before it. Contrast quick syncopated syllables with one big held note per phrase. For gospel, build phrase by phrase and repeat a line one step higher.",
    breath: { short: 2, long: 4 },
    phraseBars: 2,
    dotted: 0.6,
  },
  blues: {
    label: "Blues",
    guide:
      "Conversational and behind the beat, like call and response: sing a short phrase, leave a gap, answer it. Often enter late (a rest on beat 1 or on the first eighth). Lean on chord notes with the odd bluesy passing note, hold the last word of each line, and leave a lot of space; a blues line may only fill half of the bar.",
    breath: { short: 2, long: 6 },
    phraseBars: 2,
    dotted: 0.5,
  },
  jazz: {
    label: "Jazz",
    guide:
      "Relaxed and behind the beat. Syncopated entries, phrases that start on off-beats and finish before the next barline, long held notes against the moving chords, and lots of rests. Do not square everything to the beat.",
    breath: { short: 2, long: 4 },
    phraseBars: 2,
    dotted: 0.6,
  },
  reggae: {
    label: "Reggae",
    guide:
      "Laid back and spacious. The vocal likes the off-beats, with a rest on beat 1 of many bars. Short phrases with a lot of air, a stepwise melody in a small range, and a relaxed held note at the end of each line.",
    breath: { short: 2, long: 4 },
    phraseBars: 2,
    dotted: 0.2,
  },
  folk: {
    label: "Folk / Country",
    guide:
      "Storytelling. Follow the speech rhythm exactly: stressed words are long, light words are quick pick-ups into the next beat. A small, stepwise range (about a 5th or 6th). Breathe after every line and hold the last word of the line for a beat or more. Do not decorate; plain and honest is the sound.",
    breath: { short: 2, long: 4 },
    phraseBars: 2,
    dotted: 0.3,
  },
  indie: {
    label: "Indie / Lo-fi",
    guide:
      "Understated, intimate and half spoken. A very narrow range (a 3rd to a 5th), many repeated notes and small steps, sparse notes, deliberate silences, late entrances and a long soft landing note at the end of each phrase. No big leaps and no showy high notes.",
    breath: { short: 2, long: 4 },
    phraseBars: 2,
    dotted: 0.3,
  },
  rock: {
    label: "Rock",
    guide:
      "Punchy and direct. Stressed words hit on the beats; there are fewer notes and more repeated pitches than in pop (repeating a note three times for drive is fine, never four). Short phrases with clean stops. The chorus ends its lines on a held power note, and a rest lands right after a shouted word.",
    breath: { short: 2, long: 4 },
    phraseBars: 2,
    dotted: 0.35,
  },
  punk: {
    label: "Punk",
    guide:
      "Fast, blunt, almost chanted. Mostly eighths with HARD STOPS: sing a line, stop dead for a beat, sing the next. Narrow range and repeated notes. Only the last word of a line is held.",
    breath: { short: 2, long: 4 },
    phraseBars: 4,
    dotted: 0.15,
  },
  pop: {
    label: "Pop",
    guide:
      "Hook-driven. Short, repeatable phrases of one or two bars, then a breath. Verses are conversational (stepwise, narrow); the chorus lifts and lands its title on a long held note. Add a little syncopation (a stressed word landing just after the beat) and mix eighths with quarters, with one dotted rhythm per phrase. Leave the downbeat of some bars empty so the vocal enters after the chord has landed.",
    breath: { short: 2, long: 4 },
    phraseBars: 2,
    dotted: 0.6,
  },
};

/** Picks the phrasing profile for a genre name (and slows the breaths for slow songs). */
export function genreProfile(genre: string, tempo: number): GenreProfile {
  const g = (genre || "").toLowerCase();
  let id = "pop";
  if (/ballad/.test(g)) id = "ballad";
  else if (/soul|r&b|r\s*and\s*b|gospel/.test(g)) id = "soul";
  else if (/blues/.test(g)) id = "blues";
  else if (/jazz/.test(g)) id = "jazz";
  else if (/reggae/.test(g)) id = "reggae";
  else if (/folk|acoustic|country/.test(g)) id = "folk";
  else if (/indie|lo-?fi/.test(g)) id = "indie";
  else if (/punk/.test(g)) id = "punk";
  else if (/rock/.test(g)) id = "rock";

  const p = PROFILES[id];
  const slow = tempo > 0 && tempo <= 76 && id !== "punk";
  return {
    id,
    ...p,
    breath: slow
      ? { short: p.breath.short, long: Math.max(p.breath.long, 6) }
      : p.breath,
  };
}

/* ------------------------------ word stress -------------------------------- */

// Little words that are sung quickly and lightly.
const LIGHT_WORDS = new Set(
  (
    "a an the and but or nor so if of to in on at by for with from as is am are was were be been " +
    "it its it's that's this that these those there here do does did can will would could should " +
    "just than then too very oh ooh ah uh yeah hey la na da whoa woah"
  ).split(" "),
);
// Pronouns: often stressed in emotional lyrics, so only "medium".
const MEDIUM_WORDS = new Set(
  "i i'm i'll i've i'd you you're you'll your me my we our us he she his her him they them their mine".split(
    " ",
  ),
);
// A new phrase may start here, so a short breath right before one of these
// reads naturally ("…and I keep waiting | for the rain").
const BREAK_BEFORE = new Set(
  "and but when while that if as because cause until 'til till or so where who which then".split(
    " ",
  ),
);
// Two-syllable words with a first syllable that looks like a prefix but where
// the stress still falls on the first syllable.
const FIRST_STRESS = new Set(["any", "many", "reason", "season", "person"]);
const PREFIXES = new Set([
  "a",
  "be",
  "re",
  "de",
  "ex",
  "dis",
  "mis",
  "pre",
  "per",
  "sur",
  "en",
  "em",
  "com",
  "con",
]);

const cleanWord = (s: string) => s.toLowerCase().replace(/[^\p{L}']/gu, "");

interface Analysis {
  stress: number[];
  /** wordStart[i] = syllable i starts a word. */
  wordStart: boolean[];
  /** The cleaned word that syllable i belongs to. */
  word: string[];
}

/** Works out which syllables of one bar are stressed. A hint, not a rule. */
function analyzeSyllables(syl: Syllable[], english: boolean): Analysis {
  const stress: number[] = new Array(syl.length).fill(1);
  const wordStart: boolean[] = new Array(syl.length).fill(false);
  const word: string[] = new Array(syl.length).fill("");

  let i = 0;
  while (i < syl.length) {
    let j = i;
    while (j < syl.length - 1 && syl[j].joinNext) j++;
    // syllables i..j are one word
    const parts = syl.slice(i, j + 1).map((s) => s.text);
    const w = cleanWord(parts.join(""));
    wordStart[i] = true;
    for (let k = i; k <= j; k++) word[k] = w;

    if (!english) {
      if (j === i) stress[i] = 1;
      else for (let k = i; k <= j; k++) stress[k] = k === i ? 2 : 0;
    } else if (j === i) {
      stress[i] = LIGHT_WORDS.has(w) ? 0 : MEDIUM_WORDS.has(w) ? 1 : 2;
    } else {
      let main = 0;
      if (
        parts.length === 2 &&
        !FIRST_STRESS.has(w) &&
        PREFIXES.has(cleanWord(parts[0]))
      )
        main = 1;
      for (let k = i; k <= j; k++) stress[k] = k - i === main ? 2 : 0;
    }
    i = j + 1;
  }
  return { stress, wordStart, word };
}

/* -------------------------------- bar specs -------------------------------- */

const STRONG_END = /[.!?…]+["'”’)\]]*$/;
const SOFT_END = /[,;:—–]+["'”’)\]]*$/;

/** 0 = no breath, 1 = short breath, 2 = long breath after this syllable. */
function pauseLevel(text: string): number {
  const t = text.trim();
  if (STRONG_END.test(t)) return 2;
  if (SOFT_END.test(t)) return 1;
  return 0;
}

/**
 * One entry per bar of the song, with its chords, syllables, stress and breath
 * points worked out. Sung bars that follow each other are grouped into
 * phrases (a "line"), and every phrase ends with a breath.
 */
export function buildBarSpecs(
  sections: SectionLike[],
  beatsPerBar: number,
  opts: SpecOptions = {},
): BarSpec[] {
  const U = unitsPerBar(beatsPerBar);
  const pulseUnits = beatsPerBar === 6 ? 2 : 4;
  const profile = genreProfile(opts.genre ?? "", opts.tempo ?? 0);
  const english = !opts.language || /^\s*(english|en)\b/i.test(opts.language);
  const denseAt = beatsPerBar === 4 ? 7 : 5;
  const out: BarSpec[] = [];
  let last = "";

  for (const section of sections) {
    section.bars.forEach((bar, bi) => {
      const segs = bar.segments;
      const chords: { u: number; chord: string }[] = [];
      segs.forEach((seg, i) => {
        if (!seg.chord) return;
        const startBeat = Math.floor((i * beatsPerBar) / segs.length);
        chords.push({ u: startBeat * pulseUnits, chord: seg.chord });
      });
      if (chords.length === 0 && last) chords.push({ u: 0, chord: last });
      if (chords.length) last = chords[chords.length - 1].chord;

      const syl = capSyllables(barSyllables(segs), U);
      const syllables = syl.map((s) => s.text);
      const analysis = analyzeSyllables(syl, english);
      const pauses = syllables.map((t) => pauseLevel(t));

      // A crowded bar with no punctuation gets one small breath at a natural
      // joint (right before "and", "but", "when" ...), nearest the middle.
      if (
        english &&
        syllables.length >= denseAt &&
        pauses.slice(0, -1).every((p) => p === 0)
      ) {
        let best = -1;
        let bestDist = Infinity;
        for (let k = 1; k < syllables.length - 1; k++) {
          if (!analysis.wordStart[k + 1]) continue; // must be a word boundary
          if (!BREAK_BEFORE.has(analysis.word[k + 1])) continue;
          const dist = Math.abs(k + 0.5 - syllables.length / 2);
          if (dist < bestDist) {
            bestDist = dist;
            best = k;
          }
        }
        if (best >= 0) pauses[best] = 1;
      }

      out.push({
        index: out.length,
        section: section.name,
        barInSection: bi + 1,
        chords,
        syllables,
        pauses,
        stress: analysis.stress,
        phrase: 0,
        phraseBar: 1,
        phraseBars: 1,
        breath: profile.breath,
        dotted: profile.dotted,
      });
    });
  }

  // Group sung bars into lines (until an instrumental bar or a new section),
  // then cut every line into phrases: at punctuation, or after `phraseBars`.
  // Every phrase ends with a breath; the end of a line gets the long one.
  const sung = (s: BarSpec | undefined) => !!s && s.syllables.length > 0;
  const endsWithPunctuation = (s: BarSpec) =>
    s.pauses.length > 0 && s.pauses[s.pauses.length - 1] > 0;
  let phraseNo = 0;
  let i = 0;
  while (i < out.length) {
    if (!sung(out[i])) {
      i++;
      continue;
    }
    let j = i;
    while (
      j + 1 < out.length &&
      sung(out[j + 1]) &&
      out[j + 1].section === out[i].section
    )
      j++;

    let start = i;
    for (let k = i; k <= j; k++) {
      const len = k - start + 1;
      const lineEnd = k === j;
      const cut =
        lineEnd || endsWithPunctuation(out[k]) || len >= profile.phraseBars;
      if (!cut) continue;
      for (let m = start; m <= k; m++) {
        out[m].phrase = phraseNo;
        out[m].phraseBar = m - start + 1;
        out[m].phraseBars = len;
      }
      phraseNo++;
      const tail = out[k].pauses.length - 1;
      const want = lineEnd ? 2 : 1;
      if (out[k].pauses[tail] < want) out[k].pauses[tail] = want;
      start = k + 1;
    }
    i = j + 1;
  }
  return out;
}

/* --------------------------------- prompt --------------------------------- */

/** Fresh ideas, so "New melody" does not give the same tune twice. */
const CREATIVE_HINTS = [
  "Open the verse with a pickup-style start on the 5th degree (4) and let the line fall gently.",
  "Build the chorus around one short, catchy motif of 3 to 4 notes that returns with small changes.",
  "Let the first phrase climb in small steps and the answering phrase come back down in a different rhythm.",
  "Use a wide leap (a 4th or 5th) once per chorus on an important word, then step back down.",
  "Keep the verse narrow (a range of about a 5th) and let the chorus open up to the octave.",
  "Use a long held note at the end of every second bar, with livelier notes before it.",
  "Start phrases on the 3rd degree (2) and aim for the 5th (4) at the high point of each phrase.",
  "Add a little syncopation: let some stressed words land just after the beat.",
  "Make each phrase end on a different stable note (0, 2 or 4) so the tune never feels stuck.",
  "Use a rising sequence: the same small shape repeated a step higher on the next bar.",
  "Contrast the bridge by starting higher and moving more slowly than the verses.",
  "Echo the first half of a phrase in the second half, but finish somewhere new.",
  "Leave deliberate rests after short phrases so the singer can breathe; do not fill every bar edge-to-edge.",
  "End many bars with a rest or a long held note rather than packing notes into the last beat.",
  "Prefer sparse, singable lines with air around them over continuous streams of eighth notes.",
  "Use a rest on the downbeat of a bar occasionally, so the vocal enters after the chord has landed.",
  "Let the first bar of each phrase start with a small rest (an eighth or a beat) and the answer bar start straight on the beat.",
  "Make the title word or the most important word of each chorus the longest note of the chorus.",
  "Sing the verse almost like speech: repeat the same note for the lightest words, move only on the stressed ones.",
  "Anticipate: let one unstressed syllable per phrase slip in a sixteenth early, just before a strong beat.",
];

export function pickHints(count = 2): string[] {
  const pool = [...CREATIVE_HINTS];
  const picked: string[] = [];
  while (picked.length < count && pool.length) {
    const i = Math.floor(Math.random() * pool.length);
    picked.push(pool.splice(i, 1)[0]);
  }
  return picked;
}

export interface MelodyPromptInput {
  title: string;
  key: string;
  tempo: number;
  beatsPerBar: 3 | 4 | 6;
  mood: string;
  genre: string;
  language: string;
  specs: BarSpec[];
  /** Bars the model must write in this call. */
  wanted: number[];
  /** Bars already accepted (shown so the tune stays consistent). */
  done: Map<number, StoredBar>;
  hints: string[];
}

/** The syllables of a bar as the AI sees them: STRESSED in capitals, light ones in lowercase. */
function describeSyllables(spec: BarSpec): string {
  return spec.syllables
    .map((t, i) => {
      const word = spec.stress[i] === 2 ? t.toUpperCase() : t.toLowerCase();
      const mark =
        spec.pauses[i] === 2 ? " ||" : spec.pauses[i] === 1 ? " |" : "";
      return `${word}${mark}`;
    })
    .join(" · ");
}

function describeBar(spec: BarSpec, key: KeyLite): string {
  const chords = spec.chords
    .map(
      (c) => `${c.chord}@${c.u} (chord notes: ${chordDegrees(c.chord, key)})`,
    )
    .join(", ");
  const breaths = spec.pauses
    .map((p, i) =>
      p > 0
        ? `${i + 1}(${p === 2 ? `LONG, ${spec.breath.long}` : `short, ${spec.breath.short}`} sixteenths)`
        : "",
    )
    .filter(Boolean)
    .join(", ");
  const where =
    spec.phraseBars > 1
      ? `phrase ${spec.phrase + 1}, bar ${spec.phraseBar} of ${spec.phraseBars}`
      : `phrase ${spec.phrase + 1}, one bar`;
  return `#${spec.index} [${spec.section}, bar ${spec.barInSection} · ${where}] chords: ${chords || "same as before"} | ${spec.syllables.length} syllables: ${describeSyllables(spec)}${breaths ? ` | BREATH after syllable ${breaths}` : ""}`;
}

function formatDone(bar: StoredBar): string {
  return JSON.stringify(bar.map((n) => [n.d, n.deg ?? null]));
}

export function buildMelodyPrompt(input: MelodyPromptInput): {
  system: string;
  user: string;
} {
  const key = parseKeyLite(input.key);
  const U = unitsPerBar(input.beatsPerBar);
  const compound = input.beatsPerBar === 6;
  const meter = timeSignatureLabel(input.beatsPerBar);
  const profile = genreProfile(input.genre, input.tempo);

  const strongBeats =
    input.beatsPerBar === 4
      ? "units 0 and 8 are the strong beats (beats 1 and 3); units 4 and 12 are the secondary beats"
      : input.beatsPerBar === 3
        ? "unit 0 is the strong beat (beat 1); units 4 and 8 are weaker beats"
        : "units 0 and 6 are the two main pulses (ONE-two-three FOUR-five-six); the eighths in between are weaker";

  const scaleLine = key.names
    .map((n, i) => `${i}=${n}`)
    .concat(`7=${key.names[0]} (octave up)`)
    .join("  ");

  const tempoFeel =
    input.tempo <= 76
      ? "This is a SLOW song: every phrase should stretch out, with long notes and generous rests."
      : input.tempo >= 140
        ? "This is a FAST song: phrases are compact and punchy, but a short stop at the end of every phrase is still essential."
        : "";

  const system = `You are a gifted topline writer and vocal coach. You are given the finished lyrics and chords of a song, one bar at a time. Compose the VOCAL MELODY exactly the way a real singer would perform it: in phrases, with breaths, with the important words held and the light words tossed away. It must sound like a real, memorable song and not like a scale exercise or a children's tune.

Reply with ONE JSON object and nothing else: no markdown, no code fences, no commentary.

JSON shape:
{ "bars": [ { "i": 0, "notes": [[2, null], [4, 4], [2, 3], [6, 2], [2, null]] }, { "i": 1, "notes": [[2, 0], [4, 2], [2, 1], [4, 0], [4, null]] } ] }

"i" is the bar number exactly as written in the list (#0, #1 ...). Each note is [length, degree].

HARD RULES (a bar that breaks any of these is thrown away):
1. LENGTH is counted in sixteenth notes and must be one of 1, 2, 3, 4, 6, 8, 12, 16 (2 = an eighth note, 4 = a quarter, 3 = a dotted eighth, 6 = a dotted quarter, 8 = a half note, 12 = a dotted half, 16 = a whole note).
2. The lengths in one bar must add up to EXACTLY ${U}. This song is in ${meter}: ${strongBeats}.
3. DEGREE is a whole number: a position in the key's own scale. ${scaleLine}. 0 is the tonic, 7 is the tonic an octave higher, -1 is the scale note just below the tonic. Allowed range: ${MIN_DEG} to ${MAX_DEG}; most notes should live between 0 and 7. Use null for a rest.
4. A pitched note carries one syllable. The number of notes that are NOT rests must equal the number of syllables listed for that bar, and the syllables are sung in the order they are written. A "|" after a syllable means a short breath and "||" a long breath: the note carrying that syllable MUST be followed immediately by a rest (null) of at least the stated length, and the other notes of the bar shrink to make room. A bar may also begin with a rest (a late entrance), and may contain further rests wherever a singer would breathe. Rests are part of the melody, not decoration.
5. Do not write bars that are not asked for.
6. HARMONY. Over each chord, every note that is long (a quarter or longer), lands on a beat, or is the LAST note of the bar must be one of that chord's "chord notes". Any other scale note may only be a QUICK passing note (an eighth or shorter) that is reached by step and left by step (one degree up or down). Never leap onto a non-chord note. In a minor key degrees 5 and 6 (the flat 6th and flat 7th) clash when held over the tonic chord, e.g. F over Am: use them only as quick passing notes that continue by step, never as a held or leapt-to note.
7. RHYTHM. Use length 3 only as a dotted eighth followed by a 1 (3 then 1), and length 6 only followed by a 2 (6 then 2); never two dotted values side by side.

HOW A REAL SINGER PHRASES (follow this recipe for every bar):
1. SPEAK THE LINE FIRST. In the bar list, STRESSED syllables are in CAPITALS and light syllables in lowercase. The capitals are the notes the listener actually hears; the lowercase ones are quick pick-ups that lead into the next capital. Do not give all syllables the same weight.
2. FIND THE LANDING WORD. The syllable just before a "|" or "||" is where the phrase lands. Give it the longest note of its phrase (a quarter or longer) on a chord note, then the rest. A phrase that does not land sounds like a scale exercise.
3. THINK IN BREATHS, NOT BARS. A phrase is what is sung in one breath (the list says "phrase 3, bar 1 of 2"). The first bar of a phrase may start with a small rest or a pick-up; the middle moves; the last bar lands and breathes. Never put a rest in the middle of a word or between a light word and the word it leads into.
4. VARY THE RHYTHM. Mix eighths, quarters, dotted notes and held notes. Never give two neighbouring bars the same rhythm, never write more than three equal-length notes in a row, and in every bar with three or more notes make at least one note clearly longer than the rest. Let a stressed word land just after the beat now and then (syncopation).
5. LEAVE AIR. Do not fill every sixteenth. A good sung bar usually has a rest or ends on a held note; in a 2-bar phrase, one bar can be busy as long as the other is open. A bar that is full of notes edge to edge is almost always wrong.
6. SHAPE THE CONTOUR. Give each phrase one high point, placed on its most important word. Reach it by step or by a single leap, then let the line fall back to a chord note. Repeating a note on light words is natural speech; running up or down the scale is not.

THE CHEESY SOUND TO AVOID: a note on every beat, all notes the same length, a straight staircase up or down the scale, every bar starting right on the downbeat, no rest anywhere, the landing word as short as the pick-up words.

WORKED EXAMPLE (key of C major, 4/4, so 16 sixteenths per bar).
Bar A, chord C@0 (chord notes: 0 2 4), 3 syllables: WALK · ing · HOME |
  GOOD: [[2,null],[4,4],[2,3],[6,2],[2,null]]
  Why it works: the voice enters one eighth after the downbeat; the stressed WALK is a quarter note on a chord note; "ing" is a quick passing note that steps down; the landing word HOME is a long dotted-quarter on a chord note; then a rest to breathe.
Bar B, chord Am@0 (chord notes: 0 2 5), 4 syllables: the · TOWN · is · STILL ||
  BAD (cheesy): [[4,0],[4,1],[4,2],[4,3]]
  Why it fails: four equal quarter notes climbing the scale, every word weighted equally, no landing, no rest.
  GOOD: [[2,0],[4,2],[2,1],[4,0],[4,null]]
  Why it works: the light "the" is a quick pick-up; TOWN is a longer note that lands just off the beat (syncopation); "is" is a quick step down; STILL is held on the tonic (a chord note) and is followed by a full-beat rest, a proper breath.
Your bars should have this same feel: different lengths, held landing words, quick light syllables and real silence.

GENRE PHRASING: ${profile.label}. ${profile.guide}
Breath sizes for this song: a short breath ("|") is ${profile.breath.short} sixteenths, a long breath ("||") is ${profile.breath.long} sixteenths. ${tempoFeel}

ALSO:
- Fit the chords: on strong beats prefer the "chord notes" listed for the chord that is sounding at that moment. Between them use passing notes. The chord position "@N" says the sixteenth a chord starts on.
- Mostly move by step. Leaps up to a 5th (4 degrees) are good for drama; after a leap, step back the other way. Do not repeat the same note more than 3 times in a row.
- Phrases answer each other: a question and an answer. End each phrase on a stable note (usually a chord note, often 0, 2 or 4). End the very last bar of the song on 0 (or 7), as a long note.
- Shape the song: verses sit lower and calmer, a pre-chorus builds, the chorus is the highest, most singable and most memorable part, the bridge contrasts.
- Repeat on purpose: sections with the same name, and lines that repeat, share the same tune. Verse 2 echoes Verse 1 with small variations; choruses are nearly identical. Adapt the rhythm to the new syllables, keep the shape of the tune.
- Space and silence are as important as the notes. Prefer a few well-placed notes with air around them over a wall of continuous melody.
- Instrumental bars are not listed; skip them.`;

  const wantedSet = new Set(input.wanted);
  const listed: string[] = [];
  let currentSection = "";
  for (const spec of input.specs) {
    if (spec.syllables.length === 0) continue; // instrumental: no tune needed
    if (spec.section !== currentSection) {
      currentSection = spec.section;
      listed.push(`\n== ${currentSection} ==`);
    }
    const line = describeBar(spec, key);
    const done = input.done.get(spec.index);
    if (wantedSet.has(spec.index)) listed.push(`WRITE  ${line}`);
    else if (done)
      listed.push(`done   ${line}\n         notes: ${formatDone(done)}`);
    else listed.push(`skip   ${line}`);
  }

  const wantedList = [...wantedSet].sort((a, b) => a - b);
  const header = [
    `Song: "${input.title}"`,
    `Key: ${key.name} (${key.minor ? "natural minor" : "major"}) | Tempo: ${input.tempo} BPM${compound ? " (dotted-quarter beats)" : ""} | Time: ${meter} (${U} sixteenths per bar)`,
    `Mood: ${input.mood} | Genre: ${input.genre} | Lyrics language: ${input.language}`,
    `Creative direction for this version: ${input.hints.join(" ")}`,
  ];

  const user = `${header.join("\n")}

Lines marked WRITE need a melody from you. Lines marked "done" are already composed (their notes are shown: keep the new bars consistent with them). Lines marked "skip" are only context.
In each line, CAPITAL syllables are stressed, "|" / "||" mark a short / long breath, and "phrase N" tells you which bars are sung in one breath.
${listed.join("\n")}

Compose the melody now. Return notes for exactly these bars: ${wantedList.map((n) => `#${n}`).join(", ")}.`;

  return { system, user };
}

/* --------------------------------- parsing --------------------------------- */

function extractJson(raw: string): unknown {
  // Reasoning models sometimes put <think>…</think> in the content.
  const cleaned = raw
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/```(?:json)?/gi, "")
    .trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end <= start)
    throw new Error("The model did not return JSON");
  return JSON.parse(cleaned.slice(start, end + 1));
}

function asRecord(x: unknown): Record<string, unknown> {
  return x && typeof x === "object" ? (x as Record<string, unknown>) : {};
}

/** Pieces to pad a bar with when the model's lengths came up a little short. */
function restPieces(left: number): number[] {
  const out: number[] = [];
  for (const p of [16, 12, 8, 6, 4, 3, 2, 1]) {
    while (left >= p) {
      out.push(p);
      left -= p;
    }
  }
  return out;
}

/**
 * Turns one raw bar from the model into a clean stored bar, or null if it can't
 * be trusted. `syllableCount` is how many pitched notes the bar must have.
 */
export function validateBar(
  rawNotes: unknown,
  syllableCount: number,
  U: number,
): StoredBar | null {
  if (!Array.isArray(rawNotes) || rawNotes.length === 0) return null;

  const notes: StoredBar = [];
  for (const item of rawNotes) {
    let d: unknown;
    let deg: unknown;
    if (Array.isArray(item)) {
      d = item[0];
      deg = item[1];
    } else {
      const r = asRecord(item);
      d = r.d ?? r.length ?? r.len;
      deg = r.deg ?? r.degree ?? r.p ?? r.pitch;
    }
    const dur = Number(d);
    if (!Number.isFinite(dur) || !NOTE_LENGTHS.includes(dur)) return null;

    if (deg === null || deg === undefined || deg === "rest") {
      notes.push({ d: dur });
      continue;
    }
    const pitch = Math.round(Number(deg));
    if (!Number.isFinite(pitch) || pitch < MIN_DEG || pitch > MAX_DEG)
      return null;
    notes.push({ d: dur, deg: pitch });
  }

  const sung = notes.filter((n) => n.deg !== undefined).length;
  if (sung !== syllableCount) return null;

  const total = notes.reduce((a, n) => a + n.d, 0);
  if (total > U) return null;
  if (total < U) for (const p of restPieces(U - total)) notes.push({ d: p });

  return notes;
}

/* --------------------------------- repair ---------------------------------- */

/** What repairBar needs to know about a bar (a BarSpec fits; older callers may pass less). */
export interface RepairSpec {
  chords: { u: number; chord: string }[];
  pauses: number[];
  stress?: number[];
  breath?: Breath;
  dotted?: number;
  index?: number;
}

// Lengths a shortened note may end up with (3 and 6 need a partner, so they are avoided).
const PLAIN_LENGTHS = [1, 2, 4, 8, 12, 16];
// How much a note gives up when it has to make room for a breath.
const GIVE: Record<number, number> = {
  2: 1,
  3: 2,
  4: 2,
  6: 4,
  8: 4,
  12: 8,
  16: 8,
};

function hash32(str: string): number {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function rand32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const sungIndexes = (bar: StoredBar): number[] => {
  const out: number[] = [];
  bar.forEach((n, i) => {
    if (n.deg !== undefined) out.push(i);
  });
  return out;
};

/**
 * Breaks up a monotone bar. When four or more neighbouring notes have the same
 * length, a stressed syllable followed by a lighter one becomes a long-short
 * pair (eighth+eighth -> dotted eighth+sixteenth, quarter+quarter -> dotted
 * quarter+eighth). Total length, note count and pitches never change.
 */
function shapeRhythm(bar: StoredBar, spec: RepairSpec): StoredBar {
  const gate = spec.dotted ?? 0;
  const sung = sungIndexes(bar);
  if (gate <= 0 || sung.length < 4) return bar;

  let run = 1;
  let longest = 1;
  for (let k = 1; k < sung.length; k++) {
    const a = bar[sung[k - 1]];
    const b = bar[sung[k]];
    if (sung[k] === sung[k - 1] + 1 && a.d === b.d) {
      run++;
      longest = Math.max(longest, run);
    } else run = 1;
  }
  if (longest < 4) return bar;

  const rand = rand32(hash32(`shape|${spec.index ?? 0}`));
  if (rand() > gate) return bar;

  const stress = spec.stress ?? [];
  const pauses = spec.pauses;
  const cands: { k: number; score: number }[] = [];
  for (let k = 0; k < sung.length - 1; k++) {
    const a = bar[sung[k]];
    const b = bar[sung[k + 1]];
    if (sung[k + 1] !== sung[k] + 1 || a.d !== b.d) continue;
    if (a.d !== 2 && a.d !== 4) continue;
    if ((pauses[k + 1] ?? 0) > 0) continue; // never shrink a landing note
    const diff = (stress[k] ?? 1) - (stress[k + 1] ?? 1);
    if (diff <= 0) continue;
    cands.push({ k, score: diff * 10 + rand() });
  }
  cands.sort((x, y) => y.score - x.score);

  const out = bar.map((n) => ({ ...n }));
  const taken = new Set<number>();
  let budget = Math.max(1, Math.floor(longest / 4));
  for (const { k } of cands) {
    if (budget <= 0) break;
    if (taken.has(k) || taken.has(k + 1) || taken.has(k - 1)) continue;
    const i = sung[k];
    const j = sung[k + 1];
    const d = out[i].d;
    out[i] = { ...out[i], d: d === 2 ? 3 : 6 };
    out[j] = { ...out[j], d: d === 2 ? 1 : 2 };
    taken.add(k);
    taken.add(k + 1);
    budget--;
  }
  return out;
}

/**
 * Makes sure every syllable that wants a breath is followed by a real rest.
 * The time comes from a long note that matters least, so the word the phrase
 * lands on stays held. When no single note can give enough, several notes
 * each give a little (quick syllables become sixteenths, like patter).
 */
function insertBreaths(bar: StoredBar, spec: RepairSpec, U: number): StoredBar {
  const breath = spec.breath ?? { short: 2, long: 4 };
  const cap = Math.max(1, Math.floor(U / 2));
  const stress = spec.stress ?? [];
  let cur = bar.map((n) => ({ ...n }));

  for (let s = 0; s < spec.pauses.length; s++) {
    const level = spec.pauses[s] ?? 0;
    if (level <= 0) continue;
    const wanted = Math.min(level >= 2 ? breath.long : breath.short, cap);

    const idxs = sungIndexes(cur);
    const i = idxs[s];
    if (i === undefined) continue;

    // rests that already follow the syllable
    let restEnd = i;
    let existing = 0;
    while (restEnd + 1 < cur.length && cur[restEnd + 1].deg === undefined) {
      restEnd++;
      existing += cur[restEnd].d;
    }
    if (existing >= wanted) continue;
    const need = wanted - existing;

    // 1. one note gives up the time (the longest, lightest one that is not the landing word)
    let donor = -1; // position in `idxs`
    let give = 0;
    let bestScore = -Infinity;
    idxs.forEach((ci, k) => {
      const d = cur[ci].d;
      for (let a = need; a <= need + 2; a++) {
        const left = d - a;
        if (!PLAIN_LENGTHS.includes(left)) continue;
        // never crush an important word down to a sixteenth
        if (left === 1 && (stress[k] ?? 1) >= 1) continue;
        const score =
          d * 0.5 -
          2 * (stress[k] ?? 1) -
          (k === s ? 2.5 : 0) -
          ((spec.pauses[k] ?? 0) > 0 && k !== s ? 3 : 0) -
          (a - need) * 1.5 -
          (left === 1 ? 1 : 0);
        if (score > bestScore) {
          bestScore = score;
          donor = k;
          give = a;
        }
      }
    });

    let freed = 0;
    if (donor >= 0) {
      const ci = idxs[donor];
      cur[ci] = { ...cur[ci], d: cur[ci].d - give };
      freed = give;
    } else {
      // 2. several notes each give a little, lightest and closest first
      const order = idxs
        .map((ci, k) => ({ ci, k }))
        .filter(({ ci }) => GIVE[cur[ci].d] !== undefined)
        .sort(
          (x, y) =>
            (x.k === s ? 100 : 0) +
            (stress[x.k] ?? 1) * 10 +
            Math.abs(x.k - s) -
            ((y.k === s ? 100 : 0) +
              (stress[y.k] ?? 1) * 10 +
              Math.abs(y.k - s)),
        );
      for (const { ci } of order) {
        if (freed >= need) break;
        const g = GIVE[cur[ci].d];
        cur[ci] = { ...cur[ci], d: cur[ci].d - g };
        freed += g;
      }
    }
    if (freed === 0) continue;

    // replace the old rests after the syllable by one merged rest
    const merged = restPieces(existing + freed).map((d) => ({ d }));
    cur = [...cur.slice(0, i + 1), ...merged, ...cur.slice(restEnd + 1)];
  }
  return cur;
}

/**
 * Tidies a validated bar so it sounds right (the note count, syllable count
 * and total length never change):
 *   1. Harmony: a note that is long, on a beat, or the last of the bar must be
 *      a chord note of the chord sounding then; otherwise it is snapped to the
 *      nearest chord note. A non-chord note is only kept as a quick passing
 *      note moved into and out of by step. Huge leaps are pulled an octave in.
 *   2. Rhythm: a bar of identical note lengths gets a long-short pair on a
 *      stressed -> light syllable, so it stops sounding mechanical.
 *   3. Breath: after every syllable that wants a breath (see BarSpec.pauses)
 *      there is a real rest, taken from a long, unimportant note. The AI's own
 *      rests are kept.
 *
 * @param prevDeg last sung degree of the bar before, or null at a section start
 */
export function repairBar(
  bar: StoredBar,
  spec: RepairSpec,
  key: string,
  beatsPerBar: number,
  prevDeg: number | null = null,
): StoredBar {
  if (!bar.length) return bar;
  const k = parseKeyLite(key);
  const U = unitsPerBar(beatsPerBar);
  const beat = beatsPerBar === 6 ? 6 : 4;

  const chordPcsAt = (u: number): number[] | null => {
    let c: string | undefined;
    for (const x of spec.chords) if (x.u <= u) c = x.chord;
    c = c ?? spec.chords[0]?.chord;
    return c ? chordPcs(c) : null;
  };
  const isChordDeg = (deg: number, pcs: number[]) =>
    pcs.includes(k.pcs[mod7(deg)]);

  /* ---- 1. harmony ---- */
  const starts: number[] = [];
  let t = 0;
  for (const n of bar) {
    starts.push(t);
    t += n.d;
  }
  const sungIdx = sungIndexes(bar);
  const degs: (number | undefined)[] = bar.map((n) => n.deg);

  let prev = prevDeg;
  sungIdx.forEach((i, si) => {
    let d = degs[i] as number;
    const pcs = chordPcsAt(starts[i]);
    const nextI = sungIdx[si + 1];
    const next = nextI === undefined ? null : (degs[nextI] as number);

    if (pcs && !isChordDeg(d, pcs)) {
      const isLast = si === sungIdx.length - 1;
      const mustBeChordNote = bar[i].d >= 4 || starts[i] % beat === 0 || isLast;
      const stepwise =
        prev !== null &&
        next !== null &&
        Math.abs(d - prev) <= 1 &&
        Math.abs(d - next) <= 1;
      if (mustBeChordNote || !stepwise) {
        let best = d;
        let bestCost = Infinity;
        for (let c = MIN_DEG; c <= MAX_DEG; c++) {
          if (!isChordDeg(c, pcs)) continue;
          let cost = Math.abs(c - d);
          if (prev !== null) {
            cost += 0.3 * Math.abs(c - prev);
            if (c === prev) cost += 0.8;
          }
          if (next !== null && c === next) cost += 0.8;
          if (cost < bestCost - 1e-9) {
            bestCost = cost;
            best = c;
          }
        }
        d = best;
      }
    }

    // pull a huge leap an octave closer (same note name, so same harmony)
    if (prev !== null && Math.abs(d - prev) > 5) {
      const alt = d > prev ? d - 7 : d + 7;
      if (
        alt >= MIN_DEG &&
        alt <= MAX_DEG &&
        Math.abs(alt - prev) < Math.abs(d - prev)
      )
        d = alt;
    }
    degs[i] = d;
    prev = d;
  });

  const fixed: StoredBar = bar.map((n, i) =>
    n.deg === undefined ? { d: n.d } : { d: n.d, deg: degs[i] as number },
  );

  /* ---- 2. rhythm, 3. breath ---- */
  const out = insertBreaths(shapeRhythm(fixed, spec), spec, U);
  const total = out.reduce((a, n) => a + n.d, 0);
  const sungCount = sungIndexes(out).length;
  return total === U && sungCount === sungIdx.length ? out : fixed;
}

/**
 * Reads the model's reply and returns every bar that passed the checks.
 * Only bars in `wanted` are looked at.
 */
export function parseMelodyJson(
  raw: string,
  specs: BarSpec[],
  wanted: number[],
  beatsPerBar: number,
): Map<number, StoredBar> {
  const obj = asRecord(extractJson(raw));
  const list = Array.isArray(obj.bars) ? obj.bars : [];
  const U = unitsPerBar(beatsPerBar);
  const want = new Set(wanted);
  const out = new Map<number, StoredBar>();

  for (const b of list) {
    const r = asRecord(b);
    const index = Number(r.i ?? r.bar ?? r.index);
    if (!Number.isInteger(index) || !want.has(index) || out.has(index))
      continue;
    const spec = specs[index];
    if (!spec) continue;
    const bar = validateBar(r.notes ?? r.n, spec.syllables.length, U);
    if (bar) out.set(index, bar);
  }
  return out;
}
