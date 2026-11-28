import type {
  CameraIntrinsics,
  CompanionSpatialSample,
  EnvironmentObject,
  FreeSpaceCell,
  SpatialCapabilities,
  SpatialPoint,
  SpatialSurface,
  Vec3Tuple,
} from './types';
import { clamp, normalizeQuaternion, rotateVector } from './poseFusion';

export interface EnvironmentSnapshot {
  points: SpatialPoint[];
  surfaces: SpatialSurface[];
  objects: EnvironmentObject[];
  freeSpace: FreeSpaceCell[];
}

interface PointRecord {
  point: SpatialPoint;
  observations: number;
  firstObservedAt: number;
}

interface PlaneRecord {
  surface: SpatialSurface;
  normal: Vec3Tuple;
  hits: number;
  lastSeen: number;
}

interface ClusterRecord {
  object: EnvironmentObject;
  hits: number;
  lastSeen: number;
}

export interface EnvironmentModelOptions {
  maxPoints?: number;
  maxSurfaces?: number;
  maxObjects?: number;
  maxFreeSpace?: number;
  pointLifetimeMs?: number;
  minPlanePoints?: number;
  minClusterPoints?: number;
  analysisMinIntervalMs?: number;
}

const DEFAULTS = {
  maxPoints: 900,
  maxSurfaces: 12,
  maxObjects: 16,
  maxFreeSpace: 64,
  pointLifetimeMs: 15_000,
  minPlanePoints: 12,
  minClusterPoints: 6,
  analysisMinIntervalMs: 200,
};

function validVector(value: unknown, length = 3): value is number[] {
  return Array.isArray(value) && value.length === length && value.every(Number.isFinite);
}

