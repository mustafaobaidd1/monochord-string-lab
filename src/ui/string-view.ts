/**
 * The hero drawing: the string between its two terminations, drawn like a luthier's plan, and
 * the pointer/keyboard interaction that plucks it.
 */
import type { MaterialId } from '../physics/materials.ts';
import type { PictureMode } from '../app/picture.ts';
import { HAMMER_REST } from '../app/picture.ts';
import { fitCanvas, readTheme, type Theme } from './theme.ts';

export interface StringScene {
  length: number;
  ends: { left: string; right: string };
  excitation: 'pluck' | 'strike';
  /** Excitation point, fraction of the length from the bridge. */
  excitePoint: number;
  /** Pickup position (fraction from the bridge) or null for the bridge-force output. */
  pickup: number | null;
  material: MaterialId;
  diameter: number;
  /** Displacement (m) drawn at a comfortable height; sets the vertical exaggeration. */
  displayAmplitude: number;
}

export interface StringFrame {
  N: number;
  shapes: Float32Array[];
  count: number;
  envelope: Float32Array | null;
  mode: PictureMode;
  hammer: number | null;
  /** Finger position while the string is held (fraction from the nut, metres). */
  grab: { x: number; amplitude: number } | null;
}

export interface StringViewEvents {
  grab(xFromNut: number, amplitude: number): void;
  drag(xFromNut: number, amplitude: number): void;
  release(xFromNut: number, amplitude: number, moved: boolean): void;
  keyPluck(): void;
  keyMove(delta: number): void;
}

interface Layout {
  w: number;
  h: number;
  dpr: number;
  nutX: number;
  bridgeX: number;
  y0: number;
  half: number;
  rulerY: number;
  scale: number;
  compact: boolean;
}

const FRACTIONS = [2, 3, 4, 5];

