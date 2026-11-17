// app/page.tsx   (replaces the game landing page)
"use client";

import Link from "next/link";
import { SignInButton, useAuth } from "@clerk/nextjs";
import { ArrowRight } from "lucide-react";
import { ChordChart } from "@/app/components/songs/ChordChart";
import { Button } from "@/components/ui/button";
import type { SongSection } from "@/lib/songTypes";

// A tiny hand-written example so visitors see the format before signing in.
const DEMO: SongSection[] = [
  {
    id: "demo",
    name: "Verse 1",
    bars: [
      {
        segments: [
          { chord: "Am", lyric: "Dur-ban sun is " },
          { chord: "F", lyric: "rising " },
        ],
      },
      {
        segments: [
          { chord: "C", lyric: "guitar on my " },
          { chord: "G", lyric: "back " },
        ],
      },
      {
        segments: [
          { chord: "Am", lyric: "every road I've " },
          { chord: "F", lyric: "known " },
        ],
      },
      {
        segments: [
          { chord: "G", lyric: "fades to " },
          { chord: "Am", lyric: "black " },
        ],
      },
    ],
  },
];

export default function HomePage() {
  const { isLoaded, isSignedIn } = useAuth();

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-10 py-8">
      <section className="space-y-5">
        <h1 className="text-4xl font-black leading-tight tracking-tight sm:text-5xl">
          Tell it what the song is about.
          <br />
          Get the chords and the words, bar by bar.
        </h1>

        <p className="max-w-xl text-lg text-muted-foreground">
          Pick a topic, a mood and a length. Every bar comes back with its
          chords on top and the lyrics lined up underneath, ready to play,
          transpose and print.
        </p>

        <div className="flex flex-wrap gap-3">
          {!isLoaded ? (
            <Button size="lg" disabled>
              Loading...
            </Button>
          ) : isSignedIn ? (
            <>
              <Button asChild size="lg">
                <Link href="/songs/new">
                  Write a song <ArrowRight />
                </Link>
              </Button>

              <Button asChild size="lg" variant="outline">
                <Link href="/songs">My songs</Link>
              </Button>
            </>
          ) : (
            <SignInButton mode="modal">
              <Button size="lg">
                Sign in to start <ArrowRight />
              </Button>
            </SignInButton>
          )}
        </div>
      </section>

      <section
        aria-label="Example chord chart"
        className="rounded-xl border border-cyan-500/25 p-5"
      >
        <ChordChart
          sections={DEMO}
          barsPerRow={4}
          showChords
          showLyrics
          textScale={1.1}
        />
      </section>
    </div>
  );
}
