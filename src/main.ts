import './styles/fonts.css';
import './styles/main.css';
import { Analyzer } from './audio/analyzer.ts';
import {
  SoundEngine,
  type AudioPreference,
  type SoundMode,
  type SoundStatus,
} from './audio/engine.ts';
import type { SynthCommand } from './audio/synth.ts';
import { hz, ratio, sci } from './app/format.ts';
import { paramByKey, type ParamContext } from './app/params.ts';
import { PictureEngine, slowFactorFor } from './app/picture.ts';
import {
  initialState,
  outputSettings,
  pitchLabel,
  predictExcitation,
  presetOf,
  stateForPreset,
  stringInfo,
  type AppState,
  type ExcitationPrediction,
  type Snapshot,
} from './app/state.ts';
import { midiToFrequency, parseNote } from './dsp/notes.ts';
import { MATERIALS, linearDensity, tensionForFrequency } from './physics/materials.ts';
import { hammerSpec, pluckSpec, presetById } from './physics/presets.ts';
import { Controls } from './ui/controls.ts';
import { Keyboard } from './ui/keyboard.ts';
import { noteReadout, renderStretch, renderTension, type TensionModel } from './ui/charts.ts';
import { renderPartials } from './ui/partials.ts';
import { SpectrumView } from './ui/spectrum-view.ts';
import { StringView } from './ui/string-view.ts';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

// ------------------------------------------------------------------ setup

const params = new URLSearchParams(location.search);
const preference = (
  ['fallback', 'off'].includes(params.get('audio') ?? '') ? params.get('audio') : 'auto'
) as AudioPreference;
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

let state: AppState = initialState();
if (reducedMotion.matches) state.slowMotion = false;

let analyzer: Analyzer;
let picture: PictureEngine;
let prediction: ExcitationPrediction | null = null;
let snapshot: Snapshot | null = null;
let userPlucked = false;
let holdId = 0;
let holding = false;
let grab: { x: number; amplitude: number } | null = null;
let stringDirty = true;
let lastSpectrumDraw = 0;

const engine = new SoundEngine(
  {
    samples: (frame, data) => analyzer.push(frame, data),
    onset: (info) => analyzer.onset(info.frame),
    status: (status, mode, detail) => onSoundStatus(status, mode, detail),
    error: (message) => toast(message),
  },
  preference,
);

function makeAnalyzer(rate: number): Analyzer {
  const a = new Analyzer(rate);
  a.onSnapshot = (s) => onSnapshot(s);
  a.onRow = (row, binHz) => spectrumView.addRow(row, binHz);
  return a;
}

const stringView = new StringView(
  $('string-canvas') as HTMLCanvasElement,
  $('stage'),
  $('string-band'),
  $('string-target'),
  {
    grab: (x, amplitude) => onGrab(x, amplitude),
    drag: (x, amplitude) => onDrag(x, amplitude),
    release: (x, amplitude, moved) => onRelease(x, amplitude, moved),
    keyPluck: () => {
      void engine.start();
      excite();
    },
    keyMove: (delta) => moveExcitePoint(delta),
  },
);
stringView.onLayout = () => placeHint();
const spectrumView = new SpectrumView($('spectrum-canvas') as HTMLCanvasElement);
analyzer = makeAnalyzer(engine.sampleRate);
picture = new PictureEngine(engine.sampleRate);

const controls = new Controls({
  setParam: (key, value, commit) => setParam(key, value, commit),
  setPreset: (id) => {
    void engine.start();
    applyPreset(id, true);
  },
  setMaterial: (id) => {
    const s = { ...state.string, material: id, inharmonicity: null };
    const [lo, hi] = MATERIALS[id].diameterRange;
    s.diameter = Math.min(hi, Math.max(lo, s.diameter));
    if (id !== 'wound') {
      delete s.coreRatio;
      delete s.density;
      delete s.youngsModulus;
    }
    retuneKeepingPitch(s);
    update({ string: s, customised: true });
    scheduleExcite();
  },
  setExcitation: (kind) => {
    update({ excitation: kind });
    void engine.start();
    excite();
  },
  setOutput: (kind) => {
    update({ output: { ...state.output, kind } });
    engine.send({ type: 'output', output: outputSettings(state) });
    picture.voice.setOutput(outputSettings(state));
    scheduleExcite();
  },
  exciteAt: (fromBridge) => {
    void engine.start();
    if (state.excitation === 'pluck') update({ pluck: { ...state.pluck, fromBridge } });
    else update({ strike: { ...state.strike, fromBridge } });
    excite();
  },
  excite: () => {
    void engine.start();
    excite();
  },
  toggleMute: () => {
    update({ muted: !state.muted });
    sendMaster();
  },
  resetStiffness: () => {
    update({ string: { ...state.string, inharmonicity: null } });
    scheduleExcite();
  },
});

