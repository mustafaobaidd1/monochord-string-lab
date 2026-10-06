/**
 * Closed-form results for the stiff, damped string with simply supported ends.
 *
 * Modal solution: u(x, t) = sum_n a_n e^{-sigma_n t} cos(omega_n t) sin(n pi x / L) with
 *   omega_n^2 = c^2 beta_n^2 + kappa^2 beta_n^4,   beta_n = n pi / L
 *   f_n = n f0 sqrt(1 + B n^2),   f0 = c / (2 L),   B = kappa^2 pi^2 / (c^2 L^2) = pi^2 EI / (T L^2)
 *   sigma_n = sigma_0 + sigma_1 beta_n^2       (damping slightly lowers the frequency; ignored)
 *
 * The discrete scheme has the same eigenvectors, with the exact per-mode characteristic
 * polynomial
 *   (1 + sigma_0 k) z^2 - (2 - a - b) z + (1 - sigma_0 k - b) = 0,
 *   a = 4 lambda^2 s^2 + 16 mu^2 s^4,  b = 8 sigma_1 k s^2 / h^2,  s = sin(p pi / (2N)),
 * from which the simulated frequencies and decay rates follow exactly (`discreteMode`).
 */
import type { Grid } from './grid.ts';
import type { StringPhysics } from './materials.ts';

export const LN_1000 = Math.log(1000); // 60 dB of amplitude decay = factor 1000

/** Frequency of partial n of the continuous stiff string. */
export function partialFrequency(n: number, f0: number, B: number): number {
  return n * f0 * Math.sqrt(1 + B * n * n);
}

/** Decay rate (1/s) of partial n: sigma_0 + sigma_1 (n pi / L)^2. */
export function partialDecayRate(n: number, length: number, sigma0: number, sigma1: number) {
  const beta = (n * Math.PI) / length;
  return sigma0 + sigma1 * beta * beta;
}

/** Time for a mode with decay rate sigma to fall by 60 dB. */
export function t60(sigma: number): number {
  return sigma > 0 ? LN_1000 / sigma : Infinity;
}

/**
 * Wavenumber squared xi(omega) = beta^2 of the mode with angular frequency omega, inverting the
 * dispersion relation omega^2 = c^2 beta^2 + kappa^2 beta^4.
 */
export function wavenumberSquared(omega: number, c: number, kappa: number): number {
  if (kappa === 0) return (omega * omega) / (c * c);
  const k2 = kappa * kappa;
  return (-c * c + Math.sqrt(c ** 4 + 4 * k2 * omega * omega)) / (2 * k2);
}

/**
 * sigma_0 and sigma_1 that give 60 dB decay times t1 at frequency f1 and t2 at f2
 * (Bilbao 2009, eq. 7.29; requires f2 > f1 and a decay that is faster at f2 or equal).
 */
export function lossFromT60(
  f1: number,
  t1: number,
  f2: number,
  t2: number,
  c: number,
  kappa: number,
): { sigma0: number; sigma1: number } {
  const x1 = wavenumberSquared(2 * Math.PI * f1, c, kappa);
  const x2 = wavenumberSquared(2 * Math.PI * f2, c, kappa);
  const sigma1 = Math.max(0, (LN_1000 / t2 - LN_1000 / t1) / (x2 - x1));
  const sigma0 = Math.max(0, LN_1000 / t1 - sigma1 * x1);
  return { sigma0, sigma1 };
}

/** 60 dB decay time of the partial nearest to frequency f. */
export function t60AtFrequency(
  f: number,
  physics: Pick<StringPhysics, 'c' | 'kappa'>,
  sigma0: number,
  sigma1: number,
): number {
  const xi = wavenumberSquared(2 * Math.PI * f, physics.c, physics.kappa);
  return t60(sigma0 + sigma1 * xi);
}

/**
 * Modal weight of a raised-cosine load of total width w (fraction w/L of the length) relative to
 * a point load: W_n = (sin a / a) / (1 - a^2 / pi^2) with a = n pi w / (2 L).
 */
export function widthFactor(n: number, widthFraction: number): number {
  const a = (n * Math.PI * widthFraction) / 2;
  if (a < 1e-9) return 1;
  const ratio = a / Math.PI;
  const denom = 1 - ratio * ratio;
  if (Math.abs(denom) < 1e-9) return 0.5; // limit of the expression at a = pi
  return Math.sin(a) / a / denom;
}

/**
 * Relative displacement amplitude of partial n for a pluck at fraction x0 of the length:
 * sin(n pi x0) W_n / (n^2 (1 + B n^2)). The 1 / (1 + B n^2) factor is the stiffness correction to
 * the static shape (it is 1 for an ideal string, which recovers |sin(n pi x0 / L)| / n^2).
 */
