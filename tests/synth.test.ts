import { describe, expect, it } from 'vitest';
import { analyseSegment, Analyzer } from '../src/audio/analyzer.ts';
import { StringSynth, softLimit } from '../src/audio/synth.ts';
import { estimateFundamental, spectrumOf } from '../src/dsp/analysis.ts';
import { deriveString } from '../src/physics/materials.ts';
import { PRESETS, hammerSpec, pluckSpec, presetString } from '../src/physics/presets.ts';
import { partialFrequency, pluckOutputAmplitude } from '../src/physics/theory.ts';
import { Voice } from '../src/physics/voice.ts';

const FS = 48000;

function render(synth: StringSynth, seconds: number): Float32Array {
  const out = new Float32Array(Math.round(seconds * FS));
  const block = new Float32Array(128);
  for (let i = 0; i < out.length; i += 128) {
    const n = Math.min(128, out.length - i);
    synth.render(block, n);
    out.set(block.subarray(0, n), i);
  }
  return out;
}

const bridge = { kind: 'bridge' as const, pickup: 0.8 };

describe('voice and synth', () => {
  it('a default pluck of every preset peaks at a sensible level and never clips', () => {
    for (const preset of PRESETS) {
      for (const kind of ['bridge', 'pickup'] as const) {
        const synth = new StringSynth(FS);
        const output = { kind, pickup: 1 - preset.pickupFromBridge };
        if (preset.excitation === 'strike') {
          synth.handle({
            type: 'strike',
            params: presetString(preset),
            spec: hammerSpec(preset.strike),
            output,
          });
        } else {
          synth.handle({
            type: 'pluck',
            params: presetString(preset),
            spec: pluckSpec(preset.pluck),
            output,
          });
        }
        const out = render(synth, 0.5);
        let peak = 0;
        for (const v of out) peak = Math.max(peak, Math.abs(v));
        expect(peak, `${preset.id} ${kind}`).toBeGreaterThan(0.05);
        expect(peak, `${preset.id} ${kind}`).toBeLessThan(1.5);
      }
    }
  });

  it('the synth output has the preset pitch', () => {
    const preset = PRESETS[1];
    const synth = new StringSynth(FS);
    synth.handle({
      type: 'pluck',
      params: presetString(preset),
      spec: pluckSpec(preset.pluck),
      output: bridge,
    });
    const out = render(synth, 1);
    const f = estimateFundamental(spectrumOf(out, FS))!.frequency;
    const B = deriveString(presetString(preset)).B;
    expect(Math.abs(1200 * Math.log2(f / (preset.frequency * Math.sqrt(1 + B))))).toBeLessThan(0.1);
  });

  it('holding then releasing does not click: the first released samples continue the held output', () => {
    const preset = PRESETS[0];
    const synth = new StringSynth(FS);
    const params = presetString(preset);
    for (let a = 1; a <= 10; a++) {
      synth.handle({
        type: 'hold',
        id: 7,
        params,
        spec: { position: 0.8, width: 0.004, amplitude: a * 0.0003 },
        output: bridge,
      });
      render(synth, 0.02);
    }
    const before = render(synth, 0.01);
    synth.handle({ type: 'release', id: 7 });
    const after = render(synth, 0.002);
    const jump = Math.abs(after[0] - before[before.length - 1]);
    let peak = 0;
    for (const v of render(synth, 0.3)) peak = Math.max(peak, Math.abs(v));
    expect(peak).toBeGreaterThan(0.05);
    expect(jump).toBeLessThan(0.05 * peak);
  });

  it('a new note mutes the previous one, and a silent string goes idle', () => {
    const preset = PRESETS[1];
    const synth = new StringSynth(FS);
    const params = presetString(preset);
    synth.handle({ type: 'pluck', params, spec: pluckSpec(preset.pluck), output: bridge });
    render(synth, 0.1);
    synth.handle({ type: 'pluck', params, spec: pluckSpec(preset.pluck), output: bridge });
    expect(synth.voices.filter((v) => v.mode !== 'idle').length).toBe(2);
    expect(synth.voices.filter((v) => v.muted).length).toBe(1);
    render(synth, 0.6);
    expect(synth.voices.filter((v) => v.mode !== 'idle').length).toBe(1);
    synth.handle({ type: 'mute' });
    render(synth, 1.5);
    expect(synth.active).toBe(false);
  });

  it('reports an error instead of throwing for parameters with no stable grid', () => {
    const synth = new StringSynth(FS);
    const errors: string[] = [];
    synth.onError = (m) => errors.push(m);
    synth.handle({
      type: 'pluck',
      params: { ...presetString(PRESETS[1]), length: 0.05, inharmonicity: 0.5 },
      spec: { position: 0.5, width: 0, amplitude: 0.001 },
      output: bridge,
    });
    expect(errors.length).toBe(1);
    expect(synth.active).toBe(false);
  });

  it('the soft limiter is transparent below 0.6 and bounded by 1', () => {
    expect(softLimit(0.5)).toBe(0.5);
    expect(softLimit(-0.6)).toBe(-0.6);
    expect(softLimit(10)).toBeLessThanOrEqual(1);
    expect(softLimit(-10)).toBeGreaterThanOrEqual(-1);
    expect(softLimit(0.7)).toBeLessThan(0.7);
  });

  it('the master stage mutes smoothly', () => {
    const synth = new StringSynth(FS);
    synth.handle({ type: 'master', volume: 0, muted: true });
    const x = new Float32Array(4800).fill(0.5);
    const y = new Float32Array(4800);
    synth.master.process(x, y, 4800);
    expect(y[0]).toBeGreaterThan(0.4);
    expect(Math.abs(y[4799])).toBeLessThan(0.01);
  });

  it('the picture voice and the audio voice stay sample-identical', () => {
    const preset = PRESETS[0];
    const params = presetString(preset);
    const a = new Voice(FS);
    const b = new Voice(FS);
    a.pluck(params, pluckSpec(preset.pluck), bridge);
    b.pluck(params, pluckSpec(preset.pluck), bridge);
    const out = new Float32Array(1000);
    a.render(out, 0, 1000);
    b.advance(1000);
    for (let l = 0; l <= a.grid!.N; l++) expect(b.string!.at(l)).toBe(a.string!.at(l));
  });
});

