import type { CameraIntrinsics, QuaternionTuple, SpatialPoint, Vec3Tuple } from './types';
import type { VioTrackedFeature } from './workers/vio.worker';
import { validateCameraIntrinsics } from './environmentModel';
import { clamp, isValidQuaternion, normalizeQuaternion, quaternionAngle } from './poseFusion';

export interface RelativeMotionEstimate {
  rotation: QuaternionTuple;
  translation: Vec3Tuple;
  points: SpatialPoint[];
  confidence: number;
  inliers: number;
}

interface Matrix3 {
  rows: number[][];
}

interface EssentialCandidate {
  rotation: QuaternionTuple;
  matrix: Matrix3;
  translation: Vec3Tuple;
}

interface EssentialEstimate {
  matrix: Matrix3;
  normalized: Matrix3;
  firstTransform: Matrix3;
  secondTransform: Matrix3;
}

interface FeaturePair {
  feature: VioTrackedFeature;
  first: Vec3Tuple;
  second: Vec3Tuple;
}

function matrixVector(matrix: Matrix3, vector: Vec3Tuple): Vec3Tuple {
  return [
    matrix.rows[0][0] * vector[0] + matrix.rows[0][1] * vector[1] + matrix.rows[0][2] * vector[2],
    matrix.rows[1][0] * vector[0] + matrix.rows[1][1] * vector[1] + matrix.rows[1][2] * vector[2],
    matrix.rows[2][0] * vector[0] + matrix.rows[2][1] * vector[1] + matrix.rows[2][2] * vector[2],
  ];
}

function transpose(matrix: Matrix3): Matrix3 {
  return { rows: [0, 1, 2].map((row) => [0, 1, 2].map((column) => matrix.rows[column][row])) };
}

function multiplyMatrices(a: Matrix3, b: Matrix3): Matrix3 {
  return { rows: a.rows.map((row) => [0, 1, 2].map((column) => row.reduce((sum, value, inner) => sum + value * b.rows[inner][column], 0))) };
}

function determinant3(matrix: Matrix3): number {
  const m = matrix.rows;
  return m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) -
    m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) +
    m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
}

function quaternionFromMatrix(matrix: Matrix3): QuaternionTuple {
  const m = matrix.rows;
  const trace = m[0][0] + m[1][1] + m[2][2];
  let x: number;
  let y: number;
  let z: number;
  let w: number;
  if (trace > 0) {
    const scale = Math.sqrt(trace + 1) * 2;
    w = 0.25 * scale;
    x = (m[2][1] - m[1][2]) / scale;
    y = (m[0][2] - m[2][0]) / scale;
    z = (m[1][0] - m[0][1]) / scale;
  } else if (m[0][0] > m[1][1] && m[0][0] > m[2][2]) {
    const scale = Math.sqrt(1 + m[0][0] - m[1][1] - m[2][2]) * 2;
    w = (m[2][1] - m[1][2]) / scale;
    x = 0.25 * scale;
    y = (m[0][1] + m[1][0]) / scale;
    z = (m[0][2] + m[2][0]) / scale;
  } else if (m[1][1] > m[2][2]) {
    const scale = Math.sqrt(1 + m[1][1] - m[0][0] - m[2][2]) * 2;
    w = (m[0][2] - m[2][0]) / scale;
    x = (m[0][1] + m[1][0]) / scale;
    y = 0.25 * scale;
    z = (m[1][2] + m[2][1]) / scale;
  } else {
    const scale = Math.sqrt(1 + m[2][2] - m[0][0] - m[1][1]) * 2;
    w = (m[1][0] - m[0][1]) / scale;
    x = (m[0][2] + m[2][0]) / scale;
    y = (m[1][2] + m[2][1]) / scale;
    z = 0.25 * scale;
  }
  return normalizeQuaternion([x, y, z, w]);
}

