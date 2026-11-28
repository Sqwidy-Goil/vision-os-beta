import { describe, expect, it, vi } from 'vitest';
import { generatePairingCode } from '../src/spatial/companion/crypto';
import { decodeCompanionFrame, encodeCompanionFrame } from '../src/spatial/companion/codec';
import {
  acceptPairingJoin,
  createPairingJoin,
  createPairingMaterial,
  exportHostOffer,
  verifyPairingCode,
} from '../src/spatial/companion/pairing';
import { PairingSession, type CompanionSessionEvent } from '../src/spatial/companion/session';
import { assertTrustedLocalWssUrl } from '../src/spatial/companion/transport';
import type { CompanionCalibrationWire, CompanionTransport, CompanionTransportData } from '../src/spatial/companion/types';

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
    if (this.closedCode !== null || !this.peer) throw new Error('Fake transport is closed.');
    if (!(data instanceof Uint8Array)) throw new Error('Expected a binary companion frame.');
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

function link(): { host: FakeTransport; guest: FakeTransport } {
  const host = new FakeTransport();
  const guest = new FakeTransport();
  host.peer = guest;
  guest.peer = host;
  return { host, guest };
}

function calibration(): CompanionCalibrationWire {
  return {
    kind: 'calibration', calibrationId: 'cal-1', confidence: 0.95, frame: 'world-y-up-right-handed', depthUnits: 'meters',
    origin: [0, 0, 0], orientation: [0, 0, 0, 1],
  };
}

interface Harness {
  session: PairingSession;
  host: FakeTransport;
  guest: FakeTransport;
  events: CompanionSessionEvent[];
  guestErrors: Error[];
  now: number;
  key: Uint8Array | null;
  offer: Awaited<ReturnType<typeof decodeCompanionFrame>> | null;
  ack: Uint8Array | null;
  joinFrame: Uint8Array | null;
  encode(type: 'calibration' | 'sample' | 'close' | 'error', payload: Record<string, unknown>, seq: number): Promise<Uint8Array>;
  send(type: 'calibration' | 'sample' | 'close' | 'error', payload: Record<string, unknown>, seq: number): Promise<Uint8Array>;
}

async function harness(options: {
  now?: number;
  authorize?: boolean;
  autoAck?: boolean;
  autoJoin?: boolean;
  pairingTtlMs?: number;
  maxFrameBytes?: number;
  maxMessagesPerSecond?: number;
  guestCode?: (code: string) => string;
} = {}): Promise<Harness> {
  const transport = link();
  const events: CompanionSessionEvent[] = [];
  const guestErrors: Error[] = [];
  let now = options.now ?? 1000;
  let key: Uint8Array | null = null;
  let offer: Awaited<ReturnType<typeof decodeCompanionFrame>> | null = null;
  let ack: Uint8Array | null = null;
  let joinFrame: Uint8Array | null = null;
  const session = new PairingSession({
    url: 'wss://companion.local',
    now: () => now,
    transportFactory: () => transport.host,
    authorizePairing: () => options.authorize !== false,
    pairingTtlMs: options.pairingTtlMs,
    maxFrameBytes: options.maxFrameBytes,
    maxMessagesPerSecond: options.maxMessagesPerSecond,
    onEvent: (event) => events.push(event),
  });
  transport.guest.onError = (error) => guestErrors.push(error);
  transport.guest.onMessage = async (data) => {
    if (!(data instanceof Uint8Array)) throw new Error('Expected binary frame.');
    if (!offer) {
      offer = await decodeCompanionFrame(data, { now });
      const join = await createPairingJoin({
        offer: offer.payload as unknown as Parameters<typeof createPairingJoin>[0]['offer'],
        code: options.guestCode?.(session.code) ?? session.code,
        device: { name: 'Test iPhone', model: 'iPhone' },
        now,
      });
      key = join.sessionKey;
      joinFrame = await encodeCompanionFrame({
        sid: offer.header.sid, seq: 1, sentAt: now, type: 'join', payload: join.payload as unknown as Record<string, unknown>,
      }, { key });
      if (options.autoJoin !== false) transport.guest.send(joinFrame);
      return;
    }
    const ready = await decodeCompanionFrame(data, { key: key ?? undefined, expectedSid: offer.header.sid, expectedSeq: 1, now });
    if (ready.header.type !== 'ready') throw new Error('Expected ready message.');
    if (options.autoAck === false) return;
    ack = await encodeCompanionFrame({ sid: offer.header.sid, seq: 2, sentAt: now, type: 'ready-ack', payload: { kind: 'ready-ack' } }, { key: key ?? undefined });
    transport.guest.send(ack);
  };
  session.start();
  queueMicrotask(() => transport.host.onOpen?.());
  const result: Harness = {
    session, host: transport.host, guest: transport.guest, events, guestErrors,
    get now() { return now; },
    set now(value: number) { now = value; },
    get key() { return key; },
    get offer() { return offer; },
    get ack() { return ack; },
    get joinFrame() { return joinFrame; },
    encode: async (type, payload, seq) => {
      if (!offer || !key) throw new Error('Guest is not paired.');
      return encodeCompanionFrame({ sid: offer.header.sid, seq, sentAt: now, type, payload }, { key });
    },
    send: async (type, payload, seq) => {
      const bytes = await result.encode(type, payload, seq);
      transport.guest.send(bytes);
      return bytes;
    },
  };
  return result;
}

