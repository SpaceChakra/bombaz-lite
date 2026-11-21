/**
 * Procedural Audio Manager for BOMBAZ.
 *
 * Gritty 80s analog sound effects and a dynamic monophonic power drone (sawtooth + square)
 * built entirely with Web Audio API. No external sample files required.
 */
import { storage } from './storage.js';

export class AudioManager {
  private ctx: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private musicGain: GainNode | null = null;
  private sfxGain: GainNode | null = null;
  private drive: WaveShaperNode | null = null;
  private initialized = false;
  private next = Object.create(null) as Record<string, number>;
  private voices = 0;
  private readonly maxVoices = 24;

  // Bed Drone state
  private bedOn = false;
  private bedSub: OscillatorNode | null = null;
  private bedFifth: OscillatorNode | null = null;
  private bedLfo: OscillatorNode | null = null;
  private bedFilter: BiquadFilterNode | null = null;
  private bedLfoGain: GainNode | null = null;
  private bedGain: GainNode | null = null;
  private bedPulseTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {}

  async init(): Promise<void> {
    if (this.initialized) return;

    try {
      const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
      if (!AudioCtx) return;

      this.ctx = new AudioCtx();
      this.masterGain = this.ctx.createGain();
      this.masterGain.connect(this.ctx.destination);

      this.musicGain = this.ctx.createGain();
      this.musicGain.connect(this.masterGain);

      this.sfxGain = this.ctx.createGain();

      this.drive = this.ctx.createWaveShaper();
      this.drive.curve = this.makeDistortionCurve(65) as any;
      this.drive.oversample = '2x';

      this.sfxGain.connect(this.drive);
      this.drive.connect(this.masterGain);

      this.updateVolumes();

      this.initialized = true;
    } catch (e) {
      console.warn('Web Audio initialization failed:', e);
    }
  }

  updateVolumes(): void {
    if (!this.ctx) return;
    const s = storage.getSettings();
    const t = this.t();
    if (this.masterGain) {
      this.masterGain.gain.setValueAtTime(s.masterVol * 0.5, t);
    }
    if (this.musicGain) {
      this.musicGain.gain.setValueAtTime(s.musicVol * 0.4, t);
    }
    if (this.sfxGain) {
      this.sfxGain.gain.setValueAtTime(s.sfxVol * 0.75, t);
    }
  }


  private makeDistortionCurve(amount: number): Float32Array {
    const k = amount;
    const n = 44100;
    const curve = new Float32Array(n);
    const deg = Math.PI / 180;
    for (let i = 0; i < n; i++) {
      const x = (i * 2) / n - 1;
      curve[i] = ((3 + k) * x * 20 * deg) / (Math.PI + k * Math.abs(x));
    }
    return curve;
  }

  resume(): void {
    if (this.ctx && this.ctx.state === 'suspended') {
      this.ctx.resume();
    }
  }

  t(): number {
    return this.ctx ? this.ctx.currentTime : 0;
  }

  private gate(name: string, minGap: number): boolean {
    if (!this.ctx) return false;
    const now = this.t();
    if ((this.next[name] || 0) > now) return false;
    this.next[name] = now + minGap;
    return true;
  }

  private acquire(duration: number): boolean {
    if (!this.ctx || this.voices >= this.maxVoices) return false;
    this.voices++;
    const later = Math.max(0.05, duration) * 1000 + 30;
    setTimeout(() => {
      this.voices = Math.max(0, this.voices - 1);
    }, later);
    return true;
  }

