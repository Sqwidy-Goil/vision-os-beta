import type {
  CameraIntrinsics,
  CompanionSpatialSample,
  EnvironmentObject,
  FreeSpaceCell,
  PoseSample,
  QuaternionTuple,
  SpatialSurface,
  Vec3Tuple,
} from '../intelligence/types';
import { validateCameraIntrinsics } from '../intelligence/environmentModel';
import { base64ToBytes } from './crypto';
import { assertExactKeys, CompanionProtocolError, isRecord, type DecodedCompanionFrame } from './codec';
import type { CompanionCalibrationWire, CompanionCoordinateFrame } from './types';

const MAX_WORLD_COORDINATE = 1000;
const MAX_SURFACES = 12;
const MAX_OBJECTS = 16;
const MAX_FREE_SPACE = 64;
const MAX_FRAME_INTERVAL = 1000;

export type WirePose = Pick<PoseSample, 'position' | 'quaternion' | 'velocity' | 'covariance' | 'confidence'>;
export interface CompanionPoseDelta {
  position?: Vec3Tuple;
  quaternion?: QuaternionTuple;
  velocity?: Vec3Tuple;
  covariance?: number[];
  confidence?: number;
}
type WireSurface = Omit<SpatialSurface, 'source' | 'scale'>;
type WireObject = Omit<EnvironmentObject, 'source' | 'scale'>;
type WireFreeSpace = Omit<FreeSpaceCell, 'source' | 'scale'>;

export interface CompanionDepthUpdate {
  mode: 'full' | 'rect' | 'unchanged';
  width: number;
  height: number;
  x?: number;
  y?: number;
  baseWidth?: number;
  baseHeight?: number;
  intrinsics: CameraIntrinsics;
  values?: Float32Array | string | null;
  confidence?: Float32Array | string | null;
}

export interface CompanionSpatialUpdate {
  kind: 'sample';
  frameId: number;
  timestamp: number;
  baseFrameId: number;
  reset: boolean;
  calibrationId: string;
  poseMode: 'full' | 'delta';
  pose: WirePose | CompanionPoseDelta;
  calibrationConfidence: number;
  depth?: CompanionDepthUpdate;
  surfaces?: WireSurface[];
  objects?: WireObject[];
  freeSpace?: WireFreeSpace[];
  removed?: { surfaces: string[]; objects: string[]; freeSpace: string[] };
}

interface CalibrationState {
  id: string;
  confidence: number;
  origin: Vec3Tuple;
  orientation: QuaternionTuple;
}

interface DepthState {
  width: number;
  height: number;
  values: Float32Array;
  confidence: Float32Array;
  intrinsics: CameraIntrinsics;
}

function finite(value: unknown, label: string, min = -Number.MAX_VALUE, max = Number.MAX_VALUE): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) throw new CompanionProtocolError(`Invalid companion ${label}.`);
  return value;
}

function integer(value: unknown, label: string, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) throw new CompanionProtocolError(`Invalid companion ${label}.`);
  return value;
}

function vector(value: unknown, label: string, bound = MAX_WORLD_COORDINATE): Vec3Tuple {
  if (!Array.isArray(value) || value.length !== 3) throw new CompanionProtocolError(`Invalid companion ${label}.`);
  return [finite(value[0], label, -bound, bound), finite(value[1], label, -bound, bound), finite(value[2], label, -bound, bound)];
}

function quaternion(value: unknown): QuaternionTuple {
  if (!Array.isArray(value) || value.length !== 4) throw new CompanionProtocolError('Invalid companion quaternion.');
  const output: QuaternionTuple = [finite(value[0], 'quaternion', -1, 1), finite(value[1], 'quaternion', -1, 1), finite(value[2], 'quaternion', -1, 1), finite(value[3], 'quaternion', -1, 1)];
  const length = Math.hypot(...output);
  if (Math.abs(length - 1) > 0.001) throw new CompanionProtocolError('Companion quaternion is not normalized.');
  return output.map((entry) => entry / length) as QuaternionTuple;
}

function unitVector(value: unknown): Vec3Tuple {
  const output = vector(value, 'normal');
  if (Math.abs(Math.hypot(...output) - 1) > 0.001) throw new CompanionProtocolError('Companion plane normal is not normalized.');
  return output;
}

