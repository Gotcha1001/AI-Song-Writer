// lib/audioEngine.ts
// Everything that makes sound, built from Web Audio (no sample files, no cost).
//
//   piano          two slightly-detuned "strings" per note with a piano-shaped
//                  harmonic spectrum, hammer thump, filter sweep, sustain pedal
//   bass           plucked bass guitar (triangle + sine + saw, filter pluck)
//   strings        string section pad (detuned saws + slow attack + vibrato)
//   violin         solo bowed violin with expressive vibrato and bow noise
//   electricGuitar clean / lightly driven electric guitar with soft-clip
//   guitarStrumNote plucked-string (Karplus-Strong) acoustic guitar with body EQ + extra reverb
//   flute / warm   melody leads (also used as optional extra instruments)
//   voice          vowel-singing synth (formants + vibrato)
//   drums          kick / snare / hat, and a metronome click
//   shaker         soft filtered noise shaker
//   tambourine     bright noise + metallic ring
//   handPerc       light conga / bongo style hits
//
// All times are on the AudioContext clock, so the player can schedule ahead
// and stay in time even when the browser is busy.
import { midiToHz } from "@/lib/music";

/* ------------------------------- shared bits ------------------------------- */

const noiseCache = new WeakMap<AudioContext, AudioBuffer>();
function noiseBuffer(ctx: AudioContext): AudioBuffer {
  let buf = noiseCache.get(ctx);
  if (!buf) {
    buf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 0.5), ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    noiseCache.set(ctx, buf);
  }
  return buf;
}

/** A soft, dark room: decaying stereo noise. */
const reverbCache = new WeakMap<AudioContext, AudioBuffer>();
function reverbImpulse(ctx: AudioContext): AudioBuffer {
  let buf = reverbCache.get(ctx);
  if (!buf) {
    const seconds = 2.4;
    const len = Math.floor(ctx.sampleRate * seconds);
    buf = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      let lp = 0;
      for (let i = 0; i < len; i++) {
        const t = i / len;
        // one-pole low-pass that closes over time = darker tail
        const k = 0.55 - 0.45 * t;
        lp += k * (Math.random() * 2 - 1 - lp);
        d[i] = lp * Math.pow(1 - t, 2.6) * (i < 400 ? i / 400 : 1);
      }
    }
    reverbCache.set(ctx, buf);
  }
  return buf;
}

const waveCache = new WeakMap<AudioContext, Map<number, PeriodicWave>>();
/** Harmonic spectrum of a piano string: rich in low notes, purer up high. */
function pianoWave(ctx: AudioContext, midi: number): PeriodicWave {
  let m = waveCache.get(ctx);
  if (!m) waveCache.set(ctx, (m = new Map()));
  const bucket = Math.round(midi / 6);
  let w = m.get(bucket);
  if (!w) {
    const partials = Math.max(6, Math.round(30 - (bucket * 6 - 28) * 0.32));
    const real = new Float32Array(partials + 1);
    const imag = new Float32Array(partials + 1);
    for (let n = 1; n <= partials; n++) {
      // roll-off plus a little ripple (the hammer strikes ~1/8 along the string)
      const ripple = 1 - 0.55 * Math.abs(Math.sin((Math.PI * n) / 8));
      imag[n] = (1 / Math.pow(n, 1.2)) * (0.45 + ripple);
    }
    w = ctx.createPeriodicWave(real, imag);
    m.set(bucket, w);
  }
  return w;
}

/* --------------------------------- session --------------------------------- */

/** One playback run. Fading it out cuts everything it started, tails included. */
export interface Session {
  ctx: AudioContext;
  /** Connect instruments here. */
  input: GainNode;
  /** Extra reverb: feed this (as well as `input`) for a wetter sound. */
  wet: GainNode;
  /** Fade out and disconnect. */
  stop(fadeSeconds?: number): void;
}

export function createSession(ctx: AudioContext): Session {
  const input = ctx.createGain();

  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -20;
  comp.knee.value = 24;
  comp.ratio.value = 3.5;
  comp.attack.value = 0.006;
  comp.release.value = 0.25;

  const out = ctx.createGain();
  out.gain.value = 0.9;

  const dry = ctx.createGain();
  dry.gain.value = 1;
  const send = ctx.createGain();
  send.gain.value = 0.3;
  const verb = ctx.createConvolver();
  verb.buffer = reverbImpulse(ctx);

  const wet = ctx.createGain();
  wet.gain.value = 1;

  input.connect(dry).connect(comp);
  input.connect(send).connect(verb).connect(comp);
  wet.connect(verb);
  comp.connect(out).connect(ctx.destination);

  return {
    ctx,
    input,
    wet,
    stop(fade = 0.12) {
      const t = ctx.currentTime;
      out.gain.cancelScheduledValues(t);
      out.gain.setValueAtTime(out.gain.value, t);
      out.gain.linearRampToValueAtTime(0, t + fade);
      setTimeout(
        () => {
          try {
            out.disconnect();
          } catch {
            /* already gone */
          }
        },
        (fade + 0.1) * 1000,
      );
    },
  };
}

