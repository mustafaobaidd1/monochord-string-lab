/**
 * Validation of the finite-difference string against theory (the targets in the project brief).
 * References: S. Bilbao, Numerical Sound Synthesis (Wiley 2009), ch. 7 (scheme, stability,
 * energy); H. Fletcher, JASA 36, 203 (1964) (stiff-string partials); the plucked-string modal
 * amplitudes A_n ~ sin(n pi d / L) / n^2 (e.g. D. Russell, Acoustics and Vibration Animations,
 * Penn State).
 */
import { describe, expect, it } from 'vitest';
import { estimateFundamental, measurePartials, spectrumOf } from '../src/dsp/analysis.ts';
import { MAX_POINTS, designGrid, stabilityBound } from '../src/physics/grid.ts';
import { linearDensity, tensionForFrequency, type StringParams } from '../src/physics/materials.ts';
import { PRESETS, presetString } from '../src/physics/presets.ts';
import { StiffString } from '../src/physics/scheme.ts';
import { cents, discreteMode, partialFrequency } from '../src/physics/theory.ts';
import { FS, makeString, pluck, runBridge, slope } from './helpers.ts';

/** A near-ideal string: nylon E4 with the stiffness switched off and no loss. */
function idealString(frequency: number, length = 0.65): StringParams {
  const base = { length, material: 'nylon' as const, diameter: 0.71e-3 };
  const tension = tensionForFrequency(linearDensity(base), length, frequency);
  return { ...base, tension, sigma0: 0, sigma1: 0, inharmonicity: 0 };
}

describe('fundamental frequency', () => {
  it.each([
    [82.4069, 0.65],
    [196, 0.65],
    [329.6276, 0.65],
    [440, 0.328],
  ])(
    'measured f0 of a near-ideal string at %f Hz is within 2 cents of (1/2L) sqrt(T/mu)',
    (f, L) => {
      const sim = makeString(idealString(f, L));
      expect(sim.physics.f0).toBeCloseTo(f, 9);
      pluck(sim, { position: 0.8, width: 0, amplitude: 0.002 });
      const out = runBridge(sim, FS);
      const peak = estimateFundamental(spectrumOf(out, FS, { zeroPad: 8 }));
      expect(peak).not.toBeNull();
      const deviation = cents(peak!.frequency, f);
      expect(Math.abs(deviation)).toBeLessThan(2);
      // In practice the interpolated FFT peak lands within a hundredth of a cent.
      expect(Math.abs(deviation)).toBeLessThan(0.05);
    },
  );

  it('is also correct at 44.1 kHz', () => {
    const sim = makeString(idealString(110), 44100);
    pluck(sim, { position: 0.75, width: 0, amplitude: 0.002 });
    const out = runBridge(sim, 44100);
    const peak = estimateFundamental(spectrumOf(out, 44100, { zeroPad: 8 }));
    expect(Math.abs(cents(peak!.frequency, 110))).toBeLessThan(0.05);
  });
});

describe('stiff string partials', () => {
  for (const id of ['piano-a0', 'guitar-e2', 'bass-e1']) {
    it(`${id}: first 10 partials follow n f0 sqrt(1 + B n^2) within the scheme's numerical dispersion`, () => {
      const params = { ...presetString(PRESETS.find((p) => p.id === id)!), sigma0: 0, sigma1: 0 };
      const sim = makeString(params);
      // Pluck at an irrational-ish point so no partial among the first 10 is suppressed.
      pluck(sim, { position: 0.137, width: 0, amplitude: 0.002 });
      const seconds = sim.physics.f0 < 40 ? 2 : 1;
      const out = runBridge(sim, FS * seconds);
      const s = spectrumOf(out, FS, { zeroPad: 8 });
      const predicted = Array.from({ length: 10 }, (_, i) =>
        partialFrequency(i + 1, sim.physics.f0, sim.physics.B),
      );
      const measured = measurePartials(s, predicted);
      for (const m of measured) {
        const disc = discreteMode(m.n, sim.grid, sim.physics, 0, 0).frequency;
        // 1. The simulation obeys its own discrete dispersion relation almost exactly.
        expect(Math.abs(cents(m.measured!, disc))).toBeLessThan(0.05);
        // 2. That relation stays close to the continuous stiff-string law; the gap is the
        //    scheme's numerical dispersion, which grows like n^2 and is reported in the README.
        const dispersion = cents(disc, m.predicted);
        expect(Math.abs(cents(m.measured!, m.predicted) - dispersion)).toBeLessThan(0.05);
        expect(Math.abs(cents(m.measured!, m.predicted))).toBeLessThan(2.5);
      }
      // The inharmonic stretch itself is resolved: partial 10 sits above 10 f0 by the predicted amount.
      const stretch = cents(measured[9].measured!, 10 * sim.physics.f0);
      const expected = cents(predicted[9], 10 * sim.physics.f0);
      expect(Math.abs(stretch - expected)).toBeLessThan(2.5);
    });
  }
});

