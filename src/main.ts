import './styles.css';
import { APPLICATIONS, getApplication } from './applications/registry';
import { ai, type ChatMessage } from './core/ai';
import { RearCamera } from './core/camera';
import { deviceStatusText, inspectDevices, requestBluetoothDevice } from './core/deviceCapabilities';
import { getPanoramaUrl, initializePanoramaLibrary } from './core/environments';
import { MotionController } from './core/motion';
import { loadSettings, loadWindowRecords, saveSettings, saveWindowRecords, sanitizeSettings } from './core/settings';
import { storage } from './core/storage';
import { applyInterfacePalette, getInterfacePalette, INTERFACE_PALETTES } from './core/theme';
import { uiSound, type UiSoundName } from './core/uiSound';
import type { GamepadCommand, GamepadControl } from './input/gamepad';
import { UniversalKeyboardManager } from './input/keyboardManager';
import { SpatialScene } from './spatial/scene';
import { ArmTracker } from './tracking/armTracking';
import { HandOverlay } from './tracking/handOverlay';
import { HandTracker } from './tracking/handTracking';
import type { AppSettings, HandVisualPoint, StoredFile, TextRequestOptions, WindowState } from './types';
import type { SpatialCapabilities } from './spatial/intelligence/types';

function element<T extends HTMLElement>(id: string): T {
  const result = document.getElementById(id);
  if (!result) throw new Error(`Missing interface element: ${id}`);
  return result as T;
}

const canvas = element<HTMLCanvasElement>('spatial-canvas');
const launcher = element('launcher');
const settingsPanel = element('settings-panel');
const utilityPanel = element('utility-panel');
const utilityContent = element('utility-content');
const emptyState = element('window-empty');
const toastElement = element('toast');
const modalBackdrop = element('modal-backdrop');
const modalContent = element('modal-content');
const modalTitle = element('modal-title');
const gazeReticle = element('gaze-reticle');
const gazeProgress = element('gaze-progress');
const handCursor = element('hand-cursor');
const handOverlay = new HandOverlay(element<HTMLCanvasElement>('hand-layer'));
const handsButton = element<HTMLButtonElement>('hands-button');
let settings = loadSettings();
uiSound.configure(settings);
applyInterfacePalette(settings.palette);
let toastTimer: ReturnType<typeof setTimeout> | undefined;
let vrActive = false;
let handsActive = false;
let handsBusy = false;
let handCameraOwned = false;
let spatialCameraOwned = false;
let spatialModeGeneration = 0;
let environmentCameraOwned = false;
let manualCameraOwned = false;
let deviceBusy = false;
let selectedBluetoothName: string | null = null;
let modalResolver: ((value: string | boolean | null) => void) | null = null;
let utilityMode: 'library' | 'ai' | null = null;
let utilityRender: (() => void) | null = null;
let aiAbort: AbortController | null = null;
const aiHistory: ChatMessage[] = [];
const universalKeyboard = new UniversalKeyboardManager({
  getLayout: () => settings.keyboardLayout,
  getTransparency: () => settings.glassTransparency,
  getAccent: () => getInterfacePalette(settings.palette).accent,
  isVrActive: () => vrActive,
  notify,
});

interface HandFrame {
  x: number;
  y: number;
  pinching: boolean;
  progress: number;
  cursor: boolean;
  landmarks: HandVisualPoint[];
  arms: HandVisualPoint[];
}

function notify(message: string): void {
  if (vrActive) scene.showSpatialNotification(message);
  toastElement.textContent = message;
  toastElement.classList.add('show');
  if (toastTimer) globalThis.clearTimeout(toastTimer);
  toastTimer = globalThis.setTimeout(() => toastElement.classList.remove('show'), 3600);
}

function setStatus(id: string, text: string, error = false): void {
  const pill = element(id);
  pill.classList.toggle('muted', !error && /off|touch|unavailable/i.test(text));
  pill.classList.toggle('error', error);
  const label = pill.querySelector('span');
  if (label) label.textContent = text;
}

function syncHandControls(active: boolean): void {
  handsActive = active;
  document.body.classList.toggle('hands-on', active);
  handsButton.classList.toggle('active', active);
  handsButton.setAttribute('aria-pressed', String(active));
  handsButton.setAttribute('aria-label', active ? 'Disable hand controls' : 'Enable hand controls');
  handsButton.title = active ? 'Disable hand controls' : 'Enable hand controls';
  if (!active) {
    handCursor.classList.add('hidden');
    handCursor.classList.remove('pinching');
    handOverlay.clear();
  }
}

function updateHandFrame(frame: HandFrame | null): void {
  if (!frame || vrActive) {
    handCursor.classList.add('hidden');
    handCursor.classList.remove('pinching');
    handOverlay.clear();
    return;
  }
  handOverlay.draw(frame.landmarks, frame.arms, frame.pinching);
  handCursor.classList.toggle('hidden', !frame.cursor);
  handCursor.classList.toggle('pinching', frame.pinching);
  handCursor.style.left = `${frame.x}px`;
  handCursor.style.top = `${frame.y}px`;
  handCursor.style.setProperty('--hand-progress', `${frame.progress * 360}deg`);
}

function activateDomElement(x: number, y: number): boolean {
  const target = document.elementFromPoint(x, y);
  if (!(target instanceof Element) || target === handCursor || target.id === 'spatial-canvas') return false;
  if (target.closest('iframe, .orientation-warning, .boot-screen')) return true;
  const label = target.closest('label');
  const control = target.closest<HTMLElement>('button, input, textarea, select, a, [role="button"], [contenteditable="true"]') ?? label?.querySelector<HTMLElement>('input, textarea, select');
  if (!control) return Boolean(target.closest('.topbar, .dock, #launcher, #settings-panel, #modal-backdrop'));
  if (control.matches(':disabled')) return true;
  if (control instanceof HTMLInputElement && control.type === 'range') {
    const bounds = control.getBoundingClientRect();
    const direction = x < bounds.left + bounds.width / 2 ? -1 : 1;
    const step = Number(control.step) || 1;
    const next = Math.min(Number(control.max), Math.max(Number(control.min), Number(control.value) + step * direction));
    control.value = String(next);
    control.dispatchEvent(new Event('input', { bubbles: true }));
    control.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }
  if (control instanceof HTMLSelectElement) {
    const bounds = control.getBoundingClientRect();
    const direction = x < bounds.left + bounds.width / 2 ? -1 : 1;
    control.selectedIndex = (control.selectedIndex + direction + control.options.length) % control.options.length;
    control.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }
  if (control instanceof HTMLTextAreaElement || control.isContentEditable || (control instanceof HTMLInputElement && ['text', 'url', 'search', 'email', 'password'].includes(control.type))) {
    control.focus();
    universalKeyboard.openDom(control);
    return true;
  }
  const init: PointerEventInit = { clientX: x, clientY: y, pointerId: -2, pointerType: 'hand', bubbles: true };
  control.dispatchEvent(new PointerEvent('pointerdown', init));
  control.dispatchEvent(new PointerEvent('pointerup', init));
  control.click();
  return true;
}