/* ---------------------------------- piano ---------------------------------- */

export interface PianoOptions {
  /** Seconds the key is held (with the pedal down this is when the pedal lifts). */
  hold: number;
  /** 0 to 1 */
  velocity: number;
  /** Pedal down: the note rings on and releases softly. */
  pedal: boolean;
}

export function pianoNote(
  s: Session,
  midi: number,
  when: number,
  { hold, velocity, pedal }: PianoOptions,
): void {
  const ctx = s.ctx;
  const f = midiToHz(midi);
  const vel = Math.min(1, Math.max(0.05, velocity));
  const peak = 0.11 * Math.pow(vel, 1.3);

  // timbre
  const filter = ctx.createBiquadFilter();
  filter.type = "lowpass";
  filter.Q.value = 0.4;
  const bright = Math.min(14000, f * (3 + vel * 9));
  filter.frequency.setValueAtTime(bright, when);
  filter.frequency.setTargetAtTime(Math.max(f * 2.2, 900), when + 0.01, 0.35);

  // amplitude: quick "prompt" decay, then the long "after-sound"
  const env = ctx.createGain();
  env.gain.setValueAtTime(0, when);
  env.gain.linearRampToValueAtTime(peak, when + 0.004);
  env.gain.setTargetAtTime(peak * 0.42, when + 0.004, 0.09);
  const slowTau = Math.min(5, Math.max(0.9, 5.2 - (midi - 36) * 0.07));
  const release = Math.max(0.05, hold);
  if (release > 0.4) env.gain.setTargetAtTime(0, when + 0.4, slowTau);
  const relTau = pedal ? 0.38 : 0.13;
  env.gain.setTargetAtTime(0, when + release, relTau);
  const end = when + release + relTau * 7;

  // stereo: low notes left of centre, high notes right
  const pan = ctx.createStereoPanner();
  pan.pan.value = Math.max(-0.6, Math.min(0.6, (midi - 62) / 36));

  filter.connect(env).connect(pan).connect(s.input);

  const wave = pianoWave(ctx, midi);
  // Two strings, a few cents apart, give the gentle shimmer of a real piano.
  for (const cents of [-3.5, 3.5]) {
    const osc = ctx.createOscillator();
    osc.setPeriodicWave(wave);
    osc.frequency.value = f;
    osc.detune.value = cents;
    osc.connect(filter);
    osc.start(when);
    osc.stop(end);
  }

  // hammer thump
  const n = ctx.createBufferSource();
  n.buffer = noiseBuffer(ctx);
  const bp = ctx.createBiquadFilter();
  bp.type = "bandpass";
  bp.frequency.value = Math.min(5000, f * 2.5);
  bp.Q.value = 0.8;
  const ng = ctx.createGain();
  ng.gain.setValueAtTime(peak * 0.7, when);
  ng.gain.exponentialRampToValueAtTime(0.0001, when + 0.035);
  n.connect(bp).connect(ng).connect(pan);
  n.start(when);
  n.stop(when + 0.05);
}

/* ---------------------------------- bass ----------------------------------- */

/** A plucked bass guitar: triangle + sine body, a little saw for bite, filter "pluck". */
export function bassNote(
  s: Session,
  midi: number,
  when: number,
  seconds: number,
  velocity = 0.85,
): void {
  const ctx = s.ctx;
  const f = midiToHz(midi);
  const dur = Math.max(0.15, seconds);
  const peak = 0.14 * Math.min(1, Math.max(0.05, velocity));

  const filter = ctx.createBiquadFilter();
  filter.type = "lowpass";
  filter.Q.value = 0.7;
  filter.frequency.setValueAtTime(Math.min(3000, f * 9), when);
  filter.frequency.setTargetAtTime(f * 2.6, when + 0.01, 0.12);

  const env = ctx.createGain();
  env.gain.setValueAtTime(0, when);
  env.gain.linearRampToValueAtTime(peak, when + 0.008);
  env.gain.setTargetAtTime(peak * 0.62, when + 0.008, 0.55);
  const relTau = 0.07;
  env.gain.setTargetAtTime(0, when + dur, relTau);
  const end = when + dur + relTau * 7;

  const parts: Array<[OscillatorType, number]> = [
    ["triangle", 1],
    ["sine", 0.8], // try 0.4
    ["sawtooth", 0.22],
  ];
  for (const [type, level] of parts) {
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.value = f;
    const g = ctx.createGain();
    g.gain.value = level;
    osc.connect(g).connect(filter);
    osc.start(when);
    osc.stop(end);
  }
  filter.connect(env).connect(s.input);
}

/* --------------------------------- strings --------------------------------- */

/**
 * One note of a string section: three detuned saws, a soft low-pass, a slow
 * attack, gentle late vibrato and a long release. Play several for a chord.
 */
