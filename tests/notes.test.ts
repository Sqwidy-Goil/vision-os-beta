import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  NOTES_STORAGE_KEY,
  NotesRepository,
  createNote,
  createNotesApp,
  noteTitle,
  parseNotesDocument,
  removeNote,
  restoreNotesSnapshot,
  selectedNoteId,
  updateNoteBody,
  wrapNoteLines,
  type NotesAppOptions,
  type NotesSnapshot,
  type NotesStorage,
} from '../src/applications/notes';
import type { ApplicationContext, ApplicationInstance } from '../src/types';

function memoryStorage(initial: unknown = undefined, key = NOTES_STORAGE_KEY) {
  const values = new Map<string, unknown>();
  if (initial !== undefined) values.set(key, structuredClone(initial));
  return {
    values,
    get: async <T>(storageKey: string): Promise<T | undefined> => structuredClone(values.get(storageKey)) as T | undefined,
    set: vi.fn(async (storageKey: string, value: unknown): Promise<void> => { values.set(storageKey, structuredClone(value)); }),
  };
}

function fakeCanvasContext(): CanvasRenderingContext2D {
  return {
    fillStyle: '',
    strokeStyle: '',
    font: '',
    textAlign: 'left',
    textBaseline: 'alphabetic',
    lineWidth: 1,
    save: vi.fn(),
    restore: vi.fn(),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    arcTo: vi.fn(),
    closePath: vi.fn(),
    fill: vi.fn(),
    stroke: vi.fn(),
    rect: vi.fn(),
    clip: vi.fn(),
    translate: vi.fn(),
    fillText: vi.fn(),
    measureText: vi.fn((text: string) => ({ width: text.length * 7 })),
  } as unknown as CanvasRenderingContext2D;
}

function appContext() {
  const ctx = fakeCanvasContext();
  const canvas = { width: 1024, height: 548, context: ctx } as unknown as HTMLCanvasElement;
  const requestRender = vi.fn();
  const requestText = vi.fn(async (): Promise<string | null> => null);
  const requestConfirm = vi.fn(async (): Promise<boolean> => false);
  const context = {
    window: { id: 'notes-test', canvas, context: ctx, requestRender },
    requestText,
    requestConfirm,
    isVrActive: () => false,
  } as unknown as ApplicationContext;
  return { context, ctx, requestRender, requestText, requestConfirm };
}

function click(app: ApplicationInstance, x: number, y: number): boolean {
  return app.pointer?.(x, y, { type: 'pointerup' } as PointerEvent) ?? false;
}

function snapshot(app: ApplicationInstance): NotesSnapshot {
  return app.serialize?.() as NotesSnapshot;
}

const instances: ApplicationInstance[] = [];

function notesApp(context: ApplicationContext, storage: NotesStorage, options: Omit<NotesAppOptions, 'storage' | 'repository'> = {}) {
  const app = createNotesApp(context, { storage, ...options });
  instances.push(app);
  return app;
}

beforeEach(() => {
  vi.useRealTimers();
});