function refreshDeviceStatus(): void {
  const status = inspectDevices();
  const connected = status.gamepads.length > 0;
  const button = element<HTMLButtonElement>('device-button');
  button.disabled = deviceBusy;
  button.classList.toggle('active', connected);
  button.setAttribute('aria-label', connected ? `Authorize Bluetooth devices; ${status.gamepads.length} game controller connected` : 'Authorize Bluetooth devices');
  button.title = connected ? status.gamepads.map((gamepad) => `${gamepad.id} (${gamepad.mapping})`).join(', ') : 'Bluetooth devices and game controllers';
  element('device-status-text').textContent = `${deviceStatusText(status)}${selectedBluetoothName ? ` • Selected: ${selectedBluetoothName}` : ''}`;
  const accessButton = element<HTMLButtonElement>('device-access-button');
  accessButton.disabled = deviceBusy;
  accessButton.textContent = deviceBusy ? 'Waiting for Bluetooth selection…' : 'Authorize Bluetooth devices';
}

async function requestDeviceAccess(): Promise<void> {
  if (deviceBusy) return;
  deviceBusy = true;
  refreshDeviceStatus();
  uiSound.unlock();
  try {
    const device = await requestBluetoothDevice();
    selectedBluetoothName = device.name || 'Bluetooth device';
    uiSound.play('connect');
    notify(`${selectedBluetoothName} selected. For a controller, also pair it in system settings and press a button; Gamepad detection is separate from Web Bluetooth.`);
  } catch (error) {
    if (error instanceof DOMException && error.name === 'NotFoundError') {
      notify('No Bluetooth device was selected.');
    } else {
      uiSound.play('error');
      notify(error instanceof Error ? error.message : 'Bluetooth device access failed.');
    }
  } finally {
    deviceBusy = false;
    refreshDeviceStatus();
  }
}

function visibleDomControls(): HTMLElement[] {
  const selector = 'button, input:not([type="hidden"]), textarea, select, a[href], [tabindex]:not([tabindex="-1"])';
  const scope = modalBackdrop.classList.contains('open') ? modalBackdrop : document;
  return [...scope.querySelectorAll<HTMLElement>(selector)].filter((control) => {
    if (control.matches(':disabled') || control.getAttribute('aria-hidden') === 'true') return false;
    const style = getComputedStyle(control);
    const bounds = control.getBoundingClientRect();
    return style.display !== 'none' && style.visibility !== 'hidden' && bounds.width > 0 && bounds.height > 0
      && bounds.bottom > 0 && bounds.right > 0 && bounds.top < innerHeight && bounds.left < innerWidth;
  });
}