export function stringsNote(
  s: Session,
  midi: number,
  when: number,
  seconds: number,
  velocity = 0.65,
): void {
  const ctx = s.ctx;
  const f = midiToHz(midi);
  const dur = Math.max(0.3, seconds);
  const peak = 0.05 * Math.min(1, Math.max(0.05, velocity));

  const filter = ctx.createBiquadFilter();
  filter.type = "lowpass";
  filter.Q.value = 0.3;
  filter.frequency.value = Math.min(5200, f * 5);

  const atk = Math.min(0.35, dur * 0.4);
  const relTau = 0.18;
  const env = ctx.createGain();
  env.gain.setValueAtTime(0, when);
  env.gain.linearRampToValueAtTime(peak, when + atk);
  env.gain.setTargetAtTime(0, when + dur, relTau);
  const end = when + dur + relTau * 7;

  // vibrato that arrives after the note has opened up
  const lfo = ctx.createOscillator();
  lfo.frequency.value = 5;
  const lfoGain = ctx.createGain();
  lfoGain.gain.setValueAtTime(0, when);
  lfoGain.gain.linearRampToValueAtTime(7, when + Math.min(0.9, dur * 0.6)); // cents
  lfo.connect(lfoGain);
  lfo.start(when);
  lfo.stop(end);

  for (const cents of [-9, 0, 9]) {
    const osc = ctx.createOscillator();
    osc.type = "sawtooth";
    osc.frequency.value = f;
    osc.detune.value = cents;
    lfoGain.connect(osc.detune);
    osc.connect(filter);
    osc.start(when);
    osc.stop(end);
  }
  filter.connect(env).connect(s.input);
}

/* ---------------------------------- voice ---------------------------------- */

// Formant centres (Hz) for five vowels.
const VOWELS = {
  ah: [800, 1150, 2900],
  eh: [530, 1840, 2480],
  ee: [290, 2250, 3010],
  oh: [570, 840, 2410],
  oo: [310, 870, 2250],
} as const;
export type Vowel = keyof typeof VOWELS;

/** The vowel a syllable is sung on, from its spelling. */
export function vowelFor(text: string): Vowel {
  const m = /[aeiouy]/i.exec(text);
  switch (m?.[0].toLowerCase()) {
    case "e":
      return "eh";
    case "i":
    case "y":
      return "ee";
    case "o":
      return "oh";
    case "u":
      return "oo";
    default:
      return "ah";
  }
}

export function voiceNote(
  s: Session,
  midi: number,
  when: number,
  seconds: number,
  vowel: Vowel,
  velocity = 0.8,
): void {
  const ctx = s.ctx;
  const f = midiToHz(midi);
  const dur = Math.max(0.12, seconds);
  const [f1, f2, f3] = VOWELS[vowel];

  const src = ctx.createOscillator();
  src.type = "sawtooth";
  src.frequency.value = f;

  // vibrato that fades in on longer notes
  const lfo = ctx.createOscillator();
  lfo.frequency.value = 5.4;
  const lfoGain = ctx.createGain();
  lfoGain.gain.setValueAtTime(0, when);
  lfoGain.gain.linearRampToValueAtTime(f * 0.005, when + Math.min(0.4, dur));
  lfo.connect(lfoGain).connect(src.frequency);

  // small breathy noise
  const noise = ctx.createBufferSource();
  noise.buffer = noiseBuffer(ctx);
  noise.loop = true;
  const noiseGain = ctx.createGain();
  noiseGain.gain.value = 0.05;

  const mix = ctx.createGain();
  [
    [f1, 1.0, 5],
    [f2, 0.55, 6],
    [f3, 0.18, 7],
  ].forEach(([freq, gain, q]) => {
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = freq;
    bp.Q.value = q;
    const g = ctx.createGain();
    g.gain.value = gain;
    src.connect(bp);
    noiseGain.connect(bp);
    bp.connect(g).connect(mix);
  });
  noise.connect(noiseGain);

  const env = ctx.createGain();
  const level = 0.55 * velocity;
  const atk = Math.min(0.05, dur * 0.3);
  const rel = Math.min(0.12, dur * 0.4);
  env.gain.setValueAtTime(0, when);
  env.gain.linearRampToValueAtTime(level, when + atk);
  env.gain.setValueAtTime(level, when + dur - rel);
  env.gain.linearRampToValueAtTime(0, when + dur);

  mix.connect(env).connect(s.input);
  for (const node of [src, lfo, noise]) {
    node.start(when);
    node.stop(when + dur + 0.05);
  }
}

/* ------------------------------ melody timbres ----------------------------- */

/** Instruments the melody can be played on. "voice" is the original formant singer. */
export type MelodySound = "flute" | "warm" | "bell" | "voice";

const leadWaveCache = new WeakMap<AudioContext, Map<string, PeriodicWave>>();
function leadWave(
  ctx: AudioContext,
  key: string,
  amps: number[],
): PeriodicWave {
  let m = leadWaveCache.get(ctx);
  if (!m) leadWaveCache.set(ctx, (m = new Map()));
  let w = m.get(key);
  if (!w) {
    const real = new Float32Array(amps.length + 1);
    const imag = new Float32Array(amps.length + 1);
    amps.forEach((a, i) => (imag[i + 1] = a));
    w = ctx.createPeriodicWave(real, imag);
    m.set(key, w);
  }
  return w;
}

