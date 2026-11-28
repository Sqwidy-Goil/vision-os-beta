import type { HandVisualPoint } from '../types';
import { mapCameraLandmarkToViewport, type CameraDimensions } from './handMapping';

const HAND_CONNECTIONS: Array<[number, number]> = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [17, 18], [18, 19], [19, 20],
  [0, 17],
];

export class HandOverlay {
  private readonly context: CanvasRenderingContext2D;
  private width = 0;
  private height = 0;
  private cameraDimensions: () => CameraDimensions = () => ({ width: this.width || 1, height: this.height || 1 });

  constructor(private readonly canvas: HTMLCanvasElement) {
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Canvas 2D is unavailable for the hand overlay.');
    this.context = context;
  }

  setCameraDimensions(provider: () => CameraDimensions): void {
    this.cameraDimensions = provider;
  }

  clear(): void {
    this.context.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  draw(landmarks: HandVisualPoint[], arms: HandVisualPoint[], pinching: boolean): void {
    this.resize();
    this.clear();
    if (!landmarks.length && !arms.length) return;
    const project = (point: HandVisualPoint): { x: number; y: number } =>
      mapCameraLandmarkToViewport(point, this.cameraDimensions(), { width: this.width, height: this.height })
      ?? { x: (1 - point.x) * this.width, y: point.y * this.height };
    const context = this.context;
    context.save();
    context.lineCap = 'round';
    context.lineJoin = 'round';

    for (const [shoulderIndex, elbowIndex, wristIndex] of [[11, 13, 15], [12, 14, 16]] as const) {
      const shoulder = arms[shoulderIndex];
      const elbow = arms[elbowIndex];
      const wrist = arms[wristIndex];
      if (!shoulder || !wrist || (shoulder.visibility ?? 1) < 0.25 || (wrist.visibility ?? 1) < 0.25) continue;
      const start = project(shoulder);
      const middle = elbow && (elbow.visibility ?? 1) >= 0.25 ? project(elbow) : null;
      const end = project(wrist);
      const gradient = context.createLinearGradient(start.x, start.y, end.x, end.y);
      gradient.addColorStop(0, 'rgba(224, 164, 128, 0.34)');
      gradient.addColorStop(0.55, 'rgba(241, 190, 153, 0.48)');
      gradient.addColorStop(1, 'rgba(255, 218, 184, 0.62)');
      context.strokeStyle = gradient;
      context.lineWidth = Math.max(22, this.width * 0.052);
      context.shadowColor = 'rgba(117, 231, 255, 0.22)';
      context.shadowBlur = 16;
      context.beginPath();
      context.moveTo(start.x, start.y);
      if (middle) context.lineTo(middle.x, middle.y);
      context.lineTo(end.x, end.y);
      context.stroke();
    }

    if (landmarks.length) {
      const wrist = project(landmarks[0]);
      const trackedWrist = arms.some((point, index) => (index === 15 || index === 16) && Math.hypot(project(point).x - wrist.x, project(point).y - wrist.y) < this.width * 0.22);
      if (!trackedWrist) {
        const knuckle = project(landmarks[9] ?? landmarks[5]);
        const dx = wrist.x - knuckle.x;
        const dy = wrist.y - knuckle.y;
        const length = Math.hypot(dx, dy) || 1;
        const end = { x: wrist.x + dx / length * this.height * 0.62, y: wrist.y + dy / length * this.height * 0.62 };
        const gradient = context.createLinearGradient(wrist.x, wrist.y, end.x, end.y);
        gradient.addColorStop(0, 'rgba(255, 218, 184, 0.58)');
        gradient.addColorStop(1, 'rgba(224, 164, 128, 0.12)');
        context.strokeStyle = gradient;
        context.lineWidth = Math.max(24, this.width * 0.055);
        context.shadowColor = 'rgba(117, 231, 255, 0.24)';
        context.shadowBlur = 18;
        context.beginPath();
        context.moveTo(wrist.x, wrist.y);
        context.lineTo(end.x, end.y);
        context.stroke();
      }

      const accent = pinching ? '124, 245, 200' : '117, 231, 255';
      const palm = [0, 1, 5, 9, 13, 17].map((index) => landmarks[index]).filter((point): point is HandVisualPoint => Boolean(point)).map(project);
      if (palm.length >= 3) {
        context.beginPath();
        context.moveTo(palm[0].x, palm[0].y);
        palm.slice(1).forEach((point) => context.lineTo(point.x, point.y));
        context.closePath();
        context.fillStyle = 'rgba(245, 194, 155, 0.22)';
        context.strokeStyle = `rgba(${accent}, 0.88)`;
        context.lineWidth = Math.max(2, this.width * 0.0025);
        context.shadowColor = `rgba(${accent}, 0.7)`;
        context.shadowBlur = 15;
        context.fill();
        context.stroke();
      }
      context.strokeStyle = `rgba(${accent}, 0.94)`;
      context.lineWidth = Math.max(3, this.width * 0.005);
      context.shadowColor = `rgba(${accent}, 0.75)`;
      context.shadowBlur = 13;
      for (const [from, to] of HAND_CONNECTIONS) {
        const start = landmarks[from];
        const end = landmarks[to];
        if (!start || !end) continue;
        const a = project(start);
        const b = project(end);
        context.beginPath();
        context.moveTo(a.x, a.y);
        context.lineTo(b.x, b.y);
        context.stroke();
      }
      context.shadowBlur = 0;
      context.fillStyle = 'rgba(244, 252, 255, 0.96)';
      for (const point of landmarks) {
        const projected = project(point);
        context.beginPath();
        context.arc(projected.x, projected.y, Math.max(1.6, this.width * 0.0022), 0, Math.PI * 2);
        context.fill();
      }
    }
    context.restore();
  }

  private resize(): void {
    const width = this.canvas.clientWidth || globalThis.innerWidth;
    const height = this.canvas.clientHeight || globalThis.innerHeight;
    const ratio = Math.min(globalThis.devicePixelRatio || 1, 2);
    if (width === this.width && height === this.height && this.canvas.width === Math.round(width * ratio)) return;
    this.width = width;
    this.height = height;
    this.canvas.width = Math.round(width * ratio);
    this.canvas.height = Math.round(height * ratio);
    this.context.setTransform(ratio, 0, 0, ratio, 0, 0);
  }
}
