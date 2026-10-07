/** Messages between the page and the AudioWorklet processor (which only produces sound). */
import type { SynthCommand } from './synth.ts';

export type ToWorklet = SynthCommand;

export type FromWorklet =
  { type: 'ready'; sampleRate: number } | { type: 'error'; message: string };
