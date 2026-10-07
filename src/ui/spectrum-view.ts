/**
 * Spectrum (top) and waterfall (bottom) on one shared log-frequency axis, with the predicted
 * partials, their predicted levels, and the partials the excitation point removes.
 */
import type { Spectrum } from '../dsp/analysis.ts';
import type { ExcitationPrediction } from '../app/state.ts';
import { fitCanvas, readTheme, type Theme } from './theme.ts';

const F_MIN = 20;
const F_MAX = 16000;
const DB_RANGE = 90;
const WATERFALL_RANGE = 72;

interface Layout {
  w: number;
  h: number;
  dpr: number;
  left: number;
  right: number;
  top: number;
  specH: number;
  axisY: number;
  wfTop: number;
  wfH: number;
  compact: boolean;
}

interface ColumnMap {
  key: string;
  lo: Int32Array;
  hi: Int32Array;
}

export class SpectrumView {
  private readonly ctx: CanvasRenderingContext2D;
  private theme: Theme;
  private layout: Layout | null = null;
  private readonly waterfall = document.createElement('canvas');
  private wfCtx: CanvasRenderingContext2D;
  private lut: Uint8ClampedArray;
  private rowImage: ImageData | null = null;
  private columnCache = new Map<string, ColumnMap>();
  private live: Spectrum | null = null;
  private snapshot: Spectrum | null = null;
  private prediction: ExcitationPrediction | null = null;
  /** Reference level (dB) = strongest live level since the last excitation. */
  private reference = -Infinity;
  private snapshotPeak = -Infinity;

  constructor(private readonly canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D is not available');
    this.ctx = ctx;
    this.wfCtx = this.waterfall.getContext('2d', { willReadFrequently: false })!;
    this.theme = readTheme();
    this.lut = buildLut(this.theme);
    new ResizeObserver(() => this.draw()).observe(canvas);
  }

  /** A new excitation: reset the level reference and show its predicted partials. */
  setPrediction(p: ExcitationPrediction): void {
    this.prediction = p;
    this.reference = -Infinity;
    this.snapshot = null;
    this.snapshotPeak = -Infinity;
    this.draw();
  }

  setSnapshot(s: Spectrum): void {
    this.snapshot = s;
    let peak = -Infinity;
    const lo = Math.floor(F_MIN / s.binHz);
    for (let k = lo; k < s.db.length; k++) if (s.db[k] > peak) peak = s.db[k];
    this.snapshotPeak = peak;
    this.reference = Math.max(this.reference, peak);
    this.draw();
  }

  setLive(s: Spectrum): void {
    this.live = s;
    let peak = -Infinity;
    const lo = Math.floor(F_MIN / s.binHz);
    for (let k = lo; k < s.db.length; k++) if (s.db[k] > peak) peak = s.db[k];
    if (peak > this.reference) this.reference = peak;
  }

  private computeLayout(): Layout {
    const { w, h, dpr } = fitCanvas(this.canvas);
    const compact = w < 560;
    const left = compact ? 34 : 44;
    const right = compact ? 8 : 14;
    const top = compact ? 18 : 22;
    const axisGap = compact ? 22 : 26;
    const specH = Math.round((h - top - axisGap) * 0.56);
    const axisY = top + specH;
    const wfTop = axisY + axisGap;
    return { w, h, dpr, left, right, top, specH, axisY, wfTop, wfH: h - wfTop - 2, compact };
  }

  private x(l: Layout, f: number): number {
    return l.left + (Math.log(f / F_MIN) / Math.log(F_MAX / F_MIN)) * (l.w - l.left - l.right);
  }

  private fAt(l: Layout, x: number): number {
    return F_MIN * (F_MAX / F_MIN) ** ((x - l.left) / (l.w - l.left - l.right));
  }

  private y(l: Layout, db: number): number {
    const rel = Math.min(0, Math.max(-DB_RANGE, db - this.reference));
    return l.top + (-rel / DB_RANGE) * l.specH;
  }

  /** For each device-pixel column, the range of spectrum bins it covers. */
  private columns(l: Layout, binHz: number, length: number, scale: number): ColumnMap {
    const width = Math.max(1, Math.round((l.w - l.left - l.right) * scale));
    const key = `${binHz}|${length}|${width}|${l.left}`;
    let map = this.columnCache.get(key);
    if (map) return map;
    const lo = new Int32Array(width);
    const hi = new Int32Array(width);
    for (let i = 0; i < width; i++) {
      const xa = l.left + i / scale;
      const xb = l.left + (i + 1) / scale;
      const a = Math.floor(this.fAt(l, xa) / binHz);
      const b = Math.ceil(this.fAt(l, xb) / binHz);
      lo[i] = Math.max(0, Math.min(length - 1, a));
      hi[i] = Math.max(lo[i], Math.min(length - 1, b));
    }
    map = { key, lo, hi };
    if (this.columnCache.size > 12) this.columnCache.clear();
    this.columnCache.set(key, map);
    return map;
  }

