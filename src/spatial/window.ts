import {
  CanvasTexture,
  Color,
  DoubleSide,
  Euler,
  Group,
  LinearFilter,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  Quaternion,
  ShaderMaterial,
  SRGBColorSpace,
  Vector3,
} from 'three';
import type {
  ApplicationContext,
  ApplicationDefinition,
  ApplicationInstance,
  AppSettings,
  OverlayRect,
  SpatialWindowApi,
  StoredFile,
  WindowHitRegion,
  WindowMode,
  WindowPoseState,
  WindowState,
} from '../types';
import { getInterfacePalette } from '../core/theme';
import { drawWindowChrome, windowHitRegion, WINDOW_CHROME_HEIGHT } from './canvasUi';
import { nextWindowMode } from './windowState';

export interface SpatialWindowControls {
  minimize: (id: string) => boolean;
  toggleMaximize: (id: string) => boolean;
  cycleMode: (id: string) => WindowMode | undefined;
  toggleAnchor: (id: string) => boolean;
  moveDepth: (id: string, delta: number) => boolean;
  setPose: (id: string, pose: WindowPoseState) => boolean;
  roll: (id: string, delta: number) => boolean;
}

export type WindowHooks = Omit<ApplicationContext, 'window'> & { controls?: SpatialWindowControls };

export class SpatialWindow {
  readonly group = new Group();
  readonly surface: Mesh<PlaneGeometry, MeshBasicMaterial>;
  readonly canvas = document.createElement('canvas');
  readonly context: CanvasRenderingContext2D;
  readonly texture: CanvasTexture;
  readonly instance: ApplicationInstance;
  readonly api: SpatialWindowApi;
  overlay: HTMLElement | null = null;
  overlayRect: OverlayRect = { x: 0, y: WINDOW_CHROME_HEIGHT, width: this.canvas.width, height: this.canvas.height - WINDOW_CHROME_HEIGHT };

  private readonly frame: Mesh<PlaneGeometry, ShaderMaterial>;
  private readonly localQuaternion = new Quaternion();
  private readonly localEuler = new Euler();
  private readonly targetQuaternion = new Quaternion();
  private readonly targetPosition = new Vector3();
  private dirty = true;
  private glassTransparency = 0.78;
  private interfaceAccent = '#75e7ff';
  private hoveredAction: WindowHitRegion['action'] | null = null;