function confidence(value: unknown): number {
  return finite(value, 'confidence', 0, 1);
}

function covariance(value: unknown, size: number): number[] {
  const length = size * size;
  if (!Array.isArray(value) || value.length !== length) throw new CompanionProtocolError('Invalid companion covariance.');
  const output = value.map((entry) => finite(entry, 'covariance'));
  const lower = new Array<number>(length).fill(0);
  for (let row = 0; row < size; row += 1) {
    if (output[row * size + row] < 0) throw new CompanionProtocolError('Companion covariance has a negative variance.');
    for (let column = row + 1; column < size; column += 1) {
      if (Math.abs(output[row * size + column] - output[column * size + row]) > 1e-6 * Math.max(1, Math.abs(output[row * size + column]), Math.abs(output[column * size + row]))) {
        throw new CompanionProtocolError('Companion covariance is not symmetric.');
      }
    }
    for (let column = 0; column <= row; column += 1) {
      let residual = output[row * size + column];
      for (let inner = 0; inner < column; inner += 1) residual -= lower[row * size + inner] * lower[column * size + inner];
      if (row === column) {
        if (residual < -1e-7) throw new CompanionProtocolError('Companion covariance is not positive semidefinite.');
        lower[row * size + column] = Math.sqrt(Math.max(0, residual));
      } else if (lower[column * size + column] < 1e-12) {
        if (Math.abs(residual) > 1e-7) throw new CompanionProtocolError('Companion covariance is not positive semidefinite.');
      } else {
        lower[row * size + column] = residual / lower[column * size + column];
      }
    }
  }
  return output;
}

function rotate(value: Vec3Tuple, orientation: QuaternionTuple): Vec3Tuple {
  const [x, y, z] = value;
  const [qx, qy, qz, qw] = orientation;
  const ix = qw * x + qy * z - qz * y;
  const iy = qw * y + qz * x - qx * z;
  const iz = qw * z + qx * y - qy * x;
  const iw = -qx * x - qy * y - qz * z;
  return [ix * qw - iy * qz + iz * qy - iw * qx, ix * qz + iy * qw - iz * qx - iw * qy, -ix * qy + iy * qx + iz * qw - iw * qz];
}

function multiply(first: QuaternionTuple, second: QuaternionTuple): QuaternionTuple {
  const [x, y, z, w] = first;
  const [bx, by, bz, bw] = second;
  return [w * bx + x * bw + y * bz - z * by, w * by - x * bz + y * bw + z * bx, w * bz + x * by - y * bx + z * bw, w * bw - x * bx - y * by - z * bz];
}

function transformPoint(value: Vec3Tuple, calibration: CalibrationState): Vec3Tuple {
  const rotated = rotate(value, calibration.orientation);
  return vector([rotated[0] + calibration.origin[0], rotated[1] + calibration.origin[1], rotated[2] + calibration.origin[2]], 'world coordinate');
}

function transformCovariance(value: number[], calibration: CalibrationState): number[] {
  const output = new Array<number>(36).fill(0);
  const rotation = calibration.orientation;
  for (let row = 0; row < 3; row += 1) {
    for (let column = 0; column < 3; column += 1) {
      const basis: Vec3Tuple = [0, 0, 0];
      basis[column] = 1;
      output[(row + 0) * 6 + column + 0] = rotate(basis, rotation)[row];
      output[(row + 3) * 6 + column + 3] = rotate(basis, rotation)[row];
    }
  }
  const transformed = new Array<number>(36).fill(0);
  for (let row = 0; row < 6; row += 1) {
    for (let column = 0; column < 6; column += 1) {
      for (let inner = 0; inner < 6; inner += 1) {
        for (let other = 0; other < 6; other += 1) transformed[row * 6 + column] += output[row * 6 + inner] * value[inner * 6 + other] * output[column * 6 + other];
      }
    }
  }
  return covariance(transformed, 6);
}

function deltaVector(value: unknown, previous: Vec3Tuple, label: string): Vec3Tuple {
  if (value === undefined) return [...previous];
  if (!Array.isArray(value) || value.length !== 3) throw new CompanionProtocolError(`Invalid companion ${label} delta.`);
  return vector([
    previous[0] + finite(value[0], `${label} delta`, -30, 30),
    previous[1] + finite(value[1], `${label} delta`, -30, 30),
    previous[2] + finite(value[2], `${label} delta`, -30, 30),
  ], label);
}

