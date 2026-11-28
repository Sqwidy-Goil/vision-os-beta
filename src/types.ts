import type { RearCamera } from './core/camera';
import type { HandTracker } from './tracking/handTracking';
import type { CompanionClientStatus } from './spatial/companion/types';

export type WindowMode = 'world' | 'head' | 'individual';
export type SpatialMode = 'off' | 'economy' | 'camera' | 'full';
export type TaskbarMode = 'follow' | 'world';
export type KeyboardLayout = 'azerty' | 'qwerty';
export type EnvironmentId = 'venice' | 'loft' | 'camera' | `custom:${string}`;
export type QualityMode = 'auto' | 'high' | 'low';
export type InterfacePaletteId = 'glacier' | 'lagoon' | 'sunset' | 'orchid' | 'citrus' | 'graphite';

export interface HandVisualPoint {
  x: number;
  y: number;
  z?: number;
  visibility?: number;
}

export interface Vec3State {
  x: number;
  y: number;
  z: number;
}

export interface QuaternionState {
  x: number;
  y: number;
  z: number;
  w: number;
}

export interface WindowPoseState {
  position: Vec3State;
  quaternion: QuaternionState;
  size: { width: number; height: number };
}

export interface WindowState extends WindowPoseState {
  schemaVersion?: 2;
  id: string;
  appId: string;
  title: string;
  rotation: Vec3State;
  mode: WindowMode;
  positioningExplicit?: boolean;
  minimized: boolean;
  maximized: boolean;
  restore?: WindowPoseState;
  anchor?: string;
  anchorKind?: 'world' | 'surface' | 'object';
  anchorSnapshot?: { position: Vec3State; quaternion: QuaternionState };
  anchorOffset?: { position: Vec3State; quaternion: QuaternionState };
  anchorConfidence?: number;
  anchorObservedAt?: number;
  anchorAvailable?: boolean;
  pinned?: boolean;
  appState?: unknown;
  z: number;
}

export interface CustomEnvironment {
  id: EnvironmentId;
  name: string;
  fileId: string;
  width: number;
  height: number;
  createdAt: number;
}

export interface AppSettings {
  motionSensitivity: number;
  quality: QualityMode;
  ipd: number;
  vrDistance: number;
  fov: number;
  distortion: number;
  environment: EnvironmentId;
  headLockDefault: boolean;
  glassTransparency: number;
  glassBlur: number;
  palette: InterfacePaletteId;
  defaultWindowScale: number;
  environmentExposure: number;
  handSmoothing: number;
  dwellTime: number;
  spatialMode: SpatialMode;
  showEnvironmentMap: boolean;
  keyboardLayout: KeyboardLayout;
  taskbarMode: TaskbarMode;
  taskbarAnchor?: WindowPoseState;
  windowInertia: boolean;
  windowSnapping: boolean;
  companionEnabled: boolean;
  uiSoundEnabled: boolean;
  uiSoundVolume: number;
}

export interface StoredFile {
  id: string;
  name: string;
  type: string;
  size: number;
  createdAt: number;
  blob: Blob;
}

export interface ScanPoint {
  x: number;
  y: number;
  z: number;
  intensity: number;
}

export interface ScanRecord {
  id: string;
  name: string;
  createdAt: number;
  pointCount: number;
  points: ScanPoint[];
  method: 'feature-tracked-rgb-estimate';
}

export interface WindowHitRegion {
  action: 'drag' | 'close' | 'minimize' | 'maximize' | 'mode' | 'rotate' | 'roll' | 'depth' | 'anchor' | 'resize' | 'content';
  contentX?: number;
  contentY?: number;
}

export interface OverlayRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SpatialWindowApi {
  id: string;
  state: WindowState;
  canvas: HTMLCanvasElement;
  context: CanvasRenderingContext2D;
  requestRender: () => void;
  close: () => void;
  minimize: () => void;
  maximize: () => void;
  cycleMode: () => void;
  toggleAnchor: () => void;
  moveDepth: (delta: number) => void;
  setPose: (pose: WindowPoseState) => void;
  roll: (delta: number) => void;
  setTitle: (title: string) => void;
  setOverlay: (element: HTMLElement | null, rect?: OverlayRect) => void;
}

export interface TextRequestOptions {
  title: string;
  value: string;
  secret?: boolean;
  placeholder?: string;
  submitLabel: string;
  cancelLabel?: string;
  mode?: 'text' | 'information' | 'confirm';
  multiline?: boolean;
}

export interface ApplicationContext {
  window: SpatialWindowApi;
  rearCamera: RearCamera;
  handTracker: HandTracker;
  notify: (message: string) => void;
  pickFiles: (accept: string, multiple: boolean) => Promise<File[]>;
  requestUrl: (current: string) => Promise<string | null>;
  requestText: (options: TextRequestOptions) => Promise<string | null>;
  requestConfirm: (message: string) => Promise<boolean>;
  openSharedFile: (appId: 'photos' | 'video', file: StoredFile) => void;
  isVrActive: () => boolean;
  confirm: (message: string) => Promise<boolean>;
  getSettings: () => AppSettings;
  updateSettings: (settings: Partial<AppSettings>) => void;
  toggleHandControls: () => Promise<void>;
  recalibrate: () => void;
  setEnvironment: (environment: EnvironmentId) => void;
  focusWindow: (id: string) => void;
  closeWindow: (id: string) => void;
  listWindows: () => WindowState[];
  arrangeWindows: () => void;
  toggleWindowAnchor: (id: string) => boolean;
  moveWindowDepth: (id: string, delta: number) => boolean;
  toggleWindowPin: (id: string) => void;
  pinFocusedWindow: () => void;
  getCompanionStatus: () => CompanionClientStatus;
  connectCompanion: (endpoint: string) => Promise<void>;
  disconnectCompanion: () => void;
  requestDeviceAccess?: () => Promise<void>;
  getDeviceStatus?: () => string;
  showScan: (record: ScanRecord) => void;
}

export interface ApplicationInstance {
  render: (context: CanvasRenderingContext2D, width: number, height: number, time: number) => void;
  update?: (delta: number, time: number) => void;
  pointer?: (x: number, y: number, event: PointerEvent | MouseEvent) => boolean;
  scroll?: (deltaY: number) => boolean;
  openKeyboard?: () => void;
  openFile?: (record: StoredFile) => void | Promise<void>;
  activate?: () => void;
  deactivate?: () => void;
  suspend?: () => void;
  resume?: () => void;
  serialize?: () => unknown;
  restore?: (value: unknown) => void;
  destroy?: () => void;
}

export interface ApplicationDefinition {
  id: string;
  name: string;
  icon: string;
  color: string;
  description: string;
  spatialOnly?: boolean;
  stereoSafe?: boolean;
  create: (context: ApplicationContext) => ApplicationInstance;
}

export const DEFAULT_SETTINGS: AppSettings = {
  motionSensitivity: 1,
  quality: 'auto',
  ipd: 64,
  vrDistance: 6,
  fov: 70,
  distortion: 0.08,
  environment: 'loft',
  headLockDefault: false,
  glassTransparency: 0.78,
  glassBlur: 26,
  palette: 'glacier',
  defaultWindowScale: 1,
  environmentExposure: 1,
  handSmoothing: 0.3,
  dwellTime: 0.9,
  spatialMode: 'off',
  showEnvironmentMap: false,
  keyboardLayout: 'azerty',
  taskbarMode: 'follow',
  windowInertia: true,
  windowSnapping: true,
  companionEnabled: false,
  uiSoundEnabled: true,
  uiSoundVolume: 0.35,
};
