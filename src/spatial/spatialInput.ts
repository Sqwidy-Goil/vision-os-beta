import { CanvasTexture, DoubleSide, Group, LinearFilter, Mesh, MeshBasicMaterial, PlaneGeometry, Quaternion, SRGBColorSpace } from 'three';
import { applyKeyboardCase, backspaceText, replaceTextSelection, type TextSelection } from '../core/virtualKeyboard';
import { uiSound } from '../core/uiSound';
import type { TextRequestOptions } from '../types';
import { fillRoundedRect, roundedRect } from './canvasUi';

type SpatialTextRequest = TextRequestOptions & {
  resolve: (value: string | null) => void;
};

interface KeyRegion {
  x: number;
  y: number;
  width: number;
  height: number;
  key: string;
  character?: string;
}

export interface SpatialInputTarget {
  key: string;
  action: () => void;
}

const WIDTH = 1400;
const HEIGHT = 900;
const KEY_ROWS = [
  ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'],
  ['q', 'w', 'e', 'r', 't', 'y', 'u', 'i', 'o', 'p'],
  ['a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l'],
  ['shift', 'z', 'x', 'c', 'v', 'b', 'n', 'm', 'backspace'],
  ['-', '=', '/', '.', ':'],
  ['caps', 'space', 'enter'],
];
const SYMBOLS: Record<string, string> = {
  '1': '!', '2': '@', '3': '#', '4': '$', '5': '%', '6': '^', '7': '&', '8': '*', '9': '(', '0': ')',
  '-': '_', '=': '+', '/': '?', '.': ',',
};

export class SpatialInput {
  readonly group = new Group();
  readonly surface: Mesh<PlaneGeometry, MeshBasicMaterial>;
  private readonly canvas = document.createElement('canvas');
  private readonly context: CanvasRenderingContext2D;
  private readonly texture: CanvasTexture;
  private readonly promptRegion = { x: 40, y: 142, width: WIDTH - 80, height: 116 };
  private readonly panelRegion = { x: 40, y: 142, width: WIDTH - 80, height: 620 };
  private request: SpatialTextRequest | null = null;
  private physicalSelection: { start: number; end: number } | null = null;
  private value = '';
  private displayStart = 0;
  private selection: TextSelection = { start: 0, end: 0 };
  private shifted = false;
  private capsLocked = false;
  private regions: KeyRegion[] = [];
  private hovered: string | null = null;
  private dirty = true;
  private interfaceAccent = '#75e7ff';

  constructor() {
    this.canvas.width = WIDTH;
    this.canvas.height = HEIGHT;
    const context = this.canvas.getContext('2d');
    if (!context) throw new Error('Canvas 2D is unavailable for spatial text input.');
    this.context = context;
    this.texture = new CanvasTexture(this.canvas);
    this.texture.colorSpace = SRGBColorSpace;
    this.texture.minFilter = LinearFilter;
    this.texture.magFilter = LinearFilter;
    this.texture.generateMipmaps = false;
    this.surface = new Mesh(
      new PlaneGeometry(2.9, 2.9 * HEIGHT / WIDTH),
      new MeshBasicMaterial({ map: this.texture, transparent: true, side: DoubleSide, depthWrite: false, toneMapped: false }),
    );
    this.surface.userData.spatialInput = true;
    this.surface.renderOrder = 2_000_000;
    this.group.add(this.surface);
    this.group.visible = false;
  }

  get isOpen(): boolean {
    return this.request !== null;
  }

  get bounds(): { x: number; y: number; width: number; height: number } {
    return { x: 0, y: 0, width: WIDTH, height: HEIGHT };
  }

  private get isTextEntry(): boolean {
    return this.request?.mode === undefined || this.request.mode === 'text';
  }

