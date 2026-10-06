/**
 * Explicit finite-difference scheme for the stiff, damped string (Bilbao 2009, eq. 7.29 form):
 *
 *   u_tt = c^2 u_xx - kappa^2 u_xxxx - 2 sigma_0 u_t + 2 sigma_1 u_txx
 *
 * discretised as
 *
 *   delta_tt u = c^2 delta_xx u - kappa^2 delta_xxxx u - 2 sigma_0 delta_t. u + 2 sigma_1 delta_t- delta_xx u
 *
 * where delta_t. is the centred and delta_t- the backward time difference (the backward
 * difference keeps the sigma_1 term explicit). Solving for u^{n+1} gives a five-point stencil
 * in u^n and a three-point stencil in u^{n-1}:
 *
 *   u^{n+1}_l = A0 u_l + A1 (u_{l+1} + u_{l-1}) + A2 (u_{l+2} + u_{l-2})
 *             + B0 v_l + B1 (v_{l+1} + v_{l-1})                       (u = u^n, v = u^{n-1})
 *
 * Simply supported ends: u_0 = u_N = 0 and u_xx = 0, i.e. ghost points u_{-1} = -u_1 and
 * u_{N+1} = -u_{N-1}. With these, delta_xxxx is exactly delta_xx applied twice, the discrete
 * sine vectors sin(p pi l / N) are exact eigenvectors, and the lossless scheme conserves the
 * discrete energy returned by `energy()` to rounding error.
 */
import type { Grid } from './grid.ts';
import type { StringParams, StringPhysics } from './materials.ts';

/** Weights that sample (and, divided by h, spread onto) the grid around a point. */
export interface Spreading {
  /** First interior grid index l covered by `weights`. */
  start: number;
  /** Interpolation weights I_l, summing to 1. The matching force density is I_l / h. */
  weights: Float64Array;
}

export class StiffString {
  readonly N: number;
  readonly h: number;
  readonly k: number;
  readonly length: number;
  readonly tension: number;
  readonly mu: number;
  readonly EI: number;
  readonly sigma1: number;
  sigma0: number;

  /** Stencil coefficients (see the file comment). */
  private A0 = 0;
  private A1 = 0;
  private A2 = 0;
  private B0 = 0;
  private B1 = 0;
  /** k^2 / (mu (1 + sigma_0 k)): converts a force density into a displacement increment. */
  private forceScale = 0;

  // Three time levels with one ghost point on each side: array index i = l + 1, l = -1..N+1.
  private next: Float64Array;
  private cur: Float64Array;
  private prev: Float64Array;

  constructor(params: StringParams, physics: StringPhysics, grid: Grid) {
    this.N = grid.N;
    this.h = grid.h;
    this.k = grid.k;
    this.length = params.length;
    this.tension = params.tension;
    this.mu = physics.mu;
    this.EI = physics.EI;
    this.sigma1 = params.sigma1;
    this.sigma0 = params.sigma0;
    this.next = new Float64Array(this.N + 3);
    this.cur = new Float64Array(this.N + 3);
    this.prev = new Float64Array(this.N + 3);
    this.updateCoefficients();
  }

  /** Changes sigma_0 (used for the "finger mute"); any sigma_0 >= 0 keeps the scheme stable. */
  setSigma0(sigma0: number): void {
    this.sigma0 = Math.max(0, sigma0);
    this.updateCoefficients();
  }

  private updateCoefficients(): void {
    const { k, h } = this;
    const c2 = this.tension / this.mu;
    const kappa2 = this.EI / this.mu;
    const lambda2 = (c2 * k * k) / (h * h);
    const mu2 = (kappa2 * k * k) / (h * h * h * h);
    const S = (2 * this.sigma1 * k) / (h * h);
    const d = 1 + this.sigma0 * k;
    this.A0 = (2 - 2 * lambda2 - 6 * mu2 - 2 * S) / d;
    this.A1 = (lambda2 + 4 * mu2 + S) / d;
    this.A2 = -mu2 / d;
    this.B0 = (-1 + this.sigma0 * k + 2 * S) / d;
    this.B1 = -S / d;
    this.forceScale = (k * k) / (this.mu * d);
  }

