import { Euler, Matrix4, Quaternion, Vector3, type Object3D } from 'three';
import type {
  AppSettings,
  QuaternionState,
  Vec3State,
  WindowMode,
  WindowPoseState,
  WindowState,
} from '../types';
import {
  AnchorManager,
  createAnchorTransform,
  readAnchorTransform,
  type AnchorKind,
  type AnchorStatus,
  type AnchorTransform,
  type AnchorTransformSource,
} from './anchorManager';
import { createWindowState, restoreWindowState, surroundLayout } from './windowState';

export interface SpatialWindowLike {
  state: WindowState;
  requestRender?: () => void;
  focus?: () => void;
}

export interface WindowManagerOptions {
  createWindow: (state: WindowState) => SpatialWindowLike;
  destroyWindow: (window: SpatialWindowLike) => void;
  onChange: (states: WindowState[]) => void;
  getSettings: () => AppSettings;
  anchorManager?: AnchorManager;
  maxLinearSpeed?: number;
  maxAngularSpeed?: number;
  damping?: number;
  snapDistance?: number;
}

export interface WindowSize {
  width: number;
  height: number;
}

export interface ResizeOptions {
  aspect?: boolean;
  preserveAspect?: boolean;
  uniform?: boolean;
  aspectRatio?: number;
  aspectAxis?: 'width' | 'height';
}

export type WindowSizeChange = Partial<WindowSize> & { scale?: number };

export type ManipulationKind = 'move' | 'rotate' | 'resize' | 'depth';

export interface WindowManipulationDelta {
  position?: Vec3State;
  translation?: Vec3State;
  x?: number;
  y?: number;
  z?: number;
  dx?: number;
  dy?: number;
  dz?: number;
  quaternion?: QuaternionState;
  rotation?: Vec3State;
  size?: Partial<WindowSize>;
  width?: number;
  height?: number;
  scale?: number;
  depth?: number;
  roll?: number;
  aspect?: boolean;
  preserveAspect?: boolean;
  uniform?: boolean;
  aspectRatio?: number;
  aspectAxis?: 'width' | 'height';
  dt?: number;
  deltaTime?: number;
}

export interface WindowAnchorInput {
  id?: string;
  kind?: AnchorKind;
  transform?: AnchorTransformSource;
  pose?: AnchorTransformSource;
  position?: Vec3State;
  quaternion?: QuaternionState;
  confidence?: number;
  offset?: AnchorTransform;
}

export type WindowAnchor = string | WindowAnchorInput | AnchorTransformSource;

export type HeadPoseSource = AnchorTransformSource | QuaternionState;

interface ManipulationState {
  id: string;
  kind: ManipulationKind;
  startPose: WindowPoseState;
  lastPose: WindowPoseState;
  sampleCount: number;
  resizeOptions: ResizeOptions;
}

interface MotionState {
  linear: Vector3;
  angular: Vector3;
}

interface SettlingState {
  position?: Vec3State;
  quaternion?: QuaternionState;
}

const MODES: WindowMode[] = ['world', 'head', 'individual'];
const ANCHOR_KINDS: AnchorKind[] = ['world', 'surface', 'object'];
const MIN_SIZE: WindowSize = { width: 1.2, height: 0.75 };
const MAX_SIZE: WindowSize = { width: 8, height: 5 };
const SNAP_POSITIONS: Vec3State[] = [
  { x: 0, y: 0, z: -6 },
  { x: -3.2, y: 0, z: -6 },
  { x: 3.2, y: 0, z: -6 },
  { x: 0, y: 1.8, z: -6 },
  { x: 0, y: -1.8, z: -6 },
  { x: 0, y: 0, z: -3 },
  { x: 0, y: 0, z: -9 },
];
const COMMON_SIZES: WindowSize[] = [
  MIN_SIZE,
  { width: 2.4, height: 1.5 },
  { width: 3.2, height: 2 },
  { width: 4.15, height: 2.6 },
  { width: 5.6, height: 3.5 },
  MAX_SIZE,
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function validId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 128;
}

function validVector(value: unknown): value is Vec3State {
  return isRecord(value) && finite(value.x) && finite(value.y) && finite(value.z);
}

function normalizeQuaternion(value: unknown): QuaternionState | null {
  if (!isRecord(value)) return null;
  const { x, y, z, w } = value;
  if (!finite(x) || !finite(y) || !finite(z) || !finite(w)) return null;
  const length = Math.hypot(x, y, z, w);
  if (!Number.isFinite(length) || length < 0.0001) return null;
  const sign = w < 0 ? -1 : 1;
  return { x: x / length * sign + 0, y: y / length * sign + 0, z: z / length * sign + 0, w: w / length * sign + 0 };
}

function quaternion(value: QuaternionState): Quaternion {
  return new Quaternion(value.x, value.y, value.z, value.w);
}

function quaternionState(value: Quaternion): QuaternionState {
  const normalized = value.clone().normalize();
  const sign = normalized.w < 0 ? -1 : 1;
  return {
    x: normalized.x * sign,
    y: normalized.y * sign,
    z: normalized.z * sign,
    w: normalized.w * sign,
  };
}

function rotationFor(quaternionValue: QuaternionState): Vec3State {
  const euler = new Euler().setFromQuaternion(quaternion(quaternionValue), 'YXZ');
  return { x: euler.x, y: euler.y, z: euler.z };
}

function clonePose(pose: WindowPoseState): WindowPoseState {
  return {
    position: { ...pose.position },
    quaternion: { ...pose.quaternion },
    size: { ...pose.size },
  };
}