function resolvePose(value: unknown, mode: unknown, previous: WirePose | null): WirePose {
  if (mode === 'full') {
    assertExactKeys(value, ['position', 'quaternion', 'velocity', 'covariance', 'confidence'], [], 'Companion pose');
    return {
      position: vector(value.position, 'position'),
      quaternion: quaternion(value.quaternion),
      velocity: vector(value.velocity, 'velocity', 30),
      covariance: covariance(value.covariance, 6),
      confidence: confidence(value.confidence),
    };
  }
  if (mode !== 'delta') throw new CompanionProtocolError('Invalid companion pose update mode.');
  assertExactKeys(value, [], ['position', 'quaternion', 'velocity', 'covariance', 'confidence'], 'Companion pose delta');
  if (!previous || Object.keys(value).length === 0) throw new CompanionProtocolError('Companion pose delta has no matching base or changes.');
  return {
    position: deltaVector(value.position, previous.position, 'position'),
    quaternion: value.quaternion === undefined ? [...previous.quaternion] as QuaternionTuple : multiply(previous.quaternion, quaternion(value.quaternion)),
    velocity: deltaVector(value.velocity, previous.velocity, 'velocity'),
    covariance: value.covariance === undefined ? [...previous.covariance] : covariance(value.covariance, 6),
    confidence: value.confidence === undefined ? previous.confidence : confidence(value.confidence),
  };
}

function transformSurfaceCovariance(value: number[], calibration: CalibrationState): number[] {
  const axes: Vec3Tuple[] = [
    rotate([1, 0, 0], calibration.orientation),
    rotate([0, 1, 0], calibration.orientation),
    rotate([0, 0, 1], calibration.orientation),
  ];
  const output = new Array<number>(9).fill(0);
  for (let row = 0; row < 3; row += 1) {
    for (let column = 0; column < 3; column += 1) {
      for (let inner = 0; inner < 3; inner += 1) {
        for (let other = 0; other < 3; other += 1) output[row * 3 + column] += axes[row][inner] * value[inner * 3 + other] * axes[column][other];
      }
    }
  }
  return covariance(output, 3);
}

function transformExtents(value: unknown, label: string, calibration: CalibrationState, positive: boolean): Vec3Tuple {
  const extents = vector(value, label);
  if (extents.some((entry) => positive ? entry <= 0 : entry < 0)) throw new CompanionProtocolError(`Companion ${label} has invalid bounds.`);
  const axes: Vec3Tuple[] = [
    rotate([1, 0, 0], calibration.orientation),
    rotate([0, 1, 0], calibration.orientation),
    rotate([0, 0, 1], calibration.orientation),
  ];
  return vector([
    Math.abs(axes[0][0]) * extents[0] + Math.abs(axes[1][0]) * extents[1] + Math.abs(axes[2][0]) * extents[2],
    Math.abs(axes[0][1]) * extents[0] + Math.abs(axes[1][1]) * extents[1] + Math.abs(axes[2][1]) * extents[2],
    Math.abs(axes[0][2]) * extents[0] + Math.abs(axes[1][2]) * extents[1] + Math.abs(axes[2][2]) * extents[2],
  ], label);
}

function parsePose(value: unknown, calibration: CalibrationState, frameId: number, timestamp: number): PoseSample {
  if (!isRecord(value)) throw new CompanionProtocolError('Invalid companion pose.');
  const position = vector(value.position, 'position');
  const orientation = quaternion(value.quaternion);
  const velocity = vector(value.velocity, 'velocity', 30);
  return {
    frameId,
    timestamp,
    position: transformPoint(position, calibration),
    quaternion: multiply(calibration.orientation, orientation),
    velocity: rotate(velocity, calibration.orientation) as Vec3Tuple,
    covariance: transformCovariance(covariance(value.covariance, 6), calibration),
    confidence: confidence(value.confidence),
    scale: 'metric',
    source: 'companion',
  };
}

