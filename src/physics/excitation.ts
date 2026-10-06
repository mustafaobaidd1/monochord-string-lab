/**
 * Excitations shared by the audio thread, the main-thread engines and the tests.
 *
 * Pluck: a finger or plectrum pulls the string aside and lets go. Before release the string
 * sits in static equilibrium under the finger's load f, i.e. it solves the discrete static
 * equation of the scheme
 *
 *   (-T delta_xx + EI delta_xxxx) u = f,
 *
 * and is released from rest. For an ideal string and a point load this is the familiar
 * triangle, whose modal amplitudes are proportional to sin(n pi x0 / L) / n^2. Because
 * delta_xxxx = delta_xx delta_xx with simply supported ends, the pentadiagonal system factors
 * into two tridiagonal solves: delta_xx y = f, then (EI delta_xx - T) u = y.
 *
 * Strike: a felt hammer of mass M hits the string with velocity v0 and interacts through the
 * power-law contact force F = K [eta]_+^p (Chaigne & Askenfelt 1994), eta being the felt
 * compression. The hammer is integrated explicitly alongside the string.
 */
import type { Spreading, StiffString } from './scheme.ts';
import { spreading } from './scheme.ts';

/**
 * Solves a constant-coefficient tridiagonal system (sub/super-diagonal `off`, diagonal `diag`)
 * of size n with the Thomas algorithm. `rhs` is overwritten with the solution.
 */
function solveTridiagonal(n: number, diag: number, off: number, rhs: Float64Array): void {
  const cp = new Float64Array(n);
  let denom = diag;
  cp[0] = off / denom;
  rhs[0] /= denom;
  for (let i = 1; i < n; i++) {
    denom = diag - off * cp[i - 1];
    cp[i] = off / denom;
    rhs[i] = (rhs[i] - off * rhs[i - 1]) / denom;
  }
  for (let i = n - 2; i >= 0; i--) rhs[i] -= cp[i] * rhs[i + 1];
}

export interface PluckSpec {
  /** Pluck position as a fraction of the length from the nut (0 = nut, 1 = bridge). */
  position: number;
  /** Width of the finger or plectrum contact, m (0 = a point). */
  width: number;
  /** Displacement at the pluck point, m. */
  amplitude: number;
}

/**
 * Static shape of the discrete string under the pluck load, scaled so that the displacement at
 * the pluck point equals `amplitude`. Returns grid values for l = 0..N.
 */
export function staticDeflection(
  N: number,
  h: number,
  tension: number,
  EI: number,
  spec: PluckSpec,
): Float64Array {
  const s = spreading(N, h, spec.position, spec.width);
  const n = N - 1; // interior unknowns l = 1..N-1
  const y = new Float64Array(n);
  for (let j = 0; j < s.weights.length; j++) y[s.start + j - 1] = s.weights[j] / h;
  // delta_xx y = f  (delta_xx = tridiag(1, -2, 1) / h^2): scale by h^2.
  for (let i = 0; i < n; i++) y[i] *= h * h;
  solveTridiagonal(n, -2, 1, y);
  // (EI delta_xx - T) u = y.
  const off = EI / (h * h);
  solveTridiagonal(n, -2 * off - tension, off, y);
  const shape = new Float64Array(N + 1);
  for (let i = 0; i < n; i++) shape[i + 1] = y[i];
  // Scale so that the sampled displacement at the pluck point equals the requested amplitude.
  let at = 0;
  for (let j = 0; j < s.weights.length; j++) at += s.weights[j] * shape[s.start + j];
  const scale = at !== 0 ? spec.amplitude / at : 0;
  for (let l = 0; l <= N; l++) shape[l] *= scale;
  return shape;
}

export interface HammerSpec {
  /** Strike position as a fraction of the length from the nut. */
  position: number;
  /** Hammer mass, kg. */
  mass: number;
  /** Felt stiffness K in F = K eta^p, N / m^p. */
  stiffness: number;
  /** Felt exponent p. */
  exponent: number;
  /** Speed at impact, m/s. */
  velocity: number;
  /** Width of the hammer contact, m. */
  width: number;
}

/**
 * Energy-conserving hammer-string collision (Bilbao, Numerical Sound Synthesis, 2009, sections
 * 4.2.2 and 7.5). With the felt potential V(eta) = K [eta]_+^(p+1) / (p+1), the contact force
 * acting between time steps n-1 and n+1 is the discrete gradient
 *
 *   F^n = ( V(eta^{n+1}) - V(eta^{n-1}) ) / ( eta^{n+1} - eta^{n-1} ),
 *
 * so the total energy (string + hammer kinetic + averaged felt potential) is conserved exactly,
 * whatever the felt stiffness, hammer mass or string. The string's response to F is linear, so
 * eta^{n+1} = eta_free - gamma F with gamma = k^2 / M + (string displacement per newton), which
 * leaves one monotone scalar equation per sample; it is solved by safeguarded Newton iteration.
 */
