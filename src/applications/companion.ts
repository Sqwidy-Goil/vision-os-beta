import type { ApplicationContext, ApplicationInstance } from '../types';
import { ellipsis, fillRoundedRect } from '../spatial/canvasUi';
import { actionAt, drawButton, type CanvasAction } from './ui';

export function createCompanionApp(context: ApplicationContext): ApplicationInstance {
  const actions: CanvasAction[] = [];
  let endpoint = '';
  let connecting = false;

  const connect = async (): Promise<void> => {
    if (connecting) return;
    connecting = true;
    try {
      let value = endpoint.trim();
      if (!value) {
        const entered = await context.requestText({
          title: 'External LiDAR companion',
          value: endpoint,
          placeholder: 'wss://127.0.0.1:8443',
          submitLabel: 'Pair',
        });
        value = entered?.trim() ?? '';
        if (!value) return;
        endpoint = value;
      }
      await context.connectCompanion(endpoint);
      context.notify('Companion connected. Waiting for calibrated spatial samples.');
    } catch (error) {
      context.notify(error instanceof Error ? error.message : 'Companion connection failed.');
    } finally {
      connecting = false;
      context.window.requestRender();
    }
  };

  return {
    render: (ctx, width, height) => {
      actions.length = 0;
      const settings = context.getSettings();
      const status = context.getCompanionStatus();
      const active = status.status === 'connected' || status.status === 'calibrated';
      const busy = connecting || status.status === 'pairing';

      ctx.fillStyle = '#9aacc4';
      ctx.font = '10px -apple-system, BlinkMacSystemFont, sans-serif';
      ctx.fillText('Optional local ARKit/LiDAR sensor • disabled by default • no cloud upload', 18, 26);

      actions.push(drawButton(ctx, 16, 38, 174, 36, settings.companionEnabled ? 'Disable companion' : 'Enable companion', () => {
        context.updateSettings({ companionEnabled: !settings.companionEnabled });
        if (settings.companionEnabled) context.disconnectCompanion();
      }, settings.companionEnabled, settings.companionEnabled ? '#d9fff2' : undefined));

      fillRoundedRect(ctx, 16, 86, width - 32, 126, 12, 'rgba(255,255,255,.045)');
      ctx.fillStyle = '#e8f2ff';
      ctx.font = '600 13px -apple-system, BlinkMacSystemFont, sans-serif';
      ctx.fillText(`Status: ${status.status}`, 30, 110);
      ctx.fillStyle = status.calibration.state === 'calibrated' ? '#78f0d0' : '#ffd28a';
      ctx.fillText(`Calibration: ${status.calibration.state} • ${Math.round(status.calibration.confidence * 100)}%`, 30, 132);
      ctx.fillStyle = '#9aacc4';
      ctx.font = '10px -apple-system, BlinkMacSystemFont, sans-serif';
      ctx.fillText(`Quality: ${status.quality} • protocol: ${status.compatibility.protocolVersion ?? 'not negotiated'}`, 30, 152);
      ctx.fillText(`Transport: trusted local WSS • HMAC-SHA256 • encryption: ${status.compatibility.encryption}`, 30, 172);
      ctx.fillText(`Frame: ${status.calibration.frame ?? 'not calibrated'} • depth: ${status.compatibility.depthEncodings.join(', ')}`, 30, 192);

      if (status.pairingCode) {
        fillRoundedRect(ctx, 16, 224, width - 32, 48, 12, 'rgba(181,148,255,.12)');
        ctx.fillStyle = '#f1eaff';
        ctx.font = '600 16px ui-monospace, SFMono-Regular, monospace';
        ctx.fillText(`Pairing code: ${status.pairingCode}`, 30, 254);
      }

      const detail = status.error ?? status.reconnect.reason ?? status.calibration.reason ?? 'Pairing requires explicit approval on this device.';
      ctx.fillStyle = status.error ? '#ff9da8' : '#9aacc4';
      ctx.font = '10px -apple-system, BlinkMacSystemFont, sans-serif';
      ctx.fillText(ellipsis(ctx, detail, width - 60), 30, status.pairingCode ? 294 : 244, width - 60);
      ctx.fillText(ellipsis(ctx, endpoint || 'No local endpoint entered', width - 60), 30, status.pairingCode ? 314 : 264, width - 60);

      const buttonY = height - 96;
      actions.push(drawButton(ctx, 16, buttonY, 150, 38, busy ? 'Pairing…' : active ? 'Re-pair' : 'Enter endpoint / pair', () => { void connect(); }, !settings.companionEnabled || busy, '#b694ff'));
      actions.push(drawButton(ctx, 176, buttonY, 126, 38, 'Disconnect', () => context.disconnectCompanion(), !active && status.status !== 'pairing', '#ff9da8'));
      actions.push(drawButton(ctx, 16, height - 50, 150, 38, settings.spatialMode === 'full' ? 'Full mode active' : 'Use full mode', () => context.updateSettings({ spatialMode: 'full' }), settings.spatialMode === 'full', '#78f0d0'));
      actions.push(drawButton(ctx, 176, height - 50, 150, 38, settings.spatialMode === 'camera' ? 'Camera fallback' : 'Camera mode', () => context.updateSettings({ spatialMode: 'camera' }), settings.spatialMode === 'camera', '#75e7ff'));
    },
    pointer: (x, y) => actionAt(actions, x, y),
    serialize: () => ({ endpoint }),
    restore: (value) => {
      if (value && typeof value === 'object' && 'endpoint' in value && typeof value.endpoint === 'string') endpoint = value.endpoint.slice(0, 512);
    },
  };
}