  requestText(options: Omit<SpatialTextRequest, 'resolve'>): Promise<string | null> {
    if (this.request) this.finish(null);
    this.request = { ...options, mode: options.mode ?? 'text', resolve: () => undefined };
    this.value = options.value;
    this.selection = { start: this.value.length, end: this.value.length };
    this.physicalSelection = this.isTextEntry ? { ...this.selection } : null;
    this.displayStart = this.isTextEntry ? Math.max(0, this.value.length - 70) : 0;
    this.shifted = false;
    this.capsLocked = false;
    this.hovered = null;
    this.dirty = true;
    this.group.visible = true;
    return new Promise<string | null>((resolve) => {
      if (this.request) this.request.resolve = resolve;
      this.render();
    });
  }

  requestConfirm(message: string): Promise<boolean> {
    return this.requestText({
      title: 'Confirm action',
      value: message,
      placeholder: 'Review the action before continuing.',
      submitLabel: 'Confirm',
      mode: 'confirm',
    }).then((value) => value !== null);
  }

  update(cameraQuaternion: Quaternion, distanceScale: number): void {
    if (!this.request) {
      this.group.visible = false;
      return;
    }
    this.group.visible = true;
    this.group.position.set(0, 0.08, -5.2 * distanceScale).applyQuaternion(cameraQuaternion);
    this.group.quaternion.copy(cameraQuaternion);
    this.group.updateMatrixWorld();
  }

  target(u: number, v: number): SpatialInputTarget | null {
    if (!this.request) return null;
    const x = u * WIDTH;
    const y = (1 - v) * HEIGHT;
    const bodyRegion = this.isTextEntry ? this.promptRegion : this.panelRegion;
    if (x >= bodyRegion.x && x <= bodyRegion.x + bodyRegion.width && y >= bodyRegion.y && y <= bodyRegion.y + bodyRegion.height) {
      return this.isTextEntry
        ? { key: 'prompt', action: () => this.positionCaret(x) }
        : { key: 'information', action: () => undefined };
    }
    const keyRegion = this.regionAt(x, y);
    return keyRegion ? { key: keyRegion.key, action: () => this.press(keyRegion.key, keyRegion.character) } : null;
  }

  pointer(u: number, v: number): boolean {
    const target = this.target(u, v);
    target?.action();
    return Boolean(target);
  }

  private regionAt(x: number, y: number): KeyRegion | undefined {
    return this.regions.find((candidate) => x >= candidate.x && x <= candidate.x + candidate.width && y >= candidate.y && y <= candidate.y + candidate.height);
  }

  private positionCaret(x: number): void {
    this.context.font = '34px ui-monospace, SFMono-Regular, Menlo, monospace';
    const display = this.displayValue();
    const relative = Math.max(0, x - 78);
    let caret = 0;
    let bestDistance = Infinity;
    for (let index = 0; index <= display.length; index += 1) {
      const distance = Math.abs(this.context.measureText(display.slice(0, index)).width - relative);
      if (distance < bestDistance) {
        bestDistance = distance;
        caret = index;
      }
    }
    this.selection = { start: this.displayStart + caret, end: this.displayStart + caret };
    this.dirty = true;
  }

  hover(u: number, v: number): void {
    if (!this.request) return;
    const x = u * WIDTH;
    const y = (1 - v) * HEIGHT;
    const region = this.isTextEntry ? this.promptRegion : this.panelRegion;
    const overPrompt = x >= region.x && x <= region.x + region.width && y >= region.y && y <= region.y + region.height;
    const key = overPrompt ? (this.isTextEntry ? 'prompt' : 'information') : this.regionAt(x, y)?.key ?? null;
    if (key !== this.hovered) {
      this.hovered = key;
      this.dirty = true;
    }
  }

  clearHover(): void {
    if (this.hovered === null) return;
    this.hovered = null;
    this.dirty = true;
  }

  setInterfacePalette(accent: string): void {
    if (accent === this.interfaceAccent) return;
    this.interfaceAccent = accent;
    this.dirty = true;
    this.render();
  }

