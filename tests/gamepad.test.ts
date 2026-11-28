import { describe, expect, it } from 'vitest';
import { GamepadMapper, type GamepadDevice } from '../src/input/gamepad';

function gamepad(overrides: Partial<GamepadDevice> = {}): GamepadDevice {
  return {
    id: 'Test controller',
    index: 0,
    mapping: 'standard',
    axes: [0, 0, 0, 0],
    buttons: Array.from({ length: 17 }, () => ({ pressed: false, value: 0, touched: false })),
    ...overrides,
  };
}

function press(device: GamepadDevice, index: number): void {
  device.buttons = device.buttons.map((button, buttonIndex) => buttonIndex === index ? { pressed: true, value: 1, touched: true } : button);
}

function release(device: GamepadDevice, index: number): void {
  device.buttons = device.buttons.map((button, buttonIndex) => buttonIndex === index ? { pressed: false, value: 0, touched: false } : button);
}

describe('gamepad mapper', () => {
  it('reports connection and ignores buttons already held on the first frame', () => {
    const device = gamepad();
    press(device, 0);
    const mapper = new GamepadMapper(() => [device]);
    const first = mapper.update(1 / 60);
    expect(first.connectionChanged).toBe(true);
    expect(first.gamepad?.id).toBe('Test controller');
    expect(first.pressed).toEqual([]);
    expect(first.held).toContain('a');
    release(device, 0);
    mapper.update(1 / 60);
    press(device, 0);
    expect(mapper.update(1 / 60).pressed).toEqual(['a']);
  });

  it('applies deadzones and separates movement from camera look', () => {
    const device = gamepad({ axes: [0.1, -0.1, 0.8, -0.7] });
    const mapper = new GamepadMapper(() => [device]);
    const frame = mapper.update(1 / 60);
    expect(frame.moveX).toBe(0);
    expect(frame.moveY).toBe(0);
    expect(frame.lookX).toBeCloseTo((0.8 - 0.18) / 0.82);
    expect(frame.lookY).toBeCloseTo(-(0.7 - 0.18) / 0.82);
  });

  it('supports analog triggers and repeated directional input', () => {
    const device = gamepad();
    device.buttons = device.buttons.map((button, index) => index === 6 ? { pressed: false, value: 0.6, touched: true } : button);
    press(device, 15);
    const mapper = new GamepadMapper(() => [device]);
    expect(mapper.update(0.05).held).toEqual(expect.arrayContaining(['lt', 'right']));
    let repeated = false;
    for (let index = 0; index < 8; index += 1) {
      if (mapper.update(0.1).pressed.includes('right')) repeated = true;
    }
    expect(repeated).toBe(true);
  });

  it('accepts controllers that expose the D-pad as axes', () => {
    const device = gamepad({ axes: [0, 0, 0, 0, 1, -1] });
    const mapper = new GamepadMapper(() => [device]);
    expect(mapper.update(1 / 60).held).toEqual(expect.arrayContaining(['right', 'up']));
  });

  it('prefers a standard-mapping controller and does not guess non-standard controls', () => {
    const nonStandard = gamepad({ id: 'Legacy pad', index: 0, mapping: '', axes: [1, 0, 1, 0] });
    press(nonStandard, 0);
    const standard = gamepad({ id: 'Standard pad', index: 1, axes: [0, 0, 0, 0] });
    const mapper = new GamepadMapper(() => [nonStandard, standard]);
    const first = mapper.update(1 / 60);
    expect(first.gamepad?.id).toBe('Standard pad');
    expect(first.held).toEqual([]);
    expect(first.moveX).toBe(0);
    press(standard, 0);
    expect(mapper.update(1 / 60).pressed).toEqual(['a']);
  });

  it('reports a non-standard controller without issuing guessed commands', () => {
    const device = gamepad({ mapping: 'non-standard', axes: [1, -1, 1, -1] });
    press(device, 0);
    const mapper = new GamepadMapper(() => [device]);
    const frame = mapper.update(1 / 60);
    expect(frame.gamepad?.mapping).toBe('non-standard');
    expect(frame.pressed).toEqual([]);
    expect(frame.held).toEqual([]);
    expect([frame.moveX, frame.moveY, frame.lookX, frame.lookY]).toEqual([0, 0, 0, 0]);
  });

  it('distinguishes controllers that share a browser-reported id', () => {
    const first = gamepad({ index: 0 });
    const replacement = gamepad({ index: 1 });
    press(replacement, 0);
    let devices: Array<GamepadDevice | null> = [first, replacement];
    const mapper = new GamepadMapper(() => devices);
    expect(mapper.update(1 / 60).gamepad?.index).toBe(0);
    devices = [replacement];
    const switched = mapper.update(1 / 60);
    expect(switched.connectionChanged).toBe(true);
    expect(switched.gamepad?.index).toBe(1);
    expect(switched.pressed).toEqual([]);
    release(replacement, 0);
    mapper.update(1 / 60);
    press(replacement, 0);
    expect(mapper.update(1 / 60).pressed).toEqual(['a']);
  });

  it('clears held input without fabricating a reconnect', () => {
    const device = gamepad();
    press(device, 0);
    const mapper = new GamepadMapper(() => [device]);
    expect(mapper.update(1 / 60).connectionChanged).toBe(true);
    mapper.resetInput();
    const frame = mapper.update(1 / 60);
    expect(frame.connectionChanged).toBe(false);
    expect(frame.pressed).toEqual([]);
    expect(frame.held).toEqual(['a']);
  });

  it('clears held input and reports disconnection', () => {
    const device = gamepad();
    press(device, 0);
    let devices: Array<GamepadDevice | null> = [device];
    const mapper = new GamepadMapper(() => devices);
    mapper.update(1 / 60);
    devices = [];
    const frame = mapper.update(1 / 60);
    expect(frame.connectionChanged).toBe(true);
    expect(frame.gamepad).toBeNull();
    expect(frame.held).toEqual([]);
    expect(frame.pressed).toEqual([]);
    mapper.reset();
  });
});