export class StringView {
  private readonly ctx: CanvasRenderingContext2D;
  private readonly staticLayer = document.createElement('canvas');
  private theme: Theme;
  private layout: Layout | null = null;
  private scene: StringScene | null = null;
  private dragging = false;
  private pointerId = -1;
  private startY = 0;
  private moved = false;
  private hover: number | null = null;
  private focused = false;
  private dirtyStatic = true;
  private lastFrame: StringFrame | null = null;
  /** Called after the drawing geometry changes (resize, first draw, new scene). */
  onLayout: (() => void) | null = null;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly stage: HTMLElement,
    private readonly band: HTMLElement,
    private readonly target: HTMLElement,
    private readonly events: StringViewEvents,
  ) {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D is not available');
    this.ctx = ctx;
    this.theme = readTheme();
    this.bind();
    new ResizeObserver(() => {
      this.dirtyStatic = true;
      if (this.lastFrame) this.draw(this.lastFrame);
    }).observe(stage);
  }

  setScene(scene: StringScene): void {
    this.scene = scene;
    this.dirtyStatic = true;
  }

  refreshTheme(): void {
    this.theme = readTheme();
    this.dirtyStatic = true;
  }

  /** Vertical exaggeration: drawn displacement per metre over the horizontal scale. */
  get exaggeration(): number {
    const l = this.layout;
    if (!l || !this.scene) return 1;
    return l.scale / ((l.bridgeX - l.nutX) / this.scene.length);
  }

  /** Screen x (CSS px, relative to the stage) of a point given as a fraction from the bridge. */
  xOfFromBridge(fromBridge: number): number {
    const l = this.layout;
    if (!l) return 0;
    return l.nutX + (1 - fromBridge) * (l.bridgeX - l.nutX);
  }

  get baselineY(): number {
    return this.layout?.y0 ?? 0;
  }

  private computeLayout(): Layout {
    const { w, h, dpr } = fitCanvas(this.canvas);
    const stageRect = this.stage.getBoundingClientRect();
    const bandRect = this.band.getBoundingClientRect();
    const top = bandRect.top - stageRect.top;
    const bottom = bandRect.bottom - stageRect.top;
    const compact = w < 640;
    const margin = compact ? 30 : Math.min(84, Math.max(48, w * 0.045));
    const rulerSpace = compact ? 40 : 48;
    const stringTop = top + 6;
    const stringBottom = bottom - rulerSpace;
    const y0 = (stringTop + stringBottom) / 2;
    const half = Math.max(20, (stringBottom - stringTop) / 2 - 4);
    const scene = this.scene;
    const scale = scene ? (0.55 * half) / scene.displayAmplitude : 1e4;
    return {
      w,
      h,
      dpr,
      nutX: margin,
      bridgeX: w - margin,
      y0,
      half,
      rulerY: bottom - (compact ? 26 : 30),
      scale,
      compact,
    };
  }

  // ---------------------------------------------------------------- interaction

  private fractionAt(clientX: number): number {
    const l = this.layout;
    if (!l) return 0.5;
    const x = clientX - this.stage.getBoundingClientRect().left;
    return Math.min(0.98, Math.max(0.02, (x - l.nutX) / (l.bridgeX - l.nutX)));
  }

  private amplitudeAt(clientY: number): number {
    const l = this.layout;
    if (!l || !this.scene) return 0;
    const y = clientY - this.stage.getBoundingClientRect().top;
    const limit = l.half / l.scale;
    return Math.min(limit, Math.max(-limit, (l.y0 - y) / l.scale));
  }

  private bind(): void {
    const t = this.target;
    t.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || this.dragging) return;
      e.preventDefault();
      this.dragging = true;
      this.pointerId = e.pointerId;
      this.startY = e.clientY;
      this.moved = false;
      try {
        t.setPointerCapture(e.pointerId);
      } catch {
        // Synthetic events in some test environments cannot be captured; dragging still works.
      }
      this.events.grab(this.fractionAt(e.clientX), this.amplitudeAt(e.clientY));
    });
    t.addEventListener('pointermove', (e) => {
      if (this.dragging && e.pointerId === this.pointerId) {
        if (Math.abs(e.clientY - this.startY) > 4) this.moved = true;
        this.events.drag(this.fractionAt(e.clientX), this.amplitudeAt(e.clientY));
      } else if (!this.dragging && e.pointerType === 'mouse') {
        this.hover = this.fractionAt(e.clientX);
        if (this.lastFrame) this.draw(this.lastFrame);
      }
    });
    const end = (e: PointerEvent) => {
      if (!this.dragging || e.pointerId !== this.pointerId) return;
      this.dragging = false;
      this.events.release(this.fractionAt(e.clientX), this.amplitudeAt(e.clientY), this.moved);
    };
    t.addEventListener('pointerup', end);
    t.addEventListener('pointercancel', end);
    t.addEventListener('pointerleave', () => {
      this.hover = null;
      if (this.lastFrame && !this.dragging) this.draw(this.lastFrame);
    });
    t.addEventListener('keydown', (e) => {
      const step = e.shiftKey ? 0.05 : 0.01;
      if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') this.events.keyMove(+step);
      else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') this.events.keyMove(-step);
      else if (e.key === 'PageUp') this.events.keyMove(-0.1);
      else if (e.key === 'PageDown') this.events.keyMove(0.1);
      else if (e.key === 'Enter' || e.key === ' ') this.events.keyPluck();
      else return;
      e.preventDefault();
    });
    t.addEventListener('focus', () => {
      this.focused = t.matches(':focus-visible');
      if (this.lastFrame) this.draw(this.lastFrame);
    });
    t.addEventListener('blur', () => {
      this.focused = false;
      if (this.lastFrame) this.draw(this.lastFrame);
    });
  }

  get isDragging(): boolean {
    return this.dragging;
  }

  // ---------------------------------------------------------------- drawing

  private renderStatic(l: Layout): void {
    const s = this.scene;
    const c = this.staticLayer;
    c.width = Math.round(l.w * l.dpr);
    c.height = Math.round(l.h * l.dpr);
    const g = c.getContext('2d')!;
    g.setTransform(l.dpr, 0, 0, l.dpr, 0, 0);
    const th = this.theme;
    g.fillStyle = th.paper;
    g.fillRect(0, 0, l.w, l.h);
    drawGrain(g, l.w, l.h, th);
    if (!s) return;

    const span = l.bridgeX - l.nutX;
    const blockH = l.compact ? 22 : 30;
    // After-lengths: the string continues over the nut to the tuner and over the bridge.
    g.strokeStyle = th.brassDeep;
    g.globalAlpha = 0.55;
    g.lineWidth = 1.4;
    g.beginPath();
    g.moveTo(l.nutX, l.y0);
    g.lineTo(Math.max(0, l.nutX - (l.compact ? 30 : 70)), l.y0 + (l.compact ? 7 : 12));
    g.moveTo(l.bridgeX, l.y0);
    g.lineTo(Math.min(l.w, l.bridgeX + (l.compact ? 30 : 70)), l.y0 + (l.compact ? 9 : 16));
    g.stroke();
    g.globalAlpha = 1;

    drawTermination(g, l.nutX, l.y0, l.compact ? 9 : 12, blockH, 'left', th);
    drawTermination(g, l.bridgeX, l.y0, l.compact ? 11 : 16, blockH, 'right', th);

    // End labels.
    g.fillStyle = th.inkSoft;
    g.font = `600 ${l.compact ? 9 : 10.5}px ${th.sans}`;
    setSpacing(g, '0.12em');
    g.textBaseline = 'top';
    g.textAlign = 'left';
    g.fillText(
      s.ends.left.toUpperCase(),
      Math.max(4, l.nutX - (l.compact ? 22 : 26)),
      l.y0 + blockH + 6,
    );
    g.textAlign = 'right';
    g.fillText(
      s.ends.right.toUpperCase(),
      Math.min(l.w - 4, l.bridgeX + (l.compact ? 22 : 30)),
      l.y0 + blockH + 6,
    );
    setSpacing(g, '0px');

    // Ruler (a dimension line) with the harmonic division marks measured from the bridge.
    const ry = l.rulerY;
    g.strokeStyle = th.ink;
    g.lineWidth = 1;
    g.globalAlpha = 0.35;
    g.setLineDash([2, 3]);
    g.beginPath();
    g.moveTo(l.nutX, l.y0 + blockH + (l.compact ? 18 : 22));
    g.lineTo(l.nutX, ry + 5);
    g.moveTo(l.bridgeX, l.y0 + blockH + (l.compact ? 18 : 22));
    g.lineTo(l.bridgeX, ry + 5);
    g.stroke();
    g.setLineDash([]);
    g.globalAlpha = 0.85;
    g.beginPath();
    g.moveTo(l.nutX, ry);
    g.lineTo(l.bridgeX, ry);
    g.stroke();
    arrowHead(g, l.nutX, ry, -1, th.ink);
    arrowHead(g, l.bridgeX, ry, 1, th.ink);
    g.globalAlpha = 1;

    for (const n of FRACTIONS) {
      const x = l.bridgeX - span / n;
      g.strokeStyle = th.ink;
      g.globalAlpha = 0.7;
      g.beginPath();
      g.moveTo(x, ry - 4);
      g.lineTo(x, ry + 4);
      g.stroke();
      g.globalAlpha = 1;
      drawFraction(g, x, ry + 7, n, l.compact, th);
    }
    // L/12 (near the bridge): a short tick only.
    g.globalAlpha = 0.5;
    g.beginPath();
    g.moveTo(l.bridgeX - span / 12, ry - 3);
    g.lineTo(l.bridgeX - span / 12, ry + 3);
    g.stroke();
    g.globalAlpha = 1;

    // Length label in the free left half of the ruler.
    const label = `L = ${s.length >= 1 ? `${s.length.toFixed(3)} m` : `${Math.round(s.length * 1000)} mm`}`;
    g.font = `italic ${l.compact ? 13 : 15}px ${th.serif}`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    const lx = l.nutX + span * 0.25;
    const tw = g.measureText(label).width + 14;
    g.fillStyle = th.paper;
    g.fillRect(lx - tw / 2, ry - 9, tw, 18);
    g.fillStyle = th.ink;
    g.fillText(label, lx, ry);

    // Excitation marker on the ruler.
    const ex = l.bridgeX - s.excitePoint * span;
    g.fillStyle = th.brass;
    g.strokeStyle = th.brassDeep;
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(ex, ry - 2);
    g.lineTo(ex - 6, ry - 12);
    g.lineTo(ex + 6, ry - 12);
    g.closePath();
    g.fill();
    g.stroke();
    g.fillStyle = th.brassDeep;
    g.font = `600 ${l.compact ? 9 : 10}px ${th.sans}`;
    setSpacing(g, '0.1em');
    g.textAlign = ex > l.bridgeX - 60 ? 'right' : 'left';
    g.textBaseline = 'bottom';
    g.fillText(
      s.excitation === 'pluck' ? 'PLUCK' : 'HAMMER',
      ex + (g.textAlign === 'right' ? -9 : 9),
      ry - 6,
    );
    setSpacing(g, '0px');

    // Pickup, under the string.
    if (s.pickup != null) {
      const px = l.bridgeX - s.pickup * span;
      const py = l.y0 + Math.min(l.half * 0.55, l.compact ? 20 : 30);
      const pw = l.compact ? 26 : 38;
      const ph = l.compact ? 9 : 12;
      g.fillStyle = th.ink;
      roundRect(g, px - pw / 2, py, pw, ph, 3);
      g.fill();
      g.fillStyle = th.brassLight;
      for (let i = 0; i < 6; i++) {
        g.beginPath();
        g.arc(px - pw / 2 + (pw / 7) * (i + 1), py + ph / 2, l.compact ? 1.2 : 1.6, 0, Math.PI * 2);
        g.fill();
      }
      g.fillStyle = th.inkSoft;
      g.font = `600 ${l.compact ? 8.5 : 10}px ${th.sans}`;
      setSpacing(g, '0.1em');
      g.textAlign = 'center';
      g.textBaseline = 'top';
      g.fillText('PICKUP', px, py + ph + 4);
      setSpacing(g, '0px');
    }
  }

  draw(frame: StringFrame): void {
    this.lastFrame = frame;
    const l = this.computeLayout();
    const changed =
      !this.layout ||
      this.layout.w !== l.w ||
      this.layout.h !== l.h ||
      this.layout.y0 !== l.y0 ||
      this.layout.dpr !== l.dpr;
    this.layout = l;
    if (changed || this.dirtyStatic) {
      this.renderStatic(l);
      this.dirtyStatic = false;
      this.onLayout?.();
    }
    const g = this.ctx;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.drawImage(this.staticLayer, 0, 0);
    g.setTransform(l.dpr, 0, 0, l.dpr, 0, 0);
    const s = this.scene;
    if (!s) return;
    const th = this.theme;
    const span = l.bridgeX - l.nutX;

    if (this.hover !== null && !this.dragging) {
      const hx = l.nutX + this.hover * span;
      g.strokeStyle = th.ink;
      g.globalAlpha = 0.16;
      g.lineWidth = 1;
      g.beginPath();
      g.moveTo(hx, l.y0 - l.half);
      g.lineTo(hx, l.rulerY - 14);
      g.stroke();
      g.globalAlpha = 1;
    }

    if (s.excitation === 'strike') this.drawHammer(g, l, frame, th);

    const thickness = stringThickness(s.diameter, l.compact);
    const N = frame.N;
    const colors = stringColors(s.material, th);
    if (N > 0 && frame.mode === 'envelope' && frame.envelope && frame.count > 0) {
      this.drawEnvelope(g, l, N, frame.envelope, colors, thickness);
    } else if (N > 0 && frame.count > 1) {
      g.globalAlpha = Math.min(0.5, 2.2 / frame.count);
      for (let i = 0; i < frame.count; i++) {
        this.strokeShape(g, l, N, frame.shapes[i], colors.core, thickness * 0.8);
      }
      g.globalAlpha = 1;
    } else if (N > 0 && frame.count === 1) {
      this.drawCrisp(g, l, N, frame.shapes[0], colors, thickness, s.material === 'wound');
    } else {
      // At rest.
      const flat = new Float32Array(2);
      this.drawCrisp(g, l, 1, flat, colors, thickness, s.material === 'wound');
    }

    if (frame.grab) {
      const gx = l.nutX + frame.grab.x * span;
      const gy = l.y0 - frame.grab.amplitude * l.scale;
      g.fillStyle = th.paperLight;
      g.strokeStyle = th.ink;
      g.lineWidth = 1.5;
      g.beginPath();
      g.arc(gx, gy, 9, 0, Math.PI * 2);
      g.fill();
      g.stroke();
      g.fillStyle = th.ink;
      g.beginPath();
      g.arc(gx, gy, 3, 0, Math.PI * 2);
      g.fill();
      const text = `${(Math.abs(frame.grab.amplitude) * 1000).toFixed(1)} mm`;
      g.font = `italic ${l.compact ? 13 : 15}px ${th.serif}`;
      g.textBaseline = 'middle';
      g.textAlign = gx > l.w - 90 ? 'right' : 'left';
      g.fillText(
        text,
        gx + (g.textAlign === 'right' ? -16 : 16),
        gy + (frame.grab.amplitude >= 0 ? -14 : 14),
      );
    } else if (this.focused) {
      const fx = l.bridgeX - s.excitePoint * span;
      g.strokeStyle = th.indigo;
      g.lineWidth = 2;
      g.setLineDash([3, 3]);
      g.beginPath();
      g.arc(fx, l.y0, 13, 0, Math.PI * 2);
      g.stroke();
      g.setLineDash([]);
    }
  }

  private yOf(l: Layout, u: number): number {
    const y = l.y0 - u * l.scale;
    const lim = l.half + 8;
    return Math.min(l.y0 + lim, Math.max(l.y0 - lim, y));
  }

  private path(g: CanvasRenderingContext2D, l: Layout, N: number, shape: ArrayLike<number>): void {
    const span = l.bridgeX - l.nutX;
    g.beginPath();
    for (let i = 0; i <= N; i++) {
      const x = l.nutX + (i / N) * span;
      const y = this.yOf(l, shape[i] ?? 0);
      if (i === 0) g.moveTo(x, y);
      else g.lineTo(x, y);
    }
  }

  private strokeShape(
    g: CanvasRenderingContext2D,
    l: Layout,
    N: number,
    shape: ArrayLike<number>,
    color: string,
    width: number,
  ): void {
    this.path(g, l, N, shape);
    g.strokeStyle = color;
    g.lineWidth = width;
    g.lineJoin = 'round';
    g.lineCap = 'round';
    g.stroke();
  }

  private drawCrisp(
    g: CanvasRenderingContext2D,
    l: Layout,
    N: number,
    shape: ArrayLike<number>,
    colors: StringColors,
    thickness: number,
    wound: boolean,
  ): void {
    this.strokeShape(g, l, N, shape, colors.edge, thickness + 1.2);
    this.strokeShape(g, l, N, shape, colors.core, thickness);
    if (wound && thickness >= 2.6) {
      // Winding texture: short diagonal strokes along the string.
      g.save();
      this.path(g, l, N, shape);
      g.lineWidth = thickness;
      g.strokeStyle = colors.edge;
      g.globalAlpha = 0.45;
      g.setLineDash([1, 2.2]);
      g.stroke();
      g.restore();
    }
    g.save();
    g.translate(0, -thickness * 0.22);
    this.strokeShape(g, l, N, shape, colors.highlight, Math.max(0.6, thickness * 0.28));
    g.restore();
  }

  private drawEnvelope(
    g: CanvasRenderingContext2D,
    l: Layout,
    N: number,
    env: Float32Array,
    colors: StringColors,
    thickness: number,
  ): void {
    const span = l.bridgeX - l.nutX;
    g.beginPath();
    for (let i = 0; i <= N; i++) {
      const x = l.nutX + (i / N) * span;
      const y = this.yOf(l, env[i]);
      if (i === 0) g.moveTo(x, y);
      else g.lineTo(x, y);
    }
    for (let i = N; i >= 0; i--) {
      const x = l.nutX + (i / N) * span;
      g.lineTo(x, this.yOf(l, -env[i]));
    }
    g.closePath();
    g.fillStyle = colors.core;
    g.globalAlpha = 0.18;
    g.fill();
    g.globalAlpha = 0.75;
    g.strokeStyle = colors.edge;
    g.lineWidth = 1;
    g.stroke();
    g.globalAlpha = 1;
    const flat = new Float32Array(2);
    this.strokeShape(g, l, 1, flat, colors.core, thickness * 0.8);
  }

  private drawHammer(g: CanvasRenderingContext2D, l: Layout, frame: StringFrame, th: Theme): void {
    const s = this.scene!;
    const span = l.bridgeX - l.nutX;
    const x = l.bridgeX - s.excitePoint * span;
    const disp = frame.hammer ?? -HAMMER_REST;
    const top = Math.min(l.y0 + l.half, Math.max(l.y0 - l.half, l.y0 - disp * l.scale));
    const hw = l.compact ? 12 : 16;
    const hh = l.compact ? 10 : 13;
    // Shank.
    g.strokeStyle = th.brassDeep;
    g.lineWidth = l.compact ? 2.5 : 3;
    g.beginPath();
    g.moveTo(x, top + hh);
    g.lineTo(x, top + hh + (l.compact ? 16 : 26));
    g.stroke();
    // Felt head.
    g.fillStyle = th.felt;
    g.strokeStyle = th.ink;
    g.lineWidth = 1;
    roundRect(g, x - hw / 2, top + 1.5, hw, hh, hh / 2.2);
    g.fill();
    g.stroke();
  }
}

