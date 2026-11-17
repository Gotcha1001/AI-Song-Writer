// hooks/useSongPlayer.ts
"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { chordFrequencies } from "@/lib/music";
import type { SongBar, SongSection } from "@/lib/songTypes";

export interface FlatBar {
  sectionIndex: number;
  barIndex: number;
  bar: SongBar;
}

export function flattenBars(sections: SongSection[]): FlatBar[] {
  return sections.flatMap((s, sectionIndex) =>
    s.bars.map((bar, barIndex) => ({ sectionIndex, barIndex, bar })),
  );
}

function playClick(ctx: AudioContext, accent: boolean): void {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = "square";
  osc.frequency.value = accent ? 1500 : 1000;
  const t = ctx.currentTime;
  gain.gain.setValueAtTime(0.06, t);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.05);
  osc.connect(gain).connect(ctx.destination);
  osc.start(t);
  osc.stop(t + 0.06);
}

function playChord(ctx: AudioContext, chord: string, seconds: number): void {
  const freqs = chordFrequencies(chord);
  const t = ctx.currentTime;
  const dur = Math.min(2.5, Math.max(0.4, seconds));
  for (const f of freqs) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "triangle";
    osc.frequency.value = f;
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.07, t + 0.03);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(gain).connect(ctx.destination);
    osc.start(t);
    osc.stop(t + dur + 0.05);
  }
}

interface Options {
  sections: SongSection[];
  defaultTempo: number;
  beatsPerBar: number;
}

/**
 * Play-along: a metronome, optional chord pad, and a moving highlight
 * (`currentIndex` = flat bar number across all sections).
 */
export function useSongPlayer({
  sections,
  defaultTempo,
  beatsPerBar,
}: Options) {
  const flat = useMemo(() => flattenBars(sections), [sections]);

  const [playing, setPlaying] = useState(false);
  const [currentIndex, setCurrentIndex] = useState<number | null>(null);
  const [bpmOverride, setBpmOverride] = useState<number | null>(null);
  const [chordsOn, setChordsOn] = useState(true);
  const [clickOn, setClickOn] = useState(true);
  const [loop, setLoop] = useState(false);

  const bpm = bpmOverride ?? defaultTempo;

  const audioRef = useRef<AudioContext | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const posRef = useRef({ bar: 0, beat: 0 });
  const live = useRef({ flat, bpm, chordsOn, clickOn, loop, beatsPerBar });

  // Keep the running metronome in sync with the latest settings.
  useEffect(() => {
    live.current = { flat, bpm, chordsOn, clickOn, loop, beatsPerBar };
  }, [flat, bpm, chordsOn, clickOn, loop, beatsPerBar]);

  const stop = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
    setPlaying(false);
    setCurrentIndex(null);
  }, []);

  const playFrom = useCallback(
    (startBar = 0) => {
      if (timerRef.current) clearTimeout(timerRef.current);
      const ctx = audioRef.current ?? new AudioContext();
      audioRef.current = ctx;
      void ctx.resume();

      posRef.current = { bar: startBar, beat: 0 };
      setPlaying(true);

      const step = () => {
        const L = live.current;
        const { bar, beat } = posRef.current;
        const item = L.flat[bar];
        if (!item) {
          stop();
          return;
        }
        const beatMs = 60000 / L.bpm;

        if (beat === 0) setCurrentIndex(bar);
        if (L.clickOn) playClick(ctx, beat === 0);

        if (L.chordsOn) {
          const segs = item.bar.segments;
          segs.forEach((seg, i) => {
            const startBeat = Math.floor((i * L.beatsPerBar) / segs.length);
            if (startBeat !== beat || !seg.chord) return;
            const nextStart =
              i + 1 < segs.length
                ? Math.floor(((i + 1) * L.beatsPerBar) / segs.length)
                : L.beatsPerBar;
            playChord(
              ctx,
              seg.chord,
              ((nextStart - startBeat) * beatMs) / 1000,
            );
          });
        }

        let nextBeat = beat + 1;
        let nextBar = bar;
        if (nextBeat >= L.beatsPerBar) {
          nextBeat = 0;
          nextBar += 1;
        }
        if (nextBar >= L.flat.length) {
          if (L.loop) {
            nextBar = 0;
          } else {
            timerRef.current = setTimeout(stop, beatMs);
            return;
          }
        }
        posRef.current = { bar: nextBar, beat: nextBeat };
        timerRef.current = setTimeout(step, beatMs);
      };

      step();
    },
    [stop],
  );

  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      void audioRef.current?.close();
    },
    [],
  );

  return {
    playing,
    currentIndex,
    bpm,
    setBpm: setBpmOverride,
    chordsOn,
    setChordsOn,
    clickOn,
    setClickOn,
    loop,
    setLoop,
    playFrom,
    stop,
    totalBars: flat.length,
  };
}
