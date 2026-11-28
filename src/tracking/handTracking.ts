import { FilesetResolver, HandLandmarker } from '@mediapipe/tasks-vision';
import type { NormalizedLandmark } from '@mediapipe/tasks-vision';

export interface HandTrackingResult {
  landmarks: NormalizedLandmark[][];
  pinchDistances: Array<number | null>;
  pinchDistance: number | null;
  pinching: boolean;
}

const MODEL_URL = 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';

export class HandTracker {
  private landmarker: HandLandmarker | null = null;
  private loading: Promise<void> | null = null;
  private loadingGeneration = 0;
  private lastVideoTime = -1;
  private generation = 0;
  private disposed = false;
  private pinching = false;
  active = false;
  lastResult: HandTrackingResult = { landmarks: [], pinchDistances: [], pinchDistance: null, pinching: false };

  constructor(private readonly onStatus: (message: string, error?: boolean) => void) {}

  get available(): boolean {
    return typeof WebAssembly !== 'undefined';
  }

  async enable(): Promise<boolean> {
    if (this.disposed) return false;
    if (!this.available) {
      this.onStatus('Hand tracking needs WebAssembly, which is unavailable.', true);
      return false;
    }
    if (this.active) return true;
    if (this.landmarker) {
      this.active = true;
      this.onStatus('Hand tracking active. Show one hand to the rear camera.');
      return true;
    }
    const generation = this.generation;
    if (!this.loading || this.loadingGeneration !== generation) {
      this.loadingGeneration = generation;
      this.loading = this.load(generation);
    }
    const loading = this.loading;
    try {
      await loading;
      if (generation !== this.generation || this.disposed) return false;
      this.active = true;
      if (this.loading === loading) this.loading = null;
      this.onStatus('Hand tracking active. Show one hand to the rear camera.');
      return true;
    } catch (error) {
      if (this.loading === loading) this.loading = null;
      this.onStatus(`Hand tracking could not start: ${error instanceof Error ? error.message : 'model unavailable'}. Touch controls remain available.`, true);
      return false;
    }
  }

  private async load(generation: number): Promise<void> {
    const vision = await FilesetResolver.forVisionTasks('https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.22/wasm');
    const options = {
      runningMode: 'VIDEO' as const,
      numHands: 2,
      minHandDetectionConfidence: 0.6,
      minHandPresenceConfidence: 0.6,
      minTrackingConfidence: 0.6,
    };
    let landmarker: HandLandmarker;
    try {
      landmarker = await HandLandmarker.createFromOptions(vision, {
        ...options,
        baseOptions: { modelAssetPath: MODEL_URL, delegate: 'GPU' },
      });
    } catch {
      landmarker = await HandLandmarker.createFromOptions(vision, {
        ...options,
        baseOptions: { modelAssetPath: MODEL_URL, delegate: 'CPU' },
      });
    }
    if (generation !== this.generation || this.disposed) {
      landmarker.close();
      throw new Error('Hand tracking request cancelled.');
    }
    this.landmarker = landmarker;
  }

  disable(): void {
    this.generation += 1;
    this.active = false;
    this.pinching = false;
    this.lastVideoTime = -1;
    this.lastResult = { landmarks: [], pinchDistances: [], pinchDistance: null, pinching: false };
    this.onStatus('Hand tracking off.');
  }

  detect(video: HTMLVideoElement): HandTrackingResult {
    if (!this.active || !this.landmarker || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return this.lastResult;
    if (video.currentTime < this.lastVideoTime) this.lastVideoTime = -1;
    if (video.currentTime === this.lastVideoTime) return this.lastResult;
    this.lastVideoTime = video.currentTime;
    try {
      const result = this.landmarker.detectForVideo(video, performance.now());
      const landmarks = result.landmarks;
      const sourceWidth = video.videoWidth || 1;
      const sourceHeight = video.videoHeight || 1;
      const pinchDistances = landmarks.map((hand) => {
        const thumb = hand[4];
        const index = hand[8];
        if (!thumb || !index) return null;
        return Math.hypot(
          (thumb.x - index.x) * sourceWidth,
          (thumb.y - index.y) * sourceHeight,
          (thumb.z - index.z) * sourceWidth * 0.35,
        ) / sourceWidth;
      });
      const pinchDistance = pinchDistances[0] ?? null;
      this.pinching = pinchDistance !== null && (this.pinching ? pinchDistance >= 0.075 : pinchDistance <= 0.05);
      this.lastResult = { landmarks, pinchDistances, pinchDistance, pinching: this.pinching };
    } catch (error) {
      this.active = false;
      this.pinching = false;
      this.lastVideoTime = -1;
      this.lastResult = { landmarks: [], pinchDistances: [], pinchDistance: null, pinching: false };
      this.onStatus(`Hand tracking stopped: ${error instanceof Error ? error.message : 'inference failed'}.`, true);
    }
    return this.lastResult;
  }

  dispose(): void {
    this.generation += 1;
    this.disposed = true;
    this.active = false;
    this.landmarker?.close();
    this.landmarker = null;
  }
}
