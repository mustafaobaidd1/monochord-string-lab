/**
 * Long-form validation of the string model against theory. Run with `npm run validate`.
 * Writes src/ui/validation-results.json (shown in the app's "How it works" section and copied
 * into the README) and prints a Markdown summary.
 */
import { writeFileSync } from 'node:fs';
import {
  estimateFundamental,
  measurePartials,
  peakInRange,
  spectrumOf,
} from '../src/dsp/analysis.ts';
import { BOW_SHARPNESS, Bow } from '../src/physics/bow.ts';
import { Hammer, staticDeflection } from '../src/physics/excitation.ts';
import { MAX_POINTS, designGrid } from '../src/physics/grid.ts';
import {
  deriveString,
  linearDensity,
  tensionForFrequency,
  type StringParams,
} from '../src/physics/materials.ts';
import { PRESETS, hammerSpec, playableBowForce, presetString } from '../src/physics/presets.ts';
import { StiffString } from '../src/physics/scheme.ts';
import { cents, discreteMode, partialFrequency } from '../src/physics/theory.ts';

const FS = 48000;

function sim(params: StringParams) {
  const physics = deriveString(params);
  const grid = designGrid({
    length: params.length,
    c: physics.c,
    kappa: physics.kappa,
    sigma1: params.sigma1,
    sampleRate: FS,
  });
  return { physics, grid, s: new StiffString(params, physics, grid) };
}

function pluck(x: ReturnType<typeof sim>, params: StringParams, position: number, width = 0) {
  x.s.setAtRest(
    staticDeflection(x.grid.N, x.grid.h, params.tension, x.physics.EI, {
      position,
      width,
      amplitude: 0.002,
    }),
  );
}

function bridge(x: ReturnType<typeof sim>, n: number): Float64Array {
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    x.s.step();
    out[i] = x.s.bridgeForce();
  }
  return out;
}

const round = (v: number, d: number) => Number(v.toFixed(d));

// 1. Fundamental of a near-ideal string.
const fundamental = [82.4069, 196, 329.6276, 440].map((f) => {
  const base = { length: 0.65, material: 'nylon' as const, diameter: 0.711e-3 };
  const params: StringParams = {
    ...base,
    tension: tensionForFrequency(linearDensity(base), 0.65, f),
    sigma0: 0,
    sigma1: 0,
    inharmonicity: 0,
  };
  const x = sim(params);
  pluck(x, params, 0.8);
  const peak = estimateFundamental(spectrumOf(bridge(x, FS), FS, { zeroPad: 8 }))!;
  return {
    target: f,
    measured: round(peak.frequency, 5),
    cents: round(cents(peak.frequency, f), 4),
  };
});

// 2. Stiff-string partials (first 10) against the continuous law and the scheme's own relation.
const partials = ['piano-a0', 'bass-e1', 'guitar-e2'].map((id) => {
  const preset = PRESETS.find((p) => p.id === id)!;
  const params = { ...presetString(preset), sigma0: 0, sigma1: 0 };
  const x = sim(params);
  pluck(x, params, 0.137);
  const seconds = x.physics.f0 < 40 ? 2 : 1;
  const s = spectrumOf(bridge(x, FS * seconds), FS, { zeroPad: 8 });
  const predicted = Array.from({ length: 10 }, (_, i) =>
    partialFrequency(i + 1, x.physics.f0, x.physics.B),
  );
  const m = measurePartials(s, predicted);
  const vsContinuous = m.map((r) => cents(r.measured!, r.predicted));
  const vsDiscrete = m.map((r) =>
    cents(r.measured!, discreteMode(r.n, x.grid, x.physics, 0, 0).frequency),
  );
  const stretch10 = cents(predicted[9], 10 * x.physics.f0);
  return {
    preset: preset.name,
    B: x.physics.B,
    N: x.grid.N,
    maxVsContinuous: round(Math.max(...vsContinuous.map(Math.abs)), 3),
    maxVsDiscrete: round(Math.max(...vsDiscrete.map(Math.abs)), 4),
    dispersionAt10: round(
      cents(discreteMode(10, x.grid, x.physics, 0, 0).frequency, predicted[9]),
      3,
    ),
    stretch10: round(stretch10, 2),
    measuredStretch10: round(cents(m[9].measured!, 10 * x.physics.f0), 2),
  };
});

