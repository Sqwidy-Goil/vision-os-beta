import {
  Color,
  CylinderGeometry,
  DoubleSide,
  DynamicDrawUsage,
  Group,
  InstancedMesh,
  Matrix4,
  MeshBasicMaterial,
  Quaternion,
  SphereGeometry,
  Vector3,
} from 'three';
import type { HandVisualPoint } from '../types';
import { mapCameraLandmarkToViewport, type CameraDimensions } from '../tracking/handMapping';

const HAND_CONNECTIONS: Array<[number, number]> = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [17, 18], [18, 19], [19, 20],
  [0, 17],
];

interface SpatialHandFrame {
  landmarks: HandVisualPoint[];
  secondaryLandmarks?: HandVisualPoint[];
  arms: HandVisualPoint[];
  pinching: boolean;
}

export class SpatialHands {
  readonly group = new Group();
  private readonly bones: InstancedMesh;
  private readonly joints: InstancedMesh;
  private readonly armBones: InstancedMesh;
  private readonly palms: InstancedMesh;
  private readonly handMaterial: MeshBasicMaterial;
  private readonly armMaterial: MeshBasicMaterial;
  private readonly jointMaterial: MeshBasicMaterial;
  private readonly palmMaterial: MeshBasicMaterial;
  private readonly matrix = new Matrix4();
  private readonly midpoint = new Vector3();
  private readonly direction = new Vector3();
  private readonly quaternion = new Quaternion();
  private readonly scale = new Vector3();
  private readonly up = new Vector3(0, 1, 0);

  constructor() {
    this.handMaterial = this.material('#75e7ff', 0.88);
    this.armMaterial = this.material('#efb28f', 0.46);
    this.jointMaterial = this.material('#f4fcff', 0.96);
    this.palmMaterial = this.material('#f5c29b', 0.17);
    this.bones = new InstancedMesh(new CylinderGeometry(0.009, 0.009, 1, 7), this.handMaterial, 48);
    this.joints = new InstancedMesh(new SphereGeometry(0.018, 8, 6), this.jointMaterial, 44);
    this.armBones = new InstancedMesh(new CylinderGeometry(0.024, 0.032, 1, 9), this.armMaterial, 10);
    this.palms = new InstancedMesh(new SphereGeometry(0.075, 10, 8), this.palmMaterial, 2);
    this.palms.instanceMatrix.setUsage(DynamicDrawUsage);
    for (const mesh of [this.bones, this.joints, this.armBones, this.palms]) {
      mesh.instanceMatrix.setUsage(DynamicDrawUsage);
      mesh.frustumCulled = false;
      mesh.renderOrder = 4_000_000;
      mesh.count = 0;
      this.group.add(mesh);
    }
    this.group.visible = false;
  }

  hide(): void {
    this.group.visible = false;
  }

