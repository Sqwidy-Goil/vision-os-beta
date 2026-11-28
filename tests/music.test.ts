import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMusicApp } from '../src/applications/media';
import { DEFAULT_SETTINGS, type ApplicationContext, type ApplicationInstance } from '../src/types';

class FakeAudio {
  static instances: FakeAudio[] = [];
  preload = '';
  src = '';
  paused = true;
  currentTime = 0;
  duration = 180;
  playError: Error | null = null;
  private readonly listeners = new Map<string, Set<() => void>>();

  constructor() {
    FakeAudio.instances.push(this);
  }

  play = vi.fn(async () => {
    if (this.playError) throw this.playError;
    this.paused = false;
    this.emit('play');
  });

  pause = vi.fn(() => {
    if (this.paused) return;
    this.paused = true;
    this.emit('pause');
  });

  removeAttribute = vi.fn();

  addEventListener(type: string, listener: () => void): void {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: () => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  emit(type: string): void {
    for (const listener of this.listeners.get(type) ?? []) listener();
  }

  listenerCount(): number {
    return [...this.listeners.values()].reduce((total, listeners) => total + listeners.size, 0);
  }
}

function canvasContext(): CanvasRenderingContext2D {
  const gradient = { addColorStop: vi.fn() };
  return {
    save: vi.fn(),
    restore: vi.fn(),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    arc: vi.fn(),
    arcTo: vi.fn(),
    closePath: vi.fn(),
    fill: vi.fn(),
    stroke: vi.fn(),
    clip: vi.fn(),
    fillRect: vi.fn(),
    fillText: vi.fn(),
    createLinearGradient: vi.fn(() => gradient),
    measureText: vi.fn((text: string) => ({ width: text.length * 7 })),
  } as unknown as CanvasRenderingContext2D;
}

const instances: ApplicationInstance[] = [];

function musicContext() {
  const ctx = canvasContext();
  const requestText = vi.fn<(options: { value: string }) => Promise<string | null>>(async () => null);
  const context = {
    window: { canvas: { width: 800, height: 500 }, context: ctx, requestRender: vi.fn() },
    pickFiles: vi.fn(async () => []),
    requestText,
    requestConfirm: vi.fn(async () => true),
    notify: vi.fn(),
    getSettings: () => DEFAULT_SETTINGS,
  } as unknown as ApplicationContext;
  return { context, ctx, requestText };
}

beforeEach(() => {
  FakeAudio.instances = [];
  vi.stubGlobal('Audio', FakeAudio);
});

afterEach(() => {
  instances.splice(0).forEach((app) => app.destroy?.());
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('bundled chill music', () => {
  it('loads bundled tracks, autoplays on activation, advances at end, and honors explicit pause', async () => {
    const harness = musicContext();
    const app = createMusicApp(harness.context);
    instances.push(app);
    const audio = FakeAudio.instances[0];
    expect(audio.src).toMatch(/\/music\/Morning\.mp3$/);

    app.activate?.();
    app.activate?.();
    expect(audio.play).toHaveBeenCalledOnce();
    audio.emit('ended');
    expect(audio.src).toMatch(/\/music\/Evening\.mp3$/);

    app.render(harness.ctx, 800, 500, 0);
    expect(app.pointer?.(308, 462, {} as PointerEvent)).toBe(true);
    expect(audio.src).toMatch(/\/music\/Late-Night-Radio\.mp3$/);
    app.render(harness.ctx, 800, 500, 0);
    expect(app.pointer?.(260, 462, {} as PointerEvent)).toBe(true);
    expect(audio.src).toMatch(/\/music\/Evening\.mp3$/);

    app.render(harness.ctx, 800, 500, 0);
    expect(app.pointer?.(184, 462, {} as PointerEvent)).toBe(true);
    const playsAfterPause = audio.play.mock.calls.length;
    app.resume?.();
    expect(audio.play).toHaveBeenCalledTimes(playsAfterPause);
    app.destroy?.();
    expect(audio.listenerCount()).toBe(0);
  });

  it('waits for an explicit Play gesture after blocked autoplay instead of restarting on focus', async () => {
    const harness = musicContext();
    const app = createMusicApp(harness.context);
    instances.push(app);
    const audio = FakeAudio.instances[0];
    audio.playError = new DOMException('Autoplay blocked', 'NotAllowedError');

    app.activate?.();
    await vi.waitFor(() => {
      app.render(harness.ctx, 800, 500, 0);
      expect(harness.ctx.fillText).toHaveBeenCalledWith(
        expect.stringContaining('press Play'), expect.any(Number), expect.any(Number),
      );
    });
    expect(audio.play).toHaveBeenCalledOnce();
    app.resume?.();
    app.activate?.();
    expect(audio.play).toHaveBeenCalledOnce();

    audio.playError = null;
    app.render(harness.ctx, 800, 500, 0);
    expect(app.pointer?.(184, 462, {} as PointerEvent)).toBe(true);
    await vi.waitFor(() => expect(audio.play).toHaveBeenCalledTimes(2));
    expect(audio.paused).toBe(false);
    app.resume?.();
    expect(audio.play).toHaveBeenCalledTimes(2);
  });

  it('reports blocked autoplay honestly and exposes complete royalty-free credits', async () => {
    const harness = musicContext();
    const app = createMusicApp(harness.context);
    instances.push(app);
    const audio = FakeAudio.instances[0];
    audio.playError = new DOMException('Autoplay blocked', 'NotAllowedError');
    app.activate?.();
    await vi.waitFor(() => {
      app.render(harness.ctx, 800, 500, 0);
      expect(harness.ctx.fillText).toHaveBeenCalledWith(
        expect.stringContaining('press Play'), expect.any(Number), expect.any(Number),
      );
    });

    app.render(harness.ctx, 800, 500, 0);
    expect(app.pointer?.(643, 462, {} as PointerEvent)).toBe(true);
    const credits = harness.requestText.mock.calls[0][0].value;
    expect(credits).toContain('Kevin MacLeod');
    expect(credits).toContain('Morning');
    expect(credits).toContain('Evening');
    expect(credits).toContain('Late Night Radio');
    expect(credits).toContain('https://creativecommons.org/licenses/by/4.0/');
    expect(credits).toContain('No changes made.');
  });
});
