import { Scene, Vector3, Quaternion } from 'three';
import type { KeyboardLayout, TextRequestOptions } from '../types';
import { selectionBeforeBackspace, type TextSelection } from '../core/virtualKeyboard';
import { uiSound, type UiSoundName } from '../core/uiSound';
import {
  combineDeadAccent,
  resolveKeyboardKey,
  type DeadAccent,
  type KeyboardKeyDefinition,
} from './azertyLayout';
import {
  SpatialKeyboard,
  type SpatialKeyboardPrompt,
  type SpatialKeyboardTarget,
} from './spatialKeyboard';
import { DomTextTarget, findEditableElement } from './domKeyboard';
import {
  SessionTextTarget,
  nextCharacterStart,
  previousCharacterStart,
  type TextTarget,
} from './textTarget';

export interface KeyboardAutoShowContext {
  target: HTMLElement;
  vrActive: boolean;
  coarsePointer: boolean;
}

export type KeyboardAutoShowPolicy = (context: KeyboardAutoShowContext) => boolean;

export interface UniversalKeyboardManagerOptions {
  getLayout: () => KeyboardLayout;
  getTransparency: () => number;
  getAccent?: () => string;
  isVrActive: () => boolean;
  notify: (message: string) => void;
  /** Optional policy for focus-driven auto-show. Defaults to VR or a coarse pointer. */
  shouldAutoShow?: KeyboardAutoShowPolicy;
}

function domTargetHasFocus(target: DomTextTarget): boolean {
  const active = target.document.activeElement as Node | null;
  return active === target.element || (active?.nodeType === 1 && target.element.contains(active));
}

function lineStartAt(value: string, offset: number): number {
  return offset <= 0 ? 0 : value.lastIndexOf('\n', offset - 1) + 1;
}

function coarsePointer(): boolean {
  if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
    try {
      if (window.matchMedia('(pointer: coarse)').matches) return true;
    } catch {
      // A restricted embedded browser can still expose maxTouchPoints.
    }
  }
  return typeof navigator !== 'undefined' && (navigator.maxTouchPoints ?? 0) > 0;
}

function movedSelection(
  selection: TextSelection,
  value: string,
  movement: 'left' | 'right' | 'home' | 'end' | 'up' | 'down',
  extend: boolean,
): TextSelection {
  const direction = selection.direction ?? 'none';
  const focus = direction === 'backward' ? selection.start : selection.end;
  const anchor = direction === 'backward' ? selection.end : selection.start;
  let next = focus;

  if (movement === 'left') next = previousCharacterStart(value, focus);
  if (movement === 'right') next = nextCharacterStart(value, focus);
  if (movement === 'home') next = lineStartAt(value, focus);
  if (movement === 'end') {
    const newline = value.indexOf('\n', focus);
    next = newline === -1 ? value.length : newline;
  }
  if (movement === 'up' || movement === 'down') {
    const lineStart = lineStartAt(value, focus);
    const lineEndIndex = value.indexOf('\n', focus);
    const lineEnd = lineEndIndex === -1 ? value.length : lineEndIndex;
    if (movement === 'up') {
      next = focus === lineStart
        ? Math.max(0, lineStart - 1)
        : lineStart;
    } else {
      const nextLineStart = lineEndIndex === -1 ? value.length : lineEndIndex + 1;
      next = focus === lineEnd ? nextLineStart : lineEnd;
    }
  }

  next = Math.max(0, Math.min(value.length, next));
  if (!extend) return { start: next, end: next };
  const start = Math.min(anchor, next);
  const end = Math.max(anchor, next);
  return {
    start,
    end,
    ...(next < anchor ? { direction: 'backward' as const } : next > anchor ? { direction: 'forward' as const } : {}),
  };
}

/** Owns exactly one text target and exactly one spatial keyboard. */
export class UniversalKeyboardManager {
  readonly keyboard: SpatialKeyboard;

  private readonly options: UniversalKeyboardManagerOptions;
  private activeTarget: TextTarget | null = null;
  private request: TextRequestOptions | null = null;
  private scene: Scene | null = null;
  private autoDocument: Document | null = null;
  private autoShowPolicy: KeyboardAutoShowPolicy;
  private layoutOverride: KeyboardLayout | null = null;
  private pendingAccent: DeadAccent | null = null;
  private ignoreAutoFocusUntil = 0;
  private destroyed = false;

