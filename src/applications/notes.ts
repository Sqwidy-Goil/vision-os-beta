import type { ApplicationContext, ApplicationDefinition, ApplicationInstance } from '../types';
import { storage as indexedDbStorage } from '../core/storage';
import { ellipsis, fillRoundedRect, roundedRect } from '../spatial/canvasUi';
import { actionAt, drawButton, type CanvasAction } from './ui';

export const NOTES_STORAGE_KEY = 'notes:v1';
export const NOTES_AUTOSAVE_DELAY_MS = 450;
const NOTES_SCHEMA_VERSION = 1;
const TOOLBAR_HEIGHT = 76;
const LIST_ROW_HEIGHT = 76;
const EDITOR_LINE_HEIGHT = 24;

export interface Note {
  id: string;
  title: string;
  body: string;
  createdAt: number;
  updatedAt: number;
}

export interface NotesSnapshot {
  schemaVersion: 1;
  notes: Note[];
  selectedId: string | null;
  listScroll: number;
  editorScroll: number;
}

export interface NotesStorage {
  get<T>(key: string): Promise<T | undefined>;
  set<T>(key: string, value: T): Promise<void>;
}

export interface NotesAppOptions {
  storage?: NotesStorage;
  repository?: NotesRepository;
  debounceMs?: number;
  now?: () => number;
  createId?: () => string;
}

type SaveState = 'loading' | 'saved' | 'dirty' | 'saving' | 'error';
type ScrollArea = 'list' | 'editor';

interface NoteRow {
  note: Note;
  x: number;
  y: number;
  width: number;
  height: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function finiteNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function normalizeBody(body: string): string {
  return body.replace(/\r\n?/g, '\n');
}

export function noteTitle(body: string): string {
  const firstLine = normalizeBody(body).split('\n').find((line) => line.trim().length > 0)?.trim() ?? '';
  return firstLine ? firstLine.slice(0, 100) : 'Untitled note';
}

export function createNote(body = '', now = Date.now(), id: string = crypto.randomUUID()): Note {
  const normalized = normalizeBody(body);
  return {
    id,
    title: noteTitle(normalized),
    body: normalized,
    createdAt: now,
    updatedAt: now,
  };
}

function parseNote(value: unknown): Note {
  if (!isRecord(value)
    || typeof value.id !== 'string' || !value.id
    || typeof value.body !== 'string'
    || typeof value.createdAt !== 'number' || !Number.isFinite(value.createdAt)
    || typeof value.updatedAt !== 'number' || !Number.isFinite(value.updatedAt)
    || (value.title !== undefined && typeof value.title !== 'string')) {
    throw new Error('The saved notes document contains an invalid record.');
  }
  const body = normalizeBody(value.body);
  return {
    id: value.id,
    title: typeof value.title === 'string' && value.title.trim() ? value.title.trim().slice(0, 100) : noteTitle(body),
    body,
    createdAt: value.createdAt,
    updatedAt: Math.max(value.createdAt, value.updatedAt),
  };
}

export function parseNotes(value: unknown): Note[] {
  if (!Array.isArray(value)) throw new Error('The saved notes document is invalid.');
  const notes = value.map(parseNote);
  if (new Set(notes.map((note) => note.id)).size !== notes.length) {
    throw new Error('The saved notes document contains duplicate note IDs.');
  }
  return notes.sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
}

export function parseNotesDocument(value: unknown): Note[] {
  if (value === undefined) return [];
  if (!isRecord(value) || value.schemaVersion !== NOTES_SCHEMA_VERSION) {
    throw new Error('The saved notes document has an unsupported format.');
  }
  return parseNotes(value.notes);
}

export function selectedNoteId(notes: Note[], currentId: string | null, requestedId?: string | null): string | null {
  if (requestedId && notes.some((note) => note.id === requestedId)) return requestedId;
  if (currentId && notes.some((note) => note.id === currentId)) return currentId;
  return notes[0]?.id ?? null;
}

export function updateNoteBody(notes: Note[], id: string, body: string, now = Date.now()): Note[] {
  const normalized = normalizeBody(body);
  const current = notes.find((note) => note.id === id);
  if (!current || current.body === normalized) return notes;
  return notes.map((note) => note.id === id ? { ...note, body: normalized, title: noteTitle(normalized), updatedAt: now } : note)
    .sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
}

export function removeNote(notes: Note[], id: string, currentId: string | null = notes[0]?.id ?? null): { notes: Note[]; selectedId: string | null } {
  const index = notes.findIndex((note) => note.id === id);
  if (index < 0) return { notes, selectedId: selectedNoteId(notes, currentId) };
  const remaining = notes.filter((note) => note.id !== id);
  return {
    notes: remaining,
    selectedId: remaining[Math.min(index, remaining.length - 1)]?.id ?? null,
  };
}

export function restoreNotesSnapshot(value: unknown): NotesSnapshot | null {
  if (!isRecord(value) || value.schemaVersion !== NOTES_SCHEMA_VERSION) return null;
  try {
    const notes = parseNotes(value.notes);
    const requestedId = typeof value.selectedId === 'string' ? value.selectedId : null;
    return {
      schemaVersion: 1,
      notes,
      selectedId: selectedNoteId(notes, null, requestedId),
      listScroll: Math.max(0, finiteNumber(value.listScroll)),
      editorScroll: Math.max(0, finiteNumber(value.editorScroll)),
    };
  } catch {
    return null;
  }
}

export function wrapNoteLines(text: string, maxWidth: number, measure: (value: string) => number): string[] {
  const width = Math.max(1, maxWidth);
  const lines: string[] = [];
  for (const paragraph of normalizeBody(text).split('\n')) {
    if (!paragraph) {
      lines.push('');
      continue;
    }
    let line = '';
    for (const word of paragraph.split(/(\s+)/).filter((part) => part.length > 0)) {
      const candidate = line + word;
      if (!line || measure(candidate) <= width) {
        line = candidate;
        continue;
      }
      lines.push(line.trimEnd());
      line = word.trimStart();
      while (line && measure(line) > width) {
        if (line.length === 1) {
          lines.push(line);
          line = '';
          break;
        }
        let end = line.length - 1;
        while (end > 1 && measure(line.slice(0, end)) > width) end -= 1;
        lines.push(line.slice(0, end));
        line = line.slice(end);
      }
    }
    lines.push(line.trimEnd());
  }
  return lines.length ? lines : [''];
}

export class NotesRepository {
  readonly #storage: NotesStorage;
  readonly #key: string;

