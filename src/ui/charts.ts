/**
 * Two small SVG charts: the stretch of each partial (cents above n f0, theory as bars and the
 * measured partials as dots) and the tension each key of the keyboard needs.
 */
import { midiToFrequency, noteName } from '../dsp/notes.ts';
import { sig3 } from '../app/format.ts';
import type { Snapshot } from '../app/state.ts';

const SVG = 'http://www.w3.org/2000/svg';

function el<K extends keyof SVGElementTagNameMap>(
  name: K,
  attrs: Record<string, string | number>,
  text?: string,
): SVGElementTagNameMap[K] {
  const e = document.createElementNS(SVG, name);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  if (text != null) e.textContent = text;
  return e;
}

/** A tidy upper bound for an axis (1, 2 or 5 times a power of ten). */
function niceCeil(x: number): number {
  if (x <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(x));
  for (const m of [1, 2, 5, 10]) if (m * p >= x) return m * p;
  return 10 * p;
}

const STRETCH_PARTIALS = 20;

/**
 * Draws the stretch chart and returns the measured deviation from theory with the largest
 * magnitude (cents, signed), or null when there is no measurement yet.
 */
export function renderStretch(
  host: HTMLElement,
  f0: number,
  B: number,
  snapshot: Snapshot | null,
): number | null {
  const W = 300;
  const H = 104;
  const left = 34;
  const right = 6;
  const top = 10;
  const bottom = 22;
  const plotW = W - left - right;
  const plotH = H - top - bottom;
  const theory = Array.from({ length: STRETCH_PARTIALS }, (_, i) => {
    const n = i + 1;
    return 600 * Math.log2(1 + B * n * n);
  });
  const measured = (snapshot?.partials ?? []).map((p) =>
    p.measured && !p.suppressed ? 1200 * Math.log2(p.measured / (p.n * f0)) : null,
  );
  const maxValue = Math.max(theory[theory.length - 1], ...measured.map((m) => m ?? 0), 1);
  const yMax = niceCeil(maxValue * 1.08);
  // Numerical dispersion can leave measured partials slightly flat: keep room below zero.
  const minValue = Math.min(0, ...measured.map((m) => m ?? 0));
  const yMin = minValue < 0 ? -Math.max(niceCeil(-minValue * 1.2), yMax * 0.12) : 0;
  const y = (c: number) => top + plotH * ((yMax - c) / (yMax - yMin));
  const slot = plotW / STRETCH_PARTIALS;
  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, class: 'mini-svg', 'aria-hidden': 'true' });
  // Axes and gridline at the top value.
  svg.append(el('line', { x1: left, x2: W - right, y1: y(0), y2: y(0), class: 'axis' }));
  svg.append(el('line', { x1: left, x2: W - right, y1: y(yMax), y2: y(yMax), class: 'grid' }));
  svg.append(el('text', { x: left - 5, y: y(yMax) + 3.5, class: 'tick end' }, `+${yMax} ¢`));
  svg.append(el('text', { x: left - 5, y: y(0) + 3.5, class: 'tick end' }, '0'));
  if (yMin < 0) {
    svg.append(el('line', { x1: left, x2: W - right, y1: y(yMin), y2: y(yMin), class: 'grid' }));
    svg.append(el('text', { x: left - 5, y: y(yMin) + 3.5, class: 'tick end' }, `−${-yMin} ¢`));
  }
  theory.forEach((c, i) => {
    const x = left + i * slot + slot * 0.18;
    const h = Math.max(0.6, y(0) - y(c));
    svg.append(el('rect', { x, y: y(0) - h, width: slot * 0.64, height: h, class: 'bar' }));
    if ((i + 1) % 5 === 0 || i === 0) {
      svg.append(el('text', { x: x + slot * 0.32, y: H - 8, class: 'tick mid' }, String(i + 1)));
    }
  });
  measured.forEach((c, i) => {
    if (c == null || i >= STRETCH_PARTIALS) return;
    svg.append(el('circle', { cx: left + (i + 0.5) * slot, cy: y(c), r: 2.6, class: 'dot' }));
  });
  host.replaceChildren(svg);
  const last = theory[theory.length - 1];
  let worst: number | null = null;
  measured.forEach((m, i) => {
    if (m == null || i >= STRETCH_PARTIALS) return;
    const d = m - theory[i];
    if (worst == null || Math.abs(d) > Math.abs(worst)) worst = d;
  });
  const w = worst as number | null;
  host.setAttribute(
    'aria-label',
    `Stretch of the partials: partial ${STRETCH_PARTIALS} is ${last.toFixed(0)} cents above ${STRETCH_PARTIALS} times f0.` +
      (w != null
        ? ` Measured partials follow the prediction within ${Math.abs(w).toFixed(1)} cents.`
        : ''),
  );
  return w;
}

export interface TensionModel {
  start: number;
  home: number;
  tensionFor(midi: number): number;
  breakingLoad: number;
}

export function renderTension(host: HTMLElement, m: TensionModel, active: number | null): void {
  const W = 300;
  const H = 120;
  const left = 8;
  const right = 8;
  const top = 18;
  const bottom = 18;
  const keys = Array.from({ length: 25 }, (_, i) => m.start + i);
  const tensions = keys.map((k) => m.tensionFor(k));
  const max = Math.max(...tensions, m.breakingLoad * 1.15);
  const plotW = W - left - right;
  const plotH = H - top - bottom;
  const y = (t: number) => top + plotH * (1 - t / max);
  const slot = plotW / keys.length;
  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, class: 'mini-svg', 'aria-hidden': 'true' });
  svg.append(el('line', { x1: left, x2: W - right, y1: y(0), y2: y(0), class: 'axis' }));
  keys.forEach((k, i) => {
    const t = tensions[i];
    const x = left + i * slot + slot * 0.15;
    const h = Math.max(0.6, y(0) - y(t));
    const cls = [
      'bar',
      t > m.breakingLoad ? 'bar--over' : '',
      k === m.home ? 'bar--home' : '',
      k === active ? 'bar--active' : '',
    ]
      .filter(Boolean)
      .join(' ');
    svg.append(el('rect', { x, y: y(0) - h, width: slot * 0.7, height: h, class: cls }));
    if (k % 12 === 0) {
      svg.append(el('text', { x: x + slot * 0.35, y: H - 5, class: 'tick mid' }, noteName(k)));
    }
  });
  const yb = y(m.breakingLoad);
  svg.append(el('line', { x1: left, x2: W - right, y1: yb, y2: yb, class: 'limit' }));
  svg.append(
    el(
      'text',
      { x: left, y: yb - 4, class: 'tick limit-label' },
      `breaks ≈ ${sig3(m.breakingLoad)} N`,
    ),
  );
  host.replaceChildren(svg);
  const lo = tensions[0];
  const hi = tensions[tensions.length - 1];
  host.setAttribute(
    'aria-label',
    `Tension needed for each key, from ${sig3(lo)} newtons at ${noteName(keys[0])} to ${sig3(hi)} newtons at ${noteName(keys[24])}; the string breaks at about ${sig3(m.breakingLoad)} newtons.`,
  );
}

/** Large readout of the last key played. */
export function noteReadout(
  midi: number | null,
  tension: number | null,
  breakingLoad: number,
): string {
  if (midi == null || tension == null) return '';
  const f = midiToFrequency(midi);
  const share = Math.round((tension / breakingLoad) * 100);
  return `<span class="readout-note">${noteName(midi)}</span><span class="readout-detail">${f.toFixed(f >= 100 ? 1 : 2)} Hz · ${sig3(tension)} N · ${share} % of breaking</span>`;
}
