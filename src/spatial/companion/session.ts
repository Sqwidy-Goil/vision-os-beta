import { generatePairingCode } from './crypto';
import {
  assertExactKeys,
  CompanionProtocolError,
  decodeCompanionFrame,
  encodeCompanionFrame,
  wipeKey,
  type CompanionFrameInput,
} from './codec';
import {
  acceptPairingJoin,
  createPairingMaterial,
  exportHostOffer,
  type AcceptedPairing,
  type PairingMaterial,
  type PairingOfferPayload,
} from './pairing';
import { CompanionSampleDecoder } from './sample';
import { assertTrustedLocalWssUrl, createWebSocketTransport } from './transport';
import {
  DEFAULT_MAX_FRAME_BYTES,
  DEFAULT_MAX_MESSAGES_PER_SECOND,
  type CompanionCalibrationWire,
  type CompanionDevice,
  type CompanionPairingAuthorization,
  type CompanionTransport,
  type CompanionTransportData,
  type CompanionTransportFactory,
} from './types';
import type { CompanionSpatialSample } from '../intelligence/types';

export type PairingSessionState = 'connecting' | 'pairing' | 'authorizing' | 'ready' | 'connected' | 'closed' | 'error';

export type CompanionSessionEvent =
  | { type: 'pairing'; code: string; expiresAt: number }
  | { type: 'joined'; device: CompanionDevice; keyFingerprint: string }
  | { type: 'connected'; sessionExpiresAt: number }
  | { type: 'calibration'; calibration: ReturnType<CompanionSampleDecoder['setCalibration']> }
  | { type: 'sample'; sample: CompanionSpatialSample }
  | { type: 'error'; error: Error }
  | { type: 'disconnected'; reason: string; error: boolean };

export interface PairingSessionOptions {
  url: string;
  authorizePairing: (request: CompanionPairingAuthorization) => boolean | Promise<boolean>;
  transportFactory?: CompanionTransportFactory;
  pairingTtlMs?: number;
  sessionTtlMs?: number;
  openTimeoutMs?: number;
  maxFrameBytes?: number;
  maxMessagesPerSecond?: number;
  now?: () => number;
  crypto?: Crypto;
  onEvent: (event: CompanionSessionEvent) => void;
}

function validLimit(value: number | undefined, fallback: number, min: number, max: number): number {
  const output = value ?? fallback;
  if (!Number.isInteger(output) || output < min || output > max) throw new CompanionProtocolError('Invalid companion protocol limit.');
  return output;
}

export class PairingSession {
  readonly code: string;
  readonly connected: Promise<void>;
  private readonly url: string;
  private readonly options: PairingSessionOptions;
  private readonly now: () => number;
  private readonly decoder = new CompanionSampleDecoder();
  private readonly pairingTtlMs: number;
  private readonly maxFrameBytes: number;
  private readonly maxMessagesPerSecond: number;
  private transport: CompanionTransport | null = null;
  private material: PairingMaterial | null = null;
  private offer: PairingOfferPayload | null = null;
  private accepted: AcceptedPairing | null = null;
  private key: Uint8Array | null = null;
  private state: PairingSessionState = 'connecting';
  private started = false;
  private generation = 0;
  private queue: Promise<void> = Promise.resolve();
  private remoteSequence = 0;
  private rateWindow = 0;
  private rateCount = 0;
  private expiryTimer: ReturnType<typeof setTimeout> | null = null;
  private openTimer: ReturnType<typeof setTimeout> | null = null;
  private resolveConnected!: () => void;
  private rejectConnected!: (error: Error) => void;
  private completionSettled = false;

