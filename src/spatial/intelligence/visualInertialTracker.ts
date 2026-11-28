import type {
  CameraIntrinsics,
  MotionSample,
  QuaternionTuple,
  SpatialPoint,
  TrackingState,
  Vec3Tuple,
} from './types';
import type { VioErrorResult, VioFrameRequest, VioFrameResult } from './workers/vio.worker';
import {
  clamp,
  conjugateQuaternion,
  multiplyQuaternions,
  PoseFusion,
  isValidQuaternion,
  rotateVector,
} from './poseFusion';
import { estimateCameraIntrinsics, validateCameraIntrinsics } from './environmentModel';

export { estimateRelativeMotion } from './visualMotion';
export type { RelativeMotionEstimate } from './visualMotion';

export interface TrackerUpdate {
  frameId: number;
  timestamp: number;
  trackingState: TrackingState;
  fusion: PoseFusion;
  points: SpatialPoint[];
  message?: string;
}

export interface VisualInertialTrackerOptions {
  fusion?: PoseFusion;
  hasGyro?: boolean;
  workerFactory?: () => VioWorkerLike;
  workerTimeoutMs?: number;
  minFrameIntervalMs?: number;
  maxVisualLatencyMs?: number;
  onUpdate: (update: TrackerUpdate) => void;
  onFailure: (message: string) => void;
}

export interface VioWorkerLike {
  onmessage: ((event: MessageEvent<VioFrameResult | VioErrorResult>) => void) | null;
  onerror: ((event: Event) => void) | null;
  postMessage: (request: VioFrameRequest, transfer?: Transferable[]) => void;
  terminate: () => void;
}

function validVector(value: unknown): value is Vec3Tuple {
  return Array.isArray(value) && value.length === 3 && value.every(Number.isFinite);
}

function validMotionEstimate(result: VioFrameResult): boolean {
  const motion = result.motion;
  if (!motion || !isValidQuaternion(motion.rotation) || !validVector(motion.translation)) return false;
  if (!Number.isFinite(motion.confidence) || motion.confidence < 0 || motion.confidence > 1) return false;
  if (!Number.isInteger(motion.inliers) || motion.inliers < 8 || motion.inliers > result.features.length || !Array.isArray(motion.points) || motion.points.length > 240) return false;
  const featureIds = new Set(result.features.map((feature) => feature.id));
  const pointIds = new Set<number>();
  return motion.points.every((point) => (
    point && Number.isInteger(point.id) && featureIds.has(point.id) && !pointIds.has(point.id) &&
    validVector(point.position) && Number.isFinite(point.confidence) && point.confidence >= 0 && point.confidence <= 1 &&
    point.observedAt === result.timestamp && point.source === 'visual' && point.scale === 'relative' &&
    (pointIds.add(point.id), true)
  ));
}

function validWorkerResult(result: VioFrameResult, request: VioFrameRequest): result is VioFrameResult {
  if (result.type !== 'result' || result.frameId !== request.frameId || result.timestamp !== request.timestamp || result.width !== request.width || result.height !== request.height) return false;
  if (!Array.isArray(result.features) || result.features.length > 480 || (result.motion !== null && !validMotionEstimate(result))) return false;
  const ids = new Set<number>();
  for (const feature of result.features) {
    if (
      !feature || !Number.isInteger(feature.id) || feature.id < 0 || ids.has(feature.id) ||
      ![feature.x, feature.y, feature.previousX, feature.previousY, feature.error, feature.strength].every(Number.isFinite) ||
      feature.x < 0 || feature.x >= result.width || feature.y < 0 || feature.y >= result.height ||
      feature.previousX < 0 || feature.previousX >= result.width || feature.previousY < 0 || feature.previousY >= result.height ||
      feature.error < 0 || feature.error > 1 || feature.strength <= 0
    ) return false;
    ids.add(feature.id);
  }
  return true;
}

export class VisualInertialTracker {
  readonly fusion: PoseFusion;
  private readonly hasGyro: boolean;
  private readonly workerFactory: () => VioWorkerLike;
  private readonly workerTimeoutMs: number;
  private readonly minFrameIntervalMs: number;
  private readonly maxVisualLatencyMs: number;
  private readonly onUpdate: (update: TrackerUpdate) => void;
  private readonly onFailure: (message: string) => void;
  private worker: VioWorkerLike | null = null;
  private workerGeneration = 0;
  private pending: { request: VioFrameRequest; timeout: ReturnType<typeof setTimeout> } | null = null;
  private active = false;
  private disposed = false;
  private workerFailed = false;
  private frameId = 0;
  private lastFrameTimestamp = Number.NaN;
  private latestTimestamp = Number.NaN;
  private previousFrame: { timestamp: number; quaternion: QuaternionTuple; position: Vec3Tuple } | null = null;
  private consecutiveFailures = 0;
  private trackingState: TrackingState = 'initializing';