afterEach(() => {
  instances.splice(0).forEach((app) => app.destroy?.());
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('Notes model and IndexedDB repository', () => {
  it('derives titles, preserves multiline bodies, and normalizes restored documents', () => {
    const note = createNote('  First line\r\nSecond line\n\nFourth', 100, 'note-1');
    expect(note).toEqual({
      id: 'note-1',
      title: 'First line',
      body: '  First line\nSecond line\n\nFourth',
      createdAt: 100,
      updatedAt: 100,
    });
    expect(noteTitle('\n\n  Heading  \nBody')).toBe('Heading');
    expect(noteTitle(' \n\t')).toBe('Untitled note');

    const restored = parseNotesDocument({
      schemaVersion: 1,
      notes: [note, { ...note, id: 'note-2', updatedAt: 200, title: 'Newer' }],
    });
    expect(restored.map((entry) => entry.id)).toEqual(['note-2', 'note-1']);
    expect(() => parseNotesDocument({ schemaVersion: 99, notes: [] })).toThrow(/unsupported/);
    expect(() => parseNotesDocument({ schemaVersion: 1, notes: [note, note] })).toThrow(/duplicate/);
  });

  it('loads and atomically saves the note list through the storage wrapper', async () => {
    const storage = memoryStorage({
      schemaVersion: 1,
      notes: [createNote('Saved locally', 20, 'saved')],
    }, 'custom-notes');
    const repository = new NotesRepository(storage, 'custom-notes');
    await expect(repository.load()).resolves.toMatchObject([{ id: 'saved', body: 'Saved locally' }]);

    const next = [createNote('Atomic replacement', 30, 'next')];
    await repository.save(next);
    expect(storage.set).toHaveBeenCalledWith('custom-notes', { schemaVersion: 1, notes: next });
    expect(storage.values.get('custom-notes')).toEqual({ schemaVersion: 1, notes: next });
  });

  it('selects valid notes and chooses a nearby selection after confirmed deletion', () => {
    const notes = [
      createNote('One', 10, 'one'),
      createNote('Two', 20, 'two'),
      createNote('Three', 30, 'three'),
    ];
    expect(selectedNoteId(notes, 'one', 'missing')).toBe('one');
    expect(selectedNoteId(notes, 'missing', 'two')).toBe('two');
    expect(selectedNoteId([], 'one')).toBeNull();
    expect(removeNote(notes, 'two', 'two')).toEqual({ notes: [notes[0], notes[2]], selectedId: 'three' });
    expect(removeNote(notes, 'three', 'three').selectedId).toBe('two');
    expect(removeNote(notes, 'missing', 'one').selectedId).toBe('one');
    expect(removeNote(notes, 'one', 'one').notes).toHaveLength(2);
  });

  it('updates bodies immutably and wraps paragraphs without dropping blank lines', () => {
    const notes = [createNote('Before', 10, 'one')];
    const updated = updateNoteBody(notes, 'one', 'After\n\nDetails', 20);
    expect(notes[0].body).toBe('Before');
    expect(updated[0]).toMatchObject({ title: 'After', body: 'After\n\nDetails', updatedAt: 20 });
    expect(updateNoteBody(updated, 'one', 'After\n\nDetails', 30)).toBe(updated);
    expect(wrapNoteLines('Alpha beta\n\nGamma', 70, (text) => text.length * 10)).toEqual(['Alpha', 'beta', '', 'Gamma']);
    expect(wrapNoteLines('W', 5, () => 100)).toEqual(['W']);
  });

  it('restores selection and scroll while rejecting malformed snapshots', () => {
    const notes = [createNote('One', 10, 'one'), createNote('Two', 20, 'two')];
    expect(restoreNotesSnapshot({ schemaVersion: 1, notes, selectedId: 'two', listScroll: 25, editorScroll: 40 }))
      .toMatchObject({ selectedId: 'two', listScroll: 25, editorScroll: 40 });
    expect(restoreNotesSnapshot({ schemaVersion: 1, notes, selectedId: 'missing' })?.selectedId).toBe('two');
    expect(restoreNotesSnapshot({ schemaVersion: 1, notes: [{ id: 'bad' }] })).toBeNull();
  });
});

describe('Notes Canvas application', () => {
  it('loads local notes, selects rows, edits with multiline requestText, and confirms deletion', async () => {
    const storage = memoryStorage({
      schemaVersion: 1,
      notes: [createNote('First note', 10, 'one'), createNote('Second note', 20, 'two')],
    });
    const harness = appContext();
    harness.requestText.mockResolvedValue('Edited title\nSecond line\n\nFourth line');
    harness.requestConfirm.mockResolvedValue(true);
    const app = notesApp(harness.context, storage, { debounceMs: 60_000, now: () => 30 });
    await vi.waitFor(() => expect(snapshot(app).notes).toHaveLength(2));

    app.render(harness.ctx, 1024, 548, 0);
    expect(click(app, 100, 140)).toBe(true);
    expect(snapshot(app).selectedId).toBe('two');

    expect(click(app, 165, 36)).toBe(true);
    expect(harness.requestText).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Second note',
      value: 'Second note',
      submitLabel: 'Save note',
    }));
    await vi.waitFor(() => expect(snapshot(app).notes[0].body).toContain('Second line'));
    expect(storage.set).not.toHaveBeenCalled();

    expect(click(app, 257, 36)).toBe(true);
    expect(harness.requestConfirm).toHaveBeenCalledWith(expect.stringContaining('Edited title'));
    await vi.waitFor(() => expect(snapshot(app).notes).toHaveLength(1));
    await vi.waitFor(() => expect(storage.set).toHaveBeenCalled());
    expect(snapshot(app).notes.map((note) => note.id)).toEqual(['one']);
    expect(snapshot(app).selectedId).toBe('one');
  });

  it('creates a note immediately and keeps it in memory when IndexedDB rejects the write', async () => {
    const storage = memoryStorage();
    storage.set.mockRejectedValue(new Error('Quota exceeded'));
    const harness = appContext();
    harness.requestText.mockResolvedValue('New local body');
    const app = notesApp(harness.context, storage, { createId: () => 'created', now: () => 50 });
    await vi.waitFor(() => expect(harness.requestRender).toHaveBeenCalled());

    app.render(harness.ctx, 1024, 548, 0);
    expect(click(app, 72, 36)).toBe(true);
    await vi.waitFor(() => expect(snapshot(app).notes).toHaveLength(1));
    await vi.waitFor(() => expect(storage.set).toHaveBeenCalled());
    expect(snapshot(app).notes[0]).toMatchObject({ id: 'created', body: 'New local body' });
    expect(harness.requestText).toHaveBeenCalledWith(expect.objectContaining({ submitLabel: 'Create note' }));
  });

  it('does not delete when confirmation is cancelled or text entry is cancelled', async () => {
    const storage = memoryStorage({ schemaVersion: 1, notes: [createNote('Keep me', 10, 'keep')] });
    const harness = appContext();
    harness.requestConfirm.mockResolvedValue(false);
    harness.requestText.mockResolvedValue(null);
    const app = notesApp(harness.context, storage);
    await vi.waitFor(() => expect(snapshot(app).notes).toHaveLength(1));
    app.render(harness.ctx, 1024, 548, 0);

    click(app, 257, 36);
    click(app, 72, 36);
    await Promise.resolve();
    expect(snapshot(app).notes).toHaveLength(1);
    expect(storage.set).not.toHaveBeenCalled();
  });

  it('debounces autosave and flushes the latest edit during destroy cleanup', async () => {
    vi.useFakeTimers();
    const storage = memoryStorage({ schemaVersion: 1, notes: [createNote('Before', 10, 'one')] });
    const harness = appContext();
    harness.requestText.mockResolvedValueOnce('First edit').mockResolvedValueOnce('Latest edit');
    const debounceMs = 500;
    const app = notesApp(harness.context, storage, { debounceMs, now: () => 20 });
    await vi.advanceTimersByTimeAsync(0);
    expect(snapshot(app).notes).toHaveLength(1);
    app.render(harness.ctx, 1024, 548, 0);

    click(app, 165, 36);
    await vi.advanceTimersByTimeAsync(0);
    expect(snapshot(app).notes[0].body).toBe('First edit');
    await vi.advanceTimersByTimeAsync(debounceMs - 1);
    expect(storage.set).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(storage.set).toHaveBeenCalledTimes(1);
    expect(storage.values.get(NOTES_STORAGE_KEY)).toMatchObject({ notes: [{ body: 'First edit' }] });

    click(app, 165, 36);
    await vi.advanceTimersByTimeAsync(0);
    expect(snapshot(app).notes[0].body).toBe('Latest edit');
    expect(storage.set).toHaveBeenCalledTimes(1);
    app.destroy?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(storage.set).toHaveBeenCalledTimes(2);
    expect(storage.values.get(NOTES_STORAGE_KEY)).toMatchObject({ notes: [{ body: 'Latest edit' }] });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('serializes and restores notes, selection, and independent list/editor scroll', async () => {
    const storage = memoryStorage();
    const harness = appContext();
    const app = notesApp(harness.context, storage, { debounceMs: 60_000 });
    const longBody = Array.from({ length: 80 }, (_, index) => `Line ${index}`).join('\n');
    const value: NotesSnapshot = {
      schemaVersion: 1,
      notes: [
        createNote(longBody, 20, 'two'),
        ...Array.from({ length: 6 }, (_, index) => createNote(`List note ${index}`, 10 - index, `list-${index}`)),
        createNote('One', 0, 'one'),
      ],
      selectedId: 'two',
      listScroll: 15,
      editorScroll: 35,
    };
    app.restore?.(value);
    expect(snapshot(app)).toEqual(value);
    await vi.waitFor(() => expect(storage.set).toHaveBeenCalled());

    app.render(harness.ctx, 1024, 548, 0);
    app.pointer?.(100, 200, { type: 'pointermove' } as PointerEvent);
    app.scroll?.(10_000);
    const listScroll = snapshot(app).listScroll;
    expect(listScroll).toBeGreaterThan(0);
    app.pointer?.(600, 200, { type: 'pointermove' } as PointerEvent);
    app.scroll?.(10_000);
    expect(snapshot(app).editorScroll).toBeGreaterThan(snapshot(app).listScroll);

    const before = snapshot(app);
    app.restore?.({ schemaVersion: 1, notes: [{ id: 'bad' }] });
    expect(snapshot(app)).toEqual(before);
  });
});
