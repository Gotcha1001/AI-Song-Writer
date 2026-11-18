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

/* ---- simple synthesized drum kit (no sample files needed) --------------- */
const noiseCache = new WeakMap<AudioContext, AudioBuffer>();

function noiseBuffer(ctx: AudioContext): AudioBuffer {
  let buf = noiseCache.get(ctx);
  if (!buf) {
    buf = ctx.createBuffer(
      1,
      Math.floor(ctx.sampleRate * 0.25),
      ctx.sampleRate,
    );
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    noiseCache.set(ctx, buf);
  }
  return buf;
}

function playKick(ctx: AudioContext, when: number, vol = 0.45): void {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = "sine";
  osc.frequency.setValueAtTime(150, when);
  osc.frequency.exponentialRampToValueAtTime(42, when + 0.12);
  gain.gain.setValueAtTime(vol, when);
  gain.gain.exponentialRampToValueAtTime(0.0001, when + 0.25);
  osc.connect(gain).connect(ctx.destination);
  osc.start(when);
  osc.stop(when + 0.28);
}

function playSnare(ctx: AudioContext, when: number, vol = 0.22): void {
  const noise = ctx.createBufferSource();
  noise.buffer = noiseBuffer(ctx);
  const hp = ctx.createBiquadFilter();
  hp.type = "highpass";
  hp.frequency.value = 1500;
  const nGain = ctx.createGain();
  nGain.gain.setValueAtTime(vol, when);
  nGain.gain.exponentialRampToValueAtTime(0.0001, when + 0.16);
  noise.connect(hp).connect(nGain).connect(ctx.destination);
  noise.start(when);
  noise.stop(when + 0.18);

  // a short tonal "body" under the noise
  const osc = ctx.createOscillator();
  const oGain = ctx.createGain();
  osc.type = "triangle";
  osc.frequency.setValueAtTime(190, when);
  osc.frequency.exponentialRampToValueAtTime(120, when + 0.08);
  oGain.gain.setValueAtTime(vol * 0.6, when);
  oGain.gain.exponentialRampToValueAtTime(0.0001, when + 0.1);
  osc.connect(oGain).connect(ctx.destination);
  osc.start(when);
  osc.stop(when + 0.12);
}

function playHat(ctx: AudioContext, when: number, vol = 0.06): void {
  const noise = ctx.createBufferSource();
  noise.buffer = noiseBuffer(ctx);
  const hp = ctx.createBiquadFilter();
  hp.type = "highpass";
  hp.frequency.value = 7000;
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(vol, when);
  gain.gain.exponentialRampToValueAtTime(0.0001, when + 0.05);
  noise.connect(hp).connect(gain).connect(ctx.destination);
  noise.start(when);
  noise.stop(when + 0.06);
}

/**
 * One beat of a basic groove, with hi-hats on every 8th note.
 *   4/4: kick on 1 and 3, snare on 2 and 4
 *   3/4: kick on 1, light snare on 2 and 3 (waltz feel)
 */
function playDrums(
  ctx: AudioContext,
  beat: number,
  beatsPerBar: number,
  beatSeconds: number,
): void {
  const t = ctx.currentTime;
  if (beatsPerBar === 3) {
    if (beat === 0) playKick(ctx, t);
    else playSnare(ctx, t, 0.14);
  } else if (beat % 2 === 0) {
    playKick(ctx, t);
  } else {
    playSnare(ctx, t);
  }
  playHat(ctx, t, beat === 0 ? 0.08 : 0.06); // on the beat
  playHat(ctx, t + beatSeconds / 2, 0.04); // the "and"
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
 * Play-along: a metronome, optional drum beat, optional chord pad, and a moving highlight
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
  const [drumsOn, setDrumsOn] = useState(false);
  const [loop, setLoop] = useState(false);

  const bpm = bpmOverride ?? defaultTempo;

  const audioRef = useRef<AudioContext | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const posRef = useRef({ bar: 0, beat: 0 });
  const live = useRef({
    flat,
    bpm,
    chordsOn,
    clickOn,
    drumsOn,
    loop,
    beatsPerBar,
  });

  // Keep the running metronome in sync with the latest settings.
  useEffect(() => {
    live.current = {
      flat,
      bpm,
      chordsOn,
      clickOn,
      drumsOn,
      loop,
      beatsPerBar,
    };
  }, [flat, bpm, chordsOn, clickOn, drumsOn, loop, beatsPerBar]);

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
        if (L.drumsOn) playDrums(ctx, beat, L.beatsPerBar, beatMs / 1000);

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
    drumsOn,
    setDrumsOn,
    loop,
    setLoop,
    playFrom,
    stop,
    totalBars: flat.length,
  };
}
