import { ellipsis, fillRoundedRect, roundedRect } from '../spatial/canvasUi';
import { uiSound } from '../core/uiSound';

export interface CanvasAction {
  x: number;
  y: number;
  width: number;
  height: number;
  action: () => void;
}

export function drawButton(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  label: string,
  action: () => void,
  active = false,
  accent = '#75e7ff',
): CanvasAction {
  fillRoundedRect(context, x, y, width, height, 11, active ? `${accent}25` : 'rgba(255,255,255,0.055)');
  roundedRect(context, x, y, width, height, 11);
  context.strokeStyle = active ? `${accent}80` : 'rgba(255,255,255,0.12)';
  context.lineWidth = 1;
  context.stroke();
  context.fillStyle = active ? accent : '#dce7f7';
  context.font = '600 12px -apple-system, BlinkMacSystemFont, sans-serif';
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.fillText(ellipsis(context, label, width - 16), x + width / 2, y + height / 2);
  context.textAlign = 'left';
  context.textBaseline = 'alphabetic';
  return { x, y, width, height, action };
}

export function actionAt(actions: CanvasAction[], x: number, y: number): boolean {
  const action = actions.find((candidate) => x >= candidate.x && x <= candidate.x + candidate.width && y >= candidate.y && y <= candidate.y + candidate.height);
  if (!action) return false;
  uiSound.play('tap');
  action.action();
  return true;
}

export function videoCoverTransform(video: HTMLVideoElement, x: number, y: number, width: number, height: number): { scale: number; offsetX: number; offsetY: number; sourceWidth: number; sourceHeight: number } {
  const sourceWidth = video.videoWidth || 1;
  const sourceHeight = video.videoHeight || 1;
  const scale = Math.max(width / sourceWidth, height / sourceHeight);
  return {
    scale,
    offsetX: x + (width - sourceWidth * scale) / 2,
    offsetY: y + (height - sourceHeight * scale) / 2,
    sourceWidth,
    sourceHeight,
  };
}

export function drawVideoCover(context: CanvasRenderingContext2D, video: HTMLVideoElement, x: number, y: number, width: number, height: number): void {
  if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;
  const transform = videoCoverTransform(video, x, y, width, height);
  context.save();
  roundedRect(context, x, y, width, height, 15);
  context.clip();
  context.drawImage(video, transform.offsetX, transform.offsetY, transform.sourceWidth * transform.scale, transform.sourceHeight * transform.scale);
  context.restore();
}

export function drawImageCover(context: CanvasRenderingContext2D, image: HTMLImageElement, x: number, y: number, width: number, height: number): void {
  const sourceWidth = image.naturalWidth || 1;
  const sourceHeight = image.naturalHeight || 1;
  const scale = Math.max(width / sourceWidth, height / sourceHeight);
  const drawWidth = sourceWidth * scale;
  const drawHeight = sourceHeight * scale;
  context.save();
  roundedRect(context, x, y, width, height, 13);
  context.clip();
  context.drawImage(image, x + (width - drawWidth) / 2, y + (height - drawHeight) / 2, drawWidth, drawHeight);
  context.restore();
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds)) return '0:00';
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${Math.floor(seconds % 60).toString().padStart(2, '0')}`;
}
