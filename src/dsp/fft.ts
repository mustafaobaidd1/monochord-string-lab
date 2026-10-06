/**
 * Iterative radix-2 complex FFT with precomputed twiddles and bit-reversal table, plus a real
 * FFT built on an N/2-point complex transform.
 */
export class FFT {
  readonly size: number;
  private readonly cos: Float64Array;
  private readonly sin: Float64Array;
  private readonly rev: Uint32Array;

  constructor(size: number) {
    if (!Number.isInteger(Math.log2(size)) || size < 2) {
      throw new Error(`FFT size must be a power of two, got ${size}`);
    }
    this.size = size;
    this.cos = new Float64Array(size / 2);
    this.sin = new Float64Array(size / 2);
    for (let i = 0; i < size / 2; i++) {
      this.cos[i] = Math.cos((2 * Math.PI * i) / size);
      this.sin[i] = -Math.sin((2 * Math.PI * i) / size);
    }
    this.rev = new Uint32Array(size);
    const bits = Math.log2(size);
    for (let i = 0; i < size; i++) {
      let r = 0;
      for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
      this.rev[i] = r;
    }
  }

  /** In-place forward transform of (re, im). */
  transform(re: Float64Array, im: Float64Array): void {
    const n = this.size;
    const rev = this.rev;
    for (let i = 0; i < n; i++) {
      const j = rev[i];
      if (j > i) {
        let t = re[i];
        re[i] = re[j];
        re[j] = t;
        t = im[i];
        im[i] = im[j];
        im[j] = t;
      }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const half = len >> 1;
      const step = n / len;
      for (let start = 0; start < n; start += len) {
        for (let j = 0; j < half; j++) {
          const wr = this.cos[j * step];
          const wi = this.sin[j * step];
          const a = start + j;
          const b = a + half;
          const xr = re[b] * wr - im[b] * wi;
          const xi = re[b] * wi + im[b] * wr;
          re[b] = re[a] - xr;
          im[b] = im[a] - xi;
          re[a] += xr;
          im[a] += xi;
        }
      }
    }
  }
}

const cache = new Map<number, FFT>();
function fftOf(size: number): FFT {
  let f = cache.get(size);
  if (!f) {
    f = new FFT(size);
    cache.set(size, f);
  }
  return f;
}

/**
 * Power spectrum |X_k|^2 for k = 0..n/2 of a real signal, zero-padded to `n` (a power of two),
 * computed with an n/2-point complex FFT.
 */
export function realPowerSpectrum(signal: ArrayLike<number>, n: number): Float64Array {
  const half = n / 2;
  const f = fftOf(half);
  const re = new Float64Array(half);
  const im = new Float64Array(half);
  const len = Math.min(signal.length, n);
  for (let i = 0; i < len; i++) {
    if (i & 1) im[i >> 1] = signal[i];
    else re[i >> 1] = signal[i];
  }
  f.transform(re, im);
  const out = new Float64Array(half + 1);
  for (let k = 0; k <= half; k++) {
    const a = k % half;
    const b = (half - k) % half;
    // Even/odd split: E_k = (Z_k + conj Z_{N/2-k}) / 2, O_k = (Z_k - conj Z_{N/2-k}) / (2i).
    const er = 0.5 * (re[a] + re[b]);
    const ei = 0.5 * (im[a] - im[b]);
    const or = 0.5 * (im[a] + im[b]);
    const oi = -0.5 * (re[a] - re[b]);
    const ang = (-2 * Math.PI * k) / n;
    const c = Math.cos(ang);
    const s = Math.sin(ang);
    const xr = er + (or * c - oi * s);
    const xi = ei + (or * s + oi * c);
    out[k] = xr * xr + xi * xi;
  }
  return out;
}

export type WindowKind = 'hann' | 'blackman-harris';

/** Window of length n; `coherentGain` is the mean value (for amplitude normalisation). */
export function makeWindow(kind: WindowKind, n: number): { w: Float64Array; coherentGain: number } {
  const w = new Float64Array(n);
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const x = (2 * Math.PI * i) / (n - 1);
    const v =
      kind === 'hann'
        ? 0.5 - 0.5 * Math.cos(x)
        : 0.35875 - 0.48829 * Math.cos(x) + 0.14128 * Math.cos(2 * x) - 0.01168 * Math.cos(3 * x);
    w[i] = v;
    sum += v;
  }
  return { w, coherentGain: sum / n };
}
