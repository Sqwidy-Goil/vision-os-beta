export type SelectionDirection = 'forward' | 'backward' | 'none';

export interface TextSelection {
  start: number;
  end: number;
  direction?: SelectionDirection;
}

export interface TextEditResult extends TextSelection {
  value: string;
}

export type EditableElement = HTMLInputElement | HTMLTextAreaElement | HTMLElement;

type TextControl = HTMLInputElement | HTMLTextAreaElement;

export interface VirtualKeyboardOptions {
  document?: Document;
  onClose?: () => void;
}

export interface VirtualKeyboardActions {
  insert(text: string): boolean;
  backspace(): boolean;
  space(): boolean;
  enter(): boolean;
  toggleShift(): boolean;
  toggleCaps(): boolean;
  open(): void;
  close(): void;
  press(action: string): boolean;
}

const NON_TEXT_INPUT_TYPES = new Set([
  'button',
  'checkbox',
  'color',
  'file',
  'hidden',
  'image',
  'radio',
  'range',
  'reset',
  'submit',
]);

function clampOffset(offset: number, length: number): number {
  return Math.max(0, Math.min(length, Math.trunc(offset) || 0));
}

function normalizeSelection(value: string, selection: TextSelection): TextSelection {
  const first = clampOffset(selection.start, value.length);
  const second = clampOffset(selection.end, value.length);
  return {
    start: Math.min(first, second),
    end: Math.max(first, second),
    ...(selection.direction ? { direction: selection.direction } : {}),
  };
}

function previousCharacterStart(value: string, offset: number): number {
  if (offset <= 0) return 0;

  const last = value.charCodeAt(offset - 1);
  const beforeLast = offset > 1 ? value.charCodeAt(offset - 2) : -1;
  const isLowSurrogate = last >= 0xdc00 && last <= 0xdfff;
  const isHighSurrogate = beforeLast >= 0xd800 && beforeLast <= 0xdbff;
  return offset - (isLowSurrogate && isHighSurrogate ? 2 : 1);
}

/** Replaces a text selection and returns the caret position after the edit. */
export function replaceTextSelection(
  value: string,
  selection: TextSelection,
  replacement: string,
): TextEditResult {
  const normalized = normalizeSelection(value, selection);
  const nextValue = value.slice(0, normalized.start) + replacement + value.slice(normalized.end);
  const caret = normalized.start + replacement.length;

  return {
    value: nextValue,
    start: caret,
    end: caret,
    ...(normalized.direction ? { direction: normalized.direction } : {}),
  };
}

export function selectionBeforeBackspace(value: string, selection: TextSelection): TextSelection {
  const normalized = normalizeSelection(value, selection);
  const start = normalized.start === normalized.end
    ? previousCharacterStart(value, normalized.start)
    : normalized.start;
  return { ...normalized, start };
}

/** Deletes the selected text, or one Unicode code point immediately before the caret. */
export function backspaceText(value: string, selection: TextSelection): TextEditResult {
  return replaceTextSelection(value, selectionBeforeBackspace(value, selection), '');
}

export function applyKeyboardCase(text: string, shift: boolean, capsLock: boolean): string {
  if (!shift && !capsLock) return text;
  return shift !== capsLock ? text.toUpperCase() : text.toLowerCase();
}

function isTextControl(element: Element): element is TextControl {
  if (element.tagName === 'TEXTAREA') return true;
  return element.tagName === 'INPUT' && !NON_TEXT_INPUT_TYPES.has((element as HTMLInputElement).type);
}

function isContentEditableElement(element: Element): element is HTMLElement {
  const attribute = element.getAttribute('contenteditable')?.toLowerCase();
  if (attribute === 'false') return false;
  return attribute === '' || attribute === 'true' || attribute === 'plaintext-only' || (element as HTMLElement).isContentEditable === true;
}

function findEditableElement(node: Node | null): EditableElement | null {
  let element = node?.nodeType === 1 ? node as Element : node?.parentElement ?? null;

  while (element) {
    if (isTextControl(element)) return element;

    const attribute = element.getAttribute('contenteditable')?.toLowerCase();
    if (attribute === 'false') return null;
    if (isContentEditableElement(element)) return element as HTMLElement;

    element = element.parentElement;
  }

  return null;
}

/**
 * Tracks the most recently focused editable element without owning a DOM panel.
 * Reserved `press` actions are backspace, space, enter, shift, caps, open, and close;
 * every other action is inserted as text.
 */
export class VirtualKeyboardController {
  readonly actions: VirtualKeyboardActions;

  private readonly document: Document;
  private readonly onClose?: () => void;
  private focusedElement: EditableElement | null = null;
  private savedSelection: TextSelection | null = null;
  private savedRange: Range | null = null;
  private shifted = false;
  private capsLocked = false;
  private opened = true;
  private destroyed = false;

