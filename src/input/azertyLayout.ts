import type { KeyboardLayout } from '../types';

export type KeyboardPage = 'letters' | 'numbers' | 'symbols';
export type DeadAccent = 'acute' | 'grave' | 'circumflex' | 'diaeresis' | 'cedilla' | 'tilde';

export type KeyboardAction =
  | 'shift'
  | 'caps'
  | 'altgr'
  | 'backspace'
  | 'delete'
  | 'enter'
  | 'space'
  | 'left'
  | 'right'
  | 'up'
  | 'down'
  | 'home'
  | 'end'
  | 'language'
  | 'numbers'
  | 'symbols'
  | 'letters'
  | 'submit'
  | 'cancel'
  | 'close'
  | 'mode';

export interface KeyboardKeyDefinition {
  id: string;
  value?: string;
  shifted?: string;
  altGr?: string;
  label?: string;
  shiftedLabel?: string;
  altGrLabel?: string;
  width?: number;
  action?: KeyboardAction;
  accent?: DeadAccent;
}

export interface KeyboardRow {
  id: string;
  keys: KeyboardKeyDefinition[];
}

export interface KeyboardLayoutDefinition {
  id: KeyboardLayout;
  label: string;
  pages: Record<KeyboardPage, KeyboardRow[]>;
}

export interface KeyboardModifiers {
  shift: boolean;
  caps: boolean;
  altGr: boolean;
}

export interface ResolvedKeyboardKey {
  key: KeyboardKeyDefinition;
  label: string;
  text: string | null;
  action?: KeyboardAction;
  accent?: DeadAccent;
}

export const DEAD_ACCENTS: Record<DeadAccent, { combining: string; spacing: string; label: string }> = {
  acute: { combining: '\u0301', spacing: '\u00b4', label: 'Dead acute' },
  grave: { combining: '\u0300', spacing: '\u02cb', label: 'Dead grave' },
  circumflex: { combining: '\u0302', spacing: '\u02c6', label: 'Dead circumflex' },
  diaeresis: { combining: '\u0308', spacing: '\u00a8', label: 'Dead diaeresis' },
  cedilla: { combining: '\u0327', spacing: '\u00b8', label: 'Dead cedilla' },
  tilde: { combining: '\u0303', spacing: '\u02dc', label: 'Dead tilde' },
};

const ACTION_LABELS: Partial<Record<KeyboardAction, string>> = {
  shift: 'Shift',
  caps: 'Caps',
  altgr: 'AltGr',
  backspace: '⌫',
  delete: 'Del',
  enter: 'Enter',
  space: 'Space',
  left: '←',
  right: '→',
  up: '↑',
  down: '↓',
  home: 'Home',
  end: 'End',
  language: 'FR / EN',
  numbers: '123',
  symbols: '# + =',
  letters: 'ABC',
  submit: 'Done',
  cancel: 'Cancel',
  close: 'Close',
};

function character(id: string, value: string, shifted?: string, altGr?: string): KeyboardKeyDefinition {
  return { id, value, shifted, altGr };
}

function accent(id: DeadAccent): KeyboardKeyDefinition {
  const labels: Record<DeadAccent, string> = {
    acute: '´', grave: '`', circumflex: 'ˆ', diaeresis: '¨', cedilla: '¸', tilde: '˜',
  };
  return { id: `dead-${id}`, value: DEAD_ACCENTS[id].spacing, label: labels[id], accent: id };
}

function action(id: KeyboardAction, width = 1): KeyboardKeyDefinition {
  return { id, action: id, width, label: ACTION_LABELS[id] ?? id };
}

function numbers(layout: KeyboardLayout): KeyboardKeyDefinition[] {
  if (layout === 'azerty') {
    return [
      character('digit-1', '&', '1', '~'),
      character('digit-2', 'é', '2', '#'),
      character('digit-3', '"', '3', '{'),
      character('digit-4', "'", '4', '['),
      character('digit-5', '(', '5', '|'),
      character('digit-6', '-', '6', '`'),
      character('digit-7', 'è', '7', '\\'),
      character('digit-8', '_', '8', '^'),
      character('digit-9', 'ç', '9', '@'),
      character('digit-0', 'à', '0', ']'),
      character('equal', '=', '+', '}'),
      action('backspace', 1.55),
    ];
  }
  return [
    character('digit-1', '1', '!', '¡'),
    character('digit-2', '2', '@', '²'),
    character('digit-3', '3', '#', '³'),
    character('digit-4', '4', '$', '£'),
    character('digit-5', '5', '%', '€'),
    character('digit-6', '6', '^', '¼'),
    character('digit-7', '7', '&', '½'),
    character('digit-8', '8', '*', '¾'),
    character('digit-9', '9', '(', '‘'),
    character('digit-0', '0', ')', '’'),
    character('minus', '-', '_', '—'),
    character('equal', '=', '+', '±'),
    action('backspace', 1.55),
  ];
}

