import type {
  MeasurementScale,
  MeasurementSource,
  MotionSample,
  PoseSample,
  QuaternionTuple,
  Vec3Tuple,
} from './types';

export const IDENTITY_QUATERNION: QuaternionTuple = [0, 0, 0, 1];

const MIN_VARIANCE = 1e-8;

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function isValidQuaternion(value: unknown): value is QuaternionTuple {
  if (!Array.isArray(value) || value.length !== 4 || !value.every(Number.isFinite)) return false;
  const norm = Math.hypot(...value);
  return norm > 0.999 && norm < 1.001;
}

export function normalizeQuaternion(value: QuaternionTuple): QuaternionTuple {
  const norm = Math.hypot(...value);
  if (!Number.isFinite(norm) || norm < 1e-12) return [...IDENTITY_QUATERNION];
  return [value[0] / norm, value[1] / norm, value[2] / norm, value[3] / norm];
}

export function multiplyQuaternions(a: QuaternionTuple, b: QuaternionTuple): QuaternionTuple {
  return [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  ];
}

export function conjugateQuaternion(q: QuaternionTuple): QuaternionTuple {
  return [-q[0], -q[1], -q[2], q[3]];
}

export function quaternionAngle(a: QuaternionTuple, b: QuaternionTuple): number {
  const dot = clamp(Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]), 0, 1);
  return 2 * Math.acos(dot);
}

export function quaternionFromAxisAngle(axis: Vec3Tuple, angle: number): QuaternionTuple {
  const norm = Math.hypot(...axis);
  if (!Number.isFinite(angle) || norm < 1e-12) return [...IDENTITY_QUATERNION];
  const half = angle / 2;
  const scale = Math.sin(half) / norm;
  return [axis[0] * scale, axis[1] * scale, axis[2] * scale, Math.cos(half)];
}

export function integrateQuaternion(q: QuaternionTuple, angularVelocity: Vec3Tuple, dt: number): QuaternionTuple {
  const speed = Math.hypot(...angularVelocity);
  if (!Number.isFinite(dt) || dt <= 0 || !Number.isFinite(speed)) return normalizeQuaternion(q);
  return normalizeQuaternion(multiplyQuaternions(q, quaternionFromAxisAngle(angularVelocity, speed * dt)));
}

export function rotateVector(q: QuaternionTuple, v: Vec3Tuple): Vec3Tuple {
  const [x, y, z, w] = normalizeQuaternion(q);
  const tx = 2 * (y * v[2] - z * v[1]);
  const ty = 2 * (z * v[0] - x * v[2]);
  const tz = 2 * (x * v[1] - y * v[0]);
  return [
    v[0] + w * tx + y * tz - z * ty,
    v[1] + w * ty + z * tx - x * tz,
    v[2] + w * tz + x * ty - y * tx,
  ];
}

export function quaternionToRotationVector(q: QuaternionTuple): Vec3Tuple {
  const normalized = normalizeQuaternion(q);
  const sign = normalized[3] < 0 ? -1 : 1;
  const x = normalized[0] * sign;
  const y = normalized[1] * sign;
  const z = normalized[2] * sign;
  const w = normalized[3] * sign;
  const sine = Math.hypot(x, y, z);
  if (sine < 1e-9) return [0, 0, 0];
  const angle = 2 * Math.atan2(sine, clamp(w, -1, 1));
  const scale = angle / sine;
  return [x * scale, y * scale, z * scale];
}

export function identityMatrix(size: number): number[] {
  const result = new Array<number>(size * size).fill(0);
  for (let index = 0; index < size; index += 1) result[index * size + index] = 1;
  return result;
}

function transpose(matrix: number[], size: number): number[] {
  const result = new Array<number>(matrix.length).fill(0);
  for (let row = 0; row < size; row += 1) {
    for (let column = 0; column < size; column += 1) result[column * size + row] = matrix[row * size + column];
  }
  return result;
}

