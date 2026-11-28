export const COMPANION_PROTOCOL_VERSION = 1;
export const DEFAULT_MAX_FRAME_BYTES = 4 * 1024 * 1024;
export const DEFAULT_MAX_MESSAGES_PER_SECOND = 30;

export type CompanionStatus = 'idle' | 'pairing' | 'connected' | 'calibrated' | 'error' | 'disconnected';
export type CompanionQuality = 'none' | 'poor' | 'usable' | 'good';
export type CompanionCoordinateFrame = 'world-y-up-right-handed';
export type CompanionCalibrationState = 'uncalibrated' | 'calibrating' | 'calibrated' | 'invalid';
export type CompanionDepthEncoding = 'float32le' | 'base64';
export type CompanionTransportData = string | ArrayBuffer | Uint8Array | Blob;

export interface CompanionTransport {
  readonly kind: 'websocket';
  send(data: CompanionTransportData): void;
  close(code?: number, reason?: string): void;
  onOpen: (() => void) | null;
  onMessage: ((data: CompanionTransportData) => void | Promise<void>) | null;
  onClose: ((code: number, reason: string) => void) | null;
  onError: ((error: Error) => void) | null;
}

export type CompanionTransportFactory = (url: string) => CompanionTransport;

export interface CompanionDevice {
  name: string;
  model?: string;
}

export interface CompanionPairingAuthorization {
  device: CompanionDevice;
  keyFingerprint: string;
  endpoint: string;
  expiresAt: number;
}

export interface CompanionCalibrationWire {
  kind: 'calibration';
  calibrationId: string;
  confidence: number;
  frame: CompanionCoordinateFrame;
  depthUnits: 'meters';
  origin: [number, number, number];
  orientation: [number, number, number, number];
}

export interface CompanionCompatibility {
  supported: boolean;
  protocolVersion: number | null;
  reason: string | null;
  transport: 'wss';
  payloadAuthentication: 'hmac-sha256';
  encryption: 'wss-only';
  compression: string[];
  depthEncodings: CompanionDepthEncoding[];
}

export interface CompanionCalibrationStatus {
  state: CompanionCalibrationState;
  confidence: number;
  calibrationId: string | null;
  frame: CompanionCoordinateFrame | null;
  updatedAt: number | null;
  reason: string | null;
}

export interface CompanionReconnectStatus {
  state: 'idle' | 'manual-required';
  reason: string | null;
}

export interface CompanionClientStatus {
  status: CompanionStatus;
  enabled: boolean;
  pairingCode: string | null;
  pairingExpiresAt: number | null;
  compatibility: CompanionCompatibility;
  calibration: CompanionCalibrationStatus;
  quality: CompanionQuality;
  latestTimestamp: number | null;
  connectedAt: number | null;
  error: string | null;
  reconnect: CompanionReconnectStatus;
}

export interface CompanionPairOptions {
  authorizePairing: (request: CompanionPairingAuthorization) => boolean | Promise<boolean>;
  pairingTtlMs?: number;
  openTimeoutMs?: number;
  maxFrameBytes?: number;
  maxMessagesPerSecond?: number;
  now?: () => number;
  crypto?: Crypto;
}

export interface CompanionConnectionOptions extends CompanionPairOptions {
  url: string;
  transportFactory?: CompanionTransportFactory;
}

export interface CompanionPairingRequest {
  readonly code: string;
  readonly expiresAt: number;
  readonly completion: Promise<void>;
  cancel(): void;
}

export interface CompanionClientOptions {
  intelligence: {
    ingestCompanion(sample: import('../intelligence/types').CompanionSpatialSample): void;
    resetSession(): void;
  };
  getCompanionEnabled?: () => boolean;
  transportFactory?: CompanionTransportFactory;
  now?: () => number;
  crypto?: Crypto;
  staleTimeoutMs?: number;
  onFallbackRequired?: (reason: string) => void;
}