function poseOf(state: WindowState): WindowPoseState {
  return {
    position: { ...state.position },
    quaternion: { ...state.quaternion },
    size: { ...state.size },
  };
}

function samePose(first: WindowPoseState, second: WindowPoseState): boolean {
  return ['x', 'y', 'z'].every((axis) => first.position[axis as keyof Vec3State] === second.position[axis as keyof Vec3State])
    && ['x', 'y', 'z', 'w'].every((axis) => first.quaternion[axis as keyof QuaternionState] === second.quaternion[axis as keyof QuaternionState])
    && first.size.width === second.size.width
    && first.size.height === second.size.height;
}

function cloneAppState(value: unknown): unknown {
  if (value === undefined) return undefined;
  try {
    return structuredClone(value);
  } catch {
    // Application state is opaque; non-cloneable values retain their identity.
    return value;
  }
}

function cloneState(state: WindowState): WindowState {
  return {
    ...state,
    position: { ...state.position },
    quaternion: { ...state.quaternion },
    rotation: { ...state.rotation },
    size: { ...state.size },
    restore: state.restore ? clonePose(state.restore) : undefined,
    anchorSnapshot: readAnchorTransform(state.anchorSnapshot as AnchorTransformSource) ?? undefined,
    anchorOffset: readAnchorTransform(state.anchorOffset as AnchorTransformSource) ?? undefined,
    appState: cloneAppState(state.appState),
  };
}

function validSize(value: unknown): value is WindowSize {
  return isRecord(value) && finite(value.width) && finite(value.height);
}

function parsePose(value: unknown): WindowPoseState | null {
  if (!isRecord(value) || !validVector(value.position) || !validSize(value.size)) return null;
  const orientation = normalizeQuaternion(value.quaternion);
  if (!orientation) return null;
  return {
    position: { ...value.position },
    quaternion: orientation,
    size: { width: value.size.width, height: value.size.height },
  };
}

function validOptionalVector(value: unknown): boolean {
  return value === undefined || validVector(value);
}

function validOptionalQuaternion(value: unknown): boolean {
  return value === undefined || normalizeQuaternion(value) !== null;
}

function validStoredRecord(value: unknown): value is Record<string, unknown> & { id: string; appId: string } {
  if (!isRecord(value) || !validId(value.id) || !validId(value.appId)) return false;
  if (value.schemaVersion !== undefined && value.schemaVersion !== 1 && value.schemaVersion !== 2) return false;
  if (!validOptionalVector(value.position) || !validOptionalVector(value.rotation) || !validOptionalQuaternion(value.quaternion)) return false;
  if (value.size !== undefined) {
    if (!isRecord(value.size) || !finite(value.size.width) || !finite(value.size.height)) return false;
  }
  if (value.restore !== undefined) {
    if (!isRecord(value.restore)) return false;
    if (!validOptionalVector(value.restore.position) || !validOptionalQuaternion(value.restore.quaternion)) return false;
    if (value.restore.size !== undefined && (!isRecord(value.restore.size)
      || !finite(value.restore.size.width) || !finite(value.restore.size.height))) return false;
  }
  if (value.mode !== undefined && (typeof value.mode !== 'string' || !MODES.includes(value.mode as WindowMode))) return false;
  if (value.anchor !== undefined && (typeof value.anchor !== 'string' || value.anchor.length > 80)) return false;
  if (value.anchorKind !== undefined && !ANCHOR_KINDS.includes(value.anchorKind as AnchorKind)) return false;
  if (value.title !== undefined && typeof value.title !== 'string') return false;
  if (value.z !== undefined && !finite(value.z)) return false;
  for (const key of ['minimized', 'maximized', 'pinned']) {
    if (value[key] !== undefined && typeof value[key] !== 'boolean') return false;
  }
  return true;
}

function boundedPose(pose: WindowPoseState): WindowPoseState {
  return {
    position: {
      x: clamp(pose.position.x, -18, 18),
      y: clamp(pose.position.y, -10, 10),
      z: clamp(pose.position.z, -24, -2.2),
    },
    quaternion: normalizeQuaternion(pose.quaternion)!,
    size: {
      width: clamp(pose.size.width, MIN_SIZE.width, MAX_SIZE.width),
      height: clamp(pose.size.height, MIN_SIZE.height, MAX_SIZE.height),
    },
  };
}

function writePose(state: WindowState, pose: WindowPoseState): void {
  state.position = { ...pose.position };
  state.quaternion = { ...pose.quaternion };
  state.rotation = rotationFor(state.quaternion);
  state.size = { ...pose.size };
  state.schemaVersion = 2;
}

function resizeScale(current: WindowSize, scale: number, aspectRatio: number, axis: 'width' | 'height'): number {
  const widthPerScale = axis === 'width' ? current.width : current.height * aspectRatio;
  const minimum = Math.max(MIN_SIZE.width / widthPerScale, MIN_SIZE.height * aspectRatio / widthPerScale);
  const maximum = Math.min(MAX_SIZE.width / widthPerScale, MAX_SIZE.height * aspectRatio / widthPerScale);
  return clamp(scale, minimum, maximum);
}

