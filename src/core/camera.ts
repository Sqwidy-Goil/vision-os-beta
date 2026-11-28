export interface CameraLease {
  readonly stream: MediaStream;
  release(): void;
}

const LEGACY_OWNER = Symbol('legacy camera owner');
type CameraOwner = string | typeof LEGACY_OWNER;

export class RearCamera {
  readonly video = document.createElement('video');
  private stream: MediaStream | null = null;
  private starting: Promise<MediaStream> | null = null;
  private readonly leases = new Map<CameraOwner, Promise<CameraLease>>();
  private frameCost = 0;
  private generation = 0;

  active = false;
  facingMode = 'unknown';

  constructor(private readonly onStatus: (message: string, error?: boolean) => void) {
    this.video.playsInline = true;
    this.video.muted = true;
    this.video.autoplay = true;
    this.video.setAttribute('playsinline', '');
  }

  async acquire(owner: string): Promise<CameraLease> {
    if (!owner.trim()) throw new Error('Camera lease owner must not be empty.');
    return this.acquireLease(owner);
  }

  release(owner: string): void {
    this.releaseLease(owner);
  }

  async start(): Promise<boolean> {
    await this.acquireLease(LEGACY_OWNER);
    return true;
  }

  stop(): void {
    if (!this.leases.has(LEGACY_OWNER) && this.leases.size === 0) {
      this.stopCamera('Camera off.');
      return;
    }
    this.releaseLease(LEGACY_OWNER);
  }

  private acquireLease(owner: CameraOwner): Promise<CameraLease> {
    const existing = this.leases.get(owner);
    if (existing) return existing;
    const acquisition: Promise<CameraLease> = this.openCamera().then((stream) => {
      if (this.leases.get(owner) !== acquisition) throw new Error('Camera lease cancelled.');
      return { stream, release: () => this.releaseLease(owner) };
    }).catch((error: unknown) => {
      if (this.leases.get(owner) === acquisition) this.leases.delete(owner);
      throw error;
    });
    this.leases.set(owner, acquisition);
    return acquisition;
  }

  private releaseLease(owner: CameraOwner): void {
    if (!this.leases.delete(owner) || this.leases.size > 0) return;
    this.stopCamera('Camera off.');
  }

  private async openCamera(): Promise<MediaStream> {
    if (this.active && this.stream) return this.stream;
    if (this.starting) return this.starting;
    const generation = ++this.generation;
    const request = this.startCamera(generation);
    this.starting = request;
    try {
      return await request;
    } finally {
      if (this.starting === request) this.starting = null;
    }
  }

  private async startCamera(generation: number): Promise<MediaStream> {
    if (!navigator.mediaDevices?.getUserMedia) {
      this.onStatus('Camera access requires HTTPS and a browser with getUserMedia.', true);
      throw new Error('Camera API unavailable.');
    }
    let stream: MediaStream | null = null;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          facingMode: { ideal: 'environment' },
          width: { ideal: this.frameCost > 24 ? 960 : 1280 },
          height: { ideal: this.frameCost > 24 ? 540 : 720 },
          frameRate: { ideal: 30, max: 30 },
        },
      });
      if (generation !== this.generation) throw new Error('Camera request cancelled.');
      const track = stream.getVideoTracks()[0];
      const settings = track?.getSettings();
      track?.addEventListener('ended', () => {
        if (this.stream !== stream) return;
        this.stopCamera('Camera stream ended.', true);
      });
      this.facingMode = settings?.facingMode ?? 'unknown';
      if (this.facingMode === 'user') {
        throw new Error('Only the front camera was returned. VISI0N OS did not switch silently.');
      }
      this.stream = stream;
      this.video.srcObject = stream;
      await this.video.play();
      if (generation !== this.generation || this.stream !== stream) throw new Error('Camera request cancelled.');
      this.active = true;
      this.onStatus(this.facingMode === 'environment' ? 'Rear camera active.' : 'Camera active; facing direction is not reported by this browser.');
      return stream;
    } catch (error) {
      stream?.getTracks().forEach((track) => track.stop());
      if (generation === this.generation) {
        const message = error instanceof Error ? error.message : 'Camera permission failed.';
        this.stopCamera(message, true);
      }
      throw error;
    }
  }

  private stopCamera(message: string, error = false): void {
    this.generation += 1;
    this.leases.clear();
    this.starting = null;
    const stream = this.stream;
    this.stream = null;
    this.video.srcObject = null;
    this.active = false;
    this.facingMode = 'unknown';
    stream?.getTracks().forEach((track) => track.stop());
    this.onStatus(message, error);
  }

  recordFrameCost(milliseconds: number): void {
    this.frameCost = this.frameCost * 0.9 + milliseconds * 0.1;
  }

  get ready(): boolean {
    return this.active && this.video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA;
  }
}
