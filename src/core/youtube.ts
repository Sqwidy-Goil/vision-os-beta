const API_KEY_STORAGE = 'vision.youtube.apiKey.v1';
const API_BASE = 'https://www.googleapis.com/youtube/v3';

export interface YouTubeVideo {
  id: string;
  title: string;
  channelTitle: string;
  publishedAt?: string;
  thumbnailUrl?: string;
}

export interface YouTubeSearchResult {
  videos: YouTubeVideo[];
  nextPageToken?: string;
}

interface YouTubeSearchResponse {
  items?: Array<{
    id?: { videoId?: string };
    snippet?: {
      title?: string;
      channelTitle?: string;
      publishedAt?: string;
      thumbnails?: { medium?: { url?: string }; default?: { url?: string } };
    };
  }>;
  nextPageToken?: string;
  error?: { message?: string };
}

export function getYouTubeKey(): string | null {
  try {
    return globalThis.localStorage?.getItem(API_KEY_STORAGE) ?? null;
  } catch {
    return null;
  }
}

export function rememberYouTubeKey(value: string): void {
  const trimmed = value.trim();
  if (!trimmed) throw new Error('Enter a YouTube Data API v3 key.');
  try {
    globalThis.localStorage.setItem(API_KEY_STORAGE, trimmed);
  } catch {
    throw new Error('This browser could not save the YouTube key locally.');
  }
}

export function forgetYouTubeKey(): void {
  try {
    globalThis.localStorage?.removeItem(API_KEY_STORAGE);
  } catch {
    return;
  }
}

async function youtubeRequest(path: string, key: string, signal?: AbortSignal): Promise<YouTubeSearchResponse> {
  const url = new URL(`${API_BASE}/${path}`);
  url.searchParams.set('key', key);
  let response: Response;
  try {
    response = await fetch(url, { signal, cache: 'no-store', referrerPolicy: 'no-referrer' });
  } catch {
    if (signal?.aborted) throw new Error('The YouTube request was cancelled.');
    throw new Error('Could not reach YouTube. Check your connection.');
  }
  let data: YouTubeSearchResponse;
  try {
    data = await response.json() as YouTubeSearchResponse;
  } catch {
    throw new Error('YouTube returned an invalid response.');
  }
  if (!response.ok) {
    if (response.status === 403) throw new Error('Access denied. Check API enablement, restrictions, quota, and referrer settings.');
    if (response.status === 400 && /key/i.test(data.error?.message ?? '')) throw new Error('The YouTube API key is invalid.');
    throw new Error(`YouTube request failed (HTTP ${response.status}).`);
  }
  return data;
}

export async function testYouTubeKey(key: string, signal?: AbortSignal): Promise<void> {
  const data = await youtubeRequest('search?part=snippet&type=video&maxResults=1&q=YouTube&safeSearch=moderate', key, signal);
  if (!Array.isArray(data.items)) throw new Error('The API response did not contain a search result.');
}

export async function searchYouTube(key: string, query: string, pageToken?: string, signal?: AbortSignal): Promise<YouTubeSearchResult> {
  if (!query.trim()) throw new Error('Enter a YouTube search query.');
  const parameters = new URLSearchParams({
    part: 'snippet',
    type: 'video',
    maxResults: '12',
    q: query.trim(),
    safeSearch: 'moderate',
    key,
  });
  if (pageToken) parameters.set('pageToken', pageToken);
  const data = await youtubeRequest(`search?${parameters.toString()}`, key, signal);
  const videos = (data.items ?? []).flatMap((item): YouTubeVideo[] => {
    const id = item.id?.videoId;
    if (!id) return [];
    return [{
      id,
      title: item.snippet?.title ?? 'Untitled video',
      channelTitle: item.snippet?.channelTitle ?? 'Unknown channel',
      publishedAt: item.snippet?.publishedAt,
      thumbnailUrl: item.snippet?.thumbnails?.medium?.url ?? item.snippet?.thumbnails?.default?.url,
    }];
  });
  return { videos, nextPageToken: data.nextPageToken };
}
