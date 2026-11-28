import {
  base64UrlToBytes,
  bufferSource,
  bytesToBase64Url,
  concatBytes,
  constantTimeEqual,
  encodeText,
  hmacSha256,
  randomBytes,
  sha256,
  webCrypto,
} from './crypto';
import { assertExactKeys, CompanionProtocolError, isRecord, supportsCompanionGzip } from './codec';
import {
  COMPANION_PROTOCOL_VERSION,
  DEFAULT_MAX_FRAME_BYTES,
  DEFAULT_MAX_MESSAGES_PER_SECOND,
  type CompanionDevice,
} from './types';

const ECDH_DOMAIN = 'vision-companion/session/v1\0';
const PAIRING_DOMAIN = 'vision-companion/pair/v1\0';
const CODE_DOMAIN = 'vision-companion/code/v1\0';

export interface PairingMaterial {
  code: string;
  sid: string;
  salt: Uint8Array;
  hostKeyPair: CryptoKeyPair;
  pairingExpiresAt: number;
  sessionExpiresAt: number;
  maxFrameBytes: number;
  maxMessagesPerSecond: number;
}

export interface PairingOfferPayload {
  kind: 'offer';
  sid: string;
  protocolVersion: number;
  ephemeralPublicKey: JsonWebKey;
  salt: string;
  pairingExpiresAt: number;
  sessionExpiresAt: number;
  maxFrameBytes: number;
  maxMessagesPerSecond: number;
  features: {
    incremental: true;
    compression: string[];
    depthEncodings: ['float32le', 'base64'];
  };
}

export interface PairingJoinPayload {
  kind: 'join';
  protocolVersion: number;
  ephemeralPublicKey: JsonWebKey;
  proof: string;
  device: CompanionDevice;
  features: PairingOfferPayload['features'];
}

export interface AcceptedPairing {
  sessionKey: Uint8Array;
  device: CompanionDevice;
  keyFingerprint: string;
}

function canonicalPublicKey(key: JsonWebKey): Uint8Array {
  if (key.crv !== 'P-256' || typeof key.x !== 'string' || typeof key.y !== 'string') throw new CompanionProtocolError('Companion requires P-256 ephemeral keys.');
  return encodeText(JSON.stringify({ crv: key.crv, kty: key.kty, x: key.x, y: key.y }));
}

export async function createPairingMaterial(options: {
  code: string;
  now: number;
  pairingTtlMs: number;
  sessionTtlMs?: number;
  maxFrameBytes?: number;
  maxMessagesPerSecond?: number;
  crypto?: Crypto;
}): Promise<PairingMaterial> {
  if (!/^\d{8,12}$/.test(options.code)) throw new CompanionProtocolError('Invalid pairing code.');
  if (!Number.isFinite(options.pairingTtlMs) || options.pairingTtlMs < 30_000 || options.pairingTtlMs > 300_000) throw new CompanionProtocolError('Pairing lifetime must be 30 seconds to 5 minutes.');
  const source = webCrypto(options.crypto);
  const hostKeyPair = await source.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']) as CryptoKeyPair;
  return {
    code: options.code,
    sid: bytesToBase64Url(randomBytes(16, source)),
    salt: randomBytes(16, source),
    hostKeyPair,
    pairingExpiresAt: options.now + options.pairingTtlMs,
    sessionExpiresAt: options.now + (options.sessionTtlMs ?? 60 * 60 * 1000),
    maxFrameBytes: options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES,
    maxMessagesPerSecond: options.maxMessagesPerSecond ?? DEFAULT_MAX_MESSAGES_PER_SECOND,
  };
}

export function createPairingOffer(material: PairingMaterial): PairingOfferPayload {
  return {
    kind: 'offer',
    sid: material.sid,
    protocolVersion: COMPANION_PROTOCOL_VERSION,
    ephemeralPublicKey: { crv: 'P-256', ext: true, key_ops: [], kty: 'EC', x: '', y: '' },
    salt: bytesToBase64Url(material.salt),
    pairingExpiresAt: material.pairingExpiresAt,
    sessionExpiresAt: material.sessionExpiresAt,
    maxFrameBytes: material.maxFrameBytes,
    maxMessagesPerSecond: material.maxMessagesPerSecond,
    features: { incremental: true, compression: supportsCompanionGzip() ? ['gzip', 'identity'] : ['identity'], depthEncodings: ['float32le', 'base64'] },
  };
}

export async function exportHostOffer(material: PairingMaterial, crypto?: Crypto): Promise<PairingOfferPayload> {
  const offer = createPairingOffer(material);
  offer.ephemeralPublicKey = await webCrypto(crypto).subtle.exportKey('jwk', material.hostKeyPair.publicKey);
  return offer;
}