/**
 * Plays one melody note in a gentler timbre than the formant voice.
 *   flute  breathy, round, soft vibrato: very easy on the ears
 *   warm   mellow synth/electric-piano pad: triangle body, slow filter
 *   bell   music-box / glockenspiel: bright pluck that rings and fades
 */
export function melodyNote(
  s: Session,
  sound: Exclude<MelodySound, "voice">,
  midi: number,
  when: number,
  seconds: number,
  velocity = 0.8,
): void {
  const ctx = s.ctx;
  const f = midiToHz(midi);
  const dur = Math.max(0.12, seconds);
  const vel = Math.min(1, Math.max(0.05, velocity));

  if (sound === "bell") {
    const ring = Math.min(1.6, Math.max(0.5, dur * 1.2));
    const peak = 0.1 * vel;
    const env = ctx.createGain();
    env.gain.setValueAtTime(0, when);
    env.gain.linearRampToValueAtTime(peak, when + 0.003);
    env.gain.setTargetAtTime(0, when + 0.003, ring / 4);
    const end = when + ring * 1.6;
    // partials: fundamental, octave, and a soft inharmonic "ting"
    for (const [mult, level, decay] of [
      [1, 1, 1],
      [2, 0.35, 0.6],
      [4.01, 0.12, 0.3],
    ] as const) {
      const osc = ctx.createOscillator();
      osc.type = "sine";
      osc.frequency.value = f * mult;
      const g = ctx.createGain();
      g.gain.setValueAtTime(level, when);
      g.gain.setTargetAtTime(0, when, (ring / 4) * decay);
      osc.connect(g).connect(env);
      osc.start(when);
      osc.stop(end);
    }
    env.connect(s.input);
    return;
  }

  const filter = ctx.createBiquadFilter();
  filter.type = "lowpass";
  filter.Q.value = 0.3;

  const env = ctx.createGain();
  const relTau = 0.09;
  const end = when + dur + relTau * 7;
  const lfoGain = ctx.createGain();

  let peak: number;
  let atk: number;
  if (sound === "flute") {
    peak = 0.09 * vel;
    atk = Math.min(0.05, dur * 0.3);
    filter.frequency.value = Math.min(5000, f * 4);
    // mostly fundamental, a touch of 2nd and 3rd harmonic
    const wave = leadWave(ctx, "flute", [1, 0.22, 0.07, 0.02]);
    for (const cents of [0]) {
      const osc = ctx.createOscillator();
      osc.setPeriodicWave(wave);
      osc.frequency.value = f;
      osc.detune.value = cents;
      lfoGain.connect(osc.detune);
      osc.connect(filter);
      osc.start(when);
      osc.stop(end);
    }
    // a whisper of breath
    const n = ctx.createBufferSource();
    n.buffer = noiseBuffer(ctx);
    n.loop = true;
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = Math.min(6000, f * 2);
    bp.Q.value = 1.2;
    const ng = ctx.createGain();
    ng.gain.setValueAtTime(0.05 * peak, when);
    ng.gain.linearRampToValueAtTime(0.012 * peak, when + 0.12);
    n.connect(bp).connect(ng).connect(env);
    n.start(when);
    n.stop(end);
  } else {
    // warm
    peak = 0.08 * vel;
    atk = Math.min(0.03, dur * 0.25);
    filter.frequency.setValueAtTime(Math.min(4500, f * 6), when);
    filter.frequency.setTargetAtTime(Math.max(f * 2, 700), when + 0.02, 0.3);
    for (const [type, level, cents] of [
      ["triangle", 1, -1],
      ["triangle", 0.8, 1],
      ["sine", 0.5, 1200], // soft octave shimmer
    ] as const) {
      const osc = ctx.createOscillator();
      osc.type = type;
      osc.frequency.value = f;
      osc.detune.value = cents;
      const g = ctx.createGain();
      g.gain.value = level * 0.5;
      lfoGain.connect(osc.detune);
      osc.connect(g).connect(filter);
      osc.start(when);
      osc.stop(end);
    }
  }

  // gentle vibrato that arrives after the note has opened up
  const lfo = ctx.createOscillator();
  lfo.frequency.value = 4.2;
  lfoGain.gain.setValueAtTime(0, when);
  lfoGain.gain.setValueAtTime(0, when + 0.18);
  lfoGain.gain.linearRampToValueAtTime(
    sound === "flute" ? 1.5 : 1,
    when + 0.18 + Math.min(0.5, dur * 0.6),
  ); // cents
  lfo.connect(lfoGain);
  lfo.start(when);
  lfo.stop(end);

  env.gain.setValueAtTime(0, when);
  env.gain.linearRampToValueAtTime(peak, when + atk);
  env.gain.setTargetAtTime(peak * 0.85, when + atk, 0.4);
  env.gain.setTargetAtTime(0, when + dur, relTau);
  filter.connect(env).connect(s.input);
}

