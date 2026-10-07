/**
 * The control cards: sliders built from the parameter table, segmented choices, presets,
 * derived readouts and the explanations shown when a slider reaches the end of its range.
 */
import { MATERIALS, MATERIAL_IDS, type MaterialId } from '../physics/materials.ts';
import { PRESETS, type ExcitationKind } from '../physics/presets.ts';
import type { OutputKind } from '../physics/theory.ts';
import { MAX_POINTS } from '../physics/grid.ts';
import { hz, mm, sci, seconds, sig3 } from '../app/format.ts';
import {
  PARAMS,
  SLIDER_STEPS,
  decaySummary,
  fromSlider,
  toSlider,
  type ParamContext,
  type ParamDef,
} from '../app/params.ts';
import { pitchLabel, type AppState } from '../app/state.ts';

export interface ControlActions {
  setParam(key: string, value: number, commit: boolean): void;
  setPreset(id: string): void;
  setMaterial(id: MaterialId): void;
  setExcitation(kind: ExcitationKind): void;
  setOutput(kind: OutputKind): void;
  exciteAt(fromBridge: number): void;
  excite(): void;
  toggleMute(): void;
  resetStiffness(): void;
}

interface FieldRefs {
  def: ParamDef;
  input: HTMLInputElement;
  value: HTMLOutputElement;
  note: HTMLElement;
  reset?: HTMLButtonElement;
}

