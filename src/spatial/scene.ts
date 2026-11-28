import {
  ACESFilmicToneMapping,
  AdditiveBlending,
  BackSide,
  BufferAttribute,
  BufferGeometry,
  Color,
  Euler,
  Group,
  LinearFilter,
  MathUtils,
  Mesh,
  MeshBasicMaterial,
  PerspectiveCamera,
  Plane,
  Points,
  PointsMaterial,
  Quaternion,
  Raycaster,
  RepeatWrapping,
  Scene,
  SphereGeometry,
  SRGBColorSpace,
  Texture,
  TextureLoader,
  Vector2,
  Vector3,
  VideoTexture,
  WebGLRenderer,
} from 'three';
import type { RearCamera } from '../core/camera';
import { getInterfacePalette } from '../core/theme';
import { uiSound } from '../core/uiSound';
import type { GamepadSummary } from '../core/deviceCapabilities';
import { GamepadMapper, type GamepadCommand, type GamepadControl, type GamepadDevice } from '../input/gamepad';
import type { HandTracker } from '../tracking/handTracking';
import type { MotionController } from '../core/motion';
import type { AppSettings, ApplicationDefinition, EnvironmentId, HandVisualPoint, ScanRecord, StoredFile, TextRequestOptions, WindowHitRegion, WindowMode, WindowState } from '../types';
import type { UniversalKeyboardManager } from '../input/keyboardManager';
import { EnvironmentRenderer } from './intelligence/environmentRenderer';
import { SpatialIntelligence } from './intelligence/spatialIntelligence';
import type { MotionSample, SpatialCapabilities, SpatialFrame } from './intelligence/types';
import { WindowManager } from './windowManager';
import type { ArmTracker } from '../tracking/armTracking';
import { HandInteractionController } from '../tracking/handInteraction';
import { mapCameraLandmarkToViewport } from '../tracking/handMapping';
import { SpatialInput } from './spatialInput';
import { SpatialHands } from './spatialHands';
import { SpatialNotification } from './spatialNotification';
import { StereoRenderer, undoLensDistortion } from './stereo';
import { SpatialTaskbar, type TaskbarAction } from './taskbar';
import { SpatialWindow, type WindowHooks } from './window';
import { restoreWindowState } from './windowState';
import { avoidObservedObstacles, type OccupiedWindowPose } from './placement';
import { CompanionClient } from './companion/client';
import type { CompanionClientStatus } from './companion/types';

type SceneHooks = SpatialSceneOptions;

type HandVisualFrame = {
  x: number;
  y: number;
  pinching: boolean;
  progress: number;
  cursor: boolean;
  landmarks: HandVisualPoint[];
  secondaryLandmarks?: HandVisualPoint[];
  arms: HandVisualPoint[];
};

type GazeTarget =
  | { kind: 'input'; key: string; action: () => void }
  | { kind: 'taskbar'; key: string; action: () => void }
  | { kind: 'window'; window: SpatialWindow; region: WindowHitRegion }
  | { kind: 'keyboard'; key: string; action: () => void };

interface DragState {
  pointerId: number;
  window: SpatialWindow;
  action: WindowHitRegion['action'];
  start: Vector2;
  plane: Plane;
  offset: Vector3;
  startPosition: Vector3;
  startSize: { width: number; height: number };
  startRotation: { x: number; y: number };
  lastUpdate: number;
  startPinchDistance?: number;
  handPinchDistance?: number;
}

const BUILTIN_ENVIRONMENT_COLORS = {
  venice: { background: new Color('#121a20'), grid: 0xdde7ed },
  loft: { background: new Color('#17191d'), grid: 0xe5e9ef },
  camera: { background: new Color('#080b0e'), grid: 0xcfdae2 },
};

function environmentColors(id: EnvironmentId): { background: Color; grid: number } {
  if (id === 'venice' || id === 'loft' || id === 'camera') return BUILTIN_ENVIRONMENT_COLORS[id];
  return { background: new Color('#111418'), grid: 0xdde5eb };
}

const PANORAMA_URLS = {
  venice: `${import.meta.env.BASE_URL}environments/venice-360.jpg`,
  loft: `${import.meta.env.BASE_URL}environments/loft-360.jpg`,
};

export interface SpatialSceneOptions {
  getDefinition: (id: string) => ApplicationDefinition | undefined;
  getApplications: () => ApplicationDefinition[];
  openApp: (appId: string) => void;
  openSharedFile: (appId: 'photos' | 'video', file: StoredFile) => void;
  setVrActive: (active: boolean) => void;
  showControlsGuide: () => void;
  toggleKeyboard: () => void;
  keyboard: UniversalKeyboardManager;
  setSpatialMode: (mode: AppSettings['spatialMode']) => Promise<void>;
  onSpatialFrame: (frame: SpatialFrame) => void;
  onWindowsChanged: (windows: WindowState[]) => void;
  onGazeProgress: (progress: number, active: boolean) => void;
  onHandFrame: (frame: HandVisualFrame | null) => void;
  activateDomElement: (x: number, y: number) => boolean;
  gamepadDomInput?: (control: GamepadControl) => boolean;
  gamepadCommand?: (command: GamepadCommand) => void;
  isDomModalOpen?: () => boolean;
  onGamepadsChanged?: (gamepads: GamepadSummary[]) => void;
  requestDeviceAccess?: () => Promise<void>;
  getDeviceStatus?: () => string;
  getPanoramaUrl: (id: EnvironmentId) => string | undefined;
  armTracker: ArmTracker;
  rearCamera: RearCamera;
  handTracker: HandTracker;
  notify: (message: string) => void;
  pickFiles: (accept: string, multiple: boolean) => Promise<File[]>;
  requestUrl: (current: string) => Promise<string | null>;
  requestText: (options: TextRequestOptions) => Promise<string | null>;
  requestConfirm: (message: string) => Promise<boolean>;
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
  toggleWindowPin: (id: string) => void;
  pinFocusedWindow: () => void;
  showScan: (record: ScanRecord) => void;
}

export class SpatialScene {
  readonly renderer: WebGLRenderer;
  readonly scene = new Scene();
  readonly camera = new PerspectiveCamera(58, 1, 0.05, 120);
  readonly windows = new Map<string, SpatialWindow>();
  readonly stereo: StereoRenderer;