function identifier(value: unknown): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 80 || !/^[A-Za-z0-9._:-]+$/.test(value)) throw new CompanionProtocolError('Invalid companion identifier.');
  return value;
}

function parseSurface(value: unknown, timestamp: number, calibration: CalibrationState): SpatialSurface {
  assertExactKeys(value, ['id', 'kind', 'confidence', 'observedAt'], ['normal', 'point', 'vertices', 'indices', 'covariance'], 'Companion surface');
  const id = identifier(value.id);
  if (value.kind !== 'plane' && value.kind !== 'mesh') throw new CompanionProtocolError('Invalid companion surface kind.');
  if (finite(value.observedAt, 'observation timestamp') !== timestamp) throw new CompanionProtocolError('Companion surface timestamp does not match its frame.');
  const normal = value.normal === undefined ? undefined : rotate(unitVector(value.normal), calibration.orientation) as Vec3Tuple;
  const point = value.point === undefined ? undefined : transformPoint(vector(value.point, 'surface point'), calibration);
  let vertices: number[] | undefined;
  let indices: number[] | undefined;
  if (value.kind === 'plane') {
    if (!normal || !point || value.vertices !== undefined || value.indices !== undefined) throw new CompanionProtocolError('Companion planes require a normal and point only.');
  } else {
    if (!Array.isArray(value.vertices) || value.vertices.length < 3 || value.vertices.length > 12_000 || value.vertices.length % 3 !== 0 ||
      !Array.isArray(value.indices) || value.indices.length < 3 || value.indices.length > 18_000 || value.indices.length % 3 !== 0) {
      throw new CompanionProtocolError('Invalid simplified companion mesh.');
    }
    const rawVertices = value.vertices as unknown[];
    const rawIndices = value.indices as unknown[];
    vertices = [];
    for (let index = 0; index < rawVertices.length; index += 3) {
      const transformed = transformPoint([finite(rawVertices[index], 'mesh vertex', -MAX_WORLD_COORDINATE, MAX_WORLD_COORDINATE), finite(rawVertices[index + 1], 'mesh vertex', -MAX_WORLD_COORDINATE, MAX_WORLD_COORDINATE), finite(rawVertices[index + 2], 'mesh vertex', -MAX_WORLD_COORDINATE, MAX_WORLD_COORDINATE)] as Vec3Tuple, calibration);
      vertices.push(...transformed);
    }
    indices = rawIndices.map((entry) => integer(entry, 'mesh index', 0, rawVertices.length / 3 - 1));
  }
  return {
    id,
    kind: value.kind,
    normal,
    point,
    vertices,
    indices,
    confidence: confidence(value.confidence),
    covariance: value.covariance === undefined ? undefined : transformSurfaceCovariance(covariance(value.covariance, 3), calibration),
    observedAt: timestamp,
    source: 'companion',
    scale: 'metric',
  };
}

function parseObject(value: unknown, timestamp: number, calibration: CalibrationState): EnvironmentObject {
  assertExactKeys(value, ['id', 'center', 'extents', 'pointIds', 'confidence', 'observedAt'], ['label'], 'Companion object');
  if (!Array.isArray(value.pointIds) || value.pointIds.length > 256) throw new CompanionProtocolError('Invalid companion object points.');
  if (value.label !== undefined && (typeof value.label !== 'string' || value.label.length > 80)) throw new CompanionProtocolError('Invalid companion object label.');
  if (finite(value.observedAt, 'observation timestamp') !== timestamp) throw new CompanionProtocolError('Companion object timestamp does not match its frame.');
  const extents = transformExtents(value.extents, 'object extents', calibration, false);
  return {
    id: identifier(value.id),
    label: value.label as string | undefined,
    center: transformPoint(vector(value.center, 'object center'), calibration),
    extents,
    pointIds: value.pointIds.map((entry) => integer(entry, 'object point identifier')),
    confidence: confidence(value.confidence),
    observedAt: timestamp,
    source: 'companion',
    scale: 'metric',
  };
}

