import { describe, expect, it } from 'vitest';
import { detectFeatures, trackFeatures } from '../src/services/scanner';

describe('RGB feature scanner', () => {
  it('detects image features without inventing depth', () => {
    const width = 64;
    const height = 48;
    const gray = new Float32Array(width * height);
    for (let y = 8; y < 40; y += 8) {
      for (let x = 8; x < 56; x += 8) {
        gray[y * width + x] = 255;
      }
    }
    const features = detectFeatures(gray, width, height);
    expect(features.length).toBeGreaterThan(0);
    expect(features.every((feature) => feature.x >= 6 && feature.x < width - 6)).toBe(true);
  });

  it('tracks a shifted patch and rejects unrelated noise', () => {
    const width = 40;
    const height = 40;
    const previous = new Float32Array(width * height);
    const current = new Float32Array(width * height);
    for (let y = 14; y <= 18; y += 1) {
      for (let x = 14; x <= 18; x += 1) {
        previous[y * width + x] = 180;
        current[(y + 2) * width + x + 2] = 180;
      }
    }
    const tracked = trackFeatures(current, previous, width, height, [{ x: 16, y: 16, strength: 100 }], 4);
    expect(tracked).toHaveLength(1);
    expect(tracked[0].x).toBe(18);
    expect(tracked[0].y).toBe(18);
  });
});