export class Hammer {
  readonly spec: HammerSpec;
  readonly spread: Spreading;
  private position: number;
  private previous: number;
  private readonly k: number;
  /** Samples since the strike. */
  elapsed = 0;
  /** Samples since the last contact (for retiring the hammer). */
  sinceContact = 0;
  /** Largest force seen, N. */
  peakForce = 0;
  /** Number of samples with non-zero contact force. */
  contactSamples = 0;
  /** Felt compression at the most recent time level, m. */
  compression = 0;
  /** Recent force history, used to predict the partial amplitudes of a strike. */
  readonly history: number[] = [];
  private readonly historyLimit: number;
  private etaPrev: number;

  constructor(string: StiffString, spec: HammerSpec, historySeconds = 0.03) {
    this.spec = spec;
    this.k = string.k;
    this.spread = spreading(string.N, string.h, spec.position, spec.width);
    // Start touching the string, moving up at the impact speed.
    const surface = string.sample(this.spread);
    this.position = surface;
    this.previous = surface - spec.velocity * this.k;
    this.etaPrev = this.previous - string.samplePrevious(this.spread);
    this.compression = this.position - surface;
    this.historyLimit = Math.round(historySeconds / this.k);
  }

  /** Current hammer position (m). */
  get displacement(): number {
    return this.position;
  }

  /** Felt potential V(eta) = K [eta]_+^(p+1) / (p+1). */
  potential(eta: number): number {
    if (eta <= 0) return 0;
    const p = this.spec.exponent;
    return (this.spec.stiffness * Math.pow(eta, p + 1)) / (p + 1);
  }

  /** Discrete gradient of the felt potential between two compressions. */
  private gradient(a: number, b: number): number {
    if (a <= 0 && b <= 0) return 0;
    const d = a - b;
    const p = this.spec.exponent;
    const K = this.spec.stiffness;
    if (Math.abs(d) < 1e-14) {
      const m = 0.5 * (a + b);
      return m > 0 ? K * Math.pow(m, p) : 0;
    }
    return (this.potential(a) - this.potential(b)) / d;
  }

  /**
   * Must be called between `string.computeFree()` and `string.commit()`: solves for the contact
   * force, applies it to the string's pending update and advances the hammer.
   */
  interact(string: StiffString): number {
    const { mass } = this.spec;
    const k2 = this.k * this.k;
    const hammerFree = 2 * this.position - this.previous;
    const etaFree = hammerFree - string.samplePending(this.spread);
    const etaOld = this.etaPrev;
    let force = 0;
    let eta = etaFree;
    if (etaFree > 0 || etaOld > 0) {
      const gamma = k2 / mass + string.forceResponse(this.spread);
      // g(eta) = eta - etaFree + gamma * gradient(eta, etaOld) is increasing; its root lies in
      // [etaFree - gamma * gradient(etaFree, etaOld), etaFree].
      let hi = etaFree;
      let lo = etaFree - gamma * this.gradient(etaFree, etaOld);
      const g = (x: number) => x - etaFree + gamma * this.gradient(x, etaOld);
      let x = 0.5 * (lo + hi);
      for (let iter = 0; iter < 60; iter++) {
        const gx = g(x);
        if (gx > 0) hi = x;
        else lo = x;
        // Newton step from a numerical derivative of the (smooth, monotone) residual.
        const dx = Math.max(1e-12, Math.abs(x) * 1e-7);
        const slope = (g(x + dx) - gx) / dx;
        let next = slope > 0 ? x - gx / slope : 0.5 * (lo + hi);
        if (!(next > lo && next < hi)) next = 0.5 * (lo + hi);
        if (Math.abs(next - x) <= 1e-15 + 1e-12 * Math.abs(x) || hi - lo < 1e-16) {
          x = next;
          break;
        }
        x = next;
      }
      eta = x;
      force = this.gradient(eta, etaOld);
    }
    if (force > 0) {
      string.addForce(this.spread, force);
      this.contactSamples++;
      this.sinceContact = 0;
      if (force > this.peakForce) this.peakForce = force;
    } else {
      this.sinceContact++;
    }
    const nextPosition = hammerFree - (k2 * force) / mass;
    this.previous = this.position;
    this.position = nextPosition;
    // eta^n becomes the "old" compression for the next step.
    this.etaPrev = this.compression;
    this.compression = eta;
    if (this.history.length < this.historyLimit) this.history.push(force);
    this.elapsed++;
    return force;
  }

  /** Hammer kinetic energy (M / 2) ((u_H^n - u_H^{n-1}) / k)^2 at the latest half step. */
  kineticEnergy(): number {
    const v = (this.position - this.previous) / this.k;
    return 0.5 * this.spec.mass * v * v;
  }

  /** True once the hammer has left the string and is clearly moving away from it. */
  get retired(): boolean {
    return this.elapsed > 8 && this.sinceContact > 0.02 / this.k;
  }
}
