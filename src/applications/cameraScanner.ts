import type { ApplicationContext, ApplicationInstance, ScanRecord } from '../types';
import { storage } from '../core/storage';
import { SpatialScanner, type ScanStats } from '../services/scanner';
import { drawEmptyState, fillRoundedRect, roundedRect } from '../spatial/canvasUi';
import { actionAt, drawButton, drawVideoCover, videoCoverTransform, type CanvasAction } from './ui';

const HAND_CONNECTIONS: Array<[number, number]> = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [17, 18], [18, 19], [19, 20],
  [0, 17],
];

export function createCameraApp(context: ApplicationContext): ApplicationInstance {
  const actions: CanvasAction[] = [];
  let showLandmarks = true;

  return {
    update: () => {
      context.window.requestRender();
    },
    render: (ctx, width, height) => {
      actions.length = 0;
      const preview = { x: 16, y: 14, width: width - 32, height: height - 82 };
      fillRoundedRect(ctx, preview.x, preview.y, preview.width, preview.height, 16, '#050c16');
      if (context.rearCamera.ready) {
        drawVideoCover(ctx, context.rearCamera.video, preview.x, preview.y, preview.width, preview.height);
        const result = context.handTracker.lastResult;
        if (showLandmarks && context.handTracker.active && result.landmarks[0]) {
          const landmarks = result.landmarks[0];
          const transform = videoCoverTransform(context.rearCamera.video, preview.x, preview.y, preview.width, preview.height);
          const project = (point: { x: number; y: number }): { x: number; y: number } => ({
            x: transform.offsetX + point.x * transform.sourceWidth * transform.scale,
            y: transform.offsetY + point.y * transform.sourceHeight * transform.scale,
          });
          ctx.strokeStyle = result.pinching ? '#7cf5c8' : '#75e7ff';
          ctx.lineWidth = 2;
          for (const [from, to] of HAND_CONNECTIONS) {
            const a = landmarks[from];
            const b = landmarks[to];
            if (!a || !b) continue;
            const start = project(a);
            const end = project(b);
            ctx.beginPath();
            ctx.moveTo(start.x, start.y);
            ctx.lineTo(end.x, end.y);
            ctx.stroke();
          }
          ctx.fillStyle = '#ffffff';
          for (const point of landmarks) {
            const projected = project(point);
            ctx.beginPath();
            ctx.arc(projected.x, projected.y, 2.4, 0, Math.PI * 2);
            ctx.fill();
          }
        }
        ctx.fillStyle = 'rgba(3,9,17,.66)';
        fillRoundedRect(ctx, preview.x + 12, preview.y + 12, 176, 28, 9, 'rgba(3,9,17,.66)');
        ctx.fillStyle = context.rearCamera.facingMode === 'environment' ? '#7cf5c8' : '#ffd28a';
        ctx.font = '600 10px -apple-system, BlinkMacSystemFont, sans-serif';
        ctx.fillText(context.rearCamera.facingMode === 'environment' ? 'REAR CAMERA • LIVE' : 'CAMERA • LIVE', preview.x + 24, preview.y + 30);
      } else {
        drawEmptyState(ctx, width, height - 34, 'Rear camera', 'Enable the camera to see a live private preview.');
      }
      const buttonY = height - 58;
      actions.push(drawButton(ctx, 16, buttonY, 146, 40, context.rearCamera.active ? 'Stop camera' : 'Enable camera', () => {
        if (context.rearCamera.active) context.rearCamera.stop();
        else void context.rearCamera.start().catch(() => undefined);
      }, context.rearCamera.active));
      actions.push(drawButton(ctx, 174, buttonY, 166, 40, context.handTracker.active ? 'Hands: on' : 'Enable hands', () => {
        void context.toggleHandControls();
      }, context.handTracker.active, '#b694ff'));
      actions.push(drawButton(ctx, 352, buttonY, 130, 40, showLandmarks ? 'Hide skeleton' : 'Show skeleton', () => { showLandmarks = !showLandmarks; }, showLandmarks));
      if (width > 620) {
        actions.push(drawButton(ctx, width - 150, buttonY, 134, 40, 'Open scanner', () => context.notify('Use the Scan app to capture an estimated point cloud.')));
      }
      ctx.fillStyle = 'rgba(220,231,247,.62)';
      ctx.font = '10px -apple-system, BlinkMacSystemFont, sans-serif';
      ctx.fillText(context.handTracker.active ? 'Pinch threshold: 5.5% of frame width' : 'Hand tracking downloads a model once and may be unavailable offline.', 18, height - 10);
    },
    pointer: (x, y) => actionAt(actions, x, y),
  };
}