function bottomRow(): KeyboardRow {
  return {
    id: 'bottom',
    keys: [
      action('caps', 1.3),
      action('altgr', 1.1),
      action('left', 0.72),
      action('down', 0.72),
      action('up', 0.72),
      action('right', 0.72),
      action('space', 4.35),
      action('enter', 1.5),
      action('language', 1.1),
      action('numbers', 1.1),
      action('symbols', 1.1),
    ],
  };
}

function lettersRows(layout: KeyboardLayout): KeyboardRow[] {
  const upper = layout === 'azerty' ? 'azertyuiop' : 'qwertyuiop';
  const home = layout === 'azerty' ? 'qsdfghjklm' : 'asdfghjkl';
  const lower = layout === 'azerty' ? 'wxcvbn' : 'zxcvbnm';
  return [
    { id: 'numbers', keys: numbers(layout) },
    { id: 'upper', keys: [...upper].map((value) => character(value, value)) },
    {
      id: 'home',
      keys: [...home].map((value) => character(value, value)).concat([
        accent('acute'), accent('circumflex'), accent('diaeresis'), accent('cedilla'),
      ]),
    },
    {
      id: 'lower',
      keys: [
        action('shift', 1.55),
        ...[...lower].map((value) => character(value, value)),
        character('comma', ',', ';'),
        character('semicolon', ';', ':'),
        character('colon', ':', '!'),
      ],
    },
    bottomRow(),
  ];
}

function symbolRow(id: string, values: Array<KeyboardKeyDefinition | [string, string, string?]>): KeyboardRow {
  return {
    id,
    keys: values.map((value) => Array.isArray(value)
      ? character(value[0], value[1], undefined, value[2])
      : value),
  };
}

function shiftedSymbolRow(id: string, values: Array<KeyboardKeyDefinition | [string, string, string?]>): KeyboardRow {
  return {
    id,
    keys: values.map((value) => Array.isArray(value)
      ? character(value[0], value[1], value[2])
      : value),
  };
}

function numbersRows(): KeyboardRow[] {
  return [
    shiftedSymbolRow('numbers-digits', [
      ['number-1', '1', '!'], ['number-2', '2', '@'], ['number-3', '3', '#'],
      ['number-4', '4', '$'], ['number-5', '5', '%'], ['number-6', '6', '^'],
      ['number-7', '7', '&'], ['number-8', '8', '*'], ['number-9', '9', '('],
      ['number-0', '0', ')'], ['number-period', '.', '…'], ['number-comma', ',', ';'],
      action('backspace', 1.55),
    ]),
    shiftedSymbolRow('numbers-operators', [
      character('number-paren-left', '(', ')'), character('number-paren-right', ')', '('),
      character('number-plus', '+', '='), character('number-minus', '-', '_'),
      character('number-times', '×', '÷'), character('number-divide', '÷', '×'),
      character('number-percent', '%', '‰'), character('number-equals', '=', '≠'),
      character('number-colon', ':', ';'), character('number-semicolon', ';', ':'),
      action('delete', 1.55),
    ]),
    {
      ...bottomRow(),
      keys: bottomRow().keys.map((key) => key.action === 'numbers'
        ? action('letters', 1.1)
        : key.action === 'caps' ? action('shift', 1.3) : key),
    },
  ];
}

