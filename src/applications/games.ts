import type { ApplicationContext, ApplicationInstance } from '../types';
import { getInterfacePalette } from '../core/theme';
import { ellipsis, fillRoundedRect, roundedRect } from '../spatial/canvasUi';
import { actionAt, drawButton, type CanvasAction } from './ui';

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface GamePreferences {
  best: number;
  sound: boolean;
}

export interface GameAppOptions extends Partial<GamePreferences> {
  random?: () => number;
  persist?: (preferences: GamePreferences) => void;
}

interface GameHooks {
  requestRender: () => void;
  playTone: (frequency: number, duration?: number, type?: OscillatorType) => void;
  recordBest: (score: number) => void;
}

interface ControllerOptions {
  random: () => number;
  hooks: GameHooks;
}

interface GameController {
  start: () => void;
  primaryLabel: () => string;
  update: (deltaMs: number) => boolean;
  render: (context: CanvasRenderingContext2D, bounds: Rect, actions: CanvasAction[], accent: string) => void;
  pointer: (x: number, y: number) => boolean;
  snapshot: () => Record<string, unknown>;
}

export interface MemorySnapshot extends GamePreferences {
  schemaVersion: 1;
  paused: boolean;
  phase: 'ready' | 'playing' | 'won';
  cards: number[];
  flipped: number[];
  matched: number[];
  moves: number;
  elapsedMs: number;
  score: number;
  mismatchRemaining: number;
}

export interface EchoSnapshot extends GamePreferences {
  schemaVersion: 1;
  paused: boolean;
  phase: 'idle' | 'watch' | 'repeat' | 'gameover';
  sequence: number[];
  round: number;
  inputIndex: number;
  watchStep: number;
  litPad: number | null;
  flashRemaining: number;
  gapRemaining: number;
  feedbackPad: number | null;
  feedbackCorrect: boolean;
  feedbackRemaining: number;
}

export const REFLEX_ROUND_MS = 30_000;
export const REFLEX_TARGET_LIFE_MS = 1_450;

export interface ReflexSnapshot extends GamePreferences {
  schemaVersion: 1;
  paused: boolean;
  phase: 'idle' | 'playing' | 'over';
  remainingMs: number;
  score: number;
  hits: number;
  misses: number;
  combo: number;
  bestCombo: number;
  target: { x: number; y: number; radius: number; remainingMs: number; maxMs: number } | null;
  spawnRemaining: number;
  lastGain: number;
}

const MEMORY_SYMBOLS = ['✦', '◈', '☾', '✿', '⌁', '◐', '♫', '▲'];
const MEMORY_COLORS = ['#b694ff', '#75e7ff', '#78f0d0', '#ffd28a', '#ff9db0', '#9fc5ff', '#c7a6ff', '#78f0a8'];
const ECHO_COLORS = ['#75e7ff', '#ff9db0', '#ffe08a', '#78f0d0'];
const ECHO_FREQUENCIES = [329.63, 261.63, 220, 392];
const GAME_STORAGE_PREFIX = 'vision.games.v1.';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeBest(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.min(1_000_000_000, Math.floor(value)))
    : fallback;
}

function randomUnit(random: () => number): number {
  const value = random();
  return Number.isFinite(value) ? Math.max(0, Math.min(0.999_999, value)) : 0.5;
}

function randomInt(random: () => number, maximum: number): number {
  return Math.floor(randomUnit(random) * maximum);
}

function readPreferences(key: string): Partial<GamePreferences> {
  try {
    const raw = globalThis.localStorage?.getItem(key);
    if (!raw) return {};
    const value: unknown = JSON.parse(raw);
    if (!isRecord(value)) return {};
    return {
      ...(typeof value.best === 'number' ? { best: normalizeBest(value.best) } : {}),
      ...(typeof value.sound === 'boolean' ? { sound: value.sound } : {}),
    };
  } catch {
    return {};
  }
}

function writePreferences(key: string, preferences: GamePreferences): void {
  try {
    globalThis.localStorage?.setItem(key, JSON.stringify(preferences));
  } catch {
    return;
  }
}

export function createMemoryDeck(random: () => number = Math.random): number[] {
  const deck = Array.from({ length: 16 }, (_, index) => Math.floor(index / 2));
  for (let index = deck.length - 1; index > 0; index -= 1) {
    const swap = randomInt(random, index + 1);
    [deck[index], deck[swap]] = [deck[swap], deck[index]];
  }
  return deck;
}

