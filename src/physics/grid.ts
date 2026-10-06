/**
 * Grid design for the explicit stiff-string scheme (Bilbao, "Numerical Sound Synthesis", 2009,
 * section 7.2). With time step k = 1 / fs, the scheme is stable if and only if the grid spacing
 * satisfies
 *
 *   h >= h_min = sqrt( ( c^2 k^2 + 4 sigma_1 k + sqrt( (c^2 k^2 + 4 sigma_1 k)^2 + 16 kappa^2 k^2 ) ) / 2 )
 *
 * which follows from requiring both roots of every mode's characteristic polynomial to lie in the
 * unit disc (von Neumann analysis; see `theory.ts`). Choosing h as close to h_min as an integer
 * number of intervals allows minimises numerical dispersion, so N = floor(L / h_min).
 */

export interface GridInput {
  length: number;
  c: number;
  kappa: number;
  sigma1: number;
  sampleRate: number;
}

export interface Grid {
  /** Number of intervals; grid points are l = 0..N with l = 0 (nut) and l = N (bridge) fixed. */
  N: number;
  /** Grid spacing h = L / N, m. */
  h: number;
  /** Time step k = 1 / fs, s. */
  k: number;
  /** Stability bound on h, m. */
  hMin: number;
  /** Courant number lambda = c k / h. */
  lambda: number;
  /** Stiffness number nu = kappa k / h^2 (Bilbao writes mu; nu avoids a clash with linear density). */
  nu: number;
  /** True when N was capped at `MAX_POINTS` (the grid is coarser than the bound allows). */
  capped: boolean;
  /** Left-hand side of the stability inequality, lambda^2 + 4 nu^2 + 4 sigma_1 k / h^2 (<= 1). */
  stabilityNumber: number;
}

/** Upper limit on grid intervals, chosen so the audio thread stays well inside its budget. */
export const MAX_POINTS = 640;
/** Lower limit: fewer intervals than this can no longer represent a useful set of partials. */
export const MIN_POINTS = 12;

export function stabilityBound(c: number, kappa: number, sigma1: number, k: number): number {
  const a = c * c * k * k + 4 * sigma1 * k;
  return Math.sqrt((a + Math.sqrt(a * a + 16 * kappa * kappa * k * k)) / 2);
}

/** Largest N for which L / N still satisfies the bound (before capping). */
export function maxStableIntervals(input: GridInput): number {
  const k = 1 / input.sampleRate;
  const hMin = stabilityBound(input.c, input.kappa, input.sigma1, k);
  // A relative margin of 1e-9 keeps floating-point rounding from landing exactly on the bound.
  return Math.floor(input.length / (hMin * (1 + 1e-9)));
}

export class GridError extends Error {}

export function designGrid(input: GridInput, maxPoints = MAX_POINTS): Grid {
  const { length: L, c, kappa, sigma1, sampleRate } = input;
  if (!(L > 0 && c > 0 && kappa >= 0 && sigma1 >= 0 && sampleRate > 0)) {
    throw new GridError('Invalid grid input');
  }
  const k = 1 / sampleRate;
  const hMin = stabilityBound(c, kappa, sigma1, k);
  const stable = maxStableIntervals(input);
  if (stable < MIN_POINTS) {
    throw new GridError(
      `Only ${stable} grid intervals satisfy the stability bound (minimum ${MIN_POINTS}).`,
    );
  }
  const N = Math.min(stable, maxPoints);
  const h = L / N;
  const lambda = (c * k) / h;
  const nu = (kappa * k) / (h * h);
  return {
    N,
    h,
    k,
    hMin,
    lambda,
    nu,
    capped: stable > maxPoints,
    stabilityNumber: lambda * lambda + 4 * nu * nu + (4 * sigma1 * k) / (h * h),
  };
}

/**
 * Largest stiffness kappa for which a grid of at least `MIN_POINTS` intervals is still stable:
 * from h^4 - a h^2 - 4 kappa^2 k^2 >= 0 with h = L / MIN_POINTS and a = c^2 k^2 + 4 sigma_1 k.
 */
export function maxKappa(length: number, c: number, sigma1: number, sampleRate: number): number {
  const k = 1 / sampleRate;
  const h = length / MIN_POINTS;
  const a = c * c * k * k + 4 * sigma1 * k;
  const v = h * h * (h * h - a);
  return v > 0 ? Math.sqrt(v) / (2 * k) : 0;
}

/** Largest sigma_1 for which a grid of at least `MIN_POINTS` intervals is still stable. */
export function maxSigma1(length: number, c: number, kappa: number, sampleRate: number): number {
  const k = 1 / sampleRate;
  const h = length / MIN_POINTS;
  const a = (h ** 4 - 4 * kappa * kappa * k * k) / (h * h);
  return Math.max(0, (a - c * c * k * k) / (4 * k));
}
