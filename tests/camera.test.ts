import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RearCamera } from '../src/core/camera';

class VideoStub {
  playsInline = false;
  muted = false;
  autoplay = false;
  readyState = 0;
  srcObject: MediaStream | null = null;
  play = vi.fn(async () => { this.readyState = 4; });
  setAttribute = vi.fn();
}

function createStream(facingMode = 'environment') {
  const track = {
    stop: vi.fn(),
    addEventListener: vi.fn(),
    getSettings: vi.fn(() => ({ facingMode })),
  };
  const stream = {
    getTracks: vi.fn(() => [track]),
    getVideoTracks: vi.fn(() => [track]),
  } as unknown as MediaStream;
  return { stream, track };
}

describe('RearCamera leases', () => {
  let video: VideoStub;
  let getUserMedia: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    video = new VideoStub();
    getUserMedia = vi.fn();
    vi.stubGlobal('document', { createElement: vi.fn(() => video) });
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } });
    vi.stubGlobal('HTMLMediaElement', { HAVE_CURRENT_DATA: 4 });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('shares one stream until the final owner releases it', async () => {
    const { stream, track } = createStream();
    getUserMedia.mockResolvedValue(stream);
    const statuses: string[] = [];
    const camera = new RearCamera((message) => statuses.push(message));

    const hands = await camera.acquire('hands');
    const background = await camera.acquire('camera-background');

    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(hands.stream).toBe(stream);
    expect(background.stream).toBe(stream);
    camera.release('hands');
    hands.release();
    expect(track.stop).not.toHaveBeenCalled();
    expect(camera.active).toBe(true);
    expect(statuses).not.toContain('Camera off.');

    background.release();
    background.release();
    expect(track.stop).toHaveBeenCalledTimes(1);
    expect(camera.active).toBe(false);
    expect(video.srcObject).toBeNull();
    expect(statuses.at(-1)).toBe('Camera off.');
  });

  it('keeps start and stop compatible without taking another owner stream', async () => {
    const { stream, track } = createStream();
    getUserMedia.mockResolvedValue(stream);
    const camera = new RearCamera(vi.fn());
    const spatial = await camera.acquire('spatial-analysis');

    await Promise.all([camera.start(), camera.start()]);
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    camera.stop();
    expect(track.stop).not.toHaveBeenCalled();
    expect(camera.active).toBe(true);

    spatial.release();
    expect(track.stop).toHaveBeenCalledTimes(1);
  });

  it('cancels stale requests without disturbing a newer generation', async () => {
    const pending: Array<(stream: MediaStream) => void> = [];
    getUserMedia.mockImplementation(() => new Promise<MediaStream>((resolve) => pending.push(resolve)));
    const statuses: string[] = [];
    const camera = new RearCamera((message) => statuses.push(message));
    const stale = camera.start();
    const staleResult = expect(stale).rejects.toThrow('Camera request cancelled.');

    camera.stop();
    const current = camera.start();
    const first = createStream();
    const second = createStream();
    pending[1](second.stream);
    await expect(current).resolves.toBe(true);
    pending[0](first.stream);
    await staleResult;

    expect(first.track.stop).toHaveBeenCalledTimes(1);
    expect(second.track.stop).not.toHaveBeenCalled();
    expect(camera.active).toBe(true);
    expect(video.srcObject).toBe(second.stream);
    expect(statuses).not.toContain('Camera request cancelled.');
    camera.stop();
  });

  it('reports an unexpected stream ending and invalidates its leases', async () => {
    const { stream, track } = createStream();
    getUserMedia.mockResolvedValue(stream);
    const onStatus = vi.fn();
    const camera = new RearCamera(onStatus);
    const lease = await camera.acquire('hands');
    const ended = track.addEventListener.mock.calls[0][1] as () => void;

    ended();
    expect(camera.active).toBe(false);
    expect(video.srcObject).toBeNull();
    expect(onStatus).toHaveBeenLastCalledWith('Camera stream ended.', true);
    lease.release();
    expect(track.stop).toHaveBeenCalledTimes(1);
  });

  it('rejects a front-camera fallback without reporting it as active', async () => {
    const { stream, track } = createStream('user');
    getUserMedia.mockResolvedValue(stream);
    const onStatus = vi.fn();
    const camera = new RearCamera(onStatus);

    await expect(camera.acquire('hands')).rejects.toThrow('Only the front camera was returned');
    expect(track.stop).toHaveBeenCalledTimes(1);
    expect(camera.active).toBe(false);
    expect(onStatus).toHaveBeenLastCalledWith(
      'Only the front camera was returned. VISI0N OS did not switch silently.',
      true,
    );
  });
});
