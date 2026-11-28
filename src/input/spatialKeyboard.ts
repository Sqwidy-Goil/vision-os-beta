import {
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  Color,
  DataTexture,
  DoubleSide,
  Group,
  LinearFilter,
  Mesh,
  MeshBasicMaterial,
  MeshPhysicalMaterial,
  PlaneGeometry,
  Quaternion,
  RGBAFormat,
  Raycaster,
  SRGBColorSpace,
  Texture,
  Vector2,
  Vector3,
} from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import type { KeyboardLayout, WindowMode } from '../types';
import {
  getKeyboardLayout,
  getKeyboardRows,
  resolveKeyboardKey,
  type DeadAccent,
  type KeyboardKeyDefinition,
  type KeyboardLayoutDefinition,
  type KeyboardModifiers,
  type KeyboardPage,
  type KeyboardRow,
  type ResolvedKeyboardKey,
} from './azertyLayout';

export interface SpatialKeyboardTarget {
  key: string;
  action: () => void;
}

export interface SpatialKeyboardPrompt {
  title: string;
  value: string;
  placeholder?: string;
  secret?: boolean;
  submitLabel: string;
  cancelLabel?: string;
  mode?: 'text' | 'information' | 'confirm';
}

export interface SpatialKeyboardOptions {
  getLayout: () => KeyboardLayout;
  getTransparency: () => number;
  getAccent?: () => string;
  onPress: (key: KeyboardKeyDefinition) => void;
}

export interface SpatialKeyboardKeyState {
  press: number;
  hover: number;
  pressed: boolean;
}

interface KeyRegion {
  key: KeyboardKeyDefinition;
  u0: number;
  u1: number;
  v0: number;
  v1: number;
}

interface PromptActionRegion {
  key: KeyboardKeyDefinition;
  u0: number;
  u1: number;
}

interface KeyVisual {
  definition: KeyboardKeyDefinition;
  group: Group;
  body: Mesh<RoundedBoxGeometry, MeshPhysicalMaterial>;
  rim: Mesh<RoundedBoxGeometry, MeshBasicMaterial>;
  reflection: Mesh<PlaneGeometry, MeshBasicMaterial>;
  label: Mesh<PlaneGeometry, MeshBasicMaterial> | null;
  labelTexture: CanvasTexture | null;
  normal: Vector3;
  basePosition: Vector3;
  baseQuaternion: Quaternion;
  press: number;
  hover: number;
  holdUntil: number;
}

export const KEYBOARD_WIDTH = 3.4;
export const CURVE_SEGMENTS_X = 48;
export const CURVE_SEGMENTS_Y = 18;
export const KEYBOARD_CURVE_DEPTH = 0.34;
export const KEYBOARD_PROMPT_WIDTH = KEYBOARD_WIDTH;
export const KEYBOARD_PROMPT_HEIGHT = 0.28;
const KEY_HEIGHT = 1;
const ROW_GAP = 0.12;
const KEY_GAP = 0.12;
const FLOATING_HEIGHT = 0.032;

/** A single gently cylindrical lap surface; there are no side-wing geometries. */
export function curvedSurfacePoint(
  x: number,
  y: number,
  width = KEYBOARD_WIDTH,
  height = 1.1,
  curveDepth = KEYBOARD_CURVE_DEPTH,
): Vector3 {
  const nx = Math.max(-1, Math.min(1, x / (width * 0.5)));
  const ny = Math.max(-1, Math.min(1, y / (height * 0.5)));
  const cylinder = 1 - Math.sqrt(Math.max(0.08, 1 - nx * nx));
  return new Vector3(
    x,
    y - height * 0.045 * ny * ny,
    curveDepth * cylinder + height * 0.025 * ny * ny,
  );
}

export function curvedSurfaceFrame(
  x: number,
  y: number,
  width = KEYBOARD_WIDTH,
  height = 1.1,
  curveDepth = KEYBOARD_CURVE_DEPTH,
): { position: Vector3; normal: Vector3 } {
  const epsilon = Math.max(0.0001, width * 0.0001);
  const position = curvedSurfacePoint(x, y, width, height, curveDepth);
  const tangentX = curvedSurfacePoint(x + epsilon, y, width, height, curveDepth).sub(position);
  const tangentY = curvedSurfacePoint(x, y + epsilon, width, height, curveDepth).sub(position);
  const normal = tangentX.cross(tangentY).normalize();
  if (normal.z < 0) normal.negate();
  return { position, normal };
}

export function surfacePointAtUV(
  u: number,
  v: number,
  width = KEYBOARD_WIDTH,
  height = 1.1,
  curveDepth = KEYBOARD_CURVE_DEPTH,
): Vector3 {
  return curvedSurfacePoint((u - 0.5) * width, (v - 0.5) * height, width, height, curveDepth);
}

