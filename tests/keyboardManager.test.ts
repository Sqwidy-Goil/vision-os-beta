import { afterEach, describe, expect, it, vi } from 'vitest';
import { Mesh, MeshPhysicalMaterial, PerspectiveCamera, Quaternion, Raycaster, Scene, Vector3, type BufferGeometry } from 'three';
import { UniversalKeyboardManager } from '../src/input/keyboardManager';
import {
  createCurvedSurfaceGeometry,
  curvedSurfacePoint,
  surfacePointAtUV,
} from '../src/input/spatialKeyboard';
import { DomTextTarget } from '../src/input/domKeyboard';
import { SessionTextTarget } from '../src/input/textTarget';
import type { KeyboardLayout } from '../src/types';

type SelectionDirection = 'forward' | 'backward' | 'none';
type FakeNode = FakeInput | FakeContentEditable | FakeTextNode;

class FakeTextNode {
  readonly nodeType = 3;
  parentNode: FakeContentEditable | null = null;

  constructor(public textContent = '') {}
}

class FakeRange {
  startContainer: FakeNode | null = null;
  endContainer: FakeNode | null = null;
  startOffset = 0;
  endOffset = 0;

  get collapsed(): boolean {
    return this.startContainer === this.endContainer && this.startOffset === this.endOffset;
  }

  get commonAncestorContainer(): FakeNode | null {
    return this.startContainer;
  }

  cloneRange(): FakeRange {
    const range = new FakeRange();
    range.startContainer = this.startContainer;
    range.endContainer = this.endContainer;
    range.startOffset = this.startOffset;
    range.endOffset = this.endOffset;
    return range;
  }

  selectNodeContents(target: FakeContentEditable | FakeTextNode): void {
    const node = target instanceof FakeContentEditable ? target.textNode : target;
    this.startContainer = node;
    this.endContainer = node;
    this.startOffset = 0;
    this.endOffset = node.textContent.length;
  }

  setStart(node: FakeNode, offset: number): void {
    this.startContainer = node;
    this.startOffset = offset;
  }

  setEnd(node: FakeNode, offset: number): void {
    this.endContainer = node;
    this.endOffset = offset;
  }

  setStartAfter(node: FakeTextNode): void {
    if (!node.parentNode) throw new Error('Detached text node.');
    this.startContainer = node.parentNode;
    this.startOffset = 1;
  }

  collapse(toStart: boolean): void {
    if (toStart) {
      this.endContainer = this.startContainer;
      this.endOffset = this.startOffset;
    } else {
      this.startContainer = this.endContainer;
      this.startOffset = this.endOffset;
    }
  }

  deleteContents(): void {
    if (!(this.startContainer instanceof FakeTextNode) || this.startContainer !== this.endContainer) {
      throw new Error('The test range supports one text node.');
    }
    this.startContainer.textContent = this.startContainer.textContent.slice(0, this.startOffset)
      + this.startContainer.textContent.slice(this.endOffset);
    this.collapse(true);
  }

  insertNode(node: FakeTextNode): void {
    if (!(this.startContainer instanceof FakeTextNode)) throw new Error('The test range inserts into text nodes.');
    this.startContainer.textContent = this.startContainer.textContent.slice(0, this.startOffset)
      + node.textContent
      + this.startContainer.textContent.slice(this.startOffset);
    node.parentNode = this.startContainer.parentNode;
  }

  toString(): string {
    if (this.startContainer !== this.endContainer || !(this.startContainer instanceof FakeTextNode)) return '';
    return this.startContainer.textContent.slice(this.startOffset, this.endOffset);
  }
}

class FakeSelection {
  private range: FakeRange | null = null;

  get rangeCount(): number {
    return this.range ? 1 : 0;
  }

  getRangeAt(index: number): FakeRange {
    if (index !== 0 || !this.range) throw new Error('Range does not exist.');
    return this.range;
  }

  removeAllRanges(): void {
    this.range = null;
  }

  addRange(range: FakeRange): void {
    this.range = range.cloneRange();
  }
}

interface TestView {
  location: { origin: string };
  top: TestView;
  InputEvent?: typeof InputEvent;
}

function rootView(): TestView {
  const view = { location: { origin: 'https://app.test' } } as TestView;
  view.top = view;
  return view;
}

class FakeDocument {
  readonly defaultView = rootView();
  activeElement: unknown = null;
  selection: FakeSelection | null = null;
  private readonly listeners = new Map<string, Set<(event: Event) => void>>();

