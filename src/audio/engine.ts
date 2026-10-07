/**
 * Sound engine.
 *
 * Measurement never depends on the audio device: a main-thread copy of the string (the same
 * synth code, receiving the same commands, advanced in real time by the animation clock) feeds
 * the analyser in every situation. Sound is produced separately, by one of:
 *
 *  - worklet:  the string runs in an AudioWorklet at the audio rate (preferred).
 *  - stream:   AudioWorklet is unavailable; a second main-thread synth renders short
 *              AudioBuffers scheduled slightly ahead of the audio clock.
 *  - silent:   no sound yet (autoplay policy), no Web Audio, or the audio device failed.
 *
 * Watchdogs report an audio path that never starts or whose clock stands still (for example a
 * machine with no output device); the simulation and the analysis carry on regardless.
 */
import processorUrl from './string-processor.ts?worker&url';
import type { FromWorklet, ToWorklet } from './protocol.ts';
import { StringSynth, type OnsetInfo, type SynthCommand } from './synth.ts';

export type SoundMode = 'silent' | 'worklet' | 'stream';
export type SoundStatus =
  | 'idle' // never started: "Enable sound"
  | 'starting'
  | 'running'
  | 'suspended' // tab hidden or interrupted
  | 'unavailable' // no Web Audio at all
  | 'failed'; // the audio device or the processor failed

export interface EngineListener {
  samples(frame: number, data: Float32Array): void;
  onset(info: OnsetInfo & { frame: number }): void;
  status(status: SoundStatus, mode: SoundMode, detail?: string): void;
  error(message: string): void;
}

export type AudioPreference = 'auto' | 'fallback' | 'off';

const DEFAULT_RATE = 48000;
const BLOCK = 1024;
const STREAM_LOOKAHEAD = 0.12;
/** The worklet must report ready within this time, s. */
const READY_TIMEOUT = 4;
/** A running context whose clock does not move for this long has no working output, s. */
const STALL_TIMEOUT = 2.5;

export class SoundEngine {
  /** Which path produces sound. */
  mode: SoundMode = 'silent';
  status: SoundStatus = 'idle';
  sampleRate: number;
  private ctx: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private streamGain: GainNode | null = null;
  /** Main-thread copy of the string that feeds the analyser, with or without sound. */
  private analysis: StringSynth;
  /** Main-thread synth that plays sound when AudioWorklet is unavailable. */
  private streamSynth: StringSynth | null = null;
  private queue: ToWorklet[] = [];
  private workletReady = false;
  private readyTimer = 0;
  private quietSince = -1;
  private streamTime = 0;
  private master = { volume: 0.8, muted: false };
  private block = new Float32Array(BLOCK);
  private wet = new Float32Array(BLOCK);
  private wasRunning = false;
  private startPromise: Promise<void> | null = null;
  private clockCheck: { wall: number; audio: number } | null = null;

  constructor(
    private readonly listener: EngineListener,
    private readonly preference: AudioPreference = 'auto',
  ) {
    this.sampleRate = DEFAULT_RATE;
    this.analysis = this.makeSynth(DEFAULT_RATE, true);
    // Reported by the page once it is set up (it reads `status` after construction).
    if (preference === 'off' || typeof window.AudioContext !== 'function')
      this.status = 'unavailable';
    document.addEventListener('visibilitychange', () => this.onVisibility());
  }

