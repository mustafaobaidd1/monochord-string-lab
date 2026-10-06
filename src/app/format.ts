/** Number formatting for readouts (typographic minus, superscript exponents, adaptive digits). */

const SUP: Record<string, string> = {
  '-': '⁻',
  '0': '⁰',
  '1': '¹',
  '2': '²',
  '3': '³',
  '4': '⁴',
  '5': '⁵',
  '6': '⁶',
  '7': '⁷',
  '8': '⁸',
  '9': '⁹',
};

export const MINUS = '−';

export function signed(x: number, digits = 1): string {
  const s = Math.abs(x).toFixed(digits);
  if (Number(s) === 0) return `±${s}`;
  return `${x < 0 ? MINUS : '+'}${s}`;
}

export function fixed(x: number, digits: number): string {
  return x.toFixed(digits).replace('-', MINUS);
}

/** Three significant figures, no exponent, typographic minus. */
export function sig3(x: number): string {
  if (x === 0) return '0';
  const a = Math.abs(x);
  const digits =
    a >= 100 ? 0 : a >= 10 ? 1 : a >= 1 ? 2 : Math.min(6, 2 - Math.floor(Math.log10(a)));
  return fixed(x, digits);
}

/** Scientific notation such as "1.47 × 10⁻⁴" (plain for 0.01 <= |x| < 1000). */
export function sci(x: number, digits = 2): string {
  if (x === 0) return '0';
  const a = Math.abs(x);
  if (a >= 0.01 && a < 1000) return sig3(x);
  const e = Math.floor(Math.log10(a));
  const m = x / 10 ** e;
  const exp = String(e)
    .split('')
    .map((c) => SUP[c] ?? c)
    .join('');
  return `${fixed(m, digits)} × 10${exp}`;
}

export function hz(f: number): string {
  if (!Number.isFinite(f)) return '—';
  if (f >= 10000) return `${(f / 1000).toFixed(1)} kHz`;
  if (f >= 1000) return `${(f / 1000).toFixed(2)} kHz`;
  if (f >= 100) return `${f.toFixed(1)} Hz`;
  return `${f.toFixed(2)} Hz`;
}

export function mm(m: number): string {
  const v = m * 1000;
  if (v >= 100) return `${v.toFixed(0)} mm`;
  if (v >= 10) return `${v.toFixed(1)} mm`;
  return `${v.toFixed(2)} mm`;
}

export function seconds(t: number): string {
  if (!Number.isFinite(t)) return '∞';
  if (t >= 10) return `${t.toFixed(0)} s`;
  if (t >= 1) return `${t.toFixed(1)} s`;
  return `${(t * 1000).toFixed(0)} ms`;
}

/** A fraction of the length as "L/5" (or "0.23 L" when not near a simple ratio). */
export function ratio(fraction: number): string {
  const inv = 1 / fraction;
  const nearest = Math.round(inv);
  if (nearest >= 2 && Math.abs(inv - nearest) < 0.04 * nearest) return `L/${nearest}`;
  return `${fraction.toFixed(2)} L`;
}
