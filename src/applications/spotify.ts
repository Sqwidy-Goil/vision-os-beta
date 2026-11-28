import type { ApplicationContext, ApplicationDefinition, ApplicationInstance } from '../types';
import { ellipsis, fillRoundedRect, roundedRect } from '../spatial/canvasUi';
import { actionAt, drawButton, formatTime, type CanvasAction } from './ui';
import {
  SpotifyAuth,
  SpotifyClient,
  SpotifyError,
  type SpotifyPlaybackState,
  type SpotifySearchPage,
  type SpotifyTrack,
} from '../services/spotify';

export const SPOTIFY_REMOTE_CONTROL_LABEL = 'Remote control on active Spotify Connect device, not in-VISION audio streaming.';
const SEARCH_ROW_HEIGHT = 74;
const PLAYBACK_POLL_INTERVAL_MS = 5_000;

export interface SpotifyAppOptions {
  auth?: SpotifyAuth;
  client?: SpotifyClient;
  now?: () => number;
  pollIntervalMs?: number;
  searchLimit?: number;
  redirect?: (url: string) => void;
}

export type PlaybackIntent = 'toggle' | 'previous' | 'next' | 'shuffle' | 'repeat';

export type SpotifyTransportCommand =
  | { operation: 'play' | 'pause' | 'previous' | 'next' }
  | { operation: 'play-track'; uri: string }
  | { operation: 'shuffle'; enabled: boolean }
  | { operation: 'repeat'; state: 'off' | 'track' | 'context' }
  | { operation: 'seek'; positionMs: number };

export function mapPlaybackCommand(intent: PlaybackIntent, playback: SpotifyPlaybackState | null): SpotifyTransportCommand | null {
  if (!playback?.device) return null;
  switch (intent) {
    case 'toggle': return { operation: playback.isPlaying ? 'pause' : 'play' };
    case 'previous': return { operation: 'previous' };
    case 'next': return { operation: 'next' };
    case 'shuffle': return { operation: 'shuffle', enabled: !playback.shuffleState };
    case 'repeat': return { operation: 'repeat', state: playback.repeatState === 'off' ? 'track' : playback.repeatState === 'track' ? 'context' : 'off' };
  }
}

export function mapTrackCommand(track: SpotifyTrack): SpotifyTransportCommand {
  return { operation: 'play-track', uri: track.uri };
}

export function mapSeekCommand(playback: SpotifyPlaybackState | null, deltaMs: number): SpotifyTransportCommand | null {
  if (!playback?.device || !playback.item || playback.durationMs <= 0 || !Number.isFinite(deltaMs)) return null;
  return {
    operation: 'seek',
    positionMs: Math.max(0, Math.min(playback.durationMs, Math.round(playback.progressMs + deltaMs))),
  };
}

interface SearchRow {
  track: SpotifyTrack;
  x: number;
  y: number;
  width: number;
  height: number;
}

type FailureSource = 'playback' | 'search' | 'transport' | 'authorization';

function wrapLines(text: string, maxWidth: number, measure: (value: string) => number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split('\n')) {
    let line = '';
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      const candidate = line ? `${line} ${word}` : word;
      if (!line || measure(candidate) <= maxWidth) line = candidate;
      else {
        lines.push(line);
        line = word;
      }
    }
    lines.push(line);
  }
  return lines.length ? lines : [''];
}

function errorMessage(error: unknown): string {
  return error instanceof SpotifyError ? error.message : 'The Spotify request failed. Check your connection and try again.';
}

function defaultRedirect(url: string): void {
  if (typeof location === 'undefined') {
    throw new SpotifyError('configuration', 'Spotify sign-in is unavailable outside a browser tab.');
  }
  location.assign(url);
}

function configuredAuth(): SpotifyAuth {
  const clientId = import.meta.env.VITE_SPOTIFY_CLIENT_ID?.trim() ?? '';
  const redirectUri = import.meta.env.VITE_SPOTIFY_REDIRECT_URI?.trim() || undefined;
  return new SpotifyAuth({ clientId, redirectUri });
}

