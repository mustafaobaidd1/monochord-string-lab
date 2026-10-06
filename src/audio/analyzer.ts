/**
 * Main-thread analysis of the simulated output. Samples arrive in frames of the synth clock
 * (from the AudioWorklet, or from the main-thread engine when sound is off). After every
 * excitation the analyser waits for enough signal, then measures the fundamental and the
 * partials with a Blackman-Harris window and quadratic peak interpolation.
 */
import {
  estimateFundamental,
  levelNear,
  measurePartials,
  spectrumOf,
  type Peak,
  type Spectrum,
} from '../dsp/analysis.ts';
import { makeWindow, realPowerSpectrum } from '../dsp/fft.ts';

export interface AnalysisContext {
  /** Predicted partial frequencies (continuous theory), Hz. */
  predicted: number[];
  /** Predicted relative amplitudes of the partials in the output (same length). */
  predictedAmplitude: number[];
  /** Ideal-string fundamental, Hz. */
  f0: number;
  /** Anything the page wants back with the snapshot. */
  tag: number;
}

export interface PartialReading {
  n: number;
  predicted: number;
  measured: number | null;
  /** Level relative to the strongest partial, dB. */
  level: number | null;
  /** Predicted level relative to the strongest predicted partial, dB (-Infinity if zero). */
  predictedLevel: number;
  /** Measured at least 30 dB below the mean of its neighbours. */
  suppressed: boolean;
  /** Predicted at least 60 dB below the strongest neighbour. */
  predictedSuppressed: boolean;
}

export interface Snapshot {
  tag: number;
  fundamental: Peak | null;
  partials: PartialReading[];
  windowSeconds: number;
}

const RING = 1 << 17;
export const LIVE_FFT = 16384;
export const ROW_FFT = 4096;

export class Analyzer {
  readonly sampleRate: number;
  private readonly ring = new Float32Array(RING);
  /** Frame index of the next sample to be written. */
  private writeFrame = -1;
  private pending: { frame: number; context: AnalysisContext } | null = null;
  private context: AnalysisContext | null = null;
  private lastRowFrame = 0;
  private readonly rowHop: number;
  private readonly rowWindow = makeWindow('hann', ROW_FFT);
  private readonly liveWindow = makeWindow('hann', LIVE_FFT);
  private quietFrames = 0;
  /** True when new samples arrived since the last live spectrum. */
  dirty = false;
  /** Frame index of the last non-silent sample block. */
  lastSoundFrame = -Infinity;

  onSnapshot: ((snapshot: Snapshot) => void) | null = null;
  onRow: ((row: Float64Array, binHz: number) => void) | null = null;

  constructor(sampleRate: number) {
    this.sampleRate = sampleRate;
    this.rowHop = Math.round(sampleRate * 0.02);
  }

  /** The page announces what it just excited; the next onset is matched with it. */
  expect(context: AnalysisContext): void {
    this.context = context;
  }

  /** A voice started free vibration at `frame`. */
  onset(frame: number): void {
    if (!this.context) return;
    this.pending = { frame, context: this.context };
  }

  get frame(): number {
    return this.writeFrame;
  }

  push(frame: number, data: Float32Array): void {
    if (this.writeFrame < 0 || frame < this.writeFrame - RING) this.writeFrame = frame;
    // Fill gaps (the worklet stops sending while silent) with zeros.
    if (frame > this.writeFrame) {
      const gap = Math.min(frame - this.writeFrame, RING);
      for (let i = 0; i < gap; i++) this.ring[(this.writeFrame + i) & (RING - 1)] = 0;
      this.writeFrame = frame;
    }
    let energy = 0;
    for (let i = 0; i < data.length; i++) {
      const f = frame + i;
      if (f < this.writeFrame) continue;
      this.ring[f & (RING - 1)] = data[i];
      energy += data[i] * data[i];
    }
    this.writeFrame = Math.max(this.writeFrame, frame + data.length);
    const rms = Math.sqrt(energy / Math.max(1, data.length));
    if (rms > 1e-5) {
      this.lastSoundFrame = this.writeFrame;
      this.quietFrames = 0;
    } else {
      this.quietFrames += data.length;
    }
    this.dirty = true;
    this.emitRows();
    this.tryAnalyse();
  }

  /** True when the signal has been silent for more than a second. */
  get silent(): boolean {
    return this.quietFrames > this.sampleRate;
  }

  /** Copies `n` samples ending at `endFrame` (exclusive) into a new array. */
  private read(endFrame: number, n: number): Float32Array {
    const out = new Float32Array(n);
    const start = endFrame - n;
    for (let i = 0; i < n; i++) {
      const f = start + i;
      out[i] = f >= 0 && f > this.writeFrame - RING ? this.ring[f & (RING - 1)] : 0;
    }
    return out;
  }

