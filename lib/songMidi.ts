// lib/songMidi.ts
// Writes the sung melody (and, optionally, the chords) as a Standard MIDI File.
// No dependencies: a .mid file is just a few small binary chunks.
//
// The file has three tracks:
//   1. Conductor : title, tempo, time signature, key signature
//   2. Melody    : the sung notes, with each syllable attached as a MIDI lyric
//                  (karaoke players and most notation apps will show them)
//   3. Chords    : a voice-led piano part (optional)
import { degreeToMidi, type Melody } from "@/lib/melody";
import { voiceChord } from "@/lib/music";

const PPQ = 480; // ticks per quarter note
const TICKS_PER_SIXTEENTH = PPQ / 4; // melody time is measured in sixteenths

export interface SongMidiOptions {
  title: string;
  /** Same BPM the player shows. In 6/8 it counts dotted quarters. */
  bpm: number;
  melody: Melody;
  /** Add a piano chord track under the melody. Default true. */
  includeChords?: boolean;
}

/* --------------------------------- bytes --------------------------------- */

const u16 = (n: number) => [(n >> 8) & 0xff, n & 0xff];
const u32 = (n: number) => [
  (n >>> 24) & 0xff,
  (n >>> 16) & 0xff,
  (n >>> 8) & 0xff,
  n & 0xff,
];

/** MIDI variable-length quantity. */
function vlq(value: number): number[] {
  let v = Math.max(0, Math.floor(value));
  const out = [v & 0x7f];
  while ((v >>= 7) > 0) out.unshift((v & 0x7f) | 0x80);
  return out;
}

const textBytes = (s: string) => Array.from(new TextEncoder().encode(s));

/* --------------------------------- events -------------------------------- */

interface Ev {
  tick: number;
  /** Tie-breaker at the same tick: meta, then note-off, lyric, note-on. */
  order: number;
  bytes: number[];
}

const meta = (tick: number, type: number, data: number[], order = 0): Ev => ({
  tick,
  order,
  bytes: [0xff, type, ...vlq(data.length), ...data],
});

const noteOn = (tick: number, ch: number, note: number, vel: number): Ev => ({
  tick,
  order: 3,
  bytes: [0x90 | ch, note & 0x7f, vel & 0x7f],
});

const noteOff = (tick: number, ch: number, note: number): Ev => ({
  tick,
  order: 1,
  bytes: [0x80 | ch, note & 0x7f, 0],
});

const programChange = (ch: number, program: number): Ev => ({
  tick: 0,
  order: 0,
  bytes: [0xc0 | ch, program & 0x7f],
});

/** Sorts events, turns absolute ticks into delta times and wraps them in an MTrk chunk. */
function track(events: Ev[], endTick: number): number[] {
  const sorted = [...events].sort(
    (a, b) => a.tick - b.tick || a.order - b.order,
  );
  const body: number[] = [];
  let last = 0;
  for (const e of sorted) {
    body.push(...vlq(e.tick - last), ...e.bytes);
    last = e.tick;
  }
  body.push(...vlq(Math.max(0, endTick - last)), 0xff, 0x2f, 0x00); // end of track
  return [...textBytes("MTrk"), ...u32(body.length), ...body];
}

/* ------------------------------- song pieces ------------------------------- */

/** Key signatures only go from 7 flats to 7 sharps: fold G# major into Ab, etc. */
function keySignatureFifths(fifths: number): number {
  if (fifths > 7) return fifths - 12;
  if (fifths < -7) return fifths + 12;
  return fifths;
}

function timeSignature(beatsPerBar: number): number[] {
  if (beatsPerBar === 6) return [6, 3, 36, 8]; // 6/8, a click every dotted quarter
  return [beatsPerBar, 2, 24, 8]; // n/4
}

/** MIDI tempo is microseconds per quarter note. In 6/8, BPM counts dotted quarters. */
function microsPerQuarter(bpm: number, beatsPerBar: number): number {
  const quartersPerMinute = beatsPerBar === 6 ? bpm * 1.5 : bpm;
  return Math.round(60_000_000 / Math.max(20, quartersPerMinute));
}

/**
 * Builds the .mid file.
 * The melody you pass in is already in the song's current (possibly transposed) key.
 */
export function buildSongMidi(o: SongMidiOptions): Uint8Array {
  const { melody } = o;
  const includeChords = o.includeChords !== false;
  const barTicks = melody.unitsPerBar * TICKS_PER_SIXTEENTH;
  const endTick = melody.bars.length * barTicks;

  /* ---- track 1: conductor ---- */
  const conductor: Ev[] = [
    meta(0, 0x03, textBytes(o.title || "Song")), // track name = song title
    meta(0, 0x51, [
      (microsPerQuarter(o.bpm, melody.beatsPerBar) >> 16) & 0xff,
      (microsPerQuarter(o.bpm, melody.beatsPerBar) >> 8) & 0xff,
      microsPerQuarter(o.bpm, melody.beatsPerBar) & 0xff,
    ]),
    meta(0, 0x58, timeSignature(melody.beatsPerBar)),
    meta(0, 0x59, [
      keySignatureFifths(melody.key.fifths) & 0xff,
      melody.key.minor ? 1 : 0,
    ]),
  ];

  /* ---- track 2: melody (channel 0) ---- */
  const lead: Ev[] = [
    meta(0, 0x03, textBytes("Melody")),
    programChange(0, 54), // Synth Voice
  ];
  melody.bars.forEach((bar, bi) => {
    const barStart = bi * barTicks;
    for (const n of bar.notes) {
      if (n.deg === null) continue;
      const start = barStart + n.u * TICKS_PER_SIXTEENTH;
      // A hair shorter than written so repeated notes are heard separately.
      const len = Math.max(1, n.d * TICKS_PER_SIXTEENTH - 6);
      const midi = degreeToMidi(melody.key, n.deg);
      if (n.text) {
        // A syllable that continues into the next note gets no trailing space.
        lead.push(
          meta(start, 0x05, textBytes(n.joinNext ? n.text : `${n.text} `), 2),
        );
      }
      lead.push(noteOn(start, 0, midi, 92), noteOff(start + len, 0, midi));
    }
  });

  const tracks = [track(conductor, endTick), track(lead, endTick)];

  /* ---- track 3: chords (channel 1) ---- */
  if (includeChords) {
    const comp: Ev[] = [
      meta(0, 0x03, textBytes("Chords")),
      programChange(1, 0), // Acoustic Grand Piano
    ];
    let prev: number[] | null = null;
    melody.bars.forEach((bar, bi) => {
      const barStart = bi * barTicks;
      const chords = [...bar.chords].sort((a, b) => a.u - b.u);
      chords.forEach((c, ci) => {
        const from = barStart + c.u * TICKS_PER_SIXTEENTH;
        const to =
          barStart +
          (ci + 1 < chords.length ? chords[ci + 1].u : melody.unitsPerBar) *
            TICKS_PER_SIXTEENTH;
        const v = voiceChord(c.chord, prev);
        if (!v) return;
        prev = v.hand;
        const len = Math.max(1, to - from - 6);
        for (const note of [v.bass[0], ...v.hand]) {
          const vel = note === v.bass[0] ? 78 : 64;
          comp.push(noteOn(from, 1, note, vel), noteOff(from + len, 1, note));
        }
      });
    });
    tracks.push(track(comp, endTick));
  }

  const header = [
    ...textBytes("MThd"),
    ...u32(6),
    ...u16(1), // format 1: several tracks played together
    ...u16(tracks.length),
    ...u16(PPQ),
  ];
  return Uint8Array.from([...header, ...tracks.flat()]);
}
