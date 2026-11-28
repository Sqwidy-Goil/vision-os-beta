import { describe, expect, it, vi } from 'vitest';
import { createSettingsApp } from '../src/applications/system';
import { INTERFACE_PALETTES, applyInterfacePalette, getInterfacePalette, interfacePaletteCss } from '../src/core/theme';
import { DEFAULT_SETTINGS, type ApplicationContext, type InterfacePaletteId } from '../src/types';

function canvasContext(): CanvasRenderingContext2D {
  const gradient = { addColorStop: vi.fn() };
  return {
    clearRect: vi.fn(),
    fillRect: vi.fn(),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    arcTo: vi.fn(),
    closePath: vi.fn(),
    fill: vi.fn(),
    stroke: vi.fn(),
    save: vi.fn(),
    restore: vi.fn(),
    fillText: vi.fn(),
    createLinearGradient: vi.fn(() => gradient),
    measureText: vi.fn((text: string) => ({ width: text.length * 7 })),
    fillStyle: '#000000',
    strokeStyle: '#000000',
    font: '',
    textAlign: 'left',
    textBaseline: 'alphabetic',
    lineWidth: 1,
  } as unknown as CanvasRenderingContext2D;
}

describe('interface palettes', () => {
  it('defines six distinct palettes with safe fallback colors', () => {
    expect(INTERFACE_PALETTES).toHaveLength(6);
    expect(new Set(INTERFACE_PALETTES.map((palette) => palette.id)).size).toBe(6);
    expect(getInterfacePalette('invalid' as InterfacePaletteId).id).toBe('glacier');
    expect(interfacePaletteCss('lagoon')).toMatchObject({
      '--cyan': '#78f0d0',
      '--blue': '#75e7ff',
      '--bg': '#071310',
      '--accent-rgb': '120, 240, 208',
    });
  });

  it('applies CSS tokens and the browser theme color', () => {
    const properties = new Map<string, string>();
    const setProperty = vi.fn((name: string, value: string) => properties.set(name, value));
    const setAttribute = vi.fn();
    const root = {
      style: { setProperty },
      ownerDocument: { querySelector: vi.fn(() => ({ setAttribute })) },
    } as unknown as HTMLElement;
    applyInterfacePalette('orchid', root);
    expect(properties.get('--cyan')).toBe('#c7a6ff');
    expect(properties.get('--bg-deep')).toBe('#060309');
    expect(setAttribute).toHaveBeenCalledWith('content', '#100b18');
  });

  it('cycles the palette from the hand-accessible VR Settings row', () => {
    const ctx = canvasContext();
    const canvas = { width: 1024, height: 548, context: ctx } as unknown as HTMLCanvasElement;
    const updateSettings = vi.fn();
    const context = {
      window: { id: 'settings-test', canvas, context: ctx, requestRender: vi.fn() },
      getSettings: () => DEFAULT_SETTINGS,
      updateSettings,
    } as unknown as ApplicationContext;
    const app = createSettingsApp(context);
    app.render(ctx, 1024, 548, 0);
    expect(app.pointer?.(938, 73, { type: 'pointerup' } as PointerEvent)).toBe(true);
    expect(updateSettings).toHaveBeenCalledWith({ palette: 'lagoon' });
    app.destroy?.();
  });
});