  addEventListener(type: string, listener: (event: Event) => void): void {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: (event: Event) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  focus(target: unknown): void {
    this.activeElement = target;
    this.emit('focusin', target);
  }

  blur(): void {
    this.activeElement = null;
  }

  emit(type: string, target: unknown): void {
    const event = new Event(type);
    Object.defineProperty(event, 'target', { value: target });
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  createEvent(type = ''): Event {
    return new Event(type);
  }

  createTextNode(text: string): FakeTextNode {
    return new FakeTextNode(text);
  }

  createRange(): FakeRange {
    return new FakeRange();
  }

  createTreeWalker(root: FakeContentEditable): { nextNode: () => FakeTextNode | null } {
    let read = false;
    return {
      nextNode: () => {
        if (read) return null;
        read = true;
        return root.textNode;
      },
    };
  }

  getSelection(): FakeSelection | null {
    return this.selection;
  }
}

class FakeInput extends EventTarget {
  readonly nodeType = 1;
  readonly parentNode = null;
  readonly parentElement = null;
  readonly isConnected = true;
  readonly ownerDocument: Document;
  readonly rangeTextCalls: Array<{ text: string; start: number; end: number; mode: string }> = [];
  type = 'text';
  disabled = false;
  readOnly = false;
  selectionStart = 0;
  selectionEnd = 0;
  selectionDirection: SelectionDirection = 'none';
  placeholder = '';
  form: { requestSubmit: ReturnType<typeof vi.fn> } | null = null;

  constructor(
    readonly tagName: 'INPUT' | 'TEXTAREA',
    readonly document: FakeDocument,
    public value = '',
  ) {
    super();
    this.ownerDocument = document as unknown as Document;
    this.selectionStart = value.length;
    this.selectionEnd = value.length;
  }

  getAttribute(name: string): string | null {
    return name === 'aria-disabled' && this.disabled ? 'true' : null;
  }

  contains(node: unknown): boolean {
    return node === this;
  }

  matches(selector: string): boolean {
    return selector === ':disabled' && this.disabled;
  }

  setRangeText(text: string, start: number, end: number, mode = 'end'): void {
    this.rangeTextCalls.push({ text, start, end, mode });
    this.value = this.value.slice(0, start) + text + this.value.slice(end);
    this.selectionStart = start + text.length;
    this.selectionEnd = this.selectionStart;
    if (mode === 'end') this.selectionDirection = 'forward';
  }

  setSelectionRange(start: number, end: number, direction: SelectionDirection = 'none'): void {
    this.selectionStart = start;
    this.selectionEnd = end;
    this.selectionDirection = direction;
  }
}

class FakeContentEditable extends EventTarget {
  readonly nodeType = 1;
  readonly tagName = 'DIV';
  readonly isContentEditable = true;
  readonly parentNode = null;
  readonly parentElement = null;
  readonly isConnected = true;
  readonly ownerDocument: Document;
  readonly textNode: FakeTextNode;

  constructor(readonly document: FakeDocument, text: string) {
    super();
    this.ownerDocument = document as unknown as Document;
    this.textNode = new FakeTextNode(text);
    this.textNode.parentNode = this;
  }

  get textContent(): string {
    return this.textNode.textContent;
  }

  getAttribute(name: string): string | null {
    if (name === 'contenteditable') return 'true';
    return null;
  }

  contains(node: unknown): boolean {
    return node === this || node === this.textNode;
  }
}

const managers: UniversalKeyboardManager[] = [];

function setupManager(options: {
  layout?: KeyboardLayout;
  transparency?: number;
  vrActive?: () => boolean;
  notify?: (message: string) => void;
  shouldAutoShow?: (context: { target: HTMLElement; vrActive: boolean; coarsePointer: boolean }) => boolean;
} = {}) {
  let layout = options.layout ?? 'azerty';
  const notify = options.notify ?? vi.fn();
  const manager = new UniversalKeyboardManager({
    getLayout: () => layout,
    getTransparency: () => options.transparency ?? 0.78,
    isVrActive: options.vrActive ?? (() => false),
    notify,
    shouldAutoShow: options.shouldAutoShow,
  });
  managers.push(manager);
  const scene = new Scene();
  manager.attach(scene);
  manager.update(new Vector3(), new Quaternion(), 0, false);
  return {
    manager,
    scene,
    notify,
    setLayout: (next: KeyboardLayout) => { layout = next; },
  };
}

function installKeyboardCanvas() {
  const fillText = vi.fn();
  const context = {
    clearRect: vi.fn(),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    arcTo: vi.fn(),
    closePath: vi.fn(),
    fill: vi.fn(),
    stroke: vi.fn(),
    fillRect: vi.fn(),
    fillText,
    measureText: vi.fn((text: string) => ({ width: text.length * 8 })),
  } as unknown as CanvasRenderingContext2D;
  const canvas = { width: 0, height: 0, getContext: () => context } as unknown as HTMLCanvasElement;
  vi.stubGlobal('document', {
    createElement: vi.fn(() => canvas),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });
  return { fillText };
}

function press(manager: UniversalKeyboardManager, key: string): void {
  expect(manager.press(key), key).toBe(true);
}

function pointerAt(manager: UniversalKeyboardManager, key: string): void {
  const uv = manager.keyboard.keyCenter(key);
  if (!uv) throw new Error(`Missing key region ${key}`);
  expect(manager.pointer(uv.u, uv.v), key).toBe(true);
}

function physicalKey(key: string, modifiers: Partial<KeyboardEvent> = {}): KeyboardEvent {
  return {
    key,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    repeat: false,
    defaultPrevented: false,
    isComposing: false,
    preventDefault: vi.fn(),
    ...modifiers,
  } as unknown as KeyboardEvent;
}

function editEvents(input: EventTarget): string[] {
  const events: string[] = [];
  input.addEventListener('input', () => events.push('input'));
  input.addEventListener('change', () => events.push('change'));
  return events;
}

afterEach(() => {
  for (const manager of managers.splice(0)) manager.destroy();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('UniversalKeyboardManager sessions', () => {
  it('keeps its world placement across close, reopen and head movement until explicitly repositioned', async () => {
    const { manager } = setupManager();
    const firstResult = manager.open({ title: 'First', value: '', submitLabel: 'Save' });
    manager.update(new Vector3(), new Quaternion(), 0.016, true, 70, 1, 0.08);
    const firstPosition = manager.keyboard.group.position.clone();
    const firstQuaternion = manager.keyboard.group.quaternion.clone();
    const firstScale = manager.keyboard.group.scale.clone();
    manager.close(false);
    await expect(firstResult).resolves.toBeNull();

    const secondResult = manager.open({ title: 'Second', value: '', submitLabel: 'Save' });
    const movedPosition = new Vector3(3, 2, 1);
    const movedQuaternion = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), Math.PI / 2);
    manager.update(movedPosition, movedQuaternion, 0.016, true, 70, 1, 0.08);
    expect(manager.keyboard.group.position.distanceTo(firstPosition)).toBeLessThan(0.000001);
    expect(manager.keyboard.group.quaternion.angleTo(firstQuaternion)).toBeLessThan(0.000001);
    expect(manager.keyboard.group.scale.distanceTo(firstScale)).toBeLessThan(0.000001);

    manager.keyboard.reposition();
    manager.update(movedPosition, movedQuaternion, 0.016, true, 70, 1, 0.08);
    expect(manager.keyboard.group.position.distanceTo(firstPosition)).toBeGreaterThan(0.1);
    manager.close(false);
    await expect(secondResult).resolves.toBeNull();
  });

  it('cycles World, Head and Individual positioning with distinct camera behavior', async () => {
    const { manager } = setupManager();
    const result = manager.open({ title: 'Positioning', value: '', submitLabel: 'Save' });
    const firstPosition = new Vector3(0, 1.6, 0);
    const firstQuaternion = new Quaternion();
    manager.update(firstPosition, firstQuaternion, 0.016, true);

    expect(manager.keyboard.positioning).toBe('world');
    const modeUv = manager.keyboard.keyCenter('mode');
    if (!modeUv) throw new Error('Missing positioning mode action');
    expect(manager.keyboard.promptTarget(modeUv.u, modeUv.v)?.key).toBe('mode');
    manager.keyboard.promptTarget(modeUv.u, modeUv.v)?.action();
    expect(manager.keyboard.positioning).toBe('head');
    const headLocalPosition = manager.keyboard.group.position.clone().sub(firstPosition);
    const headLocalQuaternion = firstQuaternion.clone().invert().multiply(manager.keyboard.group.quaternion);
    const secondPosition = new Vector3(2, 2, -3);
    const secondQuaternion = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), Math.PI / 2);
    manager.update(secondPosition, secondQuaternion, 0.016, true);
    const expectedHeadPosition = headLocalPosition.clone().applyQuaternion(secondQuaternion).add(secondPosition);
    expect(manager.keyboard.group.position.distanceTo(expectedHeadPosition)).toBeLessThan(0.000001);
    expect(manager.keyboard.group.quaternion.angleTo(secondQuaternion.clone().multiply(headLocalQuaternion))).toBeLessThan(0.000001);

    press(manager, 'mode');
    expect(manager.keyboard.positioning).toBe('individual');
    const fixedPosition = manager.keyboard.group.position.clone();
    const individualQuaternion = secondQuaternion.clone().invert().multiply(manager.keyboard.group.quaternion);
    const thirdPosition = new Vector3(-2, 1.8, -4);
    const thirdQuaternion = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), 0.4);
    manager.update(thirdPosition, thirdQuaternion, 0.016, true);
    expect(manager.keyboard.group.position.distanceTo(fixedPosition)).toBeLessThan(0.000001);
    expect(manager.keyboard.group.quaternion.angleTo(thirdQuaternion.clone().multiply(individualQuaternion))).toBeLessThan(0.000001);

    press(manager, 'mode');
    expect(manager.keyboard.positioning).toBe('world');
    const worldPosition = manager.keyboard.group.position.clone();
    const worldQuaternion = manager.keyboard.group.quaternion.clone();
    manager.update(new Vector3(4, 3, -2), secondQuaternion, 0.016, true);
    expect(manager.keyboard.group.position.distanceTo(worldPosition)).toBeLessThan(0.000001);
    expect(manager.keyboard.group.quaternion.angleTo(worldQuaternion)).toBeLessThan(0.000001);
    manager.close(false);
    await expect(result).resolves.toBeNull();
  });

  it('replaces a selection with Unicode and backspaces complete code points', async () => {
    const { manager } = setupManager();
    const result = manager.open({ title: 'Name', value: 'a😀b', submitLabel: 'Save' });
    expect(manager.isOpen).toBe(true);
    manager.setSelection({ start: 1, end: 3 });
    press(manager, 'dead-acute');
    press(manager, 'e');
    expect(manager.text).toBe('aéb');
    press(manager, 'backspace');
    expect(manager.text).toBe('ab');
    press(manager, 'submit');
    await expect(result).resolves.toBe('ab');
    expect(manager.isOpen).toBe(false);
  });

  it('inserts newlines for multiline sessions and reserves modified Enter for commit', async () => {
    const { manager } = setupManager();
    const result = manager.open({ title: 'Note', value: 'first', submitLabel: 'Save', multiline: true });
    press(manager, 'enter');
    expect(manager.text).toBe('first\n');
    expect(manager.isOpen).toBe(true);
    const enter = physicalKey('Enter');
    expect(manager.physicalKey(enter)).toBe(true);
    expect(manager.text).toBe('first\n\n');
    expect(manager.isOpen).toBe(true);
    const commit = physicalKey('Enter', { ctrlKey: true });
    expect(manager.physicalKey(commit)).toBe(true);
    await expect(result).resolves.toBe('first\n\n');
    expect(manager.isOpen).toBe(false);
  });

  it('applies one-shot Shift and AltGr plus sticky Caps', async () => {
    const { manager } = setupManager();
    const result = manager.open({ title: 'Text', value: '', submitLabel: 'Save' });
    press(manager, 'shift');
    press(manager, 'a');
    press(manager, 'a');
    press(manager, 'caps');
    press(manager, 'b');
    press(manager, 'shift');
    press(manager, 'b');
    press(manager, 'caps');
    press(manager, 'altgr');
    press(manager, 'digit-1');
    expect(manager.text).toBe('AaBb~');
    expect(manager.keyboard.isShifted).toBe(false);
    expect(manager.keyboard.isAltGr).toBe(false);
    expect(manager.keyboard.isCapsLocked).toBe(false);
    manager.close(true);
    await expect(result).resolves.toBe('AaBb~');
  });

  it('composes dead accents and emits spacing accents before incompatible text', async () => {
    const { manager } = setupManager();
    const result = manager.open({ title: 'Text', value: '', submitLabel: 'Save' });
    press(manager, 'dead-acute');
    press(manager, 'e');
    press(manager, 'symbols');
    press(manager, 'dead-tilde');
    press(manager, 'letters');
    press(manager, 'n');
    press(manager, 'symbols');
    press(manager, 'dead-circumflex');
    press(manager, 'space');
    expect(manager.text).toBe('éñˆ ');
    manager.close(true);
    await expect(result).resolves.toBe('éñˆ ');
  });

  it('supports physical selection replacement, deletion, and commit without duplicate events', async () => {
    const { manager } = setupManager();
    const result = manager.open({ title: 'Text', value: 'abcd', submitLabel: 'Save' });
    const left = physicalKey('ArrowLeft');
    expect(manager.physicalKey(left)).toBe(true);
    expect(manager.physicalKey(physicalKey('ArrowLeft', { shiftKey: true }))).toBe(true);
    expect(manager.physicalKey(physicalKey('ArrowLeft', { shiftKey: true }))).toBe(true);
    expect(manager.physicalKey(physicalKey('X'))).toBe(true);
    expect(manager.text).toBe('aXd');
    expect(manager.physicalKey(physicalKey('Backspace'))).toBe(true);
    expect(manager.text).toBe('ad');
    const enter = physicalKey('Enter');
    expect(manager.physicalKey(enter)).toBe(true);
    expect(enter.preventDefault).toHaveBeenCalledOnce();
    await expect(result).resolves.toBe('ad');
  });

  it('cancels, resolves a superseded request, and keeps only one active target', async () => {
    const { manager, scene } = setupManager();
    const first = manager.open({ title: 'First', value: 'original', submitLabel: 'Save' });
    press(manager, 'x');
    expect(manager.text).toBe('originalx');
    const second = manager.open({ title: 'Second', value: 'next', submitLabel: 'Save' });
    await expect(first).resolves.toBeNull();
    expect(manager.text).toBe('next');
    manager.close();
    await expect(second).resolves.toBeNull();
    expect(scene.children.filter((child) => child.name === 'UniversalSpatialKeyboard')).toHaveLength(1);
    manager.attach(scene);
    expect(scene.children.filter((child) => child.name === 'UniversalSpatialKeyboard')).toHaveLength(1);
  });

  it('switches language and symbol pages inside the same keyboard', async () => {
    const { manager } = setupManager();
    const result = manager.open({ title: 'Text', value: '', submitLabel: 'Save' });
    const frenchQ = manager.keyboard.keyCenter('q');
    press(manager, 'language');
    expect(manager.keyboard.layout.id).toBe('qwerty');
    expect(manager.keyboard.keyCenter('q')).not.toEqual(frenchQ);
    press(manager, 'symbols');
    expect(manager.keyboard.currentPage).toBe('symbols');
    press(manager, 'symbol-18');
    press(manager, 'letters');
    expect(manager.keyboard.currentPage).toBe('letters');
    expect(manager.text).toBe('€');
    manager.close(true);
    await expect(result).resolves.toBe('€');
  });

  it('enters direct digits and decimal separators from the numeric page', async () => {
    const { manager } = setupManager();
    const result = manager.open({ title: 'Amount', value: '', submitLabel: 'Save' });
    press(manager, 'numbers');
    expect(manager.keyboard.currentPage).toBe('numbers');
    expect(manager.keyboard.keyCenter('number-period')).not.toBeNull();
    press(manager, 'number-1');
    press(manager, 'number-2');
    press(manager, 'number-period');
    press(manager, 'number-5');
    press(manager, 'letters');
    expect(manager.keyboard.currentPage).toBe('letters');
    expect(manager.text).toBe('12.5');
    manager.close(true);
    await expect(result).resolves.toBe('12.5');
  });

  it('allows information and confirmation sessions to submit without text edits', async () => {
    const { manager } = setupManager();
    const info = manager.open({ title: 'Guide', value: 'Read only', submitLabel: 'Done', mode: 'information' });
    press(manager, 'a');
    expect(manager.text).toBe('Read only');
    press(manager, 'submit');
    await expect(info).resolves.toBe('Read only');
    const confirm = manager.open({ title: 'Confirm', value: 'Proceed?', submitLabel: 'Confirm', mode: 'confirm' });
    manager.physicalKey(physicalKey('Escape'));
    await expect(confirm).resolves.toBeNull();
  });
});