/** Applies additive width/height changes or a multiplicative scale, then clamps to window bounds. */
export function resizeWindowSize(current: WindowSize, change: WindowSizeChange, options: ResizeOptions = {}): WindowSize {
  const widthDelta = finite(change.width) ? change.width : 0;
  const heightDelta = finite(change.height) ? change.height : 0;
  const multiplicativeScale = change.scale === undefined ? 1 : finite(change.scale) && change.scale > 0 ? change.scale : 1;
  const preserveAspect = options.aspect === true || options.preserveAspect === true || (finite(options.aspectRatio) && options.aspectRatio! > 0);
  const uniform = options.uniform === true;
  if (!preserveAspect && !uniform) {
    return {
      width: clamp((current.width + widthDelta) * multiplicativeScale, MIN_SIZE.width, MAX_SIZE.width),
      height: clamp((current.height + heightDelta) * multiplicativeScale, MIN_SIZE.height, MAX_SIZE.height),
    };
  }
  const aspectRatio = finite(options.aspectRatio) && options.aspectRatio! > 0 ? options.aspectRatio! : current.width / current.height;
  const axis = options.aspectAxis ?? (widthDelta !== 0 ? 'width' : 'height');
  let scale = multiplicativeScale;
  if (change.scale === undefined) {
    scale = axis === 'width'
      ? (current.width + widthDelta) / current.width
      : (current.height + heightDelta) / current.height;
  }
  scale = resizeScale(current, scale, aspectRatio, axis);
  const width = (axis === 'width' ? current.width : current.height * aspectRatio) * scale;
  return {
    width: clamp(width, MIN_SIZE.width, MAX_SIZE.width),
    height: clamp(width / aspectRatio, MIN_SIZE.height, MAX_SIZE.height),
  };
}

export function resizeAspectSize(current: WindowSize, change: WindowSizeChange, axis: 'width' | 'height' = 'width'): WindowSize {
  return resizeWindowSize(current, change, { aspect: true, aspectAxis: axis });
}

export function resizeUniformSize(current: WindowSize, change: WindowSizeChange): WindowSize {
  return resizeWindowSize(current, change, { uniform: true });
}

function angularVelocity(previous: QuaternionState, next: QuaternionState, dt: number): Vector3 {
  const delta = quaternion(next).multiply(quaternion(previous).invert()).normalize();
  if (delta.w < 0) {
    delta.set(-delta.x, -delta.y, -delta.z, -delta.w);
  }
  const angle = 2 * Math.acos(clamp(delta.w, -1, 1));
  const sine = Math.sqrt(Math.max(0, 1 - delta.w * delta.w));
  if (angle < 0.000001 || sine < 0.000001) return new Vector3();
  return new Vector3(delta.x / sine, delta.y / sine, delta.z / sine).multiplyScalar(angle / dt);
}

function resolveHeadPose(value: HeadPoseSource): AnchorTransform | null {
  if (isRecord(value) && !('position' in value)) {
    const orientation = normalizeQuaternion(value);
    return orientation ? createAnchorTransform({ x: 0, y: 0, z: 0 }, orientation) : null;
  }
  return readAnchorTransform(value as AnchorTransformSource);
}

function localToHead(position: Vec3State, pose: AnchorTransform): Vec3State {
  const value = new Vector3(position.x, position.y, position.z)
    .applyQuaternion(quaternion(pose.quaternion))
    .add(new Vector3(pose.position.x, pose.position.y, pose.position.z));
  return { x: value.x, y: value.y, z: value.z };
}

function headToLocal(position: Vec3State, pose: AnchorTransform): Vec3State {
  const value = new Vector3(position.x, position.y, position.z)
    .sub(new Vector3(pose.position.x, pose.position.y, pose.position.z))
    .applyQuaternion(quaternion(pose.quaternion).invert());
  return { x: value.x, y: value.y, z: value.z };
}

function poseToWorld(pose: WindowPoseState, mode: WindowMode, head: AnchorTransform): WindowPoseState {
  if (mode === 'world') return clonePose(pose);
  const headQuaternion = quaternion(head.quaternion);
  return {
    position: mode === 'head'
      ? localToHead(pose.position, head)
      : { ...pose.position },
    quaternion: quaternionState(headQuaternion.clone().multiply(quaternion(pose.quaternion))),
    size: { ...pose.size },
  };
}

function poseFromWorld(pose: WindowPoseState, mode: WindowMode, head: AnchorTransform): WindowPoseState {
  if (mode === 'world') return clonePose(pose);
  const inverseHead = quaternion(head.quaternion).clone().invert();
  return {
    position: mode === 'head' ? headToLocal(pose.position, head) : { ...pose.position },
    quaternion: quaternionState(inverseHead.clone().multiply(quaternion(pose.quaternion))),
    size: { ...pose.size },
  };
}

function vectorState(value: Vector3): Vec3State {
  return { x: value.x, y: value.y, z: value.z };
}

/** Owns window lifecycle, transforms, inertia and anchor-follow state for SpatialScene. */
export class WindowManager {
  readonly anchors: AnchorManager;
  private readonly windows = new Map<string, SpatialWindowLike>();
  private readonly motion = new Map<string, MotionState>();
  private readonly settling = new Map<string, SettlingState>();
  private manipulation: ManipulationState | null = null;
  private zCounter = 1;
  private currentHeadPose: AnchorTransform = createAnchorTransform();
  private readonly maxLinearSpeed: number;
  private readonly maxAngularSpeed: number;
  private readonly damping: number;
  private readonly snapDistance: number;

