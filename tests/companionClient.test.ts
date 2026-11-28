import { describe, expect, it, vi } from 'vitest';
import { CompanionClient } from '../src/spatial/companion/client';
import { decodeCompanionFrame, encodeCompanionFrame } from '../src/spatial/companion/codec';
import { createPairingJoin } from '../src/spatial/companion/pairing';
import { fullSpatialUpdate } from '../src/spatial/companion/sample';
import type { CompanionCalibrationWire, CompanionTransport, CompanionTransportData } from '../src/spatial/companion/types';
import type { CompanionSpatialSample } from '../src/spatial/intelligence/types';

class FakeTransport implements CompanionTransport {
  readonly kind = 'websocket' as const;
  onOpen: (() => void) | null = null;
  onMessage: ((data: CompanionTransportData) => void | Promise<void>) | null = null;
  onClose: ((code: number, reason: string) => void) | null = null;
  onError: ((error: Error) => void) | null = null;
  peer: FakeTransport | null = null;
  sent: Uint8Array[] = [];
  closedCode: number | null = null;

  send(data: CompanionTransportData): void {
    if (this.closedCode !== null || !(data instanceof Uint8Array) || !this.peer) throw new Error('Companion transport is closed.');
    const copy = data.slice();
    this.sent.push(copy);
    queueMicrotask(() => this.peer?.receive(copy));
  }

  close(code = 1000, reason = 'Closed'): void {
    if (this.closedCode !== null) return;
    this.closedCode = code;
    queueMicrotask(() => {
      this.onClose?.(code, reason);
      this.peer?.remoteClose(code, reason);
    });
  }

  receive(data: Uint8Array): void {
    try {
      void Promise.resolve(this.onMessage?.(data)).catch((error: unknown) => this.onError?.(error instanceof Error ? error : new Error('Fake delivery failed.')));
    } catch (error) {
      this.onError?.(error instanceof Error ? error : new Error('Fake delivery failed.'));
    }
  }

  remoteClose(code: number, reason: string): void {
    if (this.closedCode !== null) return;
    this.closedCode = code;
    this.onClose?.(code, reason);
  }
}

function calibration(): CompanionCalibrationWire {
  return {
    kind: 'calibration', calibrationId: 'cal-1', confidence: 0.95, frame: 'world-y-up-right-handed', depthUnits: 'meters',
    origin: [0, 0, 0], orientation: [0, 0, 0, 1],
  };
}

function sample(): CompanionSpatialSample {
  const covariance = new Array<number>(36).fill(0);
  covariance[0] = covariance[7] = covariance[14] = 0.01;
  covariance[21] = covariance[28] = covariance[35] = 0.01;
  return {
    frameId: 1,
    timestamp: 1000,
    pose: {
      frameId: 1, timestamp: 1000, position: [0, 0, 0], quaternion: [0, 0, 0, 1], velocity: [0, 0, 0], covariance,
      confidence: 0.9, scale: 'metric', source: 'companion',
    },
    depth: {
      width: 2, height: 2, values: new Float32Array([0, 1, 2, 3]), confidence: new Float32Array([0, 0.9, 0.8, 0.7]),
      intrinsics: { width: 2, height: 2, fx: 2, fy: 2, cx: 1, cy: 1, timestamp: 1000, calibration: 'calibrated' },
    },
    surfaces: [], objects: [], freeSpace: [], calibrationConfidence: 0.95,
  };
}

interface ClientHarness {
  client: CompanionClient;
  host: FakeTransport;
  guest: FakeTransport;
  intelligence: { ingestCompanion: ReturnType<typeof vi.fn>; resetSession: ReturnType<typeof vi.fn> };
  fallback: ReturnType<typeof vi.fn>;
  factory: ReturnType<typeof vi.fn>;
  guestErrors: Error[];
  now: number;
  key: Uint8Array | null;
  sid: string | null;
  pair(): Promise<{ code: string; completion: Promise<void> }>;
  sendCalibration(seq?: number): Promise<void>;
  sendSample(seq?: number, extra?: Record<string, unknown>): Promise<void>;
}