describe('session adapter', () => {
  it('supports explicit selection, replacement, commit, and cancel restoration', () => {
    const onCommit = vi.fn();
    const onCancel = vi.fn();
    const target = new SessionTextTarget({
      value: 'a😀b',
      selection: { start: 1, end: 3 },
      onCommit,
      onCancel,
    });
    expect(target.replace('é')).toBe(true);
    expect(target.value).toBe('aéb');
    expect(target.selection).toEqual({ start: 2, end: 2 });
    target.cancel();
    expect(target.value).toBe('a😀b');
    expect(target.selection).toEqual({ start: 1, end: 3 });
    expect(target.replace('x')).toBe(false);
    expect(onCancel).toHaveBeenCalledOnce();
    expect(onCommit).not.toHaveBeenCalled();

    const committed = new SessionTextTarget({ value: 'abc', onCommit });
    committed.setSelection({ start: 0, end: 2 });
    committed.backspace();
    committed.commit();
    expect(onCommit).toHaveBeenCalledWith('c');
  });
});

describe('DOM text adapter and manager', () => {
  it('uses setRangeText on the real selection and emits input then change exactly once', () => {
    const document = new FakeDocument();
    const input = new FakeInput('INPUT', document, 'hello');
    input.selectionStart = 1;
    input.selectionEnd = 4;
    input.selectionDirection = 'backward';
    const events = editEvents(input);
    const keydowns = vi.fn();
    input.addEventListener('keydown', keydowns);
    const { manager } = setupManager();
    manager.openDom(input as unknown as HTMLElement);
    press(manager, 'shift');
    press(manager, 'x');

    expect(input.value).toBe('hXo');
    expect(input.selectionStart).toBe(2);
    expect(input.selectionEnd).toBe(2);
    expect(input.selectionDirection).toBe('backward');
    expect(input.rangeTextCalls).toEqual([{ text: 'X', start: 1, end: 4, mode: 'end' }]);
    expect(events).toEqual(['input', 'change']);
    expect(keydowns).not.toHaveBeenCalled();
  });

  it('does not handle native DOM physical keys or synthesize keydown events', () => {
    const document = new FakeDocument();
    const input = new FakeInput('INPUT', document, 'abc');
    document.focus(input);
    const keydowns = vi.fn();
    input.addEventListener('keydown', keydowns);
    const { manager } = setupManager();
    manager.openDom(input as unknown as HTMLElement);
    const event = physicalKey('x');
    expect(manager.physicalKey(event)).toBe(false);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(input.value).toBe('abc');
    expect(keydowns).not.toHaveBeenCalled();
  });

  it('edits a blurred DOM selection directly without synthesizing a physical keydown', () => {
    const document = new FakeDocument();
    const input = new FakeInput('INPUT', document, 'abc');
    input.selectionStart = 1;
    input.selectionEnd = 1;
    const keydowns = vi.fn();
    input.addEventListener('keydown', keydowns);
    const { manager } = setupManager();
    manager.openDom(input as unknown as HTMLElement);
    const event = physicalKey('é');
    expect(manager.physicalKey(event)).toBe(true);
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(input.value).toBe('aébc');
    expect(keydowns).not.toHaveBeenCalled();
  });

  it('stops editing when a DOM field becomes read-only or disabled', () => {
    const document = new FakeDocument();
    const input = new FakeInput('INPUT', document, 'abc');
    const events = editEvents(input);
    const { manager } = setupManager();
    manager.openDom(input as unknown as HTMLElement);
    input.readOnly = true;
    press(manager, 'x');
    expect(input.value).toBe('abc');
    input.readOnly = false;
    input.disabled = true;
    press(manager, 'y');
    expect(input.value).toBe('abc');
    expect(events).toEqual([]);
  });

  it('replaces and backspaces Unicode without splitting surrogate pairs', () => {
    const document = new FakeDocument();
    const input = new FakeInput('TEXTAREA', document, 'a😀b');
    input.selectionStart = 3;
    input.selectionEnd = 3;
    const { manager } = setupManager();
    manager.openDom(input as unknown as HTMLElement);
    press(manager, 'backspace');
    expect(input.value).toBe('ab');
    manager.setSelection({ start: 0, end: 2 });
    press(manager, 'dead-acute');
    press(manager, 'e');
    expect(input.value).toBe('é');
  });

  it('falls back to value assignment when setRangeText is unavailable', () => {
    const document = new FakeDocument();
    const input = new FakeInput('INPUT', document, 'abc');
    Object.defineProperty(input, 'setRangeText', { value: undefined });
    input.selectionStart = 1;
    input.selectionEnd = 1;
    const { manager } = setupManager();
    manager.openDom(input as unknown as HTMLElement);
    press(manager, 'x');
    expect(input.value).toBe('axbc');
    expect(input.selectionStart).toBe(2);
  });

  it('accepts password fields but rejects read-only, disabled, and non-text controls', () => {
    const document = new FakeDocument();
    const password = new FakeInput('INPUT', document, 'secret');
    password.type = 'password';
    expect(new DomTextTarget(password as unknown as HTMLElement).secret).toBe(true);

    const readOnly = new FakeInput('INPUT', document, 'abc');
    readOnly.readOnly = true;
    const disabled = new FakeInput('INPUT', document, 'abc');
    disabled.disabled = true;
    const button = new FakeInput('INPUT', document, 'abc');
    button.type = 'button';
    const notify = vi.fn();
    const { manager } = setupManager({ notify });
    for (const input of [readOnly, disabled, button]) {
      manager.openDom(input as unknown as HTMLElement);
      expect(manager.isOpen).toBe(false);
    }
    expect(notify).toHaveBeenCalledTimes(3);
  });

  it('rejects cross-origin documents without touching their values', () => {
    const document = new FakeDocument();
    Object.defineProperty(document.defaultView, 'top', {
      get() { throw new Error('Cross-origin window'); },
    });
    const input = new FakeInput('INPUT', document, 'secret');
    expect(() => new DomTextTarget(input as unknown as HTMLElement)).toThrow(/same-origin/);
    expect(input.value).toBe('secret');
  });

  it('edits a contenteditable Range and preserves it after focus moves away', () => {
    const document = new FakeDocument();
    const editable = new FakeContentEditable(document, 'hello');
    const selection = new FakeSelection();
    const range = new FakeRange();
    range.setStart(editable.textNode, 1);
    range.setEnd(editable.textNode, 4);
    selection.addRange(range);
    document.selection = selection;
    const events = editEvents(editable);
    const { manager } = setupManager();
    manager.openDom(editable as unknown as HTMLElement);
    const movedSelection = new FakeSelection();
    document.selection = movedSelection;
    document.blur();
    press(manager, 'shift');
    press(manager, 'x');
    expect(editable.textContent).toBe('hXo');
    expect(events).toEqual(['input', 'change']);
    expect(movedSelection.getRangeAt(0).collapsed).toBe(true);
  });

  it('restores a DOM snapshot on cancel and emits no extra events on commit', () => {
    const document = new FakeDocument();
    const input = new FakeInput('INPUT', document, 'hello');
    input.selectionStart = 1;
    input.selectionEnd = 4;
    const events = editEvents(input);
    const { manager } = setupManager();
    manager.openDom(input as unknown as HTMLElement);
    press(manager, 'x');
    manager.close(false);
    expect(input.value).toBe('hello');
    expect(input.selectionStart).toBe(1);
    expect(input.selectionEnd).toBe(4);
    expect(events).toEqual(['input', 'change', 'input', 'change']);

    manager.openDom(input as unknown as HTMLElement);
    press(manager, 'y');
    manager.close();
    expect(input.value).toBe('hyo');
    expect(events).toEqual(['input', 'change', 'input', 'change', 'input', 'change']);
  });

  it('submits a single-line form without a synthetic keyboard event and inserts newlines in textareas', () => {
    const document = new FakeDocument();
    const input = new FakeInput('INPUT', document, 'abc');
    input.form = { requestSubmit: vi.fn() };
    const keydowns = vi.fn();
    input.addEventListener('keydown', keydowns);
    const { manager } = setupManager();
    manager.openDom(input as unknown as HTMLElement);
    press(manager, 'enter');
    expect(input.form.requestSubmit).toHaveBeenCalledOnce();
    expect(keydowns).not.toHaveBeenCalled();

    const textarea = new FakeInput('TEXTAREA', document, 'abc');
    manager.openDom(textarea as unknown as HTMLElement);
    press(manager, 'enter');
    expect(textarea.value).toBe('abc\n');
  });

  it('previews same-origin DOM text and submits it from the preview action', () => {
    const { fillText } = installKeyboardCanvas();
    const document = new FakeDocument();
    const input = new FakeInput('INPUT', document, 'DOM preview');
    input.form = { requestSubmit: vi.fn() };
    const { manager } = setupManager();
    manager.openDom(input as unknown as HTMLElement);
    manager.update(new Vector3(), new Quaternion(), 0.016, true);
    manager.render();
    expect(fillText.mock.calls.some(([text]) => text === 'DOM preview')).toBe(true);
    const point = manager.keyboard.keyWorldPoint('submit');
    if (!point) throw new Error('Missing DOM preview submit point');
    const target = manager.keyboard.pick(new Raycaster(new Vector3(), point.clone().normalize()));
    expect(target?.key).toBe('submit');
    target?.action();
    expect(input.form.requestSubmit).toHaveBeenCalledOnce();
    expect(manager.isOpen).toBe(true);
  });
});