  private makeSynth(rate: number, analysis: boolean): StringSynth {
    const synth = new StringSynth(rate);
    if (analysis) synth.onOnset = (info) => this.listener.onset({ ...info, frame: info.frame });
    synth.onError = analysis ? (message) => this.listener.error(message) : null;
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

  /** After a failure, tries again with a fresh audio context (call from a user gesture). */
  retry(): Promise<void> {
    if (this.status !== 'failed' || !this.ctx) return this.start();
    void this.ctx.close().catch(() => undefined);
    this.ctx = null;
    this.node = null;
    this.workletReady = false;
    this.startPromise = null;
    this.mode = 'silent';
    this.status = 'idle';
    return this.start();
  }

  /** Must be called from a user gesture (pointer or key event handler). */
  start(): Promise<void> {
    if (this.status === 'unavailable') return Promise.resolve();
    if (this.ctx) {
      if (this.ctx.state === 'suspended' && this.status !== 'failed') {
        void this.ctx.resume().catch(() => undefined);
      }
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
    // Simulate at the device's own rate, so what is measured is exactly what is heard.
    if (ctx.sampleRate !== this.sampleRate) {
      this.sampleRate = ctx.sampleRate;
      this.analysis = this.makeSynth(ctx.sampleRate, true);
      this.analysis.handle({ type: 'master', ...this.master });
    }
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
        this.mode = 'worklet';
        // Commands sent from now on are queued until the processor reports ready.
        this.readyTimer = window.setTimeout(() => {
          if (!this.workletReady) {
            this.audioFailed('the audio processor did not start (is there an output device?)');
          }
        }, READY_TIMEOUT * 1000);
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
    window.clearTimeout(this.readyTimer);
    this.streamGain = ctx.createGain();
    this.streamGain.connect(ctx.destination);
    this.streamSynth = this.makeSynth(ctx.sampleRate, false);
    this.streamTime = 0;
    this.mode = 'stream';
    this.queue = [];
    this.onContextState();
  }

  private workletFailed(message: string): void {
    this.listener.error(message);
    if (this.ctx) this.startStream(this.ctx);
  }

  /** The audio path is not working: stop trying to play, keep simulating and measuring. */
  private audioFailed(detail: string): void {
    window.clearTimeout(this.readyTimer);
    this.node?.disconnect();
    this.node = null;
    this.streamSynth = null;
    this.queue = [];
    this.mode = 'silent';
    this.clockCheck = null;
    void this.ctx?.suspend().catch(() => undefined);
    this.setStatus('failed', detail);
  }

  private onContextState(): void {
    if (!this.ctx || this.status === 'failed') return;
    const state = this.ctx.state as string;
    if (state === 'running') {
      if (this.mode === 'worklet' && !this.workletReady) this.setStatus('starting');
      else this.setStatus('running');
    } else if (state === 'suspended' || state === 'interrupted') {
      this.setStatus(this.status === 'starting' && !this.wasRunning ? 'starting' : 'suspended');
    } else if (state === 'closed') {
      this.audioFailed('the audio context closed');
    }
  }

  private onVisibility(): void {
    if (!this.ctx || this.status === 'failed') return;
    if (document.visibilityState === 'hidden') {
      this.wasRunning = this.ctx.state === 'running';
      if (this.wasRunning) void this.ctx.suspend().catch(() => undefined);
    } else if (this.wasRunning) {
      void this.ctx.resume().catch(() => undefined);
    }
    this.clockCheck = null;
  }

  private fromWorklet(msg: FromWorklet): void {
    switch (msg.type) {
      case 'ready':
        if (this.status === 'failed') return;
        this.workletReady = true;
        window.clearTimeout(this.readyTimer);
        for (const cmd of this.queue) this.node?.port.postMessage(cmd);
        this.queue = [];
        this.node?.port.postMessage({ type: 'master', ...this.master });
        this.onContextState();
        break;
      case 'error':
        this.listener.error(msg.message);
        break;
    }
  }

  send(cmd: SynthCommand): void {
    if (cmd.type === 'master') this.master = { volume: cmd.volume, muted: cmd.muted };
    // The analysis copy always hears every command.
    this.analysis.handle(cmd);
    if (this.mode === 'worklet') {
      if (this.workletReady) this.node?.port.postMessage(cmd);
      else this.queue.push(cmd);
    } else if (this.mode === 'stream') {
      this.streamSynth?.handle(cmd);
    }
  }

  /** Main-thread work, called once per animation frame with the elapsed wall time. */
  tick(dtSeconds: number): void {
    this.renderAnalysis(dtSeconds);
    if (this.mode === 'stream' && this.ctx && this.streamGain && this.streamSynth) {
      this.pumpStream(this.ctx, this.streamGain, this.streamSynth);
    }
    this.watchClock();
  }

  /** Advances the analysis copy by the elapsed time (capped, so a long pause cannot stall). */
  private renderAnalysis(dtSeconds: number): void {
    const synth = this.analysis;
    const n = Math.min(Math.round(dtSeconds * synth.sampleRate), 4096);
    let left = n;
    while (left > 0) {
      const count = Math.min(left, BLOCK);
      const frame = synth.frame;
      synth.render(this.block, count);
      // Keep feeding the analyser for a second after the string falls silent.
      if (synth.active) this.quietSince = -1;
      else if (this.quietSince < 0) this.quietSince = frame;
      if (synth.active || frame - this.quietSince < synth.sampleRate) {
        this.listener.samples(frame, this.block.slice(0, count));
      }
      left -= count;
    }
  }

  private pumpStream(ctx: AudioContext, gain: GainNode, synth: StringSynth): void {
    if (ctx.state !== 'running') return;
    const now = ctx.currentTime;
    if (this.streamTime < now + 0.01) this.streamTime = now + 0.03;
    while (this.streamTime < now + STREAM_LOOKAHEAD) {
      synth.render(this.block, BLOCK);
      synth.master.process(this.block, this.wet, BLOCK);
      const buffer = ctx.createBuffer(1, BLOCK, ctx.sampleRate);
      buffer.copyToChannel(this.wet, 0);
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      src.connect(gain);
      src.start(this.streamTime);
      this.streamTime += BLOCK / ctx.sampleRate;
    }
  }

  /** Detects a context that claims to run but whose clock never moves (no output device). */
  private watchClock(): void {
    const ctx = this.ctx;
    if (!ctx || this.mode === 'silent' || ctx.state !== 'running') {
      this.clockCheck = null;
      return;
    }
    if (document.visibilityState === 'hidden') return;
    const wall = performance.now() / 1000;
    const audio = ctx.currentTime;
    if (!this.clockCheck || audio !== this.clockCheck.audio) {
      this.clockCheck = { wall, audio };
      return;
    }
    if (wall - this.clockCheck.wall > STALL_TIMEOUT) {
      this.audioFailed('the audio clock stands still (no output device?)');
    }
  }
}
