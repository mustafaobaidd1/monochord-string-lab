/**
 * The bowed string must settle into Helmholtz motion (Helmholtz 1863; see Cremer, The Physics
 * of the Violin, 1984, and Bilbao 2009, 7.4): a periodic stick-slip cycle at the string's
 * fundamental, exactly harmonic partials (mode locking), a sawtooth bridge force (partials
 * falling as 1/n), sticking for about (1 - beta) of each period and slipping back at about
 * -v_B (1 - beta) / beta.
 */
import { describe, expect, it } from 'vitest';
import { measurePartials, peakInRange, spectrumOf } from '../src/dsp/analysis.ts';
import { BOW_SHARPNESS, Bow } from '../src/physics/bow.ts';
import { PRESETS, bowSpec, playableBowForce, presetString } from '../src/physics/presets.ts';
import { Voice } from '../src/physics/voice.ts';
import { FS, makeString } from './helpers.ts';

function bowRun(
  id: string,
  opts: { beta?: number; velocity?: number; forceScale?: number; seconds?: number } = {},
) {
  const beta = opts.beta ?? 0.1;
  const velocity = opts.velocity ?? 0.1;
  const preset = PRESETS.find((p) => p.id === id)!;
  const params = presetString(preset);
  const sim = makeString(params);
  const force = playableBowForce(preset, params, velocity) * (opts.forceScale ?? 1);
  const bow = new Bow(sim.string, {
    position: 1 - beta,
    force,
    velocity,
    width: 0.004,
    sharpness: BOW_SHARPNESS,
  });
  const n = Math.round(FS * (opts.seconds ?? 1));
  const bridge = new Float64Array(n);
  const eta = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    sim.string.computeFree();
    bow.interact(sim.string);
    sim.string.commit();
    bridge[i] = sim.string.bridgeForce();
    eta[i] = bow.relativeVelocity;
  }
  return { sim, bow, bridge, eta, beta, velocity, force };
}

describe('bowed string', () => {
  for (const id of ['harp-c4']) {
    it(`${id}: mode-locks into a harmonic, sawtooth-like tone`, () => {
      const r = bowRun(id, { seconds: 1.5 });
      const f1 = r.sim.physics.f0 * Math.sqrt(1 + r.sim.physics.B);
      const s = spectrumOf(r.bridge.subarray(Math.round(FS * 0.9)), FS, { zeroPad: 8 });
      const peak = peakInRange(s, f1 * 0.9, f1 * 1.1)!;
      expect(Math.abs(1200 * Math.log2(peak.frequency / f1))).toBeLessThan(25);
      const m = measurePartials(
        s,
        Array.from({ length: 8 }, (_, i) => (i + 1) * peak.frequency),
      );
      for (const p of m) {
        expect(Math.abs(1200 * Math.log2(p.measured! / (p.n * peak.frequency)))).toBeLessThan(1);
      }
      for (const p of m.slice(1, 6)) {
        expect(Math.abs(p.level! - m[0].level! + 20 * Math.log10(p.n))).toBeLessThan(3);
      }
    });
  }

  for (const id of ['violin-a4', 'guitar-e4', 'nylon-e4']) {
    it(`${id}: settles into Helmholtz motion`, () => {
      const r = bowRun(id);
      const f1 = r.sim.physics.f0 * Math.sqrt(1 + r.sim.physics.B);
      const steady = r.bridge.subarray(Math.round(FS * 0.4));
      const s = spectrumOf(steady, FS, { zeroPad: 8 });
      const peak = peakInRange(s, f1 * 0.9, f1 * 1.1)!;
      // 1. Periodic at the string's fundamental (bowing flattens slightly; tens of cents at most).
      expect(Math.abs(1200 * Math.log2(peak.frequency / f1))).toBeLessThan(25);
      // 2. Mode locking: the partials are exact harmonics of the playing frequency.
      const m = measurePartials(
        s,
        Array.from({ length: 8 }, (_, i) => (i + 1) * peak.frequency),
      );
      for (const p of m) {
        expect(Math.abs(1200 * Math.log2(p.measured! / (p.n * peak.frequency)))).toBeLessThan(1);
      }
      // 3. Sawtooth: partials fall as 1/n (within 3 dB for n = 2..6).
      for (const p of m.slice(1, 6)) {
        expect(Math.abs(p.level! - m[0].level! + 20 * Math.log10(p.n))).toBeLessThan(3);
      }
      // 4. Stick-slip: the string moves with the bow (relative speed above -0.05 m/s) for about
      //    (1 - beta) of the time, and slips back at roughly -v_B (1 - beta) / beta.
      const tail = r.eta.subarray(Math.round(FS * 0.6));
      let stick = 0;
      let slip = 0;
      for (const v of tail) {
        if (v > -0.05) stick++;
        slip = Math.min(slip, v + r.velocity);
      }
      expect(Math.abs(stick / tail.length - (1 - r.beta))).toBeLessThan(0.1);
      const ideal = (-r.velocity * (1 - r.beta)) / r.beta;
      expect(Math.abs(slip - ideal) / Math.abs(ideal)).toBeLessThan(0.35);
    });
  }

  it('more bow force flattens the pitch (the "flattening effect")', () => {
    const f = (scale: number) => {
      const r = bowRun('nylon-e4', { forceScale: scale });
      const s = spectrumOf(r.bridge.subarray(Math.round(FS * 0.4)), FS, { zeroPad: 8 });
      return peakInRange(s, 290, 370)!.frequency;
    };
    expect(f(2)).toBeLessThan(f(1));
  });

  it('lifting the bow lets the string ring freely, then it falls silent', () => {
    const preset = PRESETS.find((p) => p.id === 'violin-a4')!;
    const params = presetString(preset);
    const voice = new Voice(FS);
    voice.bowStart(
      params,
      bowSpec(preset, params, { fromBridge: 0.1, pressure: 1, velocity: 0.1 }),
      { kind: 'bridge', pickup: 0.8 },
    );
    const out = new Float32Array(FS / 2);
    voice.render(out, 0, out.length);
    expect(voice.bow).not.toBeNull();
    voice.releaseBow();
    voice.render(out.fill(0), 0, Math.round(FS * 0.05));
    expect(voice.bow).toBeNull();
    for (let i = 0; i < 12; i++) voice.render(out.fill(0), 0, out.length);
    expect(voice.mode).toBe('idle');
  });

  it('stays bounded across the range of force and speed the interface allows', () => {
    for (const id of ['violin-a4', 'guitar-e2', 'piano-a0']) {
      for (const forceScale of [0.125, 8]) {
        for (const velocity of [0.03, 0.5]) {
          for (const beta of [0.04, 0.3]) {
            const r = bowRun(id, { forceScale, velocity, beta, seconds: 0.3 });
            const max = r.sim.string.maxAbs();
            expect(Number.isFinite(max)).toBe(true);
            // Ideal Helmholtz motion peaks at v_B / (8 beta f0) mid-string. With too much force the
            // bow drags the string up to the static friction limit F beta (1 - beta) L / T instead.
            const helmholtz = velocity / (8 * beta * r.sim.physics.f0);
            const drag = (r.force * beta * (1 - beta) * r.sim.params.length) / r.sim.params.tension;
            expect(max).toBeLessThan(2 * Math.max(helmholtz, drag) + 0.002);
          }
        }
      }
    }
  });
});