// 3. Pluck at L/3.
const third = (() => {
  const params = { ...presetString(PRESETS[0]), sigma0: 0, sigma1: 0 };
  const x = sim(params);
  pluck(x, params, 1 - 1 / 3);
  const s = spectrumOf(bridge(x, FS), FS, { zeroPad: 4 });
  const predicted = Array.from({ length: 10 }, (_, i) =>
    partialFrequency(i + 1, x.physics.f0, x.physics.B),
  );
  const m = measurePartials(s, predicted);
  const level = (n: number) => m[n - 1].level ?? -400;
  const rows = [3, 6, 9].map((n) => ({
    n,
    belowNeighbours: round(Math.min(level(n - 1), level(n + 1)) - level(n), 1),
  }));
  return { rows, minimum: Math.min(...rows.map((r) => r.belowNeighbours)) };
})();

// 4. Energy: lossless drift, and decay at sigma_0.
const energy = PRESETS.map((preset) => {
  const params = { ...presetString(preset), sigma0: 0, sigma1: 0 };
  const x = sim(params);
  pluck(x, params, 0.71, 0.005);
  const e0 = x.s.energy();
  let drift = 0;
  for (let i = 0; i < FS; i++) {
    x.s.step();
    if (i % 25 === 0) drift = Math.max(drift, Math.abs(x.s.energy() - e0) / e0);
  }
  return { preset: preset.name, drift };
});

const decay = (() => {
  const sigma0 = 1.3;
  const params = { ...presetString(PRESETS[0]), sigma0, sigma1: 0 };
  const x = sim(params);
  pluck(x, params, 0.8, 0.004);
  const t: number[] = [];
  const y: number[] = [];
  for (let i = 1; i <= 2 * FS; i++) {
    x.s.step();
    if (i % 240 === 0) {
      t.push(i / FS);
      y.push(Math.log(x.s.energy()));
    }
  }
  const n = t.length;
  const mt = t.reduce((a, b) => a + b) / n;
  const my = y.reduce((a, b) => a + b) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (t[i] - mt) * (y[i] - my);
    den += (t[i] - mt) ** 2;
  }
  const measured = -num / den / 2;
  return {
    sigma0,
    measured: round(measured, 6),
    relError: Math.abs(measured - sigma0) / sigma0,
  };
})();

// 5. Every preset for 2 s: stability number, bounded output, speed.
const stability = PRESETS.map((preset) => {
  const params = presetString(preset);
  const x = sim(params);
  pluck(x, params, 0.8, 0.004);
  const start = x.s.maxAbs();
  let max = 0;
  const t0 = performance.now();
  for (let i = 0; i < 2 * FS; i++) {
    x.s.step();
    if (i % 97 === 0) max = Math.max(max, x.s.maxAbs());
  }
  const ms = (performance.now() - t0) / 2;
  return {
    preset: preset.name,
    N: x.grid.N,
    stabilityNumber: round(x.grid.stabilityNumber, 4),
    hOverHmin: round(x.grid.h / x.grid.hMin, 6),
    maxOverInitial: round(max / start, 3),
    msPerSecond: round(ms, 1),
  };
});

// 6. Hammer: energy conservation of the coupled lossless system.
const hammer = PRESETS.map((preset) => {
  const params = { ...presetString(preset), sigma0: 0, sigma1: 0 };
  const x = sim(params);
  const h = new Hammer(x.s, hammerSpec(preset.strike));
  const e0 = h.kineticEnergy();
  let drift = 0;
  for (let i = 0; i < FS / 20; i++) {
    x.s.computeFree();
    const lastEta = h.compression;
    h.interact(x.s);
    x.s.commit();
    const felt = 0.5 * (h.potential(h.compression) + h.potential(lastEta));
    drift = Math.max(drift, Math.abs(x.s.energy() + h.kineticEnergy() + felt - e0) / e0);
  }
  return { preset: preset.name, contactMs: round((h.contactSamples / FS) * 1000, 2), drift };
});