  /** Waterfall: one new row (dB spectrum of the most recent hop). */
  addRow(db: Float64Array, binHz: number): void {
    const l = this.layout;
    if (!l || l.w - l.left - l.right < 40) return;
    const W = this.waterfall.width;
    const H = this.waterfall.height;
    if (W === 0 || H === 0) return;
    const scale = W / (l.w - l.left - l.right);
    const map = this.columns(l, binHz, db.length, scale);
    const g = this.wfCtx;
    g.globalCompositeOperation = 'copy';
    g.drawImage(this.waterfall, 0, 0, W, H - 1, 0, 1, W, H - 1);
    g.globalCompositeOperation = 'source-over';
    if (!this.rowImage || this.rowImage.width !== W) this.rowImage = g.createImageData(W, 1);
    const data = this.rowImage.data;
    const ref = Number.isFinite(this.reference) ? this.reference : -20;
    for (let i = 0; i < W; i++) {
      let m = -400;
      if (map.hi[i] - map.lo[i] <= 1) {
        const pos = this.fAt(l, l.left + (i + 0.5) / scale) / binHz;
        const k = Math.min(db.length - 2, Math.floor(pos));
        const t = pos - k;
        m = db[k] * (1 - t) + db[k + 1] * t;
      } else {
        for (let k = map.lo[i]; k <= map.hi[i]; k++) if (db[k] > m) m = db[k];
      }
      const t = Math.min(1, Math.max(0, (m - ref + WATERFALL_RANGE) / WATERFALL_RANGE));
      const idx = Math.round(t * 255) * 4;
      data[i * 4] = this.lut[idx];
      data[i * 4 + 1] = this.lut[idx + 1];
      data[i * 4 + 2] = this.lut[idx + 2];
      data[i * 4 + 3] = this.lut[idx + 3];
    }
    g.putImageData(this.rowImage, 0, 0);
  }

  draw(): void {
    const l = this.computeLayout();
    // A collapsed or transient layout (for example mid-resize) has nothing sensible to draw.
    if (l.w - l.left - l.right < 40 || l.wfH < 10 || l.specH < 20) return;
    const resized =
      !this.layout || this.layout.w !== l.w || this.layout.h !== l.h || this.layout.dpr !== l.dpr;
    this.layout = l;
    if (resized) {
      const W = Math.round((l.w - l.left - l.right) * l.dpr);
      const H = Math.round(l.wfH * l.dpr);
      const old = document.createElement('canvas');
      old.width = this.waterfall.width;
      old.height = this.waterfall.height;
      if (old.width && old.height) old.getContext('2d')!.drawImage(this.waterfall, 0, 0);
      this.waterfall.width = Math.max(1, W);
      this.waterfall.height = Math.max(1, H);
      if (old.width && old.height)
        this.wfCtx.drawImage(old, 0, 0, this.waterfall.width, this.waterfall.height);
      this.columnCache.clear();
    }
    const g = this.ctx;
    const th = this.theme;
    g.setTransform(l.dpr, 0, 0, l.dpr, 0, 0);
    g.clearRect(0, 0, l.w, l.h);

    this.drawGrid(g, l, th);
    this.drawPredicted(g, l, th);
    if (this.snapshot) this.drawTrace(g, l, this.snapshot, th.inkSoft, false);
    if (this.live) this.drawTrace(g, l, this.live, th.teal, true);
    this.drawMarkers(g, l, th);
    this.drawWaterfall(g, l, th);
  }