function parseFreeSpace(value: unknown, timestamp: number, calibration: CalibrationState): FreeSpaceCell {
  assertExactKeys(value, ['id', 'center', 'extents', 'confidence', 'observedAt'], [], 'Companion free-space cell');
  const extents = transformExtents(value.extents, 'free-space extents', calibration, true);
  if (finite(value.observedAt, 'observation timestamp') !== timestamp) throw new CompanionProtocolError('Companion free-space timestamp does not match its frame.');
  return {
    id: identifier(value.id),
    center: transformPoint(vector(value.center, 'free-space center'), calibration),
    extents,
    confidence: confidence(value.confidence),
    observedAt: timestamp,
    source: 'companion',
    scale: 'metric',
  };
}

function parseIntrinsics(value: unknown, width: number, height: number, timestamp: number, current: boolean): CameraIntrinsics {
  assertExactKeys(value, ['width', 'height', 'fx', 'fy', 'cx', 'cy', 'timestamp', 'calibration'], [], 'Companion camera intrinsics');
  const intrinsics = value as unknown as CameraIntrinsics;
  if (!validateCameraIntrinsics(intrinsics, width, height) || intrinsics.calibration !== 'calibrated' ||
    (current ? intrinsics.timestamp !== timestamp : intrinsics.timestamp > timestamp)) {
    throw new CompanionProtocolError('Companion depth requires matching calibrated camera intrinsics.');
  }
  return { ...intrinsics };
}

function matchingIntrinsics(first: CameraIntrinsics, second: CameraIntrinsics): boolean {
  return first.width === second.width && first.height === second.height && first.fx === second.fx && first.fy === second.fy &&
    first.cx === second.cx && first.cy === second.cy && first.calibration === second.calibration;
}

function float32FromBytes(bytes: Uint8Array, expected: number): Float32Array {
  if (bytes.byteLength !== expected * 4) throw new CompanionProtocolError('Companion depth array length mismatch.');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const output = new Float32Array(expected);
  for (let index = 0; index < expected; index += 1) output[index] = view.getFloat32(index * 4, true);
  return output;
}

function float32Array(value: unknown, expected: number, label: string): Float32Array {
  if (typeof value === 'string') return float32FromBytes(base64ToBytes(value), expected);
  if (value instanceof Float32Array) return float32FromBytes(new Uint8Array(value.buffer, value.byteOffset, value.byteLength), expected);
  throw new CompanionProtocolError(`Invalid companion depth ${label}.`);
}

function validateDepthValues(values: Float32Array, confidence: Float32Array): void {
  let usable = 0;
  for (let index = 0; index < values.length; index += 1) {
    const range = values[index];
    const certain = confidence[index];
    if (!Number.isFinite(range) || !Number.isFinite(certain) || certain < 0 || certain > 1 || (range !== 0 && (range < 0.05 || range > 30))) {
      throw new CompanionProtocolError('Companion depth contains invalid or out-of-bounds samples.');
    }
    if (range >= 0.05 && certain >= 0.45) usable += 1;
  }
  if (usable === 0) throw new CompanionProtocolError('Companion depth contains no usable samples.');
}

