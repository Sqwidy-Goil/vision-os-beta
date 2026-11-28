import {
  base64UrlToBytes,
  bytesToBase64Url,
  concatBytes,
  constantTimeEqual,
  encodeText,
  hmacSha256,
  verifyHmacSha256,
  webCrypto,
} from './crypto';
import {
  COMPANION_PROTOCOL_VERSION,
  DEFAULT_MAX_FRAME_BYTES,
  type CompanionDepthEncoding,
  type CompanionTransportData,
} from './types';

export const COMPANION_FRAME_MAGIC = 'VIS1';
export const MAX_COMPANION_JSON_BYTES = 4 * 1024 * 1024;
export const MAX_COMPANION_DEPTH_BYTES = 2 * 1024 * 1024;

export type CompanionMessageType = 'offer' | 'join' | 'ready' | 'ready-ack' | 'calibration' | 'sample' | 'close' | 'error';
export type CompanionPayloadEncoding = 'identity' | 'gzip';

export interface CompanionFrameHeader {
  v: number;
  sid: string;
  seq: number;
  sentAt: number;
  type: CompanionMessageType;
  payloadEncoding: CompanionPayloadEncoding;
  depthEncoding: 'none' | CompanionDepthEncoding;
  payloadBytes: number;
  depthBytes: number;
  mac?: string;
}

export interface CompanionFrameInput {
  sid: string;
  seq: number;
  sentAt: number;
  type: CompanionMessageType;
  payload: Record<string, unknown>;
  key?: Uint8Array;
}

export interface CompanionFrameOptions {
  key?: Uint8Array;
  crypto?: Crypto;
  depthEncoding?: CompanionDepthEncoding;
  compression?: boolean;
  maxFrameBytes?: number;
}

export interface DecodedCompanionFrame {
  header: CompanionFrameHeader;
  payload: Record<string, unknown>;
  depthChunk: Uint8Array;
}

export class CompanionProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CompanionProtocolError';
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function assertExactKeys(value: unknown, required: readonly string[], optional: readonly string[], label: string): asserts value is Record<string, unknown> {
  if (!isRecord(value)) throw new CompanionProtocolError(`${label} must be an object.`);
  const keys = Object.keys(value);
  if (required.some((key) => !Object.hasOwn(value, key)) || keys.some((key) => !required.includes(key) && !optional.includes(key))) {
    throw new CompanionProtocolError(`${label} has missing or unknown fields.`);
  }
}

function frameLimit(value?: number): number {
  const limit = value ?? DEFAULT_MAX_FRAME_BYTES;
  if (!Number.isInteger(limit) || limit < 1024 || limit > 8 * 1024 * 1024) throw new CompanionProtocolError('Invalid companion frame limit.');
  return limit;
}