export function createScannerApp(context: ApplicationContext): ApplicationInstance {
  const scanner = new SpatialScanner();
  const actions: CanvasAction[] = [];
  let stats: ScanStats = { features: 0, tracked: 0, points: 0, motionX: 0, motionY: 0, lastCapture: 0 };
  let status = 'Ready to scan';
  let savedRecord: ScanRecord | null = null;
  let draft: ScanRecord | null = null;

  const saveRecord = (record: ScanRecord): void => {
    draft = record;
    void storage.set(`scan:${record.id}`, record).then(() => {
      context.showScan(record);
      savedRecord = record;
      draft = null;
      status = 'Scan saved locally';
      context.notify(`Saved ${record.pointCount} estimated points.`);
    }).catch((error: unknown) => {
      status = 'Save failed — draft retained';
      context.notify(error instanceof Error ? error.message : 'Could not save scan. The draft is still available.');
    });
  };

  return {
    update: () => {
      if (scanner.scanning && context.rearCamera.ready) {
        const start = performance.now();
        stats = scanner.capture(context.rearCamera.video);
        context.rearCamera.recordFrameCost(performance.now() - start);
        status = 'Tracking visual features';
      }
      context.window.requestRender();
    },
    render: (ctx, width, height) => {
      actions.length = 0;
      const preview = { x: 16, y: 14, width: width - 32, height: height - 104 };
      fillRoundedRect(ctx, preview.x, preview.y, preview.width, preview.height, 16, '#050c16');
      if (context.rearCamera.ready) {
        drawVideoCover(ctx, context.rearCamera.video, preview.x, preview.y, preview.width, preview.height);
        ctx.strokeStyle = scanner.scanning ? '#75e7ff' : 'rgba(255,255,255,.28)';
        ctx.lineWidth = 1;
        ctx.setLineDash([6, 7]);
        roundedRect(ctx, preview.x + 18, preview.y + 18, preview.width - 36, preview.height - 36, 11);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.strokeStyle = '#75e7ff';
        ctx.beginPath();
        ctx.moveTo(preview.x + preview.width / 2 - 14, preview.y + preview.height / 2);
        ctx.lineTo(preview.x + preview.width / 2 + 14, preview.y + preview.height / 2);
        ctx.moveTo(preview.x + preview.width / 2, preview.y + preview.height / 2 - 14);
        ctx.lineTo(preview.x + preview.width / 2, preview.y + preview.height / 2 + 14);
        ctx.stroke();
      } else {
        drawEmptyState(ctx, width, height - 54, 'RGB feature scanner', 'Enable the rear camera, then move slowly to capture features.');
      }
      ctx.fillStyle = 'rgba(3,9,17,.74)';
      fillRoundedRect(ctx, preview.x + 12, preview.y + preview.height - 48, preview.width - 24, 34, 10, 'rgba(3,9,17,.74)');
      ctx.fillStyle = '#dce7f7';
      ctx.font = '600 11px -apple-system, BlinkMacSystemFont, sans-serif';
      ctx.fillText(`${status}  •  ${stats.points.toLocaleString()} points  •  ${stats.features} features`, preview.x + 24, preview.y + preview.height - 27);
      const buttonY = height - 76;
      const pendingSave = draft !== null && savedRecord === null;
      actions.push(drawButton(ctx, 16, buttonY, 156, 42, scanner.scanning ? 'Stop & save' : pendingSave ? 'Retry save' : 'Start scan', () => {
        if (scanner.scanning) {
          if (scanner.pointCount < 10) {
            context.notify('Capture at least 10 tracked points before saving.');
            return;
          }
          saveRecord(scanner.finish(`Scan ${new Date().toLocaleDateString()}`));
        } else if (draft) {
          saveRecord(draft);
        } else {
          savedRecord = null;
          void context.rearCamera.start().then(() => {
            scanner.start();
            status = 'Move slowly while tracking';
          }).catch(() => undefined);
        }
      }, scanner.scanning || pendingSave));
      actions.push(drawButton(ctx, 184, buttonY, 128, 42, 'Reset', () => { scanner.reset(); stats = { features: 0, tracked: 0, points: 0, motionX: 0, motionY: 0, lastCapture: 0 }; status = 'Ready to scan'; savedRecord = null; draft = null; }));
      actions.push(drawButton(ctx, 324, buttonY, 138, 42, 'View 3D', () => {
        const record = savedRecord ?? draft;
        if (record) context.showScan(record);
        else context.notify('Save a scan before opening its 3D point cloud.');
      }, savedRecord !== null || draft !== null));
      ctx.fillStyle = 'rgba(220,231,247,.55)';
      ctx.font = '9px -apple-system, BlinkMacSystemFont, sans-serif';
      ctx.fillText('Measured: image features. Estimated: depth and geometry. No LiDAR or ARKit metric reconstruction.', 18, height - 16);
    },
    pointer: (x, y) => actionAt(actions, x, y),
    destroy: () => scanner.stop(),
  };
}