function drawDisabledButton(ctx: CanvasRenderingContext2D, x: number, y: number, width: number, height: number, label: string): void {
  fillRoundedRect(ctx, x, y, width, height, 11, 'rgba(255,255,255,.025)');
  roundedRect(ctx, x, y, width, height, 11);
  ctx.strokeStyle = 'rgba(255,255,255,.07)';
  ctx.stroke();
  ctx.fillStyle = 'rgba(154,172,196,.48)';
  ctx.font = '600 12px -apple-system, BlinkMacSystemFont, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(ellipsis(ctx, label, width - 14), x + width / 2, y + height / 2);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
}

export function createSpotifyApp(context: ApplicationContext, options: SpotifyAppOptions = {}): ApplicationInstance {
  const actions: CanvasAction[] = [];
  const rows: SearchRow[] = [];
  const auth = options.auth ?? configuredAuth();
  const client = options.client ?? new SpotifyClient(auth);
  const now = options.now ?? Date.now;
  const pollIntervalMs = options.pollIntervalMs ?? PLAYBACK_POLL_INTERVAL_MS;
  const searchLimit = options.searchLimit ?? 8;
  const redirect = options.redirect ?? defaultRedirect;
  let connected = auth.hasSession;
  let playback: SpotifyPlaybackState | null = null;
  let tracks: SpotifyTrack[] = [];
  let query = '';
  let total = 0;
  let nextOffset = 0;
  let hasMore = false;
  let scroll = 0;
  let status = connected ? 'Connected in memory. Reading the active Spotify Connect device…' : 'Disconnected. Spotify tokens are never persisted.';
  let failure = '';
  let failureSource: FailureSource = 'playback';
  let searching = false;
  let playbackLoading = false;
  let operationPending = false;
  let authorizationPending = false;
  let lastPlaybackRequest = 0;
  let searchController: AbortController | null = null;
  let playbackController: AbortController | null = null;
  let operationController: AbortController | null = null;
  let authorizationController: AbortController | null = null;
  let suspended = false;
  let destroyed = false;
  let interactionGeneration = 0;

  const requestRender = (): void => {
    if (!destroyed) context.window.requestRender();
  };

  const canControl = (): boolean => connected && Boolean(playback?.device) && !operationPending;

  const handleFailure = (error: unknown, source: FailureSource = 'playback'): void => {
    if (destroyed) return;
    failure = errorMessage(error);
    failureSource = source;
    status = failure;
    if (error instanceof SpotifyError && error.code === 'not_connected') {
      connected = false;
      playback = null;
    }
    requestRender();
  };

  const refreshPlayback = async (force = false): Promise<void> => {
    if (!connected || destroyed || suspended) return;
    if (playbackLoading && !force) return;
    playbackController?.abort();
    const controller = new AbortController();
    playbackController = controller;
    playbackLoading = true;
    lastPlaybackRequest = now();
    if (force) status = 'Reading the active Spotify Connect device…';
    requestRender();
    try {
      const state = await client.getPlaybackState(controller.signal);
      if (destroyed || suspended || playbackController !== controller) return;
      playback = state;
      failure = '';
      failureSource = 'playback';
      status = state?.device
        ? `Connected to ${state.device.name}${state.device.isActive ? ' (active)' : ''}.`
        : 'No active Spotify Connect device. Start playback on a phone, computer, or speaker, then Refresh.';
    } catch (error: unknown) {
      if (destroyed || playbackController !== controller || (error instanceof SpotifyError && error.code === 'aborted')) return;
      handleFailure(error);
    } finally {
      if (playbackController === controller) {
        playbackController = null;
        playbackLoading = false;
        requestRender();
      }
    }
  };

  const runSearch = async (text: string, append = false): Promise<void> => {
    if (!connected || destroyed) {
      failure = 'Connect Spotify before searching.';
      requestRender();
      return;
    }
    const searchText = text.trim();
    if (!searchText) {
      failure = 'Enter a track, artist, or album to search.';
      requestRender();
      return;
    }
    searchController?.abort();
    const controller = new AbortController();
    searchController = controller;
    searching = true;
    failure = '';
    failureSource = 'search';
    status = `Searching real Spotify tracks for “${searchText}”…`;
    requestRender();
    try {
      const page: SpotifySearchPage = await client.search(searchText, {
        limit: searchLimit,
        offset: append ? nextOffset : 0,
        signal: controller.signal,
      });
      if (destroyed || searchController !== controller) return;
      tracks = append ? [...tracks, ...page.tracks] : page.tracks;
      total = page.total;
      nextOffset = page.offset + page.limit;
      hasMore = page.hasMore;
      if (!append) scroll = 0;
      status = tracks.length ? `${tracks.length} real Spotify tracks loaded.` : 'No Spotify tracks found for that search.';
    } catch (error: unknown) {
      if (destroyed || searchController !== controller || (error instanceof SpotifyError && error.code === 'aborted')) return;
      handleFailure(error, 'search');
    } finally {
      if (searchController === controller) {
        searchController = null;
        searching = false;
        requestRender();
      }
    }
  };

  const search = (): void => {
    if (!connected || destroyed) return;
    const generation = interactionGeneration;
    void context.requestText({
      title: 'Search Spotify',
      value: query,
      placeholder: 'Track, artist, or album. Results come from the Spotify Web API.',
      submitLabel: 'Search',
      cancelLabel: 'Cancel',
    }).then((value) => {
      if (value === null || destroyed || generation !== interactionGeneration) return;
      query = value;
      void runSearch(query);
    }).catch((error: unknown) => {
      if (destroyed || generation !== interactionGeneration) return;
      handleFailure(error, 'search');
    });
  };

  const finishAuthorization = async (): Promise<void> => {
    if (destroyed || typeof location === 'undefined') return;
    const callback = new URL(location.href);
    if (!callback.searchParams.has('code') && !callback.searchParams.has('error')) {
      status = 'Spotify sign-in is pending in this tab. Finish in the browser, or Disconnect to cancel.';
      requestRender();
      return;
    }
    authorizationController?.abort();
    const controller = new AbortController();
    authorizationController = controller;
    authorizationPending = true;
    failure = '';
    status = 'Finishing Spotify PKCE sign-in…';
    requestRender();
    try {
      await auth.completeAuthorization(callback.href, controller.signal);
      if (destroyed || authorizationController !== controller) return;
      connected = true;
      playback = null;
      status = 'Spotify connected. Tokens are active in memory only.';
      await refreshPlayback(true);
    } catch (error: unknown) {
      if (destroyed || authorizationController !== controller || (error instanceof SpotifyError && error.code === 'aborted')) return;
      handleFailure(error, 'authorization');
    } finally {
      if (authorizationController === controller) {
        authorizationController = null;
        authorizationPending = false;
        requestRender();
      }
    }
  };

  const connect = (): void => {
    if (destroyed || authorizationPending) return;
    if (context.isVrActive()) {
      failure = 'Spotify sign-in cannot redirect out of stereo VR. Exit VR to connect; an existing session remains controllable here.';
      status = failure;
      requestRender();
      return;
    }
    const generation = interactionGeneration;
    const authorize = async (): Promise<void> => {
      if (context.isVrActive()) {
        failure = 'Spotify sign-in cannot redirect out of stereo VR. Exit VR to connect.';
        status = failure;
        requestRender();
        return;
      }
      authorizationPending = true;
      failure = '';
      status = 'Preparing Spotify PKCE authorization…';
      requestRender();
      try {
        const url = await auth.beginAuthorization({ vrActive: false, showDialog: true });
        if (destroyed || generation !== interactionGeneration) return;
        status = 'Opening Spotify authorization in this browser tab…';
        requestRender();
        redirect(url);
      } catch (error: unknown) {
        if (destroyed || generation !== interactionGeneration) return;
        handleFailure(error, 'authorization');
      } finally {
        if (!destroyed) {
          authorizationPending = false;
          requestRender();
        }
      }
    };
    if (auth.clientId) {
      void authorize();
      return;
    }
    void context.requestText({
      title: 'Spotify public Client ID',
      value: '',
      placeholder: 'From developer.spotify.com Dashboard. This is public; never enter a client secret.',
      submitLabel: 'Continue',
      cancelLabel: 'Cancel',
    }).then((value) => {
      if (value === null || destroyed || generation !== interactionGeneration) return;
      try {
        auth.setClientId(value);
      } catch (error: unknown) {
        handleFailure(error, 'authorization');
        return;
      }
      void authorize();
    }).catch((error: unknown) => {
      if (destroyed || generation !== interactionGeneration) return;
      handleFailure(error, 'authorization');
    });
  };

  const disconnect = (): void => {
    interactionGeneration += 1;
    searchController?.abort();
    playbackController?.abort();
    operationController?.abort();
    authorizationController?.abort();
    searchController = null;
    playbackController = null;
    operationController = null;
    authorizationController = null;
    searching = false;
    playbackLoading = false;
    operationPending = false;
    authorizationPending = false;
    auth.disconnect();
    connected = false;
    playback = null;
    tracks = [];
    total = 0;
    nextOffset = 0;
    hasMore = false;
    scroll = 0;
    failure = '';
    failureSource = 'playback';
    status = 'Disconnected. Access and refresh tokens were removed from memory.';
    requestRender();
  };

  const runTransport = async (command: SpotifyTransportCommand): Promise<void> => {
    if (!canControl()) {
      failure = 'Playback controls need an active Spotify Connect device. Start Spotify on a device, then Refresh.';
      status = failure;
      requestRender();
      return;
    }
    operationController?.abort();
    const controller = new AbortController();
    operationController = controller;
    operationPending = true;
    failure = '';
    status = 'Sending playback command to Spotify Connect…';
    requestRender();
    try {
      switch (command.operation) {
        case 'play': await client.play({}, controller.signal); break;
        case 'pause': await client.pause(controller.signal); break;
        case 'previous': await client.previous(controller.signal); break;
        case 'next': await client.next(controller.signal); break;
        case 'play-track': await client.play({ uris: [command.uri] }, controller.signal); break;
        case 'shuffle': await client.setShuffle(command.enabled, controller.signal); break;
        case 'repeat': await client.setRepeat(command.state, controller.signal); break;
        case 'seek': await client.seek(command.positionMs, controller.signal); break;
      }
      if (destroyed || operationController !== controller) return;
      status = 'Spotify accepted the playback command.';
      await refreshPlayback(true);
    } catch (error: unknown) {
      if (destroyed || operationController !== controller || (error instanceof SpotifyError && error.code === 'aborted')) return;
      handleFailure(error, 'transport');
    } finally {
      if (operationController === controller) {
        operationController = null;
        operationPending = false;
        requestRender();
      }
    }
  };

  const transport = (intent: PlaybackIntent): void => {
    const command = mapPlaybackCommand(intent, playback);
    if (command) void runTransport(command);
  };

  const maximumScroll = (height: number): number => {
    const bottom = height - (hasMore ? 54 : 14);
    const viewport = Math.max(0, bottom - 266);
    return Math.max(0, tracks.length * SEARCH_ROW_HEIGHT - viewport);
  };

  try {
    if (auth.hasPendingAuthorization()) void finishAuthorization();
    else if (connected) void refreshPlayback(true);
  } catch (error: unknown) {
    handleFailure(error);
  }

  return {
    render: (ctx, width, height) => {
      actions.length = 0;
      rows.length = 0;
      const compact = width < 900;
      const toggle = mapPlaybackCommand('toggle', playback);
      const controlEnabled = canControl();

      fillRoundedRect(ctx, 16, 12, width - 32, 48, 13, 'rgba(255,255,255,.045)');
      if (connected) {
        actions.push(drawButton(ctx, 28, 20, 92, 34, 'Search', search, false, '#7cf5c8'));
        actions.push(drawButton(ctx, 128, 20, 86, 34, 'Refresh', () => { void refreshPlayback(true); }, playbackLoading, '#7cf5c8'));
        if (controlEnabled) {
          actions.push(drawButton(ctx, 222, 20, 42, 34, 'Prev', () => transport('previous'), false, '#7cf5c8'));
          actions.push(drawButton(ctx, 272, 20, 88, 34, toggle?.operation === 'pause' ? 'Pause' : 'Play', () => transport('toggle'), false, '#7cf5c8'));
          actions.push(drawButton(ctx, 368, 20, 42, 34, 'Next', () => transport('next'), false, '#7cf5c8'));
        } else {
          drawDisabledButton(ctx, 222, 20, 42, 34, 'Prev');
          drawDisabledButton(ctx, 272, 20, 88, 34, 'Play');
          drawDisabledButton(ctx, 368, 20, 42, 34, 'Next');
        }
        if (!compact) {
          if (controlEnabled) {
            actions.push(drawButton(ctx, 418, 20, 78, 34, `Shuffle ${playback?.shuffleState ? 'on' : 'off'}`, () => transport('shuffle'), playback?.shuffleState === true, '#7cf5c8'));
            actions.push(drawButton(ctx, 504, 20, 74, 34, `Repeat ${playback?.repeatState ?? 'off'}`, () => transport('repeat'), playback?.repeatState !== 'off' && playback?.repeatState !== undefined, '#7cf5c8'));
          } else {
            drawDisabledButton(ctx, 418, 20, 78, 34, 'Shuffle');
            drawDisabledButton(ctx, 504, 20, 74, 34, 'Repeat');
          }
          const seekBack = mapSeekCommand(playback, -10_000);
          const seekForward = mapSeekCommand(playback, 10_000);
          if (seekBack && controlEnabled) actions.push(drawButton(ctx, 586, 20, 52, 34, '−10s', () => { void runTransport(seekBack); }, false, '#7cf5c8'));
          else drawDisabledButton(ctx, 586, 20, 52, 34, '−10s');
          if (seekForward && controlEnabled) actions.push(drawButton(ctx, 646, 20, 52, 34, '+10s', () => { void runTransport(seekForward); }, false, '#7cf5c8'));
          else drawDisabledButton(ctx, 646, 20, 52, 34, '+10s');
        }
        actions.push(drawButton(ctx, width - 112, 20, 92, 34, 'Disconnect', disconnect, false, '#ff9db0'));
      } else {
        actions.push(drawButton(ctx, 28, 20, 128, 34, authorizationPending ? 'Connecting…' : 'Connect Spotify', connect, authorizationPending, '#7cf5c8'));
        if (auth.hasSession) actions.push(drawButton(ctx, 164, 20, 104, 34, 'Disconnect', disconnect, false, '#ff9db0'));
      }
      ctx.fillStyle = failure ? '#ffb3bc' : '#9aacc4';
      ctx.font = '11px -apple-system, BlinkMacSystemFont, sans-serif';
      ctx.fillText(ellipsis(ctx, status, width - 36), 28, 74, width - 56);

      fillRoundedRect(ctx, 16, 86, width - 32, 40, 12, 'rgba(124,245,200,.055)');
      ctx.fillStyle = '#b7f8de';
      ctx.font = '650 11px -apple-system, BlinkMacSystemFont, sans-serif';
      wrapLines(SPOTIFY_REMOTE_CONTROL_LABEL, width - 56, (value) => ctx.measureText(value).width)
        .forEach((line, index) => ctx.fillText(line, 28, 102 + index * 14, width - 56));
      const contentTop = 138;

      if (!connected) {
        drawDisconnectedState(ctx, width, height, contentTop, Boolean(auth.clientId), failure, actions, connect, context.isVrActive());
        return;
      }

      const cardHeight = 102;
      fillRoundedRect(ctx, 16, contentTop, width - 32, cardHeight, 15, 'rgba(124,245,200,.04)');
      roundedRect(ctx, 16, contentTop, width - 32, cardHeight, 15);
      ctx.strokeStyle = 'rgba(124,245,200,.14)';
      ctx.stroke();
      if (playbackLoading && !playback) {
        ctx.fillStyle = '#9aacc4';
        ctx.font = '13px -apple-system, BlinkMacSystemFont, sans-serif';
        ctx.fillText('Reading real playback state from Spotify…', 32, contentTop + 52, width - 64);
      } else if (!playback?.device) {
        ctx.fillStyle = '#ffe0aa';
        ctx.font = '650 15px -apple-system, BlinkMacSystemFont, sans-serif';
        ctx.fillText('No active Spotify Connect device', 32, contentTop + 35, width - 64);
        ctx.fillStyle = '#9aacc4';
        ctx.font = '12px -apple-system, BlinkMacSystemFont, sans-serif';
        ctx.fillText('Open Spotify on a phone, computer, or speaker and start playback, then choose Refresh.', 32, contentTop + 60, width - 64);
        ctx.fillText('VISION does not start, route, or stream audio itself.', 32, contentTop + 80, width - 64);
      } else {
        const item = playback.item;
        ctx.fillStyle = '#eefbf5';
        ctx.font = '700 17px -apple-system, BlinkMacSystemFont, sans-serif';
        ctx.fillText(ellipsis(ctx, item?.name ?? 'No track loaded on this device', width - 250), 32, contentTop + 31, width - 250);
        ctx.fillStyle = '#9aacc4';
        ctx.font = '12px -apple-system, BlinkMacSystemFont, sans-serif';
        const artists = item?.artists.length ? item.artists.join(', ') : 'Spotify Connect';
        ctx.fillText(ellipsis(ctx, `${artists}${item?.albumName ? ` — ${item.albumName}` : ''}`, width - 250), 32, contentTop + 53, width - 250);
        ctx.fillText(ellipsis(ctx, `Device: ${playback.device.name} (${playback.device.type})`, width - 250), 32, contentTop + 76, width - 250);
        ctx.textAlign = 'right';
        ctx.fillText(`${formatTime(playback.progressMs / 1000)} / ${formatTime(playback.durationMs / 1000)}`, width - 32, contentTop + 31);
        ctx.fillText(playback.isPlaying ? 'Playing on Spotify Connect' : 'Paused on Spotify Connect', width - 32, contentTop + 53);
        ctx.textAlign = 'left';
        const barWidth = width - 64;
        fillRoundedRect(ctx, 32, contentTop + 86, barWidth, 4, 2, 'rgba(255,255,255,.08)');
        const progress = playback.durationMs > 0 ? Math.max(0, Math.min(1, playback.progressMs / playback.durationMs)) : 0;
        if (progress > 0) fillRoundedRect(ctx, 32, contentTop + 86, barWidth * progress, 4, 2, '#7cf5c8');
      }

      const resultTop = 266;
      const resultBottom = height - (hasMore ? 54 : 14);
      ctx.fillStyle = failure ? '#ffb3bc' : '#9aacc4';
      ctx.font = '11px -apple-system, BlinkMacSystemFont, sans-serif';
      ctx.fillText(ellipsis(ctx, failure || status, width - 250), 24, 256, width - 250);
      ctx.textAlign = 'right';
      ctx.fillText(query ? `${total} Spotify matches` : 'Spotify Web API', width - 24, 256);
      ctx.textAlign = 'left';

      if (failure && !searching) {
        drawFailureState(ctx, width, height, resultTop, failure, actions, () => {
          if (failureSource === 'search' && query) void runSearch(query);
          else void refreshPlayback(true);
        });
        return;
      }
      if (!tracks.length) {
        drawEmptyResults(ctx, width, height, resultTop, connected, query, searching);
        return;
      }

      ctx.save();
      ctx.beginPath();
      ctx.rect(16, resultTop, width - 32, Math.max(0, resultBottom - resultTop));
      ctx.clip();
      ctx.translate(0, -scroll);
      tracks.forEach((track, index) => {
        const y = resultTop + index * SEARCH_ROW_HEIGHT;
        if (y + SEARCH_ROW_HEIGHT - scroll < resultTop || y - scroll > resultBottom) return;
        const active = playback?.item?.uri === track.uri;
        fillRoundedRect(ctx, 20, y + 3, width - 40, SEARCH_ROW_HEIGHT - 7, 11, active ? 'rgba(124,245,200,.11)' : 'rgba(255,255,255,.035)');
        if (active) {
          roundedRect(ctx, 20, y + 3, width - 40, SEARCH_ROW_HEIGHT - 7, 11);
          ctx.strokeStyle = 'rgba(124,245,200,.42)';
          ctx.stroke();
        }
        ctx.fillStyle = active ? '#7cf5c8' : '#e8f2ff';
        ctx.font = '650 14px -apple-system, BlinkMacSystemFont, sans-serif';
        ctx.fillText(ellipsis(ctx, track.name, width - 210), 34, y + 27, width - 210);
        ctx.fillStyle = '#9aacc4';
        ctx.font = '11px -apple-system, BlinkMacSystemFont, sans-serif';
        const detail = `${track.artists.join(', ') || 'Unknown artist'} — ${track.albumName || 'Spotify'} • ${formatTime(track.durationMs / 1000)}`;
        ctx.fillText(ellipsis(ctx, detail, width - 210), 34, y + 48, width - 210);
        rows.push({ track, x: 20, y: y + 3 - scroll, width: width - 40, height: SEARCH_ROW_HEIGHT - 7 });
        if (canControl()) actions.push(drawButton(ctx, width - 126, y + 17 - scroll, 88, 38, active && playback?.isPlaying ? 'Playing' : 'Play', () => { void runTransport(mapTrackCommand(track)); }, active, '#7cf5c8'));
        else drawDisabledButton(ctx, width - 126, y + 17 - scroll, 88, 38, 'No device');
      });
      ctx.restore();
      if (hasMore) actions.push(drawButton(ctx, width - 172, height - 46, 148, 34, 'Load more', () => { void runSearch(query, true); }, searching, '#7cf5c8'));
    },
    pointer: (x, y, event) => {
      if (event.type !== 'pointerup' && event.type !== 'click') return false;
      if (actionAt(actions, x, y)) return true;
      const row = rows.find((candidate) => x >= candidate.x && x <= candidate.x + candidate.width && y >= candidate.y && y <= candidate.y + candidate.height);
      if (row && canControl()) {
        void runTransport(mapTrackCommand(row.track));
        return true;
      }
      return false;
    },
    openKeyboard: search,
    scroll: (deltaY) => {
      if (!Number.isFinite(deltaY)) return false;
      scroll = Math.max(0, Math.min(maximumScroll(context.window.canvas.height), scroll + deltaY));
      requestRender();
      return true;
    },
    update: (_delta, time) => {
      if (!connected || suspended || destroyed || authorizationPending || operationPending || playbackLoading) return;
      if (time - lastPlaybackRequest >= pollIntervalMs) void refreshPlayback();
    },
    activate: () => {
      suspended = false;
      if (connected) void refreshPlayback(true);
    },
    deactivate: () => {
      suspended = true;
      searchController?.abort();
      playbackController?.abort();
      operationController?.abort();
    },
    suspend: () => {
      suspended = true;
      searchController?.abort();
      playbackController?.abort();
      operationController?.abort();
    },
    resume: () => {
      suspended = false;
      if (connected) void refreshPlayback(true);
    },
    serialize: () => ({
      schemaVersion: 1,
      query,
      scroll,
      total,
      nextOffset,
      hasMore,
    }),
    restore: (value: unknown) => {
      if (!value || typeof value !== 'object' || destroyed) return;
      const candidate = value as Record<string, unknown>;
      query = typeof candidate.query === 'string' ? candidate.query.slice(0, 256) : '';
      scroll = Math.max(0, typeof candidate.scroll === 'number' && Number.isFinite(candidate.scroll) ? candidate.scroll : 0);
      total = Math.max(0, typeof candidate.total === 'number' && Number.isFinite(candidate.total) ? candidate.total : 0);
      nextOffset = Math.max(0, typeof candidate.nextOffset === 'number' && Number.isFinite(candidate.nextOffset) ? candidate.nextOffset : 0);
      hasMore = candidate.hasMore === true;
      requestRender();
    },
    destroy: () => {
      if (destroyed) return;
      destroyed = true;
      interactionGeneration += 1;
      searchController?.abort();
      playbackController?.abort();
      operationController?.abort();
      authorizationController?.abort();
      auth.destroy();
      actions.length = 0;
      rows.length = 0;
    },
  };
}

