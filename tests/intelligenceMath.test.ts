import { describe, expect, it } from 'vitest';
import type { CameraIntrinsics, PoseSample, QuaternionTuple, Vec3Tuple } from '../src/spatial/intelligence/types';
import type { VioTrackedFeature } from '../src/spatial/intelligence/workers/vio.worker';
import { buildGrayPyramid, VioTracker } from '../src/spatial/intelligence/workers/vio.worker';
import { estimateRelativeMotion } from '../src/spatial/intelligence/visualInertialTracker';
import {
  PoseFusion,
  integrateQuaternion,
  multiplyQuaternions,
  quaternionAngle,
  quaternionFromAxisAngle,
  rotateVector,
} from '../src/spatial/intelligence/poseFusion';

function expectPositiveSemidefinite(matrix: number[], size: number): void {
  const lower = Array.from({ length: size * size }, () => 0);
  for (let row = 0; row < size; row += 1) {
    for (let column = 0; column <= row; column += 1) {
      let residual = matrix[row * size + column];
      for (let inner = 0; inner < column; inner += 1) residual -= lower[row * size + inner] * lower[column * size + inner];
      if (row === column) {
        expect(residual).toBeGreaterThan(-1e-7);
        lower[row * size + row] = Math.sqrt(Math.max(0, residual));
      } else {
        lower[row * size + column] = residual / Math.max(1e-10, lower[column * size + column]);
      }
    }
  }
}

function texture(width: number, height: number): Uint8ClampedArray {
  const pixels = new Uint8ClampedArray(width * height * 4);
  let state = 0x12345678;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      const value = state >>> 24;
      const offset = (y * width + x) * 4;
      pixels[offset] = value;
      pixels[offset + 1] = value;
      pixels[offset + 2] = value;
      pixels[offset + 3] = 255;
    }
  }
  return pixels;
}

function shifted(source: Uint8ClampedArray, width: number, height: number, dx: number, dy: number): Uint8ClampedArray {
  const pixels = new Uint8ClampedArray(source.length);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const sourceX = x - dx;
      const sourceY = y - dy;
      const offset = (y * width + x) * 4;
      if (sourceX >= 0 && sourceX < width && sourceY >= 0 && sourceY < height) {
        const input = (sourceY * width + sourceX) * 4;
        pixels[offset] = source[input];
        pixels[offset + 1] = source[input + 1];
        pixels[offset + 2] = source[input + 2];
      } else {
        pixels[offset] = 128;
        pixels[offset + 1] = 128;
        pixels[offset + 2] = 128;
      }
      pixels[offset + 3] = 255;
    }
  }
  return pixels;
}

function projectedFeatures(translation: Vec3Tuple, angle: number, noise: number): VioTrackedFeature[] {
  const intrinsics: CameraIntrinsics = {
    width: 320,
    height: 240,
    fx: 280,
    fy: 280,
    cx: 160,
    cy: 120,
    timestamp: 1000,
    calibration: 'estimated',
  };
  const rotation = quaternionFromAxisAngle([0, 1, 0], angle);
  const features: VioTrackedFeature[] = [];
  let id = 0;
  let state = 7;
  const random = (): number => {
    state = (Math.imul(state, 1103515245) + 12345) >>> 0;
    return state / 0x1_0000_0000 - 0.5;
  };
  for (let row = 0; row < 6; row += 1) {
    for (let column = 0; column < 10; column += 1) {
      const point: Vec3Tuple = [-1.2 + column * 0.27 + row * 0.025, -0.8 + row * 0.31, 3.2 + (column % 3) * 0.7 + row * 0.12];
      const moved = rotateVector(rotation, point);
      const secondPoint: Vec3Tuple = [moved[0] + translation[0], moved[1] + translation[1], moved[2] + translation[2]];
      const firstX = intrinsics.cx + point[0] * intrinsics.fx / point[2] + random() * noise;
      const firstY = intrinsics.cy + point[1] * intrinsics.fy / point[2] + random() * noise;
      const secondX = intrinsics.cx + secondPoint[0] * intrinsics.fx / secondPoint[2] + random() * noise;
      const secondY = intrinsics.cy + secondPoint[1] * intrinsics.fy / secondPoint[2] + random() * noise;
      features.push({ id: id++, x: secondX, y: secondY, previousX: firstX, previousY: firstY, error: 0.03, strength: 100 });
    }
  }
  for (let index = 0; index < 20; index += 1) {
    const previousX = 20 + random() * 280;
    const previousY = 20 + random() * 200;
    features.push({ id: id++, x: 20 + random() * 280, y: 20 + random() * 200, previousX, previousY, error: 0.04, strength: 100 });
  }
  return features;
}