function multiplyMatrices(a: number[], b: number[], size: number): number[] {
  const result = new Array<number>(size * size).fill(0);
  for (let row = 0; row < size; row += 1) {
    for (let column = 0; column < size; column += 1) {
      for (let inner = 0; inner < size; inner += 1) result[row * size + column] += a[row * size + inner] * b[inner * size + column];
    }
  }
  return result;
}

function addMatrices(a: number[], b: number[]): number[] {
  return a.map((value, index) => value + b[index]);
}

function multiplyMatrixVector(matrix: number[], vector: number[], rows: number, columns = rows): number[] {
  return Array.from({ length: rows }, (_, row) => {
    let value = 0;
    for (let column = 0; column < columns; column += 1) value += matrix[row * columns + column] * vector[column];
    return value;
  });
}

function solve3Multiple(matrix: number[], columns: number[][]): number[][] | null {
  if (columns.length === 0 || !columns.every((column) => column.length === columns[0].length)) return null;
  const rows = Array.from({ length: 3 }, (_, row) => [
    ...matrix.slice(row * 3, row * 3 + 3),
    ...columns.map((column) => column[row]),
  ]);
  for (let column = 0; column < 3; column += 1) {
    let pivot = column;
    for (let row = column + 1; row < 3; row += 1) {
      if (Math.abs(rows[row][column]) > Math.abs(rows[pivot][column])) pivot = row;
    }
    if (Math.abs(rows[pivot][column]) < 1e-12) return null;
    [rows[column], rows[pivot]] = [rows[pivot], rows[column]];
    const divisor = rows[column][column];
    for (let index = column; index < 3 + columns.length; index += 1) rows[column][index] /= divisor;
    for (let row = 0; row < 3; row += 1) {
      if (row === column) continue;
      const factor = rows[row][column];
      for (let index = column; index < 3 + columns.length; index += 1) rows[row][index] -= factor * rows[column][index];
    }
  }
  return columns.map((_, column) => rows.map((row) => row[3 + column]));
}

function solve3(matrix: number[], vector: number[]): number[] | null {
  return solve3Multiple(matrix, [vector])?.[0] ?? null;
}

export function sanitizeCovariance3(value: unknown, fallback: number[]): number[] {
  if (!Array.isArray(value) || value.length !== 9 || !value.every(Number.isFinite)) return [...fallback];
  const matrix = value.map((entry, index) => {
    const mirrored = value[(index % 3) * 3 + Math.floor(index / 3)];
    return (entry + mirrored) / 2;
  });
  if (matrix[0] < -1e-10 || matrix[4] < -1e-10 || matrix[8] < -1e-10) return [...fallback];
  for (let index = 0; index < 3; index += 1) matrix[index * 3 + index] = Math.max(MIN_VARIANCE, matrix[index * 3 + index]);
  const determinant =
    matrix[0] * (matrix[4] * matrix[8] - matrix[5] * matrix[7]) -
    matrix[1] * (matrix[3] * matrix[8] - matrix[5] * matrix[6]) +
    matrix[2] * (matrix[3] * matrix[7] - matrix[4] * matrix[6]);
  const minor02 = matrix[0] * matrix[4] - matrix[1] * matrix[3];
  const minor02b = matrix[0] * matrix[8] - matrix[2] * matrix[6];
  const minor12 = matrix[4] * matrix[8] - matrix[5] * matrix[7];
  if (determinant < -1e-10 || minor02 < -1e-10 || minor02b < -1e-10 || minor12 < -1e-10) return [...fallback];
  return matrix;
}

function covarianceBlock3(covariance: number[] | undefined, rowOffset: number, columnOffset: number): number[] {
  if (!covariance) return [];
  return Array.from({ length: 9 }, (_, index) => covariance[(Math.floor(index / 3) + rowOffset) * 6 + (index % 3) + columnOffset]);
}

