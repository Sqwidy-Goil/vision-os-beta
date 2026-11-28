import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MotionController, type GyroSample } from '../src/core/motion';

type RotationRate = { alpha: number | null; beta: number | null; gamma: number | null };

function emitMotion(timestamp: number, rotationRate: RotationRate | null): void {
  const event = new Event('devicemotion');
  Object.defineProperties(event, {
    timeStamp: { value: timestamp },
    rotationRate: { value: rotationRate },
  });
  globalThis.dispatchEvent(event);
}

function emitOrientation(): void {
  const event = new Event('deviceorientation');
  Object.defineProperties(event, {
    alpha: { value: 10 },
    beta: { value: 20 },
    gamma: { value: 30 },
  });
  globalThis.dispatchEvent(event);
}

describe('MotionController gyro samples', () => {
  const controllers: MotionController[] = [];

  function createMotion(onStatus = vi.fn()): MotionController {
    const controller = new MotionController(onStatus);
    controllers.push(controller);
    return controller;
  }

  beforeEach(() => {
    const listeners = new Map<string, Set<(event: Event) => void>>();
    const addEventListener = vi.fn((type: string, listener: (event: Event) => void) => {
      const handlers = listeners.get(type) ?? new Set();
      handlers.add(listener);
      listeners.set(type, handlers);
    });
    const removeEventListener = vi.fn((type: string, listener: (event: Event) => void) => {
      listeners.get(type)?.delete(listener);
    });
    const dispatchEvent = vi.fn((event: Event) => {
      listeners.get(event.type)?.forEach((listener) => listener(event));
      return true;
    });
    vi.stubGlobal('addEventListener', addEventListener);
    vi.stubGlobal('removeEventListener', removeEventListener);
    vi.stubGlobal('dispatchEvent', dispatchEvent);
    vi.stubGlobal('DeviceOrientationEvent', class {});
    vi.stubGlobal('DeviceMotionEvent', class {});
    vi.stubGlobal('screen', { orientation: { angle: 0 } });
  });

  afterEach(() => {
    controllers.splice(0).forEach((controller) => controller.disable());
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('retains orientation behavior and requests iOS motion permission only for gyro', async () => {
    const orientationRequest = vi.fn().mockResolvedValue('granted');
    const motionRequest = vi.fn().mockResolvedValue('granted');
    vi.stubGlobal('DeviceOrientationEvent', class { static requestPermission = orientationRequest; });
    vi.stubGlobal('DeviceMotionEvent', class { static requestPermission = motionRequest; });
    const addListener = vi.spyOn(globalThis, 'addEventListener');
    const motion = createMotion();

    await expect(motion.enable()).resolves.toBe(true);
    emitOrientation();
    expect(motion.hasData).toBe(true);
    expect(motion.getTarget()).not.toBeNull();
    expect(orientationRequest).toHaveBeenCalledTimes(1);
    expect(motionRequest).not.toHaveBeenCalled();
    expect(addListener.mock.calls.some(([type]) => type === 'devicemotion')).toBe(false);

    await expect(motion.enable({ gyro: true })).resolves.toBe(true);
    await expect(motion.enable({ gyro: true })).resolves.toBe(true);
    expect(motion.gyroEnabled).toBe(true);
    expect(motionRequest).toHaveBeenCalledTimes(1);
    expect(addListener.mock.calls.filter(([type]) => type === 'devicemotion')).toHaveLength(1);

    await expect(motion.enable()).resolves.toBe(true);
    expect(motion.gyroEnabled).toBe(false);
    expect(motion.hasData).toBe(true);
  });

  it('converts finite rotation rates to rad/s and ignores duplicate or invalid timestamps', async () => {
    const samples: GyroSample[] = [];
    const motion = createMotion();
    await motion.enable({ gyro: true, onGyro: (sample) => samples.push(sample) });

    emitMotion(100, { alpha: 30, beta: 60, gamma: 90 });
    const first = motion.latestGyroSample;
    expect(first?.angularVelocity.x).toBeCloseTo(Math.PI / 3);
    expect(first?.angularVelocity.y).toBeCloseTo(Math.PI / 2);
    expect(first?.angularVelocity.z).toBeCloseTo(Math.PI / 6);

    emitMotion(100, { alpha: 0, beta: 0, gamma: 0 });
    emitMotion(99, { alpha: 0, beta: 0, gamma: 0 });
    emitMotion(101, { alpha: Number.NaN, beta: 0, gamma: 0 });
    emitMotion(102, { alpha: 0, beta: null, gamma: 0 });
    emitMotion(Number.POSITIVE_INFINITY, { alpha: 0, beta: 0, gamma: 0 });
    emitMotion(103, null);
    expect(samples).toHaveLength(1);
    expect(motion.latestGyroSample).toBe(first);

    emitMotion(104, { alpha: 0, beta: 0, gamma: 0 });
    expect(samples).toHaveLength(2);
    expect(motion.latestGyroSample?.timestamp).toBe(104);
    motion.disable();
    emitMotion(105, { alpha: 1, beta: 1, gamma: 1 });
    expect(samples).toHaveLength(2);
    expect(motion.latestGyroSample).toBeNull();
    expect(motion.gyroEnabled).toBe(false);
  });

  it('keeps orientation enabled when optional gyro permission is denied', async () => {
    const motionRequest = vi.fn().mockResolvedValue('denied');
    vi.stubGlobal('DeviceMotionEvent', class { static requestPermission = motionRequest; });
    const onStatus = vi.fn();
    const motion = createMotion(onStatus);

    await expect(motion.enable({ gyro: true })).resolves.toBe(true);
    expect(motion.enabled).toBe(true);
    expect(motion.gyroEnabled).toBe(false);
    expect(motion.gyroPermission).toBe('denied');
    expect(onStatus).toHaveBeenLastCalledWith('Motion enabled; gyro access was not granted.', true);
    emitOrientation();
    expect(motion.getTarget()).not.toBeNull();
  });
});
