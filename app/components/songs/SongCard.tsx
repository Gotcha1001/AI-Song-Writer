// app/components/songs/SongCard.tsx
"use client";

import Link from "next/link";
import { formatDistanceToNow } from "date-fns";
import { AlertTriangle, Loader2, Star, Trash2 } from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { Id } from "@/convex/_generated/dataModel";

export interface SongSummary {
  _id: Id<"songs">;
  _creationTime: number;
  title: string;
  topic: string;
  mood: string;
  genre: string;
  key: string;
  tempo: number;
  status: "generating" | "ready" | "failed";
  isFavorite: boolean;
  barCount: number;
  preview: string;
}

interface SongCardProps {
  song: SongSummary;
  onToggleFavorite: (id: Id<"songs">, next: boolean) => void;
  onDelete: (id: Id<"songs">) => void;
}

export function SongCard({ song, onToggleFavorite, onDelete }: SongCardProps) {
  return (
    <div className="group relative rounded-xl border border-cyan-500/25 bg-card p-4 transition hover:border-cyan-400/60 hover:shadow-[0_0_24px_-10px_var(--accent-400)]">
      {/* The whole card is the link; the buttons sit above it. */}
      <Link
        href={`/songs/${song._id}`}
        className="absolute inset-0 rounded-xl"
        aria-label={`Open ${song.title}`}
      />

      <div className="pointer-events-none relative">
        <div className="mb-1 flex items-start justify-between gap-2 pr-16">
          <h3 className="line-clamp-2 text-lg font-black leading-tight">
            {song.title}
          </h3>
        </div>
        <p className="mb-3 line-clamp-1 text-sm text-muted-foreground">
          {song.topic}
        </p>

        {song.status === "generating" && (
          <p className="flex items-center gap-2 text-sm text-cyan-500">
            <Loader2 className="size-4 animate-spin" /> Writing…
          </p>
        )}
        {song.status === "failed" && (
          <p className="flex items-center gap-2 text-sm text-red-500">
            <AlertTriangle className="size-4" /> Failed — open to retry
          </p>
        )}
        {song.status === "ready" && (
          <>
            <p className="mb-3 line-clamp-2 min-h-[2.5rem] text-sm italic text-foreground/70">
              {song.preview ? `“${song.preview}…”` : "Instrumental"}
            </p>
            <div className="flex flex-wrap gap-1.5">
              <Badge variant="outline">{song.key}</Badge>
              <Badge variant="outline">{song.tempo} BPM</Badge>
              <Badge variant="outline">{song.barCount} bars</Badge>
              <Badge variant="secondary">{song.genre}</Badge>
              <Badge variant="secondary">{song.mood}</Badge>
            </div>
          </>
        )}
        <p className="mt-3 text-xs text-muted-foreground">
          {formatDistanceToNow(song._creationTime, { addSuffix: true })}
        </p>
      </div>

      <div className="absolute right-2 top-2 flex gap-1">
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={
            song.isFavorite ? "Remove from favourites" : "Add to favourites"
          }
          aria-pressed={song.isFavorite}
          onClick={() => onToggleFavorite(song._id, !song.isFavorite)}
        >
          <Star
            className={cn(song.isFavorite && "fill-current text-yellow-400")}
          />
        </Button>

        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={`Delete ${song.title}`}
            >
              <Trash2 />
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete “{song.title}”?</AlertDialogTitle>
              <AlertDialogDescription>
                This removes the song and its chord chart for good.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Keep it</AlertDialogCancel>
              <AlertDialogAction onClick={() => onDelete(song._id)}>
                Delete
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    </div>
  );
}
