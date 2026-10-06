/**
 * AudioWorklet processor: runs the finite-difference string at the audio sample rate, one
 * sample per scheme step. Imported by the main thread with `?worker&url`, so Vite bundles this
 * file and the shared physics module into a single script that `audioWorklet.addModule` can load
 * under the GitHub Pages base path.
 */
import { StringSynth, type SynthCommand } from './synth.ts';
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

/** Samples per analysis message (about 43 ms at 48 kHz). */
const CHUNK = 2048;

class StringProcessor extends AudioWorkletProcessor {
  private readonly synth = new StringSynth(sampleRate);
  private dry = new Float32Array(128);
  private wet = new Float32Array(128);
  private chunk = new Float32Array(CHUNK);
  private chunkFill = 0;
  private chunkFrame = 0;
  private streaming = true;
  /** Keep posting for a little while after the string falls silent, so the tail is analysed. */
  private tail = 0;
  private failed = false;

  constructor() {
    super();
    this.synth.onOnset = (info) => this.post({ type: 'onset', ...info });
    this.synth.onError = (message) => this.post({ type: 'error', message });
    this.port.onmessage = (event: MessageEvent<ToWorklet>) => this.receive(event.data);
    this.post({ type: 'ready', sampleRate });
  }

  private post(message: FromWorklet, transfer: Transferable[] = []): void {
    this.port.postMessage(message, transfer);
  }

  private receive(message: ToWorklet): void {
    if (message.type === 'stream') {
      this.streaming = message.enabled;
      return;
    }
    this.synth.handle(message as SynthCommand);
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
      const startFrame = this.synth.frame;
      this.synth.render(this.dry, n);
      this.synth.master.process(this.dry, this.wet, n);
      for (const ch of channels) ch.set(this.wet.subarray(0, n));
      this.collect(startFrame, n);
    } catch (err) {
      // Never let an exception kill the processor: go silent and tell the page.
      this.failed = true;
      for (const ch of channels) ch.fill(0);
      this.post({ type: 'error', message: err instanceof Error ? err.message : String(err) });
    }
    return true;
  }

  /** Accumulates the dry signal into chunks for the main thread's spectrum analysis. */
  private collect(startFrame: number, n: number): void {
    const active = this.synth.active;
    if (active) this.tail = sampleRate * 0.5;
    else if (this.tail > 0) this.tail -= n;
    if (!this.streaming || (!active && this.tail <= 0)) {
      if (this.chunkFill > 0) this.flush();
      return;
    }
    let offset = 0;
    while (offset < n) {
      if (this.chunkFill === 0) this.chunkFrame = startFrame + offset;
      const take = Math.min(n - offset, CHUNK - this.chunkFill);
      this.chunk.set(this.dry.subarray(offset, offset + take), this.chunkFill);
      this.chunkFill += take;
      offset += take;
      if (this.chunkFill === CHUNK) this.flush();
    }
  }

  private flush(): void {
    const data = this.chunk.slice(0, this.chunkFill);
    this.post({ type: 'samples', frame: this.chunkFrame, data }, [data.buffer]);
    this.chunkFill = 0;
  }
}

registerProcessor('monochord-string', StringProcessor);