  constructor(options: UniversalKeyboardManagerOptions) {
    this.options = options;
    this.autoShowPolicy = options.shouldAutoShow ?? ((context) => context.vrActive || context.coarsePointer);
    this.keyboard = new SpatialKeyboard({
      getLayout: () => this.layout,
      getTransparency: () => options.getTransparency(),
      getAccent: () => options.getAccent?.() ?? '#75e7ff',
      onPress: (key) => { this.press(key); },
    });
  }

  get isOpen(): boolean {
    return !this.destroyed && this.activeTarget !== null;
  }

  get text(): string {
    return this.activeTarget?.value ?? '';
  }

  get autoShow(): KeyboardAutoShowPolicy {
    return this.autoShowPolicy;
  }

  private get layout(): KeyboardLayout {
    return this.layoutOverride ?? this.options.getLayout();
  }

  attach(scene: Scene): void {
    if (this.destroyed) return;
    if (this.scene === scene) return;
    this.scene?.remove(this.keyboard.group);
    this.scene = scene;
    scene.add(this.keyboard.group);
    this.installAutoShowListeners();
  }

  setAutoShowPolicy(policy: KeyboardAutoShowPolicy | null): void {
    this.autoShowPolicy = policy ?? ((context) => context.vrActive || context.coarsePointer);
  }

  open(options: TextRequestOptions): Promise<string | null> {
    if (this.destroyed) return Promise.resolve(null);
    this.close(false);
    const request: TextRequestOptions = { ...options, mode: options.mode ?? 'text' };
    this.request = request;
    this.layoutOverride = null;
    this.pendingAccent = null;
    this.keyboard.setLayout(this.layout);
    this.keyboard.setPage('letters');
    this.keyboard.resetModifiers();

    return new Promise<string | null>((resolve) => {
      const target = new SessionTextTarget({
        value: request.value,
        secret: request.secret,
        placeholder: request.placeholder,
        readOnly: request.mode !== 'text',
        multiline: request.multiline ?? false,
        onCommit: (value) => {
          this.activeTarget = null;
          this.request = null;
          this.hide();
          target.destroy();
          resolve(value);
        },
        onCancel: () => {
          this.activeTarget = null;
          this.request = null;
          this.hide();
          target.destroy();
          resolve(null);
        },
      });
      this.activeTarget = target;
      this.refreshContext();
      this.keyboard.group.visible = true;
    });
  }

  openDom(target: HTMLElement): void {
    if (this.destroyed) return;
    let adapter: DomTextTarget;
    try {
      adapter = new DomTextTarget(target);
    } catch (error) {
      this.options.notify(error instanceof Error ? error.message : 'The text field cannot be edited.');
      return;
    }

    this.close(true);
    this.activeTarget = adapter;
    this.request = null;
    this.layoutOverride = null;
    this.pendingAccent = null;
    this.keyboard.setLayout(this.layout);
    this.keyboard.setPage('letters');
    this.keyboard.resetModifiers();
    this.refreshContext();
    this.keyboard.group.visible = true;
  }

  close(commit?: boolean): void {
    const target = this.activeTarget;
    if (!target || this.destroyed) return;
    // Dismissing a request is cancellation; dismissing a DOM keyboard keeps its edits.
    const shouldCommit = commit ?? !(target instanceof SessionTextTarget);
    this.activeTarget = null;
    this.request = null;
    this.ignoreAutoFocusUntil = Date.now() + 150;
    this.hide();
    try {
      if (shouldCommit) target.commit();
      else target.cancel();
    } finally {
      target.destroy?.();
    }
  }

  update(cameraPosition: Vector3, cameraQuaternion: Quaternion, delta: number, vrActive: boolean, verticalFov = 70, aspect = 1, distortion = 0): void {
    if (this.destroyed) return;
    if (!this.activeTarget) {
      this.keyboard.group.visible = false;
      return;
    }
    this.keyboard.group.visible = true;
    this.keyboard.update(delta, cameraPosition, cameraQuaternion, vrActive, verticalFov, aspect, distortion);
  }

  render(): void {
    if (!this.destroyed && this.activeTarget) this.keyboard.render();
  }

  target(u: number, v: number): SpatialKeyboardTarget | null {
    return this.isOpen ? this.keyboard.target(u, v) : null;
  }

  pointer(u: number, v: number): boolean {
    const target = this.target(u, v);
    if (!target) return false;
    target.action();
    return true;
  }

  hover(u: number, v: number): void {
    if (this.isOpen) this.keyboard.hover(u, v);
    else this.keyboard.clearHover();
  }

  clearHover(): void {
    this.keyboard.clearHover();
  }

