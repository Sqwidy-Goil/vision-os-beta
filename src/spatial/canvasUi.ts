import type { WindowHitRegion, WindowState } from '../types';

export const WINDOW_CHROME_HEIGHT = 92;
export const WINDOW_CONTROL_Y = WINDOW_CHROME_HEIGHT / 2;
export const WINDOW_CONTROL_ACTIONS = ['close', 'minimize', 'maximize', 'mode', 'rotate', 'roll', 'depth', 'anchor'] as const;
export const WINDOW_CONTROL_OFFSETS = [52, 140, 228, 316, 404, 492, 580, 668] as const;
export const WINDOW_CONTROL_HIT_RADIUS = 40;
const WINDOW_CONTROL_AREA_WIDTH = WINDOW_CONTROL_OFFSETS[WINDOW_CONTROL_OFFSETS.length - 1] + WINDOW_CONTROL_HIT_RADIUS;

export function roundedRect(context: CanvasRenderingContext2D, x: number, y: number, width: number, height: number, radius: number): void {
  const r = Math.min(radius, width / 2, height / 2);
  context.beginPath();
  context.moveTo(x + r, y);
  context.arcTo(x + width, y, x + width, y + height, r);
  context.arcTo(x + width, y + height, x, y + height, r);
  context.arcTo(x, y + height, x, y, r);
  context.arcTo(x, y, x + width, y, r);
  context.closePath();
}

export function fillRoundedRect(context: CanvasRenderingContext2D, x: number, y: number, width: number, height: number, radius: number, fill: string | CanvasGradient): void {
  roundedRect(context, x, y, width, height, radius);
  context.fillStyle = fill;
  context.fill();
}

export function drawWindowChrome(context: CanvasRenderingContext2D, width: number, height: number, state: WindowState, accent: string, transparency = 0.78, hoveredAction?: WindowHitRegion['action'], highlight = '#75e7ff'): void {
  const alpha = 0.035 + (1 - transparency) * 0.42;
  const background = context.createLinearGradient(0, 0, width, height);
  background.addColorStop(0, `rgba(255,255,255,${alpha * 1.25})`);
  background.addColorStop(0.48, `rgba(22,26,32,${alpha * 0.58})`);
  background.addColorStop(1, `rgba(255,255,255,${alpha * 0.72})`);
  fillRoundedRect(context, 1, 1, width - 2, height - 2, 30, background);
  context.strokeStyle = 'rgba(255,255,255,0.34)';
  context.lineWidth = 2;
  roundedRect(context, 2, 2, width - 4, height - 4, 28);
  context.stroke();
  context.strokeStyle = 'rgba(255,255,255,0.09)';
  context.lineWidth = 1;
  roundedRect(context, 7, 7, width - 14, height - 14, 23);
  context.stroke();

  const titleGlass = context.createLinearGradient(0, 0, 0, WINDOW_CHROME_HEIGHT);
  titleGlass.addColorStop(0, `rgba(255,255,255,${alpha * 0.9})`);
  titleGlass.addColorStop(1, 'rgba(255,255,255,0.008)');
  context.fillStyle = titleGlass;
  context.fillRect(2, 2, width - 4, WINDOW_CHROME_HEIGHT - 2);
  if (hoveredAction === 'drag') fillRoundedRect(context, 12, 8, Math.max(0, width - WINDOW_CONTROL_AREA_WIDTH - 24), WINDOW_CHROME_HEIGHT - 16, 16, `${highlight}13`);

  const glow = context.createRadialGradient(54, 12, 0, 54, 12, 360);
  glow.addColorStop(0, `${accent}20`);
  glow.addColorStop(1, `${accent}00`);
  context.fillStyle = glow;
  context.fillRect(0, 0, width, 150);
  const gloss = context.createLinearGradient(0, 0, width * 0.78, 145);
  gloss.addColorStop(0, 'rgba(255,255,255,0.2)');
  gloss.addColorStop(0.22, 'rgba(255,255,255,0.055)');
  gloss.addColorStop(0.58, 'rgba(255,255,255,0)');
  context.fillStyle = gloss;
  context.fillRect(2, 2, width - 4, 142);

  context.fillStyle = 'rgba(255,255,255,0.14)';
  context.fillRect(1, WINDOW_CHROME_HEIGHT, width - 2, 1);
  context.fillStyle = accent;
  context.beginPath();
  context.arc(27, WINDOW_CONTROL_Y, 6, 0, Math.PI * 2);
  context.fill();
  context.font = '650 19px -apple-system, BlinkMacSystemFont, sans-serif';
  context.fillStyle = '#f8fbff';
  context.textBaseline = 'middle';
  context.fillText(state.title, 44, WINDOW_CONTROL_Y, Math.max(120, width - WINDOW_CONTROL_AREA_WIDTH - 60));

  const controls = [
    { label: '×', action: 'close', color: '#ffb3bc' },
    { label: '–', action: 'minimize', color: '#ffe0aa' },
    { label: '□', action: 'maximize', color: '#b7f8de' },
    { label: '◎', action: 'mode', color: '#d5e5ff' },
    { label: '↻', action: 'rotate', color: '#e3d8ff' },
    { label: '↶', action: 'roll', color: '#e3d8ff' },
    { label: '↕', action: 'depth', color: '#c9f7e7' },
    { label: '◆', action: 'anchor', color: '#c9f7e7' },
  ] as const;
  controls.forEach((control, index) => {
    const x = width - WINDOW_CONTROL_OFFSETS[index];
    const hovered = hoveredAction === control.action;
    const active = control.action === 'anchor' && state.anchor !== undefined;
    context.beginPath();
    context.arc(x, WINDOW_CONTROL_Y, hovered ? 31 : 27, 0, Math.PI * 2);
    context.fillStyle = hovered || active ? `${highlight}38` : 'rgba(255,255,255,0.075)';
    context.fill();
    context.strokeStyle = hovered || active ? `${highlight}e6` : 'rgba(255,255,255,0.13)';
    context.lineWidth = 1;
    context.stroke();
    context.fillStyle = control.color;
    context.font = '500 24px -apple-system, BlinkMacSystemFont, sans-serif';
    context.textAlign = 'center';
    context.fillText(control.label, x, WINDOW_CONTROL_Y + 1);
  });
  context.textAlign = 'left';

  const modeLabel = state.pinned
    ? 'PINNED • WORLD POSITION SAVED'
    : state.anchor
      ? `ANCHORED • ${(state.anchorKind ?? 'world').toUpperCase()}`
      : state.mode === 'world'
        ? 'WORLD-LOCKED'
        : state.mode === 'head'
          ? 'HEAD-LOCKED'
          : 'FACE CAMERA';
  context.font = '650 10px -apple-system, BlinkMacSystemFont, sans-serif';
  context.fillStyle = 'rgba(230,238,249,0.68)';
  context.fillText(modeLabel, 20, height - 20);
  context.fillStyle = 'rgba(255,255,255,0.2)';
  fillRoundedRect(context, width - 30, height - 25, 16, 16, 5, hoveredAction === 'resize' ? `${highlight}d9` : 'rgba(255,255,255,0.14)');
}

