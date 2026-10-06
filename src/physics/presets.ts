/**
 * Instrument presets. Each preset fixes the length, material and gauge, tunes the tension to its
 * note, and derives sigma_0 and sigma_1 from two decay times (Bilbao's two-frequency fit).
 * Numbers and their sources are listed in the README ("Presets").
 */
import type { HammerSpec } from './excitation.ts';
import {
  deriveString,
  linearDensity,
  tensionForFrequency,
  type MaterialId,
  type StringParams,
} from './materials.ts';
import { lossFromT60 } from './theory.ts';

export type ExcitationKind = 'pluck' | 'strike';

export interface PluckSettings {
  /** Distance of the pluck point from the bridge, as a fraction of the length. */
  fromBridge: number;
  /** Contact width, m. */
  width: number;
  /** Displacement at the pluck point, m. */
  amplitude: number;
}

export interface StrikeSettings {
  /** Distance of the strike point from the bridge, as a fraction of the length. */
  fromBridge: number;
  /** Hammer mass, kg. */
  mass: number;
  /** Felt stiffness as the force at 1 mm compression, N (Stulov's Q0 in N/mm^p). */
  q0: number;
  /** Felt exponent p in F = Q0 (eta / 1 mm)^p. */
  exponent: number;
  /** Speed at impact, m/s. */
  velocity: number;
  /** Contact width, m. */
  width: number;
}

export interface Preset {
  id: string;
  name: string;
  /** Compact label for the preset chips (the note is shown next to it). */
  short: string;
  /** Short description of the string (gauge, construction, scale). */
  detail: string;
  /** Equal-tempered note the tension is tuned to. */
  note: string;
  frequency: number;
  length: number;
  material: MaterialId;
  diameter: number;
  /** Construction overrides (core fraction, effective density, core modulus). */
  coreRatio?: number;
  density?: number;
  youngsModulus?: number;
  /** Where the construction numbers come from. */
  source: string;
  /** Two decay times used to fit sigma_0 and sigma_1. */
  decay: { f1: number; t1: number; f2: number; t2: number };
  excitation: ExcitationKind;
  pluck: PluckSettings;
  strike: StrikeSettings;
  /** Pickup position as a fraction of the length from the bridge. */
  pickupFromBridge: number;
  /** Names of the two terminations, left (x = 0) and right (x = L). */
  ends: { left: string; right: string };
}

const INCH = 0.0254;

/** A light felt mallet for strings that are not usually struck. */
const mallet: StrikeSettings = {
  fromBridge: 0.125,
  mass: 0.003,
  q0: 40,
  exponent: 2.5,
  velocity: 1.5,
  width: 0.006,
};

