import { describe, expect, it } from 'vitest';
import { designGrid } from '../src/physics/grid.ts';
import { deriveString } from '../src/physics/materials.ts';
import { PRESETS, presetString } from '../src/physics/presets.ts';
import {
  cents,
  discreteFrequencyLossless,
  discreteMode,
  lossFromT60,
  partialDecayRate,
  partialFrequency,
  pluckDisplacementAmplitude,
  pluckOutputAmplitude,
  t60,
  t60AtFrequency,
  trianglePluckAmplitude,
  wavenumberSquared,
  widthFactor,
} from '../src/physics/theory.ts';

describe('theory', () => {
  it('stiff-string partials stretch as n f0 sqrt(1 + B n^2)', () => {
    expect(partialFrequency(1, 100, 0)).toBe(100);
    expect(partialFrequency(10, 27.5, 2e-4)).toBeCloseTo(275 * Math.sqrt(1.02), 10);
    // Piano A0 with B = 2e-4: partial 20 is two thirds of a semitone sharp of 20 f0.
    expect(cents(partialFrequency(20, 27.5, 2e-4), 20 * 27.5)).toBeCloseTo(66.6, 1);
  });

  it('the triangle-pluck amplitude formula vanishes at multiples of L/d', () => {
    for (const n of [3, 6, 9]) expect(trianglePluckAmplitude(n, 1 / 3, 0.002)).toBeCloseTo(0, 15);
    // and matches the normalised displacement amplitude used by the app (ideal, point pluck)
    const r1 = trianglePluckAmplitude(2, 0.2, 1) / trianglePluckAmplitude(1, 0.2, 1);
    const r2 = pluckDisplacementAmplitude(2, 0.2, 0, 0) / pluckDisplacementAmplitude(1, 0.2, 0, 0);
    expect(r1).toBeCloseTo(r2, 12);
  });

  it('the triangle series sums to the pluck height at the pluck point', () => {
    let sum = 0;
    for (let n = 1; n <= 20000; n++)
      sum += trianglePluckAmplitude(n, 0.3, 0.002) * Math.sin(n * Math.PI * 0.3);
    expect(sum).toBeCloseTo(0.002, 6);
  });

  it('the raised-cosine width factor is 1 for a point and rolls off with width', () => {
    expect(widthFactor(5, 0)).toBe(1);
    expect(widthFactor(1, 0.01)).toBeCloseTo(1, 3);
    expect(widthFactor(20, 0.05)).toBeLessThan(widthFactor(10, 0.05));
    // Continuous at the removable singularity a = pi (n w / L = 2).
    expect(widthFactor(40, 0.05)).toBeCloseTo(0.5, 6);
    expect(widthFactor(40, 0.05 + 1e-7)).toBeCloseTo(0.5, 4);
  });

  it('bridge-force amplitudes cancel the stiffness factor; pickups add their own comb', () => {
    const B = 0.01;
    const a = pluckOutputAmplitude(4, 0.8, 0, B, 'bridge', 0);
    expect(a).toBeCloseTo(Math.abs(Math.sin(4 * Math.PI * 0.8)) / 4, 12);
    expect(pluckOutputAmplitude(4, 0.8, 0, 0, 'pickup', 0.75)).toBeCloseTo(0, 12);
  });

  it('loss fitted from two decay times reproduces them', () => {
    const d = deriveString(presetString(PRESETS[0]));
    const { sigma0, sigma1 } = lossFromT60(82.4, 7, 2000, 1.1, d.c, d.kappa);
    expect(t60AtFrequency(82.4, d, sigma0, sigma1)).toBeCloseTo(7, 9);
    expect(t60AtFrequency(2000, d, sigma0, sigma1)).toBeCloseTo(1.1, 9);
    expect(t60(0)).toBe(Infinity);
  });

  it('wavenumberSquared inverts the dispersion relation', () => {
    const c = 120;
    const kappa = 0.8;
    const beta = 37;
    const omega = Math.sqrt(c * c * beta * beta + kappa * kappa * beta ** 4);
    expect(wavenumberSquared(omega, c, kappa)).toBeCloseTo(beta * beta, 8);
    expect(wavenumberSquared(omega, c, 0)).toBeCloseTo((omega / c) ** 2, 8);
  });

  it('the discrete mode analysis reduces to the lossless dispersion relation', () => {
    const p = presetString(PRESETS[4]);
    const d = deriveString(p);
    const g = designGrid({
      length: p.length,
      c: d.c,
      kappa: d.kappa,
      sigma1: 0,
      sampleRate: 48000,
    });
    for (const n of [1, 5, 50]) {
      const m = discreteMode(n, g, d, 0, 0);
      expect(m.frequency).toBeCloseTo(discreteFrequencyLossless(n, g), 8);
      expect(m.decay).toBeCloseTo(0, 12);
    }
    // the highest mode of a grid on the stability bound sits just below Nyquist
    const top = discreteFrequencyLossless(g.N - 1, g);
    expect(top).toBeLessThan(24000);
    expect(top).toBeGreaterThan(20000);
    expect(partialDecayRate(2, 1, 0.5, 0.01)).toBeCloseTo(0.5 + 0.01 * (2 * Math.PI) ** 2, 12);
  });
});

describe('parameter limits from the stability bound', () => {
  it('maxKappa and maxSigma1 sit exactly on the minimum-grid boundary', async () => {
    const { MIN_POINTS, maxKappa, maxSigma1, stabilityBound } =
      await import('../src/physics/grid.ts');
    const L = 0.648;
    const c = 427;
    const fs = 48000;
    const kappa = maxKappa(L, c, 0.001, fs);
    expect(stabilityBound(c, kappa, 0.001, 1 / fs)).toBeCloseTo(L / MIN_POINTS, 12);
    const s1 = maxSigma1(L, c, 0.5, fs);
    expect(stabilityBound(c, 0.5, s1, 1 / fs)).toBeCloseTo(L / MIN_POINTS, 12);
  });
});
