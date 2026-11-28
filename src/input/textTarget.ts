import {
  backspaceText,
  replaceTextSelection,
  type EditableElement,
  type TextEditResult,
  type TextSelection,
} from '../core/virtualKeyboard';

export type { TextSelection } from '../core/virtualKeyboard';

export interface TextTarget {
  readonly value: string;
  readonly selection: TextSelection;
  readonly readOnly: boolean;
  readonly secret: boolean;
  readonly multiline: boolean;
  replace(replacement: string, selection?: TextSelection): boolean;
  setSelection(selection: TextSelection): boolean;
  commit(): void;
  cancel(): void;
  submit?(): boolean;
  destroy?(): void;
}

type TextControl = HTMLInputElement | HTMLTextAreaElement;

const NON_TEXT_INPUT_TYPES = new Set([
  'button', 'checkbox', 'color', 'file', 'hidden', 'image', 'radio',
  'range', 'reset', 'submit',
]);

function isTextControl(element: Element): element is TextControl {
  if (element.tagName === 'TEXTAREA') return true;
  return element.tagName === 'INPUT' && !NON_TEXT_INPUT_TYPES.has((element as HTMLInputElement).type);
}

function isContentEditableElement(element: Element): element is HTMLElement {
  const attribute = element.getAttribute('contenteditable')?.toLowerCase();
  if (attribute === 'false') return false;
  return attribute === '' || attribute === 'true' || attribute === 'plaintext-only'
    || (element as HTMLElement).isContentEditable === true;
}

function contentEditableRoot(target: Element): HTMLElement | null {
  let element: Element | null = target;
  while (element) {
    const attribute = element.getAttribute('contenteditable')?.toLowerCase();
    if (attribute === 'false') return null;
    if (isContentEditableElement(element)) return element as HTMLElement;
    element = element.parentElement;
  }
  return null;
}

/** Finds an editable root without relying on realm-specific instanceof checks. */
export function findEditableElement(node: Node | null): EditableElement | null {
  let element: Element | null = node?.nodeType === 1
    ? node as Element
    : node?.parentElement ?? null;

  while (element) {
    if (element.tagName === 'INPUT' || element.tagName === 'TEXTAREA') {
      return isTextControl(element) ? element : null;
    }
    const editable = contentEditableRoot(element);
    if (editable) return editable;
    if (element.getAttribute('contenteditable')?.toLowerCase() === 'false') return null;
    element = element.parentElement;
  }
  return null;
}

export function isEditableElement(element: Element): element is EditableElement {
  return findEditableElement(element) !== null;
}

export function isSameOriginDocument(document: Document): boolean {
  const view = document.defaultView;
  if (!view) return false;

  try {
    // Comparing top WindowProxy identity does not require reading cross-origin content.
    if (typeof window !== 'undefined') {
      if (view.top !== window.top) return false;
      return view.location.origin === window.location.origin;
    }
    // Headless callers can only prove same-origin for a root document.
    return view.top === view;
  } catch {
    return false;
  }
}

export function previousCharacterStart(value: string, offset: number): number {
  if (offset <= 0) return 0;
  const last = value.charCodeAt(offset - 1);
  const beforeLast = offset > 1 ? value.charCodeAt(offset - 2) : -1;
  const isLowSurrogate = last >= 0xdc00 && last <= 0xdfff;
  const isHighSurrogate = beforeLast >= 0xd800 && beforeLast <= 0xdbff;
  return offset - (isLowSurrogate && isHighSurrogate ? 2 : 1);
}

export function nextCharacterStart(value: string, offset: number): number {
  if (offset >= value.length) return value.length;
  const first = value.charCodeAt(offset);
  const second = value.charCodeAt(offset + 1);
  const isHighSurrogate = first >= 0xd800 && first <= 0xdbff;
  const isLowSurrogate = second >= 0xdc00 && second <= 0xdfff;
  return offset + (isHighSurrogate && isLowSurrogate ? 2 : 1);
}

function cloneSelection(selection: TextSelection): TextSelection {
  return {
    start: selection.start,
    end: selection.end,
    ...(selection.direction ? { direction: selection.direction } : {}),
  };
}

function isDisabled(element: Element): boolean {
  const control = element as HTMLInputElement;
  if (control.disabled === true || element.getAttribute('aria-disabled') === 'true') return true;
  try {
    return element.matches?.(':disabled') === true;
  } catch {
    return false;
  }
}

function isReadOnlyElement(element: Element): boolean {
  if ((element as HTMLInputElement).readOnly === true || element.getAttribute('aria-readonly') === 'true') return true;
  let ancestor = element.parentElement;
  while (ancestor) {
    if (ancestor.getAttribute('aria-readonly') === 'true') return true;
    ancestor = ancestor.parentElement;
  }
  return false;
}

