/**
 * Spectral measurement of the simulated output: windowed, zero-padded FFT; quadratic
 * interpolation of peaks on the log-magnitude spectrum (the "QIFFT" method, J. O. Smith,
 * Spectral Audio Signal Processing, 2011); fundamental and partial estimation.
 */
import { makeWindow, realPowerSpectrum, type WindowKind } from './fft.ts';

export interface Spectrum {
  /** Magnitude in dB for bins 0..fftSize/2 (arbitrary reference). */
  db: Float64Array;
  /** Bin spacing in Hz. */
  binHz: number;
  sampleRate: number;
  fftSize: number;
}

export interface Peak {
  frequency: number;
  /** Interpolated peak level, dB (same reference as the spectrum). */
  level: number;
}

const DB_FLOOR = -400;

export function nextPow2(n: number): number {
  return 2 ** Math.ceil(Math.log2(Math.max(2, n)));
}

export function spectrumOf(
  signal: ArrayLike<number>,
  sampleRate: number,
  options: { window?: WindowKind; zeroPad?: number; fftSize?: number } = {},
): Spectrum {
  const n = signal.length;
  const { w, coherentGain } = makeWindow(options.window ?? 'blackman-harris', n);
  const fftSize = options.fftSize ?? nextPow2(n * (options.zeroPad ?? 4));
  const x = new Float64Array(n);
  for (let i = 0; i < n; i++) x[i] = signal[i] * w[i];
  const power = realPowerSpectrum(x, fftSize);
  const db = new Float64Array(power.length);
  // Normalise so a full-scale sinusoid of amplitude 1 reads 0 dB at its peak.
  const norm = 2 / (n * coherentGain);
  for (let k = 0; k < power.length; k++) {
    const mag = Math.sqrt(power[k]) * norm;
    db[k] = mag > 0 ? 20 * Math.log10(mag) : DB_FLOOR;
  }
  return { db, binHz: sampleRate / fftSize, sampleRate, fftSize };
}

/** Quadratic interpolation of a peak at bin m (requires 0 < m < length - 1). */
export function interpolatePeak(s: Spectrum, m: number): Peak {
  const a = s.db[m - 1];
  const b = s.db[m];
  const c = s.db[m + 1];
  const denom = a - 2 * b + c;
  const p = denom !== 0 ? (0.5 * (a - c)) / denom : 0;
  return { frequency: (m + p) * s.binHz, level: b - 0.25 * (a - c) * p };
}

/** Highest peak in [fLow, fHigh], interpolated; null if the range holds no local maximum. */
export function peakInRange(s: Spectrum, fLow: number, fHigh: number): Peak | null {
  const lo = Math.max(1, Math.floor(fLow / s.binHz));
  const hi = Math.min(s.db.length - 2, Math.ceil(fHigh / s.binHz));
  let best = -1;
  let bestDb = -Infinity;
  for (let m = lo; m <= hi; m++) {
    const v = s.db[m];
    if (v > bestDb && v >= s.db[m - 1] && v >= s.db[m + 1]) {
      bestDb = v;
      best = m;
    }
  }
  return best < 0 ? null : interpolatePeak(s, best);
}

/** All local maxima above `threshold` dB within [fLow, fHigh]. */
export function findPeaks(s: Spectrum, threshold: number, fLow = 0, fHigh = Infinity): Peak[] {
  const lo = Math.max(1, Math.floor(fLow / s.binHz));
  const hi = Math.min(s.db.length - 2, Math.floor(fHigh / s.binHz));
  const peaks: Peak[] = [];
  for (let m = lo; m <= hi; m++) {
    const v = s.db[m];
    if (v > threshold && v > s.db[m - 1] && v >= s.db[m + 1]) peaks.push(interpolatePeak(s, m));
  }
  return peaks;
}

/**
 * How far a peak stands above the spectrum around it: its level minus the higher of the two
 * minima found within half an octave on either side.
 */
export function prominence(s: Spectrum, p: Peak): number {
  const k = p.frequency / s.binHz;
  const lo = Math.max(1, Math.floor(k / Math.SQRT2));
  const hi = Math.min(s.db.length - 1, Math.ceil(k * Math.SQRT2));
  const mid = Math.round(k);
  let left = Infinity;
  for (let m = lo; m <= mid; m++) left = Math.min(left, s.db[m]);
  let right = Infinity;
  for (let m = mid; m <= hi; m++) right = Math.min(right, s.db[m]);
  return p.level - Math.max(left, right);
}

/**
 * Independent estimate of the fundamental: the lowest spectral peak within `rangeDb` of the
 * strongest peak (above 15 Hz) that also stands at least `minProminence` dB above its
 * surroundings, so a small low-frequency bump (an attack transient, for instance) cannot be
 * mistaken for it. It does not use any predicted frequency.
 */
export function estimateFundamental(
  s: Spectrum,
  rangeDb = 30,
  minHz = 15,
  minProminence = 20,
): Peak | null {
  let maxDb = -Infinity;
  const lo = Math.max(1, Math.floor(minHz / s.binHz));
  for (let m = lo; m < s.db.length - 1; m++) if (s.db[m] > maxDb) maxDb = s.db[m];
  if (!Number.isFinite(maxDb) || maxDb <= DB_FLOOR) return null;
  const peaks = findPeaks(s, maxDb - rangeDb, minHz);
  const prominent = peaks.filter((p) => prominence(s, p) >= minProminence);
  // A fundamental heads a harmonic series: a strong peak sits near 2f or 3f (within 8 %, which
  // also covers the stretched partials of very stiff strings), and the fundamental is not far
  // weaker than that partial (a pickup next to the bridge costs it about 12 dB at most). Stray
  // low-frequency bumps fail one test or the other.
  const headsSeries = (p: Peak) =>
    prominent.some(
      (q) =>
        q.level - p.level <= 25 &&
        [2, 3].some((h) => Math.abs(q.frequency / (h * p.frequency) - 1) < 0.08),
    );
  return prominent.find(headsSeries) ?? prominent[0] ?? peaks[0] ?? null;
}

export interface MeasuredPartial {
  n: number;
  predicted: number;
  measured: number | null;
  level: number | null;
}

/**
 * Measures partial n near each predicted frequency (search window +-0.45 of the local partial
 * spacing). Returns the interpolated frequency and level of the strongest peak in the window.
 */
export function measurePartials(
  s: Spectrum,
  predicted: readonly number[],
  floorDb = -200,
): MeasuredPartial[] {
  return predicted.map((f, i) => {
    const prev = i > 0 ? predicted[i - 1] : 0;
    const next = i + 1 < predicted.length ? predicted[i + 1] : f + (f - prev);
    const lo = f - 0.45 * (f - prev);
    const hi = f + 0.45 * (next - f);
    const peak = f < s.sampleRate / 2 ? peakInRange(s, lo, hi) : null;
    if (!peak || peak.level < floorDb)
      return { n: i + 1, predicted: f, measured: null, level: null };
    return { n: i + 1, predicted: f, measured: peak.frequency, level: peak.level };
  });
}

/** Level (dB) of the spectrum at frequency f: maximum over the bins within +-halfWidth Hz. */
export function levelNear(s: Spectrum, f: number, halfWidth: number): number {
  const lo = Math.max(0, Math.floor((f - halfWidth) / s.binHz));
  const hi = Math.min(s.db.length - 1, Math.ceil((f + halfWidth) / s.binHz));
  let best = -Infinity;
  for (let m = lo; m <= hi; m++) if (s.db[m] > best) best = s.db[m];
  return best;
}
