/**
 * Sound engine. Three modes, chosen at run time:
 *
 *  - worklet:  the string runs in an AudioWorklet at the audio rate (preferred).
 *  - stream:   AudioWorklet is unavailable; the same synth runs on the main thread and its
 *              output is scheduled as short AudioBuffers slightly ahead of the audio clock.
 *  - silent:   sound is not started yet (autoplay policy) or Web Audio is missing; the synth runs
 *              on the main thread only to feed the analyser, so the spectrum still works.
 *
 * In every mode the analyser receives the dry string signal on one continuous clock.
 */
import processorUrl from './string-processor.ts?worker&url';
import type { FromWorklet, ToWorklet } from './protocol.ts';
import { StringSynth, type OnsetInfo, type SynthCommand } from './synth.ts';

export type SoundMode = 'silent' | 'worklet' | 'stream';
export type SoundStatus =
  | 'idle' // never started: "Tap to enable sound"
  | 'starting'
  | 'running'
  | 'suspended' // tab hidden or interrupted
  | 'unavailable' // no Web Audio at all
  | 'failed'; // the audio device or worklet failed

export interface EngineListener {
  samples(frame: number, data: Float32Array): void;
  onset(info: OnsetInfo & { frame: number }): void;
  status(status: SoundStatus, mode: SoundMode, detail?: string): void;
  error(message: string): void;
}

export type AudioPreference = 'auto' | 'fallback' | 'off';

const DEFAULT_RATE = 48000;
const STREAM_BLOCK = 1024;
const STREAM_LOOKAHEAD = 0.12;

export class SoundEngine {
  mode: SoundMode = 'silent';
  status: SoundStatus = 'idle';
  sampleRate: number;
  private ctx: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private streamGain: GainNode | null = null;
  private synth: StringSynth;
  private queue: ToWorklet[] = [];
  private workletReady = false;
  private clockOffset = 0;
  private lastAnalysisFrame = 0;
  private silentClock = -1;
  private streamTime = 0;
  private master = { volume: 0.8, muted: false };
  private block = new Float32Array(STREAM_BLOCK);
  private wet = new Float32Array(STREAM_BLOCK);
  private wasRunning = false;
  private startPromise: Promise<void> | null = null;

  constructor(
    private readonly listener: EngineListener,
    private readonly preference: AudioPreference = 'auto',
  ) {
    this.sampleRate = DEFAULT_RATE;
    this.synth = this.makeSynth(DEFAULT_RATE);
    if (preference === 'off' || typeof window.AudioContext !== 'function') {
      this.setStatus('unavailable');
    }
    document.addEventListener('visibilitychange', () => this.onVisibility());
  }

  private makeSynth(rate: number): StringSynth {
    const synth = new StringSynth(rate);
    synth.onOnset = (info) => this.emitOnset(info, info.frame);
    synth.onError = (message) => this.listener.error(message);
    synth.master.set(this.master.volume, this.master.muted);
    return synth;
  }

  private setStatus(status: SoundStatus, detail?: string): void {
    this.status = status;
    this.listener.status(status, this.mode, detail);
  }

  get audible(): boolean {
    return this.status === 'running' && this.mode !== 'silent';
  }

  /** Must be called from a user gesture (pointer or key event handler). */
  start(): Promise<void> {
    if (this.status === 'unavailable') return Promise.resolve();
    if (this.ctx) {
      if (this.ctx.state === 'suspended') void this.ctx.resume().catch(() => undefined);
      return this.startPromise ?? Promise.resolve();
    }
    let ctx: AudioContext;
    try {
      ctx = new AudioContext({ latencyHint: 'interactive' });
    } catch (err) {
      this.setStatus('failed', err instanceof Error ? err.message : String(err));
      return Promise.resolve();
    }
    this.ctx = ctx;
    void ctx.resume().catch(() => undefined);
    ctx.addEventListener('statechange', () => this.onContextState());
    this.setStatus('starting');
    this.startPromise = this.connect(ctx);
    return this.startPromise;
  }

  private async connect(ctx: AudioContext): Promise<void> {
    const wantWorklet = this.preference !== 'fallback';
    if (wantWorklet && ctx.audioWorklet && typeof AudioWorkletNode === 'function') {
      try {
        await ctx.audioWorklet.addModule(processorUrl);
        const node = new AudioWorkletNode(ctx, 'monochord-string', {
          numberOfInputs: 0,
          numberOfOutputs: 1,
          outputChannelCount: [1],
        });
        node.port.onmessage = (e: MessageEvent<FromWorklet>) => this.fromWorklet(e.data);
        node.onprocessorerror = () => this.workletFailed('The audio processor stopped.');
        node.connect(ctx.destination);
        this.node = node;
        this.sampleRate = ctx.sampleRate;
        this.switchSource('worklet');
        // Commands sent while loading are delivered once the processor reports ready.
        this.onContextState();
        return;
      } catch (err) {
        console.warn('AudioWorklet unavailable, using the main-thread fallback:', err);
      }
    }
    this.startStream(ctx);
  }