function subtract(a: Vec3Tuple, b: Vec3Tuple): Vec3Tuple {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function dot(a: Vec3Tuple, b: Vec3Tuple): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function cross(a: Vec3Tuple, b: Vec3Tuple): Vec3Tuple {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function length(value: Vec3Tuple): number {
  return Math.hypot(...value);
}

function unit(value: Vec3Tuple): Vec3Tuple | null {
  const magnitude = length(value);
  return magnitude > 1e-9 ? value.map((entry) => entry / magnitude) as Vec3Tuple : null;
}

function planarHull(records: PointRecord[], normal: Vec3Tuple, center: Vec3Tuple): { vertices: number[]; indices: number[] } | null {
  const dominant = Math.abs(normal[0]) < Math.abs(normal[1]) ? (Math.abs(normal[0]) < Math.abs(normal[2]) ? 0 : 2) : (Math.abs(normal[1]) < Math.abs(normal[2]) ? 1 : 2);
  const axis: Vec3Tuple = [0, 0, 0];
  axis[dominant] = 1;
  const u = unit(cross(normal, axis));
  if (!u) return null;
  const v = cross(normal, u);
  const projected = records.map((record, index) => ({
    index,
    x: dot(subtract(record.point.position, center), u),
    y: dot(subtract(record.point.position, center), v),
  })).sort((first, second) => first.x - second.x || first.y - second.y || first.index - second.index);
  const turn = (origin: typeof projected[number], first: typeof projected[number], second: typeof projected[number]): number =>
    (first.x - origin.x) * (second.y - origin.y) - (first.y - origin.y) * (second.x - origin.x);
  const lower: typeof projected = [];
  for (const point of projected) {
    while (lower.length >= 2 && turn(lower[lower.length - 2], lower[lower.length - 1], point) <= 1e-9) lower.pop();
    lower.push(point);
  }
  const upper: typeof projected = [];
  for (let index = projected.length - 1; index >= 0; index -= 1) {
    const point = projected[index];
    while (upper.length >= 2 && turn(upper[upper.length - 2], upper[upper.length - 1], point) <= 1e-9) upper.pop();
    upper.push(point);
  }
  lower.pop();
  upper.pop();
  const hull = [...lower, ...upper];
  if (hull.length < 3) return null;
  return {
    vertices: hull.flatMap((point) => records[point.index].point.position),
    indices: Array.from({ length: hull.length - 2 }, (_, index) => [0, index + 1, index + 2]).flat(),
  };
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

function boundedInteger(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
  return Number.isFinite(value) ? Math.max(minimum, Math.min(maximum, Math.floor(value as number))) : fallback;
}

export function validateCameraIntrinsics(value: CameraIntrinsics, width?: number, height?: number): value is CameraIntrinsics {
  return Boolean(
    value &&
    Number.isInteger(value.width) && value.width > 0 && value.width <= 1280 &&
    Number.isInteger(value.height) && value.height > 0 && value.height <= 720 &&
    (width === undefined || value.width === width) && (height === undefined || value.height === height) &&
    Number.isFinite(value.fx) && value.fx > 1 && Number.isFinite(value.fy) && value.fy > 1 &&
    Number.isFinite(value.cx) && value.cx >= 0 && value.cx <= value.width &&
    Number.isFinite(value.cy) && value.cy >= 0 && value.cy <= value.height &&
    Number.isFinite(value.timestamp) &&
    (value.calibration === 'estimated' || value.calibration === 'calibrated'),
  );
}

export function estimateCameraIntrinsics(width: number, height: number, timestamp: number, verticalFovDegrees = 65): CameraIntrinsics {
  const focal = height / (2 * Math.tan(clamp(verticalFovDegrees, 25, 110) * Math.PI / 360));
  return { width, height, fx: focal, fy: focal, cx: width / 2, cy: height / 2, timestamp, calibration: 'estimated' };
}

export function hasUsableDepth(depth: CompanionSpatialSample['depth']): boolean {
  if (
    !depth || !Number.isInteger(depth.width) || !Number.isInteger(depth.height) ||
    depth.width < 1 || depth.height < 1 || depth.width > 512 || depth.height > 512 || depth.width * depth.height > 262_144 ||
    !(depth.values instanceof Float32Array) || !(depth.confidence instanceof Float32Array) ||
    depth.values.length !== depth.width * depth.height || depth.confidence.length !== depth.values.length ||
    !depth.intrinsics || depth.intrinsics.calibration !== 'calibrated' || !validateCameraIntrinsics(depth.intrinsics, depth.width, depth.height)
  ) return false;
  const stride = Math.max(1, Math.ceil(Math.sqrt(depth.values.length / 768)));
  for (let y = Math.floor(stride / 2); y < depth.height; y += stride) {
    for (let x = Math.floor(stride / 2); x < depth.width; x += stride) {
      const index = y * depth.width + x;
      const range = depth.values[index];
      if (Number.isFinite(range) && range >= 0.05 && range <= 30 && Number.isFinite(depth.confidence[index]) && depth.confidence[index] >= 0.45) return true;
    }
  }
  return false;
}

export class EnvironmentModel {
  private readonly options: Required<EnvironmentModelOptions>;
  private readonly localPoints = new Map<number, PointRecord>();
  private readonly metricPoints = new Map<number, PointRecord>();
  private planes: PlaneRecord[] = [];
  private clusters: ClusterRecord[] = [];
  private companionSurfaces: SpatialSurface[] = [];
  private companionObjects: EnvironmentObject[] = [];
  private companionFreeSpace: FreeSpaceCell[] = [];
  private metricActive = false;
  private nextSurfaceId = 1;
  private nextObjectId = 1;
  private lastAnalysisTimestamp = Number.NEGATIVE_INFINITY;
  private lastSnapshot: EnvironmentSnapshot = { points: [], surfaces: [], objects: [], freeSpace: [] };

  constructor(options: EnvironmentModelOptions = {}) {
    this.options = {
      maxPoints: boundedInteger(options.maxPoints, DEFAULTS.maxPoints, 1, 10_000),
      maxSurfaces: boundedInteger(options.maxSurfaces, DEFAULTS.maxSurfaces, 1, 128),
      maxObjects: boundedInteger(options.maxObjects, DEFAULTS.maxObjects, 1, 256),
      maxFreeSpace: boundedInteger(options.maxFreeSpace, DEFAULTS.maxFreeSpace, 1, 1024),
      pointLifetimeMs: boundedInteger(options.pointLifetimeMs, DEFAULTS.pointLifetimeMs, 1, 60_000),
      minPlanePoints: boundedInteger(options.minPlanePoints, DEFAULTS.minPlanePoints, 3, 512),
      minClusterPoints: boundedInteger(options.minClusterPoints, DEFAULTS.minClusterPoints, 2, 512),
      analysisMinIntervalMs: boundedInteger(options.analysisMinIntervalMs, DEFAULTS.analysisMinIntervalMs, 0, 10_000),
    };
  }

  clear(): void {
    this.localPoints.clear();
    this.metricPoints.clear();
    this.planes = [];
    this.clusters = [];
    this.companionSurfaces = [];
    this.companionObjects = [];
    this.companionFreeSpace = [];
    this.lastAnalysisTimestamp = Number.NEGATIVE_INFINITY;
    this.lastSnapshot = { points: [], surfaces: [], objects: [], freeSpace: [] };
  }

  setMetricActive(active: boolean): void {
    if (this.metricActive === active) return;
    this.metricActive = active;
    this.lastAnalysisTimestamp = Number.NEGATIVE_INFINITY;
    this.lastSnapshot = { points: [], surfaces: [], objects: [], freeSpace: [] };
    if (active) {
      this.localPoints.clear();
      this.planes = [];
      this.clusters = [];
    } else {
      this.metricPoints.clear();
      this.companionSurfaces = [];
      this.companionObjects = [];
      this.companionFreeSpace = [];
    }
  }

  observePoints(points: SpatialPoint[]): void {
    if (this.metricActive) return;
    for (const candidate of points) {
      if (!Number.isInteger(candidate.id) || candidate.id < 0 || !validVector(candidate.position) || !Number.isFinite(candidate.observedAt) || candidate.observedAt < 0 || !Number.isFinite(candidate.confidence)) continue;
      if (
        candidate.scale !== 'relative' || (candidate.source !== 'visual' && candidate.source !== 'camera-fusion') ||
        length(candidate.position as Vec3Tuple) > 1e4 || candidate.confidence < 0.05 || candidate.confidence > 1
      ) continue;
      const existing = this.localPoints.get(candidate.id);
      if (existing && candidate.observedAt <= existing.point.observedAt) continue;
      const point: SpatialPoint = {
        id: candidate.id,
        position: [...candidate.position],
        confidence: clamp(candidate.confidence, 0, 1),
        observedAt: candidate.observedAt,
        source: candidate.source,
        scale: 'relative',
      };
      if (existing) {
        const blend = clamp(0.35 + existing.observations * 0.05, 0.35, 0.7);
        point.position = point.position.map((value, index) => existing.point.position[index] * (1 - blend) + value * blend) as Vec3Tuple;
        this.localPoints.set(point.id, { point, observations: existing.observations + 1, firstObservedAt: existing.firstObservedAt });
      } else {
        this.localPoints.set(point.id, { point, observations: 1, firstObservedAt: point.observedAt });
      }
    }
    this.pruneAndBound(this.localPoints);
  }

  observeCompanion(sample: CompanionSpatialSample): EnvironmentSnapshot {
    this.metricPoints.clear();
    this.companionSurfaces = this.sanitizeSurfaces(sample.surfaces, sample.timestamp);
    this.companionObjects = this.sanitizeObjects(sample.objects, sample.timestamp);
    this.companionFreeSpace = this.sanitizeFreeSpace(sample.freeSpace, sample.timestamp);
    if (sample.depth) this.observeDepth(sample);
    this.pruneAndBound(this.metricPoints);
    this.lastAnalysisTimestamp = sample.timestamp;
    this.lastSnapshot = this.metricSnapshot();
    return this.lastSnapshot;
  }

  rebuild(timestamp: number, capabilities: SpatialCapabilities): EnvironmentSnapshot {
    this.pruneAndBound(this.localPoints, timestamp);
    this.pruneAndBound(this.metricPoints, timestamp);
    if (this.metricActive) {
      this.lastSnapshot = this.metricSnapshot();
      this.lastAnalysisTimestamp = timestamp;
      return this.lastSnapshot;
    }

    const records = [...this.localPoints.values()];
    const points = records.map((record): SpatialPoint => ({ ...record.point, position: [...record.point.position] })).slice(0, this.options.maxPoints);
    if (!capabilities.relativeDepth || !capabilities.planes) {
      this.planes = [];
      this.clusters = [];
      this.lastSnapshot = { points, surfaces: [], objects: [], freeSpace: [] };
      return this.lastSnapshot;
    }
    this.planes = this.planes.filter((plane) => timestamp - plane.lastSeen < 1500);
    this.clusters = this.clusters.filter((cluster) => timestamp - cluster.lastSeen < 1500);
    const minimumRecords = Math.min(this.options.minPlanePoints, this.options.minClusterPoints);
    if (records.length >= minimumRecords && timestamp - this.lastAnalysisTimestamp >= this.options.analysisMinIntervalMs) {
      const stable = records.filter((record) => record.observations >= 2);
      const stride = Math.max(1, Math.ceil(stable.length / 256));
      const analysisRecords = stable.filter((_, index) => index % stride === 0).slice(0, 256);
      const { surface, inlierIds } = this.fitPlane(analysisRecords, timestamp);
      this.fitClusters(analysisRecords.filter((record) => !inlierIds.has(record.point.id)), timestamp, surface);
      this.lastAnalysisTimestamp = timestamp;
    }
    this.lastSnapshot = {
      points,
      surfaces: this.cloneSurfaces(this.planes.filter((plane) => plane.hits >= 2).map((plane) => plane.surface).slice(0, this.options.maxSurfaces)),
      objects: this.cloneObjects(this.clusters.filter((cluster) => cluster.hits >= 2).map((cluster) => cluster.object).slice(0, this.options.maxObjects)),
      freeSpace: [],
    };
    return this.lastSnapshot;
  }

  private metricSnapshot(): EnvironmentSnapshot {
    return {
      points: [...this.metricPoints.values()].map((record): SpatialPoint => ({ ...record.point, position: [...record.point.position] })).slice(0, this.options.maxPoints),
      surfaces: this.cloneSurfaces(this.companionSurfaces),
      objects: this.cloneObjects(this.companionObjects),
      freeSpace: this.companionFreeSpace.map((cell) => ({ ...cell, center: [...cell.center], extents: [...cell.extents] })),
    };
  }

  private cloneSurfaces(surfaces: SpatialSurface[]): SpatialSurface[] {
    return surfaces.map((surface) => ({
      ...surface,
      normal: surface.normal ? [...surface.normal] : undefined,
      point: surface.point ? [...surface.point] : undefined,
      vertices: surface.vertices ? [...surface.vertices] : undefined,
      indices: surface.indices ? [...surface.indices] : undefined,
      covariance: surface.covariance ? [...surface.covariance] : undefined,
    }));
  }

  private cloneObjects(objects: EnvironmentObject[]): EnvironmentObject[] {
    return objects.map((object) => ({ ...object, center: [...object.center], extents: [...object.extents], pointIds: [...object.pointIds] }));
  }

  private fitPlane(records: PointRecord[], timestamp: number): { surface: SpatialSurface | null; inlierIds: Set<number> } {
    const empty = { surface: null, inlierIds: new Set<number>() };
    if (records.length < this.options.minPlanePoints) {
      this.planes = this.planes.filter((plane) => timestamp - plane.lastSeen < 1500);
      return empty;
    }
    const ranges = records.map((record) => length(record.point.position as Vec3Tuple));
    const threshold = Math.max(0.025, Math.min(0.3, median(ranges) * 0.025));
    const random = seededRandom(0x51a7 + records.length);
    let bestNormal: Vec3Tuple | null = null;
    let bestPoint: Vec3Tuple | null = null;
    let bestIds = new Set<number>();
    for (let iteration = 0; iteration < 96; iteration += 1) {
      const a = records[Math.floor(random() * records.length)].point.position;
      const b = records[Math.floor(random() * records.length)].point.position;
      const c = records[Math.floor(random() * records.length)].point.position;
      const normal = unit(cross(subtract(b, a), subtract(c, a)));
      if (!normal || length(subtract(b, a)) < threshold || length(subtract(c, a)) < threshold) continue;
      const ids = new Set<number>();
      for (const record of records) {
        if (Math.abs(dot(normal, subtract(record.point.position, a))) <= threshold) ids.add(record.point.id);
      }
      if (ids.size > bestIds.size) {
        bestNormal = normal;
        bestPoint = a;
        bestIds = ids;
      }
    }
    const minimumSupport = Math.max(this.options.minPlanePoints, Math.ceil(records.length * 0.35));
    if (!bestNormal || !bestPoint || bestIds.size < minimumSupport) {
      this.planes = this.planes.filter((plane) => timestamp - plane.lastSeen < 1500);
      return empty;
    }

    const inliers = records.filter((record) => bestIds.has(record.point.id));
    const center = inliers.reduce<Vec3Tuple>((sum, record) => sum.map((value, index) => value + record.point.position[index] / inliers.length) as Vec3Tuple, [0, 0, 0]);
    const covariance = new Array<number>(9).fill(0);
    let squaredError = 0;
    for (const record of inliers) {
      const error = dot(bestNormal, subtract(record.point.position, center));
      squaredError += error * error;
      for (let row = 0; row < 3; row += 1) {
        for (let column = 0; column < 3; column += 1) {
          covariance[row * 3 + column] += (record.point.position[row] - center[row]) * (record.point.position[column] - center[column]) / inliers.length;
        }
      }
    }
    const normalVariance = squaredError / inliers.length;
    for (let index = 0; index < 3; index += 1) covariance[index * 3 + index] += normalVariance + threshold * threshold;
    const matched = this.planes.find((plane) => dot(plane.normal, bestNormal) > 0.965 && length(subtract(plane.surface.point ?? center, center)) < threshold * 4);
    const id = matched?.surface.id ?? `plane-${this.nextSurfaceId++}`;
    const surface: SpatialSurface = {
      id,
      kind: 'plane',
      normal: bestNormal,
      point: center,
      confidence: clamp((bestIds.size / records.length) * Math.sqrt(Math.min(1, bestIds.size / 30)) * Math.exp(-normalVariance / (threshold * threshold)), 0, 0.98),
      covariance,
      observedAt: timestamp,
      source: 'camera-fusion',
      scale: 'relative',
    };
    const hull = planarHull(inliers, bestNormal, center);
    if (hull) {
      surface.vertices = hull.vertices;
      surface.indices = hull.indices;
    }
    const record: PlaneRecord = { surface, normal: bestNormal, hits: (matched?.hits ?? 0) + 1, lastSeen: timestamp };
    this.planes = this.planes.filter((plane) => plane !== matched);
    this.planes.push(record);
    this.planes = this.planes.slice(-this.options.maxSurfaces);
    return {
      surface: record.hits >= 2 ? surface : null,
      inlierIds: bestIds,
    };
  }

  private fitClusters(records: PointRecord[], timestamp: number, plane: SpatialSurface | null): EnvironmentObject[] {
    if (records.length < this.options.minClusterPoints) {
      this.clusters = this.clusters.filter((cluster) => timestamp - cluster.lastSeen < 1500);
      return [];
    }
    const range = median(records.map((record) => length(record.point.position as Vec3Tuple)));
    const epsilon = Math.max(0.06, Math.min(0.6, range * 0.055));
    const parents = records.map((_, index) => index);
    const find = (index: number): number => {
      let root = index;
      while (parents[root] !== root) root = parents[root];
      while (parents[index] !== index) {
        const next = parents[index];
        parents[index] = root;
        index = next;
      }
      return root;
    };
    for (let first = 0; first < records.length; first += 1) {
      for (let second = first + 1; second < records.length; second += 1) {
        if (length(subtract(records[first].point.position, records[second].point.position)) <= epsilon) {
          const a = find(first);
          const b = find(second);
          if (a !== b) parents[b] = a;
        }
      }
    }
    const groups = new Map<number, PointRecord[]>();
    records.forEach((record, index) => {
      const root = find(index);
      const group = groups.get(root) ?? [];
      group.push(record);
      groups.set(root, group);
    });
    const objects: EnvironmentObject[] = [];
    for (const group of groups.values()) {
      if (group.length < this.options.minClusterPoints) continue;
      const center = group.reduce<Vec3Tuple>((sum, record) => sum.map((value, index) => value + record.point.position[index] / group.length) as Vec3Tuple, [0, 0, 0]);
      const extents = [0, 1, 2].map((axis) => {
        const values = group.map((record) => record.point.position[axis]);
        return Math.max(...values) - Math.min(...values);
      }) as Vec3Tuple;
      const matched = this.clusters.find((cluster) => length(subtract(cluster.object.center, center)) < epsilon * 2.5);
      const hits = (matched?.hits ?? 0) + 1;
      const object: EnvironmentObject = {
        id: matched?.object.id ?? `cluster-${this.nextObjectId++}`,
        center,
        extents,
        pointIds: group.map((record) => record.point.id),
        confidence: clamp(Math.min(...group.map((record) => record.point.confidence)) * Math.min(1, group.length / 12) * (plane ? 0.85 : 1), 0, 0.9),
        observedAt: timestamp,
        source: 'camera-fusion',
        scale: 'relative',
      };
      const cluster: ClusterRecord = { object, hits, lastSeen: timestamp };
      this.clusters = this.clusters.filter((entry) => entry !== matched);
      this.clusters.push(cluster);
      if (hits >= 2) objects.push(object);
    }
    this.clusters = this.clusters.filter((cluster) => timestamp - cluster.lastSeen < 1500).slice(-this.options.maxObjects);
    return objects.slice(0, this.options.maxObjects);
  }

  private observeDepth(sample: CompanionSpatialSample): void {
    const depth = sample.depth;
    if (!depth || !depth.intrinsics || depth.intrinsics.calibration !== 'calibrated' || !validateCameraIntrinsics(depth.intrinsics, depth.width, depth.height)) return;
    if (depth.values.length !== depth.width * depth.height || depth.confidence.length !== depth.values.length) return;
    if (depth.width > 512 || depth.height > 512 || depth.width * depth.height > 262_144) return;
    const intrinsics = depth.intrinsics;
    const quaternion = normalizeQuaternion(sample.pose.quaternion);
    const stride = Math.max(1, Math.ceil(Math.sqrt(depth.values.length / 768)));
    for (let y = Math.floor(stride / 2); y < depth.height; y += stride) {
      for (let x = Math.floor(stride / 2); x < depth.width; x += stride) {
        const index = y * depth.width + x;
        const range = depth.values[index];
        const confidence = depth.confidence[index];
        if (!Number.isFinite(range) || range < 0.05 || range > 30 || !Number.isFinite(confidence) || confidence < 0.45) continue;
        const camera: Vec3Tuple = [(x - intrinsics.cx) * range / intrinsics.fx, (y - intrinsics.cy) * range / intrinsics.fy, range];
        const rotated = rotateVector(quaternion, camera);
        const position: Vec3Tuple = [rotated[0] + sample.pose.position[0], rotated[1] + sample.pose.position[1], rotated[2] + sample.pose.position[2]];
        const pointConfidence = confidence * sample.calibrationConfidence * sample.pose.confidence;
        if (!position.every(Number.isFinite) || pointConfidence < 0.05) continue;
        const id = 1_000_000 + index;
        this.metricPoints.set(id, {
          point: {
            id,
            position,
            confidence: clamp(pointConfidence, 0, 1),
            observedAt: sample.timestamp,
            source: 'companion',
            scale: 'metric',
          },
          observations: 1,
          firstObservedAt: sample.timestamp,
        });
      }
    }
  }

  private sanitizeSurfaces(surfaces: SpatialSurface[], timestamp: number): SpatialSurface[] {
    if (!Array.isArray(surfaces)) return [];
    return surfaces.filter((surface) => {
      if (!surface || typeof surface.id !== 'string' || (surface.kind !== 'plane' && surface.kind !== 'mesh')) return false;
      if (!Number.isFinite(surface.confidence) || surface.confidence < 0 || surface.confidence > 1 || !Number.isFinite(surface.observedAt) || surface.observedAt < 0 || surface.observedAt > timestamp) return false;
      if (surface.normal !== undefined && (!validVector(surface.normal) || Math.abs(length(surface.normal as Vec3Tuple) - 1) > 0.01)) return false;
      if (surface.point !== undefined && !validVector(surface.point)) return false;
      if (surface.vertices !== undefined && (!Array.isArray(surface.vertices) || surface.vertices.length > 12_000 || surface.vertices.length % 3 !== 0 || !surface.vertices.every(Number.isFinite))) return false;
      if (surface.indices !== undefined && (!Array.isArray(surface.indices) || surface.indices.length > 18_000 || surface.indices.length % 3 !== 0 || !surface.indices.every((index) => Number.isInteger(index) && index >= 0 && (!surface.vertices || index < surface.vertices.length / 3)))) return false;
      if (surface.kind === 'plane') return surface.normal !== undefined && surface.point !== undefined;
      return Boolean(surface.vertices && surface.vertices.length >= 9 && surface.indices && surface.indices.length >= 3);
    }).slice(0, this.options.maxSurfaces).map((surface) => ({
      ...surface,
      source: 'companion',
      scale: 'metric',
      normal: surface.normal ? [...surface.normal] : undefined,
      point: surface.point ? [...surface.point] : undefined,
      vertices: surface.vertices ? [...surface.vertices] : undefined,
      indices: surface.indices ? [...surface.indices] : undefined,
      covariance: surface.covariance?.length === 9 && surface.covariance.every(Number.isFinite) ? [...surface.covariance] : undefined,
    }));
  }

  private sanitizeObjects(objects: EnvironmentObject[], timestamp: number): EnvironmentObject[] {
    if (!Array.isArray(objects)) return [];
    return objects.filter((object) => (
      object && typeof object.id === 'string' && validVector(object.center) && validVector(object.extents) &&
      object.extents.every((value) => value >= 0 && value < 1e4) && Array.isArray(object.pointIds) && object.pointIds.length <= 256 &&
      object.pointIds.every((id) => Number.isInteger(id) && id >= 0) && Number.isFinite(object.confidence) && object.confidence >= 0 && object.confidence <= 1 &&
      Number.isFinite(object.observedAt) && object.observedAt >= 0 && object.observedAt <= timestamp &&
      (object.label === undefined || (typeof object.label === 'string' && object.label.length <= 80))
    )).slice(0, this.options.maxObjects).map((object) => ({
      ...object,
      label: typeof object.label === 'string' && object.label.trim() ? object.label : undefined,
      center: [...object.center],
      extents: [...object.extents],
      pointIds: [...object.pointIds],
      source: 'companion',
      scale: 'metric',
    }));
  }

  private sanitizeFreeSpace(cells: FreeSpaceCell[], timestamp: number): FreeSpaceCell[] {
    if (!Array.isArray(cells)) return [];
    return cells.filter((cell) => (
      cell && typeof cell.id === 'string' && validVector(cell.center) && validVector(cell.extents) &&
      cell.extents.every((value) => value > 0 && value < 1e4) && Number.isFinite(cell.confidence) && cell.confidence >= 0 && cell.confidence <= 1 &&
      Number.isFinite(cell.observedAt) && cell.observedAt >= 0 && cell.observedAt <= timestamp
    )).slice(0, this.options.maxFreeSpace).map((cell) => ({
      ...cell,
      center: [...cell.center],
      extents: [...cell.extents],
      source: 'companion',
      scale: 'metric',
    }));
  }

  private pruneAndBound(records: Map<number, PointRecord>, timestamp?: number): void {
    const cutoff = timestamp === undefined ? Number.POSITIVE_INFINITY : timestamp - this.options.pointLifetimeMs;
    for (const [id, record] of records) {
      if (record.point.observedAt < cutoff || (timestamp !== undefined && record.point.observedAt > timestamp)) records.delete(id);
    }
    while (records.size > this.options.maxPoints) {
      let oldestId = records.keys().next().value as number | undefined;
      let oldest = oldestId === undefined ? Number.POSITIVE_INFINITY : records.get(oldestId)?.point.observedAt ?? Number.POSITIVE_INFINITY;
      for (const [id, record] of records) {
        if (record.point.observedAt < oldest) {
          oldest = record.point.observedAt;
          oldestId = id;
        }
      }
      if (oldestId === undefined) break;
      records.delete(oldestId);
    }
  }
}