/* --------------------------------- violin ---------------------------------- */

/**
 * Solo violin: slow bow attack, rich odd harmonics, expressive vibrato that
 * blooms after the note opens, and a soft high-pass so it sits above the pad.
 */
export function violinNote(
  s: Session,
  midi: number,
  when: number,
  seconds: number,
  velocity = 0.75,
): void {
  const ctx = s.ctx;
  const f = midiToHz(midi);
  const dur = Math.max(0.25, seconds);
  const vel = Math.min(1, Math.max(0.05, velocity));
  const peak = 0.14 * Math.pow(vel, 1.1);

  const filter = ctx.createBiquadFilter();
  filter.type = "lowpass";
  filter.Q.value = 0.7;
  filter.frequency.setValueAtTime(Math.min(6500, f * 6), when);
  filter.frequency.setTargetAtTime(Math.max(f * 3.5, 1200), when + 0.08, 0.25);

  const hp = ctx.createBiquadFilter();
  hp.type = "highpass";
  hp.frequency.value = Math.min(280, f * 0.6);
  hp.Q.value = 0.4;

  const atk = Math.min(0.28, dur * 0.45);
  const relTau = 0.22;
  const env = ctx.createGain();
  env.gain.setValueAtTime(0, when);
  env.gain.linearRampToValueAtTime(peak, when + atk);
  env.gain.setTargetAtTime(peak * 0.92, when + atk, 0.5);
  env.gain.setTargetAtTime(0, when + dur, relTau);
  const end = when + dur + relTau * 8;

  // expressive vibrato (arrives after bow pressure stabilises)
  const lfo = ctx.createOscillator();
  lfo.frequency.value = 5.4;
  const lfoGain = ctx.createGain();
  lfoGain.gain.setValueAtTime(0, when);
  lfoGain.gain.linearRampToValueAtTime(0, when + Math.min(0.35, atk + 0.05));
  lfoGain.gain.linearRampToValueAtTime(
    9 + vel * 4,
    when + Math.min(0.9, dur * 0.55),
  ); // cents
  lfo.connect(lfoGain);
  lfo.start(when);
  lfo.stop(end);

  // three slightly detuned oscillators for a realistic string body
  for (const [cents, level] of [
    [-6, 0.55],
    [0, 1],
    [7, 0.5],
  ] as const) {
    const osc = ctx.createOscillator();
    osc.type = "sawtooth";
    osc.frequency.value = f;
    osc.detune.value = cents;
    lfoGain.connect(osc.detune);
    const g = ctx.createGain();
    g.gain.value = level;
    osc.connect(g).connect(filter);
    osc.start(when);
    osc.stop(end);
  }

  // subtle bow noise
  const n = ctx.createBufferSource();
  n.buffer = noiseBuffer(ctx);
  n.loop = true;
  const bp = ctx.createBiquadFilter();
  bp.type = "bandpass";
  bp.frequency.value = Math.min(4200, f * 3);
  bp.Q.value = 1.4;
  const ng = ctx.createGain();
  ng.gain.setValueAtTime(0, when);
  ng.gain.linearRampToValueAtTime(0.012 * peak, when + atk * 0.6);
  ng.gain.setTargetAtTime(0.006 * peak, when + atk, 0.4);
  ng.gain.setTargetAtTime(0, when + dur, 0.12);
  n.connect(bp).connect(ng).connect(env);
  n.start(when);
  n.stop(end);

  filter.connect(hp).connect(env).connect(s.input);
}

/* ---------------------------- electric guitar ------------------------------ */

/**
 * Clean / lightly driven electric guitar: dual oscillators with mild
 * distortion (soft-clip via waveshaping curve), fast attack, palm-mute style
 * decay option via short duration.
 */
export function electricGuitarNote(
  s: Session,
  midi: number,
  when: number,
  seconds: number,
  velocity = 0.8,
): void {
  const ctx = s.ctx;
  const f = midiToHz(midi);
  const dur = Math.max(0.12, seconds);
  const vel = Math.min(1, Math.max(0.05, velocity));
  const peak = 0.16 * Math.pow(vel, 1.15);

  // soft-clip waveshaper for gentle drive
  const shaper = ctx.createWaveShaper();
  const curve = new Float32Array(256);
  for (let i = 0; i < 256; i++) {
    const x = i / 128 - 1;
    curve[i] = Math.tanh(x * 1.8) * 0.95;
  }
  shaper.curve = curve;
  shaper.oversample = "2x";

  const filter = ctx.createBiquadFilter();
  filter.type = "lowpass";
  filter.Q.value = 0.9;
  const bright = Math.min(9000, f * (4 + vel * 5));
  filter.frequency.setValueAtTime(bright, when);
  filter.frequency.setTargetAtTime(Math.max(f * 2.2, 800), when + 0.04, 0.18);

  const env = ctx.createGain();
  const atk = 0.008;
  const relTau = 0.11;
  env.gain.setValueAtTime(0, when);
  env.gain.linearRampToValueAtTime(peak, when + atk);
  env.gain.setTargetAtTime(peak * 0.55, when + atk, 0.08);
  env.gain.setTargetAtTime(0, when + dur, relTau);
  const end = when + dur + relTau * 6;

  const pan = ctx.createStereoPanner();
  pan.pan.value = Math.max(-0.45, Math.min(0.45, (midi - 55) / 30));

  for (const [type, cents, level] of [
    ["sawtooth", -4, 0.7],
    ["square", 5, 0.45],
    ["triangle", 0, 0.35],
  ] as const) {
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.value = f;
    osc.detune.value = cents;
    const g = ctx.createGain();
    g.gain.value = level;
    osc.connect(g).connect(shaper);
    osc.start(when);
    osc.stop(end);
  }

  shaper.connect(filter).connect(env).connect(pan).connect(s.input);
}