  private drawGrid(g: CanvasRenderingContext2D, l: Layout, th: Theme): void {
    g.font = `${l.compact ? 9.5 : 10.5}px ${th.sans}`;
    g.fillStyle = th.inkSoft;
    g.strokeStyle = th.ink;
    g.lineWidth = 1;
    // Plot frames.
    g.globalAlpha = 0.18;
    g.strokeRect(l.left + 0.5, l.top + 0.5, l.w - l.left - l.right - 1, l.specH - 1);
    g.strokeRect(l.left + 0.5, l.wfTop + 0.5, l.w - l.left - l.right - 1, l.wfH - 1);
    // Frequency gridlines and labels.
    const ticks = [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000];
    g.textBaseline = 'middle';
    for (const f of ticks) {
      g.textAlign = f === 20 ? 'left' : 'center';
      const x = Math.round(this.x(l, f)) + 0.5;
      g.globalAlpha = 0.1;
      g.beginPath();
      g.moveTo(x, l.top);
      g.lineTo(x, l.axisY);
      g.moveTo(x, l.wfTop);
      g.lineTo(x, l.wfTop + l.wfH);
      g.stroke();
      g.globalAlpha = 1;
      if (l.compact && (f === 50 || f === 500 || f === 5000)) continue;
      g.fillText(
        f >= 1000 ? `${f / 1000}k` : String(f),
        f === 20 ? x + 2 : x,
        l.axisY + (l.compact ? 11 : 13),
      );
    }
    g.textAlign = 'right';
    g.fillText('Hz', l.left - 6, l.axisY + (l.compact ? 11 : 13));
    // Level gridlines.
    for (const d of [0, -30, -60, -90]) {
      const y = Math.round(l.top + (-d / DB_RANGE) * l.specH) + 0.5;
      g.globalAlpha = d === 0 ? 0 : 0.1;
      g.beginPath();
      g.moveTo(l.left, y);
      g.lineTo(l.w - l.right, y);
      g.stroke();
      g.globalAlpha = 1;
      g.textBaseline = d === 0 ? 'top' : d === -90 ? 'bottom' : 'middle';
      g.fillText(d === 0 ? '0 dB' : `${d}`.replace('-', '−'), l.left - 6, y + (d === 0 ? 1 : 0));
    }
    // Waterfall time axis.
    g.textBaseline = 'top';
    g.fillText('now', l.left - 6, l.wfTop + 2);
    const secondsVisible = (l.wfH * l.dpr) / 50; // one device row per 20 ms hop
    for (let s = 2; s < secondsVisible - 0.3; s += 2) {
      const y = l.wfTop + (s * 50) / l.dpr;
      g.textBaseline = 'middle';
      g.fillText(`−${s} s`, l.left - 6, y);
    }
  }

  private drawTrace(
    g: CanvasRenderingContext2D,
    l: Layout,
    s: Spectrum,
    color: string,
    fill: boolean,
  ) {
    const scale = 1;
    const map = this.columns(l, s.binHz, s.db.length, scale);
    const n = map.lo.length;
    g.beginPath();
    for (let i = 0; i < n; i++) {
      let m = -400;
      if (map.hi[i] - map.lo[i] <= 1) {
        // Wide bins: interpolate at the column centre.
        const f = this.fAt(l, l.left + i + 0.5);
        const pos = f / s.binHz;
        const k = Math.min(s.db.length - 2, Math.floor(pos));
        const t = pos - k;
        m = s.db[k] * (1 - t) + s.db[k + 1] * t;
      } else {
        for (let k = map.lo[i]; k <= map.hi[i]; k++) if (s.db[k] > m) m = s.db[k];
      }
      const x = l.left + i + 0.5;
      const y = this.y(l, m);
      if (i === 0) g.moveTo(x, y);
      else g.lineTo(x, y);
    }
    if (fill) {
      g.save();
      g.lineTo(l.left + n, l.axisY);
      g.lineTo(l.left, l.axisY);
      g.closePath();
      g.fillStyle = this.theme.tealSoft;
      g.fill();
      g.restore();
      // Re-stroke the top edge only.
      g.beginPath();
      for (let i = 0; i < n; i++) {
        let m = -400;
        if (map.hi[i] - map.lo[i] <= 1) {
          const f = this.fAt(l, l.left + i + 0.5);
          const pos = f / s.binHz;
          const k = Math.min(s.db.length - 2, Math.floor(pos));
          const t = pos - k;
          m = s.db[k] * (1 - t) + s.db[k + 1] * t;
        } else {
          for (let k = map.lo[i]; k <= map.hi[i]; k++) if (s.db[k] > m) m = s.db[k];
        }
        const x = l.left + i + 0.5;
        const y = this.y(l, m);
        if (i === 0) g.moveTo(x, y);
        else g.lineTo(x, y);
      }
    }
    g.strokeStyle = color;
    g.lineWidth = fill ? 1.5 : 1;
    g.globalAlpha = fill ? 1 : 0.55;
    g.lineJoin = 'round';
    g.stroke();
    g.globalAlpha = 1;
  }

  private drawPredicted(g: CanvasRenderingContext2D, l: Layout, th: Theme): void {
    const p = this.prediction;
    if (!p) return;
    const missing = new Set(p.missing);
    let lastLineX = -Infinity;
    let labelRight = -Infinity;
    g.font = `500 ${l.compact ? 9.5 : 10.5}px ${th.serif}`;
    g.textAlign = 'center';
    g.textBaseline = 'bottom';
    for (let i = 0; i < p.frequencies.length; i++) {
      const f = p.frequencies[i];
      if (f < F_MIN || f > F_MAX) continue;
      const x = Math.round(this.x(l, f)) + 0.5;
      // Once partials crowd closer than 3 px the lines would merge into a band: stop there.
      if (x - lastLineX < 3) break;
      lastLineX = x;
      const gone = missing.has(i + 1);
      g.strokeStyle = gone ? th.rust : th.indigo;
      g.globalAlpha = gone ? 0.55 : 0.26;
      g.lineWidth = 1;
      if (gone) g.setLineDash([2, 3]);
      g.beginPath();
      g.moveTo(x, l.top);
      g.lineTo(x, l.axisY);
      g.stroke();
      g.setLineDash([]);
      g.globalAlpha = 1;
      const label = String(i + 1);
      const w = g.measureText(label).width;
      if (x - w / 2 > labelRight + (l.compact ? 3 : 5) && x + w / 2 < l.w - l.right) {
        g.fillStyle = gone ? th.rust : th.indigo;
        g.fillText(label, x, l.top - 3);
        labelRight = x + w / 2;
      }
    }
  }

