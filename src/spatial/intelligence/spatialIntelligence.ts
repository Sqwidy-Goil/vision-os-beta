import type { SpatialMode } from '../../types';
import type {
  CameraIntrinsics,
  CompanionSpatialSample,
  PoseSample,
  SpatialCapabilities,
  SpatialFrame,
  SpatialIntelligence as SpatialIntelligenceApi,
  TrackingState,
} from './types';
import {
  detectSpatialHardware,
  resolveSpatialCapabilities,
  type CapabilityState,
  type CompanionCapabilityState,
  type SpatialHardware,
} from './capabilities';
import { EnvironmentModel, hasUsableDepth, validateCameraIntrinsics, type EnvironmentModelOptions } from './environmentModel';
import { PoseFusion, isValidQuaternion } from './poseFusion';
import { VisualInertialTracker, type TrackerUpdate, type VisualInertialTrackerOptions } from './visualInertialTracker';

export interface SpatialIntelligenceOptions extends Pick<VisualInertialTrackerOptions, 'workerFactory' | 'workerTimeoutMs' | 'minFrameIntervalMs' | 'maxVisualLatencyMs'> {
  hardware?: Partial<SpatialHardware>;
  now?: () => number;
  companionTimeoutMs?: number;
  environment?: EnvironmentModelOptions;
}

function validVector(value: unknown): value is [number, number, number] {
  return Array.isArray(value) && value.length === 3 && value.every(Number.isFinite);
}

function validCovariance(value: unknown): value is number[] {
  if (!Array.isArray(value) || value.length !== 36 || !value.every(Number.isFinite)) return false;
  for (let row = 0; row < 6; row += 1) {
    if (value[row * 6 + row] < 0) return false;
    for (let column = row + 1; column < 6; column += 1) {
      const first = value[row * 6 + column];
      const second = value[column * 6 + row];
      if (Math.abs(first - second) > 1e-6 * Math.max(1, Math.abs(first), Math.abs(second))) return false;
    }
  }
  const lower = new Array<number>(36).fill(0);
  for (let row = 0; row < 6; row += 1) {
    for (let column = 0; column <= row; column += 1) {
      let residual = value[row * 6 + column];
      for (let inner = 0; inner < column; inner += 1) residual -= lower[row * 6 + inner] * lower[column * 6 + inner];
      if (row === column) {
        if (residual < -1e-7) return false;
        lower[row * 6 + row] = Math.sqrt(Math.max(0, residual));
      } else {
        if (lower[column * 6 + column] < 1e-12) {
          if (Math.abs(residual) > 1e-7) return false;
        } else {
          lower[row * 6 + column] = residual / lower[column * 6 + column];
        }
      }
    }
  }
  return true;
}

function validCompanionPose(pose: PoseSample): boolean {
  return Boolean(
    pose && Number.isInteger(pose.frameId) && pose.frameId >= 0 && Number.isFinite(pose.timestamp) && pose.timestamp >= 0 &&
    validVector(pose.position) && validVector(pose.velocity) && isValidQuaternion(pose.quaternion) &&
    validCovariance(pose.covariance) && Number.isFinite(pose.confidence) && pose.confidence >= 0 && pose.confidence <= 1 &&
    pose.scale === 'metric' && pose.source === 'companion',
  );
}

function validDepth(sample: CompanionSpatialSample): boolean {
  const depth = sample.depth;
  if (!depth) return false;
  return Boolean(
    Number.isInteger(depth.width) && depth.width > 0 && depth.width <= 512 &&
    Number.isInteger(depth.height) && depth.height > 0 && depth.height <= 512 &&
    depth.width * depth.height <= 262_144 &&
    depth.values instanceof Float32Array && depth.confidence instanceof Float32Array &&
    depth.values.length === depth.width * depth.height && depth.confidence.length === depth.values.length &&
    validateCameraIntrinsics(depth.intrinsics, depth.width, depth.height) && depth.intrinsics.calibration === 'calibrated' &&
    hasUsableDepth(depth),
  );
}

function cloneFrame(frame: SpatialFrame): SpatialFrame {
  return {
    ...frame,
    pose: { ...frame.pose, position: [...frame.pose.position], quaternion: [...frame.pose.quaternion], velocity: [...frame.pose.velocity], covariance: [...frame.pose.covariance] },
    points: frame.points.map((point) => ({ ...point, position: [...point.position] })),
    surfaces: frame.surfaces.map((surface) => ({ ...surface, normal: surface.normal ? [...surface.normal] : undefined, point: surface.point ? [...surface.point] : undefined, vertices: surface.vertices ? [...surface.vertices] : undefined, indices: surface.indices ? [...surface.indices] : undefined, covariance: surface.covariance ? [...surface.covariance] : undefined })),
    objects: frame.objects.map((object) => ({ ...object, center: [...object.center], extents: [...object.extents], pointIds: [...object.pointIds] })),
    freeSpace: frame.freeSpace.map((cell) => ({ ...cell, center: [...cell.center], extents: [...cell.extents] })),
    capabilities: { ...frame.capabilities, reasons: [...frame.capabilities.reasons] },
  };
}