/** Builds an indexed, subdivided surface with bottom-to-top UVs matching raycast UVs. */
export function createCurvedSurfaceGeometry(
  width = KEYBOARD_WIDTH,
  height = 1.1,
  curveDepth = KEYBOARD_CURVE_DEPTH,
): BufferGeometry {
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];

  for (let row = 0; row <= CURVE_SEGMENTS_Y; row += 1) {
    const v = row / CURVE_SEGMENTS_Y;
    for (let column = 0; column <= CURVE_SEGMENTS_X; column += 1) {
      const u = column / CURVE_SEGMENTS_X;
      const point = surfacePointAtUV(u, v, width, height, curveDepth);
      positions.push(point.x, point.y, point.z);
      uvs.push(u, v);
    }
  }

  for (let row = 0; row < CURVE_SEGMENTS_Y; row += 1) {
    for (let column = 0; column < CURVE_SEGMENTS_X; column += 1) {
      const a = row * (CURVE_SEGMENTS_X + 1) + column;
      const b = a + 1;
      const d = a + CURVE_SEGMENTS_X + 1;
      const c = d + 1;
      indices.push(a, b, d, b, c, d);
    }
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
  geometry.setAttribute('uv', new BufferAttribute(new Float32Array(uvs), 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return geometry;
}

function rowWidth(row: KeyboardRow): number {
  return row.keys.reduce((sum, key) => sum + (key.width ?? 1), 0) + KEY_GAP * Math.max(0, row.keys.length - 1);
}

function layoutMetrics(rows: KeyboardRow[]): { unit: number; width: number; height: number } {
  const maxWidth = Math.max(...rows.map(rowWidth));
  const unit = KEYBOARD_WIDTH / maxWidth;
  return {
    unit,
    width: KEYBOARD_WIDTH,
    height: (rows.length * KEY_HEIGHT + (rows.length - 1) * ROW_GAP) * unit,
  };
}

function fillPromptRect(context: CanvasRenderingContext2D, x: number, y: number, width: number, height: number, radius: number): void {
  const r = Math.min(radius, width / 2, height / 2);
  context.beginPath();
  context.moveTo(x + r, y);
  context.arcTo(x + width, y, x + width, y + height, r);
  context.arcTo(x + width, y + height, x, y + height, r);
  context.arcTo(x, y + height, x, y, r);
  context.arcTo(x, y, x + width, y, r);
  context.closePath();
  context.fill();
}

function createReflectionTexture(): DataTexture {
  const size = 64;
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const offset = (y * size + x) * 4;
      const glow = Math.max(0, 1 - y / size) * Math.max(0, 1 - x / (size * 0.85));
      data[offset] = 220;
      data[offset + 1] = 226;
      data[offset + 2] = 255;
      data[offset + 3] = Math.round(150 * glow);
    }
  }
  const texture = new DataTexture(data, size, size, RGBAFormat);
  texture.colorSpace = SRGBColorSpace;
  texture.minFilter = LinearFilter;
  texture.magFilter = LinearFilter;
  texture.needsUpdate = true;
  return texture;
}

function createLabelTexture(key: KeyboardKeyDefinition, resolved: ResolvedKeyboardKey): CanvasTexture | null {
  const ownerDocument = typeof document === 'undefined' ? null : document;
  if (!ownerDocument || typeof ownerDocument.createElement !== 'function') return null;
  const canvas = ownerDocument.createElement('canvas');
  canvas.width = 256;
  canvas.height = 128;
  const context = canvas.getContext('2d');
  if (!context) return null;
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.fillStyle = '#f7f8ff';
  const longLabel = resolved.label.length > 3;
  let fontSize = longLabel ? 30 : 48;
  context.font = `600 ${fontSize}px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`;
  while (context.measureText(resolved.label).width > 226 && fontSize > 16) {
    fontSize -= 2;
    context.font = `600 ${fontSize}px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`;
  }
  context.fillText(resolved.label, 128, longLabel ? 66 : 58, 226);
  if (key.value && key.value !== resolved.label && !key.action) {
    context.font = '500 20px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
    context.fillStyle = 'rgba(221, 218, 255, .72)';
    context.textAlign = 'left';
    context.fillText(key.value, 20, 24, 70);
  }
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.minFilter = LinearFilter;
  texture.magFilter = LinearFilter;
  texture.generateMipmaps = false;
  return texture;
}

/** One spatial keyboard instance, including its curved hit surface and individual glass keys. */
export class SpatialKeyboard {
  readonly group = new Group();
  readonly surface: Mesh<BufferGeometry, MeshPhysicalMaterial>;

