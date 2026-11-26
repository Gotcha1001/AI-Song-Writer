// convex/lib/melodyPrompt.ts
// The AI composes the vocal melody bar by bar from the finished lyrics + chords.
// This file builds that prompt and, just as important, CHECKS what comes back:
// a bar is only accepted if its note lengths add up to exactly one bar and it
// has exactly one pitched note per syllable. Bad bars are asked for again, and
// anything still missing falls back to the built-in tune on screen.
//
// After the AI answers, repairBar() tidies every bar so it sounds right:
//   - long notes / notes on the beat / the last note of a bar are chord notes
//     (no more F held over Am), quick passing notes must move by step
//   - a rest is placed wherever the lyric breathes (punctuation, end of a line,
//     and natural phrase points)
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
  /**
   * Breath wanted AFTER each syllable (same length as `syllables`):
   * 0 = none, 1 = short, 2 = long. Comes from punctuation in the lyric and
   * from the end of a line (next bar is instrumental / new section), plus
   * forced natural phrase points so the melody never becomes a wall of notes.
   */
  pauses: number[];
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
 * Force natural breathing points so the melody never becomes a continuous
 * stream of notes. Even without punctuation we insert short rests after
 * roughly every 3–4 syllables and at the end of every bar that has lyrics.
 * This is the single biggest change that stops the "cheesy wall of notes".
 */
function forceNaturalPauses(pauses: number[], syllableCount: number): void {
  if (syllableCount === 0) return;

  // Always give the last syllable at least a short breath (line end).
  const last = syllableCount - 1;
  if (pauses[last] < 1) pauses[last] = 1;

  // For denser bars, insert mid-phrase breathing.
  if (syllableCount >= 5) {
    // Aim for a short rest roughly after the 3rd syllable.
    const mid = Math.min(2, last - 1);
    if (pauses[mid] < 1) pauses[mid] = 1;
  }
  if (syllableCount >= 7) {
    // Second breathing point.
    const mid2 = Math.min(4, last - 1);
    if (pauses[mid2] < 1) pauses[mid2] = 1;
  }
  if (syllableCount >= 9) {
    const mid3 = Math.min(6, last - 1);
    if (pauses[mid3] < 1) pauses[mid3] = 1;
  }
}

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
      const pauses = syllables.map((t) => pauseLevel(t));
      forceNaturalPauses(pauses, syllables.length);

      out.push({
        index: out.length,
        section: section.name,
        barInSection: bi + 1,
        chords,
        syllables,
        pauses,
      });
    });
  }

  // The end of a line (next bar is instrumental, a new section, or the song
  // is over) always gets at least a short breath — reinforce it.
  out.forEach((spec, i) => {
    if (spec.syllables.length === 0) return;
    const next = out[i + 1];
    const lineEnd =
      !next || next.section !== spec.section || next.syllables.length === 0;
    const k = spec.pauses.length - 1;
    if (lineEnd && spec.pauses[k] < 1) spec.pauses[k] = 1;
    // Stronger close at section boundaries.
    if (
      lineEnd &&
      next &&
      next.section !== spec.section &&
      spec.pauses[k] < 2
    ) {
      spec.pauses[k] = 2;
    }
  });
  return out;
}

/* --------------------------------- prompt --------------------------------- */