function svd3(input: Matrix3): { u: Matrix3; v: Matrix3; singular: number[] } {
  const a = input.rows.map((row) => [...row]);
  const v: number[][] = [0, 1, 2].map((index) => [0, 1, 2].map((column) => index === column ? 1 : 0));
  for (let sweep = 0; sweep < 32; sweep += 1) {
    let changed = false;
    for (let p = 0; p < 2; p += 1) {
      for (let q = p + 1; q < 3; q += 1) {
        let alpha = 0;
        let beta = 0;
        let gamma = 0;
        for (let row = 0; row < 3; row += 1) {
          alpha += a[row][p] * a[row][p];
          beta += a[row][q] * a[row][q];
          gamma += a[row][p] * a[row][q];
        }
        if (Math.abs(gamma) <= 1e-12 * Math.sqrt(alpha * beta)) continue;
        const zeta = (beta - alpha) / (2 * gamma);
        const tangent = (zeta >= 0 ? 1 : -1) / (Math.abs(zeta) + Math.hypot(1, zeta));
        const cosine = 1 / Math.sqrt(1 + tangent * tangent);
        const sine = cosine * tangent;
        for (let row = 0; row < 3; row += 1) {
          const ap = a[row][p];
          const aq = a[row][q];
          a[row][p] = cosine * ap - sine * aq;
          a[row][q] = sine * ap + cosine * aq;
          const vp = v[row][p];
          const vq = v[row][q];
          v[row][p] = cosine * vp - sine * vq;
          v[row][q] = sine * vp + cosine * vq;
        }
        changed = true;
      }
    }
    if (!changed) break;
  }
  const columns = [0, 1, 2].map((column) => ({
    column,
    singular: Math.hypot(...a.map((row) => row[column])),
  })).sort((first, second) => second.singular - first.singular);
  const u: Matrix3 = { rows: [[0, 0, 0], [0, 0, 0], [0, 0, 0]] };
  const right: Matrix3 = { rows: [[0, 0, 0], [0, 0, 0], [0, 0, 0]] };
  columns.forEach(({ column, singular }, index) => {
    if (singular > 1e-12) for (let row = 0; row < 3; row += 1) u.rows[row][index] = a[row][column] / singular;
    for (let row = 0; row < 3; row += 1) right.rows[row][index] = v[row][column];
  });
  if (columns[2].singular <= 1e-12) {
    const first = u.rows.map((row) => row[0]);
    const second = u.rows.map((row) => row[1]);
    const normal: Vec3Tuple = [
      first[1] * second[2] - first[2] * second[1],
      first[2] * second[0] - first[0] * second[2],
      first[0] * second[1] - first[1] * second[0],
    ];
    const norm = Math.hypot(...normal);
    if (norm <= 1e-12) return { u, v: right, singular: columns.map((column) => column.singular) };
    for (let row = 0; row < 3; row += 1) u.rows[row][2] = normal[row] / norm;
  }
  if (determinant3(u) * determinant3(right) < 0) {
    for (const row of u.rows) row[2] = -row[2];
  }
  return { u, v: right, singular: columns.map((column) => column.singular) };
}

function enforceEssential(matrix: Matrix3): Matrix3 | null {
  if (!matrix.rows.flat().every(Number.isFinite)) return null;
  const { u, v, singular } = svd3(matrix);
  if (!singular.every(Number.isFinite) || singular[0] < 1e-9 || singular[1] / singular[0] < 0.08) return null;
  const constrainedU = { rows: u.rows.map((row) => [...row]) };
  const constrainedV = { rows: v.rows.map((row) => [...row]) };
  const scale = singular[0];
  for (const row of constrainedU.rows) {
    row[0] *= scale;
    row[1] *= scale;
    row[2] = 0;
  }
  return multiplyMatrices(constrainedU, transpose(constrainedV));
}