async function rawBytes(data: CompanionTransportData, limit: number): Promise<Uint8Array> {
  if (typeof data === 'string') {
    const bytes = encodeText(data);
    if (bytes.byteLength > limit) throw new CompanionProtocolError('Companion message exceeds the frame limit.');
    return bytes;
  }
  if (data instanceof Blob) {
    if (data.size > limit) throw new CompanionProtocolError('Companion message exceeds the frame limit.');
    return new Uint8Array(await data.arrayBuffer());
  }
  if (data instanceof ArrayBuffer) {
    if (data.byteLength > limit) throw new CompanionProtocolError('Companion message exceeds the frame limit.');
    return new Uint8Array(data);
  }
  if (data instanceof Uint8Array) {
    if (data.byteLength > limit) throw new CompanionProtocolError('Companion message exceeds the frame limit.');
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  throw new CompanionProtocolError('Unsupported companion transport data.');
}

export function supportsCompanionGzip(): boolean {
  return typeof CompressionStream === 'function' && typeof DecompressionStream === 'function';
}

async function gzipCompress(bytes: Uint8Array): Promise<Uint8Array | null> {
  if (!supportsCompanionGzip()) return null;
  const stream = new Blob([bytes.slice().buffer]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function gzipDecompress(bytes: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream !== 'function') throw new CompanionProtocolError('This browser cannot decompress companion gzip payloads.');
  const stream = new Blob([bytes.slice().buffer]).stream().pipeThrough(new DecompressionStream('gzip'));
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      total += result.value.byteLength;
      if (total > MAX_COMPANION_JSON_BYTES) throw new CompanionProtocolError('Decompressed companion payload exceeds its limit.');
      chunks.push(result.value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function float32Bytes(values: Float32Array): Uint8Array {
  const bytes = new Uint8Array(values.byteLength);
  const view = new DataView(bytes.buffer);
  for (let index = 0; index < values.length; index += 1) view.setFloat32(index * 4, values[index], true);
  return bytes;
}

function splitDepth(payload: Record<string, unknown>, depthEncoding: CompanionDepthEncoding): { payload: Record<string, unknown>; chunk: Uint8Array; encoding: 'none' | CompanionDepthEncoding } {
  if (payload.kind !== 'sample' || !isRecord(payload.depth)) return { payload, chunk: new Uint8Array(), encoding: 'none' };
  const depth = payload.depth;
  const values = depth.values;
  const confidence = depth.confidence;
  if (depth.mode === 'unchanged' && values === undefined && confidence === undefined) return { payload, chunk: new Uint8Array(), encoding: 'none' };
  const binary = values instanceof Float32Array || confidence instanceof Float32Array;
  if (!binary) {
    if (depthEncoding !== 'base64') throw new CompanionProtocolError('Depth base64 encoding was not requested.');
    if (typeof values !== 'string' || typeof confidence !== 'string') throw new CompanionProtocolError('Depth arrays must both be Float32Array or base64 strings.');
    return { payload, chunk: new Uint8Array(), encoding: 'base64' };
  }
  if (depthEncoding !== 'float32le' || !(values instanceof Float32Array) || !(confidence instanceof Float32Array)) {
    throw new CompanionProtocolError('Binary depth requires matching Float32Array values and confidence.');
  }
  const chunk = concatBytes(float32Bytes(values), float32Bytes(confidence));
  if (chunk.byteLength > MAX_COMPANION_DEPTH_BYTES) throw new CompanionProtocolError('Depth chunk exceeds its limit.');
  return {
    payload: { ...payload, depth: { ...depth, values: null, confidence: null } },
    chunk,
    encoding: 'float32le',
  };
}

function authenticationBytes(header: CompanionFrameHeader, body: Uint8Array, chunk: Uint8Array): Uint8Array {
  const type = encodeText(header.type);
  const metadata = new Uint8Array(4 + 1 + 16 + 8 + 8 + 1 + type.length + 1 + 1 + 4 + 4);
  const view = new DataView(metadata.buffer);
  metadata.set(encodeText(COMPANION_FRAME_MAGIC), 0);
  view.setUint8(4, header.v);
  metadata.set(base64UrlToBytes(header.sid, 16), 5);
  view.setBigUint64(21, BigInt(header.seq), false);
  view.setFloat64(29, header.sentAt, false);
  view.setUint8(37, type.length);
  metadata.set(type, 38);
  const encodingOffset = 38 + type.length;
  view.setUint8(encodingOffset, header.payloadEncoding === 'gzip' ? 1 : 0);
  view.setUint8(encodingOffset + 1, header.depthEncoding === 'none' ? 0 : header.depthEncoding === 'float32le' ? 1 : 2);
  view.setUint32(encodingOffset + 2, header.payloadBytes, false);
  view.setUint32(encodingOffset + 6, header.depthBytes, false);
  return concatBytes(metadata, body, chunk);
}

export async function encodeCompanionFrame(input: CompanionFrameInput, options: CompanionFrameOptions = {}): Promise<Uint8Array> {
  if (input.seq < 0 || !Number.isSafeInteger(input.seq) || !Number.isFinite(input.sentAt) || input.sentAt < 0) throw new CompanionProtocolError('Invalid frame sequence or timestamp.');
  if (!/^[A-Za-z0-9_-]{22}$/.test(input.sid)) throw new CompanionProtocolError('Invalid session identifier.');
  if (!isRecord(input.payload) || !['offer', 'join', 'ready', 'ready-ack', 'calibration', 'sample', 'close', 'error'].includes(input.type)) throw new CompanionProtocolError('Invalid frame type or payload.');
  const limit = frameLimit(options.maxFrameBytes);
  const source = webCrypto(options.crypto);
  const depth = splitDepth(input.payload, options.depthEncoding ?? 'float32le');
  const json = encodeText(JSON.stringify(depth.payload));
  if (json.byteLength > MAX_COMPANION_JSON_BYTES) throw new CompanionProtocolError('Companion JSON payload exceeds its limit.');
  let body = json;
  let payloadEncoding: CompanionPayloadEncoding = 'identity';
  if (options.compression !== false) {
    const compressed = await gzipCompress(json);
    if (compressed && compressed.byteLength < json.byteLength) {
      body = compressed;
      payloadEncoding = 'gzip';
    }
  }
  const header: CompanionFrameHeader = {
    v: COMPANION_PROTOCOL_VERSION,
    sid: input.sid,
    seq: input.seq,
    sentAt: input.sentAt,
    type: input.type,
    payloadEncoding,
    depthEncoding: depth.encoding,
    payloadBytes: body.byteLength,
    depthBytes: depth.chunk.byteLength,
  };
  if (options.key) {
    if (options.key.byteLength !== 32) throw new CompanionProtocolError('Session authentication keys must be 256 bits.');
    header.mac = bytesToBase64Url(await hmacSha256(options.key, authenticationBytes(header, body, depth.chunk), source));
  }
  const headerBytes = encodeText(JSON.stringify(header));
  if (headerBytes.byteLength > 64 * 1024 || 8 + headerBytes.byteLength + body.byteLength + depth.chunk.byteLength > limit) {
    throw new CompanionProtocolError('Companion message exceeds the frame limit.');
  }
  const frame = new Uint8Array(8 + headerBytes.byteLength + body.byteLength + depth.chunk.byteLength);
  frame.set(encodeText(COMPANION_FRAME_MAGIC), 0);
  new DataView(frame.buffer).setUint32(4, headerBytes.byteLength, false);
  frame.set(headerBytes, 8);
  frame.set(body, 8 + headerBytes.byteLength);
  frame.set(depth.chunk, 8 + headerBytes.byteLength + body.byteLength);
  return frame;
}

export async function decodeCompanionFrame(
  data: CompanionTransportData,
  options: {
    key?: Uint8Array;
    crypto?: Crypto;
    expectedSid?: string;
    expectedSeq?: number;
    now?: number;
    maxClockSkewMs?: number;
    maxFrameBytes?: number;
    allowPairingJoin?: boolean;
  } = {},
): Promise<DecodedCompanionFrame> {
  const limit = frameLimit(options.maxFrameBytes);
  const frame = await rawBytes(data, limit);
  if (frame.byteLength < 10 || !constantTimeEqual(encodeText(COMPANION_FRAME_MAGIC), frame.subarray(0, 4))) throw new CompanionProtocolError('Invalid companion frame magic.');
  const headerLength = new DataView(frame.buffer, frame.byteOffset, frame.byteLength).getUint32(4, false);
  if (headerLength < 2 || headerLength > 64 * 1024 || 8 + headerLength > frame.byteLength) throw new CompanionProtocolError('Invalid companion frame header length.');
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(frame.subarray(8, 8 + headerLength)));
  } catch {
    throw new CompanionProtocolError('Invalid companion frame header.');
  }
  assertExactKeys(parsed, ['v', 'sid', 'seq', 'sentAt', 'type', 'payloadEncoding', 'depthEncoding', 'payloadBytes', 'depthBytes'], ['mac'], 'Frame header');
  const header = parsed as unknown as CompanionFrameHeader;
  if (header.v !== COMPANION_PROTOCOL_VERSION || typeof header.sid !== 'string' || !/^[A-Za-z0-9_-]{22}$/.test(header.sid) || !Number.isSafeInteger(header.seq) || header.seq < 0 ||
    !Number.isFinite(header.sentAt) || header.sentAt < 0 || typeof header.type !== 'string' || !['offer', 'join', 'ready', 'ready-ack', 'calibration', 'sample', 'close', 'error'].includes(header.type) ||
    typeof header.payloadEncoding !== 'string' || !['identity', 'gzip'].includes(header.payloadEncoding) ||
    typeof header.depthEncoding !== 'string' || !['none', 'float32le', 'base64'].includes(header.depthEncoding) ||
    !Number.isSafeInteger(header.payloadBytes) || header.payloadBytes < 1 || !Number.isSafeInteger(header.depthBytes) || header.depthBytes < 0 ||
    header.depthBytes > MAX_COMPANION_DEPTH_BYTES || ((header.depthEncoding === 'none' || header.depthEncoding === 'base64') && header.depthBytes !== 0) ||
    (header.depthEncoding === 'float32le' && (header.depthBytes === 0 || header.depthBytes % 8 !== 0)) ||
    (header.mac !== undefined && (typeof header.mac !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(header.mac)))) {
    throw new CompanionProtocolError('Invalid companion frame header fields.');
  }
  const expectedLength = 8 + headerLength + header.payloadBytes + header.depthBytes;
  if (expectedLength !== frame.byteLength) throw new CompanionProtocolError('Companion frame length does not match its header.');
  if (options.expectedSid !== undefined && header.sid !== options.expectedSid) throw new CompanionProtocolError('Unexpected companion session identifier.');
  if (options.expectedSeq !== undefined && header.seq !== options.expectedSeq) throw new CompanionProtocolError('Companion message replay or sequence mismatch.');
  const now = options.now ?? Date.now();
  if (Math.abs(now - header.sentAt) > (options.maxClockSkewMs ?? 30_000)) throw new CompanionProtocolError('Companion frame timestamp is outside the allowed clock skew.');
  const body = frame.subarray(8 + headerLength, 8 + headerLength + header.payloadBytes);
  const depthChunk = frame.subarray(8 + headerLength + header.payloadBytes);
  if (header.type === 'offer') {
    if (header.mac !== undefined) throw new CompanionProtocolError('Pairing offers must not carry a session MAC.');
  } else if (options.allowPairingJoin && header.type === 'join' && header.mac) {
    // The host derives the key from this bounded payload, then verifies the complete frame.
  } else {
    if (!options.key || !header.mac) throw new CompanionProtocolError('Companion frame is missing session authentication.');
    const signature = base64UrlToBytes(header.mac, 32);
    if (!await verifyHmacSha256(options.key, authenticationBytes(header, body, depthChunk), signature, options.crypto)) {
      throw new CompanionProtocolError('Companion frame authentication failed.');
    }
  }
  const json = header.payloadEncoding === 'gzip' ? await gzipDecompress(body) : body;
  if (json.byteLength > MAX_COMPANION_JSON_BYTES) throw new CompanionProtocolError('Companion JSON payload exceeds its limit.');
  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(json));
  } catch {
    throw new CompanionProtocolError('Invalid companion JSON payload.');
  }
  if (!isRecord(payload)) throw new CompanionProtocolError('Companion payload must be an object.');
  return { header, payload, depthChunk };
}

export async function verifyFrameMac(frame: Uint8Array, key: Uint8Array, crypto?: Crypto): Promise<boolean> {
  try {
    await decodeCompanionFrame(frame, { key, crypto, maxClockSkewMs: Number.POSITIVE_INFINITY });
    return true;
  } catch {
    return false;
  }
}

export function wipeKey(key: Uint8Array | null): void {
  key?.fill(0);
}
