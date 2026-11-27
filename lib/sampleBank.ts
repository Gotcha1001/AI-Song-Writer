// lib/sampleBank.ts
// Real instrument samples via `smplr` (optional). Install: npm install smplr
//
// Design rules that keep the song always audible:
//   1. Until the bank is fully loaded, every sample*() returns false → synth plays.
//   2. Instruments are created with destination = a persistent bus GainNode.
//      We never disconnect() their internal output (that was silencing notes).
//   3. On each Play we only reconnect our bus → session.input (master chain).
//   4. If smplr is missing or load fails, bank.failed stays true → synth forever.

export type SampleKind =
  | "piano"
  | "bass"
  | "strings"
  | "violin"
  | "flute"
  | "guitar"
  | "warm";

interface SmplrInstrument {
  start: (opts: {
    note: number | string;
    velocity?: number;
    time?: number;
    duration?: number;
  }) => unknown;
  output?: AudioNode;
  loaded?: Promise<unknown>;
  load?: Promise<unknown>;
  ready?: Promise<unknown>;
}

interface Bank {
  ready: boolean;
  failed: boolean;
  loading: Promise<boolean> | null;
  /** Shared bus: all instruments → bus → session.input (or silent while loading). */
  bus: GainNode | null;
  piano: SmplrInstrument | null;
  bass: SmplrInstrument | null;
  strings: SmplrInstrument | null;
  violin: SmplrInstrument | null;
  flute: SmplrInstrument | null;
  guitar: SmplrInstrument | null;
  warm: SmplrInstrument | null;
}

const banks = new WeakMap<AudioContext, Bank>();

function getBank(ctx: AudioContext): Bank {
  let b = banks.get(ctx);
  if (!b) {
    b = {
      ready: false,
      failed: false,
      loading: null,
      bus: null,
      piano: null,
      bass: null,
      strings: null,
      violin: null,
      flute: null,
      guitar: null,
      warm: null,
    };
    banks.set(ctx, b);
  }
  return b;
}

async function waitLoaded(inst: SmplrInstrument): Promise<void> {
  const p = inst.loaded ?? inst.load ?? inst.ready;
  if (p && typeof (p as Promise<unknown>).then === "function") {
    await p;
  }
}

/** Create a Soundfont / piano instrument with destination = bus. */
function makeInstrument(
  Factory: unknown,
  ctx: AudioContext,
  bus: GainNode,
  options: Record<string, unknown>,
): SmplrInstrument {
  const F = Factory as {
    (c: AudioContext, o?: object): SmplrInstrument;
    new (c: AudioContext, o?: object): SmplrInstrument;
  };
  // smplr supports both Soundfont(ctx, opts) and new Soundfont(ctx, opts)
  try {
    return new F(ctx, { ...options, destination: bus });
  } catch {
    return F(ctx, { ...options, destination: bus });
  }
}

/**
 * Load samples and route them toward `dest` (session.input).
 * Safe to call every Play — reconnects the bus only.
 * Returns true when samples can be used.
 */