const keyboard = new Keyboard($('keyboard'), (midi) => playNote(midi), $('keyboard-note'));

// ------------------------------------------------------------------ state

function context(): ParamContext {
  return {
    state,
    info: stringInfo(state.string, engine.sampleRate),
    sampleRate: engine.sampleRate,
  };
}

function update(patch: Partial<AppState>): void {
  state = { ...state, ...patch };
  render();
}

function render(): void {
  const ctx = context();
  controls.render(state, ctx);
  const preset = presetOf(state);
  const { physics } = ctx.info;
  $('spec-string').textContent = state.customised
    ? `${preset.name} (modified) · ${MATERIALS[state.string.material].label.toLowerCase()}`
    : `${preset.name} · ${preset.detail}`;
  $('spec-f0').innerHTML = `${hz(physics.f0)} <span class="pitch">${pitchLabel(physics.f0)}</span>`;
  $('spec-b').textContent = physics.B === 0 ? '0 (ideal)' : sci(physics.B);
  stringView.setScene({
    length: state.string.length,
    ends: preset.ends,
    excitation: state.excitation,
    excitePoint: state.excitation === 'pluck' ? state.pluck.fromBridge : state.strike.fromBridge,
    pickup: state.output.kind === 'pickup' ? state.output.pickupFromBridge : null,
    material: state.string.material,
    diameter: state.string.diameter,
    displayAmplitude: preset.excitation === 'strike' ? 0.0012 : preset.pluck.amplitude,
  });
  const target = $('string-target');
  const point = state.excitation === 'pluck' ? state.pluck.fromBridge : state.strike.fromBridge;
  target.setAttribute('aria-valuenow', String(Math.round(point * 100)));
  target.setAttribute(
    'aria-valuetext',
    `${Math.round(point * state.string.length * 1000)} millimetres from the bridge, ${ratio(point)}`,
  );
  const f1 = physics.f0 * Math.sqrt(1 + physics.B);
  picture.slowFactor = slowFactorFor(f1);
  const slow = $('slowmo') as HTMLInputElement;
  slow.checked = state.slowMotion;
  $('slowmo-factor').textContent = state.slowMotion ? `×${picture.slowFactor}` : '';
  const pause = $('pause');
  pause.setAttribute('aria-pressed', String(state.paused));
  pause.classList.toggle('is-paused', state.paused);
  $('pause-label').textContent = state.paused ? 'Resume the animation' : 'Pause the animation';
  $('stage').classList.toggle('stage--paused', state.paused);
  stringDirty = true;
  renderSoundPill();
  renderStretchChart();
}

function renderStretchChart(): void {
  const { physics, grid } = stringInfo(state.string, engine.sampleRate);
  // Bars follow the sliders live. Dots are the last measurement, shown only while it still
  // belongs to the current string (a slider being dragged makes it stale until the re-pluck).
  const same = (a: number, b: number) =>
    Math.abs(a - b) <= 1e-9 * Math.max(Math.abs(a), Math.abs(b), 1e-12);
  const current =
    snapshot &&
    prediction &&
    snapshot.tag === prediction.tag &&
    same(prediction.f0, physics.f0) &&
    same(prediction.B, physics.B)
      ? snapshot
      : null;
  const worst = renderStretch($('stretch-chart'), physics.f0, physics.B, current);
  const note = $('stretch-note');
  if (worst == null) note.textContent = 'Dots show the measured partials after each pluck.';
  else if (worst <= -1)
    note.textContent = `Dots below the bars are the scheme's numerical dispersion: with N = ${grid?.N ?? '?'} grid intervals, partials come out up to ${Math.abs(worst).toFixed(1)} ¢ flat.`;
  else
    note.textContent = `Measured partials (dots) match the prediction within ${Math.abs(worst).toFixed(1)} ¢.`;
}