function focusDomControl(control: HTMLElement): void {
  control.focus({ preventScroll: true });
  control.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

function moveDomFocus(direction: 'up' | 'down' | 'left' | 'right'): void {
  const controls = visibleDomControls();
  if (!controls.length) return;
  const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const currentIndex = active ? controls.indexOf(active) : -1;
  if (currentIndex >= 0 && active instanceof HTMLInputElement && active.type === 'range' && (direction === 'left' || direction === 'right')) {
    const step = Number(active.step) || 1;
    active.value = String(Math.min(Number(active.max), Math.max(Number(active.min), Number(active.value) + step * (direction === 'left' ? -1 : 1))));
    active.dispatchEvent(new Event('input', { bubbles: true }));
    active.dispatchEvent(new Event('change', { bubbles: true }));
    return;
  }
  if (currentIndex >= 0 && active instanceof HTMLSelectElement && (direction === 'left' || direction === 'right')) {
    active.selectedIndex = (active.selectedIndex + (direction === 'left' ? -1 : 1) + active.options.length) % active.options.length;
    active.dispatchEvent(new Event('change', { bubbles: true }));
    return;
  }
  if (!active || currentIndex === -1) {
    focusDomControl(controls[0]);
    uiSound.play('move');
    return;
  }
  const origin = active.getBoundingClientRect();
  const x = origin.left + origin.width / 2;
  const y = origin.top + origin.height / 2;
  let best: HTMLElement | null = null;
  let bestScore = Infinity;
  for (const candidate of controls) {
    if (candidate === active) continue;
    const bounds = candidate.getBoundingClientRect();
    const dx = bounds.left + bounds.width / 2 - x;
    const dy = bounds.top + bounds.height / 2 - y;
    const primary = direction === 'left' ? -dx : direction === 'right' ? dx : direction === 'up' ? -dy : dy;
    const secondary = direction === 'left' || direction === 'right' ? Math.abs(dy) : Math.abs(dx);
    if (primary <= 6) continue;
    const score = primary + secondary * 1.6;
    if (score < bestScore) {
      best = candidate;
      bestScore = score;
    }
  }
  if (!best) best = direction === 'left' || direction === 'up' ? controls[controls.length - 1] : controls[0];
  focusDomControl(best);
  uiSound.play('move');
}

function activateFocusedDomControl(): void {
  const controls = visibleDomControls();
  const active = document.activeElement instanceof HTMLElement && controls.includes(document.activeElement)
    ? document.activeElement
    : controls[0];
  if (!active) return;
  if (active instanceof HTMLInputElement && active.type === 'range') {
    moveDomFocus('right');
    return;
  }
  if (active instanceof HTMLSelectElement) {
    active.selectedIndex = (active.selectedIndex + 1) % active.options.length;
    active.dispatchEvent(new Event('change', { bubbles: true }));
    return;
  }
  if (active instanceof HTMLTextAreaElement || active.isContentEditable || (active instanceof HTMLInputElement && ['text', 'url', 'search', 'email', 'password'].includes(active.type))) {
    active.focus();
    universalKeyboard.openDom(active);
    return;
  }
  active.click();
}

function handleGamepadDomInput(control: GamepadControl): boolean {
  if (control === 'a') {
    activateFocusedDomControl();
    return true;
  }
  if (control === 'up' || control === 'down' || control === 'left' || control === 'right') {
    moveDomFocus(control);
    return true;
  }
  return false;
}

function handleGamepadCommand(command: GamepadCommand): void {
  if (modalBackdrop.classList.contains('open') && command !== 'back') return;
  switch (command) {
    case 'back':
      if (modalBackdrop.classList.contains('open')) closeModal();
      else if (universalKeyboard.isOpen) closeKeyboard();
      else if (utilityPanel.classList.contains('open')) closeUtility();
      else if (vrActive && scene.dismissSpatialPrompt()) return;
      else if (vrActive) setVrActive(false);
      else {
        toggleLauncher(false);
        toggleSettings(false);
      }
      break;
    case 'launcher':
      if (vrActive) openOrFocusApp('windows');
      else toggleLauncher();
      break;
    case 'settings':
      if (vrActive) openOrFocusApp('settings');
      else toggleSettings();
      break;
    case 'keyboard': toggleKeyboard(); break;
    case 'windows': openOrFocusApp('windows'); break;
    case 'environment': openOrFocusApp('environments'); break;
    case 'guide':
      if (vrActive) scene.showSpatialGuide();
      else showControlsGuide();
      break;
  }
}

function disableHandControls(): void {
  if (handTracker.active) handTracker.disable();
  armTracker.disable();
  syncHandControls(false);
  if (handCameraOwned) rearCamera.release('hands');
  handCameraOwned = false;
}

async function toggleHandControls(): Promise<void> {
  if (handsBusy) return;
  handsBusy = true;
  handsButton.disabled = true;
  try {
    if (handsActive || handTracker.active) {
      disableHandControls();
      return;
    }
    if (!handTracker.available) {
      notify('Hand controls need WebAssembly, which is unavailable in this browser. Touch controls remain available.');
      return;
    }
    if (!handCameraOwned) {
      await rearCamera.acquire('hands');
      handCameraOwned = true;
    }
    const enabled = await handTracker.enable();
    if (!enabled || !rearCamera.active) {
      disableHandControls();
      return;
    }
    syncHandControls(true);
    void armTracker.enable();
    notify('Hands active. Point and pinch to activate; use two hands over a window to pinch-resize it.');
  } catch {
    disableHandControls();
  } finally {
    handsBusy = false;
    handsButton.disabled = false;
  }
}

function updateConnectionStatus(): void {
  setStatus('connection-status', navigator.onLine ? 'Online' : 'Offline', !navigator.onLine);
}

function updateMotionStatus(message: string, error = false): void {
  setStatus('motion-status', error ? 'Motion issue' : motion.enabled ? 'Motion on' : 'Touch look', error);
  if (error || /active|calibrated|enabled/i.test(message)) notify(message);
}

function updateCameraStatus(message: string, error = false): void {
  setStatus('camera-status', error ? 'Camera issue' : rearCamera.active ? 'Rear camera' : 'Camera off', error);
  if (!rearCamera.active && handsActive) disableHandControls();
  if (error || /active|off/i.test(message)) notify(message);
}

const motion = new MotionController(updateMotionStatus);
const rearCamera = new RearCamera(updateCameraStatus);
const handTracker = new HandTracker((message, error = false) => {
  notify(message);
  if (error) {
    armTracker.disable();
    syncHandControls(false);
    if (handCameraOwned) rearCamera.release('hands');
    handCameraOwned = false;
  }
});
const armTracker = new ArmTracker((message, error = false) => {
  if (error) notify(message);
});
handOverlay.setCameraDimensions(() => ({ width: rearCamera.video.videoWidth || 1, height: rearCamera.video.videoHeight || 1 }));

function toggleLauncher(force?: boolean): void {
  const open = force ?? !launcher.classList.contains('open');
  if (open === launcher.classList.contains('open')) return;
  launcher.classList.toggle('open', open);
  uiSound.play(open ? 'open' : 'close');
  element('launcher-button').classList.toggle('active', open);
  if (open) {
    settingsPanel.classList.remove('open');
    closeKeyboard();
    closeUtility();
  }
}

function toggleSettings(force?: boolean): void {
  const open = force ?? !settingsPanel.classList.contains('open');
  if (open === settingsPanel.classList.contains('open')) return;
  settingsPanel.classList.toggle('open', open);
  uiSound.play(open ? 'open' : 'close');
  if (open) {
    toggleLauncher(false);
    closeKeyboard();
    closeUtility();
  }
}

function closeUtility(): void {
  const wasOpen = utilityMode !== null;
  if (utilityMode === 'ai') aiAbort?.abort();
  utilityPanel.classList.remove('open');
  utilityMode = null;
  utilityRender = null;
  if (wasOpen) uiSound.play('close');
  for (const id of ['library-button', 'ai-button']) element(id).classList.remove('active');
}

function closeKeyboard(): void {
  const wasOpen = universalKeyboard.isOpen;
  universalKeyboard.close();
  element('keyboard-button').classList.remove('active');
  if (wasOpen) uiSound.play('close');
}

function toggleKeyboard(): void {
  if (universalKeyboard.isOpen) closeKeyboard();
  else {
    toggleLauncher(false);
    toggleSettings(false);
    closeUtility();
    scene.showSpatialKeyboard();
    element('keyboard-button').classList.add('active');
    uiSound.play('open');
  }
}

function openUtility(mode: 'library' | 'ai'): void {
  closeKeyboard();
  if (utilityMode === mode) {
    closeUtility();
    return;
  }
  toggleLauncher(false);
  toggleSettings(false);
  closeUtility();
  utilityMode = mode;
  utilityPanel.classList.add('open');
  element(`${mode}-button`).classList.add('active');
  element('utility-title').textContent = mode === 'library' ? 'Shared library' : 'AI assistant';
  element('utility-eyebrow').textContent = mode === 'library' ? 'LOCAL MEDIA' : 'OPENAI • OPTIONAL';
  uiSound.play('open');
  if (mode === 'library') renderLibrary();
  else renderAiPanel();
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function openSharedFile(appId: 'photos' | 'video', file: StoredFile): void {
  let window = [...scene.windows.values()].find((candidate) => candidate.state.appId === appId);
  if (!window) window = scene.openApp(appId) ?? undefined;
  if (!window) return;
  scene.focusWindow(window.state.id);
  window.openFile(file);
  closeUtility();
}

function renderLibrary(): void {
  utilityContent.replaceChildren();
  const description = document.createElement('p');
  description.className = 'utility-description';
  description.textContent = 'Import photos and videos before putting on the headset. Files stay in this browser and open directly in Photos or Video.';
  const actions = document.createElement('div');
  actions.className = 'library-actions';
  const importButton = document.createElement('button');
  importButton.type = 'button';
  importButton.className = 'primary-button';
  importButton.textContent = 'Import media';
  const refreshButton = document.createElement('button');
  refreshButton.type = 'button';
  refreshButton.className = 'secondary-button';
  refreshButton.textContent = 'Refresh';
  actions.append(importButton, refreshButton);
  const list = document.createElement('div');
  list.className = 'library-list';
  utilityContent.append(description, actions, list);

  const refresh = async (): Promise<void> => {
    if (utilityMode !== 'library') return;
    refreshButton.disabled = true;
    list.textContent = 'Loading local media…';
    try {
      const files = (await storage.listFiles()).filter((file) => file.type.startsWith('image/') || file.type.startsWith('video/'));
      if (utilityMode !== 'library') return;
      list.replaceChildren();
      if (!files.length) {
        const empty = document.createElement('p');
        empty.className = 'utility-description';
        empty.textContent = 'No photos or videos yet. Use Import media to add them.';
        list.append(empty);
        return;
      }
      for (const file of files) {
        const item = document.createElement('article');
        item.className = 'library-item';
        const head = document.createElement('div');
        head.className = 'library-item-head';
        const type = document.createElement('span');
        type.className = 'library-type';
        type.textContent = file.type.startsWith('video/') ? '▶' : '✦';
        const identity = document.createElement('div');
        identity.style.minWidth = '0';
        identity.style.flex = '1';
        const name = document.createElement('div');
        name.className = 'library-name';
        name.textContent = file.name;
        name.title = file.name;
        const detail = document.createElement('div');
        detail.className = 'library-detail';
        detail.textContent = `${file.type.startsWith('video/') ? 'Video' : 'Image'} • ${formatFileSize(file.size)} • ${new Date(file.createdAt).toLocaleDateString()}`;
        identity.append(name, detail);
        head.append(type, identity);
        const itemActions = document.createElement('div');
        itemActions.className = 'library-item-actions';
        if (file.type.startsWith('image/')) {
          const open = document.createElement('button');
          open.type = 'button';
          open.className = 'secondary-button';
          open.textContent = 'Open in Photos';
          open.onclick = () => openSharedFile('photos', file);
          itemActions.append(open);
        } else {
          const open = document.createElement('button');
          open.type = 'button';
          open.className = 'secondary-button';
          open.textContent = 'Play in Video';
          open.onclick = () => openSharedFile('video', file);
          itemActions.append(open);
        }
        item.append(head, itemActions);
        list.append(item);
      }
    } catch (error) {
      list.textContent = error instanceof Error ? error.message : 'Could not read local media.';
    } finally {
      refreshButton.disabled = false;
    }
  };

  importButton.onclick = () => {
    void pickFiles('image/*,video/*', true).then(async (files) => {
      let imported = 0;
      for (const file of files) {
        try {
          await storage.putFile(file);
          imported += 1;
        } catch (error) {
          notify(error instanceof Error ? error.message : 'Could not import media.');
        }
      }
      notify(`${imported} media file${imported === 1 ? '' : 's'} imported.`);
      await refresh();
    }).catch((error: unknown) => notify(error instanceof Error ? error.message : 'Could not import media.'));
  };
  refreshButton.onclick = () => { void refresh(); };
  utilityRender = () => { void refresh(); };
  void refresh();
}

function renderAiPanel(): void {
  utilityContent.replaceChildren();
  const description = document.createElement('p');
  description.className = 'utility-description';
  description.textContent = 'Optional OpenAI assistant. Your key is held in memory for this session only and is never saved by VISI0N OS.';
  const warning = document.createElement('p');
  warning.className = 'privacy-warning';
  warning.textContent = 'Privacy: prompts and chat history are sent to OpenAI only when you press Send. Do not include private camera, file, or scan content.';

  const keyField = document.createElement('label');
  keyField.className = 'ai-field';
  keyField.textContent = 'OpenAI API key';
  const keyInput = document.createElement('input');
  keyInput.type = 'password';
  keyInput.autocomplete = 'off';
  keyInput.spellcheck = false;
  keyInput.placeholder = ai.hasApiKey() ? 'Key active for this session' : 'sk-…';
  const keyActions = document.createElement('div');
  keyActions.className = 'ai-actions';
  const saveKey = document.createElement('button');
  saveKey.type = 'button';
  saveKey.className = 'secondary-button';
  saveKey.textContent = 'Use key';
  const forgetKey = document.createElement('button');
  forgetKey.type = 'button';
  forgetKey.className = 'secondary-button';
  forgetKey.textContent = 'Forget key';
  keyActions.append(saveKey, forgetKey);
  keyField.append(keyInput, keyActions);

  const modelField = document.createElement('label');
  modelField.className = 'ai-field';
  modelField.textContent = 'Model';
  const modelInput = document.createElement('input');
  modelInput.type = 'text';
  modelInput.value = 'gpt-4o-mini';
  modelInput.autocomplete = 'off';
  modelField.append(modelInput);

  const promptField = document.createElement('label');
  promptField.className = 'ai-field';
  promptField.textContent = 'Message';
  const promptInput = document.createElement('textarea');
  promptInput.placeholder = 'Ask the assistant to help with your spatial workspace…';
  promptField.append(promptInput);

  const sendActions = document.createElement('div');
  sendActions.className = 'ai-actions';
  const sendButton = document.createElement('button');
  sendButton.type = 'button';
  sendButton.className = 'primary-button';
  sendButton.textContent = 'Send';
  const cancelButton = document.createElement('button');
  cancelButton.type = 'button';
  cancelButton.className = 'secondary-button';
  cancelButton.textContent = 'Cancel';
  cancelButton.disabled = true;
  sendActions.append(sendButton, cancelButton);
  const response = document.createElement('pre');
  response.className = 'ai-response';
  response.setAttribute('aria-live', 'polite');

  saveKey.onclick = () => {
    try {
      ai.setApiKey(keyInput.value);
      keyInput.value = '';
      keyInput.placeholder = 'Key active for this session';
      notify('OpenAI key activated in memory. It will be forgotten when this page closes.');
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Enter a valid API key.');
    }
  };
  forgetKey.onclick = () => {
    aiAbort?.abort();
    aiAbort = null;
    ai.forgetApiKey();
    aiHistory.length = 0;
    keyInput.value = '';
    keyInput.placeholder = 'sk-…';
    response.textContent = '';
    sendButton.disabled = false;
    cancelButton.disabled = true;
    notify('OpenAI key and chat history forgotten.');
  };
  cancelButton.onclick = () => aiAbort?.abort();
  sendButton.onclick = () => {
    const prompt = promptInput.value.trim();
    if (!prompt) {
      notify('Enter a message first.');
      return;
    }
    if (!ai.hasApiKey()) {
      notify('Set an OpenAI API key before sending.');
      keyInput.focus();
      return;
    }
    aiHistory.push({ role: 'user', content: prompt });
    promptInput.value = '';
    const controller = new AbortController();
    aiAbort = controller;
    sendButton.disabled = true;
    cancelButton.disabled = false;
    response.textContent = 'Thinking…';
    void ai.send([{ role: 'system', content: 'You are a concise assistant inside a spatial computing interface. Be practical and honest about device limitations.' }, ...aiHistory], { model: modelInput.value, signal: controller.signal }).then((answer) => {
      if (aiAbort !== controller) return;
      aiHistory.push({ role: 'assistant', content: answer });
      response.textContent = answer;
    }).catch((error: unknown) => {
      if (aiAbort !== controller) return;
      aiHistory.pop();
      response.textContent = error instanceof Error ? error.message : 'The AI request failed.';
    }).finally(() => {
      if (aiAbort !== controller) return;
      aiAbort = null;
      sendButton.disabled = false;
      cancelButton.disabled = true;
    });
  };
  utilityContent.append(description, warning, keyField, modelField, promptField, sendActions, response);
  utilityRender = () => promptInput.focus();
}

function updateSpatialStatus(capabilities: SpatialCapabilities): void {
  const label = capabilities.activeMode === 'off' ? 'Off' : capabilities.activeMode === 'full' ? 'Full • metric' : capabilities.activeMode === 'camera' ? 'Camera • relative' : 'Economy • orientation';
  setStatus('spatial-status', label, capabilities.activeMode === 'off' && capabilities.requestedMode !== 'off');
}

async function setSpatialMode(mode: AppSettings['spatialMode']): Promise<void> {
  const generation = ++spatialModeGeneration;
  if (spatialCameraOwned) {
    rearCamera.release('spatial');
    spatialCameraOwned = false;
  }
  let cameraAvailable = false;
  if (mode === 'camera' || mode === 'full') {
    try {
      await rearCamera.acquire('spatial');
      if (generation !== spatialModeGeneration) {
        rearCamera.release('spatial');
        return;
      }
      spatialCameraOwned = true;
      cameraAvailable = rearCamera.ready;
    } catch {
      if (generation !== spatialModeGeneration) return;
      notify('Spatial analysis needs rear-camera permission. VR remains available without it.');
    }
  }
  if (generation !== spatialModeGeneration) return;
  try {
    if (mode === 'off') {
      if (motion.enabled) await motion.enable({ gyro: false });
    } else {
      await motion.enable({ gyro: true, onGyro: (sample) => {
        if (generation !== spatialModeGeneration) return;
        const orientation = motion.getTarget() ?? scene.camera.quaternion;
        scene.ingestMotion({
          timestamp: sample.timestamp,
          quaternion: [orientation.x, orientation.y, orientation.z, orientation.w],
          gyro: [sample.angularVelocity.x, sample.angularVelocity.y, sample.angularVelocity.z],
        });
      } });
    }
  } catch (error) {
    if (generation !== spatialModeGeneration) return;
    notify(error instanceof Error ? error.message : 'Motion fusion could not start.');
  }
  if (generation !== spatialModeGeneration) return;
  try {
    const capabilities = await scene.setSpatialMode(mode, cameraAvailable);
    if (generation !== spatialModeGeneration) return;
    updateSpatialStatus(capabilities);
    if (capabilities.activeMode !== mode) notify(capabilities.reasons.at(-1) ?? `Spatial mode fallback: ${capabilities.activeMode}.`);
  } catch (error) {
    if (generation !== spatialModeGeneration) return;
    setStatus('spatial-status', 'Unavailable', true);
    notify(error instanceof Error ? error.message : 'Spatial analysis could not start.');
  }
}

function updateSettings(partial: Partial<AppSettings>): void {
  const spatialChanged = partial.spatialMode !== undefined && partial.spatialMode !== settings.spatialMode;
  const environmentChanged = partial.environment !== undefined && partial.environment !== settings.environment;
  settings = sanitizeSettings({ ...settings, ...partial });
  uiSound.configure(settings);
  scene.applySettings(settings);
  if (!saveSettings(settings)) notify('Settings are active for this session but could not be persisted.');
  if (spatialChanged) void setSpatialMode(settings.spatialMode);
  if (environmentChanged) {
    if (environmentCameraOwned) {
      rearCamera.release('environment');
      environmentCameraOwned = false;
    }
    if (settings.environment === 'camera') {
      void rearCamera.acquire('environment').then(() => { environmentCameraOwned = true; }).catch(() => undefined);
    }
  }
  syncSettingsControls();
}

function syncSettingsControls(): void {
  applyInterfacePalette(settings.palette);
  element<HTMLInputElement>('motion-sensitivity').value = String(settings.motionSensitivity);
  element<HTMLSelectElement>('quality-select').value = settings.quality;
  element<HTMLInputElement>('ipd-range').value = String(settings.ipd);
  element<HTMLInputElement>('distance-range').value = String(settings.vrDistance);
  element<HTMLInputElement>('fov-range').value = String(settings.fov);
  element<HTMLInputElement>('distortion-range').value = String(settings.distortion);
  element<HTMLInputElement>('glass-transparency-range').value = String(settings.glassTransparency);
  element<HTMLInputElement>('glass-blur-range').value = String(settings.glassBlur);
  element<HTMLInputElement>('window-scale-range').value = String(settings.defaultWindowScale);
  element<HTMLInputElement>('environment-exposure-range').value = String(settings.environmentExposure);
  element<HTMLInputElement>('hand-smoothing-range').value = String(settings.handSmoothing);
  element<HTMLInputElement>('dwell-time-range').value = String(settings.dwellTime);
  element<HTMLSelectElement>('head-lock-select').value = String(settings.headLockDefault);
  element<HTMLSelectElement>('keyboard-layout-select').value = settings.keyboardLayout;
  element<HTMLSelectElement>('taskbar-mode-select').value = settings.taskbarMode;
  element<HTMLSelectElement>('spatial-mode-select').value = settings.spatialMode;
  element<HTMLInputElement>('environment-map-toggle').checked = settings.showEnvironmentMap;
  element<HTMLInputElement>('companion-enabled-toggle').checked = settings.companionEnabled;
  element<HTMLInputElement>('window-inertia-toggle').checked = settings.windowInertia;
  element<HTMLInputElement>('window-snapping-toggle').checked = settings.windowSnapping;
  element<HTMLInputElement>('ui-sound-toggle').checked = settings.uiSoundEnabled;
  element<HTMLInputElement>('ui-sound-volume').value = String(settings.uiSoundVolume);
  element('ui-sound-volume-output').textContent = `${Math.round(settings.uiSoundVolume * 100)}%`;
  document.querySelectorAll<HTMLButtonElement>('.palette-swatch').forEach((button) => {
    const active = button.dataset.palette === settings.palette;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  });
  element('ipd-output').textContent = `${settings.ipd} mm`;
  element('distance-output').textContent = `${settings.vrDistance.toFixed(1)} m`;
  element('fov-output').textContent = `${settings.fov}°`;
  element('distortion-output').textContent = settings.distortion.toFixed(2);
  element('glass-transparency-output').textContent = `${Math.round(settings.glassTransparency * 100)}%`;
  element('glass-blur-output').textContent = `${settings.glassBlur} px`;
  element('window-scale-output').textContent = `${Math.round(settings.defaultWindowScale * 100)}%`;
  element('environment-exposure-output').textContent = settings.environmentExposure.toFixed(2);
  element('hand-smoothing-output').textContent = settings.handSmoothing.toFixed(2);
  element('dwell-time-output').textContent = `${settings.dwellTime.toFixed(1)} s`;
  const alpha = 0.035 + (1 - settings.glassTransparency) * 0.55;
  document.documentElement.style.setProperty('--glass-alpha', alpha.toFixed(3));
  document.documentElement.style.setProperty('--glass-alpha-soft', (alpha * 0.38).toFixed(3));
  document.documentElement.style.setProperty('--glass-blur', `${settings.glassBlur}px`);
}

function closeModal(value: string | boolean | null = null): void {
  const wasOpen = modalBackdrop.classList.contains('open');
  modalBackdrop.classList.remove('open');
  if (wasOpen) uiSound.play(value === null ? 'back' : 'close');
  const resolver = modalResolver;
  modalResolver = null;
  resolver?.(value);
}

function requestText(options: TextRequestOptions): Promise<string | null> {
  if (options.mode === undefined || options.mode === 'text') return universalKeyboard.open(options);
  closeModal();
  modalTitle.textContent = options.title;
  const description = document.createElement('p');
  description.textContent = options.value || options.placeholder || '';
  description.style.whiteSpace = 'pre-line';
  const actions = document.createElement('div');
  actions.className = 'modal-actions';
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'secondary-button';
  cancel.textContent = options.cancelLabel ?? 'Cancel';
  const submit = document.createElement('button');
  submit.type = 'button';
  submit.className = 'primary-button';
  submit.textContent = options.submitLabel;
  actions.append(cancel, submit);
  modalContent.replaceChildren(description, actions);
  uiSound.play('open');
  modalBackdrop.classList.add('open');
  return new Promise<string | null>((resolve) => {
    modalResolver = (value) => resolve(typeof value === 'string' || value === null ? value : null);
    cancel.onclick = () => closeModal(null);
    submit.onclick = () => closeModal(options.value);
  });
}

function requestUrl(current: string): Promise<string | null> {
  return requestText({ title: 'Open a website', value: current, placeholder: 'https://example.com — embedding depends on site permissions', submitLabel: 'Open' });
}

function confirmAction(message: string): Promise<boolean> {
  closeModal();
  modalTitle.textContent = 'Confirm action';
  const description = document.createElement('p');
  description.textContent = message;
  const actions = document.createElement('div');
  actions.className = 'modal-actions';
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'secondary-button';
  cancel.textContent = 'Cancel';
  const confirm = document.createElement('button');
  confirm.type = 'button';
  confirm.className = 'primary-button';
  confirm.textContent = 'Delete';
  actions.append(cancel, confirm);
  modalContent.replaceChildren(description, actions);
  uiSound.play('open');
  modalBackdrop.classList.add('open');
  return new Promise<boolean>((resolve) => {
    modalResolver = (value) => resolve(value === true);
    cancel.onclick = () => closeModal(false);
    confirm.onclick = () => closeModal(true);
  });
}

function showInstallGuide(): void {
  closeModal();
  modalTitle.textContent = 'Install on iPhone';
  const intro = document.createElement('p');
  intro.textContent = 'VISI0N OS is a PWA, not an IPA. Safari cannot install it silently; you confirm the home-screen icon yourself.';
  const list = document.createElement('ol');
  [
    'Open the GitHub Pages site in Safari.',
    'Tap the Share button.',
    'Choose “Add to Home Screen”.',
    'Confirm the name and tap Add.',
    'Launch VISI0N OS from the home screen in landscape.',
  ].forEach((text) => {
    const item = document.createElement('li');
    item.textContent = text;
    list.append(item);
  });
  const note = document.createElement('p');
  note.textContent = 'Camera and motion permissions are requested only when you enable those features. Offline availability begins after the app has loaded once and cached its assets.';
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'primary-button';
  close.textContent = 'Got it';
  modalContent.replaceChildren(intro, list, note, close);
  uiSound.play('open');
  modalBackdrop.classList.add('open');
  close.onclick = () => closeModal();
}

function showControlsGuide(): void {
  closeModal();
  modalTitle.textContent = 'Controls & commands';
  const intro = document.createElement('p');
  intro.textContent = 'Use touch, one hand, a game controller, or Cardboard gaze. Every control also has a touch fallback.';
  const sections: Array<[string, string[]]> = [
    ['Touch and mouse', [
      'Drag a window title bar to move it. Use the rotate control to tilt it, or the bottom-right corner to resize it.',
      'Pinch with two fingers to resize a window. Scroll or use the mouse wheel over a window to change its depth.',
      'Tap app buttons, title-bar controls, launcher items, settings, and Window Manager actions.',
    ]],
    ['Hand controls', [
      'Enable Hands in the top bar. Allow the rear camera; the MediaPipe WASM runtime and model download on first use.',
      'Point with your index fingertip. Pinch thumb and index, or hold the cursor still for the configured delay, to activate a control.',
      'Pinch a title bar, rotate control, or resize corner and keep holding to drag. Open the pinch while holding the resize corner to scale with one hand.',
      'Bring two hands together, pinch both, then spread their index fingertips over a window to resize it. Lower either hand to finish.',
      'Pinch empty space in a 360 panorama and drag to turn it. Use a window’s Anchor control to preserve its current world pose.',
      'Hands and tracked arms render above every 2D interface. Pose arms load separately; if unavailable, a clearly estimated forearm is drawn from the real wrist.',
      'Use Library to prepare local media and the curved French AZERTY keyboard for real text fields. Anchor preserves the focused window’s current world pose.',
    ]],
    ['Spatial space and Cardboard', [
      'Cycle a window between World, Head, and Individual anchoring with its mode button.',
      'Choose “Arrange around me” in Settings or Window Manager to place floating windows in a world-space arc.',
      'Use the title-bar Anchor control or Window Manager action for persistent placement. Drag, roll, depth, and two-hand resize are managed in 6DOF.',
      'Enter VR for separate left/right eye rendering. Center a content control and hold your gaze to select it.',
      'Use Settings to adjust IPD, screen distance, field of view, lens correction, sensitivity, and orientation calibration.',
    ]],
    ['Game controller', [
      'Pair the controller in system Bluetooth settings, then press a button. Detection is automatic through the Gamepad API; Web Bluetooth selection is separate.',
      'D-pad or left stick moves DOM focus. In VR it moves the cursor; the right stick looks around. A activates, B goes back, X opens the keyboard.',
      'Y opens the launcher or Window Manager, Start opens Settings, shoulder buttons switch windows, triggers change depth, and the Home button opens this guide.',
      'Browsers cannot scan, join, or grant permission for Wi-Fi networks. The device button reports this limitation instead of faking a permission.',
    ]],
    ['Keyboard and privacy', [
      'Use 123 on the universal keyboard for direct digits and a decimal point, then ABC to return to letters. Shift, Caps, accents and QWERTY remain available.',
      'L: launcher. H: hand controls. G: this guide. A: arrange windows. K: keyboard. P: anchor/release. Escape: close a panel, dialog, or VR.',
      'Camera frames, scans, and files remain on this device. Only AI prompts explicitly sent with your key go to OpenAI.',
      'Hand tracking needs internet access to download its runtime/model unless the browser already cached them. Touch and gaze remain available if tracking fails.',
    ]],
  ];
  const content = document.createDocumentFragment();
  content.append(intro);
  for (const [heading, items] of sections) {
    const title = document.createElement('h3');
    title.textContent = heading;
    const list = document.createElement('ul');
    for (const item of items) {
      const entry = document.createElement('li');
      entry.textContent = item;
      list.append(entry);
    }
    content.append(title, list);
  }
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'primary-button';
  close.textContent = 'Got it';
  close.onclick = () => closeModal();
  content.append(close);
  modalContent.replaceChildren(content);
  uiSound.play('open');
  modalBackdrop.classList.add('open');
}

function pickFiles(accept: string, multiple: boolean): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.multiple = multiple;
    input.style.display = 'none';
    const finish = (): void => {
      const files = [...(input.files ?? [])];
      input.remove();
      resolve(files);
    };
    input.onchange = finish;
    input.oncancel = finish;
    document.body.append(input);
    input.click();
  });
}

