import type { CameraIntrinsics, QuaternionTuple } from '../types';
import { validateCameraIntrinsics } from '../environmentModel';
import { isValidQuaternion } from '../poseFusion';
import { estimateRelativeMotion, type RelativeMotionEstimate } from '../visualMotion';

export interface VioFrameRequest {
  type: 'frame';
  frameId: number;
  timestamp: number;
  width: number;
  height: number;
  pixels: ArrayBuffer;
  intrinsics: CameraIntrinsics;
  rotationPrior?: QuaternionTuple;
  reset?: boolean;
  maxFeatures?: number;
}

export interface VioTrackedFeature {
  id: number;
  x: number;
  y: number;
  previousX: number;
  previousY: number;
  error: number;
  strength: number;
}

export interface VioFrameResult {
  type: 'result';
  frameId: number;
  timestamp: number;
  width: number;
  height: number;
  features: VioTrackedFeature[];
  motion: RelativeMotionEstimate | null;
}

export interface VioErrorResult {
  type: 'error';
  frameId?: number;
  timestamp?: number;
  message: string;
}

export type VioResponse = VioFrameResult | VioErrorResult;

interface GrayPyramid {
  width: number;
  height: number;
  levels: Uint8ClampedArray[];
}

interface Feature {
  id: number;
  x: number;
  y: number;
  strength: number;
}

interface TrackResult {
  x: number;
  y: number;
  error: number;
}

const PATCH_RADIUS = 4;
const PYRAMID_LEVELS = 3;

function sample(image: Uint8ClampedArray, width: number, height: number, x: number, y: number): number {
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < -1 || y < -1 || x > width || y > height) return 0;
  const clampedX = Math.max(0, Math.min(width - 1, x));
  const clampedY = Math.max(0, Math.min(height - 1, y));
  const x0 = Math.floor(clampedX);
  const y0 = Math.floor(clampedY);
  const x1 = Math.min(width - 1, x0 + 1);
  const y1 = Math.min(height - 1, y0 + 1);
  const fx = clampedX - x0;
  const fy = clampedY - y0;
  const top = image[y0 * width + x0] * (1 - fx) + image[y0 * width + x1] * fx;
  const bottom = image[y1 * width + x0] * (1 - fx) + image[y1 * width + x1] * fx;
  return top * (1 - fy) + bottom * fy;
}

export function buildGrayPyramid(pixels: Uint8ClampedArray, width: number, height: number): GrayPyramid {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || pixels.length !== width * height * 4) {
    throw new Error('Invalid grayscale pyramid input.');
  }
  const gray = new Uint8ClampedArray(width * height);
  for (let index = 0; index < gray.length; index += 1) {
    const offset = index * 4;
    gray[index] = Math.round(pixels[offset] * 0.2126 + pixels[offset + 1] * 0.7152 + pixels[offset + 2] * 0.0722);
  }
  const levels = [gray];
  let currentWidth = width;
  let currentHeight = height;
  for (let level = 1; level < PYRAMID_LEVELS && currentWidth >= 16 && currentHeight >= 16; level += 1) {
    const nextWidth = Math.max(1, Math.floor(currentWidth / 2));
    const nextHeight = Math.max(1, Math.floor(currentHeight / 2));
    const next = new Uint8ClampedArray(nextWidth * nextHeight);
    const previous = levels[levels.length - 1];
    for (let y = 0; y < nextHeight; y += 1) {
      for (let x = 0; x < nextWidth; x += 1) {
        let sum = 0;
        let count = 0;
        for (let oy = 0; oy < 2; oy += 1) {
          for (let ox = 0; ox < 2; ox += 1) {
            const sx = x * 2 + ox;
            const sy = y * 2 + oy;
            if (sx < currentWidth && sy < currentHeight) {
              sum += previous[sy * currentWidth + sx];
              count += 1;
            }
          }
        }
        next[y * nextWidth + x] = Math.round(sum / Math.max(1, count));
      }
    }
    levels.push(next);
    currentWidth = nextWidth;
    currentHeight = nextHeight;
  }
  return { width, height, levels };
}

