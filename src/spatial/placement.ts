import type { WindowPoseState } from '../types';
import type { EnvironmentObject, FreeSpaceCell, SpatialSurface } from './intelligence/types';

export interface OccupiedWindowPose {
  position: WindowPoseState['position'];
  size: WindowPoseState['size'];
}

const CANDIDATE_OFFSETS: ReadonlyArray<readonly [number, number, number]> = [
  [0, 0, 0],
  [0, 0.9, 0],
  [0, -0.9, 0],
  [1.1, 0, 0],
  [-1.1, 0, 0],
  [0, 0, 1.1],
  [0, 0, -1.1],
  [0, 1.8, 0],
  [0, -1.8, 0],
  [2.2, 0, 0],
  [-2.2, 0, 0],
  [0, 0, 2.2],
  [0, 0, -2.2],
  [3.2, 0, 0],
  [-3.2, 0, 0],
  [0, 3.2, 0],
  [0, -3.2, 0],
  [0, 0, 3.2],
  [0, 0, -3.2],
];

function metricObject(object: EnvironmentObject): boolean {
  return object.scale === 'metric' && object.confidence >= 0.5 &&
    [...object.center, ...object.extents].every((value) => Number.isFinite(value)) && object.extents.every((value) => value >= 0);
}

function metricCell(cell: FreeSpaceCell): boolean {
  return cell.scale === 'metric' && cell.confidence >= 0.5 &&
    [...cell.center, ...cell.extents].every((value) => Number.isFinite(value)) && cell.extents.every((value) => value >= 0);
}

function intersectsObject(position: WindowPoseState['position'], radius: number, object: EnvironmentObject): boolean {
  const closest = {
    x: Math.max(object.center[0] - object.extents[0], Math.min(position.x, object.center[0] + object.extents[0])),
    y: Math.max(object.center[1] - object.extents[1], Math.min(position.y, object.center[1] + object.extents[1])),
    z: Math.max(object.center[2] - object.extents[2], Math.min(position.z, object.center[2] + object.extents[2])),
  };
  return Math.hypot(position.x - closest.x, position.y - closest.y, position.z - closest.z) < radius + 0.3;
}

function intersectsPlane(position: WindowPoseState['position'], radius: number, surface: SpatialSurface): boolean {
  const normal = surface.normal;
  const planePoint = surface.point;
  if (surface.kind !== 'plane' || !normal || !planePoint || surface.scale !== 'metric' || surface.confidence < 0.5) return false;
  const normalLength = Math.hypot(...normal);
  if (!Number.isFinite(normalLength) || normalLength < 1e-6 || !planePoint.every(Number.isFinite)) return false;
  const point: [number, number, number] = [position.x, position.y, position.z];
  const distance = normal.reduce((sum, value, index) => sum + value / normalLength * (point[index] - planePoint[index]), 0);
  return Math.abs(distance) < radius + 0.2;
}

function insideFreeSpace(position: WindowPoseState['position'], radius: number, cells: FreeSpaceCell[]): boolean {
  if (!cells.length) return true;
  return cells.some((cell) => (
    Math.abs(position.x - cell.center[0]) + radius <= cell.extents[0] &&
    Math.abs(position.y - cell.center[1]) + radius <= cell.extents[1] &&
    Math.abs(position.z - cell.center[2]) + radius <= cell.extents[2]
  ));
}

function intersectsWindow(position: WindowPoseState['position'], radius: number, occupied: OccupiedWindowPose): boolean {
  const otherRadius = Math.max(occupied.size.width, occupied.size.height) / 2;
  return Math.hypot(position.x - occupied.position.x, position.y - occupied.position.y, position.z - occupied.position.z) < radius + otherRadius + 0.35;
}

export function avoidObservedObstacles(
  pose: WindowPoseState,
  objects: EnvironmentObject[],
  surfaces: SpatialSurface[],
  freeSpace: FreeSpaceCell[],
  occupied: OccupiedWindowPose[] = [],
): WindowPoseState {
  const radius = Math.max(pose.size.width, pose.size.height) / 2;
  const metricObjects = objects.filter(metricObject);
  const metricFreeSpace = freeSpace.filter(metricCell);
  for (const offset of CANDIDATE_OFFSETS) {
    const position = {
      x: pose.position.x + offset[0],
      y: pose.position.y + offset[1],
      z: pose.position.z + offset[2],
    };
    if (![position.x, position.y, position.z].every(Number.isFinite)) continue;
    if (metricObjects.some((object) => intersectsObject(position, radius, object))) continue;
    if (surfaces.some((surface) => intersectsPlane(position, radius, surface))) continue;
    if (!insideFreeSpace(position, radius, metricFreeSpace)) continue;
    if (occupied.some((window) => intersectsWindow(position, radius, window))) continue;
    return offset[0] === 0 && offset[1] === 0 && offset[2] === 0 ? pose : { ...pose, position };
  }
  return pose;
}