  private readonly environment = new Group();
  private readonly scanGroup = new Group();
  private readonly textureLoader = new TextureLoader();
  private panorama: Mesh<SphereGeometry, MeshBasicMaterial> | null = null;
  private environmentTexture: Texture | null = null;
  private environmentGeneration = 0;
  private cameraEnvironmentReady = false;
  private handEnvironmentDrag: { x: number; y: number; rotationX: number; rotationY: number } | null = null;
  private readonly raycaster = new Raycaster();
  private readonly gazeRaycaster = new Raycaster();
  private readonly pointerNdc = new Vector2();
  private readonly pointerNdcRight = new Vector2();
  private readonly pointers = new Map<number, Vector2>();
  private readonly taskbar: SpatialTaskbar;
  private readonly windowManager: WindowManager;
  private readonly intelligence = new SpatialIntelligence();
  private readonly companionClient: CompanionClient;
  private readonly environmentRenderer = new EnvironmentRenderer();
  private readonly frameCanvas = document.createElement('canvas');
  private readonly frameContext: CanvasRenderingContext2D | null;
  private latestSpatialFrame: SpatialFrame | null = null;
  private lastSpatialFrameIngest = 0;
  private readonly spatialInput = new SpatialInput();
  private readonly spatialHands = new SpatialHands();
  private readonly spatialNotification = new SpatialNotification();
  private readonly viewTarget = new Quaternion();
  private readonly identityQuaternion = new Quaternion();
  private readonly manualQuaternion = new Quaternion();
  private readonly manualEuler = new Euler();
  private readonly clock = new (class {
    private previous = performance.now();
    getDelta(): number {
      const now = performance.now();
      const delta = (now - this.previous) / 1000;
      this.previous = now;
      return Math.min(delta, 0.05);
    }
  })();
  private drag: DragState | null = null;
  private contentPointer: { pointerId: number; window: SpatialWindow; region: WindowHitRegion; x: number; y: number; lastY: number; moved: boolean } | null = null;
  private handScroll: { window: SpatialWindow; region: WindowHitRegion; contentX: number; contentY: number; y: number; lastY: number; moved: boolean } | null = null;
  private handDragging = false;
  private twoHandResizing = false;
  private suppressHandActivation = false;
  private smoothedHand: { x: number; y: number } | null = null;
  private handInteraction = new HandInteractionController();
  private handVisualFrame: HandVisualFrame | null = null;
  private secondaryHandLandmarks: HandVisualPoint[] = [];
  private lastHandUpdateTime = 0;
  private lookPointer: { id: number; x: number; y: number; yaw: number; pitch: number } | null = null;
  private vrPointer: { id: number; x: number; y: number } | null = null;
  private readonly gamepad = new GamepadMapper(() => {
    if (typeof navigator === 'undefined' || typeof navigator.getGamepads !== 'function') return [];
    try {
      return navigator.getGamepads() as Array<GamepadDevice | null>;
    } catch {
      return [];
    }
  });
  private readonly gamepadCursor = new Vector2();
  private gamepadCursorReady = false;
  private gamepadEngaged = false;
  private yaw = 0;
  private pitch = 0;
  private animationFrame = 0;
  private disposed = false;
  private vrActive = false;
  private pixelRatio = 1;
  private maxPixelRatio = 1;
  private fpsElapsed = 0;
  private fpsFrames = 0;
  private gazeTargetKey = '';
  private hoveredWindow: SpatialWindow | null = null;
  private gazeElapsed = 0;
  private gazeFired = false;
  private settings: AppSettings;
  private currentEnvironment: EnvironmentId;
  private lastRuntimeError = 0;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly domLayer: HTMLElement,
    private readonly motion: MotionController,
    private readonly rearCamera: RearCamera,
    settings: AppSettings,
    private readonly hooks: SceneHooks,
  ) {
    this.settings = settings;
    this.currentEnvironment = settings.environment;
    this.companionClient = new CompanionClient({
      intelligence: this.intelligence,
      getCompanionEnabled: () => this.settings.companionEnabled,
      onFallbackRequired: (reason) => {
        this.hooks.notify(`${reason} Relative camera fallback remains active; open windows were preserved.`);
        if (this.vrActive) this.spatialNotification.show('LiDAR disconnected • camera fallback active');
      },
    });
    this.renderer = new WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: 'high-performance' });
    this.renderer.outputColorSpace = SRGBColorSpace;
    this.renderer.toneMapping = ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = settings.environmentExposure;
    this.renderer.setClearColor(environmentColors(settings.environment).background);
    this.maxPixelRatio = Math.min(globalThis.devicePixelRatio || 1, settings.quality === 'high' ? 2 : 1.5);
    this.pixelRatio = settings.quality === 'low' ? 0.8 : this.maxPixelRatio;
    this.stereo = new StereoRenderer(this.renderer);
    this.frameCanvas.width = 320;
    this.frameCanvas.height = 180;
    this.frameContext = this.frameCanvas.getContext('2d', { willReadFrequently: true });
    this.windowManager = new WindowManager({
      createWindow: (state) => {
        const window = new SpatialWindow(state, this.hooks.getDefinition(state.appId)!, this.windowHooks(), this.domLayer);
        this.windows.set(state.id, window);
        this.scene.add(window.group);
        return window;
      },
      destroyWindow: (window) => {
        const spatialWindow = window as SpatialWindow;
        if (this.hoveredWindow === spatialWindow) this.clearHoveredWindow();
        this.windows.delete(spatialWindow.state.id);
        spatialWindow.destroy();
      },
      onChange: (states) => {
        const ids = new Set(states.map((state) => state.id));
        for (const id of this.windows.keys()) if (!ids.has(id)) this.windows.delete(id);
        this.hooks.onWindowsChanged(states);
      },
      getSettings: () => this.settings,
    });
    this.taskbar = new SpatialTaskbar({
      applications: hooks.getApplications(),
      getTransparency: () => this.settings.glassTransparency,
      getAccent: () => getInterfacePalette(this.settings.palette).accent,
      mode: settings.taskbarMode,
      anchor: settings.taskbarAnchor,
    });
    hooks.keyboard.attach(this.scene);
    this.environmentRenderer.addTo(this.scene);
    this.intelligence.subscribe((frame) => {
      this.latestSpatialFrame = frame;
      this.environmentRenderer.setVisible(this.settings.showEnvironmentMap && frame.capabilities.activeMode !== 'off');
      this.environmentRenderer.update(frame);
      this.hooks.onSpatialFrame(frame);
    });
    this.scene.add(this.environment, this.scanGroup, this.taskbar.group, this.environmentRenderer.group, this.spatialInput.group, this.spatialNotification.group, this.spatialHands.group);
    this.buildEnvironment(settings.environment);
    domLayer.removeAttribute('aria-hidden');
    canvas.addEventListener('pointerdown', this.handlePointerDown);
    canvas.addEventListener('pointermove', this.handlePointerMove);
    canvas.addEventListener('pointerup', this.handlePointerUp);
    canvas.addEventListener('pointercancel', this.handlePointerUp);
    canvas.addEventListener('wheel', this.handleWheel, { passive: false });
    canvas.addEventListener('contextmenu', this.preventContextMenu);
    this.resize();
    this.applySettings(settings);
    this.animationFrame = requestAnimationFrame(this.animate);
  }

  openApp(appId: string): SpatialWindow | null {
    const definition = this.hooks.getDefinition(appId);
    if (!definition) {
      this.hooks.notify(`Application ${appId} is not available.`);
      return null;
    }
    for (const existing of this.windows.values()) existing.instance.deactivate?.();
    const managed = this.windowManager.open(appId, definition.name);
    const window = managed as SpatialWindow;
    window.instance.activate?.();
    window.render(performance.now(), true);
    uiSound.play('open');
    this.hooks.notify(`${definition.name} opened.`);
    return window;
  }

  restoreWindows(states: unknown[]): void {
    const valid = states.filter((value) => {
      const state = restoreWindowState(value, this.windows.size);
      return Boolean(state && this.hooks.getDefinition(state.appId));
    });
    this.windowManager.restore(valid);
    const focused = this.listWindows()[0];
    if (focused) this.windows.get(focused.id)?.instance.activate?.();
  }

  closeWindow(id: string): void {
    const window = this.windows.get(id);
    if (!window) return;
    const name = window.definition.name;
    window.instance.suspend?.();
    window.instance.deactivate?.();
    this.windowManager.close(id);
    uiSound.play('close');
    this.hooks.notify(`${name} closed.`);
  }

  focusWindow(id: string): void {
    const window = this.windows.get(id);
    if (!window) return;
    for (const existing of this.windows.values()) {
      if (existing !== window && !existing.state.minimized) existing.instance.deactivate?.();
    }
    window.instance.resume?.();
    this.windowManager.focus(id);
    window.instance.activate?.();
  }

  listWindows(): WindowState[] {
    return this.windowManager.list();
  }

  arrangeWindowsSurround(): void {
    if (!this.windowManager.arrange()) {
      this.hooks.notify(this.windows.size ? 'Release a window anchor before arranging the space.' : 'Open a window before arranging the space.');
      return;
    }
    let adjusted = false;
    const frame = this.latestSpatialFrame;
    if (frame?.capabilities.activeMode === 'full' && frame.pose.scale === 'metric' && frame.trackingState !== 'lost') {
      const occupied: OccupiedWindowPose[] = [];
      for (const state of this.windowManager.list()) {
        const pose = { position: state.position, quaternion: state.quaternion, size: state.size };
        const placed = avoidObservedObstacles(pose, frame.objects, frame.surfaces, frame.freeSpace, occupied);
        if (placed !== pose) {
          this.windowManager.setPose(state.id, placed);
          adjusted = true;
        }
        occupied.push({ position: placed.position, size: placed.size });
      }
    }
    this.hooks.notify(adjusted ? 'Windows arranged with observed metric obstacle and overlap avoidance.' : 'Windows arranged in a stable 6DOF arc.');
  }

  toggleWindowAnchor(id: string): boolean {
    const window = this.windows.get(id);
    if (!window) return false;
    window.group.updateMatrixWorld(true);
    const anchored = window.state.anchor === undefined;
    const worldPose = this.windowManager.worldPose(id);
    const changed = this.windowManager.setAnchor(id, anchored
      ? { id: `window:${id}`, kind: 'world', transform: worldPose ?? window.group, confidence: 1 }
      : null);
    if (changed) this.hooks.notify(`${window.definition.name} ${anchored ? 'anchored at its current world pose' : 'released from its anchor'}.`);
    return anchored && changed;
  }

  moveWindowDepth(id: string, delta: number): boolean {
    if (!Number.isFinite(delta) || !this.windowManager.beginManipulation(id, 'depth')) return false;
    const changed = this.windowManager.applyManipulation({ depth: delta });
    this.windowManager.endManipulation();
    return changed;
  }

  private minimizeWindow(id: string): boolean {
    const window = this.windows.get(id);
    if (!window) return false;
    window.instance.deactivate?.();
    return this.windowManager.setMinimized(id, true);
  }

  setFocusedWindowMode(mode: WindowMode): boolean {
    const window = [...this.windows.values()]
      .filter((candidate) => !candidate.state.minimized)
      .sort((a, b) => b.state.z - a.state.z)[0];
    if (!window) {
      this.hooks.notify('Open or focus a window before changing its positioning mode.');
      return false;
    }
    const changed = this.windowManager.setPositioning(window.state.id, mode);
    if (changed) this.hooks.notify(`${window.definition.name}: ${mode} positioning.`);
    return changed;
  }

  private cycleFocusedWindowMode(): void {
    const window = [...this.windows.values()]
      .filter((candidate) => !candidate.state.minimized)
      .sort((a, b) => b.state.z - a.state.z)[0];
    if (!window) {
      this.hooks.notify('Open or focus a window before changing its positioning mode.');
      return;
    }
    const mode = this.cycleWindowMode(window.state.id);
    if (mode) this.hooks.notify(`${window.definition.name}: ${mode} positioning.`);
  }

  private cycleWindowMode(id: string): WindowState['mode'] | undefined {
    const window = this.windows.get(id);
    if (!window) return undefined;
    const modes = ['world', 'head', 'individual'] as const;
    const mode = modes[(modes.indexOf(window.state.mode) + 1) % modes.length];
    return this.windowManager.setPositioning(id, mode) ? mode : undefined;
  }

  private rollWindow(id: string, delta: number): boolean {
    if (!Number.isFinite(delta) || !this.windowManager.beginManipulation(id, 'rotate')) return false;
    const changed = this.windowManager.applyManipulation({ roll: delta, dt: 1 / 30 });
    this.windowManager.endManipulation();
    return changed;
  }

  toggleWindowPin(id: string): boolean {
    return this.toggleWindowAnchor(id);
  }

  toggleFocusedWindowPin(): void {
    this.toggleFocusedWindowAnchor();
  }

  toggleFocusedWindowAnchor(): void {
    const window = [...this.windows.values()].sort((a, b) => b.state.z - a.state.z)[0];
    if (window) this.toggleWindowAnchor(window.state.id);
    else this.hooks.notify('Open or focus a window before anchoring it.');
  }

  refreshEnvironment(): void {
    if (this.currentEnvironment.startsWith('custom:')) this.buildEnvironment(this.currentEnvironment);
  }

  setEnvironment(environment: EnvironmentId): void {
    if (this.currentEnvironment === environment) return;
    this.currentEnvironment = environment;
    this.settings.environment = environment;
    this.buildEnvironment(environment);
    this.hooks.notify(`Environment changed to ${environment}.`);
  }

  applySettings(settings: AppSettings): void {
    const environmentChanged = settings.environment !== this.currentEnvironment;
    const taskbarPlacementChanged = settings.taskbarMode !== this.settings.taskbarMode
      || JSON.stringify(settings.taskbarAnchor) !== JSON.stringify(this.settings.taskbarAnchor);
    this.settings = settings;
    uiSound.configure(settings);
    this.companionClient.setEnabled(settings.companionEnabled);
    this.motion.sensitivity = settings.motionSensitivity;
    this.stereo.setSettings(settings.ipd, settings.fov, settings.distortion);
    this.renderer.toneMappingExposure = settings.environmentExposure;
    this.handInteraction.configure({ dwellTime: settings.dwellTime, movementThreshold: 20 });
    this.taskbar.setGlassTransparency();
    this.taskbar.setInterfacePalette();
    if (taskbarPlacementChanged) {
      this.taskbar.setMode(settings.taskbarMode);
      if (settings.taskbarMode === 'world' && settings.taskbarAnchor) this.taskbar.captureWorldAnchor(settings.taskbarAnchor);
    }
    this.environmentRenderer.setVisible(settings.showEnvironmentMap && settings.spatialMode !== 'off');
    for (const window of this.windows.values()) {
      window.setGlassTransparency(settings.glassTransparency);
      window.setInterfacePalette(settings.palette);
    }
    const interfaceAccent = getInterfacePalette(settings.palette).accent;
    this.hooks.keyboard.keyboard.setInterfacePalette();
    this.spatialInput.setInterfacePalette(interfaceAccent);
    this.spatialNotification.setInterfacePalette(interfaceAccent);
    if (environmentChanged) this.setEnvironment(settings.environment);
    this.maxPixelRatio = Math.min(globalThis.devicePixelRatio || 1, settings.quality === 'high' ? 2 : 1.5);
    const desired = settings.quality === 'low' ? 0.8 : settings.quality === 'high' ? this.maxPixelRatio : Math.min(this.pixelRatio, this.maxPixelRatio);
    this.setPixelRatio(desired);
  }

  setVrActive(active: boolean): void {
    this.vrActive = active;
    this.gamepad.resetInput();
    this.gamepadCursorReady = false;
    this.gamepadEngaged = false;
    this.gazeElapsed = 0;
    this.gazeFired = false;
    this.resetGazeTarget();
    this.hooks.onGazeProgress(0, false);
    if (this.vrPointer && this.canvas.hasPointerCapture(this.vrPointer.id)) this.canvas.releasePointerCapture(this.vrPointer.id);
    this.finishHandDrag(false);
    this.endWindowDrag();
    this.contentPointer = null;
    this.lookPointer = null;
    this.pointers.clear();
    this.vrPointer = null;
    this.handInteraction.reset();
    this.lastHandUpdateTime = 0;
    this.emitHandFrame(null);
    this.taskbar.setVisible(active);
    if (!active) {
      this.spatialInput.close();
      this.hooks.keyboard.close(false);
      this.spatialNotification.hide();
      this.spatialHands.hide();
      this.clearHoveredWindow();
      this.taskbar.hover(-1, -1);
      this.spatialInput.clearHover();
    }
    this.setPixelRatio(active ? Math.min(this.pixelRatio, 1.05) : this.settings.quality === 'low' ? 0.8 : this.maxPixelRatio);
    this.resize();
  }

  isVrActive(): boolean {
    return this.vrActive;
  }

  setSpatialMode(mode: AppSettings['spatialMode'], cameraAvailable?: boolean): Promise<SpatialCapabilities> {
    return this.intelligence.setMode(mode, cameraAvailable);
  }

  ingestMotion(sample: MotionSample): void {
    this.intelligence.ingestMotion(sample);
  }

  getSpatialFrame(): SpatialFrame {
    return this.intelligence.readLatest();
  }

  getCompanionStatus(): CompanionClientStatus {
    return this.companionClient.getStatus();
  }

  async connectCompanion(endpoint: string): Promise<void> {
    if (!this.settings.companionEnabled) throw new Error('Enable the external LiDAR companion before connecting.');
    await this.companionClient.connect({
      url: endpoint,
      authorizePairing: (request) => this.requestConfirm(
        `Authorize ${request.device.name}${request.device.model ? ` (${request.device.model})` : ''} for local spatial data? Key ${request.keyFingerprint}. Only this paired device may connect.`,
      ),
    });
  }

  disconnectCompanion(): void {
    this.companionClient.disconnect();
  }

  showSpatialNotification(message: string): void {
    if (this.vrActive) this.spatialNotification.show(message);
  }

  handlePhysicalKey(event: KeyboardEvent): boolean {
    return this.hooks.keyboard.physicalKey(event) || (this.vrActive && this.spatialInput.physicalKey(event));
  }

  private updateGamepad(delta: number): void {
    const frame = this.gamepad.update(delta);
    if (frame.connectionChanged) {
      this.hooks.onGamepadsChanged?.(frame.gamepads);
      this.gamepadCursorReady = false;
      if (frame.gamepad) {
        uiSound.play('connect');
        const mappingNote = frame.gamepad.mapping === 'standard' ? '' : ' — non-standard mapping; automatic controls require a standard-mapping controller';
        this.hooks.notify(`Controller connected: ${frame.gamepad.id}${mappingNote}`);
      }
    }
    this.gamepadEngaged = false;
    if (!frame.gamepad) return;
    this.gamepadEngaged = frame.held.length > 0 || Math.abs(frame.moveX) + Math.abs(frame.moveY) + Math.abs(frame.lookX) + Math.abs(frame.lookY) > 0.01;

    const commands: Partial<Record<GamepadControl, GamepadCommand>> = {
      b: 'back', x: 'keyboard', y: 'launcher', start: 'settings', back: 'back',
      ls: 'windows', rs: 'environment', home: 'guide',
    };
    const domModalOpen = this.hooks.isDomModalOpen?.() ?? false;
    let commandHandled = false;
    let windowNavigationHandled = false;
    for (const control of frame.pressed) {
      if (this.spatialInput.isOpen && control !== 'b' && control !== 'back') continue;
      if (domModalOpen && control !== 'b' && control !== 'back') continue;
      const command = commands[control];
      if (command) {
        if (commandHandled) continue;
        this.hooks.gamepadCommand?.(command);
        commandHandled = true;
        continue;
      }
      if (control === 'lb' || control === 'rb') {
        if (commandHandled || windowNavigationHandled) continue;
        this.cycleWindowFocus(control === 'lb' ? -1 : 1);
        windowNavigationHandled = true;
        continue;
      }
      if (control === 'lt' || control === 'rt') {
        if (commandHandled || windowNavigationHandled) continue;
        const focused = this.listWindows()[0];
        if (focused && this.moveWindowDepth(focused.id, control === 'lt' ? -0.35 : 0.35)) uiSound.play('move');
        windowNavigationHandled = true;
      }
    }

    if (!this.vrActive) {
      if (!commandHandled && !windowNavigationHandled) {
        for (const control of frame.pressed) this.hooks.gamepadDomInput?.(control);
      }
      return;
    }

    if (frame.lookX || frame.lookY) {
      this.yaw -= frame.lookX * delta * 1.55;
      this.pitch = MathUtils.clamp(this.pitch - frame.lookY * delta * 1.2, -1.25, 1.25);
    }

    const width = this.canvas.clientWidth || globalThis.innerWidth;
    const height = this.canvas.clientHeight || globalThis.innerHeight;
    if (!this.gamepadCursorReady) {
      this.gamepadCursor.set(width / 2, height / 2);
      this.gamepadCursorReady = true;
    }
    const horizontal = (frame.pressed.includes('right') ? 1 : 0) - (frame.pressed.includes('left') ? 1 : 0);
    const vertical = (frame.pressed.includes('down') ? 1 : 0) - (frame.pressed.includes('up') ? 1 : 0);
    this.gamepadCursor.x = MathUtils.clamp(this.gamepadCursor.x + frame.moveX * 680 * delta + horizontal * 28, 0, width);
    this.gamepadCursor.y = MathUtils.clamp(this.gamepadCursor.y + frame.moveY * 680 * delta + vertical * 28, 0, height);
    this.updateVrHandHover(this.gamepadCursor.x, this.gamepadCursor.y);
    if (horizontal || vertical) uiSound.play('move');
    if (frame.pressed.includes('a') && !commandHandled && !windowNavigationHandled) {
      const event = new PointerEvent('pointerup', { clientX: this.gamepadCursor.x, clientY: this.gamepadCursor.y, pointerId: -3, pointerType: 'gamepad', bubbles: true });
      this.activateSpatialAt(this.gamepadCursor.x, this.gamepadCursor.y, -3, event, true);
    }
  }

  private cycleWindowFocus(direction: number): void {
    const windows = [...this.windows.values()].filter((window) => !window.state.minimized);
    if (!windows.length) return;
    const currentId = this.listWindows()[0]?.id;
    const index = windows.findIndex((window) => window.state.id === currentId);
    const next = windows[(index + direction + windows.length) % windows.length];
    this.focusWindow(next.state.id);
    this.hooks.notify(`${next.definition.name} focused.`);
    uiSound.play('move');
  }

  openOrFocusApp(appId: string): SpatialWindow | null {
    const existing = [...this.windows.values()].find((window) => window.state.appId === appId);
    if (existing) {
      this.focusWindow(existing.state.id);
      uiSound.play('tap');
      return existing;
    }
    return this.openApp(appId);
  }

  private windowHooks(): WindowHooks {
    return {
      rearCamera: this.rearCamera,
      handTracker: this.hooks.handTracker,
      notify: this.hooks.notify,
      pickFiles: this.hooks.pickFiles,
      requestUrl: (current) => this.requestUrl(current),
      requestText: (options) => this.requestText(options),
      requestConfirm: (message) => this.requestConfirm(message),
      openSharedFile: (appId, file) => this.hooks.openSharedFile(appId, file),
      isVrActive: () => this.vrActive,
      confirm: this.hooks.confirm,
      getSettings: () => this.settings,
      updateSettings: this.hooks.updateSettings,
      toggleHandControls: () => this.hooks.toggleHandControls(),
      recalibrate: () => this.recalibrate(),
      setEnvironment: (environment) => this.hooks.setEnvironment(environment),
      focusWindow: (id) => this.focusWindow(id),
      closeWindow: (id) => this.closeWindow(id),
      listWindows: () => this.listWindows(),
      arrangeWindows: () => this.arrangeWindowsSurround(),
      toggleWindowPin: (id) => this.toggleWindowPin(id),
      toggleWindowAnchor: (id) => this.toggleWindowAnchor(id),
      moveWindowDepth: (id, delta) => this.moveWindowDepth(id, delta),
      pinFocusedWindow: () => this.toggleFocusedWindowPin(),
      getCompanionStatus: () => this.getCompanionStatus(),
      connectCompanion: (endpoint) => this.connectCompanion(endpoint),
      disconnectCompanion: () => this.disconnectCompanion(),
      requestDeviceAccess: () => this.hooks.requestDeviceAccess?.() ?? Promise.resolve(),
      getDeviceStatus: () => this.hooks.getDeviceStatus?.() ?? 'Device support unavailable',
      showScan: (record) => this.showScan(record),
      controls: {
        minimize: (id) => this.minimizeWindow(id),
        toggleMaximize: (id) => this.windowManager.toggleMaximize(id),
        cycleMode: (id) => this.cycleWindowMode(id),
        toggleAnchor: (id) => this.toggleWindowAnchor(id),
        moveDepth: (id, delta) => this.moveWindowDepth(id, delta),
        setPose: (id, pose) => this.windowManager.setPose(id, pose),
        roll: (id, delta) => this.rollWindow(id, delta),
      },
    };
  }

  private requestUrl(current: string): Promise<string | null> {
    if (!this.vrActive) return this.hooks.requestUrl(current);
    return this.requestText({ title: 'Open a website', value: current, placeholder: 'https://example.com', submitLabel: 'Open' });
  }

  private requestText(options: TextRequestOptions): Promise<string | null> {
    if (!this.vrActive) return this.hooks.requestText(options);
    if (options.mode === 'information' || options.mode === 'confirm') {
      this.hooks.keyboard.close(false);
      this.spatialInput.group.visible = true;
      return this.spatialInput.requestText(options);
    }
    this.spatialInput.close();
    this.spatialInput.group.visible = false;
    this.finishHandDrag(false);
    return this.hooks.keyboard.open(options);
  }

  private requestConfirm(message: string): Promise<boolean> {
    if (!this.vrActive) return this.hooks.confirm(message);
    this.hooks.keyboard.close(false);
    this.spatialInput.group.visible = true;
    return this.spatialInput.requestConfirm(message);
  }

  private activateTaskbarAction(action: TaskbarAction): void {
    if (action.type === 'section') return;
    if (action.type === 'app') {
      this.openOrFocusApp(action.appId);
      return;
    }
    uiSound.play(action.command === 'exit' || action.command === 'hide' ? 'close' : action.command === 'show' || action.command === 'follow' || action.command === 'anchor' ? 'toggle' : 'tap');
    switch (action.command) {
      case 'exit': this.hooks.setVrActive(false); break;
      case 'keyboard': void this.showSpatialKeyboard(); break;
      case 'hands': void this.hooks.toggleHandControls(); break;
      case 'guide': void this.showSpatialGuide(); break;
      case 'settings': this.openOrFocusApp('settings'); break;
      case 'pin': this.toggleFocusedWindowPin(); break;
      case 'anchor': this.taskbar.setMode('world'); this.persistTaskbarAnchor(); break;
      case 'follow': this.taskbar.setMode('follow'); this.persistTaskbarAnchor(); break;
      case 'reposition': this.repositionTaskbar(); break;
      case 'mode-cycle': this.cycleFocusedWindowMode(); break;
      case 'hide': this.taskbar.setVisible(false); break;
      case 'show': this.taskbar.setVisible(this.vrActive); break;
      case 'arrange': this.arrangeWindowsSurround(); break;
      case 'recalibrate': this.recalibrate(); break;
    }
  }

  showSpatialKeyboard(): void {
    const focused = [...this.windows.values()]
      .filter((window) => !window.state.minimized)
      .sort((a, b) => b.state.z - a.state.z)[0];
    if (focused?.openKeyboard()) return;
    void this.hooks.keyboard.open({
      title: 'Spatial keyboard',
      value: '',
      placeholder: 'No compatible field is selected. Open Internet, YouTube, Notes, or AI and choose Keyboard to type into that app.',
      submitLabel: 'Done',
    });
  }

  dismissSpatialPrompt(): boolean {
    if (!this.spatialInput.isOpen) return false;
    this.spatialInput.close();
    return true;
  }

  showSpatialGuide(): void {
    const guide = [
      'PINCH: point at a taskbar item, button, or field and pinch.',
      'DRAG: pinch a title bar, rotate handle, or resize corner and keep holding.',
      'RESIZE: bring two pinched hands over a window and spread them.',
      'SCROLL: hold in long content and move your hand vertically.',
      'WORLD: use Follow or World Anchored taskbar controls; camera position is relative unless a calibrated companion is connected.',
      'KEYBOARD: French AZERTY is the default; select a real text field or open a scratch keyboard. Use the 123 key for direct digits and decimals.',
      'GAMEPAD: left stick or D-pad moves the cursor, right stick looks, A selects, B goes back, X opens the keyboard, shoulders switch windows, triggers change depth.',
      'DEVICES: Web Bluetooth opens a chooser where supported. Wi-Fi scanning or joining cannot be authorized by a browser; pair controllers in system settings.',
      'LIMITS: websites and YouTube video pixels may block cross-origin embedding.',
      'PRIVACY: keys stay in this browser; camera frames and files stay on this device.',
    ].join('\n');
    void this.requestText({ title: 'Controls & commands', value: guide, placeholder: 'VR controls', submitLabel: 'Done', cancelLabel: 'Close', mode: 'information' });
  }

  repositionTaskbar(): void {
    this.taskbar.recenter(this.camera.quaternion, this.settings.vrDistance / 6, this.camera.position);
    this.persistTaskbarAnchor();
    this.hooks.notify('Taskbar positioned in front of you.');
  }

  recalibrate(): void {
    this.yaw = 0;
    this.pitch = 0;
    this.motion.calibrate();
    if (this.vrActive && this.taskbar.getMode() === 'follow') this.taskbar.recenter(this.camera.quaternion, this.settings.vrDistance / 6, this.camera.position);
  }

  private persistTaskbarAnchor(): void {
    this.hooks.updateSettings({ taskbarMode: this.taskbar.getMode(), taskbarAnchor: this.taskbar.getAnchor() ?? undefined });
  }

  showScan(record: ScanRecord): void {
    this.clearScan();
    const positions = new Float32Array(record.points.length * 3);
    const colors = new Float32Array(record.points.length * 3);
    const color = new Color();
    record.points.forEach((point, index) => {
      positions[index * 3] = point.x;
      positions[index * 3 + 1] = point.y;
      positions[index * 3 + 2] = point.z;
      color.setHSL(0.5 + point.intensity * 0.18, 0.85, 0.45 + point.intensity * 0.25);
      colors[index * 3] = color.r;
      colors[index * 3 + 1] = color.g;
      colors[index * 3 + 2] = color.b;
    });
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(positions, 3));
    geometry.setAttribute('color', new BufferAttribute(colors, 3));
    const material = new PointsMaterial({ size: 0.035, vertexColors: true, transparent: true, opacity: 0.9, blending: AdditiveBlending, depthWrite: false });
    const points = new Points(geometry, material);
    points.position.set(0, -0.2, -7);
    this.scanGroup.add(points);
    this.hooks.notify(`Displaying ${record.pointCount.toLocaleString()} estimated scan points.`);
  }

  clearScan(): void {
    for (const child of [...this.scanGroup.children]) {
      if (child instanceof Points) {
        child.geometry.dispose();
        (child.material as PointsMaterial).dispose();
      }
      child.removeFromParent();
    }
  }

  resize = (): void => {
    const width = this.canvas.clientWidth || globalThis.innerWidth;
    const height = this.canvas.clientHeight || globalThis.innerHeight;
    this.renderer.setPixelRatio(this.pixelRatio);
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.stereo.resize(width, height, this.pixelRatio);
  };

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.animationFrame);
    this.canvas.removeEventListener('pointerdown', this.handlePointerDown);
    this.canvas.removeEventListener('pointermove', this.handlePointerMove);
    this.canvas.removeEventListener('pointerup', this.handlePointerUp);
    this.canvas.removeEventListener('pointercancel', this.handlePointerUp);
    this.canvas.removeEventListener('wheel', this.handleWheel);
    this.canvas.removeEventListener('contextmenu', this.preventContextMenu);
    this.environmentGeneration += 1;
    this.environmentTexture?.dispose();
    this.environmentTexture = null;
    for (const state of this.windowManager.list()) {
      const window = this.windows.get(state.id);
      window?.instance.suspend?.();
      window?.instance.deactivate?.();
      this.windowManager.close(state.id);
    }
    this.windows.clear();
    this.companionClient.dispose();
    this.intelligence.dispose();
    this.environmentRenderer.dispose();
    this.hooks.keyboard.destroy();
    this.clearScan();
    this.taskbar.destroy();
    this.spatialInput.destroy();
    this.spatialNotification.destroy();
    this.spatialHands.destroy();
    this.stereo.dispose();
    this.renderer.dispose();
  }

  private effectiveMaxPixelRatio(): number {
    return this.vrActive ? Math.min(this.maxPixelRatio, 1.05) : this.maxPixelRatio;
  }

  private setPixelRatio(ratio: number): void {
    this.pixelRatio = MathUtils.clamp(ratio, 0.65, this.effectiveMaxPixelRatio());
    this.resize();
  }

  private emitWindowsChanged(): void {
    this.hooks.onWindowsChanged(this.listWindows());
  }

  private buildEnvironment(environment: EnvironmentId): void {
    const generation = ++this.environmentGeneration;
    this.environmentTexture?.dispose();
    this.environmentTexture = null;
    this.panorama = null;
    this.environment.rotation.set(0, 0, 0);
    this.environment.traverse((object) => {
      if (object instanceof Mesh || object instanceof Points) {
        object.geometry.dispose();
        const materials = Array.isArray(object.material) ? object.material : [object.material];
        materials.forEach((material) => material.dispose());
      }
    });
    this.environment.clear();
    const colors = environmentColors(environment);
    this.scene.background = colors.background;
    this.scene.fog = null;
    this.renderer.setClearColor(colors.background);

    if (environment === 'camera') {
      this.cameraEnvironmentReady = this.rearCamera.ready;
      if (this.cameraEnvironmentReady) {
        const texture = new VideoTexture(this.rearCamera.video);
        texture.wrapS = RepeatWrapping;
        texture.repeat.x = -1;
        texture.offset.x = 1;
        this.environmentTexture = texture;
        this.addPanorama(texture);
      }
      return;
    }

    const url = environment === 'venice' || environment === 'loft'
      ? PANORAMA_URLS[environment]
      : this.hooks.getPanoramaUrl(environment);
    if (!url) {
      if (environment.startsWith('custom:')) this.hooks.notify('This panorama is not available on this device.');
      return;
    }
    this.textureLoader.load(url, (texture) => {
      if (generation !== this.environmentGeneration || this.currentEnvironment !== environment) {
        texture.dispose();
        return;
      }
      this.environmentTexture = texture;
      this.addPanorama(texture);
    }, undefined, () => {
      if (generation === this.environmentGeneration) this.hooks.notify('Could not load this 360 panorama.');
    });
  }

  private addPanorama(texture: Texture): void {
    texture.colorSpace = SRGBColorSpace;
    texture.minFilter = LinearFilter;
    texture.magFilter = LinearFilter;
    texture.generateMipmaps = false;
    texture.anisotropy = Math.min(8, this.renderer.capabilities.getMaxAnisotropy());
    texture.needsUpdate = true;
    const panorama = new Mesh(
      new SphereGeometry(45, 64, 32),
      new MeshBasicMaterial({ map: texture, side: BackSide, fog: false, toneMapped: false }),
    );
    panorama.rotation.y = this.currentEnvironment === 'loft' ? Math.PI : 0;
    this.environment.add(panorama);
    this.panorama = panorama;
  }

  private animate = (): void => {
    if (this.disposed) return;
    try {
      const delta = this.clock.getDelta();
      const time = performance.now();
      const motionTarget = this.motion.getTarget();
      this.manualEuler.set(this.pitch, this.yaw, 0, 'YXZ');
      this.manualQuaternion.setFromEuler(this.manualEuler);
      this.viewTarget.copy(motionTarget ?? this.identityQuaternion).multiply(this.manualQuaternion);
      this.camera.quaternion.slerp(this.viewTarget, 1 - Math.exp(-delta * 10));
      const spatialFrame = this.latestSpatialFrame;
      const spatialPoseFresh = Boolean(spatialFrame && spatialFrame.capabilities.activeMode !== 'off' &&
        spatialFrame.trackingState !== 'lost' && time - spatialFrame.timestamp < 600);
      if (spatialPoseFresh && spatialFrame) {
        this.camera.position.set(...spatialFrame.pose.position);
      } else if (!this.vrActive) {
        this.camera.position.set(0, 0, 0);
      }
      this.camera.updateMatrixWorld();
      this.ingestSpatialCamera(time);

      const distanceScale = this.vrActive ? this.settings.vrDistance / 6 : 1;
      this.windowManager.step(delta, {
        position: { x: this.camera.position.x, y: this.camera.position.y, z: this.camera.position.z },
        quaternion: { x: this.camera.quaternion.x, y: this.camera.quaternion.y, z: this.camera.quaternion.z, w: this.camera.quaternion.w },
      });
      for (const window of this.windows.values()) {
        window.updateTransform(this.camera.position, this.camera.quaternion, this.vrActive);
        window.update(delta, time);
        window.render(time);
      }
      this.taskbar.update(this.camera.position, this.camera.quaternion, delta, this.vrActive);
      this.hooks.keyboard.update(
        this.camera.position,
        this.camera.quaternion,
        delta,
        this.vrActive,
        this.vrActive ? this.settings.fov : this.camera.fov,
        this.vrActive ? this.stereo.leftCamera.aspect : this.camera.aspect,
        this.settings.distortion,
      );
      if (this.vrActive) {
        this.taskbar.render();
        this.hooks.keyboard.render();
        this.spatialInput.update(this.camera.quaternion, distanceScale);
        this.spatialInput.render();
        this.spatialNotification.update(this.camera.quaternion, distanceScale, time);
      }
      if (this.currentEnvironment === 'camera' && this.cameraEnvironmentReady !== this.rearCamera.ready) this.buildEnvironment('camera');
      this.scanGroup.rotation.y += delta * 0.08;
      this.updateGamepad(delta);
      this.updateHandTracking();
      if (this.vrActive) {
        const width = this.canvas.clientWidth || globalThis.innerWidth;
        const height = this.canvas.clientHeight || globalThis.innerHeight;
        this.spatialHands.update(
          this.handVisualFrame,
          this.camera.quaternion,
          { width: width / 2, height },
          { width: this.rearCamera.video.videoWidth || width, height: this.rearCamera.video.videoHeight || height },
          this.settings.fov,
          this.handVisualFrame && this.handVisualFrame.x >= width / 2 ? 'right' : 'left',
        );
      } else this.spatialHands.hide();
      this.updateOverlays();
      if (this.vrActive) {
        this.stereo.render(this.scene, this.camera.position, this.camera.quaternion);
        this.updateGaze(delta);
      } else {
        this.renderer.setRenderTarget(null);
        this.renderer.setViewport(0, 0, this.canvas.clientWidth || globalThis.innerWidth, this.canvas.clientHeight || globalThis.innerHeight);
        this.renderer.render(this.scene, this.camera);
      }
      this.updateAdaptiveQuality(delta);
    } catch (error) {
      const now = performance.now();
      if (now - this.lastRuntimeError > 5000) {
        this.lastRuntimeError = now;
        this.hooks.notify(`A spatial module recovered from an error: ${error instanceof Error ? error.message : 'unknown error'}`);
      }
    } finally {
      this.animationFrame = requestAnimationFrame(this.animate);
    }
  };

  private ingestSpatialCamera(time: number): void {
    const mode = this.latestSpatialFrame?.capabilities.activeMode ?? 'off';
    if ((mode !== 'camera' && mode !== 'full') || !this.rearCamera.ready || !this.frameContext) return;
    const interval = this.settings.spatialMode === 'economy' ? 160 : this.settings.quality === 'low' ? 120 : 80;
    if (time - this.lastSpatialFrameIngest < interval) return;
    this.lastSpatialFrameIngest = time;
    this.frameContext.drawImage(this.rearCamera.video, 0, 0, this.frameCanvas.width, this.frameCanvas.height);
    const image = this.frameContext.getImageData(0, 0, this.frameCanvas.width, this.frameCanvas.height);
    const focal = this.frameCanvas.height * 0.5 / Math.tan(MathUtils.degToRad(this.settings.fov * 0.5));
    this.intelligence.ingestFrame(time, image, {
      width: image.width,
      height: image.height,
      fx: focal,
      fy: focal,
      cx: image.width * 0.5,
      cy: image.height * 0.5,
      timestamp: time,
      calibration: 'estimated',
    });
  }

  private updateAdaptiveQuality(delta: number): void {
    if (this.settings.quality !== 'auto') return;
    this.fpsElapsed += delta;
    this.fpsFrames += 1;
    if (this.fpsElapsed < 2.5) return;
    const fps = this.fpsFrames / this.fpsElapsed;
    if (fps < 36 && this.pixelRatio > 0.7) this.setPixelRatio(this.pixelRatio - 0.1);
    else if (fps > 55 && this.pixelRatio < this.effectiveMaxPixelRatio()) this.setPixelRatio(this.pixelRatio + 0.05);
    this.fpsElapsed = 0;
    this.fpsFrames = 0;
  }

  private updateOverlays(): void {
    const width = this.canvas.clientWidth;
    const height = this.canvas.clientHeight;
    for (const window of this.windows.values()) {
      const overlay = window.overlay;
      if (!overlay) continue;
      if (this.vrActive || window.state.minimized) {
        overlay.style.display = 'none';
        continue;
      }
      window.group.updateMatrixWorld();
      const rect = window.overlayRect;
      const local = [
        new Vector3(rect.x / window.canvas.width - 0.5, 0.5 - rect.y / window.canvas.height, 0.015),
        new Vector3((rect.x + rect.width) / window.canvas.width - 0.5, 0.5 - rect.y / window.canvas.height, 0.015),
        new Vector3((rect.x + rect.width) / window.canvas.width - 0.5, 0.5 - (rect.y + rect.height) / window.canvas.height, 0.015),
        new Vector3(rect.x / window.canvas.width - 0.5, 0.5 - (rect.y + rect.height) / window.canvas.height, 0.015),
      ];
      const projected = local.map((point) => {
        point.applyMatrix4(window.group.matrixWorld).project(this.camera);
        return { x: (point.x * 0.5 + 0.5) * width, y: (-point.y * 0.5 + 0.5) * height, z: point.z };
      });
      if (projected.some((point) => point.z > 1 || point.z < -1)) {
        overlay.style.display = 'none';
        continue;
      }
      const centerX = projected.reduce((sum, point) => sum + point.x, 0) / 4;
      const centerY = projected.reduce((sum, point) => sum + point.y, 0) / 4;
      this.pointerNdc.set((centerX / width) * 2 - 1, -((centerY / height) * 2 - 1));
      this.raycaster.setFromCamera(this.pointerNdc, this.camera);
      const surfaces = [...this.windows.values()].filter((candidate) => candidate.visible).map((candidate) => candidate.surface);
      const topHit = this.raycaster.intersectObjects(surfaces).sort((a, b) => a.distance - b.distance)[0];
      if (topHit && topHit.object.userData.windowId !== window.state.id) {
        overlay.style.display = 'none';
        continue;
      }
      overlay.style.display = 'block';
      overlay.style.width = `${rect.width}px`;
      overlay.style.height = `${rect.height}px`;
      overlay.style.transform = `matrix3d(${overlayTransformMatrix(projected, rect.width, rect.height).join(',')})`;
    }
  }

  private updateGaze(delta: number): void {
    if (this.gamepadEngaged) {
      this.resetGazeTarget();
      this.hooks.onGazeProgress(0, false);
      return;
    }
    if (this.handVisualFrame) {
      this.resetGazeTarget();
      this.hooks.onGazeProgress(0, false);
      return;
    }
    const target = this.gazeTargetAtCenter();
    const key = target?.kind === 'window'
      ? `window:${target.window.state.id}:${target.region.action}`
      : target?.key;
    if (!target || key !== this.gazeTargetKey) {
      this.resetGazeTarget();
      this.gazeTargetKey = key ?? '';
    }
    if (!target) return;
    this.gazeElapsed += delta;
    const progress = Math.min(1, this.gazeElapsed / this.settings.dwellTime);
    this.hooks.onGazeProgress(progress, true);
    if (progress >= 1 && !this.gazeFired) {
      this.gazeFired = true;
      if (target.kind === 'window') {
        this.focusWindow(target.window.state.id);
        if (target.region.action === 'content') {
          const event = new PointerEvent('pointerup', { pointerId: -1, pointerType: 'gaze', bubbles: true });
          this.activateWindowRegion(target.window, target.region, this.canvas.clientWidth / 2, this.canvas.clientHeight / 2, event);
        } else if (!['drag', 'rotate', 'roll', 'depth', 'resize'].includes(target.region.action)) {
          this.activateWindowRegion(target.window, target.region, this.canvas.clientWidth / 2, this.canvas.clientHeight / 2, new PointerEvent('pointerup', { pointerId: -1, pointerType: 'gaze', bubbles: true }));
        }
      } else target.action();
    }
  }

  private resetGazeTarget(): void {
    this.gazeTargetKey = '';
    this.gazeElapsed = 0;
    this.gazeFired = false;
  }

  private gazeTargetAtCenter(): GazeTarget | null {
    this.gazeRaycaster.setFromCamera(new Vector2(0, 0), this.stereo.leftCamera);
    if (this.hooks.keyboard.isOpen) {
      const target = this.hooks.keyboard.keyboard.pick(this.gazeRaycaster);
      return target ? { kind: 'keyboard', key: `keyboard:${target.key}`, action: target.action } : null;
    }
    if (this.spatialInput.isOpen) {
      const hit = this.gazeRaycaster.intersectObject(this.spatialInput.surface, false)[0];
      const uv = hit?.uv;
      const target = uv ? this.spatialInput.target(uv.x, uv.y) : null;
      return target ? { kind: 'input', key: `input:${target.key}`, action: target.action } : null;
    }
    const objects = [
      ...(this.taskbar.group.visible ? [this.taskbar.surface] : []),
      ...[...this.windows.values()].filter((window) => window.visible).map((window) => window.surface),
    ];
    const hit = this.gazeRaycaster.intersectObjects(objects, false).sort((a, b) => a.distance - b.distance)[0];
    if (!hit?.uv) return null;
    if (hit.object === this.taskbar.surface) {
      const target = this.taskbar.target(hit.uv.x, hit.uv.y);
      return target ? {
        kind: 'taskbar',
        key: `taskbar:${target.key}`,
        action: () => {
          const action = this.taskbar.activate(target);
          if (action) this.activateTaskbarAction(action);
        },
      } : null;
    }
    const window = this.windows.get(hit.object.userData.windowId as string);
    if (!window) return null;
    const region = window.hitTest(hit.uv.x, hit.uv.y);
    return { kind: 'window', window, region };
  }

  private emitHandFrame(frame: HandVisualFrame | null): void {
    this.handVisualFrame = frame ? { ...frame, secondaryLandmarks: this.secondaryHandLandmarks } : null;
    this.hooks.onHandFrame(this.handVisualFrame);
  }

  private updateHandTracking(): void {
    if (this.vrActive && this.vrPointer) return;
    if (!this.hooks.handTracker.active || !this.rearCamera.ready) {
      this.secondaryHandLandmarks = [];
      if (!this.vrPointer) this.finishHandDrag(false);
      this.handInteraction.reset();
      this.smoothedHand = null;
      this.lastHandUpdateTime = 0;
      this.emitHandFrame(null);
      return;
    }
    const now = performance.now();
    const result = this.hooks.handTracker.detect(this.rearCamera.video);
    this.secondaryHandLandmarks = result.landmarks[1] ?? [];
    this.rearCamera.recordFrameCost(performance.now() - now);
    const arms = this.hooks.armTracker.active ? this.hooks.armTracker.detect(this.rearCamera.video, now) : [];
    const landmarks = result.landmarks[0] ?? [];
    const tip = landmarks[8];
    if (!tip) {
      if (!this.vrPointer) this.finishHandDrag(false);
      this.handInteraction.reset();
      this.smoothedHand = null;
      this.lastHandUpdateTime = 0;
      this.emitHandFrame(arms.length ? { x: 0, y: 0, pinching: false, progress: 0, cursor: false, landmarks, arms } : null);
      return;
    }
    const width = this.canvas.clientWidth || globalThis.innerWidth;
    const height = this.canvas.clientHeight || globalThis.innerHeight;
    const camera = { width: this.rearCamera.video.videoWidth || width, height: this.rearCamera.video.videoHeight || height };
    const viewport = { width, height };
    const mapped = mapCameraLandmarkToViewport(tip, camera, viewport) ?? { x: (1 - tip.x) * width, y: tip.y * height };
    const handDelta = this.lastHandUpdateTime ? Math.min((now - this.lastHandUpdateTime) / 1000, 0.25) : 1 / 60;
    this.lastHandUpdateTime = now;
    if (!this.smoothedHand) this.smoothedHand = mapped;
    const blend = 1 - Math.exp(-handDelta * (16 - this.settings.handSmoothing * 12));
    const x = this.smoothedHand.x + (mapped.x - this.smoothedHand.x) * blend;
    const y = this.smoothedHand.y + (mapped.y - this.smoothedHand.y) * blend;
    this.smoothedHand = { x, y };

    const secondTip = result.landmarks[1]?.[8];
    const secondMapped = secondTip ? mapCameraLandmarkToViewport(secondTip, camera, viewport) : null;
    const bothPinching = (result.pinchDistances[0] ?? Infinity) <= 0.075 && (result.pinchDistances[1] ?? Infinity) <= 0.075;
    if (secondMapped && !this.hooks.keyboard.isOpen && !this.spatialInput.isOpen && (this.twoHandResizing || bothPinching)) {
      const distance = Math.hypot(mapped.x - secondMapped.x, mapped.y - secondMapped.y);
      if (this.twoHandResizing && this.drag) {
        this.updateHandPinchResize(distance);
      } else if (!this.handDragging) {
        const midpoint = { x: (mapped.x + secondMapped.x) / 2, y: (mapped.y + secondMapped.y) / 2 };
        this.updateRayAt(midpoint.x, midpoint.y);
        const picked = this.pickWindow();
        if (picked && !picked.window.state.pinned && distance > 40) {
          this.focusWindow(picked.window.state.id);
          this.startWindowDrag(picked.window, 'resize', midpoint.x, midpoint.y, -2);
          if (this.drag) this.drag.startPinchDistance = distance;
          this.twoHandResizing = true;
          this.suppressHandActivation = true;
        }
      }
      this.handInteraction.reset();
      this.emitHandFrame({ x, y, pinching: result.pinching, progress: 0, cursor: !this.vrActive, landmarks, arms });
      return;
    }
    if (this.twoHandResizing) this.finishHandDrag(false);

    if (this.suppressHandActivation) {
      const stillPinching = result.pinching || (result.pinchDistances[1] ?? Infinity) <= 0.075;
      this.handInteraction.reset();
      this.emitHandFrame({ x, y, pinching: stillPinching, progress: 0, cursor: true, landmarks, arms });
      if (stillPinching) return;
      this.suppressHandActivation = false;
    }
    const frame = this.handInteraction.update(x, y, result.pinching, handDelta);
    this.emitHandFrame({ x, y, pinching: frame.pinching, progress: frame.progress, cursor: !this.vrActive, landmarks, arms });
    if (this.vrActive) {
      if (!this.gamepadEngaged) this.updateVrHandHover(x, y);
      if (frame.activate && !this.gamepadEngaged) {
        this.activateHandAt(x, y);
        if (this.drag?.action === 'resize') this.drag.handPinchDistance = result.pinchDistance ?? undefined;
      } else if (frame.pinching && !this.gamepadEngaged) this.updateHandManipulation(x, y, result.pinchDistance);
      else if (!this.gamepadEngaged) this.finishHandDrag();
      return;
    }
    if (frame.activate && !this.gamepadEngaged) {
      this.activateHandAt(x, y);
      if (this.drag?.pointerId === -2 && this.drag.action === 'resize') this.drag.handPinchDistance = result.pinchDistance ?? undefined;
    } else if (frame.pinching && !this.gamepadEngaged) this.updateHandManipulation(x, y, result.pinchDistance);
    else if (!this.gamepadEngaged) this.finishHandDrag();
  }

  private updateEnvironmentDrag(x: number, y: number): void {
    const drag = this.handEnvironmentDrag;
    if (!drag || !this.panorama) return;
    this.panorama.rotation.y = drag.rotationY - (x - drag.x) * 0.004;
    this.panorama.rotation.x = MathUtils.clamp(drag.rotationX - (y - drag.y) * 0.0025, -0.35, 0.35);
  }

  private updateHandManipulation(x: number, y: number, pinchDistance: number | null): void {
    if (this.handScroll) {
      const scroll = this.handScroll;
      const movement = scroll.lastY - y;
      if (Math.abs(movement) >= 2) {
        scroll.window.scrollContent(movement);
        scroll.moved = true;
        scroll.lastY = y;
      }
      return;
    }
    if (this.handDragging) {
      if (this.drag?.action === 'resize' && pinchDistance !== null) this.updateHandPinchResize(pinchDistance);
      else this.updateDrag(x, y, 1);
      return;
    }
    if (this.handEnvironmentDrag) this.updateEnvironmentDrag(x, y);
  }

  private activateHandAt(x: number, y: number, pointerId = -2, event?: PointerEvent): void {
    if (!this.vrActive && this.hooks.activateDomElement(x, y)) return;
    this.activateSpatialAt(x, y, pointerId, event, false);
  }

  private activateSpatialAt(x: number, y: number, pointerId: number, event: PointerEvent | undefined, immediate: boolean): void {
    if (this.drag && !this.handDragging) return;
    this.updateRayAt(x, y);
    if (this.hooks.keyboard.isOpen) {
      const target = this.hooks.keyboard.keyboard.pick(this.raycaster);
      if (target) target.action();
      return;
    }
    if (this.spatialInput.isOpen) {
      const inputHit = this.raycaster.intersectObject(this.spatialInput.surface, false)[0];
      if (inputHit?.uv) this.spatialInput.pointer(inputHit.uv.x, inputHit.uv.y);
      return;
    }
    const objects = [
      ...(this.taskbar.group.visible ? [this.taskbar.surface] : []),
      ...[...this.windows.values()].filter((window) => window.visible).map((window) => window.surface),
    ];
    const hit = this.raycaster.intersectObjects(objects, false).sort((a, b) => a.distance - b.distance)[0];
    if (hit?.object === this.taskbar.surface && hit.uv) {
      const action = this.taskbar.pointer(hit.uv.x, hit.uv.y);
      if (action) this.activateTaskbarAction(action);
      return;
    }
    const picked = this.pickWindow();
    if (!picked) {
      if (immediate) return;
      if (pointerId === -2) {
        if (this.panorama) this.handEnvironmentDrag = { x, y, rotationX: this.panorama.rotation.x, rotationY: this.panorama.rotation.y };
      } else {
        this.lookPointer = { id: pointerId, x, y, yaw: this.yaw, pitch: this.pitch };
      }
      return;
    }
    const { window, uv } = picked;
    this.focusWindow(window.state.id);
    const region = window.hitTest(uv.x, uv.y);
    if (region.action === 'content') {
      if (immediate) {
        const pointerEvent = event ?? new PointerEvent('pointerup', { clientX: x, clientY: y, pointerId, pointerType: 'gamepad', bubbles: true });
        this.activateWindowRegion(window, region, x, y, pointerEvent);
      } else if (pointerId === -2) {
        this.handScroll = {
          window,
          region,
          contentX: region.contentX ?? 0,
          contentY: region.contentY ?? 0,
          y,
          lastY: y,
          moved: false,
        };
      } else {
        this.contentPointer = {
          pointerId,
          window,
          region,
          x,
          y,
          lastY: y,
          moved: false,
        };
      }
      return;
    }
    if (immediate && ['drag', 'rotate', 'roll', 'depth', 'resize'].includes(region.action)) return;
    const pointerEvent = event ?? new PointerEvent('pointerdown', { clientX: x, clientY: y, pointerId: -2, pointerType: 'hand', bubbles: true });
    this.activateWindowRegion(window, region, x, y, pointerEvent);
  }

  private updateVrHandHover(x: number, y: number): void {
    this.updateRayAt(x, y);
    if (this.hooks.keyboard.isOpen) {
      this.clearHoveredWindow();
      this.taskbar.hover(-1, -1);
      const target = this.hooks.keyboard.keyboard.pick(this.raycaster);
      this.hooks.keyboard.keyboard.hoverKey(target?.key ?? null);
      return;
    }
    if (this.spatialInput.isOpen) {
      this.clearHoveredWindow();
      this.taskbar.hover(-1, -1);
      const hit = this.raycaster.intersectObject(this.spatialInput.surface, false)[0];
      const uv = hit?.uv;
      if (uv) this.spatialInput.hover(uv.x, uv.y);
      else this.spatialInput.clearHover();
      return;
    }
    this.spatialInput.clearHover();
    const objects = [
      ...(this.taskbar.group.visible ? [this.taskbar.surface] : []),
      ...[...this.windows.values()].filter((window) => window.visible).map((window) => window.surface),
    ];
    const hit = this.raycaster.intersectObjects(objects, false).sort((a, b) => a.distance - b.distance)[0];
    if (hit?.object === this.taskbar.surface && hit.uv) {
      this.clearHoveredWindow();
      this.taskbar.hover(hit.uv.x, hit.uv.y);
      return;
    }
    this.taskbar.hover(-1, -1);
    const window = hit ? this.windows.get(hit.object.userData.windowId as string) ?? null : null;
    if (this.hoveredWindow !== window) {
      this.clearHoveredWindow();
      this.hoveredWindow = window;
    }
    if (window && hit.uv) window.setHover(window.hitTest(hit.uv.x, hit.uv.y));
  }

  private clearHoveredWindow(): void {
    this.hoveredWindow?.setHover(null);
    this.hoveredWindow = null;
  }

  private activateWindowRegion(window: SpatialWindow, region: WindowHitRegion, x: number, y: number, event: PointerEvent): void {
    if (region.action === 'close') {
      this.closeWindow(window.state.id);
      return;
    }
    if (region.action === 'minimize') {
      uiSound.play('close');
      this.minimizeWindow(window.state.id);
      this.hooks.notify(`${window.definition.name} minimized. Open Window Manager to restore it.`);
      return;
    }
    if (region.action === 'maximize') {
      uiSound.play('toggle');
      if (window.state.pinned) return this.hooks.notify(`${window.definition.name} is pinned. Unpin it to maximize.`);
      this.windowManager.toggleMaximize(window.state.id);
      return;
    }
    if (region.action === 'mode') {
      uiSound.play('toggle');
      if (window.state.pinned) return this.hooks.notify(`${window.definition.name} is pinned. Unpin it to change anchoring.`);
      const mode = this.cycleWindowMode(window.state.id);
      if (mode) this.hooks.notify(`${window.definition.name}: ${mode} mode.`);
      return;
    }
    if (region.action === 'anchor') {
      uiSound.play('toggle');
      this.toggleWindowAnchor(window.state.id);
      return;
    }
    if (region.action === 'content') {
      window.pointer(region.contentX ?? 0, region.contentY ?? 0, event);
      return;
    }
    this.startWindowDrag(window, region.action, x, y, event.pointerId);
  }

  private startWindowDrag(window: SpatialWindow, action: WindowHitRegion['action'], x: number, y: number, pointerId: number): void {
    if (pointerId === -1 || this.hooks.keyboard.isOpen || this.spatialInput.isOpen) return;
    uiSound.play('move');
    const kind = action === 'rotate' || action === 'roll' ? 'rotate' : action === 'depth' ? 'depth' : action === 'resize' ? 'resize' : 'move';
    if (!this.windowManager.beginManipulation(window.state.id, kind)) {
      if (window.state.pinned) this.hooks.notify(`${window.definition.name} is pinned. Unpin it to move or resize it.`);
      return;
    }
    const normal = this.camera.getWorldDirection(new Vector3());
    const plane = new Plane().setFromNormalAndCoplanarPoint(normal, window.group.position);
    const intersection = this.raycaster.ray.intersectPlane(plane, new Vector3()) ?? window.group.position.clone();
    this.drag = {
      pointerId,
      window,
      action,
      start: new Vector2(x, y),
      plane,
      offset: window.group.position.clone().sub(intersection),
      startPosition: new Vector3(window.state.position.x, window.state.position.y, window.state.position.z),
      startSize: { ...window.state.size },
      startRotation: { x: window.state.rotation.x, y: window.state.rotation.y },
      lastUpdate: performance.now(),
    };
    if (pointerId === -2) this.handDragging = true;
  }

  private updateDrag(x: number, y: number, pointerCount: number): void {
    const drag = this.drag;
    if (!drag || drag.window.state.pinned) return;
    uiSound.play('move');
    const now = performance.now();
    const dt = MathUtils.clamp((now - drag.lastUpdate) / 1000, 1 / 240, 0.1);
    drag.lastUpdate = now;
    const dx = x - drag.start.x;
    const dy = y - drag.start.y;
    if (pointerCount >= 2 && drag.startPinchDistance) {
      const points = [...this.pointers.values()];
      const distance = points[0].distanceTo(points[1]);
      const ratio = MathUtils.clamp(distance / drag.startPinchDistance, 0.55, 1.8);
      this.windowManager.applyManipulation({
        width: drag.startSize.width * ratio - drag.window.state.size.width,
        height: drag.startSize.height * ratio - drag.window.state.size.height,
        uniform: true,
        dt,
      });
    } else if (drag.action === 'resize') {
      this.windowManager.applyManipulation({
        width: drag.startSize.width + dx * 0.012 - drag.window.state.size.width,
        height: drag.startSize.height - dy * 0.009 - drag.window.state.size.height,
        dt,
      });
    } else if (drag.action === 'rotate') {
      this.windowManager.applyManipulation({ rotation: {
        x: drag.startRotation.x + dy * 0.006 - drag.window.state.rotation.x,
        y: drag.startRotation.y + dx * 0.006 - drag.window.state.rotation.y,
        z: 0,
      }, dt });
    } else if (drag.action === 'roll') {
      this.windowManager.applyManipulation({ roll: -dy * 0.008, dt });
    } else if (drag.action === 'depth') {
      this.windowManager.applyManipulation({ depth: drag.startPosition.z + (drag.start.y - y) * 0.012 - drag.window.state.position.z, dt });
    } else {
      this.updateRayAt(x, y);
      const intersection = this.raycaster.ray.intersectPlane(drag.plane, new Vector3());
      if (!intersection) return;
      intersection.add(drag.offset);
      if (drag.window.state.mode === 'head') intersection.sub(this.camera.position).applyQuaternion(this.camera.quaternion.clone().invert());
      this.windowManager.applyManipulation({ translation: {
        x: intersection.x - drag.window.state.position.x,
        y: intersection.y - drag.window.state.position.y,
        z: intersection.z - drag.window.state.position.z,
      }, dt });
    }
  }

  private updateHandPinchResize(distance: number): void {
    const drag = this.drag;
    if (!drag || drag.action !== 'resize' || drag.window.state.pinned) return;
    const now = performance.now();
    const dt = MathUtils.clamp((now - drag.lastUpdate) / 1000, 1 / 240, 0.1);
    drag.lastUpdate = now;
    const startDistance = drag.startPinchDistance ?? drag.handPinchDistance;
    if (!startDistance || startDistance < 0.001) return;
    const ratio = MathUtils.clamp(distance / startDistance, 0.55, 1.8);
    const width = drag.startPinchDistance ? drag.startSize.width * ratio : drag.window.state.size.width * ratio;
    const height = drag.startPinchDistance ? drag.startSize.height * ratio : drag.window.state.size.height * ratio;
    this.windowManager.applyManipulation({
      width: width - drag.window.state.size.width,
      height: height - drag.window.state.size.height,
      uniform: true,
      dt,
    });
    drag.handPinchDistance = distance;
  }

  private finishHandDrag(activateContent = true): void {
    const pendingContent = this.handScroll;
    this.handDragging = false;
    this.twoHandResizing = false;
    this.handEnvironmentDrag = null;
    this.handScroll = null;
    if (this.drag?.pointerId === -2) this.endWindowDrag();
    if (activateContent && pendingContent && !pendingContent.moved) {
      const event = new PointerEvent('pointerup', {
        clientX: pendingContent.contentX,
        clientY: pendingContent.contentY,
        pointerId: -2,
        pointerType: 'hand',
        bubbles: true,
      });
      this.activateWindowRegion(pendingContent.window, pendingContent.region, pendingContent.contentX, pendingContent.contentY, event);
    }
  }

  private endWindowDrag(): void {
    if (!this.drag) return;
    const handDrag = this.drag.pointerId === -2;
    this.drag = null;
    this.windowManager.endManipulation(!handDrag);
    this.emitWindowsChanged();
  }

  private updateRay(event: PointerEvent | WheelEvent): void {
    this.updateRayAt(event.clientX, event.clientY);
  }

  private updateRayAt(x: number, y: number): void {
    const bounds = this.canvas.getBoundingClientRect();
    const localX = Math.max(0, Math.min(bounds.width, x - bounds.left));
    const localY = Math.max(0, Math.min(bounds.height, y - bounds.top));
    this.pointerNdc.set((localX / bounds.width) * 2 - 1, -(localY / bounds.height) * 2 + 1);
    if (!this.vrActive) {
      this.raycaster.setFromCamera(this.pointerNdc, this.camera);
      return;
    }
    const eyeWidth = bounds.width / 2;
    const rightEye = localX >= eyeWidth;
    const eye = undoLensDistortion(
      rightEye ? (localX - eyeWidth) / eyeWidth : localX / eyeWidth,
      localY / bounds.height,
      this.settings.distortion,
    );
    const pointer = rightEye ? this.pointerNdcRight : this.pointerNdc;
    pointer.set(eye.u * 2 - 1, -(eye.v * 2 - 1));
    this.raycaster.setFromCamera(pointer, rightEye ? this.stereo.rightCamera : this.stereo.leftCamera);
  }

  private pickWindow(): { window: SpatialWindow; uv: Vector2 } | null {
    const surfaces = [...this.windows.values()].filter((window) => window.visible).map((window) => window.surface).sort((a, b) => b.renderOrder - a.renderOrder);
    const hit = this.raycaster.intersectObjects(surfaces).sort((a, b) => a.distance - b.distance)[0];
    if (!hit?.uv) return null;
    const window = this.windows.get(hit.object.userData.windowId as string);
    return window ? { window, uv: hit.uv.clone() } : null;
  }

  private handlePointerDown = (event: PointerEvent): void => {
    if (this.vrActive) {
      if (event.button !== 0 && event.pointerType === 'mouse') return;
      this.canvas.setPointerCapture(event.pointerId);
      this.vrPointer = { id: event.pointerId, x: event.clientX, y: event.clientY };
      this.activateHandAt(event.clientX, event.clientY, event.pointerId, event);
      return;
    }
    if (this.handDragging) return;
    this.canvas.setPointerCapture(event.pointerId);
    this.pointers.set(event.pointerId, new Vector2(event.clientX, event.clientY));
    if (this.drag && this.pointers.size === 2) {
      const points = [...this.pointers.values()];
      this.drag.startPinchDistance = Math.max(1, points[0].distanceTo(points[1]));
      this.drag.action = 'resize';
      this.contentPointer = null;
      return;
    }
    if (this.contentPointer && this.pointers.size === 2) {
      const points = [...this.pointers.values()];
      const midpoint = points[0].clone().add(points[1]).multiplyScalar(0.5);
      this.startWindowDrag(this.contentPointer.window, 'resize', midpoint.x, midpoint.y, this.contentPointer.pointerId);
      if (this.drag) this.drag.startPinchDistance = Math.max(1, points[0].distanceTo(points[1]));
      this.contentPointer = null;
      return;
    }
    this.updateRay(event);
    if (this.hooks.keyboard.isOpen) {
      const target = this.hooks.keyboard.keyboard.pick(this.raycaster);
      if (target) target.action();
      return;
    }
    const picked = this.pickWindow();
    if (!picked) {
      this.lookPointer = { id: event.pointerId, x: event.clientX, y: event.clientY, yaw: this.yaw, pitch: this.pitch };
      return;
    }
    const { window, uv } = picked;
    this.focusWindow(window.state.id);
    const region = window.hitTest(uv.x, uv.y);
    if (region.action === 'content') {
      this.contentPointer = {
        pointerId: event.pointerId,
        window,
        region,
        x: event.clientX,
        y: event.clientY,
        lastY: event.clientY,
        moved: false,
      };
      return;
    }
    this.activateWindowRegion(window, region, event.clientX, event.clientY, event);
  };

  private handlePointerMove = (event: PointerEvent): void => {
    if (this.vrActive) {
      if (this.vrPointer?.id !== event.pointerId) return;
      this.vrPointer.x = event.clientX;
      this.vrPointer.y = event.clientY;
      this.updateVrHandHover(event.clientX, event.clientY);
      if (this.lookPointer?.id === event.pointerId) {
        this.yaw = this.lookPointer.yaw - (event.clientX - this.lookPointer.x) * 0.004;
        this.pitch = MathUtils.clamp(this.lookPointer.pitch - (event.clientY - this.lookPointer.y) * 0.004, -1.25, 1.25);
        return;
      }
      if (this.contentPointer?.pointerId === event.pointerId) {
        const movement = this.contentPointer.lastY - event.clientY;
        if (Math.abs(movement) >= 2) {
          this.contentPointer.window.scrollContent(movement);
          this.contentPointer.lastY = event.clientY;
          this.contentPointer.moved = true;
        }
        return;
      }
      if (this.drag?.pointerId === event.pointerId) this.updateDrag(event.clientX, event.clientY, 1);
      return;
    }
    if (this.pointers.has(event.pointerId)) this.pointers.set(event.pointerId, new Vector2(event.clientX, event.clientY));
    if (this.lookPointer?.id === event.pointerId) {
      this.yaw = this.lookPointer.yaw - (event.clientX - this.lookPointer.x) * 0.004;
      this.pitch = MathUtils.clamp(this.lookPointer.pitch - (event.clientY - this.lookPointer.y) * 0.004, -1.25, 1.25);
      return;
    }
    if (this.pointers.size >= 2 && this.drag?.action === 'resize' && this.drag.startPinchDistance) {
      this.updateDrag(event.clientX, event.clientY, this.pointers.size);
      return;
    }
    if (this.contentPointer?.pointerId === event.pointerId && this.pointers.size === 1) {
      const movement = this.contentPointer.lastY - event.clientY;
      if (Math.abs(movement) >= 2) {
        this.contentPointer.window.scrollContent(movement);
        this.contentPointer.lastY = event.clientY;
        this.contentPointer.moved = true;
      }
      return;
    }
    if (!this.drag || this.drag.pointerId !== event.pointerId) return;
    this.updateDrag(event.clientX, event.clientY, this.pointers.size);
  };

  private handlePointerUp = (event: PointerEvent): void => {
    if (this.vrActive) {
      if (this.vrPointer?.id !== event.pointerId) return;
      const pendingContent = this.contentPointer;
      this.vrPointer = null;
      if (event.type === 'pointerup' && pendingContent?.pointerId === event.pointerId && !pendingContent.moved) {
        this.activateWindowRegion(pendingContent.window, pendingContent.region, pendingContent.x, pendingContent.y, event);
      }
      if (pendingContent?.pointerId === event.pointerId) this.contentPointer = null;
      if (this.drag?.pointerId === event.pointerId) this.endWindowDrag();
      if (this.lookPointer?.id === event.pointerId) this.lookPointer = null;
      if (this.canvas.hasPointerCapture(event.pointerId)) this.canvas.releasePointerCapture(event.pointerId);
      return;
    }
    const pendingContent = this.contentPointer;
    const wasPinching = this.pointers.size > 1;
    this.pointers.delete(event.pointerId);
    if (event.type === 'pointerup' && pendingContent?.pointerId === event.pointerId && !wasPinching && !pendingContent.moved) {
      this.activateWindowRegion(pendingContent.window, pendingContent.region, pendingContent.x, pendingContent.y, event);
    }
    if (pendingContent?.pointerId === event.pointerId) this.contentPointer = null;
    if (this.drag?.pointerId === event.pointerId) this.endWindowDrag();
    if (this.lookPointer?.id === event.pointerId) this.lookPointer = null;
    if (this.canvas.hasPointerCapture(event.pointerId)) this.canvas.releasePointerCapture(event.pointerId);
  };

  private handleWheel = (event: WheelEvent): void => {
    if (this.vrActive) return;
    this.updateRay(event);
    const picked = this.pickWindow();
    if (!picked) return;
    event.preventDefault();
    uiSound.play('move');
    this.focusWindow(picked.window.state.id);
    if (picked.window.hitTest(picked.uv.x, picked.uv.y).action === 'content') {
      picked.window.scrollContent(event.deltaY);
      return;
    }
    if (picked.window.state.pinned) {
      this.hooks.notify(`${picked.window.definition.name} is pinned. Unpin it to change its depth.`);
      return;
    }
    if (!this.windowManager.beginManipulation(picked.window.state.id, 'depth')) return;
    this.windowManager.applyManipulation({ depth: event.deltaY * 0.004, dt: 1 / 30 });
    this.windowManager.endManipulation();
  };

  private preventContextMenu = (event: Event): void => event.preventDefault();
}