function symmetrize(matrix: number[], size: number): number[] {
  const result = matrix.slice();
  for (let row = 0; row < size; row += 1) {
    result[row * size + row] = Math.max(MIN_VARIANCE, result[row * size + row]);
    for (let column = row + 1; column < size; column += 1) {
      const average = (result[row * size + column] + result[column * size + row]) / 2;
      result[row * size + column] = average;
      result[column * size + row] = average;
    }
  }
  return result;
}

export interface FusionResult {
  accepted: boolean;
  reason?: string;
  confidence: number;
}

export interface PoseFusionOptions {
  gyroNoise?: number;
  orientationNoise?: number;
  maxMotionGapSeconds?: number;
}

const DEFAULT_ORIENTATION_COVARIANCE = [0.02, 0, 0, 0, 0.02, 0, 0, 0, 0.02];
const DEFAULT_POSITION_COVARIANCE = [0.04, 0, 0, 0, 0.04, 0, 0, 0, 0.04];

interface FusionState {
  quaternion: QuaternionTuple;
  position: Vec3Tuple;
  velocity: Vec3Tuple;
  positionCovariance: number[];
  errorCovariance: number[];
  gyroBias: Vec3Tuple;
  lastGyro: Vec3Tuple | null;
  lastGyroTimestamp: number;
  lastTimestamp: number;
  confidenceValue: number;
  source: MeasurementSource;
}

export class PoseFusion {
  private quaternion: QuaternionTuple = [...IDENTITY_QUATERNION];
  private position: Vec3Tuple = [0, 0, 0];
  private velocity: Vec3Tuple = [0, 0, 0];
  private positionCovariance = [...DEFAULT_POSITION_COVARIANCE];
  private errorCovariance = identityMatrix(6);
  private gyroBias: Vec3Tuple = [0, 0, 0];
  private lastGyro: Vec3Tuple | null = null;
  private lastGyroTimestamp = Number.NaN;
  private lastTimestamp = Number.NaN;
  private confidenceValue = 0;
  private source: MeasurementSource = 'gyro';
  private readonly gyroNoise: number;
  private readonly orientationNoise: number;
  private readonly maxMotionGapSeconds: number;

  constructor(options: PoseFusionOptions = {}) {
    this.gyroNoise = options.gyroNoise ?? 0.035;
    this.orientationNoise = options.orientationNoise ?? 0.12;
    this.maxMotionGapSeconds = options.maxMotionGapSeconds ?? 0.5;
    for (let index = 0; index < 3; index += 1) {
      this.errorCovariance[index * 6 + index] = DEFAULT_ORIENTATION_COVARIANCE[index * 3 + index];
      this.errorCovariance[(index + 3) * 6 + index + 3] = 1e-5;
    }
  }

  get timestamp(): number {
    return this.lastTimestamp;
  }

  get orientation(): QuaternionTuple {
    return [...this.quaternion];
  }

  get translation(): Vec3Tuple {
    return [...this.position];
  }

  get orientationCovariance(): number[] {
    return Array.from({ length: 9 }, (_, index) => this.errorCovariance[Math.floor(index / 3) * 6 + index % 3]);
  }

  get translationCovariance(): number[] {
    return [...this.positionCovariance];
  }

  get confidence(): number {
    return this.confidenceValue;
  }

  get measurementSource(): MeasurementSource {
    return this.source;
  }

  hasFreshGyro(timestamp: number): boolean {
    return this.lastGyro !== null && Number.isFinite(timestamp) && timestamp >= this.lastGyroTimestamp && timestamp - this.lastGyroTimestamp <= 150;
  }

  reset(): void {
    this.quaternion = [...IDENTITY_QUATERNION];
    this.position = [0, 0, 0];
    this.velocity = [0, 0, 0];
    this.positionCovariance = [...DEFAULT_POSITION_COVARIANCE];
    this.errorCovariance = identityMatrix(6);
    this.gyroBias = [0, 0, 0];
    this.lastGyro = null;
    this.lastGyroTimestamp = Number.NaN;
    this.lastTimestamp = Number.NaN;
    this.confidenceValue = 0;
    this.source = 'gyro';
    for (let index = 0; index < 3; index += 1) {
      this.errorCovariance[index * 6 + index] = 0.02;
      this.errorCovariance[(index + 3) * 6 + index + 3] = 1e-5;
    }
  }