  constructor(options: VisualInertialTrackerOptions) {
    this.fusion = options.fusion ?? new PoseFusion();
    this.hasGyro = options.hasGyro ?? false;
    this.workerFactory = options.workerFactory ?? (() => new Worker(new URL('./workers/vio.worker.ts', import.meta.url), { type: 'module' }) as VioWorkerLike);
    this.workerTimeoutMs = Number.isFinite(options.workerTimeoutMs) ? Math.max(50, Math.min(10_000, options.workerTimeoutMs as number)) : 1800;
    this.minFrameIntervalMs = Number.isFinite(options.minFrameIntervalMs) ? Math.max(0, options.minFrameIntervalMs as number) : 50;
    this.maxVisualLatencyMs = Number.isFinite(options.maxVisualLatencyMs) ? Math.max(0, options.maxVisualLatencyMs as number) : 180;
    this.onUpdate = options.onUpdate;
    this.onFailure = options.onFailure;
  }

  setActive(active: boolean): void {
    if (this.disposed || this.active === active) return;
    this.active = active;
    if (!active) this.stopWorker();
  }

  ingestMotion(sample: MotionSample): void {
    if (!this.active || this.disposed) return;
    const result = this.fusion.ingestMotion(sample);
    if (!result.accepted) return;
    this.latestTimestamp = this.fusion.timestamp;
    this.emit(this.trackingState, [], result.reason);
  }

  ingestFrame(timestamp: number, image: ImageData, suppliedIntrinsics: CameraIntrinsics): void {
    if (!this.active || this.disposed || this.workerFailed) return;
    if (!Number.isFinite(timestamp) || timestamp < 0 || !image || !Number.isInteger(image.width) || !Number.isInteger(image.height) || image.width < 16 || image.height < 16 || image.width > 1280 || image.height > 720) return;
    if (!image.data || image.data.length !== image.width * image.height * 4) return;
    if (Number.isFinite(this.latestTimestamp) && timestamp < this.latestTimestamp - this.maxVisualLatencyMs) return;
    if (Number.isFinite(this.lastFrameTimestamp) && timestamp <= this.lastFrameTimestamp) return;
    if (Number.isFinite(this.lastFrameTimestamp) && timestamp - this.lastFrameTimestamp < this.minFrameIntervalMs) return;
    if (this.pending) return;
    const intrinsics = validateCameraIntrinsics(suppliedIntrinsics, image.width, image.height)
      ? { ...suppliedIntrinsics, timestamp }
      : estimateCameraIntrinsics(image.width, image.height, timestamp);
    let pixels: Uint8ClampedArray;
    try {
      pixels = new Uint8ClampedArray(image.data);
    } catch {
      this.fail('Camera frame buffer is unavailable.');
      return;
    }
    let rotationPrior: QuaternionTuple | undefined;
    if (this.previousFrame && this.hasGyro && this.fusion.hasFreshGyro(timestamp)) {
      this.fusion.predictTo(timestamp);
      rotationPrior = multiplyQuaternions(conjugateQuaternion(this.previousFrame.quaternion), this.fusion.orientation);
    }
    this.lastFrameTimestamp = timestamp;
    const request: VioFrameRequest = {
      type: 'frame',
      frameId: ++this.frameId,
      timestamp,
      width: image.width,
      height: image.height,
      pixels: pixels.buffer as ArrayBuffer,
      intrinsics,
      maxFeatures: 120,
      rotationPrior,
    };
    try {
      if (!this.worker) this.createWorker();
      if (!this.worker) return;
      const timeout = setTimeout(() => {
        if (this.pending?.request === request) this.fail('Visual tracking worker timed out.');
      }, this.workerTimeoutMs);
      this.pending = { request, timeout };
      this.worker.postMessage(request, [request.pixels]);
    } catch {
      this.fail('Visual tracking worker could not start.');
    }
  }

  reset(): void {
    this.stopWorker();
    this.fusion.reset();
    this.frameId = 0;
    this.lastFrameTimestamp = Number.NaN;
    this.latestTimestamp = Number.NaN;
    this.previousFrame = null;
    this.consecutiveFailures = 0;
    this.trackingState = 'initializing';
    this.workerFailed = false;
  }

  stop(): void {
    this.active = false;
    this.stopWorker();
    this.trackingState = 'lost';
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.active = false;
    this.stopWorker();
    this.fusion.reset();
    this.previousFrame = null;
  }

