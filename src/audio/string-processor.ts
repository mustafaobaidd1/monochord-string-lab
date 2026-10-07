/**
 * AudioWorklet processor: runs the finite-difference string at the audio sample rate, one
 * sample per scheme step, and only produces sound (the page measures its own main-thread copy of
 * the same simulation, so analysis works with or without an audio device). Imported by the main
 * thread with `?worker&url`, so Vite bundles this file and the shared physics module into a
 * single script that `audioWorklet.addModule` can load under the GitHub Pages base path.
 */
import { StringSynth } from './synth.ts';
import type { FromWorklet, ToWorklet } from './protocol.ts';

// Globals of the AudioWorkletGlobalScope (not part of TypeScript's DOM library).
declare const sampleRate: number;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor();
}
declare function registerProcessor(
  name: string,
  ctor: new () => AudioWorkletProcessor & {
    process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean;
  },
): void;

class StringProcessor extends AudioWorkletProcessor {
  private readonly synth = new StringSynth(sampleRate);
  private dry = new Float32Array(128);
  private wet = new Float32Array(128);
  private failed = false;

  constructor() {
    super();
    this.synth.onError = (message) => this.post({ type: 'error', message });
    this.port.onmessage = (event: MessageEvent<ToWorklet>) => this.synth.handle(event.data);
    this.post({ type: 'ready', sampleRate });
  }

  private post(message: FromWorklet): void {
    this.port.postMessage(message);
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const channels = outputs[0];
    if (!channels || channels.length === 0) return true;
    const n = channels[0].length;
    if (this.dry.length < n) {
      this.dry = new Float32Array(n);
      this.wet = new Float32Array(n);
    }
    if (this.failed) {
      for (const ch of channels) ch.fill(0);
      return true;
    }
    try {
      this.synth.render(this.dry, n);
      this.synth.master.process(this.dry, this.wet, n);
      for (const ch of channels) ch.set(this.wet.subarray(0, n));
    } catch (err) {
      // Never let an exception kill the processor: go silent and tell the page.
      this.failed = true;
      for (const ch of channels) ch.fill(0);
      this.post({ type: 'error', message: err instanceof Error ? err.message : String(err) });
    }
    return true;
  }
}

registerProcessor('monochord-string', StringProcessor);