  private env(volume: number, attack: number, duration: number, tail = 0.0008): GainNode {
    const g = this.ctx!.createGain();
    const t = this.t();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, volume), t + Math.max(0.004, attack));
    g.gain.exponentialRampToValueAtTime(tail, t + duration);
    return g;
  }

  private filter(type: BiquadFilterType, freq: number, q = 1): BiquadFilterNode {
    const f = this.ctx!.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    return f;
  }

  private sweep({
    from,
    to,
    duration,
    type = 'square',
    volume = 0.2,
    attack = 0.008,
    filterFreq = 0,
    q = 4,
  }: {
    from: number;
    to: number;
    duration: number;
    type?: OscillatorType;
    volume?: number;
    attack?: number;
    filterFreq?: number;
    q?: number;
  }): void {
    if (!this.acquire(duration)) return;
    const t = this.t();
    const osc = this.ctx!.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(from, t);
    osc.frequency.exponentialRampToValueAtTime(Math.max(20, to), t + duration);

    const g = this.env(volume, attack, duration);
    if (filterFreq) {
      const f = this.filter('lowpass', filterFreq, q);
      f.frequency.setValueAtTime(filterFreq, t);
      f.frequency.exponentialRampToValueAtTime(Math.max(80, filterFreq * 0.25), t + duration);
      osc.connect(f);
      f.connect(g);
    } else {
      osc.connect(g);
    }
    g.connect(this.sfxGain!);
    osc.start(t);
    osc.stop(t + duration + 0.02);
  }

  private noiseBuffer(): AudioBuffer {
    const rate = this.ctx!.sampleRate;
    const buf = this.ctx!.createBuffer(1, rate, rate);
    const data = buf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < data.length; i++) {
      const white = Math.random() * 2 - 1;
      last = (last + 0.02 * white) / 1.02;
      data[i] = white * 0.55 + last * 1.4;
    }
    return buf;
  }

  private noiseBurst({ duration = 0.2, volume = 0.2, startFreq = 2400, endFreq = 200, q = 0.7 }): void {
    if (!this.acquire(duration)) return;
    const t = this.t();
    const src = this.ctx!.createBufferSource();
    src.buffer = this.noiseBuffer();
    const f = this.filter('lowpass', startFreq, q);
    f.frequency.setValueAtTime(startFreq, t);
    f.frequency.exponentialRampToValueAtTime(Math.max(40, endFreq), t + duration);
    const g = this.env(volume, 0.004, duration);
    src.connect(f);
    f.connect(g);
    g.connect(this.sfxGain!);
    src.start(t);
    src.stop(t + duration + 0.02);
  }

  // --- Sound Effects ----------------------------------------------------

  playTick(): void {
    if (!this.gate('tick', 0.07)) return;
    this.sweep({ from: 1800, to: 1200, duration: 0.03, type: 'square', volume: 0.06, attack: 0.001 });
  }

  playExplosion(): void {
    if (!this.gate('boom', 0.06)) return;
    this.noiseBurst({ duration: 0.45, volume: 0.25, startFreq: 1800, endFreq: 60, q: 0.5 });
    this.sweep({ from: 150, to: 30, duration: 0.35, type: 'square', volume: 0.16, attack: 0.005 });
    this.sweep({ from: 60, to: 24, duration: 0.45, type: 'sine', volume: 0.14 });
  }

  playSeated(): void {
    if (!this.gate('seat', 0.1)) return;
    this.sweep({ from: 120, to: 600, duration: 0.15, type: 'square', volume: 0.14, filterFreq: 1200, q: 4 });
    this.noiseBurst({ duration: 0.08, volume: 0.07, startFreq: 1000, endFreq: 400 });
  }

  playLineClear(): void {
    if (!this.gate('clear', 0.3)) return;
    const notes = [261.63, 329.63, 392.00, 523.25];
    notes.forEach((f, i) => {
      setTimeout(() => {
        this.sweep({ from: f, to: f * 1.05, duration: 0.15, type: 'square', volume: 0.09, filterFreq: 2000, q: 3 });
      }, i * 60);
    });
    setTimeout(() => this.noiseBurst({ duration: 0.18, volume: 0.06, startFreq: 1800, endFreq: 300 }), 220);
  }

  playEject(): void {
    if (!this.gate('eject', 0.25)) return;
    this.sweep({ from: 600, to: 150, duration: 0.28, type: 'sawtooth', volume: 0.11, filterFreq: 1000, q: 3 });
    this.sweep({ from: 800, to: 200, duration: 0.18, type: 'sawtooth', volume: 0.08, filterFreq: 1500, q: 2 });
  }

  playPowerup(): void {
    if (!this.gate('pickup', 0.05)) return;
    this.sweep({ from: 440, to: 1200, duration: 0.12, type: 'square', volume: 0.09, filterFreq: 2400 });
    this.sweep({ from: 1200, to: 2200, duration: 0.1, type: 'square', volume: 0.07, attack: 0.01, filterFreq: 3000 });
  }

  playZap(): void {
    if (!this.gate('zap', 0.1)) return;
    this.sweep({ from: 1800, to: 300, duration: 0.15, type: 'sawtooth', volume: 0.11, filterFreq: 2400, q: 2 });
  }

  playMove(): void {
    if (!this.gate('move', 0.08)) return;
    this.sweep({ from: 120, to: 50, duration: 0.04, type: 'triangle', volume: 0.02, attack: 0.001 });
  }

  playPush(): void {
    if (!this.gate('push', 0.14)) return;
    this.noiseBurst({ duration: 0.15, volume: 0.06, startFreq: 400, endFreq: 80, q: 0.5 });
  }

  playDeleted(): void {
    if (!this.gate('deleted', 0.8)) return;
    this.sweep({ from: 440, to: 30, duration: 1.2, type: 'sawtooth', volume: 0.2, attack: 0.02, filterFreq: 800, q: 2 });
    this.noiseBurst({ duration: 0.8, volume: 0.14, startFreq: 600, endFreq: 40 });
  }

  playGateOpen(): void {
    if (!this.gate('gate_open', 0.4)) return;
    this.sweep({ from: 220, to: 880, duration: 0.25, type: 'square', volume: 0.12, filterFreq: 2000, q: 5 });
    this.sweep({ from: 440, to: 1760, duration: 0.2, type: 'sawtooth', volume: 0.08, filterFreq: 2400, q: 4 });
  }

  // --- Dynamic Drone Bed ------------------------------------------------

  startPlayBed(): void {
    if (!this.ctx || this.bedOn) return;
    this.resume();

    this.bedOn = true;
    const t = this.t();

    this.bedFilter = this.filter('lowpass', 240, 6);

    this.bedLfo = this.ctx.createOscillator();
    this.bedLfo.type = 'sine';
    this.bedLfo.frequency.value = 0.11;

    this.bedLfoGain = this.ctx.createGain();
    this.bedLfoGain.gain.value = 110;

    this.bedLfo.connect(this.bedLfoGain);
    this.bedLfoGain.connect(this.bedFilter.frequency);

    this.bedGain = this.ctx.createGain();
    this.bedGain.gain.setValueAtTime(0.0001, t);
    this.bedGain.gain.linearRampToValueAtTime(0.12, t + 1.2);

    this.bedSub = this.ctx.createOscillator();
    this.bedSub.type = 'square';
    this.bedSub.frequency.value = 55; // A1 note

    this.bedFifth = this.ctx.createOscillator();
    this.bedFifth.type = 'sawtooth';
    this.bedFifth.frequency.value = 82.5; // E2 (Perfect fifth detuned)
    this.bedFifth.detune.value = 6;

    this.bedSub.connect(this.bedFilter);
    this.bedFifth.connect(this.bedFilter);
    this.bedFilter.connect(this.bedGain);
    this.bedGain.connect(this.musicGain!);

    this.bedSub.start(t);
    this.bedFifth.start(t);
    this.bedLfo.start(t);

    this.scheduleBedPulse();
  }

  private scheduleBedPulse(): void {
    if (this.bedPulseTimer) clearTimeout(this.bedPulseTimer);
    if (!this.bedOn) return;

    this.bedPulseTimer = setTimeout(() => {
      if (!this.bedOn) return;
      this.bedPulse();
      this.scheduleBedPulse();
    }, 1600 + Math.random() * 400);
  }

  private bedPulse(): void {
    if (!this.ctx || !this.bedOn) return;
    // Sparse stabs over the main drone to add texture
    const root = Math.random() < 0.5 ? 110 : 165;
    this.sweep({
      from: root * 0.98,
      to: root,
      duration: 0.22,
      type: 'square',
      volume: 0.04,
      attack: 0.01,
      filterFreq: 900,
      q: 5,
    });
  }

  /**
   * Adjusts the drone bed's speed, filter cutoff, and pitch based on the Voild proximity.
   * @param danger 0..1 representing proximity to the Void
   */
  setDanger(danger: number): void {
    if (!this.ctx || !this.bedOn) return;

    const t = this.t();
    
    // As danger increases, filter frequency opens up, exposing aggressive sawtooth harmonics
    if (this.bedFilter) {
      this.bedFilter.frequency.setTargetAtTime(240 + danger * 460, t, 0.08);
    }
    
    // LFO frequency rises, making the filter wobble faster
    if (this.bedLfo) {
      this.bedLfo.frequency.setTargetAtTime(0.11 + danger * 1.8, t, 0.1);
    }
    if (this.bedLfoGain) {
      this.bedLfoGain.gain.setTargetAtTime(110 + danger * 200, t, 0.1);
    }

    // Oscillators pitch shifts slightly upward to create a grinding/panic tension effect
    if (this.bedSub) {
      this.bedSub.frequency.setTargetAtTime(55 * (1 + danger * 0.12), t, 0.15);
    }
    if (this.bedFifth) {
      this.bedFifth.frequency.setTargetAtTime(82.5 * (1 + danger * 0.12), t, 0.15);
    }
  }

  stopPlayBed(): void {
    this.bedOn = false;
    if (this.bedPulseTimer) clearTimeout(this.bedPulseTimer);

    const t = this.ctx ? this.t() : 0;
    
    const nodes = [this.bedSub, this.bedFifth, this.bedLfo, this.bedFilter, this.bedGain, this.bedLfoGain];
    for (const node of nodes) {
      if (!node) continue;
      try {
        if ((node as any).gain) {
          (node as any).gain.cancelScheduledValues(t);
          (node as any).gain.setTargetAtTime(0.0001, t, 0.08);
        }
        if ((node as any).stop) {
          (node as any).stop(t + 0.2);
        }
      } catch {}
    }

    this.bedSub = null;
    this.bedFifth = null;
    this.bedLfo = null;
    this.bedFilter = null;
    this.bedGain = null;
    this.bedLfoGain = null;
  }
}

/** Global singleton instance of AudioManager. */
export const audio = new AudioManager();
