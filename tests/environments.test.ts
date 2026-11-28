import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createEnvironmentsApp } from '../src/applications/system';
import { DEFAULT_SETTINGS, type ApplicationContext, type ApplicationInstance } from '../src/types';

const environmentMocks = vi.hoisted(() => ({
  importPanorama: vi.fn(),
  listCustomEnvironments: vi.fn(() => []),
  getPanoramaUrl: vi.fn(),
  deletePanorama: vi.fn(),
  deleteEnvironmentFile: vi.fn(),
}));

vi.mock('../src/core/environments', () => environmentMocks);

function canvasContext(): CanvasRenderingContext2D {
  const gradient = { addColorStop: vi.fn() };
  return {
    save: vi.fn(),
    restore: vi.fn(),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    arcTo: vi.fn(),
    closePath: vi.fn(),
    fill: vi.fn(),
    stroke: vi.fn(),
    clip: vi.fn(),
    fillRect: vi.fn(),
    fillText: vi.fn(),
    createLinearGradient: vi.fn(() => gradient),
    drawImage: vi.fn(),
    measureText: vi.fn((text: string) => ({ width: text.length * 7 })),
  } as unknown as CanvasRenderingContext2D;
}

class FakeImage {
  complete = true;
  naturalWidth = 2048;
  naturalHeight = 1024;
  onload: (() => void) | null = null;
  src = '';
}

const instances: ApplicationInstance[] = [];

beforeEach(() => {
  environmentMocks.importPanorama.mockReset();
  environmentMocks.listCustomEnvironments.mockReturnValue([]);
  vi.stubGlobal('Image', FakeImage);
});

afterEach(() => {
  instances.splice(0).forEach((app) => app.destroy?.());
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Gallery 360 environment', () => {
  it('offers an actionable gallery card that imports and activates a panorama', async () => {
    const file = new File(['panorama'], 'my-panorama.jpg', { type: 'image/jpeg' });
    environmentMocks.importPanorama.mockResolvedValue({
      id: 'custom:panorama-1',
      name: 'my-panorama',
      fileId: 'file-1',
      width: 2048,
      height: 1024,
      createdAt: 1,
    });
    const pickFiles = vi.fn(async () => [file]);
    const setEnvironment = vi.fn();
    const notify = vi.fn();
    const context = {
      window: { canvas: { width: 400, height: 400 }, context: canvasContext(), requestRender: vi.fn() },
      pickFiles,
      setEnvironment,
      notify,
      getSettings: () => DEFAULT_SETTINGS,
    } as unknown as ApplicationContext;
    const app = createEnvironmentsApp(context);
    instances.push(app);
    const ctx = context.window.context;
    app.render(ctx, 400, 400, 0);
    expect(ctx.fillText).toHaveBeenCalledWith('Gallery 360', 34, 92, 332);
    expect(vi.mocked(ctx.fillText).mock.calls.some(([text, x, y]) => text === 'Open gallery' && x === 200 && y === 131.33333333333331)).toBe(true);

    expect(app.pointer?.(120, 131.33333333333331, {} as PointerEvent)).toBe(true);
    await vi.waitFor(() => expect(setEnvironment).toHaveBeenCalledWith('custom:panorama-1'));
    expect(pickFiles).toHaveBeenCalledWith('image/jpeg,image/png,image/webp', false);
    expect(environmentMocks.importPanorama).toHaveBeenCalledWith(file);
    expect(notify).toHaveBeenCalledWith('my-panorama imported and activated.');
  });

  it('does not change environments when the gallery picker is cancelled', async () => {
    const setEnvironment = vi.fn();
    const context = {
      window: { canvas: { width: 400, height: 400 }, context: canvasContext(), requestRender: vi.fn() },
      pickFiles: vi.fn(async () => []),
      setEnvironment,
      notify: vi.fn(),
      getSettings: () => DEFAULT_SETTINGS,
    } as unknown as ApplicationContext;
    const app = createEnvironmentsApp(context);
    instances.push(app);
    app.render(context.window.context, 400, 400, 0);
    app.pointer?.(120, 131.33333333333331, {} as PointerEvent);
    await Promise.resolve();
    expect(setEnvironment).not.toHaveBeenCalled();
    expect(environmentMocks.importPanorama).not.toHaveBeenCalled();
  });
});
