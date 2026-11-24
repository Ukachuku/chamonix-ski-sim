import { clamp } from '../math/mat4';

/**
 * Procedural Web Audio synthesizer generating dynamic alpine wind rush,
 * snow-carving hiss / hockey-stop steel edge scrape, and powder landing thumps.
 * Zero external audio files required.
 */
export class SkiAudio {
  private ctx: AudioContext | null = null;
  private masterGain: GainNode | null = null;

  // Wind rush chain
  private windLowFilter: BiquadFilterNode | null = null;
  private windHowlFilter: BiquadFilterNode | null = null;
  private windGain: GainNode | null = null;
  private windHowlGain: GainNode | null = null;

  // Snow carve / scrape chain
  private snowBodyFilter: BiquadFilterNode | null = null;
  private snowEdgeFilter: BiquadFilterNode | null = null;
  private snowBodyGain: GainNode | null = null;
  private snowEdgeGain: GainNode | null = null;

  private noiseBuffer: AudioBuffer | null = null;
  private muted = false;
  private initialized = false;

  get isMuted(): boolean {
    return this.muted;
  }

  /** Must be called from a user gesture (click or keydown) to unlock browser Web Audio. */
  unlock(): void {
    if (!this.initialized) {
      this.initGraph();
    }
    if (this.ctx && this.ctx.state === 'suspended') {
      void this.ctx.resume();
    }
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    if (this.ctx && this.masterGain) {
      const now = this.ctx.currentTime;
      this.masterGain.gain.setTargetAtTime(muted ? 0 : 0.72, now, 0.04);
    }
  }

  toggleMute(): boolean {
    this.setMuted(!this.muted);
    return this.muted;
  }