  resetToPose(pose: PoseSample): void {
    if (
      !Number.isFinite(pose.timestamp) || pose.timestamp < 0 || !isValidQuaternion(pose.quaternion) ||
      !Array.isArray(pose.position) || pose.position.length !== 3 || !pose.position.every(Number.isFinite) ||
      !Array.isArray(pose.velocity) || pose.velocity.length !== 3 || !pose.velocity.every(Number.isFinite) ||
      pose.scale !== 'metric' || pose.source !== 'companion'
    ) throw new Error('Invalid companion pose.');
    this.quaternion = normalizeQuaternion(pose.quaternion);
    this.position = [...pose.position];
    this.velocity = Math.hypot(...pose.velocity) <= 20 ? [...pose.velocity] : [0, 0, 0];
    const supplied = Array.isArray(pose.covariance) && pose.covariance.length === 36 && pose.covariance.every(Number.isFinite)
      ? symmetrize(pose.covariance, 6)
      : undefined;
    this.errorCovariance = supplied ?? identityMatrix(6);
    this.positionCovariance = supplied
      ? sanitizeCovariance3(covarianceBlock3(supplied, 0, 0), DEFAULT_POSITION_COVARIANCE)
      : [...DEFAULT_POSITION_COVARIANCE];
    const orientation = supplied
      ? sanitizeCovariance3(covarianceBlock3(supplied, 3, 3), DEFAULT_ORIENTATION_COVARIANCE)
      : DEFAULT_ORIENTATION_COVARIANCE;
    for (let row = 0; row < 3; row += 1) {
      for (let column = 0; column < 3; column += 1) this.errorCovariance[row * 6 + column] = orientation[row * 3 + column];
      this.errorCovariance[(row + 3) * 6 + row + 3] = 1e-5;
    }
    this.gyroBias = [0, 0, 0];
    this.lastGyro = null;
    this.lastGyroTimestamp = Number.NaN;
    this.lastTimestamp = pose.timestamp;
    this.confidenceValue = Number.isFinite(pose.confidence) ? clamp(pose.confidence, 0, 1) : 0;
    this.source = 'companion';
  }

  ingestMotion(sample: MotionSample): FusionResult {
    if (!Number.isFinite(sample.timestamp) || sample.timestamp < 0 || !isValidQuaternion(sample.quaternion)) {
      return { accepted: false, reason: 'Malformed motion sample.', confidence: this.confidenceValue };
    }
    if (sample.gyro && (!sample.gyro.every(Number.isFinite) || Math.hypot(...sample.gyro) > 20)) {
      return { accepted: false, reason: 'Gyroscope outlier rejected.', confidence: this.confidenceValue };
    }
    if (Number.isFinite(this.lastTimestamp) && sample.timestamp <= this.lastTimestamp) {
      return { accepted: false, reason: 'Stale or duplicate motion sample rejected.', confidence: this.confidenceValue };
    }
    if (!Number.isFinite(this.lastTimestamp)) {
      this.quaternion = normalizeQuaternion(sample.quaternion);
      this.lastTimestamp = sample.timestamp;
      this.confidenceValue = 0.65;
      this.source = 'gyro';
      if (sample.gyro) {
        this.lastGyro = [...sample.gyro];
        this.lastGyroTimestamp = sample.timestamp;
      }
      const covariance = sanitizeCovariance3(sample.covariance, DEFAULT_ORIENTATION_COVARIANCE);
      for (let row = 0; row < 3; row += 1) {
        for (let column = 0; column < 3; column += 1) this.errorCovariance[row * 6 + column] = covariance[row * 3 + column];
      }
      return { accepted: true, confidence: this.confidenceValue };
    }

    this.predictTo(sample.timestamp);
    const measured = normalizeQuaternion(sample.quaternion);
    const error = quaternionToRotationVector(multiplyQuaternions(conjugateQuaternion(this.quaternion), measured));
    const covariance = sanitizeCovariance3(sample.covariance, DEFAULT_ORIENTATION_COVARIANCE.map((value) => value * this.orientationNoise / 0.12));
    const accepted = this.correctOrientation(error, covariance, 0.85, 49);
    if (sample.gyro) {
      this.lastGyro = [...sample.gyro];
      this.lastGyroTimestamp = sample.timestamp;
    }
    if (!accepted) {
      this.confidenceValue *= 0.65;
      return { accepted: false, reason: 'Orientation outlier rejected.', confidence: this.confidenceValue };
    }
    this.confidenceValue = clamp(this.confidenceValue * 0.75 + 0.25, 0, 1);
    this.source = 'gyro';
    return { accepted: true, confidence: this.confidenceValue };
  }

