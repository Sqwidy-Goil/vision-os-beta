import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Box3, Quaternion, Raycaster, Vector3 } from 'three';
import {
  SpatialTaskbar,
  TASKBAR_CANVAS_HEIGHT,
  TASKBAR_CANVAS_WIDTH,
  TASKBAR_HEIGHT,
  TASKBAR_WIDTH,
  type SpatialTaskbarOptions,
  type TaskbarAction,
  type TaskbarItem,
  type TaskbarTarget,
} from '../src/spatial/taskbar';
import type { ApplicationDefinition, WindowPoseState } from '../src/types';

interface TestRegion {
  x: number;
  y: number;
  width: number;
  height: number;
  item: TaskbarItem;
}

function application(id: string, name = id): ApplicationDefinition {
  return {
    id,
    name,
    icon: '●',
    color: '#75e7ff',
    description: `${name} test application`,
    create: () => ({ render: () => undefined }),
  };
}

function baseApplications(): ApplicationDefinition[] {
  return [
    application('browser', 'Internet'),
    application('youtube', 'YouTube'),
    application('music', 'Music'),
    application('photos', 'Photos'),
    application('ai', 'AI'),
    application('settings', 'Settings'),
    application('windows', 'Windows'),
    application('environments', 'Environments'),
  ];
}

function canvasContext(): CanvasRenderingContext2D {
  const gradient = { addColorStop: vi.fn() };
  return {
    clearRect: vi.fn(),
    fillRect: vi.fn(),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    arcTo: vi.fn(),
    closePath: vi.fn(),
    fill: vi.fn(),
    stroke: vi.fn(),
    save: vi.fn(),
    restore: vi.fn(),
    clip: vi.fn(),
    fillText: vi.fn(),
    createLinearGradient: vi.fn(() => gradient),
    createRadialGradient: vi.fn(() => gradient),
    measureText: (text: string) => ({ width: text.length * 12 }),
    globalAlpha: 1,
    fillStyle: '#000000',
    strokeStyle: '#000000',
    lineWidth: 1,
    font: '',
    textAlign: 'left',
    textBaseline: 'alphabetic',
  } as unknown as CanvasRenderingContext2D;
}

const taskbars: SpatialTaskbar[] = [];

function createTaskbar(applications = baseApplications(), options: Partial<SpatialTaskbarOptions> = {}): SpatialTaskbar {
  const taskbar = new SpatialTaskbar({
    applications,
    getTransparency: () => 0.78,
    ...options,
  });
  taskbars.push(taskbar);
  return taskbar;
}

function regions(taskbar: SpatialTaskbar): TestRegion[] {
  return (taskbar as unknown as { regions: TestRegion[] }).regions;
}

function centerUv(region: TestRegion): { u: number; v: number } {
  return {
    u: (region.x + region.width / 2) / TASKBAR_CANVAS_WIDTH,
    v: 1 - (region.y + region.height / 2) / TASKBAR_CANVAS_HEIGHT,
  };
}

function targetForItem(taskbar: SpatialTaskbar, id: string): TaskbarTarget | null {
  const region = regions(taskbar).find((candidate) => candidate.item.id === id);
  if (!region) return null;
  const { u, v } = centerUv(region);
  return taskbar.target(u, v);
}

function activateItem(taskbar: SpatialTaskbar, id: string): TaskbarAction | null {
  const target = targetForItem(taskbar, id);
  return target ? taskbar.activate(target) : null;
}

function targetsAcrossPages(taskbar: SpatialTaskbar): TaskbarTarget[] {
  const targets: TaskbarTarget[] = [];
  for (let page = 0; page < 50; page += 1) {
    for (const region of regions(taskbar)) {
      if (region.item.navigation) continue;
      const { u, v } = centerUv(region);
      const target = taskbar.target(u, v);
      if (target) targets.push(target);
    }
    const next = targetForItem(taskbar, 'next');
    if (!next) return targets;
    taskbar.activate(next);
  }
  throw new Error('Taskbar paging did not terminate.');
}

