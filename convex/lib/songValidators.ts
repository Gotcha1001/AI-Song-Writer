// convex/lib/songValidators.ts
import { v } from "convex/values";

/** One chord change + the words sung from that chord until the next one. */
export const segmentValidator = v.object({
  chord: v.optional(v.string()), // undefined = keep the previous chord
  lyric: v.string(), // "" = instrumental
});

/** One bar (measure) of music, 1–6 segments. */
export const barValidator = v.object({
  segments: v.array(segmentValidator),
});

export const sectionValidator = v.object({
  id: v.string(),
  name: v.string(), // "Verse 1", "Chorus" …
  bars: v.array(barValidator),
});

export const sectionsValidator = v.array(sectionValidator);

/**
 * One note of the AI-composed melody. `d` is its length in sixteenth notes,
 * `deg` its scale degree (0 = tonic, 7 = octave up); no `deg` means a rest.
 */
export const melodyNoteValidator = v.object({
  d: v.number(),
  deg: v.optional(v.number()),
});

/** The whole melody: one list of notes per bar, in song order. [] = not composed. */
export const melodyValidator = v.array(v.array(melodyNoteValidator));

export const melodyStatusValidator = v.union(
  v.literal("composing"),
  v.literal("ready"),
  v.literal("failed"),
);

export const lengthKeyValidator = v.union(
  v.literal("short"),
  v.literal("standard"),
  v.literal("full"),
);

export const chordStyleValidator = v.union(
  v.literal("simple"),
  v.literal("rich"),
);

export const beatsPerBarValidator = v.union(
  v.literal(3),
  v.literal(4),
  v.literal(6), // 6/8
);

/** Optional extra instruments the user selected when requesting the song. */
export const extraInstrumentValidator = v.union(
  v.literal("violin"),
  v.literal("electricGuitar"),
  v.literal("fluteLead"),
  v.literal("shaker"),
  v.literal("tambourine"),
  v.literal("percussion"),
);

export const extraInstrumentsValidator = v.array(extraInstrumentValidator);

/* ---------------------------- arrangement plan ---------------------------- */

export const arrangementStatusValidator = v.union(
  v.literal("arranging"),
  v.literal("ready"),
  v.literal("failed"),
);

/**
 * One scheduled note (flute / violin) in a stored arrangement bar.
 * Times are in sixteenths inside the bar.
 */
export const arrangementNoteValidator = v.object({
  u: v.number(),
  d: v.number(),
  midi: v.number(),
  vel: v.number(),
});

/**
 * One guitar strum in a stored arrangement bar.
 */
export const arrangementStrumValidator = v.object({
  u: v.number(),
  d: v.number(),
  shift: v.number(),
  notes: v.array(v.number()),
  vel: v.number(),
  dir: v.union(v.literal("down"), v.literal("up")),
  spread: v.number(),
});

/**
 * Full band plan the player can use. Guitar may be empty (rules fill it in);
 * flute / violin bars that fail validation are also left empty so the rules
 * engine supplies a safe fallback for just those bars.
 */
export const arrangementValidator = v.object({
  unitsPerBar: v.number(),
  guitar: v.array(v.array(arrangementStrumValidator)),
  flute: v.array(v.array(arrangementNoteValidator)),
  violin: v.array(v.array(arrangementNoteValidator)),
});