function drawDisconnectedState(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  top: number,
  clientConfigured: boolean,
  failure: string,
  actions: CanvasAction[],
  connect: () => void,
  vrActive: boolean,
): void {
  const center = top + (height - top) / 2;
  ctx.textAlign = 'center';
  ctx.fillStyle = failure ? '#ffb3bc' : '#7cf5c8';
  ctx.font = '700 20px -apple-system, BlinkMacSystemFont, sans-serif';
  ctx.fillText(failure ? 'Spotify connection unavailable' : 'Spotify Connect remote', width / 2, center - 76);
  ctx.fillStyle = '#9aacc4';
  ctx.font = '13px -apple-system, BlinkMacSystemFont, sans-serif';
  const lines = failure
    ? wrapLines(failure, width - 120, (value) => ctx.measureText(value).width)
    : [
      'No client secret is used. Sign-in uses Authorization Code + PKCE.',
      'Access and refresh tokens live in memory only and are forgotten on reload or disconnect.',
      clientConfigured ? 'Connect outside VR to authorize this browser with Spotify.' : 'Add the public Client ID from your Spotify Developer Dashboard, then authorize outside VR.',
      'Development Mode requires the app owner to have active Premium and has user limits.',
    ];
  lines.slice(0, 5).forEach((line, index) => ctx.fillText(line, width / 2, center - 43 + index * 24, width - 100));
  if (vrActive) {
    ctx.fillStyle = '#ffe0aa';
    ctx.font = '650 12px -apple-system, BlinkMacSystemFont, sans-serif';
    ctx.fillText('No authorization redirect is opened from stereo VR. Exit VR to connect.', width / 2, center + 91, width - 80);
  }
  ctx.textAlign = 'left';
  if (!failure) actions.push(drawButton(ctx, width / 2 - 90, center + 112, 180, 42, 'Connect Spotify', connect, false, '#7cf5c8'));
}

