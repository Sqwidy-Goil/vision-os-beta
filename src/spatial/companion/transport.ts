import {
  DEFAULT_MAX_FRAME_BYTES,
  type CompanionTransport,
  type CompanionTransportData,
  type CompanionTransportFactory,
} from './types';

function privateIpv4(host: string): boolean {
  const parts = host.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a, b] = parts;
  return a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

function ipv6Words(host: string): number[] | null {
  let address = host;
  const dotted = address.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) {
    if (!privateIpv4(dotted[2])) return null;
    const octets = dotted[2].split('.').map(Number);
    address = `${dotted[1]}${((octets[0] << 8) | octets[1]).toString(16)}:${((octets[2] << 8) | octets[3]).toString(16)}`;
  }
  const halves = address.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves[1] ? halves[1].split(':') : [];
  if ([...left, ...right].some((part) => !/^[0-9a-f]{1,4}$/i.test(part))) return null;
  if (halves.length === 1) return left.length === 8 ? left.map((part) => parseInt(part, 16)) : null;
  const missing = 8 - left.length - right.length;
  if (missing < 1) return null;
  return [...left, ...new Array<number>(missing).fill(0), ...right].map((part) => typeof part === 'number' ? part : parseInt(part, 16));
}

function localIpv6(host: string): boolean {
  if (!host.includes(':')) return false;
  const words = ipv6Words(host);
  if (!words) return false;
  const first = words[0];
  const loopback = words.slice(0, 7).every((word) => word === 0) && words[7] === 1;
  const uniqueLocal = (first & 0xfe00) === 0xfc00;
  const linkLocal = (first & 0xffc0) === 0xfe80;
  const mappedPrivate = words.slice(0, 5).every((word) => word === 0) && words[5] === 0xffff && privateIpv4(`${words[6] >> 8}.${words[6] & 255}.${words[7] >> 8}.${words[7] & 255}`);
  return loopback || uniqueLocal || linkLocal || mappedPrivate;
}

export function assertTrustedLocalWssUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Companion endpoint must be an absolute WSS URL.');
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const localName = host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local');
  if (url.protocol !== 'wss:' || url.username || url.password || url.search || url.hash || (!localName && !privateIpv4(host) && !localIpv6(host))) {
    throw new Error('Companion requires WSS to a trusted local-network, localhost, or .local host.');
  }
  return url.toString();
}

export class WebSocketTransport implements CompanionTransport {
  readonly kind = 'websocket' as const;
  onOpen: (() => void) | null = null;
  onMessage: ((data: CompanionTransportData) => void | Promise<void>) | null = null;
  onClose: ((code: number, reason: string) => void) | null = null;
  onError: ((error: Error) => void) | null = null;
  private readonly socket: WebSocket;

  constructor(url: string) {
    assertTrustedLocalWssUrl(url);
    if (typeof WebSocket !== 'function') throw new Error('WebSocket transport is unavailable in this browser.');
    this.socket = new WebSocket(url);
    this.socket.binaryType = 'arraybuffer';
    this.socket.addEventListener('open', () => this.onOpen?.());
    this.socket.addEventListener('message', (event: MessageEvent) => {
      const data = event.data as CompanionTransportData;
      if (typeof data === 'string' || data instanceof ArrayBuffer || data instanceof Uint8Array || data instanceof Blob) {
        void this.deliver(data);
      }
    });
    this.socket.addEventListener('close', (event: CloseEvent) => this.onClose?.(event.code, event.reason));
    this.socket.addEventListener('error', () => this.onError?.(new Error('Companion WebSocket transport failed.')));
  }

  send(data: CompanionTransportData): void {
    if (this.socket.readyState !== WebSocket.OPEN) throw new Error('Companion transport is not open.');
    if (typeof data === 'string') {
      if (new TextEncoder().encode(data).byteLength > DEFAULT_MAX_FRAME_BYTES) throw new Error('Companion message exceeds the frame limit.');
      this.socket.send(data);
      return;
    }
    const size = data instanceof Blob ? data.size : data.byteLength;
    if (size > DEFAULT_MAX_FRAME_BYTES) throw new Error('Companion message exceeds the frame limit.');
    this.socket.send(data);
  }

  close(code = 1000, reason = 'Companion session closed.'): void {
    if (this.socket.readyState === WebSocket.CLOSED || this.socket.readyState === WebSocket.CLOSING) return;
    this.socket.close(code, reason);
  }

  private async deliver(data: CompanionTransportData): Promise<void> {
    try {
      await this.onMessage?.(data);
    } catch (error) {
      this.onError?.(error instanceof Error ? error : new Error('Companion message handling failed.'));
    }
  }
}

export const createWebSocketTransport: CompanionTransportFactory = (url) => new WebSocketTransport(url);
