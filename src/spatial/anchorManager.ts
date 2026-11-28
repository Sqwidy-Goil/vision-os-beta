import { Matrix4, Quaternion, Vector3, type Object3D } from 'three';
import type { QuaternionState, Vec3State } from '../types';

export type AnchorKind = 'world' | 'surface' | 'object';
export type AnchorStatus = 'tracked' | 'low-confidence' | 'unavailable';

export interface AnchorTransform {
  position: Vec3State;
  quaternion: QuaternionState;
}

export type AnchorTransformSource = AnchorTransform | Quaternion | Matrix4 | Object3D;

export interface AnchorSnapshot {
  id: string;
  kind: AnchorKind;
  transform: AnchorTransform;
  position: Vec3State;
  quaternion: QuaternionState;
  confidence: number;
  status: AnchorStatus;
  usable: boolean;
  observedAt: number;
}

export interface StoredAnchor {
  id: string;
  kind: AnchorKind;
  transform: AnchorTransform;
  confidence: number;
  observedAt: number;
  available: boolean;
}

export interface AnchorFollowOffset {
  anchorId: string;
  position: Vec3State;
  quaternion: QuaternionState;
}

export interface AnchorResolution {
  anchorId: string;
  kind: AnchorKind;
  confidence: number;
  status: AnchorStatus;
  usable: boolean;
  transform: AnchorTransform | null;
}

export interface AnchorManagerOptions {
  minimumConfidence?: number;
  staleAfterMs?: number;
  now?: () => number;
}

const KINDS: AnchorKind[] = ['world', 'surface', 'object'];
const IDENTITY: QuaternionState = { x: 0, y: 0, z: 0, w: 1 };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

