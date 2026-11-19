// convex/ai.ts
"use node";

import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalAction } from "./_generated/server";
import { buildPrompt, parseSongJson } from "./lib/songPrompt";

/**
 * Env (set in the Convex dashboard, or `npx convex env set …`):
 *   OPENROUTER_API_KEY   required
 *   OPENROUTER_MODEL     optional, defaults to the free model below
 */
const DEFAULT_MODEL = "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free";
const MAX_ATTEMPTS = 3;

interface OpenRouterResponse {
  choices?: { message?: { content?: string | null } }[];
  error?: { message?: string; code?: number };
}

class ModelError extends Error {
  constructor(
    message: string,
    readonly retryAfterMs: number,
  ) {
    super(message);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function callModel(
  apiKey: string,
  model: string,
  system: string,
  user: string,
): Promise<string> {
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      "X-Title": "Song Writer",
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      temperature: 0.9,
      // Reasoning models spend tokens thinking first, so leave plenty of room.
      max_tokens: 12000,
    }),
  });

  const text = await res.text();
  let json: OpenRouterResponse;
  try {
    json = JSON.parse(text) as OpenRouterResponse;
  } catch {
    throw new ModelError(
      `OpenRouter sent an unreadable reply (HTTP ${res.status})`,
      2000,
    );
  }

  if (!res.ok || json.error) {
    const rateLimited = res.status === 429 || json.error?.code === 429;
    throw new ModelError(
      json.error?.message ?? `OpenRouter error (HTTP ${res.status})`,
      rateLimited ? 6000 : 2000,
    );
  }

  const content = json.choices?.[0]?.message?.content;
  if (!content || !content.trim()) {
    throw new ModelError("The model returned an empty reply", 2000);
  }
  return content;
}

export const generateSong = internalAction({
  args: { songId: v.id("songs") },
  handler: async (ctx, { songId }) => {
    const song = await ctx.runQuery(internal.songs.getForGeneration, {
      songId,
    });
    if (!song || song.status !== "generating") return;

    const fail = (error: string) =>
      ctx.runMutation(internal.songs.markFailed, { songId, error });

    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) {
      console.error(
        "[songs] OPENROUTER_API_KEY is not set. Run `npx convex env set OPENROUTER_API_KEY <key>`.",
      );
      await fail("The AI isn't configured yet (missing API key).");
      return;
    }

    const model = process.env.OPENROUTER_MODEL || DEFAULT_MODEL;
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
        const raw = await callModel(apiKey, model, system, user);
        const parsed = parseSongJson(raw, song.requestedKey);

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
