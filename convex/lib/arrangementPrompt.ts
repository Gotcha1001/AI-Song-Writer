// convex/lib/arrangementPrompt.ts
// Third AI step: high-level band decisions + short flute/violin hooks.
// The model does NOT write every note of the guitar or a full score — it
// chooses density, roles, and 2–4 bar hooks in scale degrees. We turn those
// hooks into concrete NoteEvents, check them, and leave anything that fails
// empty so the rules engine (lib/arrangement.ts) fills it in at play time.
import { timeSignatureLabel } from "./songOptions";

/* --------------------------------- types ---------------------------------- */

export interface SectionLike {
  name: string;
  bars: { segments: { chord?: string; lyric: string }[] }[];
}

export interface ArrangementNoteEvent {
  u: number;
  d: number;
  midi: number;
  vel: number;
}

export interface ArrangementStrumEvent {
  u: number;
  d: number;
  shift: number;
  notes: number[];
  vel: number;
  dir: "down" | "up";
  spread: number;
}

export interface StoredArrangement {
  unitsPerBar: number;
  guitar: ArrangementStrumEvent[][];
  flute: ArrangementNoteEvent[][];
  violin: ArrangementNoteEvent[][];
}

export type ViolinRole = "pad" | "countermelody" | "ostinato";
export type Density = "sparse" | "normal" | "full";

export interface SectionPlan {
  name: string;
  /** 0-based bar indices in the flat song that belong to this section. */
  barStart: number;
  barCount: number;
  playGuitar: boolean;
  playFlute: boolean;
  playViolin: boolean;
  density: Density;
  violinRole: ViolinRole;
  /** Optional short flute answer in scale degrees (one list per bar of the hook). */
  fluteHook?: { d: number; deg?: number }[][];
  /** Optional short violin line in scale degrees. */
  violinHook?: { d: number; deg?: number }[][];
}

/* ------------------------------- key helpers ------------------------------ */

const NOTE_TO_PC: Record<string, number> = {
  C: 0,
  "C#": 1,
  Db: 1,
  D: 2,
  "D#": 3,
  Eb: 3,
  E: 4,
  F: 5,
  "F#": 6,
  Gb: 6,
  G: 7,
  "G#": 8,
  Ab: 8,
  A: 9,
  "A#": 10,
  Bb: 10,
  B: 11,
};

/** Major scale degree offsets from the tonic (0–7). */
const MAJOR_DEG = [0, 2, 4, 5, 7, 9, 11, 12];
const MINOR_DEG = [0, 2, 3, 5, 7, 8, 10, 12];

