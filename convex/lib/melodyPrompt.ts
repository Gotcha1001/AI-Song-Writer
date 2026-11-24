// convex/lib/melodyPrompt.ts
// The AI composes the vocal melody bar by bar from the finished lyrics + chords.
// This file builds that prompt and, just as important, CHECKS what comes back:
// a bar is only accepted if its note lengths add up to exactly one bar and it
// has exactly one pitched note per syllable. Bad bars are asked for again, and
// anything still missing falls back to the built-in tune on screen.
//
// Pitches are SCALE DEGREES (0 = tonic, 7 = the octave above, -1 = the note
// below the tonic), so the melody keeps its shape when the song is transposed.
import { timeSignatureLabel } from "./songOptions";
import { barSyllables, capSyllables } from "./syllables";

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
}

export const NOTE_LENGTHS = [1, 2, 3, 4, 6, 8, 12, 16];
export const MIN_DEG = -2;
export const MAX_DEG = 8;

export function unitsPerBar(beatsPerBar: number): number {
  return beatsPerBar === 4 ? 16 : 12; // 4/4 -> 16, 3/4 and 6/8 -> 12
}

/* ------------------------------ key + chords ------------------------------ */

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

/* -------------------------------- bar specs -------------------------------- */

/** One entry per bar of the song, with its chords and syllables worked out. */
export function buildBarSpecs(
  sections: SectionLike[],
  beatsPerBar: number,
): BarSpec[] {
  const U = unitsPerBar(beatsPerBar);
  const pulseUnits = beatsPerBar === 6 ? 2 : 4;
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

      const syllables = capSyllables(barSyllables(segs), U).map((s) => s.text);
      out.push({
        index: out.length,
        section: section.name,
        barInSection: bi + 1,
        chords,
        syllables,
      });
    });
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

function describeBar(spec: BarSpec, key: KeyLite): string {
  const chords = spec.chords
    .map(
      (c) => `${c.chord}@${c.u} (chord notes: ${chordDegrees(c.chord, key)})`,
    )
    .join(", ");
  const syl = spec.syllables.join(" · ");
  return `#${spec.index} [${spec.section}, bar ${spec.barInSection}] chords: ${chords || "same as before"} | ${spec.syllables.length} syllables: ${syl}`;
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

  const system = `You are a gifted melody writer. You are given the finished lyrics and chords of a song, one bar at a time. Compose the VOCAL MELODY that a singer will sing over them, so that it sounds like a real, memorable song and not like a scale exercise.

Reply with ONE JSON object and nothing else: no markdown, no code fences, no commentary.

JSON shape:
{ "bars": [ { "i": 0, "notes": [[4, 2], [4, 3], [8, 4]] }, { "i": 1, "notes": [[2, 4], [2, 3], [4, 2], [4, 1], [4, null]] } ] }

"i" is the bar number exactly as written in the list (#0, #1 ...). Each note is [length, degree].

HARD RULES (a bar that breaks any of these is thrown away):
1. LENGTH is counted in sixteenth notes and must be one of 1, 2, 3, 4, 6, 8, 12, 16 (2 = an eighth note, 4 = a quarter, 3 = a dotted eighth, 6 = a dotted quarter, 8 = a half note, 12 = a dotted half, 16 = a whole note).
2. The lengths in one bar must add up to EXACTLY ${U}. This song is in ${meter}: ${strongBeats}.
3. DEGREE is a whole number: a position in the key's own scale. ${scaleLine}. 0 is the tonic, 7 is the tonic an octave higher, -1 is the scale note just below the tonic. Allowed range: ${MIN_DEG} to ${MAX_DEG}; most notes should live between 0 and 7. Use null for a rest.
4. A pitched note carries one syllable. The number of notes that are NOT rests must equal the number of syllables listed for that bar, and the syllables are sung in the order they are written. You SHOULD add rests (null) for breath — at the start of a bar, after a phrase, or before a strong arrival. Rests are not optional decoration; they are part of good melody writing.
5. Do not write bars that are not asked for.

HOW TO WRITE IT WELL:
- Put stressed syllables and the important words on strong beats and give them longer notes. Quick unstressed syllables get short notes. Match the natural rhythm of speech. When the lyric text contains punctuation (comma, period, question mark, ellipsis), treat it as a strong hint to place a rest or a longer note around that point.
- Fit the chords: on strong beats prefer the "chord notes" listed for the chord that is sounding at that moment. Between them use passing notes. The chord position "@N" says the sixteenth a chord starts on.
- Mostly move by step. Leaps up to a 5th (4 degrees) are good for drama; after a leap, step back the other way. Do not repeat the same note more than 3 times in a row.
- Think in phrases of 2 or 4 bars: a question and an answer. Let phrases breathe — end many bars with a rest or a long held note rather than filling every sixteenth. End each 4-bar phrase on a stable note (usually a chord note, often 0, 2 or 4). End the very last bar of the song on 0 (or 7), as a long note.
- Shape the song: verses sit lower and calmer, a pre-chorus builds, the chorus is the highest, most singable and most memorable part, the bridge contrasts.
- Repeat on purpose: sections with the same name, and lines that repeat, share the same tune. Verse 2 echoes Verse 1 with small variations; choruses are nearly identical. Adapt the rhythm to the new syllables, keep the shape of the tune.
- Make it musical and human. Avoid straight runs up and down the scale, avoid giving every bar the same rhythm, avoid a monotone, and avoid the "cheesy" sound of filling every beat with notes. Space and silence are as important as the notes themselves. Prefer a few well-placed notes with air around them over a wall of continuous melody.
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