async function waitForEvent(events: CompanionSessionEvent[], type: CompanionSessionEvent['type']): Promise<void> {
  await vi.waitFor(() => expect(events.some((event) => event.type === type)).toBe(true), { timeout: 3000, interval: 5 });
}

describe('Web Crypto companion pairing', () => {
  it('generates unguessable decimal codes and verifies them in constant time', async () => {
    const codes = new Set(Array.from({ length: 64 }, () => generatePairingCode()));
    expect(codes.size).toBe(64);
    expect([...codes].every((code) => /^\d{10}$/.test(code))).toBe(true);
    const salt = new Uint8Array(16).fill(3);
    expect(await verifyPairingCode('12345678', '12345678', salt)).toBe(true);
    expect(await verifyPairingCode('12345678', '12345679', salt)).toBe(false);
    expect(await verifyPairingCode('12345678', '87654321', new Uint8Array(16).fill(4))).toBe(false);
  });

  it('derives matching session keys, rejects wrong codes, and enforces expiry', async () => {
    const material = await createPairingMaterial({ code: '12345678', now: 1000, pairingTtlMs: 30_000 });
    const offer = await exportHostOffer(material);
    const guest = await createPairingJoin({ offer, code: '12345678', device: { name: 'iPhone' }, now: 1000 });
    const accepted = await acceptPairingJoin({ material, join: guest.payload, now: 1000 });
    expect(Array.from(accepted.sessionKey)).toEqual(Array.from(guest.sessionKey));
    const wrong = await createPairingJoin({ offer, code: '87654321', device: { name: 'iPhone' }, now: 1000 });
    await expect(acceptPairingJoin({ material, join: wrong.payload, now: 1000 })).rejects.toThrow(/proof/i);
    await expect(acceptPairingJoin({ material, join: guest.payload, now: 31_000 })).rejects.toThrow(/expired/i);
  });

  it('allows only private, loopback, link-local, and mDNS WSS endpoints', () => {
    expect(assertTrustedLocalWssUrl('wss://192.168.1.20:8443/socket')).toContain('192.168.1.20');
    expect(assertTrustedLocalWssUrl('wss://localhost/socket')).toContain('localhost');
    expect(assertTrustedLocalWssUrl('wss://[fd00::1]/socket')).toContain('[fd00::1]');
    expect(assertTrustedLocalWssUrl('wss://vision.local/socket')).toContain('vision.local');
    expect(() => assertTrustedLocalWssUrl('ws://192.168.1.20/socket')).toThrow(/WSS/);
    expect(() => assertTrustedLocalWssUrl('wss://example.com/socket')).toThrow(/local/);
    expect(() => assertTrustedLocalWssUrl('wss://user:secret@localhost/socket')).toThrow(/local/);
  });
});

