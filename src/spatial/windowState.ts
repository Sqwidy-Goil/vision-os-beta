import { Euler, Quaternion } from 'three';
import { readAnchorTransform, type AnchorTransform, type AnchorTransformSource } from './anchorManager';
import { DEFAULT_SETTINGS, type AppSettings, type QuaternionState, type Vec3State, type WindowMode, type WindowState } from '../types';

const MODES: WindowMode[] = ['world', 'head', 'individual'];

export function createWindowState(appId: string, index: number, settings: AppSettings = DEFAULT_SETTINGS): WindowState {
  const column = index % 3;
  const row = Math.floor(index / 3) % 2;
  return {
    id: crypto.randomUUID(),
    appId,
    title: appId,
    position: {
      x: (column - 1) * 0.72 + (row % 2) * 0.18,
      y: (row === 0 ? 0.34 : -0.28) - Math.floor(index / 6) * 0.08,
      z: -6 - (index % 4) * 0.22,
    },
    size: {
      width: Math.min(8, Math.max(1.2, 4.15 * settings.defaultWindowScale)),
      height: Math.min(5, Math.max(0.75, 2.6 * settings.defaultWindowScale)),
    },
    rotation: { x: 0, y: 0, z: 0 },
    quaternion: { x: 0, y: 0, z: 0, w: 1 },
    schemaVersion: 2,
    mode: settings.headLockDefault ? 'head' : 'world',
    positioningExplicit: settings.headLockDefault,
    minimized: false,
    maximized: false,
    z: index + 1,
  };
}

function numberValue(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
}

function angleValue(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function vector(value: unknown, fallback: Vec3State, pinned = false): Vec3State {
  if (!value || typeof value !== 'object') return { ...fallback };
  const candidate = value as Partial<Vec3State>;
  return {
    x: numberValue(candidate.x, fallback.x, -18, 18),
    y: numberValue(candidate.y, fallback.y, -10, 10),
    z: numberValue(candidate.z, fallback.z, -24, pinned ? 4 : -2.2),
  };
}

function quaternion(value: unknown, fallback: QuaternionState): QuaternionState {
  if (value && typeof value === 'object') {
    const candidate = value as Partial<QuaternionState>;
    const length = Math.hypot(candidate.x ?? 0, candidate.y ?? 0, candidate.z ?? 0, candidate.w ?? 1);
    if (Number.isFinite(length) && length > 0.0001) {
      const sign = (candidate.w ?? 1) < 0 ? -1 : 1;
      return {
        x: (candidate.x ?? 0) / length * sign,
        y: (candidate.y ?? 0) / length * sign,
        z: (candidate.z ?? 0) / length * sign,
        w: (candidate.w ?? 1) / length * sign,
      };
    }
  }
  const sign = fallback.w < 0 ? -1 : 1;
  return { x: fallback.x * sign, y: fallback.y * sign, z: fallback.z * sign, w: fallback.w * sign };
}

function rotationQuaternion(rotation: Vec3State): QuaternionState {
  const result = new Quaternion().setFromEuler(new Euler(rotation.x, rotation.y, rotation.z, 'YXZ'));
  return { x: result.x, y: result.y, z: result.z, w: result.w };
}

function storedTransform(value: unknown): AnchorTransform | undefined {
  return readAnchorTransform(value as AnchorTransformSource) ?? undefined;
}

export function restoreWindowState(value: unknown, index: number): WindowState | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Partial<WindowState>;
  if (typeof candidate.id !== 'string' || typeof candidate.appId !== 'string') return null;
  const fallback = createWindowState(candidate.appId, index);
  const size = candidate.size && typeof candidate.size === 'object' ? candidate.size : fallback.size;
  const restore = candidate.restore;
  const pinned = candidate.pinned === true;
  const position = vector(candidate.position, fallback.position, pinned);
  const legacyRotation = {
    x: angleValue(candidate.rotation?.x),
    y: angleValue(candidate.rotation?.y),
    z: angleValue(candidate.rotation?.z),
  };
  const orientation = quaternion(candidate.quaternion, rotationQuaternion(legacyRotation));
  const derivedRotation = new Euler().setFromQuaternion(new Quaternion(orientation.x, orientation.y, orientation.z, orientation.w), 'YXZ');
  const rotation = { x: derivedRotation.x, y: derivedRotation.y, z: derivedRotation.z };
  const normalizedSize = {
    width: numberValue(size.width, fallback.size.width, 1.2, 8),
    height: numberValue(size.height, fallback.size.height, 0.75, 5),
  };
  const legacyAnchor = pinned || candidate.anchor === 'table';
  const anchor = legacyAnchor
    ? 'legacy-world'
    : typeof candidate.anchor === 'string' && candidate.anchor.length <= 80 ? candidate.anchor : undefined;
  return {
    ...fallback,
    id: candidate.id,
    appId: candidate.appId,
    title: typeof candidate.title === 'string' ? candidate.title.slice(0, 80) : candidate.appId,
    position,
    size: normalizedSize,
    rotation,
    quaternion: orientation,
    schemaVersion: 2,
    mode: pinned || legacyAnchor ? 'world' : MODES.includes(candidate.mode as WindowMode) ? candidate.mode as WindowMode : fallback.mode,
    positioningExplicit: candidate.positioningExplicit === true,
    minimized: candidate.minimized === true,
    maximized: pinned ? false : candidate.maximized === true,
    restore: !pinned && restore && typeof restore === 'object' ? {
      position: vector(restore.position, position),
      quaternion: quaternion(restore.quaternion, orientation),
      size: {
        width: numberValue(restore.size?.width, normalizedSize.width, 1.2, 8),
        height: numberValue(restore.size?.height, normalizedSize.height, 0.75, 5),
      },
    } : undefined,
    anchor,
    anchorSnapshot: storedTransform(candidate.anchorSnapshot),
    anchorOffset: storedTransform(candidate.anchorOffset),
    anchorConfidence: numberValue(candidate.anchorConfidence, 1, 0, 1),
    anchorObservedAt: typeof candidate.anchorObservedAt === 'number' && Number.isFinite(candidate.anchorObservedAt)
      ? Math.max(0, candidate.anchorObservedAt)
      : undefined,
    anchorAvailable: typeof candidate.anchorAvailable === 'boolean' ? candidate.anchorAvailable : undefined,
    anchorKind: anchor
      ? legacyAnchor || candidate.anchorKind === 'world' || !['world', 'surface', 'object'].includes(candidate.anchorKind ?? '')
        ? 'world'
        : candidate.anchorKind
      : undefined,
    pinned,
    appState: candidate.appState,
    z: numberValue(candidate.z, index + 1, 1, 1_000_000),
  };
}

export function nextWindowMode(mode: WindowMode): WindowMode {
  return MODES[(MODES.indexOf(mode) + 1) % MODES.length];
}

export function surroundLayout(count: number): Array<{ position: Vec3State; rotation: Vec3State; quaternion: QuaternionState }> {
  const total = Math.max(0, Math.floor(count));
  return Array.from({ length: total }, (_, index) => {
    const row = Math.floor(index / 4);
    const column = index % 4;
    const rowCount = Math.min(4, total - row * 4);
    const angle = (column - (rowCount - 1) / 2) * 0.34;
    const radius = 8.5 + row * 1.5;
    return {
      position: {
        x: Math.sin(angle) * radius,
        y: 0.55 - row * 2.6,
        z: -Math.cos(angle) * radius,
      },
      rotation: { x: 0, y: -angle, z: 0 },
      quaternion: rotationQuaternion({ x: 0, y: -angle, z: 0 }),
    };
  });
}
