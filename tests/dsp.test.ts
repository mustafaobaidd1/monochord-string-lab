import { describe, expect, it } from 'vitest';
import {
  estimateFundamental,
  findPeaks,
  measurePartials,
  nextPow2,
  peakInRange,
  spectrumOf,
} from '../src/dsp/analysis.ts';
import { FFT, makeWindow, realPowerSpectrum } from '../src/dsp/fft.ts';
import {
  describePitch,
  frequencyToMidi,
  isBlackKey,
  midiToFrequency,
  noteName,
  parseNote,
} from '../src/dsp/notes.ts';

function naiveDft(x: number[]): { re: number[]; im: number[] } {
  const n = x.length;
  const re: number[] = [];
  const im: number[] = [];
  for (let k = 0; k < n; k++) {
    let a = 0;
    let b = 0;
    for (let t = 0; t < n; t++) {
      a += x[t] * Math.cos((2 * Math.PI * k * t) / n);
      b -= x[t] * Math.sin((2 * Math.PI * k * t) / n);
    }
    re.push(a);
    im.push(b);
  }
  return { re, im };
}

describe('FFT', () => {
  it('matches a direct DFT', () => {
    const n = 64;
    const x = Array.from(
      { length: n },
      (_, i) => Math.sin(i * 0.37) + 0.3 * Math.cos(i * 1.9) + (i % 5) * 0.01,
    );
    const re = Float64Array.from(x);
    const im = new Float64Array(n);
    new FFT(n).transform(re, im);
    const ref = naiveDft(x);
    for (let k = 0; k < n; k++) {
      expect(re[k]).toBeCloseTo(ref.re[k], 9);
      expect(im[k]).toBeCloseTo(ref.im[k], 9);
    }
  });

  it('the packed real FFT equals the full complex transform', () => {
    const n = 128;
    const x = Array.from({ length: 100 }, (_, i) => Math.sin(i * 0.21) * Math.exp(-i / 70));
    const power = realPowerSpectrum(x, n);
    const padded = [...x, ...new Array(n - x.length).fill(0)];
    const ref = naiveDft(padded);
    for (let k = 0; k <= n / 2; k++) {
      expect(power[k]).toBeCloseTo(ref.re[k] ** 2 + ref.im[k] ** 2, 8);
    }
  });

  it('rejects sizes that are not powers of two', () => {
    expect(() => new FFT(100)).toThrow();
    expect(nextPow2(1000)).toBe(1024);
  });

  it('windows have the expected coherent gain', () => {
    expect(makeWindow('hann', 4097).coherentGain).toBeCloseTo(0.5, 3);
    expect(makeWindow('blackman-harris', 4097).coherentGain).toBeCloseTo(0.35875, 3);
  });
});

describe('spectral peak measurement', () => {
  it('interpolates a sinusoid frequency to a small fraction of a bin and reads 0 dB for amplitude 1', () => {
    const fs = 48000;
    const f = 1234.567;
    const x = Float64Array.from({ length: 8192 }, (_, i) => Math.sin((2 * Math.PI * f * i) / fs));
    const s = spectrumOf(x, fs, { zeroPad: 4 });
    const p = peakInRange(s, 1000, 1500)!;
    expect(Math.abs(p.frequency - f)).toBeLessThan(0.01 * s.binHz * 4);
    expect(Math.abs(p.level)).toBeLessThan(0.05);
  });

  it('finds the lowest strong peak as the fundamental, even when it is weaker than a harmonic', () => {
    const fs = 48000;
    const x = Float64Array.from({ length: 24000 }, (_, i) => {
      const t = i / fs;
      return (
        0.2 * Math.sin(2 * Math.PI * 110 * t) +
        Math.sin(2 * Math.PI * 220 * t) +
        0.5 * Math.sin(2 * Math.PI * 330 * t)
      );
    });
    const s = spectrumOf(x, fs);
    expect(estimateFundamental(s)!.frequency).toBeCloseTo(110, 2);
    expect(findPeaks(s, -40).length).toBe(3);
    const m = measurePartials(s, [110, 220, 330, 440]);
    expect(m[1].measured!).toBeCloseTo(220, 2);
    expect(m[3].level ?? -400).toBeLessThan(-80);
  });

  it('returns null for silence', () => {
    const s = spectrumOf(new Float64Array(4096), 48000);
    expect(estimateFundamental(s)).toBeNull();
  });
});

describe('notes', () => {
  it('converts between names, MIDI numbers and frequencies', () => {
    expect(midiToFrequency(69)).toBe(440);
    expect(frequencyToMidi(27.5)).toBeCloseTo(21, 12);
    expect(noteName(40)).toBe('E2');
    expect(noteName(61, true)).toBe('C#4');
    expect(parseNote('E2')).toBe(40);
    expect(parseNote('C♯4')).toBe(61);
    expect(parseNote('Bb3')).toBe(58);
    expect(() => parseNote('H2')).toThrow();
    expect(isBlackKey(61)).toBe(true);
    expect(isBlackKey(60)).toBe(false);
    const d = describePitch(midiToFrequency(40) * 2 ** (3 / 1200));
    expect(d.name).toBe('E2');
    expect(d.cents).toBeCloseTo(3, 6);
  });
});

describe('fundamental estimation is robust', () => {
  const fs = 48000;
  const tone = (parts: [number, number][], seconds = 0.5) =>
    Float64Array.from({ length: Math.round(seconds * fs) }, (_, i) => {
      const t = i / fs;
      let v = 0;
      for (const [f, a] of parts) v += a * Math.sin(2 * Math.PI * f * t);
      return v;
    });

  it('ignores a weak stray peak below a strong harmonic series', () => {
    const series: [number, number][] = [1, 2, 3, 4, 5, 6].map((n) => [260 * n, 1 / n]);
    const s = spectrumOf(tone([...series, [124, 0.03]]), fs);
    expect(estimateFundamental(s)!.frequency).toBeCloseTo(260, 1);
  });

  it('finds the fundamental when the even partials are missing (pluck at L/2)', () => {
    const odd: [number, number][] = [1, 3, 5, 7].map((n) => [110 * n, 1 / n]);
    expect(estimateFundamental(spectrumOf(tone(odd), fs))!.frequency).toBeCloseTo(110, 1);
  });

  it('finds the fundamental of a very stiff string (B = 0.05)', () => {
    const B = 0.05;
    const stiff: [number, number][] = [1, 2, 3, 4].map((n) => [
      100 * n * Math.sqrt(1 + B * n * n),
      1 / n,
    ]);
    const f1 = 100 * Math.sqrt(1 + B);
    expect(estimateFundamental(spectrumOf(tone(stiff), fs))!.frequency).toBeCloseTo(f1, 1);
  });
});
