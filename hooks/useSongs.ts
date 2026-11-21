// hooks/useSongs.ts
"use client";

import { useMemo } from "react";
import { useUser } from "@clerk/nextjs";
import { useMutation, useQuery } from "convex/react";
import { ConvexError } from "convex/values";
import type { FunctionArgs } from "convex/server";
import { toast } from "sonner";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";

/** undefined = loading, [] = none yet. */
export function useSongList() {
  const { isSignedIn } = useUser();
  return useQuery(api.songs.list, isSignedIn ? {} : "skip");
}

/** undefined = loading, null = not found (or not yours). */
export function useSong(songId: string | undefined) {
  const { isSignedIn } = useUser();
  return useQuery(api.songs.get, isSignedIn && songId ? { songId } : "skip");
}

export function errorMessage(e: unknown): string {
  if (e instanceof ConvexError && typeof e.data === "string") return e.data;
  return "Something went wrong. Please try again.";
}

/** Every action toasts its own error and resolves to null / false on failure. */
export function useSongActions() {
  const request = useMutation(api.songs.request);
  const regenerate = useMutation(api.songs.regenerate);
  const regenerateMelody = useMutation(api.songs.regenerateMelody);
  const updateContent = useMutation(api.songs.updateContent);
  const patchMeta = useMutation(api.songs.patchMeta);
  const remove = useMutation(api.songs.remove);

  return useMemo(() => {
    async function run<T>(fn: () => Promise<T>): Promise<T | null> {
      try {
        return await fn();
      } catch (e) {
        toast.error(errorMessage(e));
        return null;
      }
    }
    return {
      create: (args: FunctionArgs<typeof api.songs.request>) =>
        run(() => request(args)),
      regenerate: async (songId: Id<"songs">) =>
        (await run(() => regenerate({ songId }))) !== null,
      regenerateMelody: async (songId: Id<"songs">) =>
        (await run(() => regenerateMelody({ songId }))) !== null,
      saveContent: async (args: FunctionArgs<typeof api.songs.updateContent>) =>
        (await run(() => updateContent(args))) !== null,
      rename: async (songId: Id<"songs">, title: string) =>
        (await run(() => patchMeta({ songId, title }))) !== null,
      setFavorite: async (songId: Id<"songs">, isFavorite: boolean) =>
        (await run(() => patchMeta({ songId, isFavorite }))) !== null,
      remove: async (songId: Id<"songs">) =>
        (await run(() => remove({ songId }))) !== null,
    };
  }, [request, regenerate, regenerateMelody, updateContent, patchMeta, remove]);
}
