import { CanvasTexture, DoubleSide, Group, LinearFilter, Mesh, MeshBasicMaterial, PlaneGeometry, Quaternion, SRGBColorSpace, Vector3 } from 'three';
import type { ApplicationDefinition, TaskbarMode, WindowPoseState } from '../types';
import { ellipsis, fillRoundedRect, roundedRect } from './canvasUi';

export type TaskbarCommand =
  | 'exit'
  | 'keyboard'
  | 'hands'
  | 'guide'
  | 'settings'
  | 'pin'
  | 'arrange'
  | 'recalibrate'
  | 'anchor'
  | 'follow'
  | 'reposition'
  | 'mode-cycle'
  | 'hide'
  | 'show';

export type TaskbarAction =
  | { type: 'section'; section: 'main' | 'apps' | 'controls' }
  | { type: 'app'; appId: string }
  | { type: 'command'; command: TaskbarCommand };

export interface TaskbarItem {
  id: string;
  label: string;
  icon: string;
  color: string;
  action: TaskbarAction;
  disabled?: boolean;
  navigation?: 'previous' | 'next';
}

interface HitRegion {
  x: number;
  y: number;
  width: number;
  height: number;
  item: TaskbarItem;
}

export interface TaskbarTarget {
  key: string;
  item: TaskbarItem;
}

export interface SpatialTaskbarOptions {
  applications: ApplicationDefinition[];
  getTransparency: () => number;
  getAccent?: () => string;
  mode?: TaskbarMode;
  anchor?: WindowPoseState | null;
}

export interface TaskbarStatus {
  mode: TaskbarMode;
  state: 'following' | 'anchored' | 'uninitialized';
  vrActive: boolean;
  visible: boolean;
  initialized: boolean;
  hasAnchor: boolean;
  anchored: boolean;
  recovery: 'none' | 'follow' | 'capture';
  recoverable: boolean;
}

export const TASKBAR_CANVAS_WIDTH = 2048;
export const TASKBAR_CANVAS_HEIGHT = 256;
export const TASKBAR_WIDTH = 4.4;
export const TASKBAR_HEIGHT = TASKBAR_WIDTH * TASKBAR_CANVAS_HEIGHT / TASKBAR_CANVAS_WIDTH;
export const TASKBAR_ITEM_SLOTS = 8;

const FOLLOW_OFFSET = new Vector3(0, -1.35, -6);
const CURVE_DEPTH = 0.14;
const CURVE_SEGMENTS_X = 64;
const CURVE_SEGMENTS_Y = 12;
const FOLLOW_POSITION_RESPONSE = 12;
const FOLLOW_ROTATION_RESPONSE = 14;
const NAVIGATION_WIDTH = 300;
const NAVIGATION_ITEM_WIDTH = 104;
const ITEM_GAP = 16;
const ITEM_Y = 72;
const ITEM_HEIGHT = 164;
const RESERVED_APPLICATION_IDS = new Set(['main', 'previous', 'next']);

