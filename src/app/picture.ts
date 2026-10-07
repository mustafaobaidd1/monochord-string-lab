/**
 * The picture engine: a second instance of the same voice, driven by the display clock instead
 * of the audio clock. In slow motion it advances 1/s of real time per second; in real time it
 * captures several shapes per frame (what the eye sees as a blur); for reduced motion it tracks
 * the peak displacement envelope instead of the oscillation.
 */
import type { HammerSpec, PluckSpec } from '../physics/excitation.ts';
import type { StringParams } from '../physics/materials.ts';
import { Voice, type OutputSettings } from '../physics/voice.ts';

export type PictureMode = 'slow' | 'realtime' | 'envelope';

const SLOW_FACTORS = [4, 8, 16, 32, 64, 128, 256, 512, 1024];
/** Apparent frequency the slow-motion factor aims for, Hz. */
const TARGET_APPARENT_HZ = 1.2;
const BLUR_SHAPES = 12;
/** Hammer rest position below the string (m) used for the approach animation. */
export const HAMMER_REST = 0.0012;

export function slowFactorFor(f1: number): number {
  let best = SLOW_FACTORS[0];
  for (const s of SLOW_FACTORS) {
    if (Math.abs(f1 / s - TARGET_APPARENT_HZ) < Math.abs(f1 / best - TARGET_APPARENT_HZ)) best = s;
  }
  return best;
}

export class PictureEngine {
  voice: Voice;
  slowFactor = 64;
  /** Shapes to draw this frame (one in slow motion, several for the real-time blur). */
  shapes: Float32Array[] = [];
  shapeCount = 0;
  /** Peak-hold envelope for the reduced-motion view. */
  envelope: Float32Array = new Float32Array(0);
  /** Hammer approach: physical seconds left before the hammer reaches the string. */
  private approach = 0;
  private approachSpeed = 0;
  private pendingStrike: { params: StringParams; spec: HammerSpec; output: OutputSettings } | null =
    null;
  /** Hammer displacement to draw (m), or null when no strike is in progress. */
  hammer: number | null = null;
  private hammerVelocity = 0;
  private acc = 0;
  private resting = true;

  constructor(readonly sampleRate: number) {
    this.voice = new Voice(sampleRate);
  }

  get N(): number {
    return this.voice.grid?.N ?? 0;
  }

  get active(): boolean {
    return this.voice.mode !== 'idle' || this.approach > 0 || this.hammer !== null;
  }

  private ensureBuffers(): void {
    const n = this.N + 1;
    if (this.shapes.length !== BLUR_SHAPES || this.shapes[0]?.length !== n) {
      this.shapes = Array.from({ length: BLUR_SHAPES }, () => new Float32Array(n));
      this.envelope = new Float32Array(n);
    }
  }

  private capture(index: number): void {
    const s = this.voice.string;
    if (!s) return;
    s.copyShape(this.shapes[index]);
  }

  pluck(params: StringParams, spec: PluckSpec, output: OutputSettings): void {
    this.cancelStrike();
    this.voice.pluck(params, spec, output);
    this.afterExcite();
  }

  hold(params: StringParams, spec: PluckSpec, output: OutputSettings): void {
    this.cancelStrike();
    this.voice.hold(params, spec, output);
    this.afterExcite();
  }

  release(): void {
    this.voice.release();
    this.resting = false;
  }

  strike(params: StringParams, spec: HammerSpec, output: OutputSettings): void {
    // The physics starts at contact; before that the hammer flies up from its rest position.
    this.voice.stop();
    this.pendingStrike = { params, spec, output };
    this.approachSpeed = spec.velocity;
    this.approach = HAMMER_REST / spec.velocity;
    this.hammer = -HAMMER_REST;
    this.hammerVelocity = spec.velocity;
    this.shapeCount = 0;
    this.resting = false;
    this.envelope.fill(0);
  }

  private cancelStrike(): void {
    this.pendingStrike = null;
    this.approach = 0;
    this.hammer = null;
  }

  private afterExcite(): void {
    this.ensureBuffers();
    this.envelope.fill(0);
    this.capture(0);
    this.shapeCount = 1;
    this.acc = 0;
    this.resting = false;
  }

  mute(): void {
    this.cancelStrike();
    this.voice.stop();
    this.shapeCount = 0;
    this.envelope.fill(0);
  }

  /** Advances the picture by `dt` seconds of display time. */
  tick(dt: number, mode: PictureMode): void {
    const physical = mode === 'slow' ? dt / this.slowFactor : dt;
    this.stepHammerApproach(physical);
    if (this.voice.mode === 'hold') {
      this.ensureBuffers();
      this.capture(0);
      this.shapeCount = 1;
      return;
    }
    if (this.voice.mode !== 'free') {
      this.trackHammer(physical);
      return;
    }
    this.ensureBuffers();
    this.acc += physical * this.sampleRate;
    const steps = Math.floor(this.acc);
    this.acc -= steps;
    if (mode === 'slow') {
      this.voice.advance(steps);
      this.capture(0);
      this.shapeCount = 1;
    } else {
      const parts = mode === 'realtime' ? BLUR_SHAPES : 24;
      let done = 0;
      for (let i = 0; i < parts; i++) {
        const target = Math.round(((i + 1) * steps) / parts);
        this.voice.advance(target - done);
        done = target;
        if (mode === 'realtime') this.capture(i);
        else this.updateEnvelope(physical / parts);
      }
      this.shapeCount = mode === 'realtime' ? parts : 1;
      if (mode === 'envelope') this.capture(0);
    }
    this.trackHammer(physical);
    if ((this.voice.mode as string) === 'idle') this.shapeCount = 0;
  }

  private updateEnvelope(dt: number): void {
    const s = this.voice.string;
    if (!s) return;
    const r = Math.exp(-dt / 0.25);
    const env = this.envelope;
    for (let l = 0; l < env.length; l++) {
      const a = Math.abs(s.at(l));
      env[l] = a > env[l] * r ? a : env[l] * r;
    }
  }

  private stepHammerApproach(physical: number): void {
    if (this.approach <= 0 || !this.pendingStrike) return;
    this.approach -= physical;
    this.hammer =
      -HAMMER_REST +
      this.approachSpeed * (HAMMER_REST / this.approachSpeed - Math.max(0, this.approach));
    if (this.approach <= 0) {
      const { params, spec, output } = this.pendingStrike;
      this.pendingStrike = null;
      this.voice.strike(params, spec, output);
      this.afterExcite();
      this.hammer = 0;
    }
  }

  private trackHammer(physical: number): void {
    if (this.approach > 0) return;
    const h = this.voice.hammer;
    if (h) {
      const before = this.hammer ?? h.displacement;
      this.hammer = h.displacement;
      if (physical > 0) this.hammerVelocity = (h.displacement - before) / physical;
      return;
    }
    if (this.hammer === null) return;
    // After the physics retires the hammer, let it settle back to rest.
    this.hammer = Math.max(
      -HAMMER_REST,
      this.hammer - Math.max(0.4, Math.abs(this.hammerVelocity)) * physical,
    );
    if (this.hammer <= -HAMMER_REST) this.hammer = null;
  }

  /** True when nothing on screen is moving (lets the main loop skip redraws). */
  get still(): boolean {
    return this.resting || (!this.active && this.shapeCount === 0);
  }
}