  predictTo(timestamp: number): FusionResult {
    if (!Number.isFinite(timestamp) || timestamp < 0) return { accepted: false, reason: 'Invalid prediction timestamp.', confidence: this.confidenceValue };
    if (!Number.isFinite(this.lastTimestamp)) {
      this.lastTimestamp = timestamp;
      return { accepted: true, confidence: this.confidenceValue };
    }
    const dtMilliseconds = timestamp - this.lastTimestamp;
    if (dtMilliseconds < -1) return { accepted: false, reason: 'Prediction would move backward in time.', confidence: this.confidenceValue };
    if (dtMilliseconds === 0) return { accepted: true, confidence: this.confidenceValue };
    const dt = Math.max(0, dtMilliseconds) / 1000;

    const transition = identityMatrix(6);
    for (let index = 0; index < 3; index += 1) transition[index * 6 + index + 3] = -dt;
    const propagated = multiplyMatrices(multiplyMatrices(transition, this.errorCovariance, 6), transpose(transition, 6), 6);
    const gyroFresh = this.hasFreshGyro(timestamp);
    if (gyroFresh && dt <= this.maxMotionGapSeconds && this.lastGyro) {
      const corrected: Vec3Tuple = [
        this.lastGyro[0] - this.gyroBias[0],
        this.lastGyro[1] - this.gyroBias[1],
        this.lastGyro[2] - this.gyroBias[2],
      ];
      this.quaternion = integrateQuaternion(this.quaternion, corrected, dt);
    } else {
      this.confidenceValue *= Math.exp(-dt / 0.75);
    }
    const angleVariance = Math.pow(this.gyroNoise * Math.min(dt, this.maxMotionGapSeconds), 2) + dt * 1e-5;
    const biasVariance = dt * 2e-6;
    for (let index = 0; index < 3; index += 1) {
      propagated[index * 6 + index] += angleVariance;
      propagated[(index + 3) * 6 + index + 3] += biasVariance;
    }
    this.errorCovariance = symmetrize(propagated, 6);
    this.lastTimestamp = timestamp;
    return { accepted: true, confidence: this.confidenceValue };
  }

  fuseVisualOrientation(timestamp: number, measured: QuaternionTuple, covariance?: number[], visualConfidence = 0.5, source: 'visual' | 'camera-fusion' = 'visual'): FusionResult {
    if (!Number.isFinite(timestamp) || timestamp < 0 || !isValidQuaternion(measured)) return { accepted: false, reason: 'Malformed visual orientation.', confidence: this.confidenceValue };
    if (Number.isFinite(this.lastTimestamp) && timestamp < this.lastTimestamp - 20) {
      return { accepted: false, reason: 'Stale visual orientation rejected.', confidence: this.confidenceValue };
    }
    this.predictTo(Math.max(timestamp, Number.isFinite(this.lastTimestamp) ? this.lastTimestamp : timestamp));
    const confidence = Number.isFinite(visualConfidence) ? clamp(visualConfidence, 0, 1) : 0;
    const error = quaternionToRotationVector(multiplyQuaternions(conjugateQuaternion(this.quaternion), normalizeQuaternion(measured)));
    const measurement = sanitizeCovariance3(covariance, DEFAULT_ORIENTATION_COVARIANCE.map((value) => value / Math.max(0.05, confidence)));
    const accepted = this.correctOrientation(error, measurement, 0.55, 36);
    if (!accepted) {
      this.confidenceValue *= 0.8;
      return { accepted: false, reason: 'Visual orientation outlier rejected.', confidence: this.confidenceValue };
    }
    this.confidenceValue = clamp(this.confidenceValue * 0.6 + confidence * 0.4, 0, 1);
    this.source = source;
    return { accepted: true, confidence: this.confidenceValue };
  }

