import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  REFLEX_ROUND_MS,
  createEchoApp,
  createMemoryApp,
  createMemoryDeck,
  createReflexApp,
  echoPadRect,
  memoryCardRect,
  reflexPlayArea,
  targetContains,
  type EchoSnapshot,
  type MemorySnapshot,
  type ReflexSnapshot,
} from '../src/applications/games';
import { DEFAULT_SETTINGS, type ApplicationContext, type ApplicationInstance } from '../src/types';

const WIDTH = 1024;
const HEIGHT = 548;
const CONTENT = { x: 24, y: 92, width: WIDTH - 48, height: HEIGHT - 142 };

function canvasContext(): CanvasRenderingContext2D {
  const gradient = { addColorStop: vi.fn() };
  return {
    clearRect: vi.fn(),
    fillRect: vi.fn(),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    arcTo: vi.fn(),
    arc: vi.fn(),
    closePath: vi.fn(),
    fill: vi.fn(),
    stroke: vi.fn(),
    save: vi.fn(),
    restore: vi.fn(),
    rect: vi.fn(),
    clip: vi.fn(),
    fillText: vi.fn(),
    createLinearGradient: vi.fn(() => gradient),
    createRadialGradient: vi.fn(() => gradient),
    measureText: vi.fn((text: string) => ({ width: text.length * 7 })),
    globalAlpha: 1,
    fillStyle: '#000000',
    strokeStyle: '#000000',
    font: '',
    textAlign: 'left',
    textBaseline: 'alphabetic',
    lineWidth: 1,
  } as unknown as CanvasRenderingContext2D;
}

function appContext() {
  const ctx = canvasContext();
  const canvas = { width: WIDTH, height: HEIGHT, context: ctx } as unknown as HTMLCanvasElement;
  const requestRender = vi.fn();
  const context = {
    window: { id: 'game-test', canvas, context: ctx, requestRender },
    getSettings: () => DEFAULT_SETTINGS,
    isVrActive: () => true,
  } as unknown as ApplicationContext;
  return { context, ctx, requestRender };
}

function click(app: ApplicationInstance, x: number, y: number): boolean {
  return app.pointer?.(x, y, { type: 'pointerup' } as PointerEvent) ?? false;
}

function center(rect: { x: number; y: number; width: number; height: number }): { x: number; y: number } {
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}

function footerButton(index: 0 | 1 | 2): { x: number; y: number } {
  return { x: WIDTH - 394 + index * 130 + (index === 2 ? 65 : 60), y: HEIGHT - 29 };
}

function advance(app: ApplicationInstance, milliseconds: number): void {
  let remaining = milliseconds;
  while (remaining > 0) {
    const step = Math.min(100, remaining);
    app.update?.(step / 1000, 0);
    remaining -= step;
  }
}

function snapshot<T>(app: ApplicationInstance): T {
  return app.serialize?.() as T;
}

const instances: ApplicationInstance[] = [];

function gameApp(app: ApplicationInstance): ApplicationInstance {
  instances.push(app);
  return app;
}

afterEach(() => {
  for (const app of instances.splice(0)) app.destroy?.();
  vi.restoreAllMocks();
});

describe('hand game models', () => {
  it('creates a complete shuffled Memory deck with eight pairs', () => {
    const deck = createMemoryDeck(() => 0.25);
    expect(deck).toHaveLength(16);
    expect([...deck].sort((first, second) => first - second)).toEqual(Array.from({ length: 16 }, (_, index) => Math.floor(index / 2)));
  });

  it('keeps Reflex target hit testing radial', () => {
    expect(reflexPlayArea(CONTENT).height).toBeGreaterThan(300);
    expect(targetContains({ x: 100, y: 200, radius: 15 }, 110, 210)).toBe(true);
    expect(targetContains({ x: 100, y: 200, radius: 15 }, 116, 210)).toBe(false);
  });
});

