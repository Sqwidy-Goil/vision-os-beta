import { loadSettings } from '../../core/settings';
import type { CompanionSpatialSample, SpatialIntelligence } from '../intelligence/types';
import { CompanionProtocolError } from './codec';
import { PairingSession, type CompanionSessionEvent } from './session';
import { createWebSocketTransport } from './transport';
import {
  COMPANION_PROTOCOL_VERSION,
  type CompanionCalibrationState,
  type CompanionClientOptions,
  type CompanionClientStatus,
  type CompanionCompatibility,
  type CompanionConnectionOptions,
  type CompanionPairingRequest,
  type CompanionQuality,
} from './types';

function unknownCompatibility(): CompanionCompatibility {
  return {
    supported: false,
    protocolVersion: null,
    reason: null,
    transport: 'wss',
    payloadAuthentication: 'hmac-sha256',
    encryption: 'wss-only',
    compression: ['gzip', 'identity'],
    depthEncodings: ['float32le', 'base64'],
  };
}

function initialStatus(enabled: boolean): CompanionClientStatus {
  return {
    status: 'idle',
    enabled,
    pairingCode: null,
    pairingExpiresAt: null,
    compatibility: unknownCompatibility(),
    calibration: { state: 'uncalibrated', confidence: 0, calibrationId: null, frame: null, updatedAt: null, reason: null },
    quality: 'none',
    latestTimestamp: null,
    connectedAt: null,
    error: null,
    reconnect: { state: 'idle', reason: null },
  };
}

function cloneStatus(status: CompanionClientStatus): CompanionClientStatus {
  return {
    ...status,
    compatibility: { ...status.compatibility, compression: [...status.compatibility.compression], depthEncodings: [...status.compatibility.depthEncodings] },
    calibration: { ...status.calibration },
    reconnect: { ...status.reconnect },
  };
}

function sampleQuality(sample: CompanionSpatialSample): CompanionQuality {
  const score = Math.min(sample.pose.confidence, sample.calibrationConfidence);
  if (score < 0.4) return 'poor';
  if (!sample.depth) return score >= 0.75 ? 'good' : 'usable';
  let usable = 0;
  for (let index = 0; index < sample.depth.values.length; index += 1) {
    if (sample.depth.values[index] >= 0.05 && sample.depth.confidence[index] >= 0.45) usable += 1;
  }
  return score >= 0.75 && usable / sample.depth.values.length >= 0.5 ? 'good' : 'usable';
}

export class CompanionClient {
  private readonly intelligence: Pick<SpatialIntelligence, 'ingestCompanion' | 'resetSession'>;
  private readonly getCompanionEnabled: () => boolean;
  private readonly transportFactory: CompanionClientOptions['transportFactory'];
  private readonly now: () => number;
  private readonly crypto?: Crypto;
  private readonly staleTimeoutMs: number;
  private readonly onFallbackRequired?: (reason: string) => void;
  private readonly listeners = new Set<(status: CompanionClientStatus) => void>();
  private session: PairingSession | null = null;
  private status: CompanionClientStatus;
  private enabledOverride: boolean | null = null;
  private lastArrival: number | null = null;
  private freshnessTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  constructor(options: CompanionClientOptions) {
    this.intelligence = options.intelligence;
    this.now = options.now ?? Date.now;
    this.crypto = options.crypto;
    this.transportFactory = options.transportFactory ?? createWebSocketTransport;
    this.onFallbackRequired = options.onFallbackRequired;
    this.staleTimeoutMs = options.staleTimeoutMs ?? 1500;
    if (!Number.isFinite(this.staleTimeoutMs) || this.staleTimeoutMs < 250 || this.staleTimeoutMs > 10_000) throw new CompanionProtocolError('Companion stale timeout must be 250ms to 10s.');
    this.getCompanionEnabled = options.getCompanionEnabled ?? (() => loadSettings().companionEnabled);
    let enabled = false;
    try { enabled = this.getCompanionEnabled() === true; } catch { /* Settings access must not enable the companion implicitly. */ }
    this.status = initialStatus(enabled);
  }

  enable(): boolean {
    if (this.disposed) throw new Error('Companion client is disposed.');
    this.refreshEnabled();
    if (!this.status.enabled) throw new Error('Companion is disabled in settings.');
    if (this.status.status === 'idle' || this.status.status === 'disconnected') {
      this.status = { ...initialStatus(true), compatibility: this.status.compatibility };
      this.emit();
    }
    return true;
  }

