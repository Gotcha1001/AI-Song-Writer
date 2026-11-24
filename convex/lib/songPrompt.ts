// convex/lib/songPrompt.ts
// Builds the prompt and turns the model's raw text into a clean, validated song.
// The chords are checked against the key, so a song in Bm can never end up
// with a C major or Bb chord in it.
import { CHORD_RE, LIMITS, timeSignatureLabel } from "./songOptions";

export interface PromptInput {
  topic: string;
  mood: string;
  genre: string;
  language: string;
  lengthKey: "short" | "standard" | "full";
  targetBars: number;
  requestedKey?: string;
  requestedTempo?: number;
  beatsPerBar: 3 | 4 | 6; // 6 = 6/8
  chordStyle: "simple" | "rich";
}

export interface ParsedSegment {
  chord?: string;
  lyric: string;
}
export interface ParsedBar {
  segments: ParsedSegment[];
}
export interface ParsedSection {
  id: string;
  name: string;
  bars: ParsedBar[];
}
export interface ParsedSong {
  title: string;
  key: string;
  tempo: number;
  sections: ParsedSection[];
  /** How many out-of-key chords were corrected (for logging only). */
  fixedChords: number;
}

/* ------------------------------ music theory ------------------------------ */

const SHARP_NAMES = [
  "C",
  "C#",
  "D",
  "D#",
  "E",
  "F",
  "F#",
  "G",
  "G#",
  "A",
  "A#",
  "B",
];
const FLAT_NAMES = [
  "C",
  "Db",
  "D",
  "Eb",
  "E",
  "F",
  "Gb",
  "G",
  "Ab",
  "A",
  "Bb",
  "B",
];
const LETTER_PC: Record<string, number> = {
  C: 0,
  D: 2,
  E: 4,
  F: 5,
  G: 7,
  A: 9,
  B: 11,
};

const MAJOR_SCALE = [0, 2, 4, 5, 7, 9, 11];
const MINOR_SCALE = [0, 2, 3, 5, 7, 8, 10]; // natural minor

// Tonics that are conventionally spelled with flats (F# major stays sharp).
const FLAT_MAJOR_TONICS = new Set([5, 10, 3, 8, 1]); // F Bb Eb Ab Db
const FLAT_MINOR_TONICS = new Set([2, 7, 0, 5, 10, 3]); // Dm Gm Cm Fm Bbm Ebm

type Quality = "maj" | "min" | "dim" | "aug";
const QUALITY_SUFFIX: Record<Quality, string> = {
  maj: "",
  min: "m",
  dim: "dim",
  aug: "aug",
};

interface KeyInfo {
  name: string;
  tonic: number;
  minor: boolean;
  flats: boolean;
  /** Pitch classes of the scale. */
  scale: number[];
}

/** One chord (root + triad quality) that is allowed in a key. */
interface Slot {
  root: number;
  quality: Quality;
  diatonic: boolean;
  dominant: boolean;
  label: string;
}