// 7. Bowing: Helmholtz motion at each preset's calibrated force (bow at L/10, 0.1 m/s).
const bow = [
  'violin-a4',
  'nylon-e4',
  'guitar-e4',
  'harp-c4',
  'guitar-e2',
  'bass-e1',
  'piano-a0',
].map((id) => {
  const preset = PRESETS.find((p) => p.id === id)!;
  const params = presetString(preset);
  const x = sim(params);
  const beta = 0.1;
  const velocity = 0.1;
  const b = new Bow(x.s, {
    position: 1 - beta,
    force: playableBowForce(preset, params, velocity),
    velocity,
    width: 0.004,
    sharpness: BOW_SHARPNESS,
  });
  const n = Math.round(FS * 1.5);
  const out = new Float64Array(n);
  const eta = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    x.s.computeFree();
    b.interact(x.s);
    x.s.commit();
    out[i] = x.s.bridgeForce();
    eta[i] = b.relativeVelocity;
  }
  const f1 = x.physics.f0 * Math.sqrt(1 + x.physics.B);
  const s = spectrumOf(out.subarray(Math.round(FS * 0.9)), FS, { zeroPad: 8 });
  const peak = peakInRange(s, f1 * 0.9, f1 * 1.1)!;
  const m = measurePartials(
    s,
    Array.from({ length: 8 }, (_, i) => (i + 1) * peak.frequency),
  );
  const harmonic = Math.max(...m.map((p) => Math.abs(cents(p.measured!, p.n * peak.frequency))));
  const sawtooth = Math.max(
    ...m.slice(1, 6).map((p) => Math.abs(p.level! - m[0].level! + 20 * Math.log10(p.n))),
  );
  const tail = eta.subarray(Math.round(FS * 0.9));
  let stick = 0;
  let slip = 0;
  for (const v of tail) {
    if (v > -0.05) stick++;
    slip = Math.min(slip, v + velocity);
  }
  return {
    preset: preset.name,
    force: round(playableBowForce(preset, params, velocity), 3),
    pitchCents: round(cents(peak.frequency, f1), 1),
    harmonicCents: round(harmonic, 2),
    sawtoothDb: round(sawtooth, 1),
    stickFraction: round(stick / tail.length, 3),
    slipVelocity: round(slip, 2),
    idealSlip: round((-velocity * (1 - beta)) / beta, 2),
  };
});

const results = {
  generated: new Date().toISOString().slice(0, 10),
  sampleRate: FS,
  maxPoints: MAX_POINTS,
  fundamental,
  partials,
  third,
  energy,
  decay,
  stability,
  hammer,
  bow,
};
writeFileSync('src/ui/validation-results.json', `${JSON.stringify(results, null, 2)}\n`);

const md: string[] = [];
md.push('| Check | Reference | Result |', '|---|---|---|');
for (const f of fundamental) {
  md.push(
    `| f₀ of a near-ideal string, ${f.target} Hz | (1/2L)√(T/μ) | ${f.measured} Hz (${f.cents} ¢) |`,
  );
}
for (const p of partials) {
  md.push(
    `| ${p.preset}, partials 1–10 (B = ${p.B.toExponential(2)}, N = ${p.N}) | n·f₀·√(1+Bn²) | max ${p.maxVsContinuous} ¢; vs the scheme's own dispersion relation ${p.maxVsDiscrete} ¢; numerical dispersion at n = 10: ${p.dispersionAt10} ¢; stretch of partial 10: ${p.measuredStretch10} ¢ (theory ${p.stretch10} ¢) |`,
  );
}
md.push(
  `| Pluck at L/3: partials 3, 6, 9 | ≥ 40 dB below neighbours | ${third.rows.map((r) => `${r.n}: ${r.belowNeighbours} dB`).join(', ')} |`,
);
md.push(
  `| Lossless energy drift over 1 s (all presets) | 0 (machine precision) | max ${Math.max(...energy.map((e) => e.drift)).toExponential(1)} |`,
);
md.push(
  `| Energy decay with σ₀ = ${decay.sigma0} s⁻¹ | e^(−2σ₀t) | σ₀ measured ${decay.measured} s⁻¹ (relative error ${decay.relError.toExponential(1)}) |`,
);
md.push(
  `| Presets over 2 s | bounded; λ² + 4ν² + 4σ₁k/h² ≤ 1 | ${stability.map((s) => `${s.preset} ${s.stabilityNumber}`).join(', ')}; max displacement ≤ ${Math.max(...stability.map((s) => s.maxOverInitial))}× the pluck |`,
);
md.push(
  `| Hammer + string energy (lossless) | conserved | max drift ${Math.max(...hammer.map((h) => h.drift)).toExponential(1)} |`,
  ...bow.map(
    (b) =>
      `| Bowed ${b.preset} (${b.force} N, L/10, 0.1 m/s) | Helmholtz motion: exact harmonics, sawtooth, stick ≈ 0.9 of the period, slip ≈ ${b.idealSlip} m/s | harmonics within ${b.harmonicCents} ¢; sawtooth within ${b.sawtoothDb} dB (n = 2–6); stick ${b.stickFraction}; slip ${b.slipVelocity} m/s; pitch ${b.pitchCents} ¢ |`,
  ),
);
console.log(md.join('\n'));
console.log('\nSpeed (Node, one voice):');
for (const s of stability)
  console.log(
    `  ${s.preset.padEnd(18)} N = ${String(s.N).padStart(3)}  ${s.msPerSecond} ms per simulated second`,
  );