export function memoryCardRect(bounds: Rect, index: number): Rect {
  const gridWidth = Math.min(bounds.width, 760);
  const gridX = bounds.x + (bounds.width - gridWidth) / 2;
  const gridY = bounds.y + 42;
  const gridHeight = Math.max(120, bounds.height - 42);
  const gap = 12;
  return {
    x: gridX + (index % 4) * ((gridWidth - gap * 3) / 4 + gap),
    y: gridY + Math.floor(index / 4) * ((gridHeight - gap * 3) / 4 + gap),
    width: (gridWidth - gap * 3) / 4,
    height: (gridHeight - gap * 3) / 4,
  };
}

export function echoPadRect(bounds: Rect, index: number): Rect {
  const gap = 16;
  const top = bounds.y + 36;
  const width = (bounds.width - gap) / 2;
  const height = (bounds.height - 36 - gap) / 2;
  return {
    x: bounds.x + (index % 2) * (width + gap),
    y: top + Math.floor(index / 2) * (height + gap),
    width,
    height,
  };
}

export function reflexPlayArea(bounds: Rect): Rect {
  return { x: bounds.x, y: bounds.y + 48, width: bounds.width, height: Math.max(120, bounds.height - 48) };
}

export function targetContains(target: { x: number; y: number; radius: number }, x: number, y: number): boolean {
  return Math.hypot(x - target.x, y - target.y) <= target.radius;
}

function drawHeader(
  context: CanvasRenderingContext2D,
  width: number,
  title: string,
  subtitle: string,
  best: number,
  accent: string,
): void {
  const background = context.createLinearGradient(0, 0, width, 100);
  background.addColorStop(0, 'rgba(255,255,255,0.065)');
  background.addColorStop(1, 'rgba(255,255,255,0.012)');
  fillRoundedRect(context, 0, 0, width, 82, 16, background);
  context.fillStyle = accent;
  context.beginPath();
  context.arc(28, 31, 6, 0, Math.PI * 2);
  context.fill();
  context.font = '700 20px -apple-system, BlinkMacSystemFont, sans-serif';
  context.fillStyle = '#f5f8fc';
  context.textAlign = 'left';
  context.textBaseline = 'middle';
  context.fillText(title, 44, 32, width - 220);
  context.font = '11px -apple-system, BlinkMacSystemFont, sans-serif';
  context.fillStyle = '#9aacc4';
  context.fillText(ellipsis(context, subtitle, width - 56), 24, 61, width - 56);
  context.textAlign = 'right';
  context.font = '650 11px -apple-system, BlinkMacSystemFont, sans-serif';
  context.fillStyle = accent;
  context.fillText(`BEST ${best.toLocaleString()}`, width - 24, 31);
  context.textAlign = 'left';
  context.textBaseline = 'alphabetic';
}

