// convex/songs.ts
import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import {
  internalMutation,
  internalQuery,
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { getCurrentUser } from "./lib/auth";
import { CHORD_RE, LENGTH_OPTIONS, LIMITS } from "./lib/songOptions";
import {
  beatsPerBarValidator,
  chordStyleValidator,
  lengthKeyValidator,
  sectionsValidator,
} from "./lib/songValidators";

/* --------------------------------- helpers --------------------------------- */

async function userOrThrow(ctx: QueryCtx | MutationCtx): Promise<Doc<"users">> {
  const user = await getCurrentUser(ctx);
  if (!user) throw new ConvexError("Please sign in first.");
  return user;
}

async function ownedSong(
  ctx: QueryCtx | MutationCtx,
  songId: Id<"songs">,
): Promise<{ user: Doc<"users">; song: Doc<"songs"> }> {
  const user = await userOrThrow(ctx);
  const song = await ctx.db.get(songId);
  if (!song || song.userId !== user._id)
    throw new ConvexError("Song not found.");
  return { user, song };
}

/** Throws if the user already used today's AI calls; otherwise records one. */
async function spendGeneration(
  ctx: MutationCtx,
  userId: Id<"users">,
  songId: Id<"songs">,
): Promise<void> {
  const since = Date.now() - 24 * 60 * 60 * 1000;
  const recent = await ctx.db
    .query("songGenerations")
    .withIndex("by_user_at", (q) => q.eq("userId", userId).gt("at", since))
    .take(LIMITS.dailyGenerations);
  if (recent.length >= LIMITS.dailyGenerations) {
    throw new ConvexError(
      `Daily limit reached (${LIMITS.dailyGenerations} generations per 24 hours). Try again later.`,
    );
  }
  await ctx.db.insert("songGenerations", { userId, songId, at: Date.now() });
}

async function startGeneration(
  ctx: MutationCtx,
  userId: Id<"users">,
  songId: Id<"songs">,
): Promise<void> {
  await spendGeneration(ctx, userId, songId);
  await ctx.db.patch(songId, {
    status: "generating",
    error: undefined,
    generationStartedAt: Date.now(),
    updatedAt: Date.now(),
  });
  await ctx.scheduler.runAfter(0, internal.ai.generateSong, { songId });
}

function firstLyric(song: Doc<"songs">): string {
  for (const section of song.sections) {
    for (const bar of section.bars) {
      const text = bar.segments
        .map((s) => s.lyric)
        .join("")
        .trim();
      if (text) return text;
    }
  }
  return "";
}

/* --------------------------------- queries --------------------------------- */

/** Light summaries for the library + sidebar (no full chord charts). */
export const list = query({
  args: {},
  handler: async (ctx) => {
    const user = await getCurrentUser(ctx);
    if (!user) return [];
    const songs = await ctx.db
      .query("songs")
      .withIndex("by_user", (q) => q.eq("userId", user._id))
      .order("desc")
      .take(100);
    return songs.map((s) => ({
      _id: s._id,
      _creationTime: s._creationTime,
      title: s.title,
      topic: s.topic,
      mood: s.mood,
      genre: s.genre,
      key: s.key,
      tempo: s.tempo,
      lengthKey: s.lengthKey,
      status: s.status,
      isFavorite: s.isFavorite,
      barCount: s.sections.reduce((n, sec) => n + sec.bars.length, 0),
      preview: firstLyric(s),
    }));
  },
});

/** One full song. `songId` is a plain string so a bad URL returns null, not a crash. */
export const get = query({
  args: { songId: v.string() },
  handler: async (ctx, { songId }) => {
    const user = await getCurrentUser(ctx);
    if (!user) return null;
    const id = ctx.db.normalizeId("songs", songId);
    if (!id) return null;
    const song = await ctx.db.get(id);
    if (!song || song.userId !== user._id) return null;
    return song;
  },
});

/* -------------------------------- mutations -------------------------------- */

export const request = mutation({
  args: {
    topic: v.string(),
    mood: v.string(),
    genre: v.string(),
    language: v.string(),
    lengthKey: lengthKeyValidator,
    key: v.optional(v.string()),
    tempo: v.optional(v.number()),
    beatsPerBar: beatsPerBarValidator,
    chordStyle: chordStyleValidator,
  },
  handler: async (ctx, args) => {
    const user = await userOrThrow(ctx);

    const topic = args.topic.trim();
    if (topic.length < LIMITS.topicMin)
      throw new ConvexError("Tell me a bit more about the song topic.");
    if (topic.length > LIMITS.topicMax)
      throw new ConvexError(
        `Keep the topic under ${LIMITS.topicMax} characters.`,
      );

    const mood = args.mood.trim().slice(0, LIMITS.moodMax) || "Heartfelt";
    const genre = args.genre.trim().slice(0, 40) || "Pop";
    const language =
      args.language.trim().slice(0, LIMITS.languageMax) || "English";
    const targetBars = LENGTH_OPTIONS.find(
      (l) => l.key === args.lengthKey,
    )!.bars;

    const key = args.key?.trim() || undefined;
    if (key && !/^[A-G][#b]?m?$/.test(key))
      throw new ConvexError("That key isn't valid.");
    const tempo =
      args.tempo === undefined
        ? undefined
        : Math.min(
            LIMITS.maxTempo,
            Math.max(LIMITS.minTempo, Math.round(args.tempo)),
          );

    const songId = await ctx.db.insert("songs", {
      userId: user._id,
      topic,
      mood,
      genre,
      language,
      lengthKey: args.lengthKey,
      targetBars,
      requestedKey: key,
      requestedTempo: tempo,
      beatsPerBar: args.beatsPerBar,
      chordStyle: args.chordStyle,
      title: "Writing your song…",
      key: key ?? "C",
      tempo: tempo ?? 90,
      sections: [],
      status: "generating",
      isFavorite: false,
      updatedAt: Date.now(),
    });

    await startGeneration(ctx, user._id, songId);
    return songId;
  },
});

/** Write the song again from the same brief (also used for "Try again" after a failure). */
export const regenerate = mutation({
  args: { songId: v.id("songs") },
  handler: async (ctx, { songId }) => {
    const { user, song } = await ownedSong(ctx, songId);
    const stuck =
      song.status === "generating" &&
      Date.now() - (song.generationStartedAt ?? 0) < 2 * 60 * 1000;
    if (stuck) throw new ConvexError("Still writing — give it a moment.");
    await startGeneration(ctx, user._id, songId);
  },
});

/** Save edited / transposed chart content. */
export const updateContent = mutation({
  args: {
    songId: v.id("songs"),
    sections: sectionsValidator,
    key: v.optional(v.string()),
  },
  handler: async (ctx, { songId, sections, key }) => {
    const { song } = await ownedSong(ctx, songId);
    if (song.status === "generating")
      throw new ConvexError("Wait for the song to finish writing.");

    let bars = 0;
    for (const section of sections) {
      if (section.name.length > 40)
        throw new ConvexError("Section name too long.");
      for (const bar of section.bars) {
        bars += 1;
        if (
          bar.segments.length < 1 ||
          bar.segments.length > LIMITS.maxSegmentsPerBar
        ) {
          throw new ConvexError(
            `A bar can have 1 to ${LIMITS.maxSegmentsPerBar} chords.`,
          );
        }
        for (const seg of bar.segments) {
          if (seg.lyric.length > LIMITS.lyricMax)
            throw new ConvexError("A lyric line is too long.");
          if (seg.chord !== undefined && !CHORD_RE.test(seg.chord)) {
            throw new ConvexError(`"${seg.chord}" isn't a chord I recognise.`);
          }
        }
      }
    }
    if (bars === 0 || bars > LIMITS.maxBars)
      throw new ConvexError("Song size is out of range.");
    if (key !== undefined && !/^[A-G][#b]?m?$/.test(key))
      throw new ConvexError("That key isn't valid.");

    await ctx.db.patch(songId, {
      sections,
      ...(key !== undefined ? { key } : {}),
      updatedAt: Date.now(),
    });
  },
});

export const patchMeta = mutation({
  args: {
    songId: v.id("songs"),
    title: v.optional(v.string()),
    isFavorite: v.optional(v.boolean()),
  },
  handler: async (ctx, { songId, title, isFavorite }) => {
    await ownedSong(ctx, songId);
    const patch: Partial<Doc<"songs">> = { updatedAt: Date.now() };
    if (title !== undefined) {
      const t = title.trim().slice(0, LIMITS.titleMax);
      if (!t) throw new ConvexError("A song needs a title.");
      patch.title = t;
    }
    if (isFavorite !== undefined) patch.isFavorite = isFavorite;
    await ctx.db.patch(songId, patch);
  },
});

export const remove = mutation({
  args: { songId: v.id("songs") },
  handler: async (ctx, { songId }) => {
    await ownedSong(ctx, songId);
    await ctx.db.delete(songId);
  },
});

/* ------------------------- internal (used by ai.ts) ------------------------- */

export const getForGeneration = internalQuery({
  args: { songId: v.id("songs") },
  handler: async (ctx, { songId }) => await ctx.db.get(songId),
});

export const saveGenerated = internalMutation({
  args: {
    songId: v.id("songs"),
    title: v.string(),
    key: v.string(),
    tempo: v.number(),
    sections: sectionsValidator,
  },
  handler: async (ctx, { songId, ...fields }) => {
    const song = await ctx.db.get(songId);
    if (!song) return; // deleted while generating
    await ctx.db.patch(songId, {
      ...fields,
      status: "ready",
      error: undefined,
      updatedAt: Date.now(),
    });
  },
});

export const markFailed = internalMutation({
  args: { songId: v.id("songs"), error: v.string() },
  handler: async (ctx, { songId, error }) => {
    const song = await ctx.db.get(songId);
    if (!song) return;
    await ctx.db.patch(songId, {
      status: "failed",
      error: error.slice(0, 300),
      updatedAt: Date.now(),
    });
  },
});
