import { Euler, Quaternion, Vector3 } from 'three';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createWindowManagerApp } from '../src/applications/system';
import { windowHitRegion, WINDOW_CHROME_HEIGHT, WINDOW_CONTROL_ACTIONS, WINDOW_CONTROL_HIT_RADIUS, WINDOW_CONTROL_OFFSETS, WINDOW_CONTROL_Y } from '../src/spatial/canvasUi';
import { overlayTransformMatrix } from '../src/spatial/scene';
import { SpatialWindow, type WindowHooks } from '../src/spatial/window';
import { createWindowState, nextWindowMode, restoreWindowState, surroundLayout } from '../src/spatial/windowState';
import { DEFAULT_SETTINGS, type AppSettings, type ApplicationContext, type ApplicationDefinition, type ApplicationInstance, type WindowPoseState, type WindowState } from '../src/types';

function expectQuaternion(actual: WindowState['quaternion'], expected: WindowState['quaternion']): void {
  const first = new Quaternion(actual.x, actual.y, actual.z, actual.w);
  const second = new Quaternion(expected.x, expected.y, expected.z, expected.w);
  expect(first.length()).toBeCloseTo(1, 8);
  expect(Math.abs(first.dot(second))).toBeCloseTo(1, 8);
}

function quaternionState(value: Quaternion): WindowState['quaternion'] {
  return { x: value.x, y: value.y, z: value.z, w: value.w };
}

const openWindows: SpatialWindow[] = [];

afterEach(() => {
  openWindows.splice(0).forEach((window) => window.destroy());
  vi.unstubAllGlobals();
});

function createTestWindow(appState: unknown = { value: 1 }, orientation?: WindowState['quaternion'], settings: Partial<AppSettings> = {}) {
  const gradient = { addColorStop: vi.fn() };
  const context = {
    globalAlpha: 1,
    clearRect: vi.fn(),
    save: vi.fn(),
    restore: vi.fn(),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    arcTo: vi.fn(),
    closePath: vi.fn(),
    rect: vi.fn(),
    clip: vi.fn(),
    translate: vi.fn(),
    arc: vi.fn(),
    fill: vi.fn(),
    stroke: vi.fn(),
    fillRect: vi.fn(),
    fillText: vi.fn(),
    measureText: vi.fn(() => ({ width: 0 })),
    createLinearGradient: vi.fn(() => gradient),
    createRadialGradient: vi.fn(() => gradient),
  };
  const canvas = { width: 0, height: 0, getContext: vi.fn(() => context) } as unknown as HTMLCanvasElement;
  vi.stubGlobal('document', { createElement: vi.fn(() => canvas) });
  const instance: ApplicationInstance = {
    render: vi.fn(),
    restore: vi.fn(),
    serialize: vi.fn(() => ({ value: 2 })),
    destroy: vi.fn(),
  };
  const definition: ApplicationDefinition = {
    id: 'test',
    name: 'Test',
    icon: '',
    color: '#75e7ff',
    description: '',
    create: () => instance,
  };
  const hooks = {
    getSettings: () => ({ ...DEFAULT_SETTINGS, ...settings }),
    toggleWindowAnchor: vi.fn(() => true),
    moveWindowDepth: vi.fn(),
  } as unknown as WindowHooks;
  const state = createWindowState('test', 0, { ...DEFAULT_SETTINGS, ...settings });
  state.appState = appState;
  if (orientation) state.quaternion = orientation;
  const window = new SpatialWindow(state, definition, hooks, { append: vi.fn() } as unknown as HTMLElement);
  openWindows.push(window);
  return { window, hooks, instance };
}