/* ------------------------------ percussion --------------------------------- */

/** Soft egg / shaker: filtered noise with a short envelope, good on 8ths. */
/* ------------------------------ acoustic guitar ------------------------------ */

/**
 * A plucked steel string, rendered once per pitch with the Karplus-Strong
 * method (a burst of noise circulating in a loop that loses a little high
 * end each lap, which is exactly how a real string rings and mellows).
 * The result is cached, so each note is only calculated the first time.
 */
const pluckCache = new WeakMap<AudioContext, Map<number, AudioBuffer>>();
function pluckBuffer(ctx: AudioContext, midi: number): AudioBuffer {
  let cache = pluckCache.get(ctx);
  if (!cache) pluckCache.set(ctx, (cache = new Map()));
  const hit = cache.get(midi);
  if (hit) return hit;

  const sr = ctx.sampleRate;
  const f = midiToHz(midi);
  const seconds = f < 150 ? 3.4 : 2.8;
  const len = Math.floor(sr * seconds);
  const out = new Float32Array(len);

  // brightness of the loop filter: 0.5 is a plain average (dull), higher is brighter
  const S = 0.64;
  const L = sr / f - (1 - S); // loop length, compensating the filter's own delay
  const K = Math.ceil(L) + 1;

  // the pick: noise, smoothed a little, plucked ~1/7 of the way along the string
  const e = new Float32Array(K);
  let lp = 0;
  for (let i = 0; i < K; i++) {
    lp += 0.75 * (Math.random() * 2 - 1 - lp);
    e[i] = lp;
  }
  const comb = Math.max(1, Math.round(K * 0.14));
  for (let i = K - 1; i >= comb; i--) e[i] -= e[i - comb];
  let rms = 0;
  for (let i = 0; i < K; i++) rms += e[i] * e[i];
  rms = Math.sqrt(rms / K) || 1;
  for (let i = 0; i < K; i++) out[i] = (e[i] / rms) * 0.5;

  // how long the string rings (T60), shorter for high strings
  const t60 = f < 200 ? 3.8 : f < 450 ? 3.2 : 2.2;
  const decay = Math.pow(0.001, 1 / (f * t60));
  for (let n = K; n < len; n++) {
    const pos = n - L;
    const i0 = Math.floor(pos);
    const fr = pos - i0;
    const a = out[i0] * (1 - fr) + out[i0 + 1] * fr;
    const b = out[i0 - 1] * (1 - fr) + out[i0] * fr;
    out[n] = decay * (S * a + (1 - S) * b);
  }

  // a tiny pick click, then normalise
  const click = Math.floor(sr * 0.012);
  for (let i = 0; i < click; i++) {
    out[i] += (Math.random() * 2 - 1) * Math.exp(-i / (sr * 0.003)) * 0.22;
  }
  let peak = 0;
  for (let i = 0; i < len; i++) peak = Math.max(peak, Math.abs(out[i]));
  const buf = ctx.createBuffer(1, len, sr);
  const d = buf.getChannelData(0);
  const g = peak ? 0.9 / peak : 1;
  for (let i = 0; i < len; i++) d[i] = out[i] * g;
  cache.set(midi, buf);
  return buf;
}

/**
 * The guitar's own little mixing desk: the wooden "body" (a warm bump low
 * down and some sparkle up high) and its own extra reverb. Built once per run.
 */