  private readonly options: SpatialKeyboardOptions;
  private readonly raycaster = new Raycaster();
  private readonly keyGeometry = new RoundedBoxGeometry(1, 1, 1, 3, 0.16);
  private readonly reflectionGeometry = new PlaneGeometry(1, 1);
  private readonly labelGeometry = new PlaneGeometry(1, 1);
  private readonly reflectionTexture = createReflectionTexture();
  private readonly surfaceMaterial: MeshPhysicalMaterial;
  private readonly visuals = new Map<string, KeyVisual>();
  private regions: KeyRegion[] = [];
  private rows: KeyboardRow[] = [];
  private metrics = { unit: 0.2, width: KEYBOARD_WIDTH, height: 1.1 };
  private layoutId: KeyboardLayout;
  private page: KeyboardPage = 'letters';
  private prompt: SpatialKeyboardPrompt | null = null;
  private hovered: string | null = null;
  private pendingAccent: DeadAccent | null = null;
  private shift = false;
  private caps = false;
  private altGr = false;
  private elapsed = 0;
  private destroyed = false;
  private worldAnchored = false;
  private positioningMode: WindowMode = 'world';
  private hasCameraPose = false;
  private readonly lastCameraPosition = new Vector3();
  private readonly lastCameraQuaternion = new Quaternion();
  private readonly headPosition = new Vector3();
  private readonly headQuaternion = new Quaternion();
  private readonly individualQuaternion = new Quaternion();
  private promptDirty = true;
  private promptFeedbackKey: string | null = null;
  private promptFeedbackUntil = 0;
  private promptCanvas: HTMLCanvasElement | null = null;
  private promptContext: CanvasRenderingContext2D | null = null;
  private promptTexture: CanvasTexture | null = null;
  private promptMesh: Mesh<BufferGeometry, MeshBasicMaterial> | null = null;
  private interfaceAccent = '#75e7ff';

  constructor(options: SpatialKeyboardOptions) {
    this.options = options;
    this.interfaceAccent = options.getAccent?.() ?? this.interfaceAccent;
    this.layoutId = options.getLayout();
    this.group.name = 'UniversalSpatialKeyboard';
    this.group.visible = false;
    this.surfaceMaterial = new MeshPhysicalMaterial({
      color: new Color('#dce3ea'),
      emissive: new Color(this.interfaceAccent),
      emissiveIntensity: 0.025,
      metalness: 0.04,
      roughness: 0.2,
      transmission: 0.16,
      thickness: 0.08,
      transparent: true,
      opacity: 0.25,
      clearcoat: 1,
      clearcoatRoughness: 0.16,
      side: DoubleSide,
      depthWrite: false,
    });
    this.surface = new Mesh(createCurvedSurfaceGeometry(), this.surfaceMaterial);
    this.surface.name = 'Curved keyboard UV surface';
    this.surface.userData.spatialKeyboardSurface = true;
    this.surface.renderOrder = 100;
    this.group.add(this.surface);
    this.createPrompt();
    this.rebuild();
  }

  get layout(): KeyboardLayoutDefinition {
    return getKeyboardLayout(this.layoutId);
  }

  get currentPage(): KeyboardPage {
    return this.page;
  }

  get modifiers(): KeyboardModifiers {
    return { shift: this.shift, caps: this.caps, altGr: this.altGr };
  }

  get isShifted(): boolean {
    return this.shift;
  }

  get isCapsLocked(): boolean {
    return this.caps;
  }

  get isAltGr(): boolean {
    return this.altGr;
  }

  setInterfacePalette(accent = this.options.getAccent?.()): void {
    const next = accent ?? this.interfaceAccent;
    if (next === this.interfaceAccent) return;
    this.interfaceAccent = next;
    this.surfaceMaterial.emissive.set(next);
    for (const visual of this.visuals.values()) visual.body.material.emissive.set(next);
    this.promptDirty = true;
    this.update(0);
  }

  setLayout(layout: KeyboardLayout): void {
    if (layout === this.layoutId) return;
    this.layoutId = layout;
    this.page = 'letters';
    this.pendingAccent = null;
    this.clearHover();
    this.rebuild();
  }

  setPage(page: KeyboardPage): void {
    if (page === this.page) return;
    this.page = page;
    this.pendingAccent = null;
    this.clearHover();
    this.rebuild();
  }

  setContext(prompt: SpatialKeyboardPrompt | null): void {
    this.prompt = prompt;
    this.promptDirty = true;
  }

  get positioning(): WindowMode {
    return this.positioningMode;
  }

  setPositioning(mode: WindowMode): void {
    if (this.destroyed || mode === this.positioningMode) return;
    this.positioningMode = mode;
    if (!this.hasCameraPose) {
      this.worldAnchored = false;
    } else if (mode === 'head') {
      this.captureHeadPose();
    } else if (mode === 'individual') {
      this.captureIndividualPose();
    }
    this.promptDirty = true;
  }

  cyclePositioning(): WindowMode {
    const modes = ['world', 'head', 'individual'] as const;
    const mode = modes[(modes.indexOf(this.positioningMode) + 1) % modes.length];
    this.setPositioning(mode);
    return this.positioningMode;
  }

  reposition(): void {
    this.setPositioning('world');
    this.worldAnchored = false;
    this.promptDirty = true;
  }

  toggleShift(): void {
    this.shift = !this.shift;
    this.rebuild();
  }

  toggleCaps(): void {
    this.caps = !this.caps;
    this.rebuild();
  }

  toggleAltGr(): void {
    this.altGr = !this.altGr;
    this.rebuild();
  }

  consumeTextModifiers(): void {
    if (!this.shift && !this.altGr) return;
    this.shift = false;
    this.altGr = false;
    this.rebuild();
  }

