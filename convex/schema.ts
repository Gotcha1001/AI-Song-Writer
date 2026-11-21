// convex/schema.ts
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import {
  beatsPerBarValidator,
  chordStyleValidator,
  lengthKeyValidator,
  melodyStatusValidator,
  melodyValidator,
  sectionsValidator,
} from "./lib/songValidators";

export default defineSchema({
  // ───────────────────────── from the starter kit (unchanged) ─────────────────────────
  users: defineTable({
    clerkId: v.string(),
    email: v.string(),
    name: v.string(),
    imageUrl: v.optional(v.string()),
    role: v.union(v.literal("admin"), v.literal("user")),
    createdAt: v.number(),
    // Look & feel chosen on the Settings page (accent, rain, text size).
    appearance: v.optional(
      v.object({
        accent: v.string(),
        rainMode: v.string(),
        rainDensity: v.number(),
        rainSpeed: v.number(),
        rainSize: v.number(),
        rainOpacity: v.number(),
        glow: v.boolean(),
        uiSize: v.string(),
      }),
    ),
  }).index("by_clerk_id", ["clerkId"]),

  // ───────────────────────────────── song writer ─────────────────────────────────
  songs: defineTable({
    userId: v.id("users"),

    // what the user asked for
    topic: v.string(),
    mood: v.string(),
    genre: v.string(),
    language: v.string(),
    lengthKey: lengthKeyValidator,
    targetBars: v.number(),
    requestedKey: v.optional(v.string()),
    requestedTempo: v.optional(v.number()),
    beatsPerBar: beatsPerBarValidator,
    chordStyle: chordStyleValidator,

    // what the AI produced (and the user may have edited)
    title: v.string(),
    key: v.string(),
    tempo: v.number(),
    sections: sectionsValidator,

    // generation lifecycle
    status: v.union(
      v.literal("generating"),
      v.literal("ready"),
      v.literal("failed"),
    ),
    error: v.optional(v.string()),
    generationStartedAt: v.optional(v.number()),

    // The sung melody, composed by the AI from the lyrics + chords (a second,
    // separate AI step, so the song shows up first and the tune follows).
    melody: v.optional(melodyValidator),
    melodyStatus: v.optional(melodyStatusValidator),
    melodyError: v.optional(v.string()),
    melodyStartedAt: v.optional(v.number()),

    isFavorite: v.boolean(),
    updatedAt: v.number(),
  }).index("by_user", ["userId"]),

  // One row per AI call. Used for the daily limit, so deleting a song
  // (or regenerating the same one over and over) can't dodge it.
  songGenerations: defineTable({
    userId: v.id("users"),
    songId: v.id("songs"),
    at: v.number(),
  }).index("by_user_at", ["userId", "at"]),
});