const $ = <T extends HTMLElement>(id: string) => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} is missing`);
  return el as T;
};

export class Controls {
  private fields = new Map<string, FieldRefs>();
  private presetButtons = new Map<string, HTMLButtonElement>();
  private materialInputs = new Map<MaterialId, HTMLInputElement>();
  private dragging = new Set<string>();

  constructor(private readonly actions: ControlActions) {
    this.buildFields();
    this.buildPresets();
    this.buildMaterials();
    this.bindChoices();
  }

  private buildFields(): void {
    for (const host of document.querySelectorAll<HTMLElement>('.field[data-param]')) {
      const key = host.dataset.param!;
      const def = PARAMS.find((p) => p.key === key);
      if (!def) continue;
      const id = `p-${key.replace(/\./g, '-')}`;
      host.innerHTML = `
        <div class="field-top">
          <label class="field-label" for="${id}">${def.label}</label>
          <output class="field-value" id="${id}-value" for="${id}"></output>
        </div>
        <input type="range" id="${id}" min="0" max="${SLIDER_STEPS}" step="1" />
        <p class="field-note" hidden></p>`;
      const refs: FieldRefs = {
        def,
        input: host.querySelector('input')!,
        value: host.querySelector('output')!,
        note: host.querySelector('.field-note')!,
      };
      if (key === 'string.inharmonicity') {
        const reset = document.createElement('button');
        reset.type = 'button';
        reset.className = 'link-button';
        reset.textContent = 'Use the material value';
        reset.hidden = true;
        reset.addEventListener('click', () => this.actions.resetStiffness());
        host.querySelector('.field-top')!.after(reset);
        refs.reset = reset;
      }
      refs.input.addEventListener('input', () => {
        this.dragging.add(key);
        refs.input.style.setProperty(
          '--fill',
          `${(Number(refs.input.value) / SLIDER_STEPS) * 100}%`,
        );
        this.actions.setParam(key, this.valueOf(refs), false);
      });
      refs.input.addEventListener('change', () => {
        this.dragging.delete(key);
        this.actions.setParam(key, this.valueOf(refs), true);
      });
      this.fields.set(key, refs);
    }
  }

  private lastRanges = new Map<string, [number, number]>();

  private valueOf(refs: FieldRefs): number {
    const range = this.lastRanges.get(refs.def.key) ?? [0, 1];
    return fromSlider(refs.def, Number(refs.input.value), range);
  }

  private buildPresets(): void {
    const strip = $('presets');
    for (const p of PRESETS) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'chip';
      b.setAttribute('role', 'radio');
      b.dataset.preset = p.id;
      b.innerHTML = `<span class="chip-name">${p.short}</span><span class="chip-note">${p.note}</span>`;
      b.setAttribute('aria-label', `${p.name}: ${p.detail}`);
      b.addEventListener('click', () => this.actions.setPreset(p.id));
      b.addEventListener('keydown', (e) => this.rovingKeys(e, [...this.presetButtons.values()]));
      strip.append(b);
      this.presetButtons.set(p.id, b);
    }
  }

  /** Arrow-key navigation inside a radiogroup of buttons. */
  private rovingKeys(e: KeyboardEvent, buttons: HTMLButtonElement[]): void {
    const i = buttons.indexOf(e.currentTarget as HTMLButtonElement);
    let j = -1;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') j = (i + 1) % buttons.length;
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp')
      j = (i - 1 + buttons.length) % buttons.length;
    else if (e.key === 'Home') j = 0;
    else if (e.key === 'End') j = buttons.length - 1;
    if (j < 0) return;
    e.preventDefault();
    buttons[j].focus();
    buttons[j].click();
  }

  private buildMaterials(): void {
    const set = $('material');
    for (const id of MATERIAL_IDS) {
      const label = document.createElement('label');
      label.innerHTML = `<input type="radio" name="material" value="${id}" /><span>${MATERIALS[id].label}</span>`;
      const input = label.querySelector('input')!;
      input.addEventListener('change', () => input.checked && this.actions.setMaterial(id));
      set.append(label);
      this.materialInputs.set(id, input);
    }
  }

  private bindChoices(): void {
    for (const input of document.querySelectorAll<HTMLInputElement>('input[name="excitation"]')) {
      input.addEventListener(
        'change',
        () => input.checked && this.actions.setExcitation(input.value as ExcitationKind),
      );
    }
    for (const input of document.querySelectorAll<HTMLInputElement>('input[name="output"]')) {
      input.addEventListener(
        'change',
        () => input.checked && this.actions.setOutput(input.value as OutputKind),
      );
    }
    for (const b of document.querySelectorAll<HTMLButtonElement>('#fractions button')) {
      b.addEventListener('click', () => this.actions.exciteAt(1 / Number(b.dataset.fraction)));
    }
    $('excite').addEventListener('click', () => this.actions.excite());
    $('mute').addEventListener('click', () => this.actions.toggleMute());
  }

  /** Brings every control in line with the state. */
  render(state: AppState, ctx: ParamContext): void {
    for (const [key, refs] of this.fields) {
      const range = refs.def.range(ctx);
      this.lastRanges.set(key, range);
      const value = refs.def.get(state, ctx);
      if (!this.dragging.has(key)) refs.input.value = String(toSlider(refs.def, value, range));
      refs.input.style.setProperty('--fill', `${(Number(refs.input.value) / SLIDER_STEPS) * 100}%`);
      const text = refs.def.format(value, ctx);
      refs.value.textContent = text;
      refs.input.setAttribute('aria-valuetext', refs.def.spoken?.(value, ctx) ?? text);
      const step = Number(refs.input.value);
      const end = step <= 0 ? 'min' : step >= SLIDER_STEPS ? 'max' : null;
      const warning = refs.def.warn?.(value, ctx) ?? null;
      const limit = end && refs.def.limit ? refs.def.limit(end, ctx) : null;
      const note = warning ?? limit;
      const idle =
        key === 'output.pickupFromBridge' && state.output.kind !== 'pickup'
          ? 'Choose “Pickup” above to listen through it.'
          : null;
      refs.note.hidden = !(note ?? idle);
      refs.note.textContent = note ?? idle ?? '';
      refs.note.classList.toggle('field-note--warn', Boolean(warning));
      if (refs.reset) refs.reset.hidden = state.string.inharmonicity == null;
    }
    for (const [id, b] of this.presetButtons) {
      const on = id === state.presetId;
      b.setAttribute('aria-checked', String(on));
      b.tabIndex = on ? 0 : -1;
      b.classList.toggle('chip--custom', on && state.customised);
    }
    for (const [id, input] of this.materialInputs) input.checked = id === state.string.material;
    for (const input of document.querySelectorAll<HTMLInputElement>('input[name="excitation"]')) {
      input.checked = input.value === state.excitation;
    }
    for (const input of document.querySelectorAll<HTMLInputElement>('input[name="output"]')) {
      input.checked = input.value === state.output.kind;
    }
    const kind = state.excitation;
    $('pluck-panel').hidden = kind !== 'pluck';
    $('strike-panel').hidden = kind !== 'strike';
    $('bow-panel').hidden = kind !== 'bow';
    $('excite-label').textContent =
      kind === 'pluck' ? 'Pluck' : kind === 'strike' ? 'Strike' : 'Hold to bow';
    $('fraction-label').textContent =
      kind === 'pluck' ? 'Pluck at' : kind === 'strike' ? 'Strike at' : 'Bow at';
    $('excite-note').textContent =
      kind === 'bow'
        ? 'Press and hold to bow; release to let the string ring. A click bows for 1.6 s.'
        : '';
    const current =
      kind === 'pluck'
        ? state.pluck.fromBridge
        : kind === 'bow'
          ? state.bow.fromBridge
          : state.strike.fromBridge;
    for (const b of document.querySelectorAll<HTMLButtonElement>('#fractions button')) {
      const f = 1 / Number(b.dataset.fraction);
      b.setAttribute('aria-pressed', String(Math.abs(f - current) < 1e-6));
    }
    const pickupField = this.fields.get('output.pickupFromBridge');
    if (pickupField) {
      pickupField.input.disabled = state.output.kind !== 'pickup';
      pickupField.input
        .closest('.field')!
        .classList.toggle('field--disabled', state.output.kind !== 'pickup');
    }
    const mute = $('mute');
    mute.setAttribute('aria-pressed', String(state.muted));
    mute.querySelector('span')!.textContent = state.muted ? 'Muted' : 'Mute';
    this.renderDerived(state, ctx);
  }

  private renderDerived(state: AppState, ctx: ParamContext): void {
    const { physics, grid, error } = ctx.info;
    const s = state.string;
    const f1 = physics.f0 * Math.sqrt(1 + physics.B);
    const load = s.tension / physics.breakingLoad;
    const rows: [string, string, string?][] = [
      ['Linear density μ', `${sig3(physics.mu * 1000)} g/m`],
      ['Wave speed c', `${sig3(physics.c)} m/s`],
      ['Fundamental f₀', `${hz(physics.f0)} · ${pitchLabel(physics.f0)}`],
      ['First partial f₁', hz(f1)],
      ['Inharmonicity B', sci(physics.B)],
      [
        'Load',
        `${Math.round(load * 100)} % of breaking (≈${sig3(physics.breakingLoad)} N)`,
        load > 1 ? 'warn' : undefined,
      ],
    ];
    if (grid) {
      rows.push(
        [
          'Grid',
          `N = ${grid.N} intervals, h = ${mm(grid.h)}${grid.capped ? ` (capped at ${MAX_POINTS})` : ''}`,
        ],
        ['Stability', `λ² + 4ν² + 4σ<sub>1</sub>k/h² = ${grid.stabilityNumber.toFixed(3)} ≤ 1`],
      );
    } else if (error) {
      rows.push(['Grid', error, 'warn']);
    }
    $('derived').innerHTML = rows
      .map(
        ([k, v, cls]) =>
          `<div class="derived-row${cls ? ' derived-row--warn' : ''}"><dt>${k}</dt><dd>${v}</dd></div>`,
      )
      .join('');
    const d = decaySummary(state, ctx.sampleRate);
    $('t60-readout').textContent =
      `60 dB decay: ${seconds(d.t1)} at f₁ (${hz(d.f1)}), ${seconds(d.t2)} at 2 kHz. σ₁ is why high partials die first.`;
  }
}