function validId(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 80;
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function normalizedQuaternion(value: unknown): QuaternionState | null {
  if (!isRecord(value)) return null;
  const { x, y, z, w } = value;
  if (!finite(x) || !finite(y) || !finite(z) || !finite(w)) return null;
  const length = Math.hypot(x, y, z, w);
  if (!Number.isFinite(length) || length < 0.0001) return null;
  const sign = w < 0 ? -1 : 1;
  return { x: x / length * sign + 0, y: y / length * sign + 0, z: z / length * sign + 0, w: w / length * sign + 0 };
}

function cloneTransform(transform: AnchorTransform): AnchorTransform {
  return {
    position: { ...transform.position },
    quaternion: { ...transform.quaternion },
  };
}

function quaternionState(quaternion: Quaternion): QuaternionState {
  const normalized = quaternion.clone().normalize();
  const sign = normalized.w < 0 ? -1 : 1;
  return {
    x: normalized.x * sign,
    y: normalized.y * sign,
    z: normalized.z * sign,
    w: normalized.w * sign,
  };
}

export function readAnchorTransform(source: AnchorTransformSource): AnchorTransform | null {
  return transformFromSource(source);
}

function transformFromSource(source: AnchorTransformSource): AnchorTransform | null {
  if (source instanceof Matrix4) {
    const position = new Vector3();
    const quaternion = new Quaternion();
    const scale = new Vector3();
    source.decompose(position, quaternion, scale);
    if (![position.x, position.y, position.z, quaternion.x, quaternion.y, quaternion.z, quaternion.w, scale.x, scale.y, scale.z].every(Number.isFinite)) return null;
    if (Math.abs(scale.x) < 0.000001 || Math.abs(scale.y) < 0.000001 || Math.abs(scale.z) < 0.000001) return null;
    return {
      position: { x: position.x, y: position.y, z: position.z },
      quaternion: quaternionState(quaternion),
    };
  }
  if (source instanceof Quaternion) {
    if (!Number.isFinite(source.length()) || source.length() < 0.0001) return null;
    return {
      position: { x: 0, y: 0, z: 0 },
      quaternion: quaternionState(source),
    };
  }
  if (!isRecord(source)) return null;
  if (source.isObject3D === true) {
    const object = source as unknown as Object3D;
    object.updateWorldMatrix(true, false);
    return transformFromSource(object.matrixWorld);
  }
  const position = source.position;
  if (!isRecord(position) || !finite(position.x) || !finite(position.y) || !finite(position.z)) return null;
  const quaternion = normalizedQuaternion(source.quaternion);
  if (!quaternion) return null;
  return {
    position: { x: position.x, y: position.y, z: position.z },
    quaternion,
  };
}

/**
 * Stores tracking anchors as stable IDs and copied numeric transforms.
 * Surface/object observations expire by default; world anchors do not.
 */
export class AnchorManager {
  private readonly anchors = new Map<string, StoredAnchor>();
  private readonly follows = new Map<string, AnchorFollowOffset>();
  private readonly minimumConfidence: number;
  private readonly staleAfterMs: number | undefined;
  private readonly now: () => number;

  constructor(options: AnchorManagerOptions = {}) {
    this.minimumConfidence = options.minimumConfidence === undefined
      ? 0.5
      : Math.min(1, Math.max(0, options.minimumConfidence));
    this.staleAfterMs = options.staleAfterMs;
    this.now = options.now ?? (() => performance.now());
  }

  captureWorld(
    id: string,
    transform: AnchorTransformSource,
    kind?: AnchorKind,
    confidence?: number,
  ): AnchorSnapshot;
  captureWorld(
    id: string,
    kind: AnchorKind,
    transform: AnchorTransformSource,
    confidence?: number,
  ): AnchorSnapshot;
  captureWorld(
    id: string,
    transformOrKind: AnchorTransformSource | AnchorKind,
    kindOrTransform: AnchorKind | AnchorTransformSource = 'world',
    confidence = 1,
  ): AnchorSnapshot {
    if (!validId(id)) throw new TypeError('Anchor IDs must be non-empty strings of at most 80 characters.');
    const kind = typeof transformOrKind === 'string' ? transformOrKind : kindOrTransform as AnchorKind;
    const source = typeof transformOrKind === 'string' ? kindOrTransform as AnchorTransformSource : transformOrKind;
    if (!KINDS.includes(kind)) throw new TypeError(`Unsupported anchor kind: ${String(kind)}.`);
    const transform = transformFromSource(source);
    if (!transform) throw new TypeError('Anchor transforms require a finite position and non-zero quaternion.');
    if (!finite(confidence)) throw new TypeError('Anchor confidence must be finite.');
    const record: StoredAnchor = {
      id,
      kind,
      transform,
      confidence: Math.min(1, Math.max(0, confidence)),
      observedAt: this.now(),
      available: true,
    };
    this.anchors.set(id, record);
    return this.current(id)!;
  }

  register(
    id: string,
    transform: AnchorTransformSource,
    kind: AnchorKind = 'world',
    confidence = 1,
  ): AnchorSnapshot {
    return this.captureWorld(id, transform, kind, confidence);
  }

  observe(id: string, transform: AnchorTransformSource, confidence = 1): AnchorSnapshot {
    const existing = this.anchors.get(id);
    return this.captureWorld(id, transform, existing?.kind ?? 'world', confidence);
  }

  markUnavailable(id: string): boolean {
    const anchor = this.anchors.get(id);
    if (!anchor) return false;
    anchor.available = false;
    anchor.confidence = 0;
    return true;
  }

  remove(id: string): boolean {
    const removed = this.anchors.delete(id);
    if (removed) {
      for (const [windowId, follow] of this.follows) {
        if (follow.anchorId === id) this.follows.delete(windowId);
      }
    }
    return removed;
  }

  clear(): void {
    this.anchors.clear();
    this.follows.clear();
  }

  current(id: string, now = this.now()): AnchorSnapshot | null {
    const anchor = this.anchors.get(id);
    if (!anchor) return null;
    const status = this.status(id, now);
    const transform = cloneTransform(anchor.transform);
    return {
      id: anchor.id,
      kind: anchor.kind,
      transform,
      position: { ...transform.position },
      quaternion: { ...transform.quaternion },
      confidence: anchor.confidence,
      status,
      usable: status === 'tracked',
      observedAt: anchor.observedAt,
    };
  }

  status(id: string, now = this.now()): AnchorStatus {
    const anchor = this.anchors.get(id);
    if (!anchor || !anchor.available) return 'unavailable';
    if (!Number.isFinite(anchor.confidence) || anchor.confidence < this.minimumConfidence) return 'low-confidence';
    const expires = anchor.kind === 'world' ? this.staleAfterMs : this.staleAfterMs ?? 5_000;
    if (expires !== undefined && Number.isFinite(expires) && now - anchor.observedAt > expires) return 'unavailable';
    return 'tracked';
  }

  follow(windowId: string, anchorId: string, worldPose: AnchorTransform): boolean {
    if (!validId(windowId) || !validId(anchorId)) return false;
    const anchor = this.anchors.get(anchorId);
    const pose = transformFromSource(worldPose);
    if (!anchor || !pose) return false;
    const anchorQuaternion = new Quaternion(
      anchor.transform.quaternion.x,
      anchor.transform.quaternion.y,
      anchor.transform.quaternion.z,
      anchor.transform.quaternion.w,
    );
    const inverse = anchorQuaternion.clone().invert();
    const offsetPosition = new Vector3(pose.position.x, pose.position.y, pose.position.z)
      .sub(new Vector3(anchor.transform.position.x, anchor.transform.position.y, anchor.transform.position.z))
      .applyQuaternion(inverse);
    const poseQuaternion = new Quaternion(pose.quaternion.x, pose.quaternion.y, pose.quaternion.z, pose.quaternion.w);
    const offsetQuaternion = inverse.clone().multiply(poseQuaternion).normalize();
    this.follows.set(windowId, {
      anchorId,
      position: { x: offsetPosition.x, y: offsetPosition.y, z: offsetPosition.z },
      quaternion: quaternionState(offsetQuaternion),
    });
    return true;
  }

  setFollowOffset(windowId: string, anchorId: string, offset: AnchorTransform): boolean {
    if (!validId(windowId) || !validId(anchorId) || !this.anchors.has(anchorId)) return false;
    const transform = transformFromSource(offset);
    if (!transform) return false;
    this.follows.set(windowId, { anchorId, ...transform });
    return true;
  }

  getFollowOffset(windowId: string): AnchorFollowOffset | null {
    const follow = this.follows.get(windowId);
    return follow
      ? {
          anchorId: follow.anchorId,
          position: { ...follow.position },
          quaternion: { ...follow.quaternion },
        }
      : null;
  }

  unanchor(windowId: string): boolean {
    return this.follows.delete(windowId);
  }

  resolve(windowId: string, now = this.now()): AnchorResolution {
    const follow = this.follows.get(windowId);
    const anchor = follow ? this.anchors.get(follow.anchorId) : undefined;
    if (!follow || !anchor) {
      return {
        anchorId: follow?.anchorId ?? '',
        kind: anchor?.kind ?? 'world',
        confidence: 0,
        status: 'unavailable',
        usable: false,
        transform: null,
      };
    }
    const status = this.status(anchor.id, now);
    if (status !== 'tracked') {
      return {
        anchorId: anchor.id,
        kind: anchor.kind,
        confidence: anchor.confidence,
        status,
        usable: false,
        transform: null,
      };
    }
    const anchorQuaternion = new Quaternion(
      anchor.transform.quaternion.x,
      anchor.transform.quaternion.y,
      anchor.transform.quaternion.z,
      anchor.transform.quaternion.w,
    );
    const position = new Vector3(follow.position.x, follow.position.y, follow.position.z)
      .applyQuaternion(anchorQuaternion)
      .add(new Vector3(anchor.transform.position.x, anchor.transform.position.y, anchor.transform.position.z));
    const quaternion = anchorQuaternion.clone().multiply(new Quaternion(
      follow.quaternion.x,
      follow.quaternion.y,
      follow.quaternion.z,
      follow.quaternion.w,
    )).normalize();
    return {
      anchorId: anchor.id,
      kind: anchor.kind,
      confidence: anchor.confidence,
      status,
      usable: true,
      transform: {
        position: { x: position.x, y: position.y, z: position.z },
        quaternion: quaternionState(quaternion),
      },
    };
  }

  snapshot(): StoredAnchor[] {
    return [...this.anchors.values()].map((anchor) => ({
      id: anchor.id,
      kind: anchor.kind,
      transform: cloneTransform(anchor.transform),
      confidence: anchor.confidence,
      observedAt: anchor.observedAt,
      available: anchor.available,
    }));
  }

  restore(records: readonly unknown[]): void {
    this.clear();
    if (!Array.isArray(records)) return;
    for (const value of records) {
      if (!isRecord(value) || !validId(value.id) || !KINDS.includes(value.kind as AnchorKind)) continue;
      try {
        this.captureWorld(value.id, value.transform as AnchorTransformSource, value.kind as AnchorKind, value.confidence as number);
        const restored = this.anchors.get(value.id)!;
        if (finite(value.observedAt)) restored.observedAt = value.observedAt;
        if (typeof value.available === 'boolean') restored.available = value.available;
      } catch {
        // Ignore malformed records without retaining any live tracking object.
      }
    }
  }
}

export function createAnchorTransform(
  position: Vec3State = { x: 0, y: 0, z: 0 },
  quaternion: QuaternionState = IDENTITY,
): AnchorTransform {
  const normalized = normalizedQuaternion(quaternion);
  if (!normalized || ![position.x, position.y, position.z].every(Number.isFinite)) {
    throw new TypeError('Invalid anchor transform.');
  }
  return { position: { ...position }, quaternion: normalized };
}