  fuseCompanionPose(pose: PoseSample): FusionResult {
    if (
      !Number.isFinite(pose.timestamp) || pose.timestamp < 0 || !isValidQuaternion(pose.quaternion) ||
      !Array.isArray(pose.position) || pose.position.length !== 3 || !pose.position.every(Number.isFinite) ||
      !Array.isArray(pose.velocity) || pose.velocity.length !== 3 || !pose.velocity.every(Number.isFinite) ||
      !Number.isFinite(pose.confidence) || pose.scale !== 'metric' || pose.source !== 'companion'
    ) {
      return { accepted: false, reason: 'Malformed companion pose.', confidence: this.confidenceValue };
    }
    if (!Number.isFinite(this.lastTimestamp)) {
      this.resetToPose(pose);
      return { accepted: true, confidence: this.confidenceValue };
    }
    if (pose.timestamp <= this.lastTimestamp) return { accepted: false, reason: 'Stale companion pose rejected.', confidence: this.confidenceValue };

    const state = this.captureState();
    const reject = (reason: string): FusionResult => {
      this.restoreState(state);
      this.confidenceValue = state.confidenceValue * 0.5;
      return { accepted: false, reason, confidence: this.confidenceValue };
    };
    const previousPosition = [...this.position] as Vec3Tuple;
    const dt = (pose.timestamp - state.lastTimestamp) / 1000;
    const predictedPosition: Vec3Tuple = [
      this.position[0] + this.velocity[0] * dt,
      this.position[1] + this.velocity[1] * dt,
      this.position[2] + this.velocity[2] * dt,
    ];
    const measuredVelocity: Vec3Tuple = [
      (pose.position[0] - previousPosition[0]) / dt,
      (pose.position[1] - previousPosition[1]) / dt,
      (pose.position[2] - previousPosition[2]) / dt,
    ];
    if (!measuredVelocity.every(Number.isFinite) || Math.hypot(...measuredVelocity) > 20) return reject('Companion translation outlier rejected.');

    this.position = predictedPosition;
    this.predictTo(pose.timestamp);
    const rotationError = quaternionToRotationVector(multiplyQuaternions(conjugateQuaternion(this.quaternion), normalizeQuaternion(pose.quaternion)));
    if (Math.hypot(...rotationError) > 1.2) return reject('Companion orientation outlier rejected.');
    const covariance = Array.isArray(pose.covariance) && pose.covariance.length === 36 && pose.covariance.every(Number.isFinite)
      ? pose.covariance
      : undefined;
    const measurementPosition = sanitizeCovariance3(covarianceBlock3(covariance, 0, 0), DEFAULT_POSITION_COVARIANCE);
    const measurementRotation = sanitizeCovariance3(covarianceBlock3(covariance, 3, 3), DEFAULT_ORIENTATION_COVARIANCE);
    const positionError: Vec3Tuple = [
      pose.position[0] - this.position[0],
      pose.position[1] - this.position[1],
      pose.position[2] - this.position[2],
    ];
    const sum = this.positionCovariance.map((value, index) => value + measurementPosition[index]);
    const covarianceColumns = Array.from({ length: 3 }, (_, column) => Array.from({ length: 3 }, (_, row) => this.positionCovariance[row * 3 + column]));
    const gainColumns = solve3Multiple(sum, covarianceColumns);
    if (!gainColumns) return reject('Companion covariance is singular.');
    const innovation = solve3(sum, positionError);
    if (!innovation || innovation.reduce((total, value) => total + value * value, 0) > 64) return reject('Companion translation outlier rejected.');
    const gainMatrix = gainColumns.flat();
    const correction = multiplyMatrixVector(gainMatrix, positionError, 3);
    this.position = [this.position[0] + correction[0], this.position[1] + correction[1], this.position[2] + correction[2]];
    const residual = identityMatrix(3);
    for (let row = 0; row < 3; row += 1) residual[row * 3 + row] = 1 - gainMatrix[row * 3 + row];
    const nextPosition = addMatrices(
      multiplyMatrices(multiplyMatrices(residual, this.positionCovariance, 3), transpose(residual, 3), 3),
      multiplyMatrices(multiplyMatrices(gainMatrix, measurementPosition, 3), transpose(gainMatrix, 3), 3),
    );
    this.positionCovariance = symmetrize(nextPosition, 3);
    if (!this.correctOrientation(rotationError, measurementRotation, 1.2, 64)) return reject('Companion orientation covariance rejected the sample.');
    this.velocity = measuredVelocity;
    this.source = 'companion';
    this.confidenceValue = clamp(this.confidenceValue * 0.4 + clamp(pose.confidence, 0, 1) * 0.6, 0, 1);
    return { accepted: true, confidence: this.confidenceValue };
  }