  private emitRows(): void {
    if (!this.onRow) return;
    if (this.lastRowFrame < this.writeFrame - this.sampleRate) {
      this.lastRowFrame = this.writeFrame - this.rowHop;
    }
    while (this.lastRowFrame + this.rowHop <= this.writeFrame) {
      this.lastRowFrame += this.rowHop;
      if (this.silent) continue;
      const x = this.read(this.lastRowFrame, ROW_FFT);
      const { w, coherentGain } = this.rowWindow;
      const y = new Float64Array(ROW_FFT);
      for (let i = 0; i < ROW_FFT; i++) y[i] = x[i] * w[i];
      const power = realPowerSpectrum(y, ROW_FFT);
      const norm = 2 / (ROW_FFT * coherentGain);
      const db = new Float64Array(power.length);
      for (let k = 0; k < power.length; k++) {
        const m = Math.sqrt(power[k]) * norm;
        db[k] = m > 0 ? 20 * Math.log10(m) : -200;
      }
      this.onRow(db, this.sampleRate / ROW_FFT);
    }
  }

  /** Spectrum of the most recent `LIVE_FFT` samples (Hann window, zero-padded x2). */
  liveSpectrum(): Spectrum {
    this.dirty = false;
    const x = this.read(this.writeFrame, LIVE_FFT);
    const { w, coherentGain } = this.liveWindow;
    const y = new Float64Array(LIVE_FFT);
    for (let i = 0; i < LIVE_FFT; i++) y[i] = x[i] * w[i];
    const fftSize = LIVE_FFT * 2;
    const power = realPowerSpectrum(y, fftSize);
    const norm = 2 / (LIVE_FFT * coherentGain);
    const db = new Float64Array(power.length);
    for (let k = 0; k < power.length; k++) {
      const m = Math.sqrt(power[k]) * norm;
      db[k] = m > 0 ? 20 * Math.log10(m) : -200;
    }
    return { db, binHz: this.sampleRate / fftSize, sampleRate: this.sampleRate, fftSize };
  }

  private tryAnalyse(): void {
    const p = this.pending;
    if (!p) return;
    const seconds = Math.min(1.2, Math.max(0.35, 40 / p.context.f0));
    const n = Math.round(seconds * this.sampleRate);
    if (this.writeFrame < p.frame + n) return;
    this.pending = null;
    const segment = this.read(p.frame + n, n);
    const snapshot = analyseSegment(segment, this.sampleRate, p.context);
    this.onSnapshot?.({ ...snapshot, windowSeconds: seconds });
  }
}

/** Measures one excitation's segment against its predicted partials. */
export function analyseSegment(
  segment: ArrayLike<number>,
  sampleRate: number,
  context: AnalysisContext,
): Omit<Snapshot, 'windowSeconds'> {
  const s = spectrumOf(segment, sampleRate, { window: 'blackman-harris', zeroPad: 4 });
  const fundamental = estimateFundamental(s);
  const measured = measurePartials(s, context.predicted);
  const levels = measured.map((m) => m.level ?? -Infinity);
  const maxLevel = Math.max(...levels.filter(Number.isFinite), -Infinity);
  const maxPred = Math.max(...context.predictedAmplitude, 0);
  const readings: PartialReading[] = measured.map((m, i) => {
    // The level is read at the predicted frequency (+-1/4 partial spacing) so a suppressed partial
    // reports the true floor there rather than the skirt of a neighbouring peak.
    const spacing = i > 0 ? m.predicted - context.predicted[i - 1] : m.predicted;
    const near = levelNear(s, m.measured ?? m.predicted, Math.max(s.binHz * 2, spacing * 0.08));
    const level = Number.isFinite(maxLevel)
      ? Math.max(near, m.level ?? -Infinity) - maxLevel
      : null;
    const a = context.predictedAmplitude[i] ?? 0;
    return {
      n: m.n,
      predicted: m.predicted,
      measured: m.measured,
      level: level != null && Number.isFinite(level) ? level : null,
      predictedLevel: a > 0 && maxPred > 0 ? 20 * Math.log10(a / maxPred) : -Infinity,
      suppressed: false,
      predictedSuppressed: false,
    };
  });
  for (let i = 0; i < readings.length; i++) {
    const r = readings[i];
    const neighbours = [readings[i - 1], readings[i + 1]].filter(Boolean) as PartialReading[];
    const nLevels = neighbours.map((x) => x.level).filter((x): x is number => x != null);
    if (r.level != null && nLevels.length) {
      const mean = nLevels.reduce((a, b) => a + b, 0) / nLevels.length;
      r.suppressed = r.level < mean - 30;
    } else {
      r.suppressed = r.level == null;
    }
    const pa = context.predictedAmplitude[i] ?? 0;
    const pn = Math.max(
      ...[context.predictedAmplitude[i - 1] ?? 0, context.predictedAmplitude[i + 1] ?? 0],
    );
    r.predictedSuppressed = pn > 0 && pa < pn * 1e-3;
  }
  return { tag: context.tag, fundamental, partials: readings };
}
