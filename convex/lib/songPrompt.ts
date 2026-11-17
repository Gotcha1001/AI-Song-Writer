// convex/lib/songPrompt.ts
// Builds the prompt and turns the model's raw text into a clean, validated song.
import { CHORD_RE, LIMITS } from "./songOptions";

export interface PromptInput {
  topic: string;
  mood: string;
  genre: string;
  language: string;
  lengthKey: "short" | "standard" | "full";
  targetBars: number;
  requestedKey?: string;
  requestedTempo?: number;
  beatsPerBar: 3 | 4;
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
}

const LAYOUTS: Record<PromptInput["lengthKey"], string> = {
  short: "Verse 1 (8 bars) + Chorus (8 bars)",
  standard: "Verse 1 (8), Chorus (8), Verse 2 (8), Chorus (8)",
  full: "Intro (4), Verse 1 (8), Pre-Chorus (4), Chorus (8), Verse 2 (8), Pre-Chorus (4), Chorus (8), Bridge (8), Final Chorus (8), Outro (4)",
};

export function buildPrompt(input: PromptInput): {
  system: string;
  user: string;
} {
  const system = `You are a professional songwriter and arranger. You write ORIGINAL, singable songs and lay them out as chord charts, bar by bar.

Reply with ONE JSON object and nothing else: no markdown, no code fences, no commentary.

JSON shape:
{
  "title": "string",
  "key": "Am",
  "tempo": 92,
  "sections": [
    {
      "name": "Verse 1",
      "bars": [
        { "segments": [
            { "chord": "Am", "lyric": "I walk the " },
            { "chord": "F",  "lyric": "empty road " }
        ] },
        { "segments": [ { "chord": "C", "lyric": "" } ] }
      ]
    }
  ]
}

Rules:
- The song must contain EXACTLY ${input.targetBars} bars in total across all sections. Suggested layout: ${LAYOUTS[input.lengthKey]}.
- Every bar has ${input.beatsPerBar} beats and 1 to 4 segments.
- A segment is one chord plus the words sung starting on that chord, until the next segment.
- The FIRST segment of every bar MUST have a chord (repeat the chord if it does not change). Later segments may use "chord": null when the same chord just continues under more words.
- Chord symbols use standard names only: C, Am, F#m7, Gsus4, Dmaj7, D/F#, Bb. Stay in the key.
- Lyrics must fit the bar when sung at the tempo: about 4 to 9 syllables per bar. Rhyme lightly, use concrete imagery, avoid cliches, and never copy existing songs.
- Lyric strings are concatenated when read, so keep the natural spaces: put a trailing space when the next word starts in the next segment. If a chord change lands in the middle of a word, end the first part with a hyphen, e.g. "wan-" then "dering ".
- Use "lyric": "" for instrumental bars (intro, outro, solos, breathing room).
- "key" is the tonic as a short string like "G", "F#" or "Em". "tempo" is an integer BPM.
- The title should be creative, not just the topic repeated.`;

  const lines = [
    `Topic: ${input.topic}`,
    `Mood: ${input.mood}`,
    `Genre / style: ${input.genre}`,
    `Lyrics language: ${input.language}`,
    `Length: ${input.targetBars} bars`,
    `Time signature: ${input.beatsPerBar}/4`,
    `Key: ${input.requestedKey ?? "your choice (whatever suits the mood)"}`,
    `Tempo: ${input.requestedTempo ? `${input.requestedTempo} BPM` : "your choice (whatever suits the mood)"}`,
    `Chord style: ${
      input.chordStyle === "rich"
        ? "rich: 7ths, 9ths, sus chords, slash chords, a borrowed chord or two"
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

export function parseSongJson(raw: string, fallbackKey = "C"): ParsedSong {
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

  const keyRaw = typeof obj.key === "string" ? obj.key.trim() : "";
  const key = /^[A-G][#b]?m?$/.test(keyRaw) ? keyRaw : fallbackKey;

  const tempoNum = Math.round(Number(obj.tempo));
  const tempo = Number.isFinite(tempoNum)
    ? Math.min(LIMITS.maxTempo, Math.max(LIMITS.minTempo, tempoNum))
    : 90;

  const title =
    typeof obj.title === "string" && obj.title.trim()
      ? obj.title.trim().slice(0, LIMITS.titleMax)
      : "Untitled song";

  return { title, key, tempo, sections };
}