  constructor(options: PairingSessionOptions) {
    this.url = assertTrustedLocalWssUrl(options.url);
    if (typeof options.authorizePairing !== 'function' || typeof options.onEvent !== 'function') throw new Error('Companion pairing requires explicit authorization and an event listener.');
    this.options = options;
    this.now = options.now ?? Date.now;
    this.code = generatePairingCode(options.crypto);
    this.pairingTtlMs = validLimit(options.pairingTtlMs, 120_000, 30_000, 300_000);
    this.maxFrameBytes = validLimit(options.maxFrameBytes, DEFAULT_MAX_FRAME_BYTES, 1024, 4 * 1024 * 1024);
    this.maxMessagesPerSecond = validLimit(options.maxMessagesPerSecond, DEFAULT_MAX_MESSAGES_PER_SECOND, 1, 120);
    this.rateWindow = this.now();
    this.connected = new Promise<void>((resolve, reject) => {
      this.resolveConnected = resolve;
      this.rejectConnected = reject;
    });
    void this.connected.catch(() => undefined);
  }

  get status(): PairingSessionState {
    return this.statusAt(this.now());
  }

  get pairingExpiresAt(): number {
    return this.material?.pairingExpiresAt ?? this.rateWindow + this.pairingTtlMs;
  }

  get pairingOffer(): PairingOfferPayload | null {
    return this.offer;
  }

  get sessionExpiresAt(): number | null {
    return this.material?.sessionExpiresAt ?? null;
  }

