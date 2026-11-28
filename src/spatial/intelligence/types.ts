import type { SpatialMode } from '../../types';

/** All engine timestamps are non-negative milliseconds from one monotonic host clock. */
export type TrackingState = 'initializing' | 'tracking' | 'limited' | 'lost' | 'relocalizing';
export type MeasurementSource = 'gyro' | 'visual' | 'camera-fusion' | 'companion';
export type MeasurementScale = 'relative' | 'metric';
export type Vec3Tuple = [number, number, number];
export type QuaternionTuple = [number, number, number, number];

export interface SpatialCapabilities {
  requestedMode: SpatialMode;
  activeMode: SpatialMode;
  camera: boolean;
  visualTracking: boolean;
  gyroFusion: boolean;
  relativeDepth: boolean;
  metricDepth: boolean;
  semanticObjects: boolean;
  planes: boolean;
  meshes: boolean;
  freeSpace: boolean;
  companion: boolean;
  reasons: string[];
}

export interface PoseSample {
  frameId: number;
  timestamp: number;
  position: Vec3Tuple;
  quaternion: QuaternionTuple;
  velocity: Vec3Tuple;
  /** Row-major 6x6 position/orientation covariance; engine output has zero cross-covariance. */
  covariance: number[];
  confidence: number;
  scale: MeasurementScale;
  source: MeasurementSource;
}

export interface SpatialPoint {
  id: number;
  position: Vec3Tuple;
  confidence: number;
  observedAt: number;
  source: MeasurementSource;
  scale: MeasurementScale;
}

export interface SpatialSurface {
  id: string;
  kind: 'plane' | 'mesh';
  normal?: Vec3Tuple;
  point?: Vec3Tuple;
  vertices?: number[];
  indices?: number[];
  confidence: number;
  covariance?: number[];
  observedAt: number;
  source: MeasurementSource;
  scale: MeasurementScale;
}

export interface EnvironmentObject {
  id: string;
  label?: string;
  center: Vec3Tuple;
  extents: Vec3Tuple;
  pointIds: number[];
  confidence: number;
  observedAt: number;
  source: MeasurementSource;
  scale: MeasurementScale;
}

export interface FreeSpaceCell {
  id: string;
  center: Vec3Tuple;
  extents: Vec3Tuple;
  confidence: number;
  observedAt: number;
  source: MeasurementSource;
  scale: MeasurementScale;
}

export interface SpatialFrame {
  frameId: number;
  timestamp: number;
  trackingState: TrackingState;
  pose: PoseSample;
  points: SpatialPoint[];
  surfaces: SpatialSurface[];
  objects: EnvironmentObject[];
  freeSpace: FreeSpaceCell[];
  capabilities: SpatialCapabilities;
  message?: string;
}

export interface CameraIntrinsics {
  width: number;
  height: number;
  fx: number;
  fy: number;
  cx: number;
  cy: number;
  timestamp: number;
  calibration: 'estimated' | 'calibrated';
}

export interface MotionSample {
  /** Milliseconds on the same clock as camera and companion timestamps. */
  timestamp: number;
  /** Scalar-last orientation in the same world-to-camera frame used by visual tracking. */
  quaternion: QuaternionTuple;
  /** Angular velocity in radians per second. */
  gyro?: Vec3Tuple;
  covariance?: number[];
}

export interface CompanionSpatialSample {
  frameId: number;
  timestamp: number;
  pose: PoseSample;
  depth?: {
    width: number;
    height: number;
    /** Metric camera-space range in meters, with confidence values in [0, 1]. */
    values: Float32Array;
    confidence: Float32Array;
    intrinsics: CameraIntrinsics;
  };
  surfaces: SpatialSurface[];
  objects: EnvironmentObject[];
  freeSpace: FreeSpaceCell[];
  calibrationConfidence: number;
}

export interface SpatialIntelligence {
  detectCapabilities(): Promise<SpatialCapabilities>;
  setMode(mode: SpatialMode, cameraAvailable?: boolean): Promise<SpatialCapabilities>;
  getMode(): SpatialMode;
  readLatest(): SpatialFrame;
  subscribe(listener: (frame: SpatialFrame) => void): () => void;
  /** Timestamp is milliseconds; RGBA image data is copied before worker transfer. */
  ingestFrame(timestamp: number, image: ImageData, intrinsics: CameraIntrinsics): void;
  ingestMotion(sample: MotionSample): void;
  ingestCompanion(sample: CompanionSpatialSample): void;
  resetSession(): void;
  clearEnvironment(): void;
  stop(): void;
  dispose(): void;
}