function parseKey(key: string): { pc: number; minor: boolean } {
  const m = key.trim().match(/^([A-G][#b]?)(m)?$/i);
  if (!m) return { pc: 0, minor: false };
  const root = m[1][0].toUpperCase() + (m[1].slice(1) || "");
  return { pc: NOTE_TO_PC[root] ?? 0, minor: !!m[2] };
}

/** Scale degree → MIDI, clamped into a comfortable instrument range. */
function degreeToMidi(
  deg: number,
  key: string,
  lo: number,
  hi: number,
  prefer = 60,
): number {
  const { pc, minor } = parseKey(key);
  const scale = minor ? MINOR_DEG : MAJOR_DEG;
  const oct = Math.floor(deg / 7);
  const d = ((deg % 7) + 7) % 7;
  let midi = 12 * (4 + oct) + pc + scale[d];
  // nudge into range near `prefer`
  while (midi < lo) midi += 12;
  while (midi > hi) midi -= 12;
  // prefer the octave closer to `prefer`
  if (midi - 12 >= lo && Math.abs(midi - 12 - prefer) < Math.abs(midi - prefer))
    midi -= 12;
  if (midi + 12 <= hi && Math.abs(midi + 12 - prefer) < Math.abs(midi - prefer))
    midi += 12;
  return midi;
}

export function unitsPerBar(beatsPerBar: number): number {
  // 3/4 and 4/4 → 12 / 16 sixteenths; 6/8 → 12 sixteenths (compound).
  if (beatsPerBar === 3) return 12;
  if (beatsPerBar === 6) return 12;
  return 16;
}

/* ------------------------------ build prompt ------------------------------ */

export function buildArrangementPrompt(input: {
  title: string;
  key: string;
  tempo: number;
  beatsPerBar: number;
  mood: string;
  genre: string;
  sections: SectionLike[];
  extraInstruments?: string[];
}): { system: string; user: string } {
  const U = unitsPerBar(input.beatsPerBar);
  const ts = timeSignatureLabel(input.beatsPerBar);

  // Flatten section index → bar ranges for the model.
  let bar = 0;
  const sectionLines: string[] = [];
  for (const sec of input.sections) {
    const n = sec.bars.length;
    const chords = sec.bars
      .map((b, i) => {
        const c =
          b.segments
            .map((s) => s.chord)
            .filter(Boolean)
            .join(" → ") || "—";
        return `  bar ${i + 1}: ${c}`;
      })
      .join("\n");
    sectionLines.push(
      `### ${sec.name}  (flat bars ${bar}–${bar + n - 1}, ${n} bars)\n${chords}`,
    );
    bar += n;
  }

  const extras =
    input.extraInstruments && input.extraInstruments.length
      ? input.extraInstruments.join(", ")
      : "violin, acoustic guitar, flute (default band)";

  const system = `You are the arranger for a symbolic song-writing app.
You do NOT write every note. You make musical decisions per section and, when useful, a short 2–4 bar hook in SCALE DEGREES for the flute or violin.

Scale degrees: 0 = tonic, 1 = second, 2 = third, …, 7 = octave, negative = below tonic. Rests omit "deg".
Each bar of a hook is a list of { "d": length_in_sixteenths, "deg"?: number }. Lengths in one bar MUST sum to exactly ${U}.

Output ONLY valid JSON, no markdown fences, no commentary:
{
  "sections": [
    {
      "name": "Verse 1",
      "playGuitar": true,
      "playFlute": true,
      "playViolin": false,
      "density": "sparse" | "normal" | "full",
      "violinRole": "pad" | "countermelody" | "ostinato",
      "fluteHook": [ [ {"d":4,"deg":2}, {"d":4}, {"d":8,"deg":4} ], ... ],
      "violinHook": [ ... ]
    }
  ]
}

Rules:
- Match section names exactly as given.
- Verses: usually sparser; choruses denser; last chorus fullest.
- Flute answers in vocal gaps (call-and-response); keep hooks short.
- Violin pad = held harmony; countermelody = moving line; ostinato = repeating figure.
- Prefer chord tones on long notes. Stay mostly stepwise.
- If a section has no useful hook, omit fluteHook / violinHook.
- Never invent extra sections.`;

  const user = `Song: "${input.title}"
Key: ${input.key}   Tempo: ${input.tempo}   Meter: ${ts}   Mood: ${input.mood}   Genre: ${input.genre}
Instruments the listener wants: ${extras}
Sixteenths per bar: ${U}

Sections:
${sectionLines.join("\n\n")}

Return the JSON arrangement plan now.`;

  return { system, user };
}

/* --------------------------------- parse ---------------------------------- */

function asBool(x: unknown, fallback: boolean): boolean {
  return typeof x === "boolean" ? x : fallback;
}

function asDensity(x: unknown): Density {
  return x === "sparse" || x === "full" || x === "normal" ? x : "normal";
}

function asRole(x: unknown): ViolinRole {
  return x === "countermelody" || x === "ostinato" || x === "pad" ? x : "pad";
}

function parseHook(
  raw: unknown,
  U: number,
): { d: number; deg?: number }[][] | undefined {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 8)
    return undefined;
  const out: { d: number; deg?: number }[][] = [];
  for (const bar of raw) {
    if (!Array.isArray(bar) || bar.length === 0 || bar.length > 12)
      return undefined;
    const notes: { d: number; deg?: number }[] = [];
    let sum = 0;
    for (const n of bar) {
      if (!n || typeof n !== "object") return undefined;
      const d = (n as { d?: unknown }).d;
      if (typeof d !== "number" || !Number.isFinite(d) || d <= 0 || d > U * 2)
        return undefined;
      const deg = (n as { deg?: unknown }).deg;
      if (
        deg !== undefined &&
        (typeof deg !== "number" || !Number.isFinite(deg))
      )
        return undefined;
      notes.push(deg === undefined ? { d } : { d, deg: Math.round(deg) });
      sum += d;
    }
    if (Math.abs(sum - U) > 0.01) return undefined; // must fill the bar
    out.push(notes);
  }
  return out;
}

/**
 * Parse the model JSON into per-section plans aligned with the real sections.
 * Unknown / malformed sections are skipped; the caller falls back to rules.
 */
export function parseArrangementPlan(
  raw: string,
  sections: SectionLike[],
  beatsPerBar: number,
): SectionPlan[] {
  const U = unitsPerBar(beatsPerBar);
  let data: unknown;
  try {
    const cleaned = raw
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/i, "")
      .trim();
    data = JSON.parse(cleaned);
  } catch {
    // try to find a top-level object
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start < 0 || end <= start) return [];
    try {
      data = JSON.parse(raw.slice(start, end + 1));
    } catch {
      return [];
    }
  }
  if (!data || typeof data !== "object") return [];
  const list = (data as { sections?: unknown }).sections;
  if (!Array.isArray(list)) return [];

  const byName = new Map<string, Record<string, unknown>>();
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const name = String((item as { name?: unknown }).name ?? "").trim();
    if (name) byName.set(name.toLowerCase(), item as Record<string, unknown>);
  }

  let bar = 0;
  const plans: SectionPlan[] = [];
  for (const sec of sections) {
    const rawSec = byName.get(sec.name.toLowerCase());
    const n = sec.bars.length;
    if (!rawSec) {
      bar += n;
      continue;
    }
    plans.push({
      name: sec.name,
      barStart: bar,
      barCount: n,
      playGuitar: asBool(rawSec.playGuitar, true),
      playFlute: asBool(rawSec.playFlute, true),
      playViolin: asBool(rawSec.playViolin, true),
      density: asDensity(rawSec.density),
      violinRole: asRole(rawSec.violinRole),
      fluteHook: parseHook(rawSec.fluteHook, U),
      violinHook: parseHook(rawSec.violinHook, U),
    });
    bar += n;
  }
  return plans;
}