  integrateRelativeTranslation(translation: Vec3Tuple, dt: number, confidence: number, orientation: QuaternionTuple = this.quaternion): void {
    if (!translation.every(Number.isFinite) || !isValidQuaternion(orientation) || !Number.isFinite(dt) || dt <= 0 || dt > 0.5 || !Number.isFinite(confidence)) return;
    const measurementConfidence = clamp(confidence, 0, 1);
    const limit = 2 / Math.max(0.05, measurementConfidence);
    const length = Math.hypot(...translation);
    if (length < 1e-12) return;
    const scale = length > limit ? limit / length : 1;
    const world = rotateVector(orientation, translation.map((value) => value * scale) as Vec3Tuple);
    this.position = [this.position[0] + world[0], this.position[1] + world[1], this.position[2] + world[2]];
    this.velocity = [world[0] / dt, world[1] / dt, world[2] / dt];
    const variance = clamp(0.002 / Math.max(0.05, measurementConfidence) + dt * 0.01, 0.002, 0.5);
    for (let index = 0; index < 3; index += 1) this.positionCovariance[index * 3 + index] = Math.min(4, this.positionCovariance[index * 3 + index] + variance);
  }

  samplePose(frameId: number, timestamp: number, source: MeasurementSource, scale: MeasurementScale): PoseSample {
    this.predictTo(timestamp);
    const covariance = new Array<number>(36).fill(0);
    for (let row = 0; row < 3; row += 1) {
      for (let column = 0; column < 3; column += 1) {
        covariance[row * 6 + column] = this.positionCovariance[row * 3 + column];
        covariance[(row + 3) * 6 + column + 3] = this.errorCovariance[row * 6 + column];
      }
    }
    return {
      frameId,
      timestamp: this.lastTimestamp,
      position: [...this.position],
      quaternion: [...this.quaternion],
      velocity: [...this.velocity],
      covariance,
      confidence: this.confidenceValue,
      scale,
      source,
    };
  }

  private captureState(): FusionState {
    return {
      quaternion: [...this.quaternion],
      position: [...this.position],
      velocity: [...this.velocity],
      positionCovariance: [...this.positionCovariance],
      errorCovariance: [...this.errorCovariance],
      gyroBias: [...this.gyroBias],
      lastGyro: this.lastGyro ? [...this.lastGyro] : null,
      lastGyroTimestamp: this.lastGyroTimestamp,
      lastTimestamp: this.lastTimestamp,
      confidenceValue: this.confidenceValue,
      source: this.source,
    };
  }