/** Keeps the "drag the string" hint just above the string at the excitation point. */
function placeHint(): void {
  const point = state.excitation === 'pluck' ? state.pluck.fromBridge : state.strike.fromBridge;
  const band = $('string-band');
  const x = stringView.xOfFromBridge(point);
  const y =
    stringView.baselineY -
    (band.getBoundingClientRect().top - $('stage').getBoundingClientRect().top);
  if (x > 0) band.style.setProperty('--hint-x', `${x}px`);
  band.style.setProperty('--hint-y', `${Math.max(0, y - 70)}px`);
  $('stage-hint').classList.toggle('stage-hint--right', x < band.clientWidth * 0.42);
}

/** Keeps the note when the material or gauge changes (a player would retune). */
function retuneKeepingPitch(s: AppState['string']): void {
  const f0 = stringInfo(state.string, engine.sampleRate).physics.f0;
  s.tension = Math.min(3000, Math.max(5, tensionForFrequency(linearDensity(s), s.length, f0)));
}

function setParam(key: string, value: number, commit: boolean): void {
  const def = paramByKey(key);
  const next: AppState = structuredClone(state);
  if (key === 'string.diameter') {
    next.string.diameter = value;
    retuneKeepingPitch(next.string);
  } else {
    def.set(next, value);
  }
  if (def.string) next.customised = true;
  state = next;
  render();
  if (key === 'volume') sendMaster();
  else if (key === 'output.pickupFromBridge') {
    engine.send({ type: 'output', output: outputSettings(state) });
    if (commit) scheduleExcite();
  } else if (commit) scheduleExcite();
}

function applyPreset(id: string, play: boolean): void {
  const preset = presetById(id);
  state = stateForPreset(preset, state);
  if (reducedMotion.matches && !userTouchedMotion) state.slowMotion = false;
  render();
  updateKeyboard();
  keyboard.clearActive();
  spectrumView.clearHistory();
  if (play) excite();
}

function updateKeyboard(): void {
  const preset = presetOf(state);
  const home = parseNote(preset.note);
  const start = 12 * Math.round((home - 12) / 12);
  const s = state.string;
  const mu = linearDensity(s);
  tensionModel = {
    start,
    home,
    tensionFor: (midi) => tensionForFrequency(mu, s.length, midiToFrequency(midi)),
    breakingLoad: stringInfo(s, engine.sampleRate).physics.breakingLoad,
  };
  keyboard.setModel(tensionModel);
  renderTension($('tension-chart'), tensionModel, null);
  $('note-readout').innerHTML =
    '<span class="readout-hint">Play a key: the string is retuned and plucked.</span>';
}

let tensionModel: TensionModel | null = null;

function playNote(midi: number): void {
  void engine.start();
  const s = { ...state.string };
  s.tension = tensionForFrequency(linearDensity(s), s.length, midiToFrequency(midi));
  update({ string: s, customised: true });
  excite();
  if (tensionModel) {
    renderTension($('tension-chart'), tensionModel, midi);
    $('note-readout').innerHTML = noteReadout(midi, s.tension, tensionModel.breakingLoad);
  }
}

function moveExcitePoint(delta: number): void {
  if (state.excitation === 'pluck') {
    const fromBridge = Math.min(0.98, Math.max(0.02, state.pluck.fromBridge + delta));
    update({ pluck: { ...state.pluck, fromBridge } });
  } else {
    const fromBridge = Math.min(0.98, Math.max(0.02, state.strike.fromBridge + delta));
    update({ strike: { ...state.strike, fromBridge } });
  }
}

function sendMaster(): void {
  engine.send({ type: 'master', volume: state.volume, muted: state.muted });
}

// ------------------------------------------------------------------ excitation

let exciteTimer = 0;
function scheduleExcite(): void {
  window.clearTimeout(exciteTimer);
  exciteTimer = window.setTimeout(() => excite(), 120);
}