  constructor(options: VirtualKeyboardOptions = {}) {
    this.document = options.document ?? globalThis.document;
    if (!this.document) throw new Error('VirtualKeyboardController requires a Document.');
    this.onClose = options.onClose;

    this.actions = {
      insert: (text) => this.insert(text),
      backspace: () => this.backspace(),
      space: () => this.space(),
      enter: () => this.enter(),
      toggleShift: () => this.toggleShift(),
      toggleCaps: () => this.toggleCaps(),
      open: () => this.open(),
      close: () => this.close(),
      press: (action) => this.press(action),
    };

    this.document.addEventListener('focusin', this.handleFocusIn);
    this.document.addEventListener('selectionchange', this.handleSelectionChange);
    this.document.addEventListener('select', this.handleSelectionEvent);
    this.document.addEventListener('keyup', this.handleSelectionEvent);
    this.document.addEventListener('mouseup', this.handleSelectionEvent);
    this.open();
  }

  get target(): EditableElement | null {
    if (this.focusedElement?.isConnected === false) {
      this.focusedElement = null;
      this.savedSelection = null;
      this.savedRange = null;
    }
    return this.focusedElement;
  }

  get isOpen(): boolean {
    return this.opened;
  }

  get selection(): TextSelection | null {
    const target = this.focusedElement;
    if (!target || target.isConnected === false) return null;
    if (isTextControl(target)) {
      const selection = this.readTextSelection(target);
      if (selection) return selection;
    }
    return this.savedSelection ? { ...this.savedSelection } : null;
  }

  get isShifted(): boolean {
    return this.shifted;
  }

  get isCapsLocked(): boolean {
    return this.capsLocked;
  }

  open(): void {
    if (this.destroyed) return;
    this.opened = true;
    const active = findEditableElement(this.document.activeElement);
    if (active) this.focusEditable(active);
  }

  close(): void {
    if (this.destroyed || !this.opened) return;
    this.opened = false;
    this.shifted = false;
    this.capsLocked = false;
    this.onClose?.();
  }

  destroy(): void {
    if (this.destroyed) return;

    this.document.removeEventListener('focusin', this.handleFocusIn);
    this.document.removeEventListener('selectionchange', this.handleSelectionChange);
    this.document.removeEventListener('select', this.handleSelectionEvent);
    this.document.removeEventListener('keyup', this.handleSelectionEvent);
    this.document.removeEventListener('mouseup', this.handleSelectionEvent);

    this.destroyed = true;
    this.opened = false;
    this.focusedElement = null;
    this.savedSelection = null;
    this.savedRange = null;
    this.shifted = false;
    this.capsLocked = false;
  }

  insert(text: string): boolean {
    const target = this.editableTarget();
    if (!target || text.length === 0) return false;

    this.refreshSelection();
    const replacement = applyKeyboardCase(text, this.shifted, this.capsLocked);
    const applied = isTextControl(target)
      ? this.writeTextControl(target, replacement)
      : this.writeContentEditable(target, replacement);

    return this.finishEdit(applied);
  }

  backspace(): boolean {
    const target = this.editableTarget();
    if (!target) return false;

    this.refreshSelection();
    let applied: boolean;

    if (isTextControl(target)) {
      const selection = this.textSelection(target);
      const result = backspaceText(target.value, selection);
      const deletion = selectionBeforeBackspace(target.value, selection);
      applied = result.value !== target.value && this.writeTextControl(target, '', deletion);
    } else {
      const range = this.contentEditableRange(target);
      const deletion = range ? this.rangeBeforeBackspace(target, range) : null;
      applied = deletion !== null && this.writeContentEditable(target, '', deletion);
    }

    return this.finishEdit(applied);
  }

  space(): boolean {
    return this.insert(' ');
  }

  enter(): boolean {
    const target = this.editableTarget();
    if (!target) return false;
    if (isTextControl(target) && target.tagName === 'INPUT') {
      const event = this.document.createEvent('KeyboardEvent');
      event.initEvent('keydown', true, true);
      Object.defineProperty(event, 'key', { value: 'Enter' });
      target.dispatchEvent(event);
      return true;
    }
    return this.insert('\n');
  }

  toggleShift(): boolean {
    if (!this.opened || this.destroyed) return false;
    this.shifted = !this.shifted;
    return this.shifted;
  }

  toggleCaps(): boolean {
    if (!this.opened || this.destroyed) return false;
    this.capsLocked = !this.capsLocked;
    return this.capsLocked;
  }

  press(action: string): boolean {
    switch (action) {
      case 'backspace':
        return this.backspace();
      case 'space':
        return this.space();
      case 'enter':
        return this.enter();
      case 'shift':
        this.toggleShift();
        return true;
      case 'caps':
      case 'caps-lock':
        this.toggleCaps();
        return true;
      case 'open':
        this.open();
        return !this.destroyed;
      case 'close':
        this.close();
        return true;
      default:
        return this.insert(action);
    }
  }

  private readonly handleFocusIn = (event: FocusEvent): void => {
    const editable = findEditableElement(event.target as Node | null);
    if (editable) this.focusEditable(editable);
  };

  private readonly handleSelectionChange = (): void => {
    const target = this.focusedElement;
    if (!target) return;
    if (isTextControl(target) && this.document.activeElement !== target) return;
    this.captureSelection();
  };

  private readonly handleSelectionEvent = (event: Event): void => {
    const target = this.focusedElement;
    const node = event.target as Node | null;
    if (target && node && target.contains(node)) this.captureSelection();
  };