/** A live adapter for an actual input, textarea, or contenteditable selection. */
export class DomTextTarget implements TextTarget {
  readonly element: EditableElement;
  readonly document: Document;
  readonly secret: boolean;
  readonly multiline: boolean;

  private originalValue: string;
  private originalSelection: TextSelection;
  private savedSelection: TextSelection = { start: 0, end: 0 };
  private savedRange: Range | null = null;
  private finished = false;
  private destroyed = false;

  constructor(target: HTMLElement) {
    if (!isSameOriginDocument(target.ownerDocument)) {
      throw new Error('The text field must belong to a same-origin document.');
    }
    const editable = findEditableElement(target);
    if (!editable || editable.ownerDocument !== target.ownerDocument) {
      throw new Error('The element is not an editable text field.');
    }
    if (isDisabled(editable) || isReadOnlyElement(editable)) {
      throw new Error('The text field is disabled or read-only.');
    }

    this.element = editable;
    this.document = editable.ownerDocument;
    this.secret = isTextControl(editable) && editable.type === 'password';
    this.multiline = !isTextControl(editable) || editable.tagName === 'TEXTAREA';
    this.originalValue = this.readValue();
    this.originalSelection = this.currentSelection();
    this.savedSelection = cloneSelection(this.originalSelection);
    if (!isTextControl(editable)) this.captureRange();

    this.document.addEventListener('selectionchange', this.refreshSelection);
    this.document.addEventListener('select', this.refreshSelection);
    this.document.addEventListener('keyup', this.refreshSelection);
    this.document.addEventListener('mouseup', this.refreshSelection);
  }

  get value(): string {
    return this.readValue();
  }

  get selection(): TextSelection {
    this.refreshSelection();
    return cloneSelection(this.savedSelection);
  }

  get readOnly(): boolean {
    return this.finished || this.destroyed || this.element.isConnected === false
      || isDisabled(this.element) || isReadOnlyElement(this.element)
      || (isTextControl(this.element)
        ? this.element.readOnly
        : !isContentEditableElement(this.element));
  }

  replace(replacement: string, requestedSelection?: TextSelection): boolean {
    if (this.readOnly || (replacement.length === 0 && !requestedSelection && this.selection.start === this.selection.end)) {
      return false;
    }
    this.refreshSelection();
    const selection = requestedSelection ?? this.savedSelection;
    return isTextControl(this.element)
      ? this.replaceTextControl(replacement, selection)
      : this.replaceContentEditable(replacement, selection);
  }

  setSelection(selection: TextSelection): boolean {
    if (this.finished || this.destroyed || this.element.isConnected === false) return false;
    this.refreshSelection();
    const normalized = this.normalizeSelection(selection);
    if (isTextControl(this.element)) {
      try {
        this.element.setSelectionRange(normalized.start, normalized.end, normalized.direction ?? 'none');
        this.savedSelection = normalized;
        return true;
      } catch {
        return false;
      }
    }

    const range = this.rangeForSelection(normalized);
    this.applyRange(range);
    this.savedSelection = normalized;
    return true;
  }

  commit(): void {
    this.finished = true;
  }

  cancel(): void {
    if (this.finished || this.destroyed) return;
    if (this.value !== this.originalValue) {
      if (isTextControl(this.element)) {
        this.writeTextControl(this.originalValue, { start: 0, end: this.value.length });
      } else {
        this.writeContentEditable(this.originalValue);
      }
      this.setSelection(this.originalSelection);
      this.dispatchEditEvents(this.originalValue, 'historyUndo');
    } else {
      this.setSelection(this.originalSelection);
    }
    this.finished = true;
  }

  submit(): boolean {
    if (this.finished || this.destroyed || !isTextControl(this.element) || this.element.tagName !== 'INPUT') return false;
    const form = this.element.form;
    if (!form) return false;
    if (typeof form.requestSubmit === 'function') {
      form.requestSubmit();
    } else {
      const submit = form.querySelector<HTMLButtonElement>('button[type="submit"], input[type="submit"]');
      submit?.click();
    }
    return true;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.finished = true;
    this.document.removeEventListener('selectionchange', this.refreshSelection);
    this.document.removeEventListener('select', this.refreshSelection);
    this.document.removeEventListener('keyup', this.refreshSelection);
    this.document.removeEventListener('mouseup', this.refreshSelection);
    this.savedRange = null;
  }