export class SpatialIntelligence implements SpatialIntelligenceApi {
  private readonly detectedHardware = detectSpatialHardware();
  private readonly hardwareOverride?: Partial<SpatialHardware>;
  private runtimeCameraAvailable?: boolean;
  private readonly environment: EnvironmentModel;
  private readonly tracker: VisualInertialTracker;
  private readonly companionFusion = new PoseFusion();
  private readonly listeners = new Set<(frame: SpatialFrame) => void>();
  private readonly now: () => number;
  private readonly companionTimeoutMs: number;
  private requestedMode: SpatialMode = 'off';
  private stopped = false;
  private disposed = false;
  private workerFailed = false;
  private frameSequence = 0;
  private latestTimestamp = 0;
  private trackingState: TrackingState = 'initializing';
  private message?: string;
  private companionFallbackReason?: string;
  private companionTimestamp: number | null = null;
  private companionArrival = 0;
  private companionCapability: CompanionCapabilityState | null = null;
  private latest: SpatialFrame;

  constructor(options: SpatialIntelligenceOptions = {}) {
    this.hardwareOverride = options.hardware;
    this.now = options.now ?? (() => performance.now());
    this.companionTimeoutMs = Number.isFinite(options.companionTimeoutMs)
      ? Math.max(100, Math.min(10_000, options.companionTimeoutMs as number))
      : 1200;
    this.environment = new EnvironmentModel(options.environment);
    this.tracker = new VisualInertialTracker({
      fusion: new PoseFusion(),
      hasGyro: this.hardware().gyro,
      workerFactory: options.workerFactory,
      workerTimeoutMs: options.workerTimeoutMs,
      minFrameIntervalMs: options.minFrameIntervalMs,
      maxVisualLatencyMs: options.maxVisualLatencyMs,
      onUpdate: (update) => this.handleTrackerUpdate(update),
      onFailure: (message) => this.handleWorkerFailure(message),
    });
    this.latest = this.emptyFrame(this.capabilities());
  }

  async detectCapabilities(): Promise<SpatialCapabilities> {
    this.refreshCompanion();
    return this.capabilities();
  }

  async setMode(mode: SpatialMode, cameraAvailable?: boolean): Promise<SpatialCapabilities> {
    if (this.disposed) return this.capabilities();
    if (mode !== 'off' && mode !== 'economy' && mode !== 'camera' && mode !== 'full') throw new Error('Unknown spatial mode.');
    if (cameraAvailable !== undefined) this.runtimeCameraAvailable = cameraAvailable;
    this.refreshCompanion();
    if (mode === this.requestedMode && !this.stopped) return this.capabilities();
    this.requestedMode = mode;
    this.stopped = false;
    this.workerFailed = false;
    this.tracker.reset();
    this.companionFusion.reset();
    this.environment.clear();
    this.environment.setMetricActive(false);
    this.companionTimestamp = null;
    this.companionCapability = null;
    this.frameSequence = 0;
    this.latestTimestamp = 0;
    this.trackingState = mode === 'off' ? 'lost' : 'initializing';
    this.message = undefined;
    this.companionFallbackReason = undefined;
    this.configureProcessing();
    this.publish();
    return this.capabilities();
  }

  getMode(): SpatialMode {
    return this.requestedMode;
  }

  readLatest(): SpatialFrame {
    this.refreshCompanion();
    return cloneFrame(this.latest);
  }

  subscribe(listener: (frame: SpatialFrame) => void): () => void {
    if (this.disposed) return () => undefined;
    this.listeners.add(listener);
    this.refreshCompanion();
    this.notify(listener, this.latest);
    return () => { this.listeners.delete(listener); };
  }

  ingestFrame(timestamp: number, image: ImageData, intrinsics: CameraIntrinsics): void {
    if (this.disposed || this.stopped) return;
    this.refreshCompanion();
    const activeMode = this.capabilities().activeMode;
    if (activeMode !== 'camera' && activeMode !== 'full') return;
    this.tracker.ingestFrame(timestamp, image, intrinsics);
  }

  ingestMotion(sample: Parameters<SpatialIntelligenceApi['ingestMotion']>[0]): void {
    if (this.disposed || this.stopped) return;
    this.refreshCompanion();
    const activeMode = this.capabilities().activeMode;
    if (activeMode === 'off') return;
    this.tracker.ingestMotion(sample);
  }

