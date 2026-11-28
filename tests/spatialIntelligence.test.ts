import { describe, expect, it } from 'vitest';
import { SpatialIntelligence } from '../src/spatial/intelligence/spatialIntelligence';
import type { CameraIntrinsics, CompanionSpatialSample } from '../src/spatial/intelligence/types';
import type { VioErrorResult, VioFrameRequest, VioFrameResult } from '../src/spatial/intelligence/workers/vio.worker';

class FakeWorker {
  onmessage: ((event: MessageEvent<VioFrameResult | VioErrorResult>) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  readonly requests: VioFrameRequest[] = [];
  terminated = false;

  postMessage(request: VioFrameRequest): void {
    this.requests.push(request);
  }

  terminate(): void {
    this.terminated = true;
  }
}

const intrinsics: CameraIntrinsics = {
  width: 32,
  height: 32,
  fx: 28,
  fy: 28,
  cx: 16,
  cy: 16,
  timestamp: 100,
  calibration: 'estimated',
};

function image(timestamp: number): ImageData {
  return { width: 32, height: 32, data: new Uint8ClampedArray(32 * 32 * 4), timestamp } as unknown as ImageData;
}

function companionSample(timestamp: number): CompanionSpatialSample {
  const covariance = new Array<number>(36).fill(0);
  covariance[0] = covariance[7] = covariance[14] = 0.01;
  covariance[21] = covariance[28] = covariance[35] = 0.01;
  return {
    frameId: 1,
    timestamp,
    pose: {
      frameId: 1,
      timestamp,
      position: [1, 2, 3],
      quaternion: [0, 0, 0, 1],
      velocity: [0, 0, 0],
      covariance,
      confidence: 0.9,
      scale: 'metric',
      source: 'companion',
    },
    surfaces: [],
    objects: [],
    freeSpace: [],
    calibrationConfidence: 0.95,
  };
}

describe('camera and companion fusion', () => {
  it('uses live camera acquisition failure to fall back without disabling orientation', async () => {
    const intelligence = new SpatialIntelligence({
      hardware: { camera: true, worker: true, orientation: true, gyro: true },
    });
    try {
      const camera = await intelligence.setMode('camera', true);
      expect(camera.activeMode).toBe('camera');
      const fallback = await intelligence.setMode('camera', false);
      expect(fallback.requestedMode).toBe('camera');
      expect(fallback.activeMode).toBe('economy');
      expect(fallback.camera).toBe(false);
      expect(fallback.visualTracking).toBe(false);
      expect(fallback.gyroFusion).toBe(true);
    } finally {
      intelligence.dispose();
    }
  });

  it('keeps camera tracking active in full mode and falls back without losing the session', async () => {
    const workers: FakeWorker[] = [];
    const intelligence = new SpatialIntelligence({
      hardware: { camera: true, worker: true, orientation: true, gyro: true },
      workerFactory: () => {
        const worker = new FakeWorker();
        workers.push(worker);
        return worker;
      },
      now: () => 1000,
    });
    try {
      const fallback = await intelligence.setMode('full');
      expect(fallback.activeMode).toBe('camera');
      intelligence.ingestFrame(100, image(100), intrinsics);
      expect(workers[0]?.requests).toHaveLength(1);

      intelligence.ingestCompanion(companionSample(1000));
      const full = intelligence.readLatest();
      expect(full.capabilities.activeMode).toBe('full');
      expect(full.capabilities.visualTracking).toBe(true);
      expect(full.pose.scale).toBe('metric');
      expect(full.pose.position).toEqual([1, 2, 3]);
      expect(workers[0]?.terminated).toBe(true);

      intelligence.ingestFrame(1100, image(1100), { ...intrinsics, timestamp: 1100 });
      expect(workers[1]?.requests).toHaveLength(1);
      expect(intelligence.readLatest().pose.position).toEqual([1, 2, 3]);

      intelligence.resetSession();
      const afterDisconnect = intelligence.readLatest();
      expect(afterDisconnect.capabilities.activeMode).toBe('camera');
      expect(afterDisconnect.pose.scale).toBe('relative');
      expect(afterDisconnect.capabilities.companion).toBe(false);
    } finally {
      intelligence.dispose();
    }
  });

  it('preserves the companion expiry reason while camera tracking reinitializes', async () => {
    const workers: FakeWorker[] = [];
    let now = 1000;
    const intelligence = new SpatialIntelligence({
      hardware: { camera: true, worker: true, orientation: true, gyro: true },
      workerFactory: () => {
        const worker = new FakeWorker();
        workers.push(worker);
        return worker;
      },
      now: () => now,
      companionTimeoutMs: 1200,
    });
    try {
      await intelligence.setMode('full');
      intelligence.ingestCompanion(companionSample(1000));
      now = 2201;
      expect(intelligence.readLatest().message).toContain('expired');

      let worker: FakeWorker | undefined;
      for (const timestamp of [1200, 1250]) {
        intelligence.ingestFrame(timestamp, image(timestamp), { ...intrinsics, timestamp });
        worker = workers.at(-1)!;
        const request = worker.requests.at(-1)!;
        worker.onmessage?.({
          data: {
            type: 'result', frameId: request.frameId, timestamp, width: request.width, height: request.height,
            features: [], motion: null,
          },
        } as unknown as MessageEvent<VioFrameResult>);
      }
      const fallback = intelligence.readLatest();
      expect(fallback.capabilities.activeMode).toBe('camera');
      expect(fallback.pose.scale).toBe('relative');
      expect(fallback.message).toContain('expired');

      intelligence.ingestCompanion(companionSample(1300));
      expect(intelligence.readLatest().capabilities.activeMode).toBe('full');
    } finally {
      intelligence.dispose();
    }
  });
});