function syncPinButton(windows: WindowState[]): void {
  const anchored = windows[0]?.anchor !== undefined;
  const button = element<HTMLButtonElement>('pin-button');
  button.classList.toggle('active', anchored);
  button.setAttribute('aria-pressed', String(anchored));
  button.setAttribute('aria-label', anchored ? 'Release focused window anchor' : 'Anchor focused window');
  const label = button.querySelector('span');
  if (label) label.textContent = anchored ? 'Release' : 'Anchor';
}

function onWindowsChanged(windows: WindowState[]): void {
  if (!saveWindowRecords(windows)) notify('Window layout is active for this session but could not be persisted.');
  emptyState.classList.toggle('hidden', windows.length > 0);
  syncPinButton(windows);
}

const scene: SpatialScene = new SpatialScene(canvas, element('dom-layer'), motion, rearCamera, settings, {
  getDefinition: getApplication,
  getApplications: () => APPLICATIONS,
  openApp: (appId) => { scene.openOrFocusApp(appId); },
  openSharedFile,
  setVrActive,
  showControlsGuide,
  toggleKeyboard,
  keyboard: universalKeyboard,
  setSpatialMode,
  onSpatialFrame: (frame) => updateSpatialStatus(frame.capabilities),
  notify,
  pickFiles,
  requestUrl,
  requestText,
  requestConfirm: confirmAction,
  confirm: confirmAction,
  getSettings: () => settings,
  updateSettings,
  toggleHandControls,
  recalibrate: () => scene.recalibrate(),
  setEnvironment: (environment) => updateSettings({ environment }),
  focusWindow: (id) => scene.focusWindow(id),
  closeWindow: (id) => scene.closeWindow(id),
  listWindows: (): WindowState[] => scene.listWindows(),
  showScan: (record) => scene.showScan(record),
  rearCamera,
  handTracker,
  armTracker,
  onWindowsChanged,
  onGazeProgress: (progress, active) => {
    gazeProgress.style.setProperty('--gaze', `${progress * 360}deg`);
    gazeReticle.style.opacity = active ? '1' : '0.55';
  },
  onHandFrame: updateHandFrame,
  activateDomElement,
  gamepadDomInput: handleGamepadDomInput,
  gamepadCommand: handleGamepadCommand,
  isDomModalOpen: () => modalBackdrop.classList.contains('open'),
  onGamepadsChanged: refreshDeviceStatus,
  requestDeviceAccess,
  getDeviceStatus: () => deviceStatusText(inspectDevices()),
  arrangeWindows: () => scene.arrangeWindowsSurround(),
  toggleWindowPin: (id) => { scene.toggleWindowPin(id); },
  pinFocusedWindow: () => scene.toggleFocusedWindowPin(),
  getPanoramaUrl,
});