  ingestCompanion(sample: CompanionSpatialSample): void {
    if (this.disposed || this.stopped || this.requestedMode !== 'full') return;
    this.refreshCompanion();
    if (!sample || !Number.isInteger(sample.frameId) || sample.frameId < 0 || !Number.isFinite(sample.timestamp) || sample.timestamp < 0 ||
      !validCompanionPose(sample.pose) || sample.pose.frameId !== sample.frameId || sample.pose.timestamp !== sample.timestamp ||
      !Number.isFinite(sample.calibrationConfidence) || sample.calibrationConfidence < 0.65 || sample.calibrationConfidence > 1 ||
      !Array.isArray(sample.surfaces) || !Array.isArray(sample.objects) || !Array.isArray(sample.freeSpace) ||
      (sample.depth !== undefined && !validDepth(sample))) {
      this.disconnectCompanion('Companion data is malformed or no longer calibrated.');
      return;
    }
    if (this.companionTimestamp !== null && sample.timestamp <= this.companionTimestamp) return;

    const firstMetricSample = this.companionTimestamp === null;
    if (firstMetricSample) {
      this.tracker.reset();
      this.companionFusion.resetToPose(sample.pose);
      this.environment.clear();
      this.environment.setMetricActive(true);
    } else {
      const fused = this.companionFusion.fuseCompanionPose(sample.pose);
      if (!fused.accepted) {
        this.disconnectCompanion(fused.reason ?? 'Companion pose rejected; metric data was discarded.');
        return;
      }
    }
    this.companionTimestamp = sample.timestamp;
    this.companionArrival = this.now();
    const snapshot = this.environment.observeCompanion(sample);
    this.companionCapability = {
      fresh: true,
      calibrated: true,
      metricDepth: hasUsableDepth(sample.depth),
      semanticObjects: snapshot.objects.some((object) => object.label !== undefined),
      planes: snapshot.surfaces.some((surface) => surface.kind === 'plane'),
      meshes: snapshot.surfaces.some((surface) => surface.kind === 'mesh' && Boolean(surface.vertices?.length && surface.indices?.length)),
      freeSpace: snapshot.freeSpace.length > 0,
    };
    this.latestTimestamp = sample.timestamp;
    this.trackingState = sample.pose.confidence >= 0.4 ? 'tracking' : 'limited';
    this.message = undefined;
    this.companionFallbackReason = undefined;
    this.configureProcessing();
    this.publish();
  }

  resetSession(): void {
    if (this.disposed) return;
    this.tracker.reset();
    this.companionFusion.reset();
    this.environment.clear();
    this.environment.setMetricActive(false);
    this.companionTimestamp = null;
    this.companionCapability = null;
    this.workerFailed = false;
    this.frameSequence = 0;
    this.latestTimestamp = 0;
    this.trackingState = this.requestedMode === 'off' || this.stopped ? 'lost' : 'initializing';
    this.message = undefined;
    this.companionFallbackReason = undefined;
    this.configureProcessing();
    this.publish();
  }

  clearEnvironment(): void {
    if (this.disposed) return;
    this.environment.clear();
    this.publish();
  }

  stop(): void {
    if (this.disposed || this.stopped) return;
    this.stopped = true;
    this.tracker.stop();
    this.environment.clear();
    this.trackingState = 'lost';
    this.message = 'Spatial processing is stopped.';
    this.publish();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stopped = true;
    this.listeners.clear();
    this.tracker.dispose();
    this.companionFusion.reset();
    this.environment.clear();
    this.companionTimestamp = null;
    this.companionCapability = null;
    this.latest = this.emptyFrame(this.capabilities());
  }

  private hardware(): SpatialHardware {
    const detected = this.hardwareOverride ? this.detectedHardware : detectSpatialHardware();
    const hardware = { ...detected, ...this.hardwareOverride };
    if (this.runtimeCameraAvailable !== undefined) hardware.camera = this.runtimeCameraAvailable;
    return hardware;
  }

  private capabilities(): SpatialCapabilities {
    const state: CapabilityState = {
      requestedMode: this.requestedMode,
      hardware: this.hardware(),
      workerFailed: this.workerFailed,
      companion: this.companionCapability ?? undefined,
      reasons: this.message ? [this.message] : undefined,
    };
    const capabilities = resolveSpatialCapabilities(state);
    if (this.stopped || this.disposed) {
      return {
        ...capabilities,
        activeMode: 'off',
        camera: false,
        visualTracking: false,
        gyroFusion: false,
        relativeDepth: false,
        metricDepth: false,
        semanticObjects: false,
        planes: false,
        meshes: false,
        freeSpace: false,
        companion: false,
        reasons: [...new Set([...capabilities.reasons, 'Spatial processing is stopped.'])],
      };
    }
    return capabilities;
  }

