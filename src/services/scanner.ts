import type { ScanPoint, ScanRecord } from '../types';

export interface Feature {
  x: number;
  y: number;
  strength: number;
}

export interface TrackedFeature extends Feature {
  dx: number;
  dy: number;
  error: number;
}

export interface ScanStats {
  features: number;
  tracked: number;
  points: number;
  motionX: number;
  motionY: number;
  lastCapture: number;
}

const EMPTY_STATS: ScanStats = { features: 0, tracked: 0, points: 0, motionX: 0, motionY: 0, lastCapture: 0 };

export function detectFeatures(gray: Float32Array, width: number, height: number, limit = 90): Feature[] {
  const features: Feature[] = [];
  const margin = 6;
  for (let y = margin; y < height - margin; y += 3) {
    for (let x = margin; x < width - margin; x += 3) {
      const index = y * width + x;
      const gx = gray[index + 1] - gray[index - 1];
      const gy = gray[index + width] - gray[index - width];
      const strength = Math.hypot(gx, gy);
      if (strength < 26) continue;
      if (strength < Math.abs(gray[index - width + 1] - gray[index - width - 1]) + Math.abs(gray[index - 1] - gray[index - width - 1])) continue;
      if (strength < Math.abs(gray[index + width + 1] - gray[index + width - 1]) + Math.abs(gray[index + 1] - gray[index + width - 1])) continue;
      if (features.some((feature) => Math.hypot(feature.x - x, feature.y - y) < 8)) continue;
      features.push({ x, y, strength });
      if (features.length >= limit) return features;
    }
  }
  return features;
}

function patchError(gray: Float32Array, previousGray: Float32Array, width: number, height: number, x: number, y: number, previousX: number, previousY: number): number {
  let error = 0;
  let samples = 0;
  for (let py = -2; py <= 2; py += 1) {
    for (let px = -2; px <= 2; px += 1) {
      const currentX = x + px;
      const currentY = y + py;
      const oldX = previousX + px;
      const oldY = previousY + py;
      if (currentX < 0 || currentX >= width || currentY < 0 || currentY >= height || oldX < 0 || oldX >= width || oldY < 0 || oldY >= height) continue;
      error += Math.abs(gray[currentY * width + currentX] - previousGray[oldY * width + oldX]);
      samples += 1;
    }
  }
  return samples ? error / samples : 255;
}

export function trackFeatures(gray: Float32Array, previousGray: Float32Array, width: number, height: number, previous: Feature[], searchRadius = 5): TrackedFeature[] {
  const tracked: TrackedFeature[] = [];
  for (const feature of previous) {
    let best: TrackedFeature | null = null;
    for (let y = Math.max(3, feature.y - searchRadius); y <= Math.min(height - 4, feature.y + searchRadius); y += 1) {
      for (let x = Math.max(3, feature.x - searchRadius); x <= Math.min(width - 4, feature.x + searchRadius); x += 1) {
        const error = patchError(gray, previousGray, width, height, x, y, feature.x, feature.y);
        if (!best || error < best.error) best = { x, y, dx: x - feature.x, dy: y - feature.y, strength: feature.strength, error };
      }
    }
    if (best && best.error < 34) tracked.push(best);
  }
  return tracked;
}

export class SpatialScanner {
  private readonly canvas = document.createElement('canvas');
  private readonly context: CanvasRenderingContext2D;
  private gray = new Float32Array();
  private previousGray = new Float32Array();
  private previousFeatures: Feature[] = [];
  private points: ScanPoint[] = [];
  private lastCapture = 0;
  private width = 0;
  private height = 0;

  scanning = false;

  constructor() {
    this.canvas.width = 256;
    this.canvas.height = 144;
    const context = this.canvas.getContext('2d', { willReadFrequently: true, alpha: false });
    if (!context) throw new Error('Scanner canvas is unavailable.');
    this.context = context;
  }

  start(): void {
    this.points = [];
    this.previousFeatures = [];
    this.previousGray = new Float32Array();
    this.scanning = true;
    this.lastCapture = 0;
  }

  stop(): void {
    this.scanning = false;
    this.previousFeatures = [];
  }

  reset(): void {
    this.stop();
    this.points = [];
  }

  capture(video: HTMLVideoElement): ScanStats {
    if (!this.scanning || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return { ...EMPTY_STATS, points: this.points.length };
    const now = performance.now();
    if (now - this.lastCapture < 140) return { ...EMPTY_STATS, points: this.points.length };
    this.lastCapture = now;
    this.context.drawImage(video, 0, 0, this.canvas.width, this.canvas.height);
    const pixels = this.context.getImageData(0, 0, this.canvas.width, this.canvas.height).data;
    this.width = this.canvas.width;
    this.height = this.canvas.height;
    if (this.gray.length !== this.width * this.height) this.gray = new Float32Array(this.width * this.height);
    for (let index = 0; index < this.gray.length; index += 1) {
      const offset = index * 4;
      this.gray[index] = pixels[offset] * 0.2126 + pixels[offset + 1] * 0.7152 + pixels[offset + 2] * 0.0722;
    }
    const features = detectFeatures(this.gray, this.width, this.height);
    const tracked = this.previousGray.length === this.gray.length ? trackFeatures(this.gray, this.previousGray, this.width, this.height, this.previousFeatures) : [];
    let motionX = 0;
    let motionY = 0;
    for (const feature of tracked) {
      motionX += feature.dx;
      motionY += feature.dy;
      const depthEstimate = 2.2 + (feature.y / this.height) * 4.8 + Math.min(2.5, Math.abs(feature.dx) * 0.12);
      this.points.push({
        x: (feature.x / this.width - 0.5) * 5.2,
        y: (0.5 - feature.y / this.height) * 3.1,
        z: -depthEstimate,
        intensity: Math.min(1, feature.strength / 120),
      });
    }
    if (this.points.length > 7000) this.points.splice(0, this.points.length - 7000);
    this.previousGray = this.gray.slice();
    this.previousFeatures = features;
    const divisor = Math.max(1, tracked.length);
    return {
      features: features.length,
      tracked: tracked.length,
      points: this.points.length,
      motionX: motionX / divisor,
      motionY: motionY / divisor,
      lastCapture: now,
    };
  }

  finish(name: string): ScanRecord {
    this.stop();
    return {
      id: crypto.randomUUID(),
      name: name.trim() || `Scan ${new Date().toLocaleString()}`,
      createdAt: Date.now(),
      pointCount: this.points.length,
      points: this.points.map((point) => ({ ...point })),
      method: 'feature-tracked-rgb-estimate',
    };
  }

  get pointCount(): number {
    return this.points.length;
  }
}
