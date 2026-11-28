export const SPOTIFY_AUTHORIZE_URL = 'https://accounts.spotify.com/authorize';
export const SPOTIFY_TOKEN_URL = 'https://accounts.spotify.com/api/token';
export const SPOTIFY_API_BASE_URL = 'https://api.spotify.com/v1';
export const SPOTIFY_SCOPES = ['user-read-playback-state', 'user-modify-playback-state'] as const;
export const SPOTIFY_PKCE_STORAGE_KEY = 'vision-os:spotify-pkce-pending';

const PKCE_LIFETIME_MS = 10 * 60_000;
const TOKEN_REFRESH_SKEW_MS = 30_000;
const VERIFIER_PATTERN = /^[A-Za-z0-9._~-]{43,128}$/;
const CHALLENGE_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export type SpotifyErrorCode =
  | 'configuration'
  | 'not_connected'
  | 'oauth_state'
  | 'access_denied'
  | 'oauth_failed'
  | 'invalid_request'
  | 'invalid_response'
  | 'network'
  | 'timeout'
  | 'aborted'
  | 'http'
  | 'forbidden'
  | 'permission'
  | 'premium_required'
  | 'no_active_device'
  | 'not_found'
  | 'rate_limited'
  | 'unsupported_api'
  | 'api_unavailable';

export class SpotifyError extends Error {
  readonly code: SpotifyErrorCode;
  readonly status?: number;
  readonly retryAfterMs?: number;

  constructor(code: SpotifyErrorCode, message: string, options: { status?: number; retryAfterMs?: number } = {}) {
    super(message);
    this.name = 'SpotifyError';
    this.code = code;
    this.status = options.status;
    this.retryAfterMs = options.retryAfterMs;
  }
}

export interface SpotifyTokenSet {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number;
}

export interface PkceStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface PkcePair {
  verifier: string;
  challenge: string;
}

export interface AuthorizationRequest {
  clientId: string;
  redirectUri: string;
  state: string;
  challenge: string;
  scopes?: readonly string[];
  showDialog?: boolean;
}

export interface SpotifyTrack {
  id: string;
  name: string;
  uri: string;
  artists: string[];
  albumName: string;
  durationMs: number;
  imageUrl: string | null;
  explicit: boolean;
}

export interface SpotifyDevice {
  id: string | null;
  name: string;
  type: string;
  isActive: boolean;
  volumePercent: number | null;
}

export interface SpotifyPlaybackState {
  device: SpotifyDevice | null;
  item: SpotifyTrack | null;
  isPlaying: boolean;
  progressMs: number;
  durationMs: number;
  timestamp: number;
  shuffleState: boolean;
  repeatState: 'off' | 'track' | 'context';
  volumePercent: number | null;
}

export interface SpotifySearchPage {
  tracks: SpotifyTrack[];
  total: number;
  offset: number;
  limit: number;
  hasMore: boolean;
}

export interface PlayOptions {
  deviceId?: string;
  contextUri?: string;
  uris?: string[];
  offset?: { position?: number; uri?: string };
}

interface PendingAuthorization {
  verifier: string;
  state: string;
  clientId: string;
  redirectUri: string;
  createdAt: number;
}

export interface SpotifyAuthOptions {
  clientId?: string;
  redirectUri?: string;
  fetchImpl?: typeof fetch;
  cryptoSource?: Crypto;
  pendingStorage?: PkceStorage | null;
  now?: () => number;
  tokenTimeoutMs?: number;
}

export interface SpotifyClientOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function requireCrypto(cryptoSource: Crypto | undefined): Crypto {
  if (!cryptoSource?.subtle || !cryptoSource.getRandomValues) {
    throw new SpotifyError('configuration', 'Secure browser cryptography is unavailable. Spotify sign-in cannot start.');
  }
  return cryptoSource;
}

export function generatePkceVerifier(randomByteLength = 64, cryptoSource: Crypto = globalThis.crypto): string {
  if (!Number.isInteger(randomByteLength) || randomByteLength < 32 || randomByteLength > 96) {
    throw new SpotifyError('invalid_request', 'PKCE verifier entropy must be between 32 and 96 bytes.');
  }
  const cryptoApi = requireCrypto(cryptoSource);
  return base64UrlEncode(cryptoApi.getRandomValues(new Uint8Array(randomByteLength)));
}