const guitarBusCache = new WeakMap<Session, GainNode>();
function guitarBus(s: Session): GainNode {
  const hit = guitarBusCache.get(s);
  if (hit) return hit;
  const ctx = s.ctx;
  const bus = ctx.createGain();

  const warmth = ctx.createBiquadFilter();
  warmth.type = "peaking";
  warmth.frequency.value = 110;
  warmth.Q.value = 1;
  warmth.gain.value = 4;

  const box = ctx.createBiquadFilter(); // cuts the muddy low-mids
  box.type = "peaking";
  box.frequency.value = 330;
  box.Q.value = 1.2;
  box.gain.value = -3;

  const sparkle = ctx.createBiquadFilter();
  sparkle.type = "peaking";
  sparkle.frequency.value = 3200;
  sparkle.Q.value = 0.8;
  sparkle.gain.value = 3.5;

  const air = ctx.createBiquadFilter();
  air.type = "lowpass";
  air.frequency.value = 9500;

  const reverb = ctx.createGain();
  reverb.gain.value = GUITAR_REVERB;

  bus.connect(warmth).connect(box).connect(sparkle).connect(air);
  air.connect(s.input);
  air.connect(reverb).connect(s.wet);
  guitarBusCache.set(s, bus);
  return bus;
}

/** How loud one string is, and how much extra reverb the guitar gets. */
const GUITAR_LEVEL = 0.05;
const GUITAR_REVERB = 0.9;

/**
 * One string of a strummed acoustic guitar. Play 4-5 of these a few
 * milliseconds apart for a whole chord. The string rings until `seconds`
 * are up, then is damped quickly, like a hand muting it at the next strum.
 */
export function guitarStrumNote(
  s: Session,
  midi: number,
  when: number,
  seconds: number,
  velocity = 0.7,
): void {
  const ctx = s.ctx;
  const dur = Math.max(0.08, seconds);
  const vel = Math.min(1, Math.max(0.05, velocity));

  const src = ctx.createBufferSource();
  src.buffer = pluckBuffer(ctx, midi);

  const env = ctx.createGain();
  const peak = GUITAR_LEVEL * Math.pow(vel, 1.1);
  env.gain.setValueAtTime(peak, when);
  env.gain.setValueAtTime(peak, when + dur);
  env.gain.setTargetAtTime(0, when + dur, 0.05);

  const pan = ctx.createStereoPanner();
  pan.pan.value = Math.max(-0.3, Math.min(0.3, (midi - 60) / 45));

  src.connect(env).connect(pan).connect(guitarBus(s));
  src.start(when);
  src.stop(when + dur + 0.5);
}

export function shakerNote(s: Session, when: number, velocity = 0.55): void {
  const ctx = s.ctx;
  const vel = Math.min(1, Math.max(0.05, velocity));
  const peak = 0.07 * vel;

  const n = ctx.createBufferSource();
  n.buffer = noiseBuffer(ctx);
  const bp = ctx.createBiquadFilter();
  bp.type = "bandpass";
  bp.frequency.value = 6500 + Math.random() * 1500;
  bp.Q.value = 0.6;

  const hp = ctx.createBiquadFilter();
  hp.type = "highpass";
  hp.frequency.value = 2800;

  const env = ctx.createGain();
  env.gain.setValueAtTime(0, when);
  env.gain.linearRampToValueAtTime(peak, when + 0.004);
  env.gain.exponentialRampToValueAtTime(
    0.0001,
    when + 0.09 + Math.random() * 0.04,
  );

  const pan = ctx.createStereoPanner();
  pan.pan.value = (Math.random() - 0.5) * 0.7;

  n.connect(bp).connect(hp).connect(env).connect(pan).connect(s.input);
  n.start(when);
  n.stop(when + 0.2);
}

/** Bright tambourine: short noise burst + a metallic ring (high sine). */
export function tambourineNote(s: Session, when: number, velocity = 0.6): void {
  const ctx = s.ctx;
  const vel = Math.min(1, Math.max(0.05, velocity));
  const peak = 0.085 * vel;

  // jingle body (noise)
  const n = ctx.createBufferSource();
  n.buffer = noiseBuffer(ctx);
  const bp = ctx.createBiquadFilter();
  bp.type = "bandpass";
  bp.frequency.value = 4800 + Math.random() * 800;
  bp.Q.value = 1.1;
  const ng = ctx.createGain();
  ng.gain.setValueAtTime(peak, when);
  ng.gain.exponentialRampToValueAtTime(0.0001, when + 0.12);

  // metallic ring
  const osc = ctx.createOscillator();
  osc.type = "sine";
  osc.frequency.value = 4200 + Math.random() * 600;
  const og = ctx.createGain();
  og.gain.setValueAtTime(peak * 0.35, when);
  og.gain.exponentialRampToValueAtTime(0.0001, when + 0.18);

  const pan = ctx.createStereoPanner();
  pan.pan.value = 0.25 + (Math.random() - 0.5) * 0.3;

  n.connect(bp).connect(ng).connect(pan).connect(s.input);
  osc.connect(og).connect(pan);
  n.start(when);
  n.stop(when + 0.2);
  osc.start(when);
  osc.stop(when + 0.25);
}

/**
 * Light hand percussion (conga / bongo style): tuned noise + body tone.
 * `pitch` is a relative height (0 = low conga, 1 = high bongo).
 */
