import { describe, expect, it, vi } from 'vitest';
import { createCompanionApp } from '../src/applications/companion';
import type { CompanionClientStatus } from '../src/spatial/companion/types';
import { DEFAULT_SETTINGS, type AppSettings, type ApplicationContext } from '../src/types';

function fakeCanvasContext(): CanvasRenderingContext2D {
  return {
    fillStyle: '', strokeStyle: '', font: '', textAlign: 'left', textBaseline: 'alphabetic', lineWidth: 1,
    save: vi.fn(), restore: vi.fn(), beginPath: vi.fn(), moveTo: vi.fn(), arcTo: vi.fn(), closePath: vi.fn(),
    fill: vi.fn(), stroke: vi.fn(), rect: vi.fn(), clip: vi.fn(), translate: vi.fn(), fillText: vi.fn(),
    measureText: vi.fn((text: string) => ({ width: text.length * 7 })),
  } as unknown as CanvasRenderingContext2D;
}

function status(overrides: Partial<CompanionClientStatus> = {}): CompanionClientStatus {
  return {
    status: 'idle', enabled: false, pairingCode: null, pairingExpiresAt: null,
    compatibility: { supported: false, protocolVersion: null, reason: null, transport: 'wss', payloadAuthentication: 'hmac-sha256', encryption: 'wss-only', compression: ['gzip', 'identity'], depthEncodings: ['float32le', 'base64'] },
    calibration: { state: 'uncalibrated', confidence: 0, calibrationId: null, frame: null, updatedAt: null, reason: null },
    quality: 'none', latestTimestamp: null, connectedAt: null, error: null, reconnect: { state: 'idle', reason: null },
    ...overrides,
  };
}

function setup(initialStatus = status()) {
  const ctx = fakeCanvasContext();
  const canvas = { width: 1024, height: 548, context: ctx } as unknown as HTMLCanvasElement;
  let settings: AppSettings = { ...DEFAULT_SETTINGS };
  const requestRender = vi.fn();
  const requestText = vi.fn(async (): Promise<string | null> => 'wss://127.0.0.1:8443');
  const connectCompanion = vi.fn(async (): Promise<void> => undefined);
  const disconnectCompanion = vi.fn();
  const updateSettings = vi.fn((partial: Partial<AppSettings>) => { settings = { ...settings, ...partial }; });
  const context = {
    window: { id: 'companion-test', canvas, context: ctx, requestRender },
    getSettings: () => settings,
    updateSettings,
    getCompanionStatus: () => initialStatus,
    requestText,
    connectCompanion,
    disconnectCompanion,
    notify: vi.fn(),
  } as unknown as ApplicationContext;
  const app = createCompanionApp(context);
  const render = (): void => app.render(ctx, canvas.width, canvas.height, 0);
  const click = (x: number, y: number): boolean => app.pointer?.(x, y, { type: 'pointerup' } as PointerEvent) ?? false;
  return { app, ctx, render, click, settings: () => settings, requestText, connectCompanion, disconnectCompanion, updateSettings };
}

describe('LiDAR companion application', () => {
  it('enables explicitly, requests an endpoint and starts pairing', async () => {
    const test = setup();
    test.render();
    expect(test.click(50, 50)).toBe(true);
    expect(test.settings().companionEnabled).toBe(true);
    test.render();
    expect(test.click(50, 470)).toBe(true);
    await vi.waitFor(() => expect(test.connectCompanion).toHaveBeenCalledWith('wss://127.0.0.1:8443'));
    expect(test.requestText).toHaveBeenCalledOnce();
  });

  it('switches spatial mode and disconnects through centralized controls', () => {
    const test = setup(status({ status: 'calibrated', enabled: true }));
    test.render();
    expect(test.click(50, 515)).toBe(true);
    expect(test.settings().spatialMode).toBe('full');
    expect(test.click(200, 470)).toBe(true);
    expect(test.disconnectCompanion).toHaveBeenCalledOnce();
  });

  it('shows the live pairing code and calibration state', () => {
    const test = setup(status({ status: 'pairing', enabled: true, pairingCode: 'ABCD-EFGH', calibration: { state: 'calibrating', confidence: 0.7, calibrationId: null, frame: null, updatedAt: null, reason: null } }));
    test.render();
    expect(test.ctx.fillText).toHaveBeenCalledWith('Pairing code: ABCD-EFGH', 30, 254);
    expect(test.ctx.fillText).toHaveBeenCalledWith('Calibration: calibrating • 70%', 30, 132);
  });

  it('serializes the local endpoint without credentials or sensor data', () => {
    const test = setup();
    expect((test.app.serialize?.() as { endpoint: string }).endpoint).toBe('');
    test.app.restore?.({ endpoint: 'wss://127.0.0.1:9443' });
    expect(test.app.serialize?.()).toEqual({ endpoint: 'wss://127.0.0.1:9443' });
  });
});
