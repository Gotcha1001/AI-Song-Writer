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