async function clientHarness(enabled = false): Promise<ClientHarness> {
  const host = new FakeTransport();
  const guest = new FakeTransport();
  host.peer = guest;
  guest.peer = host;
  const intelligence = { ingestCompanion: vi.fn(), resetSession: vi.fn() };
  const fallback = vi.fn();
  const factory = vi.fn(() => host);
  let now = 1000;
  let pairingCode = '';
  let key: Uint8Array | null = null;
  let sid: string | null = null;
  let remoteSequence = 2;
  const guestErrors: Error[] = [];
  guest.onError = (error) => guestErrors.push(error);
  guest.onMessage = async (data) => {
    if (!(data instanceof Uint8Array)) throw new Error('Expected binary frame.');
    if (!sid) {
      const offer = await decodeCompanionFrame(data, { now });
      const join = await createPairingJoin({
        offer: offer.payload as unknown as Parameters<typeof createPairingJoin>[0]['offer'], code: pairingCode,
        device: { name: 'Test iPhone' }, now,
      });
      key = join.sessionKey;
      sid = offer.header.sid;
      guest.send(await encodeCompanionFrame({ sid, seq: 1, sentAt: now, type: 'join', payload: join.payload as unknown as Record<string, unknown> }, { key }));
      return;
    }
    const ready = await decodeCompanionFrame(data, { key: key ?? undefined, expectedSid: sid, expectedSeq: 1, now });
    if (ready.header.type !== 'ready') throw new Error('Expected ready.');
    guest.send(await encodeCompanionFrame({ sid, seq: 2, sentAt: now, type: 'ready-ack', payload: { kind: 'ready-ack' } }, { key: key ?? undefined }));
  };
  const client = new CompanionClient({
    intelligence,
    getCompanionEnabled: () => enabled,
    transportFactory: factory,
    now: () => now,
    staleTimeoutMs: 10_000,
    onFallbackRequired: fallback,
  });
  const harness: ClientHarness = {
    client, host, guest, intelligence, fallback, factory, guestErrors,
    get now() { return now; },
    set now(value: number) { now = value; },
    get key() { return key; },
    get sid() { return sid; },
    pair: async () => {
      const request = client.pair({ url: 'wss://companion.local', authorizePairing: () => true });
      pairingCode = request.code;
      queueMicrotask(() => host.onOpen?.());
      return { code: request.code, completion: request.completion };
    },
    sendCalibration: async (seq = 3) => {
      if (!sid || !key) throw new Error('Not paired.');
      const bytes = await encodeCompanionFrame({ sid, seq, sentAt: now, type: 'calibration', payload: calibration() as unknown as Record<string, unknown> }, { key });
      guest.send(bytes);
      remoteSequence = seq;
    },
    sendSample: async (seq = remoteSequence + 1, extra = {}) => {
      if (!sid || !key) throw new Error('Not paired.');
      const payload = { ...(fullSpatialUpdate(sample(), 'cal-1') as unknown as Record<string, unknown>), ...extra };
      const bytes = await encodeCompanionFrame({ sid, seq, sentAt: now, type: 'sample', payload }, { key });
      guest.send(bytes);
      remoteSequence = seq;
    },
  };
  return harness;
}

