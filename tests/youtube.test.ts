import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createYouTubeApp, releaseYouTubePlayer, youtubePlayerState } from '../src/applications/youtube';
import { forgetYouTubeKey, getYouTubeKey, rememberYouTubeKey, searchYouTube, testYouTubeKey, type YouTubeVideo } from '../src/core/youtube';
import type { ApplicationContext, ApplicationInstance } from '../src/types';

function createLocalStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() { return values.size; },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => { values.delete(key); },
    setItem: (key, value) => { values.set(key, value); },
  };
}

describe('YouTube Data API client', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', createLocalStorage());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('stores only the explicitly saved key and can forget it', () => {
    rememberYouTubeKey('  restricted-key  ');
    expect(getYouTubeKey()).toBe('restricted-key');
    forgetYouTubeKey();
    expect(getYouTubeKey()).toBeNull();
    expect(() => rememberYouTubeKey('   ')).toThrow(/Enter a YouTube/);
  });

  it('searches real video metadata with pagination', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      items: [{
        id: { videoId: 'video-1' },
        snippet: {
          title: 'Spatial demo',
          channelTitle: 'Demo channel',
          publishedAt: '2026-11-01T00:00:00Z',
          thumbnails: { medium: { url: 'https://images.example/thumb.jpg' } },
        },
      }],
      nextPageToken: 'next-page',
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await searchYouTube('restricted-key', 'spatial demo', 'previous-page');
    const requestUrl = new URL(String(fetchMock.mock.calls[0][0]));
    expect(requestUrl.searchParams.get('key')).toBe('restricted-key');
    expect(requestUrl.searchParams.get('q')).toBe('spatial demo');
    expect(requestUrl.searchParams.get('pageToken')).toBe('previous-page');
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ cache: 'no-store', referrerPolicy: 'no-referrer' });
    expect(result).toEqual({
      videos: [{
        id: 'video-1',
        title: 'Spatial demo',
        channelTitle: 'Demo channel',
        publishedAt: '2026-11-01T00:00:00Z',
        thumbnailUrl: 'https://images.example/thumb.jpg',
      }],
      nextPageToken: 'next-page',
    });
  });

  it('explains API denial without echoing the key', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      error: { message: 'The request is missing a valid API key.' },
    }), { status: 403, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(testYouTubeKey('private-key')).rejects.toThrow(/API enablement, restrictions, quota/);
    await expect(testYouTubeKey('private-key')).rejects.not.toThrow(/private-key/);
  });
});

interface YouTubeState {
  schemaVersion: number;
  query: string;
  videos: YouTubeVideo[];
  nextPageToken: string;
  activeTab: 'results' | 'settings';
  scroll: number;
  selectedId: string;
  playing: boolean;
  currentTime: number;
}

interface FakePlayerOptions {
  videoId: string;
  playerVars?: Record<string, string | number>;
  events?: {
    onReady?: (event: { target: FakePlayer }) => void;
    onStateChange?: (event: { data: number }) => void;
    onError?: (event: { data: number }) => void;
  };
}

class FakePlayer {
  static instances: FakePlayer[] = [];
  playVideo = vi.fn();
  pauseVideo = vi.fn();
  nextVideo = vi.fn();
  previousVideo = vi.fn();
  seekTo = vi.fn();
  getCurrentTime = vi.fn(() => 42);
  getDuration = vi.fn(() => 120);
  getPlayerState = vi.fn(() => 2);
  destroy = vi.fn();

