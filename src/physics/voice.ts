/**
 * A voice is one physical string plus its excitation and output tap. The same class runs in the
 * AudioWorklet, in the main-thread fallback engine, in the slow-motion picture engine and in the
 * tests, so every view of the string comes from identical arithmetic.
 */
import { designGrid, type Grid } from './grid.ts';
import { deriveString, type StringParams, type StringPhysics } from './materials.ts';
import { StiffString } from './scheme.ts';
import { Hammer, staticDeflection, type HammerSpec, type PluckSpec } from './excitation.ts';
import { Bow, type BowSpec } from './bow.ts';
import type { OutputKind } from './theory.ts';

export interface OutputSettings {
  kind: OutputKind;
  /** Pickup position as a fraction of the length from the nut. */
  pickup: number;
}

export type VoiceMode = 'idle' | 'hold' | 'free';

/** Extra sigma_0 (1/s) applied when a voice is muted by the next note: -60 dB in about 0.17 s. */
export const MUTE_SIGMA = 40;
/** Reference pluck amplitude per metre of string, used to normalise loudness between strings. */
export const REFERENCE_AMPLITUDE_PER_METRE = 0.0046;

/** Output-level normalisation so different strings and output taps sound comparably loud. */
export function outputGain(physics: StringPhysics, params: StringParams, kind: OutputKind) {
  const reference = REFERENCE_AMPLITUDE_PER_METRE * params.length;
  if (kind === 'bridge') {
    // Bridge force of a reference pluck at L / 5: about T * A / (0.2 L).
    return 0.3 / ((params.tension * reference) / (0.2 * params.length));
  }
  // Peak string velocity of the same pluck: about 3 c A / L.
  return 0.42 / ((3 * physics.c * reference) / params.length);
}

export class Voice {
  readonly sampleRate: number;
  string: StiffString | null = null;
  physics: StringPhysics | null = null;
  grid: Grid | null = null;
  params: StringParams | null = null;
  mode: VoiceMode = 'idle';
  /** True when the voice has been muted to make room for a new note. */
  muted = false;
  hammer: Hammer | null = null;
  bow: Bow | null = null;
  /** The current note was bowed (selects the loudness normalisation). */
  private bowed = false;
  output: OutputSettings = { kind: 'bridge', pickup: 0.8 };
  /** Samples rendered since the excitation started. */
  age = 0;
  /** Running peak of the (normalised) output, for silence detection. */
  level = 0;

  private gain = 1;
  private dcX = 0;
  private dcY = 0;
  private readonly dcR: number;
  private holdFrom = 0;
  private holdTo = 0;
  private holdStep = 0;
  private holdValue = 0;
  private quiet = 0;
  private holdSpec: PluckSpec | null = null;

  constructor(sampleRate: number) {
    this.sampleRate = sampleRate;
    this.dcR = Math.exp((-2 * Math.PI * 4) / sampleRate);
  }

  /** Builds a fresh string for `params` (throws GridError for parameters with no stable grid). */
  private build(params: StringParams): StiffString {
    const physics = deriveString(params);
    const grid = designGrid({
      length: params.length,
      c: physics.c,
      kappa: physics.kappa,
      sigma1: params.sigma1,
      sampleRate: this.sampleRate,
    });
    this.params = { ...params };
    this.physics = physics;
    this.grid = grid;
    this.string = new StiffString(params, physics, grid);
    this.updateGain();
    return this.string;
  }

  private updateGain(): void {
    if (!this.physics || !this.params) return;
    if (this.bowed) {
      // Helmholtz motion makes a bridge-force sawtooth of amplitude about Z0 v_B / beta; normalise
      // to the reference bow (0.1 m/s at beta = 0.1), so faster or nearer-the-bridge bowing is louder.
      const z0 = Math.sqrt(this.params.tension * this.physics.mu);
      this.gain = this.output.kind === 'bridge' ? 0.32 / z0 : 0.6;
    } else {
      this.gain = outputGain(this.physics, this.params, this.output.kind);
    }
  }

  setOutput(output: OutputSettings): void {
    this.output = { ...output };
    this.updateGain();
  }

  private begin(): void {
    this.age = 0;
    this.level = 0;
    this.quiet = 0;
    this.muted = false;
    this.hammer = null;
    this.bow = null;
    this.bowed = false;
  }

  /** Releases a plucked string from rest in the static shape of `spec`. */
  pluck(params: StringParams, spec: PluckSpec, output: OutputSettings): void {
    this.output = { ...output };
    const s = this.build(params);
    this.begin();
    s.setAtRest(staticDeflection(s.N, s.h, s.tension, s.EI, spec));
    this.mode = 'free';
    this.primeDcBlocker();
  }

  /** Holds the string in the static shape of `spec` (a finger pulling it aside). */
  hold(params: StringParams, spec: PluckSpec, output: OutputSettings): void {
    const sameString =
      this.mode === 'hold' && this.string && this.params && sameParams(this.params, params);
    if (!sameString) {
      this.output = { ...output };
      this.build(params);
      this.begin();
      this.mode = 'hold';
      this.holdValue = 0;
      this.dcX = 0;
      this.dcY = 0;
    }
    const s = this.string!;
    this.holdSpec = { ...spec };
    s.setAtRest(staticDeflection(s.N, s.h, s.tension, s.EI, spec));
    this.holdFrom = this.holdValue;
    this.holdTo = this.rawOutputAtRest();
    this.holdStep = 0;
  }

