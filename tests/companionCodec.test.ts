import { describe, expect, it } from 'vitest';
import type { CompanionSpatialSample } from '../src/spatial/intelligence/types';
import { bytesToBase64, bytesToBase64Url } from '../src/spatial/companion/crypto';
import {
  decodeCompanionFrame,
  encodeCompanionFrame,
  type DecodedCompanionFrame,
} from '../src/spatial/companion/codec';
import { CompanionSampleDecoder, fullSpatialUpdate, type CompanionSpatialUpdate } from '../src/spatial/companion/sample';
import { DEFAULT_MAX_FRAME_BYTES, type CompanionCalibrationWire } from '../src/spatial/companion/types';

const sid = bytesToBase64Url(new Uint8Array(16).fill(7));
const key = new Uint8Array(32).fill(9);

function calibration(): CompanionCalibrationWire {
  return {
    kind: 'calibration',
    calibrationId: 'arkit-world-1',
    confidence: 0.95,
    frame: 'world-y-up-right-handed',
    depthUnits: 'meters',
    origin: [0, 0, 0],
    orientation: [0, 0, 0, 1],
  };
}

function sample(frameId: number, timestamp: number): CompanionSpatialSample {
  const covariance = new Array<number>(36).fill(0);
  covariance[0] = covariance[7] = covariance[14] = 0.01;
  covariance[21] = covariance[28] = covariance[35] = 0.01;
  return {
    frameId,
    timestamp,
    pose: {
      frameId,
      timestamp,
      position: [0, 0, 0],
      quaternion: [0, 0, 0, 1],
      velocity: [0, 0, 0],
      covariance,
      confidence: 0.9,
      scale: 'metric',
      source: 'companion',
    },
    depth: {
      width: 2,
      height: 2,
      values: new Float32Array([0, 1, 2, 3]),
      confidence: new Float32Array([0, 0.9, 0.8, 0.7]),
      intrinsics: { width: 2, height: 2, fx: 2, fy: 2, cx: 1, cy: 1, timestamp, calibration: 'calibrated' },
    },
    surfaces: [{
      id: 'floor',
      kind: 'plane',
      normal: [0, 1, 0],
      point: [0, 0, 1],
      confidence: 0.9,
      observedAt: timestamp,
      source: 'companion',
      scale: 'metric',
    }],
    objects: [{
      id: 'object-1',
      label: 'chair',
      center: [1, 0.5, 2],
      extents: [0.5, 1, 0.5],
      pointIds: [1, 2],
      confidence: 0.8,
      observedAt: timestamp,
      source: 'companion',
      scale: 'metric',
    }],
    freeSpace: [{
      id: 'cell-1',
      center: [0, 0, 2],
      extents: [1, 1, 1],
      confidence: 0.7,
      observedAt: timestamp,
      source: 'companion',
      scale: 'metric',
    }],
    calibrationConfidence: 0.95,
  };
}

async function frameFor(update: CompanionSpatialUpdate, seq: number, timestamp: number, options: { base64?: boolean; compression?: boolean } = {}): Promise<DecodedCompanionFrame> {
  let payload = update as unknown as Record<string, unknown>;
  if (options.base64 && update.depth && update.depth.values instanceof Float32Array && update.depth.confidence instanceof Float32Array) {
    const encode = (values: Float32Array): string => {
      const bytes = new Uint8Array(values.length * 4);
      const view = new DataView(bytes.buffer);
      values.forEach((value, index) => view.setFloat32(index * 4, value, true));
      return bytesToBase64(bytes);
    };
    payload = { ...payload, depth: { ...update.depth, values: encode(update.depth.values), confidence: encode(update.depth.confidence) } };
  }
  const bytes = await encodeCompanionFrame({ sid, seq, sentAt: timestamp, type: 'sample', payload }, {
    key,
    depthEncoding: options.base64 ? 'base64' : 'float32le',
    compression: options.compression,
  });
  return decodeCompanionFrame(bytes, { key, expectedSid: sid, expectedSeq: seq, now: timestamp });
}

