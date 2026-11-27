// hooks/useSongPlayer.ts
"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  bassNote,
  click,
  createSession,
  drums,
  guitarStrumNote,
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
import {
  arrangeSong,
  violinCarry,
  type Arrangement,
  type NoteEvent,
  type StrumEvent,
} from "@/lib/arrangement";
import { bassRoot, stringsPowerChord, voiceChord } from "@/lib/music";
import { compHitsAt, pianoCompFor } from "@/lib/pianoComp";
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

/** "comp" = the genre's own piano rhythm (lib/pianoComp.ts), "chords" = plain sustained chords. */
export type PianoStyle = "comp" | "chords" | "arpeggio";

/** The words of a bar as plain text for the speech voice ("wan-" + "dering" -> "wandering"). */
function barText(bar: SongBar): string {
  return bar.segments
    .map((s) => s.lyric)
    .join("")
    .replace(/-\s*/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/* ------------------------- stored arrangement plan ------------------------- */

const isNum = (n: unknown): n is number =>
  typeof n === "number" && Number.isFinite(n);
const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

/** One bar of single notes (flute / violin), moved by `shift` semitones, or null if it is not usable. */
function cleanNotes(
  evs: unknown,
  shift: number,
  U: number,
): NoteEvent[] | null {
  if (!Array.isArray(evs)) return null;
  const out: NoteEvent[] = [];
  for (const raw of evs) {
    const e = raw as Partial<NoteEvent> | null;
    if (!e || !isNum(e.u) || !isNum(e.d) || !isNum(e.midi) || !isNum(e.vel))
      return null;
    if (e.u < 0 || e.u >= U || e.d <= 0 || e.d > U * 4) return null;
    const midi = e.midi + shift;
    if (midi < 21 || midi > 108) return null;
    out.push({ u: e.u, d: e.d, midi, vel: clamp01(e.vel) });
  }
  return out;
}

/** One bar of guitar strums, moved by `shift` semitones, or null if it is not usable. */
function cleanStrums(
  evs: unknown,
  shift: number,
  U: number,
): StrumEvent[] | null {
  if (!Array.isArray(evs)) return null;
  const out: StrumEvent[] = [];
  for (const raw of evs) {
    const e = raw as Partial<StrumEvent> | null;
    if (!e || !isNum(e.u) || !isNum(e.d) || !isNum(e.vel)) return null;
    if (e.u < 0 || e.u >= U || e.d <= 0 || e.d > U * 4) return null;
    if (!Array.isArray(e.notes) || e.notes.length < 1 || e.notes.length > 8)
      return null;
    const notes: number[] = [];
    for (const m of e.notes) {
      if (!isNum(m) || m + shift < 21 || m + shift > 108) return null;
      notes.push(m + shift);
    }
    out.push({
      u: e.u,
      d: e.d,
      shift: isNum(e.shift) ? Math.min(0.3, Math.max(0, e.shift)) : 0,
      notes,
      vel: clamp01(e.vel),
      dir: e.dir === "up" ? "up" : "down",
      spread: isNum(e.spread) ? Math.min(4, Math.max(0.5, e.spread)) : 1,
    });
  }
  return out;
}

/**
 * Picks the band for the player: a stored plan (for example one written by the
 * AI arranger) where it is usable, the rule-based plan everywhere else.
 *
 *   - A plan that does not match the song (different bars-per-bar grid or bar
 *     count, e.g. the lyrics were edited after it was made) is ignored whole.
 *   - Inside a matching plan every bar is checked on its own; a bad bar takes
 *     the rule-based bar for that part, so one slip never costs the whole band.
 *   - Stored notes are absolute MIDI, so a view-only transpose moves them by the
 *     same number of semitones (kept within +-6 so the parts stay in range).
 *     The rule-based plan already follows the transposed chords and melody.
 */
export function resolveArrangement(
  stored: Arrangement | null | undefined,
  rules: Arrangement,
  bars: number,
  transposeSteps = 0,
): { arrangement: Arrangement; source: "stored" | "rules" } {
  const rulesOnly = { arrangement: rules, source: "rules" as const };
  if (
    !stored ||
    stored.unitsPerBar !== rules.unitsPerBar ||
    !Array.isArray(stored.guitar) ||
    !Array.isArray(stored.flute) ||
    !Array.isArray(stored.violin) ||
    stored.guitar.length !== bars ||
    stored.flute.length !== bars ||
    stored.violin.length !== bars
  )
    return rulesOnly;

  const U = rules.unitsPerBar;
  const shift =
    transposeSteps > 6
      ? transposeSteps - 12
      : transposeSteps < -6
        ? transposeSteps + 12
        : transposeSteps;
  let used = 0;
  const pick = <T>(
    part: unknown[],
    ruleBars: T[][],
    clean: (evs: unknown, shift: number, U: number) => T[] | null,
  ): T[][] =>
    ruleBars.map((ruleBar, i) => {
      const c = clean(part[i], shift, U);
      if (c) {
        used++;
        return c;
      }
      return ruleBar;
    });

  const arrangement: Arrangement = {
    unitsPerBar: U,
    guitar: pick(stored.guitar, rules.guitar, cleanStrums),
    flute: pick(stored.flute, rules.flute, cleanNotes),
    violin: pick(stored.violin, rules.violin, cleanNotes),
  };
  return used > 0 ? { arrangement, source: "stored" } : rulesOnly;
}

/* ------------------------------ section dynamics ------------------------------ */

export interface BarDynamics {
  /** Loudness scale for the bar (1 = normal). */
  level: number;
  /** The last bar before a chorus: crescendo through the bar. */
  swell: boolean;
}

const isChorusName = (n: string) =>
  /chorus|hook|refrain/i.test(n) && !/pre[-\s]?chorus/i.test(n);

/**
 * Per-bar loudness for the piano, bass and strings, so a song breathes:
 * intros grow, verses sit back, pre-choruses build, choruses open up (the last
 * one a little more), the bar before a chorus swells, outros fade, and the
 * final chord rings at full strength. The guitar, flute and violin already
 * carry the same shape inside lib/arrangement.ts, so they are not scaled again.
 */
export function sectionDynamics(sections: SongSection[]): BarDynamics[] {
  const out: BarDynamics[] = [];
  const choruses = sections.filter((s) => isChorusName(s.name)).length;
  let chorusSeen = 0;

  sections.forEach((section, si) => {
    const name = section.name;
    const chorus = isChorusName(name);
    const occ = chorus ? chorusSeen++ : 0;
    const lift = chorus && choruses >= 2 && occ === choruses - 1;
    const intro = /intro/i.test(name);
    const outro = /outro|ending|coda/i.test(name);
    const pre = /pre[-\s]?chorus/i.test(name);
    const verse = /verse/i.test(name);
    const next = sections[si + 1];
    const nextChorus = !!next && isChorusName(next.name);
    const len = section.bars.length;

    section.bars.forEach((_, pos) => {
      const t = len > 1 ? pos / (len - 1) : 1; // 0 -> 1 through the section
      let level = 0.9;
      if (intro) level = 0.82 + 0.14 * t;
      else if (outro) level = 1 - 0.35 * t;
      else if (chorus) level = lift ? 1.06 : 1;
      else if (pre) level = 0.94 + 0.08 * t;
      else if (verse) level = 0.9;
      out.push({ level, swell: nextChorus && pos === len - 1 });
    });
  });
  if (out.length) out[out.length - 1] = { level: 1, swell: false };
  return out;
}

/** The loudness scale at one beat of one bar. */
export function dynamicsAt(
  dynamics: BarDynamics[] | undefined,
  bar: number,
  beat: number,
  beatsPerBar: number,
): number {
  const d = dynamics?.[bar];
  if (!d) return 1;
  return d.swell ? d.level * (0.95 + 0.13 * (beat / beatsPerBar)) : d.level;
}

interface Options {
  sections: SongSection[];
  defaultTempo: number;
  beatsPerBar: number;
  /** The tune that goes with `sections` (same bars, same key). */
  melody: Melody | null;
  /** Extra instruments chosen when the song was generated (pre-enables toggles). */
  extraInstruments?: ExtraInstrumentKey[];
  /** The song's genre ("Rock", "Country"...): shapes the guitar / flute / violin parts. */
  genre?: string;
  /**
   * A band plan saved on the song (e.g. from the AI arranger), written for the
   * song's original key. Used where it is valid; the rules in
   * lib/arrangement.ts fill in anything missing, so it is always safe to omit.
   */
  storedArrangement?: Arrangement | null;
  /** The view-only transpose in semitones, so a stored plan moves with the chords. */
  transposeSteps?: number;
  /**
   * False while the melody is still being composed. The band (guitar, flute,
   * violin) is planned around the vocal, so it stays silent until the final
   * tune is in, rather than jumping when the real melody replaces the
   * placeholder. Defaults to true.
   */
  melodyReady?: boolean;
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
  genre = "pop",
  storedArrangement = null,
  transposeSteps = 0,
  melodyReady = true,
}: Options) {
  const flat = useMemo(() => flattenBars(sections), [sections]);
  // How the piano comps in this genre (reggae off-beat chops, boom-chick, ...).
  const compStyle = useMemo(() => pianoCompFor(genre), [genre]);
  // Rhythm guitar, flute counter-melody and violin harmony (see lib/arrangement.ts).
  // The rules always run; a stored plan, where it is valid, takes over from them.
  const rulesArrangement = useMemo(
    () => arrangeSong(sections, melody, beatsPerBar, genre),
    [sections, melody, beatsPerBar, genre],
  );
  const { arrangement, source: arrangementSource } = useMemo(
    () =>
      resolveArrangement(
        storedArrangement,
        rulesArrangement,
        flat.length,
        transposeSteps,
      ),
    [storedArrangement, rulesArrangement, flat.length, transposeSteps],
  );
  // Piano / bass / strings loudness shape (intro grows, chorus opens, outro fades).
  const dynamics = useMemo(() => sectionDynamics(sections), [sections]);
  // The band waits for the final melody (its parts are written around the vocal).
  const bandLocked = !melodyReady;

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
  const [pianoStyle, setPianoStyle] = useState<PianoStyle>("comp");
  const [singOn, setSingOn] = useState(false);
  const [speakOn, setSpeakOn] = useState(false);
  const [voiceURI, setVoiceURI] = useState<string>("");
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);

  const bpm = bpmOverride ?? defaultTempo;

  const audioRef = useRef<AudioContext | null>(null);
  const sessionRef = useRef<Session | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Everything the running scheduler reads. Refreshed after every render so a
  // toggle, a tempo change or a new plan is heard on the very next beat.
  const snapshot = {
    flat,
    bpm,
    chordsOn,
    clickOn,
    drumsOn,
    bassOn,
    stringsOn,
    // the band is silent while the melody is still being composed
    violinOn: violinOn && !bandLocked,
    guitarOn: guitarOn && !bandLocked,
    fluteLeadOn: fluteLeadOn && !bandLocked,
    shakerOn,
    tambourineOn,
    percussionOn,
    loop,
    beatsPerBar,
    pedalOn,
    pianoStyle,
    compStyle,
    singOn,
    speakOn,
    voiceURI,
    melody,
    arrangement,
    dynamics,
  };
  const live = useRef(snapshot);
  useEffect(() => {
    live.current = snapshot;
  });

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
      let curVoice: ReturnType<typeof voiceChord> = null; // voicing of the chord that is sounding
      const queue: Queued[] = [];
      setPlaying(true);

      // pressing play mid-song: keep a violin note that is already held
      if (startBar > 0 && live.current.violinOn) {
        const L0 = live.current;
        const comp0 = L0.beatsPerBar === 6;
        const beatSec0 = 60 / L0.bpm / (comp0 ? 3 : 1);
        const pulse0 = L0.arrangement.unitsPerBar / L0.beatsPerBar;
        for (const c of violinCarry(L0.arrangement, startBar)) {
          violinNote(
            session,
            c.midi,
            pos.time + 0.02,
            (c.units / pulse0) * beatSec0 * 0.97,
            c.vel,
          );
        }
      }

      /** Schedule every sound that belongs to one beat. */
      const scheduleBeat = (bar: number, beat: number, when: number) => {
        const L = live.current;
        const item = L.flat[bar];
        if (!item) return;
        const compound = L.beatsPerBar === 6; // BPM counts dotted quarters
        const beatSec = 60 / L.bpm / (compound ? 3 : 1);
        // section loudness for piano / bass / strings (band parts carry their own)
        const dyn = dynamicsAt(L.dynamics, bar, beat, L.beatsPerBar);
        const vol = (x: number) => Math.min(1, x * dyn);

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
                bassNote(session, root, when, length * 0.97, vol(0.85));
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
                  vol(i === 0 ? 0.7 : 0.55),
                ),
              );
            }
          }
        }

        /* ---- guitar, flute and violin: planned parts (lib/arrangement.ts) ---- */
        {
          const A = L.arrangement;
          const pulse = A.unitsPerBar / L.beatsPerBar; // sixteenths per beat
          const from = beat * pulse;
          const to = from + pulse;
          const at = (u: number) => when + ((u - from) / pulse) * beatSec;

          if (L.guitarOn) {
            for (const ev of A.guitar[bar] ?? []) {
              if (ev.u < from || ev.u >= to) continue;
              const t0 = at(ev.u + ev.shift);
              const len = (ev.d / pulse) * beatSec * 0.95;
              // down-stroke: every string low to high; up-stroke: top strings only
              const notes =
                ev.dir === "down"
                  ? ev.notes
                  : [...ev.notes].reverse().slice(0, 4);
              const spread = Math.min(
                0.09,
                Math.min(0.035, beatSec * (ev.dir === "down" ? 0.07 : 0.05)) *
                  ev.spread,
              );
              notes.forEach((m, i) =>
                guitarStrumNote(
                  session,
                  m,
                  t0 + i * spread,
                  len,
                  ev.vel * (1 - i * 0.03),
                ),
              );
            }
          }

          if (L.fluteLeadOn) {
            for (const ev of A.flute[bar] ?? []) {
              if (ev.u < from || ev.u >= to) continue;
              melodyNote(
                session,
                "flute",
                ev.midi,
                at(ev.u),
                (ev.d / pulse) * beatSec * 0.95,
                ev.vel,
              );
            }
          }

          if (L.violinOn) {
            for (const ev of A.violin[bar] ?? []) {
              if (ev.u < from || ev.u >= to) continue;
              violinNote(
                session,
                ev.midi,
                at(ev.u),
                (ev.d / pulse) * beatSec * 0.97,
                ev.vel,
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
                curVoice = v;
              }
            } else if (!curVoice && seg.chord) {
              // pressed play in the middle of a chord: voice it now
              const v = voiceChord(seg.chord, voicing);
              if (v) {
                voicing = v.hand;
                curVoice = v;
              }
            }

            if (L.pianoStyle === "comp" && curVoice) {
              // the genre's own rhythm: reggae off-beat chops, boom-chick, ...
              const v = curVoice;
              const st = L.compStyle;
              const pedal = L.pedalOn && st.pedal;
              for (const h of compHitsAt(st, L.beatsPerBar, beat)) {
                const t = when + (h.pos - beat) * beatSec;
                const toEnd = Math.max(0.05, (nextStart - h.pos) * beatSec);
                // a hit that runs to the end of its chord rings until the chord changes
                const hold =
                  h.len >= nextStart - h.pos - 1e-6
                    ? toEnd + (pedal ? 0.12 : -0.04)
                    : Math.min(toEnd, Math.max(0.06, h.len * beatSec));
                if (h.kind === "bass") {
                  pianoNote(session, v.bass[0], t, {
                    hold,
                    velocity: vol(h.vel),
                    pedal,
                  });
                  if (h.full)
                    pianoNote(session, v.bass[1], t + 0.004, {
                      hold,
                      velocity: vol(h.vel * 0.58),
                      pedal,
                    });
                } else {
                  v.hand.forEach((m, i) =>
                    pianoNote(session, m, t + 0.002 + i * st.roll, {
                      hold,
                      velocity: vol(
                        h.vel + (i === v.hand.length - 1 ? 0.06 : 0),
                      ),
                      pedal,
                    }),
                  );
                }
              }
            }

            if (
              startsHere &&
              seg.chord &&
              L.pianoStyle !== "comp" &&
              curVoice
            ) {
              {
                const v = curVoice;
                const hold = remaining + lift;
                // left hand: bass + octave
                pianoNote(session, v.bass[0], when, {
                  hold,
                  velocity: vol(0.72),
                  pedal: L.pedalOn,
                });
                pianoNote(session, v.bass[1], when + 0.004, {
                  hold,
                  velocity: vol(0.42),
                  pedal: L.pedalOn,
                });
                if (L.pianoStyle === "chords") {
                  // right hand rolled a touch, like a hand actually playing
                  v.hand.forEach((m, i) =>
                    pianoNote(session, m, when + 0.006 + i * 0.016, {
                      hold,
                      velocity: vol(0.5 + (i === v.hand.length - 1 ? 0.08 : 0)),
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
                  velocity: vol(s === 0 ? 0.55 : 0.42),
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
    /** True while the melody is composing: guitar / flute / violin toggles should show as locked. */
    bandLocked,
    /** Where the band comes from: a stored plan, or the built-in rules. */
    arrangementSource,
  };
}
