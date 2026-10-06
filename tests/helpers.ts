import { designGrid, type Grid } from '../src/physics/grid.ts';
import { deriveString, type StringParams, type StringPhysics } from '../src/physics/materials.ts';
import { StiffString } from '../src/physics/scheme.ts';
import { staticDeflection, type PluckSpec } from '../src/physics/excitation.ts';

export const FS = 48000;

export interface Sim {
  params: StringParams;
  physics: StringPhysics;
  grid: Grid;
  string: StiffString;
}

export function makeString(params: StringParams, sampleRate = FS): Sim {
  const physics = deriveString(params);
  const grid = designGrid({
    length: params.length,
    c: physics.c,
    kappa: physics.kappa,
    sigma1: params.sigma1,
    sampleRate,
  });
  return { params, physics, grid, string: new StiffString(params, physics, grid) };
}

export function pluck(sim: Sim, spec: PluckSpec): void {
  const { grid, string } = sim;
  string.setAtRest(staticDeflection(grid.N, grid.h, sim.params.tension, sim.physics.EI, spec));
}

/** Runs `samples` steps and records the bridge force. */
export function runBridge(sim: Sim, samples: number): Float64Array {
  const out = new Float64Array(samples);
  for (let i = 0; i < samples; i++) {
    sim.string.step();
    out[i] = sim.string.bridgeForce();
  }
  return out;
}

/** Least-squares slope of y against x. */
export function slope(x: ArrayLike<number>, y: ArrayLike<number>): number {
  const n = x.length;
  let sx = 0;
  let sy = 0;
  for (let i = 0; i < n; i++) {
    sx += x[i];
    sy += y[i];
  }
  const mx = sx / n;
  const my = sy / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (x[i] - mx) * (y[i] - my);
    den += (x[i] - mx) ** 2;
  }
  return num / den;
}