  /** Lets go of a held string. */
  release(): void {
    if (this.mode !== 'hold' || !this.string || !this.holdSpec) return;
    const s = this.string;
    s.setAtRest(staticDeflection(s.N, s.h, s.tension, s.EI, this.holdSpec));
    this.mode = 'free';
    this.age = 0;
  }

  strike(params: StringParams, spec: HammerSpec, output: OutputSettings): void {
    this.output = { ...output };
    const s = this.build(params);
    this.begin();
    s.clear();
    this.hammer = new Hammer(s, spec);
    this.mode = 'free';
    this.dcX = 0;
    this.dcY = 0;
  }

  /** Starts bowing a string at rest; the bow stays on until `releaseBow`. */
  bowStart(params: StringParams, spec: BowSpec, output: OutputSettings): void {
    this.output = { ...output };
    const s = this.build(params);
    this.begin();
    s.clear();
    this.bow = new Bow(s, spec);
    this.mode = 'free';
    this.dcX = 0;
    this.dcY = 0;
    this.bowed = true;
    this.updateGain();
  }

  /** Lifts the bow; the string then rings freely. */
  releaseBow(): void {
    this.bow?.release();
  }

  /** Damps the voice quickly (a finger touching the string, or the next note taking over). */
  mute(): void {
    if (this.mode === 'idle' || !this.string || this.muted) return;
    if (this.mode === 'hold') {
      this.mode = 'idle';
      return;
    }
    this.muted = true;
    this.hammer = null;
    this.bow = null;
    this.string.setSigma0(this.string.sigma0 + MUTE_SIGMA);
  }

  stop(): void {
    this.mode = 'idle';
    this.hammer = null;
    this.bow = null;
    this.string?.clear();
  }

  /** Output of the current state when the string is at rest (bridge force; velocity is zero). */
  private rawOutputAtRest(): number {
    if (!this.string) return 0;
    return this.output.kind === 'bridge' ? this.string.bridgeForce() * this.gain : 0;
  }

  private primeDcBlocker(): void {
    this.dcX = this.rawOutputAtRest();
    this.dcY = 0;
  }

  /** Advances one sample and returns the output (before the DC blocker). */
  private tick(): number {
    const s = this.string!;
    if (this.mode === 'hold') {
      // Ramp the held output over 10 ms so that dragging never clicks.
      const steps = Math.max(1, Math.round(this.sampleRate * 0.01));
      if (this.holdStep < steps) this.holdStep++;
      this.holdValue = this.holdFrom + ((this.holdTo - this.holdFrom) * this.holdStep) / steps;
      return this.holdValue;
    }
    s.computeFree();
    if (this.hammer) {
      this.hammer.interact(s);
      if (this.hammer.retired) this.hammer = null;
    }
    if (this.bow) {
      this.bow.interact(s);
      if (this.bow.finished) this.bow = null;
    }
    s.commit();
    this.age++;
    const raw = this.output.kind === 'bridge' ? s.bridgeForce() : s.velocityAt(this.output.pickup);
    return raw * this.gain;
  }

  /** Adds `count` samples of output into `out` starting at `offset`. */
  render(out: Float32Array, offset: number, count: number): void {
    if (this.mode === 'idle' || !this.string) return;
    const r = this.dcR;
    let level = this.level;
    const decay = Math.exp(-1 / (0.05 * this.sampleRate));
    for (let i = 0; i < count; i++) {
      const x = this.tick();
      const y = x - this.dcX + r * this.dcY;
      this.dcX = x;
      this.dcY = y;
      out[offset + i] += y;
      const a = Math.abs(y);
      level = a > level ? a : level * decay;
    }
    this.level = level;
    if (!Number.isFinite(level)) {
      // Never let a numerical fault reach the speakers.
      this.stop();
      return;
    }
    if (this.mode === 'free' && !this.hammer && !this.bow) {
      // A muted voice is gone once it is 70 dB down; a ringing one when it falls below -110 dB.
      const threshold = this.muted ? 3e-4 : 3e-6;
      if (level < threshold) this.quiet += count;
      else this.quiet = 0;
      if (this.quiet > this.sampleRate * (this.muted ? 0.02 : 0.2)) this.stop();
    }
  }

  /** Advances the string without producing output (used by the picture engine). */
  advance(count: number): void {
    if (this.mode !== 'free' || !this.string) return;
    for (let i = 0; i < count; i++) this.tick();
  }
}

export function sameParams(a: StringParams, b: StringParams): boolean {
  return (
    a.length === b.length &&
    a.tension === b.tension &&
    a.material === b.material &&
    a.diameter === b.diameter &&
    a.sigma0 === b.sigma0 &&
    a.sigma1 === b.sigma1 &&
    (a.inharmonicity ?? null) === (b.inharmonicity ?? null) &&
    a.coreRatio === b.coreRatio &&
    a.density === b.density &&
    a.youngsModulus === b.youngsModulus
  );
}
