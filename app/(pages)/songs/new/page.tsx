// app/(pages)/songs/new/page.tsx   →   URL: /songs/new
"use client";

import { SongForm } from "@/app/components/songs/SongForm";

export default function NewSongPage() {
  return (
    <div className="space-y-6">
      <header className="mx-auto max-w-3xl">
        <h1 className="text-3xl font-black tracking-tight">New song</h1>
        <p className="text-muted-foreground">
          Describe it, pick a mood and a length, and get a chord chart with the
          lyrics sitting right under the chords.
        </p>
      </header>
      <SongForm />
    </div>
  );
}