function drawFailureState(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  top: number,
  failure: string,
  actions: CanvasAction[],
  retry: () => void,
): void {
  ctx.fillStyle = '#ffb3bc';
  ctx.font = '650 14px -apple-system, BlinkMacSystemFont, sans-serif';
  wrapLines(failure, width - 80, (value) => ctx.measureText(value).width).slice(0, 4)
    .forEach((line, index) => ctx.fillText(line, 32, top + 30 + index * 22, width - 64));
  actions.push(drawButton(ctx, 32, Math.min(height - 52, top + 126), 120, 36, 'Retry', retry, false, '#ff9db0'));
}

function drawEmptyResults(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  top: number,
  connected: boolean,
  query: string,
  searching: boolean,
): void {
  ctx.textAlign = 'center';
  ctx.fillStyle = '#7cf5c8';
  ctx.font = '600 12px -apple-system, BlinkMacSystemFont, sans-serif';
  ctx.fillText(searching ? 'SEARCHING SPOTIFY' : query ? 'NO RESULTS' : 'REAL SPOTIFY SEARCH', width / 2, top + (height - top) / 2 - 18);
  ctx.fillStyle = '#9aacc4';
  ctx.font = '13px -apple-system, BlinkMacSystemFont, sans-serif';
  const detail = searching
    ? 'Waiting for the Spotify Web API…'
    : query
      ? 'Try another track, artist, or album.'
      : connected
        ? 'Choose Search. No catalog or playback data is fabricated.'
        : 'Connect to search the real Spotify catalog.';
  ctx.fillText(detail, width / 2, top + (height - top) / 2 + 10, width - 80);
  ctx.textAlign = 'left';
}

export const spotifyApplication: ApplicationDefinition = {
  id: 'spotify',
  name: 'Spotify',
  icon: '♫',
  color: '#7cf5c8',
  description: 'Spotify Connect remote with PKCE sign-in and in-memory tokens.',
  stereoSafe: true,
  create: createSpotifyApp,
};

export const spotifyApp = spotifyApplication;