  constructor(readonly state: WindowState, readonly definition: ApplicationDefinition, private readonly hooks: WindowHooks, domLayer: HTMLElement) {
    this.canvas.width = 1024;
    this.canvas.height = 640;
    const context = this.canvas.getContext('2d', { alpha: true });
    if (!context) throw new Error('Canvas 2D is unavailable.');
    this.context = context;
    this.glassTransparency = hooks.getSettings().glassTransparency;
    this.interfaceAccent = getInterfacePalette(hooks.getSettings().palette).accent;
    const initialPose = this.normalizedPose(this.currentPose());
    if (initialPose) this.writePose(initialPose);
    if (state.restore) state.restore = this.normalizedPose(state.restore) ?? undefined;
    this.texture = new CanvasTexture(this.canvas);
    this.texture.colorSpace = SRGBColorSpace;
    this.texture.minFilter = LinearFilter;
    this.texture.magFilter = LinearFilter;
    this.texture.generateMipmaps = false;

    this.frame = new Mesh(
      new PlaneGeometry(1.055, 1.055),
      new ShaderMaterial({
        transparent: true,
        depthWrite: false,
        side: DoubleSide,
        toneMapped: false,
        uniforms: {
          accent: { value: new Color(this.interfaceAccent) },
          time: { value: 0 },
          transparency: { value: this.glassTransparency },
        },
        vertexShader: `
          varying vec2 vUv;
          void main() {
            vUv = uv;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }
        `,
        fragmentShader: `
          precision mediump float;
          varying vec2 vUv;
          uniform vec3 accent;
          uniform float time;
          uniform float transparency;
          float roundedBox(vec2 p, vec2 b, float r) {
            vec2 q = abs(p) - b + r;
            return min(max(q.x, q.y), 0.0) + length(max(q, 0.0)) - r;
          }
          void main() {
            vec2 p = (vUv - 0.5) * 2.0;
            float distanceToEdge = roundedBox(p, vec2(0.955), 0.12);
            float mask = 1.0 - smoothstep(-0.014, 0.014, distanceToEdge);
            float rim = 1.0 - smoothstep(0.0, 0.07, abs(distanceToEdge));
            float innerRim = 1.0 - smoothstep(0.018, 0.055, abs(distanceToEdge + 0.028));
            float sweepPosition = p.x + p.y * 0.42 - sin(time * 0.28) * 0.7;
            float sweep = pow(max(0.0, 1.0 - abs(sweepPosition) * 3.4), 4.0);
            float fresnel = pow(rim, 1.6);
            vec3 neutral = vec3(0.96);
            vec3 color = mix(neutral, accent, 0.035 + fresnel * 0.08);
            color += vec3(sweep * 0.16 + innerRim * 0.08);
            float alpha = 0.012 + rim * (0.22 + (1.0 - transparency) * 0.34) + innerRim * 0.06 + sweep * 0.035;
            gl_FragColor = vec4(color, mask * alpha);
          }
        `,
      }),
    );
    this.frame.position.z = -0.012;
    this.surface = new Mesh(
      new PlaneGeometry(1, 1),
      new MeshBasicMaterial({ map: this.texture, transparent: true, side: DoubleSide, depthWrite: false }),
    );
    this.surface.userData.windowId = state.id;
    this.group.add(this.frame, this.surface);
    this.group.scale.set(state.size.width, state.size.height, 1);

    this.api = {
      id: state.id,
      state,
      canvas: this.canvas,
      context: this.context,
      requestRender: () => this.requestRender(),
      close: () => hooks.closeWindow(state.id),
      minimize: () => {
        if (hooks.controls) hooks.controls.minimize(state.id);
        else this.minimize();
      },
      maximize: () => {
        if (hooks.controls) hooks.controls.toggleMaximize(state.id);
        else this.maximize();
      },
      cycleMode: () => {
        if (hooks.controls) hooks.controls.cycleMode(state.id);
        else this.cycleMode();
      },
      toggleAnchor: () => hooks.controls ? hooks.controls.toggleAnchor(state.id) : this.toggleAnchor(),
      moveDepth: (delta) => {
        if (hooks.controls) hooks.controls.moveDepth(state.id, delta);
        else this.moveDepth(delta);
      },
      setPose: (pose) => hooks.controls ? hooks.controls.setPose(state.id, pose) : this.setPose(pose),
      roll: (delta) => hooks.controls ? hooks.controls.roll(state.id, delta) : this.roll(delta),
      setTitle: (title) => {
        state.title = title.slice(0, 80);
        this.dirty = true;
      },
      setOverlay: (element, rect) => {
        if (this.overlay && this.overlay !== element) this.overlay.remove();
        this.overlay = element;
        if (element) {
          if (element.parentElement !== domLayer) domLayer.append(element);
          this.overlayRect = rect ?? { x: 0, y: WINDOW_CHROME_HEIGHT, width: this.canvas.width, height: this.canvas.height - WINDOW_CHROME_HEIGHT };
        }
        this.dirty = true;
      },
    };

    const applicationContext: ApplicationContext = { ...hooks, window: this.api };
    this.instance = definition.create(applicationContext);
    if (state.appState !== undefined) this.instance.restore?.(state.appState);
    this.updateTransform(new Vector3(), new Quaternion(), false);
  }

  get visible(): boolean {
    return !this.state.minimized;
  }

  requestRender(): void {
    const appState = this.instance?.serialize?.();
    if (appState !== undefined) this.state.appState = appState;
    this.dirty = true;
  }