function expect(p: ExcitationPrediction): void {
  prediction = p;
  snapshot = null;
  analyzer.expect({
    predicted: p.frequencies.slice(0, 16),
    predictedAmplitude: p.amplitudes.slice(0, 16),
    f0: p.f0,
    tag: p.tag,
  });
  spectrumView.setPrediction(p);
  renderNotes(p);
  renderPartials($('partials-body'), p, null);
  $('f0-readout').setAttribute('data-state', 'measuring');
}

/** HTML annotations: which partials vanish and why, and the inharmonic stretch. */
function renderNotes(p: ExcitationPrediction): void {
  const items: string[] = [];
  const list = (ns: number[]) => `${ns.slice(0, 3).join(', ')}${ns.length > 3 ? ' …' : ''}`;
  const byExcitation = p.missing.filter(
    (n) => Math.abs(Math.sin(n * Math.PI * p.fromBridge)) < 1e-6,
  );
  const byPickup = p.missing.filter((n) => !byExcitation.includes(n));
  if (byExcitation.length) {
    const verb = p.kind === 'pluck' ? 'plucked' : 'struck';
    items.push(
      `<li class="note-comb"><span class="glyph" aria-hidden="true">×</span>Partials ${list(byExcitation)} missing: ${verb} at ${ratio(Math.min(p.fromBridge, 1 - p.fromBridge))}</li>`,
    );
  }
  if (byPickup.length) {
    items.push(
      `<li class="note-comb"><span class="glyph" aria-hidden="true">×</span>Partials ${list(byPickup)} silent at the pickup (${ratio(p.pickupFromBridge)})</li>`,
    );
  }
  const n = Math.min(20, p.frequencies.length);
  if (n >= 4) {
    const stretch = 1200 * Math.log2(p.frequencies[n - 1] / (n * p.f0));
    if (stretch >= 5) {
      items.push(
        `<li class="note-stretch"><span class="glyph" aria-hidden="true">↗</span>Partial ${n} sits ${stretch.toFixed(0)} ¢ above ${n}·<i>f</i><sub>0</sub>: stiffness stretches the partials</li>`,
      );
    } else {
      items.push(
        `<li class="note-stretch">Partials stay within ${stretch.toFixed(1)} ¢ of whole multiples of <i>f</i><sub>0</sub> up to <i>n</i> = ${n}</li>`,
      );
    }
  }
  $('spectrum-notes').innerHTML = items.join('');
}

function excite(): void {
  window.clearTimeout(exciteTimer);
  const info = stringInfo(state.string, engine.sampleRate);
  if (!info.grid) {
    toast(`This string cannot be simulated stably: ${info.error}`);
    return;
  }
  expect(predictExcitation(state, engine.sampleRate));
  const output = outputSettings(state);
  let cmd: SynthCommand;
  if (state.excitation === 'pluck') {
    const spec = pluckSpec(state.pluck);
    cmd = { type: 'pluck', params: state.string, spec, output };
    picture.pluck(state.string, spec, output);
  } else {
    const spec = hammerSpec(state.strike);
    cmd = { type: 'strike', params: state.string, spec, output };
    picture.strike(state.string, spec, output);
  }
  engine.send(cmd);
  stringDirty = true;
}

function pluckFor(x: number, amplitude: number) {
  return { position: x, width: state.pluck.width, amplitude };
}

function onGrab(x: number, amplitude: number): void {
  void engine.start();
  holding = true;
  holdId++;
  grab = { x, amplitude };
  if (state.excitation !== 'pluck') update({ excitation: 'pluck' });
  const output = outputSettings(state);
  engine.send({
    type: 'hold',
    id: holdId,
    params: state.string,
    spec: pluckFor(x, amplitude),
    output,
  });
  picture.hold(state.string, pluckFor(x, amplitude), output);
  stringDirty = true;
}

function onDrag(x: number, amplitude: number): void {
  if (!holding) return;
  grab = { x, amplitude };
  const output = outputSettings(state);
  engine.send({
    type: 'hold',
    id: holdId,
    params: state.string,
    spec: pluckFor(x, amplitude),
    output,
  });
  picture.hold(state.string, pluckFor(x, amplitude), output);
  stringDirty = true;
}