  update(
    frame: SpatialHandFrame | null,
    cameraQuaternion: Quaternion,
    viewport: { width: number; height: number },
    camera: CameraDimensions,
    fov: number,
    eye: 'left' | 'right' | null = null,
  ): void {
    if (!frame || (!frame.landmarks.length && !frame.arms.length)) {
      this.hide();
      return;
    }
    const distance = 1.8;
    const planeHeight = 2 * Math.tan(fov * Math.PI / 360) * distance;
    const planeWidth = planeHeight * viewport.width / Math.max(1, viewport.height);
    const mappingViewport = eye ? { width: viewport.width * 2, height: viewport.height } : viewport;
    const project = (point: HandVisualPoint): Vector3 | null => {
      if ((point.visibility ?? 1) < 0.2) return null;
      const mapped = mapCameraLandmarkToViewport(point, camera, mappingViewport);
      if (!mapped) return null;
      if (eye === 'right') mapped.x -= viewport.width;
      const relativeDepth = Math.max(-0.16, Math.min(0.16, (point.z ?? 0) * 0.28));
      return new Vector3(
        (mapped.x / Math.max(1, viewport.width) - 0.5) * planeWidth,
        (0.5 - mapped.y / Math.max(1, viewport.height)) * planeHeight,
        -distance + relativeDepth,
      );
    };

    this.group.visible = true;
    this.group.position.set(0, 0, -distance).applyQuaternion(cameraQuaternion);
    this.group.quaternion.copy(cameraQuaternion);
    this.group.updateMatrixWorld();

    let boneCount = 0;
    let jointCount = 0;
    let palmCount = 0;
    this.handMaterial.color.set(frame.pinching ? '#7cf5c8' : '#75e7ff');
    for (const landmarks of [frame.landmarks, frame.secondaryLandmarks ?? []]) {
      const points = landmarks.map(project);
      for (const [from, to] of HAND_CONNECTIONS) {
        const start = points[from];
        const end = points[to];
        if (!start || !end || boneCount >= this.bones.instanceMatrix.count) continue;
        this.setBone(this.bones, boneCount++, start, end, 1);
      }
      for (const point of points) {
        if (!point || jointCount >= this.joints.instanceMatrix.count) continue;
        this.matrix.makeTranslation(point.x, point.y, point.z);
        this.joints.setMatrixAt(jointCount++, this.matrix);
      }
      const palmPoints = [0, 1, 5, 9, 13, 17].map((index) => points[index]).filter((point): point is Vector3 => Boolean(point));
      if (palmPoints.length >= 3 && palmCount < this.palms.instanceMatrix.count) {
        const center = palmPoints.reduce((sum, point) => sum.add(point), new Vector3()).multiplyScalar(1 / palmPoints.length);
        this.matrix.compose(center, new Quaternion(), new Vector3(1.15, 1.35, 0.32));
        this.palms.setMatrixAt(palmCount++, this.matrix);
      }
    }

    let armCount = 0;
    const projectedArms = frame.arms.map(project);
    for (const [shoulderIndex, elbowIndex, wristIndex] of [[11, 13, 15], [12, 14, 16]] as const) {
      const shoulder = projectedArms[shoulderIndex];
      const wrist = projectedArms[wristIndex];
      const elbow = projectedArms[elbowIndex];
      if (!shoulder || !wrist) continue;
      if (elbow) {
        if (armCount < this.armBones.instanceMatrix.count) this.setBone(this.armBones, armCount++, shoulder, elbow, 1.2);
        if (armCount < this.armBones.instanceMatrix.count) this.setBone(this.armBones, armCount++, elbow, wrist, 1.2);
      } else if (armCount < this.armBones.instanceMatrix.count) {
        this.setBone(this.armBones, armCount++, shoulder, wrist, 1.2);
      }
    }

    for (const landmarks of [frame.landmarks, frame.secondaryLandmarks ?? []]) {
      if (!landmarks.length) continue;
      const wristPoint = landmarks[0];
      const knucklePoint = landmarks[9] ?? landmarks[5];
      if (!wristPoint || !knucklePoint) continue;
      const wrist = project(wristPoint);
      const knuckle = project(knucklePoint);
      if (!wrist || !knuckle) continue;
      const trackedWrist = projectedArms.some((point, index) =>
        (index === 15 || index === 16)
        && point
        && point.distanceToSquared(wrist) < 0.45);
      if (trackedWrist || armCount >= this.armBones.instanceMatrix.count) continue;
      const length = Math.max(0.01, wrist.distanceTo(knuckle));
      const end = wrist.clone().add(wrist.clone().sub(knuckle).normalize().multiplyScalar(length * 4.8));
      this.setBone(this.armBones, armCount++, wrist, end, 1.35);
    }

    for (const [mesh, count] of [[this.bones, boneCount], [this.joints, jointCount], [this.armBones, armCount], [this.palms, palmCount]] as const) {
      mesh.count = count;
      mesh.instanceMatrix.needsUpdate = true;
    }
  }

  destroy(): void {
    for (const mesh of [this.bones, this.joints, this.armBones, this.palms]) {
      mesh.geometry.dispose();
      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      materials.forEach((material) => material.dispose());
    }
    this.group.removeFromParent();
  }

  private material(color: string, opacity: number): MeshBasicMaterial {
    return new MeshBasicMaterial({
      color: new Color(color),
      transparent: true,
      opacity,
      depthTest: false,
      depthWrite: false,
      side: DoubleSide,
      toneMapped: false,
    });
  }

  private setBone(mesh: InstancedMesh, index: number, start: Vector3, end: Vector3, radius: number): void {
    this.direction.subVectors(end, start);
    const length = Math.max(0.0001, this.direction.length());
    this.midpoint.addVectors(start, end).multiplyScalar(0.5);
    this.quaternion.setFromUnitVectors(this.up, this.direction.normalize());
    this.scale.set(radius, length, radius);
    this.matrix.compose(this.midpoint, this.quaternion, this.scale);
    mesh.setMatrixAt(index, this.matrix);
  }
}
