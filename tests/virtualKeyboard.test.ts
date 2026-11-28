import { describe, expect, it } from 'vitest';
import {
  applyKeyboardCase,
  backspaceText,
  replaceTextSelection,
  VirtualKeyboardController,
  type SelectionDirection,
} from '../src/core/virtualKeyboard';

class FakeTextNode {
  readonly nodeType = 3;
  parentNode: FakeContentEditable | null = null;

  constructor(public textContent = '') {}
}

class FakeContentEditable extends EventTarget {
  readonly nodeType = 1;
  readonly tagName = 'DIV';
  readonly isContentEditable = true;
  readonly parentNode = null;
  readonly parentElement = null;
  readonly textNode: FakeTextNode;

  constructor(text: string) {
    super();
    this.textNode = new FakeTextNode(text);
    this.textNode.parentNode = this;
  }

  get textContent(): string {
    return this.textNode.textContent;
  }

  getAttribute(name: string): string | null {
    return name === 'contenteditable' ? 'true' : null;
  }

  contains(node: unknown): boolean {
    return node === this
      || node === this.textNode
      || (node instanceof FakeTextNode && node.parentNode === this);
  }
}

class FakeRange {
  startContainer: FakeContentEditable | FakeTextNode | null = null;
  endContainer: FakeContentEditable | FakeTextNode | null = null;
  startOffset = 0;
  endOffset = 0;

  get collapsed(): boolean {
    return this.startContainer === this.endContainer && this.startOffset === this.endOffset;
  }

