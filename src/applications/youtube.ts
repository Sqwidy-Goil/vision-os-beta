import type { ApplicationContext, ApplicationInstance } from '../types';
import { drawEmptyState, ellipsis, fillRoundedRect, roundedRect, WINDOW_CHROME_HEIGHT } from '../spatial/canvasUi';
import { drawImageCover } from './ui';
import { actionAt, drawButton, type CanvasAction } from './ui';
import { getYouTubeKey, rememberYouTubeKey, testYouTubeKey, forgetYouTubeKey, searchYouTube, type YouTubeVideo, type YouTubeSearchResult } from '../core/youtube';

declare global {
  interface Window {
    YT?: {
      Player: new (element: HTMLElement, options: {
        videoId: string;
        playerVars?: Record<string, string | number>;
        events?: {
          onReady?: (event: { target: YouTubePlayer }) => void;
          onStateChange?: (event: { data: number }) => void;
          onError?: (event: { data: number }) => void;
        };
      }) => YouTubePlayer;
      PlayerState: { PLAYING: number; PAUSED: number; ENDED: number };
    };
    onYouTubeIframeAPIReady?: () => void;
  }
}

interface YouTubePlayer {
  playVideo(): void;
  pauseVideo(): void;
  nextVideo(): void;
  previousVideo(): void;
  seekTo(seconds: number, allowSeekAhead: boolean): void;
  getCurrentTime(): number;
  getDuration(): number;
  getPlayerState(): number;
  destroy(): void;
}

interface YouTubePlayerState {
  player: YouTubePlayer | null;
  element: HTMLElement | null;
  ready: boolean;
  currentId: string;
}

const YOUTUBE_STATE_VERSION = 1;
const MAX_YOUTUBE_VIDEOS = 48;
const MAX_YOUTUBE_QUERY_LENGTH = 256;
const MAX_YOUTUBE_TEXT_LENGTH = 200;
const MAX_YOUTUBE_URL_LENGTH = 2_048;
const MAX_YOUTUBE_SCROLL = 1_000_000;
const SENSITIVE_URL_PARAMETER = /(?:^|[_-])(?:api[-_]?key|key|access[-_]?token|refresh[-_]?token|id[-_]?token|token|auth(?:orization)?|password|passwd|secret|session(?:[-_]?id)?|sid|state|code|signature|credential|cookie)(?:$|[_-])/i;

interface YouTubeSnapshot {
  schemaVersion: 1;
  query: string;
  videos: YouTubeVideo[];
  nextPageToken: string;
  activeTab: 'results' | 'settings';
  scroll: number;
  selectedId: string;
  playing: boolean;
  currentTime: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function boundedString(value: unknown, maximum: number): string | null {
  return typeof value === 'string' ? value.slice(0, maximum) : null;
}

function youTubeVideoId(value: unknown): string | null {
  return typeof value === 'string' && value.length <= 128 && /^[A-Za-z0-9_-]{1,128}$/.test(value) ? value : null;
}

function sanitizeYouTubeHttpsUrl(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim() || value.length > MAX_YOUTUBE_URL_LENGTH * 4) return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'https:') return null;
    url.username = '';
    url.password = '';
    for (const key of [...url.searchParams.keys()]) {
      if (SENSITIVE_URL_PARAMETER.test(key)) url.searchParams.delete(key);
    }
    return url.toString().slice(0, MAX_YOUTUBE_URL_LENGTH);
  } catch {
    return null;
  }
}

function restoreYouTubeVideo(value: unknown): YouTubeVideo | null {
  if (!isRecord(value)) return null;
  const id = youTubeVideoId(value.id);
  const title = boundedString(value.title, MAX_YOUTUBE_TEXT_LENGTH);
  const channelTitle = boundedString(value.channelTitle, MAX_YOUTUBE_TEXT_LENGTH);
  if (!id || title === null || channelTitle === null) return null;
  const publishedAt = boundedString(value.publishedAt, 64);
  const thumbnailUrl = sanitizeYouTubeHttpsUrl(value.thumbnailUrl);
  return {
    id,
    title,
    channelTitle,
    ...(publishedAt && Number.isFinite(Date.parse(publishedAt)) ? { publishedAt } : {}),
    ...(thumbnailUrl ? { thumbnailUrl } : {}),
  };
}

