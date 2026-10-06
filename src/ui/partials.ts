/** The table of measured partials against theory. */
import type { ExcitationPrediction, Snapshot } from '../app/state.ts';
import { MEASURED_PARTIALS } from '../app/state.ts';
import { fixed, signed } from '../app/format.ts';

const db = (v: number) => (Math.abs(v) >= 99.5 ? fixed(v, 0) : fixed(v, 1));

export function renderPartials(
  body: HTMLElement,
  prediction: ExcitationPrediction | null,
  snapshot: Snapshot | null,
): void {
  if (!prediction) {
    body.innerHTML = '';
    return;
  }
  const rows: string[] = [];
  const count = Math.min(MEASURED_PARTIALS, prediction.frequencies.length);
  const missing = new Set(prediction.missing);
  for (let i = 0; i < count; i++) {
    const n = i + 1;
    const f = prediction.frequencies[i];
    const reading = snapshot && snapshot.tag === prediction.tag ? snapshot.partials[i] : undefined;
    const predictedDb =
      prediction.amplitudes[i] > 0 ? 20 * Math.log10(prediction.amplitudes[i]) : -Infinity;
    const suppressed = reading?.suppressed ?? false;
    const predictedGone = missing.has(n);
    let measured = '<span class="pending">…</span>';
    let delta = '';
    let level = '';
    if (reading) {
      if (reading.measured && !suppressed) {
        measured = fixed(reading.measured, reading.measured >= 1000 ? 1 : 2);
        delta = signed(1200 * Math.log2(reading.measured / f), 2);
      } else {
        measured = '—';
      }
      level = reading.level != null ? db(reading.level) : '—';
    }
    const theory = predictedGone ? 'missing' : db(Math.max(predictedDb, -99));
    rows.push(`<tr data-partial="${n}" data-suppressed="${suppressed}" data-predicted-suppressed="${predictedGone}"${suppressed || predictedGone ? ' class="is-missing"' : ''}>
      <th scope="row">${n}</th>
      <td class="col-predicted">${fixed(f, f >= 1000 ? 1 : 2)}</td>
      <td>${measured}</td>
      <td>${delta}</td>
      <td>${level}</td>
      <td>${theory}</td>
    </tr>`);
  }
  body.innerHTML = rows.join('');
}