  private restoreState(state: FusionState): void {
    this.quaternion = [...state.quaternion];
    this.position = [...state.position];
    this.velocity = [...state.velocity];
    this.positionCovariance = [...state.positionCovariance];
    this.errorCovariance = [...state.errorCovariance];
    this.gyroBias = [...state.gyroBias];
    this.lastGyro = state.lastGyro ? [...state.lastGyro] : null;
    this.lastGyroTimestamp = state.lastGyroTimestamp;
    this.lastTimestamp = state.lastTimestamp;
    this.confidenceValue = state.confidenceValue;
    this.source = state.source;
  }

  private correctOrientation(error: Vec3Tuple, measurement: number[], maxAngle: number, maxMahalanobis: number): boolean {
    const angle = Math.hypot(...error);
    if (!Number.isFinite(angle) || angle > maxAngle) return false;
    const orientation = Array.from({ length: 9 }, (_, index) => this.errorCovariance[Math.floor(index / 3) * 6 + index % 3]);
    const sum = orientation.map((value, index) => value + measurement[index]);
    const innovation = solve3(sum, error);
    if (!innovation) return false;
    if (innovation.reduce((total, value) => total + value * value, 0) > maxMahalanobis) return false;
    const gain = new Array<number>(18).fill(0);
    for (let row = 0; row < 6; row += 1) {
      const gainRow = solve3(sum, [this.errorCovariance[row * 6], this.errorCovariance[row * 6 + 1], this.errorCovariance[row * 6 + 2]]);
      if (!gainRow) return false;
      for (let column = 0; column < 3; column += 1) gain[row * 3 + column] = gainRow[column];
    }
    const correction = multiplyMatrixVector(gain, error, 6, 3);
    if (!correction.every(Number.isFinite)) return false;
    this.quaternion = normalizeQuaternion(multiplyQuaternions(this.quaternion, quaternionFromAxisAngle(correction.slice(0, 3) as Vec3Tuple, Math.hypot(...correction.slice(0, 3)))));
    this.gyroBias = [
      clamp(this.gyroBias[0] + correction[3], -0.5, 0.5),
      clamp(this.gyroBias[1] + correction[4], -0.5, 0.5),
      clamp(this.gyroBias[2] + correction[5], -0.5, 0.5),
    ];

    const ah = identityMatrix(6);
    for (let column = 0; column < 3; column += 1) {
      for (let row = 0; row < 6; row += 1) ah[row * 6 + column] -= gain[row * 3 + column];
    }
    const gainTimesMeasurement = new Array<number>(18).fill(0);
    for (let row = 0; row < 6; row += 1) {
      for (let column = 0; column < 3; column += 1) {
        for (let inner = 0; inner < 3; inner += 1) gainTimesMeasurement[row * 3 + column] += gain[row * 3 + inner] * measurement[inner * 3 + column];
      }
    }
    const measurementCovariance = new Array<number>(36).fill(0);
    for (let row = 0; row < 6; row += 1) {
      for (let column = 0; column < 6; column += 1) {
        for (let inner = 0; inner < 3; inner += 1) measurementCovariance[row * 6 + column] += gainTimesMeasurement[row * 3 + inner] * gain[column * 3 + inner];
      }
    }
    let updated = addMatrices(
      multiplyMatrices(multiplyMatrices(ah, this.errorCovariance, 6), transpose(ah, 6), 6),
      measurementCovariance,
    );
    const angleError = correction.slice(0, 3);
    const reset = identityMatrix(6);
    reset[0 * 6 + 1] = angleError[2] / 2;
    reset[0 * 6 + 2] = -angleError[1] / 2;
    reset[1 * 6 + 0] = -angleError[2] / 2;
    reset[1 * 6 + 2] = angleError[0] / 2;
    reset[2 * 6 + 0] = angleError[1] / 2;
    reset[2 * 6 + 1] = -angleError[0] / 2;
    updated = multiplyMatrices(multiplyMatrices(reset, updated, 6), transpose(reset, 6), 6);
    this.errorCovariance = symmetrize(updated, 6);
    return true;
  }
}
