import {
  CanvasTexture,
  DoubleSide,
  Group,
  LinearFilter,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  Quaternion,
  SRGBColorSpace,
} from 'three';
import { fillRoundedRect, roundedRect } from './canvasUi';

const WIDTH = 1024;
const HEIGHT = 160;

export class SpatialNotification {
  readonly group = new Group();
  private readonly canvas = document.createElement('canvas');
  private readonly context: CanvasRenderingContext2D;
  private readonly texture: CanvasTexture;
  private readonly surface: Mesh<PlaneGeometry, MeshBasicMaterial>;
  private message = '';
  private startedAt = 0;
  private duration = 4200;
  private dirty = true;
  private interfaceAccent = '#75e7ff';

  constructor() {
    this.canvas.width = WIDTH;
    this.canvas.height = HEIGHT;
    const context = this.canvas.getContext('2d');
    if (!context) throw new Error('Canvas 2D is unavailable for spatial notifications.');
    this.context = context;
    this.texture = new CanvasTexture(this.canvas);
    this.texture.colorSpace = SRGBColorSpace;
    this.texture.minFilter = LinearFilter;
    this.texture.magFilter = LinearFilter;
    this.texture.generateMipmaps = false;
    this.surface = new Mesh(
      new PlaneGeometry(4.1, HEIGHT / WIDTH * 4.1),
      new MeshBasicMaterial({ map: this.texture, transparent: true, depthTest: false, depthWrite: false, side: DoubleSide, toneMapped: false }),
    );
    this.surface.renderOrder = 1_500_000;
    this.group.add(this.surface);
    this.group.visible = false;
  }

  show(message: string): void {
    this.message = message.trim().slice(0, 240);
    if (!this.message) return;
    this.startedAt = performance.now();
    this.group.visible = true;
    this.surface.material.opacity = 1;
    this.dirty = true;
    this.render();
  }

  update(cameraQuaternion: Quaternion, distanceScale: number, time: number): void {
    if (!this.group.visible) return;
    this.group.position.set(0, -0.62, -5.3 * distanceScale).applyQuaternion(cameraQuaternion);
    this.group.quaternion.copy(cameraQuaternion);
    const remaining = this.duration - (time - this.startedAt);
    if (remaining <= 0) {
      this.group.visible = false;
      return;
    }
    this.surface.material.opacity = Math.min(1, remaining / 650);
    if (this.dirty || remaining < 650) this.render();
  }

  hide(): void {
    this.group.visible = false;
  }

  destroy(): void {
    this.hide();
    this.surface.geometry.dispose();
    this.surface.material.dispose();
    this.texture.dispose();
    this.group.removeFromParent();
  }

  setInterfacePalette(accent: string): void {
    if (accent === this.interfaceAccent) return;
    this.interfaceAccent = accent;
    this.dirty = true;
    if (this.group.visible) this.render();
  }

  private render(): void {
    const context = this.context;
    context.clearRect(0, 0, WIDTH, HEIGHT);
    fillRoundedRect(context, 4, 4, WIDTH - 8, HEIGHT - 8, 36, 'rgba(15,19,26,0.91)');
    roundedRect(context, 4, 4, WIDTH - 8, HEIGHT - 8, 36);
    context.strokeStyle = 'rgba(255,255,255,0.32)';
    context.lineWidth = 2;
    context.stroke();
    context.fillStyle = this.interfaceAccent;
    context.beginPath();
    context.arc(55, HEIGHT / 2, 10, 0, Math.PI * 2);
    context.fill();
    context.fillStyle = '#f0f6fc';
    context.font = '600 25px -apple-system, BlinkMacSystemFont, sans-serif';
    context.textBaseline = 'middle';
    context.fillText(this.message, 88, HEIGHT / 2, WIDTH - 120);
    this.texture.needsUpdate = true;
    this.dirty = false;
  }
}
