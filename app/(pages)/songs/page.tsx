// app/(pages)/songs/page.tsx   →   URL: /songs
"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { Music2, Plus, Search, Star } from "lucide-react";
import { SongCard } from "@/app/components/songs/SongCard";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { useSongActions, useSongList } from "@/hooks/useSongs";

export default function SongsPage() {
  const songs = useSongList();
  const actions = useSongActions();
  const [query, setQuery] = useState("");
  const [onlyFavs, setOnlyFavs] = useState(false);

  const visible = useMemo(() => {
    if (!songs) return [];
    const q = query.trim().toLowerCase();
    return songs.filter(
      (s) =>
        (!onlyFavs || s.isFavorite) &&
        (!q ||
          s.title.toLowerCase().includes(q) ||
          s.topic.toLowerCase().includes(q)),
    );
  }, [songs, query, onlyFavs]);

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-3xl font-black tracking-tight">My songs</h1>
          <p className="text-muted-foreground">
            Everything you’ve written, newest first.
          </p>
        </div>
        <Button asChild size="lg">
          <Link href="/songs/new">
            <Plus /> New song
          </Link>
        </Button>
      </header>

      {songs !== undefined && songs.length > 0 && (
        <div className="flex flex-wrap items-center gap-3">
          <div className="relative min-w-56 flex-1 sm:max-w-sm">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search title or topic"
              aria-label="Search songs"
              className="pl-9"
            />
          </div>
          <Button
            variant={onlyFavs ? "default" : "outline"}
            size="sm"
            aria-pressed={onlyFavs}
            onClick={() => setOnlyFavs((f) => !f)}
          >
            <Star /> Favourites
          </Button>
        </div>
      )}

      {songs === undefined && (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-44 rounded-xl" />
          ))}
        </div>
      )}

      {songs !== undefined && songs.length === 0 && (
        <div className="flex flex-col items-center gap-4 rounded-xl border border-dashed border-cyan-500/30 py-16 text-center">
          <Music2 className="size-10 text-cyan-500" />
          <div>
            <p className="text-lg font-bold">No songs yet</p>
            <p className="text-muted-foreground">
              Give me a topic and a mood and I’ll write your first one.
            </p>
          </div>
          <Button asChild>
            <Link href="/songs/new">Write a song</Link>
          </Button>
        </div>
      )}

      {songs !== undefined && songs.length > 0 && visible.length === 0 && (
        <p className="py-10 text-center text-muted-foreground">
          Nothing matches that.
        </p>
      )}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {visible.map((song) => (
          <SongCard
            key={song._id}
            song={song}
            onToggleFavorite={(id, next) => void actions.setFavorite(id, next)}
            onDelete={(id) => void actions.remove(id)}
          />
        ))}
      </div>
    </div>
  );
}
