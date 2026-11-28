import {
  BufferGeometry,
  Color,
  DoubleSide,
  Float32BufferAttribute,
  Group,
  Mesh,
  MeshBasicMaterial,
  Points,
  PointsMaterial,
  Scene,
} from 'three';
import type { SpatialFrame, SpatialSurface } from './types';

export interface EnvironmentRendererOptions {
  maxPoints?: number;
  maxSurfaces?: number;
  maxSurfaceVertices?: number;
  pointSize?: number;
}

function finiteVec3(values: number[], index: number): boolean {
  return Number.isFinite(values[index]) && Number.isFinite(values[index + 1]) && Number.isFinite(values[index + 2]);
}

function boundedOption(value: number | undefined, fallback: number, minimum: number, maximum = Number.MAX_SAFE_INTEGER): number {
  return Number.isFinite(value) ? Math.max(minimum, Math.min(maximum, Math.floor(value as number))) : fallback;
}

function unitInterval(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
}

export class EnvironmentRenderer {
  readonly group = new Group();
  private readonly points: Points;
  private readonly pointGeometry: BufferGeometry;
  private readonly pointMaterial: PointsMaterial;
  private readonly surfaceGroup = new Group();
  private readonly maxPoints: number;
  private readonly maxSurfaces: number;
  private readonly maxSurfaceVertices: number;
  private disposed = false;

  constructor(options: EnvironmentRendererOptions = {}) {
    this.maxPoints = boundedOption(options.maxPoints, 1500, 1, 10_000);
    this.maxSurfaces = boundedOption(options.maxSurfaces, 12, 1, 64);
    this.maxSurfaceVertices = boundedOption(options.maxSurfaceVertices, 512, 3, 4096);
    this.group.name = 'observed-environment';
    this.pointGeometry = new BufferGeometry();
    this.pointGeometry.setAttribute('position', new Float32BufferAttribute(new Float32Array(this.maxPoints * 3), 3));
    this.pointGeometry.setAttribute('color', new Float32BufferAttribute(new Float32Array(this.maxPoints * 3), 3));
    this.pointGeometry.setDrawRange(0, 0);
    this.pointMaterial = new PointsMaterial({
      size: Number.isFinite(options.pointSize) ? Math.max(0.001, Math.min(1, options.pointSize as number)) : 0.025,
      sizeAttenuation: true,
      vertexColors: true,
      transparent: true,
      opacity: 0.82,
      depthWrite: false,
    });
    this.points = new Points(this.pointGeometry, this.pointMaterial);
    this.points.name = 'observed-points';
    this.points.frustumCulled = false;
    this.surfaceGroup.name = 'observed-surfaces';
    this.group.add(this.points, this.surfaceGroup);
  }

  addTo(scene: Scene): void {
    scene.add(this.group);
  }

  update(frame: SpatialFrame): void {
    if (this.disposed) return;
    const position = this.pointGeometry.getAttribute('position') as Float32BufferAttribute;
    const color = this.pointGeometry.getAttribute('color') as Float32BufferAttribute;
    const relativeColor = new Color(0x62d9ff);
    const metricColor = new Color(0x86efac);
    const tint = new Color();
    let count = 0;
    for (let index = 0; index < frame.points.length && count < this.maxPoints; index += 1) {
      const point = frame.points[index];
      if (!point || !finiteVec3(point.position, 0)) continue;
      position.setXYZ(count, point.position[0], point.position[1], point.position[2]);
      tint.copy(point.scale === 'metric' ? metricColor : relativeColor).multiplyScalar(0.35 + unitInterval(point.confidence) * 0.65);
      color.setXYZ(count, tint.r, tint.g, tint.b);
      count += 1;
    }
    position.needsUpdate = true;
    color.needsUpdate = true;
    this.pointGeometry.setDrawRange(0, count);
    this.pointGeometry.computeBoundingSphere();
    this.rebuildSurfaces(frame.surfaces);
  }

  setVisible(visible: boolean): void {
    this.group.visible = visible;
  }

  toggleVisible(): boolean {
    this.group.visible = !this.group.visible;
    return this.group.visible;
  }

  setPointsVisible(visible: boolean): void {
    this.points.visible = visible;
  }

  setSurfacesVisible(visible: boolean): void {
    this.surfaceGroup.visible = visible;
  }

  clear(): void {
    if (this.disposed) return;
    this.pointGeometry.setDrawRange(0, 0);
    this.clearSurfaces();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clearSurfaces();
    this.pointGeometry.dispose();
    this.pointMaterial.dispose();
    this.group.removeFromParent();
    this.group.clear();
  }

  private rebuildSurfaces(surfaces: SpatialSurface[]): void {
    this.clearSurfaces();
    let remainingVertices = this.maxSurfaceVertices * this.maxSurfaces;
    for (const surface of surfaces.slice(0, this.maxSurfaces)) {
      if (
        !surface || remainingVertices < 3 || !surface.vertices || surface.vertices.length < 9 ||
        surface.vertices.length % 3 !== 0 || !surface.indices || surface.indices.length < 3
      ) continue;
      const vertexCount = Math.min(Math.floor(surface.vertices.length / 3), remainingVertices, this.maxSurfaceVertices);
      const vertices = new Float32Array(vertexCount * 3);
      const vertexMap = new Array<number>(vertexCount).fill(-1);
      let validVertices = 0;
      for (let index = 0; index < vertexCount; index += 1) {
        const offset = index * 3;
        if (!finiteVec3(surface.vertices, offset)) continue;
        vertices.set(surface.vertices.slice(offset, offset + 3), validVertices * 3);
        vertexMap[index] = validVertices;
        validVertices += 1;
      }
      if (validVertices < 3) continue;
      const indices: number[] = [];
      for (let index = 0; index + 2 < surface.indices.length; index += 3) {
        const a = vertexMap[surface.indices[index]];
        const b = vertexMap[surface.indices[index + 1]];
        const c = vertexMap[surface.indices[index + 2]];
        if (a >= 0 && b >= 0 && c >= 0) indices.push(a, b, c);
      }
      if (indices.length < 3) continue;
      const geometry = new BufferGeometry();
      geometry.setAttribute('position', new Float32BufferAttribute(vertices.slice(0, validVertices * 3), 3));
      geometry.setIndex(indices);
      geometry.computeBoundingSphere();
      const material = new MeshBasicMaterial({
        color: surface.scale === 'metric' ? 0x86efac : 0x62d9ff,
        wireframe: true,
        transparent: true,
        opacity: 0.12 + unitInterval(surface.confidence) * 0.28,
        side: DoubleSide,
        depthWrite: false,
      });
      const mesh = new Mesh(geometry, material);
      mesh.name = surface.id;
      mesh.userData.kind = surface.kind;
      mesh.userData.scale = surface.scale;
      this.surfaceGroup.add(mesh);
      remainingVertices -= validVertices;
    }
  }

  private clearSurfaces(): void {
    for (const child of [...this.surfaceGroup.children]) {
      if (child instanceof Mesh) {
        child.geometry.dispose();
        const materials = Array.isArray(child.material) ? child.material : [child.material];
        materials.forEach((material) => material.dispose());
      }
      child.removeFromParent();
    }
  }
}
