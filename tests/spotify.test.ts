import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import {
  SPOTIFY_REMOTE_CONTROL_LABEL,
  createSpotifyApp,
  mapPlaybackCommand,
  mapSeekCommand,
  mapTrackCommand,
} from '../src/applications/spotify';
import {
  SPOTIFY_API_BASE_URL,
  SPOTIFY_AUTHORIZE_URL,
  SPOTIFY_PKCE_STORAGE_KEY,
  SPOTIFY_SCOPES,
  SPOTIFY_TOKEN_URL,
  SpotifyAuth,
  SpotifyClient,
  SpotifyError,
  buildAuthorizationUrl,
  createPkceChallenge,
  generateOAuthState,
  generatePkceVerifier,
  validateOAuthCallback,
  type PkceStorage,
  type SpotifyPlaybackState,
  type SpotifyTrack,
} from '../src/services/spotify';
import type { ApplicationContext, ApplicationInstance } from '../src/types';

const CLIENT_ID = 'public-client-id';
const REDIRECT_URI = 'http://127.0.0.1:5173/';
const CALLBACK_URI = 'http://127.0.0.1:5173/';
const ACCESS_TOKEN = 'memory-access-token';
const REFRESH_TOKEN = 'memory-refresh-token';

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

function tokenResponse(accessToken = ACCESS_TOKEN, refreshToken: string | undefined = REFRESH_TOKEN, expiresIn = 3600): Response {
  return jsonResponse({
    access_token: accessToken,
    token_type: 'Bearer',
    expires_in: expiresIn,
    ...(refreshToken === undefined ? {} : { refresh_token: refreshToken }),
  });
}

function pendingStorage(): PkceStorage & { values: Map<string, string> } {
  const values = new Map<string, string>();
  return {
    values,
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => { values.set(key, value); }),
    removeItem: vi.fn((key: string) => { values.delete(key); }),
  };
}

function mockCrypto(fill = 0x5a): Crypto {
  return {
    getRandomValues: vi.fn((array: Uint8Array) => {
      array.fill(fill);
      return array;
    }),
    subtle: {
      digest: vi.fn(async (_algorithm: string, data: ArrayBuffer) => crypto.subtle.digest('SHA-256', data)),
    },
  } as unknown as Crypto;
}

async function authorize(fetchMock: Mock<typeof fetch>, now: () => number = () => 1_000) {
  const storage = pendingStorage();
  const auth = new SpotifyAuth({
    clientId: CLIENT_ID,
    redirectUri: REDIRECT_URI,
    fetchImpl: fetchMock,
    cryptoSource: mockCrypto(),
    pendingStorage: storage,
    now,
  });
  const authorizationUrl = await auth.beginAuthorization({ vrActive: false });
  const state = new URL(authorizationUrl).searchParams.get('state');
  expect(state).toBeTruthy();
  fetchMock.mockResolvedValueOnce(tokenResponse());
  await auth.completeAuthorization(`${CALLBACK_URI}?code=authorization-code&state=${encodeURIComponent(state ?? '')}`);
  return { auth, storage, authorizationUrl };
}

function trackFixture(id = 'track1'): SpotifyTrack {
  return {
    id,
    name: `Track ${id}`,
    uri: `spotify:track:${id}`,
    artists: ['Demo Artist'],
    albumName: 'Demo Album',
    durationMs: 180_000,
    imageUrl: null,
    explicit: false,
  };
}