function onRelease(x: number, amplitude: number, moved: boolean): void {
  if (!holding) return;
  void engine.start();
  holding = false;
  grab = null;
  const fromBridge = Math.min(0.98, Math.max(0.02, 1 - x));
  if (!moved || Math.abs(amplitude) < 0.0001) {
    // A tap without a drag plucks at the tapped point with the current amplitude.
    update({ pluck: { ...state.pluck, fromBridge } });
    excite();
    markUserPluck();
    return;
  }
  update({
    pluck: {
      ...state.pluck,
      fromBridge,
      amplitude: Math.min(0.006, Math.max(0.0002, Math.abs(amplitude))),
    },
  });
  expect(predictExcitation(state, engine.sampleRate));
  engine.send({ type: 'release', id: holdId });
  picture.release();
  markUserPluck();
  stringDirty = true;
}

function markUserPluck(): void {
  if (userPlucked) return;
  userPlucked = true;
  $('stage-hint').classList.add('is-hidden');
}

// ------------------------------------------------------------------ analysis results

function onSnapshot(s: Snapshot): void {
  if (!prediction || s.tag !== prediction.tag) return;
  snapshot = s;
  spectrumView.setSnapshot(s.spectrum);
  renderPartials($('partials-body'), prediction, s);
  renderStretchChart();
  const out = $('f0-readout');
  out.removeAttribute('data-state');
  out.dataset.count = String(Number(out.dataset.count ?? 0) + 1);
  if (!s.fundamental) {
    out.textContent = 'no clear peak';
    out.setAttribute('data-measured-f0', '');
    return;
  }
  const f = s.fundamental.frequency;
  out.innerHTML = `${hz(f)} <span class="pitch">${pitchLabel(f)}</span>`;
  out.setAttribute('data-measured-f0', f.toFixed(4));
  const predicted1 = prediction.frequencies[0];
  const dev = 1200 * Math.log2(f / predicted1);
  const suppressed = s.partials.filter((p) => p.suppressed).map((p) => p.n);
  let text = `Measured f₁ = ${hz(f)} (${pitchLabel(f)}), ${Math.abs(dev).toFixed(2)} ¢ from theory.`;
  if (suppressed.length) {
    const causes = [
      `${prediction.kind === 'pluck' ? 'pluck' : 'strike'} at ${ratio(Math.min(prediction.fromBridge, 1 - prediction.fromBridge))}`,
    ];
    if (prediction.output === 'pickup')
      causes.push(`pickup at ${ratio(prediction.pickupFromBridge)}`);
    text += ` Partial${suppressed.length > 1 ? 's' : ''} ${suppressed.join(', ')} ${suppressed.length > 1 ? 'are' : 'is'} suppressed, as predicted for the ${causes.join(' and the ')}.`;
  }
  $('spectrum-status').textContent = text;
  $('spectrum-canvas').setAttribute('aria-label', `Spectrum and waterfall. ${text}`);
}

// ------------------------------------------------------------------ sound status

let soundStatus: SoundStatus = engine.status;
let soundMode: SoundMode = engine.mode;

function onSoundStatus(status: SoundStatus, mode: SoundMode, detail?: string): void {
  soundStatus = status;
  soundMode = mode;
  if (status === 'running' && engine.sampleRate !== analyzer.sampleRate) {
    analyzer = makeAnalyzer(engine.sampleRate);
    picture = new PictureEngine(engine.sampleRate);
    render();
  }
  if (status === 'running' && mode === 'stream') {
    $('listen-note').textContent =
      'This browser has no AudioWorklet, so the string is simulated on the main thread and played as short buffers (about 0.1 s of extra latency).';
  } else if (status === 'unavailable') {
    $('listen-note').textContent =
      'This browser offers no Web Audio, so the string is simulated and analysed silently.';
  } else if (status === 'failed') {
    $('listen-note').textContent =
      `Sound could not start${detail ? ` (${detail})` : ''}. The simulation keeps running silently; tap the sound button to retry.`;
  } else {
    $('listen-note').textContent = '';
  }
  renderSoundPill();
}

