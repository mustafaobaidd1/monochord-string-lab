/**
 * Polyphony-free string synth shared by the AudioWorklet and the main-thread engines: one
 * physical string, with a few overlapping voices so that a new note can start while the previous
 * one is damped (as a finger would), plus a master stage with volume, mute and a soft limiter.
 */
import type { BowSpec } from '../physics/bow.ts';
import type { HammerSpec, PluckSpec } from '../physics/excitation.ts';
import type { StringParams } from '../physics/materials.ts';
import { Voice, type OutputSettings } from '../physics/voice.ts';

export type SynthCommand =
  | { type: 'pluck'; params: StringParams; spec: PluckSpec; output: OutputSettings }
  | { type: 'hold'; id: number; params: StringParams; spec: PluckSpec; output: OutputSettings }
  | { type: 'release'; id: number }
  | { type: 'strike'; params: StringParams; spec: HammerSpec; output: OutputSettings }
  | { type: 'bow'; id: number; params: StringParams; spec: BowSpec; output: OutputSettings }
  | { type: 'bowRelease'; id: number }
  | { type: 'mute' }
  | { type: 'output'; output: OutputSettings }
  | { type: 'master'; volume: number; muted: boolean };

/** Information about a new excitation, reported so the analyser can line up its window. */
export interface OnsetInfo {
  /** Sample index (in the synth's own clock) of the first sample of free vibration. */
  frame: number;
  kind: 'pluck' | 'strike' | 'bow';
  N: number;
}

export const VOICE_COUNT = 3;

export class MasterStage {
  private gain = 1;
  private target = 1;
  private readonly smoothing: number;

  constructor(sampleRate: number) {
    this.smoothing = 1 - Math.exp(-1 / (0.02 * sampleRate));
  }

  set(volume: number, muted: boolean): void {
    this.target = muted ? 0 : Math.min(Math.max(volume, 0), 1);
  }

  /** Applies the smoothed gain and a soft limiter (unity below 0.6, saturating towards 1). */
  process(input: Float32Array, output: Float32Array, count: number): void {
    let g = this.gain;
    const a = this.smoothing;
    const t = this.target;
    for (let i = 0; i < count; i++) {
      g += (t - g) * a;
      output[i] = softLimit(input[i] * g);
    }
    this.gain = g;
  }
}

export function softLimit(x: number): number {
  const a = Math.abs(x);
  if (a <= 0.6) return x;
  const y = 0.6 + 0.4 * Math.tanh((a - 0.6) / 0.4);
  return x < 0 ? -y : y;
}

export class StringSynth {
  readonly sampleRate: number;
  readonly voices: Voice[];
  /** Samples rendered so far. */
  frame = 0;
  private current = -1;
  private holdId = -1;
  private bowId = -1;
  private output: OutputSettings = { kind: 'bridge', pickup: 0.8 };
  readonly master: MasterStage;
  /** Called when a voice starts free vibration (after a pluck release or a strike). */
  onOnset: ((info: OnsetInfo) => void) | null = null;
  /** Called when a command cannot be carried out (for example an unstable parameter set). */
  onError: ((message: string) => void) | null = null;

  constructor(sampleRate: number) {
    this.sampleRate = sampleRate;
    this.voices = Array.from({ length: VOICE_COUNT }, () => new Voice(sampleRate));
    this.master = new MasterStage(sampleRate);
  }

  get active(): boolean {
    return this.voices.some((v) => v.mode !== 'idle');
  }

  /** The voice that is sounding (or being held) now, if any. */
  get lead(): Voice | null {
    return this.current >= 0 ? this.voices[this.current] : null;
  }

  /** Mutes the sounding voice and returns a free voice for a new note. */
  private takeVoice(): Voice {
    for (const v of this.voices) v.mute();
    // Prefer an idle voice; otherwise steal the one that has been muted the longest.
    let index = this.voices.findIndex((v, i) => v.mode === 'idle' && i !== this.current);
    if (index < 0) {
      let oldest = -1;
      let bestAge = -1;
      this.voices.forEach((v, i) => {
        if (i !== this.current && v.age > bestAge) {
          bestAge = v.age;
          oldest = i;
        }
      });
      index = oldest >= 0 ? oldest : (this.current + 1) % this.voices.length;
    }
    this.voices[index].stop();
    this.current = index;
    return this.voices[index];
  }

  handle(cmd: SynthCommand): void {
    try {
      this.dispatch(cmd);
    } catch (err) {
      this.onError?.(err instanceof Error ? err.message : String(err));
    }
  }

  private dispatch(cmd: SynthCommand): void {
    switch (cmd.type) {
      case 'pluck': {
        const v = this.takeVoice();
        v.pluck(cmd.params, cmd.spec, cmd.output);
        this.holdId = -1;
        this.output = cmd.output;
        this.onOnset?.({ frame: this.frame, kind: 'pluck', N: v.grid?.N ?? 0 });
        break;
      }
      case 'hold': {
        const lead = this.lead;
        if (lead && lead.mode === 'hold' && this.holdId === cmd.id) {
          lead.hold(cmd.params, cmd.spec, cmd.output);
        } else {
          const v = this.takeVoice();
          v.hold(cmd.params, cmd.spec, cmd.output);
          this.holdId = cmd.id;
        }
        this.output = cmd.output;
        break;
      }
      case 'release': {
        const lead = this.lead;
        if (lead && lead.mode === 'hold' && this.holdId === cmd.id) {
          lead.release();
          this.holdId = -1;
          this.onOnset?.({ frame: this.frame, kind: 'pluck', N: lead.grid?.N ?? 0 });
        }
        break;
      }
      case 'strike': {
        const v = this.takeVoice();
        v.strike(cmd.params, cmd.spec, cmd.output);
        this.holdId = -1;
        this.output = cmd.output;
        this.onOnset?.({ frame: this.frame, kind: 'strike', N: v.grid?.N ?? 0 });
        break;
      }
      case 'bow': {
        const v = this.takeVoice();
        v.bowStart(cmd.params, cmd.spec, cmd.output);
        this.holdId = -1;
        this.bowId = cmd.id;
        this.output = cmd.output;
        this.onOnset?.({ frame: this.frame, kind: 'bow', N: v.grid?.N ?? 0 });
        break;
      }
      case 'bowRelease': {
        const lead = this.lead;
        if (lead && lead.bow && this.bowId === cmd.id) lead.releaseBow();
        break;
      }
      case 'mute':
        for (const v of this.voices) v.mute();
        this.holdId = -1;
        break;
      case 'output':
        this.output = cmd.output;
        for (const v of this.voices) v.setOutput(cmd.output);
        break;
      case 'master':
        this.master.set(cmd.volume, cmd.muted);
        break;
    }
  }

  get outputSettings(): OutputSettings {
    return this.output;
  }

  /** Renders `count` samples of the dry string signal (before the master stage) into `out`. */
  render(out: Float32Array, count: number): void {
    out.fill(0, 0, count);
    for (const v of this.voices) v.render(out, 0, count);
    this.frame += count;
  }
}