export function pluckDisplacementAmplitude(
  n: number,
  x0: number,
  widthFraction: number,
  B: number,
): number {
  return (Math.sin(n * Math.PI * x0) * widthFactor(n, widthFraction)) / (n * n * (1 + B * n * n));
}

/** Ideal-string amplitude of partial n for a triangular pluck of height `height` at x0 = d / L. */
export function trianglePluckAmplitude(n: number, x0: number, height: number): number {
  // A_n = (2 h / (n^2 pi^2)) L^2 / (d (L - d)) sin(n pi d / L)   (fractions: L = 1, d = x0)
  return (
    ((2 * height) / (n * n * Math.PI * Math.PI)) * (Math.sin(n * Math.PI * x0) / (x0 * (1 - x0)))
  );
}

export type OutputKind = 'bridge' | 'pickup';

/**
 * Relative amplitude of partial n in the output signal, for a pluck. The bridge force of mode n
 * is (T beta_n + EI beta_n^3) a_n = T beta_n (1 + B n^2) a_n, which cancels the stiffness factor
 * of the static shape: bridge-force partials follow |sin(n pi x0 / L)| W_n / n. A magnetic pickup
 * senses velocity, omega_n a_n, weighted by sin(n pi xp / L) at its position.
 */
export function pluckOutputAmplitude(
  n: number,
  x0: number,
  widthFraction: number,
  B: number,
  output: OutputKind,
  pickup: number,
): number {
  const a = pluckDisplacementAmplitude(n, x0, widthFraction, B);
  if (output === 'bridge') return Math.abs(a * n * (1 + B * n * n));
  return Math.abs(a * n * Math.sqrt(1 + B * n * n) * Math.sin(n * Math.PI * pickup));
}

/**
 * Relative amplitude of partial n for a strike whose contact force history is `force` (sampled
 * every k seconds) at fraction xh of the length. Duhamel's integral gives a free modal amplitude
 * proportional to |sin(n pi xh)| |F^(omega_n)| / omega_n after the contact ends.
 */
export function strikeOutputAmplitude(
  n: number,
  f0: number,
  B: number,
  xh: number,
  force: ArrayLike<number>,
  k: number,
  output: OutputKind,
  pickup: number,
): number {
  const fn = partialFrequency(n, f0, B);
  const w = 2 * Math.PI * fn;
  let re = 0;
  let im = 0;
  for (let i = 0; i < force.length; i++) {
    const v = force[i];
    if (v === 0) continue;
    re += v * Math.cos(w * i * k);
    im -= v * Math.sin(w * i * k);
  }
  const spectrum = Math.hypot(re, im) * k;
  const displacement = (Math.abs(Math.sin(n * Math.PI * xh)) * spectrum) / w;
  if (output === 'bridge') return displacement * n * (1 + B * n * n);
  return displacement * w * Math.abs(Math.sin(n * Math.PI * pickup));
}

export interface DiscreteMode {
  /** Frequency of the simulated mode, Hz. */
  frequency: number;
  /** Decay rate of the simulated mode, 1/s. */
  decay: number;
}

/**
 * Exact frequency and decay of mode p in the discrete scheme (see the file comment).
 */
export function discreteMode(
  p: number,
  grid: Grid,
  physics: Pick<StringPhysics, 'c' | 'kappa'>,
  sigma0: number,
  sigma1: number,
): DiscreteMode {
  const { N, h, k } = grid;
  const s = Math.sin((p * Math.PI) / (2 * N));
  const lambda2 = (physics.c * physics.c * k * k) / (h * h);
  const mu2 = (physics.kappa * physics.kappa * k * k) / (h * h * h * h);
  const a = 4 * lambda2 * s * s + 16 * mu2 * s ** 4;
  const b = (8 * sigma1 * k * s * s) / (h * h);
  const c2 = 1 + sigma0 * k;
  const c0 = 1 - sigma0 * k - b;
  const modulus = Math.sqrt(c0 / c2);
  const cosTheta = Math.min(1, Math.max(-1, (2 - a - b) / (2 * Math.sqrt(c2 * c0))));
  return { frequency: Math.acos(cosTheta) / (2 * Math.PI * k), decay: -Math.log(modulus) / k };
}

/** Lossless dispersion relation of the scheme: sin^2(omega k / 2) = lambda^2 s^2 + 4 mu^2 s^4. */
export function discreteFrequencyLossless(p: number, grid: Grid): number {
  const s = Math.sin((p * Math.PI) / (2 * grid.N));
  const v = grid.lambda * grid.lambda * s * s + 4 * grid.mu * grid.mu * s ** 4;
  return (2 * Math.asin(Math.min(1, Math.sqrt(v)))) / (2 * Math.PI * grid.k);
}

/** Interval in cents between two frequencies (positive when `measured` is higher). */
export function cents(measured: number, reference: number): number {
  return 1200 * Math.log2(measured / reference);
}
