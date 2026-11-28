import type { ApplicationContext, ApplicationInstance, EnvironmentId, ScanRecord, StoredFile, WindowState } from '../types';
import { deleteEnvironmentFile, deletePanorama, getPanoramaUrl, importPanorama, listCustomEnvironments } from '../core/environments';
import { storage } from '../core/storage';
import { getInterfacePalette, INTERFACE_PALETTES } from '../core/theme';
import { drawEmptyState, ellipsis, fillRoundedRect, roundedRect } from '../spatial/canvasUi';
import { WINDOW_CHROME_HEIGHT } from '../spatial/canvasUi';
import { actionAt, drawButton, formatBytes, type CanvasAction } from './ui';

const BROWSER_STATE_VERSION = 1;
const MAX_BROWSER_HISTORY = 50;
const MAX_BROWSER_URL_LENGTH = 2_048;
const SENSITIVE_URL_PARAMETERS = new Set([
  'key', 'apikey', 'privatekey', 'publickey', 'token', 'accesstoken', 'authtoken', 'refreshtoken',
  'idtoken', 'oauthtoken', 'sessiontoken', 'auth', 'authorization', 'password', 'passwd', 'secret',
  'clientsecret', 'appsecret', 'sharedsecret', 'session', 'sessionid', 'sid', 'state', 'code',
  'signature', 'credential', 'credentials', 'cookie', 'sessioncookie', 'csrf', 'xsrf',
]);

function isSensitiveUrlParameter(key: string): boolean {
  return SENSITIVE_URL_PARAMETERS.has(key.replace(/[^a-z0-9]/gi, '').toLowerCase());
}

function hasSensitiveUrlHash(url: URL): boolean {
  return url.hash.slice(1).split(/[?&]/).some((entry) => {
    const key = entry.split('=', 1)[0].split('/').pop() ?? '';
    return isSensitiveUrlParameter(key);
  });
}

interface BrowserSnapshot {
  schemaVersion: 1;
  url: string;
  history: string[];
  historyIndex: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function sanitizeBrowserUrl(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim() || value.length > MAX_BROWSER_URL_LENGTH * 4) return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    url.username = '';
    url.password = '';
    for (const key of [...url.searchParams.keys()]) {
      if (isSensitiveUrlParameter(key)) url.searchParams.delete(key);
    }
    if (hasSensitiveUrlHash(url)) url.hash = '';
    return url.toString().slice(0, MAX_BROWSER_URL_LENGTH);
  } catch {
    return null;
  }
}

function restoreBrowserSnapshot(value: unknown): BrowserSnapshot | null {
  if (!isRecord(value) || value.schemaVersion !== BROWSER_STATE_VERSION) return null;
  const rawHistory = Array.isArray(value.history) ? value.history.slice(-MAX_BROWSER_HISTORY) : [];
  const historyOffset = Array.isArray(value.history) ? Math.max(0, value.history.length - MAX_BROWSER_HISTORY) : 0;
  const entries = rawHistory.flatMap((entry, index) => {
    const url = sanitizeBrowserUrl(entry);
    return url ? [{ url, sourceIndex: historyOffset + index }] : [];
  });
  const requestedIndex = typeof value.historyIndex === 'number' && Number.isInteger(value.historyIndex) ? value.historyIndex : -1;
  let current = typeof value.url === 'string' && value.url.trim() ? sanitizeBrowserUrl(value.url) : null;
  if (typeof value.url === 'string' && !value.url.trim()) current = '';
  if (current === null && entries.length) {
    current = entries.find((entry) => entry.sourceIndex === requestedIndex)?.url ?? entries[entries.length - 1].url;
  }
  if (current === null) return null;
  if (!current) return { schemaVersion: 1, url: '', history: [], historyIndex: -1 };

  const history = entries.map((entry) => entry.url);
  let historyIndex = entries.findIndex((entry) => entry.sourceIndex === requestedIndex && entry.url === current);
  if (historyIndex < 0) historyIndex = history.indexOf(current);
  if (historyIndex < 0) {
    history.push(current);
    historyIndex = history.length - 1;
  }
  return { schemaVersion: 1, url: current, history, historyIndex };
}