  setPendingAccent(accent: DeadAccent | null): void {
    if (accent === this.pendingAccent) return;
    this.pendingAccent = accent;
    this.rebuild();
  }

  resetModifiers(): void {
    if (!this.shift && !this.caps && !this.altGr && this.pendingAccent === null) return;
    this.shift = false;
    this.caps = false;
    this.altGr = false;
    this.pendingAccent = null;
    this.rebuild();
  }

  getKey(id: string): KeyboardKeyDefinition | null {
    return this.regions.find((region) => region.key.id === id)?.key
      ?? this.promptActions().find((key) => key.id === id)
      ?? null;
  }

  target(u: number, v: number): SpatialKeyboardTarget | null {
    if (this.destroyed || !this.group.visible || !Number.isFinite(u) || !Number.isFinite(v)) return null;
    const uv = this.raycastUV(u, v);
    if (!uv) return null;
    const region = this.regions.find((candidate) =>
      uv.x >= candidate.u0 && uv.x <= candidate.u1 && uv.y >= candidate.v0 && uv.y <= candidate.v1);
    return region ? this.targetForKey(region.key) : null;
  }

  promptTarget(u: number, v: number): SpatialKeyboardTarget | null {
    if (this.destroyed || !this.group.visible || !Number.isFinite(u) || !Number.isFinite(v)) return null;
    if (u < 0 || u > 1 || v < 0.08 || v > 0.92) return null;
    const region = this.promptActionRegions().find((candidate) => u >= candidate.u0 && u <= candidate.u1);
    return region ? this.targetForKey(region.key) : null;
  }

  pick(raycaster: Raycaster): SpatialKeyboardTarget | null {
    if (this.destroyed || !this.group.visible) return null;
    const surfaces = this.promptMesh ? [this.promptMesh, this.surface] : [this.surface];
    const hit = raycaster.intersectObjects(surfaces, false).sort((a, b) => a.distance - b.distance)[0];
    if (!hit?.uv) return null;
    return hit.object === this.promptMesh
      ? this.promptTarget(hit.uv.x, hit.uv.y)
      : this.target(hit.uv.x, hit.uv.y);
  }

  keyCenter(key: string): { u: number; v: number } | null {
    const region = this.regions.find((candidate) => candidate.key.id === key);
    if (region) return { u: (region.u0 + region.u1) * 0.5, v: (region.v0 + region.v1) * 0.5 };
    const action = this.promptActionRegions().find((candidate) => candidate.key.id === key);
    return action ? { u: (action.u0 + action.u1) * 0.5, v: 0.5 } : null;
  }

  keyWorldPoint(key: string): Vector3 | null {
    const center = this.keyCenter(key);
    if (!center) return null;
    this.group.updateMatrixWorld(true);
    if (this.promptActions().some((action) => action.id === key) && this.promptMesh) {
      return this.promptMesh.localToWorld(new Vector3(
        (center.u - 0.5) * KEYBOARD_PROMPT_WIDTH,
        (center.v - 0.5) * KEYBOARD_PROMPT_HEIGHT,
        0.006,
      ));
    }
    return this.group.localToWorld(surfacePointAtUV(center.u, center.v, this.metrics.width, this.metrics.height));
  }

  hover(u: number, v: number): void {
    const uv = this.raycastUV(u, v);
    const region = uv ? this.regionAtUV(uv.x, uv.y) : null;
    this.setHovered(region?.key.id ?? null);
  }

  hoverKey(key: string | null): void {
    this.setHovered(key);
  }

  clearHover(): void {
    this.setHovered(null);
  }

  pressFeedback(key: string): void {
    if (this.promptActions().some((action) => action.id === key)) {
      this.promptFeedbackKey = key;
      this.promptFeedbackUntil = this.elapsed + 0.12;
      this.promptDirty = true;
      return;
    }
    const visual = this.visuals.get(key);
    if (!visual || this.destroyed) return;
    visual.press = 1;
    visual.holdUntil = this.elapsed + 0.09;
    this.updateVisual(visual, 0);
  }

  getKeyState(key: string): SpatialKeyboardKeyState | null {
    const visual = this.visuals.get(key);
    if (visual) return { press: visual.press, hover: visual.hover, pressed: visual.press > 0.05 };
    if (!this.promptActions().some((action) => action.id === key)) return null;
    const press = this.elapsed < this.promptFeedbackUntil && this.promptFeedbackKey === key ? 1 : 0;
    const hover = this.hovered === key ? 1 : 0;
    return { press, hover, pressed: press > 0.05 };
  }

