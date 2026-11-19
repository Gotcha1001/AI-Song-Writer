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