export function detectGrayFeatures(pyramid: GrayPyramid, limit: number, excluded: Feature[] = []): Feature[] {
  limit = Number.isFinite(limit) ? Math.max(1, Math.min(240, Math.floor(limit))) : 120;
  const image = pyramid.levels[0];
  const { width, height } = pyramid;
  const margin = PATCH_RADIUS + 3;
  const step = Math.max(3, Math.floor(Math.min(width, height) / 48));
  const candidates: Feature[] = [];
  for (let y = margin; y < height - margin; y += step) {
    for (let x = margin; x < width - margin; x += step) {
      const gx = image[y * width + x + 1] - image[y * width + x - 1];
      const gy = image[(y + 1) * width + x] - image[(y - 1) * width + x];
      let xx = 0;
      let xy = 0;
      let yy = 0;
      for (let oy = -1; oy <= 1; oy += 1) {
        for (let ox = -1; ox <= 1; ox += 1) {
          const dx = image[(y + oy) * width + x + ox + 1] - image[(y + oy) * width + x + ox - 1];
          const dy = image[(y + oy + 1) * width + x + ox] - image[(y + oy - 1) * width + x + ox];
          xx += dx * dx;
          xy += dx * dy;
          yy += dy * dy;
        }
      }
      const strength = (xx + yy - Math.sqrt((xx - yy) ** 2 + 4 * xy * xy)) / 2;
      if (strength < 60 || (Math.abs(gx) + Math.abs(gy) < 12)) continue;
      candidates.push({ id: -1, x, y, strength });
    }
  }
  candidates.sort((a, b) => b.strength - a.strength);
  const accepted: Feature[] = [];
  const minDistance = Math.max(6, step);
  for (const candidate of candidates) {
    if (accepted.some((feature) => Math.hypot(feature.x - candidate.x, feature.y - candidate.y) < minDistance)) continue;
    if (excluded.some((feature) => Math.hypot(feature.x - candidate.x, feature.y - candidate.y) < minDistance)) continue;
    accepted.push(candidate);
    if (accepted.length >= limit) break;
  }
  return accepted;
}

function trackLevel(
  previous: Uint8ClampedArray,
  current: Uint8ClampedArray,
  width: number,
  height: number,
  startX: number,
  startY: number,
  initialX: number,
  initialY: number,
): TrackResult | null {
  if (startX < PATCH_RADIUS + 1 || startY < PATCH_RADIUS + 1 || startX >= width - PATCH_RADIUS - 1 || startY >= height - PATCH_RADIUS - 1) return null;
  let dx = initialX;
  let dy = initialY;
  for (let iteration = 0; iteration < 15; iteration += 1) {
    let xx = 0;
    let xy = 0;
    let yy = 0;
    let xt = 0;
    let yt = 0;
    for (let oy = -PATCH_RADIUS; oy <= PATCH_RADIUS; oy += 1) {
      for (let ox = -PATCH_RADIUS; ox <= PATCH_RADIUS; ox += 1) {
        const px = startX + ox;
        const py = startY + oy;
        const gx = sample(previous, width, height, px + 1, py) - sample(previous, width, height, px - 1, py);
        const gy = sample(previous, width, height, px, py + 1) - sample(previous, width, height, px, py - 1);
        const difference = sample(current, width, height, px + dx, py + dy) - sample(previous, width, height, px, py);
        xx += gx * gx;
        xy += gx * gy;
        yy += gy * gy;
        xt -= gx * difference;
        yt -= gy * difference;
      }
    }
    const determinant = xx * yy - xy * xy;
    if (!Number.isFinite(determinant) || determinant < 1e-3 || xx < 1e-3) return null;
    const stepX = Math.max(-2, Math.min(2, (yy * xt - xy * yt) / determinant));
    const stepY = Math.max(-2, Math.min(2, (xx * yt - xy * xt) / determinant));
    dx += stepX;
    dy += stepY;
    if (Math.hypot(stepX, stepY) < 0.01) break;
  }
  const x = startX + dx;
  const y = startY + dy;
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < 1 || y < 1 || x >= width - 1 || y >= height - 1) return null;
  let error = 0;
  let count = 0;
  for (let oy = -PATCH_RADIUS; oy <= PATCH_RADIUS; oy += 1) {
    for (let ox = -PATCH_RADIUS; ox <= PATCH_RADIUS; ox += 1) {
      error += Math.abs(sample(current, width, height, x + ox, y + oy) - sample(previous, width, height, startX + ox, startY + oy));
      count += 1;
    }
  }
  return { x, y, error: error / count };
}

function trackPyramid(previous: GrayPyramid, current: GrayPyramid, feature: Feature): TrackResult | null {
  let dx = 0;
  let dy = 0;
  const levelCount = Math.min(previous.levels.length, current.levels.length);
  for (let level = levelCount - 1; level >= 0; level -= 1) {
    const scale = 2 ** level;
    const width = Math.max(1, Math.floor(previous.width / scale));
    const height = Math.max(1, Math.floor(previous.height / scale));
    if (level < levelCount - 1) {
      dx *= 2;
      dy *= 2;
    }
    const tracked = trackLevel(previous.levels[level], current.levels[level], width, height, feature.x / scale, feature.y / scale, dx, dy);
    if (!tracked) return null;
    dx = tracked.x - feature.x / scale;
    dy = tracked.y - feature.y / scale;
  }
  if (dx * dx + dy * dy > (Math.min(previous.width, previous.height) * 0.3) ** 2) return null;
  const forward = trackLevel(previous.levels[0], current.levels[0], previous.width, previous.height, feature.x, feature.y, dx, dy);
  if (!forward || Math.hypot(forward.x - feature.x - dx, forward.y - feature.y - dy) > 0.01) return null;
  const backward = trackLevel(current.levels[0], previous.levels[0], current.width, current.height, forward.x, forward.y, -dx, -dy);
  if (!backward || Math.hypot(backward.x - feature.x, backward.y - feature.y) > 0.8) return null;
  return { x: forward.x, y: forward.y, error: Math.max(forward.error, backward.error) / 255 };
}