function restoreYouTubeSnapshot(value: unknown): YouTubeSnapshot | null {
  if (!isRecord(value) || value.schemaVersion !== YOUTUBE_STATE_VERSION) return null;
  const rawVideos = Array.isArray(value.videos) ? value.videos : [];
  const seen = new Set<string>();
  const videos = rawVideos.slice(0, MAX_YOUTUBE_VIDEOS).flatMap((entry): YouTubeVideo[] => {
    const video = restoreYouTubeVideo(entry);
    if (!video || seen.has(video.id)) return [];
    seen.add(video.id);
    return [video];
  }).slice(0, MAX_YOUTUBE_VIDEOS);
  const scroll = typeof value.scroll === 'number' && Number.isFinite(value.scroll)
    ? Math.min(MAX_YOUTUBE_SCROLL, Math.max(0, value.scroll))
    : 0;
  const currentTime = typeof value.currentTime === 'number' && Number.isFinite(value.currentTime)
    ? Math.min(86_400, Math.max(0, value.currentTime))
    : 0;
  return {
    schemaVersion: 1,
    query: boundedString(value.query, MAX_YOUTUBE_QUERY_LENGTH) ?? '',
    videos,
    nextPageToken: rawVideos.length > MAX_YOUTUBE_VIDEOS ? '' : (boundedString(value.nextPageToken, 512) ?? ''),
    activeTab: value.activeTab === 'settings' ? 'settings' : 'results',
    scroll,
    selectedId: youTubeVideoId(value.selectedId) ?? '',
    playing: value.playing === true,
    currentTime,
  };
}

export const youtubePlayerState: YouTubePlayerState = { player: null, element: null, ready: false, currentId: '' };

let playerApiPromise: Promise<void> | null = null;

function loadPlayerApi(): Promise<void> {
  if (globalThis.window.YT?.Player) return Promise.resolve();
  if (playerApiPromise) return playerApiPromise;
  playerApiPromise = new Promise<void>((resolve, reject) => {
    const previous = globalThis.window.onYouTubeIframeAPIReady;
    globalThis.window.onYouTubeIframeAPIReady = () => {
      previous?.();
      resolve();
    };
    const script = document.createElement('script');
    script.src = 'https://www.youtube.com/iframe_api';
    script.async = true;
    script.onerror = () => {
      playerApiPromise = null;
      reject(new Error('The YouTube player could not load. Check your connection.'));
    };
    document.head.append(script);
    globalThis.setTimeout(() => {
      if (!globalThis.window.YT?.Player) {
        playerApiPromise = null;
        reject(new Error('The YouTube player timed out.'));
      }
    }, 12_000);
  });
  return playerApiPromise;
}

export function releaseYouTubePlayer(): void {
  const player = youtubePlayerState.player;
  youtubePlayerState.player = null;
  youtubePlayerState.element = null;
  youtubePlayerState.ready = false;
  youtubePlayerState.currentId = '';
  try {
    player?.destroy();
  } catch {
    return;
  }
}