// ------------------------------------------------------------------ helpers

interface StringColors {
  core: string;
  edge: string;
  highlight: string;
}

function stringColors(material: MaterialId, th: Theme): StringColors {
  if (material === 'nylon') return { core: '#faf6ee', edge: th.inkSoft, highlight: '#ffffff' };
  if (material === 'gut') return { core: '#d4b06a', edge: '#8a6a2c', highlight: '#f2deb0' };
  return { core: th.brass, edge: th.brassDeep, highlight: th.brassLight };
}

function stringThickness(diameter: number, compact: boolean): number {
  const t = 1.4 + diameter * 1000 * 1.6;
  return Math.min(compact ? 5.5 : 7, Math.max(compact ? 1.6 : 1.9, t));
}

function setSpacing(g: CanvasRenderingContext2D, value: string): void {
  if ('letterSpacing' in g)
    (g as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing = value;
}

function roundRect(
  g: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

function arrowHead(
  g: CanvasRenderingContext2D,
  x: number,
  y: number,
  dir: 1 | -1,
  color: string,
): void {
  g.fillStyle = color;
  g.beginPath();
  g.moveTo(x, y);
  g.lineTo(x - dir * 8, y - 3);
  g.lineTo(x - dir * 8, y + 3);
  g.closePath();
  g.fill();
}

function drawFraction(
  g: CanvasRenderingContext2D,
  x: number,
  y: number,
  n: number,
  compact: boolean,
  th: Theme,
): void {
  const size = compact ? 10 : 11.5;
  g.fillStyle = th.ink;
  g.font = `500 ${size}px ${th.serif}`;
  g.textAlign = 'center';
  g.textBaseline = 'top';
  g.fillText('1', x, y);
  g.strokeStyle = th.ink;
  g.lineWidth = 0.8;
  g.beginPath();
  g.moveTo(x - 4.5, y + size + 1);
  g.lineTo(x + 4.5, y + size + 1);
  g.stroke();
  g.fillText(String(n), x, y + size + 2);
}

/** A bone nut or saddle in section, hatched like a technical drawing. */
function drawTermination(
  g: CanvasRenderingContext2D,
  x: number,
  y0: number,
  width: number,
  height: number,
  side: 'left' | 'right',
  th: Theme,
): void {
  const x0 = side === 'left' ? x - width : x - 2;
  const x1 = side === 'left' ? x + 2 : x + width;
  g.save();
  g.beginPath();
  if (side === 'left') {
    g.moveTo(x0, y0 + height);
    g.lineTo(x0, y0 + 2);
    g.quadraticCurveTo(x0, y0 - 1.5, x0 + 4, y0 - 1.5);
    g.lineTo(x1, y0 - 1.5);
    g.lineTo(x1, y0 + height);
  } else {
    g.moveTo(x0, y0 + height);
    g.lineTo(x0 + 1, y0 + 1);
    g.quadraticCurveTo(x0 + 3, y0 - 2.5, x0 + 6, y0 - 1);
    g.lineTo(x1, y0 + height * 0.45);
    g.lineTo(x1, y0 + height);
  }
  g.closePath();
  g.fillStyle = th.paperLight;
  g.fill();
  g.clip();
  g.strokeStyle = th.ink;
  g.globalAlpha = 0.35;
  g.lineWidth = 0.8;
  for (let i = -height; i < width + height; i += 4) {
    g.beginPath();
    g.moveTo(x0 + i, y0 + height);
    g.lineTo(x0 + i + height, y0);
    g.stroke();
  }
  g.restore();
  g.save();
  g.beginPath();
  if (side === 'left') {
    g.moveTo(x0, y0 + height);
    g.lineTo(x0, y0 + 2);
    g.quadraticCurveTo(x0, y0 - 1.5, x0 + 4, y0 - 1.5);
    g.lineTo(x1, y0 - 1.5);
    g.lineTo(x1, y0 + height);
  } else {
    g.moveTo(x0, y0 + height);
    g.lineTo(x0 + 1, y0 + 1);
    g.quadraticCurveTo(x0 + 3, y0 - 2.5, x0 + 6, y0 - 1);
    g.lineTo(x1, y0 + height * 0.45);
    g.lineTo(x1, y0 + height);
  }
  g.strokeStyle = th.ink;
  g.lineWidth = 1.2;
  g.stroke();
  g.restore();
}

/** Very subtle procedural maple grain: long wavy fibres and a faint flame figure. */
function drawGrain(g: CanvasRenderingContext2D, w: number, h: number, th: Theme): void {
  let seed = 1234567;
  const rand = () => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };
  g.save();
  // Flame figure: soft vertical bands of light and shade.
  for (let x = 0; x < w; x += 6) {
    const v = Math.sin(x * 0.021) * 0.5 + Math.sin(x * 0.0067 + 1.3) * 0.5;
    g.fillStyle = v > 0 ? 'rgba(255,250,240,1)' : th.paperDeep;
    g.globalAlpha = Math.abs(v) * 0.05;
    g.fillRect(x, 0, 6, h);
  }
  // Fibres.
  g.strokeStyle = th.paperDeep;
  g.lineWidth = 0.7;
  const lines = Math.round(h / 3.2);
  for (let i = 0; i < lines; i++) {
    const y = rand() * h;
    const a1 = 0.6 + rand() * 1.8;
    const f1 = 0.002 + rand() * 0.004;
    const p1 = rand() * Math.PI * 2;
    g.globalAlpha = 0.18 + rand() * 0.32;
    g.beginPath();
    for (let x = -10; x <= w + 10; x += 12) {
      const yy = y + a1 * Math.sin(x * f1 + p1) + 0.4 * Math.sin(x * 0.03 + p1 * 2);
      if (x === -10) g.moveTo(x, yy);
      else g.lineTo(x, yy);
    }
    g.stroke();
  }
  g.restore();
}