  update(delta: number, cameraPosition?: Vector3, cameraQuaternion?: Quaternion, vrActive = false, verticalFov = 70, aspect = 1, distortion = 0): void {
    if (this.destroyed) return;
    this.elapsed += Math.max(0, Math.min(delta, 0.1));
    if (cameraPosition && cameraQuaternion) {
      this.lastCameraPosition.copy(cameraPosition);
      this.lastCameraQuaternion.copy(cameraQuaternion).normalize();
      this.hasCameraPose = true;
    }
    if (!this.worldAnchored && cameraPosition && cameraQuaternion) {
      const distance = vrActive ? 0.92 : 0.82;
      const fov = Math.max(20, Math.min(110, verticalFov));
      const eyeAspect = Math.max(0.5, aspect);
      const halfHeight = Math.tan(fov * Math.PI / 360) * distance;
      const tangent = halfHeight / distance;
      const lensDistortion = Math.max(0, Math.min(0.3, distortion));
      const lapTilt = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), -0.16);
      const fit = Math.min(
        halfHeight * 2 * eyeAspect * 0.9 / this.metrics.width,
        halfHeight * 2 * 0.72 / this.metrics.height,
        0.5,
      );
      let keyboardScale = fit;
      let bottom = -halfHeight * 0.86;
      let centerY = bottom + this.metrics.height * keyboardScale * 0.5;

      for (let iteration = 0; iteration < 12; iteration += 1) {
        centerY = bottom + this.metrics.height * keyboardScale * 0.5;
        let minY = Infinity;
        let maxY = -Infinity;
        let maxX = 0;
        for (const x of [-this.metrics.width * 0.5, this.metrics.width * 0.5]) {
          for (const y of [-this.metrics.height * 0.5, this.metrics.height * 0.5 + 0.395]) {
            const ny = Math.max(-1, Math.min(1, y / (this.metrics.height * 0.5)));
            const nx = Math.max(-1, Math.min(1, x / (this.metrics.width * 0.5)));
            const localX = x * keyboardScale;
            const localY = (y - this.metrics.height * 0.045 * ny * ny) * keyboardScale;
            const localZ = (KEYBOARD_CURVE_DEPTH * (1 - Math.sqrt(Math.max(0.08, 1 - nx * nx)))
              + this.metrics.height * 0.025 * ny * ny) * keyboardScale;
            const rotatedY = localY * Math.cos(-0.16) - localZ * Math.sin(-0.16) + centerY;
            const rotatedZ = localY * Math.sin(-0.16) + localZ * Math.cos(-0.16);
            const depth = distance - rotatedZ;
            const ndcX = localX / (depth * tangent * eyeAspect);
            const ndcY = rotatedY / (depth * tangent);
            const radiusSquared = ndcX * ndcX + ndcY * ndcY;
            const lensScale = 1 + lensDistortion * radiusSquared
              + lensDistortion * 0.35 * radiusSquared * radiusSquared;
            minY = Math.min(minY, ndcY * lensScale);
            maxY = Math.max(maxY, ndcY * lensScale);
            maxX = Math.max(maxX, Math.abs(ndcX * lensScale));
          }
        }
        if (maxX <= 0.96 && minY >= -0.96 && maxY <= 0.96) break;
        if (maxX > 0.96) keyboardScale *= 0.96 / maxX;
        if (maxY - minY > 1.92) keyboardScale *= 1.92 / (maxY - minY);
        if (minY < -0.96) bottom += -0.96 - minY;
        if (maxY > 0.96) bottom -= maxY - 0.96;
      }