for (const application of APPLICATIONS.filter((candidate) => !candidate.spatialOnly)) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'launcher-app';
  button.style.setProperty('--app-color', application.color);
  button.title = application.description;
  const icon = document.createElement('span');
  icon.className = 'app-icon';
  icon.textContent = application.icon;
  const label = document.createElement('span');
  label.textContent = application.name;
  button.append(icon, label);
  button.onclick = () => {
    scene.openOrFocusApp(application.id);
    if (globalThis.innerWidth < 760) toggleLauncher(false);
  };
  element('launcher-grid').append(button);
}

const storedWindows = loadWindowRecords();
if (storedWindows.length) scene.restoreWindows(storedWindows);
else onWindowsChanged([]);
if (settings.environment === 'camera') {
  void rearCamera.acquire('environment').then(() => { environmentCameraOwned = true; }).catch(() => undefined);
}
void setSpatialMode(settings.spatialMode);

function setVrActive(active: boolean): void {
  vrActive = active;
  uiSound.play(active ? 'open' : 'close');
  document.body.classList.toggle('vr-mode', active);
  scene.setVrActive(active);
  const button = element('vr-button');
  const label = button.querySelector('span');
  if (label) label.textContent = active ? 'Exit VR' : 'Enter VR';
  if (active) {
    toggleLauncher(false);
    toggleSettings(false);
    closeKeyboard();
    closeUtility();
    if (!motion.enabled) void motion.enable().catch(() => undefined);
    notify('Cardboard mode active. Spatial taskbar, gaze and enabled hands select controls.');
  } else {
    notify('VR mode exited.');
  }
}