function parseDepth(value: unknown, timestamp: number, previous: DepthState | undefined, frame: DecodedCompanionFrame): DepthState | undefined {
  if (value === undefined) return previous;
  assertExactKeys(value, ['mode', 'width', 'height', 'intrinsics'], ['x', 'y', 'baseWidth', 'baseHeight', 'values', 'confidence'], 'Companion depth update');
  if (value.mode !== 'full' && value.mode !== 'rect' && value.mode !== 'unchanged') throw new CompanionProtocolError('Invalid companion depth update mode.');
  if (value.mode === 'rect') {
    if (value.x === undefined || value.y === undefined || value.baseWidth === undefined || value.baseHeight === undefined) throw new CompanionProtocolError('Depth rectangles require bounds and a base resolution.');
  } else if (value.x !== undefined || value.y !== undefined || value.baseWidth !== undefined || value.baseHeight !== undefined) {
    throw new CompanionProtocolError('Full or unchanged depth must not include rectangle bounds.');
  }
  const fullWidth = value.mode === 'rect' ? integer(value.baseWidth, 'base depth width', 1, 512) : integer(value.width, 'depth width', 1, 512);
  const fullHeight = value.mode === 'rect' ? integer(value.baseHeight, 'base depth height', 1, 512) : integer(value.height, 'depth height', 1, 512);
  if (fullWidth * fullHeight > 262_144) throw new CompanionProtocolError('Companion depth resolution exceeds its limit.');
  const intrinsics = parseIntrinsics(value.intrinsics, fullWidth, fullHeight, timestamp, value.mode !== 'unchanged');
  if (value.mode === 'unchanged') {
    if (!previous || previous.width !== fullWidth || previous.height !== fullHeight || value.values !== undefined || value.confidence !== undefined ||
      previous.intrinsics.timestamp !== intrinsics.timestamp || !matchingIntrinsics(previous.intrinsics, intrinsics)) {
      throw new CompanionProtocolError('Unchanged depth has no matching base frame or intrinsics.');
    }
    return previous;
  }
  const x = value.mode === 'rect' ? integer(value.x, 'depth patch x', 0, fullWidth - 1) : 0;
  const y = value.mode === 'rect' ? integer(value.y, 'depth patch y', 0, fullHeight - 1) : 0;
  const patchWidth = value.mode === 'rect' ? integer(value.width, 'depth patch width', 1, fullWidth - x) : fullWidth;
  const patchHeight = value.mode === 'rect' ? integer(value.height, 'depth patch height', 1, fullHeight - y) : fullHeight;
  if (value.mode === 'rect' && (!previous || previous.width !== fullWidth || previous.height !== fullHeight || !matchingIntrinsics(previous.intrinsics, intrinsics))) {
    throw new CompanionProtocolError('Depth rectangle has no matching base frame or intrinsics.');
  }
  const count = patchWidth * patchHeight;
  let values: Float32Array;
  let confidence: Float32Array;
  if (value.values === null && value.confidence === null) {
    if (frame.header.depthEncoding !== 'float32le' || frame.depthChunk.byteLength !== count * 8) throw new CompanionProtocolError('Binary companion depth chunk length mismatch.');
    values = float32FromBytes(frame.depthChunk.subarray(0, count * 4), count);
    confidence = float32FromBytes(frame.depthChunk.subarray(count * 4), count);
  } else {
    if (frame.header.depthEncoding !== 'base64' || frame.depthChunk.byteLength !== 0 || typeof value.values !== 'string' || typeof value.confidence !== 'string') {
      throw new CompanionProtocolError('Companion depth arrays do not match their wire encoding.');
    }
    values = float32Array(value.values, count, 'values');
    confidence = float32Array(value.confidence, count, 'confidence');
  }
  const fullValues = previous && value.mode === 'rect' ? previous.values.slice() : new Float32Array(fullWidth * fullHeight);
  const fullConfidence = previous && value.mode === 'rect' ? previous.confidence.slice() : new Float32Array(fullWidth * fullHeight);
  for (let row = 0; row < patchHeight; row += 1) {
    for (let column = 0; column < patchWidth; column += 1) {
      const source = row * patchWidth + column;
      const target = (y + row) * fullWidth + x + column;
      fullValues[target] = values[source];
      fullConfidence[target] = confidence[source];
    }
  }
  validateDepthValues(fullValues, fullConfidence);
  return {
    width: fullWidth,
    height: fullHeight,
    values: fullValues,
    confidence: fullConfidence,
    intrinsics: value.mode === 'rect' && previous ? previous.intrinsics : intrinsics,
  };
}

function surfaceWire(surface: SpatialSurface): WireSurface {
  return {
    id: surface.id,
    kind: surface.kind,
    normal: surface.normal ? [...surface.normal] : undefined,
    point: surface.point ? [...surface.point] : undefined,
    vertices: surface.vertices ? [...surface.vertices] : undefined,
    indices: surface.indices ? [...surface.indices] : undefined,
    confidence: surface.confidence,
    covariance: surface.covariance ? [...surface.covariance] : undefined,
    observedAt: surface.observedAt,
  };
}

