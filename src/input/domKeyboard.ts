/**
 * DOM-facing keyboard adapter. It edits the browser's real selection and never
 * owns an HTML keyboard panel or dispatches synthetic physical key events.
 */
export {
  DomTextTarget,
  DomTextTarget as DomKeyboardAdapter,
  findEditableElement,
  isEditableElement,
  isSameOriginDocument,
  nextCharacterStart,
  previousCharacterStart,
} from './textTarget';
export type { TextSelection, TextTarget } from './textTarget';