export const PRESETS: readonly Preset[] = [
  {
    id: 'guitar-e2',
    name: 'Guitar E2',
    short: 'Guitar',
    detail: 'wound steel · 0.046″ · 25.5″ scale',
    note: 'E2',
    frequency: 82.4069,
    length: 25.5 * INCH,
    material: 'wound',
    diameter: 0.046 * INCH,
    source: "D'Addario NW046 (EXL110): 0.00038216 lb/in, 17.5 lb at E2 on 25.5″",
    decay: { f1: 82.4, t1: 7, f2: 2000, t2: 1.1 },
    excitation: 'pluck',
    pluck: { fromBridge: 0.2, width: 0.004, amplitude: 0.0025 },
    strike: { ...mallet, mass: 0.004 },
    pickupFromBridge: 0.1,
    ends: { left: 'Nut', right: 'Bridge' },
  },
  {
    id: 'guitar-e4',
    name: 'Guitar E4',
    short: 'Guitar',
    detail: 'plain steel · 0.010″ · 25.5″ scale',
    note: 'E4',
    frequency: 329.6276,
    length: 25.5 * INCH,
    material: 'steel',
    diameter: 0.01 * INCH,
    source: "D'Addario PL010 (EXL110): 0.00002215 lb/in, 16.2 lb at E4 on 25.5″",
    decay: { f1: 329.6, t1: 4, f2: 3000, t2: 0.9 },
    excitation: 'pluck',
    pluck: { fromBridge: 0.2, width: 0.003, amplitude: 0.0015 },
    strike: { ...mallet, mass: 0.002 },
    pickupFromBridge: 0.1,
    ends: { left: 'Nut', right: 'Bridge' },
  },
  {
    id: 'nylon-e4',
    name: 'Classical nylon',
    short: 'Nylon',
    detail: 'nylon E4 · 0.71 mm · 650 mm scale',
    note: 'E4',
    frequency: 329.6276,
    length: 0.65,
    material: 'nylon',
    diameter: 0.711e-3,
    source: "D'Addario EJ45 first string, 0.0280″ nylon, on a 650 mm classical scale",
    decay: { f1: 329.6, t1: 2.6, f2: 2000, t2: 0.45 },
    excitation: 'pluck',
    pluck: { fromBridge: 0.17, width: 0.009, amplitude: 0.002 },
    strike: { ...mallet, mass: 0.002, q0: 15 },
    pickupFromBridge: 0.1,
    ends: { left: 'Nut', right: 'Saddle' },
  },
  {
    id: 'bass-e1',
    name: 'Bass guitar E1',
    short: 'Bass',
    detail: 'wound steel · 0.100″ · 34″ scale',
    note: 'E1',
    frequency: 41.2034,
    length: 34 * INCH,
    material: 'wound',
    diameter: 0.1 * INCH,
    density: 6015,
    // Core fraction assumed (about a third of the outer diameter); not taken from a datasheet.
    coreRatio: 0.33,
    source:
      "D'Addario XLB100: 34.7 lb at E1 on a 34″ long scale (sets the effective density); core fraction 0.33 assumed",
    decay: { f1: 41.2, t1: 9, f2: 1000, t2: 1.4 },
    excitation: 'pluck',
    pluck: { fromBridge: 0.15, width: 0.01, amplitude: 0.003 },
    strike: { ...mallet, mass: 0.008 },
    pickupFromBridge: 0.12,
    ends: { left: 'Nut', right: 'Bridge' },
  },
  {
    id: 'piano-a0',
    name: 'Piano A0',
    short: 'Piano',
    detail: 'copper-wound steel · 1.35 m · lowest key',
    note: 'A0',
    frequency: 27.5,
    length: 1.35,
    material: 'wound',
    diameter: 5.6e-3,
    coreRatio: 0.25,
    density: 7024,
    youngsModulus: 195e9,
    source:
      'Yamaha G3 A0 (Podlesak & Lee, JASA 1988): core 1.4 mm, overall 5.6 mm, 1.35 m, 0.173 kg/m, E = 195 GPa',
    decay: { f1: 27.5, t1: 10, f2: 1000, t2: 2 },
    excitation: 'strike',
    pluck: { fromBridge: 0.5, width: 0.01, amplitude: 0.002 },
    // Stulov's fit for key 1: 11.0 g, Q0 = 191 N/mm^p, p = 3.72; struck at 1/8 from the agraffe.
    strike: {
      fromBridge: 1 - 1 / 8,
      mass: 0.011,
      q0: 191,
      exponent: 3.72,
      velocity: 2.5,
      width: 0.02,
    },
    pickupFromBridge: 0.1,
    ends: { left: 'Agraffe', right: 'Bridge' },
  },
  {
    id: 'harp-c4',
    name: 'Harp C4',
    short: 'Harp',
    detail: 'gut · 1.45 mm · 550 mm',
    note: 'C4',
    frequency: 261.6256,
    length: 0.55,
    material: 'gut',
    diameter: 1.45e-3,
    source: 'Bow Brand pedal gut (Cecilia 46): C4 at 550 mm, 1.45 mm, about 181 N',
    decay: { f1: 261.6, t1: 4, f2: 2000, t2: 0.6 },
    excitation: 'pluck',
    pluck: { fromBridge: 0.5, width: 0.012, amplitude: 0.003 },
    strike: { ...mallet },
    pickupFromBridge: 0.1,
    ends: { left: 'Neck', right: 'Soundboard' },
  },
  {
    id: 'violin-a4',
    name: 'Violin pizzicato',
    short: 'Violin pizz.',
    detail: 'gut A4 · 0.80 mm · 328 mm',
    note: 'A4',
    frequency: 440,
    length: 0.328,
    material: 'gut',
    diameter: 0.8e-3,
    source: 'Typical plain-gut violin A (0.80 mm assumed) on a 328 mm string length',
    decay: { f1: 440, t1: 0.9, f2: 3000, t2: 0.2 },
    excitation: 'pluck',
    pluck: { fromBridge: 0.2, width: 0.008, amplitude: 0.0015 },
    strike: { ...mallet, mass: 0.002 },
    pickupFromBridge: 0.1,
    ends: { left: 'Nut', right: 'Bridge' },
  },
];

export const DEFAULT_PRESET_ID = 'guitar-e2';

export function presetById(id: string): Preset {
  const p = PRESETS.find((x) => x.id === id);
  if (!p) throw new Error(`Unknown preset ${id}`);
  return p;
}

/** String parameters of a preset: tension tuned to the note, losses fitted to the decay times. */
export function presetString(preset: Preset): StringParams {
  const base = {
    length: preset.length,
    material: preset.material,
    diameter: preset.diameter,
    coreRatio: preset.coreRatio,
    density: preset.density,
    youngsModulus: preset.youngsModulus,
  };
  const mu = linearDensity(base);
  const tension = tensionForFrequency(mu, preset.length, preset.frequency);
  const lossless: StringParams = { ...base, tension, sigma0: 0, sigma1: 0 };
  const physics = deriveString(lossless);
  const { f1, t1, f2, t2 } = preset.decay;
  const { sigma0, sigma1 } = lossFromT60(f1, t1, f2, t2, physics.c, physics.kappa);
  return { ...lossless, sigma0, sigma1 };
}

/** Pluck spec (fraction from the nut) for the scheme. */
export function pluckSpec(p: PluckSettings) {
  return { position: 1 - p.fromBridge, width: p.width, amplitude: p.amplitude };
}

/** Felt stiffness K (N / m^p) from Stulov's Q0 (N / mm^p). */
export function feltStiffness(q0: number, exponent: number): number {
  return q0 * 1000 ** exponent;
}

export function hammerSpec(s: StrikeSettings): HammerSpec {
  return {
    position: 1 - s.fromBridge,
    mass: s.mass,
    stiffness: feltStiffness(s.q0, s.exponent),
    exponent: s.exponent,
    velocity: s.velocity,
    width: s.width,
  };
}