function createGameApp(
  context: ApplicationContext,
  storageKey: string,
  metadata: { title: string; subtitle: string; accent: string },
  options: GameAppOptions,
  createController: (options: ControllerOptions) => GameController,
): ApplicationInstance {
  const actions: CanvasAction[] = [];
  const stored = readPreferences(storageKey);
  const random = options.random ?? Math.random;
  let best = normalizeBest(options.best ?? stored.best);
  let sound = options.sound ?? stored.sound ?? true;
  let paused = false;
  let manuallyPaused = false;
  let destroyed = false;
  let audio: AudioContext | null = null;

  const requestRender = (): void => {
    if (!destroyed) context.window.requestRender();
  };

  const persist = (): void => {
    const preferences = { best, sound };
    try {
      if (options.persist) options.persist(preferences);
      else writePreferences(storageKey, preferences);
    } catch {
      return;
    }
  };

  const recordBest = (score: number): void => {
    const normalized = normalizeBest(score, best);
    if (normalized <= best) return;
    best = normalized;
    persist();
  };

  const playTone = (frequency: number, duration = 0.12, type: OscillatorType = 'sine'): void => {
    if (!sound || destroyed) return;
    try {
      audio ??= new AudioContext();
      if (audio.state === 'suspended') void audio.resume().catch(() => undefined);
      const oscillator = audio.createOscillator();
      const gain = audio.createGain();
      const start = audio.currentTime;
      oscillator.type = type;
      oscillator.frequency.setValueAtTime(frequency, start);
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(0.07, start + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
      oscillator.connect(gain);
      gain.connect(audio.destination);
      oscillator.start(start);
      oscillator.stop(start + duration + 0.02);
      oscillator.onended = () => {
        oscillator.disconnect();
        gain.disconnect();
      };
    } catch {
      return;
    }
  };

  const controller = createController({
    random,
    hooks: { requestRender, playTone, recordBest },
  });

  return {
    render: (ctx, width, height) => {
      if (destroyed) return;
      actions.length = 0;
      const accent = getInterfacePalette(context.getSettings().palette).accent;
      const background = ctx.createLinearGradient(0, 0, width, height);
      background.addColorStop(0, 'rgba(255,255,255,0.025)');
      background.addColorStop(1, 'rgba(255,255,255,0.055)');
      ctx.fillStyle = background;
      ctx.fillRect(0, 0, width, height);
      drawHeader(ctx, width, metadata.title, metadata.subtitle, best, accent);
      const bounds = { x: 24, y: 92, width: Math.max(240, width - 48), height: Math.max(220, height - 142) };
      controller.render(ctx, bounds, actions, accent);
      if (paused) {
        fillRoundedRect(ctx, bounds.x, bounds.y, bounds.width, bounds.height, 18, 'rgba(7,10,14,0.72)');
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = '#f5f8fc';
        ctx.font = '700 24px -apple-system, BlinkMacSystemFont, sans-serif';
        ctx.fillText('Paused', width / 2, bounds.y + bounds.height / 2 - 12);
        ctx.fillStyle = '#9aacc4';
        ctx.font = '12px -apple-system, BlinkMacSystemFont, sans-serif';
        ctx.fillText('Pinch Resume to continue.', width / 2, bounds.y + bounds.height / 2 + 18);
        ctx.textAlign = 'left';
        ctx.textBaseline = 'alphabetic';
      }
      ctx.fillStyle = 'rgba(154,172,196,0.72)';
      ctx.font = '10px -apple-system, BlinkMacSystemFont, sans-serif';
      ctx.fillText('Pinch, tap or dwell • pauses automatically when minimized', 24, height - 25);
      const footerX = width - 394;
      actions.push(drawButton(ctx, footerX, height - 46, 120, 34, controller.primaryLabel(), () => {
        paused = false;
        manuallyPaused = false;
        controller.start();
        requestRender();
      }, false, accent));
      actions.push(drawButton(ctx, footerX + 130, height - 46, 120, 34, paused ? 'Resume' : 'Pause', () => {
        paused = !paused;
        manuallyPaused = paused;
        requestRender();
      }, paused, accent));
      actions.push(drawButton(ctx, footerX + 260, height - 46, 110, 34, sound ? 'Sound on' : 'Sound off', () => {
        sound = !sound;
        persist();
        if (sound) playTone(520, 0.08);
        requestRender();
      }, sound, accent));
    },
    pointer: (x, y, event) => {
      if (destroyed || (event.type !== 'pointerup' && event.type !== 'click')) return false;
      if (actionAt(paused ? actions.slice(-3) : actions, x, y)) return true;
      return !paused && controller.pointer(x, y);
    },
    update: (delta) => {
      if (destroyed || paused) return;
      if (controller.update(Math.max(0, Math.min(delta, 0.1)) * 1000)) requestRender();
    },
    activate: () => {
      if (destroyed) return;
      if (!manuallyPaused) paused = false;
      requestRender();
    },
    deactivate: () => {
      if (destroyed || paused) return;
      paused = true;
      requestRender();
    },
    suspend: () => {
      if (destroyed || paused) return;
      paused = true;
      requestRender();
    },
    resume: () => {
      if (destroyed) return;
      if (!manuallyPaused) paused = false;
      requestRender();
    },
    serialize: () => ({
      ...controller.snapshot(),
      schemaVersion: 1,
      best,
      sound,
      paused,
    }),
    restore: (value) => {
      if (destroyed || !isRecord(value)) return;
      if (typeof value.best === 'number') best = normalizeBest(value.best, best);
      if (typeof value.sound === 'boolean') sound = value.sound;
      requestRender();
    },
    destroy: () => {
      if (destroyed) return;
      destroyed = true;
      actions.length = 0;
      if (audio) void audio.close().catch(() => undefined);
      audio = null;
    },
  };
}

function createMemoryController({ random, hooks }: ControllerOptions): GameController {
  let cards = createMemoryDeck(random);
  let phase: MemorySnapshot['phase'] = 'ready';
  let flipped: number[] = [];
  const matched = new Set<number>();
  let moves = 0;
  let elapsedMs = 0;
  let score = 0;
  let mismatchRemaining = 0;

  const start = (): void => {
    cards = createMemoryDeck(random);
    phase = 'ready';
    flipped = [];
    matched.clear();
    moves = 0;
    elapsedMs = 0;
    score = 0;
    mismatchRemaining = 0;
    hooks.requestRender();
  };

  const flip = (index: number): void => {
    if (phase === 'won' || mismatchRemaining > 0 || matched.has(index) || flipped.includes(index)) return;
    if (phase === 'ready') phase = 'playing';
    flipped.push(index);
    if (flipped.length === 2) {
      moves += 1;
      const [first, second] = flipped;
      if (cards[first] === cards[second]) {
        matched.add(first);
        matched.add(second);
        flipped = [];
        hooks.playTone(480 + cards[first] * 42, 0.14);
        if (matched.size === cards.length) {
          phase = 'won';
          score = Math.max(100, 10_000 - moves * 140 - Math.floor(elapsedMs / 1000) * 25);
          hooks.recordBest(score);
          hooks.playTone(780, 0.28);
        }
      } else {
        mismatchRemaining = 720;
        hooks.playTone(145, 0.16, 'triangle');
      }
    }
    hooks.requestRender();
  };

  return {
    start,
    primaryLabel: () => 'Restart',
    update: (deltaMs) => {
      if (phase !== 'playing') return false;
      elapsedMs += deltaMs;
      if (mismatchRemaining > 0) {
        mismatchRemaining = Math.max(0, mismatchRemaining - deltaMs);
        if (mismatchRemaining === 0) flipped = [];
      }
      return true;
    },
    render: (ctx, bounds, actions, accent) => {
      const seconds = Math.floor(elapsedMs / 1000);
      ctx.fillStyle = '#9aacc4';
      ctx.font = '11px -apple-system, BlinkMacSystemFont, sans-serif';
      ctx.fillText(`PAIRS ${matched.size / 2}/8   •   MOVES ${moves}   •   TIME ${seconds}s`, bounds.x + 4, bounds.y + 20);
      ctx.textAlign = 'right';
      ctx.fillStyle = phase === 'won' ? '#b7f8de' : accent;
      ctx.fillText(phase === 'won' ? `COMPLETE • ${score.toLocaleString()} POINTS` : phase === 'ready' ? 'CHOOSE A CARD' : 'FIND THE MATCHING PAIRS', bounds.x + bounds.width - 4, bounds.y + 20);
      ctx.textAlign = 'left';
      cards.forEach((pair, index) => {
        const rect = memoryCardRect(bounds, index);
        const faceUp = flipped.includes(index) || matched.has(index);
        const color = MEMORY_COLORS[pair];
        fillRoundedRect(ctx, rect.x, rect.y, rect.width, rect.height, 14, faceUp ? `${color}24` : 'rgba(255,255,255,0.045)');
        roundedRect(ctx, rect.x, rect.y, rect.width, rect.height, 14);
        ctx.strokeStyle = matched.has(index) ? `${color}a8` : faceUp ? `${color}78` : 'rgba(255,255,255,0.12)';
        ctx.lineWidth = matched.has(index) ? 2 : 1;
        ctx.stroke();
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = faceUp ? color : 'rgba(230,238,249,0.36)';
        ctx.font = faceUp ? '600 30px -apple-system, BlinkMacSystemFont, sans-serif' : '600 22px -apple-system, BlinkMacSystemFont, sans-serif';
        ctx.fillText(faceUp ? MEMORY_SYMBOLS[pair] : '✦', rect.x + rect.width / 2, rect.y + rect.height / 2);
        ctx.textAlign = 'left';
        ctx.textBaseline = 'alphabetic';
        actions.push({ ...rect, action: () => flip(index) });
      });
      if (phase === 'won') {
        const bannerWidth = Math.min(430, bounds.width - 40);
        fillRoundedRect(ctx, bounds.x + (bounds.width - bannerWidth) / 2, bounds.y + bounds.height / 2 - 35, bannerWidth, 70, 18, 'rgba(8,14,18,0.88)');
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = '#b7f8de';
        ctx.font = '700 19px -apple-system, BlinkMacSystemFont, sans-serif';
        ctx.fillText('All pairs found', bounds.x + bounds.width / 2, bounds.y + bounds.height / 2 - 10);
        ctx.fillStyle = '#eaf3ff';
        ctx.font = '12px -apple-system, BlinkMacSystemFont, sans-serif';
        ctx.fillText(`${moves} moves • ${seconds}s • ${score.toLocaleString()} points`, bounds.x + bounds.width / 2, bounds.y + bounds.height / 2 + 16);
        ctx.textAlign = 'left';
        ctx.textBaseline = 'alphabetic';
      }
    },
    pointer: () => false,
    snapshot: () => ({
      phase,
      cards: [...cards],
      flipped: [...flipped],
      matched: [...matched].sort((first, second) => first - second),
      moves,
      elapsedMs,
      score,
      mismatchRemaining,
    }),
  };
}

export function createMemoryApp(context: ApplicationContext, options: GameAppOptions = {}): ApplicationInstance {
  return createGameApp(context, `${GAME_STORAGE_PREFIX}memory`, {
    title: 'Memory',
    subtitle: 'Match eight symbol pairs. Fewer moves and faster clears score higher.',
    accent: '#b694ff',
  }, options, createMemoryController);
}

function createEchoController({ random, hooks }: ControllerOptions): GameController {
  let phase: EchoSnapshot['phase'] = 'idle';
  let sequence: number[] = [];
  let round = 0;
  let inputIndex = 0;
  let watchStep = 0;
  let litPad: number | null = null;
  let flashRemaining = 0;
  let gapRemaining = 0;
  let feedbackPad: number | null = null;
  let feedbackCorrect = true;
  let feedbackRemaining = 0;

  const flashDuration = (): number => Math.max(280, 620 - (sequence.length - 1) * 24);

  const beginPlayback = (): void => {
    phase = 'watch';
    inputIndex = 0;
    watchStep = 0;
    litPad = sequence[0] ?? null;
    flashRemaining = flashDuration();
    gapRemaining = 0;
    feedbackPad = null;
    feedbackRemaining = 0;
    if (litPad !== null) hooks.playTone(ECHO_FREQUENCIES[litPad], flashRemaining / 1600);
  };

  const start = (): void => {
    sequence = [randomInt(random, ECHO_COLORS.length)];
    round = 1;
    beginPlayback();
    hooks.requestRender();
  };

  const pressPad = (index: number): void => {
    if (phase !== 'repeat') return;
    feedbackPad = index;
    feedbackCorrect = index === sequence[inputIndex];
    feedbackRemaining = 220;
    if (!feedbackCorrect) {
      phase = 'gameover';
      litPad = null;
      hooks.recordBest(Math.max(0, sequence.length - 1));
      hooks.playTone(110, 0.3, 'sawtooth');
      hooks.requestRender();
      return;
    }
    hooks.playTone(ECHO_FREQUENCIES[index], 0.13);
    inputIndex += 1;
    if (inputIndex === sequence.length) {
      hooks.recordBest(round);
      round += 1;
      sequence.push(randomInt(random, ECHO_COLORS.length));
      beginPlayback();
    }
    hooks.requestRender();
  };

  return {
    start,
    primaryLabel: () => phase === 'idle' ? 'Start' : 'Restart',
    update: (deltaMs) => {
      let changed = false;
      if (phase === 'watch') {
        changed = true;
        if (flashRemaining > 0) {
          flashRemaining = Math.max(0, flashRemaining - deltaMs);
          if (flashRemaining === 0) {
            litPad = null;
            gapRemaining = 170;
          }
        } else {
          gapRemaining = Math.max(0, gapRemaining - deltaMs);
          if (gapRemaining === 0) {
            watchStep += 1;
            if (watchStep < sequence.length) {
              litPad = sequence[watchStep];
              flashRemaining = flashDuration();
              hooks.playTone(ECHO_FREQUENCIES[litPad], flashRemaining / 1600);
            } else {
              phase = 'repeat';
              litPad = null;
              inputIndex = 0;
            }
          }
        }
      }
      if (feedbackRemaining > 0) {
        changed = true;
        feedbackRemaining = Math.max(0, feedbackRemaining - deltaMs);
        if (feedbackRemaining === 0) feedbackPad = null;
      }
      return changed;
    },
    render: (ctx, bounds, actions, accent) => {
      const status = phase === 'idle'
        ? 'Watch the lights, then repeat the sequence with hand pinches.'
        : phase === 'watch'
          ? `WATCH • ROUND ${round}`
          : phase === 'repeat'
            ? `YOUR TURN • ${inputIndex}/${sequence.length}`
            : `SEQUENCE ENDED • ${Math.max(0, sequence.length - 1)} ROUND${sequence.length === 2 ? '' : 'S'} COMPLETED`;
      ctx.fillStyle = phase === 'gameover' ? '#ffb3bc' : phase === 'repeat' ? '#b7f8de' : '#9aacc4';
      ctx.font = '650 11px -apple-system, BlinkMacSystemFont, sans-serif';
      ctx.fillText(status, bounds.x + 4, bounds.y + 20, bounds.width - 8);
      ECHO_COLORS.forEach((color, index) => {
        const rect = echoPadRect(bounds, index);
        const lit = litPad === index || (feedbackRemaining > 0 && feedbackPad === index);
        const wrong = lit && feedbackPad === index && !feedbackCorrect;
        const glow = ctx.createRadialGradient(rect.x + rect.width / 2, rect.y + rect.height / 2, 10, rect.x + rect.width / 2, rect.y + rect.height / 2, Math.max(rect.width, rect.height) * 0.7);
        glow.addColorStop(0, lit ? `${wrong ? '#ff8f9d' : color}70` : `${color}12`);
        glow.addColorStop(1, 'rgba(255,255,255,0)');
        fillRoundedRect(ctx, rect.x, rect.y, rect.width, rect.height, 20, glow);
        fillRoundedRect(ctx, rect.x, rect.y, rect.width, rect.height, 20, lit ? `${wrong ? '#ff8f9d' : color}42` : 'rgba(255,255,255,0.035)');
        roundedRect(ctx, rect.x, rect.y, rect.width, rect.height, 20);
        ctx.strokeStyle = lit ? `${wrong ? '#ff8f9d' : color}e6` : `${color}38`;
        ctx.lineWidth = lit ? 3 : 1;
        ctx.stroke();
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = lit ? '#ffffff' : color;
        ctx.font = '700 28px -apple-system, BlinkMacSystemFont, sans-serif';
        ctx.fillText(String(index + 1), rect.x + rect.width / 2, rect.y + rect.height / 2 - 4);
        ctx.font = '10px -apple-system, BlinkMacSystemFont, sans-serif';
        ctx.fillStyle = 'rgba(255,255,255,0.58)';
        ctx.fillText(phase === 'repeat' ? 'PINCH' : phase === 'watch' && litPad === index ? 'ECHO' : 'PAD', rect.x + rect.width / 2, rect.y + rect.height / 2 + 28);
        ctx.textAlign = 'left';
        ctx.textBaseline = 'alphabetic';
        actions.push({ ...rect, action: () => pressPad(index) });
      });
      if (phase === 'idle' || phase === 'gameover') {
        const message = phase === 'idle' ? 'Pinch Start when ready' : 'Pinch Restart to try again';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = 'rgba(7,10,14,0.78)';
        ctx.fillRect(bounds.x + bounds.width / 2 - 155, bounds.y + bounds.height / 2 - 25, 310, 50);
        ctx.fillStyle = phase === 'idle' ? accent : '#ffb3bc';
        ctx.font = '650 15px -apple-system, BlinkMacSystemFont, sans-serif';
        ctx.fillText(message, bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
        ctx.textAlign = 'left';
        ctx.textBaseline = 'alphabetic';
      }
    },
    pointer: () => false,
    snapshot: () => ({
      phase,
      sequence: [...sequence],
      round,
      inputIndex,
      watchStep,
      litPad,
      flashRemaining,
      gapRemaining,
      feedbackPad,
      feedbackCorrect,
      feedbackRemaining,
    }),
  };
}

export function createEchoApp(context: ApplicationContext, options: GameAppOptions = {}): ApplicationInstance {
  return createGameApp(context, `${GAME_STORAGE_PREFIX}echo`, {
    title: 'Echo',
    subtitle: 'Remember the growing light sequence. Each completed round raises the tempo.',
    accent: '#78f0d0',
  }, options, createEchoController);
}

function createReflexController({ random, hooks }: ControllerOptions): GameController {
  let phase: ReflexSnapshot['phase'] = 'idle';
  let remainingMs = REFLEX_ROUND_MS;
  let score = 0;
  let hits = 0;
  let misses = 0;
  let combo = 0;
  let bestCombo = 0;
  let target: ReflexSnapshot['target'] = null;
  let spawnRemaining = 0;
  let lastGain = 0;
  let area = reflexPlayArea({ x: 24, y: 92, width: 976, height: 406 });
  let feedback: { x: number; y: number; hit: boolean; remaining: number } | null = null;

  const spawn = (): void => {
    const radius = 38;
    target = {
      x: area.x + radius + 12 + randomUnit(random) * Math.max(1, area.width - (radius + 12) * 2),
      y: area.y + radius + 12 + randomUnit(random) * Math.max(1, area.height - (radius + 12) * 2),
      radius,
      remainingMs: REFLEX_TARGET_LIFE_MS,
      maxMs: REFLEX_TARGET_LIFE_MS,
    };
  };

  const finish = (): void => {
    phase = 'over';
    target = null;
    hooks.recordBest(score);
    hooks.playTone(score > 0 ? 620 : 130, 0.24, score > 0 ? 'sine' : 'triangle');
    hooks.requestRender();
  };

  const start = (): void => {
    phase = 'playing';
    remainingMs = REFLEX_ROUND_MS;
    score = 0;
    hits = 0;
    misses = 0;
    combo = 0;
    bestCombo = 0;
    target = null;
    spawnRemaining = 0;
    lastGain = 0;
    feedback = null;
    spawn();
    hooks.playTone(440, 0.1);
    hooks.requestRender();
  };

  const press = (x: number, y: number): boolean => {
    if (phase !== 'playing') return false;
    if (target && targetContains(target, x, y)) {
      hits += 1;
      combo += 1;
      bestCombo = Math.max(bestCombo, combo);
      lastGain = 100 + Math.min(combo, 10) * 10 + Math.round((target.remainingMs / target.maxMs) * 50);
      score += lastGain;
      feedback = { x: target.x, y: target.y, hit: true, remaining: 240 };
      target = null;
      spawnRemaining = 180;
      hooks.playTone(520 + Math.min(combo, 8) * 35, 0.07);
      hooks.requestRender();
      return true;
    }
    if (x < area.x || y < area.y || x > area.x + area.width || y > area.y + area.height) return false;
    misses += 1;
    combo = 0;
    score = Math.max(0, score - 25);
    lastGain = -25;
    feedback = { x, y, hit: false, remaining: 240 };
    hooks.playTone(120, 0.08, 'triangle');
    hooks.requestRender();
    return true;
  };

  return {
    start,
    primaryLabel: () => phase === 'idle' ? 'Start' : 'Restart',
    update: (deltaMs) => {
      if (phase !== 'playing') {
        if (feedback && feedback.remaining > 0) {
          feedback.remaining = Math.max(0, feedback.remaining - deltaMs);
          return true;
        }
        return false;
      }
      remainingMs = Math.max(0, remainingMs - deltaMs);
      if (remainingMs === 0) {
        finish();
        return true;
      }
      if (target) {
        target.remainingMs = Math.max(0, target.remainingMs - deltaMs);
        if (target.remainingMs === 0) {
          target = null;
          misses += 1;
          combo = 0;
          spawnRemaining = 160;
        }
      } else {
        spawnRemaining = Math.max(0, spawnRemaining - deltaMs);
        if (spawnRemaining === 0) spawn();
      }
      if (feedback) {
        feedback.remaining = Math.max(0, feedback.remaining - deltaMs);
        if (feedback.remaining === 0) feedback = null;
      }
      return true;
    },
    render: (ctx, bounds, _actions, accent) => {
      area = reflexPlayArea(bounds);
      ctx.fillStyle = '#9aacc4';
      ctx.font = '11px -apple-system, BlinkMacSystemFont, sans-serif';
      ctx.fillText(`TIME ${(remainingMs / 1000).toFixed(1)}s   •   HITS ${hits}   •   MISSES ${misses}   •   COMBO ${combo}`, bounds.x + 4, bounds.y + 20);
      ctx.textAlign = 'right';
      ctx.fillStyle = accent;
      ctx.font = '650 13px -apple-system, BlinkMacSystemFont, sans-serif';
      ctx.fillText(score.toLocaleString(), bounds.x + bounds.width - 4, bounds.y + 20);
      ctx.textAlign = 'left';
      fillRoundedRect(ctx, bounds.x, bounds.y + 30, bounds.width, 5, 3, 'rgba(255,255,255,0.08)');
      if (remainingMs > 0) fillRoundedRect(ctx, bounds.x, bounds.y + 30, bounds.width * (remainingMs / REFLEX_ROUND_MS), 5, 3, accent);
      fillRoundedRect(ctx, area.x, area.y, area.width, area.height, 18, 'rgba(255,255,255,0.022)');
      roundedRect(ctx, area.x, area.y, area.width, area.height, 18);
      ctx.strokeStyle = 'rgba(255,255,255,0.08)';
      ctx.lineWidth = 1;
      ctx.stroke();
      if (target) {
        const progress = target.remainingMs / target.maxMs;
        const glow = ctx.createRadialGradient(target.x, target.y, 4, target.x, target.y, target.radius * 2.2);
        glow.addColorStop(0, 'rgba(255,179,124,0.38)');
        glow.addColorStop(1, 'rgba(255,179,124,0)');
        ctx.fillStyle = glow;
        ctx.beginPath();
        ctx.arc(target.x, target.y, target.radius * 2.2, 0, Math.PI * 2);
        ctx.fill();
        ctx.beginPath();
        ctx.arc(target.x, target.y, target.radius, 0, Math.PI * 2);
        ctx.fillStyle = '#ffb37c';
        ctx.fill();
        ctx.beginPath();
        ctx.arc(target.x, target.y, target.radius - 7, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(255,255,255,0.72)';
        ctx.lineWidth = 3;
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(target.x, target.y, target.radius + 6, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * progress);
        ctx.strokeStyle = '#fff2df';
        ctx.lineWidth = 3;
        ctx.stroke();
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = '#25150c';
        ctx.font = '700 20px -apple-system, BlinkMacSystemFont, sans-serif';
        ctx.fillText('+', target.x, target.y - 1);
        ctx.textAlign = 'left';
        ctx.textBaseline = 'alphabetic';
      }
      if (feedback) {
        ctx.globalAlpha = Math.min(1, feedback.remaining / 160);
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = feedback.hit ? '#b7f8de' : '#ffb3bc';
        ctx.font = '700 18px -apple-system, BlinkMacSystemFont, sans-serif';
        ctx.fillText(feedback.hit ? `+${lastGain}` : 'MISS', feedback.x, feedback.y - 24);
        ctx.textAlign = 'left';
        ctx.textBaseline = 'alphabetic';
        ctx.globalAlpha = 1;
      }
      if (phase === 'idle' || phase === 'over') {
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = phase === 'idle' ? accent : '#ffd28a';
        ctx.font = '700 22px -apple-system, BlinkMacSystemFont, sans-serif';
        ctx.fillText(phase === 'idle' ? '30-second reflex round' : 'Round complete', area.x + area.width / 2, area.y + area.height / 2 - 18);
        ctx.fillStyle = '#eaf3ff';
        ctx.font = '13px -apple-system, BlinkMacSystemFont, sans-serif';
        ctx.fillText(phase === 'idle' ? 'Pinch Start, then hit each target before its ring closes.' : `${score.toLocaleString()} points • ${hits} hits • best combo ${bestCombo}`, area.x + area.width / 2, area.y + area.height / 2 + 14);
        ctx.textAlign = 'left';
        ctx.textBaseline = 'alphabetic';
      }
    },
    pointer: press,
    snapshot: () => ({
      phase,
      remainingMs,
      score,
      hits,
      misses,
      combo,
      bestCombo,
      target: target ? { ...target } : null,
      spawnRemaining,
      lastGain,
    }),
  };
}

export function createReflexApp(context: ApplicationContext, options: GameAppOptions = {}): ApplicationInstance {
  return createGameApp(context, `${GAME_STORAGE_PREFIX}reflex`, {
    title: 'Reflex',
    subtitle: 'Hit hand-targeted circles before they expire. Combos multiply the score.',
    accent: '#ffb37c',
  }, options, createReflexController);
}