function nullspace8(rows: number[][]): number[] | null {
  const matrix = rows.map((row) => [...row]);
  const pivots: number[] = [];
  let row = 0;
  for (let column = 0; column < 8 && row < 8; column += 1) {
    let pivot = row;
    for (let candidate = row + 1; candidate < 8; candidate += 1) {
      if (Math.abs(matrix[candidate][column]) > Math.abs(matrix[pivot][column])) pivot = candidate;
    }
    if (Math.abs(matrix[pivot][column]) < 1e-9) continue;
    [matrix[row], matrix[pivot]] = [matrix[pivot], matrix[row]];
    const divisor = matrix[row][column];
    for (let index = column; index < 9; index += 1) matrix[row][index] /= divisor;
    for (let other = 0; other < 8; other += 1) {
      if (other === row) continue;
      const factor = matrix[other][column];
      for (let index = column; index < 9; index += 1) matrix[other][index] -= factor * matrix[row][index];
    }
    pivots.push(column);
    row += 1;
  }
  if (pivots.length < 8) return null;
  const free = Array.from({ length: 9 }, (_, index) => index).find((index) => !pivots.includes(index));
  if (free === undefined) return null;
  const result = new Array<number>(9).fill(0);
  result[free] = 1;
  pivots.forEach((column, index) => { result[column] = -matrix[index][free]; });
  const norm = Math.hypot(...result);
  return norm > 1e-9 ? result.map((value) => value / norm) : null;
}

function smallestEigenvector(matrix: number[], size: number): number[] | null {
  if (matrix.length !== size * size || !matrix.every(Number.isFinite)) return null;
  const a = matrix.slice();
  const vectors: number[][] = Array.from({ length: size }, (_, row) => Array.from({ length: size }, (_, column) => row === column ? 1 : 0));
  const tolerance = 1e-12 * Math.max(1, ...a.filter((_, index) => index % (size + 1) === 0).map(Math.abs));
  for (let sweep = 0; sweep < 32; sweep += 1) {
    let largest = 0;
    for (let p = 0; p < size - 1; p += 1) {
      for (let q = p + 1; q < size; q += 1) {
        const apq = a[p * size + q];
        largest = Math.max(largest, Math.abs(apq));
        if (Math.abs(apq) <= tolerance) continue;
        const app = a[p * size + p];
        const aqq = a[q * size + q];
        const tau = (aqq - app) / (2 * apq);
        const tangent = (tau >= 0 ? 1 : -1) / (Math.abs(tau) + Math.hypot(1, tau));
        const cosine = 1 / Math.sqrt(1 + tangent * tangent);
        const sine = cosine * tangent;
        a[p * size + p] = app - tangent * apq;
        a[q * size + q] = aqq + tangent * apq;
        a[p * size + q] = 0;
        a[q * size + p] = 0;
        for (let index = 0; index < size; index += 1) {
          if (index !== p && index !== q) {
            const aip = a[index * size + p];
            const aiq = a[index * size + q];
            a[index * size + p] = cosine * aip - sine * aiq;
            a[p * size + index] = a[index * size + p];
            a[index * size + q] = sine * aip + cosine * aiq;
            a[q * size + index] = a[index * size + q];
          }
          const vip = vectors[index][p];
          const viq = vectors[index][q];
          vectors[index][p] = cosine * vip - sine * viq;
          vectors[index][q] = sine * vip + cosine * viq;
        }
      }
    }
    if (largest <= tolerance) break;
  }
  let selected = 0;
  for (let index = 1; index < size; index += 1) if (a[index * size + index] < a[selected * size + selected]) selected = index;
  const result = vectors.map((row) => row[selected]);
  const norm = Math.hypot(...result);
  return norm > 1e-9 ? result.map((value) => value / norm) : null;
}

