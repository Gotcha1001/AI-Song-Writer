// hooks/useSongPlayer.ts
"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  bassNote,
  click,
  createSession,
  drums,
  electricGuitarNote,
  handPercNote,
  melodyNote,
  pianoNote,
  shakerNote,
  stringsNote,
  tambourineNote,
  violinNote,
  vowelFor,
  voiceNote,
  type MelodySound,
  type Session,
} from "@/lib/audioEngine";
import type { ExtraInstrumentKey } from "@/convex/lib/songOptions";
import { barSyllables, degreeToMidi, type Melody } from "@/lib/melody";
import { bassRoot, stringsPowerChord, voiceChord } from "@/lib/music";
import type { SongBar, SongSection } from "@/lib/songTypes";

/** Melody instrument: "flute" (default, soft), "warm", "bell", or "voice" (original). */
const MELODY_SOUND: MelodySound = "flute";

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

export type PianoStyle = "chords" | "arpeggio";

/** The words of a bar as plain text for the speech voice ("wan-" + "dering" -> "wandering"). */
function barText(bar: SongBar): string {
  return bar.segments
    .map((s) => s.lyric)
    .join("")
    .replace(/-\s*/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

interface Options {
  sections: SongSection[];
  defaultTempo: number;
  beatsPerBar: number;
  /** The tune that goes with `sections` (same bars, same key). */
  melody: Melody | null;
  /** Extra instruments chosen when the song was generated (pre-enables toggles). */
  extraInstruments?: ExtraInstrumentKey[];
}

interface Queued {
  time: number;
  bar: number;
  beat: number;
}

const LOOKAHEAD = 0.15; // seconds scheduled ahead
const TICK_MS = 25;

/**
 * Play-along: piano chords (with sustain pedal), optional metronome, drums,
 * a sung melody and a voice that reads the lyrics in time, plus a moving
 * highlight (`currentIndex` = flat bar number across all sections).
 */
export function useSongPlayer({
  sections,
  defaultTempo,
  beatsPerBar,
  melody,
  extraInstruments = [],
}: Options) {
  const flat = useMemo(() => flattenBars(sections), [sections]);

  const [playing, setPlaying] = useState(false);
  const [currentIndex, setCurrentIndex] = useState<number | null>(null);
  const [bpmOverride, setBpmOverride] = useState<number | null>(null);
  const [chordsOn, setChordsOn] = useState(true);
  const [clickOn, setClickOn] = useState(false);
  const [drumsOn, setDrumsOn] = useState(false);
  const [bassOn, setBassOn] = useState(true);
  const [stringsOn, setStringsOn] = useState(true);
  const [violinOn, setViolinOn] = useState(extraInstruments.includes("violin"));
  const [guitarOn, setGuitarOn] = useState(
    extraInstruments.includes("electricGuitar"),
  );
  const [fluteLeadOn, setFluteLeadOn] = useState(
    extraInstruments.includes("fluteLead"),
  );
  const [shakerOn, setShakerOn] = useState(extraInstruments.includes("shaker"));
  const [tambourineOn, setTambourineOn] = useState(
    extraInstruments.includes("tambourine"),
  );
  const [percussionOn, setPercussionOn] = useState(
    extraInstruments.includes("percussion"),
  );
  const [loop, setLoop] = useState(false);
  const [pedalOn, setPedalOn] = useState(true);
  const [pianoStyle, setPianoStyle] = useState<PianoStyle>("chords");
  const [singOn, setSingOn] = useState(false);
  const [speakOn, setSpeakOn] = useState(false);
  const [voiceURI, setVoiceURI] = useState<string>("");
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);

  const bpm = bpmOverride ?? defaultTempo;

  const audioRef = useRef<AudioContext | null>(null);
  const sessionRef = useRef<Session | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const live = useRef({
    flat,
    bpm,
    chordsOn,
    clickOn,
    drumsOn,
    bassOn,
    stringsOn,
    violinOn,
    guitarOn,
    fluteLeadOn,
    shakerOn,
    tambourineOn,
    percussionOn,
    loop,
    beatsPerBar,
    pedalOn,
    pianoStyle,
    singOn,
    speakOn,
    voiceURI,
    melody,
  });

  // Keep the running scheduler in sync with the latest settings.
  useEffect(() => {
    live.current = {
      flat,
      bpm,
      chordsOn,
      clickOn,
      drumsOn,
      bassOn,
      stringsOn,
      violinOn,
      guitarOn,
      fluteLeadOn,
      shakerOn,
      tambourineOn,
      percussionOn,
      loop,
      beatsPerBar,
      pedalOn,
      pianoStyle,
      singOn,
      speakOn,
      voiceURI,
      melody,
    };
  }, [
    flat,
    bpm,
    chordsOn,
    clickOn,
    drumsOn,
    bassOn,
    stringsOn,
    violinOn,
    guitarOn,
    fluteLeadOn,
    shakerOn,
    tambourineOn,
    percussionOn,
    loop,
    beatsPerBar,
    pedalOn,
    pianoStyle,
    singOn,
    speakOn,
    voiceURI,
    melody,
  ]);

  // When song data arrives (async), pre-enable instruments the user selected.
  useEffect(() => {
    if (!extraInstruments.length) return;
    if (extraInstruments.includes("violin")) setViolinOn(true);
    if (extraInstruments.includes("electricGuitar")) setGuitarOn(true);
    if (extraInstruments.includes("fluteLead")) setFluteLeadOn(true);
    if (extraInstruments.includes("shaker")) setShakerOn(true);
    if (extraInstruments.includes("tambourine")) setTambourineOn(true);
    if (extraInstruments.includes("percussion")) setPercussionOn(true);
  }, [extraInstruments]);

  // Browser voices load asynchronously.
  useEffect(() => {
    if (typeof window === "undefined" || !("speechSynthesis" in window)) return;
    const load = () => setVoices(window.speechSynthesis.getVoices());
    load();
    window.speechSynthesis.addEventListener("voiceschanged", load);
    return () =>
      window.speechSynthesis.removeEventListener("voiceschanged", load);
  }, []);

  useEffect(() => {
    if (
      !speakOn &&
      typeof window !== "undefined" &&
      "speechSynthesis" in window
    )
      window.speechSynthesis.cancel();
  }, [speakOn]);

  const clearTimer = () => {
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = null;
  };

  const stop = useCallback(() => {
    clearTimer();
    sessionRef.current?.stop(0.12);
    sessionRef.current = null;
    if (typeof window !== "undefined" && "speechSynthesis" in window)
      window.speechSynthesis.cancel();
    setPlaying(false);
    setCurrentIndex(null);
  }, []);

  const speak = useCallback((text: string, rate: number) => {
    if (
      !text ||
      typeof window === "undefined" ||
      !("speechSynthesis" in window)
    )
      return;
    const synth = window.speechSynthesis;
    synth.cancel();
    const u = new SpeechSynthesisUtterance(text);
    const wanted = live.current.voiceURI;
    const v = synth.getVoices().find((x) => x.voiceURI === wanted);
    if (v) {
      u.voice = v;
      u.lang = v.lang;
    }
    u.rate = Math.min(2, Math.max(0.6, rate));
    u.pitch = 1;
    synth.speak(u);
  }, []);

  const playFrom = useCallback(
    (startBar = 0) => {
      clearTimer();
      sessionRef.current?.stop(0.08);

      const ctx = audioRef.current ?? new AudioContext();
      audioRef.current = ctx;
      void ctx.resume();
      const session = createSession(ctx);
      sessionRef.current = session;

      const pos = { bar: startBar, beat: 0, time: ctx.currentTime + 0.1 };
      let endTime: number | null = null;
      let voicing: number[] | null = null; // last right-hand voicing (voice leading)
      let arpStep = 0;
      const queue: Queued[] = [];
      setPlaying(true);

      /** Schedule every sound that belongs to one beat. */
      const scheduleBeat = (bar: number, beat: number, when: number) => {
        const L = live.current;
        const item = L.flat[bar];
        if (!item) return;
        const compound = L.beatsPerBar === 6; // BPM counts dotted quarters
        const beatSec = 60 / L.bpm / (compound ? 3 : 1);

        // 6/8 clicks on the two main beats only (pulses 1 and 4), not every 8th.
        if (L.clickOn && (!compound || beat % 3 === 0))
          click(session, when, beat === 0);
        if (L.drumsOn) drums(session, when, beat, L.beatsPerBar, beatSec);

        /* ---- bass (root only) and strings (1-5-1 power chord) ---- */
        if (L.bassOn || L.stringsOn) {
          const segs = item.bar.segments;
          const starts = segs.map((_, i) =>
            Math.floor((i * L.beatsPerBar) / segs.length),
          );
          let active = -1;
          for (let i = 0; i < segs.length; i++) {
            if (starts[i] <= beat && segs[i].chord) active = i;
          }
          const chord = active >= 0 ? segs[active].chord : null;
          if (chord && starts[active] === beat) {
            const nextStart =
              active + 1 < segs.length ? starts[active + 1] : L.beatsPerBar;
            const length = (nextStart - beat) * beatSec;
            if (L.bassOn) {
              const root = bassRoot(chord);
              if (root !== null)
                bassNote(session, root, when, length * 0.97, 0.85);
            }
            if (L.stringsOn) {
              const notes = stringsPowerChord(chord);
              // a little overlap into the next chord so the section never gaps
              notes?.forEach((m, i) =>
                stringsNote(
                  session,
                  m,
                  when,
                  length + 0.1,
                  i === 0 ? 0.7 : 0.55,
                ),
              );
            }
          }
        }

        /* ---- extra melodic instruments (independent of bass/strings) ---- */
        // Trigger on the same chord-change beats as bass, but not gated by those toggles.
        {
          const segs = item.bar.segments;
          const starts = segs.map((_, i) =>
            Math.floor((i * L.beatsPerBar) / segs.length),
          );
          let active = -1;
          for (let i = 0; i < segs.length; i++) {
            if (starts[i] <= beat && segs[i].chord) active = i;
          }
          const chord = active >= 0 ? segs[active].chord : null;
          if (chord && starts[active] === beat) {
            const nextStart =
              active + 1 < segs.length ? starts[active + 1] : L.beatsPerBar;
            const length = Math.max(0.2, (nextStart - beat) * beatSec);

            if (L.violinOn) {
              // Chord tones an octave up — clear solo violin line
              const notes = stringsPowerChord(chord);
              if (notes && notes.length) {
                // root + fifth up an octave
                const top = notes[notes.length - 1] + 12;
                violinNote(session, top, when + 0.02, length * 0.95, 0.95);
                if (notes.length > 1) {
                  violinNote(
                    session,
                    notes[0] + 12,
                    when + 0.04,
                    length * 0.9,
                    0.55,
                  );
                }
              } else {
                const root = bassRoot(chord);
                if (root !== null)
                  violinNote(
                    session,
                    root + 24,
                    when + 0.02,
                    length * 0.95,
                    0.95,
                  );
              }
            }

            if (L.guitarOn) {
              const notes = stringsPowerChord(chord);
              if (notes && notes.length) {
                notes
                  .slice(0, 3)
                  .forEach((m, i) =>
                    electricGuitarNote(
                      session,
                      m + 12,
                      when + i * 0.025,
                      length * 0.9,
                      0.9 - i * 0.1,
                    ),
                  );
              } else {
                const root = bassRoot(chord);
                if (root !== null)
                  electricGuitarNote(
                    session,
                    root + 12,
                    when,
                    length * 0.9,
                    0.9,
                  );
              }
            }

            if (L.fluteLeadOn) {
              const notes = stringsPowerChord(chord);
              const midi =
                notes && notes.length
                  ? notes[notes.length - 1] + 12
                  : (bassRoot(chord) ?? 60) + 24;
              melodyNote(
                session,
                "flute",
                midi,
                when + 0.03,
                length * 0.92,
                0.95,
              );
            }
          }
        }

        /* ---- extra percussion (independent of chord changes) ---- */
        if (L.shakerOn) {
          // soft 8th-note shaker feel
          shakerNote(session, when, beat === 0 ? 0.45 : 0.35);
          if (!compound) {
            shakerNote(session, when + beatSec * 0.5, 0.28);
          }
        }
        if (
          L.tambourineOn &&
          (beat === 1 || beat === 3 || (compound && beat === 3))
        ) {
          tambourineNote(session, when, 0.55);
        }
        if (L.percussionOn && beat === 0) {
          // light hit on bar one, occasional higher fill on beat 2 of even bars
          handPercNote(session, when, 0.25, 0.6);
          if (bar % 2 === 1 && L.beatsPerBar >= 3) {
            handPercNote(session, when + beatSec * 2, 0.7, 0.4);
          }
        }

        /* ---- piano ---- */
        if (L.chordsOn) {
          const segs = item.bar.segments;
          const starts = segs.map((_, i) =>
            Math.floor((i * L.beatsPerBar) / segs.length),
          );
          // the chord that is sounding on this beat
          let active = -1;
          for (let i = 0; i < segs.length; i++) {
            if (starts[i] <= beat && segs[i].chord) active = i;
          }
          // a chord with no symbol of its own (shouldn't happen) rings on silently
          if (active >= 0) {
            const seg = segs[active];
            const nextStart =
              active + 1 < segs.length ? starts[active + 1] : L.beatsPerBar;
            const startsHere = starts[active] === beat;
            const remaining = (nextStart - beat) * beatSec;
            const lift = L.pedalOn ? 0.12 : -0.04; // pedal overlaps into the next chord

            if (startsHere && seg.chord) {
              const v = voiceChord(seg.chord, voicing);
              if (v) {
                voicing = v.hand;
                const hold = remaining + lift;
                // left hand: bass + octave
                pianoNote(session, v.bass[0], when, {
                  hold,
                  velocity: 0.72,
                  pedal: L.pedalOn,
                });
                pianoNote(session, v.bass[1], when + 0.004, {
                  hold,
                  velocity: 0.42,
                  pedal: L.pedalOn,
                });
                if (L.pianoStyle === "chords") {
                  // right hand rolled a touch, like a hand actually playing
                  v.hand.forEach((m, i) =>
                    pianoNote(session, m, when + 0.006 + i * 0.016, {
                      hold,
                      velocity: 0.5 + (i === v.hand.length - 1 ? 0.08 : 0),
                      pedal: L.pedalOn,
                    }),
                  );
                  arpStep = 0;
                }
              }
            }

            if (L.pianoStyle === "arpeggio" && voicing) {
              // one note per beat (two per beat outside 6/8), up and back down
              const hand = voicing;
              const order = [0, 1, 2, hand.length > 3 ? 3 : 1, 2, 1];
              const subs = compound ? 1 : 2;
              for (let s = 0; s < subs; s++) {
                const idx = order[arpStep % order.length] % hand.length;
                arpStep++;
                pianoNote(session, hand[idx], when + s * (beatSec / 2), {
                  hold: Math.max(0.3, remaining - s * (beatSec / 2)) + lift,
                  velocity: s === 0 ? 0.55 : 0.42,
                  pedal: L.pedalOn,
                });
              }
            }
          }
        }

        /* ---- sung melody ---- */
        const m = L.melody?.bars[bar];
        if (L.singOn && m && L.melody) {
          const pulse = compound ? 2 : 4; // sixteenths per scheduler beat
          const from = beat * pulse;
          const to = from + pulse;
          for (const n of m.notes) {
            if (n.deg === null || n.u < from || n.u >= to) continue;
            const at = when + ((n.u - from) / pulse) * beatSec;
            const len = (n.d / pulse) * beatSec * 0.94;
            const midi = degreeToMidi(L.melody.key, n.deg);
            if (MELODY_SOUND === "voice") {
              voiceNote(session, midi, at, len, vowelFor(n.text), 0.85);
            } else {
              melodyNote(session, MELODY_SOUND, midi, at, len, 0.85);
            }
          }
        }
      };

      /** Things that touch the page (highlight, speech) happen on time, not ahead of time. */
      const drain = () => {
        const now = ctx.currentTime;
        while (queue.length && queue[0].time <= now + 0.01) {
          const q = queue.shift() as Queued;
          const L = live.current;
          if (q.beat === 0) {
            setCurrentIndex(q.bar);
            if (L.speakOn) {
              const item = L.flat[q.bar];
              if (item) {
                const text = barText(item.bar);
                const syl = barSyllables(item.bar.segments).length;
                const compound = L.beatsPerBar === 6;
                const barSec =
                  (60 / L.bpm / (compound ? 3 : 1)) * L.beatsPerBar;
                speak(text, syl / (barSec * 4));
              }
            }
          }
        }
        if (endTime !== null && now >= endTime && queue.length === 0) {
          clearTimer();
          session.stop(2.5); // let the last chord ring out
          sessionRef.current = null;
          setPlaying(false);
          setCurrentIndex(null);
        }
      };

      const tick = () => {
        const L = live.current;
        if (endTime === null) {
          while (pos.time < ctx.currentTime + LOOKAHEAD) {
            const item = L.flat[pos.bar];
            if (!item) {
              endTime = pos.time;
              break;
            }
            const compound = L.beatsPerBar === 6;
            const beatSec = 60 / L.bpm / (compound ? 3 : 1);
            scheduleBeat(pos.bar, pos.beat, pos.time);
            queue.push({ time: pos.time, bar: pos.bar, beat: pos.beat });

            pos.time += beatSec;
            pos.beat += 1;
            if (pos.beat >= L.beatsPerBar) {
              pos.beat = 0;
              pos.bar += 1;
              if (pos.bar >= L.flat.length) {
                if (L.loop) pos.bar = 0;
                else {
                  endTime = pos.time;
                  break;
                }
              }
            }
          }
        }
        drain();
      };

      tick();
      timerRef.current = setInterval(tick, TICK_MS);
    },
    [speak],
  );

  useEffect(
    () => () => {
      clearTimer();
      if (typeof window !== "undefined" && "speechSynthesis" in window)
        window.speechSynthesis.cancel();
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
    bassOn,
    stringsOn,
    setDrumsOn,
    setBassOn,
    setStringsOn,
    violinOn,
    setViolinOn,
    guitarOn,
    setGuitarOn,
    fluteLeadOn,
    setFluteLeadOn,
    shakerOn,
    setShakerOn,
    tambourineOn,
    setTambourineOn,
    percussionOn,
    setPercussionOn,
    loop,
    setLoop,
    pedalOn,
    setPedalOn,
    pianoStyle,
    setPianoStyle,
    singOn,
    setSingOn,
    speakOn,
    setSpeakOn,
    voices,
    voiceURI,
    setVoiceURI,
    playFrom,
    stop,
    totalBars: flat.length,
  };
}