describe('companion spatial codec', () => {
  it('roundtrips gzip JSON, explicit little-endian Float32 depth, planes, meshes, objects, and confidence', async () => {
    const source = sample(1, 1000);
    source.surfaces.push({
      id: 'mesh-1', kind: 'mesh', vertices: [0, 0, 0, 1, 0, 0, 0, 1, 0], indices: [0, 1, 2],
      confidence: 0.85, observedAt: 1000, source: 'companion', scale: 'metric',
    });
    const frame = await frameFor(fullSpatialUpdate(source, 'arkit-world-1'), 3, 1000);
    expect(frame.header.payloadEncoding).toBe('gzip');
    expect(frame.header.depthEncoding).toBe('float32le');
    expect(new DataView(frame.depthChunk.buffer, frame.depthChunk.byteOffset).getFloat32(4, true)).toBe(1);
    const decoder = new CompanionSampleDecoder();
    decoder.setCalibration(calibration());
    const decoded = decoder.decode(frame.payload, frame);
    expect(decoded.frameId).toBe(1);
    expect(decoded.pose.source).toBe('companion');
    expect(decoded.pose.scale).toBe('metric');
    expect(Array.from(decoded.depth?.values ?? [])).toEqual([0, 1, 2, 3]);
    expect(Array.from(decoded.depth?.confidence ?? [])).toEqual(Array.from(source.depth!.confidence));
    expect(decoded.surfaces.map((surface) => surface.kind)).toEqual(['plane', 'mesh']);
    expect(decoded.objects[0].label).toBe('chair');
    expect(decoded.freeSpace[0].id).toBe('cell-1');
  });

  it('roundtrips the explicit base64 depth fallback without binary chunks', async () => {
    const frame = await frameFor(fullSpatialUpdate(sample(1, 1000), 'arkit-world-1'), 3, 1000, { base64: true, compression: false });
    expect(frame.header.payloadEncoding).toBe('identity');
    expect(frame.header.depthEncoding).toBe('base64');
    expect(frame.depthChunk.byteLength).toBe(0);
    const decoder = new CompanionSampleDecoder();
    decoder.setCalibration(calibration());
    expect(Array.from(decoder.decode(frame.payload, frame).depth?.values ?? [])).toEqual([0, 1, 2, 3]);
  });

  it('applies bounded depth rectangles and incremental environment upserts/removals without inventing depth', async () => {
    const decoder = new CompanionSampleDecoder();
    decoder.setCalibration(calibration());
    const first = await frameFor(fullSpatialUpdate(sample(1, 1000), 'arkit-world-1'), 3, 1000);
    decoder.decode(first.payload, first);
    const secondSample = sample(2, 1100);
    const update: CompanionSpatialUpdate = {
      ...fullSpatialUpdate(secondSample, 'arkit-world-1'),
      baseFrameId: 1,
      reset: false,
      depth: {
        mode: 'rect', width: 1, height: 1, x: 1, y: 1, baseWidth: 2, baseHeight: 2,
        intrinsics: secondSample.depth!.intrinsics,
        values: new Float32Array([2.5]), confidence: new Float32Array([0.95]),
      },
      surfaces: [{ id: 'wall', kind: 'plane', normal: [1, 0, 0], point: [0, 0, 1], confidence: 0.9, observedAt: 1100 }],
      objects: [{ id: 'object-1', label: 'chair', center: [1.5, 0.5, 2], extents: [0.5, 1, 0.5], pointIds: [1, 2], confidence: 0.8, observedAt: 1100 }],
      freeSpace: [],
      removed: { surfaces: ['floor'], objects: [], freeSpace: ['cell-1'] },
    };
    const second = await frameFor(update, 4, 1100);
    const decoded = decoder.decode(second.payload, second);
    expect(Array.from(decoded.depth?.values ?? [])).toEqual([0, 1, 2, 2.5]);
    expect(decoded.depth?.values[0]).toBe(0);
    expect(decoded.surfaces.map((surface) => surface.id)).toEqual(['wall']);
    expect(decoded.objects[0].center).toEqual([1.5, 0.5, 2]);
    expect(decoded.freeSpace).toEqual([]);
    const thirdSample = sample(3, 1200);
    const unchanged: CompanionSpatialUpdate = {
      ...fullSpatialUpdate(thirdSample, 'arkit-world-1'), baseFrameId: 2, reset: false,
      depth: { mode: 'unchanged', width: 2, height: 2, intrinsics: sample(1, 1000).depth!.intrinsics },
      surfaces: undefined, objects: undefined, freeSpace: undefined,
    };
    unchanged.depth!.intrinsics.timestamp = 1000;
    const third = await frameFor(unchanged, 5, 1200);
    const retained = decoder.decode(third.payload, third);
    expect(retained.depth).toBeUndefined();
    const fourthSample = sample(4, 1300);
    const delta: CompanionSpatialUpdate = {
      ...fullSpatialUpdate(fourthSample, 'arkit-world-1'), baseFrameId: 3, reset: false,
      poseMode: 'delta', pose: { position: [0.1, 0, 0], confidence: 0.8 },
      depth: {
        mode: 'rect', width: 1, height: 1, x: 0, y: 0, baseWidth: 2, baseHeight: 2,
        intrinsics: fourthSample.depth!.intrinsics, values: new Float32Array([3.5]), confidence: new Float32Array([0.9]),
      },
      surfaces: undefined, objects: undefined, freeSpace: undefined,
    };
    const fourth = await frameFor(delta, 6, 1300);
    const updated = decoder.decode(fourth.payload, fourth);
    expect(updated.pose.position[0]).toBeCloseTo(0.1);
    expect(updated.pose.confidence).toBe(0.8);
    expect(Array.from(updated.depth?.values ?? [])).toEqual([3.5, 1, 2, 2.5]);
    expect(updated.depth?.intrinsics.timestamp).toBe(1000);
  });

  it('transforms metric coordinates and covariance using the declared calibration', async () => {
    const calibrated = calibration();
    calibrated.origin = [1, 0, 0];
    calibrated.orientation = [0, 0, Math.SQRT1_2, Math.SQRT1_2];
    const source = sample(1, 1000);
    source.pose.position = [1, 0, 0];
    source.pose.covariance[0] = 4;
    const frame = await frameFor(fullSpatialUpdate(source, 'arkit-world-1'), 3, 1000);
    const decoder = new CompanionSampleDecoder();
    decoder.setCalibration(calibrated);
    const decoded = decoder.decode(frame.payload, frame);
    expect(decoded.pose.position[0]).toBeCloseTo(1);
    expect(decoded.pose.position[1]).toBeCloseTo(1);
    expect(decoded.pose.covariance[7]).toBeCloseTo(4);
    expect(decoded.pose.covariance[0]).toBeCloseTo(0.01);
    expect(decoded.surfaces[0].point?.[0]).toBeCloseTo(1);
    expect(decoded.surfaces[0].point?.[1]).toBeCloseTo(0);
    expect(decoded.surfaces[0].normal?.[0]).toBeCloseTo(-1);
  });

  it('rejects stale bases, unknown fields, estimated intrinsics, and out-of-bounds depth', async () => {
    const cases: CompanionSpatialUpdate[] = [];
    const stale = fullSpatialUpdate(sample(2, 1100), 'arkit-world-1');
    stale.baseFrameId = 1;
    stale.reset = false;
    cases.push(stale);
    const unknown = fullSpatialUpdate(sample(1, 1000), 'arkit-world-1') as CompanionSpatialUpdate & { secret?: string };
    unknown.secret = 'not-allowed';
    cases.push(unknown);
    const estimated = fullSpatialUpdate(sample(1, 1000), 'arkit-world-1');
    estimated.depth!.intrinsics.calibration = 'estimated';
    cases.push(estimated);
    const tooFar = fullSpatialUpdate(sample(1, 1000), 'arkit-world-1');
    const tooFarValues = tooFar.depth!.values;
    if (!(tooFarValues instanceof Float32Array)) throw new Error('Expected Float32Array depth values.');
    tooFarValues[1] = 31;
    cases.push(tooFar);
    const uncertain = fullSpatialUpdate(sample(1, 1000), 'arkit-world-1');
    const uncertainConfidence = uncertain.depth!.confidence;
    if (!(uncertainConfidence instanceof Float32Array)) throw new Error('Expected Float32Array depth confidence.');
    uncertainConfidence[1] = 1.1;
    cases.push(uncertain);
    for (const update of cases) {
      const frame = await frameFor(update, 3, 1000);
      const decoder = new CompanionSampleDecoder();
      decoder.setCalibration(calibration());
      expect(() => decoder.decode(frame.payload, frame)).toThrow();
    }
  });

  it('rejects incremental updates whose frame or depth intrinsics do not match', async () => {
    const decoder = new CompanionSampleDecoder();
    decoder.setCalibration(calibration());
    const first = await frameFor(fullSpatialUpdate(sample(1, 1000), 'arkit-world-1'), 3, 1000);
    decoder.decode(first.payload, first);
    const update = fullSpatialUpdate(sample(2, 1100), 'arkit-world-1');
    update.baseFrameId = 99;
    update.reset = false;
    const frame = await frameFor(update, 4, 1100);
    expect(() => decoder.decode(frame.payload, frame)).toThrow(/base|stale/i);
    const mismatchedSample = sample(3, 1200);
    const mismatched: CompanionSpatialUpdate = {
      ...fullSpatialUpdate(mismatchedSample, 'arkit-world-1'),
      baseFrameId: 1,
      reset: false,
      depth: {
        mode: 'unchanged', width: 2, height: 2,
        intrinsics: { ...sample(1, 1000).depth!.intrinsics, fx: 3 },
      },
      surfaces: undefined,
      objects: undefined,
      freeSpace: undefined,
    };
    const mismatchedFrame = await frameFor(mismatched, 5, 1200);
    expect(() => decoder.decode(mismatchedFrame.payload, mismatchedFrame)).toThrow(/base|intrinsics/i);
  });
});

describe('companion frame authentication and limits', () => {
  it('rejects tampered payload bytes, replayed sequence numbers, and oversized frames', async () => {
    const bytes = await encodeCompanionFrame({ sid, seq: 3, sentAt: 1000, type: 'sample', payload: fullSpatialUpdate(sample(1, 1000), 'arkit-world-1') as unknown as Record<string, unknown> }, { key });
    const tampered = bytes.slice();
    tampered[tampered.length - 1] ^= 1;
    await expect(decodeCompanionFrame(tampered, { key, expectedSid: sid, expectedSeq: 3, now: 1000 })).rejects.toThrow(/authentication/i);
    await expect(decodeCompanionFrame(bytes, { key, expectedSid: sid, expectedSeq: 2, now: 1000 })).rejects.toThrow(/replay|sequence/i);
    await expect(decodeCompanionFrame(new Uint8Array(DEFAULT_MAX_FRAME_BYTES + 1), { key, now: 1000 })).rejects.toThrow(/frame limit/i);
  });
});
