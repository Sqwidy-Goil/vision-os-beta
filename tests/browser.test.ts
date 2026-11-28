import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBrowserApp, normalizeBrowserInput, normalizeUrl } from '../src/applications/system';
import type { ApplicationContext, ApplicationInstance } from '../src/types';
import { DEFAULT_SETTINGS } from '../src/types';

interface BrowserState {
  schemaVersion: number;
  url: string;
  history: string[];
  historyIndex: number;
}

function fakeCanvasContext(): CanvasRenderingContext2D {
  return {
    fillStyle: '',
    strokeStyle: '',
    font: '',
    textAlign: 'left',
    textBaseline: 'alphabetic',
    lineWidth: 1,
    save: vi.fn(),
    restore: vi.fn(),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    arcTo: vi.fn(),
    closePath: vi.fn(),
    fill: vi.fn(),
    stroke: vi.fn(),
    fillText: vi.fn(),
    measureText: vi.fn((text: string) => ({ width: text.length * 7 })),
  } as unknown as CanvasRenderingContext2D;
}

function browserContext(glassTransparency = DEFAULT_SETTINGS.glassTransparency) {
  const ctx = fakeCanvasContext();
  const canvas = { width: 1024, height: 548, context: ctx } as unknown as HTMLCanvasElement;
  const requestRender = vi.fn();
  const setOverlay = vi.fn();
  const requestUrl = vi.fn(async (): Promise<string | null> => null);
  const context = {
    window: { id: 'browser-test', canvas, context: ctx, requestRender, setOverlay },
    requestUrl,
    isVrActive: () => false,
    getSettings: () => ({ ...DEFAULT_SETTINGS, glassTransparency }),
  } as unknown as ApplicationContext;
  return { context, ctx, requestRender, setOverlay, requestUrl };
}

function snapshot(app: ApplicationInstance): BrowserState {
  return app.serialize?.() as BrowserState;
}

const instances: ApplicationInstance[] = [];

function browserApp(context: ApplicationContext, initialUrl?: string): ApplicationInstance {
  const app = createBrowserApp(context, initialUrl);
  instances.push(app);
  return app;
}

afterEach(() => {
  instances.splice(0).forEach((app) => app.destroy?.());
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('spatial browser URL validation', () => {
  it('normalizes addresses and adds HTTPS', () => {
    expect(normalizeUrl('example.com')).toBe('https://example.com/');
    expect(normalizeUrl('http://localhost:5173')).toBe('http://localhost:5173/');
  });

  it('rejects unsupported protocols and malformed input', () => {
    expect(normalizeUrl('javascript:alert(1)')).toBeNull();
    expect(normalizeUrl('')).toBeNull();
    expect(normalizeUrl('not a valid address')).toBeNull();
  });

  it('turns plain search terms into a safe search URL', () => {
    expect(normalizeBrowserInput('spatial computing')).toBe('https://www.google.com/search?q=spatial%20computing');
    expect(normalizeBrowserInput('localhost:5173')).toBe('http://localhost:5173/');
    expect(normalizeBrowserInput('javascript:alert(1)')).toBeNull();
  });
});

describe('spatial browser window state', () => {
  function installDom() {
    const iframe = {
      style: { visibility: '', opacity: '' },
      src: '',
      setAttribute: vi.fn(),
      addEventListener: vi.fn(),
    };
    vi.stubGlobal('document', {
      createElement: vi.fn(() => iframe),
    });
    return iframe;
  }

  it('aligns the site iframe to the content area and follows window transparency', () => {
    const iframe = installDom();
    const harness = browserContext(1);
    const app = browserApp(harness.context, 'https://example.com/');
    expect(harness.setOverlay).toHaveBeenCalledWith(iframe, {
      x: 12,
      y: 92,
      width: 1000,
      height: 548,
    });
    app.render(harness.ctx, 1024, 548, 0);
    expect(iframe.style.opacity).toBe('0.5');
    expect(iframe.style.visibility).toBe('visible');
    harness.context.isVrActive = () => true;
    app.render(harness.ctx, 1024, 548, 0);
    expect(iframe.style.visibility).toBe('hidden');
  });

  it('round-trips the current URL and restores working back/forward history', async () => {
    installDom();
    const harness = browserContext();
    harness.requestUrl.mockResolvedValueOnce('https://example.com/two').mockResolvedValueOnce('https://example.com/three');
    const original = browserApp(harness.context, 'https://example.com/one');
    original.openKeyboard?.();
    await vi.waitFor(() => expect(snapshot(original).url).toBe('https://example.com/two'));
    original.openKeyboard?.();
    await vi.waitFor(() => expect(snapshot(original).url).toBe('https://example.com/three'));
    const saved = snapshot(original);
    expect(saved.history).toEqual(['https://example.com/one', 'https://example.com/two', 'https://example.com/three']);
    expect(saved.historyIndex).toBe(2);

    const restored = browserApp(harness.context);
    restored.restore?.(JSON.parse(JSON.stringify(saved)));
    expect(snapshot(restored)).toEqual(saved);
    restored.render(harness.ctx, 1024, 548, 0);
    expect(restored.pointer?.(736, 35, { type: 'pointerup' } as PointerEvent)).toBe(true);
    expect(snapshot(restored).url).toBe('https://example.com/two');
    expect(restored.pointer?.(790, 35, { type: 'pointerup' } as PointerEvent)).toBe(true);
    expect(snapshot(restored).url).toBe('https://example.com/three');
  });

  it('excludes credentials and iframe data and bounds restored history and URLs', () => {
    installDom();
    const harness = browserContext();
    const app = browserApp(harness.context);
    const history = Array.from({ length: 80 }, (_, index) => `https://example.com/${index}?q=${'x'.repeat(3_000)}`);
    expect(() => app.restore?.({
      schemaVersion: 1,
      url: 'https://user:password@example.com/current?token=url-secret&authToken=auth-secret&clientSecret=client-secret&state=state-secret&session=session-secret&cookie=cookie-secret&monkey=safe&q=safe#access_token=hash-secret',
      history,
      historyIndex: 79,
      cookies: 'cookie-secret',
      apiKey: 'api-secret',
      iframe: { html: '<html>private</html>' },
    })).not.toThrow();
    const saved = snapshot(app);
    const serialized = JSON.stringify(saved);
    expect(saved.history).toHaveLength(50);
    expect(saved.history.every((url) => url.length <= 2_048)).toBe(true);
    expect(saved.url).toBe('https://example.com/current?monkey=safe&q=safe');
    expect(serialized).not.toMatch(/password|url-secret|hash-secret|auth-secret|client-secret|state-secret|session-secret|cookie-secret|api-secret|<html>/);
    expect(saved).not.toHaveProperty('iframe');
  });

  it('ignores malformed or unsupported restore input without throwing', () => {
    installDom();
    const harness = browserContext();
    const app = browserApp(harness.context, 'https://example.com/keep');
    const before = snapshot(app);
    for (const value of [null, [], 42, { schemaVersion: 2, url: 'https://example.com/' }, { schemaVersion: 1, url: 'javascript:alert(1)' }]) {
      expect(() => app.restore?.(value)).not.toThrow();
      expect(snapshot(app)).toEqual(before);
    }
  });
});