  private drawMarkers(g: CanvasRenderingContext2D, l: Layout, th: Theme): void {
    const p = this.prediction;
    if (!p) return;
    const missing = new Set(p.missing);
    // Anchor the predicted levels to the strongest partial of the measured spectrum at the pluck.
    const anchor = Number.isFinite(this.snapshotPeak) ? this.snapshotPeak : this.reference;
    if (!Number.isFinite(anchor)) return;
    let lastX = -Infinity;
    for (let i = 0; i < p.frequencies.length; i++) {
      const f = p.frequencies[i];
      if (f < F_MIN || f > F_MAX) continue;
      const x = this.x(l, f);
      if (x - lastX < 9) {
        if (x - lastX < 3) break;
        continue;
      }
      lastX = x;
      if (missing.has(i + 1)) {
        const y = l.axisY - 7;
        g.strokeStyle = th.rust;
        g.lineWidth = 1.6;
        g.beginPath();
        g.moveTo(x - 4, y - 4);
        g.lineTo(x + 4, y + 4);
        g.moveTo(x + 4, y - 4);
        g.lineTo(x - 4, y + 4);
        g.stroke();
        continue;
      }
      const a = p.amplitudes[i];
      if (a <= 0) continue;
      const level = anchor + 20 * Math.log10(a);
      if (level - this.reference < -DB_RANGE) continue;
      const y = this.y(l, level);
      g.fillStyle = th.paperLight;
      g.strokeStyle = th.indigo;
      g.lineWidth = 1.3;
      g.beginPath();
      g.moveTo(x, y - 4);
      g.lineTo(x + 4, y);
      g.lineTo(x, y + 4);
      g.lineTo(x - 4, y);
      g.closePath();
      g.fill();
      g.stroke();
    }
  }

  private drawWaterfall(g: CanvasRenderingContext2D, l: Layout, th: Theme): void {
    g.save();
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.imageSmoothingEnabled = false;
    g.drawImage(
      this.waterfall,
      Math.round(l.left * l.dpr),
      Math.round(l.wfTop * l.dpr),
      this.waterfall.width,
      this.waterfall.height,
    );
    g.restore();
    // Predicted partial ticks along the top edge of the waterfall.
    const p = this.prediction;
    if (!p) return;
    g.strokeStyle = th.indigo;
    g.globalAlpha = 0.5;
    let lastX = -Infinity;
    for (const f of p.frequencies) {
      if (f > F_MAX) break;
      const x = Math.round(this.x(l, f)) + 0.5;
      if (x - lastX < 3) break;
      lastX = x;
      g.beginPath();
      g.moveTo(x, l.wfTop - 4);
      g.lineTo(x, l.wfTop);
      g.stroke();
    }
    g.globalAlpha = 1;
  }

  /** Clears the waterfall history (used when the theme or preset changes drastically). */
  clearHistory(): void {
    this.wfCtx.clearRect(0, 0, this.waterfall.width, this.waterfall.height);
  }
}

/** Ink-on-paper colour ramp: transparent → teal → indigo → walnut. */
function buildLut(th: Theme): Uint8ClampedArray {
  const stops: [number, [number, number, number, number]][] = [
    [0, [243, 234, 219, 0]],
    [0.3, [150, 190, 180, 70]],
    [0.6, hexRgba(th.teal, 185)],
    [0.85, hexRgba(th.indigo, 230)],
    [1, [42, 46, 92, 255]],
  ];
  const lut = new Uint8ClampedArray(256 * 4);
  for (let i = 0; i < 256; i++) {
    const t = i / 255;
    let j = 0;
    while (j < stops.length - 2 && t > stops[j + 1][0]) j++;
    const [t0, c0] = stops[j];
    const [t1, c1] = stops[j + 1];
    const u = (t - t0) / (t1 - t0);
    for (let c = 0; c < 4; c++) lut[i * 4 + c] = c0[c] + (c1[c] - c0[c]) * u;
  }
  return lut;
}

function hexRgba(hex: string, alpha: number): [number, number, number, number] {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex.trim());
  if (!m) return [59, 42, 30, alpha];
  return [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16), alpha];
}