const KEY_RE = /^([A-G])([#b]?)(m?)$/;
const CHORD_PARTS = /^([A-G])([#b]?)([^/]*)(?:\/([A-G])([#b]?))?$/;

function pcOf(letter: string, acc: string): number {
  let pc = LETTER_PC[letter];
  if (acc === "#") pc += 1;
  if (acc === "b") pc -= 1;
  return (pc + 12) % 12;
}

function noteName(pc: number, flats: boolean): string {
  return (flats ? FLAT_NAMES : SHARP_NAMES)[((pc % 12) + 12) % 12];
}

function parseKey(key?: string): KeyInfo | null {
  if (!key) return null;
  const m = KEY_RE.exec(key.trim());
  if (!m) return null;
  const tonic = pcOf(m[1], m[2]);
  const minor = m[3] === "m";
  let flats = minor
    ? FLAT_MINOR_TONICS.has(tonic)
    : FLAT_MAJOR_TONICS.has(tonic);
  if (m[2] === "b") flats = true;
  if (m[2] === "#") flats = false;
  return {
    name: key.trim(),
    tonic,
    minor,
    flats,
    scale: (minor ? MINOR_SCALE : MAJOR_SCALE).map((s) => (s + tonic) % 12),
  };
}

/**
 * Every chord that sounds "right" in the key:
 *  - the 7 diatonic triads
 *  - common borrowed chords (major keys: bIII, bVI, bVII, iv;
 *    minor keys: major V from the harmonic minor, major IV from dorian)
 * Extensions (7, maj7, sus4, add9 ...) are allowed on any of these roots.
 */
function buildSlots(k: KeyInfo): Slot[] {
  const slots: Slot[] = [];
  const rel = k.minor ? MINOR_SCALE : MAJOR_SCALE;

  const add = (
    root: number,
    quality: Quality,
    diatonic: boolean,
    dominant: boolean,
  ) => {
    if (slots.some((s) => s.root === root && s.quality === quality)) return;
    slots.push({
      root,
      quality,
      diatonic,
      dominant,
      label: noteName(root, k.flats) + QUALITY_SUFFIX[quality],
    });
  };

  for (let i = 0; i < 7; i++) {
    const third = (rel[(i + 2) % 7] - rel[i] + 12) % 12;
    const fifth = (rel[(i + 4) % 7] - rel[i] + 12) % 12;
    const quality: Quality =
      fifth === 6 ? "dim" : fifth === 8 ? "aug" : third === 3 ? "min" : "maj";
    add(k.scale[i], quality, true, !k.minor && i === 4);
  }

  const t = k.tonic;
  if (k.minor) {
    add((t + 7) % 12, "maj", false, true); // V  (harmonic minor)
    add((t + 5) % 12, "maj", false, false); // IV (dorian)
  } else {
    add((t + 3) % 12, "maj", false, false); // bIII
    add((t + 8) % 12, "maj", false, false); // bVI
    add((t + 10) % 12, "maj", false, false); // bVII
    add((t + 5) % 12, "min", false, false); // iv
  }
  return slots;
}

/** Human-readable chord guide used inside the prompt. */
function keyGuide(k: KeyInfo, rich: boolean): string {
  const slots = buildSlots(k);
  const diatonic = slots.filter((s) => s.diatonic).map((s) => s.label);
  const borrowed = slots.filter((s) => !s.diatonic).map((s) => s.label);
  const tonic = slots[0].label;
  const lines = [
    `KEY: ${k.name}. The ONLY chords you may use are:`,
    `  In-key chords: ${diatonic.join(", ")}`,
  ];
  if (rich) {
    lines.push(`  Borrowed chords (use sparingly): ${borrowed.join(", ")}`);
  } else {
    lines.push(
      `  Also allowed (cadence only): ${borrowed.filter((_, i) => k.minor && i === 0).join(", ") || "none"}`,
    );
  }
  lines.push(
    `  Extensions such as 7, maj7, sus4 and add9 are fine on those roots, but the ROOT of every chord must come from the lists above.`,
    `  Any other chord is a mistake. Check every chord against this list before you write it.`,
    `  Start and end the song on the tonic chord (${tonic}).`,
  );
  return lines.join("\n");
}

interface ChordInfo {
  root: number;
  quality: Quality;
  sus: boolean;
  bass?: number;
  suffix: string;
}

function analyse(chord: string): ChordInfo | null {
  const m = CHORD_PARTS.exec(chord);
  if (!m) return null;
  const suffix = m[3];
  let quality: Quality = "maj";
  if (/^(dim|°|o|ø)/.test(suffix) || /^(m|min|-)7?b5/.test(suffix))
    quality = "dim";
  else if (/^(aug|\+)/.test(suffix)) quality = "aug";
  else if (/^(m(?!aj)|min|-)/.test(suffix)) quality = "min";
  return {
    root: pcOf(m[1], m[2]),
    quality,
    sus: /sus/.test(suffix),
    bass: m[4] ? pcOf(m[4], m[5]) : undefined,
    suffix,
  };
}

function fits(info: ChordInfo, slots: Slot[]): boolean {
  return slots.some(
    (s) => s.root === info.root && (info.sus || s.quality === info.quality),
  );
}

/** Rebuild a chord on a new slot, keeping the colour (7th, sus ...) where it still makes sense. */
function rebuild(slot: Slot, suffix: string, k: KeyInfo): string {
  let rest = suffix;
  let hasMaj = false;
  const mm = /^(maj|M|Δ)/.exec(rest);
  if (mm) {
    hasMaj = true;
    rest = rest.slice(mm[0].length);
  } else {
    rest = rest.replace(/^(min|m|-|dim|°|o|ø|aug|\+)/, "");
  }
  const base = noteName(slot.root, k.flats);

  if (slot.quality === "dim") return base + "dim";
  if (/^sus/.test(rest)) return base + rest;
  if (slot.quality === "min") {
    return base + "m" + (/^(7|9|11|6|add9)?$/.test(rest) ? rest : "");
  }
  // major / aug
  if (hasMaj) return base + "maj" + (/^(7|9)$/.test(rest) ? rest : "7");
  if (/^(7|9)$/.test(rest)) return base + (slot.dominant ? rest : "maj" + rest);
  return base + (/^(6|add9)?$/.test(rest) ? rest : "");
}

/** Replace an out-of-key chord with the closest chord that belongs to the key. */
function snapChord(info: ChordInfo, slots: Slot[], k: KeyInfo): string {
  let best = slots[0];
  let bestScore = Infinity;
  for (const s of slots) {
    const d = Math.abs(s.root - info.root);
    const dist = Math.min(d, 12 - d);
    const score =
      dist * 2 + (s.quality === info.quality ? 0 : 1) + (s.diatonic ? 0 : 0.5);
    if (score < bestScore) {
      best = s;
      bestScore = score;
    }
  }
  return rebuild(best, info.suffix, k);
}

function fixChord(
  chord: string,
  slots: Slot[],
  k: KeyInfo,
): { chord: string; changed: boolean } {
  const info = analyse(chord);
  if (!info) return { chord, changed: false };

  if (fits(info, slots)) {
    const bassOk =
      info.bass === undefined ||
      k.scale.includes(info.bass) ||
      slots.some((s) => s.root === info.bass);
    if (bassOk) return { chord, changed: false };
    // Root is fine but the bass note is foreign: drop the slash bass.
    return { chord: chord.slice(0, chord.indexOf("/")), changed: true };
  }
  return { chord: snapChord(info, slots, k), changed: true };
}

/**
 * Used when the user did not pick a key: find the key that the written chords
 * fit best, so the key label always matches the music.
 */
function detectKey(chords: string[], declared: string): KeyInfo {
  const declaredKey = parseKey(declared);
  const infos = chords.map(analyse).filter((c): c is ChordInfo => c !== null);
  if (infos.length === 0) return declaredKey ?? (parseKey("C") as KeyInfo);

  let best: KeyInfo | null = null;
  let bestScore = -Infinity;

  for (let t = 0; t < 12; t++) {
    for (const minor of [false, true]) {
      const flats = minor ? FLAT_MINOR_TONICS.has(t) : FLAT_MAJOR_TONICS.has(t);
      const isDeclared =
        !!declaredKey && declaredKey.tonic === t && declaredKey.minor === minor;
      const cand = isDeclared
        ? (declaredKey as KeyInfo)
        : (parseKey(noteName(t, flats) + (minor ? "m" : "")) as KeyInfo);
      const slots = buildSlots(cand);

      let score = infos.filter((i) => fits(i, slots)).length;
      if (isDeclared) score += 0.5;
      const onTonic = (i: ChordInfo) =>
        i.root === t && i.quality === (minor ? "min" : "maj");
      if (onTonic(infos[0])) score += 0.3;
      if (onTonic(infos[infos.length - 1])) score += 0.3;

      if (score > bestScore) {
        best = cand;
        bestScore = score;
      }
    }
  }
  return best as KeyInfo;
}

/* --------------------------------- prompt --------------------------------- */

const LAYOUTS: Record<PromptInput["lengthKey"], string> = {
  short: "Verse 1 (8 bars) + Chorus (8 bars)",
  standard: "Verse 1 (8), Chorus (8), Verse 2 (8), Chorus (8)",
  full: "Intro (4), Verse 1 (8), Pre-Chorus (4), Chorus (8), Verse 2 (8), Pre-Chorus (4), Chorus (8), Bridge (8), Final Chorus (8), Outro (4)",
};

export function buildPrompt(input: PromptInput): {
  system: string;
  user: string;
} {
  const requested = parseKey(input.requestedKey);
  const rich = input.chordStyle === "rich";
  const barRule =
    input.beatsPerBar === 6
      ? "Every bar is in 6/8 time: six eighth-note pulses felt as two groups of three (ONE-two-three FOUR-five-six), a lilting compound feel. Use 1 or 2 segments per bar, and when a bar has 2 segments the chord change lands on the second group of three (the 4th pulse). Write lyrics with a flowing, rolling rhythm that suits 6/8."
      : `Every bar has ${input.beatsPerBar} beats and 1 to 4 segments.`;

  // The JSON example uses chords that really are in the key (Am: Am, F, C).
  const exKey = requested ?? (parseKey("Am") as KeyInfo);
  const exSlots = buildSlots(exKey).filter((s) => s.diatonic);
  const exA = exSlots[0].label;
  const exB = exSlots[5].label;
  const exC = exSlots[2].label;

  const keyRules = requested
    ? keyGuide(requested, rich)
    : `KEY: choose the key first, then use ONLY chords from that key. For a major key that means the seven chords built on its major scale (in C: C, Dm, Em, F, G, Am, Bdim); for a minor key the natural minor scale (in Am: Am, Bdim, C, Dm, Em, F, G), plus the major V chord. ${
        rich
          ? "A borrowed chord or two is fine (bVII, bVI, iv, IV)."
          : "No borrowed chords."
      } Never write a chord whose root is not a note of your chosen key's scale: for example a C or Bb chord does not belong in B minor. Start and end the song on the tonic chord, and set \"key\" to that tonic.`;

  const system = `You are a professional songwriter and arranger. You write ORIGINAL, singable songs and lay them out as chord charts, bar by bar.

Reply with ONE JSON object and nothing else: no markdown, no code fences, no commentary.

JSON shape:
{
  "title": "string",
  "key": "${exKey.name}",
  "tempo": 92,
  "sections": [
    {
      "name": "Verse 1",
      "bars": [
        { "segments": [
            { "chord": "${exA}", "lyric": "I walk the " },
            { "chord": "${exB}",  "lyric": "empty road " }
        ] },
        { "segments": [ { "chord": "${exC}", "lyric": "" } ] }
      ]
    }
  ]
}

Rules:
- The song must contain EXACTLY ${input.targetBars} bars in total across all sections. Suggested layout: ${LAYOUTS[input.lengthKey]}.
- ${barRule}
- A segment is one chord plus the words sung starting on that chord, until the next segment.
- The FIRST segment of every bar MUST have a chord (repeat the chord if it does not change). Later segments may use "chord": null when the same chord just continues under more words.
- Chord symbols use standard names: a letter A to G, an optional # or b, then an optional quality (m, 7, maj7, m7, sus2, sus4, add9, dim), and optionally a slash bass note (e.g. a chord over its third).
- HARMONY IS STRICT. ${keyRules}
- Lyrics must be singable and leave room to breathe. Aim for 2–6 syllables in most sung bars (occasionally up to 7 on a busy line). Do NOT pack every bar wall-to-wall; sparse bars with 1–3 syllables are excellent and common in real songs.
- Use natural punctuation inside the lyrics (commas, periods, question marks, ellipses, dashes) to mark where a singer would breathe or pause. This is the strongest cue for phrasing and rests.
- Lyric strings are concatenated when read, so keep the natural spaces: put a trailing space when the next word starts in the next segment. If a chord change lands in the middle of a word, end the first part with a hyphen, e.g. "wan-" then "dering ".
- Use "lyric": "" liberally for instrumental bars (intro, outro, solos, turnarounds, and breathing room between phrases). Empty bars are a feature, not a last resort.
- Rhyme lightly, use concrete imagery, avoid cliches, and never copy existing songs.
- "key" is the tonic as a short string like "G", "F#" or "Em"${requested ? ` and MUST be exactly "${requested.name}"` : ""}. "tempo" is an integer BPM${input.beatsPerBar === 6 ? " counting dotted-quarter beats (two per 6/8 bar, so typically 50 to 100)" : ""}.
- The title should be creative, not just the topic repeated.`;

  const lines = [
    `Topic: ${input.topic}`,
    `Mood: ${input.mood}`,
    `Genre / style: ${input.genre}`,
    `Lyrics language: ${input.language}`,
    `Length: ${input.targetBars} bars`,
    `Time signature: ${timeSignatureLabel(input.beatsPerBar)}`,
    `Key: ${input.requestedKey ?? "your choice (whatever suits the mood)"}`,
    `Tempo: ${input.requestedTempo ? `${input.requestedTempo} BPM` : "your choice (whatever suits the mood)"}`,
    `Chord style: ${
      rich
        ? "rich: 7ths, 9ths, sus chords, slash chords, a borrowed chord or two (all still inside the key rules above)"
        : "simple: mostly triads, an occasional 7th, easy for beginners"
    }`,
  ];

  return { system, user: `Write the song.\n\n${lines.join("\n")}` };
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

function cleanChord(x: unknown): string | undefined {
  if (typeof x !== "string") return undefined;
  const c = x.trim().replace(/♭/g, "b").replace(/♯/g, "#");
  return c && CHORD_RE.test(c) ? c : undefined;
}

function cleanLyric(x: unknown): string {
  if (typeof x !== "string") return "";
  return x.replace(/\s+/g, " ").trimStart().slice(0, LIMITS.lyricMax);
}

/**
 * @param requestedKey the key the user picked in the form (if any). When given
 *   it is authoritative: the song is labelled with it and every chord that does
 *   not belong to it is corrected. When omitted, the key is detected from the
 *   chords the model wrote.
 */
export function parseSongJson(raw: string, requestedKey?: string): ParsedSong {
  const obj = asRecord(extractJson(raw));
  const rawSections = Array.isArray(obj.sections) ? obj.sections : [];

  let budget: number = LIMITS.maxBars;
  const sections: ParsedSection[] = [];

  rawSections.forEach((s, si) => {
    const sec = asRecord(s);
    const rawBars = Array.isArray(sec.bars) ? sec.bars : [];
    const bars: ParsedBar[] = [];

    for (const b of rawBars) {
      if (budget <= 0) break;
      const rawSegs = Array.isArray(asRecord(b).segments)
        ? (asRecord(b).segments as unknown[])
        : [];
      const segments: ParsedSegment[] = rawSegs
        .slice(0, LIMITS.maxSegmentsPerBar)
        .map((seg) => {
          const r = asRecord(seg);
          const chord = cleanChord(r.chord);
          return chord
            ? { chord, lyric: cleanLyric(r.lyric) }
            : { lyric: cleanLyric(r.lyric) };
        });
      bars.push({ segments: segments.length ? segments : [{ lyric: "" }] });
      budget -= 1;
    }

    if (bars.length === 0) return;
    const name =
      typeof sec.name === "string" && sec.name.trim()
        ? sec.name.trim().slice(0, 40)
        : `Section ${si + 1}`;
    sections.push({ id: `s${sections.length + 1}`, name, bars });
  });

  if (sections.length === 0) throw new Error("The song had no sections");

  /* ---- decide the key, then force every chord to belong to it ---- */
  const declared = typeof obj.key === "string" ? obj.key.trim() : "";
  const allChords: string[] = [];
  for (const sec of sections)
    for (const bar of sec.bars)
      for (const seg of bar.segments) if (seg.chord) allChords.push(seg.chord);

  const key: KeyInfo = parseKey(requestedKey) ?? detectKey(allChords, declared);
  const slots = buildSlots(key);

  let fixedChords = 0;
  for (const sec of sections) {
    for (const bar of sec.bars) {
      bar.segments = bar.segments.map((seg) => {
        if (!seg.chord) return seg;
        const fixed = fixChord(seg.chord, slots, key);
        if (fixed.changed) fixedChords += 1;
        return { ...seg, chord: fixed.chord };
      });
    }
  }

  const tempoNum = Math.round(Number(obj.tempo));
  const tempo = Number.isFinite(tempoNum)
    ? Math.min(LIMITS.maxTempo, Math.max(LIMITS.minTempo, tempoNum))
    : 90;

  const title =
    typeof obj.title === "string" && obj.title.trim()
      ? obj.title.trim().slice(0, LIMITS.titleMax)
      : "Untitled song";

  return { title, key: key.name, tempo, sections, fixedChords };
}