function normalizedPairs(pairs: FeaturePair[]): { pairs: FeaturePair[]; first: Matrix3; second: Matrix3 } | null {
  const transform = (key: 'first' | 'second'): Matrix3 | null => {
    const meanX = pairs.reduce((sum, pair) => sum + pair[key][0], 0) / pairs.length;
    const meanY = pairs.reduce((sum, pair) => sum + pair[key][1], 0) / pairs.length;
    const distance = pairs.reduce((sum, pair) => sum + (pair[key][0] - meanX) ** 2 + (pair[key][1] - meanY) ** 2, 0) / pairs.length;
    if (!Number.isFinite(distance) || distance < 1e-12) return null;
    const scale = Math.sqrt(2 / distance);
    return { rows: [[scale, 0, -meanX * scale], [0, scale, -meanY * scale], [0, 0, 1]] };
  };
  const first = transform('first');
  const second = transform('second');
  if (!first || !second) return null;
  return {
    first,
    second,
    pairs: pairs.map((pair) => ({
      feature: pair.feature,
      first: matrixVector(first, pair.first),
      second: matrixVector(second, pair.second),
    })),
  };
}

function essentialFromPairs(input: FeaturePair[]): EssentialEstimate | null {
  if (input.length < 8) return null;
  const normalized = normalizedPairs(input);
  if (!normalized) return null;
  const { pairs, first, second } = normalized;
  let solution: number[] | null;
  if (pairs.length === 8) {
    const rows = pairs.map(({ first: previous, second: current }) => {
      const [x, y, z] = previous;
      const [u, v, w] = current;
      return [u * x, u * y, u * z, v * x, v * y, v * z, w * x, w * y, w * z];
    });
    solution = nullspace8(rows);
  } else {
    const normal = new Array<number>(81).fill(0);
    for (const { first: previous, second: current } of pairs) {
      const [x, y, z] = previous;
      const [u, v, w] = current;
      const coefficients = [u * x, u * y, u * z, v * x, v * y, v * z, w * x, w * y, w * z];
      for (let row = 0; row < 9; row += 1) {
        for (let column = 0; column < 9; column += 1) normal[row * 9 + column] += coefficients[row] * coefficients[column];
      }
    }
    solution = smallestEigenvector(normal, 9);
  }
  if (!solution) return null;
  const raw = { rows: [solution.slice(0, 3), solution.slice(3, 6), solution.slice(6, 9)] };
  const estimated = enforceEssential(raw);
  if (!estimated) return null;
  return {
    matrix: multiplyMatrices(multiplyMatrices(transpose(second), estimated), first),
    normalized: estimated,
    firstTransform: first,
    secondTransform: second,
  };
}

function essentialCandidates(essential: Matrix3): EssentialCandidate[] {
  const { u, v } = svd3(essential);
  const w: Matrix3 = { rows: [[0, -1, 0], [1, 0, 0], [0, 0, 1]] };
  const wt = transpose(w);
  const baseTranslation: Vec3Tuple = [u.rows[0][2], u.rows[1][2], u.rows[2][2]];
  const candidates: EssentialCandidate[] = [];
  for (const rotation of [multiplyMatrices(multiplyMatrices(u, w), transpose(v)), multiplyMatrices(multiplyMatrices(u, wt), transpose(v))]) {
    if (determinant3(rotation) < 0) continue;
    for (const sign of [1, -1]) {
      const matrix = { rows: rotation.rows.map((row) => [...row]) };
      if (determinant3(matrix) < 0) continue;
      candidates.push({
        rotation: quaternionFromMatrix(matrix),
        matrix,
        translation: baseTranslation.map((value) => value * sign) as Vec3Tuple,
      });
    }
  }
  return candidates;
}

function sampsonError(essential: Matrix3, first: Vec3Tuple, second: Vec3Tuple): number {
  const ef = matrixVector(essential, first);
  const ets = matrixVector(transpose(essential), second);
  const numerator = Math.abs(second[0] * ef[0] + second[1] * ef[1] + second[2] * ef[2]);
  const denominator = Math.sqrt(ef[0] ** 2 + ef[1] ** 2 + ets[0] ** 2 + ets[1] ** 2) + 1e-12;
  return numerator / denominator;
}

