export type UiSoundName = 'tap' | 'key' | 'toggle' | 'confirm' | 'back' | 'error' | 'open' | 'close' | 'move' | 'connect';

interface SoundProfile {
  wave: OscillatorType;
  from: number;
  to: number;
  duration: number;
  gain: number;
  throttle: number;
}

const PROFILES: Record<UiSoundName, SoundProfile> = {
  tap: { wave: 'triangle', from: 520, to: 720, duration: 0.045, gain: 0.16, throttle: 24 },
  key: { wave: 'sine', from: 680, to: 540, duration: 0.032, gain: 0.12, throttle: 18 },
  toggle: { wave: 'sine', from: 390, to: 640, duration: 0.085, gain: 0.15, throttle: 35 },
  confirm: { wave: 'triangle', from: 540, to: 880, duration: 0.12, gain: 0.18, throttle: 45 },
  back: { wave: 'triangle', from: 430, to: 260, duration: 0.075, gain: 0.14, throttle: 35 },
  error: { wave: 'sawtooth', from: 190, to: 120, duration: 0.13, gain: 0.1, throttle: 90 },
  open: { wave: 'sine', from: 340, to: 690, duration: 0.11, gain: 0.15, throttle: 45 },
  close: { wave: 'sine', from: 650, to: 320, duration: 0.09, gain: 0.13, throttle: 45 },
  move: { wave: 'triangle', from: 250, to: 290, duration: 0.022, gain: 0.075, throttle: 70 },
  connect: { wave: 'sine', from: 440, to: 920, duration: 0.18, gain: 0.17, throttle: 120 },
};

type AudioContextConstructor = new () => AudioContext;

function audioContextConstructor(): AudioContextConstructor | null {
  const candidate = globalThis.AudioContext
    ?? (globalThis as typeof globalThis & { webkitAudioContext?: AudioContextConstructor }).webkitAudioContext;
  return candidate ?? null;
}

export class UiSoundEngine {
  private context: AudioContext | null = null;
  private master: GainNode | null = null;
  private enabled = true;
  private volume = 0.35;
  private variation = 0;
  private disposed = false;
  private lastSoundRequest = -Infinity;
  private readonly lastPlayed = new Map<UiSoundName, number>();

  configure(settings: { uiSoundEnabled: boolean; uiSoundVolume: number }): void {
    if (this.disposed) return;
    this.enabled = settings.uiSoundEnabled;
    this.volume = Number.isFinite(settings.uiSoundVolume) ? Math.max(0, Math.min(1, settings.uiSoundVolume)) : 0.35;
    if (this.master && this.context) {
      this.master.gain.setTargetAtTime(this.volume, this.context.currentTime, 0.015);
    }
  }

  unlock(): void {
    if (this.disposed || !this.enabled || this.volume <= 0) return;
    const context = this.ensureContext();
    if (context?.state === 'suspended') void context.resume().catch(() => undefined);
  }

  hasSoundRequestSince(timestamp: number): boolean {
    return this.lastSoundRequest >= timestamp;
  }

  play(name: UiSoundName): boolean {
    if (this.disposed || !this.enabled || this.volume <= 0) return false;
    this.lastSoundRequest = globalThis.performance.now();
    const context = this.ensureContext();
    if (!context || !this.master) return false;
    if (context.state !== 'running') {
      void context.resume().catch(() => undefined);
      return false;
    }
    const profile = PROFILES[name];
    const now = context.currentTime;
    const last = this.lastPlayed.get(name) ?? -Infinity;
    if (now - last < profile.throttle / 1000) return false;
    this.lastPlayed.set(name, now);

    const variation = (this.variation++ % 5) - 2;
    const pitch = 1 + variation * 0.035;
    const oscillator = context.createOscillator();
    const envelope = context.createGain();
    oscillator.type = profile.wave;
    oscillator.frequency.setValueAtTime(profile.from * pitch, now);
    oscillator.frequency.exponentialRampToValueAtTime(profile.to * pitch, now + profile.duration);
    envelope.gain.setValueAtTime(0.0001, now);
    envelope.gain.exponentialRampToValueAtTime(profile.gain, now + 0.006);
    envelope.gain.exponentialRampToValueAtTime(0.0001, now + profile.duration);
    oscillator.connect(envelope);
    envelope.connect(this.master);
    oscillator.start(now);
    oscillator.stop(now + profile.duration + 0.01);
    oscillator.onended = () => {
      oscillator.disconnect();
      envelope.disconnect();
    };
    return true;
  }

  dispose(): void {
    this.disposed = true;
    if (this.context) void this.context.close().catch(() => undefined);
    this.context = null;
    this.master = null;
    this.lastPlayed.clear();
  }

  private ensureContext(): AudioContext | null {
    if (this.disposed || this.context) return this.context;
    const Constructor = audioContextConstructor();
    if (!Constructor) return null;
    try {
      this.context = new Constructor();
      this.master = this.context.createGain();
      this.master.gain.value = this.volume;
      this.master.connect(this.context.destination);
      return this.context;
    } catch {
      this.context = null;
      this.master = null;
      return null;
    }
  }
}

export const uiSound = new UiSoundEngine();
