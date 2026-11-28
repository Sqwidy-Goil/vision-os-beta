import { afterEach, describe, expect, it, vi } from 'vitest';
import { UiSoundEngine } from '../src/core/uiSound';

class FakeParam {
  readonly values: number[] = [];
  value = 0;
  setValueAtTime(value: number): void { this.values.push(value); this.value = value; }
  exponentialRampToValueAtTime(value: number): void { this.values.push(value); this.value = value; }
  setTargetAtTime(value: number): void { this.values.push(value); this.value = value; }
}

class FakeGain {
  readonly gain = new FakeParam();
  connect = vi.fn();
  disconnect = vi.fn();
}

class FakeOscillator {
  type = 'sine';
  readonly frequency = new FakeParam();
  onended: (() => void) | null = null;
  connect = vi.fn();
  disconnect = vi.fn();
  start = vi.fn();
  stop = vi.fn();
}

class FakeAudioContext {
  static instances: FakeAudioContext[] = [];
  currentTime = 0;
  state = 'suspended';
  readonly destination = {};
  readonly gains: FakeGain[] = [];
  readonly oscillators: FakeOscillator[] = [];
  resume = vi.fn(async () => { this.state = 'running'; });
  close = vi.fn(async () => { this.state = 'closed'; });

  constructor() { FakeAudioContext.instances.push(this); }

  createGain(): FakeGain {
    const gain = new FakeGain();
    this.gains.push(gain);
    return gain;
  }

  createOscillator(): FakeOscillator {
    const oscillator = new FakeOscillator();
    this.oscillators.push(oscillator);
    return oscillator;
  }
}

function engine(): UiSoundEngine {
  FakeAudioContext.instances = [];
  const result = new UiSoundEngine();
  result.configure({ uiSoundEnabled: true, uiSoundVolume: 0.4 });
  return result;
}

afterEach(() => vi.unstubAllGlobals());

describe('UI sound engine', () => {
  it('stays silent and does not create audio while disabled', () => {
    vi.stubGlobal('AudioContext', FakeAudioContext);
    const sound = engine();
    sound.configure({ uiSoundEnabled: false, uiSoundVolume: 0.4 });
    expect(sound.play('tap')).toBe(false);
    sound.unlock();
    expect(FakeAudioContext.instances).toHaveLength(0);
  });

  it('unlocks one shared context and synthesizes a short enveloped sound', () => {
    vi.stubGlobal('AudioContext', FakeAudioContext);
    const sound = engine();
    sound.unlock();
    const context = FakeAudioContext.instances[0];
    expect(context.state).toBe('running');
    expect(context.resume).toHaveBeenCalledTimes(1);
    expect(sound.play('tap')).toBe(true);
    expect(FakeAudioContext.instances).toHaveLength(1);
    expect(context.oscillators).toHaveLength(1);
    expect(context.gains).toHaveLength(2);
    expect(context.oscillators[0].frequency.values[0]).toBeGreaterThan(0);
    expect(context.oscillators[0].stop).toHaveBeenCalled();
    context.oscillators[0].onended?.();
    expect(context.oscillators[0].disconnect).toHaveBeenCalled();
    expect(context.gains[1].disconnect).toHaveBeenCalled();
  });

  it('does not queue sounds while the audio context is suspended', () => {
    vi.stubGlobal('AudioContext', FakeAudioContext);
    const sound = engine();
    expect(sound.play('tap')).toBe(false);
    const context = FakeAudioContext.instances[0];
    context.state = 'suspended';
    expect(sound.play('key')).toBe(false);
    expect(context.oscillators).toHaveLength(0);
    sound.unlock();
    expect(sound.play('tap')).toBe(true);
    expect(context.oscillators).toHaveLength(1);
  });

  it('throttles repeated sounds while allowing later variations', () => {
    vi.stubGlobal('AudioContext', FakeAudioContext);
    const sound = engine();
    sound.unlock();
    expect(sound.play('key')).toBe(true);
    expect(sound.play('key')).toBe(false);
    expect(sound.play('tap')).toBe(true);
    const context = FakeAudioContext.instances[0];
    context.currentTime = 1;
    expect(sound.play('key')).toBe(true);
    expect(context.oscillators).toHaveLength(3);
    expect(context.oscillators[0].frequency.values[0]).not.toBe(context.oscillators[2].frequency.values[0]);
  });

  it('clamps volume, updates the master gain, and closes its context', () => {
    vi.stubGlobal('AudioContext', FakeAudioContext);
    const sound = engine();
    sound.play('tap');
    const context = FakeAudioContext.instances[0];
    expect(context.gains[0].gain.value).toBe(0.4);
    sound.configure({ uiSoundEnabled: true, uiSoundVolume: 9 });
    expect(context.gains[0].gain.values.at(-1)).toBe(1);
    sound.configure({ uiSoundEnabled: true, uiSoundVolume: -1 });
    expect(context.gains[0].gain.values.at(-1)).toBe(0);
    sound.dispose();
    expect(context.close).toHaveBeenCalledTimes(1);
    expect(sound.play('tap')).toBe(false);
  });

  it('fails safely when Web Audio is unavailable', () => {
    vi.stubGlobal('AudioContext', undefined);
    const sound = engine();
    expect(sound.play('tap')).toBe(false);
    sound.unlock();
    sound.dispose();
  });
});
