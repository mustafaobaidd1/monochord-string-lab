/**
 * Every slider in one table: range, scale, formatting and, at the ends of each range, the reason
 * the range stops there (stability of the scheme, or the realism of the linear model).
 */
import { MIN_POINTS, maxKappa, maxSigma1 } from '../physics/grid.ts';
import { MATERIALS } from '../physics/materials.ts';
import { t60AtFrequency } from '../physics/theory.ts';
import { hz, mm, ratio, sci, sig3 } from './format.ts';
import { pitchLabel, stringInfo, type AppState, type StringInfo } from './state.ts';

export interface ParamContext {
  state: AppState;
  info: StringInfo;
  sampleRate: number;
}

export type Scale = 'linear' | 'log' | 'log0';

export interface ParamDef {
  key: string;
  label: string;
  scale: Scale;
  range(ctx: ParamContext): [number, number];
  get(s: AppState, ctx: ParamContext): number;
  set(s: AppState, v: number): void;
  format(v: number, ctx: ParamContext): string;
  /** Words for screen readers (defaults to `format`). */
  spoken?(v: number, ctx: ParamContext): string;
  /** Explanation shown when the value sits at an end of its range. */
  limit?(end: 'min' | 'max', ctx: ParamContext): string;
  /** A warning that applies inside the range (for example, beyond the breaking load). */
  warn?(v: number, ctx: ParamContext): string | null;
  /** Live parameters change the sound immediately instead of re-exciting the string. */
  live?: boolean;
  /** String parameters mark the state as customised. */
  string?: boolean;
}

export const SLIDER_STEPS = 1000;
const LOG0_ZERO = 0.02; // fraction of the slider reserved for an exact zero

export function toSlider(def: ParamDef, v: number, range: [number, number]): number {
  const [lo, hi] = range;
  let t: number;
  if (def.scale === 'linear') t = (v - lo) / (hi - lo);
  else if (def.scale === 'log') t = Math.log(v / lo) / Math.log(hi / lo);
  else {
    const min = LOG0_MIN[def.key] ?? 1e-6;
    if (v <= 0) t = 0;
    else t = LOG0_ZERO + (1 - LOG0_ZERO) * (Math.log(Math.max(v, min) / min) / Math.log(hi / min));
  }
  return Math.round(Math.min(1, Math.max(0, t)) * SLIDER_STEPS);
}

export function fromSlider(def: ParamDef, step: number, range: [number, number]): number {
  const [lo, hi] = range;
  const t = Math.min(1, Math.max(0, step / SLIDER_STEPS));
  if (def.scale === 'linear') return lo + t * (hi - lo);
  if (def.scale === 'log') return lo * (hi / lo) ** t;
  if (t < LOG0_ZERO / 2) return 0;
  const min = LOG0_MIN[def.key] ?? 1e-6;
  const u = Math.max(0, (t - LOG0_ZERO) / (1 - LOG0_ZERO));
  return min * (hi / min) ** u;
}

const LOG0_MIN: Record<string, number> = {
  'string.inharmonicity': 1e-6,
  'string.sigma1': 1e-5,
};

const inch = (m: number) => `${(m / 0.0254).toFixed(3).replace(/^0/, '')}″`;

/** Largest B for which a grid of MIN_POINTS intervals is still stable, capped at 0.05. */
export function maxInharmonicity(ctx: ParamContext): number {
  const { state, info, sampleRate } = ctx;
  const { length: L, sigma1 } = state.string;
  const kmax = maxKappa(L, info.physics.c, sigma1, sampleRate);
  const bmax = (kmax * kmax * Math.PI * Math.PI) / (info.physics.c ** 2 * L * L);
  return Math.min(0.05, bmax * 0.98);
}

export function maxLoss(ctx: ParamContext): number {
  const { state, info, sampleRate } = ctx;
  return Math.min(
    0.05,
    0.98 * maxSigma1(state.string.length, info.physics.c, info.physics.kappa, sampleRate),
  );
}

