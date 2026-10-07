/**
 * "How it works": the model, the scheme, the validation numbers and the limitations. Loaded on
 * demand together with KaTeX.
 */
import katex from 'katex';
import 'katex/dist/katex.min.css';
import results from './validation-results.json';
import { PRESETS } from '../physics/presets.ts';
import { MATERIALS, MATERIAL_IDS } from '../physics/materials.ts';

const t = (tex: string) => `<span class="tex" data-tex="${encode(tex)}"></span>`;
const T = (tex: string) => `<div class="tex tex-block" data-tex="${encode(tex)}"></div>`;

function encode(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

function exp(x: number, d = 1): string {
  const [m, e] = x.toExponential(d).split('e');
  return `${m} × 10<sup>${Number(e)}</sup>`.replace('-', '−');
}

function validationTable(): string {
  const r = results;
  const rows: string[] = [];
  for (const f of r.fundamental) {
    rows.push(
      `<tr><td>Fundamental of a near-ideal string at ${f.target} Hz</td><td>${t('f_0 = \\tfrac{1}{2L}\\sqrt{T/\\mu}')}</td><td>${f.measured.toFixed(4)} Hz (${f.cents.toFixed(4)} ¢)</td><td>±2 ¢</td></tr>`,
    );
  }
  for (const p of r.partials) {
    rows.push(
      `<tr><td>${p.preset}: partials 1–10, B = ${exp(p.B, 2)}</td><td>${t('n f_0 \\sqrt{1+Bn^2}')}</td><td>max ${p.maxVsContinuous.toFixed(2)} ¢ (scheme's own relation: ${p.maxVsDiscrete} ¢); partial 10 stretched ${p.measuredStretch10.toFixed(1)} ¢ vs ${p.stretch10.toFixed(1)} ¢</td><td>within the numerical dispersion, ${p.dispersionAt10.toFixed(2)} ¢ at n = 10</td></tr>`,
    );
  }
  rows.push(
    `<tr><td>Pluck at L/3</td><td>partials 3, 6, 9 vanish</td><td>${r.third.rows.map((x) => `${x.n}: ${x.belowNeighbours} dB`).join(', ')} below neighbours</td><td>≥ 40 dB</td></tr>`,
  );
  rows.push(
    `<tr><td>Lossless energy, 1 s, all presets</td><td>conserved</td><td>max relative drift ${exp(Math.max(...r.energy.map((e) => e.drift)))}</td><td>machine precision</td></tr>`,
  );
  rows.push(
    `<tr><td>Energy decay with σ₀ = ${r.decay.sigma0} s⁻¹</td><td>${t('E \\propto e^{-2\\sigma_0 t}')}</td><td>σ₀ = ${r.decay.measured} s⁻¹ (relative error ${exp(r.decay.relError)})</td><td>0.5 %</td></tr>`,
  );
  rows.push(
    `<tr><td>All presets for 2 s</td><td>${t('\\lambda^2 + 4\\nu^2 + 4\\sigma_1 k/h^2 \\le 1')}</td><td>${Math.min(...r.stability.map((s) => s.stabilityNumber))}–${Math.max(...r.stability.map((s) => s.stabilityNumber))}; displacement never exceeds the pluck</td><td>bounded</td></tr>`,
  );
  rows.push(
    `<tr><td>Hammer and string together (lossless)</td><td>total energy conserved</td><td>max drift ${exp(Math.max(...r.hammer.map((h) => h.drift)))}</td><td>machine precision</td></tr>`,
  );
  for (const b of r.bow.filter((x) =>
    ['Violin pizzicato', 'Classical nylon', 'Guitar E4', 'Harp C4'].includes(x.preset),
  )) {
    rows.push(
      `<tr><td>Bowed ${b.preset}, ${b.force} N at L/10, 0.1 m/s</td><td>Helmholtz motion</td><td>harmonics within ${b.harmonicCents} ¢; sawtooth within ${b.sawtoothDb} dB; sticks ${(b.stickFraction * 100).toFixed(0)} % of the time; slips at ${b.slipVelocity} m/s (ideal ${b.idealSlip})</td><td>locked, 1/n</td></tr>`,
    );
  }
  return `<div class="how-table" tabindex="0" role="region" aria-label="Validation results"><table>
    <thead><tr><th scope="col">Check</th><th scope="col">Reference</th><th scope="col">Measured</th><th scope="col">Target</th></tr></thead>
    <tbody>${rows.join('')}</tbody></table></div>`;
}

function presetTable(): string {
  return `<div class="how-table" tabindex="0" role="region" aria-label="Preset sources"><table>
    <thead><tr><th scope="col">Preset</th><th scope="col">String</th><th scope="col">Source of the construction</th></tr></thead>
    <tbody>${PRESETS.map((p) => `<tr><td>${p.name}</td><td>${p.detail}</td><td>${p.source}</td></tr>`).join('')}</tbody>
  </table></div>`;
}

function materialList(): string {
  return `<ul>${MATERIAL_IDS.map((id) => `<li><strong>${MATERIALS[id].label}.</strong> ${MATERIALS[id].source}</li>`).join('')}</ul>`;
}

export function renderHow(root: HTMLElement): void {
  root.innerHTML = `
  <header class="how-head">
    <p class="kicker">Plate II · notes</p>
    <h2 id="how-title">How it works</h2>
    <p class="how-lede">An educational physical model whose numbers are checked against theory. Below: the equation, the
    finite-difference scheme that runs at the audio rate, what was validated, and what the model leaves out.</p>
  </header>

  <div class="how-grid">
    <section>
      <h3>1 · The stiff, damped string</h3>
      <p>The transverse displacement ${t('u(x,t)')} of a string of length ${t('L')}, tension ${t('T')}, linear density
      ${t('\\mu = \\rho A')} and bending stiffness ${t('EI')} obeys (Bilbao 2009)</p>
      ${T('\\begin{gathered}u_{tt} = c^2 u_{xx} - \\kappa^2 u_{xxxx} - 2\\sigma_0 u_t + 2\\sigma_1 u_{txx}\\\\ c=\\sqrt{T/\\mu},\\qquad \\kappa=\\sqrt{EI/\\mu}\\end{gathered}')}
      <p>The first term is the ideal string; the second resists bending; ${t('\\sigma_0')} removes energy equally at all
      frequencies and ${t('\\sigma_1')} removes more at short wavelengths. Both ends are simply supported:
      ${t('u = u_{xx} = 0')}. The material and diameter ${t('d')} set ${t('\\mu = \\rho\\pi d^2/4')} and
      ${t('EI = E\\pi d_c^4/64')}, where ${t('d_c')} is the core diameter (the whole wire for plain strings).</p>
      ${materialList()}
    </section>

    <section>
      <h3>2 · Partials and inharmonicity</h3>
      <p>Each mode ${t('\\sin(n\\pi x/L)')} vibrates on its own:</p>
      ${T('\\begin{gathered}f_n = n f_0\\sqrt{1 + B n^2},\\qquad f_0 = \\frac{1}{2L}\\sqrt{\\frac{T}{\\mu}}\\\\ B = \\frac{\\pi^2 EI}{TL^2} = \\frac{\\pi^3 E d^4}{64\\, T L^2}\\;\\text{(solid wire)}\\end{gathered}')}
      ${T('\\text{decay rate}\\quad \\sigma_n = \\sigma_0 + \\sigma_1\\left(\\frac{n\\pi}{L}\\right)^2')}
      <p>Stiffness pushes every partial sharp, and more so the higher it is. For the piano A0 preset
      (${t('B \\approx 2.1\\times10^{-4}')}) partial 20 sits about 67 cents (two thirds of a semitone) above
      ${t('20 f_0')}: the bass note is slightly out of tune with its own harmonics, which is why pianos are tuned
      “stretched”. ${t('\\sigma_1')} makes the upper partials die first, which the waterfall shows as lines that end
      early on the right.</p>
    </section>

    <section>
      <h3>3 · Where you pluck</h3>
      <p>A plucked string starts from rest in the shape it takes under the finger. For an ideal string and a point
      pluck of height ${t('h')} at ${t('x_0')} that shape is a triangle with modal amplitudes</p>
      ${T('a_n = \\frac{2h}{n^2\\pi^2}\\,\\frac{L^2}{x_0(L-x_0)}\\,\\sin\\frac{n\\pi x_0}{L}')}
      <p>so ${t('a_n \\propto |\\sin(n\\pi x_0/L)|/n^2')}. Every partial with a node at the pluck point vanishes: pluck at
      ${t('L/3')} and partials 3, 6, 9… are missing. What you hear is the force on the bridge,
      ${t('F = Tu_x - EIu_{xxx}')}, which weights partial ${t('n')} by ${t('T\\beta_n(1+Bn^2)')}, so the bridge spectrum
      follows ${t('|\\sin(n\\pi x_0/L)|/n')}. Near the bridge ${t('\\sin(n\\pi x_0/L)\\approx n\\pi x_0/L')} for the
      first ${t('L/2x_0')} partials, which therefore come out almost equally strong: <strong>that is why plucking
      near the bridge sounds brighter.</strong></p>
      <p>The app computes the starting shape by solving the scheme's own static equation
      ${t('(-T\\delta_{xx} + EI\\delta_{xxxx})u = f')} for a raised-cosine finger of width ${t('w')} (two tridiagonal
      solves), which adds the stiffness factor ${t('1/(1+Bn^2)')} and a width factor
      ${t('W_n = \\frac{\\sin\\alpha}{\\alpha}\\big/\\left(1-\\frac{\\alpha^2}{\\pi^2}\\right)')},
      ${t('\\alpha = n\\pi w/2L')}. A magnetic pickup senses velocity, ${t('\\omega_n a_n|\\sin(n\\pi x_p/L)|')}, and adds a
      second comb of its own.</p>
    </section>

    <section>
      <h3>4 · Striking with a hammer</h3>
      <p>A felt hammer of mass ${t('M')} meets the string with the power-law force ${t('F = K[\\eta]_+^{\\,p}')}
      (Chaigne &amp; Askenfelt 1994), ${t('\\eta')} being the felt compression; stiffness is entered as Stulov's
      ${t('Q_0')}, the force at 1 mm. The collision is discretised so that energy is conserved exactly:</p>
      ${T('F^n = \\frac{V(\\eta^{n+1}) - V(\\eta^{n-1})}{\\eta^{n+1}-\\eta^{n-1}},\\qquad V(\\eta) = \\frac{K[\\eta]_+^{\\,p+1}}{p+1}')}
      <p>The string responds linearly to ${t('F^n')}, so each sample needs one monotone scalar equation, solved by
      safeguarded Newton iteration. The predicted partial levels of a strike come from the computed contact force:
      ${t('a_n \\propto |\\sin(n\\pi x_h/L)|\\,|\\hat F(\\omega_n)|/\\omega_n')}.</p>
    </section>

    <section>
      <h3>5 · Bowing</h3>
      <p>The bow presses with force ${t('F')} and moves at speed ${t('v_B')}; friction depends on the slip
      ${t('\\eta = u_t(x_B) - v_B')} through Bilbao's smooth characteristic</p>
      ${T('F_{\\text{bow}} = -F\\,\\phi(\\eta),\\qquad \\phi(\\eta) = \\sqrt{2a}\\,\\eta\\,e^{-a\\eta^2 + 1/2}')}
      <p>with ${t('a = 1000\\,\\text{s}^2/\\text{m}^2')} (friction peaks at a slip of 2 cm/s). Taking ${t('\\eta')} at the
      centred time difference leaves one scalar equation per sample, solved by Newton iteration from the previous slip,
      which follows the stick or slip branch. In the playable range the string settles into <strong>Helmholtz
      motion</strong>: a single corner circulates once per period, the string sticks to the bow for about
      ${t('1-\\beta')} of each period (${t('\\beta = x_B/L')}) and slips back at about ${t('-v_B(1-\\beta)/\\beta')}.
      The partials then lock to exact multiples of ${t('f_1')}, however stiff the string, and the bridge force is a
      sawtooth. Too little force and the bow slips more than once per period; too much and the pitch flattens and the
      tone turns raucous (Schelleng's limits). The force slider is relative to a force found by simulation for each
      preset and scaled as ${t('Z_0^{1.3}v_B')} (${t('Z_0 = \\sqrt{T\\mu}')}) for other strings.</p>
    </section>

    <section>
      <h3>6 · The finite-difference scheme</h3>
      <p>On a grid ${t('x_l = lh')}, ${t('t_n = nk')} with ${t('k = 1/f_s')} (one step per audio sample), the scheme is</p>
      ${T('\\delta_{tt}u = c^2\\delta_{xx}u - \\kappa^2\\delta_{xxxx}u - 2\\sigma_0\\delta_{t\\cdot}u + 2\\sigma_1\\delta_{t-}\\delta_{xx}u')}
      <p>with centred ${t('\\delta_{t\\cdot}')} and backward ${t('\\delta_{t-}')} differences, which keeps it explicit.
      Writing ${t('\\lambda = ck/h')} and ${t('\\nu = \\kappa k/h^2')}, a von Neumann analysis of every mode gives the
      stability condition</p>
      ${T('\\begin{gathered}h \\ge h_{\\min},\\\\ h_{\\min}^2 = \\tfrac12\\left(c^2k^2 + 4\\sigma_1 k + \\sqrt{(c^2k^2 + 4\\sigma_1k)^2 + 16\\kappa^2k^2}\\right)\\end{gathered}')}
      <p>The grid uses ${t('N = \\lfloor L/h_{\\min}\\rfloor')} intervals (at most ${results.maxPoints}), as close to the
      bound as possible because that minimises numerical dispersion. The simulated partials follow the exact discrete
      relation ${t('\\sin^2(\\omega k/2) = \\lambda^2 s^2 + 4\\nu^2 s^4')}, ${t('s = \\sin(n\\pi/2N)')}: about a cent flat of
      the continuous law at the 10th partial, growing as ${t('n^2')}. Without loss the discrete energy</p>
      ${T('\\begin{aligned}\\mathfrak{h} = {} & \\tfrac{\\mu}{2}\\lVert\\delta_{t-}u\\rVert^2 + \\tfrac{T}{2}\\langle\\delta_{x+}u,\\, e_{t-}\\delta_{x+}u\\rangle\\\\ & + \\tfrac{EI}{2}\\langle\\delta_{xx}u,\\, e_{t-}\\delta_{xx}u\\rangle\\end{aligned}')}
      <p>is conserved to rounding error, which the tests check.</p>
    </section>

    <section>
      <h3>7 · From simulation to sound</h3>
      <p>The scheme runs in an <strong>AudioWorklet</strong> at the audio sample rate. The output is the bridge force (or
      the pickup velocity), scaled by a per-string reference so different strings sound comparably loud, high-passed at
      4 Hz, then a master volume and a soft limiter. If AudioWorklet is missing, the same code runs on the main thread
      and is played as short buffers; before the first tap it runs silently so the spectrum is alive anyway.</p>
      <p>The drawing comes from a second copy of the same voice on a slower clock (slow motion, ×4 to ×1024 chosen so the
      fundamental appears at about one cycle per second). The spectrum is measured from the first 0.35–1.2 s after each
      excitation with a Blackman–Harris window, zero-padding and quadratic interpolation of log-magnitude peaks.</p>
    </section>
  </div>

  <section class="how-wide">
    <h3>8 · Validation</h3>
    <p>This is an <strong>educational simulation</strong>, not a calibrated model of any particular instrument. What has
    been validated is the numerics: the scheme reproduces the analytic results below (computed by
    <code>npm run validate</code> at ${results.sampleRate / 1000} kHz on ${results.generated}; the unit tests check the
    same targets).</p>
    ${validationTable()}
    <h4>Presets</h4>
    ${presetTable()}
    <p class="how-small">Decay times of the presets are plausible estimates (piano decay rates after Weinreich), not
    measurements of these instruments.</p>
  </section>

  <section class="how-wide">
    <h3>9 · Limitations</h3>
    <ul class="how-list">
      <li>Linear model: no tension modulation, so large plucks do not go sharp; no longitudinal or torsional waves and
      no phantom partials.</li>
      <li>One plane of vibration and rigid, simply supported ends: no bridge motion, no instrument body, no coupled
      unison strings, so no two-stage piano decay or beating.</li>
      <li>Losses are Bilbao's two-parameter ${t('\\sigma_0 + \\sigma_1\\beta^2')} model fitted to two decay times; real
      damping varies more with frequency.</li>
      <li>Wound strings are a steel core (for stiffness) plus an effective density (for mass); the bass core fraction is
      an assumption.</li>
      <li>The explicit scheme has numerical dispersion (quantified above), and the grid is capped at
      ${results.maxPoints} intervals, which removes the very highest partials of long, slack strings.</li>
      <li>The felt is a lossless power law (no hysteresis); the pickup is a point velocity sensor with no aperture or
      electrical resonance.</li>
      <li>The bow is a point contact with a smooth friction curve and no rosin thermodynamics, bow-hair width or torsion;
      stiff strings (wound E2, bass, piano) lock only approximately, and above about the \${t('1/\\beta')}-th partial the
      simulated spectrum falls below the ideal sawtooth because the Helmholtz corner is rounded.</li>
      <li>Loudness is normalised per string, not an absolute sound level.</li>
    </ul>
  </section>

  <section class="how-wide how-sources">
    <h3>Sources</h3>
    <ul class="how-list">
      <li>S. Bilbao, <em>Numerical Sound Synthesis</em>, Wiley, 2009 — stiff-string scheme, stability, energy, loss fit,
      collisions.</li>
      <li>H. Fletcher, “Normal vibration frequencies of a stiff piano string”, JASA 36, 203 (1964).</li>
      <li>A. Chaigne and A. Askenfelt, “Numerical simulations of piano strings I”, JASA 95, 1112 (1994); A. Stulov's
      hammer fits as summarised in J. O. Smith, <em>Physical Audio Signal Processing</em>.</li>
      <li>M. Podlesak and A. R. Lee, “Dispersion of waves in piano strings”, JASA 83, 305 (1988) — the A0 string.</li>
      <li>I. Barbancho et al., “Inharmonicity-based method for the automatic generation of guitar tablature”, IEEE TASLP
      20 (2012) — measured guitar B.</li>
      <li>J. Woodhouse and N. Lynch-Aird, Acta Acustica 105, 516 (2019) — nylon and gut properties.</li>
      <li>D'Addario string tension chart; Bow Brand harp strings; D. Russell, Acoustics and Vibration Animations (Penn
      State) — plucked-string Fourier amplitudes; J. O. Smith, <em>Spectral Audio Signal Processing</em> — QIFFT.</li>
    </ul>
  </section>`;

  for (const el of root.querySelectorAll<HTMLElement>('.tex')) {
    katex.render(el.dataset.tex ?? '', el, {
      displayMode: el.classList.contains('tex-block'),
      throwOnError: false,
      output: 'htmlAndMathml',
    });
  }
  // Formulas wider than a narrow screen scroll sideways; make those reachable by keyboard.
  for (const el of root.querySelectorAll<HTMLElement>('.tex-block')) {
    if (el.scrollWidth > el.clientWidth + 1) {
      el.tabIndex = 0;
      el.setAttribute('role', 'region');
      el.setAttribute('aria-label', 'Equation (scrolls sideways)');
    }
  }
}