export class VioTracker {
  private previous: GrayPyramid | null = null;
  private features: Feature[] = [];
  private nextId = 1;
  private frameCount = 0;

  reset(): void {
    this.previous = null;
    this.features = [];
    this.nextId = 1;
    this.frameCount = 0;
  }

  process(pixels: Uint8ClampedArray, width: number, height: number, maxFeatures = 120): VioTrackedFeature[] {
    maxFeatures = Number.isFinite(maxFeatures) ? Math.max(8, Math.min(240, Math.floor(maxFeatures))) : 120;
    const current = buildGrayPyramid(pixels, width, height);
    this.frameCount += 1;
    if (!this.previous || this.previous.width !== width || this.previous.height !== height) {
      this.features = detectGrayFeatures(current, maxFeatures);
      for (const feature of this.features) feature.id = this.nextId++;
      this.previous = current;
      return [];
    }

    const tracked: VioTrackedFeature[] = [];
    const survivors: Feature[] = [];
    for (const feature of this.features) {
      const result = trackPyramid(this.previous, current, feature);
      if (!result || result.error > 0.22) continue;
      tracked.push({
        id: feature.id,
        x: result.x,
        y: result.y,
        previousX: feature.x,
        previousY: feature.y,
        error: result.error,
        strength: feature.strength,
      });
      survivors.push({ ...feature, x: result.x, y: result.y });
    }

    if (survivors.length < maxFeatures && (this.frameCount % 3 === 0 || survivors.length < 8)) {
      const additions = detectGrayFeatures(current, maxFeatures - survivors.length, survivors);
      for (const feature of additions) {
        feature.id = this.nextId++;
        survivors.push(feature);
      }
    }
    this.features = survivors.slice(0, maxFeatures);
    this.previous = current;
    return tracked;
  }
}

export function processVioRequest(request: VioFrameRequest, tracker: VioTracker): VioResponse {
  try {
    if (!request || request.type !== 'frame') throw new Error('Unsupported VIO worker request.');
    if (!Number.isInteger(request.frameId) || request.frameId < 0 || !Number.isFinite(request.timestamp) || request.timestamp < 0) throw new Error('Invalid frame metadata.');
    if (!Number.isInteger(request.width) || !Number.isInteger(request.height) || request.width < 16 || request.height < 16 || request.width > 1280 || request.height > 720) throw new Error('Invalid frame dimensions.');
    if (!validateCameraIntrinsics(request.intrinsics, request.width, request.height)) throw new Error('Invalid camera intrinsics.');
    if (request.rotationPrior !== undefined && !isValidQuaternion(request.rotationPrior)) throw new Error('Invalid rotation prior.');
    const pixels = request.pixels instanceof ArrayBuffer ? new Uint8ClampedArray(request.pixels) : null;
    if (!pixels || pixels.length !== request.width * request.height * 4) throw new Error('Malformed RGBA frame.');
    if (request.reset) tracker.reset();
    const features = tracker.process(pixels, request.width, request.height, Math.max(8, Math.min(240, request.maxFeatures ?? 120)));
    const motion = estimateRelativeMotion(features, request.intrinsics, request.timestamp, request.rotationPrior);
    return { type: 'result', frameId: request.frameId, timestamp: request.timestamp, width: request.width, height: request.height, features, motion };
  } catch (error) {
    return {
      type: 'error',
      frameId: request?.frameId,
      timestamp: request?.timestamp,
      message: error instanceof Error ? error.message : 'VIO worker failed.',
    };
  }
}

const tracker = new VioTracker();
const workerScope = globalThis as unknown as {
  onmessage: ((event: MessageEvent<VioFrameRequest>) => void) | null;
  postMessage: (message: VioResponse) => void;
};

if (typeof self !== 'undefined' && typeof workerScope.postMessage === 'function' && !('document' in self)) {
  workerScope.onmessage = (event: MessageEvent<VioFrameRequest>): void => {
    workerScope.postMessage(processVioRequest(event.data, tracker));
  };
}
