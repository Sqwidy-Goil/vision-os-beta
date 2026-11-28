import { describe, expect, it } from 'vitest';
import { applyPinchHysteresis, mapCameraLandmarkToViewport, pinchResizeRatio } from '../src/tracking/handMapping';

describe('mirrored cover camera mapping', () => {
  it('mirrors x without cropping when the aspect ratios match', () => {
    expect(mapCameraLandmarkToViewport(
      { x: 0.25, y: 0.75 },
      { width: 640, height: 480 },
      { width: 320, height: 240 },
    )).toEqual({ x: 240, y: 180 });
  });

  it('centers a horizontal cover crop in a portrait viewport', () => {
    const camera = { width: 1280, height: 720 };
    const viewport = { width: 390, height: 844 };
    const center = mapCameraLandmarkToViewport({ x: 0.5, y: 0.5 }, camera, viewport);
    const left = mapCameraLandmarkToViewport({ x: 0, y: 0 }, camera, viewport);
    const right = mapCameraLandmarkToViewport({ x: 1, y: 1 }, camera, viewport);

    expect(center).toEqual({ x: 195, y: 422 });
    expect(left?.x).toBeCloseTo(945.222222);
    expect(left?.y).toBe(0);
    expect(right?.x).toBeCloseTo(-555.222222);
    expect(right?.y).toBe(844);
  });

  it('centers a vertical cover crop in a landscape viewport', () => {
    const camera = { width: 1280, height: 720 };
    const viewport = { width: 844, height: 390 };
    const top = mapCameraLandmarkToViewport({ x: 0, y: 0 }, camera, viewport);
    const bottom = mapCameraLandmarkToViewport({ x: 1, y: 1 }, camera, viewport);

    expect(top?.x).toBe(844);
    expect(top?.y).toBeCloseTo(-42.375);
    expect(bottom?.x).toBe(0);
    expect(bottom?.y).toBeCloseTo(432.375);
  });

  it('crops a portrait camera horizontally without changing its center', () => {
    const camera = { width: 720, height: 1280 };
    const viewport = { width: 390, height: 844 };

    expect(mapCameraLandmarkToViewport({ x: 0.5, y: 0.5 }, camera, viewport)).toEqual({ x: 195, y: 422 });
    expect(mapCameraLandmarkToViewport({ x: 0, y: 0 }, camera, viewport)?.x).toBeCloseTo(432.375);
    expect(mapCameraLandmarkToViewport({ x: 1, y: 1 }, camera, viewport)?.x).toBeCloseTo(-42.375);
  });

  it('returns null for invalid source or viewport dimensions', () => {
    const valid = { width: 1280, height: 720 };
    const invalidSizes = [
      { width: 0, height: 720 },
      { width: 1280, height: 0 },
      { width: -1, height: 720 },
      { width: 1280, height: -1 },
      { width: Number.NaN, height: 720 },
      { width: 1280, height: Number.POSITIVE_INFINITY },
    ];

    for (const invalid of invalidSizes) {
      expect(mapCameraLandmarkToViewport({ x: 0.5, y: 0.5 }, invalid, valid)).toBeNull();
      expect(mapCameraLandmarkToViewport({ x: 0.5, y: 0.5 }, valid, invalid)).toBeNull();
    }
  });

  it('rejects non-finite landmarks and overflowing projections', () => {
    const camera = { width: 1280, height: 720 };
    const viewport = { width: 390, height: 844 };

    expect(mapCameraLandmarkToViewport({ x: Number.NaN, y: 0.5 }, camera, viewport)).toBeNull();
    expect(mapCameraLandmarkToViewport({ x: 0.5, y: Number.POSITIVE_INFINITY }, camera, viewport)).toBeNull();
    expect(mapCameraLandmarkToViewport(
      { x: 0.5, y: 0.5 },
      { width: Number.MAX_VALUE, height: 1 },
      { width: Number.MAX_VALUE, height: Number.MAX_VALUE },
    )).toBeNull();
  });

  it('leaves cropped source coordinates outside the viewport unclamped', () => {
    expect(mapCameraLandmarkToViewport(
      { x: 1.25, y: -0.2 },
      { width: 200, height: 100 },
      { width: 200, height: 100 },
    )).toEqual({ x: -50, y: -20 });
  });
});

describe('pinch hysteresis', () => {
  it('uses separate enter and release thresholds to avoid flicker', () => {
    expect(applyPinchHysteresis(0.1, false, 0.05, 0.09)).toBe(false);
    expect(applyPinchHysteresis(0.05, false, 0.05, 0.09)).toBe(true);
    expect(applyPinchHysteresis(0.07, true, 0.05, 0.09)).toBe(true);
    expect(applyPinchHysteresis(0.09, true, 0.05, 0.09)).toBe(false);
  });

  it('handles a complete pinch without dropping inside the hysteresis band', () => {
    const distances = [0.1, 0.04, 0.06, 0.08, 0.1];
    let pinching = false;
    const states = distances.map((distance) => {
      pinching = applyPinchHysteresis(distance, pinching, 0.05, 0.09);
      return pinching;
    });

    expect(states).toEqual([false, true, true, true, false]);
  });

  it('fails open for invalid distances or thresholds', () => {
    for (const distance of [null, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(applyPinchHysteresis(distance, true, 0.05, 0.09)).toBe(false);
    }
    expect(applyPinchHysteresis(0.04, false, 0.09, 0.05)).toBe(false);
    expect(applyPinchHysteresis(0.04, false, -0.05, 0.09)).toBe(false);
    expect(applyPinchHysteresis(0.04, false, 0.05, Number.NaN)).toBe(false);
  });
});

describe('pinch resize ratio', () => {
  it('scales from the starting pinch distance', () => {
    expect(pinchResizeRatio(150, 100, 0.5, 2)).toBe(1.5);
    expect(pinchResizeRatio(50, 100, 0.5, 2)).toBe(0.5);
    expect(pinchResizeRatio(100, 100, 0.5, 2)).toBe(1);
  });

  it('clamps growth and shrinkage to the caller range', () => {
    expect(pinchResizeRatio(400, 100, 0.5, 2)).toBe(2);
    expect(pinchResizeRatio(25, 100, 0.5, 2)).toBe(0.5);
    expect(pinchResizeRatio(150, 100, 0.75, 1.25)).toBe(1.25);
  });

  it('returns a neutral ratio for invalid measurements', () => {
    for (const distance of [null, 0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(pinchResizeRatio(distance, 100, 0.5, 2)).toBe(1);
      expect(pinchResizeRatio(100, distance, 0.5, 2)).toBe(1);
    }
  });

  it('returns a neutral ratio for invalid ranges', () => {
    expect(pinchResizeRatio(150, 100, 0, 2)).toBe(1);
    expect(pinchResizeRatio(150, 100, 2, 1)).toBe(1);
    expect(pinchResizeRatio(150, 100, Number.NaN, 2)).toBe(1);
    expect(pinchResizeRatio(150, 100, 0.5, Number.POSITIVE_INFINITY)).toBe(1);
  });
});