describe('authenticated companion session', () => {
  it('requires user authorization and completes an ECDH/HMAC handshake', async () => {
    const denied = await harness({ authorize: false });
    await waitForEvent(denied.events, 'error');
    expect(denied.events.find((event) => event.type === 'error')).toMatchObject({ error: expect.objectContaining({ message: expect.stringContaining('not authorized') }) });
    expect(denied.host.closedCode).toBe(1008);

    const accepted = await harness();
    await accepted.session.connected;
    expect(accepted.events.some((event) => event.type === 'joined')).toBe(true);
    expect(accepted.events.some((event) => event.type === 'connected')).toBe(true);
    expect(accepted.guestErrors).toEqual([]);
    accepted.session.disconnect();
  });

  it('expires a single-use pairing code before accepting a delayed join', async () => {
    const delayed = await harness({ pairingTtlMs: 30_000, autoJoin: false });
    await vi.waitFor(() => expect(delayed.joinFrame).not.toBeNull(), { timeout: 3000, interval: 5 });
    delayed.now = 31_000;
    const completion = delayed.session.connected.catch((error: unknown) => error);
    delayed.guest.send(delayed.joinFrame!);
    await waitForEvent(delayed.events, 'error');
    expect(delayed.events.find((event) => event.type === 'error')).toMatchObject({ error: expect.objectContaining({ message: expect.stringMatching(/expired/) }) });
    expect(await completion).toBeInstanceOf(Error);
    expect(delayed.host.closedCode).toBe(1008);
  });

  it('rejects replayed acknowledgements and stops the session', async () => {
    const active = await harness();
    await active.session.connected;
    expect(active.ack).not.toBeNull();
    active.guest.send(active.ack!);
    await waitForEvent(active.events, 'error');
    expect(active.events.find((event) => event.type === 'error')).toMatchObject({ error: expect.objectContaining({ message: expect.stringMatching(/replay|sequence/) }) });
    expect(active.host.closedCode).toBe(1008);
  });

  it('rejects tampered authenticated calibration frames', async () => {
    const active = await harness();
    await active.session.connected;
    const bytes = await active.encode('calibration', calibration() as unknown as Record<string, unknown>, 3);
    bytes[bytes.length - 1] ^= 1;
    active.guest.send(bytes);
    await waitForEvent(active.events, 'error');
    expect(active.events.find((event) => event.type === 'error')).toMatchObject({ error: expect.objectContaining({ message: expect.stringMatching(/authentication/) }) });
  });

  it('rejects oversized frames and strict schema violations', async () => {
    const active = await harness({ maxFrameBytes: 4096 });
    await active.session.connected;
    active.guest.send(new Uint8Array(4097));
    await waitForEvent(active.events, 'error');
    expect(active.events.find((event) => event.type === 'error')).toMatchObject({ error: expect.objectContaining({ message: expect.stringMatching(/frame limit/) }) });

    const malformed = await harness();
    await malformed.session.connected;
    await malformed.send('calibration', { ...calibration(), unexpected: true }, 3);
    await waitForEvent(malformed.events, 'error');
    expect(malformed.events.find((event) => event.type === 'error')).toMatchObject({ error: expect.objectContaining({ message: expect.stringMatching(/unknown fields/) }) });
  });

  it('enforces the authenticated message rate limit', async () => {
    const active = await harness({ maxMessagesPerSecond: 2 });
    await active.session.connected;
    await active.send('calibration', calibration() as unknown as Record<string, unknown>, 3);
    await active.send('calibration', calibration() as unknown as Record<string, unknown>, 4);
    await active.send('calibration', calibration() as unknown as Record<string, unknown>, 5);
    await waitForEvent(active.events, 'error');
    expect(active.events.find((event) => event.type === 'error')).toMatchObject({ error: expect.objectContaining({ message: expect.stringMatching(/rate limit/) }) });
  });
});