function essentialInliers(estimate: EssentialEstimate, pairs: FeaturePair[], threshold: number): FeaturePair[] {
  return pairs.filter((pair) => sampsonError(
    estimate.normalized,
    matrixVector(estimate.firstTransform, pair.first),
    matrixVector(estimate.secondTransform, pair.second),
  ) < threshold);
}

function triangulateNormalized(first: Vec3Tuple, second: Vec3Tuple, candidate: EssentialCandidate): { position: Vec3Tuple; error: number } | null {
  const t = candidate.translation;
  const r = candidate.matrix;
  const skewFirst = [[0, -first[2], first[1]], [first[2], 0, -first[0]], [-first[1], first[0], 0]];
  const skewSecond = [[0, -second[2], second[1]], [second[2], 0, -second[0]], [-second[1], second[0], 0]];
  const rows = skewFirst.map((row) => [...row, 0, 0, 0]);
  for (const skewRow of skewSecond) {
    const rotationRow = [0, 1, 2].map((column) => skewRow.reduce((sum, value, inner) => sum + value * r.rows[inner][column], 0));
    const translation = skewRow.reduce((sum, value, index) => sum + value * t[index], 0);
    rows.push([...rotationRow, translation]);
  }
  const normal = new Array<number>(16).fill(0);
  for (const row of rows) {
    for (let i = 0; i < 4; i += 1) for (let j = 0; j < 4; j += 1) normal[i * 4 + j] += row[i] * row[j];
  }
  const solution = smallestEigenvector(normal, 4);
  if (!solution || Math.abs(solution[3]) < 1e-8) return null;
  const point: Vec3Tuple = [solution[0] / solution[3], solution[1] / solution[3], solution[2] / solution[3]];
  const moved = matrixVector(r, point);
  const secondPoint: Vec3Tuple = [moved[0] + t[0], moved[1] + t[1], moved[2] + t[2]];
  if (point[2] <= 0.025 || secondPoint[2] <= 0.025 || Math.hypot(...point) > 250) return null;
  const error = Math.hypot(
    point[0] / point[2] - first[0] / first[2],
    point[1] / point[2] - first[1] / first[2],
    secondPoint[0] / secondPoint[2] - second[0] / second[2],
    secondPoint[1] / secondPoint[2] - second[1] / second[2],
  );
  return Number.isFinite(error) ? { position: point, error } : null;
}

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