  constructor(private readonly options: WindowManagerOptions) {
    this.anchors = options.anchorManager ?? new AnchorManager();
    this.maxLinearSpeed = Math.max(0.1, options.maxLinearSpeed ?? 8);
    this.maxAngularSpeed = Math.max(0.1, options.maxAngularSpeed ?? 4);
    this.damping = Math.max(0.1, options.damping ?? 5.5);
    this.snapDistance = Math.max(0, options.snapDistance ?? 0.3);
  }

  open(appId: string, title: string): SpatialWindowLike {
    if (!validId(appId) || typeof title !== 'string') throw new TypeError('A valid appId and title are required.');
    const state = createWindowState(appId, this.windows.size, this.options.getSettings());
    state.title = title.trim().slice(0, 80) || appId;
    state.z = ++this.zCounter;
    const window = this.create(state);
    this.windows.set(state.id, window);
    window.focus?.();
    window.requestRender?.();
    this.commit();
    return window;
  }

  /** Replaces the workspace with valid records; malformed records are skipped. */
  restore(records: readonly unknown[]): void {
    if (!Array.isArray(records)) return;
    const restored: SpatialWindowLike[] = [];
    const states: WindowState[] = [];
    const ids = new Set<string>();
    for (const [index, value] of records.entries()) {
      if (!validStoredRecord(value) || ids.has(value.id)) continue;
      const state = restoreWindowState(value, index);
      if (!state || ids.has(state.id)) continue;
      if (state.mode === 'head' && !state.positioningExplicit && !this.options.getSettings().headLockDefault) {
        writePose(state, poseToWorld(poseOf(state), 'head', this.currentHeadPose));
        state.mode = 'world';
      }
      try {
        restored.push(this.create(state));
        states.push(state);
        ids.add(state.id);
      } catch {
        // A failed application/window constructor must not create a partial record.
      }
    }
    if (records.length > 0 && restored.length === 0) return;
    const persistedAnchors = states.flatMap((state) => state.anchor && state.anchorSnapshot ? [{
      id: state.anchor,
      kind: state.anchorKind ?? 'world',
      transform: state.anchorSnapshot,
      confidence: state.anchorConfidence ?? 1,
      observedAt: state.anchorObservedAt ?? 0,
      available: state.anchorAvailable ?? true,
    }] : []);
    if (persistedAnchors.length > 0) this.anchors.restore(persistedAnchors);
    for (const window of this.windows.values()) {
      this.anchors.unanchor(window.state.id);
      this.options.destroyWindow(window);
    }
    this.windows.clear();
    this.motion.clear();
    this.settling.clear();
    this.manipulation = null;
    for (const window of restored) {
      this.windows.set(window.state.id, window);
      this.zCounter = Math.max(this.zCounter, window.state.z);
      if (window.state.anchor && this.anchors.current(window.state.anchor)) {
        if (window.state.anchorOffset) {
          this.anchors.setFollowOffset(window.state.id, window.state.anchor, window.state.anchorOffset);
        } else {
          this.anchors.follow(window.state.id, window.state.anchor, poseOf(window.state));
        }
      }
      this.syncAnchorMetadata(window.state);
      window.focus?.();
      window.requestRender?.();
    }
    this.commit();
  }

  focus(id: string): boolean {
    const window = this.find(id);
    if (!window) return false;
    window.state.minimized = false;
    window.state.z = ++this.zCounter;
    window.focus?.();
    window.requestRender?.();
    this.commit();
    return true;
  }

  setMinimized(id: string, minimized: boolean): boolean {
    const window = this.find(id);
    if (!window || window.state.minimized === minimized) return false;
    window.state.minimized = minimized;
    if (minimized) {
      this.motion.delete(id);
      this.settling.delete(id);
      if (this.manipulation?.id === id) this.manipulation = null;
    }
    window.requestRender?.();
    this.commit();
    return true;
  }

  close(id: string): boolean {
    const window = this.find(id);
    if (!window) return false;
    this.windows.delete(id);
    this.motion.delete(id);
    this.settling.delete(id);
    this.anchors.unanchor(id);
    if (this.manipulation?.id === id) this.manipulation = null;
    try {
      this.options.destroyWindow(window);
    } finally {
      this.commit();
    }
    return true;
  }

  list(): WindowState[] {
    return [...this.windows.values()]
      .map((window) => window.state)
      .sort((first, second) => second.z - first.z)
      .map(cloneState);
  }

  snapshot(): WindowState[] {
    return this.list();
  }

  beginManipulation(id: string, kind: ManipulationKind): boolean {
    const window = this.find(id);
    if (this.manipulation || !window || !['move', 'rotate', 'resize', 'depth'].includes(kind) || window.state.pinned || window.state.minimized) return false;
    this.motion.delete(id);
    this.settling.delete(id);
    this.manipulation = {
      id,
      kind,
      startPose: poseOf(window.state),
      lastPose: poseOf(window.state),
      sampleCount: 0,
      resizeOptions: {},
    };
    return true;
  }

