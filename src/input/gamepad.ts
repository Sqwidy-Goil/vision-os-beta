import type { GamepadSummary } from '../core/deviceCapabilities';

export type GamepadControl =
  | 'a' | 'b' | 'x' | 'y'
  | 'lb' | 'rb' | 'lt' | 'rt'
  | 'back' | 'start' | 'ls' | 'rs' | 'home'
  | 'up' | 'down' | 'left' | 'right';

export type GamepadCommand = 'back' | 'launcher' | 'settings' | 'keyboard' | 'windows' | 'environment' | 'guide';

export interface GamepadDevice {
  id: string;
  index: number;
  mapping?: string;
  axes: ReadonlyArray<number>;
  buttons: ReadonlyArray<{ pressed: boolean; value: number; touched?: boolean }>;
}

export interface GamepadFrame {
  gamepads: GamepadSummary[];
  gamepad: GamepadSummary | null;
  connectionChanged: boolean;
  pressed: GamepadControl[];
  held: GamepadControl[];
  moveX: number;
  moveY: number;
  lookX: number;
  lookY: number;
}

const BUTTONS: GamepadControl[] = [
  'a', 'b', 'x', 'y', 'lb', 'rb', 'lt', 'rt', 'back', 'start', 'ls', 'rs',
  'up', 'down', 'left', 'right', 'home',
];
const DIRECTIONS = new Set<GamepadControl>(['up', 'down', 'left', 'right']);
const DEADZONE = 0.18;
const REPEAT_DELAY = 0.42;
const REPEAT_INTERVAL = 0.14;

function finiteAxis(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function deadzone(value: number): number {
  const magnitude = Math.abs(value);
  if (magnitude <= DEADZONE) return 0;
  return Math.sign(value) * Math.min(1, (magnitude - DEADZONE) / (1 - DEADZONE));
}

function readDevices(getGamepads: (() => ReadonlyArray<GamepadDevice | null>) | undefined): GamepadDevice[] {
  if (typeof getGamepads !== 'function') return [];
  try {
    return getGamepads().filter((gamepad): gamepad is GamepadDevice => Boolean(gamepad));
  } catch {
    return [];
  }
}

export class GamepadMapper {
  private readonly held = new Set<GamepadControl>();
  private readonly nextRepeat = new Map<GamepadControl, number>();
  private elapsed = 0;
  private activeId: string | null = null;
  private activeIndex: number | null = null;
  private initialized = false;

  constructor(private readonly getGamepads?: () => ReadonlyArray<GamepadDevice | null>) {}

  update(delta: number): GamepadFrame {
    this.elapsed += Math.max(0, Math.min(delta, 0.1));
    const devices = readDevices(this.getGamepads);
    const gamepads = devices.map(({ id, index, mapping }) => ({ id, index, mapping: mapping || 'non-standard' }));
    const device = devices.find((gamepad) => gamepad.mapping === 'standard') ?? devices[0] ?? null;
    const id = device?.id ?? null;
    const index = device?.index ?? null;
    const connectionChanged = id !== this.activeId || index !== this.activeIndex;
    this.activeId = id;
    this.activeIndex = index;
    if (connectionChanged || !device) {
      this.held.clear();
      this.nextRepeat.clear();
      this.initialized = false;
    }

    const down = new Set<GamepadControl>();
    const standardMapping = device?.mapping === 'standard';
    if (device && standardMapping) {
      device.buttons.forEach((button, index) => {
        const control = BUTTONS[index];
        if (!control) return;
        const pressed = control === 'lt' || control === 'rt' ? button.value >= 0.35 : button.pressed || button.value >= 0.5;
        if (pressed) down.add(control);
      });
      const axisX = finiteAxis(device.axes[0]);
      const axisY = finiteAxis(device.axes[1]);
      if (axisX < -0.55) down.add('left');
      if (axisX > 0.55) down.add('right');
      if (axisY < -0.55) down.add('up');
      if (axisY > 0.55) down.add('down');
      const buttonDown = (index: number): boolean => {
        const button = device.buttons[index];
        return Boolean(button && (button.pressed || button.value >= 0.5));
      };
      const usesLateDpadAxes = device.axes.length >= 8 && (Math.abs(finiteAxis(device.axes[6])) > 0.1 || Math.abs(finiteAxis(device.axes[7])) > 0.1);
      const dpadAxis = usesLateDpadAxes ? 6 : device.axes.length >= 6 ? 4 : -1;
      if (dpadAxis >= 0) {
        const horizontal = finiteAxis(device.axes[dpadAxis]);
        const vertical = finiteAxis(device.axes[dpadAxis + 1]);
        if (!buttonDown(14) && horizontal < -0.55) down.add('left');
        if (!buttonDown(15) && horizontal > 0.55) down.add('right');
        if (!buttonDown(12) && vertical < -0.55) down.add('up');
        if (!buttonDown(13) && vertical > 0.55) down.add('down');
      }
    }

    const pressed: GamepadControl[] = [];
    if (device) {
      for (const control of down) {
        if (!this.initialized) {
          if (DIRECTIONS.has(control)) this.nextRepeat.set(control, this.elapsed + REPEAT_DELAY);
          continue;
        }
        const wasHeld = this.held.has(control);
        if (!wasHeld) {
          pressed.push(control);
          this.nextRepeat.set(control, this.elapsed + (DIRECTIONS.has(control) ? REPEAT_DELAY : Infinity));
        } else if (DIRECTIONS.has(control) && this.elapsed >= (this.nextRepeat.get(control) ?? Infinity)) {
          pressed.push(control);
          this.nextRepeat.set(control, this.elapsed + REPEAT_INTERVAL);
        }
      }
    }
    this.initialized = true;
    this.held.clear();
    for (const control of down) this.held.add(control);

    return {
      gamepads,
      gamepad: device ? gamepads.find((gamepad) => gamepad.index === device.index) ?? null : null,
      connectionChanged,
      pressed,
      held: [...down],
      moveX: standardMapping ? deadzone(finiteAxis(device?.axes[0])) : 0,
      moveY: standardMapping ? deadzone(finiteAxis(device?.axes[1])) : 0,
      lookX: standardMapping ? deadzone(finiteAxis(device?.axes[2])) : 0,
      lookY: standardMapping ? deadzone(finiteAxis(device?.axes[3])) : 0,
    };
  }

  resetInput(): void {
    this.held.clear();
    this.nextRepeat.clear();
    this.initialized = false;
  }

  reset(): void {
    this.resetInput();
    this.activeId = null;
    this.activeIndex = null;
  }
}