export function estimateRelativeMotion(
  features: VioTrackedFeature[],
  intrinsics: CameraIntrinsics,
  timestamp: number,
  rotationPrior?: QuaternionTuple,
): RelativeMotionEstimate | null {
  if (features.length < 8 || !Number.isFinite(timestamp) || timestamp < 0 || !validateCameraIntrinsics(intrinsics)) return null;
  if (rotationPrior !== undefined && !isValidQuaternion(rotationPrior)) return null;
  const ids = new Set<number>();
  const validFeatures = features.filter((feature) => {
    if (
      !feature || !Number.isInteger(feature.id) || feature.id < 0 || ids.has(feature.id) ||
      ![feature.x, feature.y, feature.previousX, feature.previousY, feature.error, feature.strength].every(Number.isFinite) ||
      feature.x < 0 || feature.x >= intrinsics.width || feature.y < 0 || feature.y >= intrinsics.height ||
      feature.previousX < 0 || feature.previousX >= intrinsics.width || feature.previousY < 0 || feature.previousY >= intrinsics.height ||
      feature.error < 0 || feature.error > 1 || feature.strength <= 0
    ) return false;
    ids.add(feature.id);
    return true;
  });
  if (validFeatures.length < 8) return null;
  const pairs = validFeatures.map((feature) => ({
    feature,
    first: [(feature.previousX - intrinsics.cx) / intrinsics.fx, (feature.previousY - intrinsics.cy) / intrinsics.fy, 1] as Vec3Tuple,
    second: [(feature.x - intrinsics.cx) / intrinsics.fx, (feature.y - intrinsics.cy) / intrinsics.fy, 1] as Vec3Tuple,
  }));
  const random = seededRandom(validFeatures.length * 7919 + Math.floor(intrinsics.fx));
  let bestEssential: EssentialEstimate | null = null;
  let bestInliers: FeaturePair[] = [];
  let bestScore = 0;
  const threshold = 0.002;
  for (let iteration = 0; iteration < 320; iteration += 1) {
    const selected: FeaturePair[] = [];
    const used = new Set<number>();
    while (selected.length < 12 && used.size < pairs.length) {
      const index = Math.floor(random() * pairs.length);
      if (used.has(index)) continue;
      used.add(index);
      selected.push(pairs[index]);
    }
    if (selected.length < 12) break;
    const essential = essentialFromPairs(selected);
    if (!essential) continue;
    const inliers = essentialInliers(essential, pairs, threshold);
    const score = inliers.length + Math.min(0.25, inliers.length / pairs.length * 0.25);
    if (inliers.length >= 8 && inliers.length / pairs.length >= 0.45 && score > bestScore) {
      bestEssential = essential;
      bestInliers = inliers;
      bestScore = score;
    }
  }
  if (!bestEssential) return null;
  const refinedEssential = essentialFromPairs(bestInliers);
  if (refinedEssential) {
    const refinedInliers = essentialInliers(refinedEssential, pairs, threshold);
    if (refinedInliers.length >= 8 && refinedInliers.length >= bestInliers.length) {
      bestEssential = refinedEssential;
      bestInliers = refinedInliers;
    }
  }
  const candidates = essentialCandidates(bestEssential.matrix);
  let selected: EssentialCandidate | null = null;
  let selectedInliers: FeaturePair[] = [];
  let selectedScore = Number.NEGATIVE_INFINITY;
  for (const candidate of candidates) {
    const rotationError = rotationPrior ? quaternionAngle(candidate.rotation, rotationPrior) : 0;
    if (rotationPrior && rotationError > 0.75) continue;
    const inliers = bestInliers;
    let positive = 0;
    const stride = Math.max(1, Math.floor(inliers.length / 80));
    for (let index = 0; index < inliers.length; index += stride) {
      if (triangulateNormalized(inliers[index].first, inliers[index].second, candidate)) positive += 1;
    }
    const score = positive * 4 - rotationError * 12;
    if (positive >= Math.max(5, Math.ceil(inliers.length / stride * 0.55)) && score > selectedScore) {
      selected = candidate;
      selectedInliers = inliers;
      selectedScore = score;
    }
  }
  if (!selected) return null;

  const points: SpatialPoint[] = [];
  let errorSum = 0;
  let accepted = 0;
  for (const { feature, first, second } of selectedInliers.slice(0, 240)) {
    const triangulated = triangulateNormalized(first, second, selected);
    if (!triangulated || triangulated.error > 0.012) continue;
    const normalized = triangulated.position;
    const position: Vec3Tuple = [normalized[0] * intrinsics.fx * normalized[2], normalized[1] * intrinsics.fy * normalized[2], normalized[2]];
    const confidence = clamp((selectedInliers.length / pairs.length) * (1 - clamp(feature.error, 0, 1)) * Math.exp(-triangulated.error * 35), 0.05, 0.95);
    points.push({ id: feature.id, position, confidence, observedAt: timestamp, source: 'visual', scale: 'relative' });
    errorSum += triangulated.error;
    accepted += 1;
  }
  if (accepted < 6) return null;
  const confidence = clamp((selectedInliers.length / pairs.length) * Math.min(1, accepted / 24) * Math.exp(-errorSum / accepted * 20), 0.05, 0.95);
  return {
    rotation: selected.rotation,
    translation: [...selected.translation],
    points,
    confidence,
    inliers: selectedInliers.length,
  };
}
