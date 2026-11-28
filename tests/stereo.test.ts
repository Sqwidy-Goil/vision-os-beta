import { describe, expect, it } from 'vitest';
import { eyeCameraPositions, undoLensDistortion } from '../src/spatial/stereo';

describe('stereo eye cameras', () => {
  it('creates distinct symmetric camera positions from IPD', () => {
    const [left, right] = eyeCameraPositions(64);
    expect(left).toBeCloseTo(-0.032);
    expect(right).toBeCloseTo(0.032);
    expect(left).not.toBe(right);
  });

  it('handles invalid negative separation safely', () => {
    expect(eyeCameraPositions(-10)).toEqual([0, 0]);
  });

  it('inverts lens distortion for centered and off-center pointer rays', () => {
    for (const distortion of [0, 0.08, 0.3]) {
      for (const [u, v] of [[0.5, 0.5], [0.7, 0.35], [0.2, 0.8], [0.99, 0.99]]) {
        const px = u * 2 - 1;
        const py = v * 2 - 1;
        const radius = px * px + py * py;
        const scale = 1 + distortion * radius + distortion * 0.35 * radius * radius;
        const distorted = { u: (px * scale * 0.5) + 0.5, v: (py * scale * 0.5) + 0.5 };
        const corrected = undoLensDistortion(distorted.u, distorted.v, distortion);
        expect(corrected.u).toBeCloseTo(u, 4);
        expect(corrected.v).toBeCloseTo(v, 4);
      }
    }
  });
});