export function handPercNote(
  s: Session,
  when: number,
  pitch = 0.4,
  velocity = 0.65,
): void {
  const ctx = s.ctx;
  const vel = Math.min(1, Math.max(0.05, velocity));
  const peak = 0.1 * vel;
  const bodyF = 120 + pitch * 180;

  // body tone
  const osc = ctx.createOscillator();
  osc.type = "sine";
  osc.frequency.setValueAtTime(bodyF * 1.4, when);
  osc.frequency.exponentialRampToValueAtTime(bodyF, when + 0.03);
  const og = ctx.createGain();
  og.gain.setValueAtTime(peak * 0.7, when);
  og.gain.exponentialRampToValueAtTime(0.0001, when + 0.22);

  // skin / slap noise
  const n = ctx.createBufferSource();
  n.buffer = noiseBuffer(ctx);
  const bp = ctx.createBiquadFilter();
  bp.type = "bandpass";
  bp.frequency.value = 800 + pitch * 1200;
  bp.Q.value = 0.8;
  const ng = ctx.createGain();
  ng.gain.setValueAtTime(peak * 0.55, when);
  ng.gain.exponentialRampToValueAtTime(0.0001, when + 0.08);

  const pan = ctx.createStereoPanner();
  pan.pan.value = -0.15 + pitch * 0.4;

  osc.connect(og).connect(pan).connect(s.input);
  n.connect(bp).connect(ng).connect(pan);
  osc.start(when);
  osc.stop(when + 0.3);
  n.start(when);
  n.stop(when + 0.15);
}

/* ---------------------------------- drums ---------------------------------- */

export function click(s: Session, when: number, accent: boolean): void {
  const ctx = s.ctx;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = "square";
  osc.frequency.value = accent ? 1500 : 1000;
  gain.gain.setValueAtTime(0.04, when);
  gain.gain.exponentialRampToValueAtTime(0.0001, when + 0.05);
  osc.connect(gain).connect(s.input);
  osc.start(when);
  osc.stop(when + 0.06);
}

export function kick(s: Session, when: number, vol = 0.45): void {
  const ctx = s.ctx;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = "sine";
  osc.frequency.setValueAtTime(150, when);
  osc.frequency.exponentialRampToValueAtTime(42, when + 0.12);
  gain.gain.setValueAtTime(vol, when);
  gain.gain.exponentialRampToValueAtTime(0.0001, when + 0.25);
  osc.connect(gain).connect(s.input);
  osc.start(when);
  osc.stop(when + 0.28);
}

export function snare(s: Session, when: number, vol = 0.22): void {
  const ctx = s.ctx;
  const noise = ctx.createBufferSource();
  noise.buffer = noiseBuffer(ctx);
  const hp = ctx.createBiquadFilter();
  hp.type = "highpass";
  hp.frequency.value = 1500;
  const nGain = ctx.createGain();
  nGain.gain.setValueAtTime(vol, when);
  nGain.gain.exponentialRampToValueAtTime(0.0001, when + 0.16);
  noise.connect(hp).connect(nGain).connect(s.input);
  noise.start(when);
  noise.stop(when + 0.18);

  const osc = ctx.createOscillator();
  const oGain = ctx.createGain();
  osc.type = "triangle";
  osc.frequency.setValueAtTime(190, when);
  osc.frequency.exponentialRampToValueAtTime(120, when + 0.08);
  oGain.gain.setValueAtTime(vol * 0.6, when);
  oGain.gain.exponentialRampToValueAtTime(0.0001, when + 0.1);
  osc.connect(oGain).connect(s.input);
  osc.start(when);
  osc.stop(when + 0.12);
}

export function hat(s: Session, when: number, vol = 0.06): void {
  const ctx = s.ctx;
  const noise = ctx.createBufferSource();
  noise.buffer = noiseBuffer(ctx);
  const hp = ctx.createBiquadFilter();
  hp.type = "highpass";
  hp.frequency.value = 7000;
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(vol, when);
  gain.gain.exponentialRampToValueAtTime(0.0001, when + 0.05);
  noise.connect(hp).connect(gain).connect(s.input);
  noise.start(when);
  noise.stop(when + 0.06);
}

/**
 * One pulse of a basic groove, with hi-hats on every 8th note.
 *   4/4: kick on 1 and 3, snare on 2 and 4
 *   3/4: kick on 1, light snare on 2 and 3 (waltz feel)
 *   6/8: a pulse is an 8th note; kick on 1, snare on 4, hat on every pulse
 */
export function drums(
  s: Session,
  when: number,
  beat: number,
  beatsPerBar: number,
  beatSeconds: number,
): void {
  if (beatsPerBar === 6) {
    if (beat === 0) kick(s, when);
    else if (beat === 3) snare(s, when);
    hat(s, when, beat % 3 === 0 ? 0.08 : 0.05);
    return;
  }
  if (beatsPerBar === 3) {
    if (beat === 0) kick(s, when);
    else snare(s, when, 0.14);
  } else if (beat % 2 === 0) kick(s, when);
  else snare(s, when);
  hat(s, when, beat === 0 ? 0.08 : 0.06);
  hat(s, when + beatSeconds / 2, 0.04);
}