  updateTransform(cameraPosition: Vector3, cameraQuaternion: Quaternion, vrActive: boolean): void {
    this.targetPosition.set(this.state.position.x, this.state.position.y, this.state.position.z);
    this.localQuaternion.set(this.state.quaternion.x, this.state.quaternion.y, this.state.quaternion.z, this.state.quaternion.w).normalize();
    this.targetQuaternion.copy(this.localQuaternion);
    if (this.state.mode === 'head') {
      this.targetPosition.applyQuaternion(cameraQuaternion).add(cameraPosition);
      this.targetQuaternion.premultiply(cameraQuaternion);
    } else if (this.state.mode === 'individual') {
      this.targetQuaternion.premultiply(cameraQuaternion);
    }
    this.group.position.copy(this.targetPosition);
    this.group.quaternion.copy(this.targetQuaternion);
    this.group.scale.set(this.state.size.width, this.state.size.height, 1);
    this.group.visible = !this.state.minimized;
    if (vrActive && this.state.mode === 'world') this.group.updateMatrixWorld();
  }

  render(time: number, force = false): void {
    if (!this.visible) return;
    if (!force && !this.dirty) return;
    const { context, canvas } = this;
    context.clearRect(0, 0, canvas.width, canvas.height);
    drawWindowChrome(context, canvas.width, canvas.height, this.state, this.definition.color, this.glassTransparency, this.hoveredAction ?? undefined, this.interfaceAccent);
    context.save();
    context.globalAlpha = 0.98 - this.glassTransparency * 0.48;
    context.beginPath();
    context.rect(0, WINDOW_CHROME_HEIGHT, canvas.width, canvas.height - WINDOW_CHROME_HEIGHT);
    context.clip();
    context.translate(0, WINDOW_CHROME_HEIGHT);
    this.instance.render(context, canvas.width, canvas.height - WINDOW_CHROME_HEIGHT, time);
    context.restore();
    this.frame.material.uniforms.time.value = time / 1000;
    this.texture.needsUpdate = true;
    this.dirty = false;
  }

  update(delta: number, time: number): void {
    this.instance.update?.(delta, time);
  }

  hitTest(u: number, v: number): WindowHitRegion {
    return windowHitRegion(u, v, this.canvas.width, this.canvas.height);
  }

  setHover(region: WindowHitRegion | null): void {
    const action = region?.action === 'content' ? null : region?.action ?? null;
    if (action === this.hoveredAction) return;
    this.hoveredAction = action;
    this.dirty = true;
  }

  pointer(x: number, y: number, event: PointerEvent | MouseEvent): boolean {
    const handled = this.instance.pointer?.(x, y, event) ?? false;
    if (handled) this.dirty = true;
    return handled;
  }

  scrollContent(deltaY: number): boolean {
    const handled = this.instance.scroll?.(deltaY) ?? false;
    if (handled) this.dirty = true;
    return handled;
  }

  openKeyboard(): boolean {
    if (!this.instance.openKeyboard) return false;
    this.instance.openKeyboard();
    this.dirty = true;
    return true;
  }

  focus(): void {
    this.surface.renderOrder = this.state.z;
    this.frame.renderOrder = this.state.z - 0.1;
  }

  setGlassTransparency(value: number): void {
    this.glassTransparency = value;
    this.frame.material.uniforms.transparency.value = value;
    this.dirty = true;
  }

  setInterfacePalette(value: AppSettings['palette']): void {
    this.interfaceAccent = getInterfacePalette(value).accent;
    this.frame.material.uniforms.accent.value.set(this.interfaceAccent);
    this.dirty = true;
  }

  openFile(record: StoredFile): void {
    void this.instance.openFile?.(record);
  }

  minimize(): void {
    this.state.minimized = true;
    this.group.visible = false;
    this.requestRender();
  }

  restore(): void {
    this.state.minimized = false;
    this.group.visible = true;
    this.requestRender();
  }

  maximize(): void {
    if (this.state.pinned) return;
    if (this.state.maximized) {
      if (this.state.restore) this.writePose(this.state.restore);
      this.state.maximized = false;
      this.state.restore = undefined;
    } else {
      this.state.restore = this.currentPose();
      this.writePose({
        position: { x: 0, y: 0, z: -6 },
        quaternion: { x: 0, y: 0, z: 0, w: 1 },
        size: { width: 5.6, height: 3.5 },
      });
      this.state.maximized = true;
    }
    this.requestRender();
  }