  private startStream(ctx: AudioContext): void {
    this.node?.disconnect();
    this.node = null;
    this.streamGain = ctx.createGain();
    this.streamGain.connect(ctx.destination);
    this.sampleRate = ctx.sampleRate;
    this.synth = this.makeSynth(ctx.sampleRate);
    this.streamTime = 0;
    this.switchSource('stream');
    for (const cmd of this.queue) if (cmd.type !== 'stream') this.synth.handle(cmd);
    this.queue = [];
    this.onContextState();
  }

  private workletFailed(message: string): void {
    this.listener.error(message);
    if (this.ctx) this.startStream(this.ctx);
  }

  /** Re-bases the analysis clock so samples from the new source continue the old timeline. */
  private switchSource(mode: SoundMode): void {
    this.mode = mode;
    this.clockOffset = this.lastAnalysisFrame;
    this.silentClock = -1;
  }

  private onContextState(): void {
    if (!this.ctx) return;
    const state = this.ctx.state as string;
    if (state === 'running') {
      if (this.mode === 'worklet' && !this.workletReady) this.setStatus('starting');
      else this.setStatus('running');
    } else if (state === 'suspended' || state === 'interrupted') {
      this.setStatus(this.status === 'starting' && !this.wasRunning ? 'starting' : 'suspended');
    } else if (state === 'closed') {
      this.setStatus('failed', 'The audio context closed.');
    }
  }

  private onVisibility(): void {
    if (!this.ctx) return;
    if (document.visibilityState === 'hidden') {
      this.wasRunning = this.ctx.state === 'running';
      if (this.wasRunning) void this.ctx.suspend().catch(() => undefined);
    } else if (this.wasRunning) {
      void this.ctx.resume().catch(() => undefined);
    }
  }

  private fromWorklet(msg: FromWorklet): void {
    switch (msg.type) {
      case 'ready':
        this.workletReady = true;
        this.sampleRate = msg.sampleRate;
        for (const cmd of this.queue) this.node?.port.postMessage(cmd);
        this.queue = [];
        this.node?.port.postMessage({ type: 'master', ...this.master });
        this.onContextState();
        break;
      case 'samples':
        this.emitSamples(msg.frame, msg.data);
        break;
      case 'onset':
        this.emitOnset(msg, msg.frame);
        break;
      case 'error':
        this.listener.error(msg.message);
        break;
    }
  }

  private emitSamples(frame: number, data: Float32Array): void {
    const f = frame + this.clockOffset;
    this.lastAnalysisFrame = Math.max(this.lastAnalysisFrame, f + data.length);
    this.listener.samples(f, data);
  }

  private emitOnset(info: OnsetInfo, frame: number): void {
    this.listener.onset({ ...info, frame: frame + this.clockOffset });
  }

  send(cmd: SynthCommand): void {
    if (cmd.type === 'master') this.master = { volume: cmd.volume, muted: cmd.muted };
    if (this.mode === 'worklet') {
      if (this.workletReady) this.node?.port.postMessage(cmd);
      else this.queue.push(cmd);
      return;
    }
    if (this.status === 'starting' && this.mode === 'silent' && this.ctx) {
      // The worklet is still loading: queue for it, but also keep the analysis running.
      this.queue.push(cmd);
    }
    this.synth.handle(cmd);
  }

  /** Main-thread work, called once per animation frame with the elapsed wall time. */
  tick(dtSeconds: number): void {
    if (this.mode === 'worklet') return;
    if (this.mode === 'stream' && this.ctx && this.streamGain) {
      this.pumpStream(this.ctx, this.streamGain);
      return;
    }
    // Silent: render the elapsed time (capped, so a long pause does not stall a frame).
    const n = Math.min(Math.round(dtSeconds * this.synth.sampleRate), 4096);
    if (n <= 0) return;
    if (this.silentClock < 0) this.silentClock = this.synth.frame;
    let left = n;
    while (left > 0) {
      const count = Math.min(left, STREAM_BLOCK);
      const frame = this.synth.frame;
      this.synth.render(this.block, count);
      if (this.synth.active || frame - this.silentClock < this.synth.sampleRate) {
        this.emitSamples(frame, this.block.slice(0, count));
      }
      if (this.synth.active) this.silentClock = frame;
      left -= count;
    }
  }

  private pumpStream(ctx: AudioContext, gain: GainNode): void {
    if (ctx.state !== 'running') return;
    const now = ctx.currentTime;
    if (this.streamTime < now + 0.01) this.streamTime = now + 0.03;
    while (this.streamTime < now + STREAM_LOOKAHEAD) {
      const frame = this.synth.frame;
      this.synth.render(this.block, STREAM_BLOCK);
      this.synth.master.process(this.block, this.wet, STREAM_BLOCK);
      const buffer = ctx.createBuffer(1, STREAM_BLOCK, ctx.sampleRate);
      buffer.copyToChannel(this.wet, 0);
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      src.connect(gain);
      src.start(this.streamTime);
      this.streamTime += STREAM_BLOCK / ctx.sampleRate;
      if (this.synth.active) this.emitSamples(frame, this.block.slice());
    }
  }

  /** The synth clock frame currently being heard (for aligning visuals in stream mode). */
  get frame(): number {
    return this.lastAnalysisFrame;
  }
}