function disabledNavigationUv(direction: 'previous' | 'next'): { u: number; v: number } {
  const x = direction === 'previous'
    ? TASKBAR_CANVAS_WIDTH - 300 + 8 + 52
    : TASKBAR_CANVAS_WIDTH - 112 + 52;
  return { u: x / TASKBAR_CANVAS_WIDTH, v: 1 - (72 + 82) / TASKBAR_CANVAS_HEIGHT };
}

beforeEach(() => {
  const canvas = { width: 0, height: 0, getContext: () => canvasContext() };
  vi.stubGlobal('document', { createElement: () => canvas });
});

afterEach(() => {
  for (const taskbar of taskbars.splice(0)) taskbar.destroy();
  vi.unstubAllGlobals();
});

describe('SpatialTaskbar presentation and hit testing', () => {
  it('uses compact curved PlaneGeometry while preserving CanvasTexture UVs', () => {
    const taskbar = createTaskbar();
    taskbar.group.updateMatrixWorld(true);
    const bounds = new Box3().setFromObject(taskbar.group);
    const size = bounds.getSize(new Vector3());

    expect(size.x).toBeCloseTo(TASKBAR_WIDTH, 5);
    expect(size.y).toBeCloseTo(TASKBAR_HEIGHT, 5);
    expect(size.x).toBeLessThan(4.8);
    expect(size.y).toBeLessThan(0.7);
    expect(size.z).toBeGreaterThan(0.13);
    expect(size.z).toBeLessThan(0.25);
    expect(taskbar.group.position.y).toBeLessThan(-1);
    expect(taskbar.group.position.z).toBeLessThan(-5);

    const geometry = taskbar.surface.geometry;
    expect(geometry.type).toBe('PlaneGeometry');
    expect(geometry.attributes.position.count).toBe(geometry.attributes.uv.count);
    expect(geometry.attributes.uv.getX(0)).toBe(0);
    expect(geometry.attributes.uv.getY(0)).toBe(1);
    expect(geometry.attributes.position.getZ(0)).toBeGreaterThan(0.13);
    expect(taskbar.surface.material.map).toBe(taskbar['texture']);
  });

  it('keeps exact region boundaries and raycast UV mapping on the curved mesh', () => {
    const taskbar = createTaskbar();
    taskbar.group.updateMatrixWorld(true);
    const region = regions(taskbar).find((candidate) => candidate.item.id === 'apps');
    expect(region).toBeDefined();
    if (!region) return;
    const { u, v } = centerUv(region);

    expect(taskbar.target((region.x - 0.25) / TASKBAR_CANVAS_WIDTH, v)).toBeNull();
    expect(taskbar.target((region.x + region.width) / TASKBAR_CANVAS_WIDTH, v)?.item.id).toBe('apps');
    expect(taskbar.target(u, v)?.item.id).toBe('apps');

    const localX = (u - 0.5) * TASKBAR_WIDTH;
    const localY = (v - 0.5) * TASKBAR_HEIGHT;
    const origin = new Vector3(localX, localY, 2).applyMatrix4(taskbar.group.matrixWorld);
    const direction = new Vector3(0, 0, -1).transformDirection(taskbar.group.matrixWorld);
    const hit = new Raycaster(origin, direction).intersectObject(taskbar.surface, false)[0];
    expect(hit?.uv).toBeDefined();
    expect(taskbar.target(hit!.uv!.x, hit!.uv!.y)?.item.id).toBe('apps');
  });

  it('omits unavailable navigation hit regions instead of returning decorative actions', () => {
    const taskbar = createTaskbar();
    expect(targetForItem(taskbar, 'previous')).toBeNull();
    expect(targetForItem(taskbar, 'next')).not.toBeNull();
    const previousUv = disabledNavigationUv('previous');
    expect(taskbar.pointer(previousUv.u, previousUv.v)).toBeNull();

    expect(activateItem(taskbar, 'next')).toBeNull();
    expect(targetForItem(taskbar, 'previous')).not.toBeNull();
    expect(targetForItem(taskbar, 'next')).toBeNull();
    const nextUv = disabledNavigationUv('next');
    expect(taskbar.pointer(nextUv.u, nextUv.v)).toBeNull();

    activateItem(taskbar, 'previous');
    taskbar.setApplications([]);
    activateItem(taskbar, 'apps');
    expect(targetForItem(taskbar, 'previous')).toBeNull();
    expect(targetForItem(taskbar, 'next')).toBeNull();
  });
});