describe('Memory', () => {
  it('matches pairs, clears mismatches, completes the board and pauses its timer', () => {
    const harness = appContext();
    const app = gameApp(createMemoryApp(harness.context, { random: () => 0.2, best: 0, sound: false }));
    app.render(harness.ctx, WIDTH, HEIGHT, 0);
    const initial = snapshot<MemorySnapshot>(app);
    const firstPair = initial.cards[0];
    const partner = initial.cards.findIndex((pair, index) => index > 0 && pair === firstPair);

    expect(click(app, center(memoryCardRect(CONTENT, 0)).x, center(memoryCardRect(CONTENT, 0)).y)).toBe(true);
    expect(click(app, center(memoryCardRect(CONTENT, partner)).x, center(memoryCardRect(CONTENT, partner)).y)).toBe(true);
    expect(snapshot<MemorySnapshot>(app).matched).toEqual([0, partner].sort((first, second) => first - second));
    expect(snapshot<MemorySnapshot>(app).moves).toBe(1);

    const other = initial.cards.findIndex((pair, index) => index > 0 && pair !== firstPair && index !== partner);
    const mismatch = initial.cards.findIndex((pair, index) => index > 0 && pair !== firstPair && pair !== initial.cards[other] && index !== partner);
    expect(click(app, center(memoryCardRect(CONTENT, other)).x, center(memoryCardRect(CONTENT, other)).y)).toBe(true);
    expect(snapshot<MemorySnapshot>(app).flipped).toEqual([other]);
    expect(click(app, center(memoryCardRect(CONTENT, mismatch)).x, center(memoryCardRect(CONTENT, mismatch)).y)).toBe(true);
    expect(snapshot<MemorySnapshot>(app).flipped).toHaveLength(2);
    advance(app, 800);
    expect(snapshot<MemorySnapshot>(app).flipped).toEqual([]);

    for (let pair = 0; pair < 8; pair += 1) {
      const indices = initial.cards.map((value, index) => ({ value, index })).filter((card) => card.value === pair).map((card) => card.index);
      for (const index of indices) {
        const point = center(memoryCardRect(CONTENT, index));
        click(app, point.x, point.y);
      }
    }
    const won = snapshot<MemorySnapshot>(app);
    expect(won.phase).toBe('won');
    expect(won.matched).toHaveLength(16);
    expect(won.score).toBeGreaterThan(0);
    expect(won.best).toBe(won.score);

    const pause = footerButton(1);
    expect(click(app, pause.x, pause.y)).toBe(true);
    expect(snapshot<MemorySnapshot>(app).paused).toBe(true);
    app.activate?.();
    expect(snapshot<MemorySnapshot>(app).paused).toBe(true);
    const deliberateResume = footerButton(1);
    expect(click(app, deliberateResume.x, deliberateResume.y)).toBe(true);
    expect(snapshot<MemorySnapshot>(app).paused).toBe(false);

    const elapsed = won.elapsedMs;
    app.deactivate?.();
    advance(app, 1000);
    expect(snapshot<MemorySnapshot>(app).elapsedMs).toBe(elapsed);
    expect(snapshot<MemorySnapshot>(app).paused).toBe(true);
    const blockedCard = center(memoryCardRect(CONTENT, 0));
    expect(click(app, blockedCard.x, blockedCard.y)).toBe(false);
    const resume = footerButton(1);
    expect(click(app, resume.x, resume.y)).toBe(true);
    expect(snapshot<MemorySnapshot>(app).paused).toBe(false);
    app.activate?.();
    expect(snapshot<MemorySnapshot>(app).paused).toBe(false);
  });

  it('persists sound preferences and restores only validated scores', () => {
    const harness = appContext();
    const persist = vi.fn();
    const app = gameApp(createMemoryApp(harness.context, { random: () => 0, best: 10, sound: false, persist }));
    app.render(harness.ctx, WIDTH, HEIGHT, 0);
    const sound = footerButton(2);
    click(app, sound.x, sound.y);
    expect(snapshot<MemorySnapshot>(app).sound).toBe(true);
    expect(persist).toHaveBeenLastCalledWith({ best: 10, sound: true });
    app.restore?.({ best: 420, sound: false, cards: ['invalid'] });
    expect(snapshot<MemorySnapshot>(app).best).toBe(420);
    expect(snapshot<MemorySnapshot>(app).sound).toBe(false);
    expect(snapshot<MemorySnapshot>(app).phase).toBe('ready');
  });
});