  cycleMode(): void {
    if (this.state.pinned) return;
    this.state.mode = nextWindowMode(this.state.mode);
    this.state.anchor = undefined;
    this.state.anchorKind = undefined;
    this.requestRender();
  }

  toggleAnchor(): boolean {
    const anchored = this.hooks.toggleWindowAnchor(this.state.id);
    this.dirty = true;
    return anchored;
  }

  moveDepth(delta: number): void {
    if (!Number.isFinite(delta)) return;
    this.hooks.moveWindowDepth(this.state.id, delta);
    this.dirty = true;
  }

  setPose(pose: WindowPoseState): boolean {
    const normalized = this.normalizedPose(pose);
    if (!normalized || this.state.pinned) return false;
    this.writePose(normalized);
    this.state.anchor = undefined;
    this.state.anchorKind = undefined;
    this.requestRender();
    return true;
  }

  roll(delta: number): boolean {
    if (!Number.isFinite(delta) || this.state.pinned) return false;
    const pose = this.currentPose();
    const orientation = new Quaternion(pose.quaternion.x, pose.quaternion.y, pose.quaternion.z, pose.quaternion.w)
      .normalize()
      .multiply(new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), delta));
    return this.setPose({
      position: pose.position,
      quaternion: { x: orientation.x, y: orientation.y, z: orientation.z, w: orientation.w },
      size: pose.size,
    });
  }

  togglePin(): boolean {
    this.state.pinned = !this.state.pinned;
    if (this.state.pinned) {
      this.state.position = { x: this.group.position.x, y: this.group.position.y, z: this.group.position.z };
      this.group.quaternion.normalize();
      this.state.quaternion = { x: this.group.quaternion.x, y: this.group.quaternion.y, z: this.group.quaternion.z, w: this.group.quaternion.w };
      this.localEuler.setFromQuaternion(this.group.quaternion, 'YXZ');
      this.state.rotation = { x: this.localEuler.x, y: this.localEuler.y, z: this.localEuler.z };
      this.state.mode = 'world';
      this.state.anchor = undefined;
      this.state.anchorKind = undefined;
      this.state.maximized = false;
      this.state.restore = undefined;
    }
    this.requestRender();
    return this.state.pinned;
  }

  private currentPose(): WindowPoseState {
    return {
      position: { ...this.state.position },
      quaternion: { ...this.state.quaternion },
      size: { ...this.state.size },
    };
  }

  private normalizedPose(pose: WindowPoseState): WindowPoseState | null {
    if (!pose || !pose.position || !pose.size || !pose.quaternion) return null;
    if (![pose.position.x, pose.position.y, pose.position.z, pose.size.width, pose.size.height].every(Number.isFinite)) return null;
    if (pose.size.width <= 0 || pose.size.height <= 0) return null;
    const length = Math.hypot(pose.quaternion.x, pose.quaternion.y, pose.quaternion.z, pose.quaternion.w);
    if (!Number.isFinite(length) || length < 0.0001) return null;
    const sign = pose.quaternion.w < 0 ? -1 : 1;
    return {
      position: { ...pose.position },
      quaternion: {
        x: pose.quaternion.x / length * sign,
        y: pose.quaternion.y / length * sign,
        z: pose.quaternion.z / length * sign,
        w: pose.quaternion.w / length * sign,
      },
      size: { ...pose.size },
    };
  }

  private writePose(pose: WindowPoseState): void {
    this.state.position = { ...pose.position };
    this.state.quaternion = { ...pose.quaternion };
    this.localEuler.setFromQuaternion(new Quaternion(pose.quaternion.x, pose.quaternion.y, pose.quaternion.z, pose.quaternion.w), 'YXZ');
    this.state.rotation = { x: this.localEuler.x, y: this.localEuler.y, z: this.localEuler.z };
    this.state.size = { ...pose.size };
    this.state.schemaVersion = 2;
  }

  destroy(): void {
    this.instance.destroy?.();
    this.overlay?.remove();
    this.texture.dispose();
    this.surface.geometry.dispose();
    this.surface.material.dispose();
    this.frame.geometry.dispose();
    this.frame.material.dispose();
    this.group.removeFromParent();
  }
}
