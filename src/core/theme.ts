import type { InterfacePaletteId } from '../types';

export interface InterfacePaletteDefinition {
  id: InterfacePaletteId;
  name: string;
  accent: string;
  secondary: string;
  background: string;
  backgroundMid: string;
  backgroundDeep: string;
  backgroundGlow: string;
}

export const INTERFACE_PALETTES: readonly InterfacePaletteDefinition[] = [
  { id: 'glacier', name: 'Glacier', accent: '#75e7ff', secondary: '#9fc5ff', background: '#0b0e12', backgroundMid: '#0c1014', backgroundDeep: '#05070a', backgroundGlow: '#20252b' },
  { id: 'lagoon', name: 'Lagoon', accent: '#78f0d0', secondary: '#75e7ff', background: '#071310', backgroundMid: '#0a1a17', backgroundDeep: '#030a08', backgroundGlow: '#12332c' },
  { id: 'sunset', name: 'Sunset', accent: '#ffb37c', secondary: '#ff8f9d', background: '#160d0d', backgroundMid: '#211314', backgroundDeep: '#090405', backgroundGlow: '#45242a' },
  { id: 'orchid', name: 'Orchid', accent: '#c7a6ff', secondary: '#f59cff', background: '#100b18', backgroundMid: '#181023', backgroundDeep: '#060309', backgroundGlow: '#32204b' },
  { id: 'citrus', name: 'Citrus', accent: '#ffe08a', secondary: '#78f0a8', background: '#151208', backgroundMid: '#211c0d', backgroundDeep: '#080602', backgroundGlow: '#40351a' },
  { id: 'graphite', name: 'Graphite', accent: '#d7dce2', secondary: '#9fc5ff', background: '#0d0f12', backgroundMid: '#14171b', backgroundDeep: '#050607', backgroundGlow: '#292d33' },
];

export function getInterfacePalette(id: InterfacePaletteId): InterfacePaletteDefinition {
  return INTERFACE_PALETTES.find((palette) => palette.id === id) ?? INTERFACE_PALETTES[0];
}

function rgbChannels(hex: string): string {
  const value = Number.parseInt(hex.slice(1), 16);
  return `${(value >> 16) & 255}, ${(value >> 8) & 255}, ${value & 255}`;
}

export function interfacePaletteCss(id: InterfacePaletteId): Record<string, string> {
  const palette = getInterfacePalette(id);
  return {
    '--cyan': palette.accent,
    '--blue': palette.secondary,
    '--violet': palette.secondary,
    '--accent-rgb': rgbChannels(palette.accent),
    '--secondary-rgb': rgbChannels(palette.secondary),
    '--bg': palette.background,
    '--bg-mid': palette.backgroundMid,
    '--bg-deep': palette.backgroundDeep,
    '--bg-glow': palette.backgroundGlow,
  };
}

export function applyInterfacePalette(id: InterfacePaletteId, root: HTMLElement = document.documentElement): void {
  const palette = getInterfacePalette(id);
  for (const [property, value] of Object.entries(interfacePaletteCss(id))) root.style.setProperty(property, value);
  root.ownerDocument.querySelector('meta[name="theme-color"]')?.setAttribute('content', palette.background);
}