describe('spatial window state', () => {
  it('creates independent quaternion-authoritative world-locked windows', () => {
    const first = createWindowState('camera', 0);
    const second = createWindowState('camera', 1);
    expect(first.id).not.toBe(second.id);
    expect(first.schemaVersion).toBe(2);
    expect(first.mode).toBe('world');
    expect(first.position.z).toBeLessThan(-2);
    expect(first.quaternion).toEqual({ x: 0, y: 0, z: 0, w: 1 });
    expect(first.rotation).toEqual({ x: 0, y: 0, z: 0 });
    first.position.x = 99;
    first.quaternion.w = 0;
    expect(second.position.x).not.toBe(99);
    expect(second.quaternion.w).toBe(1);
  });

  it('restores and clamps untrusted values while treating quaternions as authoritative', () => {
    const expected = new Quaternion().setFromEuler(new Euler(0.3, -0.4, 0.2, 'YXZ'));
    const restored = restoreWindowState({
      id: 'saved-window',
      appId: 'photos',
      title: 'Saved photos',
      position: { x: 999, y: 0, z: -1 },
      size: { width: -4, height: 999 },
      quaternion: { x: expected.x * 2, y: expected.y * 2, z: expected.z * 2, w: expected.w * 2 },
      rotation: { x: 0, y: 0, z: 0 },
      mode: 'invalid',
      minimized: true,
      maximized: false,
      z: 4,
    }, 0);
    expect(restored).not.toBeNull();
    expect(restored?.position.x).toBe(18);
    expect(restored?.position.z).toBe(-2.2);
    expect(restored?.size.width).toBe(1.2);
    expect(restored?.size.height).toBe(5);
    expect(restored?.mode).toBe(DEFAULT_SETTINGS.headLockDefault ? 'head' : 'world');
    expect(restored?.minimized).toBe(true);
    expect(restored?.schemaVersion).toBe(2);
    expectQuaternion(restored!.quaternion, quaternionState(expected));
    const derived = new Quaternion().setFromEuler(new Euler(restored!.rotation.x, restored!.rotation.y, restored!.rotation.z, 'YXZ'));
    expect(Math.abs(derived.dot(expected))).toBeCloseTo(1, 8);
  });

  it('migrates legacy table anchors to a quaternion-authoritative legacy world anchor', () => {
    const restored = restoreWindowState({
      id: 'legacy-table-window',
      appId: 'browser',
      title: 'Legacy table browser',
      position: { x: 0, y: -1, z: -4 },
      size: { width: 3, height: 2 },
      rotation: { x: -1, y: 0, z: 0 },
      anchor: 'table',
      mode: 'head',
      minimized: false,
      maximized: false,
      z: 2,
    }, 0);
    const expected = new Quaternion().setFromEuler(new Euler(-1, 0, 0, 'YXZ'));
    expect(restored?.schemaVersion).toBe(2);
    expect(restored?.anchor).toBe('legacy-world');
    expect(restored?.anchorKind).toBe('world');
    expect(restored?.mode).toBe('world');
    expect(restored?.position).toEqual({ x: 0, y: -1, z: -4 });
    expectQuaternion(restored!.quaternion, quaternionState(expected));
  });

  it('cycles through all anchoring modes', () => {
    expect(nextWindowMode('world')).toBe('head');
    expect(nextWindowMode('head')).toBe('individual');
    expect(nextWindowMode('individual')).toBe('world');
  });

  it('arranges quaternion-oriented windows in world-space rows that face the viewer', () => {
    const layout = surroundLayout(5);
    expect(layout).toHaveLength(5);
    expect(layout[0].position.x).toBeLessThan(layout[3].position.x);
    expect(layout.every((placement) => placement.position.z < -7)).toBe(true);
    expect(layout[0].rotation.y).toBeCloseTo(-Math.asin(layout[0].position.x / Math.hypot(layout[0].position.x, layout[0].position.z)));
    expect(layout[4].position.y).toBeLessThan(layout[0].position.y);
    layout.forEach((placement) => {
      const orientation = new Quaternion(placement.quaternion.x, placement.quaternion.y, placement.quaternion.z, placement.quaternion.w);
      const normal = new Vector3(0, 0, 1).applyQuaternion(orientation);
      const towardViewer = new Vector3(-placement.position.x, 0, -placement.position.z).normalize();
      expect(orientation.length()).toBeCloseTo(1, 8);
      expect(normal.dot(towardViewer)).toBeCloseTo(1, 8);
    });
    expect(surroundLayout(0)).toEqual([]);
  });

  it('maps enlarged top-origin canvas controls from bottom-origin plane UVs', () => {
    const v = 1 - WINDOW_CONTROL_Y / 640;
    expect(windowHitRegion(300 / 1024, v, 1024, 640)).toEqual({ action: 'drag' });
    expect(WINDOW_CONTROL_ACTIONS).toEqual(['close', 'minimize', 'maximize', 'mode', 'rotate', 'roll', 'depth', 'anchor']);
    WINDOW_CONTROL_ACTIONS.forEach((action, index) => {
      expect(windowHitRegion((1024 - WINDOW_CONTROL_OFFSETS[index]) / 1024, v, 1024, 640)).toEqual({ action });
      if (index > 0) {
        const gapX = 1024 - (WINDOW_CONTROL_OFFSETS[index - 1] + WINDOW_CONTROL_OFFSETS[index]) / 2;
        expect(windowHitRegion(gapX / 1024, v, 1024, 640)).toEqual({ action: 'drag' });
      }
    });
    expect(windowHitRegion(1020 / 1024, 1 - 632 / 640, 1024, 640)).toEqual({ action: 'resize' });
    expect(windowHitRegion(0.5, 0.5, 1024, 640)).toEqual({ action: 'content', contentX: 512, contentY: 320 - WINDOW_CHROME_HEIGHT });
    expect(windowHitRegion((1024 - WINDOW_CONTROL_OFFSETS[0] + WINDOW_CONTROL_HIT_RADIUS + 1) / 1024, v, 1024, 640)).toEqual({ action: 'drag' });
  });

  it('round-trips the complete quaternion pose saved by a maximized window', () => {
    const orientation = new Quaternion().setFromEuler(new Euler(0.2, -0.4, 0.1, 'YXZ'));
    const original: WindowPoseState = {
      position: { x: 2, y: 1, z: -8 },
      quaternion: quaternionState(orientation),
      size: { width: 3.5, height: 2.25 },
    };
    const restored = restoreWindowState({
      id: 'maximized-window',
      appId: 'browser',
      position: { x: 0, y: 0, z: -6 },
      quaternion: { x: 0, y: 0, z: 0, w: 1 },
      size: { width: 5.6, height: 3.5 },
      maximized: true,
      restore: original,
      appState: { query: 'saved' },
      z: 5,
    }, 0);
    expect(restored?.maximized).toBe(true);
    expect(restored?.restore).toEqual(original);
    const roundTrip = restoreWindowState(JSON.parse(JSON.stringify(restored)), 0);
    expect(roundTrip?.schemaVersion).toBe(2);
    expect(roundTrip?.maximized).toBe(true);
    expect(roundTrip?.restore).toEqual(original);
    expect(roundTrip?.appState).toEqual({ query: 'saved' });
  });

  it('restores pinned windows as immutable world placements', () => {
    const restored = restoreWindowState({
      id: 'pinned-window',
      appId: 'browser',
      title: 'Pinned browser',
      position: { x: 2, y: 1, z: -5 },
      size: { width: 3, height: 2 },
      rotation: { x: 0, y: 0.2, z: 0 },
      mode: 'head',
      minimized: false,
      maximized: true,
      pinned: true,
      z: 3,
    }, 0);
    expect(restored?.pinned).toBe(true);
    expect(restored?.mode).toBe('world');
    expect(restored?.anchor).toBe('legacy-world');
    expect(restored?.anchorKind).toBe('world');
    expect(restored?.maximized).toBe(false);
    expect(restored?.restore).toBeUndefined();
    expect(restored?.position).toEqual({ x: 2, y: 1, z: -5 });
    expect(restored?.schemaVersion).toBe(2);
    const expected = new Quaternion().setFromEuler(new Euler(0, 0.2, 0, 'YXZ'));
    expectQuaternion(restored!.quaternion, quaternionState(expected));
  });

  it('preserves pinned world transforms outside normal window limits', () => {
    const restored = restoreWindowState({
      id: 'pinned-behind',
      appId: 'browser',
      position: { x: 1, y: 2, z: 1.5 },
      rotation: { x: 0.2, y: 2.8, z: 0.1 },
      mode: 'head',
      pinned: true,
    }, 0);
    expect(restored?.position).toEqual({ x: 1, y: 2, z: 1.5 });
    expect(restored?.rotation.y).toBeCloseTo(2.8);
    expect(restored?.mode).toBe('world');
    expect(restored?.anchor).toBe('legacy-world');
    expect(restored?.quaternion.w).toBeGreaterThanOrEqual(0);
  });

  it('renders and serializes SpatialWindow transforms from authoritative quaternions', () => {
    const expected = new Quaternion().setFromEuler(new Euler(0.3, -0.7, 0.2, 'YXZ'));
    const { window, hooks, instance } = createTestWindow({ value: 1 }, {
      x: expected.x * 2,
      y: expected.y * 2,
      z: expected.z * 2,
      w: expected.w * 2,
    });
    expectQuaternion(window.state.quaternion, quaternionState(expected));
    expect(Math.abs(window.group.quaternion.dot(expected))).toBeCloseTo(1, 8);

    const pose: WindowPoseState = {
      position: { x: 1.5, y: -0.5, z: -7 },
      quaternion: { x: expected.x, y: expected.y, z: expected.z, w: expected.w },
      size: { width: 5, height: 3 },
    };
    window.api.setPose(pose);
    expect(window.state.position).toEqual(pose.position);
    expect(window.state.size).toEqual(pose.size);
    expectQuaternion(window.state.quaternion, pose.quaternion);
    window.api.toggleAnchor();
    window.api.moveDepth(-0.5);
    expect(hooks.toggleWindowAnchor).toHaveBeenCalledWith(window.state.id);
    expect(hooks.moveWindowDepth).toHaveBeenCalledWith(window.state.id, -0.5);
    expect(instance.restore).toHaveBeenCalledWith({ value: 1 });
    window.api.requestRender();
    expect(window.state.appState).toEqual({ value: 2 });
    expect(instance.serialize).toHaveBeenCalled();
  });

  it('keeps world-window coordinates independent of the VR distance setting', () => {
    const near = createTestWindow({}, undefined, { vrDistance: 2 });
    const far = createTestWindow({}, undefined, { vrDistance: 12 });
    for (const { window } of [near, far]) {
      window.state.position = { x: 1.5, y: -0.5, z: -7 };
      window.updateTransform(new Vector3(2, 3, 4), new Quaternion(), true);
    }
    expect(near.window.group.position.toArray()).toEqual(far.window.group.position.toArray());
    expect(near.window.group.position.toArray()).toEqual([1.5, -0.5, -7]);
  });

  it('applies glass transparency to application content as well as chrome', () => {
    const opaque = createTestWindow({}, undefined, { glassTransparency: 0 });
    const clear = createTestWindow({}, undefined, { glassTransparency: 1 });
    const alphas: number[] = [];
    for (const { window, instance } of [opaque, clear]) {
      (instance.render as ReturnType<typeof vi.fn>).mockImplementation((context: CanvasRenderingContext2D) => {
        alphas.push(context.globalAlpha);
      });
      window.render(0, true);
    }
    expect(alphas[0]).toBeCloseTo(0.98);
    expect(alphas[1]).toBeCloseTo(0.5);
    expect(alphas[1]).toBeLessThan(alphas[0]);
  });

  it('restores the full pose after maximize and applies local-axis roll', () => {
    const { window } = createTestWindow();
    const orientation = new Quaternion().setFromEuler(new Euler(0.2, -0.4, 0.1, 'YXZ'));
    const original: WindowPoseState = {
      position: { x: 2, y: 1, z: -8 },
      quaternion: quaternionState(orientation),
      size: { width: 3.5, height: 2.25 },
    };
    window.api.setPose(original);
    const z = window.state.z;
    window.api.maximize();
    expect(window.state.maximized).toBe(true);
    expect(window.state.restore).toEqual(original);
    expect(window.state.quaternion).toEqual({ x: 0, y: 0, z: 0, w: 1 });
    window.api.maximize();
    expect(window.state.maximized).toBe(false);
    expect(window.state.restore).toBeUndefined();
    expect(window.state.position).toEqual(original.position);
    expect(window.state.size).toEqual(original.size);
    expectQuaternion(window.state.quaternion, original.quaternion);
    expect(window.state.z).toBe(z);

    const roll = Math.PI / 2;
    expect(window.roll(roll)).toBe(true);
    const expected = orientation.clone().multiply(new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), roll));
    expectQuaternion(window.state.quaternion, quaternionState(expected));
    window.state.pinned = true;
    expect(window.roll(roll)).toBe(false);
  });

  it('uses manager-facing anchor and depth actions without mutating window records', () => {
    const state = createWindowState('browser', 0);
    state.id = 'managed-window';
    state.anchor = 'legacy-world';
    const context = {
      listWindows: vi.fn(() => [state]),
      arrangeWindows: vi.fn(),
      toggleWindowAnchor: vi.fn(),
      moveWindowDepth: vi.fn(),
      toggleWindowPin: vi.fn(),
      focusWindow: vi.fn(),
      closeWindow: vi.fn(),
    } as unknown as ApplicationContext;
    const gradient = { addColorStop: vi.fn() };
    const fillText = vi.fn();
    const canvasContext = {
      beginPath: vi.fn(),
      moveTo: vi.fn(),
      arcTo: vi.fn(),
      closePath: vi.fn(),
      fill: vi.fn(),
      stroke: vi.fn(),
      fillRect: vi.fn(),
      arc: vi.fn(),
      createLinearGradient: vi.fn(() => gradient),
      measureText: vi.fn(() => ({ width: 0 })),
      fillText,
    } as unknown as CanvasRenderingContext2D;
    const app = createWindowManagerApp(context);
    const before = JSON.stringify(state);
    app.render(canvasContext, 1024, 640, 0);
    expect(fillText.mock.calls.some(([label]) => /table/i.test(String(label)))).toBe(false);
    app.pointer?.(710, 22, {} as PointerEvent);
    app.pointer?.(625, 79, {} as PointerEvent);
    app.pointer?.(693, 79, {} as PointerEvent);
    app.pointer?.(829, 79, {} as PointerEvent);
    app.pointer?.(897, 79, {} as PointerEvent);
    app.pointer?.(965, 79, {} as PointerEvent);
    expect(context.toggleWindowAnchor).toHaveBeenNthCalledWith(1, state.id);
    expect(context.toggleWindowAnchor).toHaveBeenNthCalledWith(2, state.id);
    expect(context.moveWindowDepth).toHaveBeenNthCalledWith(1, state.id, 0.5);
    expect(context.moveWindowDepth).toHaveBeenNthCalledWith(2, state.id, -0.5);
    expect(context.focusWindow).toHaveBeenCalledWith(state.id);
    expect(context.closeWindow).toHaveBeenCalledWith(state.id);
    expect(JSON.stringify(state)).toBe(before);
  });

  it('projects rotated and perspective overlay corners without swapping matrix terms', () => {
    const project = (points: Array<{ x: number; y: number }>) => {
      const matrix = overlayTransformMatrix(points, 200, 100);
      return points.map((_, index) => {
        const x = index % 3 === 0 ? 0 : 200;
        const y = index < 2 ? 0 : 100;
        return [
          (matrix[0] * x + matrix[4] * y + matrix[12]) / (matrix[3] * x + matrix[7] * y + 1),
          (matrix[1] * x + matrix[5] * y + matrix[13]) / (matrix[3] * x + matrix[7] * y + 1),
        ];
      });
    };
    const rotated = [
      { x: 40, y: 20 },
      { x: 190, y: 80 },
      { x: 150, y: 140 },
      { x: 0, y: 80 },
    ];
    const perspective = [
      { x: 10, y: 20 },
      { x: 190, y: 15 },
      { x: 170, y: 130 },
      { x: 0, y: 110 },
    ];
    for (const points of [rotated, perspective]) {
      const projected = project(points);
      points.forEach((point, index) => {
        expect(projected[index][0]).toBeCloseTo(point.x, 5);
        expect(projected[index][1]).toBeCloseTo(point.y, 5);
      });
    }
  });

  it('projects DOM overlay pixels without multiplying by canvas dimensions', () => {
    const points = [
      { x: 10, y: 20 },
      { x: 210, y: 20 },
      { x: 210, y: 120 },
      { x: 10, y: 120 },
    ];
    const matrix = overlayTransformMatrix(points, 200, 100);
    const project = (x: number, y: number): [number, number] => [
      (matrix[0] * x + matrix[4] * y + matrix[12]) / (matrix[3] * x + matrix[7] * y + 1),
      (matrix[1] * x + matrix[5] * y + matrix[13]) / (matrix[3] * x + matrix[7] * y + 1),
    ];
    expect(project(0, 0)).toEqual([10, 20]);
    expect(project(200, 100)).toEqual([210, 120]);
  });
});
