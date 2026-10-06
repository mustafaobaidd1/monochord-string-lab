/** Equal-tempered note names and frequencies (A4 = 440 Hz, MIDI 69). */

const NAMES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'] as const;
const ASCII_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'] as const;

export function midiToFrequency(midi: number): number {
  return 440 * 2 ** ((midi - 69) / 12);
}

export function frequencyToMidi(f: number): number {
  return 69 + 12 * Math.log2(f / 440);
}

export function noteName(midi: number, ascii = false): string {
  const m = Math.round(midi);
  const names = ascii ? ASCII_NAMES : NAMES;
  return `${names[((m % 12) + 12) % 12]}${Math.floor(m / 12) - 1}`;
}

export function isBlackKey(midi: number): boolean {
  return [1, 3, 6, 8, 10].includes(((Math.round(midi) % 12) + 12) % 12);
}

/** Nearest note name and the deviation from it in cents. */
export function describePitch(f: number): { name: string; cents: number; midi: number } {
  const midi = frequencyToMidi(f);
  const nearest = Math.round(midi);
  return { name: noteName(nearest), cents: (midi - nearest) * 100, midi: nearest };
}

/** Parses names such as "E2", "C#4" or "C♯4" into a MIDI number. */
export function parseNote(name: string): number {
  const m = /^([A-G])([#♯b♭]?)(-?\d)$/.exec(name.trim());
  if (!m) throw new Error(`Not a note name: ${name}`);
  const base = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }[m[1] as 'C'];
  const accidental = m[2] === '#' || m[2] === '♯' ? 1 : m[2] === 'b' || m[2] === '♭' ? -1 : 0;
  return 12 * (Number(m[3]) + 1) + base + accidental;
}