  /** Computes the force-free update u^{n+1} into the internal "next" buffer. */
  computeFree(): void {
    const u = this.cur;
    const v = this.prev;
    const w = this.next;
    const N = this.N;
    u[0] = -u[2];
    u[N + 2] = -u[N];
    const A0 = this.A0;
    const A1 = this.A1;
    const A2 = this.A2;
    const B0 = this.B0;
    const B1 = this.B1;
    for (let i = 2; i <= N; i++) {
      w[i] =
        A0 * u[i] +
        A1 * (u[i + 1] + u[i - 1]) +
        A2 * (u[i + 2] + u[i - 2]) +
        B0 * v[i] +
        B1 * (v[i + 1] + v[i - 1]);
    }
    w[1] = 0;
    w[N + 1] = 0;
  }

  /** Adds a point force F (newtons) spread over `s` to the pending update. */
  addForce(s: Spreading, force: number): void {
    const scale = (force * this.forceScale) / this.h;
    const w = this.next;
    const weights = s.weights;
    for (let j = 0; j < weights.length; j++) w[s.start + j + 1] += scale * weights[j];
  }

  /** Displacement increment per newton of force at the pending update, sampled through `s`. */
  forceResponse(s: Spreading): number {
    let sum = 0;
    for (let j = 0; j < s.weights.length; j++) sum += s.weights[j] * s.weights[j];
    return (this.forceScale / this.h) * sum;
  }

  /** Rotates the time levels: u^{n-1} <- u^n, u^n <- u^{n+1}. */
  commit(): void {
    const t = this.prev;
    this.prev = this.cur;
    this.cur = this.next;
    this.next = t;
  }

  step(): void {
    this.computeFree();
    this.commit();
  }

  /**
   * Puts the string at rest in `shape` (length N + 1, grid points 0..N) with zero centred
   * velocity: u^{n-1} = u^n + (k^2 / 2) * (spatial operator applied to u^n), so that the first
   * update is symmetric in time.
   */
  setAtRest(shape: ArrayLike<number>): void {
    const N = this.N;
    for (let l = 0; l <= N; l++) {
      this.cur[l + 1] = shape[l];
      this.prev[l + 1] = shape[l];
    }
    this.cur[1] = 0;
    this.cur[N + 1] = 0;
    this.prev[1] = 0;
    this.prev[N + 1] = 0;
    // One free update with u^{n-1} = u^n gives u^n + k^2 * L u^n (losses aside).
    this.computeFree();
    for (let i = 1; i <= N + 1; i++) this.prev[i] = 0.5 * (this.cur[i] + this.next[i]);
  }

  /** Sets the string to rest at zero displacement. */
  clear(): void {
    this.cur.fill(0);
    this.prev.fill(0);
    this.next.fill(0);
  }

  /** Current displacement at grid point l (0..N). */
  at(l: number): number {
    return this.cur[l + 1];
  }

  /** Copies the current displacement (grid points 0..N) into `out`. */
  copyShape(out: Float64Array | Float32Array): void {
    const N = this.N;
    for (let l = 0; l <= N; l++) out[l] = this.cur[l + 1];
  }

  /** Displacement sampled through `s` (the same weights used to spread forces). */
  sample(s: Spreading): number {
    let sum = 0;
    const u = this.cur;
    for (let j = 0; j < s.weights.length; j++) sum += s.weights[j] * u[s.start + j + 1];
    return sum;
  }

  /** Displacement of the pending update sampled through `s`. */
  samplePending(s: Spreading): number {
    let sum = 0;
    const w = this.next;
    for (let j = 0; j < s.weights.length; j++) sum += s.weights[j] * w[s.start + j + 1];
    return sum;
  }

  /** Displacement at the previous time level sampled through `s`. */
  samplePrevious(s: Spreading): number {
    let sum = 0;
    const v = this.prev;
    for (let j = 0; j < s.weights.length; j++) sum += s.weights[j] * v[s.start + j + 1];
    return sum;
  }

  /** Linear interpolation of the current displacement at a fraction xi of the length. */
  displacementAt(xi: number): number {
    const pos = Math.min(Math.max(xi, 0), 1) * this.N;
    const l = Math.min(Math.floor(pos), this.N - 1);
    const a = pos - l;
    return (1 - a) * this.cur[l + 1] + a * this.cur[l + 2];
  }

