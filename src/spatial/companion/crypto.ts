const encoder = new TextEncoder();

export function webCrypto(candidate?: Crypto): Crypto {
  const value = candidate ?? globalThis.crypto;
  if (!value?.subtle) throw new Error('Web Crypto with SubtleCrypto is required for companion pairing.');
  return value;
}

export function randomBytes(length: number, crypto?: Crypto): Uint8Array {
  const value = new Uint8Array(length);
  webCrypto(crypto).getRandomValues(value);
  return value;
}

export function generatePairingCode(crypto?: Crypto, digits = 10): string {
  if (!Number.isInteger(digits) || digits < 8 || digits > 12) throw new Error('Pairing codes require 8 to 12 digits.');
  const source = webCrypto(crypto);
  const output = new Uint32Array(digits);
  const limit = Math.floor(0x1_0000_0000 / 10) * 10;
  for (let index = 0; index < digits; index += 1) {
    let candidate: number;
    do {
      source.getRandomValues(output.subarray(index, index + 1));
      candidate = output[index];
    } while (candidate >= limit);
    output[index] = candidate % 10;
  }
  return Array.from(output, (digit) => String(digit)).join('');
}

export function constantTimeEqual(first: Uint8Array, second: Uint8Array): boolean {
  if (first.byteLength !== second.byteLength) return false;
  let difference = 0;
  for (let index = 0; index < first.byteLength; index += 1) difference |= first[index] ^ second[index];
  return difference === 0;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.byteLength; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

export function base64ToBytes(value: string): Uint8Array {
  if (value.length > 8 * 1024 * 1024 || value.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error('Invalid base64 data.');
  }
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  if (bytesToBase64(bytes) !== value) throw new Error('Non-canonical base64 data.');
  return bytes;
}

export function bytesToBase64Url(bytes: Uint8Array): string {
  return bytesToBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export function base64UrlToBytes(value: string, expectedBytes?: number): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value) || (expectedBytes !== undefined && value.length !== Math.ceil(expectedBytes * 4 / 3))) {
    throw new Error('Invalid base64url data.');
  }
  const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4);
  const bytes = base64ToBytes(padded);
  if (expectedBytes !== undefined && bytes.byteLength !== expectedBytes) throw new Error('Unexpected binary data length.');
  if (bytesToBase64Url(bytes) !== value) throw new Error('Non-canonical base64url data.');
  return bytes;
}

export function bufferSource(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer as ArrayBuffer;
}

export async function sha256(data: Uint8Array, crypto?: Crypto): Promise<Uint8Array> {
  return new Uint8Array(await webCrypto(crypto).subtle.digest('SHA-256', bufferSource(data)));
}

export async function hmacSha256(key: Uint8Array, data: Uint8Array, crypto?: Crypto): Promise<Uint8Array> {
  const source = webCrypto(crypto);
  const imported = await source.subtle.importKey('raw', bufferSource(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
  return new Uint8Array(await source.subtle.sign('HMAC', imported, bufferSource(data)));
}

export async function verifyHmacSha256(key: Uint8Array, data: Uint8Array, signature: Uint8Array, crypto?: Crypto): Promise<boolean> {
  if (signature.byteLength !== 32) return false;
  const source = webCrypto(crypto);
  const imported = await source.subtle.importKey('raw', bufferSource(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  return source.subtle.verify('HMAC', imported, bufferSource(signature), bufferSource(data));
}

export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
}

export function encodeText(value: string): Uint8Array {
  return encoder.encode(value);
}
