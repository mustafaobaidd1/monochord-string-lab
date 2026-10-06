import { describe, expect, it } from 'vitest';
import { Hammer, staticDeflection } from '../src/physics/excitation.ts';
import { StiffString, spreading } from '../src/physics/scheme.ts';
import { PRESETS, feltStiffness, hammerSpec, presetString } from '../src/physics/presets.ts';
import { pluckDisplacementAmplitude } from '../src/physics/theory.ts';
import { FS, makeString } from './helpers.ts';

describe('static deflection (pluck shape)', () => {
  it('is an exact triangle for an ideal string and a point load on a grid point', () => {
    const N = 60;
    const h = 0.01;
    const shape = staticDeflection(N, h, 100, 0, { position: 0.25, width: 0, amplitude: 0.003 });
    const apex = 15;
    for (let l = 0; l <= N; l++) {
      const expected = l <= apex ? (0.003 * l) / apex : (0.003 * (N - l)) / (N - apex);
      expect(shape[l]).toBeCloseTo(expected, 12);
    }
  });

  it('reaches the requested amplitude at the pluck point for stiff strings and wide fingers', () => {
    const sim = makeString(presetString(PRESETS.find((p) => p.id === 'piano-a0')!));
    const spec = { position: 0.37, width: 0.02, amplitude: 0.002 };
    const shape = staticDeflection(
      sim.grid.N,
      sim.grid.h,
      sim.params.tension,
      sim.physics.EI,
      spec,
    );
    const s = spreading(sim.grid.N, sim.grid.h, spec.position, spec.width);
    let at = 0;
    s.weights.forEach((w, j) => (at += w * shape[s.start + j]));
    expect(at).toBeCloseTo(0.002, 12);
    expect(shape[0]).toBe(0);
    expect(shape[sim.grid.N]).toBe(0);
  });

  it('has modal amplitudes proportional to sin(n pi x0) W_n / (n^2 (1 + B n^2))', () => {
    const sim = makeString(presetString(PRESETS.find((p) => p.id === 'guitar-e2')!));
    const spec = { position: 0.7, width: 0.006, amplitude: 0.002 };
    sim.string.setAtRest(
      staticDeflection(sim.grid.N, sim.grid.h, sim.params.tension, sim.physics.EI, spec),
    );
    const q1 = sim.string.modalAmplitude(1);
    const w = spec.width / sim.params.length;
    const p1 = pluckDisplacementAmplitude(1, spec.position, w, sim.physics.B);
    for (const n of [2, 3, 5, 8]) {
      const ratio = sim.string.modalAmplitude(n) / q1;
      const expected = pluckDisplacementAmplitude(n, spec.position, w, sim.physics.B) / p1;
      expect(ratio).toBeCloseTo(expected, 2);
    }
  });
});

describe('spreading', () => {
  it('weights sum to one and stay inside the string', () => {
    for (const [xi, width] of [
      [0.5, 0.02],
      [0.01, 0.05],
      [0.999, 0.01],
      [0.3, 0],
    ] as const) {
      const s = spreading(100, 0.006, xi, width);
      const sum = s.weights.reduce((a, b) => a + b, 0);
      expect(sum).toBeCloseTo(1, 12);
      expect(s.start).toBeGreaterThanOrEqual(1);
      expect(s.start + s.weights.length - 1).toBeLessThanOrEqual(99);
    }
  });
});

