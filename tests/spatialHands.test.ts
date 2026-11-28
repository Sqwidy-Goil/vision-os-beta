import { describe, expect, it } from 'vitest';
import { Quaternion } from 'three';
import { SpatialHands } from '../src/spatial/spatialHands';
import type { HandVisualPoint } from '../src/types';

function hand(): HandVisualPoint[] {
  return Array.from({ length: 21 }, (_, index) => ({
    x: 0.35 + index * 0.006,
    y: 0.45 + index * 0.004,
    z: index === 8 ? -0.1 : 0,
    visibility: 1,
  }));
}

describe('stereo hand geometry', () => {
  it('builds one shared 3D hand model from tracked landmarks', () => {
    const hands = new SpatialHands();
    hands.update(
      { landmarks: hand(), arms: [], pinching: false },
      new Quaternion(),
      { width: 800, height: 600 },
      { width: 640, height: 480 },
      70,
    );
    expect(hands.group.visible).toBe(true);
    expect(hands.group.position.z).toBeCloseTo(-1.8);
    expect(hands.group.children).toHaveLength(4);
    hands.hide();
    expect(hands.group.visible).toBe(false);
    hands.destroy();
  });

  it('includes the second tracked hand for two-hand resize feedback', () => {
    const hands = new SpatialHands();
    hands.update(
      { landmarks: hand(), secondaryLandmarks: hand().map((point) => ({ ...point, x: point.x + 0.25 })), arms: [], pinching: true },
      new Quaternion(),
      { width: 800, height: 600 },
      { width: 640, height: 480 },
      70,
    );
    expect(hands.group.children).toHaveLength(4);
    hands.destroy();
  });
});