export function windowHitRegion(u: number, v: number, width: number, height: number): WindowHitRegion {
  const x = u * width;
  const y = (1 - v) * height;
  if (y <= WINDOW_CHROME_HEIGHT) {
    for (let index = 0; index < WINDOW_CONTROL_OFFSETS.length; index += 1) {
      const controlX = width - WINDOW_CONTROL_OFFSETS[index];
      if (Math.hypot(x - controlX, y - WINDOW_CONTROL_Y) <= WINDOW_CONTROL_HIT_RADIUS) {
        return { action: WINDOW_CONTROL_ACTIONS[index] };
      }
    }
    return { action: 'drag' };
  }
  if (x > width - 46 && y > height - 46) return { action: 'resize' };
  return { action: 'content', contentX: x, contentY: y - WINDOW_CHROME_HEIGHT };
}

export function ellipsis(context: CanvasRenderingContext2D, text: string, maxWidth: number): string {
  if (context.measureText(text).width <= maxWidth) return text;
  let result = text;
  while (result.length > 1 && context.measureText(`${result}…`).width > maxWidth) result = result.slice(0, -1);
  return `${result}…`;
}

export function drawEmptyState(context: CanvasRenderingContext2D, width: number, height: number, title: string, detail: string, accent = '#75e7ff'): void {
  context.textAlign = 'center';
  context.fillStyle = accent;
  context.font = '600 12px -apple-system, BlinkMacSystemFont, sans-serif';
  context.fillText(title.toUpperCase(), width / 2, height / 2 - 20);
  context.fillStyle = '#9aacc4';
  context.font = '13px -apple-system, BlinkMacSystemFont, sans-serif';
  context.fillText(ellipsis(context, detail, width - 70), width / 2, height / 2 + 8, width - 70);
  context.textAlign = 'left';
}
