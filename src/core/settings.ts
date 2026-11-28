import { DEFAULT_SETTINGS, type AppSettings, type EnvironmentId, type InterfacePaletteId, type KeyboardLayout, type QualityMode, type SpatialMode, type TaskbarMode, type WindowPoseState } from '../types';

const SETTINGS_KEY = 'vision.settings.v1';
const WINDOWS_KEY = 'vision.windows.v1';
const BUILTIN_ENVIRONMENTS: EnvironmentId[] = ['venice', 'loft', 'camera'];
const QUALITIES: QualityMode[] = ['auto', 'high', 'low'];
const SPATIAL_MODES: SpatialMode[] = ['off', 'economy', 'camera', 'full'];
const KEYBOARD_LAYOUTS: KeyboardLayout[] = ['azerty', 'qwerty'];
const TASKBAR_MODES: TaskbarMode[] = ['follow', 'world'];
const INTERFACE_PALETTES: InterfacePaletteId[] = ['glacier', 'lagoon', 'sunset', 'orchid', 'citrus', 'graphite'];

function environmentId(value: unknown): EnvironmentId {
  if (BUILTIN_ENVIRONMENTS.includes(value as EnvironmentId)) return value as EnvironmentId;
  if (typeof value === 'string' && /^custom:[a-zA-Z0-9-]+$/.test(value)) return value as EnvironmentId;
  return DEFAULT_SETTINGS.environment;
}

function finite(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
}

function pose(value: unknown): WindowPoseState | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const candidate = value as Partial<WindowPoseState>;
  const quaternion = candidate.quaternion;
  const size = candidate.size;
  if (!quaternion || typeof quaternion !== 'object' || !size || typeof size !== 'object') return undefined;
  const length = Math.hypot(quaternion.x ?? 0, quaternion.y ?? 0, quaternion.z ?? 0, quaternion.w ?? 1);
  if (!Number.isFinite(length) || length < 0.0001) return undefined;
  return {
    position: {
      x: finite(candidate.position?.x, 0, -24, 24),
      y: finite(candidate.position?.y, 0, -12, 12),
      z: finite(candidate.position?.z, -6, -30, 12),
    },
    quaternion: {
      x: (quaternion.x ?? 0) / length,
      y: (quaternion.y ?? 0) / length,
      z: (quaternion.z ?? 0) / length,
      w: (quaternion.w ?? 1) / length,
    },
    size: {
      width: finite(size.width, 5.2, 1.2, 8),
      height: finite(size.height, 0.65, 0.75, 5),
    },
  };
}

export function sanitizeSettings(value: unknown): AppSettings {
  if (!value || typeof value !== 'object') return { ...DEFAULT_SETTINGS };
  const settings = value as Partial<AppSettings>;
  return {
    motionSensitivity: finite(settings.motionSensitivity, DEFAULT_SETTINGS.motionSensitivity, 0.25, 2),
    quality: QUALITIES.includes(settings.quality as QualityMode) ? settings.quality as QualityMode : DEFAULT_SETTINGS.quality,
    ipd: finite(settings.ipd, DEFAULT_SETTINGS.ipd, 50, 80),
    vrDistance: finite(settings.vrDistance, DEFAULT_SETTINGS.vrDistance, 3, 12),
    fov: finite(settings.fov, DEFAULT_SETTINGS.fov, 50, 100),
    distortion: finite(settings.distortion, DEFAULT_SETTINGS.distortion, 0, 0.3),
    environment: environmentId(settings.environment),
    headLockDefault: settings.headLockDefault === true,
    glassTransparency: finite(settings.glassTransparency, DEFAULT_SETTINGS.glassTransparency, 0, 0.95),
    glassBlur: finite(settings.glassBlur, DEFAULT_SETTINGS.glassBlur, 0, 40),
    palette: INTERFACE_PALETTES.includes(settings.palette as InterfacePaletteId) ? settings.palette as InterfacePaletteId : DEFAULT_SETTINGS.palette,
    defaultWindowScale: finite(settings.defaultWindowScale, DEFAULT_SETTINGS.defaultWindowScale, 0.7, 1.3),
    environmentExposure: finite(settings.environmentExposure, DEFAULT_SETTINGS.environmentExposure, 0.6, 1.6),
    handSmoothing: finite(settings.handSmoothing, DEFAULT_SETTINGS.handSmoothing, 0, 0.75),
    dwellTime: finite(settings.dwellTime, DEFAULT_SETTINGS.dwellTime, 0.4, 1.6),
    spatialMode: SPATIAL_MODES.includes(settings.spatialMode as SpatialMode) ? settings.spatialMode as SpatialMode : DEFAULT_SETTINGS.spatialMode,
    showEnvironmentMap: settings.showEnvironmentMap === true,
    keyboardLayout: KEYBOARD_LAYOUTS.includes(settings.keyboardLayout as KeyboardLayout) ? settings.keyboardLayout as KeyboardLayout : DEFAULT_SETTINGS.keyboardLayout,
    taskbarMode: TASKBAR_MODES.includes(settings.taskbarMode as TaskbarMode) ? settings.taskbarMode as TaskbarMode : DEFAULT_SETTINGS.taskbarMode,
    taskbarAnchor: pose(settings.taskbarAnchor),
    windowInertia: settings.windowInertia !== false,
    windowSnapping: settings.windowSnapping !== false,
    companionEnabled: settings.companionEnabled === true,
    uiSoundEnabled: settings.uiSoundEnabled !== false,
    uiSoundVolume: finite(settings.uiSoundVolume, DEFAULT_SETTINGS.uiSoundVolume, 0, 1),
  };
}

export function loadSettings(): AppSettings {
  try {
    return sanitizeSettings(JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? 'null'));
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(settings: AppSettings): boolean {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    return true;
  } catch {
    return false;
  }
}

export function loadWindowRecords(): unknown[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(WINDOWS_KEY) ?? '[]');
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

export function saveWindowRecords(windows: unknown[]): boolean {
  try {
    localStorage.setItem(WINDOWS_KEY, JSON.stringify(windows));
    return true;
  } catch {
    return false;
  }
}