element('launcher-button').onclick = () => toggleLauncher();
element('launcher-close').onclick = () => toggleLauncher(false);
element('empty-launch').onclick = () => toggleLauncher(true);
element('settings-button').onclick = () => toggleSettings();
element('settings-close').onclick = () => toggleSettings(false);
function openOrFocusApp(appId: string): void {
  const existing = scene.openOrFocusApp(appId);
  if (existing) notify(`${existing.definition.name} focused.`);
}

element('windows-button').onclick = () => openOrFocusApp('windows');
element('environment-button').onclick = () => openOrFocusApp('environments');
element('scan-button').onclick = () => openOrFocusApp('scanner');
element('vr-button').onclick = () => setVrActive(!vrActive);
element('vr-exit').onclick = () => setVrActive(false);
element('hands-button').onclick = () => { void toggleHandControls(); };
element('device-button').onclick = () => { void requestDeviceAccess(); };
element('device-access-button').onclick = () => { void requestDeviceAccess(); };
element('guide-button').onclick = showControlsGuide;
element('surround-button').onclick = () => scene.arrangeWindowsSurround();
element('anchor-button').onclick = () => scene.toggleFocusedWindowAnchor();
element('pin-button').onclick = () => scene.toggleFocusedWindowPin();
element('library-button').onclick = () => openUtility('library');
element('ai-button').onclick = () => openUtility('ai');
element('keyboard-button').onclick = toggleKeyboard;
element('utility-close').onclick = () => { closeKeyboard(); closeUtility(); };
element('calibrate-button').onclick = () => scene.recalibrate();
element('install-button').onclick = showInstallGuide;
element('modal-close').onclick = () => closeModal();
modalBackdrop.onclick = (event) => {
  if (event.target === modalBackdrop) closeModal();
};
element('motion-button').onclick = () => {
  if (motion.enabled) motion.disable();
  else void motion.enable().catch(() => undefined);
};
element('camera-button').onclick = () => {
  if (manualCameraOwned) {
    rearCamera.stop();
    manualCameraOwned = false;
  } else {
    manualCameraOwned = true;
    void rearCamera.start().catch(() => { manualCameraOwned = false; });
  }
};