describe('curved geometry, UV hit testing, and glass press feedback', () => {
  it('builds finite subdivided geometry with monotonic UVs and curved depth', () => {
    const geometry = createCurvedSurfaceGeometry();
    const positions = geometry.getAttribute('position');
    const normals = geometry.getAttribute('normal');
    const uvs = geometry.getAttribute('uv');
    expect(positions.count).toBe(49 * 19);
    expect(uvs.count).toBe(positions.count);
    expect(uvs.getX(0)).toBe(0);
    expect(uvs.getY(0)).toBe(0);
    expect(uvs.getX(positions.count - 1)).toBe(1);
    expect(uvs.getY(positions.count - 1)).toBe(1);
    for (let index = 0; index < positions.count; index += 1) {
      expect(Number.isFinite(positions.getX(index))).toBe(true);
      expect(Number.isFinite(positions.getY(index))).toBe(true);
      expect(Number.isFinite(positions.getZ(index))).toBe(true);
      expect(Number.isFinite(normals.getZ(index))).toBe(true);
    }
    expect(curvedSurfacePoint(1.7, 0).z).toBeGreaterThan(curvedSurfacePoint(0, 0).z + 0.2);
    expect(surfacePointAtUV(0.5, 0.5).z).toBeCloseTo(0);
    expect(curvedSurfacePoint(0, 0).x).toBe(0);
    geometry.dispose();
  });

  it('keeps every key and preview action inside the distorted active-eye viewport', () => {
    const { manager } = setupManager();
    manager.open({ title: 'Fit', value: '', submitLabel: 'Done' });
    const scales: number[] = [];
    for (const [fov, aspect, distortion] of [[50, 0.5, 0.3], [70, 1.016, 0.08], [100, 1.6, 0.08]]) {
      manager.keyboard.reposition();
      const camera = new PerspectiveCamera(fov, aspect, 0.05, 10);
      manager.update(new Vector3(), new Quaternion(), 0.016, true, fov, aspect, distortion);
      camera.updateMatrixWorld(true);
      scales.push(manager.keyboard.group.scale.x);
      const points = ['dead-acute', 'v', 'e', 'cancel', 'submit'].map((key) => ({
        name: key,
        point: manager.keyboard.keyWorldPoint(key),
      }));
      for (const { name, point } of points) {
        expect(point, name).not.toBeNull();
        if (!point) continue;
        point.project(camera);
        const radiusSquared = point.x * point.x + point.y * point.y;
        const lensScale = 1 + distortion * radiusSquared + distortion * 0.35 * radiusSquared * radiusSquared;
        expect(Math.abs(point.x) * lensScale, `horizontal ${name} ${fov}/${aspect}`).toBeLessThanOrEqual(0.97);
        expect(Math.abs(point.y) * lensScale, `vertical ${name} ${fov}/${aspect}`).toBeLessThanOrEqual(0.97);
      }
    }
    expect(scales[0]).toBeGreaterThan(0);
    expect(scales[0]).toBeLessThan(scales[1]);
    expect(scales[1]).toBeLessThanOrEqual(scales[2]);
    expect(scales[2]).toBeLessThanOrEqual(1);
    manager.close(false);
  });

  it('anchors the keyboard in world space when it opens instead of following the head', () => {
    const { manager } = setupManager();
    manager.open({ title: 'Anchored', value: '', submitLabel: 'Done' });
    manager.update(new Vector3(0, 1.6, 0), new Quaternion(), 0.016, true);
    const position = manager.keyboard.group.position.clone();
    const quaternion = manager.keyboard.group.quaternion.clone();
    const moved = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), Math.PI / 2);
    manager.update(new Vector3(4, 2, -3), moved, 0.016, true, 100, 0.5, 0.3);
    expect(manager.keyboard.group.position.equals(position)).toBe(true);
    expect(manager.keyboard.group.quaternion.equals(quaternion)).toBe(true);
    manager.keyboard.reposition();
    manager.update(new Vector3(4, 2, -3), moved, 0.016, true);
    expect(manager.keyboard.group.position.distanceTo(new Vector3(4, 2, -3))).toBeGreaterThan(0.5);
    manager.close(false);
  });

  it('shows the current text beside pickable preview actions without a lower keyboard rim', async () => {
    const { fillText } = installKeyboardCanvas();
    const { manager } = setupManager();
    const result = manager.open({ title: 'Preview', value: 'Current text', submitLabel: 'Save' });
    manager.update(new Vector3(), new Quaternion(), 0.016, true);
    manager.render();
    expect(fillText.mock.calls.some(([text]) => text === 'Current text')).toBe(true);
    expect(manager.keyboard.group.getObjectByName('Curved keyboard rim')).toBeUndefined();
    const prompt = manager.keyboard.group.getObjectByName('Curved keyboard prompt');
    expect(prompt).toBeDefined();
    const point = manager.keyboard.keyWorldPoint('submit');
    expect(point).not.toBeNull();
    if (!point) throw new Error('Missing preview submit point');
    const ray = new Raycaster(new Vector3(), point.clone().normalize());
    const target = manager.keyboard.pick(ray);
    expect(target?.key).toBe('submit');
    target?.action();
    await expect(result).resolves.toBe('Current text');
  });

  it('raycasts curved UVs to the correct individual key and hover region', async () => {
    const { manager } = setupManager();
    const result = manager.open({ title: 'Curved', value: '', submitLabel: 'Save' });
    manager.update(new Vector3(0, 1.6, 0), new Quaternion(), 0.016, true);
    const uv = manager.keyboard.keyCenter('a');
    if (!uv) throw new Error('Missing A key');
    expect(manager.target(uv.u, uv.v)?.key).toBe('a');
    manager.hover(uv.u, uv.v);
    manager.update(new Vector3(), new Quaternion(), 0.1, true);
    expect(manager.keyboard.getKeyState('a')?.hover).toBeGreaterThan(0.8);
    pointerAt(manager, 'a');
    expect(manager.text).toBe('a');
    expect(manager.target(0.01, 0.99)).toBeNull();
    manager.close(false);
    await expect(result).resolves.toBeNull();
  });

  it('animates press depth, scale, rim glow, and layered transparent glass', async () => {
    const { manager } = setupManager({ transparency: 0.82 });
    const result = manager.open({ title: 'Glass', value: '', submitLabel: 'Save' });
    const keyGroup = manager.keyboard.group.getObjectByName('Key a');
    if (!keyGroup) throw new Error('Missing key group');
    const body = keyGroup.children.find((child) => child instanceof Mesh
      && child.material instanceof MeshPhysicalMaterial
      && child.material.transmission > 0.3) as Mesh<BufferGeometry, MeshPhysicalMaterial>;
    expect(body).toBeDefined();
    expect(body.material.transparent).toBe(true);
    expect(body.material.clearcoat).toBe(1);
    expect(keyGroup.children.length).toBeGreaterThanOrEqual(3);

    pointerAt(manager, 'a');
    expect(manager.keyboard.getKeyState('a')?.press).toBe(1);
    expect(body.material.emissiveIntensity).toBeCloseTo(0.305);
    expect(keyGroup.scale.x).toBeLessThan(1);
    manager.update(new Vector3(), new Quaternion(), 0.35, false);
    expect(manager.keyboard.getKeyState('a')?.press).toBeLessThan(0.01);
    expect(keyGroup.scale.x).toBeCloseTo(1);
    manager.close(false);
    await expect(result).resolves.toBeNull();
  });
});

describe('auto-show policy', () => {
  it('exposes VR/coarse-pointer context and removes its document listener on destroy', () => {
    const document = new FakeDocument();
    const fakeWindow = document.defaultView;
    Object.assign(fakeWindow, { matchMedia: vi.fn(() => ({ matches: false })) });
    vi.stubGlobal('document', document);
    vi.stubGlobal('window', fakeWindow);
    vi.stubGlobal('navigator', { maxTouchPoints: 0 });
    let vrActive = false;
    const policy = vi.fn((context: { vrActive: boolean; coarsePointer: boolean }) => context.vrActive || context.coarsePointer);
    const { manager } = setupManager({ vrActive: () => vrActive, shouldAutoShow: policy });
    const input = new FakeInput('INPUT', document, 'abc');
    document.focus(input as unknown as HTMLElement);
    expect(manager.isOpen).toBe(false);
    vrActive = true;
    document.focus(input as unknown as HTMLElement);
    expect(manager.isOpen).toBe(true);
    expect(policy).toHaveBeenLastCalledWith(expect.objectContaining({ vrActive: true, coarsePointer: false }));
    manager.destroy();
    document.focus(input as unknown as HTMLElement);
    expect(manager.isOpen).toBe(false);
  });
});