export function ensureSamples(
  ctx: AudioContext,
  dest: AudioNode,
): Promise<boolean> {
  const bank = getBank(ctx);

  // Always keep the bus feeding the current session input.
  if (!bank.bus) {
    bank.bus = ctx.createGain();
    bank.bus.gain.value = 1;
  }
  try {
    bank.bus.disconnect();
  } catch {
    /* first connect */
  }
  try {
    bank.bus.connect(dest);
  } catch {
    /* ignore */
  }

  if (bank.ready) return Promise.resolve(true);
  if (bank.failed) return Promise.resolve(false);
  if (bank.loading) return bank.loading;

  const bus = bank.bus;

  bank.loading = (async () => {
    try {
      const smplr = await import("smplr");

      // Lighter kit = faster first load. Switch to "MusyngKite" for higher quality.
      const kit = "FluidR3_GM";

      const mkSf = async (instrument: string) => {
        const inst = makeInstrument(smplr.Soundfont, ctx, bus, {
          instrument,
          kit,
        });
        await waitLoaded(inst);
        return inst;
      };

      // Piano: prefer multi-velocity grand, fall back to GM.
      try {
        if (typeof smplr.SplendidGrandPiano === "function") {
          const piano = makeInstrument(smplr.SplendidGrandPiano, ctx, bus, {});
          await waitLoaded(piano);
          bank.piano = piano;
        }
      } catch (e) {
        console.warn(
          "[sampleBank] SplendidGrandPiano failed, using GM piano",
          e,
        );
      }
      if (!bank.piano) {
        bank.piano = await mkSf("acoustic_grand_piano");
      }

      const [bass, strings, violin, flute, guitar, warm] = await Promise.all([
        mkSf("acoustic_bass"),
        mkSf("string_ensemble_1"),
        mkSf("violin"),
        mkSf("flute"),
        mkSf("acoustic_guitar_nylon"),
        mkSf("clarinet"),
      ]);
      bank.bass = bass;
      bank.strings = strings;
      bank.violin = violin;
      bank.flute = flute;
      bank.guitar = guitar;
      bank.warm = warm;

      // Re-assert bus → dest in case a new session started during load.
      try {
        bus.disconnect();
      } catch {
        /* */
      }
      try {
        bus.connect(dest);
      } catch {
        /* */
      }

      bank.ready = true;
      console.info("[sampleBank] Sample instruments ready");
      return true;
    } catch (e) {
      console.warn(
        "[sampleBank] Samples unavailable — synth fallback. npm install smplr",
        e,
      );
      bank.failed = true;
      return false;
    } finally {
      bank.loading = null;
    }
  })();

  return bank.loading;
}

export function samplesReady(ctx: AudioContext): boolean {
  return getBank(ctx).ready;
}

function vel127(v: number): number {
  return Math.round(Math.min(1, Math.max(0.05, v)) * 127);
}

function play(
  ctx: AudioContext,
  inst: SmplrInstrument | null,
  midi: number,
  when: number,
  duration: number,
  velocity: number,
): boolean {
  const bank = getBank(ctx);
  // Hard gate: never claim success until the whole bank is ready.
  if (!bank.ready || !inst) return false;
  try {
    inst.start({
      note: Math.round(midi),
      velocity: vel127(velocity),
      time: when,
      duration: Math.max(0.05, duration),
    });
    return true;
  } catch (e) {
    console.warn(
      "[sampleBank] note start failed — synth will take over next time",
      e,
    );
    return false;
  }
}

export function samplePiano(
  ctx: AudioContext,
  midi: number,
  when: number,
  duration: number,
  velocity: number,
): boolean {
  return play(ctx, getBank(ctx).piano, midi, when, duration, velocity);
}

export function sampleBass(
  ctx: AudioContext,
  midi: number,
  when: number,
  duration: number,
  velocity: number,
): boolean {
  return play(ctx, getBank(ctx).bass, midi, when, duration, velocity);
}

export function sampleStrings(
  ctx: AudioContext,
  midi: number,
  when: number,
  duration: number,
  velocity: number,
): boolean {
  return play(ctx, getBank(ctx).strings, midi, when, duration, velocity * 0.9);
}

export function sampleViolin(
  ctx: AudioContext,
  midi: number,
  when: number,
  duration: number,
  velocity: number,
): boolean {
  return play(ctx, getBank(ctx).violin, midi, when, duration, velocity);
}

export function sampleFlute(
  ctx: AudioContext,
  midi: number,
  when: number,
  duration: number,
  velocity: number,
): boolean {
  return play(ctx, getBank(ctx).flute, midi, when, duration, velocity);
}

export function sampleGuitar(
  ctx: AudioContext,
  midi: number,
  when: number,
  duration: number,
  velocity: number,
): boolean {
  return play(ctx, getBank(ctx).guitar, midi, when, duration, velocity);
}

export function sampleWarm(
  ctx: AudioContext,
  midi: number,
  when: number,
  duration: number,
  velocity: number,
): boolean {
  return play(ctx, getBank(ctx).warm, midi, when, duration, velocity);
}