const paletteControl = element('palette-control');
for (const palette of INTERFACE_PALETTES) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'palette-swatch';
  button.dataset.palette = palette.id;
  button.title = palette.name;
  button.setAttribute('aria-label', `${palette.name} interface palette`);
  button.style.setProperty('--swatch', palette.accent);
  button.style.setProperty('--swatch-secondary', palette.secondary);
  button.onclick = () => updateSettings({ palette: palette.id });
  paletteControl.append(button);
}

const sensitivity = element<HTMLInputElement>('motion-sensitivity');
sensitivity.oninput = () => updateSettings({ motionSensitivity: Number(sensitivity.value) });
const quality = element<HTMLSelectElement>('quality-select');
quality.onchange = () => updateSettings({ quality: quality.value as AppSettings['quality'] });
const ipd = element<HTMLInputElement>('ipd-range');
ipd.oninput = () => updateSettings({ ipd: Number(ipd.value) });
const distance = element<HTMLInputElement>('distance-range');
distance.oninput = () => updateSettings({ vrDistance: Number(distance.value) });
const fov = element<HTMLInputElement>('fov-range');
fov.oninput = () => updateSettings({ fov: Number(fov.value) });
const distortion = element<HTMLInputElement>('distortion-range');
distortion.oninput = () => updateSettings({ distortion: Number(distortion.value) });
const glassTransparency = element<HTMLInputElement>('glass-transparency-range');
glassTransparency.oninput = () => updateSettings({ glassTransparency: Number(glassTransparency.value) });
const glassBlur = element<HTMLInputElement>('glass-blur-range');
glassBlur.oninput = () => updateSettings({ glassBlur: Number(glassBlur.value) });
const windowScale = element<HTMLInputElement>('window-scale-range');
windowScale.oninput = () => updateSettings({ defaultWindowScale: Number(windowScale.value) });
const environmentExposure = element<HTMLInputElement>('environment-exposure-range');
environmentExposure.oninput = () => updateSettings({ environmentExposure: Number(environmentExposure.value) });
const handSmoothing = element<HTMLInputElement>('hand-smoothing-range');
handSmoothing.oninput = () => updateSettings({ handSmoothing: Number(handSmoothing.value) });
const dwellTime = element<HTMLInputElement>('dwell-time-range');
dwellTime.oninput = () => updateSettings({ dwellTime: Number(dwellTime.value) });
const headLock = element<HTMLSelectElement>('head-lock-select');
headLock.onchange = () => updateSettings({ headLockDefault: headLock.value === 'true' });
const keyboardLayout = element<HTMLSelectElement>('keyboard-layout-select');
keyboardLayout.onchange = () => updateSettings({ keyboardLayout: keyboardLayout.value as AppSettings['keyboardLayout'] });
const taskbarMode = element<HTMLSelectElement>('taskbar-mode-select');
taskbarMode.onchange = () => updateSettings({ taskbarMode: taskbarMode.value as AppSettings['taskbarMode'] });
element('taskbar-reposition-button').onclick = () => scene.repositionTaskbar();
element<HTMLInputElement>('window-inertia-toggle').onchange = (event) => updateSettings({ windowInertia: (event.currentTarget as HTMLInputElement).checked });
element<HTMLInputElement>('window-snapping-toggle').onchange = (event) => updateSettings({ windowSnapping: (event.currentTarget as HTMLInputElement).checked });
element<HTMLInputElement>('ui-sound-toggle').onchange = (event) => updateSettings({ uiSoundEnabled: (event.currentTarget as HTMLInputElement).checked });
const uiSoundVolume = element<HTMLInputElement>('ui-sound-volume');
uiSoundVolume.oninput = () => updateSettings({ uiSoundVolume: Number(uiSoundVolume.value) });
const spatialMode = element<HTMLSelectElement>('spatial-mode-select');
spatialMode.onchange = () => updateSettings({ spatialMode: spatialMode.value as AppSettings['spatialMode'] });
element<HTMLInputElement>('environment-map-toggle').onchange = (event) => updateSettings({ showEnvironmentMap: (event.currentTarget as HTMLInputElement).checked });
element<HTMLInputElement>('companion-enabled-toggle').onchange = (event) => updateSettings({ companionEnabled: (event.currentTarget as HTMLInputElement).checked });
element('companion-open-button').onclick = () => openOrFocusApp('companion');
syncSettingsControls();