describe('pluck position', () => {
  it('a pluck at L/3 leaves partials 3, 6 and 9 at least 40 dB below their neighbours', () => {
    const params = { ...presetString(PRESETS[0]), sigma0: 0, sigma1: 0 };
    const sim = makeString(params);
    pluck(sim, { position: 1 - 1 / 3, width: 0, amplitude: 0.002 });
    const out = runBridge(sim, FS);
    const s = spectrumOf(out, FS, { zeroPad: 4 });
    const predicted = Array.from({ length: 10 }, (_, i) =>
      partialFrequency(i + 1, sim.physics.f0, sim.physics.B),
    );
    const m = measurePartials(s, predicted);
    const level = (n: number) => m[n - 1].level ?? -400;
    for (const n of [3, 6, 9]) {
      expect(level(n - 1) - level(n)).toBeGreaterThan(40);
      expect(level(n + 1) - level(n)).toBeGreaterThan(40);
    }
  });

  it('bridge-force partials follow |sin(n pi x0 / L)| / n for a point pluck', () => {
    const params = { ...presetString(PRESETS[1]), sigma0: 0, sigma1: 0 };
    const sim = makeString(params);
    const x0 = 0.8;
    pluck(sim, { position: x0, width: 0, amplitude: 0.001 });
    const out = runBridge(sim, FS);
    const s = spectrumOf(out, FS, { zeroPad: 4 });
    const predicted = Array.from({ length: 8 }, (_, i) =>
      partialFrequency(i + 1, sim.physics.f0, sim.physics.B),
    );
    const m = measurePartials(s, predicted);
    const ref = Math.abs(Math.sin(Math.PI * x0));
    for (const n of [2, 3, 4, 6, 7]) {
      const expectedDb = 20 * Math.log10(Math.abs(Math.sin(n * Math.PI * x0)) / n / ref);
      expect(Math.abs(m[n - 1].level! - m[0].level! - expectedDb)).toBeLessThan(0.5);
    }
  });
});

describe('energy', () => {
  for (const preset of PRESETS) {
    it(`${preset.id}: the lossless scheme conserves the discrete energy to machine precision`, () => {
      const params = { ...presetString(preset), sigma0: 0, sigma1: 0 };
      const sim = makeString(params);
      pluck(sim, { position: 0.71, width: 0.005, amplitude: 0.002 });
      const e0 = sim.string.energy();
      let drift = 0;
      for (let i = 0; i < FS / 2; i++) {
        sim.string.step();
        if (i % 50 === 0) drift = Math.max(drift, Math.abs(sim.string.energy() - e0) / e0);
      }
      expect(drift).toBeLessThan(1e-11);
    });
  }

  it('with sigma_0 only, the energy decays at 2 sigma_0 (amplitude at sigma_0)', () => {
    const sigma0 = 1.3;
    const params = { ...presetString(PRESETS[0]), sigma0, sigma1: 0 };
    const sim = makeString(params);
    pluck(sim, { position: 0.8, width: 0.004, amplitude: 0.002 });
    const t: number[] = [];
    const logE: number[] = [];
    for (let i = 1; i <= FS; i++) {
      sim.string.step();
      if (i % 240 === 0) {
        t.push(i / FS);
        logE.push(Math.log(sim.string.energy()));
      }
    }
    const measured = -slope(t, logE) / 2;
    expect(Math.abs(measured - sigma0) / sigma0).toBeLessThan(0.005);
  });

  it('with sigma_1, each partial decays at sigma_0 + sigma_1 (n pi / L)^2', () => {
    const sigma0 = 0.4;
    const sigma1 = 0.004;
    const params = { ...presetString(PRESETS[1]), sigma0, sigma1 };
    const sim = makeString(params);
    pluck(sim, { position: 0.73, width: 0, amplitude: 0.001 });
    const modes = [1, 2, 4, 7];
    const traces = modes.map(() => new Float64Array(FS / 2));
    for (let i = 0; i < FS / 2; i++) {
      sim.string.step();
      modes.forEach((p, j) => (traces[j][i] = sim.string.modalAmplitude(p)));
    }
    modes.forEach((p, j) => {
      // Decay rate from the peak envelope of the modal coordinate (local maxima of |q|).
      const q = traces[j];
      const t: number[] = [];
      const logPeak: number[] = [];
      for (let i = 1; i < q.length - 1; i++) {
        const a = Math.abs(q[i]);
        if (a > Math.abs(q[i - 1]) && a >= Math.abs(q[i + 1])) {
          t.push(i / FS);
          logPeak.push(Math.log(a));
        }
      }
      const measured = -slope(t, logPeak);
      const beta = (p * Math.PI) / params.length;
      const continuous = sigma0 + sigma1 * beta * beta;
      const discrete = discreteMode(p, sim.grid, sim.physics, sigma0, sigma1).decay;
      expect(Math.abs(discrete - continuous) / continuous).toBeLessThan(0.01);
      expect(Math.abs(measured - continuous) / continuous).toBeLessThan(0.01);
    });
  });
});