  constructor(storage: NotesStorage = indexedDbStorage, key = NOTES_STORAGE_KEY) {
    this.#storage = storage;
    this.#key = key;
  }

  async load(): Promise<Note[]> {
    return parseNotesDocument(await this.#storage.get<unknown>(this.#key));
  }

  async save(notes: Note[]): Promise<void> {
    await this.#storage.set(this.#key, { schemaVersion: NOTES_SCHEMA_VERSION, notes: parseNotes(notes) });
  }
}

function listWidth(width: number): number {
  return Math.max(210, Math.min(300, Math.floor(width * 0.29)));
}

function noteSnippet(note: Note): string {
  return note.body.replace(/\s+/g, ' ').trim() || 'Empty note';
}

function formatNoteDate(timestamp: number): string {
  return new Date(timestamp).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function createNotesApp(context: ApplicationContext, options: NotesAppOptions = {}): ApplicationInstance {
  const actions: CanvasAction[] = [];
  const rows: NoteRow[] = [];
  const repository = options.repository ?? new NotesRepository(options.storage);
  const now = options.now ?? Date.now;
  const createId = options.createId ?? (() => crypto.randomUUID());
  const debounceMs = options.debounceMs ?? NOTES_AUTOSAVE_DELAY_MS;
  let notes: Note[] = [];
  let selectedId: string | null = null;
  let listScroll = 0;
  let editorScroll = 0;
  let pointerX = 0;
  let saveState: SaveState = 'loading';
  let status = 'Loading notes from this device…';
  let autosaveTimer: ReturnType<typeof setTimeout> | null = null;
  let saveQueue: Promise<void> = Promise.resolve();
  let mutationRevision = 0;
  let persistedRevision = -1;
  let loadGeneration = 0;
  let interactionGeneration = 0;
  let destroyed = false;

  const selectedNote = (): Note | undefined => notes.find((note) => note.id === selectedId);
  const requestRender = (): void => {
    if (!destroyed) context.window.requestRender();
  };

  const editorLines = (width: number): string[] => {
    const note = selectedNote();
    if (!note) return [];
    const measurement = context.window.context;
    measurement.save();
    measurement.font = '15px -apple-system, BlinkMacSystemFont, sans-serif';
    const lines = wrapNoteLines(note.body, Math.max(100, width - listWidth(width) - 64), (value) => measurement.measureText(value).width);
    measurement.restore();
    return lines;
  };

  const maximumListScroll = (height: number): number => {
    const viewport = Math.max(0, height - TOOLBAR_HEIGHT - 48);
    return Math.max(0, notes.length * LIST_ROW_HEIGHT - viewport);
  };

  const maximumEditorScroll = (width: number, height: number): number => {
    const viewport = Math.max(0, height - TOOLBAR_HEIGHT - 76);
    return Math.max(0, editorLines(width).length * EDITOR_LINE_HEIGHT - viewport + 18);
  };

  const clampScroll = (): void => {
    const { width, height } = context.window.canvas;
    listScroll = Math.max(0, Math.min(maximumListScroll(height), listScroll));
    editorScroll = Math.max(0, Math.min(maximumEditorScroll(width, height), editorScroll));
  };

  const ensureSelectedVisible = (): void => {
    const index = notes.findIndex((note) => note.id === selectedId);
    if (index < 0) return;
    const { height } = context.window.canvas;
    const viewport = Math.max(0, height - TOOLBAR_HEIGHT - 48);
    const rowTop = index * LIST_ROW_HEIGHT;
    const rowBottom = rowTop + LIST_ROW_HEIGHT;
    if (rowTop < listScroll) listScroll = rowTop;
    else if (rowBottom > listScroll + viewport) listScroll = Math.max(0, rowBottom - viewport);
    listScroll = Math.min(listScroll, maximumListScroll(height));
  };

  const clearAutosaveTimer = (): void => {
    if (autosaveTimer !== null) clearTimeout(autosaveTimer);
    autosaveTimer = null;
  };

  const saveNow = (): Promise<void> => {
    clearAutosaveTimer();
    const revision = mutationRevision;
    if (revision === persistedRevision && saveState === 'saved') return saveQueue;
    const snapshot = parseNotes(notes);
    saveState = 'saving';
    status = 'Saving notes to IndexedDB…';
    requestRender();
    const task = saveQueue.catch(() => undefined).then(() => repository.save(snapshot));
    saveQueue = task.catch(() => undefined);
    void task.then(() => {
      persistedRevision = Math.max(persistedRevision, revision);
      if (destroyed || revision !== mutationRevision) return;
      saveState = 'saved';
      status = 'All changes saved locally.';
      requestRender();
    }, (error: unknown) => {
      if (destroyed) return;
      saveState = 'error';
      status = `Local save failed: ${error instanceof Error ? error.message : 'IndexedDB is unavailable.'} Changes remain in memory.`;
      requestRender();
    });
    return task;
  };

  const scheduleAutosave = (): void => {
    clearAutosaveTimer();
    saveState = 'dirty';
    status = 'Unsaved changes — autosave pending…';
    autosaveTimer = setTimeout(() => {
      autosaveTimer = null;
      void saveNow().catch(() => undefined);
    }, Math.max(0, debounceMs));
    requestRender();
  };

  const applyNotes = (nextNotes: Note[], nextSelectedId: string | null, immediate: boolean): void => {
    notes = parseNotes(nextNotes);
    selectedId = selectedNoteId(notes, selectedId, nextSelectedId);
    mutationRevision += 1;
    ensureSelectedVisible();
    clampScroll();
    if (immediate) void saveNow().catch(() => undefined);
    else scheduleAutosave();
    requestRender();
  };

  const load = async (): Promise<void> => {
    const generation = ++loadGeneration;
    saveState = 'loading';
    status = 'Loading notes from this device…';
    requestRender();
    try {
      const loaded = await repository.load();
      if (destroyed || generation !== loadGeneration) return;
      notes = loaded;
      selectedId = selectedNoteId(notes, selectedId);
      persistedRevision = mutationRevision;
      saveState = 'saved';
      status = notes.length ? `${notes.length} ${notes.length === 1 ? 'note' : 'notes'} stored on this device.` : 'No notes yet. New notes stay on this device.';
      ensureSelectedVisible();
      clampScroll();
    } catch (error: unknown) {
      if (destroyed || generation !== loadGeneration) return;
      saveState = 'error';
      status = `Could not read IndexedDB: ${error instanceof Error ? error.message : 'Local storage is unavailable.'}`;
    }
    requestRender();
  };

  const create = (): void => {
    if (destroyed) return;
    const generation = interactionGeneration;
    void context.requestText({
      title: 'New local note',
      value: '',
      placeholder: 'Write a note. Enter inserts a new line and Create note confirms.',
      submitLabel: 'Create note',
      cancelLabel: 'Cancel',
      multiline: true,
    }).then((value) => {
      if (value === null || destroyed || generation !== interactionGeneration) return;
      const note = createNote(value, now(), createId());
      applyNotes([note, ...notes], note.id, true);
    }).catch((error: unknown) => {
      if (destroyed || generation !== interactionGeneration) return;
      status = error instanceof Error ? error.message : 'Note entry is unavailable.';
      requestRender();
    });
  };

  const edit = (): void => {
    const note = selectedNote();
    if (!note || destroyed) {
      create();
      return;
    }
    const generation = interactionGeneration;
    void context.requestText({
      title: note.title,
      value: note.body,
      placeholder: 'Edit multiline text. Enter inserts a new line; Save note confirms.',
      submitLabel: 'Save note',
      cancelLabel: 'Cancel',
      multiline: true,
    }).then((value) => {
      if (value === null || destroyed || generation !== interactionGeneration) return;
      applyNotes(updateNoteBody(notes, note.id, value, now()), selectedId, false);
    }).catch((error: unknown) => {
      if (destroyed || generation !== interactionGeneration) return;
      status = error instanceof Error ? error.message : 'Note editing is unavailable.';
      requestRender();
    });
  };

  const remove = (): void => {
    const note = selectedNote();
    if (!note || destroyed) return;
    const generation = interactionGeneration;
    void context.requestConfirm(`Delete “${note.title}” from this device? This cannot be undone.`).then((confirmed) => {
      if (!confirmed || destroyed || generation !== interactionGeneration || !notes.some((candidate) => candidate.id === note.id)) return;
      const result = removeNote(notes, note.id, selectedId);
      applyNotes(result.notes, result.selectedId, true);
    }).catch((error: unknown) => {
      if (destroyed || generation !== interactionGeneration) return;
      status = error instanceof Error ? error.message : 'The delete confirmation was unavailable.';
      requestRender();
    });
  };

  const scrollContent = (area: ScrollArea, deltaY: number): void => {
    if (!Number.isFinite(deltaY)) return;
    if (area === 'list') listScroll += deltaY;
    else editorScroll += deltaY;
    clampScroll();
    requestRender();
  };

  void load();

  return {
    render: (ctx, width, height) => {
      actions.length = 0;
      rows.length = 0;
      const sidebar = listWidth(width);
      const editorX = sidebar + 8;
      const editorWidth = Math.max(120, width - editorX - 16);
      const current = selectedNote();

      fillRoundedRect(ctx, 16, 12, width - 32, 48, 13, 'rgba(255,255,255,.045)');
      actions.push(drawButton(ctx, 28, 20, 88, 32, 'New note', create, false, '#b7f8de'));
      actions.push(drawButton(ctx, 124, 20, 82, 32, 'Edit', edit, Boolean(current), '#b7f8de'));
      actions.push(drawButton(ctx, 214, 20, 86, 32, 'Delete', remove, Boolean(current), '#ff9db0'));
      actions.push(drawButton(ctx, 308, 20, 82, 32, 'Save now', () => { void saveNow().catch(() => undefined); }, saveState === 'saving'));
      ctx.fillStyle = saveState === 'error' ? '#ffb3bc' : saveState === 'dirty' || saveState === 'saving' ? '#ffe0aa' : '#9aacc4';
      ctx.font = '11px -apple-system, BlinkMacSystemFont, sans-serif';
      const stereoHint = context.isVrActive() ? '  •  Stereo text entry is single-line' : '';
      ctx.fillText(ellipsis(ctx, `${status}  •  Local-first / IndexedDB${stereoHint}`, width - 430), 410, 40, Math.max(80, width - 430));

      const panelTop = TOOLBAR_HEIGHT;
      const panelHeight = Math.max(80, height - panelTop - 14);
      fillRoundedRect(ctx, 16, panelTop, sidebar - 24, panelHeight, 15, 'rgba(255,255,255,.028)');
      roundedRect(ctx, 16, panelTop, sidebar - 24, panelHeight, 15);
      ctx.strokeStyle = 'rgba(255,255,255,.10)';
      ctx.stroke();
      fillRoundedRect(ctx, editorX, panelTop, editorWidth, panelHeight, 15, 'rgba(183,248,222,.025)');
      roundedRect(ctx, editorX, panelTop, editorWidth, panelHeight, 15);
      ctx.strokeStyle = 'rgba(183,248,222,.13)';
      ctx.stroke();

      ctx.fillStyle = '#9aacc4';
      ctx.font = '650 10px -apple-system, BlinkMacSystemFont, sans-serif';
      ctx.fillText(`NOTES  ${notes.length}`, 30, panelTop + 23);
      ctx.fillText('EDITOR', editorX + 16, panelTop + 23);
      const listTop = panelTop + 34;
      const listBottom = height - 16;
      ctx.save();
      ctx.beginPath();
      ctx.rect(22, listTop, sidebar - 36, Math.max(0, listBottom - listTop));
      ctx.clip();
      ctx.translate(0, -listScroll);
      notes.forEach((note, index) => {
        const y = listTop + index * LIST_ROW_HEIGHT;
        if (y + LIST_ROW_HEIGHT - listScroll < listTop || y - listScroll > listBottom) return;
        const selected = note.id === selectedId;
        fillRoundedRect(ctx, 24, y + 3, sidebar - 40, LIST_ROW_HEIGHT - 8, 10, selected ? 'rgba(183,248,222,.12)' : 'rgba(255,255,255,.035)');
        if (selected) {
          roundedRect(ctx, 24, y + 3, sidebar - 40, LIST_ROW_HEIGHT - 8, 10);
          ctx.strokeStyle = 'rgba(183,248,222,.48)';
          ctx.stroke();
        }
        ctx.fillStyle = selected ? '#b7f8de' : '#e8f2ff';
        ctx.font = '650 13px -apple-system, BlinkMacSystemFont, sans-serif';
        ctx.fillText(ellipsis(ctx, note.title, sidebar - 72), 36, y + 25, sidebar - 72);
        ctx.fillStyle = '#9aacc4';
        ctx.font = '11px -apple-system, BlinkMacSystemFont, sans-serif';
        ctx.fillText(ellipsis(ctx, noteSnippet(note), sidebar - 72), 36, y + 44, sidebar - 72);
        ctx.font = '10px -apple-system, BlinkMacSystemFont, sans-serif';
        ctx.fillText(formatNoteDate(note.updatedAt), 36, y + 61);
        rows.push({ note, x: 24, y: y + 3 - listScroll, width: sidebar - 40, height: LIST_ROW_HEIGHT - 8 });
      });
      ctx.restore();

      if (!notes.length) {
        ctx.fillStyle = '#9aacc4';
        ctx.font = '12px -apple-system, BlinkMacSystemFont, sans-serif';
        ctx.fillText(saveState === 'loading' ? 'Reading IndexedDB…' : 'No local notes', 36, listTop + 30, sidebar - 72);
      }

      if (!current) {
        ctx.textAlign = 'center';
        ctx.fillStyle = '#b7f8de';
        ctx.font = '600 12px -apple-system, BlinkMacSystemFont, sans-serif';
        ctx.fillText('LOCAL NOTE EDITOR', editorX + editorWidth / 2, panelTop + panelHeight / 2 - 12);
        ctx.fillStyle = '#9aacc4';
        ctx.font = '13px -apple-system, BlinkMacSystemFont, sans-serif';
        ctx.fillText('Choose New note to write on this device.', editorX + editorWidth / 2, panelTop + panelHeight / 2 + 16, editorWidth - 40);
        ctx.textAlign = 'left';
        return;
      }

      ctx.fillStyle = '#eefbf5';
      ctx.font = '700 18px -apple-system, BlinkMacSystemFont, sans-serif';
      ctx.fillText(ellipsis(ctx, current.title, editorWidth - 32), editorX + 16, panelTop + 52, editorWidth - 32);
      ctx.fillStyle = '#9aacc4';
      ctx.font = '11px -apple-system, BlinkMacSystemFont, sans-serif';
      const updated = new Date(current.updatedAt).toLocaleString();
      ctx.fillText(ellipsis(ctx, `${updated}  •  ${current.body.length.toLocaleString()} characters  •  Autosave ${debounceMs} ms`, editorWidth - 32), editorX + 16, panelTop + 72, editorWidth - 32);
      const bodyTop = panelTop + 86;
      const bodyBottom = height - 16;
      ctx.save();
      ctx.beginPath();
      ctx.rect(editorX + 12, bodyTop, editorWidth - 24, Math.max(0, bodyBottom - bodyTop));
      ctx.clip();
      ctx.translate(0, -editorScroll);
      ctx.fillStyle = '#dce7f7';
      ctx.font = '15px -apple-system, BlinkMacSystemFont, sans-serif';
      if (!current.body) {
        ctx.fillStyle = '#9aacc4';
        ctx.fillText('This note is empty. Choose Edit to write.', editorX + 18, bodyTop + 28, editorWidth - 36);
      } else {
        editorLines(width).forEach((line, index) => {
          ctx.fillText(line || ' ', editorX + 18, bodyTop + 24 + index * EDITOR_LINE_HEIGHT, editorWidth - 36);
        });
      }
      ctx.restore();
    },
    pointer: (x, y, event) => {
      pointerX = x;
      if (event.type !== 'pointerup' && event.type !== 'click') return false;
      if (actionAt(actions, x, y)) return true;
      const row = rows.find((candidate) => x >= candidate.x && x <= candidate.x + candidate.width && y >= candidate.y && y <= candidate.y + candidate.height);
      if (row) {
        selectedId = row.note.id;
        editorScroll = 0;
        ensureSelectedVisible();
        requestRender();
        return true;
      }
      if (currentEditorBounds(x, y, context.window.canvas.width, context.window.canvas.height)) {
        edit();
        return true;
      }
      return false;
    },
    openKeyboard: edit,
    scroll: (deltaY) => {
      const sidebar = listWidth(context.window.canvas.width);
      scrollContent(pointerX > 0 && pointerX < sidebar ? 'list' : 'editor', deltaY);
      return true;
    },
    serialize: (): NotesSnapshot => ({
      schemaVersion: 1,
      notes: notes.map((note) => ({ ...note })),
      selectedId,
      listScroll,
      editorScroll,
    }),
    restore: (value: unknown) => {
      const snapshot = restoreNotesSnapshot(value);
      if (!snapshot || destroyed) {
        if (!destroyed) {
          status = 'Saved window state was invalid; current notes were kept.';
          requestRender();
        }
        return;
      }
      loadGeneration += 1;
      interactionGeneration += 1;
      clearAutosaveTimer();
      notes = snapshot.notes;
      selectedId = snapshot.selectedId;
      listScroll = snapshot.listScroll;
      editorScroll = snapshot.editorScroll;
      mutationRevision += 1;
      saveState = 'dirty';
      status = 'Restored window notes — saving locally…';
      clampScroll();
      void saveNow().catch(() => undefined);
    },
    suspend: () => {
      clearAutosaveTimer();
      if (mutationRevision !== persistedRevision) void saveNow().catch(() => undefined);
    },
    resume: () => requestRender(),
    destroy: () => {
      if (destroyed) return;
      destroyed = true;
      interactionGeneration += 1;
      loadGeneration += 1;
      clearAutosaveTimer();
      actions.length = 0;
      rows.length = 0;
      if (mutationRevision !== persistedRevision) void saveNow().catch(() => undefined);
    },
  };
}

function currentEditorBounds(x: number, y: number, width: number, height: number): boolean {
  const editorX = listWidth(width) + 8;
  return x >= editorX && x <= width - 16 && y >= TOOLBAR_HEIGHT + 86 && y <= height - 16;
}

export const notesApplication: ApplicationDefinition = {
  id: 'notes',
  name: 'Notes',
  icon: '▤',
  color: '#b7f8de',
  description: 'Local-first multiline notes with IndexedDB autosave.',
  stereoSafe: true,
  create: createNotesApp,
};

export const notesApp = notesApplication;