export function fullSpatialUpdate(sample: CompanionSpatialSample, calibrationId: string): CompanionSpatialUpdate {
  return {
    kind: 'sample',
    frameId: sample.frameId,
    timestamp: sample.timestamp,
    baseFrameId: 0,
    reset: true,
    calibrationId,
    poseMode: 'full',
    pose: {
      position: [...sample.pose.position],
      quaternion: [...sample.pose.quaternion],
      velocity: [...sample.pose.velocity],
      covariance: [...sample.pose.covariance],
      confidence: sample.pose.confidence,
    },
    calibrationConfidence: sample.calibrationConfidence,
    depth: sample.depth ? {
      mode: 'full',
      width: sample.depth.width,
      height: sample.depth.height,
      intrinsics: { ...sample.depth.intrinsics },
      values: sample.depth.values.slice(),
      confidence: sample.depth.confidence.slice(),
    } : undefined,
    surfaces: sample.surfaces.map(surfaceWire),
    objects: sample.objects.map((object) => ({ id: object.id, label: object.label, center: [...object.center], extents: [...object.extents], pointIds: [...object.pointIds], confidence: object.confidence, observedAt: object.observedAt })),
    freeSpace: sample.freeSpace.map((cell) => ({ id: cell.id, center: [...cell.center], extents: [...cell.extents], confidence: cell.confidence, observedAt: cell.observedAt })),
  };
}

function uniqueIds(values: unknown[], label: string): string[] {
  const output = values.map(identifier);
  if (new Set(output).size !== output.length) throw new CompanionProtocolError(`Duplicate companion ${label} identifiers.`);
  return output;
}

export class CompanionSampleDecoder {
  private calibration: CalibrationState | null = null;
  private frameId = 0;
  private timestamp = 0;
  private lastPose: WirePose | null = null;
  private depth: DepthState | undefined;
  private surfaces = new Map<string, SpatialSurface>();
  private objects = new Map<string, EnvironmentObject>();
  private freeSpace = new Map<string, FreeSpaceCell>();

  setCalibration(value: CompanionCalibrationWire): { id: string; confidence: number; frame: CompanionCoordinateFrame } {
    assertExactKeys(value, ['kind', 'calibrationId', 'confidence', 'frame', 'depthUnits', 'origin', 'orientation'], [], 'Companion calibration');
    if (value.kind !== 'calibration' || value.frame !== 'world-y-up-right-handed' || value.depthUnits !== 'meters') throw new CompanionProtocolError('Unsupported companion coordinate calibration.');
    const calibration: CalibrationState = {
      id: identifier(value.calibrationId),
      confidence: finite(value.confidence, 'calibration confidence', 0.65, 1),
      origin: vector(value.origin, 'calibration origin', 100),
      orientation: quaternion(value.orientation),
    };
    this.calibration = calibration;
    this.frameId = 0;
    this.timestamp = 0;
    this.lastPose = null;
    this.depth = undefined;
    this.surfaces.clear();
    this.objects.clear();
    this.freeSpace.clear();
    return { id: calibration.id, confidence: calibration.confidence, frame: value.frame };
  }