  private readonly refreshSelection = (): void => {
    if (this.finished || this.destroyed) return;
    if (isTextControl(this.element)) {
      const selection = this.readControlSelection();
      if (selection) this.savedSelection = selection;
      return;
    }
    const range = this.currentRange();
    if (!range) return;
    this.savedRange = range.cloneRange();
    this.savedSelection = this.selectionFromRange(range);
  };

  private readValue(): string {
    return isTextControl(this.element) ? this.element.value : this.element.textContent ?? '';
  }

  private normalizeSelection(selection: TextSelection): TextSelection {
    const first = Math.max(0, Math.min(this.value.length, Math.trunc(selection.start) || 0));
    const second = Math.max(0, Math.min(this.value.length, Math.trunc(selection.end) || 0));
    return {
      start: Math.min(first, second),
      end: Math.max(first, second),
      ...(selection.direction ? { direction: selection.direction } : {}),
    };
  }

  private readControlSelection(): TextSelection | null {
    if (!isTextControl(this.element)) return null;
    const target = this.element;
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

  private currentSelection(): TextSelection {
    return isTextControl(this.element)
      ? this.readControlSelection() ?? { start: this.value.length, end: this.value.length }
      : this.selectionFromRange(this.currentRange() ?? this.endRange());
  }

  private captureRange(): void {
    const range = this.currentRange();
    if (range) this.savedRange = range.cloneRange();
  }

  private currentRange(): Range | null {
    const selection = this.document.getSelection();
    if (selection && selection.rangeCount > 0) {
      const range = selection.getRangeAt(0);
      if (this.element.contains(range.commonAncestorContainer)) return range.cloneRange();
    }
    if (this.savedRange && this.element.contains(this.savedRange.commonAncestorContainer)) {
      return this.savedRange.cloneRange();
    }
    return null;
  }

  private endRange(): Range {
    const range = this.document.createRange();
    range.selectNodeContents(this.element);
    range.collapse(false);
    return range;
  }

  private selectionFromRange(range: Range): TextSelection {
    const prefix = this.document.createRange();
    prefix.selectNodeContents(this.element);
    prefix.setEnd(range.startContainer, range.startOffset);
    const start = prefix.toString().length;
    return {
      start,
      end: start + range.toString().length,
      ...(this.savedSelection.direction ? { direction: this.savedSelection.direction } : {}),
    };
  }

  private rangeForSelection(selection: TextSelection): Range {
    const range = this.document.createRange();
    const walker = this.document.createTreeWalker(this.element, 4);
    let consumed = 0;
    let hasStart = false;
    let node: Node | null;
    while ((node = walker.nextNode())) {
      const length = node.textContent?.length ?? 0;
      if (!hasStart && selection.start <= consumed + length) {
        range.setStart(node, Math.max(0, selection.start - consumed));
        hasStart = true;
      }
      if (selection.end <= consumed + length) {
        range.setEnd(node, Math.max(0, selection.end - consumed));
        return range;
      }
      consumed += length;
    }

    if (!hasStart) range.setStart(this.element, 0);
    range.collapse(true);
    return range;
  }

  private applyRange(range: Range): void {
    const selection = this.document.getSelection();
    if (!selection) return;
    selection.removeAllRanges();
    selection.addRange(range);
    this.savedRange = range.cloneRange();
  }

  private replaceTextControl(replacement: string, selection: TextSelection): boolean {
    const normalized = this.normalizeSelection(selection);
    if (normalized.start === normalized.end && replacement.length === 0) return false;
    const applied = this.writeTextControl(replacement, normalized);
    if (!applied) return false;
    this.savedSelection = this.readControlSelection() ?? {
      start: normalized.start + replacement.length,
      end: normalized.start + replacement.length,
    };
    this.dispatchEditEvents(replacement);
    return true;
  }

  private writeTextControl(replacement: string, selection: TextSelection): boolean {
    if (!isTextControl(this.element)) return false;
    const target = this.element;
    if (typeof target.setRangeText === 'function') {
      try {
        target.setRangeText(replacement, selection.start, selection.end, 'end');
      } catch {
        target.value = replaceTextSelection(target.value, selection, replacement).value;
      }
    } else {
      target.value = replaceTextSelection(target.value, selection, replacement).value;
    }
    const caret = selection.start + replacement.length;
    try {
      target.setSelectionRange(caret, caret, selection.direction ?? 'none');
    } catch {
      // Some input types expose values but not selection APIs.
    }
    return true;
  }

  private replaceContentEditable(replacement: string, selection: TextSelection): boolean {
    const normalized = this.normalizeSelection(selection);
    if (normalized.start === normalized.end && replacement.length === 0) return false;
    this.writeContentEditable(replacement, normalized);
    this.refreshSelection();
    this.dispatchEditEvents(replacement);
    return true;
  }

  private writeContentEditable(replacement: string, selection?: TextSelection): void {
    const range = selection ? this.rangeForSelection(selection) : this.endRange();
    if (!selection) range.selectNodeContents(this.element);
    range.deleteContents();
    if (replacement.length > 0) {
      const node = this.document.createTextNode(replacement);
      range.insertNode(node);
      range.setStartAfter(node);
    }
    range.collapse(true);
    this.applyRange(range);
  }

  private dispatchEditEvents(replacement: string, inputType?: string): void {
    const view = this.document.defaultView;
    let input: Event;
    if (view && typeof view.InputEvent === 'function') {
      input = new view.InputEvent('input', {
        bubbles: true,
        inputType: inputType ?? (replacement.length > 0 ? 'insertText' : 'deleteContentBackward'),
        data: replacement.length > 0 ? replacement : null,
      });
    } else {
      input = this.document.createEvent('Event');
      input.initEvent('input', true, false);
    }
    this.element.dispatchEvent(input);
    const change = this.document.createEvent('Event');
    change.initEvent('change', true, false);
    this.element.dispatchEvent(change);
  }
}

export interface SessionTargetOptions {
  value?: string;
  selection?: TextSelection;
  secret?: boolean;
  placeholder?: string;
  readOnly?: boolean;
  multiline?: boolean;
  onCommit?: (value: string) => void;
  onCancel?: () => void;
}

/** In-memory custom text session with explicit selection, replacement, commit, and cancel. */
export class SessionTextTarget implements TextTarget {
  readonly secret: boolean;
  readonly placeholder: string;
  readonly readOnly: boolean;
  readonly multiline: boolean;

