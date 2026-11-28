export interface CameraDimensions {
  width: number;
  height: number;
}

export interface NormalizedPoint {
  x: number;
  y: number;
}

export interface ViewportPoint {
  x: number;
  y: number;
}

function isValidDimensions(dimensions: CameraDimensions): boolean {
  return Number.isFinite(dimensions.width) && dimensions.width > 0
    && Number.isFinite(dimensions.height) && dimensions.height > 0;
}

/** Maps through a centered object-fit: cover crop and mirrors the source horizontally. */
export function mapCameraLandmarkToViewport(
  point: NormalizedPoint,
  camera: CameraDimensions,
  viewport: CameraDimensions,
): ViewportPoint | null {
  if (!isValidDimensions(camera) || !isValidDimensions(viewport)
    || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return null;

  const scale = Math.max(viewport.width / camera.width, viewport.height / camera.height);
  const renderedWidth = camera.width * scale;
  const renderedHeight = camera.height * scale;
  const offsetX = (viewport.width - renderedWidth) / 2;
  const offsetY = (viewport.height - renderedHeight) / 2;
  const mapped = {
    x: (1 - point.x) * renderedWidth + offsetX,
    y: point.y * renderedHeight + offsetY,
  };

  return Number.isFinite(mapped.x) && Number.isFinite(mapped.y) ? mapped : null;
}

/** Enters at enterDistance and remains pinching until releaseDistance is reached. */
export function applyPinchHysteresis(
  distance: number | null,
  wasPinching: boolean,
  enterDistance: number,
  releaseDistance: number,
): boolean {
  if (distance === null || !Number.isFinite(distance) || distance < 0
    || !Number.isFinite(enterDistance) || enterDistance < 0
    || !Number.isFinite(releaseDistance) || releaseDistance < enterDistance) return false;

  return wasPinching ? distance < releaseDistance : distance <= enterDistance;
}

function isPositiveFinite(value: number | null): value is number {
  return value !== null && Number.isFinite(value) && value > 0;
}

/** Returns a neutral ratio for invalid measurements or ranges, otherwise clamps current/start. */
export function pinchResizeRatio(
  currentDistance: number | null,
  startDistance: number | null,
  minRatio: number,
  maxRatio: number,
): number {
  if (!isPositiveFinite(currentDistance) || !isPositiveFinite(startDistance)
    || !Number.isFinite(minRatio) || !Number.isFinite(maxRatio)
    || minRatio <= 0 || maxRatio < minRatio) return 1;

  return Math.min(maxRatio, Math.max(minRatio, currentDistance / startDistance));
}