describe('SpatialTaskbar registry and actions', () => {
  it('maps the Main registry and required spatial controls without a table command', () => {
    const taskbar = createTaskbar();
    const main = targetsAcrossPages(taskbar);
    const byId = new Map(main.map((target) => [target.item.id, target]));
    expect([...byId.keys()]).toEqual(expect.arrayContaining([
      'home', 'browser', 'youtube', 'spotify', 'photos', 'ai', 'settings', 'apps', 'controls', 'exit',
    ]));
    expect(byId.get('home')?.item.action).toEqual({ type: 'section', section: 'main' });
    expect(byId.get('browser')?.item.action).toEqual({ type: 'app', appId: 'browser' });
    expect(byId.get('youtube')?.item.action).toEqual({ type: 'app', appId: 'youtube' });
    expect(byId.get('spotify')?.item.action).toEqual({ type: 'app', appId: 'music' });
    expect(byId.get('photos')?.item.action).toEqual({ type: 'app', appId: 'photos' });
    expect(byId.get('ai')?.item.action).toEqual({ type: 'app', appId: 'ai' });
    expect(byId.get('settings')?.item.action).toEqual({ type: 'app', appId: 'settings' });

    activateItem(taskbar, 'controls');
    const controls = targetsAcrossPages(taskbar);
    const commands = controls
      .map((target) => target.item.action)
      .filter((action): action is Extract<TaskbarAction, { type: 'command' }> => action.type === 'command')
      .map((action) => action.command);
    expect(commands).toEqual(expect.arrayContaining([
      'keyboard', 'settings', 'anchor', 'follow', 'reposition', 'hide', 'show', 'mode-cycle', 'exit',
    ]));
    expect(commands).not.toContain('table');
    expect(commands).not.toContain('mode-world');
    expect(commands).not.toContain('mode-head');
    expect(commands).not.toContain('mode-individual');
    expect(controls.find((target) => target.item.id === 'windows')?.item.action).toEqual({ type: 'app', appId: 'windows' });
    expect(controls.find((target) => target.item.id === 'anchor')?.item.label).toBe('Bar World');
    expect(controls.find((target) => target.item.id === 'follow')?.item.label).toBe('Bar Follow');
    expect(controls.find((target) => target.item.id === 'mode-cycle')?.item.label).toBe('Window mode');
    expect(controls.find((target) => target.item.id === 'mode-cycle')?.item.action).toEqual({ type: 'command', command: 'mode-cycle' });
  });

  it('pages all registered applications and keeps the Main return available', () => {
    const taskbar = createTaskbar();
    const applications = Array.from({ length: 17 }, (_, index) => application(`custom-${index}`, `Custom ${index}`));
    taskbar.setApplications(applications);
    expect(activateItem(taskbar, 'apps')).toEqual({ type: 'section', section: 'apps' });

    const targets = targetsAcrossPages(taskbar);
    expect(targets[0].item.id).toBe('main');
    expect(targets[0].item.action).toEqual({ type: 'section', section: 'main' });
    const appIds = targets
      .filter((target) => target.item.action.type === 'app')
      .map((target) => (target.item.action as Extract<TaskbarAction, { type: 'app' }>).appId);
    expect(appIds).toEqual(applications.map((entry) => entry.id));
    expect(targetForItem(taskbar, 'next')).toBeNull();

    activateItem(taskbar, 'main');
    expect(targetForItem(taskbar, 'apps')).not.toBeNull();
    expect(targetForItem(taskbar, 'home')).not.toBeNull();
  });

  it('synchronizes registry updates and rejects stale or unavailable app targets', () => {
    const taskbar = createTaskbar([application('alpha')]);
    activateItem(taskbar, 'apps');
    const stale = targetForItem(taskbar, 'alpha');
    expect(stale).not.toBeNull();

    taskbar.setApplications([application('beta')]);
    expect(targetForItem(taskbar, 'alpha')).toBeNull();
    expect(targetForItem(taskbar, 'beta')?.item.action).toEqual({ type: 'app', appId: 'beta' });
    expect(stale ? taskbar.activate(stale) : 'missing').toBeNull();
    expect(targetForItem(taskbar, 'browser')).toBeNull();

    taskbar.setApplications(baseApplications());
    expect(targetForItem(taskbar, 'browser')?.item.action).toEqual({ type: 'app', appId: 'browser' });
  });

  it('applies anchor, follow, reposition, visibility, and settings command mappings', () => {
    const taskbar = createTaskbar();
    activateItem(taskbar, 'next');
    activateItem(taskbar, 'controls');
    expect(activateItem(taskbar, 'anchor')).toEqual({ type: 'command', command: 'anchor' });
    expect(taskbar.getMode()).toBe('world');
    expect(activateItem(taskbar, 'follow')).toEqual({ type: 'command', command: 'follow' });
    expect(taskbar.getMode()).toBe('follow');
    expect(activateItem(taskbar, 'reposition')).toEqual({ type: 'command', command: 'reposition' });
    expect(activateItem(taskbar, 'settings')).toEqual({ type: 'command', command: 'settings' });
    expect(activateItem(taskbar, 'hide')).toEqual({ type: 'command', command: 'hide' });
    expect(taskbar.group.visible).toBe(false);
    expect(activateItem(taskbar, 'show')).toEqual({ type: 'command', command: 'show' });
    expect(taskbar.group.visible).toBe(true);
    expect(activateItem(taskbar, 'next')).toBeNull();
    expect(activateItem(taskbar, 'mode-cycle')).toEqual({ type: 'command', command: 'mode-cycle' });
    expect(activateItem(taskbar, 'mode-world')).toBeNull();
    expect(activateItem(taskbar, 'mode-individual')).toBeNull();
    expect(activateItem(taskbar, 'mode-head')).toBeNull();
  });
});