  private configureProcessing(): void {
    const activeMode = this.capabilities().activeMode;
    this.tracker.setActive(activeMode === 'camera' || activeMode === 'economy' || activeMode === 'full');
    this.environment.setMetricActive(activeMode === 'full');
  }

  private handleTrackerUpdate(update: TrackerUpdate): void {
    if (this.disposed || this.stopped) return;
    const activeMode = this.capabilities().activeMode;
    if (activeMode === 'off') return;
    if (activeMode === 'full') return;
    if (activeMode === 'camera') this.environment.observePoints(update.points);
    this.latestTimestamp = Math.max(this.latestTimestamp, update.timestamp);
    this.trackingState = update.trackingState;
    if (update.trackingState === 'tracking') this.companionFallbackReason = undefined;
    this.message = this.companionFallbackReason ?? update.message;
    this.publish();
  }

  private handleWorkerFailure(message: string): void {
    if (this.disposed || this.stopped) return;
    this.workerFailed = true;
    if (this.capabilities().activeMode === 'full') {
      this.message = message;
      this.publish();
      return;
    }
    this.environment.clear();
    this.environment.setMetricActive(false);
    this.trackingState = 'lost';
    this.message = this.companionFallbackReason ?? message;
    this.configureProcessing();
    this.publish();
  }

  private refreshCompanion(): void {
    if (this.companionTimestamp === null) return;
    const arrivalExpired = this.now() - this.companionArrival > this.companionTimeoutMs;
    if (arrivalExpired) this.disconnectCompanion('Companion connection expired; metric data was discarded.');
  }

  private disconnectCompanion(message: string): void {
    this.companionTimestamp = null;
    this.companionCapability = null;
    this.environment.clear();
    this.environment.setMetricActive(false);
    this.tracker.reset();
    this.companionFusion.reset();
    this.frameSequence = 0;
    this.latestTimestamp = 0;
    this.trackingState = 'initializing';
    this.message = message;
    this.companionFallbackReason = message;
    this.configureProcessing();
    this.publish();
  }

  private publish(): void {
    const capabilities = this.capabilities();
    const timestamp = this.latestTimestamp;
    let pose: PoseSample;
    if (capabilities.activeMode === 'full' && this.companionTimestamp !== null) {
      pose = this.companionFusion.samplePose(this.frameSequence + 1, timestamp, 'companion', 'metric');
    } else if (capabilities.activeMode === 'off') {
      pose = {
        frameId: 0,
        timestamp: 0,
        position: [0, 0, 0],
        quaternion: [0, 0, 0, 1],
        velocity: [0, 0, 0],
        covariance: new Array<number>(36).fill(0),
        confidence: 0,
        scale: 'relative',
        source: 'gyro',
      };
    } else {
      pose = this.tracker.fusion.samplePose(this.frameSequence + 1, timestamp, this.tracker.fusion.measurementSource, 'relative');
    }
    const environment = capabilities.activeMode === 'off'
      ? { points: [], surfaces: [], objects: [], freeSpace: [] }
      : this.environment.rebuild(timestamp, capabilities);
    this.frameSequence += 1;
    this.latest = {
      frameId: this.frameSequence,
      timestamp: capabilities.activeMode === 'off' ? 0 : pose.timestamp,
      trackingState: capabilities.activeMode === 'off' ? 'lost' : this.trackingState,
      pose,
      ...environment,
      capabilities,
      message: this.message,
    };
    for (const listener of this.listeners) this.notify(listener, this.latest);
  }

  private notify(listener: (frame: SpatialFrame) => void, frame: SpatialFrame): void {
    try { listener(cloneFrame(frame)); } catch { /* A subscriber must not interrupt tracking. */ }
  }

  private emptyFrame(capabilities: SpatialCapabilities): SpatialFrame {
    return {
      frameId: 0,
      timestamp: 0,
      trackingState: capabilities.activeMode === 'off' ? 'lost' : 'initializing',
      pose: {
        frameId: 0,
        timestamp: 0,
        position: [0, 0, 0],
        quaternion: [0, 0, 0, 1],
        velocity: [0, 0, 0],
        covariance: new Array<number>(36).fill(0),
        confidence: 0,
        scale: 'relative',
        source: 'gyro',
      },
      points: [],
      surfaces: [],
      objects: [],
      freeSpace: [],
      capabilities,
      message: capabilities.reasons.at(-1),
    };
  }
}

export function createSpatialIntelligence(options: SpatialIntelligenceOptions = {}): SpatialIntelligence {
  return new SpatialIntelligence(options);
}