describe('companion host client API', () => {
  it('is disabled by default, requires explicit enable, and exposes pairing/connect compatibility', async () => {
    const h = await clientHarness();
    expect(h.client.getStatus().status).toBe('idle');
    expect(h.client.getStatus().enabled).toBe(false);
    expect(() => h.client.pair({ url: 'wss://companion.local', authorizePairing: () => true })).toThrow(/disabled/);
    h.client.setEnabled(true);
    expect(h.client.enable()).toBe(true);
    const statuses: string[] = [];
    const unsubscribe = h.client.subscribe((status) => statuses.push(status.status));
    const pairing = await h.pair();
    expect(pairing.code).toMatch(/^\d{10}$/);
    expect(h.client.getStatus().status).toBe('pairing');
    await pairing.completion;
    expect(h.client.getStatus()).toMatchObject({
      status: 'connected', enabled: true, quality: 'none', latestTimestamp: null,
      compatibility: { supported: true, transport: 'wss', payloadAuthentication: 'hmac-sha256', encryption: 'wss-only' },
    });
    expect(statuses).toContain('pairing');
    expect(statuses).toContain('connected');
    unsubscribe();
    h.client.disconnect();
    expect(h.guestErrors).toEqual([]);
  });

  it('reports insecure or non-local endpoints as errors without opening a transport', async () => {
    const h = await clientHarness();
    h.client.setEnabled(true);
    expect(() => h.client.pair({ url: 'wss://example.com/socket', authorizePairing: () => true })).toThrow(/local/);
    expect(h.client.getStatus()).toMatchObject({ status: 'error', reconnect: { state: 'manual-required' }, latestTimestamp: null });
    expect(h.factory).not.toHaveBeenCalled();
  });

  it('ingests only calibrated validated samples and clears all stale metrics on disconnect', async () => {
    const h = await clientHarness();
    h.client.setEnabled(true);
    const pairing = await h.pair();
    await pairing.completion;
    await h.sendCalibration();
    await vi.waitFor(() => expect(h.client.getStatus().calibration.state).toBe('calibrated'), { timeout: 3000, interval: 5 });
    expect(h.intelligence.ingestCompanion).not.toHaveBeenCalled();
    await h.sendSample();
    await vi.waitFor(() => expect(h.client.getStatus().status).toBe('calibrated'), { timeout: 3000, interval: 5 });
    expect(h.intelligence.ingestCompanion).toHaveBeenCalledTimes(1);
    expect(h.client.getStatus()).toMatchObject({ quality: 'good', latestTimestamp: 1000 });
    const sentBeforeDisconnect = h.host.sent.length;
    h.client.disconnect();
    expect(h.host.closedCode).toBe(1000);
    expect(h.client.getStatus()).toMatchObject({
      status: 'disconnected', quality: 'none', latestTimestamp: null,
      calibration: { state: 'uncalibrated' }, reconnect: { state: 'manual-required' },
    });
    expect(h.intelligence.resetSession).toHaveBeenCalledTimes(1);
    expect(h.fallback).toHaveBeenCalledTimes(1);
    expect(h.host.sent.length).toBe(sentBeforeDisconnect);
    await vi.waitFor(() => expect(h.guest.closedCode).toBe(1000), { timeout: 1000, interval: 5 });
    expect(() => h.guest.send(new Uint8Array([1, 2, 3]))).toThrow(/closed/);
    expect(h.intelligence.ingestCompanion).toHaveBeenCalledTimes(1);
  });

  it('reports manual reconnect after unexpected transport loss without silently reconnecting', async () => {
    const h = await clientHarness();
    h.client.setEnabled(true);
    const pairing = await h.pair();
    await pairing.completion;
    await h.sendCalibration();
    await h.sendSample();
    await vi.waitFor(() => expect(h.client.getStatus().status).toBe('calibrated'), { timeout: 3000, interval: 5 });
    h.guest.close(1006, 'Network lost');
    await vi.waitFor(() => expect(h.client.getStatus().status).toBe('disconnected'), { timeout: 3000, interval: 5 });
    expect(h.client.getStatus()).toMatchObject({ latestTimestamp: null, quality: 'none', reconnect: { state: 'manual-required' } });
    expect(h.intelligence.resetSession).toHaveBeenCalledTimes(1);
    expect(h.factory).toHaveBeenCalledTimes(1);
    expect(h.fallback).toHaveBeenCalledWith(expect.stringContaining('Network lost'));
  });

  it('expires stale samples locally and closes the link instead of retaining metric data', async () => {
    const h = await clientHarness();
    h.client.setEnabled(true);
    const pairing = await h.pair();
    await pairing.completion;
    await h.sendCalibration();
    await h.sendSample();
    await vi.waitFor(() => expect(h.client.getStatus().status).toBe('calibrated'), { timeout: 3000, interval: 5 });
    h.now = 11_001;
    expect(h.client.getStatus()).toMatchObject({ status: 'disconnected', latestTimestamp: null, quality: 'none', reconnect: { state: 'manual-required' } });
    expect(h.host.closedCode).toBe(1000);
    expect(h.intelligence.resetSession).toHaveBeenCalledTimes(1);
    expect(h.fallback).toHaveBeenCalledWith(expect.stringMatching(/expired|stale/));
  });

  it('moves malformed authenticated data to error and discards the previous sample', async () => {
    const h = await clientHarness();
    h.client.setEnabled(true);
    const pairing = await h.pair();
    await pairing.completion;
    await h.sendCalibration();
    await h.sendSample();
    await vi.waitFor(() => expect(h.client.getStatus().status).toBe('calibrated'), { timeout: 3000, interval: 5 });
    await h.sendSample(5, { unexpected: true });
    await vi.waitFor(() => expect(h.client.getStatus().status).toBe('error'), { timeout: 3000, interval: 5 });
    expect(h.client.getStatus()).toMatchObject({ latestTimestamp: null, quality: 'none', reconnect: { state: 'manual-required' } });
    expect(h.client.getStatus().error).toMatch(/unknown fields/);
    expect(h.intelligence.ingestCompanion).toHaveBeenCalledTimes(1);
    expect(h.intelligence.resetSession).toHaveBeenCalledTimes(1);
    expect(h.host.closedCode).toBe(1008);
  });
});