  private focusEditable(element: EditableElement): void {
    this.opened = true;
    this.focusedElement = element;
    this.savedSelection = null;
    this.savedRange = null;
    this.captureSelection();
  }

  private editableTarget(): EditableElement | null {
    const target = this.focusedElement;
    if (!target || !this.opened || this.destroyed) return null;
    if (target.isConnected === false) {
      this.focusedElement = null;
      this.savedSelection = null;
      this.savedRange = null;
      return null;
    }
    if (isTextControl(target)) {
      return target.disabled || target.readOnly ? null : target;
    }
    return isContentEditableElement(target) ? target : null;
  }

  private refreshSelection(): void {
    const target = this.focusedElement;
    if (!target) return;

    if (isTextControl(target)) {
      const selection = this.readTextSelection(target);
      if (selection) this.savedSelection = selection;
      return;
    }

    const range = this.contentEditableRange(target);
    if (range) this.savedRange = range.cloneRange();
  }

  private captureSelection(): void {
    const target = this.focusedElement;
    if (!target) return;

    if (isTextControl(target)) {
      const selection = this.readTextSelection(target);
      if (selection) this.savedSelection = selection;
      return;
    }

    const selection = this.document.getSelection();
    if (!selection || selection.rangeCount === 0) return;
    const range = selection.getRangeAt(0);
    if (target.contains(range.commonAncestorContainer)) this.savedRange = range.cloneRange();
  }

  private readTextSelection(target: TextControl): TextSelection | null {
    try {
      if (target.selectionStart === null || target.selectionEnd === null) return null;
      return {
        start: target.selectionStart,
        end: target.selectionEnd,
        ...(target.selectionDirection ? { direction: target.selectionDirection } : {}),
      };
    } catch {
      return null;
    }
  }

  private textSelection(target: TextControl): TextSelection {
    return this.readTextSelection(target)
      ?? this.savedSelection
      ?? { start: target.value.length, end: target.value.length };
  }

  private writeTextControl(
    target: TextControl,
    replacement: string,
    currentSelection: TextSelection = this.textSelection(target),
  ): boolean {
    const selection = normalizeSelection(target.value, currentSelection);
    const result = replaceTextSelection(target.value, selection, replacement);

    if (typeof target.setRangeText === 'function') {
      try {
        target.setRangeText(replacement, selection.start, selection.end, 'end');
      } catch {
        target.value = result.value;
      }
    } else {
      target.value = result.value;
    }

    const start = clampOffset(result.start, target.value.length);
    const end = clampOffset(result.end, target.value.length);
    try {
      target.setSelectionRange(start, end, result.direction ?? 'none');
    } catch {
      // Some input types accept values but do not expose selection APIs.
    }

    return true;
  }

  private contentEditableRange(target: HTMLElement): Range {
    const selection = this.document.getSelection();
    if (selection && selection.rangeCount > 0) {
      const range = selection.getRangeAt(0);
      if (target.contains(range.commonAncestorContainer)) return range.cloneRange();
    }

    if (this.savedRange && target.contains(this.savedRange.commonAncestorContainer)) {
      return this.savedRange.cloneRange();
    }

    const range = this.document.createRange();
    range.selectNodeContents(target);
    range.collapse(false);
    return range;
  }

  private rangeBeforeBackspace(target: HTMLElement, range: Range): Range | null {
    if (!range.collapsed) return range.cloneRange();

    const preceding = range.cloneRange();
    preceding.selectNodeContents(target);
    preceding.setEnd(range.startContainer, range.startOffset);
    const text = preceding.toString();
    if (text.length === 0) return null;

    const walker = this.document.createTreeWalker(target, 4);
    let consumed = 0;
    let node: Node | null;
    while ((node = walker.nextNode())) {
      const content = node.textContent ?? '';
      if (consumed + content.length >= text.length) {
        const deletion = range.cloneRange();
        deletion.setStart(node, previousCharacterStart(content, text.length - consumed));
        deletion.setEnd(range.startContainer, range.startOffset);
        return deletion;
      }
      consumed += content.length;
    }

    return null;
  }

  private writeContentEditable(target: HTMLElement, replacement: string, range = this.contentEditableRange(target)): boolean {
    if (range.collapsed && replacement.length === 0) return false;

    range.deleteContents();
    if (replacement.length > 0) {
      const node = this.document.createTextNode(replacement);
      range.insertNode(node);
      range.setStartAfter(node);
    }
    range.collapse(true);

    const selection = this.document.getSelection();
    if (selection) {
      selection.removeAllRanges();
      selection.addRange(range);
    }

    return true;
  }

  private finishEdit(applied: boolean): boolean {
    if (!applied) return false;

    this.shifted = false;
    const target = this.focusedElement;
    if (target) this.dispatchEditEvents(target);
    this.captureSelection();
    return true;
  }

  private dispatchEditEvents(target: EditableElement): void {
    for (const type of ['input', 'change']) {
      const event = this.document.createEvent('Event');
      event.initEvent(type, true, false);
      target.dispatchEvent(event);
    }
  }
}