      const position = new Vector3(0, centerY, -distance).applyQuaternion(cameraQuaternion).add(cameraPosition);
      this.group.position.copy(position);
      this.group.quaternion.copy(cameraQuaternion).multiply(lapTilt);
      this.group.scale.setScalar(keyboardScale);
      this.group.updateMatrixWorld(true);
      this.worldAnchored = true;
      if (this.positioningMode === 'head') this.captureHeadPose();
      else if (this.positioningMode === 'individual') this.captureIndividualPose();
    }
    if (this.hasCameraPose && cameraPosition && cameraQuaternion) {
      if (this.positioningMode === 'head') {
        this.group.position.copy(this.headPosition).applyQuaternion(cameraQuaternion).add(cameraPosition);
        this.group.quaternion.copy(cameraQuaternion).multiply(this.headQuaternion);
        this.group.updateMatrixWorld(true);
      } else if (this.positioningMode === 'individual') {
        this.group.quaternion.copy(cameraQuaternion).multiply(this.individualQuaternion);
        this.group.updateMatrixWorld(true);
      }
    }
    const transparency = Math.max(0, Math.min(1, this.options.getTransparency()));
    this.surfaceMaterial.opacity = 0.12 - transparency * 0.09;
    this.surfaceMaterial.transmission = 0.24 + transparency * 0.5;
    for (const visual of this.visuals.values()) this.updateVisual(visual, delta);
    if (this.promptMesh) this.promptMesh.material.opacity = 0.92 - transparency * 0.2;
  }

  render(): void {
    if (this.destroyed || !this.promptDirty || !this.promptContext || !this.promptTexture) return;
    const context = this.promptContext;
    const canvas = this.promptCanvas;
    if (!canvas) return;
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = 'rgba(230, 236, 244, 0.11)';
    fillPromptRect(context, 1, 1, canvas.width - 2, canvas.height - 2, 24);
    context.strokeStyle = `${this.interfaceAccent}4d`;
    context.lineWidth = 2;
    context.stroke();
    const previewWidth = canvas.width * 0.68;
    context.textAlign = 'left';
    context.textBaseline = 'middle';
    context.fillStyle = 'rgba(246,248,252,0.68)';
    context.font = '600 19px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
    context.fillText(this.prompt?.title ?? 'Spatial keyboard', 24, 25, previewWidth - 48);
    context.fillStyle = '#f7f9fc';
    context.font = '450 23px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
    const display = this.prompt?.secret
      ? '•'.repeat(Array.from(this.prompt.value).length)
      : this.prompt?.value || this.prompt?.placeholder || '';
    context.fillText(display.slice(-220), 24, 65, previewWidth - 48);

    const actions = this.promptActions();
    const actionWidth = (canvas.width - previewWidth) / actions.length;
    actions.forEach((action, index) => {
      const x = previewWidth + index * actionWidth;
      const hovered = this.hovered === action.id;
      const pressed = this.promptFeedbackKey === action.id && this.elapsed < this.promptFeedbackUntil;
      context.fillStyle = hovered || pressed ? `${this.interfaceAccent}33` : 'rgba(255,255,255,0.055)';
      fillPromptRect(context, x + 7, 10, actionWidth - 14, canvas.height - 20, 18);
      context.strokeStyle = hovered || pressed ? `${this.interfaceAccent}9e` : 'rgba(255,255,255,0.16)';
      context.lineWidth = 2;
      context.stroke();
      context.textAlign = 'center';
      context.fillStyle = action.action === 'cancel' ? '#ffd3d8' : action.action === 'submit' ? '#d5f8e8' : '#f1f4f8';
      if (action.action === 'mode') {
        context.font = '600 11px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
        context.fillStyle = 'rgba(220,231,247,.62)';
        context.fillText('MODE ↻', x + actionWidth / 2, canvas.height / 2 - 17, actionWidth - 18);
        context.font = '600 18px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
        context.fillStyle = '#f1f4f8';
        context.fillText(action.label ?? action.id, x + actionWidth / 2, canvas.height / 2 + 14, actionWidth - 18);
      } else {
        context.font = action.id === 'close' ? '500 34px -apple-system, BlinkMacSystemFont, sans-serif' : '600 19px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
        context.fillText(action.label ?? action.id, x + actionWidth / 2, canvas.height / 2 + 1, actionWidth - 24);
      }
    });
    if (this.promptFeedbackKey && this.elapsed >= this.promptFeedbackUntil) this.promptFeedbackKey = null;
    context.textAlign = 'left';
    this.promptTexture.needsUpdate = true;
    this.promptDirty = false;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.group.visible = false;
    this.group.removeFromParent();
    const geometries = new Set<BufferGeometry>();
    const materials = new Set<MeshBasicMaterial | MeshPhysicalMaterial>();
    const textures = new Set<Texture>();
    this.group.traverse((object) => {
      if (!(object instanceof Mesh)) return;
      geometries.add(object.geometry);
      const objectMaterials = Array.isArray(object.material) ? object.material : [object.material];
      for (const material of objectMaterials) {
        materials.add(material as MeshBasicMaterial | MeshPhysicalMaterial);
        const map = (material as MeshBasicMaterial).map;
        if (map) textures.add(map);
      }
    });
    for (const visual of this.visuals.values()) {
      if (visual.labelTexture) textures.add(visual.labelTexture);
    }
    if (this.promptTexture) textures.add(this.promptTexture);
    textures.add(this.reflectionTexture);
    this.labelGeometry.dispose();
    for (const geometry of geometries) geometry.dispose();
    for (const material of materials) material.dispose();
    for (const texture of textures) texture.dispose();
    this.visuals.clear();
    this.regions = [];
  }

  private captureHeadPose(): void {
    const inverse = this.lastCameraQuaternion.clone().invert();
    this.headPosition.copy(this.group.position).sub(this.lastCameraPosition).applyQuaternion(inverse);
    this.headQuaternion.copy(inverse).multiply(this.group.quaternion).normalize();
  }

  private captureIndividualPose(): void {
    this.individualQuaternion.copy(this.lastCameraQuaternion).invert().multiply(this.group.quaternion).normalize();
  }

  private rebuild(): void {
    if (this.destroyed) return;
    for (const visual of this.visuals.values()) {
      visual.labelTexture?.dispose();
      visual.label?.material.dispose();
      visual.body.material.dispose();
      visual.rim.material.dispose();
      visual.reflection.material.dispose();
      visual.group.removeFromParent();
    }
    this.visuals.clear();
    this.regions = [];
    this.rows = getKeyboardRows(this.layoutId, this.page);
    this.metrics = layoutMetrics(this.rows);
    this.surface.geometry.dispose();
    this.surface.geometry = createCurvedSurfaceGeometry(this.metrics.width, this.metrics.height);
    this.layoutRegions();
    for (const region of this.regions) this.createKeyVisual(region);
    this.positionPrompt();
    this.promptDirty = true;
    this.update(0);
  }

  private layoutRegions(): void {
    const { unit, width, height } = this.metrics;
    const keyHeight = (KEY_HEIGHT - KEY_GAP * 0.55) * unit;
    this.rows.forEach((row, rowIndex) => {
      const totalWidth = rowWidth(row);
      let left = (width - totalWidth * unit) * 0.5;
      const top = height * 0.5 - rowIndex * (KEY_HEIGHT + ROW_GAP) * unit;
      for (const key of row.keys) {
        const keyWidth = (key.width ?? 1) * unit - KEY_GAP * unit * 0.55;
        this.regions.push({
          key,
          u0: (left + KEY_GAP * unit * 0.275) / width,
          u1: (left + KEY_GAP * unit * 0.275 + keyWidth) / width,
          v0: (top - keyHeight + height * 0.5) / height,
          v1: (top + height * 0.5) / height,
        });
        left += ((key.width ?? 1) + KEY_GAP) * unit;
      }
    });
  }

  private createKeyVisual(region: KeyRegion): void {
    const key = region.key;
    const resolved = resolveKeyboardKey(key, this.modifiers);
    const width = region.u1 - region.u0;
    const height = region.v1 - region.v0;
    const x = ((region.u0 + region.u1) * 0.5 - 0.5) * this.metrics.width;
    const y = ((region.v0 + region.v1) * 0.5 - 0.5) * this.metrics.height;
    const frame = curvedSurfaceFrame(x, y, this.metrics.width, this.metrics.height);
    const group = new Group();
    group.name = `Key ${key.id}`;
    group.position.copy(frame.position).addScaledVector(frame.normal, FLOATING_HEIGHT);
    group.quaternion.setFromUnitVectors(new Vector3(0, 0, 1), frame.normal);

    const activeAccent = key.accent !== undefined && key.accent === this.pendingAccent;
    const bodyMaterial = new MeshPhysicalMaterial({
      color: new Color(activeAccent ? '#e7edf5' : '#eef2f7'),
      emissive: new Color(this.interfaceAccent),
      emissiveIntensity: 0.025,
      metalness: 0.02,
      roughness: 0.14,
      transmission: 0.58,
      thickness: 0.09,
      ior: 1.45,
      clearcoat: 1,
      clearcoatRoughness: 0.07,
      attenuationColor: new Color('#eef2f7'),
      attenuationDistance: 1.8,
      transparent: true,
      opacity: 0.36,
      depthWrite: false,
    });
    const body = new Mesh(this.keyGeometry, bodyMaterial);
    body.scale.set(width * this.metrics.width, height * this.metrics.height, 0.052);
    body.renderOrder = 210;

    const rimMaterial = new MeshBasicMaterial({
      color: new Color(activeAccent ? '#ffffff' : '#dce4ec'),
      transparent: true,
      opacity: activeAccent ? 0.68 : 0.3,
      depthWrite: false,
      toneMapped: false,
    });
    const rim = new Mesh(this.keyGeometry, rimMaterial);
    rim.scale.set(width * this.metrics.width + 0.012, height * this.metrics.height + 0.012, 0.02);
    rim.position.z = -0.018;
    rim.renderOrder = 200;

    const reflectionMaterial = new MeshBasicMaterial({
      map: this.reflectionTexture,
      transparent: true,
      opacity: 0.24,
      depthWrite: false,
      toneMapped: false,
      side: DoubleSide,
    });
    const reflection = new Mesh(this.reflectionGeometry, reflectionMaterial);
    reflection.scale.set(width * this.metrics.width * 0.78, height * this.metrics.height * 0.34, 1);
    reflection.position.set(0, height * this.metrics.height * 0.2, 0.03);
    reflection.renderOrder = 220;

    const labelTexture = createLabelTexture(key, resolved);
    let label: Mesh<PlaneGeometry, MeshBasicMaterial> | null = null;
    if (labelTexture) {
      label = new Mesh(this.labelGeometry, new MeshBasicMaterial({
        map: labelTexture,
        transparent: true,
        depthWrite: false,
        toneMapped: false,
        side: DoubleSide,
      }));
      label.scale.set(width * this.metrics.width * 0.84, height * this.metrics.height * 0.72, 1);
      label.position.z = 0.034;
      label.renderOrder = 230;
      group.add(label);
    }

    group.add(rim, body, reflection);
    this.group.add(group);
    this.visuals.set(key.id, {
      definition: key,
      group,
      body,
      rim,
      reflection,
      label,
      labelTexture,
      normal: frame.normal,
      basePosition: group.position.clone(),
      baseQuaternion: group.quaternion.clone(),
      press: 0,
      hover: key.id === this.hovered ? 1 : 0,
      holdUntil: 0,
    });
  }

  private updateVisual(visual: KeyVisual, delta: number): void {
    const target = this.elapsed < visual.holdUntil ? 1 : 0;
    const smoothing = 1 - Math.exp(-delta * (target > visual.press ? 30 : 17));
    visual.press += (target - visual.press) * smoothing;
    if (Math.abs(visual.press - target) < 0.001) visual.press = target;
    const hoverTarget = visual.definition.id === this.hovered ? 1 : 0;
    visual.hover += (hoverTarget - visual.hover) * (1 - Math.exp(-delta * 18));
    if (Math.abs(visual.hover - hoverTarget) < 0.001) visual.hover = hoverTarget;

    visual.group.position.copy(visual.basePosition)
      .addScaledVector(visual.normal, -0.018 * visual.press + 0.004 * visual.hover);
    visual.group.quaternion.copy(visual.baseQuaternion);
    visual.group.scale.setScalar(1 - visual.press * 0.025);
    const transparency = Math.max(0, Math.min(1, this.options.getTransparency()));
    visual.body.material.opacity = 0.88 - transparency * 0.62 + visual.hover * 0.06;
    visual.body.material.transmission = 0.12 + transparency * 0.56;
    visual.body.material.emissiveIntensity = 0.025 + visual.press * 0.28 + visual.hover * 0.07;
    visual.rim.material.opacity = 0.24 + transparency * 0.08 + visual.press * 0.34 + visual.hover * 0.24;
    visual.reflection.material.opacity = 0.18 + visual.press * 0.2;
  }

  private targetForKey(key: KeyboardKeyDefinition): SpatialKeyboardTarget {
    return {
      key: key.id,
      action: () => {
        this.pressFeedback(key.id);
        this.options.onPress(key);
      },
    };
  }

  private promptActions(): KeyboardKeyDefinition[] {
    const modeLabel = `${this.positioningMode[0].toUpperCase()}${this.positioningMode.slice(1)}`;
    if (!this.prompt) return [
      { id: 'mode', label: modeLabel, action: 'mode' },
      { id: 'close', label: 'Close', action: 'close' },
    ];
    return [
      { id: 'mode', label: modeLabel, action: 'mode' },
      { id: 'cancel', label: this.prompt.cancelLabel ?? 'Cancel', action: 'cancel' },
      { id: 'submit', label: this.prompt.submitLabel, action: 'submit' },
      { id: 'close', label: '×', action: 'close' },
    ];
  }

  private promptActionRegions(): PromptActionRegion[] {
    const start = 0.68;
    const width = (1 - start) / this.promptActions().length;
    return this.promptActions().map((key, index) => ({
      key,
      u0: start + index * width,
      u1: start + (index + 1) * width,
    }));
  }

  private raycastUV(u: number, v: number): Vector2 | null {
    if (!Number.isFinite(u) || !Number.isFinite(v) || u < 0 || u > 1 || v < 0 || v > 1) return null;
    this.group.updateMatrixWorld(true);
    const origin = this.group.localToWorld(surfacePointAtUV(u, v, this.metrics.width, this.metrics.height));
    const frame = curvedSurfaceFrame(
      (u - 0.5) * this.metrics.width,
      (v - 0.5) * this.metrics.height,
      this.metrics.width,
      this.metrics.height,
    );
    const normal = frame.normal.transformDirection(this.group.matrixWorld);
    origin.addScaledVector(normal, 0.5);
    this.raycaster.set(origin, normal.negate());
    return this.raycaster.intersectObject(this.surface, false)[0]?.uv ?? null;
  }

  private regionAtUV(u: number, v: number): KeyRegion | null {
    if (!Number.isFinite(u) || !Number.isFinite(v) || u < 0 || u > 1 || v < 0 || v > 1) return null;
    return this.regions.find((region) =>
      u >= region.u0 && u <= region.u1 && v >= region.v0 && v <= region.v1) ?? null;
  }

  private setHovered(key: string | null): void {
    if (key === this.hovered) return;
    this.hovered = key;
    if (key && this.promptActions().some((action) => action.id === key)) this.promptDirty = true;
    this.update(0);
  }

  private createPrompt(): void {
    const ownerDocument = typeof document === 'undefined' ? null : document;
    if (!ownerDocument || typeof ownerDocument.createElement !== 'function') return;
    const canvas = ownerDocument.createElement('canvas');
    canvas.width = 1152;
    canvas.height = 96;
    const context = canvas.getContext('2d');
    if (!context) return;
    const texture = new CanvasTexture(canvas);
    texture.colorSpace = SRGBColorSpace;
    texture.minFilter = LinearFilter;
    texture.magFilter = LinearFilter;
    texture.generateMipmaps = false;
    const mesh = new Mesh(createCurvedSurfaceGeometry(KEYBOARD_PROMPT_WIDTH, KEYBOARD_PROMPT_HEIGHT, 0.035), new MeshBasicMaterial({
      map: texture,
      transparent: true,
      opacity: 0.58,
      side: DoubleSide,
      depthWrite: false,
      toneMapped: false,
    }));
    mesh.name = 'Curved keyboard prompt';
    mesh.renderOrder = 120;
    this.promptCanvas = canvas;
    this.promptContext = context;
    this.promptTexture = texture;
    this.promptMesh = mesh;
    this.group.add(mesh);
    this.positionPrompt();
  }

  private positionPrompt(): void {
    if (!this.promptMesh) return;
    this.promptMesh.position.set(0, this.metrics.height * 0.5 + KEYBOARD_PROMPT_HEIGHT * 0.5 + 0.055, 0);
  }
}
