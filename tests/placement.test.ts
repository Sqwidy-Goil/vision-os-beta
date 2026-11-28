import { describe, expect, it } from 'vitest';
import type { WindowPoseState } from '../src/types';
import type { EnvironmentObject, FreeSpaceCell, SpatialSurface } from '../src/spatial/intelligence/types';
import { avoidObservedObstacles } from '../src/spatial/placement';

const pose: WindowPoseState = {
  position: { x: 0, y: 1, z: -5 },
  quaternion: { x: 0, y: 0, z: 0, w: 1 },
  size: { width: 3, height: 2 },
};

function object(center: EnvironmentObject['center'], extents: EnvironmentObject['extents']): EnvironmentObject {
  return { id: 'object', center, extents, pointIds: [], confidence: 0.9, observedAt: 1, source: 'companion', scale: 'metric' };
}

describe('metric window placement', () => {
  it('moves a window away from an observed object without changing its orientation or size', () => {
    const placed = avoidObservedObstacles(pose, [object([0, 1, -5], [1, 1, 0.5])], [], []);
    expect(placed.position).not.toEqual(pose.position);
    expect(placed.quaternion).toEqual(pose.quaternion);
    expect(placed.size).toEqual(pose.size);
    expect(Math.hypot(placed.position.x, placed.position.y - 1, placed.position.z + 5)).toBeGreaterThan(1.8);
  });

  it('requires observed free space when free-space cells are available', () => {
    const freeSpace: FreeSpaceCell = {
      id: 'free', center: [2.2, 1, -5], extents: [2, 2, 2], confidence: 0.9,
      observedAt: 1, source: 'companion', scale: 'metric',
    };
    const placed = avoidObservedObstacles(pose, [], [], [freeSpace]);
    expect(placed.position.x).toBe(2.2);
    expect(placed.position.y).toBe(1);
    expect(placed.position.z).toBe(-5);
  });

  it('rejects metric planes and overlapping windows', () => {
    const plane: SpatialSurface = {
      id: 'wall', kind: 'plane', point: [0, 1, -5], normal: [0, 0, 1], confidence: 0.9,
      observedAt: 1, source: 'companion', scale: 'metric',
    };
    const placed = avoidObservedObstacles(pose, [], [plane], [], [{ position: { x: 0, y: 2.8, z: -5 }, size: pose.size }]);
    expect(placed.position).not.toEqual(pose.position);
    expect(Math.abs(placed.position.z + 5)).toBeGreaterThan(2);
  });

  it('ignores relative-scale obstacles instead of inventing metric clearance', () => {
    const relative = { ...object([0, 1, -5], [1, 1, 0.5]), scale: 'relative' as const };
    expect(avoidObservedObstacles(pose, [relative], [], [])).toBe(pose);
  });
});