async function defaultSha256Digest(value: string): Promise<ArrayBuffer> {
  const cryptoApi = requireCrypto(globalThis.crypto);
  return cryptoApi.subtle.digest('SHA-256', new TextEncoder().encode(value));
}

export async function createPkceChallenge(
  verifier: string,
  digest: (value: string) => Promise<ArrayBuffer> = defaultSha256Digest,
): Promise<string> {
  if (!VERIFIER_PATTERN.test(verifier)) {
    throw new SpotifyError('invalid_request', 'The PKCE verifier must contain 43–128 unreserved URL-safe characters.');
  }
  return base64UrlEncode(new Uint8Array(await digest(verifier)));
}

export function generateOAuthState(cryptoSource: Crypto = globalThis.crypto): string {
  return base64UrlEncode(requireCrypto(cryptoSource).getRandomValues(new Uint8Array(32)));
}

export async function createPkcePair(cryptoSource: Crypto = globalThis.crypto): Promise<PkcePair> {
  const cryptoApi = requireCrypto(cryptoSource);
  const verifier = generatePkceVerifier(64, cryptoApi);
  return {
    verifier,
    challenge: await createPkceChallenge(verifier, (value) => cryptoApi.subtle.digest('SHA-256', new TextEncoder().encode(value))),
  };
}

function containsControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function validateClientId(clientId: string): string {
  const value = clientId.trim();
  if (!value || value.length > 128 || /\s/.test(value) || containsControlCharacter(value)) {
    throw new SpotifyError('configuration', 'Enter the public Client ID from your Spotify app. A client secret is never needed.');
  }
  return value;
}

function validateRedirectUri(redirectUri: string): string {
  let url: URL;
  try {
    url = new URL(redirectUri);
  } catch {
    throw new SpotifyError('configuration', 'Set a valid absolute Spotify redirect URI.');
  }
  const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) || url.hash || url.username || url.password) {
    throw new SpotifyError('configuration', 'Spotify redirect URIs must use HTTPS, except on loopback, and cannot contain a fragment or credentials.');
  }
  return url.href;
}

export function buildAuthorizationUrl(request: AuthorizationRequest): string {
  const clientId = validateClientId(request.clientId);
  const redirectUri = validateRedirectUri(request.redirectUri);
  if (!request.state || request.state.length > 512 || containsControlCharacter(request.state)) {
    throw new SpotifyError('invalid_request', 'A non-empty OAuth state value is required.');
  }
  if (!CHALLENGE_PATTERN.test(request.challenge)) {
    throw new SpotifyError('invalid_request', 'A valid SHA-256 PKCE challenge is required.');
  }
  const scopes = request.scopes ?? SPOTIFY_SCOPES;
  if (!scopes.length || scopes.some((scope) => !scope.trim())) {
    throw new SpotifyError('invalid_request', 'At least one valid Spotify scope is required.');
  }
  const url = new URL(SPOTIFY_AUTHORIZE_URL);
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('state', request.state);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('code_challenge', request.challenge);
  url.searchParams.set('scope', scopes.join(' '));
  url.searchParams.set('show_dialog', request.showDialog ? 'true' : 'false');
  return url.href;
}

function callbackUrl(value: string | URL): URL {
  try {
    const base = typeof location === 'undefined' ? 'https://localhost/' : location.href;
    return value instanceof URL ? new URL(value.href) : new URL(value, base);
  } catch {
    throw new SpotifyError('oauth_failed', 'Spotify returned an invalid authorization callback.');
  }
}

export function validateOAuthCallback(value: string | URL, expectedState: string): { code: string } {
  const url = callbackUrl(value);
  if (url.searchParams.get('state') !== expectedState) {
    throw new SpotifyError('oauth_state', 'Spotify sign-in state did not match this tab. Connect again to retry safely.');
  }
  const error = url.searchParams.get('error');
  if (error === 'access_denied') {
    throw new SpotifyError('access_denied', 'Spotify authorization was cancelled or denied.');
  }
  if (error) {
    throw new SpotifyError('oauth_failed', 'Spotify could not complete sign-in. Connect again to retry.');
  }
  const code = url.searchParams.get('code');
  if (!code) {
    throw new SpotifyError('oauth_failed', 'Spotify did not return an authorization code. Connect again to retry.');
  }
  return { code };
}