/* -------------------------- hooks → note events --------------------------- */

function hookToEvents(
  hook: { d: number; deg?: number }[][],
  key: string,
  barStart: number,
  totalBars: number,
  range: { lo: number; hi: number; prefer: number },
  baseVel: number,
): (ArrangementNoteEvent[] | null)[] {
  // Returns one entry per bar of the song; null = "use rules for this bar".
  const out: (ArrangementNoteEvent[] | null)[] = Array.from(
    { length: totalBars },
    () => null,
  );
  for (let i = 0; i < hook.length; i++) {
    const bi = barStart + i;
    if (bi >= totalBars) break;
    const events: ArrangementNoteEvent[] = [];
    let u = 0;
    for (const n of hook[i]) {
      if (n.deg !== undefined) {
        events.push({
          u,
          d: n.d,
          midi: degreeToMidi(n.deg, key, range.lo, range.hi, range.prefer),
          vel: baseVel,
        });
      }
      u += n.d;
    }
    out[bi] = events; // may be empty (all rests) — still "owned" by the plan
  }
  return out;
}

/**
 * Build a StoredArrangement from the AI section plans.
 * Guitar is always left empty (rules engine is better at strums).
 * Flute / violin only get bars the hooks successfully covered; everything
 * else stays empty so the client rules fill them.
 */
export function plansToArrangement(
  plans: SectionPlan[],
  key: string,
  beatsPerBar: number,
  totalBars: number,
): StoredArrangement {
  const U = unitsPerBar(beatsPerBar);
  const flute: (ArrangementNoteEvent[] | null)[] = Array.from(
    { length: totalBars },
    () => null,
  );
  const violin: (ArrangementNoteEvent[] | null)[] = Array.from(
    { length: totalBars },
    () => null,
  );

  for (const p of plans) {
    if (p.playFlute && p.fluteHook) {
      const evs = hookToEvents(
        p.fluteHook,
        key,
        p.barStart,
        totalBars,
        { lo: 60, hi: 96, prefer: 74 },
        p.density === "full" ? 0.72 : p.density === "sparse" ? 0.5 : 0.62,
      );
      for (let i = 0; i < totalBars; i++) {
        if (evs[i] !== null) flute[i] = evs[i];
      }
    }
    if (p.playViolin && p.violinHook) {
      const prefer =
        p.violinRole === "pad" ? 62 : p.violinRole === "ostinato" ? 67 : 69;
      const evs = hookToEvents(
        p.violinHook,
        key,
        p.barStart,
        totalBars,
        { lo: 55, hi: 88, prefer },
        p.density === "full" ? 0.65 : 0.55,
      );
      for (let i = 0; i < totalBars; i++) {
        if (evs[i] !== null) violin[i] = evs[i];
      }
    }
  }

  return {
    unitsPerBar: U,
    guitar: Array.from({ length: totalBars }, () => []),
    flute: flute.map((b) => b ?? []),
    violin: violin.map((b) => b ?? []),
  };
}

/** Count how many bars actually received AI notes (for logging / empty check). */
export function arrangementCoverage(a: StoredArrangement): number {
  let n = 0;
  for (let i = 0; i < a.flute.length; i++) {
    if (a.flute[i].length > 0 || a.violin[i].length > 0) n++;
  }
  return n;
}
