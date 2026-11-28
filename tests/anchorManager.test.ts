import { Euler, Matrix4, Object3D, Quaternion, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import {
  AnchorManager,
  createAnchorTransform,
  type AnchorTransform,
} from '../src/spatial/anchorManager';

const IDENTITY = { x: 0, y: 0, z: 0, w: 1 };

function transform(position = { x: 0, y: 0, z: -5 }, quaternion = IDENTITY): AnchorTransform {
  return { position: { ...position }, quaternion: { ...quaternion } };
}

function expectTransform(actual: AnchorTransform | null, expected: AnchorTransform): void {
  expect(actual).not.toBeNull();
  expect(actual!.position.x).toBeCloseTo(expected.position.x, 8);
  expect(actual!.position.y).toBeCloseTo(expected.position.y, 8);
  expect(actual!.position.z).toBeCloseTo(expected.position.z, 8);
  const first = new Quaternion(actual!.quaternion.x, actual!.quaternion.y, actual!.quaternion.z, actual!.quaternion.w);
  const second = new Quaternion(expected.quaternion.x, expected.quaternion.y, expected.quaternion.z, expected.quaternion.w);
  expect(Math.abs(first.dot(second))).toBeCloseTo(1, 8);
}

describe('AnchorManager', () => {
  it('captures copied world transforms from Three.js objects and matrices', () => {
    const anchors = new AnchorManager();
    const object = new Object3D();
    object.position.set(1, 2, -4);
    object.quaternion.setFromEuler(new Euler(0.1, 0.2, 0.3, 'YXZ'));
    object.scale.set(2, 3, 4);
    object.userData.anchorId = 'object-1';
    object.userData.anchorKind = 'object';
    const captured = anchors.captureWorld('object-1', object, 'object');
    expect(captured.status).toBe('tracked');
    expect(captured.usable).toBe(true);
    expect(captured.transform.position).toEqual({ x: 1, y: 2, z: -4 });
    expect(captured.position).toEqual({ x: 1, y: 2, z: -4 });

    object.position.set(99, 99, 99);
    object.quaternion.identity();
    expect(anchors.current('object-1')!.transform.position).toEqual({ x: 1, y: 2, z: -4 });
    const snapshot = anchors.snapshot();
    expect(snapshot).toHaveLength(1);
    expect(snapshot[0].id).toBe('object-1');
    expect(snapshot[0].kind).toBe('object');
    expect(JSON.stringify(snapshot)).not.toContain('Object3D');
    expect(JSON.stringify(snapshot)).not.toContain('matrixWorld');

    const rotation = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), Math.PI / 2);
    const matrix = new Matrix4().compose(new Vector3(-2, 1, -6), rotation, new Vector3(1, 1, 1));
    anchors.captureWorld('matrix-1', matrix, 'surface');
    expectTransform(anchors.current('matrix-1')!.transform, transform(
      { x: -2, y: 1, z: -6 },
      { x: rotation.x, y: rotation.y, z: rotation.z, w: rotation.w },
    ));
    anchors.captureWorld('rotation-1', rotation);
    expect(anchors.current('rotation-1')!.transform.position).toEqual({ x: 0, y: 0, z: 0 });
  });

  it('normalizes transforms and rejects invalid IDs, confidence and quaternions', () => {
    const anchors = new AnchorManager();
    expect(() => anchors.captureWorld('', transform())).toThrow(TypeError);
    expect(() => anchors.captureWorld('x'.repeat(81), transform())).toThrow(TypeError);
    expect(() => anchors.captureWorld('bad-kind', transform(), 'invalid' as never)).toThrow(TypeError);
    expect(() => anchors.captureWorld('bad-confidence', transform(), 'world', Number.NaN)).toThrow(TypeError);
    expect(() => anchors.captureWorld('bad-position', transform({ x: Number.NaN, y: 0, z: 0 }))).toThrow(TypeError);
    expect(() => anchors.captureWorld('bad-quaternion', transform(undefined, { x: 0, y: 0, z: 0, w: 0 }))).toThrow(TypeError);
    expect(anchors.current('missing')).toBeNull();
    expect(anchors.status('missing')).toBe('unavailable');

    const normalized = createAnchorTransform({ x: 1, y: 2, z: 3 }, { x: 0, y: 0, z: 0, w: -2 });
    expect(normalized.quaternion).toEqual(IDENTITY);
    expect(() => createAnchorTransform({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0, w: 0 })).toThrow(TypeError);
  });

  it('maintains relative follow offsets across anchor translation and rotation', () => {
    const anchors = new AnchorManager();
    const oldAnchorRotation = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), 0.5);
    const windowRotation = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), 0.2);
    const oldAnchor = transform(
      { x: 0, y: 0, z: -5 },
      { x: oldAnchorRotation.x, y: oldAnchorRotation.y, z: oldAnchorRotation.z, w: oldAnchorRotation.w },
    );
    const windowPose = transform(
      { x: 1, y: 2, z: -4 },
      { x: windowRotation.x, y: windowRotation.y, z: windowRotation.z, w: windowRotation.w },
    );
    anchors.captureWorld('surface-1', oldAnchor, 'surface');
    expect(anchors.follow('window-1', 'surface-1', windowPose)).toBe(true);
    expectTransform(anchors.resolve('window-1').transform, windowPose);

    const newAnchorRotation = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), 1.1);
    const newAnchor = transform(
      { x: 2, y: 1, z: -6 },
      { x: newAnchorRotation.x, y: newAnchorRotation.y, z: newAnchorRotation.z, w: newAnchorRotation.w },
    );
    anchors.observe('surface-1', newAnchor);
    const deltaRotation = newAnchorRotation.clone().multiply(oldAnchorRotation.clone().invert());
    const expectedPosition = new Vector3(1, 2, 1).applyQuaternion(deltaRotation).add(new Vector3(2, 1, -6));
    const expectedRotation = deltaRotation.clone().multiply(windowRotation);
    expectTransform(anchors.resolve('window-1').transform, transform(
      { x: expectedPosition.x, y: expectedPosition.y, z: expectedPosition.z },
      { x: expectedRotation.x, y: expectedRotation.y, z: expectedRotation.z, w: expectedRotation.w },
    ));

    const localOffset = transform({ x: 0.5, y: -1, z: -2 }, IDENTITY);
    expect(anchors.setFollowOffset('window-1', 'surface-1', localOffset)).toBe(true);
    const offsetPosition = new Vector3(0.5, -1, -2).applyQuaternion(newAnchorRotation).add(new Vector3(2, 1, -6));
    expectTransform(anchors.resolve('window-1').transform, transform(
      { x: offsetPosition.x, y: offsetPosition.y, z: offsetPosition.z },
      { x: newAnchorRotation.x, y: newAnchorRotation.y, z: newAnchorRotation.z, w: newAnchorRotation.w },
    ));
  });

  it('reports unavailable and low-confidence tracking instead of fabricating follows', () => {
    const anchors = new AnchorManager({ minimumConfidence: 0.6 });
    anchors.captureWorld('surface-1', transform(), 'surface', 0.2);
    anchors.follow('window-1', 'surface-1', transform({ x: 1, y: 0, z: -4 }));
    const low = anchors.current('surface-1')!;
    expect(low.status).toBe('low-confidence');
    expect(low.usable).toBe(false);
    expect(low.transform).toEqual(transform());
    const lowResolution = anchors.resolve('window-1');
    expect(lowResolution.status).toBe('low-confidence');
    expect(lowResolution.usable).toBe(false);
    expect(lowResolution.transform).toBeNull();

    anchors.observe('surface-1', transform({ x: 2, y: 0, z: -5 }), 0.9);
    expect(anchors.resolve('window-1').status).toBe('tracked');
    expect(anchors.resolve('window-1').usable).toBe(true);
    anchors.markUnavailable('surface-1');
    expect(anchors.status('surface-1')).toBe('unavailable');
    expect(anchors.current('surface-1')!.usable).toBe(false);
    expect(anchors.resolve('window-1').transform).toBeNull();
    expect(anchors.resolve('missing-window').status).toBe('unavailable');
    expect(anchors.follow('window-2', 'missing-anchor', transform())).toBe(false);
  });

  it('expires stale surface/object observations but keeps world anchors stable', () => {
    let now = 0;
    const anchors = new AnchorManager({ now: () => now });
    anchors.captureWorld('surface-1', transform(), 'surface');
    anchors.captureWorld('object-1', transform(), 'object');
    anchors.captureWorld('world-1', transform(), 'world');
    now = 5_001;
    expect(anchors.status('surface-1')).toBe('unavailable');
    expect(anchors.status('object-1')).toBe('unavailable');
    expect(anchors.status('world-1')).toBe('tracked');
    anchors.observe('surface-1', transform({ x: 1, y: 0, z: -5 }), 1);
    expect(anchors.status('surface-1')).toBe('tracked');
  });

  it('unanchors windows and removes dependent follows with an anchor', () => {
    const anchors = new AnchorManager();
    anchors.captureWorld('world-1', transform());
    anchors.captureWorld('world-2', transform({ x: 2, y: 0, z: -5 }));
    anchors.follow('window-1', 'world-1', transform({ x: 1, y: 0, z: -4 }));
    anchors.follow('window-2', 'world-2', transform({ x: 3, y: 0, z: -4 }));
    expect(anchors.unanchor('window-1')).toBe(true);
    expect(anchors.unanchor('window-1')).toBe(false);
    expect(anchors.resolve('window-1').status).toBe('unavailable');
    expect(anchors.resolve('window-2').status).toBe('tracked');
    expect(anchors.remove('world-2')).toBe(true);
    expect(anchors.resolve('window-2').status).toBe('unavailable');
    expect(anchors.current('world-2')).toBeNull();
    anchors.clear();
    expect(anchors.snapshot()).toEqual([]);
  });

  it('round-trips serializable stable IDs and numeric transforms only', () => {
    const anchors = new AnchorManager({ now: () => 10 });
    const rotation = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), 0.4);
    anchors.captureWorld('world-1', transform(), 'world', 0.9);
    anchors.captureWorld('surface-1', transform(
      { x: 1, y: 2, z: -3 },
      { x: rotation.x, y: rotation.y, z: rotation.z, w: rotation.w },
    ), 'surface', 0.8);
    const records = JSON.parse(JSON.stringify(anchors.snapshot())) as unknown[];
    const restored = new AnchorManager({ now: () => 20 });
    restored.restore(records);
    expect(restored.snapshot().map((record) => record.id)).toEqual(['world-1', 'surface-1']);
    expect(restored.current('world-1')!.kind).toBe('world');
    expect(restored.current('surface-1')!.confidence).toBe(0.8);
    expectTransform(restored.current('surface-1')!.transform, anchors.current('surface-1')!.transform);
    const stale = new AnchorManager({ now: () => 5_011 });
    stale.restore(records);
    expect(stale.status('surface-1')).toBe('unavailable');
    expect(stale.status('world-1')).toBe('tracked');

    restored.restore([
      { id: 'valid', kind: 'world', transform: transform(), confidence: 1 },
      { id: 'invalid', kind: 'invalid', transform: transform(), confidence: 1 },
      { id: 'nan', kind: 'world', transform: transform({ x: Number.NaN, y: 0, z: 0 }), confidence: 1 },
    ]);
    expect(restored.snapshot().map((record) => record.id)).toEqual(['valid']);
  });
});
