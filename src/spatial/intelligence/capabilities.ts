import type { SpatialMode } from '../../types';
import type { SpatialCapabilities } from './types';

export interface SpatialHardware {
  camera: boolean;
  worker: boolean;
  orientation: boolean;
  gyro: boolean;
}

export interface CompanionCapabilityState {
  fresh: boolean;
  calibrated: boolean;
  metricDepth: boolean;
  semanticObjects: boolean;
  planes: boolean;
  meshes: boolean;
  freeSpace: boolean;
}

export interface CapabilityState {
  requestedMode: SpatialMode;
  hardware: SpatialHardware;
  workerFailed?: boolean;
  companion?: CompanionCapabilityState;
  reasons?: string[];
}

export function detectSpatialHardware(): SpatialHardware {
  const nav = typeof navigator === 'undefined' ? undefined : navigator;
  return {
    camera: Boolean(nav?.mediaDevices?.getUserMedia) && globalThis.isSecureContext !== false,
    worker: typeof Worker !== 'undefined',
    orientation: 'DeviceOrientationEvent' in globalThis || 'DeviceMotionEvent' in globalThis,
    gyro: 'DeviceMotionEvent' in globalThis,
  };
}

export function resolveSpatialCapabilities(state: CapabilityState): SpatialCapabilities {
  const { hardware } = state;
  const visual = hardware.camera && hardware.worker && !state.workerFailed;
  const companion = state.companion?.fresh ? state.companion : undefined;
  const calibratedCompanion = Boolean(companion?.fresh && companion.calibrated);
  const reasons = [...(state.reasons ?? [])];
  let activeMode: SpatialMode = 'off';

  if (state.requestedMode === 'full') {
    if (calibratedCompanion) {
      activeMode = 'full';
    } else if (visual) {
      activeMode = 'camera';
      reasons.push('Full mode needs a fresh calibrated companion; using relative camera tracking.');
    } else if (hardware.orientation) {
      activeMode = 'economy';
      reasons.push('Full mode and camera tracking are unavailable; using orientation only.');
    } else {
      reasons.push('Full mode needs a fresh calibrated companion.');
    }
  } else if (state.requestedMode === 'camera') {
    if (visual) {
      activeMode = 'camera';
    } else if (hardware.orientation) {
      activeMode = 'economy';
      reasons.push('Camera tracking is unavailable; using orientation only.');
    } else {
      reasons.push('Camera access, Web Workers, or both are unavailable.');
    }
  } else if (state.requestedMode === 'economy') {
    if (hardware.orientation) {
      activeMode = 'economy';
    } else {
      reasons.push('Device orientation is unavailable.');
    }
  }

  if (visual && !hardware.gyro) reasons.push('Gyroscope fusion is unavailable; visual tracking has no inertial prior.');
  if (activeMode === 'camera') reasons.push('Depth and translation use an arbitrary relative scale, not metric units.');
  if (activeMode === 'economy') reasons.push('Orientation only: no position, depth, surfaces, or free space are reconstructed.');
  if (activeMode === 'off') reasons.push('Spatial processing is stopped.');

  const metricFull = activeMode === 'full' && calibratedCompanion;
  return {
    requestedMode: state.requestedMode,
    activeMode,
    camera: activeMode !== 'off' && hardware.camera,
    visualTracking: (activeMode === 'camera' || activeMode === 'full') && visual,
    gyroFusion: (activeMode === 'camera' || activeMode === 'economy' || activeMode === 'full') && hardware.gyro,
    relativeDepth: activeMode === 'camera' && visual,
    metricDepth: metricFull && Boolean(companion?.metricDepth),
    semanticObjects: metricFull && Boolean(companion?.semanticObjects),
    planes: (activeMode === 'camera' && visual) || (metricFull && Boolean(companion?.planes)),
    meshes: metricFull && Boolean(companion?.meshes),
    freeSpace: metricFull && Boolean(companion?.freeSpace),
    companion: metricFull,
    reasons: [...new Set(reasons)],
  };
}

export async function detectCapabilities(
  requestedMode: SpatialMode = 'off',
  state: Omit<CapabilityState, 'requestedMode' | 'hardware'> = {},
): Promise<SpatialCapabilities> {
  return resolveSpatialCapabilities({ ...state, requestedMode, hardware: detectSpatialHardware() });
}