function playbackFixture(isPlaying = true): SpotifyPlaybackState {
  return {
    device: { id: 'device1', name: 'Studio speakers', type: 'Computer', isActive: true, volumePercent: 65 },
    item: trackFixture(),
    isPlaying,
    progressMs: 30_000,
    durationMs: 180_000,
    timestamp: 1_000,
    shuffleState: false,
    repeatState: 'off',
    volumePercent: 65,
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

function spotifyContext(vrActive = false) {
  const ctx = fakeCanvasContext();
  const canvas = { width: 1024, height: 548, context: ctx } as unknown as HTMLCanvasElement;
  const requestRender = vi.fn();
  const setOverlay = vi.fn();
  const requestText = vi.fn(async (): Promise<string | null> => null);
  const context = {
    window: { id: 'spotify-test', canvas, context: ctx, requestRender, setOverlay },
    requestText,
    isVrActive: () => vrActive,
  } as unknown as ApplicationContext;
  return { context, ctx, requestRender, setOverlay, requestText };
}

function click(app: ApplicationInstance, x: number, y: number): boolean {
  return app.pointer?.(x, y, { type: 'pointerup' } as PointerEvent) ?? false;
}

function clientDouble() {
  return {
    getPlaybackState: vi.fn(async (): Promise<SpotifyPlaybackState | null> => playbackFixture()),
    search: vi.fn(async () => ({ tracks: [trackFixture()], total: 1, offset: 0, limit: 8, hasMore: false })),
    play: vi.fn(async () => undefined),
    pause: vi.fn(async () => undefined),
    next: vi.fn(async () => undefined),
    previous: vi.fn(async () => undefined),
    seek: vi.fn(async () => undefined),
    setVolume: vi.fn(async () => undefined),
    setShuffle: vi.fn(async () => undefined),
    setRepeat: vi.fn(async () => undefined),
    getAvailableDevices: vi.fn(async () => []),
  };
}

const instances: ApplicationInstance[] = [];

beforeEach(() => {
  vi.useRealTimers();
});

afterEach(() => {
  instances.splice(0).forEach((app) => app.destroy?.());
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('Spotify PKCE helpers', () => {
  it('generates URL-safe verifiers and states from mocked secure randomness', () => {
    const verifier = generatePkceVerifier(32, mockCrypto());
    expect(verifier).toHaveLength(43);
    expect(verifier).toMatch(/^[A-Za-z0-9._~-]+$/);
    expect(generatePkceVerifier(96, mockCrypto())).toHaveLength(128);
    expect(generateOAuthState(mockCrypto(0x01))).toHaveLength(43);
    expect(() => generatePkceVerifier(16, mockCrypto())).toThrow(/entropy/);
  });

  it('creates the RFC 7636 S256 challenge and rejects invalid verifiers', async () => {
    const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
    const challenge = await createPkceChallenge(verifier, (value) => crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
    expect(challenge).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
    await expect(createPkceChallenge('too-short')).rejects.toMatchObject({ code: 'invalid_request' });
  });

  it('builds a secret-free authorization URL and validates callback state and denial', async () => {
    const url = new URL(buildAuthorizationUrl({
      clientId: CLIENT_ID,
      redirectUri: REDIRECT_URI,
      state: 'state-value',
      challenge: 'a'.repeat(43),
    }));
    expect(url.origin + url.pathname).toBe(SPOTIFY_AUTHORIZE_URL);
    expect(url.searchParams.get('client_id')).toBe(CLIENT_ID);
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('redirect_uri')).toBe(REDIRECT_URI);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')).toBe('a'.repeat(43));
    expect(url.searchParams.get('scope')).toBe(SPOTIFY_SCOPES.join(' '));
    expect(url.href).not.toMatch(/client_secret|Bearer|access_token/i);
    expect(validateOAuthCallback(`${CALLBACK_URI}?code=abc&state=state-value`, 'state-value')).toEqual({ code: 'abc' });
    expect(() => validateOAuthCallback(`${CALLBACK_URI}?code=abc&state=wrong`, 'state-value')).toThrow(/state did not match/i);
    expect(() => validateOAuthCallback(`${CALLBACK_URI}?error=access_denied&state=state-value`, 'state-value')).toThrow(/cancelled or denied/i);
    expect(() => buildAuthorizationUrl({ clientId: CLIENT_ID, redirectUri: 'http://insecure.example/callback', state: 's', challenge: 'a'.repeat(43) }))
      .toThrow(/HTTPS/);
  });
});

describe('SpotifyAuth token lifecycle', () => {
  it('keeps tokens in memory, stores only temporary PKCE state, and never redirects from VR', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const storage = pendingStorage();
    const localStorage = { getItem: vi.fn(), setItem: vi.fn(), removeItem: vi.fn(), clear: vi.fn() };
    vi.stubGlobal('localStorage', localStorage);
    const auth = new SpotifyAuth({
      clientId: CLIENT_ID,
      redirectUri: REDIRECT_URI,
      fetchImpl: fetchMock,
      cryptoSource: mockCrypto(),
      pendingStorage: storage,
      now: () => 1_000,
    });

    await expect(auth.beginAuthorization({ vrActive: true })).rejects.toMatchObject({ code: 'configuration' });
    expect(storage.setItem).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();

    const authorizationUrl = await auth.beginAuthorization({ vrActive: false });
    const state = new URL(authorizationUrl).searchParams.get('state') ?? '';
    const pendingRaw = storage.values.get(SPOTIFY_PKCE_STORAGE_KEY) ?? '';
    expect(pendingRaw).toContain('verifier');
    expect(pendingRaw).toContain(state);
    expect(pendingRaw).not.toContain(ACCESS_TOKEN);
    expect(pendingRaw).not.toContain(REFRESH_TOKEN);

    fetchMock.mockResolvedValueOnce(tokenResponse());
    await auth.completeAuthorization(`${CALLBACK_URI}?code=code-value&state=${encodeURIComponent(state)}`);
    expect(auth.hasSession).toBe(true);
    expect(storage.values.has(SPOTIFY_PKCE_STORAGE_KEY)).toBe(false);
    const [tokenUrl, init] = fetchMock.mock.calls[0];
    expect(tokenUrl).toBe(SPOTIFY_TOKEN_URL);
    expect(init?.method).toBe('POST');
    const body = new URLSearchParams(String(init?.body));
    expect(body.get('client_id')).toBe(CLIENT_ID);
    expect(body.get('grant_type')).toBe('authorization_code');
    expect(body.get('code')).toBe('code-value');
    expect(body.get('code_verifier')).toMatch(/^[A-Za-z0-9._~-]{43,128}$/);
    expect(body.get('redirect_uri')).toBe(REDIRECT_URI);
    expect(body.has('client_secret')).toBe(false);
    expect(new Headers(init?.headers).get('Content-Type')).toBe('application/x-www-form-urlencoded');
    expect(JSON.stringify(auth)).not.toContain(ACCESS_TOKEN);
    expect(JSON.stringify(auth)).not.toContain(REFRESH_TOKEN);
    expect(localStorage.getItem).not.toHaveBeenCalled();
    expect(localStorage.setItem).not.toHaveBeenCalled();

    auth.disconnect();
    expect(auth.hasSession).toBe(false);
    await expect(auth.getAccessToken()).rejects.toMatchObject({ code: 'not_connected' });
  });

  it('refreshes expiring access tokens in memory and retains the refresh token when omitted', async () => {
    let clock = 0;
    const fetchMock = vi.fn<typeof fetch>();
    const { auth } = await authorize(fetchMock, () => clock);
    await expect(auth.getAccessToken()).resolves.toBe(ACCESS_TOKEN);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    clock = 3_570_001;
    fetchMock.mockResolvedValueOnce(tokenResponse('refreshed-access-token', undefined));
    await expect(auth.getAccessToken()).resolves.toBe('refreshed-access-token');
    const init = fetchMock.mock.calls[1][1];
    const body = new URLSearchParams(String(init?.body));
    expect(body.get('grant_type')).toBe('refresh_token');
    expect(body.get('refresh_token')).toBe(REFRESH_TOKEN);
    expect(body.has('client_secret')).toBe(false);

    clock = 7_170_001;
    fetchMock.mockResolvedValueOnce(tokenResponse('second-refreshed-access-token', undefined));
    await expect(auth.getAccessToken()).resolves.toBe('second-refreshed-access-token');
    const secondBody = new URLSearchParams(String(fetchMock.mock.calls[2][1]?.body));
    expect(secondBody.get('refresh_token')).toBe(REFRESH_TOKEN);
  });

  it('rejects stale state without exchanging the authorization code', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const auth = new SpotifyAuth({ clientId: CLIENT_ID, redirectUri: REDIRECT_URI, fetchImpl: fetchMock, cryptoSource: mockCrypto(), pendingStorage: pendingStorage() });
    await auth.beginAuthorization({ vrActive: false });
    await expect(auth.completeAuthorization(`${CALLBACK_URI}?code=secret-code&state=wrong`)).rejects.toMatchObject({ code: 'oauth_state' });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(auth.hasSession).toBe(false);
  });
});

describe('Spotify Web API client', () => {
  it('searches real tracks with pagination, Bearer headers, and current Development Mode limits', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const { auth } = await authorize(fetchMock);
    const client = new SpotifyClient(auth, { fetchImpl: fetchMock });
    fetchMock.mockResolvedValueOnce(jsonResponse({
      tracks: {
        items: [{
          id: 'track1',
          name: 'Demo Track',
          uri: 'spotify:track:track1',
          artists: [{ name: 'Demo Artist' }],
          album: { name: 'Demo Album', images: [{ url: 'https://images.example/cover.jpg' }] },
          duration_ms: 180_000,
          explicit: false,
        }],
        total: 20,
      },
    }));

    const page = await client.search('demo track', { offset: 4, limit: 8 });
    const [rawUrl, init] = fetchMock.mock.calls[1];
    const url = new URL(String(rawUrl));
    expect(url.origin + url.pathname).toBe(`${SPOTIFY_API_BASE_URL}/search`);
    expect(url.searchParams.get('q')).toBe('demo track');
    expect(url.searchParams.get('type')).toBe('track');
    expect(url.searchParams.get('limit')).toBe('8');
    expect(url.searchParams.get('offset')).toBe('4');
    expect(new Headers(init?.headers).get('Authorization')).toBe(`Bearer ${ACCESS_TOKEN}`);
    expect(new Headers(init?.headers).get('Accept')).toBe('application/json');
    expect(init).toMatchObject({ cache: 'no-store', referrerPolicy: 'no-referrer' });
    expect(page).toMatchObject({ total: 20, offset: 4, limit: 8, hasMore: true });
    expect(page.tracks[0]).toEqual({
      ...trackFixture(),
      name: 'Demo Track',
      imageUrl: 'https://images.example/cover.jpg',
    });
    await expect(client.search('demo', { limit: 11 })).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(client.search('demo', { limit: Number.NaN })).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(client.search('demo', { offset: Number.NaN })).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(client.search('   ')).rejects.toMatchObject({ code: 'invalid_request' });
  });

  it('returns null for no active device and maps real playback state', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const { auth } = await authorize(fetchMock);
    const client = new SpotifyClient(auth, { fetchImpl: fetchMock });
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await expect(client.getPlaybackState()).resolves.toBeNull();
    expect(new URL(String(fetchMock.mock.calls[1][0])).pathname).toBe('/v1/me/player');

    fetchMock.mockResolvedValueOnce(jsonResponse({
      device: { id: 'device1', name: 'Studio speakers', type: 'Computer', is_active: true, volume_percent: 65 },
      item: {
        id: 'track1', name: 'Track track1', uri: 'spotify:track:track1', artists: [{ name: 'Demo Artist' }],
        album: { name: 'Demo Album' }, duration_ms: 180_000,
      },
      is_playing: true,
      progress_ms: 30_000,
      timestamp: 1_000,
      shuffle_state: false,
      repeat_state: 'off',
      volume_percent: 65,
    }));
    await expect(client.getPlaybackState()).resolves.toEqual(playbackFixture());
  });

  it('sends transport controls to the active device without inventing playback', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const { auth } = await authorize(fetchMock);
    const client = new SpotifyClient(auth, { fetchImpl: fetchMock });
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));

    await client.play({ uris: ['spotify:track:track1'] });
    await client.pause();
    await client.next();
    await client.previous();
    await client.seek(42_000);
    await client.setShuffle(true);
    await client.setRepeat('context');

    const calls = fetchMock.mock.calls.slice(1);
    expect(calls.map(([url, init]) => `${init?.method} ${new URL(String(url)).pathname}${new URL(String(url)).search}`)).toEqual([
      'PUT /v1/me/player',
      'PUT /v1/me/player/pause',
      'POST /v1/me/player/next',
      'POST /v1/me/player/previous',
      'PUT /v1/me/player/seek?position_ms=42000',
      'PUT /v1/me/player/shuffle?state=true',
      'PUT /v1/me/player/repeat?state=context',
    ]);
    expect(JSON.parse(String(calls[0][1]?.body))).toEqual({ uris: ['spotify:track:track1'] });
    expect(new Headers(calls[0][1]?.headers).get('Content-Type')).toBe('application/json');
    expect(calls.every(([, init]) => new Headers(init?.headers).get('Authorization') === `Bearer ${ACCESS_TOKEN}`)).toBe(true);
  });

  it('sanitizes errors and clears memory tokens on unauthorized responses', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const { auth } = await authorize(fetchMock);
    const client = new SpotifyClient(auth, { fetchImpl: fetchMock });
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: { status: 401, message: `Bearer ${ACCESS_TOKEN}` } }, 401));

    const error = await client.search('demo').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SpotifyError);
    expect(error).toMatchObject({ code: 'not_connected', status: 401 });
    expect((error as SpotifyError).retryAfterMs).toBeUndefined();
    expect((error as Error).message).not.toContain(ACCESS_TOKEN);
    expect(JSON.stringify(error)).not.toContain(ACCESS_TOKEN);
    expect(auth.hasSession).toBe(false);
  });

  it.each([
    ['PREMIUM_REQUIRED', 'premium_required', /Premium/],
    ['NO_ACTIVE_DEVICE', 'no_active_device', /No active Spotify Connect device/],
    ['INSUFFICIENT_CLIENT_SCOPE', 'permission', /permission was not granted/],
  ])('maps Spotify %s responses to honest UI errors', async (reason, code, message) => {
    const fetchMock = vi.fn<typeof fetch>();
    const { auth } = await authorize(fetchMock);
    const client = new SpotifyClient(auth, { fetchImpl: fetchMock });
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: { status: 403, reason, message: 'unsafe server text' } }, 403));
    const error = await client.pause().catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code, status: 403 });
    expect((error as Error).message).toMatch(message);
    expect((error as Error).message).not.toContain('unsafe server text');
  });

  it('recognizes permission restrictions when Spotify omits a reason code', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const { auth } = await authorize(fetchMock);
    const client = new SpotifyClient(auth, { fetchImpl: fetchMock });
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: { status: 403, message: 'Insufficient client scope' } }, 403));
    await expect(client.pause()).rejects.toMatchObject({ code: 'permission', status: 403 });
  });

  it('reports rate limits, network failures, and malformed responses without leaking request data', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const { auth } = await authorize(fetchMock);
    const client = new SpotifyClient(auth, { fetchImpl: fetchMock });
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: { status: 429, message: 'slow down' } }, 429, { 'Retry-After': '2' }));
    await expect(client.search('demo')).rejects.toMatchObject({ code: 'rate_limited', retryAfterMs: 2_000 });

    fetchMock.mockRejectedValueOnce(new Error(`network failed with Bearer ${ACCESS_TOKEN}`));
    const networkError = await client.search('demo').catch((caught: unknown) => caught);
    expect(networkError).toMatchObject({ code: 'network' });
    expect((networkError as Error).message).not.toContain(ACCESS_TOKEN);

    fetchMock.mockResolvedValueOnce(new Response('not-json', { status: 200 }));
    await expect(client.getPlaybackState()).rejects.toMatchObject({ code: 'invalid_response' });
  });
});