  get commonAncestorContainer(): FakeContentEditable | FakeTextNode | null {
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

  setStart(node: FakeContentEditable | FakeTextNode, offset: number): void {
    this.startContainer = node;
    this.startOffset = offset;
  }

  setEnd(node: FakeContentEditable | FakeTextNode, offset: number): void {
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
    if (this.startContainer !== this.endContainer || !(this.startContainer instanceof FakeTextNode)) {
      throw new Error('The test range only supports a single text node.');
    }
    this.startContainer.textContent = this.startContainer.textContent.slice(0, this.startOffset)
      + this.startContainer.textContent.slice(this.endOffset);
    this.collapse(true);
  }

  insertNode(node: FakeTextNode): void {
    if (!(this.startContainer instanceof FakeTextNode)) {
      throw new Error('The test range only inserts into a text node.');
    }
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

class FakeInput extends EventTarget {
  readonly nodeType = 1;
  readonly parentNode = null;
  readonly parentElement = null;
  type = 'text';
  disabled = false;
  readOnly = false;
  selectionStart = 0;
  selectionEnd = 0;
  selectionDirection: SelectionDirection = 'none';
  readonly rangeTextCalls: Array<{ text: string; start: number; end: number; mode: string }> = [];

  constructor(readonly tagName: 'INPUT' | 'TEXTAREA', public value = '') {
    super();
  }

  contains(node: unknown): boolean {
    return node === this;
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

class FakeDocument {
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

  createEvent(): Event {
    return new Event('virtual-keyboard');
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

function setupInput(value = '', tagName: 'INPUT' | 'TEXTAREA' = 'INPUT') {
  const document = new FakeDocument();
  const input = new FakeInput(tagName, value);
  const controller = new VirtualKeyboardController({ document: document as unknown as Document });
  document.focus(input);
  return { document, input, controller };
}

describe('virtual keyboard text editing', () => {
  it('inserts at the caret and replaces only the current selection', () => {
    expect(replaceTextSelection('ab', { start: 1, end: 1 }, 'XY')).toEqual({
      value: 'aXYb', start: 3, end: 3,
    });
    expect(replaceTextSelection('hello', { start: 1, end: 4, direction: 'backward' }, 'X')).toEqual({
      value: 'hXo', start: 2, end: 2, direction: 'backward',
    });
  });

  it('normalizes reversed and out-of-bounds selections', () => {
    expect(replaceTextSelection('ab', { start: 2, end: 0 }, 'X')).toEqual({
      value: 'X', start: 1, end: 1,
    });
    expect(replaceTextSelection('ab', { start: 99, end: 1 }, 'X')).toEqual({
      value: 'aX', start: 2, end: 2,
    });
  });

  it('backspaces a selection or one complete previous Unicode character', () => {
    expect(backspaceText('hello', { start: 1, end: 4 })).toEqual({ value: 'ho', start: 1, end: 1 });
    expect(backspaceText('a😀b', { start: 3, end: 3 })).toEqual({ value: 'ab', start: 1, end: 1 });
    expect(backspaceText('abc', { start: 0, end: 0 })).toEqual({ value: 'abc', start: 0, end: 0 });
  });

  it('applies one-shot shift and sticky caps without changing unshifted text', () => {
    expect(applyKeyboardCase('a!', false, false)).toBe('a!');
    expect(applyKeyboardCase('a!', true, false)).toBe('A!');
    expect(applyKeyboardCase('a!', false, true)).toBe('A!');
    expect(applyKeyboardCase('A!', true, true)).toBe('a!');
  });
});

describe('VirtualKeyboardController', () => {
  it('uses the last focused input, setRangeText, and emits input then change', () => {
    const document = new FakeDocument();
    const first = new FakeInput('INPUT', 'first');
    const second = new FakeInput('INPUT', 'hello');
    const controller = new VirtualKeyboardController({ document: document as unknown as Document });
    const events: string[] = [];
    second.addEventListener('input', () => events.push('input'));
    second.addEventListener('change', () => events.push('change'));

    document.focus(first);
    document.focus(second);
    second.selectionStart = 1;
    second.selectionEnd = 4;
    second.selectionDirection = 'backward';
    document.emit('select', second);
    document.blur();

    expect(controller.insert('X')).toBe(true);
    expect(controller.target).toBe(second);
    expect(second.value).toBe('hXo');
    expect(second.selectionStart).toBe(2);
    expect(second.selectionEnd).toBe(2);
    expect(second.selectionDirection).toBe('backward');
    expect(second.rangeTextCalls).toEqual([{ text: 'X', start: 1, end: 4, mode: 'end' }]);
    expect(events).toEqual(['input', 'change']);
  });

  it('backspaces a selection, then the previous character, without events at the start', () => {
    const { input, controller } = setupInput('hello');
    const events: string[] = [];
    input.addEventListener('input', () => events.push('input'));
    input.addEventListener('change', () => events.push('change'));
    input.selectionStart = 1;
    input.selectionEnd = 4;

    expect(controller.backspace()).toBe(true);
    expect(input.value).toBe('ho');
    expect(input.selectionStart).toBe(1);
    expect(controller.backspace()).toBe(true);
    expect(input.value).toBe('o');

    input.selectionStart = 0;
    input.selectionEnd = 0;
    expect(controller.backspace()).toBe(false);
    expect(input.value).toBe('o');
    expect(events).toEqual(['input', 'change', 'input', 'change']);
  });

  it('exposes bound button actions for shift, caps, space, and enter', () => {
    const { input, controller } = setupInput('', 'TEXTAREA');
    const { actions } = controller;

    expect(actions.toggleShift()).toBe(true);
    expect(actions.press('a')).toBe(true);
    expect(controller.isShifted).toBe(false);
    expect(actions.toggleCaps()).toBe(true);
    expect(actions.press('b')).toBe(true);
    expect(actions.toggleShift()).toBe(true);
    expect(actions.press('c')).toBe(true);
    expect(actions.toggleCaps()).toBe(false);
    expect(actions.space()).toBe(true);
    expect(actions.enter()).toBe(true);

    expect(input.value).toBe('ABc \n');
    expect(input.selectionStart).toBe(input.value.length);
    expect(input.selectionEnd).toBe(input.value.length);
  });

  it('dispatches Enter for single-line inputs without inserting a newline', () => {
    const { input, controller } = setupInput('abc');
    const keys: string[] = [];
    input.addEventListener('keydown', (event) => keys.push((event as KeyboardEvent).key));

    expect(controller.actions.enter()).toBe(true);
    expect(input.value).toBe('abc');
    expect(keys).toEqual(['Enter']);
  });

  it('closes through the action API, resets modifiers, and can reopen', () => {
    const document = new FakeDocument();
    const input = new FakeInput('INPUT');
    let closeCount = 0;
    const controller = new VirtualKeyboardController({
      document: document as unknown as Document,
      onClose: () => { closeCount += 1; },
    });
    document.focus(input);
    controller.toggleShift();
    controller.toggleCaps();

    controller.actions.press('close');
    expect(controller.isOpen).toBe(false);
    expect(controller.isShifted).toBe(false);
    expect(controller.isCapsLocked).toBe(false);
    expect(controller.insert('x')).toBe(false);
    controller.close();
    expect(closeCount).toBe(1);

    controller.actions.press('open');
    expect(controller.isOpen).toBe(true);
    expect(controller.insert('x')).toBe(true);
    expect(input.value).toBe('x');
  });

  it('falls back to value assignment and ignores read-only inputs', () => {
    const { input, controller } = setupInput('abc');
    Object.defineProperty(input, 'setRangeText', { value: undefined });
    input.selectionStart = 1;
    input.selectionEnd = 1;

    expect(controller.insert('X')).toBe(true);
    expect(input.value).toBe('aXbc');
    expect(input.selectionStart).toBe(2);

    const events: string[] = [];
    input.addEventListener('input', () => events.push('input'));
    input.addEventListener('change', () => events.push('change'));
    input.readOnly = true;
    expect(controller.insert('Y')).toBe(false);
    expect(input.value).toBe('aXbc');
    expect(events).toEqual([]);
  });

  it('retains a contenteditable range after panel focus and edits it as text', () => {
    const document = new FakeDocument();
    const editable = new FakeContentEditable('hello');
    const selection = new FakeSelection();
    const range = new FakeRange();
    range.setStart(editable.textNode, 1);
    range.setEnd(editable.textNode, 4);
    selection.addRange(range);
    document.selection = selection;
    const controller = new VirtualKeyboardController({ document: document as unknown as Document });
    const events: string[] = [];
    editable.addEventListener('input', () => events.push('input'));
    editable.addEventListener('change', () => events.push('change'));

    document.focus(editable);
    document.blur();
    expect(controller.insert('X')).toBe(true);
    expect(editable.textContent).toBe('hXo');
    expect(selection.getRangeAt(0).collapsed).toBe(true);
    expect(selection.getRangeAt(0).startContainer).toBe(editable);
    expect(events).toEqual(['input', 'change']);

    range.setStart(editable.textNode, 3);
    range.setEnd(editable.textNode, 3);
    selection.addRange(range);
    expect(controller.backspace()).toBe(true);
    expect(editable.textContent).toBe('hX');
    expect(selection.getRangeAt(0).collapsed).toBe(true);
  });

  it('does not edit a field removed from the document', () => {
    const { input, controller } = setupInput('abc');
    Object.defineProperty(input, 'isConnected', { value: false });

    expect(controller.insert('X')).toBe(false);
    expect(controller.target).toBeNull();
    expect(input.value).toBe('abc');
  });

  it('removes document listeners when destroyed', () => {
    const { document, input, controller } = setupInput('abc');
    controller.destroy();
    document.focus(input);

    expect(controller.target).toBeNull();
    expect(controller.insert('X')).toBe(false);
    expect(input.value).toBe('abc');
  });
});
