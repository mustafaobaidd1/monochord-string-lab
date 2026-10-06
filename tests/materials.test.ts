import { describe, expect, it } from 'vitest';
import {
  MATERIALS,
  deriveString,
  effectiveModulus,
  inharmonicitySolidWire,
  linearDensity,
  tensionForFrequency,
} from '../src/physics/materials.ts';
import { PRESETS, presetString } from '../src/physics/presets.ts';

const INCH = 0.0254;
const LB_PER_INCH = 0.45359237 / INCH; // lb/in -> kg/m
const LBF = 4.4482216152605;
const SCALE = 25.5 * INCH;

/** D'Addario unit weights and tensions on a 25.5 in scale (tension chart 13934). */
const DADDARIO = [
  { item: 'PL010', material: 'steel', d: 0.01, uw: 0.00002215, lb: 16.2, f: 329.6276 },
  { item: 'PL013', material: 'steel', d: 0.013, uw: 0.00003744, lb: 15.4, f: 246.9417 },
  { item: 'PL017', material: 'steel', d: 0.017, uw: 0.00006402, lb: 16.6, f: 195.9977 },
  { item: 'NW046', material: 'wound', d: 0.046, uw: 0.00038216, lb: 17.5, f: 82.4069 },
] as const;

describe('materials', () => {
  it.each(DADDARIO)("$item: linear density matches D'Addario's unit weight within 1.5 %", (row) => {
    const mu = linearDensity({ material: row.material, diameter: row.d * INCH });
    const published = row.uw * LB_PER_INCH;
    expect(Math.abs(mu - published) / published).toBeLessThan(0.015);
  });

  it.each(DADDARIO)("$item: tension at pitch matches D'Addario's chart within 1.5 %", (row) => {
    const mu = linearDensity({ material: row.material, diameter: row.d * INCH });
    const T = tensionForFrequency(mu, SCALE, row.f);
    expect(Math.abs(T - row.lb * LBF) / (row.lb * LBF)).toBeLessThan(0.015);
  });

  it("D'Addario's formula T = UW (2 L F)^2 / 386.4 is the same law as T = mu (2 L f)^2", () => {
    const row = DADDARIO[3];
    const tLb = (row.uw * (2 * 25.5 * row.f) ** 2) / 386.4;
    expect(tLb).toBeCloseTo(row.lb, 1);
  });

  it('B for solid wire equals pi^3 E d^4 / (64 T L^2)', () => {
    const p = {
      length: 0.65,
      tension: 70,
      material: 'steel' as const,
      diameter: 0.3e-3,
      sigma0: 0,
      sigma1: 0,
    };
    const d = deriveString(p);
    const closed = inharmonicitySolidWire(MATERIALS.steel.youngsModulus, 0.3e-3, 70, 0.65);
    expect(d.B).toBeCloseTo(closed, 14);
    expect(d.f0).toBeCloseTo(Math.sqrt(70 / d.mu) / 1.3, 10);
  });

  // Measured averages over 13 guitars: Barbancho et al., IEEE TASLP 20(10), 2012.
  it('the wound E2 preset has B close to the 1.56e-4 measured on electric guitars', () => {
    const d = deriveString(presetString(PRESETS.find((p) => p.id === 'guitar-e2')!));
    expect(Math.abs(d.B - 1.56e-4) / 1.56e-4).toBeLessThan(0.1);
  });

  it('the plain E4 preset has B close to the 1.50e-5 measured on electric guitars', () => {
    const d = deriveString(presetString(PRESETS.find((p) => p.id === 'guitar-e4')!));
    expect(Math.abs(d.B - 1.5e-5) / 1.5e-5).toBeLessThan(0.1);
  });

  it('the nylon E4 preset has B close to the 4.07e-5 measured on classical guitars', () => {
    const d = deriveString(presetString(PRESETS.find((p) => p.id === 'nylon-e4')!));
    expect(Math.abs(d.B - 4.07e-5) / 4.07e-5).toBeLessThan(0.15);
  });

  it('the piano A0 preset reproduces the Yamaha G3 string (Podlesak & Lee 1988)', () => {
    const params = presetString(PRESETS.find((p) => p.id === 'piano-a0')!);
    const d = deriveString(params);
    expect(d.mu).toBeCloseTo(0.173, 3);
    expect(params.tension).toBeGreaterThan(900);
    expect(params.tension).toBeLessThan(1000);
    // B of about 2e-4, as measured on concert grands at A0 (DAFx-04) and derived for the G3.
    expect(d.B).toBeGreaterThan(1.8e-4);
    expect(d.B).toBeLessThan(2.4e-4);
  });

  it('nylon stiffens under tension (bending modulus 4.5 GPa + 39 sigma)', () => {
    const base = presetString(PRESETS.find((p) => p.id === 'nylon-e4')!);
    const area = (Math.PI * base.diameter ** 2) / 4;
    expect(effectiveModulus(base)).toBeCloseTo(4.5e9 + 39 * (base.tension / area), 0);
    expect(effectiveModulus({ ...base, tension: 1e-9 })).toBeCloseTo(4.5e9, -3);
    expect(effectiveModulus({ ...base, material: 'gut' })).toBe(6e9);
  });

  it('an inharmonicity override sets EI so that B takes the requested value', () => {
    const base = presetString(PRESETS[0]);
    const d = deriveString({ ...base, inharmonicity: 0.01 });
    expect(d.B).toBeCloseTo(0.01, 12);
    expect(d.materialB).toBeCloseTo(deriveString(base).B, 12);
    expect(deriveString({ ...base, inharmonicity: 0 }).kappa).toBe(0);
  });

  it('every preset is tuned to its note', () => {
    for (const preset of PRESETS) {
      const d = deriveString(presetString(preset));
      expect(d.f0).toBeCloseTo(preset.frequency, 8);
    }
  });
});
