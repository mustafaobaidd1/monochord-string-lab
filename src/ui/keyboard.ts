/**
 * A two-octave keyboard (one octave at a time on narrow screens). Each key retunes the string's
 * tension to the note, T = mu (2 L f)^2, and excites it. Computer keys follow the common
 * two-row layout: Z S X D C V G B H N J M , for the lower octave and Q 2 W 3 E R 5 T 6 Y 7 U I
 * for the upper one.
 */
import { isBlackKey, midiToFrequency, noteName } from '../dsp/notes.ts';
import { hz, sig3 } from '../app/format.ts';

const LOWER = [
  'KeyZ',
  'KeyS',
  'KeyX',
  'KeyD',
  'KeyC',
  'KeyV',
  'KeyG',
  'KeyB',
  'KeyH',
  'KeyN',
  'KeyJ',
  'KeyM',
  'Comma',
];
const UPPER = [
  'KeyQ',
  'Digit2',
  'KeyW',
  'Digit3',
  'KeyE',
  'KeyR',
  'Digit5',
  'KeyT',
  'Digit6',
  'KeyY',
  'Digit7',
  'KeyU',
  'KeyI',
];
const LABELS: Record<string, string> = {
  Comma: ',',
  Digit2: '2',
  Digit3: '3',
  Digit5: '5',
  Digit6: '6',
  Digit7: '7',
};

export interface KeyboardModel {
  /** Lowest key (a C), MIDI number. */
  start: number;
  /** Note of the current preset (highlighted as "home"). */
  home: number;
  /** Tension (N) needed for a MIDI note. */
  tensionFor(midi: number): number;
  breakingLoad: number;
}

export class Keyboard {
  private model: KeyboardModel | null = null;
  private keys = new Map<number, HTMLButtonElement>();
  private octave = 0;
  private active: number | null = null;
  private readonly narrow = window.matchMedia('(max-width: 640px)');

  constructor(
    private readonly root: HTMLElement,
    private readonly onPlay: (midi: number) => void,
    private readonly note: HTMLElement,
  ) {
    document.getElementById('octave-down')!.addEventListener('click', () => this.setOctave(0));
    document.getElementById('octave-up')!.addEventListener('click', () => this.setOctave(1));
    this.narrow.addEventListener('change', () => this.applyOctave());
    document.addEventListener('keydown', (e) => this.onKey(e));
  }

  setModel(model: KeyboardModel): void {
    this.model = model;
    this.octave = model.home >= model.start + 12 ? 1 : 0;
    this.build();
  }

  private build(): void {
    const m = this.model!;
    this.root.innerHTML = '';
    this.keys.clear();
    const whites = document.createElement('div');
    whites.className = 'keys';
    this.root.append(whites);
    for (let i = 0; i <= 24; i++) {
      const midi = m.start + i;
      const black = isBlackKey(midi);
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `key ${black ? 'key--black' : 'key--white'}`;
      b.dataset.midi = String(midi);
      b.dataset.octave = String(i < 12 ? 0 : i === 24 ? 2 : 1);
      const f = midiToFrequency(midi);
      const T = m.tensionFor(midi);
      const over = T > m.breakingLoad;
      const code = i < 12 ? LOWER[i] : UPPER[i - 12];
      const keyLabel = code ? (LABELS[code] ?? code.replace('Key', '')) : '';
      b.setAttribute(
        'aria-label',
        `${noteName(midi)}, ${hz(f)}, tension ${sig3(T)} newtons${over ? ', beyond the breaking load' : ''}`,
      );
      b.innerHTML = `${!black && midi % 12 === 0 ? `<span class="key-name">${noteName(midi)}</span>` : ''}<span class="key-code" aria-hidden="true">${keyLabel}</span>${over ? '<span class="key-warn" aria-hidden="true">!</span>' : ''}`;
      if (over) b.classList.add('key--overload');
      if (midi === m.home) b.classList.add('key--home');
      b.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        this.play(midi);
      });
      b.addEventListener('click', (e) => {
        // Keyboard activation (Enter / Space) arrives as a click with detail 0.
        if (e.detail === 0) this.play(midi);
      });
      whites.append(b);
      this.keys.set(midi, b);
    }
    this.applyOctave();
    this.renderActive();
  }

  private setOctave(o: number): void {
    this.octave = o;
    this.applyOctave();
  }

  private applyOctave(): void {
    const narrow = this.narrow.matches;
    this.root.classList.toggle('keyboard--one-octave', narrow);
    for (const b of this.keys.values()) {
      const o = Number(b.dataset.octave);
      const visible =
        !narrow ||
        o === this.octave ||
        (o === 2 && this.octave === 1) ||
        (o === 1 && Number(b.dataset.midi) % 12 === 0 && this.octave === 0);
      b.hidden = !visible;
    }
    this.layoutKeys();
    const down = document.getElementById('octave-down') as HTMLButtonElement;
    const up = document.getElementById('octave-up') as HTMLButtonElement;
    down.setAttribute('aria-pressed', String(this.octave === 0));
    up.setAttribute('aria-pressed', String(this.octave === 1));
    const m = this.model;
    const range = document.getElementById('octave-range');
    if (m && range) {
      const lo = m.start + 12 * this.octave;
      range.textContent = `${noteName(lo)}–${noteName(lo + 12)}`;
    }
  }

  /** Positions the black keys on the boundaries between the visible white keys. */
  private layoutKeys(): void {
    const visible = [...this.keys.values()].filter((b) => !b.hidden);
    const whites = visible.filter((b) => b.classList.contains('key--white'));
    this.root.style.setProperty('--n', String(whites.length));
    let k = 0;
    for (const b of visible) {
      if (b.classList.contains('key--white')) k++;
      else b.style.setProperty('--k', String(k));
    }
  }

  private play(midi: number): void {
    this.active = midi;
    this.renderActive();
    this.onPlay(midi);
    const m = this.model;
    if (!m) return;
    const T = m.tensionFor(midi);
    this.note.textContent =
      T > m.breakingLoad
        ? `${noteName(midi)} needs ${sig3(T)} N, beyond the ≈${sig3(m.breakingLoad)} N breaking load: a real string of this gauge would snap. That is why instruments use a different gauge for each note.`
        : `${noteName(midi)}: tension ${sig3(T)} N (${Math.round((T / m.breakingLoad) * 100)} % of the breaking load).`;
  }

  private renderActive(): void {
    for (const [midi, b] of this.keys) b.classList.toggle('key--active', midi === this.active);
  }

  clearActive(): void {
    this.active = null;
    this.renderActive();
    this.note.textContent = '';
  }

  private onKey(e: KeyboardEvent): void {
    if (e.repeat || e.ctrlKey || e.metaKey || e.altKey || !this.model) return;
    const t = e.target as HTMLElement | null;
    if (
      t &&
      (t.tagName === 'SELECT' ||
        t.tagName === 'TEXTAREA' ||
        (t.tagName === 'INPUT' && (t as HTMLInputElement).type === 'text'))
    )
      return;
    let index = LOWER.indexOf(e.code);
    if (index < 0) {
      const u = UPPER.indexOf(e.code);
      if (u >= 0) index = 12 + u;
    }
    if (index < 0) return;
    e.preventDefault();
    this.play(this.model.start + index);
  }
}