export const PARAMS: ParamDef[] = [
  {
    key: 'string.diameter',
    label: 'Diameter',
    scale: 'log',
    string: true,
    range: (ctx) => [...MATERIALS[ctx.state.string.material].diameterRange],
    get: (s) => s.string.diameter,
    set: (s, v) => (s.string.diameter = v),
    format: (v, ctx) =>
      ctx.state.string.material === 'steel' || ctx.state.string.material === 'wound'
        ? `${mm(v)} · ${inch(v)}`
        : mm(v),
    limit: (end, ctx) => {
      const m = MATERIALS[ctx.state.string.material];
      const [lo, hi] = m.diameterRange;
      return `${end === 'min' ? 'Thinnest' : 'Thickest'} realistic gauge for ${m.label.toLowerCase()} in this model (${mm(lo)}–${mm(hi)}).`;
    },
  },
  {
    key: 'string.length',
    label: 'Length',
    scale: 'linear',
    string: true,
    range: () => [0.25, 2],
    get: (s) => s.string.length,
    set: (s, v) => (s.string.length = v),
    format: (v) => (v >= 1 ? `${v.toFixed(3)} m` : mm(v)),
    limit: (end) =>
      end === 'min'
        ? 'Shorter strings exist (a violin E is 33 cm), but below 25 cm stiff strings run out of stable grid points.'
        : 'Two metres is about the longest bass string of a concert grand.',
  },
  {
    key: 'string.tension',
    label: 'Tension',
    scale: 'log',
    string: true,
    range: () => [5, 3000],
    get: (s) => s.string.tension,
    set: (s, v) => (s.string.tension = v),
    format: (v, ctx) => {
      const f0 = Math.sqrt(v / ctx.info.physics.mu) / (2 * ctx.state.string.length);
      return `${sig3(v)} N · ${hz(f0)} (${pitchLabel(f0)})`;
    },
    spoken: (v, ctx) => {
      const f0 = Math.sqrt(v / ctx.info.physics.mu) / (2 * ctx.state.string.length);
      return `${sig3(v)} newtons, fundamental ${hz(f0)}`;
    },
    limit: (end) =>
      end === 'min'
        ? 'Below 5 N a string is too slack to hold a pitch.'
        : 'Three kilonewtons covers every instrument string; piano bass strings carry about one.',
    warn: (v, ctx) => {
      const b = ctx.info.physics.breakingLoad;
      return v > b
        ? `Beyond the breaking load (≈${sig3(b)} N for this core): a real string would snap. The model keeps going.`
        : null;
    },
  },
  {
    key: 'string.inharmonicity',
    label: 'Stiffness <span class="sym">B</span>',
    scale: 'log0',
    string: true,
    range: (ctx) => [0, maxInharmonicity(ctx)],
    get: (s, ctx) => s.string.inharmonicity ?? ctx.info.physics.materialB,
    set: (s, v) => (s.string.inharmonicity = v),
    format: (v, ctx) =>
      `${v === 0 ? '0 (ideal string)' : sci(v)}${ctx.state.string.inharmonicity == null ? ' · material' : ''}`,
    spoken: (v) => (v === 0 ? 'zero, an ideal string' : `B equals ${sci(v)}`),
    limit: (end, ctx) =>
      end === 'min'
        ? 'B = 0 is the ideal, perfectly flexible string: all partials are exact harmonics.'
        : maxInharmonicity(ctx) < 0.05 * 0.99
          ? `Limited by stability: stiffer than this, the bound h ≥ h_min leaves fewer than ${MIN_POINTS} grid intervals.`
          : 'At B = 0.05 the string already behaves like a metal bar; the thin-string model stops being realistic.',
  },
  {
    key: 'string.sigma0',
    label: 'Damping <span class="sym">σ</span><sub>0</sub>',
    scale: 'linear',
    string: true,
    range: () => [0, 10],
    get: (s) => s.string.sigma0,
    set: (s, v) => (s.string.sigma0 = v),
    format: (v) => `${v.toFixed(2)} s⁻¹`,
    spoken: (v) => `${v.toFixed(2)} per second`,
    limit: (end) =>
      end === 'min'
        ? 'σ₀ = 0: no frequency-independent loss (air and the bridge still lose energy in reality).'
        : 'Above 10 s⁻¹ even the fundamental dies within 0.7 s: a thud rather than a note.',
  },
  {
    key: 'string.sigma1',
    label: 'Damping <span class="sym">σ</span><sub>1</sub>',
    scale: 'log0',
    string: true,
    range: (ctx) => [0, maxLoss(ctx)],
    get: (s) => s.string.sigma1,
    set: (s, v) => (s.string.sigma1 = v),
    format: (v) => (v === 0 ? '0 m²/s' : `${sci(v)} m²/s`),
    spoken: (v) => `${sci(v)} square metres per second`,
    limit: (end, ctx) =>
      end === 'min'
        ? 'σ₁ = 0: every partial decays at the same rate.'
        : maxLoss(ctx) < 0.05 * 0.99
          ? `Limited by stability: σ₁ enlarges h_min, and beyond this fewer than ${MIN_POINTS} grid intervals remain.`
          : 'Above 0.05 m²/s the upper partials vanish almost instantly: a muffled, felt-like tone.',
  },
  {
    key: 'pluck.fromBridge',
    label: 'Position',
    scale: 'linear',
    range: () => [0.02, 0.98],
    get: (s) => s.pluck.fromBridge,
    set: (s, v) => (s.pluck.fromBridge = v),
    format: (v, ctx) =>
      `${mm(v * ctx.state.string.length)} from the bridge · ${ratio(Math.min(v, 1 - v))}`,
    limit: () =>
      'Closer than 2 % of the length to either end, the pluck lands on the last few grid points.',
  },
  {
    key: 'pluck.width',
    label: 'Finger width',
    scale: 'linear',
    range: () => [0, 0.02],
    get: (s) => s.pluck.width,
    set: (s, v) => (s.pluck.width = v),
    format: (v) => (v < 0.0002 ? 'point (plectrum edge)' : mm(v)),
    limit: (end) =>
      end === 'min'
        ? 'A point pluck: the ideal triangle, brightest possible.'
        : 'Twenty millimetres, a broad fingertip: it rounds the corner and softens the top.',
  },
  {
    key: 'pluck.amplitude',
    label: 'Amplitude',
    scale: 'linear',
    range: () => [0.0002, 0.006],
    get: (s) => s.pluck.amplitude,
    set: (s, v) => (s.pluck.amplitude = v),
    format: (v) => mm(v),
    limit: (end) =>
      end === 'min'
        ? 'A fifth of a millimetre: barely audible.'
        : 'Bigger plucks stretch a real string and raise its pitch (tension modulation); this linear model ignores that.',
  },
  {
    key: 'strike.fromBridge',
    label: 'Position',
    scale: 'linear',
    range: () => [0.02, 0.98],
    get: (s) => s.strike.fromBridge,
    set: (s, v) => (s.strike.fromBridge = v),
    format: (v, ctx) =>
      `${mm(v * ctx.state.string.length)} from the bridge · ${ratio(Math.min(v, 1 - v))}`,
    limit: () => 'The hammer must land at least 2 % of the length away from either end.',
  },
  {
    key: 'strike.velocity',
    label: 'Hammer speed',
    scale: 'log',
    range: () => [0.2, 6],
    get: (s) => s.strike.velocity,
    set: (s, v) => (s.strike.velocity = v),
    format: (v) => `${v.toFixed(v < 1 ? 2 : 1)} m/s`,
    spoken: (v) => `${v.toFixed(1)} metres per second`,
    limit: (end) =>
      end === 'min'
        ? 'A pianissimo piano hammer moves at about 0.5 m/s.'
        : 'A fortissimo piano hammer reaches about 4–5 m/s.',
  },
  {
    key: 'strike.mass',
    label: 'Hammer mass',
    scale: 'log',
    range: () => [0.0005, 0.02],
    get: (s) => s.strike.mass,
    set: (s, v) => (s.strike.mass = v),
    format: (v) => `${(v * 1000).toFixed(v < 0.01 ? 1 : 0)} g`,
    limit: (end) =>
      end === 'min'
        ? 'Half a gram: a light dulcimer-style beater.'
        : 'Twenty grams is heavier than any piano hammer (bass hammers weigh about 11 g).',
  },
  {
    key: 'strike.q0',
    label: 'Felt stiffness',
    scale: 'log',
    range: () => [2, 5000],
    get: (s) => s.strike.q0,
    set: (s, v) => (s.strike.q0 = v),
    format: (v) => `${sig3(v)} N at 1 mm`,
    spoken: (v) => `${sig3(v)} newtons at one millimetre of compression`,
    limit: (end) =>
      end === 'min'
        ? 'Very soft felt: long contact, a dull thump.'
        : 'Nearly hard: a short, bright click.',
  },
  {
    key: 'strike.exponent',
    label: 'Felt exponent <span class="sym">p</span>',
    scale: 'linear',
    range: () => [1.5, 4.5],
    get: (s) => s.strike.exponent,
    set: (s, v) => (s.strike.exponent = v),
    format: (v) => `p = ${v.toFixed(2)}`,
    limit: (end) =>
      end === 'min'
        ? 'Nearly linear felt (p ≈ 1.5).'
        : 'Strongly hardening felt; fits to real piano hammers give p ≈ 2–4.3.',
  },
  {
    key: 'output.pickupFromBridge',
    label: 'Pickup position',
    scale: 'linear',
    live: true,
    range: () => [0.02, 0.5],
    get: (s) => s.output.pickupFromBridge,
    set: (s, v) => (s.output.pickupFromBridge = v),
    format: (v, ctx) => `${mm(v * ctx.state.string.length)} from the bridge · ${ratio(v)}`,
    limit: (end) =>
      end === 'min'
        ? 'A pickup almost on the bridge hears mostly the high partials: thin and bright.'
        : 'At the midpoint the pickup sits on a node of every even partial.',
  },
  {
    key: 'volume',
    label: 'Volume',
    scale: 'linear',
    live: true,
    range: () => [0, 1],
    get: (s) => s.volume,
    set: (s, v) => (s.volume = v),
    format: (v) => `${Math.round(v * 100)} %`,
  },
];

export function paramByKey(key: string): ParamDef {
  const p = PARAMS.find((d) => d.key === key);
  if (!p) throw new Error(`Unknown parameter ${key}`);
  return p;
}

/** 60 dB decay times at the fundamental and at 2 kHz, for the damping readout. */
export function decaySummary(
  state: AppState,
  sampleRate: number,
): { f1: number; t1: number; t2: number } {
  const { physics } = stringInfo(state.string, sampleRate);
  const f1 = physics.f0 * Math.sqrt(1 + physics.B);
  return {
    f1,
    t1: t60AtFrequency(f1, physics, state.string.sigma0, state.string.sigma1),
    t2: t60AtFrequency(2000, physics, state.string.sigma0, state.string.sigma1),
  };
}