  render(force = false): void {
    if (!this.request || (!this.dirty && !force)) return;
    const mode = this.request.mode;
    const confirmation = mode === 'confirm';
    const context = this.context;
    context.clearRect(0, 0, WIDTH, HEIGHT);
    fillRoundedRect(context, 3, 3, WIDTH - 6, HEIGHT - 6, 42, 'rgba(16,20,27,0.93)');
    const sheen = context.createLinearGradient(0, 0, WIDTH, HEIGHT);
    sheen.addColorStop(0, 'rgba(255,255,255,0.14)');
    sheen.addColorStop(0.45, 'rgba(255,255,255,0.01)');
    sheen.addColorStop(1, 'rgba(255,255,255,0.07)');
    fillRoundedRect(context, 6, 6, WIDTH - 12, HEIGHT - 12, 40, sheen);
    roundedRect(context, 4, 4, WIDTH - 8, HEIGHT - 8, 41);
    context.strokeStyle = 'rgba(255,255,255,0.42)';
    context.lineWidth = 3;
    context.stroke();
    context.fillStyle = '#f5f8fc';
    context.font = '700 34px -apple-system, BlinkMacSystemFont, sans-serif';
    context.textBaseline = 'middle';
    context.fillText(this.request.title, 42, 62, WIDTH - 84);
    context.fillStyle = 'rgba(255,255,255,0.65)';
    context.font = '22px -apple-system, BlinkMacSystemFont, sans-serif';
    context.fillText(this.request.placeholder ?? 'Point at a key and pinch. Click the field to move the caret.', 42, 104, WIDTH - 84);

    if (!this.isTextEntry) {
      context.fillStyle = '#9aacc4';
      context.font = '17px -apple-system, BlinkMacSystemFont, sans-serif';
      context.fillText(confirmation ? 'Confirmation required' : 'Controls guide • no text entry required', 42, 132, WIDTH - 84);
    }

    if (this.isTextEntry) {
      const prompt = this.promptRegion;
      fillRoundedRect(context, prompt.x, prompt.y, prompt.width, prompt.height, 24, this.hovered === 'prompt' ? `${this.interfaceAccent}21` : 'rgba(255,255,255,0.075)');
      roundedRect(context, prompt.x, prompt.y, prompt.width, prompt.height, 24);
      context.strokeStyle = `${this.interfaceAccent}a6`;
      context.lineWidth = 3;
      context.stroke();
      const display = this.displayValue();
      context.font = '34px ui-monospace, SFMono-Regular, Menlo, monospace';
      context.fillStyle = '#f4f8fd';
      context.textAlign = 'left';
      context.fillText(display, 78, 201, WIDTH - 156);
      const caretOffset = context.measureText(display.slice(0, Math.max(0, this.selection.start - this.displayStart))).width;
      context.fillStyle = this.interfaceAccent;
      context.fillRect(78 + caretOffset, 174, 3, 52);
    } else {
      const panel = this.panelRegion;
      fillRoundedRect(context, panel.x, panel.y, panel.width, panel.height, 24, this.hovered === 'information' ? `${this.interfaceAccent}21` : 'rgba(255,255,255,0.055)');
      roundedRect(context, panel.x, panel.y, panel.width, panel.height, 24);
      context.strokeStyle = confirmation ? 'rgba(255,190,150,0.42)' : 'rgba(255,255,255,0.16)';
      context.lineWidth = 2;
      context.stroke();
      context.save();
      roundedRect(context, panel.x + 4, panel.y + 4, panel.width - 8, panel.height - 8, 20);
      context.clip();
      context.fillStyle = '#eaf3ff';
      context.font = `${confirmation ? '650 34px' : '600 27px'} -apple-system, BlinkMacSystemFont, sans-serif`;
      this.wrapPanelText(this.value).forEach((line, index) => {
        context.fillText(line, panel.x + 30, panel.y + 46 + index * (confirmation ? 48 : 38), panel.width - 60);
      });
      context.restore();
    }

    this.regions = [];
    if (this.isTextEntry) {
      const startY = 286;
      KEY_ROWS.forEach((row, rowIndex) => {
        const widths = row.map((key) => key === 'space' ? 5.1 : key === 'shift' || key === 'caps' ? 1.55 : key === 'backspace' ? 1.55 : key === 'enter' ? 2 : 1);
        const gap = 14;
        const unit = (WIDTH - 80) / 10.6;
        const rowWidth = widths.reduce((sum, width) => sum + width, 0) * unit + gap * (row.length - 1);
        let x = (WIDTH - rowWidth) / 2;
        row.forEach((key, index) => {
          const width = widths[index] * unit;
          this.drawKey(key, x, startY + rowIndex * 78, width, 64);
          x += width + gap;
        });
      });
      this.drawKey('clear', WIDTH / 2 - 110, HEIGHT - 100, 220, 62);
    }
    this.drawKey('cancel', 40, HEIGHT - 100, 220, 62);
    this.drawKey('submit', WIDTH - 260, HEIGHT - 100, 220, 62);
    this.texture.needsUpdate = true;
    this.dirty = false;
  }