export function createYouTubeApp(context: ApplicationContext): ApplicationInstance {
  const actions: CanvasAction[] = [];
  const rows: Array<{ video: YouTubeVideo; x: number; y: number; width: number; height: number }> = [];
  const thumbnails = new Map<string, HTMLImageElement>();
  let query = '';
  let videos: YouTubeVideo[] = [];
  let nextPageToken = '';
  let status = 'Search YouTube with your own restricted Data API v3 key.';
  let loading = false;
  let scroll = 0;
  let generation = 0;
  let activeTab: 'results' | 'settings' = 'results';
  let keyConfigured = Boolean(getYouTubeKey());
  let showKey = false;
  let playing = false;
  let playbackActive = false;
  let playerError = '';
  let selectedId = '';
  let currentTime = 0;
  let destroyed = false;
  let autoValidationStarted = false;

  const contentTop = (): number => context.isVrActive() ? 146 : 98;
  const contentBottom = (): number => context.window.canvas.height - WINDOW_CHROME_HEIGHT - 62;
  const maximumScroll = (): number => Math.max(0, Math.ceil(videos.length / 2) * 206 - (contentBottom() - contentTop()));

  const scrollContent = (deltaY: number): void => {
    scroll = Math.max(0, Math.min(maximumScroll(), scroll + deltaY));
    context.window.requestRender();
  };

  const ensureThumbnail = (video: YouTubeVideo): HTMLImageElement | undefined => {
    if (!video.thumbnailUrl) return undefined;
    const existing = thumbnails.get(video.id);
    if (existing) return existing;
    const image = new Image();
    image.crossOrigin = 'anonymous';
    image.referrerPolicy = 'no-referrer';
    image.onload = () => context.window.requestRender();
    image.onerror = () => { thumbnails.delete(video.id); };
    image.src = video.thumbnailUrl;
    thumbnails.set(video.id, image);
    return image;
  };

  const search = async (append = false): Promise<void> => {
    const text = query.trim();
    const key = getYouTubeKey();
    if (!key) {
      activeTab = 'settings';
      status = 'Add a YouTube Data API v3 key first.';
      context.window.requestRender();
      return;
    }
    if (!text) {
      status = 'Enter a search query first.';
      context.window.requestRender();
      return;
    }
    const version = ++generation;
    activeTab = 'results';
    loading = true;
    playerError = '';
    status = 'Searching YouTube…';
    context.window.requestRender();
    try {
      const result: YouTubeSearchResult = await searchYouTube(key, text, append ? nextPageToken : undefined);
      if (version !== generation) return;
      videos = append ? [...videos, ...result.videos] : result.videos;
      nextPageToken = result.nextPageToken ?? '';
      status = result.videos.length ? `${result.videos.length} videos loaded` : 'No videos found.';
      scroll = 0;
    } catch (error) {
      if (version === generation) status = error instanceof Error ? error.message : 'YouTube search failed.';
    } finally {
      if (version === generation) {
        loading = false;
        context.window.requestRender();
      }
    }
  };

  const editQuery = (): void => {
    void context.requestText({ title: 'Search YouTube', value: query, placeholder: 'Video title, creator, or topic', submitLabel: 'Search' }).then((value) => {
      if (value === null) return;
      query = value;
      void search();
    }).catch((error: unknown) => {
      status = error instanceof Error ? error.message : 'YouTube search entry is unavailable.';
      context.window.requestRender();
    });
  };

  const editKey = (): void => {
    const current = getYouTubeKey() ?? '';
    void context.requestText({ title: 'YouTube Data API v3 key', value: current, secret: !showKey, placeholder: 'Restricted browser key', submitLabel: 'Save key' }).then((value) => {
      if (value === null) return;
      if (!value.trim()) {
        forgetYouTubeKey();
        keyConfigured = false;
        status = 'YouTube key removed from this browser.';
      } else {
        rememberYouTubeKey(value);
        keyConfigured = true;
        status = 'Key saved locally in this browser. A frontend cannot hide it.';
      }
      context.window.requestRender();
    }).catch((error: unknown) => {
      status = error instanceof Error ? error.message : 'YouTube key entry is unavailable.';
      context.window.requestRender();
    });
  };

  const testKey = async (): Promise<void> => {
    const key = getYouTubeKey();
    if (!key) {
      status = 'Enter and save a key first.';
      context.window.requestRender();
      return;
    }
    status = 'Testing YouTube connection…';
    context.window.requestRender();
    try {
      await testYouTubeKey(key);
      if (destroyed) return;
      status = 'YouTube connection successful.';
    } catch (error) {
      if (destroyed) return;
      status = error instanceof Error ? error.message : 'YouTube connection failed.';
    }
    context.window.requestRender();
  };

  const ensurePlayer = async (videoId: string, options: { play?: boolean; startSeconds?: number } = {}): Promise<void> => {
    if (!videoId || destroyed) return;
    selectedId = youTubeVideoId(videoId) ?? '';
    const playOnReady = options.play ?? true;
    const startSeconds = typeof options.startSeconds === 'number' && Number.isFinite(options.startSeconds)
      ? Math.min(86_400, Math.max(0, options.startSeconds))
      : 0;
    if (context.isVrActive()) {
      playerError = 'Video pixels cannot be rendered in stereo VR. Exit VR or open this video on YouTube.';
      status = playerError;
      context.window.requestRender();
      return;
    }
    playerError = '';
    try {
      await loadPlayerApi();
      if (destroyed) return;
      if (!youtubePlayerState.element || youtubePlayerState.currentId !== videoId) {
        releaseYouTubePlayer();
        const element = document.createElement('div');
        element.id = `youtube-player-${context.window.id}`;
        element.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;border:0;background:#000;';
        context.window.setOverlay(element, { x: 18, y: 92, width: 988, height: 548 });
        youtubePlayerState.element = element;
        const api = globalThis.window.YT;
        if (!api) throw new Error('The YouTube player API is unavailable.');
        youtubePlayerState.player = new api.Player(element, {
          videoId,
          playerVars: { playsinline: 1, rel: 0, modestbranding: 1, origin: globalThis.location.origin, ...(startSeconds > 0 ? { start: Math.floor(startSeconds) } : {}) },
          events: {
            onReady: (event) => {
              youtubePlayerState.ready = true;
              if (startSeconds > 0) event.target.seekTo(startSeconds, true);
              if (playOnReady) event.target.playVideo();
              else event.target.pauseVideo();
            },
            onStateChange: (event) => {
              const state = globalThis.window.YT?.PlayerState;
              playing = state ? event.data === state.PAUSED : event.data === 2;
              playbackActive = state ? event.data === state.PLAYING : event.data === 1;
              context.window.requestRender();
            },
            onError: () => {
              playerError = 'Playback was blocked or unavailable. Try Open on YouTube.';
              context.window.requestRender();
            },
          },
        });
        youtubePlayerState.currentId = videoId;
      } else {
        const player = youtubePlayerState.player;
        if (startSeconds > 0) player?.seekTo(startSeconds, true);
        if (playOnReady) player?.playVideo();
        else player?.pauseVideo();
      }
      playing = !playOnReady;
      playbackActive = playOnReady;
      currentTime = startSeconds;
      context.window.requestRender();
    } catch (error) {
      if (destroyed) return;
      playerError = error instanceof Error ? error.message : 'Video playback is unavailable.';
      context.window.requestRender();
    }
  };

  return {
    activate: () => {
      if (autoValidationStarted || !keyConfigured || destroyed) return;
      autoValidationStarted = true;
      void testKey();
    },
    render: (ctx, width, height) => {
      actions.length = 0;
      rows.length = 0;
      fillRoundedRect(ctx, 14, 12, width - 28, 52, 14, 'rgba(255,255,255,.045)');
      ctx.fillStyle = '#e9f0f8';
      ctx.font = '600 14px -apple-system, BlinkMacSystemFont, sans-serif';
      ctx.fillText(ellipsis(ctx, query || 'Search YouTube', width - 610), 32, 43, width - 610);
      actions.push(drawButton(ctx, width - 558, 21, 82, 33, 'Search', editQuery));
      actions.push(drawButton(ctx, width - 468, 21, 88, 33, 'Settings', () => { activeTab = activeTab === 'settings' ? 'results' : 'settings'; }, activeTab === 'settings'));
      actions.push(drawButton(ctx, width - 372, 21, 82, 33, keyConfigured ? 'Edit key' : 'Add key', editKey, keyConfigured));
      actions.push(drawButton(ctx, width - 282, 21, 82, 33, 'Test', () => { void testKey(); }));
      actions.push(drawButton(ctx, width - 192, 21, 70, 33, showKey ? 'Hide' : 'Show', () => { showKey = !showKey; }, showKey));
      actions.push(drawButton(ctx, width - 114, 21, 94, 33, 'Forget', () => {
        forgetYouTubeKey();
        keyConfigured = false;
        status = 'YouTube key removed from this browser.';
        context.window.requestRender();
      }));
      ctx.fillStyle = loading ? '#75e7ff' : '#9aacc4';
      ctx.font = '11px -apple-system, BlinkMacSystemFont, sans-serif';
      ctx.fillText(ellipsis(ctx, status, width - 40), 24, 82, width - 48);

      if (activeTab === 'settings') {
        drawSettings(ctx, width, height, keyConfigured, showKey, actions, {
          editKey,
          testKey: () => { void testKey(); },
          forget: () => { forgetYouTubeKey(); keyConfigured = false; status = 'Key removed.'; context.window.requestRender(); },
        });
        return;
      }

      const vrActive = context.isVrActive();
      if (vrActive) {
        fillRoundedRect(ctx, 18, 92, width - 36, 44, 13, 'rgba(255,180,110,.08)');
        ctx.fillStyle = '#ffd4ad';
        ctx.font = '600 12px -apple-system, BlinkMacSystemFont, sans-serif';
        ctx.fillText('Search and thumbnails work in VR. Cross-origin video pixels play only after exiting VR.', 32, 118, width - 64);
      }
      if (!vrActive && youtubePlayerState.currentId) {
        if (playerError) {
          drawEmptyState(ctx, width, height - 140, 'Playback unavailable', playerError, '#ffb3bc');
        } else if (!playing && youtubePlayerState.ready) {
          ctx.fillStyle = '#ffb3bc';
          ctx.font = '650 14px -apple-system, BlinkMacSystemFont, sans-serif';
          ctx.fillText('Video paused', 34, 128);
        }
        return;
      }
      if (!videos.length) {
        drawEmptyState(ctx, width, height - 140, 'YouTube spatial search', 'Add your restricted Data API v3 key, then search. Results and thumbnails work in VR; playback uses the official IFrame Player API outside stereo VR.');
        return;
      }
      const top = contentTop();
      const bottom = contentBottom();
      ctx.save();
      ctx.beginPath();
      ctx.rect(18, top, width - 36, bottom - top);
      ctx.clip();
      ctx.translate(0, -scroll);
      videos.forEach((video, index) => {
        const column = index % 2;
        const row = Math.floor(index / 2);
        const item = { video, x: 24 + column * 490, y: top + 14 + row * 206, width: 470, height: 190 };
        rows.push(item);
        fillRoundedRect(ctx, item.x, item.y, item.width, item.height, 17, 'rgba(255,255,255,.05)');
        roundedRect(ctx, item.x, item.y, item.width, item.height, 17);
        ctx.strokeStyle = 'rgba(255,255,255,.12)';
        ctx.stroke();
        const thumbnail = ensureThumbnail(video);
        if (thumbnail?.complete && thumbnail.naturalWidth) {
          drawImageCover(ctx, thumbnail, item.x + 14, item.y + 14, 144, 88);
        } else {
          ctx.fillStyle = 'rgba(255,143,157,.16)';
          ctx.fillText('▶', item.x + 78, item.y + 64);
        }
        ctx.fillStyle = '#f0f4fa';
        ctx.font = '650 15px -apple-system, BlinkMacSystemFont, sans-serif';
        const title = ellipsis(ctx, video.title, item.width - 196);
        ctx.fillText(title, item.x + 172, item.y + 34, item.width - 196);
        ctx.fillStyle = '#9aacc4';
        ctx.font = '12px -apple-system, BlinkMacSystemFont, sans-serif';
        ctx.fillText(ellipsis(ctx, video.channelTitle, item.width - 196), item.x + 172, item.y + 62, item.width - 196);
        ctx.fillText(video.publishedAt ? new Date(video.publishedAt).toLocaleDateString() : 'YouTube', item.x + 172, item.y + 88, item.width - 196);
        ctx.fillText(`https://youtu.be/${video.id}`, item.x + 20, item.y + 118, item.width - 40);
        if (item.y - scroll + item.height >= top && item.y - scroll <= bottom) {
          actions.push(drawButton(ctx, item.x + 20, item.y + 136 - scroll, 96, 38, 'Play', () => { void ensurePlayer(video.id); }));
          actions.push(drawButton(ctx, item.x + 128, item.y + 136 - scroll, 132, 38, 'Open', () => { globalThis.open(`https://www.youtube.com/watch?v=${encodeURIComponent(video.id)}`, '_blank', 'noopener,noreferrer'); }));
        }
      });
      ctx.restore();
      if (nextPageToken) actions.push(drawButton(ctx, width - 174, height - 50, 140, 38, 'Load more', () => { void search(true); }));
    },
    pointer: (x, y, event) => {
      if (activeTab === 'settings') {
        if (actionAt(actions, x, y)) return true;
        return false;
      }
      if (actionAt(actions, x, y)) return true;
      if (y >= 14 && y <= 64 && x <= context.window.canvas.width - 570) {
        editQuery();
        return true;
      }
      const top = contentTop();
      const bottom = contentBottom();
      if (event.type === 'pointermove' && event.buttons === 1 && y > top && y < bottom) {
        scrollContent(-event.movementY);
        return true;
      }
      const row = rows.find((candidate) =>
        x >= candidate.x
        && x <= candidate.x + candidate.width
        && y + scroll >= candidate.y
        && y + scroll <= candidate.y + candidate.height);
      if (row) {
        if (event.type === 'pointerup') void ensurePlayer(row.video.id);
        return true;
      }
      return y > top && y < bottom;
    },
    openKeyboard: editQuery,
    scroll: (deltaY) => {
      scrollContent(deltaY);
      return true;
    },
    serialize: (): YouTubeSnapshot => {
      if (selectedId && youtubePlayerState.currentId === selectedId) {
        try {
          const playerTime = youtubePlayerState.player?.getCurrentTime();
          if (typeof playerTime === 'number' && Number.isFinite(playerTime)) currentTime = Math.min(86_400, Math.max(0, playerTime));
        } catch {
          // A destroyed or cross-origin player can reject state reads; keep the last safe value.
        }
      }
      return {
        schemaVersion: 1,
        query: query.slice(0, MAX_YOUTUBE_QUERY_LENGTH),
        videos: videos.flatMap((video): YouTubeVideo[] => {
          const saved = restoreYouTubeVideo(video);
          return saved ? [saved] : [];
        }).slice(0, MAX_YOUTUBE_VIDEOS),
        nextPageToken: videos.length > MAX_YOUTUBE_VIDEOS ? '' : nextPageToken.slice(0, 512),
        activeTab,
        scroll: Math.min(MAX_YOUTUBE_SCROLL, Math.max(0, scroll)),
        selectedId: youTubeVideoId(selectedId) ?? '',
        playing: Boolean(selectedId) && playbackActive,
        currentTime,
      };
    },
    restore: (value: unknown) => {
      if (destroyed) return;
      const snapshot = restoreYouTubeSnapshot(value);
      if (!snapshot) return;
      generation += 1;
      loading = false;
      playerError = '';
      query = snapshot.query;
      videos = snapshot.videos;
      nextPageToken = snapshot.nextPageToken;
      activeTab = snapshot.activeTab;
      showKey = false;
      keyConfigured = Boolean(getYouTubeKey());
      selectedId = snapshot.selectedId;
      playing = !snapshot.playing;
      playbackActive = snapshot.playing;
      currentTime = snapshot.currentTime;
      scroll = Math.min(snapshot.scroll, maximumScroll());
      status = videos.length
        ? `${videos.length} videos restored`
        : query ? 'Search restored. Choose Search to refresh results.' : 'Search YouTube with your own restricted Data API v3 key.';
      context.window.requestRender();
      if (selectedId && !context.isVrActive()) {
        void ensurePlayer(selectedId, { play: snapshot.playing, startSeconds: currentTime });
      }
    },
    destroy: () => {
      if (destroyed) return;
      destroyed = true;
      generation += 1;
      thumbnails.clear();
      releaseYouTubePlayer();
      context.window.setOverlay(null);
    },
  };
}