  setEnabled(enabled: boolean): void {
    if (this.disposed) return;
    this.enabledOverride = enabled === true;
    if (this.enabledOverride === this.status.enabled) return;
    this.status.enabled = this.enabledOverride;
    if (!this.status.enabled) {
      this.disconnect('Companion was disabled.');
    } else if (this.status.status === 'idle' || this.status.status === 'disconnected') {
      this.status = initialStatus(true);
      this.emit();
    }
  }

  pair(options: CompanionConnectionOptions): CompanionPairingRequest {
    if (this.disposed) throw new Error('Companion client is disposed.');
    this.refreshEnabled();
    if (!this.status.enabled) throw new Error('Companion is disabled in settings.');
    if (this.session) this.disconnect('Starting a new companion pairing.');
    const now = options.now ?? this.now;
    let session: PairingSession;
    try {
      session = new PairingSession({
        ...options,
        now,
        crypto: options.crypto ?? this.crypto,
        transportFactory: options.transportFactory ?? this.transportFactory,
        onEvent: (event) => this.handleEvent(session, event),
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'Companion pairing could not start.';
      this.status = { ...initialStatus(true), status: 'error', error: reason, reconnect: { state: 'manual-required', reason } };
      this.emit();
      throw error;
    }
    this.session = session;
    this.status = { ...initialStatus(true), status: 'pairing', pairingCode: session.code, pairingExpiresAt: session.pairingExpiresAt };
    this.lastArrival = null;
    this.emit();
    const completion = session.connected.then(() => undefined, (error: unknown) => {
      throw error instanceof Error ? error : new Error('Companion pairing failed.');
    });
    session.start();
    return {
      code: session.code,
      expiresAt: session.pairingExpiresAt,
      completion,
      cancel: () => {
        if (this.session === session) this.disconnect('Companion pairing was cancelled.');
        else session.disconnect('Companion pairing was cancelled.');
      },
    };
  }

  async connect(options: CompanionConnectionOptions): Promise<void> {
    await this.pair(options).completion;
  }

  disconnect(reason = 'Companion disconnected by the user.'): void {
    const session = this.session;
    const wasActive = Boolean(session) || this.status.status === 'calibrated' || this.status.status === 'connected';
    this.session = null;
    session?.disconnect(reason);
    this.clearFreshnessTimer();
    this.lastArrival = null;
    this.intelligence.resetSession();
    this.status = {
      ...this.status,
      status: 'disconnected',
      pairingCode: null,
      pairingExpiresAt: null,
      calibration: { state: 'uncalibrated', confidence: 0, calibrationId: null, frame: null, updatedAt: null, reason: null },
      quality: 'none',
      latestTimestamp: null,
      connectedAt: null,
      error: null,
      reconnect: { state: session ? 'manual-required' : 'idle', reason: session ? reason : null },
    };
    this.emit();
    if (wasActive) this.reportFallback(reason);
  }

  getStatus(): CompanionClientStatus {
    this.checkFreshness();
    return cloneStatus(this.status);
  }

  subscribe(listener: (status: CompanionClientStatus) => void): () => void {
    if (this.disposed) return () => undefined;
    this.listeners.add(listener);
    try { listener(this.getStatus()); } catch { /* A subscriber must not interrupt companion state. */ }
    return () => { this.listeners.delete(listener); };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disconnect('Companion client was disposed.');
    this.disposed = true;
    this.listeners.clear();
  }

  private refreshEnabled(): void {
    try {
      const enabled = this.enabledOverride ?? this.getCompanionEnabled() === true;
      if (!enabled && this.status.enabled) this.setEnabled(false);
      this.status.enabled = enabled;
    } catch {
      this.status.enabled = false;
    }
  }

  private handleEvent(session: PairingSession, event: CompanionSessionEvent): void {
    if (this.session !== session || this.disposed) return;
    if (event.type === 'pairing') {
      this.status = { ...this.status, status: 'pairing', pairingCode: event.code, pairingExpiresAt: event.expiresAt, error: null };
    } else if (event.type === 'joined') {
      this.status = {
        ...this.status,
        compatibility: { ...unknownCompatibility(), supported: true, protocolVersion: COMPANION_PROTOCOL_VERSION },
      };
    } else if (event.type === 'connected') {
      this.status = {
        ...this.status,
        status: 'connected',
        pairingCode: null,
        connectedAt: this.now(),
        error: null,
        reconnect: { state: 'idle', reason: null },
      };
    } else if (event.type === 'calibration') {
      const state: CompanionCalibrationState = 'calibrated';
      this.status = {
        ...this.status,
        calibration: {
          state,
          confidence: event.calibration.confidence,
          calibrationId: event.calibration.id,
          frame: event.calibration.frame,
          updatedAt: this.now(),
          reason: null,
        },
      };
    } else if (event.type === 'sample') {
      try {
        this.intelligence.ingestCompanion(event.sample);
        this.lastArrival = this.now();
        this.status = {
          ...this.status,
          status: 'calibrated',
          quality: sampleQuality(event.sample),
          latestTimestamp: event.sample.timestamp,
          error: null,
        };
        this.scheduleFreshness();
      } catch (error) {
        this.fail(session, error instanceof Error ? error : new Error('SpatialIntelligence rejected companion data.'));
        return;
      }
    } else if (event.type === 'error') {
      this.fail(session, event.error);
      return;
    } else if (event.type === 'disconnected') {
      this.session = null;
      this.clearFreshnessTimer();
      this.lastArrival = null;
      this.intelligence.resetSession();
      this.status = {
        ...this.status,
        status: 'disconnected',
        pairingCode: null,
        pairingExpiresAt: null,
        calibration: { state: 'uncalibrated', confidence: 0, calibrationId: null, frame: null, updatedAt: null, reason: null },
        quality: 'none',
        latestTimestamp: null,
        connectedAt: null,
        error: null,
        reconnect: { state: 'manual-required', reason: event.reason },
      };
      this.reportFallback(event.reason);
    }
    this.emit();
  }

  private fail(session: PairingSession, error: Error): void {
    if (this.session !== session) return;
    this.session = null;
    session.disconnect(error.message);
    this.clearFreshnessTimer();
    this.lastArrival = null;
    this.intelligence.resetSession();
    this.status = {
      ...this.status,
      status: 'error',
      pairingCode: null,
      pairingExpiresAt: null,
      calibration: { state: 'invalid', confidence: 0, calibrationId: null, frame: null, updatedAt: this.now(), reason: error.message },
      quality: 'none',
      latestTimestamp: null,
      connectedAt: null,
      error: error.message,
      reconnect: { state: 'manual-required', reason: error.message },
    };
    this.reportFallback(error.message);
    this.emit();
  }

  private scheduleFreshness(): void {
    this.clearFreshnessTimer();
    this.freshnessTimer = setTimeout(() => this.checkFreshness(), this.staleTimeoutMs);
  }

  private checkFreshness(): void {
    if (this.status.status !== 'calibrated' || this.lastArrival === null || this.now() - this.lastArrival <= this.staleTimeoutMs) return;
    const reason = 'Companion data expired; stale metric data was discarded.';
    const session = this.session;
    this.session = null;
    session?.disconnect(reason);
    this.clearFreshnessTimer();
    this.lastArrival = null;
    this.intelligence.resetSession();
    this.status = {
      ...this.status,
      status: 'disconnected',
      pairingCode: null,
      pairingExpiresAt: null,
      calibration: { state: 'uncalibrated', confidence: 0, calibrationId: null, frame: null, updatedAt: null, reason: null },
      quality: 'none',
      latestTimestamp: null,
      connectedAt: null,
      error: reason,
      reconnect: { state: 'manual-required', reason },
    };
    this.reportFallback(reason);
    this.emit();
  }

  private clearFreshnessTimer(): void {
    if (this.freshnessTimer) clearTimeout(this.freshnessTimer);
    this.freshnessTimer = null;
  }

  private reportFallback(reason: string): void {
    try { this.onFallbackRequired?.(reason); } catch { /* The host owns visual fallback and active windows. */ }
  }

  private emit(): void {
    for (const listener of [...this.listeners]) {
      try { listener(cloneStatus(this.status)); } catch { /* A subscriber must not interrupt companion state. */ }
    }
  }
}