  decode(value: Record<string, unknown>, frame: DecodedCompanionFrame): CompanionSpatialSample {
    const calibration = this.calibration;
    if (!calibration) throw new CompanionProtocolError('Companion sample arrived before coordinate calibration.');
    assertExactKeys(value, ['kind', 'frameId', 'timestamp', 'baseFrameId', 'reset', 'calibrationId', 'poseMode', 'pose', 'calibrationConfidence'], ['depth', 'surfaces', 'objects', 'freeSpace', 'removed'], 'Companion sample');
    if (value.kind !== 'sample' || typeof value.reset !== 'boolean' || value.calibrationId !== calibration.id) throw new CompanionProtocolError('Companion sample does not match its calibration.');
    const frameId = integer(value.frameId, 'frame identifier', 1);
    const timestamp = finite(value.timestamp, 'sample timestamp', 0);
    const baseFrameId = integer(value.baseFrameId, 'base frame identifier');
    if (frameId <= this.frameId || timestamp <= this.timestamp || timestamp - this.timestamp > MAX_FRAME_INTERVAL) throw new CompanionProtocolError('Companion sample sequence or timestamp is stale.');
    const reset = value.reset;
    if (reset && (baseFrameId !== 0 || value.poseMode !== 'full' || value.removed !== undefined || value.surfaces === undefined || value.objects === undefined || value.freeSpace === undefined)) {
      throw new CompanionProtocolError('Full companion samples require complete environment arrays.');
    }
    if (!reset && (this.frameId === 0 || baseFrameId !== this.frameId || value.depth === undefined && value.surfaces === undefined && value.objects === undefined && value.freeSpace === undefined && value.removed === undefined)) {
      throw new CompanionProtocolError('Companion incremental sample has an invalid base or no changes.');
    }
    const calibrationConfidence = finite(value.calibrationConfidence, 'calibration confidence', 0.65, 1);
    const resolvedPose = resolvePose(value.pose, value.poseMode, reset ? null : this.lastPose);
    const pose = parsePose(resolvedPose, calibration, frameId, timestamp);
    const depthState = parseDepth(value.depth, timestamp, reset ? undefined : this.depth, frame);
    const depth = isRecord(value.depth) && value.depth.mode === 'unchanged' ? undefined : depthState;
    const nextSurfaces = reset ? new Map<string, SpatialSurface>() : new Map(this.surfaces);
    const nextObjects = reset ? new Map<string, EnvironmentObject>() : new Map(this.objects);
    const nextFreeSpace = reset ? new Map<string, FreeSpaceCell>() : new Map(this.freeSpace);
    if (value.removed !== undefined) {
      assertExactKeys(value.removed, ['surfaces', 'objects', 'freeSpace'], [], 'Companion removals');
      if (!Array.isArray(value.removed.surfaces) || !Array.isArray(value.removed.objects) || !Array.isArray(value.removed.freeSpace)) throw new CompanionProtocolError('Companion removals must be arrays.');
      for (const id of uniqueIds(value.removed.surfaces, 'surface removal')) nextSurfaces.delete(id);
      for (const id of uniqueIds(value.removed.objects, 'object removal')) nextObjects.delete(id);
      for (const id of uniqueIds(value.removed.freeSpace, 'free-space removal')) nextFreeSpace.delete(id);
    }
    if (value.surfaces !== undefined) {
      if (!Array.isArray(value.surfaces) || value.surfaces.length > MAX_SURFACES) throw new CompanionProtocolError('Too many companion surfaces.');
      const ids = uniqueIds(value.surfaces.map((entry) => isRecord(entry) ? entry.id : undefined), 'surface');
      const parsed = value.surfaces.map((entry) => parseSurface(entry, timestamp, calibration));
      ids.forEach((id, index) => nextSurfaces.set(id, parsed[index]));
    }
    if (value.objects !== undefined) {
      if (!Array.isArray(value.objects) || value.objects.length > MAX_OBJECTS) throw new CompanionProtocolError('Too many companion objects.');
      const ids = uniqueIds(value.objects.map((entry) => isRecord(entry) ? entry.id : undefined), 'object');
      const parsed = value.objects.map((entry) => parseObject(entry, timestamp, calibration));
      ids.forEach((id, index) => nextObjects.set(id, parsed[index]));
    }
    if (value.freeSpace !== undefined) {
      if (!Array.isArray(value.freeSpace) || value.freeSpace.length > MAX_FREE_SPACE) throw new CompanionProtocolError('Too many companion free-space cells.');
      const ids = uniqueIds(value.freeSpace.map((entry) => isRecord(entry) ? entry.id : undefined), 'free-space');
      const parsed = value.freeSpace.map((entry) => parseFreeSpace(entry, timestamp, calibration));
      ids.forEach((id, index) => nextFreeSpace.set(id, parsed[index]));
    }
    if (nextSurfaces.size > MAX_SURFACES || nextObjects.size > MAX_OBJECTS || nextFreeSpace.size > MAX_FREE_SPACE) throw new CompanionProtocolError('Companion environment exceeds its bounds.');
    this.frameId = frameId;
    this.timestamp = timestamp;
    this.lastPose = resolvedPose;
    this.depth = depthState;
    this.surfaces = nextSurfaces;
    this.objects = nextObjects;
    this.freeSpace = nextFreeSpace;
    return {
      frameId,
      timestamp,
      pose,
      depth,
      surfaces: [...this.surfaces.values()],
      objects: [...this.objects.values()],
      freeSpace: [...this.freeSpace.values()],
      calibrationConfidence,
    };
  }

  reset(): void {
    this.frameId = 0;
    this.timestamp = 0;
    this.lastPose = null;
    this.depth = undefined;
    this.surfaces.clear();
    this.objects.clear();
    this.freeSpace.clear();
  }
}