describe('analyser', () => {
  it('measures the synth output after an onset and flags the partials a pluck at L/3 removes', () => {
    const preset = PRESETS[0];
    const params = presetString(preset);
    const physics = deriveString(params);
    const synth = new StringSynth(FS);
    const analyzer = new Analyzer(FS);
    const snapshots: ReturnType<typeof analyseSegment>[] = [];
    analyzer.onSnapshot = (s) => snapshots.push(s);
    synth.onOnset = (info) => analyzer.onset(info.frame);
    const predicted = Array.from({ length: 12 }, (_, i) =>
      partialFrequency(i + 1, physics.f0, physics.B),
    );
    const x0 = 1 - 1 / 3;
    analyzer.expect({
      predicted,
      predictedAmplitude: predicted.map((_, i) =>
        pluckOutputAmplitude(i + 1, x0, 0, physics.B, 'bridge', 0),
      ),
      f0: physics.f0,
      tag: 1,
    });
    synth.handle({
      type: 'pluck',
      params,
      spec: { position: x0, width: 0, amplitude: 0.002 },
      output: bridge,
    });
    const block = new Float32Array(2048);
    for (let i = 0; i < 40; i++) {
      const frame = synth.frame;
      synth.render(block, 2048);
      analyzer.push(frame, block.slice());
    }
    expect(snapshots.length).toBe(1);
    const s = snapshots[0];
    expect(Math.abs(1200 * Math.log2(s.fundamental!.frequency / predicted[0]))).toBeLessThan(0.5);
    const flagged = s.partials.filter((p) => p.suppressed).map((p) => p.n);
    expect(flagged).toEqual([3, 6, 9, 12]);
    expect(s.partials.filter((p) => p.predictedSuppressed).map((p) => p.n)).toEqual([3, 6, 9, 12]);
    // E2: about 12 bins per partial spacing, rounded up to a power of two (8192), zero-padded x2.
    expect(analyzer.liveSpectrum().db.length).toBe(8193);
  });
});
