/** Messages between the page and the AudioWorklet processor. */
import type { OnsetInfo, SynthCommand } from './synth.ts';

export type ToWorklet = SynthCommand | { type: 'stream'; enabled: boolean };

export type FromWorklet =
  | { type: 'ready'; sampleRate: number }
  | ({ type: 'onset' } & OnsetInfo)
  | { type: 'samples'; frame: number; data: Float32Array }
  | { type: 'error'; message: string };
