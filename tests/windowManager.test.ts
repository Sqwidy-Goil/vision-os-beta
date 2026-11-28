import { Euler, Quaternion, Vector3 } from 'three';
import { describe, expect, it, vi } from 'vitest';
import { AnchorManager } from '../src/spatial/anchorManager';
import {
  WindowManager,
  resizeAspectSize,
  resizeUniformSize,
  resizeWindowSize,
  type SpatialWindowLike,
} from '../src/spatial/windowManager';
import { DEFAULT_SETTINGS, type AppSettings, type QuaternionState, type WindowPoseState, type WindowState } from '../src/types';

const IDENTITY: QuaternionState = { x: 0, y: 0, z: 0, w: 1 };

function pose(position = { x: 0, y: 0, z: -6 }, quaternionValue = IDENTITY, size = { width: 4, height: 2 }): WindowPoseState {
  return { position: { ...position }, quaternion: { ...quaternionValue }, size: { ...size } };
}

function expectQuaternion(actual: QuaternionState, expected: QuaternionState): void {
  const first = new Quaternion(actual.x, actual.y, actual.z, actual.w);
  const second = new Quaternion(expected.x, expected.y, expected.z, expected.w).normalize();
  expect(first.length()).toBeCloseTo(1, 8);
  expect(Math.abs(first.dot(second))).toBeCloseTo(1, 8);
}

function setup(settings: Partial<AppSettings> = {}, anchorManager?: AnchorManager) {
  let currentSettings: AppSettings = {
    ...DEFAULT_SETTINGS,
    windowInertia: false,
    windowSnapping: false,
    ...settings,
  };
  const changes: WindowState[][] = [];
  const destroyed: SpatialWindowLike[] = [];
  const manager = new WindowManager({
    createWindow: (state) => ({ state, requestRender: vi.fn() }),
    destroyWindow: (window) => { destroyed.push(window); },
    onChange: (states) => { changes.push(states); },
    getSettings: () => currentSettings,
    anchorManager,
  });
  return {
    manager,
    changes,
    destroyed,
    setSettings: (value: Partial<AppSettings>) => { currentSettings = { ...currentSettings, ...value }; },
  };
}