export async function verifyPairingCode(expectedCode: string, presentedCode: string, salt: Uint8Array, crypto?: Crypto): Promise<boolean> {
  if (!/^\d{8,12}$/.test(expectedCode) || !/^\d{8,12}$/.test(presentedCode)) return false;
  const source = webCrypto(crypto);
  const expected = await sha256(concatBytes(encodeText(CODE_DOMAIN), salt, encodeText(expectedCode)), source);
  const presented = await sha256(concatBytes(encodeText(CODE_DOMAIN), salt, encodeText(presentedCode)), source);
  return constantTimeEqual(expected, presented);
}

async function deriveSessionKey(hostPublicKey: JsonWebKey, guestPublicKey: JsonWebKey, privateKey: CryptoKey, salt: Uint8Array, sid: string, crypto?: Crypto): Promise<Uint8Array> {
  const source = webCrypto(crypto);
  const publicKey = await source.subtle.importKey('jwk', hostPublicKey, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = await source.subtle.deriveBits({ name: 'ECDH', public: publicKey }, privateKey, 256);
  const info = encodeText(`${ECDH_DOMAIN}${sid}\0`);
  const bits = await source.subtle.deriveBits({
    name: 'HKDF',
    hash: 'SHA-256',
    salt: bufferSource(salt),
    info: bufferSource(concatBytes(info, canonicalPublicKey(hostPublicKey), canonicalPublicKey(guestPublicKey))),
  }, await source.subtle.importKey('raw', shared, 'HKDF', false, ['deriveBits']), 256);
  return new Uint8Array(bits);
}

async function pairingProof(sessionKey: Uint8Array, hostPublicKey: JsonWebKey, guestPublicKey: JsonWebKey, sid: string, salt: Uint8Array, code: string, crypto?: Crypto): Promise<Uint8Array> {
  const digest = await sha256(concatBytes(encodeText(CODE_DOMAIN), salt, encodeText(code)), crypto);
  return hmacSha256(sessionKey, concatBytes(
    encodeText(PAIRING_DOMAIN),
    base64UrlToBytes(sid, 16),
    canonicalPublicKey(hostPublicKey),
    canonicalPublicKey(guestPublicKey),
    digest,
  ), crypto);
}

export async function keyFingerprint(publicKey: JsonWebKey, crypto?: Crypto): Promise<string> {
  return bytesToBase64Url(await sha256(canonicalPublicKey(publicKey), crypto));
}

function validateDevice(value: unknown): CompanionDevice {
  assertExactKeys(value, ['name'], ['model'], 'Companion device');
  if (typeof value.name !== 'string' || value.name.trim().length < 1 || value.name.length > 80 ||
    (value.model !== undefined && (typeof value.model !== 'string' || value.model.length < 1 || value.model.length > 80))) {
    throw new CompanionProtocolError('Invalid companion device metadata.');
  }
  return value.model === undefined ? { name: value.name } : { name: value.name, model: value.model };
}

function validateFeatures(value: unknown, offered?: PairingOfferPayload['features']): void {
  assertExactKeys(value, ['incremental', 'compression', 'depthEncodings'], [], 'Companion features');
  if (value.incremental !== true || !Array.isArray(value.compression) || value.compression.length < 1 || value.compression.length > 2 ||
    new Set(value.compression).size !== value.compression.length || value.compression.some((entry) => entry !== 'gzip' && entry !== 'identity') || !value.compression.includes('identity') ||
    !Array.isArray(value.depthEncodings) || value.depthEncodings.length !== 2 || value.depthEncodings[0] !== 'float32le' || value.depthEncodings[1] !== 'base64' ||
    (offered && value.compression.some((entry) => !offered.compression.includes(entry)))) {
    throw new CompanionProtocolError('Companion protocol features are incompatible.');
  }
}

export function validatePairingOffer(value: unknown): PairingOfferPayload {
  assertExactKeys(value, ['kind', 'sid', 'protocolVersion', 'ephemeralPublicKey', 'salt', 'pairingExpiresAt', 'sessionExpiresAt', 'maxFrameBytes', 'maxMessagesPerSecond', 'features'], [], 'Pairing offer');
  if (value.kind !== 'offer' || typeof value.sid !== 'string' || !/^[A-Za-z0-9_-]{22}$/.test(value.sid) || value.protocolVersion !== COMPANION_PROTOCOL_VERSION || !isRecord(value.ephemeralPublicKey) ||
    typeof value.salt !== 'string' || !Number.isFinite(value.pairingExpiresAt) || !Number.isFinite(value.sessionExpiresAt) ||
    typeof value.maxFrameBytes !== 'number' || !Number.isInteger(value.maxFrameBytes) || value.maxFrameBytes < 1024 || value.maxFrameBytes > 8 * 1024 * 1024 ||
    typeof value.maxMessagesPerSecond !== 'number' || !Number.isInteger(value.maxMessagesPerSecond) || value.maxMessagesPerSecond < 1 || value.maxMessagesPerSecond > 120) {
    throw new CompanionProtocolError('Invalid pairing offer.');
  }
  base64UrlToBytes(value.salt, 16);
  canonicalPublicKey(value.ephemeralPublicKey);
  validateFeatures(value.features);
  return value as unknown as PairingOfferPayload;
}

export async function createPairingJoin(options: {
  offer: PairingOfferPayload;
  code: string;
  device: CompanionDevice;
  now: number;
  crypto?: Crypto;
}): Promise<{ payload: PairingJoinPayload; sessionKey: Uint8Array; publicKey: JsonWebKey }> {
  const offer = validatePairingOffer(options.offer);
  if (options.now >= offer.pairingExpiresAt) throw new CompanionProtocolError('Companion pairing code has expired.');
  if (!/^\d{8,12}$/.test(options.code)) throw new CompanionProtocolError('Invalid pairing code.');
  const device = validateDevice(options.device);
  const source = webCrypto(options.crypto);
  const guestKeyPair = await source.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']) as CryptoKeyPair;
  const publicKey = await source.subtle.exportKey('jwk', guestKeyPair.publicKey);
  const salt = base64UrlToBytes(offer.salt, 16);
  const sessionKey = await deriveSessionKey(offer.ephemeralPublicKey, publicKey, guestKeyPair.privateKey, salt, offer.sid, source);
  const proof = await pairingProof(sessionKey, offer.ephemeralPublicKey, publicKey, offer.sid, salt, options.code, source);
  return {
    sessionKey,
    publicKey,
    payload: {
      kind: 'join',
      protocolVersion: COMPANION_PROTOCOL_VERSION,
      ephemeralPublicKey: publicKey,
      proof: bytesToBase64Url(proof),
      device,
      features: {
        incremental: true,
        compression: offer.features.compression.includes('gzip') && supportsCompanionGzip() ? ['gzip', 'identity'] : ['identity'],
        depthEncodings: ['float32le', 'base64'],
      },
    },
  };
}

export async function acceptPairingJoin(options: {
  material: PairingMaterial;
  join: PairingJoinPayload;
  now: number;
  crypto?: Crypto;
}): Promise<AcceptedPairing> {
  const { material } = options;
  if (options.now >= material.pairingExpiresAt) throw new CompanionProtocolError('Companion pairing code has expired.');
  if (options.now >= material.sessionExpiresAt) throw new CompanionProtocolError('Companion session has expired.');
  assertExactKeys(options.join, ['kind', 'protocolVersion', 'ephemeralPublicKey', 'proof', 'device', 'features'], [], 'Pairing join');
  if (options.join.kind !== 'join' || options.join.protocolVersion !== COMPANION_PROTOCOL_VERSION || !isRecord(options.join.ephemeralPublicKey) ||
    typeof options.join.proof !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(options.join.proof)) {
    throw new CompanionProtocolError('Invalid pairing join.');
  }
  canonicalPublicKey(options.join.ephemeralPublicKey);
  validateFeatures(options.join.features, createPairingOffer(material).features);
  const device = validateDevice(options.join.device);
  const source = webCrypto(options.crypto);
  const guestPublic = await source.subtle.importKey('jwk', options.join.ephemeralPublicKey, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = await source.subtle.deriveBits({ name: 'ECDH', public: guestPublic }, material.hostKeyPair.privateKey, 256);
  const hostPublic = await source.subtle.exportKey('jwk', material.hostKeyPair.publicKey);
  const bits = await source.subtle.deriveBits({
    name: 'HKDF',
    hash: 'SHA-256',
    salt: bufferSource(material.salt),
    info: bufferSource(concatBytes(encodeText(`${ECDH_DOMAIN}${material.sid}\0`), canonicalPublicKey(hostPublic), canonicalPublicKey(options.join.ephemeralPublicKey))),
  }, await source.subtle.importKey('raw', shared, 'HKDF', false, ['deriveBits']), 256);
  const sessionKey = new Uint8Array(bits);
  const expectedProof = await pairingProof(sessionKey, hostPublic, options.join.ephemeralPublicKey, material.sid, material.salt, material.code, source);
  const presentedProof = base64UrlToBytes(options.join.proof, 32);
  if (!constantTimeEqual(expectedProof, presentedProof)) {
    wipe(sessionKey);
    throw new CompanionProtocolError('Companion pairing proof failed.');
  }
  return { sessionKey, device, keyFingerprint: await keyFingerprint(options.join.ephemeralPublicKey, source) };
}

function wipe(value: Uint8Array): void {
  value.fill(0);
}
