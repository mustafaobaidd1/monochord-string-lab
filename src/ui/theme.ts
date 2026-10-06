/** Colours and fonts shared by the canvas views, read from the CSS custom properties. */
export interface Theme {
  paper: string;
  paperLight: string;
  paperDeep: string;
  ink: string;
  inkSoft: string;
  line: string;
  brass: string;
  brassDeep: string;
  brassLight: string;
  teal: string;
  tealSoft: string;
  indigo: string;
  rust: string;
  felt: string;
  serif: string;
  sans: string;
}

export function readTheme(el: Element = document.documentElement): Theme {
  const cs = getComputedStyle(el);
  const v = (name: string, fallback: string) => cs.getPropertyValue(name).trim() || fallback;
  return {
    paper: v('--paper', '#f3eadb'),
    paperLight: v('--paper-light', '#f8f2e6'),
    paperDeep: v('--paper-deep', '#e6d6bb'),
    ink: v('--ink', '#3b2a1e'),
    inkSoft: v('--ink-soft', '#6b5644'),
    line: v('--line', 'rgba(59,42,30,0.2)'),
    brass: v('--brass', '#b8862b'),
    brassDeep: v('--brass-deep', '#7d5a1a'),
    brassLight: v('--brass-light', '#e3c27a'),
    teal: v('--teal', '#2f6e68'),
    tealSoft: v('--teal-soft', 'rgba(47,110,104,0.16)'),
    indigo: v('--indigo', '#3d4a86'),
    rust: v('--rust', '#9a3b22'),
    felt: v('--felt', '#8c7a63'),
    serif: v('--font-serif', 'Spectral, Georgia, serif'),
    sans: v('--font-sans', '"Work Sans Variable", system-ui, sans-serif'),
  };
}

/** Sizes a canvas for its CSS box and the device pixel ratio; returns the CSS size. */
export function fitCanvas(
  canvas: HTMLCanvasElement,
  maxDpr = 2,
): { w: number; h: number; dpr: number } {
  const rect = canvas.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, maxDpr);
  const w = Math.max(1, Math.round(rect.width));
  const h = Math.max(1, Math.round(rect.height));
  const bw = Math.round(w * dpr);
  const bh = Math.round(h * dpr);
  if (canvas.width !== bw || canvas.height !== bh) {
    canvas.width = bw;
    canvas.height = bh;
  }
  return { w, h, dpr };
}