  private createWorker(): void {
    const worker = this.workerFactory();
    if (!worker || typeof worker.postMessage !== 'function' || typeof worker.terminate !== 'function') throw new Error('Invalid visual tracking worker.');
    const generation = ++this.workerGeneration;
    worker.onmessage = (event: MessageEvent<VioFrameResult | VioErrorResult>): void => {
      if (generation !== this.workerGeneration || this.worker !== worker || this.disposed || !this.active) return;
      const pending = this.pending;
      if (!pending) return;
      const result = event.data;
      if (!result || result.type === 'error') {
        if (result?.frameId !== undefined && result.frameId !== pending.request.frameId) return;
        this.fail(result?.message || 'Visual tracking worker failed.');
        return;
      }
      if (!validWorkerResult(result, pending.request)) {
        this.fail('Visual tracking worker returned malformed features.');
        return;
      }
      clearTimeout(pending.timeout);
      this.pending = null;
      this.processResult(result);
    };
    worker.onerror = (event: Event): void => {
      if (generation !== this.workerGeneration || this.worker !== worker || this.disposed) return;
      event.preventDefault();
      this.fail('Visual tracking worker failed.');
    };
    this.worker = worker;
  }

  private processResult(result: VioFrameResult): void {
    if (Number.isFinite(this.latestTimestamp) && result.timestamp < this.latestTimestamp - this.maxVisualLatencyMs) {
      this.previousFrame = null;
      this.consecutiveFailures += 1;
      this.emit('limited', [], 'Stale camera result rejected.');
      return;
    }
    this.fusion.predictTo(result.timestamp);
    const previous = this.previousFrame;
    const currentQuaternion = this.fusion.orientation;
    const currentPosition = this.fusion.translation;
    this.previousFrame = { timestamp: result.timestamp, quaternion: currentQuaternion, position: currentPosition };
    if (!previous) {
      this.consecutiveFailures = 0;
      this.trackingState = 'initializing';
      this.emit('initializing', [], 'Collecting sparse features.');
      return;
    }
    const dt = (result.timestamp - previous.timestamp) / 1000;
    if (dt <= 0 || dt > 0.5) {
      this.consecutiveFailures += 1;
      this.emit('limited', [], 'Camera baseline expired; reinitializing.');
      return;
    }
    const estimate = result.motion;
    if (!estimate) {
      this.consecutiveFailures += 1;
      this.trackingState = this.consecutiveFailures >= 3 ? 'lost' : 'limited';
      this.emit(this.trackingState, [], this.consecutiveFailures >= 3 ? 'Insufficient validated parallax; visual pose lost.' : 'Insufficient validated parallax.');
      return;
    }
    const measured = multiplyQuaternions(previous.quaternion, estimate.rotation);
    const orientationCovariance = new Array<number>(9).fill(0);
    const variance = clamp(0.12 / Math.max(0.05, estimate.confidence), 0.02, 1.5);
    for (let index = 0; index < 3; index += 1) orientationCovariance[index * 3 + index] = variance;
    const source = this.fusion.hasFreshGyro(result.timestamp) ? 'camera-fusion' as const : 'visual' as const;
    const fused = this.fusion.fuseVisualOrientation(result.timestamp, measured, orientationCovariance, estimate.confidence, source);
    if (!fused.accepted) {
      this.consecutiveFailures += 1;
      this.trackingState = 'limited';
      this.emit('limited', [], fused.reason);
      return;
    }
    this.fusion.integrateRelativeTranslation(estimate.translation, dt, estimate.confidence, previous.quaternion);
    const points = estimate.points.map((point) => {
      const rotated = rotateVector(previous.quaternion, point.position);
      return {
        ...point,
        position: [rotated[0] + previous.position[0], rotated[1] + previous.position[1], rotated[2] + previous.position[2]] as Vec3Tuple,
        source,
      };
    });
    this.consecutiveFailures = 0;
    this.trackingState = 'tracking';
    this.latestTimestamp = this.fusion.timestamp;
    this.previousFrame = { timestamp: this.latestTimestamp, quaternion: this.fusion.orientation, position: this.fusion.translation };
    this.emit('tracking', points);
  }

  private emit(state: TrackingState, points: SpatialPoint[], message?: string): void {
    this.trackingState = state;
    const timestamp = Number.isFinite(this.latestTimestamp) ? this.latestTimestamp : Number.isFinite(this.fusion.timestamp) ? this.fusion.timestamp : 0;
    this.onUpdate({
      frameId: this.frameId,
      timestamp,
      trackingState: state,
      fusion: this.fusion,
      points,
      message,
    });
  }

  private fail(message: string): void {
    if (this.disposed || this.workerFailed) return;
    this.workerFailed = true;
    this.stopWorker();
    this.previousFrame = null;
    this.trackingState = 'lost';
    this.onFailure(message);
  }

  private stopWorker(): void {
    this.workerGeneration += 1;
    if (this.pending) {
      clearTimeout(this.pending.timeout);
      this.pending = null;
    }
    if (this.worker) {
      this.worker.onmessage = null;
      this.worker.onerror = null;
      try { this.worker.terminate(); } catch { /* Already terminated by the browser. */ }
      this.worker = null;
    }
  }
}
