import { describe, expect, it } from 'vitest';
import {
  AZERTY_LAYOUT,
  QWERTY_LAYOUT,
  combineDeadAccent,
  getKeyboardRows,
  resolveKeyboardKey,
  type KeyboardKeyDefinition,
  type KeyboardModifiers,
} from '../src/input/azertyLayout';

function key(
  id: string,
  layout: 'azerty' | 'qwerty' = 'azerty',
  page: 'letters' | 'numbers' | 'symbols' = 'letters',
): KeyboardKeyDefinition {
  const definition = getKeyboardRows(layout, page)
    .flatMap((row) => row.keys)
    .find((candidate) => candidate.id === id);
  if (!definition) throw new Error(`Missing key ${id}`);
  return definition;
}

function resolve(
  id: string,
  modifiers: Partial<KeyboardModifiers> = {},
  layout: 'azerty' | 'qwerty' = 'azerty',
  page: 'letters' | 'numbers' | 'symbols' = 'letters',
) {
  return resolveKeyboardKey(key(id, layout, page), {
    shift: false,
    caps: false,
    altGr: false,
    ...modifiers,
  });
}

describe('French AZERTY and language layouts', () => {
  it('keeps AZERTY as the default French mapping', () => {
    expect(AZERTY_LAYOUT.id).toBe('azerty');
    expect(resolve('a').text).toBe('a');
    expect(resolve('z').text).toBe('z');
    expect(resolve('q').text).toBe('q');
    expect(resolve('w').text).toBe('w');
    expect(resolve('m').text).toBe('m');
    expect(resolve('comma').text).toBe(',');
  });

  it('provides the French number row with Shift-produced digits', () => {
    expect(getKeyboardRows('azerty', 'letters')[0].keys.map((entry) => entry.id)).toContain('digit-1');
    expect(resolve('digit-1').label).toBe('&');
    expect(resolve('digit-1', { shift: true }).text).toBe('1');
    expect(resolve('digit-2', { shift: true }).text).toBe('2');
    expect(resolve('digit-7', { shift: true }).text).toBe('7');
    expect(resolve('digit-0', { shift: true }).text).toBe('0');
    expect(resolve('digit-2').text).toBe('é');
    expect(resolve('digit-9').text).toBe('ç');
    expect(resolve('digit-0').text).toBe('à');
  });

  it('uses one-shot Shift and sticky Caps with XOR casing', () => {
    expect(resolve('a', { shift: true }).text).toBe('A');
    expect(resolve('a', { caps: true }).text).toBe('A');
    expect(resolve('a', { shift: true, caps: true }).text).toBe('a');
    expect(resolve('digit-1', { shift: true, caps: true }).text).toBe('1');
    expect(resolve('comma', { shift: true }).text).toBe(';');
    expect(resolve('comma', { caps: true }).text).toBe(',');
    expect(resolve('digit-2', { caps: true }).text).toBe('É');
    expect(resolve('digit-9', { caps: true }).text).toBe('Ç');
    expect(resolve('digit-0', { caps: true }).text).toBe('À');
  });

  it('prioritizes AltGr output without leaking it into letter casing', () => {
    expect(resolve('digit-1', { altGr: true }).text).toBe('~');
    expect(resolve('digit-3', { altGr: true, shift: true }).text).toBe('{');
    expect(resolve('a', { altGr: true }).text).toBe('a');
  });

  it('switches the same keyboard between French and QWERTY', () => {
    expect(QWERTY_LAYOUT.id).toBe('qwerty');
    expect(resolve('a', {}, 'qwerty').text).toBe('a');
    expect(resolve('q', {}, 'qwerty').text).toBe('q');
    expect(resolve('w', {}, 'qwerty').text).toBe('w');
    expect(resolve('z', {}, 'qwerty').text).toBe('z');
    expect(resolve('language').action).toBe('language');
    expect(resolve('symbols').action).toBe('symbols');
    expect(getKeyboardRows('azerty', 'symbols').flatMap((row) => row.keys).some((entry) => entry.action === 'letters')).toBe(true);
  });

  it('provides a direct numeric page with decimal and operator keys', () => {
    expect(resolve('numbers').action).toBe('numbers');
    expect(resolve('number-1', {}, 'azerty', 'numbers').text).toBe('1');
    expect(resolve('number-0', {}, 'qwerty', 'numbers').text).toBe('0');
    expect(resolve('number-period', {}, 'azerty', 'numbers').text).toBe('.');
    expect(resolve('number-comma', {}, 'azerty', 'numbers').text).toBe(',');
    expect(resolve('number-plus', {}, 'azerty', 'numbers').text).toBe('+');
    expect(resolve('shift', {}, 'azerty', 'numbers').action).toBe('shift');
    expect(resolve('number-1', { shift: true }, 'azerty', 'numbers').text).toBe('!');
    expect(getKeyboardRows('azerty', 'numbers').flatMap((row) => row.keys).some((entry) => entry.action === 'letters')).toBe(true);
    expect(getKeyboardRows('azerty', 'symbols').flatMap((row) => row.keys).some((entry) => entry.action === 'numbers')).toBe(true);
  });

  it('includes editing, navigation, accents, and symbol controls', () => {
    const ids = new Set(getKeyboardRows('azerty', 'letters').flatMap((row) => row.keys.map((entry) => entry.id)));
    for (const id of ['shift', 'caps', 'altgr', 'backspace', 'enter', 'space', 'left', 'right', 'up', 'down']) {
      expect(ids.has(id), id).toBe(true);
    }
    expect(resolve('dead-acute').accent).toBe('acute');
    expect(resolve('dead-grave', {}, 'azerty', 'symbols').accent).toBe('grave');
    expect(getKeyboardRows('azerty', 'symbols').flatMap((row) => row.keys).some((entry) => entry.value === '€')).toBe(true);
  });
});

describe('dead accents and Unicode composition', () => {
  it('normalizes composed accents to NFC', () => {
    expect(combineDeadAccent('e', 'acute')).toBe('é');
    expect(combineDeadAccent('a', 'grave')).toBe('à');
    expect(combineDeadAccent('u', 'diaeresis')).toBe('ü');
    expect(combineDeadAccent('i', 'circumflex')).toBe('î');
    expect(combineDeadAccent('c', 'cedilla')).toBe('ç');
    expect(combineDeadAccent('n', 'tilde')).toBe('ñ');
    expect(combineDeadAccent('e\u0301', 'grave')).toBe('è');
  });

  it('emits a spacing accent before a non-composable character', () => {
    expect(combineDeadAccent('😀', 'acute')).toBe('´😀');
    expect(combineDeadAccent('7', 'circumflex')).toBe('ˆ7');
  });
});