describe('Echo', () => {
  it('plays a sequence, accepts a full round and ends on a wrong pad', () => {
    const harness = appContext();
    const app = gameApp(createEchoApp(harness.context, { random: () => 0.1, best: 0, sound: false }));
    app.render(harness.ctx, WIDTH, HEIGHT, 0);
    const start = footerButton(0);
    click(app, start.x, start.y);
    expect(snapshot<EchoSnapshot>(app).phase).toBe('watch');
    expect(snapshot<EchoSnapshot>(app).sequence).toHaveLength(1);
    advance(app, 900);
    expect(snapshot<EchoSnapshot>(app).phase).toBe('repeat');

    const first = snapshot<EchoSnapshot>(app).sequence[0];
    const firstPoint = center(echoPadRect(CONTENT, first));
    click(app, firstPoint.x, firstPoint.y);
    expect(snapshot<EchoSnapshot>(app).round).toBe(2);
    expect(snapshot<EchoSnapshot>(app).sequence).toHaveLength(2);
    expect(snapshot<EchoSnapshot>(app).phase).toBe('watch');
    advance(app, 1700);
    expect(snapshot<EchoSnapshot>(app).phase).toBe('repeat');

    const sequence = snapshot<EchoSnapshot>(app).sequence;
    const firstPointAgain = center(echoPadRect(CONTENT, sequence[0]));
    click(app, firstPointAgain.x, firstPointAgain.y);
    const wrongPoint = center(echoPadRect(CONTENT, (sequence[1] + 1) % 4));
    click(app, wrongPoint.x, wrongPoint.y);
    const ended = snapshot<EchoSnapshot>(app);
    expect(ended.phase).toBe('gameover');
    expect(ended.best).toBe(1);
  });

  it('freezes playback timing while deactivated', () => {
    const harness = appContext();
    const app = gameApp(createEchoApp(harness.context, { random: () => 0, best: 0, sound: false }));
    app.render(harness.ctx, WIDTH, HEIGHT, 0);
    const start = footerButton(0);
    click(app, start.x, start.y);
    const before = snapshot<EchoSnapshot>(app).flashRemaining;
    app.deactivate?.();
    advance(app, 1000);
    expect(snapshot<EchoSnapshot>(app).flashRemaining).toBe(before);
    app.resume?.();
    advance(app, 900);
    expect(snapshot<EchoSnapshot>(app).phase).toBe('repeat');
  });
});

describe('Reflex', () => {
  it('spawns hand-targetable circles, scores hits and finishes the timed round', () => {
    const harness = appContext();
    const persist = vi.fn();
    const app = gameApp(createReflexApp(harness.context, { random: () => 0.4, best: 0, sound: false, persist }));
    app.render(harness.ctx, WIDTH, HEIGHT, 0);
    const start = footerButton(0);
    click(app, start.x, start.y);
    const active = snapshot<ReflexSnapshot>(app);
    expect(active.phase).toBe('playing');
    expect(active.remainingMs).toBe(REFLEX_ROUND_MS);
    expect(active.target).not.toBeNull();
    expect(click(app, active.target!.x, active.target!.y)).toBe(true);
    expect(snapshot<ReflexSnapshot>(app).hits).toBe(1);
    expect(snapshot<ReflexSnapshot>(app).score).toBeGreaterThan(0);
    expect(snapshot<ReflexSnapshot>(app).target).toBeNull();

    advance(app, REFLEX_ROUND_MS);
    const over = snapshot<ReflexSnapshot>(app);
    expect(over.phase).toBe('over');
    expect(over.remainingMs).toBe(0);
    expect(over.best).toBe(over.score);
    expect(persist).toHaveBeenCalledWith({ best: over.score, sound: false });
  });

  it('counts misses, resets combos and pauses the countdown', () => {
    const harness = appContext();
    const app = gameApp(createReflexApp(harness.context, { random: () => 0.4, best: 0, sound: false }));
    app.render(harness.ctx, WIDTH, HEIGHT, 0);
    const start = footerButton(0);
    click(app, start.x, start.y);
    const target = snapshot<ReflexSnapshot>(app).target!;
    expect(click(app, target.x, target.y)).toBe(true);
    expect(snapshot<ReflexSnapshot>(app).combo).toBe(1);
    const area = reflexPlayArea(CONTENT);
    expect(click(app, area.x + area.width - 5, area.y + area.height - 5)).toBe(true);
    expect(snapshot<ReflexSnapshot>(app).misses).toBe(1);
    expect(snapshot<ReflexSnapshot>(app).combo).toBe(0);

    const remaining = snapshot<ReflexSnapshot>(app).remainingMs;
    app.deactivate?.();
    advance(app, 1000);
    expect(snapshot<ReflexSnapshot>(app).remainingMs).toBe(remaining);
    app.activate?.();
    advance(app, 500);
    expect(snapshot<ReflexSnapshot>(app).remainingMs).toBeLessThan(remaining);
  });
});