  private initGraph(): void {
    const AudioCtx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext })
        .webkitAudioContext;
    if (!AudioCtx) return;

    const ctx = new AudioCtx();
    this.ctx = ctx;

    // Generate 4 seconds of rich pink-ish stereo noise for organic wind & granular snow
    const sampleRate = ctx.sampleRate;
    const length = sampleRate * 4;
    const buffer = ctx.createBuffer(2, length, sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const data = buffer.getChannelData(ch);
      let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
      for (let i = 0; i < length; i++) {
        const white = Math.random() * 2 - 1;
        b0 = 0.99886 * b0 + white * 0.0555179;
        b1 = 0.99332 * b1 + white * 0.0750759;
        b2 = 0.96900 * b2 + white * 0.1538520;
        b3 = 0.86650 * b3 + white * 0.3104856;
        b4 = 0.55000 * b4 + white * 0.5329522;
        b5 = -0.7616 * b5 - white * 0.0168980;
        const pink = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362) * 0.065;
        b6 = white * 0.115926;
        // Mix slight white brightness for crisp snow crystal hiss
        data[i] = clamp(pink * 0.85 + white * 0.18, -1, 1);
      }
    }
    this.noiseBuffer = buffer;

    const master = ctx.createGain();
    master.gain.value = this.muted ? 0 : 0.72;
    master.connect(ctx.destination);
    this.masterGain = master;

    // --- 1. WIND RUSH SYNTH ---
    const windSrc = ctx.createBufferSource();
    windSrc.buffer = buffer;
    windSrc.loop = true;

    const windLow = ctx.createBiquadFilter();
    windLow.type = 'lowpass';
    windLow.frequency.value = 260;
    windLow.Q.value = 0.9;

    const windGain = ctx.createGain();
    windGain.gain.value = 0.04;

    const windHowl = ctx.createBiquadFilter();
    windHowl.type = 'bandpass';
    windHowl.frequency.value = 520;
    windHowl.Q.value = 2.6;

    const windHowlGain = ctx.createGain();
    windHowlGain.gain.value = 0.0;

    windSrc.connect(windLow);
    windLow.connect(windGain);
    windGain.connect(master);

    windSrc.connect(windHowl);
    windHowl.connect(windHowlGain);
    windHowlGain.connect(master);

    windSrc.start();
    this.windLowFilter = windLow;
    this.windHowlFilter = windHowl;
    this.windGain = windGain;
    this.windHowlGain = windHowlGain;

    // --- 2. SNOW CARVING & EDGE SCRAPE SYNTH ---
    const snowSrc = ctx.createBufferSource();
    snowSrc.buffer = buffer;
    snowSrc.loop = true;
    snowSrc.playbackRate.value = 1.15;

    const snowBody = ctx.createBiquadFilter();
    snowBody.type = 'bandpass';
    snowBody.frequency.value = 1100;
    snowBody.Q.value = 0.85;

    const snowBodyGain = ctx.createGain();
    snowBodyGain.gain.value = 0.0;

    const snowEdge = ctx.createBiquadFilter();
    snowEdge.type = 'bandpass';
    snowEdge.frequency.value = 2850;
    snowEdge.Q.value = 1.7;

    const snowEdgeGain = ctx.createGain();
    snowEdgeGain.gain.value = 0.0;

    snowSrc.connect(snowBody);
    snowBody.connect(snowBodyGain);
    snowBodyGain.connect(master);

    snowSrc.connect(snowEdge);
    snowEdge.connect(snowEdgeGain);
    snowEdgeGain.connect(master);

    snowSrc.start(0, 1.37); // Phase offset from wind source
    this.snowBodyFilter = snowBody;
    this.snowEdgeFilter = snowEdge;
    this.snowBodyGain = snowBodyGain;
    this.snowEdgeGain = snowEdgeGain;

    this.initialized = true;
  }

  /** Modulate wind & snow audio smoothly every animation frame. */
  update(
    speedKmh: number,
    carveIntensity: number,
    hockeyStop: number,
    grounded: boolean,
    active: boolean
  ): void {
    if (!this.initialized || !this.ctx || this.ctx.state !== 'running') return;

    const now = this.ctx.currentTime;
    const speedNorm = clamp(speedKmh / 115, 0, 1.25);

    // Subtle alpine ridge ambient breeze even when stationary at summit
    const baseWind = active ? 0.045 : 0.035;
    const windLevel = baseWind + Math.pow(speedNorm, 1.45) * 0.42;
    const windCutoff = 190 + speedNorm * 1150 + (grounded ? 0 : 280);
    const howlFreq = 340 + speedNorm * 780 + (grounded ? 0 : 260);
    const howlLevel = Math.max(0, speedNorm - 0.22) * (grounded ? 0.14 : 0.24);

    this.windLowFilter!.frequency.setTargetAtTime(windCutoff, now, 0.06);
    this.windGain!.gain.setTargetAtTime(windLevel, now, 0.06);
    this.windHowlFilter!.frequency.setTargetAtTime(howlFreq, now, 0.08);
    this.windHowlGain!.gain.setTargetAtTime(howlLevel, now, 0.08);

    // Snow glide + aggressive edge carve & hockey-stop scrape (silent while airborne!)
    if (grounded && active && speedKmh > 1.5) {
      const glideBase = clamp(speedNorm * 0.14, 0, 0.18);
      const carveBoost = carveIntensity * (0.24 + speedNorm * 0.26);
      const hockeyBoost = hockeyStop * clamp(speedKmh / 28, 0, 1) * 0.56;

      const bodyVol = glideBase + carveBoost * 0.72 + hockeyBoost * 0.95;
      const edgeVol =
        glideBase * 0.35 + carveBoost * 0.92 + hockeyBoost * 1.15;

      const bodyFreq = 820 + speedNorm * 650 + hockeyStop * 480;
      const edgeFreq = 2200 + carveIntensity * 1100 + hockeyStop * 1350;

      this.snowBodyFilter!.frequency.setTargetAtTime(bodyFreq, now, 0.04);
      this.snowEdgeFilter!.frequency.setTargetAtTime(edgeFreq, now, 0.04);
      this.snowBodyGain!.gain.setTargetAtTime(clamp(bodyVol, 0, 0.65), now, 0.04);
      this.snowEdgeGain!.gain.setTargetAtTime(clamp(edgeVol, 0, 0.58), now, 0.04);
    } else {
      this.snowBodyGain!.gain.setTargetAtTime(0, now, 0.05);
      this.snowEdgeGain!.gain.setTargetAtTime(0, now, 0.05);
    }
  }

  /** Crisp muffled powder impact thump when touching down from a ridge jump. */
  triggerLanding(strength: number): void {
    if (
      !this.initialized ||
      !this.ctx ||
      !this.masterGain ||
      !this.noiseBuffer ||
      this.ctx.state !== 'running' ||
      this.muted
    ) {
      return;
    }

    const ctx = this.ctx;
    const now = ctx.currentTime;
    const s = clamp(strength, 0.15, 1.0);

    // Sub thump oscillator
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(110 + s * 40, now);
    osc.frequency.exponentialRampToValueAtTime(34, now + 0.18);

    const oscGain = ctx.createGain();
    oscGain.gain.setValueAtTime(0.32 * s, now);
    oscGain.gain.exponentialRampToValueAtTime(0.001, now + 0.22);

    osc.connect(oscGain);
    oscGain.connect(this.masterGain);
    osc.start(now);
    osc.stop(now + 0.24);

    // Powder spray puff noise burst
    const puff = ctx.createBufferSource();
    puff.buffer = this.noiseBuffer;

    const puffFilter = ctx.createBiquadFilter();
    puffFilter.type = 'bandpass';
    puffFilter.frequency.setValueAtTime(1350, now);
    puffFilter.Q.value = 0.7;

    const puffGain = ctx.createGain();
    puffGain.gain.setValueAtTime(0.45 * s, now);
    puffGain.gain.exponentialRampToValueAtTime(0.001, now + 0.34);

    puff.connect(puffFilter);
    puffFilter.connect(puffGain);
    puffGain.connect(this.masterGain);
    puff.start(now, Math.random() * 2.0, 0.36);
  }
}