function finite(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

function validVector(value: Vector3 | null | undefined): value is Vector3 {
  return Boolean(value && Number.isFinite(value.x) && Number.isFinite(value.y) && Number.isFinite(value.z));
}

function validQuaternion(value: Quaternion | null | undefined): value is Quaternion {
  if (!value) return false;
  const length = Math.hypot(value.x, value.y, value.z, value.w);
  return Number.isFinite(length) && length > 0.0001;
}

function clonePose(pose: WindowPoseState): WindowPoseState {
  return {
    position: { ...pose.position },
    quaternion: { ...pose.quaternion },
    size: { ...pose.size },
  };
}

function normalizePose(pose: WindowPoseState | null | undefined): WindowPoseState | null {
  if (!pose?.position || !Number.isFinite(pose.position.x) || !Number.isFinite(pose.position.y) || !Number.isFinite(pose.position.z)) return null;
  const quaternion = pose.quaternion;
  if (!quaternion) return null;
  const length = Math.hypot(quaternion.x ?? 0, quaternion.y ?? 0, quaternion.z ?? 0, quaternion.w ?? 1);
  if (!Number.isFinite(length) || length < 0.0001) return null;
  return {
    position: { ...pose.position },
    quaternion: {
      x: (quaternion.x ?? 0) / length,
      y: (quaternion.y ?? 0) / length,
      z: (quaternion.z ?? 0) / length,
      w: (quaternion.w ?? 1) / length,
    },
    size: {
      width: Number.isFinite(pose.size?.width) && pose.size.width > 0 ? pose.size.width : TASKBAR_WIDTH,
      height: Number.isFinite(pose.size?.height) && pose.size.height > 0 ? pose.size.height : TASKBAR_HEIGHT,
    },
  };
}

function curvedGeometry(): PlaneGeometry {
  const geometry = new PlaneGeometry(TASKBAR_WIDTH, TASKBAR_HEIGHT, CURVE_SEGMENTS_X, CURVE_SEGMENTS_Y);
  const positions = geometry.attributes.position;
  for (let index = 0; index < positions.count; index += 1) {
    const normalizedX = positions.getX(index) / (TASKBAR_WIDTH / 2);
    const normalizedY = positions.getY(index) / (TASKBAR_HEIGHT / 2);
    positions.setZ(index, CURVE_DEPTH * normalizedX * normalizedX + CURVE_DEPTH * 0.12 * normalizedY * normalizedY);
  }
  positions.needsUpdate = true;
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

export class SpatialTaskbar {
  readonly group = new Group();
  readonly surface: Mesh<PlaneGeometry, MeshBasicMaterial>;
  private readonly canvas = document.createElement('canvas');
  private readonly context: CanvasRenderingContext2D;
  private readonly texture: CanvasTexture;
  private readonly getTransparency: () => number;
  private readonly getAccent?: () => string;
  private applications: ApplicationDefinition[];
  private section: 'main' | 'apps' | 'controls' = 'main';
  private page = 0;
  private pageCount = 1;
  private regions: HitRegion[] = [];
  private hoveredId: string | null = null;
  private dirty = true;
  private mode: TaskbarMode = 'follow';
  private worldAnchor: WindowPoseState | null = null;
  private followInitialized = true;
  private followDistanceScale = 1;
  private vrActive = false;
  private hasCameraPosition = false;
  private hasCameraQuaternion = false;
  private readonly lastCameraPosition = new Vector3();
  private readonly lastCameraQuaternion = new Quaternion();
  private readonly desiredPosition = new Vector3();
  private readonly desiredOffset = new Vector3();

  constructor(options: SpatialTaskbarOptions) {
    this.canvas.width = TASKBAR_CANVAS_WIDTH;
    this.canvas.height = TASKBAR_CANVAS_HEIGHT;
    const context = this.canvas.getContext('2d');
    if (!context) throw new Error('Canvas 2D is unavailable for the spatial taskbar.');
    this.context = context;
    this.applications = this.copyApplications(options.applications);
    this.getTransparency = options.getTransparency;
    this.getAccent = options.getAccent;
    this.mode = options.mode === 'world' ? 'world' : 'follow';
    this.worldAnchor = normalizePose(options.anchor);
    this.texture = new CanvasTexture(this.canvas);
    this.texture.colorSpace = SRGBColorSpace;
    this.texture.minFilter = LinearFilter;
    this.texture.magFilter = LinearFilter;
    this.texture.generateMipmaps = false;
    this.surface = new Mesh(
      curvedGeometry(),
      new MeshBasicMaterial({ map: this.texture, transparent: true, side: DoubleSide, depthWrite: false, toneMapped: false }),
    );
    this.surface.userData.taskbar = true;
    this.surface.renderOrder = 1_000_000;
    this.group.add(this.surface);
    this.group.visible = false;
    this.group.position.copy(FOLLOW_OFFSET);
    if (this.mode === 'world') {
      this.worldAnchor ??= this.currentPose();
      this.applyWorldAnchor(this.worldAnchor);
    }
    this.render();
  }

  update(
    cameraPosition?: Vector3 | null,
    cameraQuaternion?: Quaternion | null,
    delta = 1 / 60,
    vrActive = this.vrActive,
  ): void {
    const vrActiveChanged = this.vrActive !== Boolean(vrActive);
    this.vrActive = Boolean(vrActive);
    const positionSupplied = validVector(cameraPosition);
    const quaternionSupplied = validQuaternion(cameraQuaternion);
    if (positionSupplied) {
      this.lastCameraPosition.copy(cameraPosition);
      this.hasCameraPosition = true;
    }
    if (quaternionSupplied) {
      this.lastCameraQuaternion.copy(cameraQuaternion).normalize();
      this.hasCameraQuaternion = true;
    }
    if (this.mode === 'follow') {
      if (!this.followInitialized && (positionSupplied || quaternionSupplied)) this.initializeFollowPlacement();
      if (this.followInitialized) {
        const seconds = Math.min(0.25, Math.max(0, finite(delta, 0)));
        const positionAlpha = 1 - Math.exp(-FOLLOW_POSITION_RESPONSE * seconds);
        const rotationAlpha = 1 - Math.exp(-FOLLOW_ROTATION_RESPONSE * seconds);
        const orientation = this.hasCameraQuaternion ? this.lastCameraQuaternion : this.group.quaternion;
        if (positionSupplied) {
          this.desiredOffset.copy(FOLLOW_OFFSET);
          this.desiredOffset.z *= this.followDistanceScale;
          this.desiredOffset.applyQuaternion(orientation);
          this.desiredPosition.copy(this.lastCameraPosition).add(this.desiredOffset);
          this.group.position.lerp(this.desiredPosition, positionAlpha);
          if (this.group.position.distanceToSquared(this.desiredPosition) < 0.0000000001) this.group.position.copy(this.desiredPosition);
        }
        if (quaternionSupplied) {
          this.group.quaternion.slerp(this.lastCameraQuaternion, rotationAlpha);
          if (this.group.quaternion.angleTo(this.lastCameraQuaternion) < 0.00001) this.group.quaternion.copy(this.lastCameraQuaternion);
        }
        this.group.updateMatrixWorld();
      }
    }
    if (vrActiveChanged) this.dirty = true;
  }

  setMode(mode: 'follow' | 'world'): void {
    if (mode === 'world') {
      this.mode = 'world';
      if (this.worldAnchor) this.applyWorldAnchor(this.worldAnchor);
      else this.captureWorldAnchor();
      return;
    }
    if (this.mode === 'world') this.group.scale.set(1, 1, 1);
    this.worldAnchor = null;
    this.mode = 'follow';
    if (!this.followInitialized) this.initializeFollowPlacement();
    this.group.updateMatrixWorld();
    this.dirty = true;
  }

  getMode(): TaskbarMode {
    return this.mode;
  }

  captureWorldAnchor(pose?: WindowPoseState): void {
    this.worldAnchor = normalizePose(pose) ?? this.currentPose();
    this.mode = 'world';
    this.applyWorldAnchor(this.worldAnchor);
    this.dirty = true;
  }

  releaseWorldAnchor(): void {
    this.worldAnchor = null;
    this.mode = 'follow';
    this.followInitialized = false;
    this.group.scale.set(1, 1, 1);
    this.group.updateMatrixWorld();
    this.dirty = true;
  }

  getAnchor(): WindowPoseState | null {
    return this.worldAnchor ? clonePose(this.worldAnchor) : null;
  }

  getStatus(): TaskbarStatus {
    const initialized = this.mode === 'world' ? this.worldAnchor !== null : this.followInitialized;
    const recovery = this.mode === 'world'
      ? this.worldAnchor ? 'none' : 'capture'
      : this.followInitialized ? 'none' : 'follow';
    return {
      mode: this.mode,
      state: this.mode === 'world' ? (this.worldAnchor ? 'anchored' : 'uninitialized') : (this.followInitialized ? 'following' : 'uninitialized'),
      vrActive: this.vrActive,
      visible: this.group.visible,
      initialized,
      hasAnchor: this.worldAnchor !== null,
      anchored: this.mode === 'world' && this.worldAnchor !== null,
      recovery,
      recoverable: recovery !== 'none',
    };
  }

  setApplications(applications: ApplicationDefinition[]): void {
    this.applications = this.copyApplications(applications);
    this.hoveredId = null;
    this.dirty = true;
    this.render();
  }

  recenter(cameraQuaternion: Quaternion, distanceScale: number, cameraPosition?: Vector3 | null): void {
    const suppliedPosition = validVector(cameraPosition) ? cameraPosition : this.hasCameraPosition ? this.lastCameraPosition : new Vector3();
    if (validQuaternion(cameraQuaternion)) {
      this.lastCameraQuaternion.copy(cameraQuaternion).normalize();
      this.hasCameraQuaternion = true;
    }
    if (validVector(suppliedPosition)) {
      this.lastCameraPosition.copy(suppliedPosition);
      this.hasCameraPosition = true;
    }
    this.followDistanceScale = Math.min(3, Math.max(0.25, finite(distanceScale, 1)));
    const orientation = this.hasCameraQuaternion ? this.lastCameraQuaternion : this.group.quaternion;
    const offset = FOLLOW_OFFSET.clone();
    offset.z *= this.followDistanceScale;
    offset.applyQuaternion(orientation).add(this.lastCameraPosition);
    if (this.mode === 'world') {
      this.captureWorldAnchor({
        position: { x: offset.x, y: offset.y, z: offset.z },
        quaternion: { x: orientation.x, y: orientation.y, z: orientation.z, w: orientation.w },
        size: this.currentPose().size,
      });
      return;
    }
    this.followInitialized = true;
    this.initializeFollowPlacement();
    this.dirty = true;
  }

  setVisible(visible: boolean): void {
    this.group.visible = visible;
    this.dirty = true;
  }

  setGlassTransparency(): void {
    this.dirty = true;
  }

  setInterfacePalette(): void {
    this.dirty = true;
  }

  target(u: number, v: number): TaskbarTarget | null {
    const region = this.regionAt(u, v);
    if (!region) return null;
    return { key: this.targetKey(region.item), item: region.item };
  }

  activate(target: TaskbarTarget): TaskbarAction | null {
    const region = this.regions.find((candidate) => this.targetKey(candidate.item) === target.key);
    if (!region) return null;
    const item = region.item;
    if (item.navigation === 'previous') this.page = Math.max(0, this.page - 1);
    else if (item.navigation === 'next') this.page = Math.min(this.pageCount - 1, this.page + 1);
    else if (item.action.type === 'section') {
      this.section = item.action.section;
      this.page = 0;
    } else if (item.action.type === 'command') {
      switch (item.action.command) {
        case 'anchor': this.captureWorldAnchor(); break;
        case 'follow': this.setMode('follow'); break;
        case 'reposition':
          if (this.mode === 'world') this.captureWorldAnchor();
          else this.recenter(this.hasCameraQuaternion ? this.lastCameraQuaternion : this.group.quaternion, this.followDistanceScale, this.lastCameraPosition);
          break;
        case 'hide': this.setVisible(false); break;
        case 'show': this.setVisible(true); break;
        default: break;
      }
    }
    this.hoveredId = item.id;
    this.dirty = true;
    this.render();
    return item.navigation ? null : item.action;
  }

  pointer(u: number, v: number): TaskbarAction | null {
    const target = this.target(u, v);
    return target ? this.activate(target) : null;
  }

  hover(u: number, v: number): void {
    const id = this.regionAt(u, v)?.item.id ?? null;
    if (id !== this.hoveredId) {
      this.hoveredId = id;
      this.dirty = true;
    }
  }

  render(force = false): void {
    if (!this.dirty && !force) return;
    const context = this.context;
    const transparency = Math.min(1, Math.max(0, finite(this.getTransparency(), 0.78)));
    const accent = this.getAccent?.() ?? '#75e7ff';
    const alpha = 0.035 + (1 - transparency) * 0.5;
    const accentAlpha = Math.round(alpha * 0.42 * 255).toString(16).padStart(2, '0');
    context.clearRect(0, 0, TASKBAR_CANVAS_WIDTH, TASKBAR_CANVAS_HEIGHT);
    context.save();
    const glass = context.createLinearGradient(0, 0, TASKBAR_CANVAS_WIDTH, TASKBAR_CANVAS_HEIGHT);
    glass.addColorStop(0, `rgba(242,248,255,${alpha * 0.72})`);
    glass.addColorStop(0.16, `rgba(24,30,38,${alpha * 0.7})`);
    glass.addColorStop(0.52, `${accent}${accentAlpha}`);
    glass.addColorStop(0.86, `rgba(50,62,78,${alpha * 0.58})`);
    glass.addColorStop(1, `rgba(235,246,255,${alpha * 0.78})`);
    fillRoundedRect(context, 2, 2, TASKBAR_CANVAS_WIDTH - 4, TASKBAR_CANVAS_HEIGHT - 4, 70, glass);

    context.save();
    roundedRect(context, 5, 5, TASKBAR_CANVAS_WIDTH - 10, TASKBAR_CANVAS_HEIGHT - 10, 66);
    context.clip();
    const reflection = context.createRadialGradient(TASKBAR_CANVAS_WIDTH * 0.38, -90, 10, TASKBAR_CANVAS_WIDTH * 0.38, -90, TASKBAR_CANVAS_WIDTH * 0.58);
    reflection.addColorStop(0, `${accent}38`);
    reflection.addColorStop(0.42, `rgba(205,232,255,${alpha * 0.28})`);
    reflection.addColorStop(1, 'rgba(255,255,255,0)');
    context.fillStyle = reflection;
    context.fillRect(0, 0, TASKBAR_CANVAS_WIDTH, TASKBAR_CANVAS_HEIGHT);
    const edgeReflection = context.createLinearGradient(0, 0, TASKBAR_CANVAS_WIDTH, 0);
    edgeReflection.addColorStop(0, 'rgba(255,255,255,0.22)');
    edgeReflection.addColorStop(0.08, 'rgba(255,255,255,0.015)');
    edgeReflection.addColorStop(0.92, 'rgba(255,255,255,0.015)');
    edgeReflection.addColorStop(1, 'rgba(255,255,255,0.2)');
    context.fillStyle = edgeReflection;
    context.fillRect(0, 0, TASKBAR_CANVAS_WIDTH, TASKBAR_CANVAS_HEIGHT);
    context.restore();

    roundedRect(context, 3, 3, TASKBAR_CANVAS_WIDTH - 6, TASKBAR_CANVAS_HEIGHT - 6, 68);
    context.strokeStyle = `${accent}6b`;
    context.lineWidth = 3;
    context.stroke();
    roundedRect(context, 9, 9, TASKBAR_CANVAS_WIDTH - 18, TASKBAR_CANVAS_HEIGHT - 18, 60);
    context.strokeStyle = 'rgba(180,220,255,0.1)';
    context.lineWidth = 2;
    context.stroke();

    context.fillStyle = accent;
    context.font = '700 18px -apple-system, BlinkMacSystemFont, sans-serif';
    context.textAlign = 'left';
    context.textBaseline = 'middle';
    context.fillText('VISI0N OS', 32, 36);
    context.textAlign = 'right';
    context.fillStyle = 'rgba(255,255,255,0.56)';
    context.font = '600 16px -apple-system, BlinkMacSystemFont, sans-serif';
    const sectionTitle = this.section === 'apps' ? 'APPLICATIONS' : this.section === 'controls' ? 'SPATIAL CONTROLS' : 'PINCH TO SELECT • GAZE + DWELL';
    const modeTitle = this.mode === 'world' ? 'WORLD ANCHOR' : 'FOLLOW';
    context.fillText(`${sectionTitle} • ${modeTitle}`, TASKBAR_CANVAS_WIDTH - 32, 36);
    context.textAlign = 'left';

    const items = this.currentItems();
    const applicationsPage = this.section === 'apps';
    const pageItems = applicationsPage ? items.slice(1) : items;
    const pageSize = TASKBAR_ITEM_SLOTS - (applicationsPage ? 1 : 0);
    this.pageCount = Math.max(1, Math.ceil(pageItems.length / pageSize));
    this.page = Math.min(this.page, this.pageCount - 1);
    const pageSlice = pageItems.slice(this.page * pageSize, (this.page + 1) * pageSize);
    const visible = applicationsPage ? [items[0], ...pageSlice] : pageSlice;
    this.regions = [];
    const available = TASKBAR_CANVAS_WIDTH - 64 - NAVIGATION_WIDTH;
    const itemWidth = (available - ITEM_GAP * (TASKBAR_ITEM_SLOTS - 1)) / TASKBAR_ITEM_SLOTS;
    visible.forEach((item, index) => this.drawItem(item, 32 + index * (itemWidth + ITEM_GAP), ITEM_Y, itemWidth, ITEM_HEIGHT));
    this.drawItem({
      id: 'previous',
      label: 'Back',
      icon: '‹',
      color: '#dce7f7',
      action: { type: 'section', section: this.section },
      navigation: 'previous',
    }, TASKBAR_CANVAS_WIDTH - NAVIGATION_WIDTH + 8, ITEM_Y, NAVIGATION_ITEM_WIDTH, ITEM_HEIGHT, this.page === 0);
    this.drawItem({
      id: 'next',
      label: 'Next',
      icon: '›',
      color: '#dce7f7',
      action: { type: 'section', section: this.section },
      navigation: 'next',
    }, TASKBAR_CANVAS_WIDTH - 112, ITEM_Y, NAVIGATION_ITEM_WIDTH, ITEM_HEIGHT, this.page >= this.pageCount - 1);
    context.fillStyle = 'rgba(255,255,255,0.56)';
    context.font = '600 16px -apple-system, BlinkMacSystemFont, sans-serif';
    context.textAlign = 'center';
    context.fillText(`${this.page + 1} / ${this.pageCount}`, TASKBAR_CANVAS_WIDTH - 184, ITEM_Y + ITEM_HEIGHT / 2);
    context.restore();
    this.texture.needsUpdate = true;
    this.dirty = false;
  }

  private copyApplications(applications: ApplicationDefinition[]): ApplicationDefinition[] {
    const seen = new Set<string>();
    return applications.filter((application) => {
      if (!application || typeof application.id !== 'string' || !application.id || seen.has(application.id)) return false;
      seen.add(application.id);
      return true;
    }).map((application) => ({ ...application }));
  }

  private currentItems(): TaskbarItem[] {
    if (this.section === 'controls') {
      return [
        { id: 'home', label: 'Home', icon: '⌂', color: '#c5d2e4', action: { type: 'section', section: 'main' } },
        { id: 'keyboard', label: 'Keyboard', icon: '⌨', color: '#dce7f7', action: { type: 'command', command: 'keyboard' } },
        { id: 'settings', label: 'Settings', icon: '⚙', color: '#c7d5e8', action: { type: 'command', command: 'settings' } },
        { id: 'anchor', label: 'Bar World', icon: '◆', color: '#c9f7e7', action: { type: 'command', command: 'anchor' } },
        { id: 'follow', label: 'Bar Follow', icon: '◎', color: '#75e7ff', action: { type: 'command', command: 'follow' } },
        { id: 'reposition', label: 'Reposition', icon: '↻', color: '#e3d8ff', action: { type: 'command', command: 'reposition' } },
        { id: 'hide', label: 'Hide', icon: '−', color: '#dce7f7', action: { type: 'command', command: 'hide' } },
        { id: 'show', label: 'Show', icon: '□', color: '#b7f8de', action: { type: 'command', command: 'show' } },
        { id: 'mode-cycle', label: 'Window mode', icon: '⟳', color: '#b7f8de', action: { type: 'command', command: 'mode-cycle' } },
        this.applicationItem('windows', 'Windows', '▣', '#aebaff'),
        { id: 'exit', label: 'Exit VR', icon: '×', color: '#ffb3bc', action: { type: 'command', command: 'exit' } },
        this.applicationItem('environments', 'Space', '◎', '#78f0d0'),
        { id: 'hands', label: 'Hands', icon: '✋', color: '#7cf5c8', action: { type: 'command', command: 'hands' } },
        { id: 'guide', label: 'Guide', icon: '?', color: '#ffe0aa', action: { type: 'command', command: 'guide' } },
        { id: 'pin', label: 'Pin', icon: '◆', color: '#d5e5ff', action: { type: 'command', command: 'pin' } },
        { id: 'arrange', label: 'Arrange', icon: '◎', color: '#dce7f7', action: { type: 'command', command: 'arrange' } },
        { id: 'recalibrate', label: 'Recalibrate', icon: '↻', color: '#e3d8ff', action: { type: 'command', command: 'recalibrate' } },
      ];
    }
    if (this.section === 'apps') {
      return [
        { id: 'main', label: 'Taskbar', icon: '▦', color: '#c5d2e4', action: { type: 'section', section: 'main' } },
        ...this.applications.map((application): TaskbarItem => ({
          id: RESERVED_APPLICATION_IDS.has(application.id) ? `application:${application.id}` : application.id,
          label: application.name,
          icon: application.icon,
          color: application.color,
          action: { type: 'app', appId: application.id },
        })),
      ];
    }
    return [
      { id: 'home', label: 'Home', icon: '⌂', color: '#c5d2e4', action: { type: 'section', section: 'main' } },
      this.applicationItem('browser', 'Internet', '◉', '#75e7ff'),
      this.applicationItem('youtube', 'YouTube', '▶', '#ff8f9d'),
      this.applicationItem('spotify', 'Spotify', '♫', '#ffd28a', 'music'),
      this.applicationItem('photos', 'Photos', '✦', '#b694ff'),
      this.applicationItem('ai', 'AI', '✦', '#b694ff'),
      this.applicationItem('settings', 'Settings', '⚙', '#c7d5e8'),
      { id: 'apps', label: 'Applications', icon: '▦', color: '#c5d2e4', action: { type: 'section', section: 'apps' } },
      { id: 'controls', label: 'Controls', icon: '⚙', color: '#c7d5e8', action: { type: 'section', section: 'controls' } },
      { id: 'exit', label: 'Exit VR', icon: '×', color: '#ffb3bc', action: { type: 'command', command: 'exit' } },
    ];
  }

  private applicationItem(id: string, label: string, icon: string, color: string, alternateId?: string): TaskbarItem {
    const application = this.applications.find((candidate) => candidate.id === id)
      ?? (alternateId ? this.applications.find((candidate) => candidate.id === alternateId) : undefined);
    return {
      id,
      label: id === 'spotify' ? 'Spotify' : application?.name ?? label,
      icon: application?.icon ?? icon,
      color: application?.color ?? color,
      action: { type: 'app', appId: application?.id ?? id },
      disabled: !application,
    };
  }

  private drawItem(item: TaskbarItem, x: number, y: number, width: number, height: number, unavailable = false): void {
    const disabled = unavailable || item.disabled === true;
    const hovered = !disabled && this.hoveredId === item.id;
    const context = this.context;
    context.save();
    context.globalAlpha = disabled ? 0.32 : 1;
    if (hovered) {
      context.globalAlpha = 0.22;
      fillRoundedRect(context, x, y, width, height, 30, item.color);
      context.globalAlpha = 1;
    } else {
      fillRoundedRect(context, x, y, width, height, 30, 'rgba(255,255,255,0.055)');
    }
    roundedRect(context, x, y, width, height, 30);
    context.strokeStyle = hovered ? item.color : 'rgba(255,255,255,0.13)';
    context.lineWidth = hovered ? 3 : 2;
    context.stroke();
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.fillStyle = item.color;
    context.font = '600 68px -apple-system, BlinkMacSystemFont, sans-serif';
    context.fillText(item.icon, x + width / 2, y + 68);
    context.fillStyle = '#f2f6fc';
    context.font = '650 24px -apple-system, BlinkMacSystemFont, sans-serif';
    context.fillText(ellipsis(context, item.label, width - 24), x + width / 2, y + 132);
    context.restore();
    if (!disabled) this.regions.push({ x, y, width, height, item });
  }

  private regionAt(u: number, v: number): HitRegion | undefined {
    const x = u * TASKBAR_CANVAS_WIDTH;
    const y = (1 - v) * TASKBAR_CANVAS_HEIGHT;
    return this.regions.find((candidate) => x >= candidate.x && x <= candidate.x + candidate.width && y >= candidate.y && y <= candidate.y + candidate.height);
  }

  private targetKey(item: TaskbarItem): string {
    return `${this.section}:${this.page}:${item.id}`;
  }

  private initializeFollowPlacement(): void {
    this.group.scale.set(1, 1, 1);
    this.group.quaternion.copy(this.hasCameraQuaternion ? this.lastCameraQuaternion : this.group.quaternion).normalize();
    this.desiredOffset.copy(FOLLOW_OFFSET);
    this.desiredOffset.z *= this.followDistanceScale;
    this.desiredOffset.applyQuaternion(this.group.quaternion);
    this.group.position.copy(this.desiredOffset);
    if (this.hasCameraPosition) this.group.position.add(this.lastCameraPosition);
    this.group.updateMatrixWorld();
  }

  private currentPose(): WindowPoseState {
    const scaleX = Math.abs(this.group.scale.x) > 0.0001 ? this.group.scale.x : 1;
    const scaleY = Math.abs(this.group.scale.y) > 0.0001 ? this.group.scale.y : 1;
    return {
      position: { x: this.group.position.x, y: this.group.position.y, z: this.group.position.z },
      quaternion: { x: this.group.quaternion.x, y: this.group.quaternion.y, z: this.group.quaternion.z, w: this.group.quaternion.w },
      size: { width: TASKBAR_WIDTH * scaleX, height: TASKBAR_HEIGHT * scaleY },
    };
  }

  private applyWorldAnchor(pose: WindowPoseState): void {
    this.group.position.set(pose.position.x, pose.position.y, pose.position.z);
    this.group.quaternion.set(pose.quaternion.x, pose.quaternion.y, pose.quaternion.z, pose.quaternion.w).normalize();
    this.group.scale.set(pose.size.width / TASKBAR_WIDTH, pose.size.height / TASKBAR_HEIGHT, 1);
    this.group.updateMatrixWorld();
  }

  destroy(): void {
    this.surface.geometry.dispose();
    this.surface.material.dispose();
    this.texture.dispose();
    this.group.removeFromParent();
  }
}
