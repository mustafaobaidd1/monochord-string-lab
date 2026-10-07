/**
 * Bowed string (Bilbao, Numerical Sound Synthesis, 2009, section 7.4). The bow presses on the
 * string with force F at x_B and moves at speed v_B; friction depends on the relative velocity
 * eta = u_t(x_B) - v_B through Bilbao's smooth characteristic
 *
 *   phi(eta) = sqrt(2a) eta exp(-a eta^2 + 1/2),      |phi| <= 1, peak at eta = 1/sqrt(2a),
 *
 * and acts on the string as the point force -F phi(eta). With eta taken at the centred time
 * difference, the string's response is linear in the force, so each sample needs one scalar
 * nonlinear equation  g(eta) = eta + q phi(eta) - b = 0,  whose root lies in [b - q, b + q]
 * because |phi| <= 1. It is solved by Newton iteration from the previous eta (which follows the
 * stick/slip branch, giving the physical hysteresis) with bisection as a safeguard.
 *
 * In the playable range of force and speed the string settles into Helmholtz motion: it sticks
 * to the bow for a fraction (1 - beta) of each period and slips back for beta, beta = x_B / L
 * measured from the bridge, and the bridge force becomes a sawtooth.
 */
import type { Spreading, StiffString } from './scheme.ts';
import { spreading } from './scheme.ts';

export interface BowSpec {
  /** Bow position as a fraction of the length from the nut (1 - beta). */
  position: number;
  /** Bow force, N. */
  force: number;
  /** Bow speed, m/s. */
  velocity: number;
  /** Width of the bow-hair contact, m. */
  width: number;
  /** Friction-curve sharpness a, s^2/m^2 (friction peaks at a relative speed of 1/sqrt(2a)). */
  sharpness: number;
}

/** Friction-curve sharpness used by the interface (peak friction at 0.022 m/s slip). */
export const BOW_SHARPNESS = 1000;

/**
 * A bow force that lies inside the playable (Helmholtz) range for a string of impedance
 * Z0 = sqrt(T mu): fitted to simulations of the presets at beta = 0.1, it scales as
 * Z0^1.25 and with the bow speed (Schelleng's minimum force grows as v_B Z0^2 / beta^2, the
 * maximum as v_B Z0 / beta).
 */
export function referenceBowForce(tension: number, mu: number, velocity: number): number {
  const z0 = Math.sqrt(tension * mu);
  return 0.2 * (z0 / 0.19) ** 1.25 * (velocity / 0.1);
}

export class Bow {
  readonly spec: BowSpec;
  readonly spread: Spreading;
  private readonly rootA: number;
  private eta: number;
  /** Envelope of the bow force (0..1): pressed in over 20 ms, lifted over 30 ms. */
  private level = 0;
  private target = 1;
  private readonly attack: number;
  private readonly releaseStep: number;
  /** Relative velocity at the last step, m/s (exposed for tests and the drawing). */
  relativeVelocity = 0;
  /** String velocity under the bow at the last step, m/s. */
  stringVelocity = 0;

  constructor(string: StiffString, spec: BowSpec) {
    this.spec = spec;
    this.spread = spreading(string.N, string.h, spec.position, spec.width);
    this.rootA = Math.sqrt(2 * spec.sharpness);
    this.eta = -spec.velocity;
    this.attack = string.k / 0.02;
    this.releaseStep = string.k / 0.03;
  }

  /** Lifts the bow; the force fades out and `finished` becomes true. */
  release(): void {
    this.target = 0;
  }

  get finished(): boolean {
    return this.target === 0 && this.level <= 0;
  }

  get pressed(): boolean {
    return this.target === 1;
  }

  /** Friction characteristic phi(eta). */
  friction(eta: number): number {
    return this.rootA * eta * Math.exp(-this.spec.sharpness * eta * eta + 0.5);
  }

  /**
   * Must be called between `string.computeFree()` and `string.commit()`. Returns the force the
   * bow applies to the string, N.
   */
  interact(string: StiffString): number {
    if (this.target > this.level) this.level = Math.min(1, this.level + this.attack);
    else if (this.target < this.level) this.level = Math.max(0, this.level - this.releaseStep);
    const force = this.spec.force * this.level;
    const k = string.k;
    const vB = this.spec.velocity;
    const b =
      (string.samplePending(this.spread) - string.samplePrevious(this.spread)) / (2 * k) - vB;
    if (force <= 0) {
      this.eta = b;
      this.relativeVelocity = b;
      this.stringVelocity = b + vB;
      return 0;
    }
    const q = (string.forceResponse(this.spread) * force) / (2 * k);
    const a = this.spec.sharpness;
    const ra = this.rootA;
    let lo = b - q;
    let hi = b + q;
    let x = Math.min(hi, Math.max(lo, this.eta));
    for (let it = 0; it < 60; it++) {
      const e = Math.exp(-a * x * x + 0.5);
      const g = x + q * ra * x * e - b;
      if (g > 0) hi = x;
      else lo = x;
      const dg = 1 + q * ra * e * (1 - 2 * a * x * x);
      let next = dg > 0 ? x - g / dg : 0.5 * (lo + hi);
      if (!(next > lo && next < hi)) next = 0.5 * (lo + hi);
      if (Math.abs(next - x) <= 1e-13 || hi - lo <= 1e-14) {
        x = next;
        break;
      }
      x = next;
    }
    this.eta = x;
    this.relativeVelocity = x;
    this.stringVelocity = x + vB;
    const f = -force * this.friction(x);
    string.addForce(this.spread, f);
    return f;
  }
}