const intrinsics: CameraIntrinsics = {
  width: 320,
  height: 240,
  fx: 280,
  fy: 280,
  cx: 160,
  cy: 120,
  timestamp: 1000,
  calibration: 'estimated',
};

function pose(timestamp: number, position: Vec3Tuple, velocity: Vec3Tuple = [0, 0, 0]): PoseSample {
  const covariance = new Array<number>(36).fill(0);
  covariance[0] = covariance[7] = covariance[14] = 0.01;
  covariance[21] = covariance[28] = covariance[35] = 0.01;
  return {
    frameId: 1,
    timestamp,
    position,
    quaternion: [0, 0, 0, 1],
    velocity,
    covariance,
    confidence: 0.9,
    scale: 'metric',
    source: 'companion',
  };
}

describe('pose fusion', () => {
  it('rotates vectors with the quaternion convention used by camera points', () => {
    const quarterTurn = quaternionFromAxisAngle([0, 0, 1], Math.PI / 2);
    const rotated = rotateVector(quarterTurn, [1, 0, 0]);
    expect(rotated[0]).toBeCloseTo(0, 8);
    expect(rotated[1]).toBeCloseTo(1, 8);
    expect(rotated[2]).toBeCloseTo(0, 8);
    expect(quaternionAngle(integrateQuaternion([0, 0, 0, 1], [0, 0, 2], 0.25), quaternionFromAxisAngle([0, 0, 1], 0.5))).toBeLessThan(1e-6);
  });

  it('integrates milliseconds as seconds and emits normalized symmetric covariance', () => {
    const fusion = new PoseFusion();
    fusion.ingestMotion({ timestamp: 1000, quaternion: [0, 0, 0, 1], gyro: [0, 0, 1] });
    fusion.predictTo(1050);
    expect(Math.hypot(...fusion.orientation)).toBeCloseTo(1, 10);
    expect(quaternionAngle(fusion.orientation, quaternionFromAxisAngle([0, 0, 1], 0.05))).toBeLessThan(1e-6);
    fusion.ingestMotion({ timestamp: 1100, quaternion: [0, 0, 0, 1] });
    expect(quaternionAngle(fusion.orientation, [0, 0, 0, 1])).toBeLessThan(0.05);
    const sample = fusion.samplePose(2, 1100, 'gyro', 'relative');
    expect(sample.timestamp).toBe(1100);
    expect(sample.covariance).toHaveLength(36);
    for (let row = 0; row < 6; row += 1) {
      for (let column = 0; column < 6; column += 1) {
        expect(sample.covariance[row * 6 + column]).toBeCloseTo(sample.covariance[column * 6 + row], 10);
        expect(Number.isFinite(sample.covariance[row * 6 + column])).toBe(true);
      }
      expect(sample.covariance[row * 6 + row]).toBeGreaterThan(0);
    }
    expectPositiveSemidefinite(sample.covariance, 6);
  });

  it('rejects duplicate, stale, implausible gyro, and orientation outlier samples', () => {
    const fusion = new PoseFusion();
    fusion.ingestMotion({ timestamp: 1000, quaternion: [0, 0, 0, 1] });
    expect(fusion.ingestMotion({ timestamp: 1000, quaternion: [0, 0, 0, 1] }).accepted).toBe(false);
    expect(fusion.ingestMotion({ timestamp: 900, quaternion: [0, 0, 0, 1] }).accepted).toBe(false);
    expect(fusion.ingestMotion({ timestamp: 1010, quaternion: [0, 0, 0, 1], gyro: [100, 0, 0] }).accepted).toBe(false);
    const outlier = fusion.ingestMotion({
      timestamp: 1020,
      quaternion: quaternionFromAxisAngle([0, 0, 1], 2.5),
    });
    expect(outlier.accepted).toBe(false);
    expect(outlier.reason).toContain('outlier');
    expect(quaternionAngle(fusion.orientation, [0, 0, 0, 1])).toBeLessThan(1e-8);
    expect(fusion.confidence).toBeLessThan(0.65);
  });

  it('reads position and orientation covariance from the correct 6x6 blocks', () => {
    const fusion = new PoseFusion();
    const sample = pose(1000, [1, 2, 3]);
    sample.covariance[0] = 0.25;
    sample.covariance[21] = 4;
    fusion.resetToPose(sample);
    expect(fusion.translationCovariance[0]).toBeCloseTo(0.25, 10);
    expect(fusion.orientationCovariance[0]).toBeCloseTo(4, 10);
    expect(fusion.translation).toEqual([1, 2, 3]);
  });

  it('predicts companion translation before fusing a metric pose', () => {
    const fusion = new PoseFusion();
    fusion.resetToPose(pose(1000, [0, 0, 0], [1, 0, 0]));
    const next = pose(1100, [0.1, 0, 0]);
    const result = fusion.fuseCompanionPose(next);
    expect(result.accepted, result.reason).toBe(true);
    expect(fusion.translation[0]).toBeCloseTo(0.1, 3);
    expect(fusion.translationCovariance[0]).toBeLessThan(0.02);
  });
});