function browserPendingStorage(): PkceStorage | null {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage;
  } catch {
    return null;
  }
}

function defaultRedirectUri(): string {
  if (typeof location === 'undefined') return '';
  const url = new URL(location.href);
  url.search = '';
  url.hash = '';
  return url.href;
}

function errorPayload(value: unknown): { status: number | null; reason: string; message: string } {
  if (!isRecord(value)) return { status: null, reason: '', message: '' };
  const error = isRecord(value.error) ? value.error : value;
  return {
    status: typeof error.status === 'number' ? error.status : null,
    reason: typeof error.reason === 'string' ? error.reason.toUpperCase() : '',
    // Server messages are deliberately not copied into errors; they may echo request data.
    message: typeof error.message === 'string' ? error.message : '',
  };
}

function retryAfterMs(response: Response): number | undefined {
  const raw = response.headers.get('Retry-After');
  if (raw === null || !raw.trim()) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value * 1000 : undefined;
}

function apiError(response: Response, payload: unknown): SpotifyError {
  const error = errorPayload(payload);
  const detail = `${error.reason} ${error.message}`.toUpperCase();
  const status = response.status;
  const options = { status, retryAfterMs: retryAfterMs(response) };
  if (status === 401) return new SpotifyError('not_connected', 'Spotify authorization expired. Connect again; tokens are kept in memory only.', options);
  if (status === 403) {
    if (detail.includes('PREMIUM_REQUIRED') || detail.includes('PREMIUM REQUIRED')) {
      return new SpotifyError('premium_required', 'Spotify Premium is required to control playback on this account.', options);
    }
    if (detail.includes('NO_ACTIVE_DEVICE') || detail.includes('NO ACTIVE DEVICE') || detail.includes('DEVICE_NOT_FOUND')) {
      return new SpotifyError('no_active_device', 'No active Spotify Connect device is available. Start Spotify on a device, then refresh.', options);
    }
    if (detail.includes('INSUFFICIENT_CLIENT_SCOPE') || detail.includes('INSUFFICIENT CLIENT SCOPE')
      || detail.includes('INSUFFICIENT_PERMISSION') || detail.includes('INSUFFICIENT PERMISSION')) {
      return new SpotifyError('permission', 'Spotify playback permission was not granted. Reconnect and approve access.', options);
    }
    if (/DEVELOP|QUOTA|RESTRICT|UNSUPPORTED|USER LIMIT/.test(detail)) {
      return new SpotifyError('unsupported_api', 'Spotify denied this Web API request for the app or account. Check Development Mode eligibility and dashboard access.', options);
    }
    return new SpotifyError('forbidden', 'Spotify denied this request. Check the account, app permissions, and active Connect device.', options);
  }
  if (status === 404) {
    return new SpotifyError(detail.includes('DEVICE_NOT_FOUND') || detail.includes('DEVICE NOT FOUND') ? 'no_active_device' : 'not_found', 'The Spotify resource or playback device is no longer available.', options);
  }
  if (status === 429) return new SpotifyError('rate_limited', 'Spotify rate-limited this request. Wait before trying again.', options);
  if (status >= 500) return new SpotifyError('api_unavailable', 'Spotify is temporarily unavailable. Try again later.', options);
  return new SpotifyError('http', `Spotify rejected the request (HTTP ${status}).`, options);
}

function tokenError(response: Response, payload: unknown): SpotifyError {
  const error = errorPayload(payload);
  const options = { status: response.status, retryAfterMs: retryAfterMs(response) };
  if (response.status === 400 && (error.reason === 'INVALID_GRANT' || error.reason === 'INVALID_AUTHORIZATION_CODE')) {
    return new SpotifyError('oauth_failed', 'Spotify sign-in expired or was already used. Connect again to retry.', options);
  }
  if (response.status === 401 || response.status === 400) {
    return new SpotifyError('configuration', 'Spotify rejected the Client ID, redirect URI, or PKCE exchange. Check the exact redirect URI in your Spotify app.', options);
  }
  if (response.status === 429) return new SpotifyError('rate_limited', 'Spotify rate-limited sign-in. Wait before trying again.', options);
  return apiError(response, payload);
}