describe('WindowManager', () => {
  it('migrates legacy Euler, table and pinned records while preserving persisted fields', () => {
    const { manager, changes } = setup();
    const appState = { selectedFile: 'photo-1', nested: { count: 2 } };
    manager.restore([
      {
        id: 'legacy-euler',
        appId: 'photos',
        title: 'Legacy photos',
        position: { x: 1, y: 2, z: -5 },
        rotation: { x: 0.2, y: -0.4, z: 0.1 },
        size: { width: 3, height: 2 },
        mode: 'head',
        minimized: true,
        maximized: false,
        z: 42,
        appState,
      },
      {
        id: 'legacy-table',
        appId: 'browser',
        position: { x: 0, y: -1, z: -4 },
        rotation: { x: -1, y: 0, z: 0 },
        size: { width: 3, height: 2 },
        anchor: 'table',
        z: 7,
      },
      {
        id: 'legacy-pinned',
        appId: 'camera',
        position: { x: 1, y: 2, z: 1.5 },
        rotation: { x: 0.1, y: 2.8, z: 0 },
        size: { width: 2, height: 1 },
        pinned: true,
        maximized: true,
        z: 9,
      },
    ]);

    expect(changes).toHaveLength(1);
    const states = manager.list();
    expect(states.map((state) => state.id)).toEqual(['legacy-euler', 'legacy-pinned', 'legacy-table']);
    const legacy = states.find((state) => state.id === 'legacy-euler')!;
    const expected = new Quaternion().setFromEuler(new Euler(0.2, -0.4, 0.1, 'YXZ'));
    expectQuaternion(legacy.quaternion, { x: expected.x, y: expected.y, z: expected.z, w: expected.w });
    expect(legacy.mode).toBe('world');
    expect(legacy.positioningExplicit).toBe(false);
    expect(legacy.schemaVersion).toBe(2);
    expect(legacy.minimized).toBe(true);
    expect(legacy.z).toBe(42);
    expect(legacy.appState).toEqual(appState);

    const table = states.find((state) => state.id === 'legacy-table')!;
    expect(table.anchor).toBe('legacy-world');
    expect(table.anchorKind).toBe('world');
    expect(table.mode).toBe('world');
    const pinned = states.find((state) => state.id === 'legacy-pinned')!;
    expect(pinned.position.z).toBe(1.5);
    expect(pinned.maximized).toBe(false);
    expect(pinned.mode).toBe('world');
  });

  it('migrates accidental head locks while preserving deliberate head positioning', () => {
    const { manager } = setup();
    manager.restore([
      {
        id: 'accidental-head',
        appId: 'browser',
        position: { x: 1, y: 0.5, z: -5 },
        quaternion: IDENTITY,
        size: { width: 3, height: 2 },
        mode: 'head',
      },
      {
        id: 'deliberate-head',
        appId: 'browser',
        position: { x: 1, y: 0.5, z: -5 },
        quaternion: IDENTITY,
        size: { width: 3, height: 2 },
        mode: 'head',
        positioningExplicit: true,
      },
    ]);
    const accidental = manager.list().find((state) => state.id === 'accidental-head')!;
    const deliberate = manager.list().find((state) => state.id === 'deliberate-head')!;
    expect(accidental.mode).toBe('world');
    expect(accidental.position).toEqual({ x: 1, y: 0.5, z: -5 });
    expect(deliberate.mode).toBe('head');
    expect(deliberate.positioningExplicit).toBe(true);

    const defaultWorld = manager.open('browser', 'Default world');
    expect(defaultWorld.state.mode).toBe('world');
    expect(defaultWorld.state.positioningExplicit).toBe(false);
  });

  it('honors an explicitly configured head-lock default for new windows', () => {
    const { manager } = setup({ headLockDefault: true });
    const window = manager.open('browser', 'Default head');
    expect(window.state.mode).toBe('head');
    expect(window.state.positioningExplicit).toBe(true);
  });

  it('round-trips authoritative quaternions and derives compatible Euler rotation', () => {
    const { manager, changes } = setup();
    const window = manager.open('browser', 'Quaternion window');
    const expected = new Quaternion().setFromEuler(new Euler(0.3, -0.7, 0.2, 'YXZ'));
    const supplied = pose(
      { x: 1.5, y: -0.5, z: -7 },
      { x: expected.x * 2, y: expected.y * 2, z: expected.z * 2, w: expected.w * 2 },
      { width: 5, height: 3 },
    );
    expect(manager.setPose(window.state.id, supplied)).toBe(true);
    const state = manager.list()[0];
    expectQuaternion(state.quaternion, { x: expected.x, y: expected.y, z: expected.z, w: expected.w });
    const derived = new Quaternion().setFromEuler(new Euler(state.rotation.x, state.rotation.y, state.rotation.z, 'YXZ'));
    expect(Math.abs(derived.dot(expected))).toBeCloseTo(1, 8);
    expect(changes).toHaveLength(2);

    state.position.x = 99;
    state.quaternion.w = 0;
    expect(manager.list()[0].position.x).toBe(1.5);
    expect(manager.list()[0].quaternion.w).not.toBe(0);
  });

  it('applies six-axis translation and rotation plus independent depth and resize', () => {
    const { manager, changes } = setup();
    const window = manager.open('browser', 'Six axes');
    const id = window.state.id;
    manager.setPose(id, pose());

    expect(manager.beginManipulation(id, 'move')).toBe(true);
    expect(manager.applyManipulation({ dx: 0.4, dy: -0.3, dz: -0.5, dt: 0.1 })).toBe(true);
    expect(manager.endManipulation()).toBe(true);
    expect(manager.list()[0].position).toEqual({ x: 0.4, y: -0.3, z: -6.5 });

    const beforeRotation = manager.list()[0].quaternion;
    manager.beginManipulation(id, 'rotate');
    manager.applyManipulation({ rotation: { x: 0.2, y: 0.3, z: -0.1 }, dt: 0.1 });
    manager.endManipulation();
    const expected = new Quaternion().setFromEuler(new Euler(0.2, 0.3, -0.1, 'YXZ'))
      .multiply(new Quaternion(beforeRotation.x, beforeRotation.y, beforeRotation.z, beforeRotation.w));
    expectQuaternion(manager.list()[0].quaternion, { x: expected.x, y: expected.y, z: expected.z, w: expected.w });
    expect(manager.list()[0].position).toEqual({ x: 0.4, y: -0.3, z: -6.5 });

    manager.beginManipulation(id, 'depth');
    manager.applyManipulation({ depth: -0.4 });
    manager.endManipulation();
    expect(manager.list()[0].position).toEqual({ x: 0.4, y: -0.3, z: -6.9 });

    manager.beginManipulation(id, 'resize');
    manager.applyManipulation({ width: 1, height: -0.5 });
    manager.endManipulation();
    expect(manager.list()[0].size).toEqual({ width: 5, height: 1.5 });
    expect(changes).toHaveLength(6);
  });

  it('provides bounded aspect-ratio and uniform resize helpers', () => {
    const current = { width: 4, height: 2 };
    expect(resizeAspectSize(current, { width: 2 })).toEqual({ width: 6, height: 3 });
    expect(resizeAspectSize(current, { height: 1 }, 'height')).toEqual({ width: 6, height: 3 });
    expect(resizeUniformSize(current, { scale: 1.5 })).toEqual({ width: 6, height: 3 });
    expect(resizeUniformSize(current, { width: 2 })).toEqual({ width: 6, height: 3 });
    expect(resizeWindowSize(current, { width: 2 }, { aspectRatio: 16 / 9 })).toEqual({ width: 6, height: 3.375 });
    expect(resizeWindowSize(current, { scale: 100 })).toEqual({ width: 8, height: 5 });
    expect(resizeWindowSize(current, { scale: 0.01 }, { uniform: true })).toEqual({ width: 1.5, height: 0.75 });

    const { manager } = setup();
    const window = manager.open('browser', 'Resize');
    manager.setPose(window.state.id, pose(undefined, IDENTITY, current));
    manager.beginManipulation(window.state.id, 'resize');
    manager.applyManipulation({ width: 2, aspect: true });
    expect(manager.list()[0].size).toEqual({ width: 6, height: 3 });
    manager.applyManipulation({ scale: 1.25, uniform: true });
    expect(manager.list()[0].size).toEqual({ width: 7.5, height: 3.75 });
    manager.applyManipulation({ scale: 100, uniform: true });
    expect(manager.list()[0].size).toEqual({ width: 8, height: 4 });
  });

  it('settles bounded linear and angular inertia without further notifications', () => {
    const { manager, changes } = setup({ windowInertia: true });
    const window = manager.open('browser', 'Inertia');
    const id = window.state.id;
    manager.setPose(id, pose());
    manager.beginManipulation(id, 'move');
    manager.applyManipulation({ dx: 1, dt: 1 / 60 });
    manager.endManipulation();
    const released = manager.list()[0];
    for (let frame = 0; frame < 300; frame += 1) manager.step(1 / 60, IDENTITY);
    const settled = manager.list()[0];
    expect(settled.position.x).toBeGreaterThan(released.position.x);
    expect(settled.position.x).toBeLessThanOrEqual(2.5);
    expect(Number.isFinite(settled.position.x)).toBe(true);
    const callbackCount = changes.length;
    expect(manager.step(1, IDENTITY)).toBe(false);
    expect(changes).toHaveLength(callbackCount);

    manager.beginManipulation(id, 'rotate');
    manager.applyManipulation({ rotation: { x: 0.1, y: 20, z: -0.2 }, dt: 1 / 60 });
    manager.endManipulation();
    for (let frame = 0; frame < 300; frame += 1) manager.step(1 / 60, IDENTITY);
    expect(Number.isFinite(manager.list()[0].quaternion.x)).toBe(true);
    expect(new Quaternion(
      manager.list()[0].quaternion.x,
      manager.list()[0].quaternion.y,
      manager.list()[0].quaternion.z,
      manager.list()[0].quaternion.w,
    ).length()).toBeCloseTo(1, 8);
  });

  it('keeps a hand-released pose exact instead of adding inertia or snapping', () => {
    const { manager } = setup({ windowInertia: true, windowSnapping: true });
    const window = manager.open('browser', 'Hand placement');
    const id = window.state.id;
    manager.setPose(id, pose({ x: 1.17, y: 0.43, z: -6.7 }));
    manager.beginManipulation(id, 'move');
    manager.applyManipulation({ translation: { x: 0.42, y: -0.26, z: 0 }, dt: 1 / 60 });
    const released = manager.list()[0];
    manager.endManipulation(false);
    for (let frame = 0; frame < 180; frame += 1) manager.step(1 / 60, IDENTITY);
    expect(manager.list()[0].position).toEqual(released.position);
    expect(manager.list()[0].quaternion).toEqual(released.quaternion);
  });

  it('settles to snap endpoints only when snapping is enabled', () => {
    const { manager } = setup({ windowSnapping: true });
    const window = manager.open('browser', 'Snap');
    const id = window.state.id;
    manager.setPose(id, pose({ x: 0.05, y: 0, z: -6 }));
    manager.beginManipulation(id, 'move');
    manager.endManipulation();
    for (let frame = 0; frame < 120; frame += 1) manager.step(1 / 60, IDENTITY);
    expect(manager.list()[0].position).toEqual({ x: 0, y: 0, z: -6 });

    expect(manager.setPose(id, pose({ x: 0, y: 0, z: -6 }, IDENTITY, { width: 1.25, height: 0.8 }))).toBe(true);
    expect(manager.beginManipulation(id, 'resize')).toBe(true);
    expect(manager.endManipulation()).toBe(true);
    expect(manager.list()[0].size).toEqual({ width: 1.2, height: 0.75 });

    const snappedRotation = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), Math.PI / 2 - 0.05);
    manager.setPose(id, pose(undefined, { x: snappedRotation.x, y: snappedRotation.y, z: snappedRotation.z, w: snappedRotation.w }));
    manager.beginManipulation(id, 'rotate');
    manager.endManipulation();
    for (let frame = 0; frame < 120; frame += 1) manager.step(1 / 60, IDENTITY);
    const expected = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), Math.PI / 2);
    expectQuaternion(manager.list()[0].quaternion, { x: expected.x, y: expected.y, z: expected.z, w: expected.w });

    const disabled = setup({ windowSnapping: false });
    const other = disabled.manager.open('browser', 'No snap');
    disabled.manager.setPose(other.state.id, pose({ x: 0.05, y: 0, z: -6 }));
    disabled.manager.beginManipulation(other.state.id, 'move');
    disabled.manager.endManipulation();
    expect(disabled.manager.step(0.1, IDENTITY)).toBe(false);
    expect(disabled.manager.list()[0].position.x).toBe(0.05);
  });

  it('restores the complete pose after maximize, including quaternion', () => {
    const { manager } = setup();
    const window = manager.open('browser', 'Maximize');
    const originalQuaternion = new Quaternion().setFromEuler(new Euler(0.2, -0.4, 0.1, 'YXZ'));
    const original = pose(
      { x: 2, y: 1, z: -8 },
      { x: originalQuaternion.x, y: originalQuaternion.y, z: originalQuaternion.z, w: originalQuaternion.w },
      { width: 3.5, height: 2.25 },
    );
    manager.setPose(window.state.id, original);
    const z = window.state.z;
    expect(manager.maximize(window.state.id)).toBe(true);
    expect(manager.list()[0].maximized).toBe(true);
    expect(manager.list()[0].restore).toEqual(original);
    expect(manager.list()[0].size).toEqual({ width: 5.6, height: 3.5 });
    expect(manager.restoreMaximized(window.state.id)).toBe(true);
    const restored = manager.list()[0];
    expect(restored.maximized).toBe(false);
    expect(restored.restore).toBeUndefined();
    expect(restored.position).toEqual(original.position);
    expect(restored.size).toEqual(original.size);
    expectQuaternion(restored.quaternion, original.quaternion);
    expect(restored.z).toBe(z);
  });

  it('follows world, surface and object anchors with offsets and unanchors cleanly', () => {
    const anchors = new AnchorManager();
    const { manager } = setup({}, anchors);
    const window = manager.open('browser', 'Anchored');
    const id = window.state.id;
    const windowRotation = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), 0.3);
    const initial = pose(
      { x: 1, y: 2, z: -4 },
      { x: windowRotation.x, y: windowRotation.y, z: windowRotation.z, w: windowRotation.w },
    );
    manager.setPose(id, initial);
    const oldAnchorRotation = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), 0.5);
    anchors.captureWorld('surface-1', {
      position: { x: 0, y: 0, z: -5 },
      quaternion: { x: oldAnchorRotation.x, y: oldAnchorRotation.y, z: oldAnchorRotation.z, w: oldAnchorRotation.w },
    }, 'surface');
    expect(manager.setAnchor(id, 'surface-1')).toBe(true);
    expect(manager.list()[0].anchorKind).toBe('surface');
    expect(manager.list()[0].mode).toBe('world');

    const newAnchorRotation = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), 1);
    anchors.observe('surface-1', {
      position: { x: 2, y: 1, z: -6 },
      quaternion: { x: newAnchorRotation.x, y: newAnchorRotation.y, z: newAnchorRotation.z, w: newAnchorRotation.w },
    });
    expect(manager.step(0, IDENTITY)).toBe(true);
    const deltaRotation = newAnchorRotation.clone().multiply(oldAnchorRotation.clone().invert());
    const expectedPosition = new Vector3(1, 2, 1).applyQuaternion(deltaRotation).add(new Vector3(2, 1, -6));
    const expectedRotation = deltaRotation.clone().multiply(windowRotation);
    const followed = manager.list()[0];
    expect(followed.position.x).toBeCloseTo(expectedPosition.x, 8);
    expect(followed.position.y).toBeCloseTo(expectedPosition.y, 8);
    expect(followed.position.z).toBeCloseTo(expectedPosition.z, 8);
    expectQuaternion(followed.quaternion, { x: expectedRotation.x, y: expectedRotation.y, z: expectedRotation.z, w: expectedRotation.w });

    expect(manager.clearAnchor(id)).toBe(true);
    const unanchored = manager.snapshot();
    anchors.observe('surface-1', pose({ x: 5, y: 2, z: -8 }));
    expect(manager.step(0, IDENTITY)).toBe(false);
    expect(manager.snapshot()).toEqual(unanchored);

    manager.setAnchor(id, { id: 'object-1', kind: 'object', transform: pose({ x: 0, y: 0, z: -5 }) });
    expect(manager.getAnchorStatus(id)).toBe('tracked');
    expect(manager.list()[0].anchorKind).toBe('object');
    manager.clearAnchor(id);
    manager.setAnchor(id, { id: 'world-1', kind: 'world', position: { x: 0, y: 0, z: -5 }, quaternion: IDENTITY });
    expect(manager.getAnchorStatus(id)).toBe('tracked');
    expect(manager.list()[0].anchorKind).toBe('world');
    manager.clearAnchor(id);

    anchors.captureWorld('uncertain', pose({ x: 0, y: 0, z: -5 }), 'surface', 0.2);
    manager.setAnchor(id, 'uncertain');
    expect(manager.getAnchorStatus(id)).toBe('low-confidence');
    const uncertain = manager.snapshot();
    anchors.observe('uncertain', pose({ x: 3, y: 0, z: -7 }), 0.2);
    expect(manager.step(0, IDENTITY)).toBe(false);
    expect(manager.snapshot()).toEqual(uncertain);
    anchors.markUnavailable('uncertain');
    expect(manager.getAnchorStatus(id)).toBe('unavailable');
    manager.clearAnchor(id);

    manager.setAnchor(id, 'not-tracked');
    expect(manager.getAnchorStatus(id)).toBe('unavailable');
    expect(manager.step(0, IDENTITY)).toBe(false);
  });

  it('preserves the displayed world pose when changing positioning frames', () => {
    const { manager } = setup();
    const headPosition = { x: 2, y: 1, z: -3 };
    const headQuaternion = new Quaternion().setFromEuler(new Euler(0.1, Math.PI / 2, -0.05, 'YXZ'));
    manager.step(0, {
      position: headPosition,
      quaternion: { x: headQuaternion.x, y: headQuaternion.y, z: headQuaternion.z, w: headQuaternion.w },
    });
    const window = manager.open('notes', 'Notes');
    manager.setPositioning(window.state.id, 'head');
    const local = pose(
      { x: 1, y: 0.2, z: -4 },
      { x: 0.1, y: -0.2, z: 0.15, w: 0.96 },
      { width: 3.2, height: 2.1 },
    );
    manager.setPose(window.state.id, local);
    const expectedPosition = new Vector3(local.position.x, local.position.y, local.position.z)
      .applyQuaternion(headQuaternion)
      .add(new Vector3(headPosition.x, headPosition.y, headPosition.z));
    const expectedQuaternion = headQuaternion.clone().multiply(new Quaternion(
      local.quaternion.x,
      local.quaternion.y,
      local.quaternion.z,
      local.quaternion.w,
    ).normalize());

    expect(manager.setPositioning(window.state.id, 'world')).toBe(true);
    const world = manager.list()[0];
    expect(world.position.x).toBeCloseTo(expectedPosition.x, 8);
    expect(world.position.y).toBeCloseTo(expectedPosition.y, 8);
    expect(world.position.z).toBeCloseTo(expectedPosition.z, 8);
    expectQuaternion(world.quaternion, {
      x: expectedQuaternion.x,
      y: expectedQuaternion.y,
      z: expectedQuaternion.z,
      w: expectedQuaternion.w,
    });

    manager.setPositioning(window.state.id, 'individual');
    const individual = manager.list()[0];
    expect(individual.position).toEqual(world.position);
    expectQuaternion(individual.quaternion, local.quaternion);
    manager.setPositioning(window.state.id, 'head');
    const roundTrip = manager.list()[0];
    expect(roundTrip.position.x).toBeCloseTo(local.position.x, 8);
    expect(roundTrip.position.y).toBeCloseTo(local.position.y, 8);
    expect(roundTrip.position.z).toBeCloseTo(local.position.z, 8);
    expectQuaternion(roundTrip.quaternion, local.quaternion);
  });

  it('persists anchor snapshots and follow offsets across workspace restoration', () => {
    const { manager } = setup();
    const window = manager.open('browser', 'Browser');
    manager.setPose(window.state.id, pose({ x: 1, y: 0.5, z: -5 }));
    expect(manager.setAnchor(window.state.id, {
      id: 'persisted-anchor',
      kind: 'world',
      transform: pose({ x: 0, y: 0, z: -4 }),
    })).toBe(true);
    const initial = manager.list()[0];
    expect(initial.mode).toBe('world');
    expect(initial.anchorSnapshot).toEqual({ position: { x: 0, y: 0, z: -4 }, quaternion: IDENTITY });
    expect(initial.anchorOffset?.position).toEqual({ x: 1, y: 0.5, z: -1 });

    manager.anchors.observe('persisted-anchor', pose({ x: 1, y: 0, z: -4 }));
    manager.step(0.016, IDENTITY);
    const moved = manager.list()[0];
    expect(moved.position).toEqual({ x: 2, y: 0.5, z: -5 });
    expect(moved.anchorSnapshot?.position).toEqual({ x: 1, y: 0, z: -4 });

    const restored = setup();
    restored.manager.restore([moved]);
    const restoredState = restored.manager.list()[0];
    expect(restoredState.anchor).toBe('persisted-anchor');
    expect(restoredState.anchorOffset).toEqual(moved.anchorOffset);
    expect(restored.manager.getAnchorStatus(restoredState.id)).toBe('tracked');
    restored.manager.anchors.observe('persisted-anchor', pose({ x: 2, y: 0, z: -4 }));
    restored.manager.step(0.016, IDENTITY);
    expect(restored.manager.list()[0].position).toEqual({ x: 3, y: 0.5, z: -5 });
  });

  it('rejects invalid states and deltas without mutating or notifying', () => {
    const { manager, changes } = setup();
    manager.restore([
      { id: 'bad-number', appId: 'browser', position: { x: Number.NaN, y: 0, z: -6 } },
      { id: 'bad-quaternion', appId: 'browser', quaternion: { x: 0, y: 0, z: 0, w: 0 } },
      { id: 'bad-mode', appId: 'browser', mode: 'invalid' },
      { id: 'valid', appId: 'browser' },
    ]);
    expect(manager.list().map((state) => state.id)).toEqual(['valid']);
    expect(changes).toHaveLength(1);
    const id = manager.list()[0].id;
    const before = manager.snapshot();
    expect(manager.setPose(id, pose({ x: Number.NaN, y: 0, z: -6 }))).toBe(false);
    expect(manager.setPose(id, pose(undefined, { x: 0, y: 0, z: 0, w: 0 }))).toBe(false);
    expect(manager.setAnchor(id, '')).toBe(false);
    expect(manager.setAnchor(id, { id: 'bad', kind: 'invalid' as never, transform: pose() })).toBe(false);
    expect(manager.setPositioning(id, 'invalid' as never)).toBe(false);
    expect(manager.beginManipulation(id, 'invalid' as never)).toBe(false);
    expect(manager.step(Number.NaN, IDENTITY)).toBe(false);
    expect(manager.step(-1, IDENTITY)).toBe(false);
    expect(manager.step(0.1, { x: 0, y: 0, z: 0, w: 0 })).toBe(false);
    expect(manager.snapshot()).toEqual(before);
    expect(changes).toHaveLength(1);

    manager.beginManipulation(id, 'move');
    expect(manager.applyManipulation({ dx: Number.NaN })).toBe(false);
    expect(manager.applyManipulation({ position: { x: 0, y: 0, z: Number.POSITIVE_INFINITY } })).toBe(false);
    expect(manager.applyManipulation({ dx: 0.1, dt: 0 })).toBe(false);
    expect(manager.applyManipulation({ scale: -1 })).toBe(false);
    expect(manager.applyManipulation({ width: 1, aspectRatio: 0 })).toBe(false);
    expect(manager.snapshot()).toEqual(before);
    expect(changes).toHaveLength(1);
    manager.endManipulation();
  });

  it('emits exactly one cloned persistence snapshot per public mutation', () => {
    const { manager, changes, destroyed } = setup();
    const first = manager.open('browser', 'First');
    expect(changes).toHaveLength(1);
    manager.list();
    manager.snapshot();
    expect(changes).toHaveLength(1);
    manager.focus(first.state.id);
    expect(changes).toHaveLength(2);
    manager.beginManipulation(first.state.id, 'move');
    expect(changes).toHaveLength(2);
    manager.applyManipulation({ dx: 0.1 });
    expect(changes).toHaveLength(3);
    manager.endManipulation();
    expect(changes).toHaveLength(3);
    manager.setPose(first.state.id, pose({ x: 1, y: 0, z: -6 }));
    expect(changes).toHaveLength(4);
    manager.setAnchor(first.state.id, { id: 'world-1', kind: 'world', transform: pose({ x: 0, y: 0, z: -5 }) });
    expect(changes).toHaveLength(5);
    manager.clearAnchor(first.state.id);
    expect(changes).toHaveLength(6);
    manager.setPositioning(first.state.id, 'head');
    expect(changes).toHaveLength(7);
    manager.arrange();
    expect(changes).toHaveLength(8);
    manager.close(first.state.id);
    expect(changes).toHaveLength(9);
    expect(destroyed).toHaveLength(1);

    manager.restore([
      { id: 'restored-1', appId: 'browser', z: 3 },
      { id: 'restored-2', appId: 'photos', z: 4 },
    ]);
    expect(changes).toHaveLength(10);
    expect(changes[9]).toHaveLength(2);
    changes[0][0].position.x = 999;
    expect(manager.list()).toHaveLength(2);
    expect(manager.list().every((state) => state.position.x !== 999)).toBe(true);
    manager.setPose('missing', pose());
    manager.close('missing');
    manager.focus('missing');
    expect(changes).toHaveLength(10);
  });
});