function soundForClick(target: Element): UiSoundName {
  if (target.closest('#modal-close, #settings-close, #launcher-close, #utility-close, .launcher-close, [data-sound="back"]')) return 'back';
  if (target.closest('input[type="checkbox"], .palette-swatch, [aria-pressed]')) return 'toggle';
  if (target.closest('.primary-button')) return 'confirm';
  if (target.closest('.launcher-app, #launcher-button, #windows-button, #environment-button, #scan-button, #library-button, #ai-button, #keyboard-button')) return 'open';
  return 'tap';
}

document.addEventListener('pointerdown', () => uiSound.unlock(), { capture: true });
document.addEventListener('keydown', () => uiSound.unlock(), { capture: true });
const clickSoundStarts = new WeakMap<Event, number>();
document.addEventListener('click', (event) => {
  clickSoundStarts.set(event, globalThis.performance.now());
}, { capture: true });
document.addEventListener('click', (event) => {
  if (!(event.target instanceof Element) || event.target instanceof HTMLCanvasElement) return;
  const started = clickSoundStarts.get(event);
  if (started !== undefined && uiSound.hasSoundRequestSince(started)) return;
  uiSound.play(soundForClick(event.target));
});
document.addEventListener('input', (event) => {
  if (event.target instanceof HTMLInputElement && event.target.type === 'range') uiSound.play('move');
}, { capture: true });
document.addEventListener('change', (event) => {
  if (event.target instanceof HTMLInputElement && ['checkbox', 'radio'].includes(event.target.type)) uiSound.play('toggle');
  else if (event.target instanceof HTMLSelectElement) uiSound.play('tap');
}, { capture: true });
globalThis.addEventListener('gamepadconnected', refreshDeviceStatus);
globalThis.addEventListener('gamepaddisconnected', refreshDeviceStatus);
refreshDeviceStatus();

globalThis.addEventListener('resize', () => {
  scene.resize();
  handOverlay.clear();
});
globalThis.addEventListener('pointermove', (event) => {
  const target = event.target;
  if (!(target instanceof Element)) return;
  const panel = target.closest<HTMLElement>('.glass');
  if (!panel) return;
  const bounds = panel.getBoundingClientRect();
  panel.style.setProperty('--glass-x', `${event.clientX - bounds.left}px`);
  panel.style.setProperty('--glass-y', `${event.clientY - bounds.top}px`);
});
globalThis.addEventListener('online', () => {
  updateConnectionStatus();
  notify('Back online.');
});
globalThis.addEventListener('offline', () => {
  updateConnectionStatus();
  notify('Offline mode. Cached apps and local data remain available.');
});
globalThis.addEventListener('keydown', (event) => {
  if (scene.handlePhysicalKey(event)) {
    event.preventDefault();
    return;
  }
  if (event.key === 'Escape') {
    if (modalBackdrop.classList.contains('open')) closeModal();
    else if (universalKeyboard.isOpen) closeKeyboard();
    else if (utilityPanel.classList.contains('open')) closeUtility();
    else if (vrActive) setVrActive(false);
    else {
      toggleLauncher(false);
      toggleSettings(false);
    }
    return;
  }
  if (event.ctrlKey || event.metaKey || event.altKey) return;
  const target = event.target;
  const typing = target instanceof HTMLElement && (target.matches('input, textarea, select') || target.isContentEditable);
  if (typing || modalBackdrop.classList.contains('open') || event.repeat) return;
  const key = event.key.toLowerCase();
  if (key === 'l') toggleLauncher();
  else if (key === 'h') void toggleHandControls();
  else if (key === 'g') showControlsGuide();
  else if (key === 'a') scene.arrangeWindowsSurround();
  else if (key === 'k') toggleKeyboard();
  else if (key === 'p') scene.toggleFocusedWindowPin();
});

updateConnectionStatus();
setStatus('motion-status', 'Touch look');
setStatus('camera-status', 'Camera off');
void storage.open().catch((error: unknown) => notify(error instanceof Error ? error.message : 'Local storage is unavailable.'));
void initializePanoramaLibrary().then(() => {
  if (settings.environment.startsWith('custom:') && !getPanoramaUrl(settings.environment)) updateSettings({ environment: 'loft' });
  scene.refreshEnvironment();
  if (utilityMode === 'library') utilityRender?.();
}).catch((error: unknown) => notify(error instanceof Error ? error.message : 'Custom panoramas are unavailable.'));

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  globalThis.addEventListener('load', () => {
    void navigator.serviceWorker.register(`${import.meta.env.BASE_URL}service-worker.js`).catch((error: unknown) => {
      notify(`Offline setup failed: ${error instanceof Error ? error.message : 'service worker unavailable'}`);
    });
  });
}

requestAnimationFrame(() => {
  requestAnimationFrame(() => {
    element('boot').classList.add('done');
    toggleLauncher(true);
  });
});