async function fetchWithTimeout(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<Response> {
  if (signal?.aborted) throw new SpotifyError('aborted', 'The Spotify request was cancelled.');
  const controller = new AbortController();
  let timedOut = false;
  const abort = (): void => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } catch (error: unknown) {
    if (signal?.aborted || (error instanceof DOMException && error.name === 'AbortError' && !timedOut)) {
      throw new SpotifyError('aborted', 'The Spotify request was cancelled.');
    }
    if (timedOut) throw new SpotifyError('timeout', 'Spotify did not respond in time. Check your connection and try again.');
    throw new SpotifyError('network', 'Could not reach Spotify. Check your connection and try again.');
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}

function parseTokenResponse(value: unknown, now: number, previousRefreshToken: string | null): SpotifyTokenSet {
  if (!isRecord(value) || typeof value.access_token !== 'string' || !value.access_token.trim()) {
    throw new SpotifyError('invalid_response', 'Spotify returned an invalid token response.');
  }
  if (typeof value.token_type !== 'string' || value.token_type.toLowerCase() !== 'bearer') {
    throw new SpotifyError('invalid_response', 'Spotify returned an unsupported token type.');
  }
  if (typeof value.expires_in !== 'number' || !Number.isFinite(value.expires_in) || value.expires_in <= 0) {
    throw new SpotifyError('invalid_response', 'Spotify returned an invalid token lifetime.');
  }
  if (value.refresh_token !== undefined && typeof value.refresh_token !== 'string') {
    throw new SpotifyError('invalid_response', 'Spotify returned an invalid refresh token.');
  }
  const refreshToken = typeof value.refresh_token === 'string' && value.refresh_token
    ? value.refresh_token
    : previousRefreshToken;
  return {
    accessToken: value.access_token,
    refreshToken,
    expiresAt: now + value.expires_in * 1000,
  };
}

export class SpotifyAuth {
  readonly #fetchImpl: typeof fetch;
  readonly #cryptoSource: Crypto;
  readonly #pendingStorage: PkceStorage | null | undefined;
  readonly #now: () => number;
  readonly #tokenTimeoutMs: number;
  #clientId: string;
  #redirectUri: string;
  #tokens: SpotifyTokenSet | null = null;
  #refreshPromise: Promise<string> | null = null;
  #generation = 0;

  constructor(options: SpotifyAuthOptions = {}) {
    this.#fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.#cryptoSource = options.cryptoSource ?? globalThis.crypto;
    this.#pendingStorage = options.pendingStorage;
    this.#now = options.now ?? Date.now;
    this.#tokenTimeoutMs = options.tokenTimeoutMs ?? 15_000;
    this.#clientId = options.clientId?.trim() ?? '';
    this.#redirectUri = options.redirectUri ? validateRedirectUri(options.redirectUri) : '';
    if (!Number.isFinite(this.#tokenTimeoutMs) || this.#tokenTimeoutMs <= 0) {
      throw new SpotifyError('configuration', 'Spotify request timeout must be positive.');
    }
  }

  get clientId(): string {
    return this.#clientId;
  }

  get redirectUri(): string {
    return this.#redirectUri || defaultRedirectUri();
  }

  get hasSession(): boolean {
    return this.#tokens !== null;
  }

  setClientId(clientId: string): void {
    this.#clientId = validateClientId(clientId);
  }

  hasPendingAuthorization(): boolean {
    return this.readPending() !== null;
  }

  private storage(): PkceStorage {
    const storage = this.#pendingStorage === undefined ? browserPendingStorage() : this.#pendingStorage;
    if (!storage) {
      throw new SpotifyError('configuration', 'Same-tab session storage is required to finish Spotify PKCE sign-in. Tokens are never persisted.');
    }
    return storage;
  }

  private readPending(): PendingAuthorization | null {
    let raw: string | null;
    try {
      raw = this.storage().getItem(SPOTIFY_PKCE_STORAGE_KEY);
    } catch {
      throw new SpotifyError('configuration', 'Spotify sign-in state could not be read from this tab.');
    }
    if (!raw) return null;
    try {
      const value: unknown = JSON.parse(raw);
      if (!isRecord(value)
        || typeof value.verifier !== 'string' || !VERIFIER_PATTERN.test(value.verifier)
        || typeof value.state !== 'string' || !value.state
        || typeof value.clientId !== 'string'
        || typeof value.redirectUri !== 'string'
        || typeof value.createdAt !== 'number' || !Number.isFinite(value.createdAt)
        || Math.abs(this.#now() - value.createdAt) > PKCE_LIFETIME_MS) {
        throw new Error('Invalid pending authorization.');
      }
      return {
        verifier: value.verifier,
        state: value.state,
        clientId: validateClientId(value.clientId),
        redirectUri: validateRedirectUri(value.redirectUri),
        createdAt: value.createdAt,
      };
    } catch {
      try {
        this.storage().removeItem(SPOTIFY_PKCE_STORAGE_KEY);
      } catch {
        // A later connect attempt will replace the unusable state.
      }
      return null;
    }
  }

  private takePending(): PendingAuthorization {
    const pending = this.readPending();
    if (!pending) throw new SpotifyError('oauth_failed', 'No valid Spotify sign-in is pending in this tab. Connect again to retry.');
    try {
      this.storage().removeItem(SPOTIFY_PKCE_STORAGE_KEY);
    } catch {
      throw new SpotifyError('configuration', 'Spotify sign-in state could not be cleared from this tab.');
    }
    return pending;
  }

  async beginAuthorization(options: { vrActive: boolean; showDialog?: boolean }): Promise<string> {
    if (options.vrActive) {
      throw new SpotifyError('configuration', 'Spotify sign-in needs a browser redirect and cannot start in stereo VR. Exit VR to connect; an existing session can still be controlled in VR.');
    }
    const clientId = validateClientId(this.#clientId);
    const redirectUri = validateRedirectUri(this.redirectUri);
    const pair = await createPkcePair(this.#cryptoSource);
    const state = generateOAuthState(this.#cryptoSource);
    const pending: PendingAuthorization = { verifier: pair.verifier, state, clientId, redirectUri, createdAt: this.#now() };
    try {
      this.storage().setItem(SPOTIFY_PKCE_STORAGE_KEY, JSON.stringify(pending));
    } catch {
      throw new SpotifyError('configuration', 'Spotify sign-in state could not be saved in this tab.');
    }
    return buildAuthorizationUrl({
      clientId,
      redirectUri,
      state,
      challenge: pair.challenge,
      scopes: SPOTIFY_SCOPES,
      showDialog: options.showDialog,
    });
  }

  private async requestToken(parameters: URLSearchParams, signal?: AbortSignal): Promise<SpotifyTokenSet> {
    const response = await fetchWithTimeout(this.#fetchImpl, SPOTIFY_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: parameters.toString(),
      cache: 'no-store',
      referrerPolicy: 'no-referrer',
    }, this.#tokenTimeoutMs, signal);
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new SpotifyError('invalid_response', 'Spotify returned an invalid sign-in response.');
    }
    if (!response.ok) throw tokenError(response, payload);
    return parseTokenResponse(payload, this.#now(), null);
  }

  async completeAuthorization(callback: string | URL, signal?: AbortSignal): Promise<void> {
    const pending = this.takePending();
    const { code } = validateOAuthCallback(callback, pending.state);
    const generation = this.#generation;
    const parameters = new URLSearchParams({
      client_id: pending.clientId,
      grant_type: 'authorization_code',
      code,
      redirect_uri: pending.redirectUri,
      code_verifier: pending.verifier,
    });
    const tokens = await this.requestToken(parameters, signal);
    if (generation !== this.#generation) throw new SpotifyError('aborted', 'Spotify sign-in was cancelled.');
    this.#clientId = pending.clientId;
    this.#redirectUri = pending.redirectUri;
    this.#tokens = tokens;
  }

  async getAccessToken(signal?: AbortSignal): Promise<string> {
    const tokens = this.#tokens;
    if (!tokens) throw new SpotifyError('not_connected', 'Spotify is disconnected. Connect to continue.');
    if (tokens.expiresAt > this.#now() + TOKEN_REFRESH_SKEW_MS) return tokens.accessToken;
    if (!tokens.refreshToken) {
      this.clearSession();
      throw new SpotifyError('not_connected', 'Spotify authorization expired. Connect again.');
    }
    if (!this.#refreshPromise) {
      this.#refreshPromise = this.refreshAccessToken(tokens, signal).finally(() => { this.#refreshPromise = null; });
    }
    return this.#refreshPromise;
  }

  private async refreshAccessToken(previous: SpotifyTokenSet, signal?: AbortSignal): Promise<string> {
    const generation = this.#generation;
    const parameters = new URLSearchParams({
      client_id: this.#clientId,
      grant_type: 'refresh_token',
      refresh_token: previous.refreshToken ?? '',
    });
    const response = await fetchWithTimeout(this.#fetchImpl, SPOTIFY_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: parameters.toString(),
      cache: 'no-store',
      referrerPolicy: 'no-referrer',
    }, this.#tokenTimeoutMs, signal);
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new SpotifyError('invalid_response', 'Spotify returned an invalid token refresh response.');
    }
    if (!response.ok) throw tokenError(response, payload);
    const refreshed = parseTokenResponse(payload, this.#now(), previous.refreshToken);
    if (generation !== this.#generation) throw new SpotifyError('aborted', 'Spotify sign-in was cancelled.');
    this.#tokens = refreshed;
    return refreshed.accessToken;
  }

  clearSession(): void {
    this.#generation += 1;
    this.#tokens = null;
    this.#refreshPromise = null;
  }

  disconnect(): void {
    this.clearSession();
    try {
      this.storage().removeItem(SPOTIFY_PKCE_STORAGE_KEY);
    } catch {
      // Tokens are already gone; unavailable session storage must not restore them.
    }
  }

  destroy(): void {
    this.disconnect();
  }
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}

function numberValue(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function parseTrack(value: unknown): SpotifyTrack {
  if (!isRecord(value)) throw new SpotifyError('invalid_response', 'Spotify returned invalid track data.');
  const id = stringValue(value.id);
  const name = stringValue(value.name);
  const uri = stringValue(value.uri);
  if (!id || !name || !uri) throw new SpotifyError('invalid_response', 'Spotify returned incomplete track data.');
  const artists = Array.isArray(value.artists)
    ? value.artists.flatMap((artist) => isRecord(artist) && typeof artist.name === 'string' ? [artist.name] : [])
    : [];
  const album = isRecord(value.album) ? value.album : null;
  const images = Array.isArray(album?.images) ? album.images : [];
  const image = images.find((candidate): candidate is JsonRecord => isRecord(candidate) && typeof candidate.url === 'string');
  return {
    id,
    name,
    uri,
    artists,
    albumName: typeof album?.name === 'string' ? album.name : '',
    durationMs: numberValue(value.duration_ms),
    imageUrl: image?.url as string | undefined ?? null,
    explicit: value.explicit === true,
  };
}

function parseDevice(value: unknown): SpotifyDevice | null {
  if (!isRecord(value)) return null;
  return {
    id: stringValue(value.id),
    name: typeof value.name === 'string' ? value.name : 'Spotify device',
    type: typeof value.type === 'string' ? value.type : 'unknown',
    isActive: value.is_active === true,
    volumePercent: typeof value.volume_percent === 'number' && Number.isFinite(value.volume_percent)
      ? value.volume_percent
      : null,
  };
}

function parsePlaybackState(value: unknown): SpotifyPlaybackState {
  if (!isRecord(value)) throw new SpotifyError('invalid_response', 'Spotify returned invalid playback state.');
  const item = value.item == null ? null : parseTrack(value.item);
  const repeat = value.repeat_state;
  return {
    device: parseDevice(value.device),
    item,
    isPlaying: value.is_playing === true,
    progressMs: numberValue(value.progress_ms),
    durationMs: item?.durationMs ?? numberValue(value.item && isRecord(value.item) ? value.item.duration_ms : 0),
    timestamp: numberValue(value.timestamp, Date.now()),
    shuffleState: value.shuffle_state === true,
    repeatState: repeat === 'track' || repeat === 'context' ? repeat : 'off',
    volumePercent: typeof value.volume_percent === 'number' && Number.isFinite(value.volume_percent)
      ? value.volume_percent
      : null,
  };
}

function validateUri(uri: string, kinds: readonly string[]): void {
  const prefix = new RegExp(`^spotify:(${kinds.join('|')}):[A-Za-z0-9]+$`);
  if (!prefix.test(uri)) throw new SpotifyError('invalid_request', 'A valid Spotify URI is required.');
}

export class SpotifyClient {
  readonly #auth: SpotifyAuth;
  readonly #fetchImpl: typeof fetch;
  readonly #timeoutMs: number;

  constructor(auth: SpotifyAuth, options: SpotifyClientOptions = {}) {
    this.#auth = auth;
    this.#fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.#timeoutMs = options.timeoutMs ?? 15_000;
    if (!Number.isFinite(this.#timeoutMs) || this.#timeoutMs <= 0) {
      throw new SpotifyError('configuration', 'Spotify request timeout must be positive.');
    }
  }

  private async request<T>(path: string, init: RequestInit = {}, parse: (value: unknown) => T, signal?: AbortSignal): Promise<T> {
    const token = await this.#auth.getAccessToken(signal);
    const headers = new Headers(init.headers);
    headers.set('Authorization', `Bearer ${token}`);
    headers.set('Accept', 'application/json');
    const response = await fetchWithTimeout(this.#fetchImpl, new URL(path, `${SPOTIFY_API_BASE_URL}/`).href, {
      ...init,
      headers,
      cache: 'no-store',
      referrerPolicy: 'no-referrer',
    }, this.#timeoutMs, signal);
    if (!response.ok) {
      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        payload = undefined;
      }
      if (response.status === 401) this.#auth.clearSession();
      throw apiError(response, payload);
    }
    if (response.status === 204) return undefined as T;
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new SpotifyError('invalid_response', 'Spotify returned an invalid JSON response.');
    }
    return parse(payload);
  }

  private playerPath(suffix = '', deviceId?: string): string {
    const url = new URL(`${SPOTIFY_API_BASE_URL}/me/player${suffix}`);
    if (deviceId) {
      if (!/^[A-Za-z0-9_-]+$/.test(deviceId)) throw new SpotifyError('invalid_request', 'A valid Spotify device ID is required.');
      url.searchParams.set('device_id', deviceId);
    }
    return `${url.pathname}${url.search}`;
  }

  async search(query: string, options: { offset?: number; limit?: number; signal?: AbortSignal } = {}): Promise<SpotifySearchPage> {
    const text = query.trim();
    if (!text || text.length > 256) throw new SpotifyError('invalid_request', 'Enter a Spotify search query of 1–256 characters.');
    const limit = Math.floor(options.limit ?? 8);
    const offset = Math.floor(options.offset ?? 0);
    // Development Mode search currently caps limit at 10; pagination remains available.
    if (!Number.isFinite(limit) || !Number.isFinite(offset) || limit < 1 || limit > 10 || offset < 0) {
      throw new SpotifyError('invalid_request', 'Spotify search limit must be 1–10 and offset must be non-negative.');
    }
    const url = new URL(`${SPOTIFY_API_BASE_URL}/search`);
    url.searchParams.set('q', text);
    url.searchParams.set('type', 'track');
    url.searchParams.set('limit', String(limit));
    url.searchParams.set('offset', String(offset));
    const page = await this.request(`${url.pathname}${url.search}`, {}, (value) => {
      if (!isRecord(value) || !isRecord(value.tracks) || !Array.isArray(value.tracks.items)) {
        throw new SpotifyError('invalid_response', 'Spotify returned invalid search results.');
      }
      return {
        tracks: value.tracks.items.map(parseTrack),
        total: numberValue(value.tracks.total),
        offset,
        limit,
      };
    }, options.signal);
    const tracks = (page as SpotifySearchPage).tracks;
    const resolved = page as SpotifySearchPage;
    resolved.hasMore = offset + tracks.length < resolved.total;
    return resolved;
  }

  async getPlaybackState(signal?: AbortSignal): Promise<SpotifyPlaybackState | null> {
    const state = await this.request<SpotifyPlaybackState | null>(this.playerPath(), {}, (value) => parsePlaybackState(value), signal);
    return state ?? null;
  }

  async getAvailableDevices(signal?: AbortSignal): Promise<SpotifyDevice[]> {
    return this.request(this.playerPath('/devices'), {}, (value) => {
      if (!isRecord(value) || !Array.isArray(value.devices)) {
        throw new SpotifyError('invalid_response', 'Spotify returned invalid device data.');
      }
      return value.devices.map(parseDevice).filter((device): device is SpotifyDevice => device !== null);
    }, signal);
  }

  async play(options: PlayOptions = {}, signal?: AbortSignal): Promise<void> {
    const body: JsonRecord = {};
    if (options.contextUri) {
      validateUri(options.contextUri, ['album', 'artist', 'playlist']);
      body.context_uri = options.contextUri;
    }
    if (options.uris) {
      if (!options.uris.length || options.uris.length > 100) throw new SpotifyError('invalid_request', 'Playback accepts 1–100 Spotify item URIs.');
      options.uris.forEach((uri) => validateUri(uri, ['track', 'episode']));
      body.uris = options.uris;
    }
    if (options.offset) {
      const offset: JsonRecord = {};
      if (options.offset.position !== undefined) {
        if (!Number.isInteger(options.offset.position) || options.offset.position < 0) throw new SpotifyError('invalid_request', 'Playback offset must be a non-negative integer.');
        offset.position = options.offset.position;
      }
      if (options.offset.uri) {
        validateUri(options.offset.uri, ['track', 'episode']);
        offset.uri = options.offset.uri;
      }
      body.offset = offset;
    }
    const hasBody = Object.keys(body).length > 0;
    await this.request<void>(this.playerPath('', options.deviceId), {
      method: 'PUT',
      headers: hasBody ? { 'Content-Type': 'application/json' } : undefined,
      body: hasBody ? JSON.stringify(body) : undefined,
    }, () => undefined, signal);
  }

  async pause(signal?: AbortSignal): Promise<void> {
    await this.request<void>(this.playerPath('/pause'), { method: 'PUT' }, () => undefined, signal);
  }

  async next(signal?: AbortSignal): Promise<void> {
    await this.request<void>(this.playerPath('/next'), { method: 'POST' }, () => undefined, signal);
  }

  async previous(signal?: AbortSignal): Promise<void> {
    await this.request<void>(this.playerPath('/previous'), { method: 'POST' }, () => undefined, signal);
  }

  async seek(positionMs: number, signal?: AbortSignal): Promise<void> {
    if (!Number.isInteger(positionMs) || positionMs < 0) throw new SpotifyError('invalid_request', 'Seek position must be a non-negative integer.');
    const url = new URL(`${SPOTIFY_API_BASE_URL}/me/player/seek`);
    url.searchParams.set('position_ms', String(positionMs));
    await this.request<void>(`${url.pathname}${url.search}`, { method: 'PUT' }, () => undefined, signal);
  }

  async setVolume(volumePercent: number, signal?: AbortSignal): Promise<void> {
    if (!Number.isInteger(volumePercent) || volumePercent < 0 || volumePercent > 100) {
      throw new SpotifyError('invalid_request', 'Playback volume must be an integer from 0 to 100.');
    }
    const url = new URL(`${SPOTIFY_API_BASE_URL}/me/player/volume`);
    url.searchParams.set('volume_percent', String(volumePercent));
    await this.request<void>(`${url.pathname}${url.search}`, { method: 'PUT' }, () => undefined, signal);
  }

  async setShuffle(enabled: boolean, signal?: AbortSignal): Promise<void> {
    const url = new URL(`${SPOTIFY_API_BASE_URL}/me/player/shuffle`);
    url.searchParams.set('state', String(enabled));
    await this.request<void>(`${url.pathname}${url.search}`, { method: 'PUT' }, () => undefined, signal);
  }

  async setRepeat(state: 'off' | 'track' | 'context', signal?: AbortSignal): Promise<void> {
    if (state !== 'off' && state !== 'track' && state !== 'context') throw new SpotifyError('invalid_request', 'Repeat state must be off, track, or context.');
    const url = new URL(`${SPOTIFY_API_BASE_URL}/me/player/repeat`);
    url.searchParams.set('state', state);
    await this.request<void>(`${url.pathname}${url.search}`, { method: 'PUT' }, () => undefined, signal);
  }
}