export function normalizeUrl(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  try {
    const explicitProtocol = /^https?:\/\//i.test(trimmed);
    const url = new URL(explicitProtocol ? trimmed : `https://${trimmed}`);
    if (!explicitProtocol && /^(?:localhost|127(?:\.\d+){3}|\[[0-9a-f:]+\])$/i.test(url.hostname)) url.protocol = 'http:';
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}

export function normalizeBrowserInput(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  if (/^https?:\/\//i.test(trimmed)) return normalizeUrl(trimmed);
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed) && !/^(?:localhost|127(?:\.\d+){3}|\[[0-9a-f:]+\])(?::\d+)?(?:[/?#]|$)/i.test(trimmed)) return null;
  const looksLikeAddress = /^(?:localhost|127(?:\.\d+){3}|\[[0-9a-f:]+\])(?::\d+)?(?:[/?#]|$)/i.test(trimmed)
    || /^[^\s/]+\.[^\s/]+(?:[/?#]|$)/.test(trimmed);
  return looksLikeAddress ? normalizeUrl(trimmed) : `https://www.google.com/search?q=${encodeURIComponent(trimmed)}`;
}

export function createBrowserApp(context: ApplicationContext, initialUrl?: string): ApplicationInstance {
  const iframe = document.createElement('iframe');
  iframe.title = 'Spatial browser content';
  iframe.setAttribute('sandbox', 'allow-scripts allow-forms allow-popups');
  iframe.setAttribute('referrerpolicy', 'no-referrer');
  iframe.src = 'about:blank';
  iframe.style.visibility = 'hidden';
  context.window.setOverlay(iframe, { x: 12, y: WINDOW_CHROME_HEIGHT, width: 1000, height: 640 - WINDOW_CHROME_HEIGHT });
  const actions: CanvasAction[] = [];
  let url = '';
  let input = '';
  let status = 'Enter a website to begin';
  let loading = false;
  let loadTimer: ReturnType<typeof setTimeout> | undefined;
  const history: string[] = [];
  let historyIndex = -1;

  const editUrl = (): void => {
    void (context.isVrActive()
      ? context.requestText({ title: 'Website or search', value: input || url, placeholder: 'Enter an address or search terms', submitLabel: 'Open' })
      : context.requestUrl(input || url))
      .then((value) => { if (value !== null) load(value); })
      .catch((error: unknown) => context.notify(error instanceof Error ? error.message : 'Could not open address.'));
  };

  const load = (value: string, fromHistory = false): void => {
    const normalized = normalizeBrowserInput(value);
    if (!normalized) {
      status = 'Enter a valid address or supported http/https URL';
      context.window.requestRender();
      return;
    }
    if (!fromHistory && normalized !== url) {
      history.splice(historyIndex + 1);
      history.push(normalized);
      historyIndex = history.length - 1;
    }
    url = normalized;
    input = normalized;
    loading = true;
    status = 'Loading… some websites block embedded viewing';
    iframe.style.visibility = 'visible';
    iframe.src = normalized;
    if (loadTimer) globalThis.clearTimeout(loadTimer);
    loadTimer = globalThis.setTimeout(() => {
      loading = false;
      status = 'If this page is blank, the site may block embedding. Open it externally.';
      context.window.requestRender();
    }, 6500);
    context.window.requestRender();
  };

  const go = (direction: -1 | 1): void => {
    const next = historyIndex + direction;
    if (next < 0 || next >= history.length) {
      status = direction < 0 ? 'No earlier page in this session' : 'No later page in this session';
      context.window.requestRender();
      return;
    }
    historyIndex = next;
    load(history[next], true);
  };

  iframe.addEventListener('load', () => {
    if (loadTimer) globalThis.clearTimeout(loadTimer);
    loading = false;
    status = context.isVrActive()
      ? 'Stereo iframe pixels are blocked by browsers. Use Open externally or exit VR.'
      : url ? 'Embedded page loaded. A blank page may block framing.' : 'Ready';
    context.window.requestRender();
  });

  if (initialUrl) load(initialUrl);

  return {
    render: (ctx, width, height) => {
      actions.length = 0;
      iframe.style.visibility = url && !context.isVrActive() ? 'visible' : 'hidden';
      iframe.style.opacity = String(0.98 - context.getSettings().glassTransparency * 0.48);
      fillRoundedRect(ctx, 14, 14, width - 338, 43, 12, 'rgba(255,255,255,.05)');
      ctx.fillStyle = '#dce7f7';
      ctx.font = '12px -apple-system, BlinkMacSystemFont, sans-serif';
      ctx.fillText(ellipsis(ctx, input || url || 'Search or enter an address', width - 360), 30, 41, width - 360);
      actions.push(drawButton(ctx, width - 312, 20, 48, 31, '←', () => go(-1), historyIndex > 0));
      actions.push(drawButton(ctx, width - 258, 20, 48, 31, '→', () => go(1), historyIndex >= 0 && historyIndex < history.length - 1));
      actions.push(drawButton(ctx, width - 204, 20, 54, 31, '↻', () => { if (url) load(url, true); }));
      actions.push(drawButton(ctx, width - 144, 20, 54, 31, '⌂', () => load('https://www.google.com/')));
      actions.push(drawButton(ctx, width - 84, 20, 68, 31, '↗', () => {
        if (!url) return;
        globalThis.open(url, '_blank', 'noopener,noreferrer');
      }));
      ctx.fillStyle = loading ? '#75e7ff' : '#9aacc4';
      ctx.font = '10px -apple-system, BlinkMacSystemFont, sans-serif';
      ctx.fillText(ellipsis(ctx, status, width - 40), 20, 78, width - 40);
      if (!url || context.isVrActive()) {
        drawEmptyState(ctx, width, height - 50, context.isVrActive() ? 'Spatial browser controls' : 'Spatial browser', context.isVrActive()
          ? 'Browsers protect cross-origin iframe pixels. Navigate with these controls or open the page in Safari.'
          : 'Websites that permit embedding open here. Others can open in Safari.');
      }
    },
    pointer: (x, y) => {
      if (actionAt(actions, x, y)) return true;
      const width = context.window.canvas.width;
      if (y >= 14 && y <= 57 && x >= 20 && x <= width - 330) {
        editUrl();
        return true;
      }
      return false;
    },
    openKeyboard: editUrl,
    serialize: (): BrowserSnapshot => {
      const historyOffset = Math.max(0, history.length - MAX_BROWSER_HISTORY);
      const entries = history.slice(historyOffset).flatMap((entry, index) => {
        const savedUrl = sanitizeBrowserUrl(entry);
        return savedUrl ? [{ url: savedUrl, sourceIndex: historyOffset + index }] : [];
      });
      const savedUrl = sanitizeBrowserUrl(url);
      let savedHistoryIndex = entries.findIndex((entry) => entry.sourceIndex === historyIndex);
      if (savedUrl && !entries.some((entry) => entry.url === savedUrl)) {
        entries.push({ url: savedUrl, sourceIndex: historyIndex });
        savedHistoryIndex = entries.length - 1;
      }
      if (savedHistoryIndex < 0 && savedUrl) savedHistoryIndex = Math.max(0, entries.length - 1);
      return {
        schemaVersion: 1,
        url: savedUrl ?? '',
        history: entries.map((entry) => entry.url),
        historyIndex: savedHistoryIndex,
      };
    },
    restore: (value: unknown) => {
      const snapshot = restoreBrowserSnapshot(value);
      if (!snapshot) return;
      history.length = 0;
      history.push(...snapshot.history);
      historyIndex = snapshot.historyIndex;
      if (!snapshot.url) {
        if (loadTimer) globalThis.clearTimeout(loadTimer);
        loadTimer = undefined;
        url = '';
        input = '';
        loading = false;
        status = 'Enter a website to begin';
        iframe.style.visibility = 'hidden';
        iframe.src = 'about:blank';
        context.window.requestRender();
        return;
      }
      load(snapshot.url, true);
    },
    destroy: () => {
      if (loadTimer) globalThis.clearTimeout(loadTimer);
      iframe.src = 'about:blank';
      context.window.setOverlay(null);
    },
  };
}

type FileEntry =
  | { kind: 'file'; key: string; file: StoredFile }
  | { kind: 'scan'; key: string; scan: ScanRecord };

export function createFilesApp(context: ApplicationContext): ApplicationInstance {
  const actions: CanvasAction[] = [];
  const rows: Array<{ x: number; y: number; width: number; height: number; entry: FileEntry }> = [];
  let entries: FileEntry[] = [];
  let tab: 'all' | 'scans' = 'all';
  let loading = true;

  const refresh = async (): Promise<void> => {
    loading = true;
    try {
      const [files, records] = await Promise.all([storage.listFiles(), storage.list<ScanRecord>()]);
      entries = [
        ...files.map((file): FileEntry => ({ kind: 'file', key: file.id, file })),
        ...records.filter((record) => record.key.startsWith('scan:') && record.value?.method === 'feature-tracked-rgb-estimate').map((record): FileEntry => ({ kind: 'scan', key: record.key, scan: record.value })),
      ].sort((a, b) => (b.kind === 'file' ? b.file.createdAt : b.scan.createdAt) - (a.kind === 'file' ? a.file.createdAt : a.scan.createdAt));
    } catch (error) {
      context.notify(error instanceof Error ? error.message : 'Could not read local files.');
    } finally {
      loading = false;
      context.window.requestRender();
    }
  };
  void refresh();

  const download = (entry: FileEntry): void => {
    const blob = entry.kind === 'file' ? entry.file.blob : new Blob([JSON.stringify(entry.scan, null, 2)], { type: 'application/json' });
    const name = entry.kind === 'file' ? entry.file.name : `${entry.scan.name}.json`;
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = name;
    anchor.click();
    globalThis.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  return {
    render: (ctx, width, height) => {
      actions.length = 0;
      rows.length = 0;
      actions.push(drawButton(ctx, 16, 12, 92, 34, 'All files', () => { tab = 'all'; void refresh(); }, tab === 'all'));
      actions.push(drawButton(ctx, 120, 12, 92, 34, 'Scans', () => { tab = 'scans'; void refresh(); }, tab === 'scans'));
      actions.push(drawButton(ctx, width - 106, 12, 90, 34, 'Refresh', () => void refresh()));
      ctx.fillStyle = 'rgba(220,231,247,.55)';
      ctx.font = '10px -apple-system, BlinkMacSystemFont, sans-serif';
      ctx.textAlign = 'right';
      ctx.fillText(`${entries.length} local records`, width - 18, 68);
      ctx.textAlign = 'left';
      const visible = entries.filter((entry) => tab === 'all' || entry.kind === 'scan');
      if (!visible.length) {
        drawEmptyState(ctx, width, height - 30, loading ? 'Loading files' : 'No local records', loading ? 'Reading IndexedDB…' : 'Import media or save a scan to see it here.');
        return;
      }
      const rowHeight = 58;
      visible.forEach((entry, index) => {
        const y = 62 + index * rowHeight;
        if (y + rowHeight > height - 8) return;
        rows.push({ x: 16, y, width: width - 32, height: rowHeight - 6, entry });
        fillRoundedRect(ctx, 16, y, width - 32, rowHeight - 6, 11, 'rgba(255,255,255,.04)');
        const isScan = entry.kind === 'scan';
        const name = isScan ? entry.scan.name : entry.file.name;
        const detail = isScan ? `${entry.scan.pointCount.toLocaleString()} estimated points • ${new Date(entry.scan.createdAt).toLocaleString()}` : `${formatBytes(entry.file.size)} • ${new Date(entry.file.createdAt).toLocaleDateString()}`;
        ctx.fillStyle = isScan ? '#75e7ff' : '#b694ff';
        ctx.font = '600 17px -apple-system, BlinkMacSystemFont, sans-serif';
        ctx.fillText(isScan ? '◈' : '▤', 30, y + 24);
        ctx.fillStyle = '#e8f2ff';
        ctx.font = '600 11px -apple-system, BlinkMacSystemFont, sans-serif';
        ctx.fillText(ellipsis(ctx, name, width - 300), 58, y + 21, width - 300);
        ctx.fillStyle = '#9aacc4';
        ctx.font = '9px -apple-system, BlinkMacSystemFont, sans-serif';
        ctx.fillText(ellipsis(ctx, detail, width - 300), 58, y + 38, width - 300);
        actions.push(drawButton(ctx, width - 224, y + 9, 62, 34, 'Save', () => download(entry)));
        if (isScan) actions.push(drawButton(ctx, width - 154, y + 9, 62, 34, 'View', () => context.showScan(entry.scan)));
        actions.push(drawButton(ctx, width - 84, y + 9, 62, 34, 'Delete', () => {
          void context.requestConfirm(`Delete ${name} from this device?`).then(async (confirmed) => {
            if (!confirmed) return;
            if (entry.kind === 'file') {
              const removedEnvironment = await deleteEnvironmentFile(entry.file.id);
              if (removedEnvironment && context.getSettings().environment === removedEnvironment) context.setEnvironment('loft');
            } else await storage.remove(entry.key);
            await refresh();
          }).catch((error: unknown) => context.notify(error instanceof Error ? error.message : 'Could not delete local record.'));
        }, false, '#ff8f9d'));
      });
    },
    pointer: (x, y) => actionAt(actions, x, y),
  };
}

export function createSettingsApp(context: ApplicationContext): ApplicationInstance {
  const actions: CanvasAction[] = [];
  let page = 0;
  return {
    render: (ctx, width, height) => {
      actions.length = 0;
      const settings = context.getSettings();
      const rows = [
        { label: 'Interface palette', value: getInterfacePalette(settings.palette).name, action: () => {
          const index = INTERFACE_PALETTES.findIndex((palette) => palette.id === settings.palette);
          context.updateSettings({ palette: INTERFACE_PALETTES[(index + 1) % INTERFACE_PALETTES.length].id });
        } },
        { label: 'Motion sensitivity', value: settings.motionSensitivity.toFixed(2), action: () => context.updateSettings({ motionSensitivity: settings.motionSensitivity >= 1.95 ? 0.5 : settings.motionSensitivity + 0.25 }) },
        { label: 'Glass transparency', value: `${Math.round(settings.glassTransparency * 100)}%`, action: () => context.updateSettings({ glassTransparency: settings.glassTransparency >= 0.95 ? 0.4 : settings.glassTransparency + 0.1 }) },
        { label: 'Glass blur', value: `${settings.glassBlur} px`, action: () => context.updateSettings({ glassBlur: settings.glassBlur >= 40 ? 0 : settings.glassBlur + 5 }) },
        { label: 'Default window scale', value: `${Math.round(settings.defaultWindowScale * 100)}%`, action: () => context.updateSettings({ defaultWindowScale: settings.defaultWindowScale >= 1.3 ? 0.7 : settings.defaultWindowScale + 0.1 }) },
        { label: 'Render quality', value: settings.quality, action: () => context.updateSettings({ quality: settings.quality === 'auto' ? 'high' : settings.quality === 'high' ? 'low' : 'auto' }) },
        { label: 'Default window anchoring', value: settings.headLockDefault ? 'Head-locked' : 'World-locked', action: () => context.updateSettings({ headLockDefault: !settings.headLockDefault }) },
        { label: 'Environment exposure', value: settings.environmentExposure.toFixed(2), action: () => context.updateSettings({ environmentExposure: settings.environmentExposure >= 1.6 ? 0.6 : settings.environmentExposure + 0.1 }) },
        { label: 'Hand smoothing', value: settings.handSmoothing.toFixed(2), action: () => context.updateSettings({ handSmoothing: settings.handSmoothing >= 0.75 ? 0 : settings.handSmoothing + 0.15 }) },
        { label: 'Hand activation delay', value: `${settings.dwellTime.toFixed(1)} s`, action: () => context.updateSettings({ dwellTime: settings.dwellTime >= 1.6 ? 0.4 : settings.dwellTime + 0.1 }) },
        { label: 'Cardboard eye separation', value: `${settings.ipd} mm`, action: () => context.updateSettings({ ipd: settings.ipd >= 78 ? 52 : settings.ipd + 2 }) },
        { label: 'Virtual screen distance', value: `${settings.vrDistance.toFixed(1)} m`, action: () => context.updateSettings({ vrDistance: settings.vrDistance >= 11 ? 3.5 : settings.vrDistance + 0.5 }) },
        { label: 'Field of view', value: `${settings.fov}°`, action: () => context.updateSettings({ fov: settings.fov >= 100 ? 50 : settings.fov + 5 }) },
        { label: 'Lens correction', value: settings.distortion.toFixed(2), action: () => context.updateSettings({ distortion: settings.distortion >= 0.28 ? 0 : settings.distortion + 0.04 }) },
        { label: 'Spatial analysis', value: settings.spatialMode, action: () => {
          const modes = ['off', 'economy', 'camera', 'full'] as const;
          context.updateSettings({ spatialMode: modes[(modes.indexOf(settings.spatialMode) + 1) % modes.length] });
        } },
        { label: 'Observed environment map', value: settings.showEnvironmentMap ? 'Visible' : 'Hidden', action: () => context.updateSettings({ showEnvironmentMap: !settings.showEnvironmentMap }) },
        { label: 'Spatial keyboard layout', value: settings.keyboardLayout === 'azerty' ? 'French AZERTY' : 'QWERTY', action: () => context.updateSettings({ keyboardLayout: settings.keyboardLayout === 'azerty' ? 'qwerty' : 'azerty' }) },
        { label: 'VR taskbar positioning', value: settings.taskbarMode === 'follow' ? 'Follow head' : 'World anchored', action: () => context.updateSettings({ taskbarMode: settings.taskbarMode === 'follow' ? 'world' : 'follow' }) },
        { label: 'Controlled window inertia', value: settings.windowInertia ? 'Enabled' : 'Disabled', action: () => context.updateSettings({ windowInertia: !settings.windowInertia }) },
        { label: 'Window snapping', value: settings.windowSnapping ? 'Enabled' : 'Disabled', action: () => context.updateSettings({ windowSnapping: !settings.windowSnapping }) },
        { label: 'Interface sounds', value: settings.uiSoundEnabled ? 'Enabled' : 'Disabled', action: () => context.updateSettings({ uiSoundEnabled: !settings.uiSoundEnabled }) },
        { label: 'Sound volume', value: `${Math.round(settings.uiSoundVolume * 100)}%`, action: () => context.updateSettings({ uiSoundVolume: settings.uiSoundVolume >= 0.95 ? 0.1 : Math.min(1, settings.uiSoundVolume + 0.1) }) },
        { label: 'Bluetooth & gamepad', value: context.getDeviceStatus?.() ?? 'Detect controllers', action: () => { void context.requestDeviceAccess?.(); } },
        { label: 'External LiDAR companion', value: settings.companionEnabled ? 'Enabled' : 'Disabled', action: () => context.updateSettings({ companionEnabled: !settings.companionEnabled }) },
      ];
      const pageSize = 6;
      const pages = Math.ceil(rows.length / pageSize);
      page = Math.min(page, pages - 1);
      ctx.fillStyle = '#9aacc4';
      ctx.font = '10px -apple-system, BlinkMacSystemFont, sans-serif';
      ctx.fillText('Interface, spatial analysis, windows, hands and Cardboard • saved locally', 18, 28);
      rows.slice(page * pageSize, (page + 1) * pageSize).forEach((row, index) => {
        const y = 44 + index * 70;
        fillRoundedRect(ctx, 16, y, width - 32, 58, 12, 'rgba(255,255,255,.045)');
        ctx.fillStyle = '#dce7f7';
        ctx.font = '600 12px -apple-system, BlinkMacSystemFont, sans-serif';
        ctx.fillText(row.label, 30, y + 23);
        ctx.fillStyle = '#e8f5f5';
        ctx.font = '10px -apple-system, BlinkMacSystemFont, sans-serif';
        ctx.fillText(row.value, 30, y + 42);
        actions.push(drawButton(ctx, width - 142, y + 12, 112, 34, 'Adjust', row.action));
      });
      actions.push(drawButton(ctx, 16, height - 52, 190, 38, 'Recalibrate orientation', () => context.recalibrate()));
      actions.push(drawButton(ctx, width - 218, height - 52, 94, 38, 'Previous', () => { page = Math.max(0, page - 1); }, page === 0));
      actions.push(drawButton(ctx, width - 112, height - 52, 96, 38, `Next ${page + 1}/${pages}`, () => { page = Math.min(pages - 1, page + 1); }));
    },
    pointer: (x, y) => actionAt(actions, x, y),
  };
}

const ENVIRONMENTS: Array<{ id: EnvironmentId; name: string; detail: string; colors: [string, string]; image?: string }> = [
  { id: 'venice', name: 'Venice 360', detail: 'Panoramic canal and waterfront.', colors: ['#42535e', '#e7f5ff'], image: `${import.meta.env.BASE_URL}environments/venice-360.jpg` },
  { id: 'loft', name: 'Loft 360', detail: 'Immersive living room.', colors: ['#55534f', '#f4e9db'], image: `${import.meta.env.BASE_URL}environments/loft-360.jpg` },
  { id: 'camera', name: 'Camera passthrough', detail: 'Mirrored live rear-camera space.', colors: ['#3a4449', '#d9fff2'] },
];

type EnvironmentEntry = {
  id: string;
  name: string;
  detail: string;
  colors: [string, string];
  image?: string;
  custom: boolean;
  gallery?: boolean;
};

export function createEnvironmentsApp(context: ApplicationContext): ApplicationInstance {
  const actions: CanvasAction[] = [];
  const images = new Map<string, HTMLImageElement>();
  let page = 0;

  const entries = (): EnvironmentEntry[] => [
    { id: 'gallery', name: 'Gallery 360', detail: 'Open Photos and choose a 360 panorama.', colors: ['#5b4a86', '#e9ddff'], custom: false, gallery: true },
    ...ENVIRONMENTS.map((environment) => ({ ...environment, custom: false })),
    ...listCustomEnvironments().map((environment) => ({
      id: environment.id,
      name: environment.name,
      detail: `${environment.width}×${environment.height} • local 360 panorama`,
      colors: ['#454b50', '#e8f1f5'] as [string, string],
      image: getPanoramaUrl(environment.id),
      custom: true,
    })),
  ];

  const ensureImage = (entry: { id: string; image?: string }): HTMLImageElement | undefined => {
    if (!entry.image) return undefined;
    const existing = images.get(entry.id);
    if (existing) return existing;
    const image = new Image();
    image.onload = () => context.window.requestRender();
    image.src = entry.image;
    images.set(entry.id, image);
    return image;
  };

  const importFromGallery = (pageSize: number): void => {
    void context.pickFiles('image/jpeg,image/png,image/webp', false).then(async (files) => {
      if (!files[0]) return;
      try {
        const record = await importPanorama(files[0]);
        page = Math.floor(entries().length / pageSize);
        context.setEnvironment(record.id);
        context.notify(`${record.name} imported and activated.`);
      } catch (error) {
        context.notify(error instanceof Error ? error.message : 'Could not import panorama.');
      }
    }).catch((error: unknown) => context.notify(error instanceof Error ? error.message : 'Could not import panorama.'));
  };

  return {
    render: (ctx, width, height) => {
      actions.length = 0;
      const settings = context.getSettings();
      const all = entries();
      const pageSize = width > 680 ? 4 : 3;
      const pages = Math.max(1, Math.ceil(all.length / pageSize));
      page = Math.min(page, pages - 1);
      const visible = all.slice(page * pageSize, (page + 1) * pageSize);
      actions.push(drawButton(ctx, 16, 12, 148, 36, 'Import 360 image', () => importFromGallery(pageSize)));
      ctx.fillStyle = 'rgba(220,231,247,.62)';
      ctx.font = '10px -apple-system, BlinkMacSystemFont, sans-serif';
      ctx.fillText(`${Math.max(0, all.length - 1)} environment${all.length === 2 ? '' : 's'} • Gallery imports 2:1 panoramas`, 180, 34);
      if (pages > 1) {
        actions.push(drawButton(ctx, width - 218, 12, 94, 36, 'Previous', () => { page = Math.max(0, page - 1); }, page === 0));
        actions.push(drawButton(ctx, width - 112, 12, 96, 36, `Next ${page + 1}/${pages}`, () => { page = Math.min(pages - 1, page + 1); }));
      }
      const columns = width > 680 ? 2 : 1;
      const rows = Math.max(1, Math.ceil(visible.length / columns));
      const cardWidth = (width - 32 - (columns - 1) * 14) / columns;
      const cardHeight = Math.min(174, (height - 72 - (rows - 1) * 12) / rows);
      visible.forEach((environment, index) => {
        const column = index % columns;
        const row = Math.floor(index / columns);
        const x = 16 + column * (cardWidth + 14);
        const y = 60 + row * (cardHeight + 12);
        ctx.save();
        roundedRect(ctx, x, y, cardWidth, cardHeight, 16);
        ctx.clip();
        const gradient = ctx.createLinearGradient(x, y, x + cardWidth, y + cardHeight);
        gradient.addColorStop(0, environment.colors[0]);
        gradient.addColorStop(1, '#101418');
        ctx.fillStyle = gradient;
        ctx.fillRect(x, y, cardWidth, cardHeight);
        const image = ensureImage(environment);
        if (environment.gallery) {
          ctx.fillStyle = 'rgba(255,255,255,.16)';
          ctx.font = '600 64px -apple-system, BlinkMacSystemFont, sans-serif';
          ctx.textAlign = 'center';
          ctx.fillText('▧', x + cardWidth / 2, y + cardHeight * 0.56);
          ctx.textAlign = 'left';
        } else if (image?.complete && image.naturalWidth) {
          const scale = Math.max(cardWidth / image.naturalWidth, cardHeight / image.naturalHeight);
          const sourceWidth = cardWidth / scale;
          const sourceHeight = cardHeight / scale;
          ctx.drawImage(image, (image.naturalWidth - sourceWidth) / 2, (image.naturalHeight - sourceHeight) / 2, sourceWidth, sourceHeight, x, y, cardWidth, cardHeight);
        }
        const shade = ctx.createLinearGradient(0, y, 0, y + cardHeight);
        shade.addColorStop(0, 'rgba(3,9,17,.04)');
        shade.addColorStop(0.5, 'rgba(3,9,17,.34)');
        shade.addColorStop(1, 'rgba(3,9,17,.88)');
        ctx.fillStyle = shade;
        ctx.fillRect(x, y, cardWidth, cardHeight);
        ctx.restore();
        roundedRect(ctx, x, y, cardWidth, cardHeight, 16);
        ctx.strokeStyle = settings.environment === environment.id ? environment.colors[1] : 'rgba(255,255,255,.18)';
        ctx.lineWidth = settings.environment === environment.id ? 2 : 1;
        ctx.stroke();
        ctx.fillStyle = '#f4f8ff';
        ctx.font = '600 16px -apple-system, BlinkMacSystemFont, sans-serif';
        ctx.fillText(ellipsis(ctx, environment.name, cardWidth - 36), x + 18, y + 32, cardWidth - 36);
        ctx.fillStyle = 'rgba(220,231,247,.76)';
        ctx.font = '10px -apple-system, BlinkMacSystemFont, sans-serif';
        ctx.fillText(ellipsis(ctx, environment.detail, cardWidth - 36), x + 18, y + 51, cardWidth - 36);
        if (environment.gallery) {
          actions.push(drawButton(ctx, x + 16, y + cardHeight - 46, cardWidth - 32, 32, 'Open gallery', () => importFromGallery(pageSize), false, environment.colors[1]));
          return;
        }
        actions.push(drawButton(ctx, x + 16, y + cardHeight - 46, environment.custom ? cardWidth - 122 : cardWidth - 32, 32, settings.environment === environment.id ? 'Active environment' : 'Enter environment', () => context.setEnvironment(environment.id as EnvironmentId), settings.environment === environment.id, environment.colors[1]));
        if (environment.custom) actions.push(drawButton(ctx, x + cardWidth - 94, y + cardHeight - 46, 78, 32, 'Delete', () => {
          void context.requestConfirm(`Delete ${environment.name} from this device?`).then(async (confirmed) => {
            if (!confirmed) return;
            if (settings.environment === environment.id) context.setEnvironment('loft');
            await deletePanorama(environment.id as EnvironmentId);
            images.delete(environment.id);
          }).catch((error: unknown) => context.notify(error instanceof Error ? error.message : 'Could not delete panorama.'));
        }, false, '#ff9da8'));
      });
    },
    pointer: (x, y) => actionAt(actions, x, y),
  };
}

export function createWindowManagerApp(context: ApplicationContext): ApplicationInstance {
  const actions: CanvasAction[] = [];
  return {
    render: (ctx, width, height) => {
      actions.length = 0;
      const windows = context.listWindows();
      ctx.fillStyle = '#9aacc4';
      ctx.font = '10px -apple-system, BlinkMacSystemFont, sans-serif';
      ctx.fillText(`${windows.length} spatial window${windows.length === 1 ? '' : 's'} • positions save automatically`, 18, 28);
      if (!windows.length) {
        drawEmptyState(ctx, width, height - 20, 'No open windows', 'Open an app from the launcher to begin.');
        return;
      }
      const focused = [...windows].sort((a, b) => b.z - a.z)[0];
      actions.push(drawButton(ctx, width - 204, 8, 188, 28, 'Arrange around me', () => context.arrangeWindows()));
      actions.push(drawButton(ctx, width - 408, 8, 188, 28, focused?.anchor ? 'Unanchor focused' : 'Anchor focused', () => {
        if (focused) context.toggleWindowAnchor(focused.id);
      }, focused?.anchor !== undefined));
      windows.forEach((window: WindowState, index) => {
        const y = 48 + index * 70;
        if (y + 64 > height - 8) return;
        fillRoundedRect(ctx, 16, y, width - 32, 62, 12, window.minimized ? 'rgba(255,255,255,.025)' : 'rgba(255,255,255,.045)');
        ctx.fillStyle = window.minimized ? '#75859b' : '#75e7ff';
        ctx.font = '600 16px -apple-system, BlinkMacSystemFont, sans-serif';
        ctx.fillText('▣', 30, y + 24);
        ctx.fillStyle = '#e8f2ff';
        ctx.font = '600 11px -apple-system, BlinkMacSystemFont, sans-serif';
        ctx.fillText(ellipsis(ctx, window.title, width - 500), 56, y + 22, width - 500);
        ctx.fillStyle = '#9aacc4';
        ctx.font = '9px -apple-system, BlinkMacSystemFont, sans-serif';
        const positioning = window.anchor ? `${window.anchorKind ?? 'world'} anchor` : window.mode;
        ctx.fillText(`${positioning} • z ${window.position.z.toFixed(1)}${window.minimized ? ' • minimized' : ''}`, 56, y + 39, width - 500);
        actions.push(drawButton(ctx, width - 430, y + 14, 62, 34, window.anchor ? 'Release' : 'Anchor', () => context.toggleWindowAnchor(window.id), window.anchor !== undefined, '#d9fff2'));
        actions.push(drawButton(ctx, width - 362, y + 14, 62, 34, 'Near', () => context.moveWindowDepth(window.id, 0.5)));
        actions.push(drawButton(ctx, width - 226, y + 14, 62, 34, 'Far', () => context.moveWindowDepth(window.id, -0.5)));
        actions.push(drawButton(ctx, width - 158, y + 14, 62, 34, 'Focus', () => context.focusWindow(window.id)));
        actions.push(drawButton(ctx, width - 90, y + 14, 62, 34, 'Close', () => context.closeWindow(window.id), false, '#ff9da8'));
      });
    },
    pointer: (x, y) => actionAt(actions, x, y),
  };
}