function renderSoundPill(): void {
  const pill = $('sound-pill');
  const label = $('sound-label');
  let status: string = soundStatus;
  let text: string;
  if (soundStatus === 'running' && state.muted) {
    status = 'muted';
    text = 'Muted';
  } else if (soundStatus === 'running') {
    text = soundMode === 'stream' ? 'Sound on · fallback' : 'Sound on';
  } else if (soundStatus === 'starting') text = 'Starting sound…';
  else if (soundStatus === 'suspended') text = 'Sound paused · tap to resume';
  else if (soundStatus === 'unavailable') text = 'No sound in this browser';
  else if (soundStatus === 'failed') text = 'Sound failed · tap to retry';
  else text = 'Enable sound';
  pill.dataset.status = status;
  label.textContent = text;
  (pill as HTMLButtonElement).disabled = soundStatus === 'unavailable';
}

$('sound-pill').addEventListener('click', () => {
  if (soundStatus === 'running') {
    update({ muted: !state.muted });
    sendMaster();
  } else {
    void engine.start();
  }
});

// ------------------------------------------------------------------ motion controls

let userTouchedMotion = false;
($('slowmo') as HTMLInputElement).addEventListener('change', (e) => {
  userTouchedMotion = true;
  update({ slowMotion: (e.target as HTMLInputElement).checked });
});
$('pause').addEventListener('click', () => update({ paused: !state.paused }));

document.addEventListener('keydown', (e) => {
  if (e.code !== 'Space' || e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
  const t = e.target as HTMLElement;
  if (
    t &&
    t !== document.body &&
    t.closest('button, input, select, textarea, a, [role="slider"], [tabindex]')
  )
    return;
  e.preventDefault();
  void engine.start();
  excite();
});

// ------------------------------------------------------------------ toast

let toastTimer = 0;
function toast(message: string): void {
  const el = $('toast');
  el.textContent = message;
  el.hidden = false;
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (el.hidden = true), 6000);
}

// ------------------------------------------------------------------ main loop

let last = performance.now();
function frame(now: number): void {
  const dt = Math.min(0.1, Math.max(0, (now - last) / 1000));
  last = now;
  engine.tick(dt);
  const mode = state.slowMotion ? 'slow' : reducedMotion.matches ? 'envelope' : 'realtime';
  if (!state.paused && (picture.active || holding)) {
    picture.tick(dt, mode);
    stringDirty = true;
  }
  if (stringDirty) {
    stringDirty = false;
    stringView.draw({
      N: picture.N,
      shapes: picture.shapes,
      count: picture.shapeCount,
      envelope: mode === 'envelope' ? picture.envelope : null,
      mode,
      hammer: picture.hammer,
      grab,
    });
  }
  if (analyzer.dirty && now - lastSpectrumDraw > 33) {
    lastSpectrumDraw = now;
    spectrumView.setLive(analyzer.liveSpectrum());
    spectrumView.draw();
  }
  requestAnimationFrame(frame);
}

reducedMotion.addEventListener('change', () => render());

// ------------------------------------------------------------------ start

render();
updateKeyboard();
sendMaster();
// The opening example: a silent pluck, so the string and the spectrum are alive at once.
excite();
requestAnimationFrame((t) => {
  last = t;
  frame(t);
  document.documentElement.dataset.ready = 'true';
});
void document.fonts?.ready.then(() => {
  stringView.refreshTheme();
  stringDirty = true;
  spectrumView.draw();
});

// "How it works" is loaded when it approaches the viewport or is linked to.
const how = $('how');
let howLoaded = false;
function loadHow(): void {
  if (howLoaded) return;
  howLoaded = true;
  void import('./ui/how.ts')
    .then((m) => m.renderHow(how))
    .catch(() => {
      how.innerHTML =
        '<p class="how-error">The explanation failed to load. <button type="button" class="link-button" id="how-retry">Try again</button></p>';
      $('how-retry')?.addEventListener('click', () => {
        howLoaded = false;
        loadHow();
      });
    });
}
new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && loadHow(), {
  rootMargin: '800px 0px',
}).observe(how);
document.querySelectorAll('a[href="#how"]').forEach((a) => a.addEventListener('click', loadHow));
if (location.hash === '#how') loadHow();

declare global {
  interface Window {
    monochord?: {
      state: () => AppState;
      snapshot: () => Snapshot | null;
      engine: SoundEngine;
      excite: () => void;
    };
  }
}
window.monochord = { state: () => state, snapshot: () => snapshot, engine, excite };
