// convex/ai.ts
"use node";

import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalAction } from "./_generated/server";
import {
  buildBarSpecs,
  buildMelodyPrompt,
  parseMelodyJson,
  pickHints,
  unitsPerBar,
  type StoredBar,
} from "./lib/melodyPrompt";
import { callModel, hasAiKey, ModelError, sleep } from "./lib/openrouter";
import { buildPrompt, parseSongJson } from "./lib/songPrompt";

/**
 * Env (set in the Convex dashboard, or `npx convex env set …`):
 *   OPENROUTER_API_KEY   and/or
 *   GEMINI_API_KEY       at least one of the two is required
 *   OPENROUTER_MODELS / GEMINI_MODELS / AI_PRIMARY are optional, see lib/openrouter.ts
 * Several models are tried in turn, so one flaky free model doesn't sink a song.
 */
const MAX_ATTEMPTS = 3;

export const generateSong = internalAction({
  args: { songId: v.id("songs") },
  handler: async (ctx, { songId }): Promise<void> => {
    const song = await ctx.runQuery(internal.songs.getForGeneration, {
      songId,
    });
    if (!song || song.status !== "generating") return;

    const fail = (error: string) =>
      ctx.runMutation(internal.songs.markFailed, { songId, error });

    if (!hasAiKey()) {
      console.error(
        "[songs] No AI key is set. Run `npx convex env set OPENROUTER_API_KEY <key>` and/or `npx convex env set GEMINI_API_KEY <key>`.",
      );
      await fail("The AI isn't configured yet (missing API key).");
      return;
    }

    const { system, user } = buildPrompt({
      topic: song.topic,
      mood: song.mood,
      genre: song.genre,
      language: song.language,
      lengthKey: song.lengthKey,
      targetBars: song.targetBars,
      requestedKey: song.requestedKey,
      requestedTempo: song.requestedTempo,
      beatsPerBar: song.beatsPerBar,
      chordStyle: song.chordStyle,
    });

    let lastError = "Unknown error";
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        const raw = await callModel({
          system,
          user,
          label: "song",
          rotate: attempt - 1, // a retry asks a different model first
        });
        const parsed = parseSongJson(raw, song.requestedKey);

        // Saving also starts the melody step (see songs.saveGenerated).
        await ctx.runMutation(internal.songs.saveGenerated, {
          songId,
          title: parsed.title,
          key: parsed.key,
          tempo: song.requestedTempo ?? parsed.tempo,
          sections: parsed.sections,
        });
        return;
      } catch (e) {
        lastError = e instanceof Error ? e.message : String(e);
        console.error(
          `[songs] attempt ${attempt}/${MAX_ATTEMPTS} failed:`,
          lastError,
        );
        if (attempt < MAX_ATTEMPTS) {
          await sleep(e instanceof ModelError ? e.retryAfterMs : 1500);
        }
      }
    }

    await fail(`Couldn't write the song (${lastError}). Try again.`);
  },
});

/**
 * Second AI step: compose the vocal melody from the finished lyrics + chords.
 * Every bar is checked (lengths add up, one note per syllable). Bars that fail
 * are asked for again, up to MAX_ATTEMPTS times; anything still missing is left
 * empty and the app draws its built-in tune for just those bars.
 */
export const composeMelody = internalAction({
  args: { songId: v.id("songs"), startedAt: v.number() },
  handler: async (ctx, { songId, startedAt }): Promise<void> => {
    const song = await ctx.runQuery(internal.songs.getForGeneration, {
      songId,
    });
    if (
      !song ||
      song.status !== "ready" ||
      song.melodyStatus !== "composing" ||
      song.melodyStartedAt !== startedAt
    )
      return;

    const fail = (error: string) =>
      ctx.runMutation(internal.songs.markMelodyFailed, {
        songId,
        startedAt,
        error,
      });

    if (!hasAiKey()) {
      await fail("The AI isn't configured yet (missing API key).");
      return;
    }

    const specs = buildBarSpecs(song.sections, song.beatsPerBar);
    const U = unitsPerBar(song.beatsPerBar);
    const sungBars = specs.filter((s) => s.syllables.length > 0);
    if (sungBars.length === 0) {
      await fail("This song has no lyrics to put a melody to.");
      return;
    }

    const hints = pickHints(2);
    const done = new Map<number, StoredBar>();
    let lastError = "Unknown error";

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const wanted = sungBars.map((s) => s.index).filter((i) => !done.has(i));
      if (wanted.length === 0) break;

      try {
        const { system, user } = buildMelodyPrompt({
          title: song.title,
          key: song.key,
          tempo: song.tempo,
          beatsPerBar: song.beatsPerBar,
          mood: song.mood,
          genre: song.genre,
          language: song.language,
          specs,
          wanted,
          done,
          hints,
        });
        const raw = await callModel({
          system,
          user,
          temperature: 1,
          title: "Song Writer melody",
          label: "melody",
          rotate: attempt - 1, // a retry asks a different model first
        });
        const got = parseMelodyJson(raw, specs, wanted, song.beatsPerBar);
        for (const [i, bar] of got) done.set(i, bar);
        if (got.size < wanted.length) {
          lastError = `${wanted.length - got.size} bars didn't fit the lyrics`;
        }
      } catch (e) {
        lastError = e instanceof Error ? e.message : String(e);
        console.error(
          `[melody] attempt ${attempt}/${MAX_ATTEMPTS} failed:`,
          lastError,
        );
        if (attempt < MAX_ATTEMPTS) {
          await sleep(e instanceof ModelError ? e.retryAfterMs : 1500);
        }
      }
    }

    if (done.size === 0) {
      await fail(`Couldn't compose a melody (${lastError}). Try again.`);
      return;
    }

    // One list per bar, in song order. Instrumental bars are one long rest;
    // bars the AI never got right stay [] (the app fills those in itself).
    const melody: StoredBar[] = specs.map((spec) =>
      spec.syllables.length === 0 ? [{ d: U }] : (done.get(spec.index) ?? []),
    );

    await ctx.runMutation(internal.songs.saveMelody, {
      songId,
      startedAt,
      melody,
    });
  },
});
