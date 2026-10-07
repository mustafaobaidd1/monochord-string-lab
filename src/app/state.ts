/**
 * Application state, derived physics and the excitation descriptions shared by the views.
 */
import { analyseSegment } from '../audio/analyzer.ts';
import { describePitch } from '../dsp/notes.ts';
import { Hammer } from '../physics/excitation.ts';
import { GridError, designGrid, type Grid } from '../physics/grid.ts';
import {
  MATERIALS,
  deriveString,
  type MaterialId,
  type StringParams,
  type StringPhysics,
} from '../physics/materials.ts';
import {
  DEFAULT_PRESET_ID,
  bowSpec,
  hammerSpec,
  pluckSpec,
  presetById,
  presetString,
  type BowSettings,
  type ExcitationKind,
  type PluckSettings,
  type Preset,
  type StrikeSettings,
} from '../physics/presets.ts';
import { StiffString } from '../physics/scheme.ts';
import {
  partialFrequency,
  pluckOutputAmplitude,
  strikeOutputAmplitude,
  type OutputKind,
} from '../physics/theory.ts';
import type { OutputSettings } from '../physics/voice.ts';

export interface AppState {
  presetId: string;
  /** True once the user changed a string parameter away from the preset. */
  customised: boolean;
  string: StringParams;
  excitation: ExcitationKind;
  pluck: PluckSettings;
  strike: StrikeSettings;
  bow: BowSettings;
  output: { kind: OutputKind; pickupFromBridge: number };
  volume: number;
  muted: boolean;
  slowMotion: boolean;
  paused: boolean;
}

export function stateForPreset(preset: Preset, previous?: AppState): AppState {
  return {
    presetId: preset.id,
    customised: false,
    string: presetString(preset),
    excitation: preset.excitation,
    pluck: { ...preset.pluck },
    strike: { ...preset.strike },
    bow: { fromBridge: 0.1, pressure: 1, velocity: 0.1 },
    output: {
      kind: previous?.output.kind ?? 'bridge',
      pickupFromBridge: preset.pickupFromBridge,
    },
    volume: previous?.volume ?? 0.8,
    muted: previous?.muted ?? false,
    slowMotion: previous?.slowMotion ?? true,
    paused: previous?.paused ?? false,
  };
}

export function initialState(): AppState {
  return stateForPreset(presetById(DEFAULT_PRESET_ID));
}

export interface StringInfo {
  physics: StringPhysics;
  grid: Grid | null;
  error: string | null;
}

export function stringInfo(params: StringParams, sampleRate: number): StringInfo {
  const physics = deriveString(params);
  try {
    const grid = designGrid({
      length: params.length,
      c: physics.c,
      kappa: physics.kappa,
      sigma1: params.sigma1,
      sampleRate,
    });
    return { physics, grid, error: null };
  } catch (err) {
    return { physics, grid: null, error: err instanceof GridError ? err.message : String(err) };
  }
}

export function outputSettings(state: AppState): OutputSettings {
  return { kind: state.output.kind, pickup: 1 - state.output.pickupFromBridge };
}

export const DISPLAY_MAX_HZ = 16000;
/** Number of partials measured and listed in the table. */
export const MEASURED_PARTIALS = 12;

/** What the views need to annotate one excitation. */
export interface ExcitationPrediction {
  kind: ExcitationKind;
  /** Position of the excitation as a fraction of the length from the bridge. */
  fromBridge: number;
  f0: number;
  B: number;
  /** Predicted partial frequencies (continuous theory) up to the display limit. */
  frequencies: number[];
  /** Predicted output amplitudes, normalised to the strongest partial. */
  amplitudes: number[];
  output: OutputKind;
  pickupFromBridge: number;
  /** Partials predicted to vanish (at least 60 dB below the stronger neighbour). */
  missing: number[];
  tag: number;
}

let tagCounter = 0;

/** Force history of a strike, from a short main-thread run of the same scheme. */
export function strikeForceHistory(params: StringParams, strike: StrikeSettings, fs: number) {
  const info = stringInfo(params, fs);
  if (!info.grid) return { force: [] as number[], k: 1 / fs };
  const s = new StiffString(params, info.physics, info.grid);
  const hammer = new Hammer(s, hammerSpec(strike), 0.03);
  const steps = Math.round(0.03 * fs);
  for (let i = 0; i < steps && !hammer.retired; i++) {
    s.computeFree();
    hammer.interact(s);
    s.commit();
  }
  return { force: hammer.history, k: 1 / fs };
}

export function predictExcitation(state: AppState, sampleRate: number): ExcitationPrediction {
  const { physics } = stringInfo(state.string, sampleRate);
  const { f0, B } = physics;
  const nyquist = sampleRate / 2;
  const frequencies: number[] = [];
  for (let n = 1; n <= 400; n++) {
    const f = partialFrequency(n, f0, B);
    if (f > Math.min(DISPLAY_MAX_HZ, nyquist * 0.95)) break;
    frequencies.push(f);
  }
  const out = state.output.kind;
  const pickup = 1 - state.output.pickupFromBridge;
  let raw: number[];
  let fromBridge: number;
  if (state.excitation === 'pluck') {
    fromBridge = state.pluck.fromBridge;
    const x0 = 1 - fromBridge;
    const w = state.pluck.width / state.string.length;
    raw = frequencies.map((_, i) => pluckOutputAmplitude(i + 1, x0, w, B, out, pickup));
  } else if (state.excitation === 'bow') {
    // Helmholtz motion: one corner circulating once per period, so the partials lock to exact
    // multiples of f1 and the bridge force is a sawtooth (displacement 1/n^2, force 1/n).
    fromBridge = state.bow.fromBridge;
    const f1 = f0 * Math.sqrt(1 + B);
    frequencies.splice(0, frequencies.length);
    for (let n = 1; n * f1 <= Math.min(DISPLAY_MAX_HZ, nyquist * 0.95); n++)
      frequencies.push(n * f1);
    raw = frequencies.map((_, i) =>
      out === 'bridge' ? 1 / (i + 1) : Math.abs(Math.sin((i + 1) * Math.PI * pickup)) / (i + 1),
    );
  } else {
    fromBridge = state.strike.fromBridge;
    const { force, k } = strikeForceHistory(state.string, state.strike, sampleRate);
    const xh = 1 - fromBridge;
    raw = frequencies.map((_, i) => strikeOutputAmplitude(i + 1, f0, B, xh, force, k, out, pickup));
  }
  const max = Math.max(...raw, 1e-300);
  const amplitudes = raw.map((a) => a / max);
  const missing: number[] = [];
  amplitudes.forEach((a, i) => {
    const neighbour = Math.max(amplitudes[i - 1] ?? 0, amplitudes[i + 1] ?? 0);
    if (neighbour > 0 && a < neighbour * 1e-3) missing.push(i + 1);
  });
  return {
    kind: state.excitation,
    fromBridge,
    f0,
    B,
    frequencies,
    amplitudes,
    output: out,
    pickupFromBridge: state.output.pickupFromBridge,
    missing,
    tag: ++tagCounter,
  };
}

export function presetOf(state: AppState): Preset {
  return presetById(state.presetId);
}

export function materialLabel(id: MaterialId): string {
  return MATERIALS[id].label;
}

export function pitchLabel(f: number): string {
  const p = describePitch(f);
  const c = Math.round(p.cents);
  return `${p.name} ${c === 0 ? '±0' : c > 0 ? `+${c}` : `−${-c}`} ¢`;
}

export type Snapshot = ReturnType<typeof analyseSegment> & { windowSeconds: number };

export { bowSpec, pluckSpec, hammerSpec };