function symbolsRows(): KeyboardRow[] {
  return [
    symbolRow('symbols-numbers', [
      ['symbol-1', '~', '1'], ['symbol-2', '#', '2'], ['symbol-3', '{', '3'],
      ['symbol-4', '[', '4'], ['symbol-5', '|', '5'], ['symbol-6', '`', '6'],
      ['symbol-7', '^', '7'], ['symbol-8', '@', '8'], ['symbol-9', ']', '9'],
      ['symbol-0', '}', '0'], ['symbol-11', '\\', '¬'], ['symbol-12', '°', 'º'],
      action('backspace', 1.55),
    ]),
    symbolRow('symbols-punctuation', [
      ['symbol-13', '¡', '!'], ['symbol-14', '¿', '?'], ['symbol-15', '×', '÷'],
      ['symbol-16', '÷', '×'], ['symbol-17', '±', '∓'], ['symbol-18', '€', '£'],
      ['symbol-19', '£', '¥'], ['symbol-20', '¥', '¢'], ['symbol-21', '¢', '$'],
      ['symbol-22', '§', '¶'], ['symbol-23', '¶', '†'], ['symbol-24', '†', '‡'],
      ['symbol-25', '‡', '•'],
    ]),
    {
      id: 'symbols-accents',
      keys: [
        accent('acute'), accent('grave'), accent('circumflex'), accent('diaeresis'),
        accent('cedilla'), accent('tilde'), character('ellipsis', '…'),
        character('middle-dot', '·'), character('bullet', '•'),
        character('guillemet-left', '«'), character('guillemet-right', '»'),
        character('copyright', '©'), character('registered', '®'),
        character('trademark', '™'),
      ],
    },
    {
      id: 'symbols-brackets',
      keys: [
        action('shift', 1.55),
        character('less', '<', '>'), character('greater', '>', '<'),
        character('paren-left', '(', ')'), character('paren-right', ')', '('),
        character('bracket-left', '[', ']'), character('bracket-right', ']', '['),
        character('brace-left', '{', '}'), character('brace-right', '}', '{'),
        character('slash', '/', '\\'), character('backslash', '\\', '/'),
        character('underscore', '_', '—'), character('equals', '=', '≠'),
      ],
    },
    {
      ...bottomRow(),
      keys: bottomRow().keys.map((key) => key.action === 'symbols' ? action('letters', 1.1) : key),
    },
  ];
}

function layout(id: KeyboardLayout): KeyboardLayoutDefinition {
  return {
    id,
    label: id === 'azerty' ? 'Français (AZERTY)' : 'English (QWERTY)',
    pages: {
      letters: lettersRows(id),
      numbers: numbersRows(),
      symbols: symbolsRows(),
    },
  };
}

export const AZERTY_LAYOUT = layout('azerty');
export const QWERTY_LAYOUT = layout('qwerty');
export const KEYBOARD_LAYOUTS: Record<KeyboardLayout, KeyboardLayoutDefinition> = {
  azerty: AZERTY_LAYOUT,
  qwerty: QWERTY_LAYOUT,
};

export function getKeyboardLayout(id: KeyboardLayout): KeyboardLayoutDefinition {
  return KEYBOARD_LAYOUTS[id];
}

export function getKeyboardRows(id: KeyboardLayout, page: KeyboardPage): KeyboardRow[] {
  return getKeyboardLayout(id).pages[page];
}

/** Resolves labels and output without mutating the shared layout definition. */
export function resolveKeyboardKey(
  key: KeyboardKeyDefinition,
  modifiers: KeyboardModifiers,
): ResolvedKeyboardKey {
  if (key.action) {
    return {
      key,
      label: key.label ?? ACTION_LABELS[key.action] ?? key.id,
      text: null,
      action: key.action,
    };
  }

  let text = key.value ?? key.label ?? key.id;
  if (modifiers.altGr && key.altGr !== undefined) {
    text = key.altGr;
  } else if (modifiers.shift && key.shifted !== undefined) {
    text = key.shifted;
  } else if (/^\p{L}$/u.test(text)) {
    text = modifiers.shift !== modifiers.caps ? text.toUpperCase() : text.toLowerCase();
  }

  const label = modifiers.altGr && key.altGrLabel !== undefined
    ? key.altGrLabel
    : modifiers.shift && key.shiftedLabel !== undefined
      ? key.shiftedLabel
      : key.accent ? key.label ?? text : text;

  return { key, label, text, ...(key.accent ? { accent: key.accent } : {}) };
}

/** Composes a dead accent, or emits its spacing form before a non-composable character. */
export function combineDeadAccent(value: string, deadAccent: DeadAccent): string {
  const definition = DEAD_ACCENTS[deadAccent];
  const base = value.normalize('NFD').replace(/\p{M}/gu, '');
  if (base.length === 0) return definition.spacing + value;
  const combined = (base + definition.combining).normalize('NFC');
  return combined === base + definition.combining
    ? definition.spacing + value
    : combined;
}

export function isKeyboardAction(value: string): value is KeyboardAction {
  return Object.prototype.hasOwnProperty.call(ACTION_LABELS, value);
}