describe('hammer', () => {
  /**
   * Against an immovable string (huge linear density), the explicit hammer integrator must
   * reproduce the analytic contact of a mass on a power-law spring:
   *   energy  M v0^2 / 2 = K eta_max^(p+1) / (p+1)
   *   time    t_c = 2 (eta_max / v0) * integral_0^1 ds / sqrt(1 - s^(p+1))
   * and rebound at the impact speed.
   */
  it('reproduces the analytic power-law contact time and an elastic rebound', () => {
    const params = { ...presetString(PRESETS[0]), sigma0: 0, sigma1: 0 };
    const sim = makeString(params);
    const rigid = new StiffString(params, { ...sim.physics, mu: 1e12 }, sim.grid);
    const spec = {
      position: 0.875,
      mass: 0.009,
      stiffness: 4e9,
      exponent: 2.5,
      velocity: 3,
      width: 0.01,
    };
    const hammer = new Hammer(rigid, spec);
    // Contact time from the interpolated zero crossings of the felt compression.
    let prevEta = hammer.compression;
    const tIn = 0; // the compression starts at exactly zero
    let tOut = -1;
    let last = hammer.displacement;
    let rebound = 0;
    for (let i = 1; i < FS / 10; i++) {
      rigid.computeFree();
      hammer.interact(rigid);
      rigid.commit();
      const eta = hammer.compression;
      if (prevEta > 0 && eta <= 0 && tOut < 0) {
        tOut = (i - 1 + prevEta / (prevEta - eta)) / FS;
      }
      if (tOut >= 0 && i > tOut * FS + 4) {
        rebound = (hammer.displacement - last) * FS;
        break;
      }
      prevEta = eta;
      last = hammer.displacement;
    }
    const p = spec.exponent;
    const etaMax =
      (((p + 1) * spec.mass * spec.velocity ** 2) / (2 * spec.stiffness)) ** (1 / (p + 1));
    // integral_0^1 ds / sqrt(1 - s^(p+1)), by the substitution s = sin^(2/(p+1)) theta.
    let integral = 0;
    const steps = 200000;
    const e = 2 / (p + 1);
    for (let i = 0; i < steps; i++) {
      const theta = ((i + 0.5) / steps) * (Math.PI / 2);
      integral += e * Math.pow(Math.sin(theta), e - 1) * (Math.PI / 2 / steps);
    }
    const tc = (2 * etaMax * integral) / spec.velocity;
    expect(Math.abs(tOut - tIn - tc) / tc).toBeLessThan(0.01);
    // Energy-conserving collision: the hammer leaves at the impact speed.
    expect(Math.abs(Math.abs(rebound) - spec.velocity) / spec.velocity).toBeLessThan(1e-6);
    expect(rebound).toBeLessThan(0);
  });

  it('conserves total energy (string + hammer + felt) exactly when the string is lossless', () => {
    for (const preset of PRESETS) {
      const params = { ...presetString(preset), sigma0: 0, sigma1: 0 };
      const sim = makeString(params);
      const hammer = new Hammer(sim.string, hammerSpec(preset.strike));
      const energy = () => {
        const felt = 0.5 * (hammer.potential(hammer.compression) + hammer.potential(lastEta));
        return sim.string.energy() + hammer.kineticEnergy() + felt;
      };
      let lastEta = hammer.compression;
      const e0 = hammer.kineticEnergy();
      let drift = 0;
      for (let i = 0; i < FS / 20; i++) {
        sim.string.computeFree();
        lastEta = hammer.compression;
        hammer.interact(sim.string);
        sim.string.commit();
        drift = Math.max(drift, Math.abs(energy() - e0) / e0);
      }
      expect(hammer.contactSamples, preset.id).toBeGreaterThan(5);
      expect(drift, preset.id).toBeLessThan(1e-9);
    }
  });

  it('on a real string the hammer leaves, the string vibrates and nothing blows up', () => {
    for (const preset of PRESETS) {
      const params = presetString(preset);
      const sim = makeString(params);
      const hammer = new Hammer(sim.string, hammerSpec(preset.strike));
      for (let i = 0; i < FS / 5; i++) {
        sim.string.computeFree();
        if (!hammer.retired) hammer.interact(sim.string);
        sim.string.commit();
      }
      expect(hammer.contactSamples, preset.id).toBeGreaterThan(5);
      expect(hammer.retired, preset.id).toBe(true);
      const max = sim.string.maxAbs();
      expect(Number.isFinite(max)).toBe(true);
      expect(max).toBeGreaterThan(1e-6);
      expect(max).toBeLessThan(0.02);
    }
  });

  it('stays stable at the extremes of the interface ranges', () => {
    const params = presetString(PRESETS[1]); // the lightest string
    for (const mass of [0.0005, 0.02]) {
      for (const q0 of [2, 5000]) {
        for (const exponent of [2, 4.5]) {
          for (const velocity of [0.2, 6]) {
            const sim = makeString(params);
            const hammer = new Hammer(sim.string, {
              position: 0.5,
              mass,
              stiffness: feltStiffness(q0, exponent),
              exponent,
              velocity,
              width: 0.004,
            });
            for (let i = 0; i < FS / 20; i++) {
              sim.string.computeFree();
              if (!hammer.retired) hammer.interact(sim.string);
              sim.string.commit();
            }
            const max = sim.string.maxAbs();
            expect(Number.isFinite(max)).toBe(true);
            expect(max).toBeLessThan(0.1);
          }
        }
      }
    }
  });
});