  private originalValue: string;
  private originalSelection: TextSelection;
  private currentValue: string;
  private currentSelection: TextSelection;
  private finished = false;
  private readonly onCommit?: (value: string) => void;
  private readonly onCancel?: () => void;

  constructor(options: SessionTargetOptions = {}) {
    this.originalValue = options.value ?? '';
    this.currentValue = this.originalValue;
    this.originalSelection = this.normalizeSelection(options.selection ?? {
      start: this.originalValue.length,
      end: this.originalValue.length,
    });
    this.currentSelection = cloneSelection(this.originalSelection);
    this.secret = options.secret ?? false;
    this.placeholder = options.placeholder ?? '';
    this.readOnly = options.readOnly ?? false;
    this.multiline = options.multiline ?? false;
    this.onCommit = options.onCommit;
    this.onCancel = options.onCancel;
  }

  get value(): string {
    return this.currentValue;
  }

  get selection(): TextSelection {
    return cloneSelection(this.currentSelection);
  }

  replace(replacement: string, selection?: TextSelection): boolean {
    if (this.finished || this.readOnly || (replacement.length === 0 && !selection
      && this.currentSelection.start === this.currentSelection.end)) {
      return false;
    }
    const result: TextEditResult = replaceTextSelection(this.currentValue, selection ?? this.currentSelection, replacement);
    this.currentValue = result.value;
    this.currentSelection = {
      start: result.start,
      end: result.end,
      ...(result.direction ? { direction: result.direction } : {}),
    };
    return true;
  }

  setSelection(selection: TextSelection): boolean {
    if (this.finished) return false;
    this.currentSelection = this.normalizeSelection(selection);
    return true;
  }

  commit(): void {
    if (this.finished) return;
    this.finished = true;
    this.onCommit?.(this.currentValue);
  }

  cancel(): void {
    if (this.finished) return;
    this.currentValue = this.originalValue;
    this.currentSelection = cloneSelection(this.originalSelection);
    this.finished = true;
    this.onCancel?.();
  }

  destroy(): void {
    this.finished = true;
  }

  /** Deletes a selection or the previous complete Unicode code point. */
  backspace(): boolean {
    if (this.finished || this.readOnly) return false;
    const deletion = this.currentSelection.start === this.currentSelection.end
      ? { ...this.currentSelection, start: previousCharacterStart(this.currentValue, this.currentSelection.start) }
      : this.currentSelection;
    if (deletion.start === deletion.end) return false;
    const result = backspaceText(this.currentValue, deletion);
    this.currentValue = result.value;
    this.currentSelection = { start: result.start, end: result.end };
    return true;
  }

  private normalizeSelection(selection: TextSelection): TextSelection {
    const first = Math.max(0, Math.min(this.currentValue.length, Math.trunc(selection.start) || 0));
    const second = Math.max(0, Math.min(this.currentValue.length, Math.trunc(selection.end) || 0));
    return {
      start: Math.min(first, second),
      end: Math.max(first, second),
      ...(selection.direction ? { direction: selection.direction } : {}),
    };
  }
}
