import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPhotosApp } from '../src/applications/media';
import { storage } from '../src/core/storage';
import type { ApplicationContext, ApplicationInstance, StoredFile } from '../src/types';

interface PhotosState {
  schemaVersion: number;
  photoIds: string[];
  selectedId: string | null;
}

class FakeImage {
  naturalWidth = 64;
  naturalHeight = 64;
  onload: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  crossOrigin = '';
  referrerPolicy = '';
  private source = '';

  get src(): string {
    return this.source;
  }

  set src(value: string) {
    this.source = value;
    queueMicrotask(() => this.onload?.(new Event('load')));
  }
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
    fillText: vi.fn(),
    measureText: vi.fn((text: string) => ({ width: text.length * 7 })),
  } as unknown as CanvasRenderingContext2D;
}

function photosContext() {
  const ctx = fakeCanvasContext();
  const canvas = { width: 1024, height: 548, context: ctx } as unknown as HTMLCanvasElement;
  const requestRender = vi.fn();
  const context = {
    window: { id: 'photos-test', canvas, context: ctx, requestRender },
    notify: vi.fn(),
  } as unknown as ApplicationContext;
  return { context, requestRender };
}

function snapshot(app: ApplicationInstance): PhotosState {
  return app.serialize?.() as PhotosState;
}

function storedImage(id: string, type = 'image/png'): StoredFile {
  return {
    id,
    name: `${id}.png`,
    type,
    size: 4,
    createdAt: 1,
    blob: new Blob(['data'], { type }),
  };
}

const instances: ApplicationInstance[] = [];
let records: Map<string, StoredFile>;
let getFile: ReturnType<typeof vi.spyOn>;

function photosApp(context: ApplicationContext): ApplicationInstance {
  const app = createPhotosApp(context);
  instances.push(app);
  return app;
}

beforeEach(() => {
  records = new Map();
  vi.stubGlobal('Image', FakeImage);
  vi.stubGlobal('URL', {
    createObjectURL: vi.fn(() => `blob:photo-${records.size}-${Math.random()}`),
    revokeObjectURL: vi.fn(),
  });
  vi.spyOn(storage, 'listFiles').mockImplementation(async () => [...records.values()]);
  getFile = vi.spyOn(storage, 'getFile').mockImplementation(async (id: string) => records.get(id));
});

afterEach(() => {
  instances.splice(0).forEach((app) => app.destroy?.());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('Photos spatial window state', () => {
  it('round-trips gallery IDs and the selected stored photo', async () => {
    records.set('one', storedImage('one'));
    records.set('two', storedImage('two'));
    const harness = photosContext();
    const original = photosApp(harness.context);
    await vi.waitFor(() => expect(snapshot(original).photoIds).toHaveLength(2));
    original.restore?.({ schemaVersion: 1, photoIds: ['two', 'one'], selectedId: 'one' });
    await vi.waitFor(() => expect(snapshot(original).selectedId).toBe('one'));
    expect(snapshot(original).photoIds).toEqual(['two', 'one']);

    const restored = photosApp(harness.context);
    restored.restore?.(JSON.parse(JSON.stringify(snapshot(original))));
    await vi.waitFor(() => expect(snapshot(restored)).toEqual(snapshot(original)));
  });

  it('restores selected IDs only when an image record is available in IndexedDB', async () => {
    records.set('one', storedImage('one'));
    records.set('two', storedImage('two'));
    records.set('video', storedImage('video', 'video/mp4'));
    const harness = photosContext();
    const app = photosApp(harness.context);
    app.restore?.({
      schemaVersion: 1,
      photoIds: ['two', 'missing', 'video'],
      selectedId: 'two',
    });
    await vi.waitFor(() => expect(snapshot(app).selectedId).toBe('two'));
    expect(snapshot(app).photoIds).toEqual(['two', 'one']);
    expect(getFile).toHaveBeenCalledWith('missing');
    expect(getFile).toHaveBeenCalledWith('video');
    expect(snapshot(app).photoIds).not.toContain('missing');
    expect(snapshot(app).photoIds).not.toContain('video');
  });

  it('bounds IDs and excludes blobs, object URLs, credentials, and untrusted fields', async () => {
    const harness = photosContext();
    const app = photosApp(harness.context);
    const photoIds = Array.from({ length: 80 }, (_, index) => `photo-${index}`);
    expect(() => app.restore?.({
      schemaVersion: 1,
      photoIds: [...photoIds, 'x'.repeat(300)],
      selectedId: 'selected-missing',
      apiKey: 'api-secret',
      cookies: 'cookie-secret',
      blob: 'blob-secret',
      objectUrl: 'blob:object-secret',
    })).not.toThrow();
    await vi.waitFor(() => expect(getFile).toHaveBeenCalledTimes(64));
    const saved = snapshot(app);
    expect(saved.photoIds).toEqual([]);
    expect(saved.selectedId).toBeNull();
    expect(JSON.stringify(saved)).not.toMatch(/api-secret|cookie-secret|blob-secret|object-secret/);
    expect(saved).not.toHaveProperty('blob');
    expect(saved).not.toHaveProperty('objectUrl');
  });

  it('ignores malformed restore roots without throwing or changing valid state', async () => {
    records.set('one', storedImage('one'));
    const harness = photosContext();
    const app = photosApp(harness.context);
    await vi.waitFor(() => expect(snapshot(app).photoIds).toEqual(['one']));
    const before = snapshot(app);
    for (const value of [null, [], 42, { schemaVersion: 2 }, { schemaVersion: 1, url: 'javascript:alert(1)' }]) {
      expect(() => app.restore?.(value)).not.toThrow();
      if (value === null || Array.isArray(value) || typeof value !== 'object' || (value as { schemaVersion?: number }).schemaVersion !== 1) {
        expect(snapshot(app)).toEqual(before);
      }
    }
  });
});