  constructor(readonly element: HTMLElement, readonly options: FakePlayerOptions) {
    FakePlayer.instances.push(this);
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

function youtubeContext() {
  const ctx = fakeCanvasContext();
  const canvas = { width: 1024, height: 400, context: ctx } as unknown as HTMLCanvasElement;
  const requestRender = vi.fn();
  const setOverlay = vi.fn();
  const context = {
    window: { id: 'youtube-test', canvas, context: ctx, requestRender, setOverlay },
    isVrActive: () => false,
    requestText: vi.fn(async (): Promise<string | null> => null),
  } as unknown as ApplicationContext;
  return { context, requestRender, setOverlay };
}

function snapshot(app: ApplicationInstance): YouTubeState {
  return app.serialize?.() as YouTubeState;
}

function video(id: string): YouTubeVideo {
  return { id, title: `Video ${id}`, channelTitle: 'Demo channel', publishedAt: '2026-11-01T00:00:00Z', thumbnailUrl: `https://i.ytimg.com/vi/${id}/hq.jpg` };
}

const instances: ApplicationInstance[] = [];

function youtubeApp(context: ApplicationContext): ApplicationInstance {
  const app = createYouTubeApp(context);
  instances.push(app);
  return app;
}

describe('YouTube spatial window state', () => {
  beforeEach(() => {
    FakePlayer.instances = [];
    vi.stubGlobal('localStorage', createLocalStorage());
    rememberYouTubeKey('restricted-secret-key');
    vi.stubGlobal('location', { origin: 'https://app.example' });
    vi.stubGlobal('window', {
      YT: { Player: FakePlayer, PlayerState: { PLAYING: 1, PAUSED: 2, ENDED: 0 } },
    });
    vi.stubGlobal('document', {
      createElement: vi.fn(() => ({ id: '', style: {} })),
      head: { append: vi.fn() },
    });
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    instances.splice(0).forEach((app) => app.destroy?.());
    releaseYouTubePlayer();
    forgetYouTubeKey();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('restores query, results, UI state, and selected player position without searching again', async () => {
    const harness = youtubeContext();
    const app = youtubeApp(harness.context);
    const videos = Array.from({ length: 4 }, (_, index) => video(`video-${index}`));
    app.restore?.({
      schemaVersion: 1,
      query: 'spatial demo',
      videos,
      nextPageToken: 'next-page',
      activeTab: 'settings',
      scroll: 25,
      selectedId: 'video-1',
      playing: false,
      currentTime: 42,
    });
    await vi.waitFor(() => expect(youtubePlayerState.currentId).toBe('video-1'));
    const player = FakePlayer.instances[0];
    player.options.events?.onReady?.({ target: player });
    expect(player.seekTo).toHaveBeenCalledWith(42, true);
    expect(player.pauseVideo).toHaveBeenCalledTimes(1);
    expect(player.playVideo).not.toHaveBeenCalled();
    expect(snapshot(app)).toMatchObject({
      query: 'spatial demo',
      videos,
      nextPageToken: 'next-page',
      activeTab: 'settings',
      scroll: 25,
      selectedId: 'video-1',
      playing: false,
      currentTime: 42,
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('never serializes API keys, tokens, key visibility, or untrusted secret fields', async () => {
    const harness = youtubeContext();
    const app = youtubeApp(harness.context);
    app.restore?.({
      schemaVersion: 1,
      query: 'safe query',
      videos: [{ ...video('video-1'), thumbnailUrl: 'https://i.ytimg.com/vi/video-1/hq.jpg?token=thumb-secret' }],
      selectedId: 'video-1',
      playing: false,
      currentTime: 0,
      apiKey: 'injected-api-secret',
      accessToken: 'injected-access-secret',
      status: 'injected-status-secret',
      showKey: true,
    });
    await vi.waitFor(() => expect(youtubePlayerState.currentId).toBe('video-1'));
    const serialized = JSON.stringify(snapshot(app));
    expect(serialized).not.toMatch(/restricted-secret-key|injected-api-secret|injected-access-secret|injected-status-secret|thumb-secret/);
    expect(serialized).not.toContain('showKey');
    expect(getYouTubeKey()).toBe('restricted-secret-key');
  });

  it('bounds restored collections and strings and validates media URLs and IDs', () => {
    const harness = youtubeContext();
    const app = youtubeApp(harness.context);
    const videos = Array.from({ length: 60 }, (_, index) => ({
      ...video(`video-${index}`),
      title: 't'.repeat(500),
      channelTitle: 'c'.repeat(500),
      thumbnailUrl: 'javascript:alert(1)',
    }));
    expect(() => app.restore?.({
      schemaVersion: 1,
      query: 'q'.repeat(500),
      videos,
      nextPageToken: 'n'.repeat(1_000),
      scroll: Number.MAX_SAFE_INTEGER,
      selectedId: 'not a valid id',
      currentTime: Number.POSITIVE_INFINITY,
    })).not.toThrow();
    const saved = snapshot(app);
    expect(saved.query).toHaveLength(256);
    expect(saved.videos).toHaveLength(48);
    expect(saved.videos.every((entry) => entry.title.length <= 200 && entry.channelTitle.length <= 200 && !entry.thumbnailUrl)).toBe(true);
    expect(saved.nextPageToken).toBe('');
    expect(saved.scroll).toBeLessThanOrEqual(1_000_000);
    expect(saved.selectedId).toBe('');
    expect(saved.currentTime).toBe(0);
  });

  it('automatically validates an already saved local key once per activation lifecycle', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ items: [] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    const harness = youtubeContext();
    const app = youtubeApp(harness.context);
    app.activate?.();
    app.activate?.();
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    const requestUrl = new URL(String(vi.mocked(fetch).mock.calls[0][0]));
    expect(requestUrl.searchParams.get('key')).toBe('restricted-secret-key');
    expect(requestUrl.searchParams.get('q')).toBe('YouTube');
    await vi.waitFor(() => {
      app.render(harness.context.window.context, 1024, 400, 0);
      expect(harness.context.window.context.fillText).toHaveBeenCalledWith(
        'YouTube connection successful.', 24, 82, 976,
      );
    });
    expect(JSON.stringify(snapshot(app))).not.toContain('restricted-secret-key');
  });

  it('ignores malformed restore roots without throwing or changing valid state', () => {
    const harness = youtubeContext();
    const app = youtubeApp(harness.context);
    app.restore?.({ schemaVersion: 1, query: 'keep', videos: [video('video-1')] });
    const before = snapshot(app);
    for (const value of [null, [], 42, { schemaVersion: 2 }]) {
      expect(() => app.restore?.(value)).not.toThrow();
      expect(snapshot(app)).toEqual(before);
    }
  });
});