  /** Returns true only when the manager consumed the event; it never dispatches synthetic keydowns. */
  physicalKey(event: KeyboardEvent): boolean {
    const target = this.activeTarget;
    if (!target || this.destroyed || event.defaultPrevented || event.isComposing) return false;
    // A focused DOM field already receives the browser's native physical-key edit.
    // When canvas/panel focus owns the event, edit the stored selection directly instead.
    if (target instanceof DomTextTarget && domTargetHasFocus(target)) return false;

    if (event.key === 'Escape') {
      uiSound.play('back');
      this.close(false);
      event.preventDefault();
      return true;
    }
    if (event.key === 'Enter') {
      uiSound.play(target.multiline && !event.ctrlKey && !event.metaKey ? 'key' : 'confirm');
      if (target.multiline && !event.ctrlKey && !event.metaKey) {
        if (this.insertText('\n', false)) event.preventDefault();
      } else if (target instanceof DomTextTarget) {
        target.submit();
        event.preventDefault();
      } else {
        this.close(true);
        event.preventDefault();
      }
      return true;
    }
    if (event.ctrlKey || event.metaKey) return false;
    if (event.key === 'Backspace') {
      uiSound.play('key');
      const selection = target.selection;
      const deletion = selectionBeforeBackspace(target.value, selection);
      if (deletion.start !== deletion.end) target.replace('', deletion);
      this.afterEdit();
      event.preventDefault();
      return true;
    }
    if (event.key === 'Delete') {
      uiSound.play('key');
      const selection = target.selection;
      const deletion = selection.start === selection.end
        ? { start: selection.end, end: nextCharacterStart(target.value, selection.end) }
        : selection;
      if (deletion.start !== deletion.end) target.replace('', deletion);
      this.afterEdit();
      event.preventDefault();
      return true;
    }
    if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) {
      uiSound.play('move');
      const movement = event.key === 'ArrowLeft' ? 'left'
        : event.key === 'ArrowRight' ? 'right'
          : event.key === 'ArrowUp' ? 'up'
            : event.key === 'ArrowDown' ? 'down'
              : event.key === 'Home' ? 'home' : 'end';
      target.setSelection(movedSelection(target.selection, target.value, movement, event.shiftKey));
      event.preventDefault();
      return true;
    }
    if (Array.from(event.key).length === 1) {
      const applied = this.insertText(event.key);
      if (applied) event.preventDefault();
      return applied;
    }
    return false;
  }

  setSelection(selection: TextSelection): boolean {
    return this.activeTarget?.setSelection(selection) ?? false;
  }

  /** Programmatic equivalent of pressing a current key; primarily useful to integrations and tests. */
  press(key: string | KeyboardKeyDefinition): boolean {
    if (!this.isOpen) return false;
    const definition = typeof key === 'string' ? this.keyboard.getKey(key) : key;
    if (!definition) return false;
    this.handleKey(definition);
    return true;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.close(false);
    this.removeAutoShowListeners();
    this.keyboard.destroy();
    this.scene = null;
    this.destroyed = true;
  }

  private handleKey(key: KeyboardKeyDefinition): void {
    const target = this.activeTarget;
    if (!target) return;
    const action = key.action ?? 'character';
    const modifierActions = new Set(['shift', 'caps', 'altgr', 'language', 'numbers', 'symbols', 'letters', 'mode']);
    const movementActions = new Set(['left', 'right', 'up', 'down', 'home', 'end']);
    const sound: UiSoundName = modifierActions.has(action) ? 'toggle'
      : movementActions.has(action) ? 'move'
        : action === 'cancel' || action === 'close' ? 'back'
          : action === 'enter' || action === 'submit' ? 'confirm'
            : 'key';
    uiSound.play(sound);
    switch (key.action) {
      case 'shift':
        this.keyboard.toggleShift();
        return;
      case 'caps':
        this.keyboard.toggleCaps();
        return;
      case 'altgr':
        this.keyboard.toggleAltGr();
        return;
      case 'language':
        this.layoutOverride = this.layout === 'azerty' ? 'qwerty' : 'azerty';
        this.keyboard.setLayout(this.layoutOverride);
        return;
      case 'numbers':
        this.keyboard.setPage('numbers');
        return;
      case 'symbols':
        this.keyboard.setPage('symbols');
        return;
      case 'letters':
        this.keyboard.setPage('letters');
        return;
      case 'backspace': {
        if (target.readOnly) return;
        const selection = target.selection;
        const deletion = selectionBeforeBackspace(target.value, selection);
        if (deletion.start !== deletion.end) target.replace('', deletion);
        this.afterEdit();
        return;
      }
      case 'delete': {
        if (target.readOnly) return;
        const selection = target.selection;
        const deletion = selection.start === selection.end
          ? { start: selection.end, end: nextCharacterStart(target.value, selection.end) }
          : selection;
        if (deletion.start !== deletion.end) target.replace('', deletion);
        this.afterEdit();
        return;
      }
      case 'left':
      case 'right':
      case 'up':
      case 'down':
      case 'home':
      case 'end':
        target.setSelection(movedSelection(target.selection, target.value, key.action, false));
        return;
      case 'space':
        this.insertText(' ', false);
        return;
      case 'enter':
        if (target instanceof DomTextTarget) {
          if (target.multiline) this.insertText('\n', false);
          else target.submit();
        } else if (target.multiline) {
          this.insertText('\n', false);
        } else {
          this.close(true);
        }
        return;
      case 'mode':
        this.keyboard.cyclePositioning();
        return;
      case 'submit':
        if (target instanceof DomTextTarget) target.submit();
        else this.close(true);
        return;
      case 'cancel':
        this.close(false);
        return;
      case 'close':
        this.close(true);
        return;
      default:
        break;
    }

    const resolved = resolveKeyboardKey(key, this.keyboard.modifiers);
    if (!resolved.text) return;
    if (resolved.accent) {
      this.pendingAccent = this.pendingAccent === resolved.accent ? null : resolved.accent;
      this.keyboard.setPendingAccent(this.pendingAccent);
      return;
    }
    this.insertText(resolved.text, false);
  }

  private insertText(text: string, audible = true): boolean {
    const target = this.activeTarget;
    if (!target || target.readOnly) return false;
    const accent = this.pendingAccent;
    const replacement = accent ? combineDeadAccent(text, accent) : text;
    const applied = target.replace(replacement);
    if (applied && accent) {
      this.pendingAccent = null;
      this.keyboard.setPendingAccent(null);
    }
    if (applied) {
      if (audible) uiSound.play('key');
      this.keyboard.consumeTextModifiers();
      this.afterEdit();
    }
    return applied;
  }

  private afterEdit(): void {
    this.refreshContext();
  }

  private refreshContext(): void {
    const target = this.activeTarget;
    const prompt = target instanceof SessionTextTarget && this.request
      ? this.sessionPrompt(target, this.request)
      : target instanceof DomTextTarget
        ? {
            title: target.secret ? 'Secure text' : 'Text input',
            value: target.value,
            secret: target.secret,
            submitLabel: target.multiline ? 'Done' : 'Submit',
            cancelLabel: 'Cancel',
            mode: 'text' as const,
          }
        : null;
    this.keyboard.setContext(prompt);
  }

  private sessionPrompt(target: SessionTextTarget, request: TextRequestOptions): SpatialKeyboardPrompt {
    return {
      title: request.title,
      value: target.value,
      placeholder: target.placeholder,
      secret: target.secret,
      submitLabel: request.submitLabel,
      cancelLabel: request.cancelLabel,
      mode: request.mode,
    };
  }

  private hide(): void {
    this.layoutOverride = null;
    this.pendingAccent = null;
    this.keyboard.group.visible = false;
    this.keyboard.clearHover();
    this.keyboard.resetModifiers();
  }

  private installAutoShowListeners(): void {
    const ownerDocument = typeof document === 'undefined' ? null : document;
    if (!ownerDocument || this.autoDocument === ownerDocument) return;
    this.removeAutoShowListeners();
    this.autoDocument = ownerDocument;
    ownerDocument.addEventListener('focusin', this.handleAutoFocus);
  }

  private removeAutoShowListeners(): void {
    this.autoDocument?.removeEventListener('focusin', this.handleAutoFocus);
    this.autoDocument = null;
  }

  private readonly handleAutoFocus = (event: FocusEvent): void => {
    if (this.destroyed || Date.now() < this.ignoreAutoFocusUntil) return;
    const editable = findEditableElement(event.target as Node | null);
    if (!editable || (this.activeTarget instanceof DomTextTarget && this.activeTarget.element === editable)) return;
    const context: KeyboardAutoShowContext = {
      target: editable,
      vrActive: this.options.isVrActive(),
      coarsePointer: coarsePointer(),
    };
    if (this.autoShowPolicy(context)) this.openDom(editable);
  };
}