describe('stability', () => {
  it('every preset satisfies the stability bound and stays bounded for 2 s', () => {
    for (const preset of PRESETS) {
      const params = presetString(preset);
      const sim = makeString(params);
      const { grid } = sim;
      expect(grid.h).toBeGreaterThanOrEqual(grid.hMin);
      expect(grid.stabilityNumber).toBeLessThanOrEqual(1);
      expect(grid.N).toBeLessThanOrEqual(MAX_POINTS);
      pluck(sim, { position: 0.8, width: 0.004, amplitude: 0.003 });
      const startMax = sim.string.maxAbs();
      let max = 0;
      for (let i = 0; i < 2 * FS; i++) {
        sim.string.step();
        if (i % 97 === 0) max = Math.max(max, sim.string.maxAbs());
      }
      expect(Number.isFinite(max)).toBe(true);
      // Displacement can exceed the initial pluck only by the usual wave superposition factor.
      expect(max).toBeLessThan(2 * startMax);
    }
  });

  it('random parameter sets inside the interface ranges always produce a stable grid', () => {
    let seed = 12345;
    const rand = () => {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      return seed / 4294967296;
    };
    for (let trial = 0; trial < 300; trial++) {
      const params: StringParams = {
        length: 0.25 + rand() * 1.95,
        tension: 5 * Math.pow(500, rand()),
        material: (['steel', 'nylon', 'gut', 'wound'] as const)[Math.floor(rand() * 4)],
        diameter: 0.2e-3 + rand() * 2.5e-3,
        sigma0: rand() * 6,
        sigma1: rand() * 0.03,
        inharmonicity: rand() < 0.3 ? rand() * 0.02 : null,
      };
      let sim;
      try {
        sim = makeString(params);
      } catch {
        continue; // the interface refuses parameter sets with too few stable grid points
      }
      expect(sim.grid.h).toBeGreaterThanOrEqual(
        stabilityBound(sim.physics.c, sim.physics.kappa, params.sigma1, 1 / FS),
      );
      pluck(sim, { position: rand() * 0.9 + 0.05, width: rand() * 0.01, amplitude: 0.002 });
      for (let i = 0; i < 4000; i++) sim.string.step();
      expect(Number.isFinite(sim.string.maxAbs())).toBe(true);
      expect(sim.string.maxAbs()).toBeLessThan(0.01);
    }
  });

  it('a grid just below the bound blows up (the bound is sharp)', () => {
    const params = { ...presetString(PRESETS[1]), sigma0: 0, sigma1: 0 };
    const sim = makeString(params);
    const unstable = designGrid(
      {
        length: params.length,
        c: sim.physics.c,
        kappa: sim.physics.kappa,
        sigma1: 0,
        sampleRate: FS,
      },
      10_000,
    );
    // Force one more interval than the bound allows.
    const N = unstable.N + 1;
    const h = params.length / N;
    const grid = {
      ...unstable,
      N,
      h,
      lambda: (sim.physics.c * unstable.k) / h,
      nu: (sim.physics.kappa * unstable.k) / (h * h),
    };
    expect(grid.h).toBeLessThan(grid.hMin);
    const unstableSim = { ...sim, grid, string: new StiffString(params, sim.physics, grid) };
    pluck(unstableSim, { position: 0.8, width: 0, amplitude: 0.001 });
    let max = 0;
    for (let i = 0; i < FS; i++) {
      unstableSim.string.step();
      max = Math.max(max, Math.abs(unstableSim.string.at(N >> 1)));
      if (!Number.isFinite(max) || max > 1) break;
    }
    expect(!Number.isFinite(max) || max > 1).toBe(true);
  });
});