/** Fresh ideas, so "New melody" does not give the same tune twice. */
const CREATIVE_HINTS = [
  "Treat the vocal line like a singer performing, not like a sequence of syllables. Group words into short musical phrases and leave deliberate silence between them.",
  "Open the verse with a pickup-style start on the 5th degree (4) and let the line fall gently into a rest.",
  "Build the chorus around one short, catchy motif of 3 to 4 notes that returns with small changes, always leaving space after the motif.",
  "Let the first phrase climb in small steps and the answering phrase come back down, then rest before the next idea.",
  "Use a wide leap (a 4th or 5th) once per chorus on an important word, then step back down and rest.",
  "Keep the verse narrow (a range of about a 5th) and let the chorus open up to the octave, with clear breathing points between phrases.",
  "Use a long held note at the end of every second bar, with livelier notes before it, then a rest.",
  "Start phrases on the 3rd degree (2) and aim for the 5th (4) at the high point of each phrase, then land and breathe.",
  "Add a little syncopation: let some stressed words land just after the beat, then leave air.",
  "Make each phrase end on a different stable note (0, 2 or 4) so the tune never feels stuck, and always follow with a rest or held note.",
  "Use a rising sequence: the same small shape repeated a step higher on the next bar, with rests between statements.",
  "Contrast the bridge by starting higher and moving more slowly than the verses, with longer sustained notes and more silence.",
  "Echo the first half of a phrase in the second half, but finish somewhere new and leave space.",
  "Leave deliberate rests after short phrases so the singer can breathe; never fill every bar edge-to-edge.",
  "End many bars with a rest or a long held note rather than packing notes into the last beat.",
  "Prefer sparse, singable lines with air around them over continuous streams of eighth notes. Silence is part of the melody.",
  "Use a rest on the downbeat of a bar occasionally, so the vocal enters after the chord has landed.",
  "Give important content words longer notes and weaker syllables very short notes, then rest after the phrase lands.",
  "Think of the melody as a conversation: short statements separated by silence, not a continuous paragraph of notes.",
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
  const breaths = spec.pauses
    .map((p, i) =>
      p > 0
        ? `${i + 1}(${p === 2 ? "long, ~4 sixteenths" : "short, ~2 sixteenths"})`
        : "",
    )
    .filter(Boolean)
    .join(", ");
  return `#${spec.index} [${spec.section}, bar ${spec.barInSection}] chords: ${chords || "same as before"} | ${spec.syllables.length} syllables: ${syl}${breaths ? ` | BREATH after syllable ${breaths}` : ""}`;
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

  const system = `You are a gifted melody writer who thinks like a vocal coach and a songwriter, not like a note-per-syllable machine. You are given the finished lyrics and chords of a song, one bar at a time. Compose the VOCAL MELODY that a real singer will perform, with natural phrasing, breathing, emphasis and musical space.

The biggest failure mode to avoid is the "cheesy continuous stream": every syllable gets a note of similar length, almost no rests, and the line never breathes. That sounds mechanical and amateur. Real songs have short phrases, intentional silence, longer notes on important words, and space for the singer to breathe.

Reply with ONE JSON object and nothing else: no markdown, no code fences, no commentary.

JSON shape:
{ "bars": [ { "i": 0, "notes": [[4, 2], [4, 3], [8, 4]] }, { "i": 1, "notes": [[2, 4], [2, 3], [4, 2], [4, 1], [4, null]] } ] }

"i" is the bar number exactly as written in the list (#0, #1 ...). Each note is [length, degree].

HARD RULES (a bar that breaks any of these is thrown away):
1. LENGTH is counted in sixteenth notes and must be one of 1, 2, 3, 4, 6, 8, 12, 16 (2 = an eighth note, 4 = a quarter, 3 = a dotted eighth, 6 = a dotted quarter, 8 = a half note, 12 = a dotted half, 16 = a whole note).
2. The lengths in one bar must add up to EXACTLY ${U}. This song is in ${meter}: ${strongBeats}.
3. DEGREE is a whole number: a position in the key's own scale. ${scaleLine}. 0 is the tonic, 7 is the tonic an octave higher, -1 is the scale note just below the tonic. Allowed range: ${MIN_DEG} to ${MAX_DEG}; most notes should live between 0 and 7. Use null for a rest.
4. A pitched note carries one syllable. The number of notes that are NOT rests must equal the number of syllables listed for that bar, and the syllables are sung in the order they are written. Where a bar line says "BREATH after syllable N", the note carrying syllable N MUST be followed immediately by a rest (null) of the stated length (the other notes shrink to make room). Also add rests wherever else a singer would breathe. Rests are essential, not optional decoration.
5. Do not write bars that are not asked for.
6. HARMONY. Over each chord, every note that is long (a quarter or longer), lands on a beat, or is the LAST note of the bar must be one of that chord's "chord notes". Any other scale note may only be a QUICK passing note (an eighth or shorter) that is reached by step and left by step (one degree up or down). Never leap onto a non-chord note. In a minor key degrees 5 and 6 (the flat 6th and flat 7th) clash when held over the tonic chord, e.g. F over Am: use them only as quick passing notes that continue by step, never as a held or leapt-to note.
7. RHYTHM. Use length 3 only as a dotted eighth followed by a 1 (3 then 1), and length 6 only followed by a 2 (6 then 2) — never two dotted values side by side.

HOW TO WRITE A NATURAL, NON-CHEESY VOCAL LINE:

Think of the lyrics as a vocal performance with phrasing, not a list of syllables that must each receive a note of similar weight.

- Group the words into short musical phrases (usually 2–5 syllables). After a phrase lands, leave silence (a rest) or a long held note so the singer can breathe and the listener can feel the cadence.
- Put stressed syllables and the important content words on strong beats and give them longer notes. Unstressed syllables get short notes. Match the natural rhythm of speech.
- When the lyric contains punctuation or the bar ends a line, treat it as a hard instruction to create space (rest or long note).
- Fit the chords: on strong beats prefer the "chord notes" listed for the chord that is sounding. Between them use passing notes. The chord position "@N" says the sixteenth a chord starts on.
- Mostly move by step. Leaps up to a 5th (4 degrees) are good for drama; after a leap, step back the other way. Do not repeat the same note more than 3 times in a row.
- Think in phrases of 2 or 4 bars: a question and an answer. Let phrases breathe — end many bars with a rest or a long held note rather than filling every sixteenth. End each 4-bar phrase on a stable note (usually a chord note, often 0, 2 or 4). End the very last bar of the song on 0 (or 7), as a long note.
- Shape the song: verses sit lower and calmer, a pre-chorus builds, the chorus is the highest, most singable and most memorable part, the bridge contrasts.
- Repeat on purpose: sections with the same name, and lines that repeat, share the same tune. Verse 2 echoes Verse 1 with small variations; choruses are nearly identical. Adapt the rhythm to the new syllables, keep the shape of the tune.
- Make it musical and human. Avoid straight runs up and down the scale, avoid giving every bar the same rhythm, avoid a monotone, and avoid the "cheesy" sound of filling every beat with notes. Space and silence are as important as the notes themselves. Prefer a few well-placed notes with air around them over a wall of continuous melody.

CONCRETE EXAMPLES OF GOOD VS BAD PHRASING (same syllables, different feel):

Bad (mechanical, cheesy — almost every syllable similar length, no real space):
Syllables: "I · walked · the · emp · ty · road"
notes: [[2,0],[2,1],[2,2],[2,3],[2,2],[2,0],[4,null]]  ← still too even and busy

Better (natural speech rhythm + intentional breath):
Syllables: "I · walked · the · emp · ty · road"
notes: [[2,0],[4,2],[2,1],[2,0],[2,2],[4,0]]  ← longer on "walked" and "road", natural shape
(Then the repair step / BREATH markers will insert the rest after the phrase.)

Even better for a ballad or reflective line (more space):
notes: [[2,0],[6,2],[2,1],[2,0],[4,2],[null rest filled by repair]]

Another good pattern (phrase + rest inside the bar):
Syllables: "re · mem · ber · the · rhy · thm"
notes: [[2,2],[2,3],[4,4],[2,2],[2,3],[2,4],[2,null]]  ← short-short-long motif, then continues, ends with air

Use these principles: longer notes on important words, shorter on weak ones, and deliberate rests after phrases. Never produce a bar that is just a continuous stream of similar-length notes.

Instrumental bars are not listed; skip them.`;

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

Compose the melody now. Return notes for exactly these bars: ${wantedList.map((n) => `#${n}`).join(", ")}.

Remember: treat this as a vocal performance with phrasing and breathing, not a one-note-per-syllable assignment. Leave air.`;

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
 * Tidies a validated bar so it sounds right (the note count, syllable count
 * and total length never change):
 *   1. Harmony: a note that is long, on a beat, or the last of the bar must be
 *      a chord note of the chord sounding then; otherwise it is snapped to the
 *      nearest chord note. A non-chord note is only kept as a quick passing
 *      note moved into and out of by step. Huge leaps are pulled an octave in.
 *   2. Breath: after every syllable that wants a breath (see BarSpec.pauses)
 *      a rest is made by shortening that note. The AI's own rests are kept.
 *      This is more aggressive than before so dense bars still breathe.
 *
 * @param prevDeg last sung degree of the bar before, or null at a section start
 */
export function repairBar(
  bar: StoredBar,
  spec: { chords: { u: number; chord: string }[]; pauses: number[] },
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
  const sungIdx: number[] = [];
  bar.forEach((n, i) => {
    if (n.deg !== undefined) sungIdx.push(i);
  });
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

  /* ---- 2. breath (more aggressive) ---- */
  const out: StoredBar = [];
  let s = 0;
  for (let i = 0; i < fixed.length; i++) {
    const n = fixed[i];
    out.push(n);
    if (n.deg === undefined) continue;
    const level = spec.pauses[s++] ?? 0;
    if (level <= 0) continue;
    const following = fixed[i + 1];
    if (following && following.deg === undefined) continue; // already a rest

    // Prefer longer rests than before so the line actually breathes.
    const wanted = level >= 2 ? 4 : 2;
    const breath = Math.min(wanted, n.d - 1);
    if (breath < 1) continue;
    const keep = [...NOTE_LENGTHS].reverse().find((l) => l <= n.d - breath);
    if (!keep) continue;
    out[out.length - 1] = { d: keep, deg: n.deg };
    for (const p of restPieces(n.d - keep)) out.push({ d: p });
  }

  const total = out.reduce((a, n) => a + n.d, 0);
  return total === U ? out : fixed;
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