describe('sparse grayscale worker tracking', () => {
  it('tracks a known image shift through the pyramid while preserving feature IDs', () => {
    const width = 160;
    const height = 120;
    const tracker = new VioTracker();
    const first = texture(width, height);
    const second = shifted(first, width, height, 3, 2);
    expect(tracker.process(first, width, height, 80)).toEqual([]);
    const tracks = tracker.process(second, width, height, 80);
    expect(tracks.length).toBeGreaterThan(20);
    const ids = new Set(tracks.map((track) => track.id));
    expect(ids.size).toBe(tracks.length);
    for (const track of tracks) {
      expect(track.x - track.previousX).toBeGreaterThan(2.2);
      expect(track.x - track.previousX).toBeLessThan(3.8);
      expect(track.y - track.previousY).toBeGreaterThan(1.2);
      expect(track.y - track.previousY).toBeLessThan(2.8);
      expect(track.error).toBeLessThanOrEqual(0.22);
    }
    const third = tracker.process(shifted(second, width, height, 2, 0), width, height, 80);
    const persistent = third.filter((track) => ids.has(track.id));
    expect(persistent.length).toBeGreaterThan(10);
    expect(persistent.every((track) => Math.abs(track.x - track.previousX - 2) < 0.8)).toBe(true);
  });

  it('rejects an occluded or textureless frame instead of inventing tracks', () => {
    const tracker = new VioTracker();
    const width = 96;
    const height = 80;
    tracker.process(texture(width, height), width, height, 60);
    const blank = new Uint8ClampedArray(width * height * 4);
    for (let index = 0; index < blank.length; index += 4) {
      blank[index] = blank[index + 1] = blank[index + 2] = 128;
      blank[index + 3] = 255;
    }
    expect(tracker.process(blank, width, height, 60)).toEqual([]);
  });

  it('rejects malformed pyramid buffers', () => {
    expect(() => buildGrayPyramid(new Uint8ClampedArray(4), 2, 2)).toThrow(/Invalid/);
  });
});

describe('essential motion estimation', () => {
  it('recovers known rotation and translation direction despite outliers', () => {
    const translation: Vec3Tuple = [-0.12, 0.01, 0.02];
    const expectedRotation = quaternionFromAxisAngle([0, 1, 0], 0.08);
    const estimate = estimateRelativeMotion(projectedFeatures(translation, 0.08, 0.04), intrinsics, 1100, expectedRotation);
    expect(estimate).not.toBeNull();
    if (!estimate) return;
    expect(quaternionAngle(estimate.rotation, expectedRotation)).toBeLessThan(0.035);
    const expectedDirection = translation.map((value) => value / Math.hypot(...translation)) as Vec3Tuple;
    const direction = estimate.translation.reduce((sum, value, index) => sum + value * expectedDirection[index], 0);
    expect(direction).toBeGreaterThan(0.99);
    expect(estimate.inliers).toBeGreaterThanOrEqual(45);
    expect(estimate.points.length).toBeGreaterThanOrEqual(20);
    expect(estimate.points.every((point) => point.position.every(Number.isFinite) && point.position[2] > 0 && point.scale === 'relative')).toBe(true);
  });

  it('does not infer parallax from pure rotation or too few features', () => {
    expect(estimateRelativeMotion(projectedFeatures([0, 0, 0], 0.08, 0), intrinsics, 1100)).toBeNull();
    expect(estimateRelativeMotion(projectedFeatures([-0.1, 0, 0], 0.08, 0).slice(0, 7), intrinsics, 1100)).toBeNull();
  });

  it('keeps quaternion composition consistent with vector rotation', () => {
    const first = quaternionFromAxisAngle([1, 0, 0], 0.3);
    const second = quaternionFromAxisAngle([0, 0, 1], -0.4);
    const combined: QuaternionTuple = multiplyQuaternions(second, first);
    const sequential = rotateVector(second, rotateVector(first, [0.4, -0.2, 0.7]));
    const direct = rotateVector(combined, [0.4, -0.2, 0.7]);
    expect(direct[0]).toBeCloseTo(sequential[0], 10);
    expect(direct[1]).toBeCloseTo(sequential[1], 10);
    expect(direct[2]).toBeCloseTo(sequential[2], 10);
  });
});