  private wrapPanelText(value: string): string[] {
    const lines: string[] = [];
    for (const paragraph of value.split('\n')) {
      const words = paragraph.trim().split(/\s+/).filter(Boolean);
      if (words.length === 0) {
        lines.push('');
        continue;
      }
      let line = '';
      for (const word of words) {
        const candidate = line ? `${line} ${word}` : word;
        if (!line || this.context.measureText(candidate).width <= this.panelRegion.width - 60) {
          line = candidate;
          continue;
        }
        lines.push(line);
        line = word;
      }
      lines.push(line);
    }
    return lines;
  }

  private displayValue(): string {
    if (!this.request) return '';
    if (!this.isTextEntry) return this.value;
    if (this.request.secret) return '•'.repeat(this.value.length);
    return `${this.displayStart > 0 ? '…' : ''}${this.value.slice(this.displayStart, this.displayStart + 100)}`;
  }

  private press(key: string, character?: string): void {
    if (!this.request) return;
    uiSound.play(key === 'cancel' ? 'back' : key === 'submit' || key === 'enter' ? 'confirm' : key === 'shift' || key === 'caps' ? 'toggle' : 'key');
    if (key === 'cancel') {
      this.finish(null);
      return;
    }
    if (key === 'submit') {
      const value = this.value;
      this.finish(value);
      return;
    }
    if (!this.isTextEntry) return;
    if (key === 'clear') {
      this.value = '';
      this.displayStart = 0;
      this.selection = { start: 0, end: 0 };
      this.physicalSelection = { start: 0, end: 0 };
    } else if (key === 'shift') {
      this.shifted = !this.shifted;
    } else if (key === 'caps') {
      this.capsLocked = !this.capsLocked;
    } else if (key === 'backspace') {
      const result = backspaceText(this.value, this.selection);
      this.value = result.value;
      this.selection = { start: result.start, end: result.end };
      this.physicalSelection = { ...this.selection };
    } else if (key === 'space') {
      this.insert(' ');
    } else if (key === 'enter') {
      this.finish(this.value);
      return;
    } else {
      const shifted = this.shifted !== this.capsLocked;
      const base = character ?? key;
      const text = shifted ? SYMBOLS[base] ?? base.toUpperCase() : base;
      this.insert(applyKeyboardCase(text, false, false));
    }
    this.dirty = true;
    this.render();
  }

  private insert(text: string): void {
    const result = replaceTextSelection(this.value, this.selection, text);
    this.value = result.value;
    this.selection = { start: result.start, end: result.end };
    this.physicalSelection = { ...this.selection };
    if (this.selection.start > this.displayStart + 90 || this.selection.start < this.displayStart) this.displayStart = Math.max(0, this.selection.start - 70);
    this.shifted = false;
  }

