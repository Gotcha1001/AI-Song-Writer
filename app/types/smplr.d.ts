// Minimal typings so the project typechecks before/without deep smplr types.
declare module "smplr" {
  export class Soundfont {
    constructor(
      context: AudioContext,
      options?: { instrument?: string; kit?: string; destination?: AudioNode },
    );
    start(opts: {
      note: number | string;
      velocity?: number;
      time?: number;
      duration?: number;
    }): unknown;
    output?: AudioNode;
    loaded?: Promise<unknown>;
    load?: Promise<unknown>;
    ready?: Promise<unknown>;
  }

  export class SplendidGrandPiano {
    constructor(context: AudioContext, options?: { destination?: AudioNode });
    start(opts: {
      note: number | string;
      velocity?: number;
      time?: number;
      duration?: number;
    }): unknown;
    output?: AudioNode;
    loaded?: Promise<unknown>;
    load?: Promise<unknown>;
    ready?: Promise<unknown>;
  }

  export function getSoundfontNames(): string[];
  export function getSoundfontKits(): string[];
}
