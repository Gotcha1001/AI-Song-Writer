// lib/songTypes.ts
import type { Doc } from "@/convex/_generated/dataModel";

export type Song = Doc<"songs">;
export type SongSection = Song["sections"][number];
export type SongBar = SongSection["bars"][number];
export type SongSegment = SongBar["segments"][number];