export function overlayTransformMatrix(points: Array<{ x: number; y: number }>, width: number, height: number): number[] {
  const matrix = homographyMatrix(points);
  matrix[0] /= width;
  matrix[1] /= width;
  matrix[3] /= width;
  matrix[4] /= height;
  matrix[5] /= height;
  matrix[7] /= height;
  return matrix;
}

function homographyMatrix(points: Array<{ x: number; y: number }>): number[] {
  const [p0, p1, p2, p3] = points;
  const dx1 = p1.x - p2.x;
  const dx2 = p3.x - p2.x;
  const dx3 = p0.x - p1.x + p2.x - p3.x;
  const dy1 = p1.y - p2.y;
  const dy2 = p3.y - p2.y;
  const dy3 = p0.y - p1.y + p2.y - p3.y;
  const determinant = dx1 * dy2 - dx2 * dy1;
  if (Math.abs(determinant) < 0.00001) return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const g = (dx3 * dy2 - dx2 * dy3) / determinant;
  const h = (dx1 * dy3 - dx3 * dy1) / determinant;
  const a = p1.x - p0.x + g * p1.x;
  const b = p3.x - p0.x + h * p3.x;
  const d = p1.y - p0.y + g * p1.y;
  const e = p3.y - p0.y + h * p3.y;
  return [a, d, 0, g, b, e, 0, h, 0, 0, 1, 0, p0.x, p0.y, 0, 1];
}