  start(): void {
    if (this.started) throw new Error('Companion pairing session has already started.');
    this.started = true;
    try {
      this.transport = (this.options.transportFactory ?? createWebSocketTransport)(this.url);
      this.transport.onOpen = () => this.enqueue(() => this.open());
      this.transport.onMessage = (data) => this.receive(data);
      this.transport.onClose = (code, reason) => this.transportClosed(code, reason);
      this.transport.onError = (error) => this.fail(error);
      const timeout = validLimit(this.options.openTimeoutMs, 10_000, 1000, 60_000);
      this.openTimer = setTimeout(() => this.fail(new Error('Companion WebSocket connection timed out.')), timeout);
      this.armExpiry();
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error('Companion transport could not start.'));
    }
  }

  disconnect(reason = 'Companion session closed by the user.'): void {
    if (this.state === 'closed' || this.state === 'error') return;
    this.terminate(false, reason);
  }

  private statusAt(now: number): PairingSessionState {
    if ((this.state === 'pairing' || this.state === 'authorizing') && this.material && now >= this.material.pairingExpiresAt) return 'error';
    if ((this.state === 'connected' || this.state === 'ready') && this.material && now >= this.material.sessionExpiresAt) return 'error';
    return this.state;
  }

  private armExpiry(): void {
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    const deadline = this.state === 'connected' || this.state === 'ready' ? this.material?.sessionExpiresAt : this.material?.pairingExpiresAt;
    if (deadline === undefined) return;
    this.expiryTimer = setTimeout(() => this.fail(new Error(this.state === 'connected' ? 'Companion session expired.' : 'Companion pairing code expired.')), Math.max(0, deadline - this.now()));
  }

  private async open(): Promise<void> {
    const generation = this.generation;
    if (this.openTimer) clearTimeout(this.openTimer);
    this.openTimer = null;
    if (this.state !== 'connecting') return;
    const now = this.now();
    this.material = await createPairingMaterial({
      code: this.code,
      now,
      pairingTtlMs: this.pairingTtlMs,
      sessionTtlMs: validLimit(this.options.sessionTtlMs, 60 * 60 * 1000, 60_000, 2 * 60 * 60 * 1000),
      maxFrameBytes: this.maxFrameBytes,
      maxMessagesPerSecond: this.maxMessagesPerSecond,
      crypto: this.options.crypto,
    });
    this.rateWindow = now;
    this.offer = await exportHostOffer(this.material, this.options.crypto);
    if (generation !== this.generation || this.state !== 'connecting') return;
    if (this.offer.sid !== this.material.sid) throw new CompanionProtocolError('Pairing offer session mismatch.');
    this.state = 'pairing';
    await this.write({ sid: this.material.sid, seq: 0, sentAt: this.now(), type: 'offer', payload: this.offer as unknown as Record<string, unknown> });
    this.emit({ type: 'pairing', code: this.code, expiresAt: this.material.pairingExpiresAt });
    this.armExpiry();
  }

  private receive(data: CompanionTransportData): void {
    const generation = this.generation;
    this.enqueue(async () => {
      if (generation !== this.generation || this.state === 'closed' || this.state === 'error') return;
      this.consumeRate();
      if (!this.material) throw new CompanionProtocolError('Companion sent data before its pairing offer.');
      if (this.state === 'pairing' || this.state === 'authorizing') {
        if (this.now() >= this.material.pairingExpiresAt) throw new CompanionProtocolError('Companion pairing code expired.');
        const unverified = await decodeCompanionFrame(data, {
          crypto: this.options.crypto,
          expectedSid: this.material.sid,
          expectedSeq: 1,
          now: this.now(),
          maxFrameBytes: this.maxFrameBytes,
          allowPairingJoin: true,
        });
        if (unverified.header.type !== 'join' || unverified.payload.kind !== 'join') throw new CompanionProtocolError('Companion pairing requires a join message.');
        const join = unverified.payload as unknown as Parameters<typeof acceptPairingJoin>[0]['join'];
        this.accepted = await acceptPairingJoin({ material: this.material, join, now: this.now(), crypto: this.options.crypto });
        this.key = this.accepted.sessionKey;
        const verified = await decodeCompanionFrame(data, {
          key: this.key,
          crypto: this.options.crypto,
          expectedSid: this.material.sid,
          expectedSeq: 1,
          now: this.now(),
          maxFrameBytes: this.maxFrameBytes,
        });
        if (JSON.stringify(verified.payload) !== JSON.stringify(unverified.payload)) throw new CompanionProtocolError('Pairing join changed during authentication.');
        this.remoteSequence = 1;
        this.state = 'authorizing';
        this.material.code = '';
        this.emit({ type: 'joined', device: this.accepted.device, keyFingerprint: this.accepted.keyFingerprint });
        let authorized: boolean;
        try {
          authorized = await this.options.authorizePairing({
            device: this.accepted.device,
            keyFingerprint: this.accepted.keyFingerprint,
            endpoint: this.url,
            expiresAt: this.material.pairingExpiresAt,
          });
        } catch {
          authorized = false;
        }
        if (this.state !== 'authorizing' || this.generation !== generation) return;
        if (!authorized) throw new CompanionProtocolError('Companion pairing was not authorized by the user.');
        await this.write({
          sid: this.material.sid,
          seq: 1,
          sentAt: this.now(),
          type: 'ready',
          key: this.key,
          payload: {
            kind: 'ready',
            sessionExpiresAt: this.material.sessionExpiresAt,
            maxFrameBytes: this.maxFrameBytes,
            maxMessagesPerSecond: this.maxMessagesPerSecond,
            features: this.offer?.features,
          },
        });
        this.state = 'ready';
        return;
      }
      if ((this.state !== 'connected' && this.state !== 'ready') || !this.key) throw new CompanionProtocolError('Companion session is not authenticated.');
      if (this.now() >= this.material.sessionExpiresAt) throw new CompanionProtocolError('Companion session expired.');
      const expectedSequence = this.remoteSequence + 1;
      const frame = await decodeCompanionFrame(data, {
        key: this.key,
        crypto: this.options.crypto,
        expectedSid: this.material.sid,
        expectedSeq: expectedSequence,
        now: this.now(),
        maxFrameBytes: this.maxFrameBytes,
      });
      this.remoteSequence = expectedSequence;
      if (frame.header.type === 'ready-ack') {
        assertExactKeys(frame.payload, ['kind'], [], 'Companion ready acknowledgement');
        if (frame.payload.kind !== 'ready-ack') throw new CompanionProtocolError('Invalid companion ready acknowledgement.');
        this.state = 'connected';
        this.rateWindow = this.now();
        this.rateCount = 0;
        this.armExpiry();
        this.emit({ type: 'connected', sessionExpiresAt: this.material.sessionExpiresAt });
        this.resolveCompletion();
      } else if (frame.header.type === 'calibration' && this.state === 'connected') {
        const calibration = this.decoder.setCalibration(frame.payload as unknown as CompanionCalibrationWire);
        this.emit({ type: 'calibration', calibration });
      } else if (frame.header.type === 'sample' && this.state === 'connected') {
        this.emit({ type: 'sample', sample: this.decoder.decode(frame.payload, frame) });
      } else if (frame.header.type === 'close') {
        assertExactKeys(frame.payload, ['kind', 'reason'], [], 'Companion close message');
        if (frame.payload.kind !== 'close' || typeof frame.payload.reason !== 'string' || frame.payload.reason.length > 120) throw new CompanionProtocolError('Invalid companion close message.');
        this.terminate(false, frame.payload.reason);
      } else if (frame.header.type === 'error') {
        assertExactKeys(frame.payload, ['kind', 'code', 'message'], [], 'Companion error message');
        if (frame.payload.kind !== 'error' || typeof frame.payload.code !== 'string' || frame.payload.code.length > 40 || typeof frame.payload.message !== 'string' || frame.payload.message.length > 200) {
          throw new CompanionProtocolError('Invalid companion error message.');
        }
        this.terminate(false, `${frame.payload.code}: ${frame.payload.message}`);
      } else {
        throw new CompanionProtocolError('Unexpected companion message type.');
      }
    });
  }

  private consumeRate(): void {
    const now = this.now();
    if (now - this.rateWindow >= 1000) {
      this.rateWindow = now;
      this.rateCount = 0;
    }
    this.rateCount += 1;
    if (this.rateCount > this.maxMessagesPerSecond) throw new CompanionProtocolError('Companion message rate limit exceeded.');
  }

  private async write(input: CompanionFrameInput): Promise<void> {
    if (!this.transport || this.state === 'closed' || this.state === 'error') return;
    const frame = await encodeCompanionFrame(input, {
      key: input.key,
      crypto: this.options.crypto,
      maxFrameBytes: this.maxFrameBytes,
    });
    this.transport.send(frame);
  }

  private enqueue(operation: () => void | Promise<void>): void {
    const generation = this.generation;
    this.queue = this.queue.then(async () => {
      if (generation !== this.generation || this.state === 'closed' || this.state === 'error') return;
      await operation();
    }).catch((error: unknown) => {
      if (generation === this.generation) this.fail(error instanceof Error ? error : new Error('Companion protocol failed.'));
    });
  }

  private transportClosed(code: number, reason: string): void {
    if (this.state === 'closed' || this.state === 'error') return;
    if (this.state === 'connected') this.terminate(false, reason || `Companion transport closed (${code}).`);
    else this.fail(new Error(reason || `Companion transport closed before pairing completed (${code}).`));
  }

  private fail(error: Error): void {
    if (this.state === 'closed' || this.state === 'error') return;
    this.state = 'error';
    this.cleanup();
    this.emit({ type: 'error', error });
    this.emit({ type: 'disconnected', reason: error.message, error: true });
    this.rejectCompletion(error);
    try { this.transport?.close(1008, error.message.slice(0, 100)); } catch { /* The transport may already be closed. */ }
  }

  private terminate(error: boolean, reason: string): void {
    if (this.state === 'closed' || this.state === 'error') return;
    this.state = 'closed';
    this.cleanup();
    this.emit({ type: 'disconnected', reason, error });
    if (!this.completionSettled) this.rejectCompletion(new Error(reason));
    try { this.transport?.close(1000, reason.slice(0, 100)); } catch { /* The transport may already be closed. */ }
  }

  private cleanup(): void {
    if (this.openTimer) clearTimeout(this.openTimer);
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    this.openTimer = null;
    this.expiryTimer = null;
    wipeKey(this.key);
    this.key = null;
    if (this.accepted) wipeKey(this.accepted.sessionKey);
    this.accepted = null;
    this.material?.salt.fill(0);
    this.decoder.reset();
    this.generation += 1;
  }

  private resolveCompletion(): void {
    if (this.completionSettled) return;
    this.completionSettled = true;
    this.resolveConnected();
  }

  private rejectCompletion(error: Error): void {
    if (this.completionSettled) return;
    this.completionSettled = true;
    this.rejectConnected(error);
  }

  private emit(event: CompanionSessionEvent): void {
    try { this.options.onEvent(event); } catch { /* A status subscriber must not interrupt the protocol. */ }
  }
}