  physicalKey(event: KeyboardEvent): boolean {
    if (!this.request) return false;
    uiSound.unlock();
    if (event.key === 'Escape') {
      this.finish(null);
      return true;
    }
    if (event.key === 'Enter') {
      this.finish(this.value);
      return true;
    }
    if (!this.isTextEntry || event.ctrlKey || event.metaKey || event.altKey) return false;
    if (event.key === 'Backspace') {
      const result = backspaceText(this.value, this.selection);
      this.value = result.value;
      this.selection = { start: result.start, end: result.end };
    } else if (event.key === 'Delete') {
      const selection = this.selection.start === this.selection.end
        ? { start: this.selection.end, end: Math.min(this.value.length, this.selection.end + 1) }
        : this.selection;
      const result = replaceTextSelection(this.value, selection, '');
      this.value = result.value;
      this.selection = { start: result.start, end: result.end };
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      const caret = event.key === 'ArrowLeft' ? Math.max(0, this.selection.start - 1) : Math.min(this.value.length, this.selection.end + 1);
      this.selection = { start: caret, end: caret };
    } else if (event.key === 'Home' || event.key === 'End') {
      const caret = event.key === 'Home' ? 0 : this.value.length;
      this.selection = { start: caret, end: caret };
    } else if (event.key.length === 1) {
      this.insert(event.key);
      this.dirty = true;
      this.render();
      return true;
    } else return false;
    this.physicalSelection = { ...this.selection };
    this.displayStart = Math.max(0, Math.min(this.displayStart, this.selection.start));
    this.dirty = true;
    this.render();
    return true;
  }

  setPhysicalSelection(start: number, end = start): void {
    const first = Math.max(0, Math.min(this.value.length, start));
    const second = Math.max(0, Math.min(this.value.length, end));
    this.selection = { start: Math.min(first, second), end: Math.max(first, second) };
    if (this.physicalSelection) this.physicalSelection = { ...this.selection };
    if (this.selection.end > this.displayStart + 90 || this.selection.start < this.displayStart) this.displayStart = Math.max(0, this.selection.start - 70);
    this.dirty = true;
  }

  syncPhysicalSelection(): void {
    if (!this.physicalSelection) return;
    this.physicalSelection.start = Math.min(this.physicalSelection.start, this.value.length);
    this.physicalSelection.end = Math.min(this.physicalSelection.end, this.value.length);
    this.selection = { ...this.physicalSelection };
    if (this.selection.end > this.displayStart + 90 || this.selection.start < this.displayStart) this.displayStart = Math.max(0, this.selection.start - 70);
    this.dirty = true;
  }

  get text(): string {
    return this.value;
  }

  private drawKey(key: string, x: number, y: number, width: number, height: number): void {
    const labels: Record<string, string> = { shift: 'shift', caps: 'caps', backspace: '⌫', space: 'Space', enter: 'Done', cancel: this.request?.cancelLabel ?? 'Cancel', clear: 'Clear', submit: this.request?.submitLabel ?? 'Save' };
    const character = /^[a-z0-9]$/.test(key) ? key : undefined;
    const upper = character ? this.shifted !== this.capsLocked : false;
    const label = labels[key] ?? (upper ? SYMBOLS[character ?? key] ?? character?.toUpperCase() ?? key : key);
    const context = this.context;
    fillRoundedRect(context, x, y, width, height, 17, this.hovered === key ? `${this.interfaceAccent}3d` : 'rgba(255,255,255,0.075)');
    roundedRect(context, x, y, width, height, 17);
    context.strokeStyle = this.hovered === key ? `${this.interfaceAccent}e6` : 'rgba(255,255,255,0.14)';
    context.lineWidth = 2;
    context.stroke();
    context.fillStyle = key === 'cancel' ? '#ffb3bc' : key === 'submit' ? '#b7f8de' : '#eef4fb';
    context.font = key.length > 2 ? '650 23px -apple-system, BlinkMacSystemFont, sans-serif' : '600 29px -apple-system, BlinkMacSystemFont, sans-serif';
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.fillText(label, x + width / 2, y + height / 2, width - 18);
    context.textAlign = 'left';
    context.textBaseline = 'alphabetic';
    this.regions.push({ x, y, width, height, key, character });
  }

  private finish(value: string | null): void {
    const request = this.request;
    this.request = null;
    this.physicalSelection = null;
    this.group.visible = false;
    this.dirty = true;
    request?.resolve(value);
  }

  close(): void {
    this.finish(null);
  }

  destroy(): void {
    this.close();
    this.surface.geometry.dispose();
    this.surface.material.dispose();
    this.texture.dispose();
    this.group.removeFromParent();
  }
}