  /** Velocity (u^n - u^{n-1}) / k at a fraction xi of the length, linearly interpolated. */
  velocityAt(xi: number): number {
    const pos = Math.min(Math.max(xi, 0), 1) * this.N;
    const l = Math.min(Math.floor(pos), this.N - 1);
    const a = pos - l;
    const now = (1 - a) * this.cur[l + 1] + a * this.cur[l + 2];
    const before = (1 - a) * this.prev[l + 1] + a * this.prev[l + 2];
    return (now - before) / this.k;
  }

  /**
   * Transverse force on the bridge (x = L): T u_x - EI u_xxx evaluated with centred differences
   * and the simply supported ghost points. Per mode this is (T beta + EI beta^3) times the modal
   * amplitude, up to sign.
   */
  bridgeForce(): number {
    const N = this.N;
    const u1 = this.cur[N]; // l = N - 1
    const u2 = this.cur[N - 1]; // l = N - 2
    const h = this.h;
    return (this.tension * u1) / h + (this.EI * (2 * u1 - u2)) / (h * h * h);
  }

  /**
   * Discrete energy H^{n+1/2} (joules) of the lossless part of the scheme, evaluated from the two
   * most recent time levels:
   *   H = mu/2 ||delta_t- u||^2 + T/2 <delta_x+ u^n, delta_x+ u^{n-1}> + EI/2 <delta_xx u^n, delta_xx u^{n-1}>
   * It is exactly conserved (to rounding) when sigma_0 = sigma_1 = 0 and no force acts.
   */
  energy(): number {
    const u = this.cur;
    const v = this.prev;
    const N = this.N;
    const h = this.h;
    const k = this.k;
    let kinetic = 0;
    for (let i = 2; i <= N; i++) {
      const d = u[i] - v[i];
      kinetic += d * d;
    }
    kinetic *= (this.mu * h) / (2 * k * k);
    let tension = 0;
    for (let i = 1; i <= N; i++) tension += (u[i + 1] - u[i]) * (v[i + 1] - v[i]);
    tension *= this.tension / (2 * h);
    let bending = 0;
    for (let i = 2; i <= N; i++) {
      const a = u[i + 1] - 2 * u[i] + u[i - 1];
      const b = v[i + 1] - 2 * v[i] + v[i - 1];
      bending += a * b;
    }
    bending *= this.EI / (2 * h * h * h);
    return kinetic + tension + bending;
  }

  /** Modal coordinate q_p = (2 / N) sum_l u_l sin(p pi l / N) of the current state. */
  modalAmplitude(p: number): number {
    const N = this.N;
    let sum = 0;
    for (let l = 1; l < N; l++) sum += this.cur[l + 1] * Math.sin((p * Math.PI * l) / N);
    return (2 / N) * sum;
  }

  /** Largest absolute displacement over the grid. */
  maxAbs(): number {
    let m = 0;
    const u = this.cur;
    for (let i = 1; i <= this.N + 1; i++) {
      const a = Math.abs(u[i]);
      if (a > m) m = a;
    }
    return m;
  }
}

/**
 * Raised-cosine spreading of total width `width` (m) centred at a fraction `xi` of the length,
 * restricted to interior points. Falls back to linear interpolation when fewer than two grid
 * points fall inside the width.
 */
export function spreading(N: number, h: number, xi: number, width: number): Spreading {
  const L = N * h;
  const x0 = Math.min(Math.max(xi, 0), 1) * L;
  const half = width / 2;
  const first = Math.max(1, Math.ceil((x0 - half) / h));
  const last = Math.min(N - 1, Math.floor((x0 + half) / h));
  if (width > 0 && last - first + 1 >= 2) {
    const weights = new Float64Array(last - first + 1);
    let sum = 0;
    for (let l = first; l <= last; l++) {
      const s = l * h - x0;
      const v = 1 + Math.cos((2 * Math.PI * s) / width);
      weights[l - first] = v;
      sum += v;
    }
    if (sum > 0) {
      for (let j = 0; j < weights.length; j++) weights[j] /= sum;
      return { start: first, weights };
    }
  }
  // Linear interpolation between the two nearest interior points.
  const pos = Math.min(Math.max(x0 / h, 1), N - 1);
  const l = Math.min(Math.floor(pos), N - 2);
  const a = pos - l;
  if (l < 1) return { start: 1, weights: Float64Array.of(1) };
  return { start: l, weights: Float64Array.of(1 - a, a) };
}