  applyManipulation(delta: WindowManipulationDelta): boolean {
    const manipulation = this.manipulation;
    const window = manipulation ? this.find(manipulation.id) : undefined;
    if (!manipulation || !window || !this.validDelta(delta)) return false;
    const state = window.state;
    const previous = poseOf(state);
    const next = clonePose(previous);
    const dt = clamp(delta.dt ?? delta.deltaTime ?? 1 / 60, 1 / 240, 0.1);
    if (manipulation.kind === 'move' || manipulation.kind === 'depth') {
      const translation = delta.translation ?? delta.position ?? { x: 0, y: 0, z: 0 };
      const dx = (delta.dx ?? delta.x ?? 0) + translation.x;
      const dy = (delta.dy ?? delta.y ?? 0) + translation.y;
      const dz = (delta.dz ?? delta.z ?? 0) + translation.z + (delta.depth ?? 0);
      next.position = {
        x: previous.position.x + (manipulation.kind === 'move' ? dx : 0),
        y: previous.position.y + (manipulation.kind === 'move' ? dy : 0),
        z: previous.position.z + dz,
      };
      next.position = boundedPose(next).position;
    } else if (manipulation.kind === 'rotate') {
      const orientation = quaternion(previous.quaternion);
      if (delta.quaternion) orientation.premultiply(quaternion(normalizeQuaternion(delta.quaternion)!));
      if (delta.rotation) {
        const euler = new Euler(delta.rotation.x, delta.rotation.y, delta.rotation.z, 'YXZ');
        orientation.premultiply(new Quaternion().setFromEuler(euler));
      }
      if (delta.roll) orientation.multiply(new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), delta.roll));
      next.quaternion = quaternionState(orientation);
    } else {
      manipulation.resizeOptions = {
        aspect: delta.aspect,
        preserveAspect: delta.preserveAspect,
        uniform: delta.uniform,
        aspectRatio: delta.aspectRatio,
        aspectAxis: delta.aspectAxis,
      };
      next.size = resizeWindowSize(previous.size, {
        width: delta.width,
        height: delta.height,
        scale: delta.scale,
        ...delta.size,
      }, manipulation.resizeOptions);
    }
    writePose(state, next);
    const anchorChanged = manipulation.kind !== 'resize' && this.clearAnchorState(state);
    const settings = this.options.getSettings();
    if (settings.windowInertia && manipulation.kind !== 'resize') {
      const linear = manipulation.kind === 'depth'
        ? new Vector3(0, 0, (next.position.z - previous.position.z) / dt)
        : new Vector3(
          (next.position.x - previous.position.x) / dt,
          (next.position.y - previous.position.y) / dt,
          (next.position.z - previous.position.z) / dt,
        );
      if (linear.length() > this.maxLinearSpeed) linear.setLength(this.maxLinearSpeed);
      const angular = manipulation.kind === 'rotate'
        ? angularVelocity(previous.quaternion, next.quaternion, dt)
        : new Vector3();
      if (angular.length() > this.maxAngularSpeed) angular.setLength(this.maxAngularSpeed);
      this.motion.set(state.id, { linear, angular });
    } else {
      this.motion.delete(state.id);
    }
    manipulation.lastPose = clonePose(next);
    manipulation.sampleCount += 1;
    window.requestRender?.();
    const changed = !samePose(previous, next) || anchorChanged;
    if (changed) this.commit();
    return changed;
  }

  endManipulation(settle = true): boolean {
    const manipulation = this.manipulation;
    if (!manipulation) return false;
    const window = this.find(manipulation.id);
    this.manipulation = null;
    if (!window) return false;
    if (!settle) {
      this.motion.delete(window.state.id);
      this.settling.delete(window.state.id);
      window.requestRender?.();
      return true;
    }
    if (!this.options.getSettings().windowInertia) this.motion.delete(window.state.id);
    let changed = false;
    if (this.options.getSettings().windowSnapping) {
      if (manipulation.kind === 'resize') {
        const current = window.state.size;
        const target = COMMON_SIZES.reduce((closest, size) => {
          const distance = Math.hypot(size.width - current.width, size.height - current.height);
          const closestDistance = Math.hypot(closest.width - current.width, closest.height - current.height);
          return distance < closestDistance ? size : closest;
        }, COMMON_SIZES[0]);
        if (Math.hypot(target.width - current.width, target.height - current.height) <= 0.08) {
          const size = resizeWindowSize(current, {
            width: target.width - current.width,
            height: target.height - current.height,
          }, manipulation.resizeOptions);
          if (size.width !== current.width || size.height !== current.height) {
            window.state.size = size;
            changed = true;
          }
        }
      } else {
        const motion = this.motion.get(window.state.id);
        const position = window.state.position;
        const currentTarget = this.nearestSnap(position, window.state.mode);
        const predictedTarget = motion && motion.linear.lengthSq() > 0
          ? this.nearestSnap(vectorState(new Vector3(position.x, position.y, position.z).addScaledVector(motion.linear, 0.06)), window.state.mode)
          : null;
        const target = currentTarget && currentTarget.distance <= this.snapDistance ? currentTarget : predictedTarget;
        const settling: SettlingState = {};
        if (target && target.distance <= this.snapDistance * 1.5) settling.position = target.position;
        if (manipulation.kind === 'rotate') {
          const orientation = this.nearestRotationSnap(window.state.quaternion);
          if (orientation.distance <= 0.18) settling.quaternion = orientation.quaternion;
        }
        if (settling.position || settling.quaternion) {
          this.settling.set(window.state.id, settling);
          this.motion.delete(window.state.id);
        }
      }
    }
    window.requestRender?.();
    if (changed) this.commit();
    return true;
  }

  setPose(id: string, pose: WindowPoseState): boolean {
    const window = this.find(id);
    const parsed = parsePose(pose);
    if (!window || !parsed || window.state.pinned) return false;
    const next = boundedPose(parsed);
    const previous = poseOf(window.state);
    writePose(window.state, next);
    const anchorChanged = this.clearAnchorState(window.state);
    this.motion.delete(id);
    this.settling.delete(id);
    window.requestRender?.();
    const changed = !samePose(previous, next) || anchorChanged;
    if (changed) this.commit();
    return changed;
  }

  worldPose(id: string): WindowPoseState | null {
    const window = this.find(id);
    return window ? poseToWorld(poseOf(window.state), window.state.mode, this.currentHeadPose) : null;
  }

  setAnchor(id: string, anchor: WindowAnchor | null): boolean {
    const window = this.find(id);
    if (!window || window.state.pinned) return false;
    if (anchor === null) return this.clearAnchor(id);
    const input = this.parseAnchor(anchor);
    if (!input) return false;
    if (input.transform) {
      try {
        this.anchors.captureWorld(input.id, input.transform, input.kind, input.confidence);
      } catch {
        return false;
      }
    }
    const state = window.state;
    const worldPose = poseToWorld(poseOf(state), state.mode, this.currentHeadPose);
    state.anchor = input.id;
    state.anchorKind = input.kind;
    state.mode = 'world';
    writePose(state, worldPose);
    const followed = input.offset
      ? this.anchors.setFollowOffset(id, input.id, input.offset)
      : this.anchors.follow(id, input.id, worldPose);
    if (!followed && this.anchors.current(input.id) === null) {
      // Keep the stable ID for persistence, but do not fabricate a tracked transform.
      this.anchors.unanchor(id);
    }
    this.syncAnchorMetadata(state);
    this.motion.delete(id);
    this.settling.delete(id);
    window.requestRender?.();
    this.commit();
    return true;
  }

  clearAnchor(id: string): boolean {
    const window = this.find(id);
    if (!window) return false;
    const changed = this.clearAnchorState(window.state);
    this.motion.delete(id);
    this.settling.delete(id);
    window.requestRender?.();
    if (changed) this.commit();
    return changed;
  }

  setPositioning(id: string, mode: WindowMode): boolean {
    const window = this.find(id);
    if (!window || window.state.pinned || !MODES.includes(mode)) return false;
    const changed = window.state.mode !== mode || window.state.anchor !== undefined || !window.state.positioningExplicit;
    const previousMode = window.state.mode;
    const worldPose = poseToWorld(poseOf(window.state), previousMode, this.currentHeadPose);
    if (window.state.restore) {
      const restoreWorldPose = poseToWorld(window.state.restore, previousMode, this.currentHeadPose);
      window.state.restore = poseFromWorld(restoreWorldPose, mode, this.currentHeadPose);
    }
    window.state.mode = mode;
    window.state.positioningExplicit = true;
    this.clearAnchorState(window.state);
    writePose(window.state, poseFromWorld(worldPose, mode, this.currentHeadPose));
    this.motion.delete(id);
    this.settling.delete(id);
    window.requestRender?.();
    if (changed) this.commit();
    return changed;
  }

  step(delta: number, headPose?: HeadPoseSource): boolean {
    if (!finite(delta) || delta < 0) return false;
    if (headPose !== undefined) {
      const parsedHeadPose = resolveHeadPose(headPose);
      if (!parsedHeadPose) return false;
      this.currentHeadPose = parsedHeadPose;
    }
    if (!this.options.getSettings().windowInertia) this.motion.clear();
    if (!this.options.getSettings().windowSnapping) this.settling.clear();
    if (this.manipulation) return false;
    let changed = false;
    for (const window of this.windows.values()) {
      const state = window.state;
      const previous = poseOf(state);
      if (state.anchor && !state.maximized) {
        const resolution = this.anchors.resolve(state.id);
        if (resolution.usable && resolution.transform) {
          writePose(state, { ...resolution.transform, size: state.size });
          this.syncAnchorMetadata(state);
          this.motion.delete(state.id);
          this.settling.delete(state.id);
        } else {
          // Lost or uncertain tracking freezes the window instead of claiming it still follows.
          this.motion.delete(state.id);
          this.settling.delete(state.id);
        }
      } else {
        const settling = this.settling.get(state.id);
        if (settling) {
          const alpha = 1 - Math.exp(-14 * delta);
          const position = new Vector3(state.position.x, state.position.y, state.position.z);
          if (settling.position) position.lerp(new Vector3(settling.position.x, settling.position.y, settling.position.z), alpha);
          let orientation = quaternion(state.quaternion);
          if (settling.quaternion) orientation.slerp(quaternion(settling.quaternion), alpha);
          const positionDone = !settling.position || position.distanceTo(new Vector3(settling.position.x, settling.position.y, settling.position.z)) < 0.002;
          const rotationDone = !settling.quaternion || Math.abs(orientation.dot(quaternion(settling.quaternion))) > 0.999999;
          if (positionDone && settling.position) position.set(settling.position.x, settling.position.y, settling.position.z);
          if (rotationDone && settling.quaternion) orientation = quaternion(settling.quaternion);
          writePose(state, { position: vectorState(position), quaternion: quaternionState(orientation), size: state.size });
          if (positionDone && rotationDone) this.settling.delete(state.id);
        } else {
          const motion = this.motion.get(state.id);
          if (motion) {
            const decay = Math.exp(-this.damping * delta);
            const travel = (1 - decay) / this.damping;
            const position = new Vector3(state.position.x, state.position.y, state.position.z).addScaledVector(motion.linear, travel);
            const bounded = boundedPose({
              position: vectorState(position),
              quaternion: state.quaternion,
              size: state.size,
            });
            if (bounded.position.x !== position.x) motion.linear.x = 0;
            if (bounded.position.y !== position.y) motion.linear.y = 0;
            if (bounded.position.z !== position.z) motion.linear.z = 0;
            const orientation = quaternion(state.quaternion);
            const angularSpeed = motion.angular.length();
            if (angularSpeed > 0.000001) {
              orientation.premultiply(new Quaternion().setFromAxisAngle(motion.angular.clone().normalize(), angularSpeed * travel));
            }
            motion.linear.multiplyScalar(decay);
            motion.angular.multiplyScalar(decay);
            writePose(state, { position: bounded.position, quaternion: quaternionState(orientation), size: state.size });
            if (this.options.getSettings().windowSnapping) {
              const snap = this.nearestSnap(state.position, state.mode);
              if (snap && snap.distance <= this.snapDistance) {
                this.settling.set(state.id, { position: snap.position });
                this.motion.delete(state.id);
              } else if (angularSpeed > 0.000001) {
                const rotation = this.nearestRotationSnap(state.quaternion);
                if (rotation.distance <= 0.12) {
                  this.settling.set(state.id, { quaternion: rotation.quaternion });
                  this.motion.delete(state.id);
                }
              }
            }
            if (motion.linear.lengthSq() < 0.000225 && motion.angular.lengthSq() < 0.0004) this.motion.delete(state.id);
          }
        }
      }
      const windowChanged = !samePose(previous, poseOf(state));
      if (windowChanged) {
        changed = true;
        window.requestRender?.();
      }
    }
    if (changed) this.commit();
    return changed;
  }

  arrange(): boolean {
    const windows = [...this.windows.values()]
      .filter((window) => !window.state.pinned)
      .sort((first, second) => first.state.z - second.state.z);
    if (windows.length === 0) return false;
    const placements = surroundLayout(windows.length);
    windows.forEach((window, index) => {
      const state = window.state;
      state.mode = 'world';
      this.clearAnchorState(state);
      state.maximized = false;
      state.restore = undefined;
      writePose(state, {
        position: placements[index].position,
        quaternion: placements[index].quaternion,
        size: { width: 3.2, height: 2 },
      });
      this.motion.delete(state.id);
      this.settling.delete(state.id);
      window.requestRender?.();
    });
    this.commit();
    return true;
  }

  maximize(id: string): boolean {
    const window = this.find(id);
    if (!window || window.state.pinned || window.state.maximized) return false;
    window.state.restore = poseOf(window.state);
    const headQuaternion = quaternion(this.currentHeadPose.quaternion);
    const centered = poseFromWorld({
      position: localToHead({ x: 0, y: 0, z: -6 }, this.currentHeadPose),
      quaternion: quaternionState(headQuaternion),
      size: { width: 5.6, height: 3.5 },
    }, window.state.mode, this.currentHeadPose);
    writePose(window.state, centered);
    window.state.maximized = true;
    this.motion.delete(id);
    this.settling.delete(id);
    window.requestRender?.();
    this.commit();
    return true;
  }

  restoreMaximized(id: string): boolean {
    const window = this.find(id);
    if (!window || !window.state.maximized) return false;
    if (window.state.restore) writePose(window.state, boundedPose(window.state.restore));
    window.state.maximized = false;
    window.state.restore = undefined;
    if (window.state.anchor) this.anchors.follow(id, window.state.anchor, poseOf(window.state));
    this.motion.delete(id);
    this.settling.delete(id);
    window.requestRender?.();
    this.commit();
    return true;
  }

  toggleMaximize(id: string): boolean {
    return this.find(id)?.state.maximized ? this.restoreMaximized(id) : this.maximize(id);
  }

  getAnchorStatus(id: string): AnchorStatus {
    const state = this.find(id)?.state;
    return state?.anchor ? this.anchors.status(state.anchor) : 'unavailable';
  }

  private find(id: string): SpatialWindowLike | undefined {
    return this.windows.get(id);
  }

  private create(state: WindowState): SpatialWindowLike {
    const window = this.options.createWindow(state);
    if (!window || !window.state || window.state.id !== state.id) throw new TypeError('createWindow must return a window with the supplied state ID.');
    return window;
  }

  private commit(): void {
    this.options.onChange(this.snapshot());
  }

  private clearAnchorState(state: WindowState): boolean {
    const changed = state.anchor !== undefined || state.anchorKind !== undefined
      || state.anchorSnapshot !== undefined || state.anchorOffset !== undefined;
    state.anchor = undefined;
    state.anchorKind = undefined;
    state.anchorSnapshot = undefined;
    state.anchorOffset = undefined;
    state.anchorConfidence = undefined;
    state.anchorObservedAt = undefined;
    state.anchorAvailable = undefined;
    this.anchors.unanchor(state.id);
    return changed;
  }

  private syncAnchorMetadata(state: WindowState): void {
    if (!state.anchor) return;
    const anchor = this.anchors.current(state.anchor);
    if (!anchor) {
      state.anchorSnapshot = undefined;
      state.anchorOffset = undefined;
      state.anchorConfidence = undefined;
      state.anchorObservedAt = undefined;
      state.anchorAvailable = undefined;
      return;
    }
    state.anchorKind = anchor.kind;
    state.anchorSnapshot = readAnchorTransform(anchor.transform) ?? undefined;
    state.anchorConfidence = anchor.confidence;
    state.anchorObservedAt = anchor.observedAt;
    state.anchorAvailable = anchor.status !== 'unavailable';
    const follow = this.anchors.getFollowOffset(state.id);
    state.anchorOffset = follow ? readAnchorTransform(follow) ?? undefined : undefined;
  }

  private validDelta(delta: WindowManipulationDelta): boolean {
    if (!isRecord(delta)) return false;
    for (const key of ['x', 'y', 'z', 'dx', 'dy', 'dz', 'width', 'height', 'scale', 'depth', 'roll', 'dt', 'deltaTime', 'aspectRatio']) {
      if (delta[key as keyof WindowManipulationDelta] !== undefined && !finite(delta[key as keyof WindowManipulationDelta])) return false;
    }
    if (!validOptionalVector(delta.position) || !validOptionalVector(delta.translation) || !validOptionalVector(delta.rotation)) return false;
    if (delta.quaternion !== undefined && !normalizeQuaternion(delta.quaternion)) return false;
    if (delta.size !== undefined && (!isRecord(delta.size)
      || (delta.size.width !== undefined && !finite(delta.size.width))
      || (delta.size.height !== undefined && !finite(delta.size.height)))) return false;
    if (delta.aspectAxis !== undefined && delta.aspectAxis !== 'width' && delta.aspectAxis !== 'height') return false;
    if (delta.scale !== undefined && (!finite(delta.scale) || delta.scale <= 0)) return false;
    if (delta.aspectRatio !== undefined && (!finite(delta.aspectRatio) || delta.aspectRatio <= 0)) return false;
    if ((delta.dt !== undefined && (!finite(delta.dt) || delta.dt <= 0))
      || (delta.deltaTime !== undefined && (!finite(delta.deltaTime) || delta.deltaTime <= 0))) return false;
    for (const key of ['aspect', 'preserveAspect', 'uniform']) {
      if (delta[key as keyof WindowManipulationDelta] !== undefined && typeof delta[key as keyof WindowManipulationDelta] !== 'boolean') return false;
    }
    return true;
  }

  private parseAnchor(anchor: WindowAnchor): { id: string; kind: AnchorKind; confidence: number; transform?: AnchorTransformSource; offset?: AnchorTransform } | null {
    const generatedId = () => `anchor-${crypto.randomUUID()}`;
    if (typeof anchor === 'string') {
      if (anchor.length === 0 || anchor.length > 80) return null;
      const id = anchor === 'table' ? 'legacy-world' : anchor;
      const kind = this.anchors.current(id)?.kind ?? 'world';
      return { id, kind, confidence: 1 };
    }
    if (anchor instanceof Matrix4 || anchor instanceof Quaternion) {
      return { id: generatedId(), kind: 'world', confidence: 1, transform: anchor };
    }
    if (isRecord(anchor) && anchor.isObject3D === true) {
      const object = anchor as unknown as Object3D;
      const suppliedId = object.userData?.anchorId;
      const suppliedKind = object.userData?.anchorKind;
      const id = validId(suppliedId) ? suppliedId : generatedId();
      const kind = ANCHOR_KINDS.includes(suppliedKind as AnchorKind) ? suppliedKind as AnchorKind : 'world';
      return { id, kind, confidence: 1, transform: object };
    }
    if (!isRecord(anchor)) return null;
    const input = anchor as WindowAnchorInput & { position?: Vec3State; quaternion?: QuaternionState };
    let source = input.transform ?? input.pose;
    if (!source && validVector(input.position) && input.quaternion) {
      const orientation = normalizeQuaternion(input.quaternion);
      if (orientation) source = createAnchorTransform(input.position, orientation);
    }
    const suppliedId = input.id;
    const id = validId(suppliedId) ? suppliedId : source ? generatedId() : '';
    if (!id || id.length > 80) return null;
    const stableId = id === 'table' ? 'legacy-world' : id;
    const kind = input.kind ?? this.anchors.current(stableId)?.kind ?? 'world';
    if (!ANCHOR_KINDS.includes(kind)) return null;
    const confidence = input.confidence ?? 1;
    if (!finite(confidence)) return null;
    const offset = input.offset ? readAnchorTransform(input.offset) ?? undefined : undefined;
    if (input.offset && !offset) return null;
    return { id: stableId, kind, confidence, transform: source, offset };
  }

  private nearestSnap(position: Vec3State, mode: WindowMode): { position: Vec3State; distance: number } | null {
    const worldPosition = mode === 'head' ? localToHead(position, this.currentHeadPose) : position;
    let nearest: { position: Vec3State; distance: number } | null = null;
    for (const endpoint of SNAP_POSITIONS) {
      const distance = Math.hypot(endpoint.x - worldPosition.x, endpoint.y - worldPosition.y, endpoint.z - worldPosition.z);
      if (!nearest || distance < nearest.distance) {
        nearest = {
          position: mode === 'head' ? headToLocal(endpoint, this.currentHeadPose) : { ...endpoint },
          distance,
        };
      }
    }
    return nearest;
  }

  private nearestRotationSnap(orientation: QuaternionState): { quaternion: QuaternionState; distance: number } {
    const euler = new Euler().setFromQuaternion(quaternion(orientation), 'YXZ');
    const snapped = new Quaternion().setFromEuler(new Euler(
      Math.round(euler.x / (Math.PI / 2)) * (Math.PI / 2),
      Math.round(euler.y / (Math.PI / 2)) * (Math.PI / 2),
      Math.round(euler.z / (Math.PI / 2)) * (Math.PI / 2),
      'YXZ',
    ));
    return {
      quaternion: quaternionState(snapped),
      distance: 2 * Math.acos(clamp(Math.abs(quaternion(orientation).dot(snapped)), -1, 1)),
    };
  }
}