describe('Spotify Canvas UI action mapping', () => {
  it('maps transport intent and seek bounds from real playback state', () => {
    expect(mapPlaybackCommand('toggle', null)).toBeNull();
    expect(mapPlaybackCommand('toggle', playbackFixture(true))).toEqual({ operation: 'pause' });
    expect(mapPlaybackCommand('toggle', playbackFixture(false))).toEqual({ operation: 'play' });
    expect(mapPlaybackCommand('previous', playbackFixture())).toEqual({ operation: 'previous' });
    expect(mapPlaybackCommand('next', playbackFixture())).toEqual({ operation: 'next' });
    expect(mapPlaybackCommand('shuffle', playbackFixture())).toEqual({ operation: 'shuffle', enabled: true });
    expect(mapPlaybackCommand('repeat', playbackFixture())).toEqual({ operation: 'repeat', state: 'track' });
    expect(mapSeekCommand(playbackFixture(), -60_000)).toEqual({ operation: 'seek', positionMs: 0 });
    expect(mapSeekCommand(playbackFixture(), 60_000)).toEqual({ operation: 'seek', positionMs: 90_000 });
    expect(mapTrackCommand(trackFixture())).toEqual({ operation: 'play-track', uri: 'spotify:track:track1' });
  });

  it('renders directly in Canvas, searches, plays a result, and disconnects memory tokens', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const { auth } = await authorize(fetchMock);
    const client = clientDouble();
    const harness = spotifyContext();
    harness.requestText.mockResolvedValue('demo track');
    const app = createSpotifyApp(harness.context, {
      auth,
      client: client as unknown as SpotifyClient,
      now: () => 1_000,
      searchLimit: 8,
    });
    instances.push(app);
    await Promise.resolve();
    await Promise.resolve();
    app.render(harness.ctx, 1024, 548, 0);

    expect((harness.ctx.fillText as Mock).mock.calls.some(([text]) => text === SPOTIFY_REMOTE_CONTROL_LABEL)).toBe(true);
    expect(harness.setOverlay).not.toHaveBeenCalled();
    expect(click(app, 74, 37)).toBe(true);
    await vi.waitFor(() => expect(client.search).toHaveBeenCalledWith('demo track', expect.objectContaining({ limit: 8, offset: 0 })));
    app.render(harness.ctx, 1024, 548, 0);

    expect(click(app, 500, 290)).toBe(true);
    await vi.waitFor(() => expect(client.play).toHaveBeenCalledWith({ uris: ['spotify:track:track1'] }, expect.any(AbortSignal)));
    expect(JSON.stringify(app.serialize?.())).not.toContain(ACCESS_TOKEN);
    expect(JSON.stringify(app.serialize?.())).not.toContain(REFRESH_TOKEN);

    click(app, 958, 37);
    expect(auth.hasSession).toBe(false);
    app.render(harness.ctx, 1024, 548, 0);
    expect((harness.ctx.fillText as Mock).mock.calls.some(([text]) => String(text).includes('Disconnected'))).toBe(true);
  });

  it('maps the Canvas pause button to the real transport service', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const { auth } = await authorize(fetchMock);
    const client = clientDouble();
    const harness = spotifyContext();
    const app = createSpotifyApp(harness.context, { auth, client: client as unknown as SpotifyClient, now: () => 1_000 });
    instances.push(app);
    await Promise.resolve();
    await Promise.resolve();
    app.render(harness.ctx, 1024, 548, 0);

    expect(click(app, 316, 37)).toBe(true);
    await vi.waitFor(() => expect(client.pause).toHaveBeenCalledWith(expect.any(AbortSignal)));
    expect(client.play).not.toHaveBeenCalled();
  });

  it('does not open an OAuth redirect from VR and asks for no client secret', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const storage = pendingStorage();
    const auth = new SpotifyAuth({ fetchImpl: fetchMock, cryptoSource: mockCrypto(), pendingStorage: storage });
    const client = clientDouble();
    const harness = spotifyContext(true);
    const redirect = vi.fn();
    const app = createSpotifyApp(harness.context, { auth, client: client as unknown as SpotifyClient, redirect });
    instances.push(app);
    app.render(harness.ctx, 1024, 548, 0);

    expect(click(app, 92, 37)).toBe(true);
    app.render(harness.ctx, 1024, 548, 0);
    expect(redirect).not.toHaveBeenCalled();
    expect(harness.requestText).not.toHaveBeenCalled();
    expect(storage.setItem).not.toHaveBeenCalled();
    expect((harness.ctx.fillText as Mock).mock.calls.some(([text]) => String(text).includes('cannot redirect out of stereo VR'))).toBe(true);
  });

  it('shows an honest no-device state and does not fake a play action', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const { auth } = await authorize(fetchMock);
    const client = clientDouble();
    client.getPlaybackState.mockResolvedValue(null);
    const harness = spotifyContext();
    const app = createSpotifyApp(harness.context, { auth, client: client as unknown as SpotifyClient, now: () => 1_000 });
    instances.push(app);
    await Promise.resolve();
    await Promise.resolve();
    app.render(harness.ctx, 1024, 548, 0);

    expect((harness.ctx.fillText as Mock).mock.calls.some(([text]) => text === 'No active Spotify Connect device')).toBe(true);
    expect(click(app, 316, 37)).toBe(false);
    expect(client.play).not.toHaveBeenCalled();
  });
});