function drawSettings(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  configured: boolean,
  showKey: boolean,
  actions: CanvasAction[],
  callbacks: { editKey: () => void; testKey: () => void; forget: () => void },
): void {
  fillRoundedRect(context, 24, 108, width - 48, height - 140, 20, 'rgba(255,255,255,.035)');
  context.fillStyle = '#f0f4fa';
  context.font = '700 22px -apple-system, BlinkMacSystemFont, sans-serif';
  context.fillText('YouTube Data API v3', 48, 154);
  context.fillStyle = '#9aacc4';
  context.font = '14px -apple-system, BlinkMacSystemFont, sans-serif';
  const lines = [
    configured ? 'A key is stored in this browser only. VISI0N OS does not upload or publish it.' : 'No key is stored. Search and public video information need a key.',
    'A frontend-only GitHub Pages app cannot securely hide a key. Anyone with this device or bundle can inspect it.',
    'Restrict the key to YouTube Data API v3 and trusted referrers. For stronger protection, use your own backend proxy.',
    'Cross-origin iframe pixels cannot be rendered stereoscopically. Player audio/video remain available outside Cardboard VR.',
  ];
  lines.forEach((line, index) => context.fillText(ellipsis(context, line, width - 100), 48, 196 + index * 30, width - 100));
  context.fillStyle = configured ? '#b7f8de' : '#ffd5da';
  context.font = '650 13px -apple-system, BlinkMacSystemFont, sans-serif';
  context.fillText(configured ? 'KEY CONFIGURED IN THIS BROWSER' : 'KEY NOT CONFIGURED', 48, 336);
  actions.push(drawButton(context, 48, 362, 142, 40, configured ? 'Edit key' : 'Add key', callbacks.editKey));
  actions.push(drawButton(context, 202, 362, 142, 40, 'Test connection', callbacks.testKey));
  actions.push(drawButton(context, 356, 362, 132, 40, 'Forget key', callbacks.forget));
  context.fillStyle = showKey && configured ? '#dce7f7' : '#9aacc4';
  context.font = '12px ui-monospace, SFMono-Regular, Menlo, monospace';
  const key = getYouTubeKey() ?? '';
  context.fillText(showKey && key ? ellipsis(context, key, width - 100) : configured ? '••••••••••••••••••••••••' : 'No key entered', 48, 444, width - 100);
}