describe('SpatialTaskbar follow and world anchoring', () => {
  it('damps camera translation and rotation without per-frame recentering, then stays stable', () => {
    const taskbar = createTaskbar();
    const identity = new Quaternion();
    taskbar.update(new Vector3(), identity, 1 / 60, true);
    const initialOffset = taskbar.group.position.clone();
    const cameraPosition = new Vector3(1.2, 0.4, -8);
    const cameraQuaternion = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), 0.5);
    const expectedPosition = initialOffset.clone().applyQuaternion(cameraQuaternion).add(cameraPosition);

    taskbar.update(cameraPosition, cameraQuaternion, 1 / 60, true);
    expect(taskbar.group.position.distanceTo(expectedPosition)).toBeGreaterThan(0.05);
    expect(taskbar.group.quaternion.angleTo(cameraQuaternion)).toBeGreaterThan(0.001);
    for (let frame = 0; frame < 240; frame += 1) taskbar.update(cameraPosition, cameraQuaternion, 1 / 60, true);
    expect(taskbar.group.position.distanceTo(expectedPosition)).toBeLessThan(0.00001);
    expect(taskbar.group.quaternion.angleTo(cameraQuaternion)).toBeLessThan(0.00001);

    const settledPosition = taskbar.group.position.clone();
    const settledQuaternion = taskbar.group.quaternion.clone();
    for (let frame = 0; frame < 120; frame += 1) taskbar.update(cameraPosition, cameraQuaternion, 1 / 60, true);
    expect(taskbar.group.position.distanceTo(settledPosition)).toBeLessThan(0.0000001);
    expect(taskbar.group.quaternion.angleTo(settledQuaternion)).toBeLessThan(0.0000001);

    const orientationOnly = new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), 0.2);
    taskbar.update(undefined, orientationOnly, 1 / 60, true);
    expect(taskbar.group.position.distanceTo(settledPosition)).toBe(0);
    taskbar.update(cameraPosition, cameraQuaternion, Number.NaN, true);
    expect(taskbar.group.position.toArray().every(Number.isFinite)).toBe(true);
    expect(taskbar.getStatus()).toMatchObject({ mode: 'follow', state: 'following', vrActive: true, recovery: 'none' });
  });

  it('captures a stable world pose, does not follow, restores persistence, and releases to follow', () => {
    const taskbar = createTaskbar();
    taskbar.update(new Vector3(0.5, 0.2, -7), new Quaternion(), 1 / 60, true);
    taskbar.setMode('world');
    const anchor = taskbar.getAnchor();
    expect(anchor).not.toBeNull();
    if (!anchor) return;
    expect(taskbar.getStatus()).toMatchObject({ mode: 'world', state: 'anchored', hasAnchor: true, recovery: 'none' });

    for (let frame = 0; frame < 120; frame += 1) {
      taskbar.update(new Vector3(4, 2, -12), new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), 1), 1 / 60, true);
    }
    expect(taskbar.group.position.toArray()).toEqual([anchor.position.x, anchor.position.y, anchor.position.z]);
    expect(taskbar.getAnchor()).toEqual(anchor);

    const supplied: WindowPoseState = {
      position: { x: 2, y: -0.5, z: -8 },
      quaternion: { x: 0, y: 0, z: 0, w: 2 },
      size: { width: 4.4, height: TASKBAR_HEIGHT },
    };
    taskbar.captureWorldAnchor(supplied);
    expect(taskbar.getAnchor()).toEqual({ ...supplied, quaternion: { x: 0, y: 0, z: 0, w: 1 } });
    const returned = taskbar.getAnchor();
    if (!returned) throw new Error('Expected a captured anchor.');
    returned.position.x = 99;
    expect(taskbar.getAnchor()?.position.x).toBe(2);

    const restored = createTaskbar(baseApplications(), { mode: 'world', anchor: taskbar.getAnchor() });
    expect(restored.group.position.toArray()).toEqual([2, -0.5, -8]);
    restored.update(new Vector3(-3, 1, -5), new Quaternion(), 1, true);
    expect(restored.group.position.toArray()).toEqual([2, -0.5, -8]);

    const beforeRecenter = restored.group.position.clone();
    const cameraPosition = new Vector3(-3, 1, -5);
    restored.recenter(new Quaternion(), 2, cameraPosition);
    const expectedReposition = new Vector3(0, -1.35, -12).add(cameraPosition);
    expect(restored.group.position.distanceTo(expectedReposition)).toBeLessThan(0.00001);
    expect(restored.getAnchor()?.position).toEqual({
      x: expectedReposition.x,
      y: expectedReposition.y,
      z: expectedReposition.z,
    });
    restored.releaseWorldAnchor();
    expect(restored.getAnchor()).toBeNull();
    expect(restored.getStatus()).toMatchObject({ mode: 'follow', recovery: 'follow', recoverable: true });
    restored.update(new Vector3(-3, 1, -5), new Quaternion(), 1 / 60, true);
    expect(restored.group.position.distanceTo(beforeRecenter)).toBeGreaterThan(0.01);
  });

  it('keeps recenter as a follow-only placement initializer', () => {
    const taskbar = createTaskbar();
    const cameraQuaternion = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), 0.25);
    taskbar.recenter(cameraQuaternion, 1.5);
    const expected = new Vector3(0, -1.35, -9).applyQuaternion(cameraQuaternion);
    expect(taskbar.group.position.distanceTo(expected)).toBeLessThan(0.00001);
    expect(taskbar.group.quaternion.angleTo(cameraQuaternion)).toBeLessThan(0.00001);
    expect(taskbar.getStatus().initialized).toBe(true);
  });
});
